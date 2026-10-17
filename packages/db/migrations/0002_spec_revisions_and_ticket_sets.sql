CREATE TABLE `spec_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`drafted_at` text NOT NULL,
	`approved_at` text,
	`rejected_at` text,
	`rejection_reason` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "spec_revisions_rejection_reason_ck" CHECK(("spec_revisions"."rejected_at" IS NULL) = ("spec_revisions"."rejection_reason" IS NULL)),
	CONSTRAINT "spec_revisions_single_decision_ck" CHECK("spec_revisions"."approved_at" IS NULL OR "spec_revisions"."rejected_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_one_undecided_per_map` ON `spec_revisions` (`map_id`) WHERE "spec_revisions"."approved_at" IS NULL AND "spec_revisions"."rejected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_one_approved_per_map` ON `spec_revisions` (`map_id`) WHERE "spec_revisions"."approved_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `spec_revisions_map_revision_uq` ON `spec_revisions` (`map_id`,`revision`);--> statement-breakpoint
CREATE TABLE `ticket_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`map_id` text NOT NULL,
	`spec_revision_id` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`drafted_at` text NOT NULL,
	`approved_at` text,
	`rejected_at` text,
	`rejection_reason` text,
	FOREIGN KEY (`map_id`) REFERENCES `maps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `spec_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ticket_sets_rejection_reason_ck" CHECK(("ticket_sets"."rejected_at" IS NULL) = ("ticket_sets"."rejection_reason" IS NULL)),
	CONSTRAINT "ticket_sets_single_decision_ck" CHECK("ticket_sets"."approved_at" IS NULL OR "ticket_sets"."rejected_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_one_undecided_per_map` ON `ticket_sets` (`map_id`) WHERE "ticket_sets"."approved_at" IS NULL AND "ticket_sets"."rejected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_one_approved_per_map` ON `ticket_sets` (`map_id`) WHERE "ticket_sets"."approved_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_sets_map_version_uq` ON `ticket_sets` (`map_id`,`version`);