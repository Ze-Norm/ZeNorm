import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { err, ok } from "@zenorm/contracts";
import type { CodedError, Result } from "@zenorm/contracts";
import Database, { SqliteError } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import * as schema from "./schema.ts";

export {
  FEED_EXCLUDED_TABLES,
  changeFeedEnds,
  changeFeedInstalled,
  FEED_TABLES,
  feedTriggerName,
  installChangeFeed,
  pruneChangeFeed,
  USER_ID_TABLES,
} from "./feed.ts";
export type { ChangeFeedEnds, FeedEntry } from "./feed.ts";
export {
  changeFeed,
  consistencyFindings,
  codeSurveys,
  consistencyPasses,
  deliveryRunEvents,
  deliveryRuns,
  deliveryRunTickets,
  hatchMessages,
  mapExclusions,
  mapFog,
  mapProposals,
  maps,
  planningRuns,
  projects,
  questionRounds,
  researchReports,
  researchSources,
  specifications,
  specReviewFindings,
  specReviews,
  specRevisions,
  specWaits,
  taskOutcomes,
  ticketSetRejections,
  ticketSets,
  ticketSetVersions,
  ticketsReviewFindings,
  ticketsReviews,
  waypointBlockers,
  waypointTouches,
  users,
  waypoints,
  writeActor,
} from "./schema.ts";

export type ZeNormDatabase = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

/** Drizzle's record of applied migrations. */
const MIGRATIONS_TABLE = "zenorm_migrations";
/**
 * The repository's migrations folder, `packages/db/migrations`, found from this module. Only the
 * entries that run from source and tests pass it to `migrateDatabase`; the built CLI passes its
 * packaged copy.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** A database file SQLite cannot open; assignable to `StartupError`. `subject` is the file path. */
export type DatabaseOpenError = CodedError<"database_open_failed"> & { readonly subject: string };

/**
 * Opens (creating if absent) the SQLite file with WAL and foreign keys on. SQLite refusing the
 * file (a directory, not a database, not writable) is `database_open_failed`.
 */
export function openDatabase(filePath: string): Result<ZeNormDatabase, DatabaseOpenError> {
  let client: Database.Database | undefined;
  try {
    client = new Database(filePath);
    client.pragma("journal_mode = WAL");
    client.pragma("foreign_keys = ON");
  } catch (error: unknown) {
    client?.close();
    if (!(error instanceof SqliteError)) {
      throw error;
    }
    return err({ code: "database_open_failed", message: error.message, subject: filePath });
  }
  return ok(drizzle({ client, schema }));
}

/**
 * The file beside the database whose lock marks the data folder as in use by one running ZeNorm.
 */
export const INSTANCE_LOCK_FILE = "zenorm.lock";

/**
 * Another ZeNorm holds the data folder; assignable to `StartupError`. `subject` is the lock file.
 */
export type DataDirInUseError = CodedError<"data_dir_in_use"> & { readonly subject: string };

/**
 * Claims the data folder for `db`'s connection: attaches `lockPath` (creating it) in SQLite's
 * exclusive locking mode and writes to it, so the connection holds its lock until it closes, and
 * the operating system frees it when the process dies, however it dies. Another connection
 * already holding it, in any process, is `data_dir_in_use` at once, with no busy wait. Any other
 * SQLite refusal of the file is `database_open_failed`. Readers of the database itself, such as
 * `checkDatabaseFile`, are not blocked.
 */
export function claimInstanceLock(
  db: ZeNormDatabase,
  lockPath: string,
): Result<void, DataDirInUseError | DatabaseOpenError> {
  const client = db.$client;
  const busyTimeout: unknown = client.pragma("busy_timeout", { simple: true });
  if (typeof busyTimeout !== "number") {
    throw new Error(`PRAGMA busy_timeout read ${String(busyTimeout)}`);
  }
  client.pragma("busy_timeout = 0");
  try {
    client.prepare("ATTACH DATABASE ? AS instance_lock").run(lockPath);
    client.pragma("instance_lock.locking_mode = EXCLUSIVE");
    client.exec(
      "BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS instance_lock.held (pid INTEGER); COMMIT;",
    );
  } catch (error: unknown) {
    if (!(error instanceof SqliteError)) {
      throw error;
    }
    if (client.inTransaction) client.exec("ROLLBACK");
    if (error.code === "SQLITE_BUSY") {
      return err({
        code: "data_dir_in_use",
        message: `Another ZeNorm is running on this data folder (${lockPath} is locked). Stop it first, or give this one its own dataDir`,
        subject: lockPath,
      });
    }
    return err({ code: "database_open_failed", message: error.message, subject: lockPath });
  } finally {
    client.pragma(`busy_timeout = ${String(busyTimeout)}`);
  }
  return ok(undefined);
}

