-- Rebuilds `tickets_review_findings` with `route` (`revise | decision`, checked) and `question`
-- (not null), as `spec_review_findings` has them. The table is empty on every instance (no earlier
-- code records a tickets review), so the rebuild copies nothing, and it refuses a table with any
-- row rather than drop it. The rebuild runs with foreign keys off (`migrateDatabase`) and ends by
-- refusing any foreign key violation, so a broken database rolls the migration back.
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
	CONSTRAINT "tickets_review_findings_kind_ck" CHECK("__new_tickets_review_findings"."kind" IN ('untraced_criterion', 'uncovered_clause', 'contradiction', 'unsupported_evidence')),
	CONSTRAINT "tickets_review_findings_route_ck" CHECK("__new_tickets_review_findings"."route" IN ('revise', 'decision'))
);
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0009_tickets_review_findings_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0009_tickets_review_findings_rows` SELECT count(*) FROM `tickets_review_findings`;
--> statement-breakpoint
DROP TABLE `zenorm_0009_tickets_review_findings_rows`;
--> statement-breakpoint
DROP TABLE `tickets_review_findings`;--> statement-breakpoint
ALTER TABLE `__new_tickets_review_findings` RENAME TO `tickets_review_findings`;--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0009_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0009_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0009_foreign_key_violations`;
