# Tracker templates

Templates for publishing To Tickets output outside ZeNorm, referenced from [To Tickets](SKILL.md). ZeNorm product runs publish through the supplied tools instead.

<local-ticket-template>

# <NN> <Ticket title>

Blocked by: each blocking ticket and what it supplies, or "none". Say which tickets run in parallel with this one and which run last.

The orchestrator rulings binding on this ticket, quoted (omit when none). Files this ticket owns or may touch; for parallel tickets, "touch nothing another ticket owns; if a shared file needs a change, stop and report". A lone ticket says it owns what it touches and needs no more.

## What to build
The end-to-end behaviour, citing spec decisions; agrees with every quoted ruling.

## Acceptance criteria
- Each criterion, including the gate one, leads with the spec criterion ids it carries (a decision id when no criterion fits), then the scope-trace rows and demo screens. A criterion no id backs is invented scope; drop it or raise it in the report.

## Testing and completion
The tests at the seams the spec names, then the required checks as literal commands. Plus only those ticket conditions from [To Tickets](SKILL.md) step 5 that this ticket's work triggers.

## Out of scope
Boundaries, naming the ticket or slice that owns each.

## References
Spec sections, ledger rows, waypoints, demo screens and prototype files, each with what it governs.

</local-ticket-template>

<issue-template>

## Parent

A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Testing and completion

Observable checks/evidence needed to complete this slice, reusing applicable testing agreements.

## Out of scope

Explicit boundaries, including behavior already satisfied or owned by another ticket.

## References

Relevant source links and their scope, as described above.

## Blocked by

- A reference to each blocking ticket, or "None (can start immediately)".

</issue-template>
