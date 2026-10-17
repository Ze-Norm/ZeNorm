-- Slice 8 spec D1 and Existing Records. Adds `projects.required_checks` (`[]` on every existing
-- project, by the column's SQL DEFAULT, which only backfills: core writes the value on every new
-- project and `schema.ts` declares no default; nothing is copied from old runs, L184 (1)). SQLite
-- cannot drop a column default, so every database keeps this one although `0010_snapshot.json`
-- shows none: a raw insert without the column gets `[]`. A later migration that rebuilds
-- `projects` drops it (L197 item 14, N-Std-1).
-- Rebuilds `delivery_runs` with `project_id` (the run's spec's), `base_branch` (the project's, which
-- nothing could change before this migration), the stored `phase` and `merged_at`. `phase` is
-- `failure.phase` for a failed run, `reviewing` for a passed or blocked one, and for a cancelled or
-- active one the web's evidence rule: check results, `reviewing`; a final commit, `verifying`; else
-- `implementing`. `phase` then leaves `failure` (L44), and every verdict finding gains
-- `"criterion": null` (S8-11). Where a project has several active runs, all but the newest (by
-- `started_at`, then `id`) end cancelled at the migration time before the per-project index is
-- created (L98). Adds `delivery_run_tickets` and `delivery_run_events`, empty: older runs get no
-- ticket rows and no lines. The rebuild runs with foreign keys off (`migrateDatabase`) and ends by
-- refusing any foreign key violation (L163).
ALTER TABLE `projects` ADD `required_checks` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
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
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`specification_id`) REFERENCES `specifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_set_id`) REFERENCES `ticket_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_runs_single_outcome_ck" CHECK("__new_delivery_runs"."verdict" IS NULL OR "__new_delivery_runs"."failure" IS NULL),
	CONSTRAINT "delivery_runs_outcome_ended_ck" CHECK("__new_delivery_runs"."ended_at" IS NOT NULL OR ("__new_delivery_runs"."verdict" IS NULL AND "__new_delivery_runs"."failure" IS NULL)),
	CONSTRAINT "delivery_runs_phase_ck" CHECK("__new_delivery_runs"."phase" IN ('preparing', 'implementing', 'verifying', 'reviewing')),
	CONSTRAINT "delivery_runs_merged_verdict_ck" CHECK("__new_delivery_runs"."merged_at" IS NULL OR "__new_delivery_runs"."verdict" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_delivery_runs`("id", "project_id", "specification_id", "ticket_set_id", "number", "branch", "worktree_path", "base_branch", "base_commit", "checks", "phase", "started_at", "ended_at", "final_commit", "check_results", "verdict", "failure", "merged_at")
SELECT
	r."id",
	s."project_id",
	r."specification_id",
	r."ticket_set_id",
	r."number",
	r."branch",
	r."worktree_path",
	p."base_branch",
	r."base_commit",
	r."checks",
	CASE
		WHEN r."failure" IS NOT NULL THEN json_extract(r."failure", '$.phase')
		WHEN r."verdict" IS NOT NULL THEN 'reviewing'
		WHEN r."check_results" IS NOT NULL THEN 'reviewing'
		WHEN r."final_commit" IS NOT NULL THEN 'verifying'
		ELSE 'implementing'
	END,
	r."started_at",
	r."ended_at",
	r."final_commit",
	r."check_results",
	CASE
		WHEN r."verdict" IS NULL THEN NULL
		ELSE json_set(
			r."verdict",
			'$.findings',
			(
				SELECT json_group_array(json_set(f."value", '$.criterion', json('null')) ORDER BY f."key")
				FROM json_each(r."verdict", '$.findings') AS f
			)
		)
	END,
	CASE WHEN r."failure" IS NULL THEN NULL ELSE json_remove(r."failure", '$.phase') END,
	NULL
FROM `delivery_runs` AS r
INNER JOIN `specifications` AS s ON s."id" = r."specification_id"
INNER JOIN `projects` AS p ON p."id" = s."project_id";
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0010_delivery_runs_rows` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0010_delivery_runs_rows` SELECT (SELECT count(*) FROM `delivery_runs`) - (SELECT count(*) FROM `__new_delivery_runs`);
--> statement-breakpoint
DROP TABLE `zenorm_0010_delivery_runs_rows`;
--> statement-breakpoint
UPDATE `__new_delivery_runs`
SET "ended_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "ended_at" IS NULL AND "id" NOT IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "started_at" DESC, "id" DESC) AS "rank"
		FROM `__new_delivery_runs`
		WHERE "ended_at" IS NULL
	)
	WHERE "rank" = 1
);
--> statement-breakpoint
DROP TABLE `delivery_runs`;
--> statement-breakpoint
ALTER TABLE `__new_delivery_runs` RENAME TO `delivery_runs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_one_active_per_project` ON `delivery_runs` (`project_id`) WHERE "delivery_runs"."ended_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_runs_spec_number_uq` ON `delivery_runs` (`specification_id`,`number`);
--> statement-breakpoint
CREATE TABLE `delivery_run_tickets` (
	`run_id` text NOT NULL,
	`ticket` text NOT NULL,
	`position` integer NOT NULL,
	`started_at` text,
	`merged_at` text,
	`commit` text,
	`summary` text,
	PRIMARY KEY(`run_id`, `ticket`),
	FOREIGN KEY (`run_id`) REFERENCES `delivery_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_run_tickets_ticket_ck" CHECK("delivery_run_tickets"."ticket" GLOB 'T[1-9]*'),
	CONSTRAINT "delivery_run_tickets_merged_commit_ck" CHECK(("delivery_run_tickets"."merged_at" IS NULL) = ("delivery_run_tickets"."commit" IS NULL)),
	CONSTRAINT "delivery_run_tickets_summary_length_ck" CHECK(length("summary") <= 1000)
);
--> statement-breakpoint
CREATE TABLE `delivery_run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`who` text NOT NULL,
	`ticket` text,
	`text` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `delivery_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_run_events_who_ck" CHECK("delivery_run_events"."who" IN ('zenorm', 'orchestrator', 'implementer', 'reviewer')),
	CONSTRAINT "delivery_run_events_text_length_ck" CHECK(length("text") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0010_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0010_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0010_foreign_key_violations`;
