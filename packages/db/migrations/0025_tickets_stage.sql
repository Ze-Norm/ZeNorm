-- The fourth stage is renamed Tickets (decisions ledger, October 12, 2026): the stage id
-- `implementation` becomes `tickets`. Rebuilds `hatch_messages` so its stage check admits
-- `tickets` in place of `implementation`, rewriting each stored `implementation` stage to `tickets`
-- inside the copy (the old table's own check refuses `tickets`, so it is never updated in place);
-- every other column of every row is copied unchanged, and the rebuild refuses to finish unless
-- the new table has as many rows as the old one. The rebuild runs with foreign keys off
-- (`migrateDatabase`; `hatch_messages` is a parent of `planning_runs`, `waypoints` and
-- `spec_waits`) and the migration ends by refusing any foreign key violation (L163).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hatch_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`stage` text NOT NULL,
	`specification_id` text,
	`text` text NOT NULL,
	`sent_at` text NOT NULL,
	`run_id` text,
	`reply` text,
	`refusal` text,
	`change` text,
	`replied_at` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hatch_messages_stage_ck" CHECK("__new_hatch_messages"."stage" IN ('idea', 'wayfinding', 'spec', 'tickets')),
	CONSTRAINT "hatch_messages_specification_stage_ck" CHECK("__new_hatch_messages"."specification_id" IS NULL OR "__new_hatch_messages"."stage" NOT IN ('idea', 'wayfinding')),
	CONSTRAINT "hatch_messages_text_length_ck" CHECK(length("text") BETWEEN 1 AND 4000),
	CONSTRAINT "hatch_messages_reply_length_ck" CHECK("reply" IS NULL OR length("reply") BETWEEN 1 AND 2000),
	CONSTRAINT "hatch_messages_replied_ck" CHECK(("__new_hatch_messages"."reply" IS NULL) = ("__new_hatch_messages"."replied_at" IS NULL) AND ("__new_hatch_messages"."reply" IS NULL) = ("__new_hatch_messages"."run_id" IS NULL)),
	CONSTRAINT "hatch_messages_refusal_ck" CHECK("__new_hatch_messages"."refusal" IS NULL OR ("__new_hatch_messages"."reply" IS NOT NULL AND "__new_hatch_messages"."refusal" IN ('spec_in_flight', 'map_uncleared', 'spec_approved', 'ticket_set_approved', 'no_ticket_set', 'waypoint_not_waiting', 'waypoint_state', 'spec_waiting'))),
	CONSTRAINT "hatch_messages_change_ck" CHECK("__new_hatch_messages"."change" IS NULL OR ("__new_hatch_messages"."reply" IS NOT NULL AND "__new_hatch_messages"."refusal" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_hatch_messages`("id", "map_id", "stage", "specification_id", "text", "sent_at", "run_id", "reply", "refusal", "change", "replied_at")
SELECT "id", "map_id", CASE "stage" WHEN 'implementation' THEN 'tickets' ELSE "stage" END, "specification_id", "text", "sent_at", "run_id", "reply", "refusal", "change", "replied_at" FROM `hatch_messages`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0025_hatch_messages_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0025_hatch_messages_rows` SELECT (SELECT count(*) FROM `hatch_messages`) - (SELECT count(*) FROM `__new_hatch_messages`);
--> statement-breakpoint
DROP TABLE `zenorm_0025_hatch_messages_rows`;
--> statement-breakpoint
DROP TABLE `hatch_messages`;--> statement-breakpoint
ALTER TABLE `__new_hatch_messages` RENAME TO `hatch_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0025_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0025_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0025_foreign_key_violations`;
