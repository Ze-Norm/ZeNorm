-- Slice 6b spec D1 and Existing Records: additive. Adds `maps.fog_next_position` (1 on every
-- existing map, by the column's SQL DEFAULT, which only backfills: core writes the value on every
-- new map and `schema.ts` declares no default) and creates the fog, Out of scope, research, task and
-- consistency tables, all empty. Every other row is kept unchanged.
--
-- Departures from the domain model (section 3.3): no `needs_person` task outcome row (the asked
-- round's `asked_by_run` and the run's `asked` state record it); no `research_sources.revision` or
-- `version` (nothing in 6b re-reads a source or changes a resolution in place; `compared` uses
-- `resolved_at` as the version stand-in); `task_outcomes.facts` is non-empty also when `failed`;
-- `consistency_findings.waypoint_numbers` holds numbers, not `waypoint_ids`. Keys: a research report
-- and a task outcome are keyed by their run, a finding by the waypoint it created, fog items and
-- Out of scope lines by `(map_id, position)`.
CREATE TABLE `consistency_findings` (
	`created_waypoint_id` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	`kind` text NOT NULL,
	`waypoint_numbers` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`question` text NOT NULL,
	FOREIGN KEY (`created_waypoint_id`) REFERENCES `waypoints`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `consistency_passes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "consistency_findings_kind_ck" CHECK("consistency_findings"."kind" IN ('conflicting_surfaces', 'undefined_term', 'deferred_case_assumed')),
	CONSTRAINT "consistency_findings_title_length_ck" CHECK(length("title") <= 120),
	CONSTRAINT "consistency_findings_explanation_length_ck" CHECK(length("explanation") <= 4000),
	CONSTRAINT "consistency_findings_question_length_ck" CHECK(length("question") <= 1000)
);
--> statement-breakpoint
CREATE TABLE `consistency_passes` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`run_id` text NOT NULL,
	`compared` text NOT NULL,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`run_id`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consistency_passes_run_uq` ON `consistency_passes` (`run_id`);--> statement-breakpoint
CREATE TABLE `map_exclusions` (
	`map_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`waypoint_id` text,
	`created_by_run` text NOT NULL,
	PRIMARY KEY(`map_id`, `position`),
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`created_by_run`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "map_exclusions_text_length_ck" CHECK(length("text") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_exclusions_waypoint_uq` ON `map_exclusions` (`waypoint_id`);--> statement-breakpoint
CREATE TABLE `map_fog` (
	`map_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`created_by_run` text NOT NULL,
	PRIMARY KEY(`map_id`, `position`),
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`created_by_run`) REFERENCES `planning_runs`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "map_fog_text_length_ck" CHECK(length("text") <= 500)
);
--> statement-breakpoint
CREATE TABLE `research_reports` (
	`run_id` text PRIMARY KEY NOT NULL,
	`waypoint_id` text NOT NULL,
	`answered` integer NOT NULL,
	`summary` text NOT NULL,
	`gap` text,
	`findings` text NOT NULL,
	`limitations` text NOT NULL,
	`uncertainties` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`waypoint_id`) REFERENCES `waypoints`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "research_reports_gap_ck" CHECK("research_reports"."answered" = ("research_reports"."gap" IS NULL)),
	CONSTRAINT "research_reports_summary_length_ck" CHECK(length("summary") <= 4000),
	CONSTRAINT "research_reports_gap_length_ck" CHECK("gap" IS NULL OR length("gap") <= 1000)
);
--> statement-breakpoint
CREATE TABLE `research_sources` (
	`report_run_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`excerpt` text NOT NULL,
	PRIMARY KEY(`report_run_id`, `position`),
	FOREIGN KEY (`report_run_id`) REFERENCES `research_reports`(`run_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "research_sources_kind_ck" CHECK("research_sources"."kind" IN ('map', 'waypoint', 'specification', 'repository_file', 'external')),
	CONSTRAINT "research_sources_url_ck" CHECK(("research_sources"."kind" = 'external') = ("research_sources"."url" IS NOT NULL)),
	CONSTRAINT "research_sources_title_length_ck" CHECK(length("title") <= 200),
	CONSTRAINT "research_sources_excerpt_length_ck" CHECK(length("excerpt") <= 2000)
);
--> statement-breakpoint
CREATE TABLE `task_outcomes` (
	`run_id` text PRIMARY KEY NOT NULL,
	`waypoint_id` text NOT NULL,
	`outcome` text NOT NULL,
	`action` text NOT NULL,
	`facts` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`waypoint_id`) REFERENCES `waypoints`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_outcomes_outcome_ck" CHECK("task_outcomes"."outcome" IN ('done', 'failed')),
	CONSTRAINT "task_outcomes_action_length_ck" CHECK(length("action") <= 1000),
	CONSTRAINT "task_outcomes_facts_length_ck" CHECK(length("facts") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE `maps` ADD `fog_next_position` integer DEFAULT 1 NOT NULL;