import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SONNET_LIMITS } from "@zenorm/contracts";
import type { StartupError } from "@zenorm/contracts";
import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";
import { DATABASE_FILE, startup } from "@zenorm/zenorm/startup";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCli } from "./cli.ts";
import type { CliInput, Command, CommandEnd, Env } from "./cli.ts";
import { withCommands } from "./commands.ts";
import { DOCTOR_CHECKS, doctorCommand } from "./doctor.ts";
import type { DoctorCheck } from "./doctor.ts";
import { initConfig } from "./init.ts";
import { MINIMUM_NODE_VERSION } from "./packaged.ts";

/** The repository's stand-in claude (`apps/zenorm/e2e/fake-claude.ts`). */
const FAKE_CLAUDE = createRequire(import.meta.url).resolve("@zenorm/zenorm/e2e/fake-claude");
const MODEL = "claude-sonnet-5-5";
const STAND_IN_TAG = "9999_stand_in";
// A view, not a table: `migrate` starts on it, and the change feed refuses a table it has no entry
// for. This package cannot import `@zenorm/db` to migrate without starting.
const STAND_IN_SQL = "CREATE VIEW `stand_in` AS SELECT 1 AS `id`;\n";

/** A `claude` that runs the stand-in with this Node whatever the PATH, after `prefix`. */
function standInScript(prefix: string): string {
  return `#!/bin/sh\n${prefix}exec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`;
}

let home: string;
let dataDir: string;
let webDistDir: string;
let configFile: string;
let claudePath: string;
let reported: StartupError[];
let checks: DoctorCheck[];

const unreached: Command = () => {
  throw new Error("only run and doctor run in these tests");
};

/** `zenorm <argv>` with `env`, the repository's skills and migrations and the test's web build. */
function zenorm(argv: readonly string[], env: Env): Promise<CommandEnd> {
  const input: CliInput = {
    argv,
    env,
    platform: "linux",
    nodeVersion: MINIMUM_NODE_VERSION,
    assets: { webDistDir, ...SOURCE_ASSETS },
    writeOut: () => {
      throw new Error("these tests ask for no help or version");
    },
  };
  const doctor = doctorCommand((check) => {
    checks.push(check);
  });
  return runCli(input, withCommands({ init: unreached, doctor }), (error) => {
    reported.push(error);
  });
}

/** `HOME` at the test's folder and the process's `PATH`, where git is. */
function machineEnv(): Env {
  return { HOME: home, PATH: process.env.PATH };
}

/** A config as `zenorm init` writes it, with the stand-in claude and `dataDir`. */
async function writeConfig(configDataDir: string): Promise<void> {
  const config = initConfig(
    configDataDir,
    claudePath,
    { model: MODEL, fastMode: false },
    SONNET_LIMITS,
  );
  await writeFile(configFile, JSON.stringify(config));
}

/** `zenorm run`'s startup on the config, migrating with `migrationsFolder`; then closed. */
async function migrate(migrationsFolder: string): Promise<void> {
  const started = await startup({
    args: ["--config", configFile],
    env: {},
    standardConfigPath: null,
    webDistDir,
    skillsDir: SOURCE_ASSETS.skillsDir,
    migrationsFolder,
    log: () => undefined,
  });
  if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
  started.value.db.$client.close();
}

interface Journal {
  readonly entries: readonly { readonly when: number }[];
}

function isEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  return "when" in entry && typeof entry.when === "number";
}

function isJournal(value: unknown): value is Journal {
  if (typeof value !== "object" || value === null || !("entries" in value)) return false;
  const { entries } = value;
  return Array.isArray(entries) && entries.every(isEntry);
}

/** The shipped migrations and one stand-in after the last, as a newer build ships them (5.2). */
async function newerMigrations(): Promise<string> {
  const folder = join(home, "migrations-newer");
  await cp(SOURCE_ASSETS.migrationsFolder, folder, { recursive: true });
  const journalFile = join(folder, "meta", "_journal.json");
  const journal: unknown = JSON.parse(await readFile(journalFile, "utf8"));
  if (!isJournal(journal)) throw new Error("the shipped journal is not a journal");
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("the shipped journal has no entry");
  const idx = journal.entries.length;
  const standIn = { ...last, idx, when: last.when + 1000, tag: STAND_IN_TAG };
  const entries = [...journal.entries, standIn];
  await writeFile(journalFile, JSON.stringify({ ...journal, entries }));
  await writeFile(join(folder, `${STAND_IN_TAG}.sql`), STAND_IN_SQL);
  return folder;
}

/** Each failed check doctor reported: its name and code. */
function failures(): { name: string; code: string }[] {
  const failed: { name: string; code: string }[] = [];
  for (const { name, outcome } of checks) {
    if (outcome.kind === "failed") failed.push({ name, code: outcome.error.code });
  }
  return failed;
}

function kinds(): Record<string, string> {
  return Object.fromEntries(checks.map(({ name, outcome }) => [name, outcome.kind]));
}

