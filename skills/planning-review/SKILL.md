---
name: planning-review
description: "Independently review a spec against the resolutions of its map (spec review), or a ticket breakdown against its spec (tickets review), before the next step starts. Traces every element to its source and reports contradictions, invented scope, undefined terms, dropped resolutions and uncovered clauses. Use when a spec or a ticket breakdown needs checking by someone other than the agent that wrote it."
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

# Planning Review

A **planning review** is an independent check of a planning artifact against its sources, by a fresh agent that did not write it. It replaces the writer's self-audit: [To Spec](../to-spec/SKILL.md) and [To Tickets](../to-tickets/SKILL.md) still account for every commitment while they work, but their own accounting carries no weight. The review is a checkpoint: its findings block the next step until they are resolved.

- The **spec review** sits between `/to-spec` and `/to-tickets`. It checks the current revision of every spec on the map against the map's resolutions. To Tickets doesn't start until a review of those exact revisions passes.
- The **tickets review** sits between `/to-tickets` and the human's breakdown review. It checks the proposed tickets against the spec revisions they implement. The breakdown can't be approved, and no ticket is delivered, until a review of that exact breakdown passes.

This is not the human breakdown review (granularity, blocking edges, merge or split), and not the delivery-time Code Review. Don't judge slicing or code.

## Stance

You didn't write the artifact, and its writer's audit isn't evidence. Read the artifact and its sources in full, form your own view and cite exact wording. Report what is wrong; don't rewrite the artifact, redesign the destination or recommend implementation. An empty findings list is a claim that you traced everything and found nothing, so make it only when that's true.

Report every problem in one pass. Each failed review costs a repair and another review, and an element your review passes stays settled while a repair leaves it unchanged.

## Trace every element

Tracing is the review. Each element either traces to a source or it is **invented scope**.

- **Spec review:** trace every behavior clause, acceptance criterion, testing decision and exclusion of every spec to the resolved decision tickets whose resolutions it carries, or to the confirmed destination. Account for every resolved ticket: it is carried by some element, it deliberately adds nothing to any spec (say why), or it was dropped.
- **Tickets review:** trace every acceptance criterion of every ticket to the spec clauses, criteria, testing decisions or exclusions it carries. A criterion traces only when its clause states what the criterion requires; a criterion that adds detail its clause doesn't state (for example adding a CSV format to a list of export formats when no answer mentioned CSV) is invented scope even if its clause is on the same topic. That includes making vague wording precise: a criterion that turns "a short summary" into "at most 200 characters" invents the number.

For a testing decision, trace the observable guarantee and any testing exclusions to the recorded human answer, delegation or retained agreement. The writer proposes the concrete seam and technique for verifying that guarantee; assess whether those checks demonstrate it, rather than requiring the human to select the harness. A requirement to demonstrate external behavior governs the required evidence; it does not itself exclude additional implementation-detail checks. Enforce a recorded human testing exclusion when one exists, and report a new testing restriction only when the artifact actually adds one.

Every finding names behavior the spec states and the tickets don't carry, or behavior a ticket adds that the spec doesn't state; quote the missing or added words. Don't report how a commitment is carried rather than whether it is: a testing decision (how the checks run, such as through a subprocess or a browser) is carried by a ticket's testing text as well as by its criteria, so report it uncovered only when neither carries it. Don't ask for vague wording to be made measurable; carrying the spec's own words is coverage.

## What to report

Spec review:

- **Contradiction**: an element that contradicts a resolution, another element or another spec.
- **Invented scope**: an element no resolution or destination settles.
- **Term used but never defined**: a term, record or surface the spec relies on that neither it nor any resolution defines.
- **Resolution dropped**: a resolution no element carries.
- **Existing records**: a missing existing-records statement, one its cited answer doesn't support, or one the existing data contradicts, for example by assuming every existing record already satisfies a constraint the change adds. When the destination changes ZeNorm itself, inspect the application records to check. Report a kind or state of record the statement misses, not a count that changed because the map's own planning added decision tickets or specifications.
- **No check can verify it**: an element whose outcome no test or inspection can decide. Two common shapes: an open-ended absence claim ("nothing can create X"; an absence over a finite list the system enumerates is checkable), and behavior an agent triggers by its own judgment with no stated criteria for when ("the assistant escalates when it judges the case is urgent"). Revise when the resolutions supply the mechanism or the criteria; otherwise it is a decision for the human.

Tickets review:

- **Criterion traces to no spec clause**: invented scope in a ticket.
- **Spec clause left uncovered**: a clause or criterion the breakdown marks necessary that no ticket criterion carries.
- **Contradiction**: tickets that contradict each other or the spec.

Quote the wording each finding rests on and name every element, ticket and criterion involved.

## Route each finding

- **Revise** when the sources settle the point and the artifact departs from them. The writer revises: a To Spec revision for a spec, a To Tickets revision for a breakdown.
- **Decision** when the sources don't settle it and the human must decide. It becomes a Grilling ticket on the map, which reopens the map until the human answers.

Phrase every finding's question for the human, even a revise finding: when revisions keep failing review, revise findings go to the human too, so a revision loop ends with a decision rather than another attempt. After two failed repairs against the same sources, every remaining revise finding goes to the human.

## Review a repair

A spec review that follows a failed review over the same resolutions is a re-review. It receives the earlier findings, the elements the repair changed and the elements that are settled: traced without a finding and unchanged since. Check each earlier finding was repaired and check every changed element, including how it fits the settled ones. Don't trace settled elements again or raise a finding that rests only on them; their earlier trace carries forward. Any change to the map's destination, exclusions or resolutions makes the next review a full one.

A tickets review following a failed review of the same breakdown checks changed and reopened criteria in one pass. A criterion traced without a finding stays settled only when its ticket ID, index and text are unchanged. Omit settled criteria from trace; their earlier trace carries forward. Findings must name an unsettled criterion or a specification element left uncovered by a changed or removed criterion or an earlier finding. Retired tickets remove their criteria. A different breakdown, an unchanged re-read, changed governing specification revisions or dispositions, or a prior review without a retained governing basis receives a full review.

## Record the review

Record exactly one result through the supplied review operation, with the full trace and the findings. The service rejects a trace that skips an element, and requires a finding for every element that traces to nothing and every necessary clause no criterion carries. A review of different revisions doesn't count: any new spec revision or breakdown needs its own review.

In the local tracker, write the review as a note on the spec or breakdown listing what was traced and each finding, and chart each decision finding as a Grilling ticket on the map.
