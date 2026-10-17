-- Planning salience: rebuilds `waypoints` with `person_decides` (not null, no default): true exactly
-- when a planning review finding routed `decision` opened or linked the waypoint, so only the person
-- can settle it and its grilling resolves only after a round is asked. Every row is copied; the
-- backfill sets it from the stored findings (`spec_review_findings` escalated with route `decision`
-- naming the waypoint), false for every other waypoint. The rebuild runs with foreign keys off
-- (`migrateDatabase`) and ends by refusing any foreign key violation.
CREATE TABLE `__new_waypoints` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`question` text NOT NULL,
	`claimed_at` text,
	`resolution` text,
	`gist` text,
	`resolved_at` text,
	`resolved_how` text,
	`resolved_by_run` text,
	`created_by_run` text NOT NULL,
	`hatch_message_id` text,
	`person_decides` integer NOT NULL,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hatch_message_id`) REFERENCES `hatch_messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "waypoints_kind_ck" CHECK("__new_waypoints"."kind" IN ('grilling', 'research', 'task')),
	CONSTRAINT "waypoints_status_ck" CHECK("__new_waypoints"."status" IN ('open', 'claimed', 'resolved', 'out_of_scope')),
	CONSTRAINT "waypoints_resolved_how_ck" CHECK("__new_waypoints"."resolved_how" IS NULL OR "__new_waypoints"."resolved_how" IN ('run', 'plain_choice')),
	CONSTRAINT "waypoints_resolution_ck" CHECK(("__new_waypoints"."status" = 'resolved') = ("__new_waypoints"."resolution" IS NOT NULL) AND ("__new_waypoints"."status" = 'resolved') = ("__new_waypoints"."gist" IS NOT NULL) AND ("__new_waypoints"."status" = 'resolved') = ("__new_waypoints"."resolved_at" IS NOT NULL) AND ("__new_waypoints"."status" = 'resolved') = ("__new_waypoints"."resolved_how" IS NOT NULL)),
	CONSTRAINT "waypoints_gist_length_ck" CHECK("gist" IS NULL OR length("gist") <= 200),
	CONSTRAINT "waypoints_resolved_by_run_ck" CHECK(("__new_waypoints"."resolved_by_run" IS NOT NULL) = ("__new_waypoints"."resolved_how" IS NOT NULL AND "__new_waypoints"."resolved_how" = 'run'))
);
--> statement-breakpoint
INSERT INTO `__new_waypoints`("id", "map_id", "number", "kind", "status", "title", "question", "claimed_at", "resolution", "gist", "resolved_at", "resolved_how", "resolved_by_run", "created_by_run", "hatch_message_id", "person_decides")
SELECT "id", "map_id", "number", "kind", "status", "title", "question", "claimed_at", "resolution", "gist", "resolved_at", "resolved_how", "resolved_by_run", "created_by_run", "hatch_message_id",
	EXISTS (SELECT 1 FROM `spec_review_findings` WHERE `spec_review_findings`.`waypoint_id` = `waypoints`.`id` AND `spec_review_findings`.`escalated` = 1 AND `spec_review_findings`.`route` = 'decision')
FROM `waypoints`;
--> statement-breakpoint
DROP TABLE `waypoints`;--> statement-breakpoint
ALTER TABLE `__new_waypoints` RENAME TO `waypoints`;--> statement-breakpoint
CREATE UNIQUE INDEX `waypoints_map_number_uq` ON `waypoints` (`map_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `waypoints_map_id_uq` ON `waypoints` (`map_id`,`id`);--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0013_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0013_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0013_foreign_key_violations`;
