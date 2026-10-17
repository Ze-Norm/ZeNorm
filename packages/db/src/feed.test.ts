import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChangeEntityType, ChangeOp } from "@zenorm/contracts";
import { SqliteError } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  changeFeedEnds,
  FEED_EXCLUDED_TABLES,
  feedTriggerName,
  installChangeFeed,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
  pruneChangeFeed,
  USER_ID_TABLES,
} from "./index.ts";
import type { ZeNormDatabase } from "./index.ts";

let dir: string;
let db: ZeNormDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zenorm-feed-"));
  const opened = openDatabase(join(dir, "zenorm.sqlite"));
  if (!opened.ok) throw new Error(opened.error.message);
  db = opened.value;
  const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
  if (!migrated.ok) throw new Error(migrated.error.message);
});

afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const at = "2026-10-11T12:00:00.000Z";
const projectId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a01";
const mapId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a11";
const runId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f6a21";

function strings(rows: unknown[]): string[] {
  return rows.map((row) => {
    if (typeof row !== "string") throw new Error("expected a text value");
    return row;
  });
}

function userId(): string {
  const [id] = strings(db.$client.prepare("select id from users").pluck().all());
  if (id === undefined) throw new Error("the migration created no user");
  return id;
}

/** The SQLite error `run` fails with; a run that does not fail is a broken test. */
function failure(run: () => unknown): InstanceType<typeof SqliteError> {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof SqliteError) return error;
    throw error;
  }
  throw new Error("expected the statement to fail");
}

function setActor(kind: string, user: string | null, run: string | null): void {
  db.$client
    .prepare(
      "insert into write_actor (id, actor_kind, actor_user_id, actor_run_id) values (1, ?, ?, ?)",
    )
    .run(kind, user, run);
}

function insertProject(): void {
  db.$client
    .prepare(
      "insert into projects (id, folder_path, base_branch, created_at, required_checks) values (?, '/repo', 'main', ?, '[]')",
    )
    .run(projectId, at);
}

function insertMap(user: string | null): void {
  db.$client
    .prepare(
      "insert into maps (id, project_id, idea, created_at, fog_next_position, user_id) values (?, ?, 'An idea', ?, 1, ?)",
    )
    .run(mapId, projectId, at, user);
}

function feed(): unknown[] {
  return db.$client
    .prepare(
      "select seq, project_id, map_id, entity_type, entity_id, op, actor_kind, actor_user_id, actor_run_id from change_feed order by seq",
    )
    .all();
}

