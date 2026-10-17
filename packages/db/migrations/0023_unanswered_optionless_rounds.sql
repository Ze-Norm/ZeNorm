-- Unanswered option-less rounds: a stored question has 2 to 4 options, so a round holding an
-- option-less question that was never submitted (pending, or withdrawn by a reopen) is deleted; no
-- row references a round and nobody answered it. A submitted one is not rewritten: it fails to load,
-- loudly.
DELETE FROM `question_rounds`
WHERE `status` <> 'submitted'
	AND EXISTS (
		SELECT 1 FROM json_each(`question_rounds`.`questions`) AS `question`
		WHERE json_array_length(`question`.`value`, '$.options') = 0
	);