/** A failed migration; assignable to `StartupError`. `subject` is the database file path. */
export type MigrationError = CodedError<"migration_failed"> & { readonly subject: string };

/**
 * A database holding an applied migration this build does not ship; assignable to `StartupError`.
 * `subject` is the database file path.
 */
export type DatabaseNewerError = CodedError<"database_newer_than_build"> & {
  readonly subject: string;
};

/** The `created_at` of each row of `zenorm_migrations`; none before the first migration. */
function appliedMigrationTimes(client: Database.Database): number[] {
  const table = client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (table === undefined) return [];
  return client
    .prepare(`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at`)
    .pluck()
    .all()
    .map((createdAt) => Number(createdAt));
}

/**
 * Refuses a database holding an applied migration that `migrationsFolder`'s journal does not ship:
 * a newer build migrated it, and this build would misread its schema. A row is matched by its
 * `created_at`, the journal's `when` that Drizzle's migrator records and applies by. It only reads,
 * so it runs on a read-only connection too. A journal that cannot be read is `migration_failed`.
 */
function refuseNewerDatabase(
  client: Database.Database,
  migrationsFolder: string,
): Result<void, MigrationError | DatabaseNewerError> {
  let shipped: Set<number>;
  try {
    shipped = new Set(readMigrationFiles({ migrationsFolder }).map((entry) => entry.folderMillis));
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return err({ code: "migration_failed", message: error.message, subject: client.name });
  }
  const unshipped = appliedMigrationTimes(client).filter((when) => !shipped.has(when));
  if (unshipped.length === 0) {
    return ok(undefined);
  }
  return err({
    code: "database_newer_than_build",
    message: `${client.name} holds ${String(unshipped.length)} applied migration(s) this build of ZeNorm does not ship, so a newer ZeNorm wrote it. Run that version or a later one; this build leaves the database as it is`,
    subject: client.name,
  });
}

/**
 * Applies every pending migration in `migrationsFolder` (Drizzle's folder: the SQL files and
 * `meta/_journal.json`) in one transaction. Applying again is a no-op. A database holding a
 * migration the folder does not ship is refused `database_newer_than_build` before anything is
 * applied or written. Foreign keys are off while it runs, as SQLite's table rebuild requires
 * (`PRAGMA foreign_keys` is a no-op inside the migrator's transaction, so a rebuilt table's `DROP`
 * would trip its children's keys); keys are back on after. Nothing here checks the keys afterwards: the migrator has committed by then, so a check
 * could roll nothing back. So every migration that rebuilds a table (from `0008`) ends by refusing
 * any foreign key violation itself, with a `zenorm_<number>_foreign_key_violations` guard; a `db`
 * test holds every such migration to that.
 */
export function migrateDatabase(
  db: ZeNormDatabase,
  migrationsFolder: string,
): Result<void, MigrationError | DatabaseNewerError> {
  const newer = refuseNewerDatabase(db.$client, migrationsFolder);
  if (!newer.ok) {
    return newer;
  }
  db.$client.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return err({ code: "migration_failed", message: error.message, subject: db.$client.name });
  } finally {
    db.$client.pragma("foreign_keys = ON");
  }
  return ok(undefined);
}

/** What `checkDatabaseFile` found: no file yet (`zenorm run` creates it), or one it can run. */
export type DatabaseFileState = "absent" | "current";

/**
 * `zenorm doctor`'s database check: opens `filePath` read-only and refuses it as `migrateDatabase`
 * would (`database_newer_than_build`, or `migration_failed` for an unreadable journal), applying
 * and writing nothing. A file SQLite cannot read is `database_open_failed`.
 */
export function checkDatabaseFile(
  filePath: string,
  migrationsFolder: string,
): Result<DatabaseFileState, DatabaseOpenError | MigrationError | DatabaseNewerError> {
  if (!existsSync(filePath)) {
    return ok("absent");
  }
  let client: Database.Database | undefined;
  try {
    client = new Database(filePath, { readonly: true, fileMustExist: true });
    const newer = refuseNewerDatabase(client, migrationsFolder);
    return newer.ok ? ok("current") : newer;
  } catch (error: unknown) {
    if (!(error instanceof SqliteError)) {
      throw error;
    }
    return err({ code: "database_open_failed", message: error.message, subject: filePath });
  } finally {
    client?.close();
  }
}

/**
 * True when a query failed on a SQLite UNIQUE constraint. Drizzle 0.45's better-sqlite3 session
 * rethrows the driver's `SqliteError` unwrapped.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof SqliteError && error.code === "SQLITE_CONSTRAINT_UNIQUE";
}
