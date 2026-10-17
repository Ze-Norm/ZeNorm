import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The templates `test-support.ts` copies for each case. */
    coreTemplates: {
      /** A database file every migration has run on, closed. */
      readonly database: string;
      /** A repository on `main` with one commit holding a README. */
      readonly repository: string;
    };
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/**
 * Vitest global setup: makes, once per run, the migrated database and the committed repository
 * each case copies (migrating and committing anew were most of a case's time), and removes them
 * after the run.
 */
export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "zenorm-core-templates-"));
  const database = join(root, "zenorm.sqlite");
  const opened = openDatabase(database);
  if (!opened.ok) throw new Error(opened.error.message);
  const migrated = migrateDatabase(opened.value, MIGRATIONS_FOLDER);
  if (!migrated.ok) throw new Error(migrated.error.message);
  opened.value.$client.close();
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repository, "README.md"), "# Repo\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-q", "-m", "init"]);
  project.provide("coreTemplates", { database, repository });
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
