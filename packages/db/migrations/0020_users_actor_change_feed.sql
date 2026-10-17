CREATE TABLE `change_feed` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`map_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`op` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_run_id` text,
	`at` text NOT NULL,
	CONSTRAINT "change_feed_op_ck" CHECK("change_feed"."op" IN ('insert', 'update', 'delete')),
	CONSTRAINT "change_feed_actor_kind_ck" CHECK("change_feed"."actor_kind" IN ('user', 'planning_run', 'delivery_run', 'system')),
	CONSTRAINT "change_feed_actor_ck" CHECK(CASE "change_feed"."actor_kind" WHEN 'user' THEN "change_feed"."actor_user_id" IS NOT NULL AND "change_feed"."actor_run_id" IS NULL WHEN 'system' THEN "change_feed"."actor_user_id" IS NULL AND "change_feed"."actor_run_id" IS NULL ELSE "change_feed"."actor_user_id" IS NOT NULL AND "change_feed"."actor_run_id" IS NOT NULL END)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `write_actor` (
	`id` integer PRIMARY KEY NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_run_id` text,
	CONSTRAINT "write_actor_one_row_ck" CHECK("write_actor"."id" = 1),
	CONSTRAINT "write_actor_actor_kind_ck" CHECK("write_actor"."actor_kind" IN ('user', 'planning_run', 'delivery_run', 'system')),
	CONSTRAINT "write_actor_actor_ck" CHECK(CASE "write_actor"."actor_kind" WHEN 'user' THEN "write_actor"."actor_user_id" IS NOT NULL AND "write_actor"."actor_run_id" IS NULL WHEN 'system' THEN "write_actor"."actor_user_id" IS NULL AND "write_actor"."actor_run_id" IS NULL ELSE "write_actor"."actor_user_id" IS NOT NULL AND "write_actor"."actor_run_id" IS NOT NULL END)
);
--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `executor` text;--> statement-breakpoint
ALTER TABLE `maps` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
INSERT INTO `users` (`id`, `created_at`) VALUES (lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
UPDATE `maps` SET `user_id` = (SELECT `id` FROM `users`);
--> statement-breakpoint
UPDATE `planning_runs` SET `user_id` = (SELECT `id` FROM `users`);
--> statement-breakpoint
UPDATE `delivery_runs` SET `user_id` = (SELECT `id` FROM `users`);
--> statement-breakpoint
UPDATE `delivery_runs` SET `executor` = 'local';
--> statement-breakpoint
CREATE TEMP TABLE `zenorm_0020_foreign_key_violations` (`count` integer NOT NULL CHECK(`count` = 0));
--> statement-breakpoint
INSERT INTO `zenorm_0020_foreign_key_violations` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `zenorm_0020_foreign_key_violations`;
