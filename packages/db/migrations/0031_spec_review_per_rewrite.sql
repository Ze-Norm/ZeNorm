-- A draft rewritten in place by an agent (a review repair, a re-clear) keeps its revision row and
-- gathers one review per rewrite, so a revision may have more than one review.
DROP INDEX `spec_reviews_spec_revision_uq`;--> statement-breakpoint
CREATE INDEX `spec_reviews_spec_revision` ON `spec_reviews` (`spec_revision_id`);