import { ChangeEntityType, ChangeOp } from "@zenorm/contracts";

import type { ZeNormDatabase } from "./index.ts";

/** The trigger's row: `NEW` after an insert or update, `OLD` after a delete. */
type Row = "NEW" | "OLD";

/** A SQL expression over the trigger's row. */
type Expression = (row: Row) => string;

/**
 * How the change feed names one table's row (slice 9 spec D10): its id (a composite key joined
 * with `:`), its project (never null; `change_feed.project_id` is `NOT NULL`) and its map (null
 * when the row belongs to no map).
 *
 * No foreign key in the schema is `ON DELETE CASCADE` (every one is `NO ACTION`, checked at 0020),
 * so no statement deletes a parent along with its children, and a child's `OLD` row can read its
 * parent: a parent cannot be deleted while a child names it.
 */
export interface FeedEntry {
  readonly id: Expression;
  readonly project: Expression;
  readonly map: Expression | null;
}

/** `a:b:…` over the row's key columns. */
function key(...columns: readonly string[]): Expression {
  return (row) => columns.map((column) => `${row}.${column}`).join(` || ':' || `);
}

function column(name: string): Expression {
  return (row) => `${row}.${name}`;
}

/** The project of the map `map` names. */
function projectOfMap(map: Expression): Expression {
  return (row) => `(SELECT project_id FROM maps WHERE id = ${map(row)})`;
}

/** A row on a map, through its `map_id`. */
const ON_MAP = { project: projectOfMap(column("map_id")), map: column("map_id") };

/** A row on a map through another table: `SELECT map_id FROM <table> WHERE id = <row>.<via>`. */
function onMapVia(table: string, via: string): Omit<FeedEntry, "id"> {
  const map: Expression = (row) => `(SELECT map_id FROM ${table} WHERE id = ${row}.${via})`;
  return { project: projectOfMap(map), map };
}

/** A ticket set's map: the map that wrote its spec revision. */
function ticketSetMap(ticketSetId: string): string {
  return `(SELECT r.map_id FROM ticket_sets s JOIN spec_revisions r ON r.id = s.spec_revision_id WHERE s.id = ${ticketSetId})`;
}

/** A row on a ticket set, through `via` (the ticket set's id). */
function onTicketSet(via: string): Omit<FeedEntry, "id"> {
  const map: Expression = (row) => ticketSetMap(`${row}.${via}`);
  return { project: projectOfMap(map), map };
}

/** A row on a delivery run, through `run_id`: the run's project and its ticket set's map. */
const ON_DELIVERY_RUN: Omit<FeedEntry, "id"> = {
  project: (row) => `(SELECT project_id FROM delivery_runs WHERE id = ${row}.run_id)`,
  map: (row) => ticketSetMap(`(SELECT ticket_set_id FROM delivery_runs WHERE id = ${row}.run_id)`),
};

/** A review finding, through its review's planning run. */
function onReview(reviews: string): Omit<FeedEntry, "id"> {
  const map: Expression = (row) =>
    `(SELECT p.map_id FROM ${reviews} v JOIN planning_runs p ON p.id = v.run_id WHERE v.id = ${row}.review_id)`;
  return { project: projectOfMap(map), map };
}

/**
 * The feed's table map (slice 9 spec D10): one entry per core table. `installChangeFeed` refuses a
 * database with a table this map does not name, or a named table it lacks.
 */
