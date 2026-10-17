-- Destructive; the tickets-review tables are created here too, empty. Deletes the flat-shape spec
-- revisions and ticket sets in every state, the delivery runs on them (their branches and worktrees
-- stay on disk, as 0005), and every `to_spec` and `to_tickets` planning run, so none hides a due
-- one; at startup `planNext` starts `to_spec` on each cleared map with no revision. Every other
-- planning run gets null `specification_id` and `cancel_reason`. Maps, Wayfinding records, projects
-- and every other row are kept unchanged. `planning_runs` gains its columns by ALTER TABLE (no
-- rebuild), so the rows other tables reference keep their ids.
--
-- `specifications` holds no title (a spec shows its latest revision's) and no `tickets_numbered`
-- (it is derived); `spec_revisions` has no state enum (approved and superseded are timestamps, a
-- rejection is a supersession with its reason); a ticket set version's tickets, dispositions,
-- slicing and execution are one typed `content` document, not four tables; `spec_reviews.sources`
-- lists the map's closed waypoints with outcome and closing time (no input manifest);
-- `planning_runs` scopes per spec as well as per waypoint and map; delivery runs number per spec.
DELETE FROM `delivery_runs`;
--> statement-breakpoint
DROP TABLE `delivery_runs`;
--> statement-breakpoint
DROP TABLE `ticket_sets`;
--> statement-breakpoint
DROP TABLE `spec_revisions`;
--> statement-breakpoint
DELETE FROM `planning_runs` WHERE `purpose` IN ('to_spec', 'to_tickets');
--> statement-breakpoint
CREATE TABLE `specifications` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `specifications_project_number_uq` ON `specifications` (`project_id`,`number`);
--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `specification_id` text REFERENCES specifications(id) CONSTRAINT "planning_runs_specification_purpose_ck" CHECK("planning_runs"."purpose" = 'to_spec' OR ("planning_runs"."specification_id" IS NOT NULL) = ("planning_runs"."purpose" IN ('spec_review', 'tickets_review', 'to_tickets')));
--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `cancel_reason` text CONSTRAINT "planning_runs_cancel_reason_ck" CHECK(("planning_runs"."state" = 'cancelled') = ("planning_runs"."cancel_reason" IS NOT NULL) AND ("planning_runs"."cancel_reason" IS NULL OR "planning_runs"."cancel_reason" IN ('replaced')));
--> statement-breakpoint
DROP INDEX `planning_runs_one_running_per_map`;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_map` ON `planning_runs` (`map_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NULL AND "planning_runs"."specification_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_specification` ON `planning_runs` (`specification_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."specification_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `spec_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`specification_id` text NOT NULL,
	`revision` integer NOT NULL,
	`map_id` text NOT NULL,
	`written_by_run` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`approved_at` text,
	`superseded_at` text,
	`rejection_reason` text,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`written_by_run`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spec_revisions_single_decision_ck" CHECK("spec_revisions"."approved_at" IS NULL OR "spec_revisions"."superseded_at" IS NULL),
	CONSTRAINT "spec_revisions_rejection_reason_ck" CHECK("spec_revisions"."rejection_reason" IS NULL OR "spec_revisions"."superseded_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_one_draft_per_spec` ON `spec_revisions` (`specification_id`) WHERE "spec_revisions"."approved_at" IS NULL AND "spec_revisions"."superseded_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_spec_revision_uq` ON `spec_revisions` (`specification_id`,`revision`);
--> statement-breakpoint
CREATE TABLE `ticket_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`spec_revision_id` text NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `spec_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ticket_sets_state_ck" CHECK("ticket_sets"."state" IN ('awaiting_review', 'review_passed', 'review_failed', 'approved')),
	CONSTRAINT "ticket_sets_approved_ck" CHECK(("ticket_sets"."state" = 'approved') = ("ticket_sets"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_spec_revision_uq` ON `ticket_sets` (`spec_revision_id`);
--> statement-breakpoint
CREATE TABLE `spec_review_findings` (
	`review_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`route` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`question` text NOT NULL,
	`element_ids` text NOT NULL,
	`waypoint_numbers` text NOT NULL,
	`escalated` integer NOT NULL,
	`waypoint_id` text,
	PRIMARY KEY(`review_id`, `position`),
	FOREIGN KEY (`review_id`) REFERENCES `spec_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`waypoint_id`) REFERENCES `waypoints`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spec_review_findings_kind_ck" CHECK("spec_review_findings"."kind" IN ('contradiction', 'invented_scope', 'undefined_term', 'dropped_resolution', 'existing_records', 'unverifiable')),
	CONSTRAINT "spec_review_findings_route_ck" CHECK("spec_review_findings"."route" IN ('revise', 'decision')),
	CONSTRAINT "spec_review_findings_escalated_ck" CHECK(("spec_review_findings"."waypoint_id" IS NOT NULL) = "spec_review_findings"."escalated")
);
--> statement-breakpoint
CREATE TABLE `spec_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`spec_revision_id` text NOT NULL,
	`run_id` text NOT NULL,
	`passed` integer NOT NULL,
	`summary` text NOT NULL,
	`sources` text NOT NULL,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `spec_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_reviews_spec_revision_uq` ON `spec_reviews` (`spec_revision_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_reviews_run_uq` ON `spec_reviews` (`run_id`);
--> statement-breakpoint
CREATE TABLE `ticket_set_rejections` (
	`ticket_set_id` text NOT NULL,
	`version` integer NOT NULL,
	`reason` text NOT NULL,
	`rejected_at` text NOT NULL,
	FOREIGN KEY (`ticket_set_id`,`version`) REFERENCES `ticket_set_versions`(`ticket_set_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_set_rejections_version_uq` ON `ticket_set_rejections` (`ticket_set_id`,`version`);
--> statement-breakpoint
CREATE TABLE `ticket_set_versions` (
	`ticket_set_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`written_by_run` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket_set_id`, `version`),
	FOREIGN KEY (`ticket_set_id`) REFERENCES `ticket_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`written_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tickets_review_findings` (
	`review_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`ticket_numbers` text NOT NULL,
	`criterion_ids` text NOT NULL,
	`escalated` integer NOT NULL,
	PRIMARY KEY(`review_id`, `position`),
	FOREIGN KEY (`review_id`) REFERENCES `tickets_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tickets_review_findings_kind_ck" CHECK("tickets_review_findings"."kind" IN ('untraced_criterion', 'uncovered_clause', 'contradiction', 'unsupported_evidence'))
);
--> statement-breakpoint
CREATE TABLE `tickets_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_set_id` text NOT NULL,
	`ticket_set_version` integer NOT NULL,
	`run_id` text NOT NULL,
	`passed` integer NOT NULL,
	`summary` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_set_id`,`ticket_set_version`) REFERENCES `ticket_set_versions`(`ticket_set_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_reviews_run_uq` ON `tickets_reviews` (`run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_reviews_version_uq` ON `tickets_reviews` (`ticket_set_id`,`ticket_set_version`);
--> statement-breakpoint
CREATE TABLE `delivery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`specification_id` text NOT NULL,
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
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_set_id`) REFERENCES `ticket_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_runs_single_outcome_ck" CHECK("delivery_runs"."verdict" IS NULL OR "delivery_runs"."failure" IS NULL),
	CONSTRAINT "delivery_runs_outcome_ended_ck" CHECK("delivery_runs"."ended_at" IS NOT NULL OR ("delivery_runs"."verdict" IS NULL AND "delivery_runs"."failure" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_one_active_per_ticket_set` ON `delivery_runs` (`ticket_set_id`) WHERE "delivery_runs"."ended_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_spec_number_uq` ON `delivery_runs` (`specification_id`,`number`);
