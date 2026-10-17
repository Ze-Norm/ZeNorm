-- Planning salience: map changes gain `fogDecided` (fog items the agent decides,
-- each saved as a resolved waypoint) and `fogSettledHere` (fog its own resolution settles). The only
-- stored column that parses map changes is `hatch_messages.change`, whose `fog` holds them on the
-- changes that settle fog. Every stored change was written before either list existed and settled
-- fog through neither, so each `fog` object gets both as empty lists; `json_insert` leaves a list
-- already present as it is. Changes without `fog` (and null changes) are left alone.
UPDATE `hatch_messages`
SET `change` = json_insert(`change`, '$.fog.fogDecided', json('[]'), '$.fog.fogSettledHere', json('[]'))
WHERE `change` IS NOT NULL AND json_type(`change`, '$.fog') = 'object';
