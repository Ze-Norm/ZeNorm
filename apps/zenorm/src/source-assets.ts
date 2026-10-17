import { SKILLS_DIR } from "@zenorm/agent";
import { MIGRATIONS_FOLDER } from "@zenorm/db";

/**
 * The repository's skills and migrations folders, which the entries that run from source
 * (`main.ts`, `apps/zenorm-example`) pass in beside their web build (1.3). The built `zenorm`
 * command never imports this module: it passes the copies inside its package.
 */
export const SOURCE_ASSETS = {
  skillsDir: SKILLS_DIR,
  migrationsFolder: MIGRATIONS_FOLDER,
} as const;
