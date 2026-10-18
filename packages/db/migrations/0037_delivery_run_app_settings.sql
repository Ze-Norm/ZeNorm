-- Screenshots of changed screens. A run pins its project's app settings at its start. Adds
-- `delivery_runs.app_start_command` and `delivery_runs.app_url`, null on every existing run, so the
-- runs before this one publish with capture off. Adds `delivery_runs.app_setup_commands`, `[]` on
-- every existing run by the column's SQL DEFAULT, which only backfills: core writes the value on
-- every new run and `schema.ts` declares no default, as `fix_commands` does (0033). SQLite cannot
-- drop a column default, so every database keeps this one although `0037_snapshot.json` shows none.
ALTER TABLE `delivery_runs` ADD `app_start_command` text;
--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `app_url` text;
--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `app_setup_commands` text DEFAULT '[]' NOT NULL;
