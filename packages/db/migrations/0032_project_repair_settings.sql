-- Delivery repairs failing checks. Adds `projects.repair_limit`, null on every existing
-- project: there is no default limit, and Start delivery is blocked until a person saves one.
-- Adds `projects.fix_commands`, `[]` on every existing project by the column's SQL DEFAULT, which
-- only backfills: core writes the value on every new project and `schema.ts` declares no default,
-- as `required_checks` does (0010). SQLite cannot drop a column default, so every database keeps
-- this one although `0032_snapshot.json` shows none.
ALTER TABLE `projects` ADD `repair_limit` integer;
--> statement-breakpoint
ALTER TABLE `projects` ADD `fix_commands` text DEFAULT '[]' NOT NULL;
