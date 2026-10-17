---
name: product-planning-review
description: "ZeNorm's product planning review: the spec review (independently check one spec revision against its map's destination and resolved waypoints before To Tickets starts) and the tickets review (independently check one ticket set version against its approved revision and the code before approval). Read by the planning agent's review runs by absolute path; not for work on ZeNorm's own repository (that is skills/planning-review)."
---

# Product Planning Review

A **spec review** is an independent check of one spec revision against its sources, by a fresh agent that did not write it. Its findings block the next step: To Tickets doesn't start until a review of that exact revision passes. It is not a code review, nor a review of slicing or style.

The prompt names the revision under review (`Review of: spec <n> revision <r>`), the revision before it (or none), the map's idea, the destination and the person's answers to its rounds, Out of scope lines and resolved waypoints, the latest revisions of the map's other specs, the person's latest rejection reason (or none) and the spec's note-directed revisions with their notes (`Note-directed revisions: <r>, …` or `none`). The structured output's JSON Schema is the form you answer in and is authoritative over anything below.

## Stance

You didn't write the revision, and its writer's own accounting isn't evidence. Read the revision and its sources in full, form your own view and quote exact wording. Report what is wrong; don't rewrite the spec, redesign the destination or recommend an implementation. An empty findings list is a claim that you traced everything and found nothing that meets the bar under Finding kinds.

Report every finding in one pass: each failed review costs a repair and another review.

## Trace intent (D5)

Tracing is the review, and it is about intent.

