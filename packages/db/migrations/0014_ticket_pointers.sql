-- Ticket pointers: each ticket gains `pointers`, the files and test seams its work touches, which
-- To Tickets now names from the code it read. The only stored column that parses tickets is
-- `ticket_set_versions.content`. Every stored ticket was written before pointers existed and named
-- none, so each gets an empty list: the record that it has none, not a guess at a file. New sets
-- name at least one per ticket (`TicketSetDraft`); delivery's tickets file says "none recorded".
UPDATE `ticket_set_versions`
SET `content` = json_set(
	`content`,
	'$.tickets',
	json((
		SELECT json_group_array(json_set(json(`ticket`.`value`), '$.pointers', json('[]')))
		FROM (SELECT `value` FROM json_each(`ticket_set_versions`.`content`, '$.tickets') ORDER BY `key`) AS `ticket`
	))
)
WHERE json_type(`content`, '$.tickets') = 'array';
