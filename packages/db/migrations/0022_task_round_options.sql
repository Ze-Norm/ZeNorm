-- Task round options: every question has 2 to 4 options, the first the recommendation; a Task
-- round no longer asks in words alone. A claimed waypoint whose pending round holds an option-less
-- question returns to `open`, so a fresh Task run asks it again with options; 0023 deletes the round.
UPDATE `waypoints`
SET `status` = 'open'
WHERE `status` = 'claimed'
	AND `id` IN (
		SELECT `waypoint_id` FROM `question_rounds`
		WHERE `status` = 'pending'
			AND EXISTS (
				SELECT 1 FROM json_each(`question_rounds`.`questions`) AS `question`
				WHERE json_array_length(`question`.`value`, '$.options') = 0
			)
	);
