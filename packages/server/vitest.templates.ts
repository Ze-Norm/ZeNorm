import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** A database file every migration has run on, closed: each app test case copies it. */
    migratedDatabase: string;
  }
}

/**
 * Vitest global setup: migrates, once per run, the database each app test case copies (migrating
 * anew was a large part of a case's time), and removes it after the run.
 */
export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "zenorm-server-template-"));
  const database = join(root, "zenorm.sqlite");
  const opened = openDatabase(database);
  if (!opened.ok) throw new Error(opened.error.message);
  const migrated = migrateDatabase(opened.value, MIGRATIONS_FOLDER);
  if (!migrated.ok) throw new Error(migrated.error.message);
  opened.value.$client.close();
  project.provide("migratedDatabase", database);
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
