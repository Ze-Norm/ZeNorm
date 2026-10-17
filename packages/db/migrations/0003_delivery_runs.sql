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
CREATE UNIQUE INDEX `delivery_runs_one_active_per_ticket_set` ON `delivery_runs` (`ticket_set_id`) WHERE "delivery_runs"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_ticket_set_number_uq` ON `delivery_runs` (`ticket_set_id`,`number`);