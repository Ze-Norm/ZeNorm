-- Additive. Adds `hatch_messages`; rebuilds `planning_runs` (its `cancel_reason` check gains
-- `reopened`, it gains `hatch_message_id` with its purpose check, the map-scope index excludes
-- `hatch` and one running `hatch` run per map is unique) and `question_rounds` (`withdrawn_at`,
-- `withdrawn_reason`, set exactly when withdrawn), copying every row with the new columns null, so
-- ids and `replaced` cancellations are kept; `waypoints` gains `hatch_message_id` by ALTER TABLE.
-- The rebuild runs with foreign keys off (`migrateDatabase`) and ends by refusing any foreign key
-- violation, so a broken copy rolls the migration back.
--
-- `hatch_messages` has no `sent_by_user` column; `run_id` names the `hatch` run that replied and is
-- set exactly when replied; `refusal` holds the refusal code beside the reply that states it;
-- `change` holds the change core applied with the reply, written in its transaction, null for a
-- reply-only or refused message; the spec on screen is `specification_id`, null on Idea and
-- Wayfinding.
CREATE TABLE `hatch_messages` (
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
	CONSTRAINT "hatch_messages_stage_ck" CHECK("hatch_messages"."stage" IN ('idea', 'wayfinding', 'spec', 'implementation')),
	CONSTRAINT "hatch_messages_specification_stage_ck" CHECK("hatch_messages"."specification_id" IS NULL OR "hatch_messages"."stage" NOT IN ('idea', 'wayfinding')),
	CONSTRAINT "hatch_messages_text_length_ck" CHECK(length("text") BETWEEN 1 AND 4000),
	CONSTRAINT "hatch_messages_reply_length_ck" CHECK("reply" IS NULL OR length("reply") BETWEEN 1 AND 2000),
	CONSTRAINT "hatch_messages_replied_ck" CHECK(("hatch_messages"."reply" IS NULL) = ("hatch_messages"."replied_at" IS NULL) AND ("hatch_messages"."reply" IS NULL) = ("hatch_messages"."run_id" IS NULL)),
	CONSTRAINT "hatch_messages_refusal_ck" CHECK("hatch_messages"."refusal" IS NULL OR ("hatch_messages"."reply" IS NOT NULL AND "hatch_messages"."refusal" IN ('spec_in_flight', 'map_uncleared', 'spec_approved', 'ticket_set_approved', 'no_ticket_set', 'waypoint_not_waiting', 'waypoint_state'))),
	CONSTRAINT "hatch_messages_change_ck" CHECK("hatch_messages"."change" IS NULL OR ("hatch_messages"."reply" IS NOT NULL AND "hatch_messages"."refusal" IS NULL))
);
--> statement-breakpoint
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
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retry_of_run_id`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hatch_message_id`) REFERENCES `hatch_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "planning_runs_purpose_ck" CHECK("__new_planning_runs"."purpose" IN ('chart', 'grilling', 'research', 'task', 'consistency', 'to_spec', 'spec_review', 'to_tickets', 'tickets_review', 'hatch')),
	CONSTRAINT "planning_runs_state_ck" CHECK("__new_planning_runs"."state" IN ('running', 'asked', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "planning_runs_waypoint_purpose_ck" CHECK(("__new_planning_runs"."waypoint_id" IS NOT NULL) = ("__new_planning_runs"."purpose" IN ('grilling', 'research', 'task'))),
	CONSTRAINT "planning_runs_ended_ck" CHECK(("__new_planning_runs"."state" = 'running') = ("__new_planning_runs"."ended_at" IS NULL)),
	CONSTRAINT "planning_runs_error_ck" CHECK(("__new_planning_runs"."state" = 'failed') = ("__new_planning_runs"."error_code" IS NOT NULL) AND ("__new_planning_runs"."error_code" IS NULL) = ("__new_planning_runs"."error_message" IS NULL)),
	CONSTRAINT "planning_runs_specification_purpose_ck" CHECK("__new_planning_runs"."purpose" = 'to_spec' OR ("__new_planning_runs"."specification_id" IS NOT NULL) = ("__new_planning_runs"."purpose" IN ('spec_review', 'tickets_review', 'to_tickets'))),
	CONSTRAINT "planning_runs_cancel_reason_ck" CHECK(("__new_planning_runs"."state" = 'cancelled') = ("__new_planning_runs"."cancel_reason" IS NOT NULL) AND ("__new_planning_runs"."cancel_reason" IS NULL OR "__new_planning_runs"."cancel_reason" IN ('replaced', 'reopened'))),
	CONSTRAINT "planning_runs_hatch_message_ck" CHECK(CASE "__new_planning_runs"."purpose" WHEN 'hatch' THEN "__new_planning_runs"."hatch_message_id" IS NOT NULL WHEN 'to_spec' THEN 1 WHEN 'to_tickets' THEN 1 ELSE "__new_planning_runs"."hatch_message_id" IS NULL END)
);
--> statement-breakpoint
INSERT INTO `__new_planning_runs`("id", "map_id", "waypoint_id", "specification_id", "purpose", "state", "retry_of_run_id", "error_code", "error_message", "cancel_reason", "hatch_message_id", "started_at", "ended_at") SELECT "id", "map_id", "waypoint_id", "specification_id", "purpose", "state", "retry_of_run_id", "error_code", "error_message", "cancel_reason", NULL, "started_at", "ended_at" FROM `planning_runs`;--> statement-breakpoint
DROP TABLE `planning_runs`;--> statement-breakpoint
ALTER TABLE `__new_planning_runs` RENAME TO `planning_runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_retry_of_run_id_unique` ON `planning_runs` (`retry_of_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_map` ON `planning_runs` (`map_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NULL AND "planning_runs"."specification_id" IS NULL AND "planning_runs"."purpose" <> 'hatch';--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_hatch_per_map` ON `planning_runs` (`map_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."purpose" = 'hatch';--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_specification` ON `planning_runs` (`specification_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."specification_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_one_running_per_waypoint` ON `planning_runs` (`waypoint_id`) WHERE "planning_runs"."state" = 'running' AND "planning_runs"."waypoint_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `planning_runs_map_id_uq` ON `planning_runs` (`map_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_question_rounds` (
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
	`withdrawn_at` text,
	`withdrawn_reason` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asked_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`map_id`,`waypoint_id`) REFERENCES `waypoints`(`map_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_rounds_status_ck" CHECK("__new_question_rounds"."status" IN ('pending', 'submitted', 'withdrawn')),
	CONSTRAINT "question_rounds_answers_submitted_ck" CHECK(("__new_question_rounds"."answers" IS NULL) = ("__new_question_rounds"."submitted_at" IS NULL)),
	CONSTRAINT "question_rounds_submitted_status_ck" CHECK(("__new_question_rounds"."status" = 'submitted') = ("__new_question_rounds"."submitted_at" IS NOT NULL)),
	CONSTRAINT "question_rounds_withdrawn_ck" CHECK(("__new_question_rounds"."status" = 'withdrawn') = ("__new_question_rounds"."withdrawn_at" IS NOT NULL) AND ("__new_question_rounds"."withdrawn_at" IS NULL) = ("__new_question_rounds"."withdrawn_reason" IS NULL) AND ("__new_question_rounds"."withdrawn_reason" IS NULL OR "__new_question_rounds"."withdrawn_reason" IN ('superseded', 'waypoint_out_of_scope'))),
	CONSTRAINT "question_rounds_map_level_not_final_ck" CHECK("__new_question_rounds"."waypoint_id" IS NOT NULL OR "__new_question_rounds"."final" = 0)
);
--> statement-breakpoint
INSERT INTO `__new_question_rounds`("id", "map_id", "waypoint_id", "number", "final", "status", "asked_by_run", "intro", "questions", "answers", "asked_at", "submitted_at", "withdrawn_at", "withdrawn_reason") SELECT "id", "map_id", "waypoint_id", "number", "final", "status", "asked_by_run", "intro", "questions", "answers", "asked_at", "submitted_at", NULL, NULL FROM `question_rounds`;--> statement-breakpoint
DROP TABLE `question_rounds`;--> statement-breakpoint
ALTER TABLE `__new_question_rounds` RENAME TO `question_rounds`;--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_waypoint_number_uq` ON `question_rounds` (`waypoint_id`,`number`) WHERE "question_rounds"."waypoint_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_map_number_uq` ON `question_rounds` (`map_id`,`number`) WHERE "question_rounds"."waypoint_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_one_pending_per_waypoint` ON `question_rounds` (`waypoint_id`) WHERE "question_rounds"."status" = 'pending' AND "question_rounds"."waypoint_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_one_pending_per_map` ON `question_rounds` (`map_id`) WHERE "question_rounds"."status" = 'pending' AND "question_rounds"."waypoint_id" IS NULL;--> statement-breakpoint
ALTER TABLE `waypoints` ADD `hatch_message_id` text REFERENCES hatch_messages(id);--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0008_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0008_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0008_foreign_key_violations`;
