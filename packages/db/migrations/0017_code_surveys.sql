CREATE TABLE `code_surveys` (
	`map_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`run_id`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_surveys_run_uq` ON `code_surveys` (`run_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_planning_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`waypoint_id` text,
	`specification_id` text,
	`purpose` text NOT NULL,
	`state` text NOT NULL,
	`retry_of_run_id` text,
	`error_code` text,
	`error_message` text,
	`cancel_reason` text,
	`hatch_message_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`session_id` text,
	`result_subtype` text,
	`num_turns` integer,
	`duration_ms` integer,
	`total_cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retry_of_run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hatch_message_id`) REFERENCES `hatch_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "planning_runs_purpose_ck" CHECK("__new_planning_runs"."purpose" IN ('chart', 'survey', 'grilling', 'research', 'task', 'consistency', 'to_spec', 'spec_review', 'to_tickets', 'tickets_review', 'hatch')),
	CONSTRAINT "planning_runs_state_ck" CHECK("__new_planning_runs"."state" IN ('running', 'asked', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "planning_runs_waypoint_purpose_ck" CHECK(("__new_planning_runs"."waypoint_id" IS NOT NULL) = ("__new_planning_runs"."purpose" IN ('grilling', 'research', 'task'))),
	CONSTRAINT "planning_runs_ended_ck" CHECK(("__new_planning_runs"."state" = 'running') = ("__new_planning_runs"."ended_at" IS NULL)),
	CONSTRAINT "planning_runs_error_ck" CHECK(("__new_planning_runs"."state" = 'failed') = ("__new_planning_runs"."error_code" IS NOT NULL) AND ("__new_planning_runs"."error_code" IS NULL) = ("__new_planning_runs"."error_message" IS NULL)),
	CONSTRAINT "planning_runs_specification_purpose_ck" CHECK("__new_planning_runs"."purpose" = 'to_spec' OR ("__new_planning_runs"."specification_id" IS NOT NULL) = ("__new_planning_runs"."purpose" IN ('spec_review', 'tickets_review', 'to_tickets'))),
	CONSTRAINT "planning_runs_cancel_reason_ck" CHECK(("__new_planning_runs"."state" = 'cancelled') = ("__new_planning_runs"."cancel_reason" IS NOT NULL) AND ("__new_planning_runs"."cancel_reason" IS NULL OR "__new_planning_runs"."cancel_reason" IN ('replaced', 'reopened'))),
	CONSTRAINT "planning_runs_hatch_message_ck" CHECK(CASE "__new_planning_runs"."purpose" WHEN 'hatch' THEN "__new_planning_runs"."hatch_message_id" IS NOT NULL WHEN 'to_spec' THEN 1 WHEN 'to_tickets' THEN 1 ELSE "__new_planning_runs"."hatch_message_id" IS NULL END)
);
--> statement-breakpoint
INSERT INTO `__new_planning_runs`("id", "map_id", "waypoint_id", "specification_id", "purpose", "state", "retry_of_run_id", "error_code", "error_message", "cancel_reason", "hatch_message_id", "started_at", "ended_at", "session_id", "result_subtype", "num_turns", "duration_ms", "total_cost_usd", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens") SELECT "id", "map_id", "waypoint_id", "specification_id", "purpose", "state", "retry_of_run_id", "error_code", "error_message", "cancel_reason", "hatch_message_id", "started_at", "ended_at", "session_id", "result_subtype", "num_turns", "duration_ms", "total_cost_usd", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens" FROM `planning_runs`;--> statement-breakpoint
DROP TABLE `planning_runs`;--> statement-breakpoint
ALTER TABLE `__new_planning_runs` RENAME TO `planning_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_retry_of_run_id_unique` ON `planning_runs` (`retry_of_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_map` ON `planning_runs` (`map_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NULL AND "planning_runs"."specification_id" IS NULL AND "planning_runs"."purpose" <> 'hatch';--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_hatch_per_map` ON `planning_runs` (`map_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."purpose" = 'hatch';--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_specification` ON `planning_runs` (`specification_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."specification_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_waypoint` ON `planning_runs` (`waypoint_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_map_id_uq` ON `planning_runs` (`map_id`,`id`);--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0017_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0017_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0017_foreign_key_violations`;
