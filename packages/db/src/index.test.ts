import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok } from "@zenorm/contracts";
import { SqliteError } from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  checkDatabaseFile,
  claimInstanceLock,
  INSTANCE_LOCK_FILE,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
} from "./index.ts";
import { codeSurveys, deliveryRuns, hatchMessages, projects, questionRounds } from "./schema.ts";
import type { ZeNormDatabase } from "./index.ts";
import { ticketSetVersions, waypoints } from "./schema.ts";

let dir: string;
let db: ZeNormDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zenorm-db-"));
  const opened = openDatabase(join(dir, "zenorm.sqlite"));
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  db = opened.value;
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

/** The rows dumped for the table at `index`; a missing dump is a broken test, not an empty table. */
function rowsAt(dumps: Record<string, unknown>[][], index: number): Record<string, unknown>[] {
  const rows = dumps[index];
  if (rows === undefined) throw new Error(`no dump at index ${String(index)}`);
  return rows;
}

function tableNames(): unknown[] {
  return db.$client
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .pluck()
    .all();
}

describe("openDatabase", () => {
  test("turns on WAL and foreign keys", () => {
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  test("returns database_open_failed when the path is a directory", async () => {
    const path = join(dir, "a-directory.sqlite");
    await mkdir(path);
    expect(openDatabase(path)).toMatchObject({
      ok: false,
      error: { code: "database_open_failed", subject: path },
    });
  });

  test("returns database_open_failed when the file is not a SQLite database", async () => {
    const path = join(dir, "not-sqlite.sqlite");
    await writeFile(path, "this is not a SQLite database file. ".repeat(20));
    expect(openDatabase(path)).toMatchObject({
      ok: false,
      error: { code: "database_open_failed", subject: path },
    });
  });
});

describe("claimInstanceLock", () => {
  /** A second connection to the same database, as a second ZeNorm would open it. */
  function openSecond(): ZeNormDatabase {
    const opened = openDatabase(join(dir, "zenorm.sqlite"));
    if (!opened.ok) throw new Error(opened.error.message);
    return opened.value;
  }

  test("a second claim on the data folder is data_dir_in_use at once, until the first closes", () => {
    const lockPath = join(dir, INSTANCE_LOCK_FILE);
    expect(claimInstanceLock(db, lockPath)).toEqual(ok(undefined));

    const second = openSecond();
    const startedAt = Date.now();
    const refused = claimInstanceLock(second, lockPath);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(!refused.ok && { code: refused.error.code, subject: refused.error.subject }).toEqual({
      code: "data_dir_in_use",
      subject: lockPath,
    });
    // The refused connection keeps its own busy timeout.
    expect(second.$client.pragma("busy_timeout", { simple: true })).toBe(5000);
    second.$client.close();

    db.$client.close();
    const third = openSecond();
    expect(claimInstanceLock(third, lockPath)).toEqual(ok(undefined));
    third.$client.close();
  });

  test("the holder migrates and writes, and a read-only check still reads the database", () => {
    expect(claimInstanceLock(db, join(dir, INSTANCE_LOCK_FILE)).ok).toBe(true);
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    expect(checkDatabaseFile(join(dir, "zenorm.sqlite"), MIGRATIONS_FOLDER)).toEqual(ok("current"));
  });

  test("a lock path SQLite cannot open is database_open_failed", async () => {
    const lockPath = join(dir, "a-directory.lock");
    await mkdir(lockPath);
    const refused = claimInstanceLock(db, lockPath);
    expect(!refused.ok && refused.error.code).toBe("database_open_failed");
  });
});

describe("migrateDatabase", () => {
  test("creates every table on a fresh file", () => {
    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });
    expect(tableNames()).toEqual([
      "change_feed",
      "code_surveys",
      "consistency_findings",
      "consistency_passes",
      "delivery_run_events",
      "delivery_run_tickets",
      "delivery_runs",
      "hatch_messages",
      "map_exclusions",
      "map_fog",
      "map_proposals",
      "maps",
      "planning_runs",
      "projects",
      "question_rounds",
      "research_reports",
      "research_sources",
      "spec_review_findings",
      "spec_reviews",
      "spec_revisions",
      "spec_waits",
      "specifications",
      "sqlite_sequence",
      "task_outcomes",
      "ticket_set_rejections",
      "ticket_set_versions",
      "ticket_sets",
      "tickets_review_findings",
      "tickets_reviews",
      "users",
      "waypoint_blockers",
      "waypoint_touches",
      "waypoints",
      "write_actor",
      "zenorm_migrations",
    ]);
  });

  test("migrating again is a no-op", () => {
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    const schemaBefore = db.$client.prepare("select type, name, sql from sqlite_master").all();
    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });
    expect(db.$client.prepare("select type, name, sql from sqlite_master").all()).toEqual(
      schemaBefore,
    );
    expect(db.$client.prepare("select count(*) from zenorm_migrations").pluck().get()).toBe(37);
  });

  test("returns migration_failed when a migration cannot apply", () => {
    db.$client.exec("create table projects (id text)");
    const result = migrateDatabase(db, MIGRATIONS_FOLDER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("migration_failed");
      expect(result.error.subject).toBe(join(dir, "zenorm.sqlite"));
    }
  });
});

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const TAGS = [
  "0000_projects",
  "0001_maps_and_question_rounds",
  "0002_spec_revisions_and_ticket_sets",
  "0003_delivery_runs",
  "0004_projects_drop_name",
  "0005_wayfinding",
  "0006_research_task_fog",
  "0007_specs_and_reviews",
  "0008_hatch_messages_and_reopen",
  "0009_tickets_review_routes",
  "0010_delivery_completion",
  "0011_revising_delivered_spec",
  "0012_hatch_change_fog_lists",
  "0013_person_decides",
  "0014_ticket_pointers",
  "0015_retained_reason",
  "0016_planning_run_usage",
  "0017_code_surveys",
  "0018_spec_revision_removals",
  "0019_fog_runs",
  "0020_users_actor_change_feed",
  "0021_spec_review_verified",
  "0022_task_round_options",
  "0023_unanswered_optionless_rounds",
  "0024_delivery_resume",
  "0025_tickets_stage",
  "0026_map_proposals",
  "0027_hatch_map_proposals",
  "0028_map_proposal_titles",
  "0029_map_proposal_kinds",
  "0030_delivery_pull_requests",
  "0031_spec_review_per_rewrite",
  "0032_project_repair_settings",
  "0033_delivery_run_repairs",
  "0034_first_map_round_not_final",
  "0035_agent_decided",
  "0036_project_app_settings",
  "0037_delivery_run_app_settings",
];

/** The split-from columns 0026 gives every map, null on each map that predates it. */
const SPLIT_FROM_NULLS = { split_from_map_id: null, split_from_run_id: null };

/**
 * 0020 gives every map, planning run and delivery run the one User, and every delivery run the
 * executor `local`; 0024 starts every delivery run at its base commit, resuming none; 0026 gives
 * every map its null split-from columns; 0030 gives every delivery run no pull request; 0033 pins
 * no repair settings on every delivery run; 0034 gives every resolved waypoint no agent-decided
 * calls.
 */
function withUser(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "waypoints") {
    return { ...row, agent_decided: row.status === "resolved" ? "[]" : null };
  }
  if (!["maps", "planning_runs", "delivery_runs"].includes(table)) return row;
  const user_id = db.$client.prepare("select id from users").pluck().get();
  if (table === "delivery_runs") return { ...row, user_id, ...runColumnsAfter0020(row) };
  return table === "maps" ? { ...row, user_id, ...SPLIT_FROM_NULLS } : { ...row, user_id };
}

/** The pull request columns 0030 gives every delivery run, null on each run that predates it. */
const PULL_REQUEST_NULLS = { pr_number: null, pr_url: null, pr_state: null };

/** The repair columns 0033 gives every delivery run that predates it: none pinned, none counted. */
const REPAIRS_UNPINNED = { repair_limit: null, repair_attempts: null, fix_commands: "[]" };

/** The app columns 0037 gives every delivery run that predates it: none pinned, capture off. */
const APP_SETTINGS_UNPINNED = { app_start_command: null, app_url: null, app_setup_commands: "[]" };

/** The columns 0020, 0024, 0030, 0033 and 0037 add to a delivery run, as they set them. */
function runColumnsAfter0020(row: Record<string, unknown>): Record<string, unknown> {
  return {
    executor: "local",
    start_commit: row.base_commit,
    resumed_from_run_id: null,
    ...PULL_REQUEST_NULLS,
    ...REPAIRS_UNPINNED,
    ...APP_SETTINGS_UNPINNED,
  };
}

/**
 * The repair settings 0032 gives every project that predates it, no limit and no fix commands, and
 * the app settings 0036 gives it: no start command, no URL and no setup commands.
 */
const REPAIR_SETTINGS_UNSAVED = {
  repair_limit: null,
  fix_commands: "[]",
  app_start_command: null,
  app_url: null,
  app_setup_commands: "[]",
};

/** The usage columns 0016 gives every planning run, null on each run that predates it. */
const USAGE_NULLS = {
  session_id: null,
  result_subtype: null,
  num_turns: null,
  duration_ms: null,
  total_cost_usd: null,
  input_tokens: null,
  output_tokens: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
};

/** Migrates `db` up to and including `last` alone, from a copy of the folder without the rest. */
async function migrateUpTo(last: string): Promise<void> {
  const tags = TAGS.slice(0, TAGS.indexOf(last) + 1);
  expect(tags.at(-1)).toBe(last);
  const folder = join(dir, `migrations-${last}`);
  await mkdir(join(folder, "meta"), { recursive: true });
  for (const tag of tags) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  const journal = z
    .object({ entries: z.array(z.object({ tag: z.string() }).loose()) })
    .loose()
    .parse(JSON.parse(await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8")));
  const entries = journal.entries.filter((entry) => tags.includes(entry.tag));
  expect(entries.map((entry) => entry.tag)).toEqual(tags);
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  migrate(db, { migrationsFolder: folder, migrationsTable: "zenorm_migrations" });
}

/** The shipped migrations and one stand-in after the last, as a newer build ships them. */
async function newerMigrations(): Promise<string> {
  const folder = join(dir, "migrations-newer");
  await cp(MIGRATIONS, folder, { recursive: true });
  const journalFile = join(folder, "meta", "_journal.json");
  const journal = z
    .object({ entries: z.array(z.object({ when: z.number() }).loose()) })
    .loose()
    .parse(JSON.parse(await readFile(journalFile, "utf8")));
  const last = journal.entries.at(-1);
  if (last === undefined) throw new Error("the shipped journal has no entry");
  const tag = "9999_stand_in";
  await writeFile(join(folder, `${tag}.sql`), "CREATE TABLE `stand_in` (`id` integer);\n");
  const standIn = { ...last, idx: journal.entries.length, when: last.when + 1000, tag };
  const entries = [...journal.entries, standIn];
  await writeFile(journalFile, JSON.stringify({ ...journal, entries }));
  return folder;
}

function migrationRows(): unknown[] {
  return db.$client.prepare("select * from zenorm_migrations order by id").all();
}

describe("a database newer than the build", () => {
  test("migrateDatabase refuses database_newer_than_build and leaves the rows as they were", async () => {
    expect(migrateDatabase(db, await newerMigrations()).ok).toBe(true);
    const before = migrationRows();
    expect(before).toHaveLength(TAGS.length + 1);
    const result = migrateDatabase(db, MIGRATIONS_FOLDER);
    expect(!result.ok && { code: result.error.code, subject: result.error.subject }).toEqual({
      code: "database_newer_than_build",
      subject: join(dir, "zenorm.sqlite"),
    });
    expect(migrationRows()).toEqual(before);
    expect(tableNames()).toContain("stand_in");
  });

  test("an earlier migration set migrates forward", async () => {
    await migrateUpTo("0035_agent_decided");
    expect(migrationRows()).toHaveLength(TAGS.length - 1);
    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });
    expect(migrationRows()).toHaveLength(TAGS.length);
  });

  test("checkDatabaseFile reads without writing: absent, current, or newer", async () => {
    expect(checkDatabaseFile(join(dir, "none.sqlite"), MIGRATIONS_FOLDER)).toEqual(ok("absent"));
    expect(existsSync(join(dir, "none.sqlite"))).toBe(false);
    const path = join(dir, "zenorm.sqlite");
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    expect(checkDatabaseFile(path, MIGRATIONS_FOLDER)).toEqual(ok("current"));

    const newer = await newerMigrations();
    expect(migrateDatabase(db, newer).ok).toBe(true);
    const before = migrationRows();
    const checked = checkDatabaseFile(path, MIGRATIONS_FOLDER);
    expect(!checked.ok && { code: checked.error.code, subject: checked.error.subject }).toEqual({
      code: "database_newer_than_build",
      subject: path,
    });
    expect(checkDatabaseFile(path, newer)).toEqual(ok("current"));
    expect(migrationRows()).toEqual(before);
  });

  test("checkDatabaseFile: a file that is not SQLite is database_open_failed", async () => {
    const path = join(dir, "not-sqlite.sqlite");
    await writeFile(path, "this is not a SQLite database file. ".repeat(20));
    const checked = checkDatabaseFile(path, MIGRATIONS_FOLDER);
    expect(!checked.ok && checked.error.code).toBe("database_open_failed");
  });
});

describe("migrations that rebuild a table", () => {
  /** Rebuilt before `migrateDatabase` turned keys off and already applied: left as they are. */
  const BEFORE_THE_GUARD = ["0005_wayfinding.sql", "0007_specs_and_reviews.sql"];
  const folder = fileURLToPath(new URL("../migrations/", import.meta.url));

  test("each ends with its foreign key violation guard", async () => {
    const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
    const rebuilding: string[] = [];
    for (const file of files) {
      const sql = await readFile(join(folder, file), "utf8");
      const number = file.slice(0, 4);
      const guard = `zenorm_${number}_foreign_key_violations`;
      const drops = [...sql.matchAll(/DROP TABLE `([^`]+)`/g)].map((match) => match[1]);
      if (drops.every((table) => table === guard)) continue;
      rebuilding.push(file);
      if (BEFORE_THE_GUARD.includes(file)) continue;
      const statements = sql
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement !== "");
      expect(statements.slice(-3), file).toEqual([
        `CREATE TEMP TABLE \`${guard}\` (\`count\` integer NOT NULL CHECK(\`count\` = 0));`,
        `INSERT INTO \`${guard}\` SELECT count(*) FROM pragma_foreign_key_check;`,
        `DROP TABLE \`${guard}\`;`,
      ]);
    }
    expect(rebuilding).toEqual([
      ...BEFORE_THE_GUARD,
      "0008_hatch_messages_and_reopen.sql",
      "0009_tickets_review_routes.sql",
      "0010_delivery_completion.sql",
      "0011_revising_delivered_spec.sql",
      "0013_person_decides.sql",
      "0017_code_surveys.sql",
      "0019_fog_runs.sql",
      "0025_tickets_stage.sql",
      "0027_hatch_map_proposals.sql",
      "0028_map_proposal_titles.sql",
      "0029_map_proposal_kinds.sql",
      "0030_delivery_pull_requests.sql",
      "0034_first_map_round_not_final.sql",
      "0035_agent_decided.sql",
    ]);
  });
});

describe("migration 0004", () => {
  async function migrateTo0003(): Promise<void> {
    await migrateUpTo("0003_delivery_runs");
  }

  function columns(): unknown[] {
    return db.$client.prepare("select name from pragma_table_info('projects')").pluck().all();
  }

  test("drops projects.name and keeps every other column, row and the folder_path index", async () => {
    await migrateTo0003();
    expect(columns()).toEqual(["id", "name", "folder_path", "base_branch", "created_at"]);
    const rows = [
      [
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51",
        "Typed name",
        "/repos/one",
        "main",
        "2026-10-01T09:00:00.000Z",
      ],
      [
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52",
        "Other",
        "/repos/two",
        "trunk",
        "2026-10-02T09:00:00.000Z",
      ],
    ];
    const insert = db.$client.prepare(
      "insert into projects (id, name, folder_path, base_branch, created_at) values (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(...row);
    }

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    // 0010 then adds `required_checks`, 0030 `repair_limit` and `fix_commands`, and 0036 the app
    // settings.
    expect(columns()).toEqual([
      "id",
      "folder_path",
      "base_branch",
      "created_at",
      "required_checks",
      "repair_limit",
      "fix_commands",
      "app_start_command",
      "app_url",
      "app_setup_commands",
    ]);
    expect(
      db.$client
        .prepare("select id, folder_path, base_branch, created_at from projects order by id")
        .raw()
        .all(),
    ).toEqual(
      rows.map(([id, , folderPath, baseBranch, createdAt]) => [
        id,
        folderPath,
        baseBranch,
        createdAt,
      ]),
    );
    expect(() =>
      db.$client
        .prepare(
          "insert into projects (id, folder_path, base_branch, created_at) values (?, ?, ?, ?)",
        )
        .run(
          "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53",
          "/repos/one",
          "main",
          "2026-10-03T09:00:00.000Z",
        ),
    ).toThrow(SqliteError);
  });
});

describe("migration 0005", () => {
  const at = "2026-10-07T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51";

  function count(table: string): unknown {
    return db.$client.prepare(`select count(*) from ${table}`).pluck().get();
  }

  test("keeps projects and empties maps and everything that hangs off them", async () => {
    await migrateUpTo("0004_projects_drop_name");
    const run = (statement: string, ...values: unknown[]) =>
      db.$client.prepare(statement).run(...values);
    run(
      "insert into projects (id, folder_path, base_branch, created_at) values (?, ?, ?, ?)",
      projectId,
      "/repos/one",
      "main",
      at,
    );
    const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52";
    run(
      "insert into maps (id, project_id, idea, created_at) values (?, ?, ?, ?)",
      mapId,
      projectId,
      "An idea",
      at,
    );
    run(
      "insert into question_rounds (id, map_id, intro, questions, answers, asked_at, submitted_at) values (?, ?, ?, ?, ?, ?, ?)",
      "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a53",
      mapId,
      "Intro",
      "[]",
      "[]",
      at,
      at,
    );
    const revisionId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a54";
    run(
      "insert into spec_revisions (id, map_id, revision, content, drafted_at, approved_at) values (?, ?, ?, ?, ?, ?)",
      revisionId,
      mapId,
      1,
      "{}",
      at,
      at,
    );
    const ticketSetId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a55";
    run(
      "insert into ticket_sets (id, map_id, spec_revision_id, version, content, drafted_at, approved_at) values (?, ?, ?, ?, ?, ?, ?)",
      ticketSetId,
      mapId,
      revisionId,
      1,
      "{}",
      at,
      at,
    );
    run(
      "insert into delivery_runs (id, ticket_set_id, number, branch, worktree_path, base_commit, checks, started_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a56",
      ticketSetId,
      1,
      "zenorm/branch",
      "/runs/x/worktree",
      "abc",
      "[]",
      at,
    );

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(
      db.$client
        .prepare("select id, folder_path, base_branch, created_at from projects")
        .raw()
        .all(),
    ).toEqual([[projectId, "/repos/one", "main", at]]);
    for (const table of [
      "maps",
      "question_rounds",
      "spec_revisions",
      "ticket_sets",
      "delivery_runs",
      "waypoints",
      "waypoint_blockers",
      "planning_runs",
    ]) {
      expect(count(table), table).toBe(0);
    }
    expect(db.$client.prepare("select name from pragma_table_info('maps')").pluck().all()).toEqual([
      "id",
      "project_id",
      "idea",
      "title",
      "summary",
      "destination",
      "destination_confirmed_at",
      "created_at",
      "fog_next_position",
      "user_id",
      "split_from_map_id",
      "split_from_run_id",
    ]);
  });
});

