-- Map proposals gain a kind (idea-phase split): `split` for a first chart's offer to split an idea
-- too big for one map, made before the destination is confirmed, and `outside` for work a run found
-- outside the confirmed destination. Every proposal stored before this migration is `outside`: the
-- first chart could not propose until now. The rebuild copies every other column unchanged and
-- refuses to finish unless the new table has as many rows as the old one. It runs with foreign keys
-- off (`migrateDatabase`) and ends by refusing any foreign key violation.
CREATE TABLE `__new_map_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
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
	CONSTRAINT "map_proposals_kind_ck" CHECK("__new_map_proposals"."kind" IN ('split', 'outside')),
	CONSTRAINT "map_proposals_state_ck" CHECK("__new_map_proposals"."state" IN ('pending', 'confirmed', 'dismissed')),
	CONSTRAINT "map_proposals_target_ck" CHECK(("__new_map_proposals"."line" IS NOT NULL) + ("__new_map_proposals"."waypoint_id" IS NOT NULL) + ("__new_map_proposals"."exclusion_position" IS NOT NULL) = 1),
	CONSTRAINT "map_proposals_title_length_ck" CHECK(length("title") BETWEEN 1 AND 120),
	CONSTRAINT "map_proposals_idea_length_ck" CHECK(length("idea") BETWEEN 1 AND 4000),
	CONSTRAINT "map_proposals_line_length_ck" CHECK("line" IS NULL OR length("line") BETWEEN 1 AND 500),
	CONSTRAINT "map_proposals_new_map_ck" CHECK(("__new_map_proposals"."state" = 'confirmed') = ("__new_map_proposals"."new_map_id" IS NOT NULL)),
	CONSTRAINT "map_proposals_decided_ck" CHECK(("__new_map_proposals"."state" = 'pending') = ("__new_map_proposals"."decided_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_map_proposals`("id", "map_id", "kind", "title", "idea", "line", "waypoint_id", "exclusion_position", "state", "new_map_id", "created_by_run", "created_at", "decided_at")
SELECT "id", "map_id", 'outside', "title", "idea", "line", "waypoint_id", "exclusion_position", "state", "new_map_id", "created_by_run", "created_at", "decided_at" FROM `map_proposals`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0029_map_proposals_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0029_map_proposals_rows` SELECT (SELECT count(*) FROM `map_proposals`) - (SELECT count(*) FROM `__new_map_proposals`);
--> statement-breakpoint
DROP TABLE `zenorm_0029_map_proposals_rows`;
--> statement-breakpoint
DROP TABLE `map_proposals`;
--> statement-breakpoint
ALTER TABLE `__new_map_proposals` RENAME TO `map_proposals`;
--> statement-breakpoint
CREATE INDEX `map_proposals_map` ON `map_proposals` (`map_id`);
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0029_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0029_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0029_foreign_key_violations`;
