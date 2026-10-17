-- Delivery ends by opening a GitHub pull request. Rebuilds `delivery_runs` so its phase check
-- admits `publishing`, the step a passing run on a GitHub project ends in, and adds the nullable
-- `pr_number`, `pr_url` and `pr_state` of the pull request a passed run opened: all set or all
-- null, the state one of `open`, `closed` and `merged`, and only on a run with a verdict. Every run
-- before this migration opened no pull request, so all three are null on it. `start_commit`,
-- `user_id` and `executor` stay nullable in SQL as their added columns were. The rebuild copies
-- every other column unchanged and refuses to finish unless the new table has as many rows as the
-- old one. It runs with foreign keys off (`migrateDatabase`) and ends by refusing any foreign key
-- violation.
CREATE TABLE `__new_delivery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`specification_id` text NOT NULL,
	`ticket_set_id` text NOT NULL,
	`number` integer NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_commit` text NOT NULL,
	`checks` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`final_commit` text,
	`check_results` text,
	`verdict` text,
	`failure` text,
	`merged_at` text,
	`user_id` text,
	`executor` text,
	`start_commit` text,
	`resumed_from_run_id` text,
	`pr_number` integer,
	`pr_url` text,
	`pr_state` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_set_id`) REFERENCES `ticket_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resumed_from_run_id`) REFERENCES `delivery_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_runs_single_outcome_ck" CHECK("__new_delivery_runs"."verdict" IS NULL OR "__new_delivery_runs"."failure" IS NULL),
	CONSTRAINT "delivery_runs_outcome_ended_ck" CHECK("__new_delivery_runs"."ended_at" IS NOT NULL OR ("__new_delivery_runs"."verdict" IS NULL AND "__new_delivery_runs"."failure" IS NULL)),
	CONSTRAINT "delivery_runs_phase_ck" CHECK("__new_delivery_runs"."phase" IN ('preparing', 'implementing', 'verifying', 'reviewing', 'publishing')),
	CONSTRAINT "delivery_runs_merged_verdict_ck" CHECK("__new_delivery_runs"."merged_at" IS NULL OR "__new_delivery_runs"."verdict" IS NOT NULL),
	CONSTRAINT "delivery_runs_pull_request_ck" CHECK(("__new_delivery_runs"."pr_number" IS NULL) = ("__new_delivery_runs"."pr_url" IS NULL) AND ("__new_delivery_runs"."pr_number" IS NULL) = ("__new_delivery_runs"."pr_state" IS NULL)),
	CONSTRAINT "delivery_runs_pull_request_state_ck" CHECK("__new_delivery_runs"."pr_state" IS NULL OR "__new_delivery_runs"."pr_state" IN ('open', 'closed', 'merged')),
	CONSTRAINT "delivery_runs_pull_request_verdict_ck" CHECK("__new_delivery_runs"."pr_number" IS NULL OR "__new_delivery_runs"."verdict" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_delivery_runs`("id", "project_id", "specification_id", "ticket_set_id", "number", "branch", "worktree_path", "base_branch", "base_commit", "checks", "phase", "started_at", "ended_at", "final_commit", "check_results", "verdict", "failure", "merged_at", "user_id", "executor", "start_commit", "resumed_from_run_id", "pr_number", "pr_url", "pr_state")
SELECT "id", "project_id", "specification_id", "ticket_set_id", "number", "branch", "worktree_path", "base_branch", "base_commit", "checks", "phase", "started_at", "ended_at", "final_commit", "check_results", "verdict", "failure", "merged_at", "user_id", "executor", "start_commit", "resumed_from_run_id", NULL, NULL, NULL FROM `delivery_runs`;
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0030_delivery_runs_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0030_delivery_runs_rows` SELECT (SELECT count(*) FROM `delivery_runs`) - (SELECT count(*) FROM `__new_delivery_runs`);
--> statement-breakpoint
DROP TABLE `zenorm_0030_delivery_runs_rows`;
--> statement-breakpoint
DROP TABLE `delivery_runs`;
--> statement-breakpoint
ALTER TABLE `__new_delivery_runs` RENAME TO `delivery_runs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_one_active_per_project` ON `delivery_runs` (`project_id`) WHERE "delivery_runs"."ended_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_spec_number_uq` ON `delivery_runs` (`specification_id`,`number`);
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0030_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0030_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0030_foreign_key_violations`;
