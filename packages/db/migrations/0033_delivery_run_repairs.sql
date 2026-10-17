-- Delivery repairs failing checks. A run pins its project's repair limit and fix commands at
-- its start and counts its repair attempts. Adds `delivery_runs.repair_limit` and
-- `delivery_runs.repair_attempts`, null on every existing run: a run from before has no pinned
-- limit and no attempt count, and reads as before. Adds `delivery_runs.fix_commands`, `[]` on
-- every existing run by the column's SQL DEFAULT, which only backfills: core writes the value on
-- every new run and `schema.ts` declares no default, as `projects.fix_commands` (0032). SQLite
-- cannot drop a column default, so every database keeps this one although `0033_snapshot.json`
-- shows none.
ALTER TABLE `delivery_runs` ADD `repair_limit` integer;
--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `repair_attempts` integer;
--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `fix_commands` text DEFAULT '[]' NOT NULL;
