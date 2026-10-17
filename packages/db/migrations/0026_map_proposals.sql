CREATE TABLE `map_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`idea` text NOT NULL,
	`line` text,
	`waypoint_id` text,
	`state` text NOT NULL,
	`new_map_id` text,
	`created_by_run` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`new_map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`created_by_run`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "map_proposals_state_ck" CHECK("map_proposals"."state" IN ('pending', 'confirmed', 'dismissed')),
	CONSTRAINT "map_proposals_idea_length_ck" CHECK(length("idea") BETWEEN 1 AND 4000),
	CONSTRAINT "map_proposals_line_length_ck" CHECK("line" IS NULL OR length("line") BETWEEN 1 AND 500),
	CONSTRAINT "map_proposals_new_map_ck" CHECK(("map_proposals"."state" = 'confirmed') = ("map_proposals"."new_map_id" IS NOT NULL)),
	CONSTRAINT "map_proposals_decided_ck" CHECK(("map_proposals"."state" = 'pending') = ("map_proposals"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `map_proposals_map` ON `map_proposals` (`map_id`);--> statement-breakpoint
ALTER TABLE `map_exclusions` ADD `split_map_id` text REFERENCES maps(id);--> statement-breakpoint
ALTER TABLE `maps` ADD `split_from_map_id` text REFERENCES maps(id);--> statement-breakpoint
ALTER TABLE `maps` ADD `split_from_run_id` text REFERENCES planning_runs(id);