beforeEach(async () => {
  reported = [];
  checks = [];
  home = await mkdtemp(join(tmpdir(), "zenorm-doctor-"));
  dataDir = join(home, "data");
  await mkdir(dataDir);
  webDistDir = join(home, "web");
  await mkdir(webDistDir);
  await writeFile(join(webDistDir, "index.html"), "<!doctype html>");
  configFile = join(home, "config.json");
  // Signed in to claude.ai unless its environment names a sign-in state file.
  claudePath = join(home, "claude");
  await writeFile(claudePath, standInScript(""));
  await chmod(claudePath, 0o755);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("zenorm doctor (C5, 5.4)", () => {
  test("everything passing exits 0 and leaves the config and database files unchanged", async () => {
    await writeConfig(dataDir);
    await migrate(SOURCE_ASSETS.migrationsFolder);
    const configBefore = await readFile(configFile);
    const databaseBefore = await readFile(join(dataDir, DATABASE_FILE));

    expect(await zenorm(["doctor", "--config", configFile], machineEnv())).toBe(0);
    expect(reported).toEqual([]);
    expect(checks.map(({ name }) => name)).toEqual(DOCTOR_CHECKS);
    expect(failures()).toEqual([]);
    expect(Object.values(kinds()).every((kind) => kind === "passed")).toBe(true);
    expect(await readFile(configFile)).toEqual(configBefore);
    expect(await readFile(join(dataDir, DATABASE_FILE))).toEqual(databaseBefore);
  });

  test("a data folder with no database yet passes, and doctor creates none", async () => {
    await writeConfig(dataDir);
    expect(await zenorm(["doctor", "--config", configFile], machineEnv())).toBe(0);
    expect(await readdir(dataDir)).toEqual([]);
  });

  test("git off PATH and a bad dataDir: both fail with their codes, the rest still run, exit 1", async () => {
    const noGit = join(home, "empty-bin");
    await mkdir(noGit);
    await writeConfig(join(home, "no-such-data"));

    const env = { HOME: home, PATH: noGit };
    expect(await zenorm(["doctor", "--config", configFile], env)).toBe(1);
    expect(reported).toEqual([]);
    expect(failures()).toEqual([
      { name: "data_dir", code: "data_dir_missing" },
      { name: "git", code: "git_missing" },
    ]);
    expect(kinds()).toMatchObject({
      config: "passed",
      claude: "passed",
      sign_in: "passed",
      web_build: "passed",
      database: "skipped",
    });
  });

  test("a database a newer build migrated is database_newer_than_build, and stays as it was (5.2)", async () => {
    await writeConfig(dataDir);
    await migrate(await newerMigrations());
    const databaseBefore = await readFile(join(dataDir, DATABASE_FILE));

    expect(await zenorm(["doctor", "--config", configFile], machineEnv())).toBe(1);
    expect(failures()).toEqual([{ name: "database", code: "database_newer_than_build" }]);
    expect(await readFile(join(dataDir, DATABASE_FILE))).toEqual(databaseBefore);
  });

  test("a signed-out claude fails the sign-in check with agent_not_logged_in", async () => {
    await writeConfig(dataDir);
    const authFile = join(home, "fake-auth");
    await writeFile(authFile, "signed_out");
    const env = { ...machineEnv(), ZENORM_FAKE_AUTH_FILE: authFile };
    expect(await zenorm(["doctor", "--config", configFile], env)).toBe(1);
    expect(failures()).toEqual([{ name: "sign_in", code: "agent_not_logged_in" }]);
  });

  test("no config file: config_file_missing, its checks skipped, git and the web build still checked", async () => {
    expect(await zenorm(["doctor"], machineEnv())).toBe(1);
    expect(failures()).toEqual([{ name: "config", code: "config_file_missing" }]);
    expect(kinds()).toMatchObject({
      data_dir: "skipped",
      claude: "skipped",
      sign_in: "skipped",
      git: "passed",
      web_build: "passed",
      database: "skipped",
    });
  });

  test("an unknown flag is arguments_invalid, with no check run", async () => {
    expect(await zenorm(["doctor", "--fix"], machineEnv())).toBe(1);
    expect(reported.map(({ code }) => code)).toEqual(["arguments_invalid"]);
    expect(checks).toEqual([]);
  });
});

describe("zenorm run's sign-in check (C5)", () => {
  test("a signed-out claude refuses agent_not_logged_in before listening or opening the database", async () => {
    const authFile = join(home, "fake-auth");
    await writeFile(authFile, "signed_out");
    await writeConfig(dataDir);

    // `run` reads the sign-in with the environment it is given, as doctor does.
    const env = { ...machineEnv(), ZENORM_FAKE_AUTH_FILE: authFile };
    expect(await zenorm(["run", "--config", configFile], env)).toBe(1);
    expect(reported.map(({ code }) => code)).toEqual(["agent_not_logged_in"]);
    expect(await readdir(dataDir)).toEqual([]);
  });
});
