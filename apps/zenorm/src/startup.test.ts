import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  changeFeedEnds,
  INSTANCE_LOCK_FILE,
  maps,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
  users,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { startAndListen } from "./serve.ts";
import { SOURCE_ASSETS } from "./source-assets.ts";
import {
  CONFIG_ENV_VAR,
  DATABASE_FILE,
  RUNS_DIR,
  SESSIONS_DIR,
  shutDown,
  startup,
  startZeNorm,
} from "./startup.ts";
import type { StartupInput, ZeNormInput } from "./startup.ts";

let root: string;
let dataDir: string;
let webDistDir: string;
let configFile: string;
let agent: {
  claudePath: string;
  wayfindingModel: string;
  specModel: string;
  models: Record<string, Record<string, { aim: number; max: number }>>;
  effort: string;
  maxTurns: number;
  timeoutSeconds: number;
};

const delivery = {
  model: "claude-sonnet-5-5",
  effort: "medium",
  orchestratorMaxTurns: 200,
  orchestratorTimeoutMinutes: 120,
  reviewerMaxTurns: 40,
  reviewerTimeoutMinutes: 20,
  checkTimeoutMinutes: 10,
  executor: "local",
};

/** The Sonnet profile: every aim its max, today's drafting bounds, the build about 1200 of 2000. */
const sonnetLimits = {
  questionText: { aim: 200, max: 200 },
  questionTopic: { aim: 80, max: 80 },
  optionDetail: { aim: 200, max: 200 },
  optionLabel: { aim: 80, max: 80 },
  roundIntro: { aim: 300, max: 300 },
  mapTitle: { aim: 120, max: 120 },
  mapSummary: { aim: 1000, max: 1000 },
  destination: { aim: 1000, max: 1000 },
  waypointTitle: { aim: 120, max: 120 },
  waypointQuestion: { aim: 1000, max: 1000 },
  resolution: { aim: 800, max: 800 },
  gist: { aim: 200, max: 200 },
  agentDecided: { aim: 120, max: 200 },
  mapLine: { aim: 500, max: 500 },
  findingExplanation: { aim: 4000, max: 4000 },
  researchSummary: { aim: 4000, max: 4000 },
  researchFindingTitle: { aim: 120, max: 120 },
  researchFindingDetail: { aim: 2000, max: 2000 },
  researchSourceTitle: { aim: 200, max: 200 },
  researchExcerpt: { aim: 2000, max: 2000 },
  researchNote: { aim: 1000, max: 1000 },
  taskAction: { aim: 1000, max: 1000 },
  taskFacts: { aim: 4000, max: 4000 },
  surveyText: { aim: 400, max: 400 },
  surveyName: { aim: 200, max: 200 },
  hatchReply: { aim: 2000, max: 2000 },
  waitNote: { aim: 4000, max: 4000 },
  specTitle: { aim: 120, max: 120 },
  specProse: { aim: 600, max: 600 },
  clauseTitle: { aim: 120, max: 120 },
  clauseText: { aim: 400, max: 400 },
  criterionText: { aim: 500, max: 500 },
  clauseName: { aim: 200, max: 200 },
  contentLine: { aim: 500, max: 500 },
  removalReason: { aim: 300, max: 300 },
  ticketTitle: { aim: 120, max: 120 },
  ticketBuild: { aim: 1200, max: 2000 },
  dispositionText: { aim: 1000, max: 1000 },
  ticketSetSlicing: { aim: 2000, max: 2000 },
  ticketSetExecution: { aim: 1000, max: 1000 },
  specReviewSummary: { aim: 1000, max: 1000 },
  ticketsReviewSummary: { aim: 1000, max: 1000 },
  ticketsReviewFindingTitle: { aim: 120, max: 120 },
  ticketsReviewFindingExplanation: { aim: 1000, max: 1000 },
  ticketsReviewFindingQuestion: { aim: 500, max: 500 },
};

const closers: (() => void)[] = [];

