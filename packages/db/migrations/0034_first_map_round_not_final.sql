-- The first map-level round is never final; a follow-up round on the destination (round 2 or 3) may
-- be. The rebuild replaces `question_rounds_map_level_not_final_ck` with
-- `question_rounds_first_map_round_not_final_ck` and copies every column, index and other check
-- unchanged. Every stored map-level round is not final, so each passes the new check. It refuses to
-- finish unless the new table has as many rows as the old one. It runs with foreign keys off
-- (`migrateDatabase`) and ends by refusing any foreign key violation.
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
	CONSTRAINT "question_rounds_first_map_round_not_final_ck" CHECK("__new_question_rounds"."waypoint_id" IS NOT NULL OR "__new_question_rounds"."number" > 1 OR "__new_question_rounds"."final" = 0)
);
--> statement-breakpoint
INSERT INTO `__new_question_rounds`("id", "map_id", "waypoint_id", "number", "final", "status", "asked_by_run", "intro", "questions", "answers", "asked_at", "submitted_at", "withdrawn_at", "withdrawn_reason")
SELECT "id", "map_id", "waypoint_id", "number", "final", "status", "asked_by_run", "intro", "questions", "answers", "asked_at", "submitted_at", "withdrawn_at", "withdrawn_reason" FROM `question_rounds`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0034_question_rounds_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0034_question_rounds_rows` SELECT (SELECT count(*) FROM `question_rounds`) - (SELECT count(*) FROM `__new_question_rounds`);
--> statement-breakpoint
DROP TABLE `zenorm_0034_question_rounds_rows`;
--> statement-breakpoint
DROP TABLE `question_rounds`;
--> statement-breakpoint
ALTER TABLE `__new_question_rounds` RENAME TO `question_rounds`;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_waypoint_number_uq` ON `question_rounds` (`waypoint_id`,`number`) WHERE "question_rounds"."waypoint_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_map_number_uq` ON `question_rounds` (`map_id`,`number`) WHERE "question_rounds"."waypoint_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_one_pending_per_waypoint` ON `question_rounds` (`waypoint_id`) WHERE "question_rounds"."status" = 'pending' AND "question_rounds"."waypoint_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `question_rounds_one_pending_per_map` ON `question_rounds` (`map_id`) WHERE "question_rounds"."status" = 'pending' AND "question_rounds"."waypoint_id" IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0034_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0034_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0034_foreign_key_violations`;
