-- Delivery resume: a run pins the commit its branch starts at (the base commit, or the head of the
-- run it resumes) and names the run it resumes. `start_commit` is nullable in SQL, as an added
-- column; every run before this one started at its base commit.
ALTER TABLE `delivery_runs` ADD `start_commit` text;--> statement-breakpoint
ALTER TABLE `delivery_runs` ADD `resumed_from_run_id` text REFERENCES delivery_runs(id);--> statement-breakpoint
UPDATE `delivery_runs` SET `start_commit` = `base_commit`;