export const FEED_TABLES: Readonly<Record<ChangeEntityType, FeedEntry>> = {
  projects: { id: column("id"), project: column("id"), map: null },
  maps: { id: column("id"), project: column("project_id"), map: column("id") },
  specifications: { id: column("id"), project: column("project_id"), map: null },
  planning_runs: { id: column("id"), ...ON_MAP },
  waypoints: { id: column("id"), ...ON_MAP },
  waypoint_blockers: { id: key("map_id", "waypoint_number", "blocker_number"), ...ON_MAP },
  question_rounds: { id: column("id"), ...ON_MAP },
  hatch_messages: { id: column("id"), ...ON_MAP },
  spec_revisions: { id: column("id"), ...ON_MAP },
  spec_waits: { id: column("id"), ...ON_MAP },
  map_fog: { id: key("map_id", "position"), ...ON_MAP },
  map_exclusions: { id: key("map_id", "position"), ...ON_MAP },
  map_proposals: { id: column("id"), ...ON_MAP },
  code_surveys: { id: column("map_id"), ...ON_MAP },
  consistency_passes: { id: column("id"), ...ON_MAP },
  consistency_findings: {
    id: column("created_waypoint_id"),
    ...onMapVia("consistency_passes", "pass_id"),
  },
  research_reports: { id: column("run_id"), ...onMapVia("planning_runs", "run_id") },
  research_sources: {
    id: key("report_run_id", "position"),
    ...onMapVia("planning_runs", "report_run_id"),
  },
  task_outcomes: { id: column("run_id"), ...onMapVia("planning_runs", "run_id") },
  waypoint_touches: {
    id: key("waypoint_id", "specification_id"),
    ...onMapVia("waypoints", "waypoint_id"),
  },
  spec_reviews: { id: column("id"), ...onMapVia("planning_runs", "run_id") },
  spec_review_findings: { id: key("review_id", "position"), ...onReview("spec_reviews") },
  ticket_sets: { id: column("id"), ...onMapVia("spec_revisions", "spec_revision_id") },
  ticket_set_versions: { id: key("ticket_set_id", "version"), ...onTicketSet("ticket_set_id") },
  // No primary key: its unique `(ticket_set_id, version)` names the row.
  ticket_set_rejections: { id: key("ticket_set_id", "version"), ...onTicketSet("ticket_set_id") },
  tickets_reviews: { id: column("id"), ...onMapVia("planning_runs", "run_id") },
  tickets_review_findings: { id: key("review_id", "position"), ...onReview("tickets_reviews") },
  delivery_runs: {
    id: column("id"),
    project: column("project_id"),
    map: (row) => ticketSetMap(`${row}.ticket_set_id`),
  },
  delivery_run_tickets: { id: key("run_id", "ticket"), ...ON_DELIVERY_RUN },
  delivery_run_events: { id: key("run_id", "seq"), ...ON_DELIVERY_RUN },
};

/**
 * The tables the feed does not record (S9-12): the feed itself, the users, the write's Actor and
 * drizzle's migrations; every `sqlite_%` table is skipped too (AUTOINCREMENT creates `sqlite_sequence`).
 */
export const FEED_EXCLUDED_TABLES: readonly string[] = [
  "change_feed",
  "users",
  "write_actor",
  "zenorm_migrations",
];

/** The tables whose `user_id` the `user_id_missing` triggers hold to non-null (spec D8, S9-11). */
export const USER_ID_TABLES: readonly ChangeEntityType[] = [
  "maps",
  "planning_runs",
  "delivery_runs",
];

/** The `TEMP` trigger that appends the feed row for `op` on `table`. */
export function feedTriggerName(table: ChangeEntityType, op: ChangeOp): string {
  return `change_feed_${table}_${op}`;
}

/**
 * Whether `db`'s connection has every change-feed and `user_id` trigger `installChangeFeed`
 * creates: `TEMP` triggers live per connection, so a database opened without it writes no feed.
 */
