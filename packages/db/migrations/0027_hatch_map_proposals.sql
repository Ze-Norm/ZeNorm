-- The escape hatch proposes maps (map proposals). Rebuilds `hatch_messages` so its refusal check
-- admits `exclusion_not_found` and `exclusion_already_split`, and `map_proposals` to add
-- `exclusion_position` (the existing Out of scope line a hatch proposal splits off, referencing
-- `map_exclusions`) and to hold each proposal to exactly one of its own line, a waypoint and that
-- position. Each rebuild copies every column of every row unchanged (`exclusion_position` null:
-- every stored proposal has its own line or a waypoint) and refuses to finish unless the new table
-- has as many rows as the old one. The rebuilds run with foreign keys off (`migrateDatabase`;
-- `hatch_messages` is a parent of `planning_runs`, `waypoints` and `spec_waits`) and the migration
-- ends by refusing any foreign key violation.
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
	CONSTRAINT "hatch_messages_refusal_ck" CHECK("__new_hatch_messages"."refusal" IS NULL OR ("__new_hatch_messages"."reply" IS NOT NULL AND "__new_hatch_messages"."refusal" IN ('spec_in_flight', 'map_uncleared', 'spec_approved', 'ticket_set_approved', 'no_ticket_set', 'waypoint_not_waiting', 'waypoint_state', 'spec_waiting', 'exclusion_not_found', 'exclusion_already_split'))),
	CONSTRAINT "hatch_messages_change_ck" CHECK("__new_hatch_messages"."change" IS NULL OR ("__new_hatch_messages"."reply" IS NOT NULL AND "__new_hatch_messages"."refusal" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_hatch_messages`("id", "map_id", "stage", "specification_id", "text", "sent_at", "run_id", "reply", "refusal", "change", "replied_at")
SELECT "id", "map_id", "stage", "specification_id", "text", "sent_at", "run_id", "reply", "refusal", "change", "replied_at" FROM `hatch_messages`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0027_hatch_messages_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0027_hatch_messages_rows` SELECT (SELECT count(*) FROM `hatch_messages`) - (SELECT count(*) FROM `__new_hatch_messages`);
--> statement-breakpoint
DROP TABLE `zenorm_0027_hatch_messages_rows`;
--> statement-breakpoint
DROP TABLE `hatch_messages`;
--> statement-breakpoint
ALTER TABLE `__new_hatch_messages` RENAME TO `hatch_messages`;
--> statement-breakpoint
CREATE TABLE `__new_map_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`idea` text NOT NULL,
	`line` text,
	`waypoint_id` text,
	`exclusion_position` integer,
	`state` text NOT NULL,
	`new_map_id` text,
	`created_by_run` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`new_map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`created_by_run`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`exclusion_position`) REFERENCES `map_exclusions`(`map_id`,`position`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "map_proposals_state_ck" CHECK("__new_map_proposals"."state" IN ('pending', 'confirmed', 'dismissed')),
	CONSTRAINT "map_proposals_target_ck" CHECK(("__new_map_proposals"."line" IS NOT NULL) + ("__new_map_proposals"."waypoint_id" IS NOT NULL) + ("__new_map_proposals"."exclusion_position" IS NOT NULL) = 1),
	CONSTRAINT "map_proposals_idea_length_ck" CHECK(length("idea") BETWEEN 1 AND 4000),
	CONSTRAINT "map_proposals_line_length_ck" CHECK("line" IS NULL OR length("line") BETWEEN 1 AND 500),
	CONSTRAINT "map_proposals_new_map_ck" CHECK(("__new_map_proposals"."state" = 'confirmed') = ("__new_map_proposals"."new_map_id" IS NOT NULL)),
	CONSTRAINT "map_proposals_decided_ck" CHECK(("__new_map_proposals"."state" = 'pending') = ("__new_map_proposals"."decided_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_map_proposals`("id", "map_id", "idea", "line", "waypoint_id", "exclusion_position", "state", "new_map_id", "created_by_run", "created_at", "decided_at")
SELECT "id", "map_id", "idea", "line", "waypoint_id", NULL, "state", "new_map_id", "created_by_run", "created_at", "decided_at" FROM `map_proposals`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0027_map_proposals_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0027_map_proposals_rows` SELECT (SELECT count(*) FROM `map_proposals`) - (SELECT count(*) FROM `__new_map_proposals`);
--> statement-breakpoint
DROP TABLE `zenorm_0027_map_proposals_rows`;
--> statement-breakpoint
DROP TABLE `map_proposals`;
--> statement-breakpoint
ALTER TABLE `__new_map_proposals` RENAME TO `map_proposals`;
--> statement-breakpoint
CREATE INDEX `map_proposals_map` ON `map_proposals` (`map_id`);
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0027_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0027_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0027_foreign_key_violations`;
