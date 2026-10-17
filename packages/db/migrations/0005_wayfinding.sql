-- Slice 6a spec D1 and Existing Records: drops the pre-6a maps and everything that hangs off them
-- (question rounds, spec revisions, ticket sets, delivery runs) and creates the Wayfinding tables.
-- Projects are kept unchanged. Waypoints, blockers and planning runs start empty. A delivery run's
-- branch and worktree stay on disk untouched; only its row goes.
--
-- Departure from the domain model (section 3): `agent_runs` is merged into `planning_runs` (no
-- separate shared run record, no `manifest`); the new tables drop `version`, and `waypoints` drops
-- `context`. The only run rows this slice stores are planning runs (delivery keeps
-- `delivery_runs`, and model and usage recording is not in this slice); `version` serves
-- `version_conflict` and the change feed, which come with slice 9; nothing in this slice writes
-- `context`. The slices that need them add them.
DROP TABLE `delivery_runs`;
--> statement-breakpoint
DROP TABLE `ticket_sets`;
--> statement-breakpoint
DROP TABLE `spec_revisions`;
--> statement-breakpoint
DROP TABLE `question_rounds`;
--> statement-breakpoint
DROP TABLE `maps`;
--> statement-breakpoint
CREATE TABLE `maps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`idea` text NOT NULL,
	`title` text,
	`summary` text,
	`destination` text,
	`destination_confirmed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "maps_destination_confirmed_ck" CHECK("maps"."destination_confirmed_at" IS NULL OR "maps"."destination" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `planning_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`waypoint_id` text,
	`purpose` text NOT NULL,
	`state` text NOT NULL,
	`retry_of_run_id` text,
	`error_code` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retry_of_run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "planning_runs_purpose_ck" CHECK("planning_runs"."purpose" IN ('chart', 'grilling', 'research', 'task', 'consistency', 'to_spec', 'spec_review', 'to_tickets', 'tickets_review', 'hatch')),
	CONSTRAINT "planning_runs_state_ck" CHECK("planning_runs"."state" IN ('running', 'asked', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "planning_runs_waypoint_purpose_ck" CHECK(("planning_runs"."waypoint_id" IS NOT NULL) = ("planning_runs"."purpose" IN ('grilling', 'research', 'task'))),
	CONSTRAINT "planning_runs_ended_ck" CHECK(("planning_runs"."state" = 'running') = ("planning_runs"."ended_at" IS NULL)),
	CONSTRAINT "planning_runs_error_ck" CHECK(("planning_runs"."state" = 'failed') = ("planning_runs"."error_code" IS NOT NULL) AND ("planning_runs"."error_code" IS NULL) = ("planning_runs"."error_message" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_retry_of_run_id_unique` ON `planning_runs` (`retry_of_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_map` ON `planning_runs` (`map_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_waypoint` ON `planning_runs` (`waypoint_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_map_id_uq` ON `planning_runs` (`map_id`,`id`);
--> statement-breakpoint
CREATE TABLE `waypoints` (
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
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "waypoints_kind_ck" CHECK("waypoints"."kind" IN ('grilling', 'research', 'task')),
	CONSTRAINT "waypoints_status_ck" CHECK("waypoints"."status" IN ('open', 'claimed', 'resolved', 'out_of_scope')),
	CONSTRAINT "waypoints_resolved_how_ck" CHECK("waypoints"."resolved_how" IS NULL OR "waypoints"."resolved_how" IN ('run', 'plain_choice')),
	CONSTRAINT "waypoints_resolution_ck" CHECK(("waypoints"."status" = 'resolved') = ("waypoints"."resolution" IS NOT NULL) AND ("waypoints"."status" = 'resolved') = ("waypoints"."gist" IS NOT NULL) AND ("waypoints"."status" = 'resolved') = ("waypoints"."resolved_at" IS NOT NULL) AND ("waypoints"."status" = 'resolved') = ("waypoints"."resolved_how" IS NOT NULL)),
	CONSTRAINT "waypoints_gist_length_ck" CHECK("gist" IS NULL OR length("gist") <= 200),
	CONSTRAINT "waypoints_resolved_by_run_ck" CHECK(("waypoints"."resolved_by_run" IS NOT NULL) = ("waypoints"."resolved_how" IS NOT NULL AND "waypoints"."resolved_how" = 'run'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waypoints_map_number_uq` ON `waypoints` (`map_id`,`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `waypoints_map_id_uq` ON `waypoints` (`map_id`,`id`);
--> statement-breakpoint
CREATE TABLE `waypoint_blockers` (
	`map_id` text NOT NULL,
	`waypoint_number` integer NOT NULL,
	`blocker_number` integer NOT NULL,
	PRIMARY KEY(`map_id`, `waypoint_number`, `blocker_number`),
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_number`) REFERENCES `waypoints`(`map_id`,`number`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`blocker_number`) REFERENCES `waypoints`(`map_id`,`number`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "waypoint_blockers_not_self_ck" CHECK("waypoint_blockers"."waypoint_number" <> "waypoint_blockers"."blocker_number")
);
--> statement-breakpoint
CREATE TABLE `question_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`waypoint_id` text,
	`number` integer NOT NULL,
	`final` integer NOT NULL,
	`status` text NOT NULL,
	`asked_by_run` text NOT NULL,
	`intro` text NOT NULL,
	`questions` text NOT NULL,
	`answers` text,
	`asked_at` text NOT NULL,
	`submitted_at` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asked_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_rounds_status_ck" CHECK("question_rounds"."status" IN ('pending', 'submitted', 'withdrawn')),
	CONSTRAINT "question_rounds_answers_submitted_ck" CHECK(("question_rounds"."answers" IS NULL) = ("question_rounds"."submitted_at" IS NULL)),
	CONSTRAINT "question_rounds_submitted_status_ck" CHECK(("question_rounds"."status" = 'submitted') = ("question_rounds"."submitted_at" IS NOT NULL)),
	CONSTRAINT "question_rounds_map_level_not_final_ck" CHECK("question_rounds"."waypoint_id" IS NOT NULL OR "question_rounds"."final" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_waypoint_number_uq` ON `question_rounds` (`waypoint_id`,`number`) WHERE "question_rounds"."waypoint_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_map_number_uq` ON `question_rounds` (`map_id`,`number`) WHERE "question_rounds"."waypoint_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_one_pending_per_waypoint` ON `question_rounds` (`waypoint_id`) WHERE "question_rounds"."status" = 'pending' AND "question_rounds"."waypoint_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_one_pending_per_map` ON `question_rounds` (`map_id`) WHERE "question_rounds"."status" = 'pending' AND "question_rounds"."waypoint_id" IS NULL;
--> statement-breakpoint
CREATE TABLE `spec_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`drafted_at` text NOT NULL,
	`approved_at` text,
	`rejected_at` text,
	`rejection_reason` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spec_revisions_rejection_reason_ck" CHECK(("spec_revisions"."rejected_at" IS NULL) = ("spec_revisions"."rejection_reason" IS NULL)),
	CONSTRAINT "spec_revisions_single_decision_ck" CHECK("spec_revisions"."approved_at" IS NULL OR "spec_revisions"."rejected_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_one_undecided_per_map` ON `spec_revisions` (`map_id`) WHERE "spec_revisions"."approved_at" IS NULL AND "spec_revisions"."rejected_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_one_approved_per_map` ON `spec_revisions` (`map_id`) WHERE "spec_revisions"."approved_at" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_map_revision_uq` ON `spec_revisions` (`map_id`,`revision`);
--> statement-breakpoint
CREATE TABLE `ticket_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`spec_revision_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`drafted_at` text NOT NULL,
	`approved_at` text,
	`rejected_at` text,
	`rejection_reason` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `spec_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ticket_sets_rejection_reason_ck" CHECK(("ticket_sets"."rejected_at" IS NULL) = ("ticket_sets"."rejection_reason" IS NULL)),
	CONSTRAINT "ticket_sets_single_decision_ck" CHECK("ticket_sets"."approved_at" IS NULL OR "ticket_sets"."rejected_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_one_undecided_per_map` ON `ticket_sets` (`map_id`) WHERE "ticket_sets"."approved_at" IS NULL AND "ticket_sets"."rejected_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_one_approved_per_map` ON `ticket_sets` (`map_id`) WHERE "ticket_sets"."approved_at" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_map_version_uq` ON `ticket_sets` (`map_id`,`version`);
--> statement-breakpoint
CREATE TABLE `delivery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_set_id` text NOT NULL,
	`number` integer NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`base_commit` text NOT NULL,
	`checks` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`final_commit` text,
	`check_results` text,
	`verdict` text,
	`failure` text,
	FOREIGN KEY (`ticket_set_id`) REFERENCES `ticket_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_runs_single_outcome_ck" CHECK("delivery_runs"."verdict" IS NULL OR "delivery_runs"."failure" IS NULL),
	CONSTRAINT "delivery_runs_outcome_ended_ck" CHECK("delivery_runs"."ended_at" IS NOT NULL OR ("delivery_runs"."verdict" IS NULL AND "delivery_runs"."failure" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_one_active_per_ticket_set` ON `delivery_runs` (`ticket_set_id`) WHERE "delivery_runs"."ended_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_ticket_set_number_uq` ON `delivery_runs` (`ticket_set_id`,`number`);