/** A stand-in `claude` whose every call runs `script` (`sh`). */
async function writeClaude(path: string, script: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

const SIGNED_IN = `echo '{"loggedIn":true,"authMethod":"claude.ai"}'`;
/** Claude Code exits 1 when it is not signed in. */
const SIGNED_OUT = `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`;

const JournalEntry = z.looseObject({ idx: z.number(), when: z.number(), tag: z.string() });
type JournalEntry = z.infer<typeof JournalEntry>;
const Journal = z.looseObject({ entries: z.array(JournalEntry) });
const STAND_IN_TAG = "9999_stand_in";
const STAND_IN_SQL = "CREATE TABLE `stand_in` (`id` integer);\n";

/** A copy of the shipped migrations at `<root>/<name>` whose journal lists `entries(shipped)`. */
async function migrationsCopy(
  name: string,
  entries: (shipped: readonly JournalEntry[]) => readonly JournalEntry[],
): Promise<string> {
  const folder = join(root, name);
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalFile = join(folder, "meta", "_journal.json");
  const journal = Journal.parse(JSON.parse(await readFile(journalFile, "utf8")));
  await writeFile(journalFile, JSON.stringify({ ...journal, entries: entries(journal.entries) }));
  return folder;
}

/** Every shipped migration but the last, as an earlier build shipped them. */
function earlierMigrations(): Promise<string> {
  return migrationsCopy("migrations-earlier", (shipped) => shipped.slice(0, -1));
}

/** The shipped migrations and one stand-in after the last, as a newer build ships them. */
async function newerMigrations(): Promise<string> {
  const folder = await migrationsCopy("migrations-newer", (shipped) => {
    const last = shipped.at(-1);
    if (last === undefined) throw new Error("the shipped journal has no entry");
    const standIn = { ...last, idx: last.idx + 1, when: last.when + 1000, tag: STAND_IN_TAG };
    return [...shipped, standIn];
  });
  await writeFile(join(folder, `${STAND_IN_TAG}.sql`), STAND_IN_SQL);
  return folder;
}

/** `map.list`'s RPC response body: the maps, by id. */
const ListedMaps = z.object({ json: z.array(z.looseObject({ id: z.string() })) });

/** The rows of `zenorm_migrations` in the data folder's database. */
function appliedMigrations(): unknown[] {
  const opened = openDatabase(join(dataDir, DATABASE_FILE));
  if (!opened.ok) throw new Error(opened.error.message);
  const client = opened.value.$client;
  const rows = client.prepare("SELECT * FROM zenorm_migrations ORDER BY id").all();
  client.close();
  return rows;
}

/** The startup sweeps' lines. */
let logLines: string[];
function log(line: string): void {
  logLines.push(line);
}

function validConfig(): unknown {
  return { server: { host: "127.0.0.1", port: 4310 }, dataDir, agent, delivery, plugins: {} };
}

async function writeConfig(config: unknown): Promise<void> {
  await writeFile(configFile, JSON.stringify(config));
}

/** The input besides the arguments and environment: the assets, no standard path, the log. */
function fixed(): Omit<StartupInput, "args" | "env"> {
  return { webDistDir, ...SOURCE_ASSETS, standardConfigPath: null, log };
}

function viaEnv(): StartupInput {
  return { args: [], env: { [CONFIG_ENV_VAR]: configFile }, ...fixed() };
}

/** The code `startup` refuses with, or null once it started, closing the database again. */
async function startupCode(input: StartupInput) {
  const result = await startup(input);
  if (result.ok) {
    result.value.db.$client.close();
    return null;
  }
  return { code: result.error.code, subject: result.error.subject };
}

beforeEach(async () => {
  logLines = [];
  root = await mkdtemp(join(tmpdir(), "zenorm-startup-"));
  dataDir = join(root, "data");
  webDistDir = join(root, "dist");
  configFile = join(root, "config.json");
  // Startup checks that `claudePath` is an executable regular file, then runs only its
  // `auth status --json`; this stand-in reports signed in to anything.
  const claudePath = join(root, "claude");
  await writeClaude(claudePath, SIGNED_IN);
  agent = {
    claudePath,
    wayfindingModel: "claude-opus-5-5",
    specModel: "claude-sonnet-5-5",
    models: {
      "claude-opus-5-5": { ...sonnetLimits, resolution: { aim: 700, max: 1000 } },
      "claude-sonnet-5-5": sonnetLimits,
    },
    effort: "medium",
    maxTurns: 12,
    timeoutSeconds: 240,
  };
  await mkdir(dataDir);
  await mkdir(webDistDir);
  await writeFile(join(webDistDir, "index.html"), "<!doctype html>");
  await writeConfig(validConfig());
});

afterEach(async () => {
  for (const close of closers.splice(0)) {
    close();
  }
  await rm(root, { recursive: true, force: true });
});

describe("startup", () => {
  test("a valid config from ZENORM_CONFIG opens and migrates the database", async () => {
    const result = await startup(viaEnv());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { config, db } = result.value;
    closers.push(() => {
      db.$client.close();
    });
    expect(config).toEqual(validConfig());
    expect(db.$client.name).toBe(join(dataDir, DATABASE_FILE));
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("a valid config from --config starts, and a second start is a no-op migration", async () => {
    const input: StartupInput = { args: ["--config", configFile], env: {}, ...fixed() };
    const first = await startup(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.value.db.$client.close();

    expect(await startupCode(input)).toBeNull();
  });

  test("config_path_missing when neither source is set and the entry has no standard path", async () => {
    expect(await startupCode({ args: [], env: {}, ...fixed() })).toMatchObject({
      code: "config_path_missing",
    });
  });

  test("the standard config path is read when neither source is set", async () => {
    const standard = join(root, "standard", "config.json");
    const input: StartupInput = { args: [], env: {}, ...fixed(), standardConfigPath: standard };
    expect(await startupCode(input)).toEqual({ code: "config_file_missing", subject: standard });
    await mkdir(join(root, "standard"));
    await writeFile(standard, JSON.stringify(validConfig()));
    expect(await startupCode(input)).toBeNull();
  });

  test("--config or ZENORM_CONFIG wins over the standard config path", async () => {
    const standard = join(root, "nowhere", "config.json");
    expect(await startupCode({ ...viaEnv(), standardConfigPath: standard })).toBeNull();
    const viaArgs: StartupInput = {
      args: ["--config", configFile],
      env: {},
      ...fixed(),
      standardConfigPath: standard,
    };
    expect(await startupCode(viaArgs)).toBeNull();
  });

  test.each([
    { name: "an unknown flag", args: ["--port", "4310"] },
    { name: "--config without a value", args: ["--config"] },
    { name: "a positional argument", args: ["config.json"] },
  ])("arguments_invalid for $name", async ({ args }) => {
    expect(await startupCode({ args, env: {}, ...fixed() })).toEqual({
      code: "arguments_invalid",
      subject: args.join(" "),
    });
  });

  test("config_path_ambiguous when both sources are set", async () => {
    const input: StartupInput = { ...viaEnv(), args: ["--config", configFile] };
    expect(await startupCode(input)).toMatchObject({ code: "config_path_ambiguous" });
  });

  test("config_file_missing when the file does not exist", async () => {
    const missing = join(root, "nope.json");
    const input: StartupInput = { args: [], env: { [CONFIG_ENV_VAR]: missing }, ...fixed() };
    expect(await startupCode(input)).toEqual({ code: "config_file_missing", subject: missing });
  });

  test("config_file_invalid for a file that is not JSON", async () => {
    await writeFile(configFile, "{ server: ");
    expect(await startupCode(viaEnv())).toEqual({
      code: "config_file_invalid",
      subject: configFile,
    });
  });

  test.each([
    {
      name: "a missing key",
      config: () => ({ server: { host: "127.0.0.1" }, dataDir, agent, delivery }),
      subject: "server.port",
    },
    {
      name: "a mistyped key",
      config: () => ({ server: { host: "127.0.0.1", port: "4310" }, dataDir, agent, delivery }),
      subject: "server.port",
    },
    {
      name: "an unknown key",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent,
        delivery,
        plugins: {},
        extra: true,
      }),
      subject: "extra",
    },
    {
      name: "an unknown nested key",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310, tls: false },
        dataDir,
        agent,
        delivery,
      }),
      subject: "server.tls",
    },
    {
      name: "a relative dataDir",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir: "data",
        agent,
        delivery,
      }),
      subject: "dataDir",
    },
    {
      name: "a config without the delivery section",
      config: () => ({ server: { host: "127.0.0.1", port: 4310 }, dataDir, agent }),
      subject: "delivery",
    },
    {
      name: "a delivery section missing a key",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent,
        delivery: { ...delivery, checkTimeoutMinutes: undefined },
      }),
      subject: "delivery.checkTimeoutMinutes",
    },
    {
      name: "a delivery section with no executor",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent,
        delivery: { ...delivery, executor: undefined },
        plugins: {},
      }),
      subject: "delivery.executor",
    },
    {
      name: "no plugins object",
      config: () => ({ server: { host: "127.0.0.1", port: 4310 }, dataDir, agent, delivery }),
      subject: "plugins",
    },
    {
      name: "an agent section with the old single model",
      config: () => {
        const { claudePath, models, effort, maxTurns, timeoutSeconds } = agent;
        return {
          server: { host: "127.0.0.1", port: 4310 },
          dataDir,
          agent: {
            claudePath,
            model: "claude-sonnet-5-5",
            models,
            effort,
            maxTurns,
            timeoutSeconds,
          },
          delivery,
        };
      },
      subject: "agent.wayfindingModel",
    },
    {
      name: "an agent section with the old model beside the new keys",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent: { ...agent, model: "claude-sonnet-5-5" },
        delivery,
      }),
      subject: "agent.model",
    },
    {
      name: "an agent section with no models entry for its wayfinding model",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent: { ...agent, models: { "claude-sonnet-5-5": sonnetLimits } },
        delivery,
        plugins: {},
      }),
      subject: "agent.models.claude-opus-5-5",
    },
    {
      name: "a models entry whose max is above the stored cap",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent: {
          ...agent,
          models: {
            ...agent.models,
            "claude-sonnet-5-5": { ...sonnetLimits, clauseText: { aim: 400, max: 1001 } },
          },
        },
        delivery,
        plugins: {},
      }),
      subject: "agent.models.claude-sonnet-5-5.clauseText.max",
    },
    {
      name: "a delivery section without executor (required, no default)",
      config: () => ({
        server: { host: "127.0.0.1", port: 4310 },
        dataDir,
        agent,
        delivery: { ...delivery, executor: undefined },
      }),
      subject: "delivery.executor",
    },
  ])("config_file_invalid with the key path for $name", async ({ config, subject }) => {
    await writeConfig(config());
    expect(await startupCode(viaEnv())).toEqual({ code: "config_file_invalid", subject });
  });

  test("data_dir_missing when dataDir does not exist", async () => {
    const missing = join(root, "no-data");
    await writeConfig({
      server: { host: "127.0.0.1", port: 4310 },
      dataDir: missing,
      agent,
      delivery,
      plugins: {},
    });
    expect(await startupCode(viaEnv())).toEqual({ code: "data_dir_missing", subject: missing });
  });

  test("data_dir_missing when dataDir is a file", async () => {
    const file = join(root, "data-file");
    await writeFile(file, "");
    await writeConfig({
      server: { host: "127.0.0.1", port: 4310 },
      dataDir: file,
      agent,
      delivery,
      plugins: {},
    });
    expect(await startupCode(viaEnv())).toMatchObject({ code: "data_dir_missing" });
  });

  test("creates <dataDir>/sessions when absent, keeps it when present, and returns it", async () => {
    const sessionsDir = join(dataDir, SESSIONS_DIR);
    for (let start = 0; start < 2; start += 1) {
      const result = await startup(viaEnv());
      if (!result.ok) throw new Error(result.error.code);
      result.value.db.$client.close();
      expect(result.value.sessionsDir).toBe(sessionsDir);
      expect((await stat(sessionsDir)).isDirectory()).toBe(true);
    }
  });

  test("sweeps a stale session record and an orphaned run folder before returning", async () => {
    // A pid that has exited: the sweep removes its record without a signal.
    const exited = spawn("/usr/bin/true");
    await once(exited, "exit");
    if (exited.pid === undefined) throw new Error("spawn gave no pid");
    const sessionsDir = join(dataDir, SESSIONS_DIR);
    await mkdir(sessionsDir);
    const record = {
      pid: exited.pid,
      command: "/nowhere/claude",
      startedAt: new Date().toISOString(),
      kind: "planning",
    };
    await writeFile(join(sessionsDir, `${String(exited.pid)}.json`), JSON.stringify(record));
    await mkdir(join(dataDir, RUNS_DIR, "bogus"), { recursive: true });

    expect(await startupCode(viaEnv())).toBeNull();
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(await readdir(join(dataDir, RUNS_DIR))).toEqual([]);
    expect(logLines).toHaveLength(2);
  });

  test("data_dir_in_use while another start holds the data folder: nothing is migrated or swept", async () => {
    const first = await startup(viaEnv());
    if (!first.ok) throw new Error(first.error.code);
    // What a running ZeNorm owns: a session record (here of an exited pid, which a sweep would
    // remove) and a run folder no delivery run names.
    const exited = spawn("/usr/bin/true");
    await once(exited, "exit");
    if (exited.pid === undefined) throw new Error("spawn gave no pid");
    const record = join(dataDir, SESSIONS_DIR, `${String(exited.pid)}.json`);
    await writeFile(
      record,
      JSON.stringify({
        pid: exited.pid,
        command: "/nowhere/claude",
        startedAt: new Date().toISOString(),
        kind: "planning",
      }),
    );
    await mkdir(join(dataDir, RUNS_DIR, "bogus"), { recursive: true });
    logLines = [];

    expect(await startupCode(viaEnv())).toEqual({
      code: "data_dir_in_use",
      subject: join(dataDir, INSTANCE_LOCK_FILE),
    });
    expect(await readdir(join(dataDir, SESSIONS_DIR))).toEqual([`${String(exited.pid)}.json`]);
    expect(await readdir(join(dataDir, RUNS_DIR))).toEqual(["bogus"]);
    expect(logLines).toEqual([]);

    first.value.db.$client.close();
    expect(await startupCode(viaEnv())).toBeNull();
  });

  test("deletes every change feed row an earlier server left, and issues no id again", async () => {
    migratedWith((db) => {
      for (let row = 0; row < 3; row += 1) {
        db.$client
          .prepare(
            `INSERT INTO change_feed
               (project_id, map_id, entity_type, entity_id, op, actor_kind, actor_user_id, actor_run_id, at)
             VALUES ('p', NULL, 'projects', 'p', 'insert', 'system', NULL, NULL, '2026-10-12T10:00:00.000Z')`,
          )
          .run();
      }
    });
    const result = await startup(viaEnv());
    if (!result.ok) throw new Error(result.error.code);
    const { db } = result.value;
    expect(db.$client.prepare("SELECT count(*) FROM change_feed").pluck().get()).toBe(0);
    expect(changeFeedEnds(db)).toEqual({ newest: 3, prunedThrough: 3 });
    db.$client.close();
  });

  test.each([
    { name: "says signed out", script: SIGNED_OUT },
    { name: "fails without a status", script: "exit 1" },
  ])(
    "agent_not_logged_in when claude auth status $name, before the database is opened",
    async ({ script }) => {
      await writeClaude(agent.claudePath, script);
      expect(await startupCode(viaEnv())).toEqual({
        code: "agent_not_logged_in",
        subject: agent.claudePath,
      });
      expect(await readdir(dataDir)).toEqual([]);
    },
  );

  test("database_newer_than_build: a database a newer build migrated is left unchanged", async () => {
    const opened = openDatabase(join(dataDir, DATABASE_FILE));
    if (!opened.ok) throw new Error(opened.error.message);
    const migrated = migrateDatabase(opened.value, await newerMigrations());
    opened.value.$client.close();
    expect(migrated.ok).toBe(true);
    const before = appliedMigrations();

    expect(await startupCode(viaEnv())).toEqual({
      code: "database_newer_than_build",
      subject: join(dataDir, DATABASE_FILE),
    });
    expect(appliedMigrations()).toEqual(before);
  });

  test("web_build_missing when index.html is absent", async () => {
    await rm(join(webDistDir, "index.html"));
    expect(await startupCode(viaEnv())).toMatchObject({ code: "web_build_missing" });
  });

  test("database_open_failed when the database file is not SQLite", async () => {
    const dbPath = join(dataDir, DATABASE_FILE);
    await writeFile(dbPath, "this is not a SQLite database file. ".repeat(20));
    expect(await startupCode(viaEnv())).toEqual({ code: "database_open_failed", subject: dbPath });
  });

  test("database_open_failed when the database path is a directory", async () => {
    const dbPath = join(dataDir, DATABASE_FILE);
    await mkdir(dbPath);
    expect(await startupCode(viaEnv())).toEqual({ code: "database_open_failed", subject: dbPath });
  });

  test("migration_failed when the database cannot be migrated", async () => {
    const dbPath = join(dataDir, DATABASE_FILE);
    const opened = openDatabase(dbPath);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }
    const conflicting = opened.value;
    conflicting.$client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)");
    conflicting.$client.close();

    expect(await startupCode(viaEnv())).toEqual({ code: "migration_failed", subject: dbPath });
  });

  /** A migrated database whose `users` table `change` edits, closed again. */
  function migratedWith(change: (db: ZeNormDatabase) => void): string {
    const dbPath = join(dataDir, DATABASE_FILE);
    const opened = openDatabase(dbPath);
    if (!opened.ok) throw new Error(opened.error.message);
    const migrated = migrateDatabase(opened.value, MIGRATIONS_FOLDER);
    if (!migrated.ok) throw new Error(migrated.error.message);
    change(opened.value);
    opened.value.$client.close();
    return dbPath;
  }

  test("user_missing when the users table has no row", async () => {
    const dbPath = migratedWith((db) => {
      db.delete(users).run();
    });
    expect(await startupCode(viaEnv())).toEqual({ code: "user_missing", subject: dbPath });
  });

  test("user_ambiguous when the users table has more than one row", async () => {
    const dbPath = migratedWith((db) => {
      db.insert(users)
        .values({ id: "0".repeat(32), createdAt: new Date().toISOString() })
        .run();
    });
    expect(await startupCode(viaEnv())).toEqual({ code: "user_ambiguous", subject: dbPath });
  });
});