export function changeFeedInstalled(db: ZeNormDatabase): boolean {
  const expected = new Set<string>();
  for (const table of ChangeEntityType.options) {
    for (const op of ChangeOp.options) expected.add(feedTriggerName(table, op));
  }
  for (const table of USER_ID_TABLES) {
    expected.add(`user_id_missing_${table}_insert`);
    expected.add(`user_id_missing_${table}_update`);
  }
  const present = new Set(
    db.$client
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_temp_master WHERE type = 'trigger'`)
      .all()
      .map((row) => row.name),
  );
  return [...expected].every((name) => present.has(name));
}

const TRIGGER_EVENT: Readonly<Record<ChangeOp, { readonly event: string; readonly row: Row }>> = {
  insert: { event: "INSERT", row: "NEW" },
  update: { event: "UPDATE", row: "NEW" },
  delete: { event: "DELETE", row: "OLD" },
};

function feedTrigger(table: ChangeEntityType, entry: FeedEntry, op: ChangeOp): string {
  const { event, row } = TRIGGER_EVENT[op];
  const map = entry.map === null ? "NULL" : entry.map(row);
  return `CREATE TEMP TRIGGER \`${feedTriggerName(table, op)}\` AFTER ${event} ON main.\`${table}\` FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'actor_missing') WHERE NOT EXISTS (SELECT 1 FROM write_actor);
  INSERT INTO change_feed (project_id, map_id, entity_type, entity_id, op, actor_kind, actor_user_id, actor_run_id, at)
    SELECT ${entry.project(row)}, ${map}, '${table}', ${entry.id(row)}, '${op}', actor_kind, actor_user_id, actor_run_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM write_actor;
END`;
}

function userIdTriggers(
  table: ChangeEntityType,
): { readonly name: string; readonly sql: string }[] {
  return [
    { name: `user_id_missing_${table}_insert`, event: "INSERT" },
    { name: `user_id_missing_${table}_update`, event: "UPDATE OF user_id" },
  ].map(({ name, event }) => ({
    name,
    sql: `CREATE TEMP TRIGGER \`${name}\` BEFORE ${event} ON main.\`${table}\` FOR EACH ROW WHEN NEW.user_id IS NULL BEGIN
  SELECT RAISE(ABORT, 'user_id_missing');
END`,
  }));
}

/** The core tables in `sqlite_master`: every table but the excluded ones and `sqlite_%`. */
function coreTables(db: ZeNormDatabase): string[] {
  const names = db.$client
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .pluck()
    .all();
  return names
    .map((name) => {
      if (typeof name !== "string") throw new Error("sqlite_master returned a non-text table name");
      return name;
    })
    .filter((name) => !FEED_EXCLUDED_TABLES.includes(name));
}

/**
 * Installs the change feed on a migrated database (slice 9 spec D10, S9-12): drops and creates, as
 * `TEMP` triggers on this connection, each core table's `AFTER INSERT`, `AFTER UPDATE` and
 * `AFTER DELETE` feed triggers and the `user_id_missing` refusals of D8. A trigger raises
 * `actor_missing` when `write_actor` is empty (a write outside core's `write`). Migrations never
 * fire them: they are installed after migrating, on every open. A core table without a
 * `FEED_TABLES` entry, or an entry without its table, is a programmer error, and throws.
 */
export function installChangeFeed(db: ZeNormDatabase): void {
  const tables = coreTables(db);
  const unmapped = tables.filter((table) => !ChangeEntityType.safeParse(table).success);
  if (unmapped.length > 0) {
    throw new Error(`The change feed has no entry for the table(s) ${unmapped.join(", ")}`);
  }
  const missing = ChangeEntityType.options.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new Error(`The change feed names table(s) the database lacks: ${missing.join(", ")}`);
  }
  const client = db.$client;
  client.transaction(() => {
    for (const table of ChangeEntityType.options) {
      for (const op of ChangeOp.options) {
        client.prepare(`DROP TRIGGER IF EXISTS temp.\`${feedTriggerName(table, op)}\``).run();
        client.prepare(feedTrigger(table, FEED_TABLES[table], op)).run();
      }
    }
    for (const table of USER_ID_TABLES) {
      for (const trigger of userIdTriggers(table)) {
        client.prepare(`DROP TRIGGER IF EXISTS temp.\`${trigger.name}\``).run();
        client.prepare(trigger.sql).run();
      }
    }
  })();
}

/**
 * The change feed's ends (CR9b-17): `newest` is the highest `seq` ever issued, kept in
 * `sqlite_sequence` (`seq` is AUTOINCREMENT, so a pruned id is never issued again), 0 before the
 * first row; `prunedThrough` is the highest `seq` no longer kept: every row at or below it is gone,
 * every row above it is kept. The feed only ever loses its oldest rows, so it is the kept oldest
 * row's `seq` less one, or `newest` when no row is kept.
 */
export interface ChangeFeedEnds {
  readonly newest: number;
  readonly prunedThrough: number;
}

function integerOrNull(value: unknown, what: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${what} is not an integer`);
  }
  return value;
}

export function changeFeedEnds(db: ZeNormDatabase): ChangeFeedEnds {
  const client = db.$client;
  const issued: unknown = client
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_feed'")
    .pluck()
    .get();
  // No `sqlite_sequence` row: the feed has never had a row, so no id has been issued.
  const newest =
    issued === undefined ? 0 : integerOrNull(issued, "sqlite_sequence.seq of change_feed");
  if (newest === null) throw new Error("sqlite_sequence holds a null seq for change_feed");
  const oldest = integerOrNull(
    client.prepare("SELECT min(seq) FROM change_feed").pluck().get(),
    "min(seq) over change_feed",
  );
  return { newest, prunedThrough: oldest === null ? newest : oldest - 1 };
}

/**
 * Deletes the feed rows no open stream needs (CR9b-17): every row at or below `through`, or every
 * row when `through` is `"all"`. The feed has no triggers, so this is no write and needs no Actor.
 */
export function pruneChangeFeed(db: ZeNormDatabase, through: number | "all"): void {
  if (through === "all") {
    db.$client.prepare("DELETE FROM change_feed").run();
  } else {
    db.$client.prepare("DELETE FROM change_feed WHERE seq <= ?").run(through);
  }
}
