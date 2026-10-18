-- Screenshots of changed screens. Adds `projects.app_start_command` and `projects.app_url`, null on
-- every existing project, so screenshots stay off until a person saves both. Adds
-- `projects.app_setup_commands`, `[]` on every existing project by the column's SQL DEFAULT, which
-- only backfills: core writes the value on every new project and `schema.ts` declares no default,
-- as `fix_commands` does (0032). SQLite cannot drop a column default, so every database keeps this
-- one although `0036_snapshot.json` shows none.
ALTER TABLE `projects` ADD `app_start_command` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `app_url` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `app_setup_commands` text DEFAULT '[]' NOT NULL;
