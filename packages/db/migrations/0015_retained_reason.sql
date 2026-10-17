-- Retained reason: a `retained` disposition gains `reason`, like `delivered`'s, so a retained
-- criterion whose text changed since its open carrier was written can say why that ticket still
-- covers it (the tickets review's departure check, S8b-13). The only stored column that parses
-- dispositions is `ticket_set_versions.content`. Every stored retained disposition was written
-- before the field existed and gave no reason, so each gets null: the record that it has none.
UPDATE `ticket_set_versions`
SET `content` = json_set(
	`content`,
	'$.dispositions',
	json((
		SELECT json_group_array(
			CASE json_extract(`disposition`.`value`, '$.kind')
				WHEN 'retained' THEN json_set(json(`disposition`.`value`), '$.reason', json('null'))
				ELSE json(`disposition`.`value`)
			END
		)
		FROM (SELECT `value` FROM json_each(`ticket_set_versions`.`content`, '$.dispositions') ORDER BY `key`) AS `disposition`
	))
)
WHERE json_type(`content`, '$.dispositions') = 'array';