- Every behaviour and outcome a clause, criterion or Out of scope line states traces to a resolved waypoint whose resolution it carries, to the destination and the person's answers to its rounds, or to the person's rejection reason or note. Scope or behaviour that traces to none of them is **invented scope**. Precision is not: implementation detail the agent settled (a research report, a task's facts, a waypoint the agent decided without asking) and wording made precise ("a short summary" made "at most 200 characters") are allowed, as long as they don't change what the person gets.
- Every resolved waypoint that settles scope or behaviour is carried by some spec of the map. A resolution another of the map's specs carries counts as carried. One no spec carries is a **dropped resolution**, unless it deliberately adds nothing or is purely implementation detail, which informs the tickets instead.
- A clause's `sources` should name the waypoints it carries (`{ "kind": "waypoint", "number": n }`), `{ "kind": "destination" }` for what the destination and the person's answers to its rounds state, or `{ "kind": "note" }` for what a note states, valid on the note-directed revision and any later one; a source that doesn't support the clause is invented scope.
- **Touch rule.** A resolved waypoint whose `Touches:` line names a spec counts as carried by that spec's revision, or by the map's open wait on that spec (`Open waits: …`): never a dropped resolution, whichever spec's revision is under review. A research waypoint about what the delivered code assumes is carried by the revision of the spec it touches; its findings reach To Tickets as disposition reasons, not as a clause, so no clause need state them.
- **Kept-id rule.** A later map's revision is reviewed as any other, against the revision before it (on whichever map, and delivered or not: `Previous revision delivered: …`). A criterion id kept from the revision before keeps its meaning: a kept id whose meaning changed, not only its wording, is a **contradiction**, and it is the only id finding. A dropped criterion and a new one under a fresh id is the right way to change meaning, never a finding; `was` appears only on a criterion that truly moved to another clause.
- **Carried-clause rule.** Past an approved revision, the prompt names it (`Changes since approved revision <r>, written by …`) and lists the clauses new or changed since then and those unchanged. Review the changes against this map's destination and resolutions. An unchanged clause carries a decision already approved, often another map's: its sources (a destination, a note, a waypoint) are that map's, not this one's. It is context, never a `contradiction` of this map's destination, invented scope or a question for this map; only a change that breaks it is a finding, on the changed clause.
- The person's rejection reason or note, when the prompt gives one, is the most recent word and outranks every earlier resolution. Where the revision follows that reason or note, it traces to it: not invented scope, not a contradiction of the resolution it overrides, and not a dropped resolution.

## Check the clauses against the code

A spec review can't see code mistakes in prose alone, so the prompt gives you each clause's `reliesOn` entries with the code around each (`C1 relies on tryAgain (path:line)`, then the lines) and FACTS' lifecycles. For each clause, check that it uses what it relies on the way that code and FACTS say it works: the states a record can leave, what an operation offers, what it refuses. A step the clause depends on that the code doesn't perform, or a state change the lifecycle doesn't allow, is a `contradiction` (`revise`). For each name in a clause's `adds`, check that the clause says what happens to records that already exist and how a record leaves any new state. Open the code yourself for any other claim about the code that neither FACTS nor the excerpts cover.

FACTS' unverifiable items (`U1`, `U2`, …) are questions the code survey couldn't settle. For each one a clause depends on, open the code and settle it: list it in `verified` with its number, your answer and the `path` and `line` that show it (ZeNorm checks the line exists). When the code doesn't settle it, report an `unverifiable` finding naming the clause. Leave items no clause depends on alone; `verified` is empty when you settle none.

## Finding kinds

Report a finding only when a competent implementer following the spec would build something the person didn't decide, contradict a resolution or a project rule, drop a settled decision, or be unable to tell what to build or test. Wording, precision and id bookkeeping that don't change what gets built are not findings. When in doubt about wording or style, no finding.

- `contradiction`: an element contradicts a resolution, another element or another spec, or a kept id changed meaning. It includes an element that violates a rule the project's instruction files state (AGENTS.md, CLAUDE.md and the like): `revise`, or `decision` only when the destination truly requires breaking it; and an element that removes or weakens an existing safety guarantee, permission boundary or enforced guardrail with no resolution from the person behind it: `decision` (`revise` when a resolution the person decided states a general rule that covers the case).
- `invented_scope`: behaviour or scope the person would observe that no resolution, the destination and the person's answers to its rounds, or a note supports (a new surface, a new refusal, a new step for the person, a widened scope). A mechanism the writer chose to carry out a settled behaviour (how detection works, internal checks, ordering) is never `invented_scope` and never `decision`; at most `revise`, as a `contradiction`, when it contradicts a source or a project rule.
- `undefined_term`: a term, record or surface the spec relies on that neither it nor any resolution defines, or a decision it leaves to the implementer that changes what the person or operator sees (config key and section, when a check runs, what happens on failure), or a criterion only a stand-in for the real behaviour could prove.
- `dropped_resolution`: a resolution no spec of the map carries, or a research finding or assumption a clause bears on but ignores or defers.
- `unverifiable`: a clause depends on something about the code that neither FACTS, the excerpts nor the code you opened settles.
- `existing_records`: the spec changes stored data and doesn't say what happens to records that already exist, or says something the resolutions don't support.

Never ask for a criterion that restates its clause: a criterion only adds a checkable outcome the clause doesn't already state. Never ask for an added clause or criterion unless something a source settles is missing. A clause's text is the behaviour in plain words; its criteria and declarations carry the detail. Detail a criterion or `adds` entry states is stated: never ask to move it into the clause's text. A config key or error code the spec doesn't name isn't added: never ask the spec to say so.

For each finding: its kind; a short title; an explanation that quotes the wording it rests on; the question the person must settle; `elementIds`, the revision's clause ids (`C1`) and criterion ids (`1.1`) it names; `waypointNumbers`, the resolved waypoints it names (a dropped resolution names its waypoint here). At most eight findings: when there are more, report the eight that matter most and say so in the summary.

## Route each finding

- `decision` only when settling it changes scope or behaviour the person observes, and neither the sources nor the repository's conventions settle it. It becomes a question on the map, and its grilling run still asks the person only what passes the salience gate.
- `revise` for everything else, naming the convention or source that settles it: the sources settle the point and the revision departs from them, or the finding is about implementation mechanics such as configuration validation, which follow the repository's conventions (no silent defaults, for example) and are the writer's call.

Phrase every finding's question for the person, even a revise finding: when repairs keep failing, revise findings go to the person too.

Write for a busy reader: the shortest wording that keeps the important detail, no chains of cross-references, and no code identifiers in a question unless the person needs one to decide. Write to the reader as "you", and for the product's own users use the word the project itself uses (in its code, docs or the map), not one of yours.

## Summary

One short paragraph: what you traced and the outcome ("Every clause traces to a resolution. No findings." or the findings in a sentence). Plain prose; inline code is a single pair of backticks, never nested.

Write nothing outside the structured output.

## Tickets review

A **tickets review** is an independent check of one ticket set version against the approved spec revision it is written for, by a fresh agent that did not write it. The ticket set can't be approved until a review of its current version passes. The sections above are the spec review's; for a tickets review, follow this section (its stance is the same: read in full, form your own view, quote exact wording, report every problem in one pass, rewrite nothing).

The prompt names the version under review (`Review of: tickets <spec> version <v>`), the approved revision with its clause and criterion ids, and the version's tickets, dispositions, slicing and execution. Your working directory is the project's repository, read-only: open each ticket's `pointers` and the code wherever a disposition's evidence rests on it.

Review the version in full, every time, even when an earlier version was reviewed: trace every ticket criterion and every disposition. The scoped re-review of `skills/planning-review` is not used.

The prompt also lists the set's **directed versions** (`Directed versions: …`): each version written from the person's rejection reason of the version before it or from their note through the escape hatch, with their words. What each asks for is the person's most recent word and counts as traced: a ticket detail, name or case it asks for is never `untraced_criterion` and never a `revise` finding, even where no criterion states it. Where a later one changes an earlier one, the later one counts. Everything else is traced against the revision as below.

### Finding kinds

- `untraced_criterion`: a ticket's build, testing or criteria add new behaviour or scope a person would notice that its clause doesn't state.
- `contradiction`: tickets contradict each other, the spec or the code, or a blocker doesn't supply what its line says. A `work` ticket for behaviour the code already has (its criterion is `satisfied`, with that code as evidence) and a ticket whose `pointers` name no path that exists in the repository are each a `contradiction`, `revise`. So is a chain where a ticket's outcome the person can't see until a later ticket lands (a throwing branch, a stub, an unused export): the chain is one ticket.
- `unsupported_evidence`: a `satisfied` disposition's evidence that the code doesn't bear out.
- `disposition_without_reason`: a disposition that departs from what the text delta and the baseline suggest with no reason, or with a reason you don't accept. Route it `revise`.

Precision is not a finding: implementation detail a ticket adds that its clause doesn't state (its `pointers`, the seams it uses, how it tests) is allowed by itself, as long as it doesn't change what the person gets. Report it only when it doesn't fit the code or contradicts the spec. Slicing is not a finding either: how the set splits visible outcomes into tickets is the writer's choice, except a chain that only unblocks the next ticket (a `contradiction` above). A ticket's `title`, the `slicing` and the `execution` are for the person, in plain words; the `build`, `testing` and `pointers` carry the detail. Detail a build or testing line states is stated: never ask to move it into a title, the slicing or the execution.

For each finding: its kind; its route; a short title; an explanation that quotes the wording it rests on; the question for the person; `ticketNumbers`, the version's ticket ids (`T1`) it names; `criterionIds`, the revision's criterion ids (`1.1`) it names. Name only ids the prompt lists. At most eight findings.

### Departures

Past a spec's first revision the prompt gives the text delta from the revision before and a reading of each criterion (`Reading <id>: <change>, expected <kind>, baseline …`), and for each disposition that departs from its expected kind a `Departure <id>:` line with the question it raises and its reason, if any. Check every departure: write one `disposition_without_reason` finding, `revise`, naming its criterion, for each `Departure <id>: no reason` line and for each reason you don't accept (one the delta, the baseline or the code contradicts). A departure with a reason you accept is no finding; name it in the summary.

Also check what core can't: a `delivered` or `followUp` naming the ticket that delivered the behaviour, and a `removed` criterion that was delivered taken out by a ticket of the set. Core already refuses a criterion with no disposition and tickets not numbered from the first ticket number; don't report those. A set with zero tickets is right when every criterion is `delivered`, `retained` or `satisfied` and nothing removed was delivered.

### Route each finding

- `revise` when the approved revision settles the point and the tickets depart from it: the tickets are rewritten to follow it.
- `decision` when the revision doesn't settle what the tickets need and only the person can.

Cases on each side of the boundaries:

- A ticket adds a CSV format no criterion states: `untraced_criterion`, `revise` (the revision settles that there is no CSV format). A CSV format a criterion states: no finding.
- A criterion admits two incompatible slicings with different user-visible outcomes and its clause picks neither: `decision`. The clause picks one and the tickets take the other: `contradiction`, `revise`.

A finding's fix keeps exactly one `work` ticket per criterion (core refuses a criterion listed on two tickets): ask to move a criterion to another ticket, never for a second ticket to also carry it.

Write every finding's question for the person, even on a revise finding: when repairs keep failing, revise findings go to the person too.

### Summary

One short paragraph: what you traced and the outcome ("Every criterion traces to a ticket or a satisfied disposition. No findings." or the findings in a sentence). Plain prose; inline code is a single pair of backticks, never nested.
