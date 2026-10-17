ALTER TABLE `planning_runs` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `result_subtype` text;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `num_turns` integer;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `total_cost_usd` real;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `cache_creation_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `planning_runs` ADD `cache_read_input_tokens` integer;