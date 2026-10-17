CREATE TABLE `maps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`idea` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `question_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`intro` text NOT NULL,
	`questions` text NOT NULL,
	`answers` text,
	`asked_at` text NOT NULL,
	`submitted_at` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_rounds_answers_submitted_ck" CHECK(("question_rounds"."answers" IS NULL) = ("question_rounds"."submitted_at" IS NULL))
);