describe("startZeNorm", () => {
  function zenormInput(): ZeNormInput {
    return {
      ...viaEnv(),
      plugins: [],
      logError: (message, error) => {
        throw new Error(message, { cause: error });
      },
    };
  }

  test("executor_unknown: delivery.executor names nothing registered, with no plugins", async () => {
    await writeConfig({
      server: { host: "127.0.0.1", port: 4310 },
      dataDir,
      agent,
      delivery: { ...delivery, executor: "remote" },
      plugins: {},
    });
    const result = await startZeNorm(zenormInput());
    expect(!result.ok && { code: result.error.code, subject: result.error.subject }).toEqual({
      code: "executor_unknown",
      subject: "remote",
    });
    // Refused before the database is opened or migrated: the empty dataDir stays empty.
    expect(await readdir(dataDir)).toEqual([]);
  });

  test("plugin_config_unknown_section: a plugins section with no plugin", async () => {
    await writeConfig({
      server: { host: "127.0.0.1", port: 4310 },
      dataDir,
      agent,
      delivery,
      plugins: { example: {} },
    });
    const result = await startZeNorm(zenormInput());
    expect(!result.ok && result.error.code).toBe("plugin_config_unknown_section");
    expect(await readdir(dataDir)).toEqual([]);
  });

  test("a config whose delivery section has only today's keys and no gh key starts the app with the pull request writer", async () => {
    expect(Object.keys(delivery).sort()).toEqual([
      "checkTimeoutMinutes",
      "effort",
      "executor",
      "model",
      "orchestratorMaxTurns",
      "orchestratorTimeoutMinutes",
      "reviewerMaxTurns",
      "reviewerTimeoutMinutes",
    ]);
    const result = await startZeNorm(zenormInput());
    if (!result.ok) throw new Error(result.error.code);
    closers.push(() => {
      result.value.db.$client.close();
    });
    expect(JSON.stringify(result.value.config)).not.toMatch(/"gh/i);
    await result.value.app.stopPlanningRuns();
    await result.value.app.stopDeliveryRuns();
    await result.value.app.stopPlugins();
  });

  test("the local executor with no plugins starts the app", async () => {
    const result = await startZeNorm(zenormInput());
    if (!result.ok) throw new Error(result.error.code);
    closers.push(() => {
      result.value.db.$client.close();
    });
    const listed = await result.value.app.request("http://127.0.0.1:4310/plugins", {
      headers: { host: "127.0.0.1:4310" },
    });
    expect(await listed.json()).toEqual([]);
    await result.value.app.stopPlanningRuns();
    await result.value.app.stopDeliveryRuns();
    await result.value.app.stopPlugins();
  });

  test("the app serves the Host of the config's server section and no other", async () => {
    await writeConfig({
      server: { host: "zenorm.example", port: 4312 },
      dataDir,
      agent,
      delivery,
      plugins: {},
    });
    // The guard logs each refusal through `logError`; this input collects them.
    const refusals: string[] = [];
    const result = await startZeNorm({
      ...zenormInput(),
      logError: (message) => {
        refusals.push(message);
      },
    });
    if (!result.ok) throw new Error(result.error.code);
    closers.push(() => {
      result.value.db.$client.close();
    });
    const { app } = result.value;
    const hostStatus = async (host: string): Promise<number> =>
      (await app.request("http://zenorm.example:4312/healthz", { headers: { host } })).status;

    expect(await hostStatus("zenorm.example:4312")).toBe(200);
    expect(await hostStatus("127.0.0.1:4312")).toBe(200);
    expect(refusals).toEqual([]);
    expect(await hostStatus("zenorm.example:4310")).toBe(403);
    expect(await hostStatus("127.0.0.1:4310")).toBe(403);
    expect(refusals).toHaveLength(2);
    await app.stopPlanningRuns();
    await app.stopDeliveryRuns();
    await app.stopPlugins();
  });

  test("a database an earlier build migrated migrates forward and serves its maps", async () => {
    const projectId = "01900000-0000-7000-8000-000000000001";
    const mapId = "01900000-0000-7000-8000-000000000002";
    const opened = openDatabase(join(dataDir, DATABASE_FILE));
    if (!opened.ok) throw new Error(opened.error.message);
    const db = opened.value;
    const migrated = migrateDatabase(db, await earlierMigrations());
    if (!migrated.ok) throw new Error(migrated.error.message);
    const user = db.select({ id: users.id }).from(users).get();
    if (user === undefined) throw new Error("the migrations created no user");
    const createdAt = new Date().toISOString();
    const map = {
      id: mapId,
      projectId,
      idea: "An earlier map",
      createdAt,
      fogNextPosition: 1,
      userId: user.id,
    };
    // In SQL: the earlier build's projects table lacks the columns the last migration adds.
    db.$client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at, required_checks) values (?, ?, 'main', ?, '[]')",
      )
      .run(projectId, root, createdAt);
    db.insert(maps).values(map).run();
    db.$client.close();
    const earlierRows = appliedMigrations();

    const result = await startZeNorm(zenormInput());
    if (!result.ok) throw new Error(result.error.code);
    const { app } = result.value;
    closers.push(() => {
      result.value.db.$client.close();
    });
    expect(appliedMigrations().length).toBeGreaterThan(earlierRows.length);
    const response = await app.request("http://127.0.0.1:4310/rpc/map/list", {
      method: "POST",
      headers: { host: "127.0.0.1:4310", "content-type": "application/json" },
      body: JSON.stringify({ json: { projectId }, meta: [] }),
    });
    const listed = ListedMaps.parse(await response.json());
    expect(listed.json.map(({ id }) => id)).toEqual([mapId]);
    await app.stopPlanningRuns();
    await app.stopDeliveryRuns();
    await app.stopPlugins();
  });
});

