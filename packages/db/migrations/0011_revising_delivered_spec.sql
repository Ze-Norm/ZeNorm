-- Rebuilds `hatch_messages` so its refusal check admits
-- `spec_waiting` (keeping `spec_approved`, which stored replies carry) and `tickets_review_findings`
-- so its kind check admits `disposition_without_reason`. Each rebuild copies every column of every
-- row unchanged and refuses to finish unless the new table has as many rows as the old one. Then
-- adds `waypoint_touches` and `spec_waits`, empty: no waypoint gets a touch and no map waits.
-- `spec_waits` references `hatch_messages`, so it is created after that rebuild. The rebuilds run
-- with foreign keys off (`migrateDatabase`; `hatch_messages` is a parent of `planning_runs` and
-- `waypoints`) and the migration ends by refusing any foreign key violation.
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
	CONSTRAINT "hatch_messages_stage_ck" CHECK("__new_hatch_messages"."stage" IN ('idea', 'wayfinding', 'spec', 'implementation')),
	CONSTRAINT "hatch_messages_specification_stage_ck" CHECK("__new_hatch_messages"."specification_id" IS NULL OR "__new_hatch_messages"."stage" NOT IN ('idea', 'wayfinding')),
	CONSTRAINT "hatch_messages_text_length_ck" CHECK(length("text") BETWEEN 1 AND 4000),
	CONSTRAINT "hatch_messages_reply_length_ck" CHECK("reply" IS NULL OR length("reply") BETWEEN 1 AND 2000),
	CONSTRAINT "hatch_messages_replied_ck" CHECK(("__new_hatch_messages"."reply" IS NULL) = ("__new_hatch_messages"."replied_at" IS NULL) AND ("__new_hatch_messages"."reply" IS NULL) = ("__new_hatch_messages"."run_id" IS NULL)),
	CONSTRAINT "hatch_messages_refusal_ck" CHECK("__new_hatch_messages"."refusal" IS NULL OR ("__new_hatch_messages"."reply" IS NOT NULL AND "__new_hatch_messages"."refusal" IN ('spec_in_flight', 'map_uncleared', 'spec_approved', 'ticket_set_approved', 'no_ticket_set', 'waypoint_not_waiting', 'waypoint_state', 'spec_waiting'))),
	CONSTRAINT "hatch_messages_change_ck" CHECK("__new_hatch_messages"."change" IS NULL OR ("__new_hatch_messages"."reply" IS NOT NULL AND "__new_hatch_messages"."refusal" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_hatch_messages`("id", "map_id", "stage", "specification_id", "text", "sent_at", "run_id", "reply", "refusal", "change", "replied_at")
SELECT "id", "map_id", "stage", "specification_id", "text", "sent_at", "run_id", "reply", "refusal", "change", "replied_at" FROM `hatch_messages`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0011_hatch_messages_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0011_hatch_messages_rows` SELECT (SELECT count(*) FROM `hatch_messages`) - (SELECT count(*) FROM `__new_hatch_messages`);
--> statement-breakpoint
DROP TABLE `zenorm_0011_hatch_messages_rows`;
--> statement-breakpoint
DROP TABLE `hatch_messages`;
--> statement-breakpoint
ALTER TABLE `__new_hatch_messages` RENAME TO `hatch_messages`;
--> statement-breakpoint
CREATE TABLE `__new_tickets_review_findings` (
	`review_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`route` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`question` text NOT NULL,
	`ticket_numbers` text NOT NULL,
	`criterion_ids` text NOT NULL,
	`escalated` integer NOT NULL,
	PRIMARY KEY(`review_id`, `position`),
	FOREIGN KEY (`review_id`) REFERENCES `tickets_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tickets_review_findings_kind_ck" CHECK("__new_tickets_review_findings"."kind" IN ('untraced_criterion', 'uncovered_clause', 'contradiction', 'unsupported_evidence', 'disposition_without_reason')),
	CONSTRAINT "tickets_review_findings_route_ck" CHECK("__new_tickets_review_findings"."route" IN ('revise', 'decision'))
);
--> statement-breakpoint
INSERT INTO `__new_tickets_review_findings`("review_id", "position", "kind", "route", "title", "explanation", "question", "ticket_numbers", "criterion_ids", "escalated")
SELECT "review_id", "position", "kind", "route", "title", "explanation", "question", "ticket_numbers", "criterion_ids", "escalated" FROM `tickets_review_findings`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0011_tickets_review_findings_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0011_tickets_review_findings_rows` SELECT (SELECT count(*) FROM `tickets_review_findings`) - (SELECT count(*) FROM `__new_tickets_review_findings`);
--> statement-breakpoint
DROP TABLE `zenorm_0011_tickets_review_findings_rows`;
--> statement-breakpoint
DROP TABLE `tickets_review_findings`;
--> statement-breakpoint
ALTER TABLE `__new_tickets_review_findings` RENAME TO `tickets_review_findings`;
--> statement-breakpoint
CREATE TABLE `waypoint_touches` (
	`waypoint_id` text NOT NULL,
	`specification_id` text NOT NULL,
	`revision` integer NOT NULL,
	`criteria` text NOT NULL,
	PRIMARY KEY(`waypoint_id`, `specification_id`),
	FOREIGN KEY (`waypoint_id`) REFERENCES `waypoints`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`,`revision`) REFERENCES `spec_revisions`(`specification_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "waypoint_touches_revision_ck" CHECK("waypoint_touches"."revision" >= 1),
	CONSTRAINT "waypoint_touches_criteria_ck" CHECK(json_array_length("criteria") BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE `spec_waits` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`specification_id` text NOT NULL,
	`note` text NOT NULL,
	`hatch_message_id` text,
	`since` text NOT NULL,
	`hold_kind` text NOT NULL,
	`hold_map_id` text NOT NULL,
	`hold_revision` integer NOT NULL,
	`released_at` text,
	`released_by_run` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hatch_message_id`) REFERENCES `hatch_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hold_map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`released_by_run`) REFERENCES `planning_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`,`hold_revision`) REFERENCES `spec_revisions`(`specification_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spec_waits_note_length_ck" CHECK(length("note") BETWEEN 1 AND 4000),
	CONSTRAINT "spec_waits_hold_kind_ck" CHECK("spec_waits"."hold_kind" IN ('revision', 'revising', 'tickets', 'delivering')),
	CONSTRAINT "spec_waits_hold_revision_ck" CHECK("spec_waits"."hold_revision" >= 1),
	CONSTRAINT "spec_waits_released_ck" CHECK(("spec_waits"."released_at" IS NULL) = ("spec_waits"."released_by_run" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_waits_one_open_per_map_spec` ON `spec_waits` (`map_id`,`specification_id`) WHERE "spec_waits"."released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX `spec_waits_open_by_spec` ON `spec_waits` (`specification_id`) WHERE "spec_waits"."released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX `spec_waits_released_by_run` ON `spec_waits` (`released_by_run`);
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0011_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0011_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0011_foreign_key_violations`;