describe("migration 0006", () => {
  const at = "2026-10-08T12:00:00.000Z";
  const ids = Array.from(
    { length: 12 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b${index.toString().padStart(2, "0")}`,
  );
  const [projectId, mapId, chartRunId, grillRunId, oneId, twoId, roundId, specRunId, revisionId] =
    ids;
  const OLD_TABLES = [
    "projects",
    "maps",
    "planning_runs",
    "waypoints",
    "waypoint_blockers",
    "question_rounds",
    "spec_revisions",
    "ticket_sets",
    "delivery_runs",
  ];

  function dump(table: string): unknown[] {
    return db.$client.prepare(`select * from ${table} order by rowid`).all();
  }

  test("keeps every row of a filled 0005 database and sets fog_next_position to 1", async () => {
    await migrateUpTo("0005_wayfinding");
    const insert = (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      db.$client
        .prepare(
          `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(row));
    };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "Count lines",
      title: "Lines",
      summary: "Count lines.",
      destination: "wordcount counts lines.",
      destination_confirmed_at: at,
      created_at: at,
    });
    const ended = { state: "completed", started_at: at, ended_at: at };
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    for (const [waypointId, number] of [
      [oneId, 1],
      [twoId, 2],
    ] as const) {
      insert("waypoints", {
        id: waypointId,
        map_id: mapId,
        number,
        kind: "grilling",
        status: "open",
        title: `Waypoint ${String(number)}`,
        question: "What holds?",
        created_by_run: chartRunId,
      });
    }
    insert("waypoint_blockers", { map_id: mapId, waypoint_number: 2, blocker_number: 1 });
    insert("planning_runs", {
      id: grillRunId,
      map_id: mapId,
      waypoint_id: oneId,
      purpose: "grilling",
      state: "asked",
      started_at: at,
      ended_at: at,
    });
    insert("question_rounds", {
      id: roundId,
      map_id: mapId,
      waypoint_id: oneId,
      number: 1,
      final: 0,
      status: "pending",
      asked_by_run: grillRunId,
      intro: "Intro",
      questions: JSON.stringify([
        {
          topic: "Flag",
          text: "Which flag?",
          options: [
            { label: "-l", detail: "Short." },
            { label: "--lines", detail: "Long." },
          ],
        },
      ]),
      asked_at: at,
    });
    insert("planning_runs", { id: specRunId, map_id: mapId, purpose: "to_spec", ...ended });
    insert("spec_revisions", {
      id: revisionId,
      map_id: mapId,
      revision: 1,
      content: JSON.stringify({ title: "Lines", body: "Count lines.", criteria: ["Counts."] }),
      drafted_at: at,
    });
    const before = OLD_TABLES.map(dump);

    await migrateUpTo("0006_research_task_fog");

    const after = OLD_TABLES.map(dump);
    expect(after.slice(2)).toEqual(before.slice(2));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(
      z
        .array(z.looseObject({}))
        .parse(before[1])
        .map((row) => ({ ...row, fog_next_position: 1 })),
    );
    for (const table of [
      "map_fog",
      "map_exclusions",
      "research_reports",
      "research_sources",
      "task_outcomes",
      "consistency_passes",
      "consistency_findings",
    ]) {
      expect(db.$client.prepare(`select count(*) from ${table}`).pluck().get(), table).toBe(0);
    }
  });
});

/** The SQLite constraint code `insert` fails with, or undefined when it succeeds. */
function constraintOf(insert: () => void): unknown {
  try {
    insert();
  } catch (error: unknown) {
    if (!(error instanceof SqliteError)) throw error;
    return error.code;
  }
  return undefined;
}