describe("installChangeFeed (S9-12, spec D10)", () => {
  test("gives every core table in sqlite_master its three TEMP feed triggers, and the user_id refusals", () => {
    installChangeFeed(db);
    // Installing again drops and recreates them: one of each still.
    installChangeFeed(db);

    const tables = strings(
      db.$client
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .pluck()
        .all(),
    ).filter((name) => !name.startsWith("sqlite_") && !FEED_EXCLUDED_TABLES.includes(name));
    expect(tables).toEqual([...ChangeEntityType.options].sort());
    // TEMP triggers are recorded in the temp schema, not in `sqlite_master`.
    const triggers = db.$client
      .prepare("select name, tbl_name from sqlite_temp_master where type = 'trigger' order by name")
      .all();
    const expected = [
      ...tables.flatMap((table) =>
        ChangeOp.options.map((op) => ({
          name: feedTriggerName(ChangeEntityType.parse(table), op),
          tbl_name: table,
        })),
      ),
      ...USER_ID_TABLES.flatMap((table) =>
        ["insert", "update"].map((event) => ({
          name: `user_id_missing_${table}_${event}`,
          tbl_name: table,
        })),
      ),
    ].sort((a, b) => a.name.localeCompare(b.name));
    expect(triggers).toEqual(expected);
    // Nothing reached the migrated schema.
    expect(
      db.$client.prepare("select count(*) from sqlite_master where type = 'trigger'").pluck().get(),
    ).toBe(0);
  });

  test("throws on a table the feed map has no entry for", () => {
    db.$client.exec("create table unrecorded (id text primary key)");
    expect(() => {
      installChangeFeed(db);
    }).toThrow(Error);
  });

  test("a write with no actor aborts with actor_missing and leaves nothing behind", () => {
    installChangeFeed(db);

    const error = failure(insertProject);
    expect(error.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
    // RAISE's message is the code.
    expect(error.message).toBe("actor_missing");
    expect(db.$client.prepare("select count(*) from projects").pluck().get()).toBe(0);
    expect(feed()).toEqual([]);
  });

  test("appends one row per insert, update and delete on projects and maps, naming the project, the map and the Actor", () => {
    installChangeFeed(db);
    const user = userId();
    setActor("planning_run", user, runId);
    insertProject();
    insertMap(user);
    db.$client.prepare("update maps set title = 'Lines' where id = ?").run(mapId);
    db.$client.prepare("delete from maps where id = ?").run(mapId);
    db.$client.prepare("delete from write_actor").run();

    const row = (seq: number, table: string, id: string, map: string | null, op: string) => ({
      seq,
      project_id: projectId,
      map_id: map,
      entity_type: table,
      entity_id: id,
      op,
      actor_kind: "planning_run",
      actor_user_id: user,
      actor_run_id: runId,
    });
    expect(feed()).toEqual([
      row(1, "projects", projectId, null, "insert"),
      row(2, "maps", mapId, mapId, "insert"),
      row(3, "maps", mapId, mapId, "update"),
      row(4, "maps", mapId, mapId, "delete"),
    ]);
  });

  test("refuses a null user_id on insert and on update with user_id_missing (spec D8)", () => {
    installChangeFeed(db);
    setActor("system", null, null);
    insertProject();

    const inserted = failure(() => {
      insertMap(null);
    });
    expect(inserted.message).toBe("user_id_missing");
    insertMap(userId());
    const updated = failure(() =>
      db.$client.prepare("update maps set user_id = null where id = ?").run(mapId),
    );
    expect(updated.message).toBe("user_id_missing");
    const run = failure(() =>
      db.$client
        .prepare(
          "insert into planning_runs (id, map_id, purpose, state, started_at) values (?, ?, 'chart', 'running', ?)",
        )
        .run(runId, mapId, at),
    );
    expect(run.message).toBe("user_id_missing");
  });
});

describe("changeFeedEnds and pruneChangeFeed (CR9b-17)", () => {
  function seqs(): unknown[] {
    return db.$client.prepare("select seq from change_feed order by seq").pluck().all();
  }

  test("a feed that has never had a row has issued nothing and pruned nothing", () => {
    expect(changeFeedEnds(db)).toEqual({ newest: 0, prunedThrough: 0 });
  });

  test("prunes the rows at or below an id, or all, and never issues a pruned id again", () => {
    installChangeFeed(db);
    setActor("system", null, null);
    insertProject();
    insertMap(userId());
    for (let update = 0; update < 3; update += 1) {
      db.$client
        .prepare("update maps set idea = ? where id = ?")
        .run(`Idea ${String(update)}`, mapId);
    }
    expect(seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(changeFeedEnds(db)).toEqual({ newest: 5, prunedThrough: 0 });

    pruneChangeFeed(db, 2);
    expect(seqs()).toEqual([3, 4, 5]);
    expect(changeFeedEnds(db)).toEqual({ newest: 5, prunedThrough: 2 });

    pruneChangeFeed(db, "all");
    expect(seqs()).toEqual([]);
    expect(changeFeedEnds(db)).toEqual({ newest: 5, prunedThrough: 5 });

    // AUTOINCREMENT: the next row's id is past every id issued, pruned or kept.
    db.$client.prepare("update maps set idea = 'Again' where id = ?").run(mapId);
    expect(seqs()).toEqual([6]);
    expect(changeFeedEnds(db)).toEqual({ newest: 6, prunedThrough: 5 });
  });
});