describe("shutDown", () => {
  test("stops planning and delivery runs together, and closes the database only after both and the server", async () => {
    const steps: string[] = [];
    const settle: Record<"planning" | "delivery", () => void> = {
      planning: () => {
        throw new Error("stopPlanningRuns was not called");
      },
      delivery: () => {
        throw new Error("stopDeliveryRuns was not called");
      },
    };
    const stop = (kind: "planning" | "delivery") => () =>
      new Promise<void>((resolve) => {
        steps.push(`${kind} stopping`);
        settle[kind] = () => {
          steps.push(`${kind} settled`);
          resolve();
        };
      });
    const done = shutDown({
      closeServer: async () => {
        steps.push("server closing");
        await Promise.resolve();
        steps.push("server closed");
      },
      stopPlanningRuns: stop("planning"),
      stopDeliveryRuns: stop("delivery"),
      stopPlugins: () => {
        steps.push("plugins stopped");
        return Promise.resolve();
      },
      closeDatabase: () => {
        steps.push("database closed");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both stops started at once, before either settled.
    expect(steps).toEqual([
      "server closing",
      "planning stopping",
      "delivery stopping",
      "server closed",
    ]);
    settle.delivery();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steps).not.toContain("database closed");
    settle.planning();
    await done;
    expect(steps).toEqual([
      "server closing",
      "planning stopping",
      "delivery stopping",
      "server closed",
      "delivery settled",
      "planning settled",
      "plugins stopped",
      "database closed",
    ]);
  });
});

describe("startAndListen", () => {
  test("server_port_in_use when the port is taken: no run is marked interrupted or relaunched, and the data folder is freed", async () => {
    const taken = createServer();
    taken.listen(0, "127.0.0.1");
    await once(taken, "listening");
    const address = taken.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await writeConfig({
      server: { host: "127.0.0.1", port: address.port },
      dataDir,
      agent,
      delivery,
      plugins: {},
    });
    // A planning run an earlier server left running; launching would sweep it as interrupted.
    const runId = "01900000-0000-7000-8000-000000000003";
    const opened = openDatabase(join(dataDir, DATABASE_FILE));
    if (!opened.ok) throw new Error(opened.error.message);
    const db = opened.value;
    const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
    if (!migrated.ok) throw new Error(migrated.error.message);
    const createdAt = new Date().toISOString();
    db.$client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at) values (?, ?, 'main', ?)",
      )
      .run("01900000-0000-7000-8000-000000000001", root, createdAt);
    db.$client
      .prepare("insert into maps (id, project_id, idea, created_at) values (?, ?, 'An idea', ?)")
      .run(
        "01900000-0000-7000-8000-000000000002",
        "01900000-0000-7000-8000-000000000001",
        createdAt,
      );
    db.$client
      .prepare(
        "insert into planning_runs (id, map_id, purpose, state, started_at) values (?, ?, 'chart', 'running', ?)",
      )
      .run(runId, "01900000-0000-7000-8000-000000000002", createdAt);
    db.$client.close();

    try {
      const result = await startAndListen(
        { args: [], standardConfigPath: null, plugins: [], webDistDir, ...SOURCE_ASSETS },
        { [CONFIG_ENV_VAR]: configFile },
      );
      expect(!result.ok && { code: result.error.code, subject: result.error.subject }).toEqual({
        code: "server_port_in_use",
        subject: `127.0.0.1:${String(address.port)}`,
      });
    } finally {
      taken.close();
    }

    const reopened = openDatabase(join(dataDir, DATABASE_FILE));
    if (!reopened.ok) throw new Error(reopened.error.message);
    const state: unknown = reopened.value.$client
      .prepare("select state from planning_runs where id = ?")
      .pluck()
      .get(runId);
    reopened.value.$client.close();
    expect(state).toBe("running");
    expect(await startupCode(viaEnv())).toBeNull();
  });
});