describe("the Wayfinding tables", () => {
  const at = "2026-10-07T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
  const otherMapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
  const chartRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
  let nextId = 1;

  function id(): string {
    const value = `0199a1b2-c3d4-7e5f-8a9b-${nextId.toString().padStart(12, "0")}`;
    nextId += 1;
    return value;
  }

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function run(row: Record<string, unknown>): void {
    insert("planning_runs", {
      id: id(),
      map_id: mapId,
      waypoint_id: null,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
      ...row,
    });
  }

  function waypoint(row: Record<string, unknown>): void {
    insert("waypoints", {
      id: id(),
      map_id: mapId,
      kind: "grilling",
      status: "open",
      title: "A decision",
      question: "What holds?",
      created_by_run: chartRunId,
      person_decides: 0,
      ...row,
    });
  }

  function round(row: Record<string, unknown>): void {
    insert("question_rounds", {
      id: id(),
      map_id: mapId,
      waypoint_id: null,
      number: 1,
      final: 0,
      status: "pending",
      asked_by_run: chartRunId,
      intro: "Intro",
      questions: "[]",
      asked_at: at,
      ...row,
    });
  }

  const waypointOneId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61";
  const waypointTwoId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62";

  beforeEach(() => {
    nextId = 1;
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    for (const map of [mapId, otherMapId]) {
      insert("maps", { id: map, project_id: projectId, idea: "An idea", created_at: at });
    }
    run({ id: chartRunId });
    waypoint({ id: waypointOneId, number: 1 });
    waypoint({ id: waypointTwoId, number: 2 });
  });

  test("maps require a destination once it is confirmed", () => {
    expect(
      constraintOf(() => {
        db.$client
          .prepare("update maps set destination_confirmed_at = ? where id = ?")
          .run(at, mapId);
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => {
        db.$client
          .prepare("update maps set destination = ?, destination_confirmed_at = ? where id = ?")
          .run("Somewhere", at, mapId);
      }),
    ).toBeUndefined();
  });

  describe("waypoints", () => {
    const resolved = {
      status: "resolved",
      resolution: "Use flags.",
      gist: "Flags",
      agent_decided: "[]",
      resolved_at: at,
      resolved_how: "plain_choice",
      resolved_by_run: null,
    };

    test("accepts a resolved waypoint by plain choice and one resolved by a run", () => {
      expect(
        constraintOf(() => {
          waypoint({ number: 3, ...resolved });
        }),
      ).toBeUndefined();
      expect(
        constraintOf(() => {
          waypoint({ number: 4, ...resolved, resolved_how: "run", resolved_by_run: chartRunId });
        }),
      ).toBeUndefined();
    });

    test.each([
      ["resolved without a resolution", { ...resolved, resolution: null }],
      ["resolved without a gist", { ...resolved, gist: null }],
      ["resolved without agent_decided", { ...resolved, agent_decided: null }],
      ["more than 3 agent-decided calls", { ...resolved, agent_decided: '["a","b","c","d"]' }],
      ["an open waypoint with agent-decided calls", { agent_decided: "[]" }],
      ["resolved without resolved_at", { ...resolved, resolved_at: null }],
      ["resolved without resolved_how", { ...resolved, resolved_how: null }],
      ["a gist over 200 characters", { ...resolved, gist: "g".repeat(201) }],
      ["resolved_by_run without resolved_how run", { ...resolved, resolved_by_run: chartRunId }],
      ["resolved_how run without resolved_by_run", { ...resolved, resolved_how: "run" }],
      ["an unknown resolved_how", { ...resolved, resolved_how: "vote" }],
      ["an open waypoint with a resolution", { resolution: "Early." }],
      ["an unknown kind", { kind: "fog" }],
      ["an unknown status", { status: "done" }],
    ])("rejects %s", (_case, row) => {
      expect(
        constraintOf(() => {
          waypoint({ number: 3, ...row });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
    });

    test("rejects a repeated number within a map, not across maps", () => {
      expect(
        constraintOf(() => {
          waypoint({ number: 1 });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect(
        constraintOf(() => {
          waypoint({ number: 1, map_id: otherMapId });
        }),
      ).toBeUndefined();
    });
  });

  describe("waypoint_blockers", () => {
    test("accepts a blocker between two waypoints of the map", () => {
      expect(
        constraintOf(() => {
          insert("waypoint_blockers", { map_id: mapId, waypoint_number: 2, blocker_number: 1 });
        }),
      ).toBeUndefined();
    });

    test("refuses self-blocking", () => {
      expect(
        constraintOf(() => {
          insert("waypoint_blockers", { map_id: mapId, waypoint_number: 1, blocker_number: 1 });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
    });

    test("cannot name a waypoint of another map", () => {
      // Waypoint 3 exists only on the other map.
      waypoint({ number: 3, map_id: otherMapId });
      expect(
        constraintOf(() => {
          insert("waypoint_blockers", { map_id: mapId, waypoint_number: 2, blocker_number: 3 });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    });
  });

  describe("question_rounds", () => {
    test("refuses a final map-level round 1, not a final map-level round 2 or waypoint round", () => {
      expect(
        constraintOf(() => {
          round({ final: 1 });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        constraintOf(() => {
          round({ final: 1, number: 2 });
        }),
      ).toBeUndefined();
      expect(
        constraintOf(() => {
          round({ final: 1, waypoint_id: waypointOneId });
        }),
      ).toBeUndefined();
    });

    test("allows one pending map-level round per map and one pending round per waypoint", () => {
      round({});
      expect(
        constraintOf(() => {
          round({ number: 2 });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect(
        constraintOf(() => {
          round({ map_id: otherMapId });
        }),
      ).toBeUndefined();
      round({ waypoint_id: waypointOneId });
      expect(
        constraintOf(() => {
          round({ waypoint_id: waypointOneId, number: 2 });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect(
        constraintOf(() => {
          round({ waypoint_id: waypointTwoId });
        }),
      ).toBeUndefined();
    });

    test("numbers map-level rounds per map and waypoint rounds per waypoint", () => {
      const submitted = { status: "submitted", answers: "[]", submitted_at: at };
      round(submitted);
      expect(
        constraintOf(() => {
          round(submitted);
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect(
        constraintOf(() => {
          round({ ...submitted, waypoint_id: waypointOneId });
        }),
      ).toBe(undefined);
      expect(
        constraintOf(() => {
          round({ ...submitted, waypoint_id: waypointOneId });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    });

    test.each([
      ["answers without submitted_at", { status: "submitted", answers: "[]" }],
      ["submitted without submitted_at", { status: "submitted" }],
      ["submitted_at while pending", { answers: "[]", submitted_at: at }],
      ["an unknown status", { status: "answered" }],
    ])("rejects a round with %s", (_case, row) => {
      expect(
        constraintOf(() => {
          round(row);
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
    });

    test("cannot hang off a waypoint of another map", () => {
      expect(
        constraintOf(() => {
          round({ map_id: otherMapId, waypoint_id: waypointOneId });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    });
  });

  describe("code_surveys (0017)", () => {
    const survey = {
      entries: [
        {
          area: ".",
          role: "The repository root.",
          touched: true,
          why: "The destination changes it.",
          surfaceFiles: [],
          facts: [{ claim: "A fact.", path: "README.md", line: 1 }],
        },
      ],
      identifiers: [],
      unverifiable: [],
    };

    test("stores one survey per map, written by a survey run of that map, parsed on read", () => {
      const surveyRunId = id();
      run({ id: surveyRunId, purpose: "survey" });
      insert("code_surveys", {
        map_id: mapId,
        run_id: surveyRunId,
        content: JSON.stringify(survey),
        created_at: at,
      });
      expect(db.select().from(codeSurveys).all()).toEqual([
        { mapId, runId: surveyRunId, content: survey, createdAt: at },
      ]);
      const againRunId = id();
      run({ id: againRunId, purpose: "survey" });
      expect(
        constraintOf(() => {
          insert("code_surveys", {
            map_id: mapId,
            run_id: againRunId,
            content: JSON.stringify(survey),
            created_at: at,
          });
        }),
      ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });

    test("cannot name a run of another map", () => {
      expect(
        constraintOf(() => {
          insert("code_surveys", {
            map_id: otherMapId,
            run_id: chartRunId,
            content: JSON.stringify(survey),
            created_at: at,
          });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    });

    test("a stored survey that breaks the schema throws on read", () => {
      const surveyRunId = id();
      run({ id: surveyRunId, purpose: "survey" });
      insert("code_surveys", {
        map_id: mapId,
        run_id: surveyRunId,
        content: JSON.stringify({ ...survey, entries: [] }),
        created_at: at,
      });
      expect(() => db.select().from(codeSurveys).all()).toThrow();
    });
  });

  describe("planning_runs", () => {
    test("stores a map-scoped fog run (0019), never one on a waypoint", () => {
      run({ id: id(), purpose: "fog" });
      const waypointId = id();
      waypoint({ id: waypointId, number: 90 });
      expect(
        constraintOf(() => {
          run({ id: id(), purpose: "fog", waypoint_id: waypointId });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
    });

    test("stores a run's CLI usage, and leaves it null for a run without a result (0016)", () => {
      run({
        id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01",
        state: "failed",
        error_code: "agent_run_failed",
        error_message: "out of turns",
        session_id: "session-9",
        result_subtype: "error_max_turns",
        num_turns: 13,
        duration_ms: 90000,
        total_cost_usd: 1.25,
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      });
      run({
        id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02",
        state: "failed",
        error_code: "agent_cli_missing",
        error_message: "no CLI",
      });
      const usage = `select session_id, result_subtype, num_turns, duration_ms, total_cost_usd,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
        from planning_runs where id = ?`;
      expect(db.$client.prepare(usage).get("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01")).toEqual({
        session_id: "session-9",
        result_subtype: "error_max_turns",
        num_turns: 13,
        duration_ms: 90000,
        total_cost_usd: 1.25,
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      });
      expect(db.$client.prepare(usage).get("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02")).toEqual({
        session_id: null,
        result_subtype: null,
        num_turns: null,
        duration_ms: null,
        total_cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      });
    });

    test("ties a waypoint to grilling, research and task runs", () => {
      expect(
        constraintOf(() => {
          run({ waypoint_id: waypointOneId });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        constraintOf(() => {
          run({ purpose: "grilling" });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        constraintOf(() => {
          run({ purpose: "grilling", waypoint_id: waypointOneId });
        }),
      ).toBeUndefined();
    });

    test("accepts every CONTEXT.md purpose and state, and nothing else", () => {
      // A `hatch` run needs its message: the hatch tables' tests cover it.
      for (const purpose of ["consistency", "to_spec"]) {
        expect(
          constraintOf(() => {
            run({ purpose });
          }),
          purpose,
        ).toBeUndefined();
      }
      expect(
        constraintOf(() => {
          run({ state: "asked" });
        }),
      ).toBeUndefined();
      expect(
        constraintOf(() => {
          run({ state: "cancelled", cancel_reason: "replaced" });
        }),
      ).toBeUndefined();
      expect(
        constraintOf(() => {
          run({ purpose: "draft" });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        constraintOf(() => {
          run({ state: "stopped" });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
    });

    test("allows one running run per scope", () => {
      run({ state: "running", ended_at: null });
      expect(
        constraintOf(() => {
          run({ state: "running", ended_at: null });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      const grilling = { purpose: "grilling", state: "running", ended_at: null };
      expect(
        constraintOf(() => {
          run({ ...grilling, waypoint_id: waypointOneId });
        }),
      ).toBe(undefined);
      expect(
        constraintOf(() => {
          run({ ...grilling, waypoint_id: waypointOneId });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect(
        constraintOf(() => {
          run({ ...grilling, waypoint_id: waypointTwoId });
        }),
      ).toBeUndefined();
    });

    test("retries a run at most once", () => {
      const failed = {
        state: "failed",
        error_code: "agent_run_failed",
        error_message: "Failed.",
      };
      run({ ...failed, retry_of_run_id: chartRunId });
      expect(
        constraintOf(() => {
          run({ ...failed, retry_of_run_id: chartRunId });
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    });

    test.each([
      ["a running run with ended_at", { state: "running" }],
      ["an ended run without ended_at", { ended_at: null }],
      ["a failed run without a code", { state: "failed", error_message: "x" }],
      ["a code on a completed run", { error_code: "agent_run_failed", error_message: "x" }],
    ])("rejects %s", (_case, row) => {
      expect(
        constraintOf(() => {
          run(row);
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
    });
  });

  describe("the fog, Out of scope, research, task and consistency tables", () => {
    const otherRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";
    const researchRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a71";
    const passId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a72";
    const consistencyRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a73";

    function check(row: () => void): unknown {
      return constraintOf(row);
    }

    beforeEach(() => {
      run({ id: otherRunId, map_id: otherMapId });
      run({ id: researchRunId, purpose: "research", waypoint_id: waypointOneId });
      run({ id: consistencyRunId, purpose: "consistency" });
      insert("consistency_passes", {
        id: passId,
        map_id: mapId,
        run_id: consistencyRunId,
        compared: "[]",
      });
    });

    test("maps.fog_next_position is 1 by the migration's backfill", () => {
      expect(
        db.$client.prepare("select fog_next_position from maps where id = ?").pluck().get(mapId),
      ).toBe(1);
    });

    test("map_fog: one item per position, its text at most 500, its run on the same map", () => {
      const fog = (row: Record<string, unknown>) => () => {
        insert("map_fog", {
          map_id: mapId,
          position: 1,
          text: "f".repeat(500),
          created_by_run: chartRunId,
          ...row,
        });
      };
      expect(check(fog({}))).toBeUndefined();
      expect(check(fog({}))).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
      expect(check(fog({ position: 2, text: "f".repeat(501) }))).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(check(fog({ position: 3, created_by_run: otherRunId }))).toBe(
        "SQLITE_CONSTRAINT_FOREIGNKEY",
      );
    });

    test("map_exclusions: one line per position and per waypoint, the waypoint on the same map", () => {
      const line = (row: Record<string, unknown>) => () => {
        insert("map_exclusions", {
          map_id: mapId,
          position: 1,
          text: "Not this effort.",
          waypoint_id: null,
          created_by_run: chartRunId,
          ...row,
        });
      };
      expect(check(line({}))).toBeUndefined();
      expect(check(line({}))).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
      expect(check(line({ position: 2, waypoint_id: waypointOneId }))).toBeUndefined();
      expect(check(line({ position: 3, waypoint_id: waypointOneId }))).toBe(
        "SQLITE_CONSTRAINT_UNIQUE",
      );
      expect(
        check(line({ map_id: otherMapId, created_by_run: otherRunId, waypoint_id: waypointTwoId })),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(check(line({ position: 4, text: "x".repeat(501) }))).toBe("SQLITE_CONSTRAINT_CHECK");
    });

    const report = {
      run_id: researchRunId,
      waypoint_id: waypointOneId,
      answered: 1,
      summary: "It is answered.",
      gap: null,
      findings: "[]",
      limitations: "[]",
      uncertainties: "[]",
    };

    test("research_reports: a gap exactly when unanswered, one per run, the summary at most 4000", () => {
      expect(
        check(() => {
          insert("research_reports", { ...report, gap: "Unknown." });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        check(() => {
          insert("research_reports", { ...report, answered: 0 });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        check(() => {
          insert("research_reports", { ...report, summary: "s".repeat(4001) });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        check(() => {
          insert("research_reports", { ...report, run_id: id() });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(
        check(() => {
          insert("research_reports", report);
        }),
      ).toBeUndefined();
      expect(
        check(() => {
          insert("research_reports", report);
        }),
      ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });

    test("research_sources: a known kind, a URL exactly for an external source, a known report", () => {
      insert("research_reports", report);
      let position = 0;
      const source = (row: Record<string, unknown>) => () => {
        position += 1;
        insert("research_sources", {
          report_run_id: researchRunId,
          position,
          kind: "external",
          title: "Docs",
          url: "https://example.com",
          excerpt: "An excerpt.",
          ...row,
        });
      };
      expect(check(source({}))).toBeUndefined();
      expect(check(source({ kind: "repository_file", url: null }))).toBeUndefined();
      expect(check(source({ kind: "blog" }))).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(check(source({ url: null }))).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(check(source({ kind: "map" }))).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(check(source({ title: "t".repeat(201) }))).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(check(source({ report_run_id: chartRunId }))).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(
        check(() => {
          insert("research_sources", {
            report_run_id: researchRunId,
            position: 1,
            kind: "map",
            title: "Map",
            url: null,
            excerpt: "Again.",
          });
        }),
      ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });

    test("task_outcomes: done or failed, non-empty facts, one per run", () => {
      const taskRunId = id();
      run({ id: taskRunId, purpose: "task", waypoint_id: waypointTwoId });
      const outcome = {
        run_id: taskRunId,
        waypoint_id: waypointTwoId,
        outcome: "failed",
        action: "Read the config.",
        facts: "It is absent.",
      };
      expect(
        check(() => {
          insert("task_outcomes", { ...outcome, outcome: "partial" });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        check(() => {
          insert("task_outcomes", { ...outcome, facts: "" });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        check(() => {
          insert("task_outcomes", { ...outcome, waypoint_id: id() });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(
        check(() => {
          insert("task_outcomes", outcome);
        }),
      ).toBeUndefined();
      expect(
        check(() => {
          insert("task_outcomes", { ...outcome, outcome: "done" });
        }),
      ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });

    test("consistency_passes: one per run, the run on the same map", () => {
      const pass = { id: id(), map_id: mapId, run_id: consistencyRunId, compared: "[]" };
      expect(
        check(() => {
          insert("consistency_passes", pass);
        }),
      ).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect(
        check(() => {
          insert("consistency_passes", { ...pass, run_id: otherRunId });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    });

    test("consistency_findings: a known kind and pass, one per created waypoint", () => {
      const finding = {
        created_waypoint_id: waypointTwoId,
        pass_id: passId,
        kind: "conflicting_surfaces",
        waypoint_numbers: "[1]",
        title: "Which flag",
        explanation: "Waypoint 1 says -l.",
        question: "Which flag counts lines?",
      };
      expect(
        check(() => {
          insert("consistency_findings", { ...finding, kind: "typo" });
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        check(() => {
          insert("consistency_findings", { ...finding, pass_id: id() });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(
        check(() => {
          insert("consistency_findings", { ...finding, created_waypoint_id: id() });
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(
        check(() => {
          insert("consistency_findings", finding);
        }),
      ).toBeUndefined();
      expect(
        check(() => {
          insert("consistency_findings", finding);
        }),
      ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });

    test("every other new check and foreign key rejects a violating insert", () => {
      const reject = (table: string, row: Record<string, unknown>) =>
        check(() => {
          insert(table, row);
        });
      expect(
        reject("map_exclusions", {
          map_id: mapId,
          position: 1,
          text: "Not this map.",
          waypoint_id: null,
          created_by_run: otherRunId,
        }),
      ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
      expect(reject("research_reports", { ...report, waypoint_id: id() })).toBe(
        "SQLITE_CONSTRAINT_FOREIGNKEY",
      );
      expect(reject("research_reports", { ...report, answered: 0, gap: "g".repeat(1001) })).toBe(
        "SQLITE_CONSTRAINT_CHECK",
      );
      insert("research_reports", report);
      expect(
        reject("research_sources", {
          report_run_id: researchRunId,
          position: 1,
          kind: "map",
          title: "Map",
          url: null,
          excerpt: "e".repeat(2001),
        }),
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      const taskRunId = id();
      run({ id: taskRunId, purpose: "task", waypoint_id: waypointTwoId });
      const outcome = {
        run_id: taskRunId,
        waypoint_id: waypointTwoId,
        outcome: "done",
        action: "Read the config.",
        facts: "It names eu-west-1.",
      };
      expect(reject("task_outcomes", { ...outcome, run_id: id() })).toBe(
        "SQLITE_CONSTRAINT_FOREIGNKEY",
      );
      expect(reject("task_outcomes", { ...outcome, action: "a".repeat(1001) })).toBe(
        "SQLITE_CONSTRAINT_CHECK",
      );
      expect(reject("task_outcomes", { ...outcome, facts: "f".repeat(4001) })).toBe(
        "SQLITE_CONSTRAINT_CHECK",
      );
      const finding = {
        created_waypoint_id: waypointTwoId,
        pass_id: passId,
        kind: "undefined_term",
        waypoint_numbers: "[1]",
        title: "A term",
        explanation: "Waypoint 1 uses it.",
        question: "What does it mean?",
      };
      for (const over of [
        { title: "t".repeat(121) },
        { explanation: "e".repeat(4001) },
        { question: "q".repeat(1001) },
      ]) {
        expect(reject("consistency_findings", { ...finding, ...over })).toBe(
          "SQLITE_CONSTRAINT_CHECK",
        );
      }
    });
  });
});

describe("migration 0007", () => {
  const at = "2026-10-08T12:00:00.000Z";
  const ids = Array.from(
    { length: 20 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c${index.toString().padStart(2, "0")}`,
  );
  const [projectId, mapId, otherMapId, chartRunId, grillRunId, waypointId, roundId] = ids;
  const [specRunId, specRetryId, ticketsRunId, otherSpecRunId] = ids.slice(7);
  const [rejectedId, approvedId, draftId, rejectedSetId, approvedSetId, deliveryId] = ids.slice(11);
  const KEPT = ["projects", "maps", "waypoints", "question_rounds"];

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function dump(table: string): unknown[] {
    return db.$client.prepare(`select * from ${table} order by rowid`).all();
  }

  test("deletes flat revisions, ticket sets, their delivery runs and the to_spec and to_tickets runs, keeping the rest", async () => {
    await migrateUpTo("0006_research_task_fog");
    const ended = { state: "completed", started_at: at, ended_at: at };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    for (const id of [mapId, otherMapId]) {
      insert("maps", {
        id,
        project_id: projectId,
        idea: "Count lines",
        title: "Lines",
        summary: "Count lines.",
        destination: "A line counter",
        destination_confirmed_at: at,
        created_at: at,
        fog_next_position: 1,
      });
    }
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    insert("waypoints", {
      id: waypointId,
      map_id: mapId,
      number: 1,
      kind: "grilling",
      status: "resolved",
      title: "Flag",
      question: "Which flag?",
      resolution: "-l",
      gist: "-l",
      resolved_how: "plain_choice",
      resolved_at: at,
      created_by_run: chartRunId,
    });
    insert("planning_runs", {
      id: grillRunId,
      map_id: mapId,
      waypoint_id: waypointId,
      purpose: "grilling",
      ...ended,
    });
    insert("question_rounds", {
      id: roundId,
      map_id: mapId,
      waypoint_id: waypointId,
      number: 1,
      final: 1,
      status: "submitted",
      asked_by_run: grillRunId,
      intro: "One question",
      questions: "[]",
      answers: "[]",
      asked_at: at,
      submitted_at: at,
    });
    insert("planning_runs", {
      id: specRunId,
      map_id: mapId,
      purpose: "to_spec",
      state: "failed",
      error_code: "agent_timed_out",
      error_message: "Timed out",
      started_at: at,
      ended_at: at,
    });
    insert("planning_runs", {
      id: specRetryId,
      map_id: mapId,
      purpose: "to_spec",
      retry_of_run_id: specRunId,
      ...ended,
    });
    insert("planning_runs", { id: ticketsRunId, map_id: mapId, purpose: "to_tickets", ...ended });
    insert("planning_runs", {
      id: otherSpecRunId,
      map_id: otherMapId,
      purpose: "to_spec",
      ...ended,
    });
    const flat = JSON.stringify({
      title: "Lines",
      body: "Count.",
      criteria: [{ text: "Counts." }],
    });
    const revision = (id: string | undefined, map: string | undefined, n: number) => ({
      id,
      map_id: map,
      revision: n,
      content: flat,
      drafted_at: at,
    });
    insert("spec_revisions", {
      ...revision(rejectedId, mapId, 1),
      rejected_at: at,
      rejection_reason: "Too broad",
    });
    insert("spec_revisions", { ...revision(approvedId, mapId, 2), approved_at: at });
    insert("spec_revisions", revision(draftId, otherMapId, 1));
    const tickets = JSON.stringify({
      tickets: [{ title: "Count", body: "Count.", criteria: [1], blockedBy: [] }],
    });
    const set = (id: string | undefined, version: number) => ({
      id,
      map_id: mapId,
      spec_revision_id: approvedId,
      version,
      content: tickets,
      drafted_at: at,
    });
    insert("ticket_sets", { ...set(rejectedSetId, 1), rejected_at: at, rejection_reason: "No" });
    insert("ticket_sets", { ...set(approvedSetId, 2), approved_at: at });
    insert("delivery_runs", {
      id: deliveryId,
      ticket_set_id: approvedSetId,
      number: 1,
      branch: "zenorm/lines-2e3f4c01-run-1",
      worktree_path: "/runs/1/worktree",
      base_commit: "a".repeat(40),
      checks: "[]",
      started_at: at,
    });
    const before = KEPT.map(dump);

    await migrateUpTo("0007_specs_and_reviews");

    expect(KEPT.map(dump)).toEqual(before);
    for (const table of ["spec_revisions", "ticket_sets", "delivery_runs", "specifications"]) {
      expect(db.$client.prepare(`select count(*) from ${table}`).pluck().get(), table).toBe(0);
    }
    expect(
      db.$client
        .prepare(
          "select id, purpose, specification_id, cancel_reason from planning_runs order by rowid",
        )
        .all(),
    ).toEqual([
      { id: chartRunId, purpose: "chart", specification_id: null, cancel_reason: null },
      { id: grillRunId, purpose: "grilling", specification_id: null, cancel_reason: null },
    ]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("the spec, ticket set, review and delivery run tables", () => {
  const at = "2026-10-08T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d00";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01";
  const otherMapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d02";
  const specRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d03";
  const otherRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d04";
  const specId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d05";
  const waypointId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d06";
  let nextId = 1;

  function id(): string {
    const value = `0199a1b2-c3d4-7e5f-8a9b-${nextId.toString().padStart(12, "0")}`;
    nextId += 1;
    return value;
  }

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function run(row: Record<string, unknown>): string {
    const runId = id();
    insert("planning_runs", {
      id: runId,
      map_id: mapId,
      purpose: "to_tickets",
      specification_id: specId,
      state: "completed",
      started_at: at,
      ended_at: at,
      ...row,
    });
    return runId;
  }

  function revision(row: Record<string, unknown>): string {
    const revisionId = id();
    insert("spec_revisions", {
      id: revisionId,
      specification_id: specId,
      map_id: mapId,
      written_by_run: specRunId,
      content: "{}",
      created_at: at,
      ...row,
    });
    return revisionId;
  }

  function ticketSet(specRevisionId: string, row: Record<string, unknown> = {}): string {
    const setId = id();
    insert("ticket_sets", {
      id: setId,
      spec_revision_id: specRevisionId,
      state: "awaiting_review",
      version: 1,
      created_at: at,
      updated_at: at,
      ...row,
    });
    return setId;
  }

  function version(ticketSetId: string, number: number): void {
    insert("ticket_set_versions", {
      ticket_set_id: ticketSetId,
      version: number,
      content: "{}",
      written_by_run: specRunId,
      created_at: at,
    });
  }

  function review(specRevisionId: string): string {
    const reviewId = id();
    insert("spec_reviews", {
      id: reviewId,
      spec_revision_id: specRevisionId,
      run_id: run({ purpose: "spec_review" }),
      passed: 0,
      summary: "One finding.",
      sources: "[]",
    });
    return reviewId;
  }

  beforeEach(() => {
    nextId = 1;
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    for (const map of [mapId, otherMapId]) {
      insert("maps", {
        id: map,
        project_id: projectId,
        idea: "An idea",
        created_at: at,
        fog_next_position: 1,
      });
    }
    insert("planning_runs", {
      id: specRunId,
      map_id: mapId,
      purpose: "to_spec",
      state: "completed",
      started_at: at,
      ended_at: at,
    });
    insert("planning_runs", {
      id: otherRunId,
      map_id: otherMapId,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
    });
    insert("waypoints", {
      id: waypointId,
      map_id: mapId,
      number: 1,
      kind: "grilling",
      status: "open",
      title: "A decision",
      question: "What holds?",
      created_by_run: otherRunId,
      person_decides: 0,
    });
    insert("specifications", { id: specId, project_id: projectId, number: 1 });
  });

  test("numbers specs per project", () => {
    expect(
      constraintOf(() => {
        insert("specifications", { id: id(), project_id: projectId, number: 1 });
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test("numbers revisions per spec and keeps one draft per spec", () => {
    const first = revision({ revision: 1 });
    expect(
      constraintOf(() => {
        revision({ revision: 1, superseded_at: at });
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(
      constraintOf(() => {
        revision({ revision: 2 });
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    db.$client
      .prepare("update spec_revisions set superseded_at = ?, rejection_reason = ? where id = ?")
      .run(at, "Too broad", first);
    expect(
      constraintOf(() => {
        revision({ revision: 2 });
      }),
    ).toBeUndefined();
  });

  test("refuses a revision whose map is not its writing run's", () => {
    expect(
      constraintOf(() => {
        revision({ revision: 1, map_id: otherMapId });
      }),
    ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  });

  test.each([
    ["approved and superseded", { approved_at: at, superseded_at: at }],
    ["a rejection reason without superseded_at", { rejection_reason: "No" }],
  ])("refuses a revision %s", (_case, row) => {
    expect(
      constraintOf(() => {
        revision({ revision: 1, ...row });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  });

  test("keeps one ticket set per revision, approved_at exactly when approved", () => {
    const approved = revision({ revision: 1, approved_at: at });
    expect(
      constraintOf(() => {
        ticketSet(approved, { state: "review_passed", approved_at: at });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => {
        ticketSet(approved, { state: "approved" });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => {
        ticketSet(approved, { state: "held" });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    ticketSet(approved);
    expect(
      constraintOf(() => {
        ticketSet(approved);
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test("keeps one content row per version and one rejection per version", () => {
    const set = ticketSet(revision({ revision: 1, approved_at: at }));
    version(set, 1);
    expect(
      constraintOf(() => {
        version(set, 1);
      }),
    ).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    const reject = (number: number) => {
      insert("ticket_set_rejections", {
        ticket_set_id: set,
        version: number,
        reason: "No",
        rejected_at: at,
      });
    };
    expect(
      constraintOf(() => {
        reject(2);
      }),
    ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    reject(1);
    expect(
      constraintOf(() => {
        reject(1);
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test("keeps a review per rewrite of a draft and a waypoint exactly on an escalated finding", () => {
    const draft = revision({ revision: 1 });
    const reviewId = review(draft);
    // A draft rewritten in place gathers one review per rewrite; each review run reviews once.
    expect(
      constraintOf(() => {
        review(draft);
      }),
    ).toBeUndefined();
    let position = 0;
    const finding = (row: Record<string, unknown>) => {
      position += 1;
      insert("spec_review_findings", {
        review_id: reviewId,
        position,
        kind: "invented_scope",
        route: "revise",
        title: "Invented",
        explanation: "Says more.",
        question: "Keep it?",
        element_ids: '["C1"]',
        waypoint_numbers: "[]",
        ...row,
      });
    };
    expect(
      constraintOf(() => {
        finding({ escalated: 1 });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => {
        finding({ escalated: 0, waypoint_id: waypointId });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => {
        finding({ escalated: 1, waypoint_id: waypointId });
        finding({ escalated: 0 });
      }),
    ).toBeUndefined();
  });

  test("tickets_review_findings: a known route and a question on every finding", () => {
    const approved = revision({ revision: 1, approved_at: at });
    const set = ticketSet(approved);
    version(set, 1);
    const reviewId = id();
    insert("tickets_reviews", {
      id: reviewId,
      ticket_set_id: set,
      ticket_set_version: 1,
      run_id: run({ purpose: "tickets_review" }),
      passed: 0,
      summary: "One finding.",
    });
    let position = 0;
    const finding = (row: Record<string, unknown>) => () => {
      position += 1;
      insert("tickets_review_findings", {
        review_id: reviewId,
        position,
        kind: "untraced_criterion",
        title: "Adds a CSV format",
        explanation: "No criterion states it.",
        ticket_numbers: '["T1"]',
        criterion_ids: '["1.1"]',
        escalated: 0,
        ...row,
      });
    };
    expect(constraintOf(finding({ question: "Drop it?" }))).toBe("SQLITE_CONSTRAINT_NOTNULL");
    expect(constraintOf(finding({ route: "later", question: "Drop it?" }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(finding({ route: "revise" }))).toBe("SQLITE_CONSTRAINT_NOTNULL");
    expect(constraintOf(finding({ route: "revise", question: "Drop it?" }))).toBeUndefined();
    expect(
      constraintOf(finding({ route: "decision", question: "Which slicing?", escalated: 1 })),
    ).toBeUndefined();
  });

  test("scopes spec runs to their spec, one running per spec", () => {
    expect(
      constraintOf(() => {
        run({ purpose: "spec_review", specification_id: null });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => {
        run({ purpose: "consistency" });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    run({ state: "running", ended_at: null });
    expect(
      constraintOf(() => {
        run({ purpose: "to_spec", state: "running", ended_at: null });
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    // The map's own scope runs beside it.
    expect(
      constraintOf(() => {
        run({ purpose: "to_spec", specification_id: null, state: "running", ended_at: null });
      }),
    ).toBeUndefined();
  });

  test.each([
    ["a cancel reason on a completed run", { cancel_reason: "replaced" }],
    ["a cancelled run without a reason", { state: "cancelled" }],
    ["an unknown cancel reason", { state: "cancelled", cancel_reason: "bored" }],
  ])("refuses %s", (_case, row) => {
    expect(
      constraintOf(() => {
        run({ purpose: "to_spec", ...row });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  });
});

describe("delivery_runs", () => {
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
  const specRevisionId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
  const ticketSetId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e";
  const specificationId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5f";
  const specRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
  const at = "2026-10-07T12:00:00.000Z";
  const commit = "a".repeat(40);
  const verdict = JSON.stringify({ reviewedCommit: commit, summary: "Fine.", findings: [] });
  const failure = JSON.stringify({ code: "delivery_no_commits", message: "No commits" });
  let nextNumber = 1;

  interface End {
    endedAt: string | null;
    verdict: string | null;
    failure: string | null;
  }

  const ACTIVE: End = { endedAt: null, verdict: null, failure: null };
  const CANCELLED: End = { endedAt: at, verdict: null, failure: null };

  function runId(number: number): string {
    return `0199a1b2-c3d4-7e5f-8a9b-${number.toString().padStart(12, "0")}`;
  }

  /** Inserts a run numbered after the previous one, so only the constraint under test can fail. */
  function insertRun(
    end: End,
    extra: { phase: string; mergedAt: string | null } = { phase: "implementing", mergedAt: null },
  ): void {
    const number = nextNumber;
    nextNumber += 1;
    db.$client
      .prepare(
        "insert into delivery_runs (id, project_id, specification_id, ticket_set_id, number, branch, worktree_path, base_branch, base_commit, checks, phase, started_at, ended_at, verdict, failure, merged_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId(number),
        projectId,
        specificationId,
        ticketSetId,
        number,
        `zenorm/spec-2e3f4a5c-run-${String(number)}`,
        `/runs/${String(number)}/worktree`,
        "main",
        commit,
        JSON.stringify(["git status --short"]),
        extra.phase,
        at,
        end.endedAt,
        end.verdict,
        end.failure,
        extra.mergedAt,
      );
  }

  function constraintCode(insert: () => void): unknown {
    try {
      insert();
    } catch (error: unknown) {
      if (!(error instanceof SqliteError)) throw error;
      return error.code;
    }
    return undefined;
  }

  beforeEach(() => {
    nextNumber = 1;
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    db.$client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at, required_checks) values (?, ?, ?, ?, ?)",
      )
      .run(projectId, "/repo", "main", at, "[]");
    db.$client
      .prepare("insert into maps (id, project_id, idea, created_at) values (?, ?, ?, ?)")
      .run(mapId, projectId, "An idea", at);
    db.$client
      .prepare(
        "insert into planning_runs (id, map_id, purpose, state, started_at, ended_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(specRunId, mapId, "to_spec", "completed", at, at);
    db.$client
      .prepare("insert into specifications (id, project_id, number) values (?, ?, ?)")
      .run(specificationId, projectId, 1);
    db.$client
      .prepare(
        "insert into spec_revisions (id, specification_id, revision, map_id, written_by_run, content, created_at, approved_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(specRevisionId, specificationId, 1, mapId, specRunId, "{}", at, at);
    db.$client
      .prepare(
        "insert into ticket_sets (id, spec_revision_id, state, version, created_at, updated_at, approved_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ticketSetId, specRevisionId, "approved", 1, at, at, at);
  });

  test("accepts ended runs of every kind, then one active run", () => {
    expect(() => {
      insertRun(CANCELLED);
      insertRun({ endedAt: at, verdict, failure: null });
      insertRun({ endedAt: at, verdict: null, failure });
      insertRun(ACTIVE);
    }).not.toThrow();
  });

  test("rejects a second active run in a project, even of another spec", () => {
    insertRun(ACTIVE);
    const otherSpecId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61";
    db.$client
      .prepare("insert into specifications (id, project_id, number) values (?, ?, ?)")
      .run(otherSpecId, projectId, 2);
    expect(
      constraintCode(() => {
        db.$client
          .prepare(
            "insert into delivery_runs (id, project_id, specification_id, ticket_set_id, number, branch, worktree_path, base_branch, base_commit, checks, phase, started_at) values (?, ?, ?, ?, 1, 'b', '/w', 'main', ?, '[\"x\"]', 'preparing', ?)",
          )
          .run(runId(99), projectId, otherSpecId, ticketSetId, commit, at);
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test("rejects merged_at without a verdict, and accepts it with one", () => {
    expect(
      constraintCode(() => {
        insertRun(CANCELLED, { phase: "implementing", mergedAt: at });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(() => {
      insertRun({ endedAt: at, verdict, failure: null }, { phase: "reviewing", mergedAt: at });
    }).not.toThrow();
  });

  test("rejects a phase outside the four", () => {
    expect(
      constraintCode(() => {
        insertRun(ACTIVE, { phase: "merging", mergedAt: null });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  });

  test("ticket rows tie merged_at to commit; lines are 1–500 characters by a known actor", () => {
    insertRun(ACTIVE);
    const ticket = db.$client.prepare(
      'insert into delivery_run_tickets (run_id, ticket, position, merged_at, "commit") values (?, ?, ?, ?, ?)',
    );
    expect(() => ticket.run(runId(1), "T1", 1, at, commit)).not.toThrow();
    expect(constraintCode(() => ticket.run(runId(1), "T2", 2, at, null))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintCode(() => ticket.run(runId(1), "T3", 3, null, commit))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintCode(() => ticket.run(runId(1), "X1", 4, null, null))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    const line = db.$client.prepare(
      "insert into delivery_run_events (run_id, seq, at, who, ticket, text) values (?, ?, ?, ?, ?, ?)",
    );
    expect(() => line.run(runId(1), 1, at, "zenorm", null, "x".repeat(500))).not.toThrow();
    expect(constraintCode(() => line.run(runId(1), 2, at, "zenorm", null, "x".repeat(501)))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintCode(() => line.run(runId(1), 3, at, "zenorm", null, ""))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintCode(() => line.run(runId(1), 4, at, "merger", "T1", "x"))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintCode(() => line.run(runId(1), 1, at, "zenorm", null, "again"))).toBe(
      "SQLITE_CONSTRAINT_PRIMARYKEY",
    );
  });

  test("rejects a second active run of a ticket set", () => {
    insertRun(ACTIVE);
    expect(
      constraintCode(() => {
        insertRun(ACTIVE);
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test("rejects a repeated number within a spec", () => {
    insertRun(CANCELLED);
    nextNumber = 1;
    expect(
      constraintCode(() => {
        insertRun(CANCELLED);
      }),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test.each([
    ["both a verdict and a failure", { endedAt: at, verdict, failure }],
    ["a failure but no ended_at", { endedAt: null, verdict: null, failure }],
    ["a verdict but no ended_at", { endedAt: null, verdict, failure: null }],
  ])("rejects a run with %s", (_case, end) => {
    expect(
      constraintCode(() => {
        insertRun(end);
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
  });

  test("rejects a run whose ticket set does not exist", () => {
    db.$client.exec("delete from ticket_sets");
    expect(
      constraintCode(() => {
        insertRun(ACTIVE);
      }),
    ).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  });
});

describe("migration 0008", () => {
  const at = "2026-10-08T12:00:00.000Z";
  const ids = Array.from(
    { length: 20 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e${index.toString().padStart(2, "0")}`,
  );
  const [projectId, mapId, chartRunId, plainId, openId, grillRunId, submittedId, pendingId] = ids;
  const [specId, specRunId, replacedRunId, reviewRunId, revisionId, reviewId] = ids.slice(8);
  const [ticketsRunId, setId, deliveryId] = ids.slice(14);
  const TABLES = [
    "projects",
    "maps",
    "planning_runs",
    "waypoints",
    "question_rounds",
    "specifications",
    "spec_revisions",
    "spec_reviews",
    "ticket_sets",
    "ticket_set_versions",
    "delivery_runs",
  ];
  /**
   * The columns 0008 adds, 0010's and 0030's to projects, 0010's to delivery runs, 0012's to
   * waypoints, 0018's to revisions, 0020's to spec reviews.
   */
  const NEW_COLUMNS: Record<string, Record<string, string | number | null | undefined>> = {
    projects: { required_checks: "[]", ...REPAIR_SETTINGS_UNSAVED },
    delivery_runs: {
      project_id: projectId,
      base_branch: "main",
      phase: "implementing",
      merged_at: null,
    },
    planning_runs: { hatch_message_id: null, ...USAGE_NULLS },
    spec_revisions: { removed: null },
    spec_reviews: { verified: null },
    waypoints: { hatch_message_id: null, person_decides: 0 },
    question_rounds: { withdrawn_at: null, withdrawn_reason: null },
  };

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function dump(table: string): Record<string, unknown>[] {
    return z
      .array(z.record(z.string(), z.unknown()))
      .parse(db.$client.prepare(`select * from ${table} order by rowid`).all());
  }

  /** A `0007` database with a record of every kind 0008 must keep. */
  function seed0007(): void {
    const ended = { state: "completed", started_at: at, ended_at: at };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "Count lines",
      title: "Lines",
      summary: "Count lines.",
      destination: "A line counter",
      destination_confirmed_at: at,
      created_at: at,
      fog_next_position: 1,
    });
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    const waypoint = { map_id: mapId, kind: "grilling", title: "Flag", created_by_run: chartRunId };
    insert("waypoints", {
      ...waypoint,
      id: plainId,
      number: 1,
      status: "resolved",
      question: "Which flag?",
      resolution: "-l",
      gist: "-l",
      resolved_how: "plain_choice",
      resolved_at: at,
    });
    insert("waypoints", { ...waypoint, id: openId, number: 2, status: "claimed", question: "?" });
    insert("planning_runs", {
      id: grillRunId,
      map_id: mapId,
      waypoint_id: openId,
      purpose: "grilling",
      state: "asked",
      started_at: at,
      ended_at: at,
    });
    const round = {
      map_id: mapId,
      waypoint_id: openId,
      final: 0,
      asked_by_run: grillRunId,
      intro: "One question",
      questions: "[]",
      asked_at: at,
    };
    insert("question_rounds", {
      ...round,
      id: submittedId,
      number: 1,
      status: "submitted",
      answers: "[]",
      submitted_at: at,
    });
    insert("question_rounds", { ...round, id: pendingId, number: 2, status: "pending" });
    insert("specifications", { id: specId, project_id: projectId, number: 1 });
    insert("planning_runs", { id: specRunId, map_id: mapId, purpose: "to_spec", ...ended });
    insert("planning_runs", {
      id: replacedRunId,
      map_id: mapId,
      specification_id: specId,
      purpose: "to_spec",
      state: "cancelled",
      cancel_reason: "replaced",
      started_at: at,
      ended_at: at,
    });
    insert("spec_revisions", {
      id: revisionId,
      specification_id: specId,
      revision: 1,
      map_id: mapId,
      written_by_run: specRunId,
      content: "{}",
      created_at: at,
      approved_at: at,
    });
    insert("planning_runs", {
      id: reviewRunId,
      map_id: mapId,
      specification_id: specId,
      purpose: "spec_review",
      ...ended,
    });
    insert("spec_reviews", {
      id: reviewId,
      spec_revision_id: revisionId,
      run_id: reviewRunId,
      passed: 1,
      summary: "Passed.",
      sources: "[]",
    });
    insert("planning_runs", {
      id: ticketsRunId,
      map_id: mapId,
      specification_id: specId,
      purpose: "to_tickets",
      ...ended,
    });
    insert("ticket_sets", {
      id: setId,
      spec_revision_id: revisionId,
      state: "approved",
      version: 1,
      created_at: at,
      updated_at: at,
      approved_at: at,
    });
    insert("ticket_set_versions", {
      ticket_set_id: setId,
      version: 1,
      content: "{}",
      written_by_run: ticketsRunId,
      created_at: at,
    });
    insert("delivery_runs", {
      id: deliveryId,
      specification_id: specId,
      ticket_set_id: setId,
      number: 1,
      branch: "zenorm/lines-run-1",
      worktree_path: "/runs/1/worktree",
      base_commit: "a".repeat(40),
      checks: "[]",
      started_at: at,
    });
  }

  test("keeps every row of a 0007 database, with the new columns null and no new run", async () => {
    await migrateUpTo("0007_specs_and_reviews");
    seed0007();
    const before = TABLES.map(dump);

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(TABLES.map(dump)).toEqual(
      TABLES.map((table, index) =>
        rowsAt(before, index).map((row) => withUser(table, { ...row, ...NEW_COLUMNS[table] })),
      ),
    );
    expect(dump("hatch_messages")).toEqual([]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    // The children of the rebuilt tables still name them.
    const parents = (table: string) =>
      db.$client.prepare(`select "table" from pragma_foreign_key_list('${table}')`).pluck().all();
    expect(parents("waypoints")).toContain("planning_runs");
    expect(parents("question_rounds")).toContain("planning_runs");
    expect(parents("spec_reviews")).toContain("planning_runs");
  });

  test("refuses a database whose copy would break a foreign key, writing nothing", async () => {
    await migrateUpTo("0007_specs_and_reviews");
    seed0007();
    db.$client.pragma("foreign_keys = OFF");
    insert("waypoints", {
      id: ids[19],
      map_id: mapId,
      number: 3,
      kind: "grilling",
      status: "open",
      title: "Orphan",
      question: "?",
      created_by_run: ids[18],
    });
    db.$client.pragma("foreign_keys = ON");

    const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);

    expect(migrated.ok ? null : migrated.error.code).toBe("migration_failed");
    expect(tableNames()).not.toContain("hatch_messages");
    expect(db.$client.prepare("select count(*) from zenorm_migrations").pluck().get()).toBe(8);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("the hatch tables", () => {
  const at = "2026-10-08T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f00";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f01";
  const otherMapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f02";
  const chartRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f03";
  const specId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f04";
  const waypointId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f05";
  let nextId = 1;

  function id(): string {
    const value = `0199a1b2-c3d4-7e5f-8a9b-${nextId.toString().padStart(12, "0")}`;
    nextId += 1;
    return value;
  }

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function message(row: Record<string, unknown>): string {
    const messageId = id();
    insert("hatch_messages", {
      id: messageId,
      map_id: mapId,
      stage: "wayfinding",
      text: "Does nested mean any depth?",
      sent_at: at,
      ...row,
    });
    return messageId;
  }

  function run(row: Record<string, unknown>): string {
    const runId = id();
    insert("planning_runs", {
      id: runId,
      map_id: mapId,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
      ...row,
    });
    return runId;
  }

  function round(row: Record<string, unknown>): string {
    const roundId = id();
    insert("question_rounds", {
      id: roundId,
      map_id: mapId,
      waypoint_id: waypointId,
      number: nextId,
      final: 1,
      status: "pending",
      asked_by_run: chartRunId,
      intro: "Intro",
      questions: "[]",
      asked_at: at,
      ...row,
    });
    return roundId;
  }

  function replied(runId: string): Record<string, unknown> {
    return { run_id: runId, reply: "Yes, any depth.", replied_at: at };
  }

  beforeEach(() => {
    nextId = 1;
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    for (const map of [mapId, otherMapId]) {
      insert("maps", { id: map, project_id: projectId, idea: "An idea", created_at: at });
    }
    insert("specifications", { id: specId, project_id: projectId, number: 1 });
    run({ id: chartRunId });
    insert("waypoints", {
      id: waypointId,
      map_id: mapId,
      number: 1,
      kind: "grilling",
      status: "open",
      title: "A decision",
      question: "What holds?",
      person_decides: 0,
      created_by_run: chartRunId,
    });
  });

  test("hatch_messages: the stage is a planning stage, and Idea and Wayfinding name no spec", () => {
    for (const stage of ["idea", "wayfinding"]) {
      expect(
        constraintOf(() => message({ stage, specification_id: specId })),
        stage,
      ).toBe("SQLITE_CONSTRAINT_CHECK");
      expect(
        constraintOf(() => message({ stage })),
        stage,
      ).toBeUndefined();
    }
    for (const stage of ["spec", "tickets"]) {
      expect(
        constraintOf(() => message({ stage, specification_id: specId })),
        stage,
      ).toBeUndefined();
      expect(
        constraintOf(() => message({ stage })),
        stage,
      ).toBeUndefined();
    }
    expect(constraintOf(() => message({ stage: "delivery" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => message({ text: "" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => message({ text: "x".repeat(4001) }))).toBe("SQLITE_CONSTRAINT_CHECK");
  });

  test("hatch_messages: a reply comes with its time and run, a refusal and a change with a reply", () => {
    const messageId = message({});
    const hatchRun = run({ purpose: "hatch", hatch_message_id: messageId });
    expect(constraintOf(() => message({ reply: "Yes.", run_id: hatchRun }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(() => message({ reply: "Yes.", replied_at: at }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(() => message({ refusal: "spec_in_flight" }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(() => message({ ...replied(hatchRun), refusal: "busy" }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    const change = JSON.stringify({ kind: "revise_spec" });
    expect(constraintOf(() => message({ change }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(
      constraintOf(() => message({ ...replied(hatchRun), refusal: "spec_in_flight", change })),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => message(replied(hatchRun)))).toBeUndefined();
    expect(
      constraintOf(() => message({ ...replied(hatchRun), refusal: "spec_in_flight" })),
    ).toBeUndefined();
    expect(constraintOf(() => message({ ...replied(hatchRun), change }))).toBeUndefined();
  });

  test("planning_runs: a hatch run needs its message; to_spec and to_tickets may carry one, others not", () => {
    const messageId = message({});
    expect(constraintOf(() => run({ purpose: "hatch" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => run({ hatch_message_id: messageId }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(
      constraintOf(() =>
        run({ purpose: "grilling", waypoint_id: waypointId, hatch_message_id: messageId }),
      ),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => run({ purpose: "hatch", hatch_message_id: messageId }))).toBe(
      undefined,
    );
    expect(constraintOf(() => run({ purpose: "to_spec", hatch_message_id: messageId }))).toBe(
      undefined,
    );
    expect(
      constraintOf(() =>
        run({ purpose: "to_tickets", specification_id: specId, hatch_message_id: messageId }),
      ),
    ).toBeUndefined();
    expect(constraintOf(() => run({ purpose: "to_spec" }))).toBeUndefined();
  });

  test("planning_runs: one running hatch run per map, beside the map's own running run", () => {
    const running = { state: "running", ended_at: null };
    run({ ...running, purpose: "hatch", hatch_message_id: message({}) });
    expect(
      constraintOf(() => run({ ...running, purpose: "hatch", hatch_message_id: message({}) })),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(constraintOf(() => run(running))).toBeUndefined();
    const otherMessage = message({ map_id: otherMapId });
    expect(
      constraintOf(() =>
        run({ ...running, map_id: otherMapId, purpose: "hatch", hatch_message_id: otherMessage }),
      ),
    ).toBeUndefined();
  });

  test("planning_runs: `reopened` is a cancellation reason, only on a cancelled run", () => {
    expect(constraintOf(() => run({ cancel_reason: "reopened" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => run({ state: "cancelled", cancel_reason: "reopened" }))).toBe(
      undefined,
    );
    expect(constraintOf(() => run({ state: "cancelled", cancel_reason: "replaced" }))).toBe(
      undefined,
    );
  });

  test("question_rounds: a withdrawn round has its time and reason, and only a withdrawn one", () => {
    const withdrawn = { status: "withdrawn", withdrawn_at: at };
    expect(constraintOf(() => round({ withdrawn_reason: "superseded" }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(() => round({ withdrawn_at: at }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => round({ status: "withdrawn" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => round(withdrawn))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(() => round({ ...withdrawn, withdrawn_reason: "stale" }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    for (const reason of ["superseded", "waypoint_out_of_scope"]) {
      expect(
        constraintOf(() => round({ ...withdrawn, withdrawn_reason: reason })),
        reason,
      ).toBeUndefined();
    }
  });

  test("waypoints: hatch_message_id names a message", () => {
    const messageId = message({});
    const update = (value: string) => () => {
      db.$client
        .prepare("update waypoints set hatch_message_id = ? where id = ?")
        .run(value, waypointId);
    };
    expect(constraintOf(update(specId))).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    expect(constraintOf(update(messageId))).toBeUndefined();
  });
});

describe("migration 0009", () => {
  const at = "2026-10-09T12:00:00.000Z";
  const ids = Array.from(
    { length: 24 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b${index.toString().padStart(2, "0")}`,
  );
  const [projectId, mapId, specRunId, specId, otherSpecId, revisionId, otherRevisionId] = ids;
  const [ticketsRunId, approvedSetId, openSetId, noteId, questionId, hatchRunId] = ids.slice(7);
  const [noteRunId, reviewRunId, ticketsReviewId, stoppedRunId, retryRunId] = ids.slice(13);
  /** Every table a 0008 database holds rows in here; 0009 must keep each row as it was. */
  const TABLES = [
    "projects",
    "maps",
    "planning_runs",
    "specifications",
    "spec_revisions",
    "ticket_sets",
    "ticket_set_versions",
    "ticket_set_rejections",
    "hatch_messages",
    "tickets_reviews",
  ];

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function dump(table: string): Record<string, unknown>[] {
    return z
      .array(z.record(z.string(), z.unknown()))
      .parse(db.$client.prepare(`select * from ${table} order by rowid`).all());
  }

  function columnsOf(table: string): unknown[] {
    return db.$client.prepare(`select name from pragma_table_info('${table}')`).pluck().all();
  }

  /**
   * A `0008` database: an approved set and an unapproved one with a rejection and a note rewrite,
   * hatch messages naming specs, spec runs of every kind, a stopped one retried.
   */
  function seed0008(): void {
    const ended = { state: "completed", started_at: at, ended_at: at };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "Count lines",
      title: "Lines",
      created_at: at,
      fog_next_position: 1,
    });
    insert("planning_runs", { id: specRunId, map_id: mapId, purpose: "to_spec", ...ended });
    for (const [id, number] of [
      [specId, 1],
      [otherSpecId, 2],
    ] as const) {
      insert("specifications", { id, project_id: projectId, number });
    }
    for (const [id, specificationId] of [
      [revisionId, specId],
      [otherRevisionId, otherSpecId],
    ] as const) {
      insert("spec_revisions", {
        id,
        specification_id: specificationId,
        revision: 1,
        map_id: mapId,
        written_by_run: specRunId,
        content: "{}",
        created_at: at,
        approved_at: at,
      });
    }
    const specRun = (id: unknown, specificationId: unknown, row: Record<string, unknown>) => {
      insert("planning_runs", {
        id,
        map_id: mapId,
        specification_id: specificationId,
        purpose: "to_tickets",
        ...ended,
        ...row,
      });
    };
    specRun(ticketsRunId, specId, {});
    insert("ticket_sets", {
      id: approvedSetId,
      spec_revision_id: revisionId,
      state: "approved",
      version: 1,
      created_at: at,
      updated_at: at,
      approved_at: at,
    });
    insert("ticket_sets", {
      id: openSetId,
      spec_revision_id: otherRevisionId,
      state: "awaiting_review",
      version: 3,
      created_at: at,
      updated_at: at,
    });
    for (const [setId, version] of [
      [approvedSetId, 1],
      [openSetId, 1],
      [openSetId, 2],
      [openSetId, 3],
    ] as const) {
      insert("ticket_set_versions", {
        ticket_set_id: setId,
        version,
        content: "{}",
        written_by_run: ticketsRunId,
        created_at: at,
      });
    }
    insert("ticket_set_rejections", {
      ticket_set_id: openSetId,
      version: 1,
      reason: "Split the exporter.",
      rejected_at: at,
    });
    insert("hatch_messages", {
      id: noteId,
      map_id: mapId,
      stage: "implementation",
      specification_id: otherSpecId,
      text: "Merge T1 and T2.",
      sent_at: at,
    });
    insert("hatch_messages", {
      id: questionId,
      map_id: mapId,
      stage: "spec",
      specification_id: specId,
      text: "Is the exporter in?",
      sent_at: at,
    });
    insert("planning_runs", {
      id: hatchRunId,
      map_id: mapId,
      purpose: "hatch",
      hatch_message_id: noteId,
      ...ended,
    });
    db.$client
      .prepare("update hatch_messages set run_id = ?, reply = ?, replied_at = ? where id = ?")
      .run(hatchRunId, "I'll rewrite the tickets.", at, noteId);
    specRun(noteRunId, otherSpecId, { hatch_message_id: noteId });
    const failed = { state: "failed", error_code: "agent_timeout", error_message: "Timed out." };
    specRun(stoppedRunId, otherSpecId, failed);
    specRun(retryRunId, otherSpecId, { ...failed, retry_of_run_id: stoppedRunId });
  }

  test("keeps every row of a 0008 database and gives tickets review findings a route and question", async () => {
    await migrateUpTo("0008_hatch_messages_and_reopen");
    seed0008();
    const before = TABLES.map(dump);

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    // 0010 then gives every project `required_checks = []`, 0016 every run its null usage, 0018
    // every revision its null removals, 0020 every map and run the one User, 0025 the hatch message sent
    // from the stage once called Implementation the stage `tickets`, 0030 every project no repair
    // limit and no fix commands.
    expect(TABLES.map(dump)).toEqual(
      TABLES.map((table, index) =>
        rowsAt(before, index).map((row) => {
          if (table === "projects") {
            return { ...row, required_checks: "[]", ...REPAIR_SETTINGS_UNSAVED };
          }
          if (table === "planning_runs") return withUser(table, { ...row, ...USAGE_NULLS });
          if (table === "spec_revisions") return { ...row, removed: null };
          if (table === "hatch_messages" && row.stage === "implementation") {
            return { ...row, stage: "tickets" };
          }
          return withUser(table, row);
        }),
      ),
    );
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 6, 2, 2, 2, 4, 1, 2, 0]);
    expect(dump("tickets_review_findings")).toEqual([]);
    expect(columnsOf("tickets_review_findings")).toEqual([
      "review_id",
      "position",
      "kind",
      "route",
      "title",
      "explanation",
      "question",
      "ticket_numbers",
      "criterion_ids",
      "escalated",
    ]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db.$client
        .prepare(`select "table" from pragma_foreign_key_list('tickets_review_findings')`)
        .pluck()
        .all(),
    ).toEqual(["tickets_reviews"]);
  });

  test("refuses a database holding a tickets review finding, writing nothing", async () => {
    await migrateUpTo("0008_hatch_messages_and_reopen");
    seed0008();
    insert("planning_runs", {
      id: reviewRunId,
      map_id: mapId,
      specification_id: otherSpecId,
      purpose: "tickets_review",
      state: "completed",
      started_at: at,
      ended_at: at,
    });
    insert("tickets_reviews", {
      id: ticketsReviewId,
      ticket_set_id: openSetId,
      ticket_set_version: 3,
      run_id: reviewRunId,
      passed: 0,
      summary: "One finding.",
    });
    insert("tickets_review_findings", {
      review_id: ticketsReviewId,
      position: 1,
      kind: "contradiction",
      title: "T1 and T2 disagree",
      explanation: "They write different formats.",
      ticket_numbers: '["T1","T2"]',
      criterion_ids: "[]",
      escalated: 0,
    });

    const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);

    expect(migrated.ok ? null : migrated.error.code).toBe("migration_failed");
    expect(columnsOf("tickets_review_findings")).not.toContain("route");
    expect(dump("tickets_review_findings")).toHaveLength(1);
    expect(db.$client.prepare("select count(*) from zenorm_migrations").pluck().get()).toBe(9);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("migration 0010", () => {
  const at = "2026-10-09T12:00:00.000Z";
  const later = "2026-10-09T13:00:00.000Z";
  const ids = Array.from(
    { length: 20 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c${index.toString().padStart(2, "0")}`,
  );
  function id(index: number): string {
    const value = ids[index];
    if (value === undefined) throw new Error(`No id ${String(index)}`);
    return value;
  }
  const projectId = id(0);
  const mapId = id(1);
  const runA = id(2);
  const runB = id(3);
  const specA = id(4);
  const specB = id(5);
  const revisionA = id(6);
  const revisionB = id(7);
  const setA = id(8);
  const setB = id(9);
  const passed = id(10);
  const blocked = id(11);
  const failed = id(12);
  const cancelled = id(13);
  const cancelledVerifying = id(14);
  const olderActive = id(15);
  const newerActive = id(16);
  const commit = "a".repeat(40);
  const check = {
    command: "pnpm test",
    exitCode: 0,
    timedOut: false,
    durationMs: 5,
    outputTail: "",
  };
  const finding = (title: string, severity: string) => ({
    axis: "spec",
    severity,
    file: null,
    title,
    detail: "Detail.",
  });

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function run(
    id: string,
    spec: { specId: string; setId: string },
    number: number,
    fields: Record<string, unknown>,
  ): void {
    insert("delivery_runs", {
      id,
      specification_id: spec.specId,
      ticket_set_id: spec.setId,
      number,
      branch: `zenorm/spec-run-${id.slice(-2)}`,
      worktree_path: `/runs/${id}/worktree`,
      base_commit: commit,
      checks: '["pnpm test"]',
      started_at: at,
      ...fields,
    });
  }

  function seed0009(): void {
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "trunk",
      created_at: at,
    });
    insert("maps", { id: mapId, project_id: projectId, idea: "An idea", created_at: at });
    const a = { specId: specA, setId: setA };
    const b = { specId: specB, setId: setB };
    for (const [specId, revisionId, setId, planningRunId, number] of [
      [specA, revisionA, setA, runA, 1],
      [specB, revisionB, setB, runB, 2],
    ] as const) {
      insert("planning_runs", {
        id: planningRunId,
        map_id: mapId,
        purpose: "to_spec",
        state: "completed",
        started_at: at,
        ended_at: at,
      });
      insert("specifications", { id: specId, project_id: projectId, number });
      insert("spec_revisions", {
        id: revisionId,
        specification_id: specId,
        revision: 1,
        map_id: mapId,
        written_by_run: planningRunId,
        content: "{}",
        created_at: at,
        approved_at: at,
      });
      insert("ticket_sets", {
        id: setId,
        spec_revision_id: revisionId,
        state: "approved",
        version: 1,
        created_at: at,
        updated_at: at,
        approved_at: at,
      });
    }
    const ended = { ended_at: at, final_commit: commit, check_results: JSON.stringify([check]) };
    run(passed, a, 1, {
      ...ended,
      verdict: JSON.stringify({
        reviewedCommit: commit,
        summary: "Fine.",
        findings: [finding("First note", "note"), finding("Second note", "note")],
      }),
    });
    run(blocked, a, 2, {
      ...ended,
      verdict: JSON.stringify({
        reviewedCommit: commit,
        summary: "Blocked.",
        findings: [finding("Broken", "blocking")],
      }),
    });
    run(failed, a, 3, {
      ended_at: at,
      failure: JSON.stringify({
        phase: "preparing",
        code: "delivery_worktree_failed",
        message: "No.",
      }),
    });
    run(cancelled, a, 4, { ...ended });
    run(cancelledVerifying, a, 5, { ended_at: at, final_commit: commit });
    run(olderActive, a, 6, {});
    run(newerActive, b, 1, { started_at: later });
  }

  const MigratedRun = z.strictObject({
    id: z.string(),
    project_id: z.string(),
    base_branch: z.string(),
    phase: z.string(),
    ended_at: z.string().nullable(),
    verdict: z.string().nullable(),
    failure: z.string().nullable(),
    merged_at: z.string().nullable(),
  });

  function runs(): z.infer<typeof MigratedRun>[] {
    return z
      .array(MigratedRun)
      .parse(
        db.$client
          .prepare(
            "select id, project_id, base_branch, phase, ended_at, verdict, failure, merged_at from delivery_runs order by id",
          )
          .all(),
      );
  }

  function parsed(text: string | null | undefined): unknown {
    if (typeof text !== "string") throw new Error("No stored JSON");
    return JSON.parse(text);
  }

  test("backfills a 0009 database's projects and runs, ending all but the newest active run", async () => {
    await migrateUpTo("0009_tickets_review_routes");
    seed0009();
    const before = Date.now();

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(db.$client.prepare("select required_checks from projects").pluck().all()).toEqual([
      "[]",
    ]);
    const migrated = runs();
    const byId = new Map(migrated.map((row) => [row.id, row]));
    expect(migrated.map((row) => [row.id, row.phase])).toEqual([
      [passed, "reviewing"],
      [blocked, "reviewing"],
      [failed, "preparing"],
      [cancelled, "reviewing"],
      [cancelledVerifying, "verifying"],
      [olderActive, "implementing"],
      [newerActive, "implementing"],
    ]);
    for (const row of migrated) {
      expect(row.project_id).toBe(projectId);
      expect(row.base_branch).toBe("trunk");
      expect(row.merged_at).toBeNull();
    }
    expect(parsed(byId.get(failed)?.failure)).toEqual({
      code: "delivery_worktree_failed",
      message: "No.",
    });
    expect(parsed(byId.get(passed)?.verdict)).toEqual({
      reviewedCommit: commit,
      summary: "Fine.",
      findings: [
        { ...finding("First note", "note"), criterion: null },
        { ...finding("Second note", "note"), criterion: null },
      ],
    });
    expect(parsed(byId.get(blocked)?.verdict)).toMatchObject({
      findings: [{ ...finding("Broken", "blocking"), criterion: null }],
    });
    expect(byId.get(newerActive)?.ended_at).toBeNull();
    const cancelledAt = String(byId.get(olderActive)?.ended_at);
    expect(z.iso.datetime().safeParse(cancelledAt).success).toBe(true);
    expect(Date.parse(cancelledAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(byId.get(olderActive)?.verdict).toBeNull();
    expect(byId.get(olderActive)?.failure).toBeNull();
    expect(db.$client.prepare("select count(*) from delivery_run_tickets").pluck().get()).toBe(0);
    expect(db.$client.prepare("select count(*) from delivery_run_events").pluck().get()).toBe(0);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db.$client
        .prepare(`select "table" from pragma_foreign_key_list('delivery_runs') order by "table"`)
        .pluck()
        .all(),
    ).toEqual(["delivery_runs", "projects", "specifications", "ticket_sets", "users"]);
  });

  test("keeps the newest active run per project, and on equal start times the higher id", async () => {
    await migrateUpTo("0009_tickets_review_routes");
    seed0009();
    // Project 1's two active runs start at once: the higher id stays active.
    db.$client.prepare("update delivery_runs set started_at = ? where id = ?").run(at, newerActive);
    // Project 2 has one active run, older than project 1's: it stays active.
    const other = (index: number): string => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d${String(index)}0`;
    insert("projects", {
      id: other(1),
      folder_path: "/other",
      base_branch: "main",
      created_at: at,
    });
    insert("maps", { id: other(2), project_id: other(1), idea: "Another idea", created_at: at });
    insert("planning_runs", {
      id: other(3),
      map_id: other(2),
      purpose: "to_spec",
      state: "completed",
      started_at: at,
      ended_at: at,
    });
    insert("specifications", { id: other(4), project_id: other(1), number: 1 });
    insert("spec_revisions", {
      id: other(5),
      specification_id: other(4),
      revision: 1,
      map_id: other(2),
      written_by_run: other(3),
      content: "{}",
      created_at: at,
      approved_at: at,
    });
    insert("ticket_sets", {
      id: other(6),
      spec_revision_id: other(5),
      state: "approved",
      version: 1,
      created_at: at,
      updated_at: at,
      approved_at: at,
    });
    run(other(7), { specId: other(4), setId: other(6) }, 1, {
      started_at: "2026-10-09T11:00:00.000Z",
    });

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    const byId = new Map(runs().map((row) => [row.id, row]));
    expect(byId.get(newerActive)?.ended_at).toBeNull();
    expect(byId.get(olderActive)?.ended_at).not.toBeNull();
    expect(byId.get(other(7))).toMatchObject({ project_id: other(1), ended_at: null });
  });

  test("keeps an empty verdict findings list empty", async () => {
    await migrateUpTo("0009_tickets_review_routes");
    seed0009();
    db.$client
      .prepare("update delivery_runs set verdict = ? where id = ?")
      .run(JSON.stringify({ reviewedCommit: commit, summary: "Clean.", findings: [] }), passed);

    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);

    const verdict = db.$client
      .prepare("select verdict from delivery_runs where id = ?")
      .pluck()
      .get(passed);
    expect(parsed(typeof verdict === "string" ? verdict : null)).toEqual({
      reviewedCommit: commit,
      summary: "Clean.",
      findings: [],
    });
  });
});

describe("migration 0011", () => {
  const at = "2026-10-10T12:00:00.000Z";
  const ids = Array.from(
    { length: 24 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e${index.toString().padStart(2, "0")}`,
  );
  function id(index: number): string {
    const value = ids[index];
    if (value === undefined) throw new Error(`No id ${String(index)}`);
    return value;
  }
  const projectId = id(0);
  const mapId = id(1);
  const otherMapId = id(2);
  const chartRunId = id(3);
  const specRunId = id(4);
  const specId = id(5);
  const revisionId = id(6);
  const setId = id(7);
  const ticketsRunId = id(8);
  const reviewRunId = id(9);
  const reviewId = id(10);
  const refusedId = id(11);
  const appliedId = id(12);
  const pendingId = id(13);
  const hatchRunId = id(14);
  const otherHatchRunId = id(15);
  const noteRunId = id(16);
  const waypointId = id(17);
  /** Every table a `0010` database holds rows in here, with its key; `0011` keeps each row. */
  const TABLES = {
    projects: "id",
    maps: "id",
    planning_runs: "id",
    waypoints: "id",
    specifications: "id",
    spec_revisions: "id",
    ticket_sets: "id",
    ticket_set_versions: "ticket_set_id, version",
    tickets_reviews: "id",
    tickets_review_findings: "review_id, position",
    hatch_messages: "id",
  } as const;
  const ticketSetContent = {
    tickets: [
      {
        id: "T1",
        title: "Count lines",
        build: "Count the lines.",
        blockedBy: [],
        criteria: ["1.1"],
        testing: ["A file of three lines counts 3."],
        followUp: null,
        outOfScope: [],
      },
    ],
    dispositions: [{ criterion: "1.1", kind: "work", ticket: "T1", reason: null }],
    slicing: "One ticket.",
    execution: "In order.",
  };

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function dumpAll(): Record<string, unknown[]> {
    return Object.fromEntries(
      Object.entries(TABLES).map(([table, key]) => [
        table,
        db.$client.prepare(`select * from ${table} order by ${key}`).all(),
      ]),
    );
  }

  /**
   * A `0010` database: an approved spec with its set and a tickets review with two findings, three
   * hatch messages (a `spec_approved` refusal, an applied change, one pending), a waypoint and a
   * `to_spec` run referencing hatch messages.
   */
  function seed0010(): void {
    const ended = { state: "completed", started_at: at, ended_at: at };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: '["pnpm test"]',
    });
    for (const map of [mapId, otherMapId]) {
      insert("maps", {
        id: map,
        project_id: projectId,
        idea: "Count lines",
        title: "Lines",
        created_at: at,
        fog_next_position: 1,
      });
    }
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    insert("planning_runs", { id: specRunId, map_id: mapId, purpose: "to_spec", ...ended });
    insert("specifications", { id: specId, project_id: projectId, number: 1 });
    insert("spec_revisions", {
      id: revisionId,
      specification_id: specId,
      revision: 1,
      map_id: mapId,
      written_by_run: specRunId,
      content: "{}",
      created_at: at,
      approved_at: at,
    });
    insert("ticket_sets", {
      id: setId,
      spec_revision_id: revisionId,
      state: "approved",
      version: 1,
      created_at: at,
      updated_at: at,
      approved_at: at,
    });
    const specScoped = { map_id: mapId, specification_id: specId, ...ended };
    insert("planning_runs", { id: ticketsRunId, purpose: "to_tickets", ...specScoped });
    insert("planning_runs", { id: reviewRunId, purpose: "tickets_review", ...specScoped });
    insert("ticket_set_versions", {
      ticket_set_id: setId,
      version: 1,
      content: JSON.stringify(ticketSetContent),
      written_by_run: ticketsRunId,
      created_at: at,
    });
    insert("tickets_reviews", {
      id: reviewId,
      ticket_set_id: setId,
      ticket_set_version: 1,
      run_id: reviewRunId,
      passed: 1,
      summary: "Two findings.",
    });
    for (const [position, kind, route] of [
      [1, "untraced_criterion", "revise"],
      [2, "contradiction", "decision"],
    ] as const) {
      insert("tickets_review_findings", {
        review_id: reviewId,
        position,
        kind,
        route,
        title: `Finding ${String(position)}`,
        explanation: "Why.",
        question: "What now?",
        ticket_numbers: '["T1"]',
        criterion_ids: '["1.1"]',
        escalated: position === 2 ? 1 : 0,
      });
    }
    insert("hatch_messages", {
      id: refusedId,
      map_id: mapId,
      stage: "spec",
      specification_id: specId,
      text: "Drop criterion 1.1.",
      sent_at: at,
    });
    insert("hatch_messages", {
      id: appliedId,
      map_id: mapId,
      stage: "wayfinding",
      text: "Reopen the counting question.",
      sent_at: at,
    });
    insert("hatch_messages", {
      id: pendingId,
      map_id: otherMapId,
      stage: "idea",
      text: "Is blank a line?",
      sent_at: at,
    });
    for (const [runId, messageId] of [
      [hatchRunId, refusedId],
      [otherHatchRunId, appliedId],
    ] as const) {
      insert("planning_runs", {
        id: runId,
        map_id: mapId,
        purpose: "hatch",
        hatch_message_id: messageId,
        ...ended,
      });
    }
    db.$client
      .prepare(
        "update hatch_messages set run_id = ?, reply = ?, refusal = ?, replied_at = ? where id = ?",
      )
      .run(hatchRunId, "The spec is approved.", "spec_approved", at, refusedId);
    db.$client
      .prepare(
        "update hatch_messages set run_id = ?, reply = ?, change = ?, replied_at = ? where id = ?",
      )
      .run(
        otherHatchRunId,
        "Reopened.",
        JSON.stringify({ kind: "open_waypoint", waypoint: 1 }),
        at,
        appliedId,
      );
    insert("waypoints", {
      id: waypointId,
      map_id: mapId,
      number: 1,
      kind: "grilling",
      status: "open",
      title: "Counting",
      question: "What counts as a line?",
      created_by_run: chartRunId,
      hatch_message_id: appliedId,
    });
    insert("planning_runs", {
      id: noteRunId,
      purpose: "to_tickets",
      hatch_message_id: refusedId,
      ...specScoped,
      state: "failed",
      error_code: "agent_timeout",
      error_message: "Timed out.",
    });
  }

  test("keeps every row and value of a 0010 database and adds the two tables empty", async () => {
    await migrateUpTo("0010_delivery_completion");
    seed0010();
    const before = dumpAll();
    expect(before.hatch_messages).toHaveLength(3);
    expect(before.tickets_review_findings).toHaveLength(2);

    // 0011 alone, with foreign keys off as `migrateDatabase` runs it: later migrations change rows.
    db.$client.pragma("foreign_keys = OFF");
    await migrateUpTo("0011_revising_delivered_spec");
    db.$client.pragma("foreign_keys = ON");

    // The stored ticket set is left as it was; 0014 gives its tickets pointers so it parses.
    expect(dumpAll()).toEqual(before);
    expect(db.$client.prepare("select count(*) from waypoint_touches").pluck().get()).toBe(0);
    expect(db.$client.prepare("select count(*) from spec_waits").pluck().get()).toBe(0);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    for (const [table, parents] of [
      ["hatch_messages", ["maps", "planning_runs", "specifications"]],
      ["tickets_review_findings", ["tickets_reviews"]],
      ["planning_runs", ["hatch_messages", "maps", "planning_runs", "specifications", "waypoints"]],
    ] as const) {
      expect(
        db.$client
          .prepare(`select distinct "table" from pragma_foreign_key_list('${table}') order by 1`)
          .pluck()
          .all(),
        table,
      ).toEqual(parents);
    }
  });

  describe("on a migrated database", () => {
    let nextRun = 0;
    function run(): string {
      nextRun += 1;
      const runId = `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5e${nextRun.toString().padStart(2, "0")}`;
      insert("planning_runs", {
        id: runId,
        map_id: otherMapId,
        purpose: "to_spec",
        state: "running",
        started_at: at,
      });
      return runId;
    }
    let nextWait = 0;
    function wait(row: Record<string, unknown>): void {
      nextWait += 1;
      insert("spec_waits", {
        id: `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6e${nextWait.toString().padStart(2, "0")}`,
        map_id: otherMapId,
        specification_id: specId,
        note: "Trim the ends.",
        since: at,
        hold_kind: "revision",
        hold_map_id: mapId,
        hold_revision: 1,
        ...row,
      });
    }
    function touch(row: Record<string, unknown>): void {
      insert("waypoint_touches", {
        waypoint_id: waypointId,
        specification_id: specId,
        revision: 1,
        criteria: '["1.1"]',
        ...row,
      });
    }

    beforeEach(async () => {
      nextRun = 0;
      nextWait = 0;
      await migrateUpTo("0010_delivery_completion");
      seed0010();
      expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    });

    test("a refusal may be spec_waiting and a finding disposition_without_reason", () => {
      db.$client
        .prepare(
          "update hatch_messages set run_id = ?, reply = ?, refusal = ?, replied_at = ? where id = ?",
        )
        .run(hatchRunId, "This map already waits.", "spec_waiting", at, pendingId);
      insert("tickets_review_findings", {
        review_id: reviewId,
        position: 3,
        kind: "disposition_without_reason",
        route: "revise",
        title: "No reason",
        explanation: "1.1 changed and reads delivered.",
        question: "Why does it still hold?",
        ticket_numbers: "[]",
        criterion_ids: '["1.1"]',
        escalated: 0,
      });
      expect(() => {
        db.$client
          .prepare("update hatch_messages set refusal = ? where id = ?")
          .run("spec_unknown", pendingId);
      }).toThrow(SqliteError);
    });

    test("waypoint_touches: a known waypoint and spec, 1 to 12 criteria, one per waypoint and spec", () => {
      touch({});
      expect(() => {
        touch({ criteria: '["1.2"]' });
      }).toThrow(SqliteError);
      const otherSpec = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7e01";
      expect(() => {
        touch({ specification_id: otherSpec });
      }).toThrow(SqliteError);
      insert("specifications", { id: otherSpec, project_id: projectId, number: 2 });
      expect(() => {
        touch({ specification_id: otherSpec, criteria: "[]" });
      }).toThrow(SqliteError);
      const thirteen = JSON.stringify(Array.from({ length: 13 }, (_, i) => `1.${String(i + 1)}`));
      expect(() => {
        touch({ specification_id: otherSpec, criteria: thirteen });
      }).toThrow(SqliteError);
      expect(() => {
        touch({ specification_id: otherSpec, revision: 0 });
      }).toThrow(SqliteError);
      // The touched revision must be a stored revision of the spec.
      const twelve = thirteen.replace(',"1.13"', "");
      expect(() => {
        touch({ specification_id: otherSpec, criteria: twelve });
      }).toThrow(SqliteError);
      insert("spec_revisions", {
        id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7e02",
        specification_id: otherSpec,
        revision: 1,
        map_id: otherMapId,
        written_by_run: run(),
        content: "{}",
        created_at: at,
      });
      touch({ specification_id: otherSpec, criteria: twelve });
      expect(db.$client.prepare("select count(*) from waypoint_touches").pluck().get()).toBe(2);
    });

    test("spec_waits: one open wait per map and spec, released with its run, a known hold", () => {
      wait({ hatch_message_id: pendingId });
      expect(() => {
        wait({});
      }).toThrow(SqliteError);
      const released = run();
      db.$client
        .prepare("update spec_waits set released_at = ?, released_by_run = ?")
        .run(at, released);
      wait({});
      expect(() => {
        wait({ released_at: at });
      }).toThrow(SqliteError);
      expect(() => {
        wait({ released_by_run: run() });
      }).toThrow(SqliteError);
      wait({ map_id: mapId, released_at: at, released_by_run: released });
      expect(db.$client.prepare("select count(*) from spec_waits").pluck().get()).toBe(3);
    });

    test("spec_waits: the hold's kind is known, its map is set and its revision is at least 1", () => {
      expect(() => {
        wait({ hold_kind: "approved" });
      }).toThrow(SqliteError);
      expect(() => {
        wait({ hold_map_id: null });
      }).toThrow(SqliteError);
      expect(() => {
        wait({ hold_revision: 0 });
      }).toThrow(SqliteError);
      // The hold's revision must be a stored revision of the spec.
      expect(() => {
        wait({ hold_revision: 2 });
      }).toThrow(SqliteError);
      expect(() => {
        wait({ note: "" });
      }).toThrow(SqliteError);
      expect(() => {
        wait({ note: "x".repeat(4001) });
      }).toThrow(SqliteError);
      wait({ note: "x".repeat(4000), hold_kind: "delivering" });
    });

    test("a second unapproved revision of one spec still fails to insert", () => {
      const draft = (revisionNumber: number) => {
        insert("spec_revisions", {
          id: `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8e0${String(revisionNumber)}`,
          specification_id: specId,
          revision: revisionNumber,
          map_id: mapId,
          written_by_run: specRunId,
          content: "{}",
          created_at: at,
        });
      };
      draft(2);
      expect(() => {
        draft(3);
      }).toThrow(SqliteError);
    });
  });
});

describe("migration 0012", () => {
  const at = "2026-10-08T12:00:00.000Z";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01";
  const OLD_FOG = {
    newWaypoints: [],
    fogOutOfScope: [{ position: 2, line: "Later." }],
    newFog: [],
  };

  function message(id: string, change: unknown): void {
    db.$client
      .prepare(
        "insert into hatch_messages (id, map_id, stage, text, sent_at, run_id, reply, change, replied_at) values (?, ?, 'wayfinding', 'Rule it out', ?, ?, 'Done.', ?, ?)",
      )
      .run(
        id,
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c00",
        at,
        runId,
        change === null ? null : JSON.stringify(change),
        at,
      );
  }

  test("backfills fogDecided and fogSettledHere into every stored change's fog, so it parses", async () => {
    await migrateUpTo("0011_revising_delivered_spec");
    // The rows alone are under test: their map and run are not.
    db.$client.pragma("foreign_keys = OFF");
    message("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c11", {
      kind: "rule_out_of_scope",
      waypoint: 2,
      reason: "Not this effort.",
      fog: OLD_FOG,
    });
    message("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c12", { kind: "revise_spec" });
    message("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c13", null);

    // 0012 alone: the orphan rows would trip 0013's foreign key violation guard.
    await migrateUpTo("0012_hatch_change_fog_lists");
    db.$client.pragma("foreign_keys = ON");

    const changes = db
      .select({ id: hatchMessages.id, change: hatchMessages.change })
      .from(hatchMessages)
      .orderBy(hatchMessages.id)
      .all()
      .map((row) => row.change);
    expect(changes).toEqual([
      {
        kind: "rule_out_of_scope",
        waypoint: 2,
        reason: "Not this effort.",
        fog: { ...OLD_FOG, fogDecided: [], fogSettledHere: [] },
      },
      { kind: "revise_spec" },
      null,
    ]);
  });
});

describe("migration 0013", () => {
  const at = "2026-10-09T12:00:00.000Z";
  const ids = {
    project: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d00",
    map: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01",
    run: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d02",
    specification: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d03",
    revision: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d04",
    review: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d05",
    decision: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d11",
    revise: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d12",
    charted: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d13",
  };

  function run(sql: string, ...values: unknown[]): void {
    db.$client.prepare(sql).run(...values);
  }

  test("adds waypoints.person_decides, true exactly where a decision finding escalated to it", async () => {
    await migrateUpTo("0012_hatch_change_fog_lists");
    run(
      "insert into projects (id, folder_path, base_branch, created_at) values (?, '/repos/one', 'main', ?)",
      ids.project,
      at,
    );
    run(
      "insert into maps (id, project_id, idea, created_at) values (?, ?, 'An idea', ?)",
      ids.map,
      ids.project,
      at,
    );
    run(
      "insert into planning_runs (id, map_id, purpose, state, started_at, ended_at) values (?, ?, 'chart', 'completed', ?, ?)",
      ids.run,
      ids.map,
      at,
      at,
    );
    run(
      "insert into specifications (id, project_id, number) values (?, ?, 1)",
      ids.specification,
      ids.project,
    );
    run(
      "insert into spec_revisions (id, specification_id, revision, map_id, written_by_run, content, created_at) values (?, ?, 1, ?, ?, '{}', ?)",
      ids.revision,
      ids.specification,
      ids.map,
      ids.run,
      at,
    );
    run(
      "insert into spec_reviews (id, spec_revision_id, run_id, passed, summary, sources) values (?, ?, ?, 0, 'Findings.', '[]')",
      ids.review,
      ids.revision,
      ids.run,
    );
    for (const [number, id] of [ids.decision, ids.revise, ids.charted].entries()) {
      run(
        "insert into waypoints (id, map_id, number, kind, status, title, question, created_by_run) values (?, ?, ?, 'grilling', 'open', 'Title', 'Question?', ?)",
        id,
        ids.map,
        number + 1,
        ids.run,
      );
    }
    for (const [position, route, id] of [
      [1, "decision", ids.decision],
      [2, "revise", ids.revise],
    ] as const) {
      run(
        "insert into spec_review_findings (review_id, position, kind, route, title, explanation, question, element_ids, waypoint_numbers, escalated, waypoint_id) values (?, ?, 'contradiction', ?, 'Title', 'Why.', 'Question?', '[]', '[]', 1, ?)",
        ids.review,
        position,
        route,
        id,
      );
    }

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(
      db.$client.prepare("select id, person_decides from waypoints order by number").raw().all(),
    ).toEqual([
      [ids.decision, 1],
      [ids.revise, 0],
      [ids.charted, 0],
    ]);
    expect(() => {
      run(
        "insert into waypoints (id, map_id, number, kind, status, title, question, created_by_run) values ('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d14', ?, 4, 'grilling', 'open', 'Title', 'Question?', ?)",
        ids.map,
        ids.run,
      );
    }).toThrow(SqliteError);
  });
});

describe("migration 0014", () => {
  const at = "2026-10-10T12:00:00.000Z";
  const ticket = (id: string) => ({
    id,
    title: "Count lines",
    build: "Count the lines.",
    blockedBy: [],
    criteria: ["1.1"],
    testing: ["A file of three lines counts 3."],
    followUp: null,
    outOfScope: [],
  });
  const set = (tickets: unknown[]) => ({
    tickets,
    dispositions: [{ criterion: "1.1", kind: "satisfied", evidence: "Already counted." }],
    slicing: "One ticket.",
    execution: "In order.",
  });

  function version(ticketSetId: string, content: unknown): void {
    db.$client
      .prepare(
        "insert into ticket_set_versions (ticket_set_id, version, content, written_by_run, created_at) values (?, 1, ?, ?, ?)",
      )
      .run(ticketSetId, JSON.stringify(content), "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e00", at);
  }

  test("gives every stored ticket an empty pointers list, so each set parses", async () => {
    await migrateUpTo("0013_person_decides");
    // The rows alone are under test: their sets and runs are not.
    db.$client.pragma("foreign_keys = OFF");
    version("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01", set([ticket("T1"), ticket("T2")]));
    version("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e02", set([]));

    await migrateUpTo("0014_ticket_pointers");

    const contents = db
      .select({ content: ticketSetVersions.content })
      .from(ticketSetVersions)
      .orderBy(ticketSetVersions.ticketSetId)
      .all()
      .map((row) => row.content);
    expect(contents).toEqual([
      set([
        { ...ticket("T1"), pointers: [] },
        { ...ticket("T2"), pointers: [] },
      ]),
      set([]),
    ]);
  });
});

describe("migration 0015", () => {
  const at = "2026-10-10T12:00:00.000Z";
  const set = (dispositions: unknown[]) => ({
    tickets: [],
    dispositions,
    slicing: "Nothing to build.",
    execution: "Nothing to run.",
  });
  const satisfied = { criterion: "1.1", kind: "satisfied", evidence: "Already counted." };
  const delivered = { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null };
  const retained = (criterion: string) => ({ criterion, kind: "retained", ticket: "T2" });

  function version(ticketSetId: string, content: unknown): void {
    db.$client
      .prepare(
        "insert into ticket_set_versions (ticket_set_id, version, content, written_by_run, created_at) values (?, 1, ?, ?, ?)",
      )
      .run(ticketSetId, JSON.stringify(content), "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e00", at);
  }

  test("gives every stored retained disposition a null reason and leaves the rest, so each set parses", async () => {
    await migrateUpTo("0014_ticket_pointers");
    // The rows alone are under test: their sets and runs are not.
    db.$client.pragma("foreign_keys = OFF");
    version(
      "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01",
      set([satisfied, retained("1.3"), delivered, retained("1.4")]),
    );
    version("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e02", set([satisfied]));

    await migrateUpTo("0015_retained_reason");

    const contents = db
      .select({ content: ticketSetVersions.content })
      .from(ticketSetVersions)
      .orderBy(ticketSetVersions.ticketSetId)
      .all()
      .map((row) => row.content);
    expect(contents).toEqual([
      set([
        satisfied,
        { ...retained("1.3"), reason: null },
        delivered,
        { ...retained("1.4"), reason: null },
      ]),
      set([satisfied]),
    ]);
  });
});

describe("migration 0020", () => {
  const at = "2026-10-11T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a01";
  const mapIds = ["0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a11", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a12"];
  const runIds = ["0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a21", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a22"];
  const specificationId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a31";
  const specRevisionId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a41";
  const ticketSetId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a51";
  const deliveryRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a61";
  const TABLES = [
    "projects",
    "maps",
    "planning_runs",
    "specifications",
    "spec_revisions",
    "ticket_sets",
    "delivery_runs",
  ];

  function fill(): void {
    const client = db.$client;
    client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at, required_checks) values (?, '/repo', 'main', ?, '[]')",
      )
      .run(projectId, at);
    for (const [index, mapId] of mapIds.entries()) {
      client
        .prepare(
          "insert into maps (id, project_id, idea, created_at, fog_next_position) values (?, ?, ?, ?, 1)",
        )
        .run(mapId, projectId, `Idea ${String(index)}`, at);
    }
    client
      .prepare(
        "insert into planning_runs (id, map_id, purpose, state, started_at, ended_at) values (?, ?, 'to_spec', 'completed', ?, ?)",
      )
      .run(runIds[0], mapIds[0], at, at);
    client
      .prepare(
        "insert into planning_runs (id, map_id, purpose, state, started_at) values (?, ?, 'chart', 'running', ?)",
      )
      .run(runIds[1], mapIds[1], at);
    client
      .prepare("insert into specifications (id, project_id, number) values (?, ?, 1)")
      .run(specificationId, projectId);
    client
      .prepare(
        "insert into spec_revisions (id, specification_id, revision, map_id, written_by_run, content, created_at, approved_at) values (?, ?, 1, ?, ?, '{}', ?, ?)",
      )
      .run(specRevisionId, specificationId, mapIds[0], runIds[0], at, at);
    client
      .prepare(
        "insert into ticket_sets (id, spec_revision_id, state, version, created_at, updated_at, approved_at) values (?, ?, 'approved', 1, ?, ?, ?)",
      )
      .run(ticketSetId, specRevisionId, at, at, at);
    client
      .prepare(
        "insert into delivery_runs (id, project_id, specification_id, ticket_set_id, number, branch, worktree_path, base_branch, base_commit, checks, phase, started_at) values (?, ?, ?, ?, 1, 'b', '/w', 'main', ?, '[\"x\"]', 'preparing', ?)",
      )
      .run(deliveryRunId, projectId, specificationId, ticketSetId, "a".repeat(40), at);
  }

  function dump(table: string): Record<string, unknown>[] {
    return z
      .array(z.record(z.string(), z.unknown()))
      .parse(db.$client.prepare(`select * from ${table} order by rowid`).all());
  }

  test("keeps every row, creates the one user, backfills user_id to it and executor to local", async () => {
    await migrateUpTo("0019_fog_runs");
    fill();
    const before = TABLES.map(dump);

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    const users = dump("users");
    expect(users).toHaveLength(1);
    const [user] = users;
    expect(user?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(z.iso.datetime().safeParse(user?.created_at).success).toBe(true);
    const withUser = new Set(["maps", "planning_runs", "delivery_runs"]);
    for (const [index, table] of TABLES.entries()) {
      const rows = rowsAt(before, index);
      // 0024 then starts every delivery run at its base commit, 0026 gives every map its null
      // split-from columns, and 0030 every project no repair limit and no fix commands.
      expect(dump(table), table).toEqual(
        withUser.has(table)
          ? rows.map((row) => ({
              ...row,
              user_id: user?.id,
              ...(table === "delivery_runs" ? runColumnsAfter0020(row) : {}),
              ...(table === "maps" ? SPLIT_FROM_NULLS : {}),
            }))
          : table === "projects"
            ? rows.map((row) => ({ ...row, ...REPAIR_SETTINGS_UNSAVED }))
            : rows,
      );
    }
    expect(dump("change_feed")).toEqual([]);
    expect(dump("write_actor")).toEqual([]);
  });

  test("checks write_actor and change_feed rows: one actor row, each kind with its ids", () => {
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    const user = "0123456789abcdef0123456789abcdef";
    const run = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f5a21";
    const actor = (id: number, kind: string, userId: string | null, runId: string | null) => () =>
      db.$client
        .prepare(
          "insert into write_actor (id, actor_kind, actor_user_id, actor_run_id) values (?, ?, ?, ?)",
        )
        .run(id, kind, userId, runId);
    expect(constraintOf(actor(2, "system", null, null))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(actor(1, "robot", null, null))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(actor(1, "user", null, null))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(actor(1, "user", user, run))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(actor(1, "planning_run", user, null))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(actor(1, "delivery_run", null, run))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(actor(1, "system", user, null))).toBe("SQLITE_CONSTRAINT_CHECK");
    actor(1, "delivery_run", user, run)();
    expect(constraintOf(actor(1, "system", null, null))).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");

    const feed = (op: string, kind: string, userId: string | null) => () =>
      db.$client
        .prepare(
          "insert into change_feed (project_id, map_id, entity_type, entity_id, op, actor_kind, actor_user_id, actor_run_id, at) values (?, null, 'projects', ?, ?, ?, ?, null, ?)",
        )
        .run(projectId, projectId, op, kind, userId, at);
    expect(constraintOf(feed("upsert", "system", null))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(feed("insert", "user", null))).toBe("SQLITE_CONSTRAINT_CHECK");
    feed("insert", "user", user)();
    feed("delete", "system", null)();
    expect(db.$client.prepare("select seq from change_feed order by seq").pluck().all()).toEqual([
      1, 2,
    ]);
  });
});

describe("migrations 0022 and 0023", () => {
  const at = "2026-10-11T12:00:00.000Z";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f00";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f01";
  const options = [
    { label: "Yes", detail: "Gives this." },
    { label: "No", detail: "Gives that." },
  ];
  const question = (withOptions: boolean) => ({
    topic: "Hosting",
    text: "Where is it hosted?",
    options: withOptions ? options : [],
  });

  function waypoint(id: string, number: number): void {
    db.$client
      .prepare(
        "insert into waypoints (id, map_id, number, kind, status, title, question, claimed_at, created_by_run, person_decides) values (?, ?, ?, 'task', 'claimed', 'A task', 'What?', ?, ?, 0)",
      )
      .run(id, mapId, number, at, runId);
  }

  function round(id: string, waypointId: string, questions: unknown[]): void {
    db.$client
      .prepare(
        "insert into question_rounds (id, map_id, waypoint_id, number, final, status, asked_by_run, intro, questions, asked_at) values (?, ?, ?, 1, 0, 'pending', ?, 'One thing.', ?, ?)",
      )
      .run(id, mapId, waypointId, runId, JSON.stringify(questions), at);
  }

  test("delete unanswered rounds with an option-less question and open a pending one's waypoint; the rest parse", async () => {
    await migrateUpTo("0021_spec_review_verified");
    // The rows alone are under test: their map and runs are not.
    db.$client.pragma("foreign_keys = OFF");
    waypoint("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f10", 1);
    waypoint("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f11", 2);
    round("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f20", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f10", [
      question(true),
      question(false),
    ]);
    round("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f21", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f11", [
      question(true),
    ]);
    // A round a reopen withdrew is never answered either.
    waypoint("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f12", 3);
    round("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f22", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f12", [
      question(false),
    ]);
    db.$client
      .prepare(
        "update question_rounds set status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = 'superseded' where id = ?",
      )
      .run(at, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f22");

    await migrateUpTo("0023_unanswered_optionless_rounds");

    expect(
      db.$client.prepare("select number, status from waypoints order by number").all(),
    ).toEqual([
      { number: 1, status: "open" },
      { number: 2, status: "claimed" },
      { number: 3, status: "claimed" },
    ]);
    expect(
      db
        .select({ id: questionRounds.id, questions: questionRounds.questions })
        .from(questionRounds)
        .all(),
    ).toEqual([{ id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f21", questions: [question(true)] }]);
  });
});

describe("migration 0024", () => {
  test("every run before it starts at its base commit and resumes no run", async () => {
    await migrateUpTo("0023_unanswered_optionless_rounds");
    // The run alone is under test: its project, spec and ticket set are not.
    db.$client.pragma("foreign_keys = OFF");
    const user = db.$client.prepare("select id from users").pluck().get();
    db.$client
      .prepare(
        "insert into delivery_runs (id, project_id, specification_id, ticket_set_id, number, branch, worktree_path, base_branch, base_commit, checks, phase, started_at, user_id, executor) values (?, ?, ?, ?, 1, 'b', '/w', 'main', ?, '[\"x\"]', 'preparing', ?, ?, 'local')",
      )
      .run(
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e01",
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e02",
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e03",
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4e04",
        "a".repeat(40),
        "2026-10-12T12:00:00.000Z",
        user,
      );

    await migrateUpTo("0024_delivery_resume");

    expect(
      db.$client.prepare("select start_commit, resumed_from_run_id from delivery_runs").all(),
    ).toEqual([{ start_commit: "a".repeat(40), resumed_from_run_id: null }]);
  });
});

describe("migration 0026", () => {
  const at = "2026-10-12T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a01";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a11";
  const otherMapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a12";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a21";
  const otherRunId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a22";

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A project with two maps, a completed chart on each, and one Out of scope line on the first. */
  function seed(): void {
    const userId: unknown = db.$client.prepare("select id from users").pluck().get();
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
    });
    for (const [id, run] of [
      [mapId, runId],
      [otherMapId, otherRunId],
    ] as const) {
      insert("maps", {
        id,
        project_id: projectId,
        idea: "An idea",
        created_at: at,
        fog_next_position: 1,
        user_id: userId,
      });
      insert("planning_runs", {
        id: run,
        map_id: id,
        purpose: "chart",
        state: "completed",
        started_at: at,
        ended_at: at,
        user_id: userId,
      });
    }
    insert("map_exclusions", {
      map_id: mapId,
      position: 1,
      text: "Not this effort.",
      waypoint_id: null,
      created_by_run: runId,
    });
  }

  test("an existing map records no source map and its lines link no map; nothing is backfilled", async () => {
    await migrateUpTo("0023_unanswered_optionless_rounds");
    seed();

    await migrateUpTo("0026_map_proposals");

    expect(
      db.$client
        .prepare("select id, split_from_map_id, split_from_run_id from maps order by id")
        .all(),
    ).toEqual([
      { id: mapId, ...SPLIT_FROM_NULLS },
      { id: otherMapId, ...SPLIT_FROM_NULLS },
    ]);
    expect(
      db.$client.prepare("select position, text, split_map_id from map_exclusions").all(),
    ).toEqual([{ position: 1, text: "Not this effort.", split_map_id: null }]);
    expect(db.$client.prepare("select count(*) from map_proposals").pluck().get()).toBe(0);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("map_proposals: a pending, confirmed or dismissed proposal within its bounds, by a run of its map", async () => {
    await migrateUpTo("0026_map_proposals");
    seed();
    let next = 0;
    const proposal = (row: Record<string, unknown>) => () => {
      next += 1;
      insert("map_proposals", {
        id: `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6b${next.toString().padStart(2, "0")}`,
        map_id: mapId,
        idea: "Import data too.",
        line: "Imports are a later effort.",
        waypoint_id: null,
        state: "pending",
        new_map_id: null,
        created_by_run: runId,
        created_at: at,
        decided_at: null,
        ...row,
      });
    };
    expect(constraintOf(proposal({}))).toBeUndefined();
    expect(
      constraintOf(proposal({ state: "confirmed", new_map_id: otherMapId, decided_at: at })),
    ).toBeUndefined();
    expect(constraintOf(proposal({ state: "dismissed", decided_at: at }))).toBeUndefined();
    expect(constraintOf(proposal({ state: "confirmed", decided_at: at }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(proposal({ new_map_id: otherMapId }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ state: "dismissed" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ decided_at: at }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ state: "open" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ idea: "" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ idea: "i".repeat(4001) }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ idea: "i".repeat(4000) }))).toBeUndefined();
    expect(constraintOf(proposal({ line: "l".repeat(501) }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ created_by_run: otherRunId }))).toBe(
      "SQLITE_CONSTRAINT_FOREIGNKEY",
    );
  });
});

describe("migration 0027", () => {
  const at = "2026-10-12T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7a01";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7a11";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7a21";
  const messageId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7a31";
  const proposalId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7a41";

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A map with a completed chart, one Out of scope line, a refused hatch reply and a proposal. */
  function seed(): void {
    const userId: unknown = db.$client.prepare("select id from users").pluck().get();
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "An idea",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", {
      id: runId,
      map_id: mapId,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
      user_id: userId,
    });
    insert("map_exclusions", {
      map_id: mapId,
      position: 1,
      text: "Not this effort.",
      waypoint_id: null,
      created_by_run: runId,
    });
    insert("hatch_messages", {
      id: messageId,
      map_id: mapId,
      stage: "wayfinding",
      text: "Reword waypoint 1.",
      sent_at: at,
      run_id: runId,
      reply: "I didn't change that waypoint.",
      refusal: "waypoint_state",
      replied_at: at,
    });
    insert("map_proposals", {
      id: proposalId,
      map_id: mapId,
      idea: "Import data too.",
      line: "Imports are a later effort.",
      state: "pending",
      created_by_run: runId,
      created_at: at,
    });
  }

  test("keeps every hatch message and proposal; a stored proposal names no existing line", async () => {
    await migrateUpTo("0026_map_proposals");
    seed();

    await migrateUpTo("0027_hatch_map_proposals");

    expect(db.$client.prepare("select id, refusal from hatch_messages").all()).toEqual([
      { id: messageId, refusal: "waypoint_state" },
    ]);
    expect(
      db.$client
        .prepare("select id, line, waypoint_id, exclusion_position from map_proposals")
        .all(),
    ).toEqual([
      {
        id: proposalId,
        line: "Imports are a later effort.",
        waypoint_id: null,
        exclusion_position: null,
      },
    ]);
    expect(
      db.$client
        .prepare("select count(*) from sqlite_master where name = 'map_proposals_map'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("a refusal may be exclusion_not_found or exclusion_already_split", async () => {
    await migrateUpTo("0027_hatch_map_proposals");
    seed();
    const update = db.$client.prepare("update hatch_messages set refusal = ? where id = ?");
    for (const refusal of ["exclusion_not_found", "exclusion_already_split"]) {
      expect(constraintOf(() => update.run(refusal, messageId))).toBeUndefined();
    }
    expect(constraintOf(() => update.run("exclusion_missing", messageId))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
  });

  test("keeps 0025's stage check: a message's stage may be tickets, never implementation", async () => {
    await migrateUpTo("0027_hatch_map_proposals");
    seed();
    const update = db.$client.prepare("update hatch_messages set stage = ? where id = ?");
    expect(constraintOf(() => update.run("tickets", messageId))).toBeUndefined();
    expect(constraintOf(() => update.run("implementation", messageId))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
  });

  test("map_proposals: exactly one of its own line, a waypoint and an existing line of its map", async () => {
    await migrateUpTo("0027_hatch_map_proposals");
    seed();
    let next = 0;
    const proposal = (row: Record<string, unknown>) => () => {
      next += 1;
      insert("map_proposals", {
        id: `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f7b${next.toString().padStart(2, "0")}`,
        map_id: mapId,
        idea: "Import data too.",
        line: null,
        waypoint_id: null,
        exclusion_position: null,
        state: "pending",
        new_map_id: null,
        created_by_run: runId,
        created_at: at,
        decided_at: null,
        ...row,
      });
    };
    expect(constraintOf(proposal({ exclusion_position: 1 }))).toBeUndefined();
    expect(constraintOf(proposal({ line: "Later." }))).toBeUndefined();
    expect(constraintOf(proposal({}))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(proposal({ line: "Later.", exclusion_position: 1 }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(proposal({ exclusion_position: 2 }))).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  });
});

describe("migration 0028", () => {
  const at = "2026-10-13T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8a01";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8a11";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8a21";

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A map with a completed chart. */
  function seedMap(): void {
    const userId: unknown = db.$client.prepare("select id from users").pluck().get();
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "An idea",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", {
      id: runId,
      map_id: mapId,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
      user_id: userId,
    });
  }

  function proposal(id: string, row: Record<string, unknown>): Record<string, unknown> {
    return {
      id,
      map_id: mapId,
      line: "Later.",
      state: "pending",
      created_by_run: runId,
      created_at: at,
      ...row,
    };
  }

  test("titles each stored proposal with its idea's first sentence, at most 120 characters", async () => {
    await migrateUpTo("0027_hatch_map_proposals");
    seedMap();
    const long = "x".repeat(130);
    insert(
      "map_proposals",
      proposal("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8b01", { idea: "Import data too. Then more." }),
    );
    insert(
      "map_proposals",
      proposal("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8b02", { idea: "No full stop here" }),
    );
    insert("map_proposals", proposal("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8b03", { idea: long }));
    insert(
      "map_proposals",
      proposal("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8b04", { idea: ".Starts with a stop" }),
    );

    await migrateUpTo("0028_map_proposal_titles");

    expect(db.$client.prepare("select title, idea from map_proposals order by id").all()).toEqual([
      { title: "Import data too", idea: "Import data too. Then more." },
      { title: "No full stop here", idea: "No full stop here" },
      { title: "x".repeat(120), idea: long },
      { title: ".Starts with a stop", idea: ".Starts with a stop" },
    ]);
    expect(
      db.$client
        .prepare("select count(*) from sqlite_master where name = 'map_proposals_map'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("a title is required, 1 to 120 characters", async () => {
    await migrateUpTo("0028_map_proposal_titles");
    seedMap();
    let next = 0;
    const add = (row: Record<string, unknown>) => () => {
      next += 1;
      insert(
        "map_proposals",
        proposal(`0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f8c${next.toString().padStart(2, "0")}`, {
          idea: "Import data too.",
          ...row,
        }),
      );
    };
    expect(constraintOf(add({ title: "Import data" }))).toBeUndefined();
    expect(constraintOf(add({}))).toBe("SQLITE_CONSTRAINT_NOTNULL");
    expect(constraintOf(add({ title: "" }))).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(constraintOf(add({ title: "x".repeat(121) }))).toBe("SQLITE_CONSTRAINT_CHECK");
  });
});
describe("migration 0029", () => {
  const at = "2026-10-13T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f9a01";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f9a11";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f9a21";

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A map with a completed chart. */
  function seedMap(): void {
    const userId: unknown = db.$client.prepare("select id from users").pluck().get();
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "An idea",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", {
      id: runId,
      map_id: mapId,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
      user_id: userId,
    });
  }

  function proposal(id: string, row: Record<string, unknown>): Record<string, unknown> {
    return {
      id,
      map_id: mapId,
      line: "Later.",
      state: "pending",
      created_by_run: runId,
      created_at: at,
      ...row,
    };
  }

  test("every stored proposal is outside work", async () => {
    await migrateUpTo("0028_map_proposal_titles");
    seedMap();
    insert(
      "map_proposals",
      proposal("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f9b01", { title: "Imports", idea: "Import data." }),
    );

    await migrateUpTo("0029_map_proposal_kinds");

    expect(db.$client.prepare("select kind, title from map_proposals").all()).toEqual([
      { kind: "outside", title: "Imports" },
    ]);
    expect(
      db.$client
        .prepare("select count(*) from sqlite_master where name = 'map_proposals_map'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("a kind is required: split or outside", () => {
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    seedMap();
    let next = 0;
    const add = (row: Record<string, unknown>) => () => {
      next += 1;
      insert(
        "map_proposals",
        proposal(`0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f9c${next.toString().padStart(2, "0")}`, {
          title: "Imports",
          idea: "Import data.",
          ...row,
        }),
      );
    };
    expect(constraintOf(add({ kind: "split" }))).toBeUndefined();
    expect(constraintOf(add({ kind: "outside" }))).toBeUndefined();
    expect(constraintOf(add({}))).toBe("SQLITE_CONSTRAINT_NOTNULL");
    expect(constraintOf(add({ kind: "inside" }))).toBe("SQLITE_CONSTRAINT_CHECK");
  });
});

describe("migration 0030", () => {
  const at = "2026-10-14T12:00:00.000Z";
  const commit = "a".repeat(40);
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa001";
  const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa011";
  const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa021";
  const specificationId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa031";
  const specRevisionId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa041";
  const ticketSetId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa051";
  const verdict = JSON.stringify({ reviewedCommit: commit, summary: "Fine.", findings: [] });
  const PULL_REQUEST = {
    pr_number: 12,
    pr_url: "https://github.com/acme/numbers/pull/12",
    pr_state: "open",
  };

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A project with an approved ticket set to deliver. */
  function seed(): void {
    const userId: unknown = db.$client.prepare("select id from users").pluck().get();
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "An idea",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", {
      id: runId,
      map_id: mapId,
      purpose: "to_spec",
      state: "completed",
      started_at: at,
      ended_at: at,
      user_id: userId,
    });
    insert("specifications", { id: specificationId, project_id: projectId, number: 1 });
    insert("spec_revisions", {
      id: specRevisionId,
      specification_id: specificationId,
      revision: 1,
      map_id: mapId,
      written_by_run: runId,
      content: "{}",
      created_at: at,
      approved_at: at,
    });
    insert("ticket_sets", {
      id: ticketSetId,
      spec_revision_id: specRevisionId,
      state: "approved",
      version: 1,
      created_at: at,
      updated_at: at,
      approved_at: at,
    });
  }

  let nextNumber = 0;

  /** A run numbered after the previous one, ended with `row`'s outcome, in `row`'s phase. */
  function run(row: Record<string, unknown>): () => void {
    return () => {
      nextNumber += 1;
      insert("delivery_runs", {
        id: `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa${nextNumber.toString().padStart(3, "0")}`,
        project_id: projectId,
        specification_id: specificationId,
        ticket_set_id: ticketSetId,
        number: nextNumber,
        branch: `zenorm/spec-run-${String(nextNumber)}`,
        worktree_path: "/w",
        base_branch: "main",
        base_commit: commit,
        start_commit: commit,
        checks: '["x"]',
        phase: "reviewing",
        started_at: at,
        ended_at: at,
        user_id: db.$client.prepare("select id from users").pluck().get(),
        executor: "local",
        ...row,
      });
    };
  }

  beforeEach(() => {
    nextNumber = 0;
  });

  test("every run before it keeps its columns and opened no pull request", async () => {
    await migrateUpTo("0029_map_proposal_kinds");
    seed();
    run({ verdict })();
    run({ ended_at: null, phase: "implementing" })();
    const before = z
      .array(z.record(z.string(), z.unknown()))
      .parse(db.$client.prepare("select * from delivery_runs order by number").all());

    await migrateUpTo("0030_delivery_pull_requests");

    expect(db.$client.prepare("select * from delivery_runs order by number").all()).toEqual(
      before.map((row) => ({ ...row, ...PULL_REQUEST_NULLS })),
    );
    for (const name of ["delivery_runs_one_active_per_project", "delivery_runs_spec_number_uq"]) {
      expect(
        db.$client.prepare("select count(*) from sqlite_master where name = ?").pluck().get(name),
      ).toBe(1);
    }
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("a run may end in publishing, and a passed run records its pull request", () => {
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    seed();
    expect(constraintOf(run({ phase: "publishing", verdict, ...PULL_REQUEST }))).toBeUndefined();
    expect(
      constraintOf(
        run({ phase: "publishing", failure: '{"code":"delivery_push_failed","message":"No."}' }),
      ),
    ).toBeUndefined();
    expect(constraintOf(run({ phase: "merging", verdict }))).toBe("SQLITE_CONSTRAINT_CHECK");
  });

  test("a pull request is all three columns, in a known state, on a run with a verdict", () => {
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    seed();
    expect(constraintOf(run({ verdict, ...PULL_REQUEST, pr_url: null }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(run({ verdict, ...PULL_REQUEST, pr_state: null }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(run({ verdict, ...PULL_REQUEST, pr_state: "draft" }))).toBe(
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(constraintOf(run({ ...PULL_REQUEST }))).toBe("SQLITE_CONSTRAINT_CHECK");
    for (const state of ["open", "closed", "merged"]) {
      expect(constraintOf(run({ verdict, ...PULL_REQUEST, pr_state: state }))).toBeUndefined();
    }
  });
});

describe("migration 0031", () => {
  const indexes = (): unknown[] =>
    db.$client
      .prepare(
        "select name from sqlite_master where type = 'index' and tbl_name = 'spec_reviews' and name like 'spec_reviews_spec_revision%' order by name",
      )
      .pluck()
      .all();

  test("a revision's reviews are indexed, no longer one per revision", async () => {
    await migrateUpTo("0030_delivery_pull_requests");
    expect(indexes()).toEqual(["spec_reviews_spec_revision_uq"]);
    expect(migrateDatabase(db, MIGRATIONS_FOLDER).ok).toBe(true);
    expect(indexes()).toEqual(["spec_reviews_spec_revision"]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("migration 0032", () => {
  const at = "2026-10-14T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa001";

  test("an existing project has no repair limit and no fix commands, its other values kept", async () => {
    await migrateUpTo("0031_spec_review_per_rewrite");
    db.$client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at, required_checks) values (?, ?, ?, ?, ?)",
      )
      .run(projectId, "/repo", "main", at, '["pnpm test"]');

    await migrateUpTo("0032_project_repair_settings");

    expect(db.$client.prepare("select * from projects").all()).toEqual([
      {
        id: projectId,
        folder_path: "/repo",
        base_branch: "main",
        created_at: at,
        required_checks: '["pnpm test"]',
        repair_limit: null,
        fix_commands: "[]",
      },
    ]);
  });

  test("the stored project reads repairLimit null and fixCommands empty", async () => {
    await migrateUpTo("0031_spec_review_per_rewrite");
    db.$client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at, required_checks) values (?, ?, ?, ?, ?)",
      )
      .run(projectId, "/repo", "main", at, "[]");

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(db.select().from(projects).all()).toEqual([
      {
        id: projectId,
        folderPath: "/repo",
        baseBranch: "main",
        createdAt: at,
        requiredChecks: [],
        repairLimit: null,
        fixCommands: [],
        appStartCommand: null,
        appUrl: null,
        appSetupCommands: [],
      },
    ]);
  });
});

describe("migration 0036", () => {
  const at = "2026-10-18T12:00:00.000Z";
  const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fa036";

  test("an existing project has no app start command, URL or setup commands, its other values kept", async () => {
    await migrateUpTo("0035_agent_decided");
    db.$client
      .prepare(
        "insert into projects (id, folder_path, base_branch, created_at, required_checks, repair_limit, fix_commands) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(projectId, "/repo", "main", at, '["pnpm test"]', 2, '["pnpm format"]');

    await migrateUpTo("0036_project_app_settings");

    expect(db.$client.prepare("select * from projects").all()).toEqual([
      {
        id: projectId,
        folder_path: "/repo",
        base_branch: "main",
        created_at: at,
        required_checks: '["pnpm test"]',
        repair_limit: 2,
        fix_commands: '["pnpm format"]',
        app_start_command: null,
        app_url: null,
        app_setup_commands: "[]",
      },
    ]);
  });
});

describe("migration 0033", () => {
  const at = "2026-10-14T12:00:00.000Z";
  const ids = Array.from(
    { length: 8 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fb0${index.toString().padStart(2, "0")}`,
  );
  const [projectId, mapId, chartRunId, specId, revisionId, ticketsRunId, setId, runId] = ids;

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A `0032` database with one ended delivery run. */
  function seedRun(): void {
    const userId = db.$client.prepare("select id from users").pluck().get();
    const ended = { state: "completed", started_at: at, ended_at: at, user_id: userId };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: '["pnpm test"]',
      repair_limit: 2,
      fix_commands: '["pnpm format"]',
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "Count lines",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    insert("specifications", { id: specId, project_id: projectId, number: 1 });
    insert("spec_revisions", {
      id: revisionId,
      specification_id: specId,
      revision: 1,
      map_id: mapId,
      written_by_run: chartRunId,
      content: "{}",
      created_at: at,
      approved_at: at,
    });
    insert("planning_runs", {
      id: ticketsRunId,
      map_id: mapId,
      specification_id: specId,
      purpose: "to_tickets",
      ...ended,
    });
    insert("ticket_sets", {
      id: setId,
      spec_revision_id: revisionId,
      state: "approved",
      version: 1,
      created_at: at,
      updated_at: at,
      approved_at: at,
    });
    insert("delivery_runs", {
      id: runId,
      project_id: projectId,
      specification_id: specId,
      ticket_set_id: setId,
      number: 1,
      branch: "zenorm/lines-run-1",
      worktree_path: "/runs/1/worktree",
      base_branch: "main",
      base_commit: "a".repeat(40),
      start_commit: "a".repeat(40),
      checks: '["pnpm test"]',
      phase: "verifying",
      started_at: at,
      ended_at: at,
      failure: '{"code":"delivery_checks_failed","message":"These checks did not pass"}',
      user_id: userId,
      executor: "local",
    });
  }

  test("a run from before has no pinned repair limit, no attempt count and no fix commands", async () => {
    await migrateUpTo("0032_project_repair_settings");
    seedRun();
    const runs = () =>
      z
        .array(z.record(z.string(), z.unknown()))
        .parse(db.$client.prepare("select * from delivery_runs").all());
    const before = runs();
    expect(before).toHaveLength(1);

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(runs()).toEqual(
      before.map((row) => ({ ...row, ...REPAIRS_UNPINNED, ...APP_SETTINGS_UNPINNED })),
    );
    expect(
      db
        .select({
          repairLimit: deliveryRuns.repairLimit,
          repairAttempts: deliveryRuns.repairAttempts,
          fixCommands: deliveryRuns.fixCommands,
        })
        .from(deliveryRuns)
        .all(),
    ).toEqual([{ repairLimit: null, repairAttempts: null, fixCommands: [] }]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("0037: a run from before pins no app start command, URL or setup commands", async () => {
    await migrateUpTo("0036_project_app_settings");
    seedRun();
    const runs = () =>
      z
        .array(z.record(z.string(), z.unknown()))
        .parse(db.$client.prepare("select * from delivery_runs").all());
    const before = runs();
    expect(before).toHaveLength(1);

    await migrateUpTo("0037_delivery_run_app_settings");

    expect(runs()).toEqual(before.map((row) => ({ ...row, ...APP_SETTINGS_UNPINNED })));
    expect(
      db
        .select({
          appStartCommand: deliveryRuns.appStartCommand,
          appUrl: deliveryRuns.appUrl,
          appSetupCommands: deliveryRuns.appSetupCommands,
        })
        .from(deliveryRuns)
        .all(),
    ).toEqual([{ appStartCommand: null, appUrl: null, appSetupCommands: [] }]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("migration 0034", () => {
  const at = "2026-10-16T12:00:00.000Z";
  const ids = Array.from(
    { length: 14 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fc0${index.toString().padStart(2, "0")}`,
  );
  const [
    projectId,
    mapId,
    chartRunId,
    waypointId,
    grillRunId,
    roundOneId,
    roundTwoId,
    wayRoundId,
    pendingWayRoundId,
    otherMapId,
    otherRunId,
    finalOneId,
    otherOneId,
    finalTwoId,
  ] = ids;
  const questions = JSON.stringify([
    {
      topic: "Scope",
      text: "How far?",
      options: [
        { label: "Narrow", detail: "Soon." },
        { label: "Wide", detail: "All." },
      ],
    },
  ]);
  const answers = JSON.stringify([{ optionIndex: 0, note: "", accepted: true }]);

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  function rounds(): unknown[] {
    return db.$client.prepare("select * from question_rounds order by id").all();
  }

  function round(row: Record<string, unknown>): void {
    insert("question_rounds", {
      map_id: mapId,
      waypoint_id: null,
      final: 0,
      status: "submitted",
      asked_by_run: chartRunId,
      intro: "Intro.",
      questions,
      answers,
      asked_at: at,
      submitted_at: at,
      ...row,
    });
  }

  /** A map with two submitted map-level rounds, a final waypoint round and a pending one. */
  function seed(): void {
    const userId = db.$client.prepare("select id from users").pluck().get();
    const ended = { state: "completed", started_at: at, ended_at: at, user_id: userId };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "An idea",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    insert("waypoints", {
      id: waypointId,
      map_id: mapId,
      number: 1,
      kind: "grilling",
      status: "open",
      title: "A decision",
      question: "What holds?",
      created_by_run: chartRunId,
      person_decides: 0,
    });
    insert("planning_runs", {
      id: grillRunId,
      map_id: mapId,
      waypoint_id: waypointId,
      purpose: "grilling",
      ...ended,
    });
    round({ id: roundOneId, number: 1 });
    round({ id: roundTwoId, number: 2 });
    round({
      id: wayRoundId,
      waypoint_id: waypointId,
      number: 1,
      final: 1,
      asked_by_run: grillRunId,
    });
    round({
      id: pendingWayRoundId,
      waypoint_id: waypointId,
      number: 2,
      status: "pending",
      asked_by_run: grillRunId,
      answers: null,
      submitted_at: null,
    });
  }

  function checkSql(): string {
    const sql: unknown = db.$client
      .prepare("select sql from sqlite_master where name = 'question_rounds'")
      .pluck()
      .get();
    if (typeof sql !== "string") throw new Error("No question_rounds table");
    return sql;
  }

  test("keeps every row and value, every index, and swaps the one check", async () => {
    await migrateUpTo("0033_delivery_run_repairs");
    seed();
    const before = rounds();
    const indexes = () =>
      db.$client
        .prepare(
          "select name, sql from sqlite_master where type = 'index' and tbl_name = 'question_rounds' order by name",
        )
        .all();
    const indexesBefore = indexes();
    const sqlBefore = checkSql();
    expect(before).toHaveLength(4);
    expect(sqlBefore).toContain("question_rounds_map_level_not_final_ck");

    await migrateUpTo("0034_first_map_round_not_final");

    expect(rounds()).toEqual(before);
    expect(indexes()).toEqual(indexesBefore);
    const sqlAfter = checkSql();
    expect(sqlAfter).not.toContain("question_rounds_map_level_not_final_ck");
    expect(sqlAfter).toContain("question_rounds_first_map_round_not_final_ck");
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("the new check rejects a final map-level round 1 and accepts a final round 2 and waypoint round", async () => {
    await migrateUpTo("0034_first_map_round_not_final");
    seed();
    const userId = db.$client.prepare("select id from users").pluck().get();
    insert("maps", {
      id: otherMapId,
      project_id: projectId,
      idea: "Another idea",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", {
      id: otherRunId,
      map_id: otherMapId,
      purpose: "chart",
      state: "completed",
      started_at: at,
      ended_at: at,
      user_id: userId,
    });
    const onOther = { map_id: otherMapId, asked_by_run: otherRunId };
    expect(
      constraintOf(() => {
        round({ ...onOther, id: finalOneId, number: 1, final: 1 });
      }),
    ).toBe("SQLITE_CONSTRAINT_CHECK");
    round({ ...onOther, id: otherOneId, number: 1 });
    expect(
      constraintOf(() => {
        round({ ...onOther, id: finalTwoId, number: 2, final: 1 });
      }),
    ).toBeUndefined();
    expect(
      constraintOf(() => {
        round({
          id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fc0ff",
          waypoint_id: waypointId,
          number: 3,
          final: 1,
          asked_by_run: grillRunId,
        });
      }),
    ).toBeUndefined();
  });
});

describe("migration 0035", () => {
  const at = "2026-10-16T12:00:00.000Z";
  const ids = Array.from(
    { length: 8 },
    (_, index) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3fc0${index.toString().padStart(2, "0")}`,
  );
  const [projectId, mapId, chartRunId, grillRunId, openId, grilledId, plainId, fogId] = ids;

  function insert(table: string, row: Record<string, unknown>): void {
    const columns = Object.keys(row);
    db.$client
      .prepare(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(row));
  }

  /** A `0034` database with an open waypoint, one grilled, one by plain choice and a decided fog item. */
  function seedWaypoints(): void {
    const userId = db.$client.prepare("select id from users").pluck().get();
    const ended = { state: "completed", started_at: at, ended_at: at, user_id: userId };
    insert("projects", {
      id: projectId,
      folder_path: "/repo",
      base_branch: "main",
      created_at: at,
      required_checks: "[]",
      fix_commands: "[]",
    });
    insert("maps", {
      id: mapId,
      project_id: projectId,
      idea: "Count lines",
      created_at: at,
      fog_next_position: 1,
      user_id: userId,
    });
    insert("planning_runs", { id: chartRunId, map_id: mapId, purpose: "chart", ...ended });
    const waypoint = {
      map_id: mapId,
      kind: "grilling",
      title: "Flags",
      question: "Which flags?",
      created_by_run: chartRunId,
      person_decides: 0,
    };
    insert("waypoints", { ...waypoint, id: openId, number: 1, status: "open" });
    insert("waypoints", {
      ...waypoint,
      id: grilledId,
      number: 2,
      status: "claimed",
      claimed_at: at,
    });
    insert("planning_runs", {
      id: grillRunId,
      map_id: mapId,
      waypoint_id: grilledId,
      purpose: "grilling",
      ...ended,
    });
    const resolved = { status: "resolved", resolution: "Use -l.", resolved_at: at };
    db.$client
      .prepare(
        "update waypoints set status = 'resolved', resolution = 'Use -l.', gist = '-l', resolved_at = ?, resolved_how = 'run', resolved_by_run = ? where id = ?",
      )
      .run(at, grillRunId, grilledId);
    insert("waypoints", {
      ...waypoint,
      ...resolved,
      id: plainId,
      number: 3,
      gist: "-c",
      resolved_how: "plain_choice",
    });
    insert("waypoints", {
      ...waypoint,
      ...resolved,
      id: fogId,
      number: 4,
      gist: "Count bytes, not characters",
      resolved_how: "run",
      resolved_by_run: chartRunId,
    });
  }

  test("sets agent_decided to none on every resolved waypoint, a decided fog item's too", async () => {
    await migrateUpTo("0034_first_map_round_not_final");
    seedWaypoints();

    expect(migrateDatabase(db, MIGRATIONS_FOLDER)).toEqual({ ok: true, value: undefined });

    expect(
      db
        .select({ id: waypoints.id, agentDecided: waypoints.agentDecided })
        .from(waypoints)
        .orderBy(waypoints.number)
        .all(),
    ).toEqual([
      { id: openId, agentDecided: null },
      { id: grilledId, agentDecided: [] },
      { id: plainId, agentDecided: [] },
      { id: fogId, agentDecided: [] },
    ]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });
});
