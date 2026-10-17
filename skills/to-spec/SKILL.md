---
name: to-spec
description: "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

Use the supplied tracker/tools and triage vocabulary. For direct work in this checkout, the repository's own planning records (decisions ledger, slice plan, scope trace, issues) are the tracker; never open the legacy checkout or follow `zenorm-legacy` links. Product runs publish through ZeNorm's supplied operations as described in the shared integration reference.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

Read relevant source documents and prototypes behind the discussion. Preserve their links in References below, and carry agreed behavior into the spec so its contract does not depend on following links.

Load full governing decision/resolution bodies and corrections, relevant research findings, selected prototype revision and actual approval scope, existing specifications, and applicable testing agreements. Map summaries alone are insufficient. Preserve substantive requirements, constraints, exclusions, and edge cases, including unchanged intent from existing specs. Separate agreed behavior from recommendations and unresolved questions.

When the project keeps an approved scope bar or scope trace and an approved prototype, read both, not only the slice or task row. A row is a summary someone wrote while planning; checked only against its own wording, a spec can drop part of the approved bar and every later review, which checks the spec, will miss it. So check every element against the bar and the prototype. Open the spec with one line naming the trace rows and prototype screens it carries, each at its part for this spec, and cite each of them in References by its own file or route, not a folder, so a reviewer can open exactly the screen a clause answers to. Dropping a carried row's part, or pulling in a part a later spec owns, is a scope error either way: the second kind is as costly as the first, because it gets built, reviewed and argued over before its own spec settles it. Annotations the prototype's verdict resolved are requirements. Look at each carried screen and list what is on it: every visible element (button, column, table, badge, empty state) is either specified or named in Out of Scope with the spec that owns it, because the build is compared with the screen side by side and only Out of Scope excuses a difference.

Every spec states what happens to existing records when it ships, in its `existingRecords` statement. When the contract adds, changes or constrains persisted data, account for the data that already exists: when the destination changes ZeNorm itself, inspect the application records the contract touches; for any other project, rely on the recorded answers about its live data. Do not assume a case the evidence contradicts, such as every existing record already satisfying a constraint the change adds. Then either state that no backfill or migration is needed and why (`none-needed`), or describe the backfill or migration and name the behavior clauses that carry it (`migration`), so it reaches implementation tickets. Describe existing records by kind and the rule that applies to each, covering every kind the contract touches, including values an earlier record pinned (what a run started with, a stored name), since a kind left out is one the tickets will guess about; never describe them as counts or lists of current rows: the map's own planning keeps adding decision tickets and specifications while the spec is reviewed, so a count goes stale on its own. Both cite the ticket or map whose human answer settled it; if no answer does, ask before drafting. Use `unaffected`, with its reason, only when the contract adds, changes and constrains no persisted data. A destructive migration (dropping or rewriting columns or rows) states that the live database is backed up before the merge that runs it, since the person's own instance runs it on merge and there is no way back otherwise. The backup is a step in shipping the change, not a product feature: don't add backup code or error codes for it. When a stored value becomes derived, re-examine every constraint written for the stored value against what existing records will derive: a limit that suited typed input can make an existing record unreadable once the value comes from somewhere else.

Reuse agreed specification boundaries and stable identities: one map-led effort may create or update several specifications. Inspect actual code and completed/in-progress work, including named branches when the current checkout is only planning. Reconcile intent without treating existing implementation as automatically correct or proposing its unnecessary replacement. Keep Matt Pocock's terminology; agile parallels do not introduce replacement artifacts.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

MVP implementation completion must be agent-verifiable with the available tools and a named environment. Cover the promised behavior with executable checks, including browser interaction when applicable; a load-only smoke test cannot prove a gameplay journey. Human feedback about feel is advisory, outside ticket completion. Do not invent a human play/signoff gate or an undefined hardware target. If an existing agreed contract requires either, retain the conflict and reconcile it through planning rather than silently dropping it.

When an answer says something must be impossible, specify the mechanism that makes it so, not a negative test: a schema constraint (not null, foreign key, unique, check), a required argument or function signature, or a type that cannot represent the invalid state. Write the criterion as that mechanism ("an invoice's customer is a required column") and test that it rejects the invalid case (the insert fails, the call without the argument does not typecheck). Don't write an open-ended absence criterion such as "no available operation creates X": no test can prove it. An absence over a finite surface the system enumerates is checkable and fine, such as a tool missing from an agent's tool list, a route the server doesn't register, or a caller that is refused.

When an agent's judgment triggers behavior (it decides when to escalate, split, retry or propose something), state the criteria it decides by and what it does at the boundary, so a test can present a case on each side. Carry the criteria from the resolutions; if none states them, ask rather than writing "when it judges it necessary".

When the behavior lives in the UI and its package has no unit-test seam, decide whether to add a component-test harness or rest on browser tests and prototype comparison, and say which; otherwise each ticket decides alone and the logic ends up untested. When verification compares against an approved prototype, state the match rule: what must agree (layout, elements, wording, states) and what may differ (record data, items under Out of Scope), so the side-by-side has a verdict rather than an opinion.

The seams are your proposal; do not ask the human to choose or confirm one. Reuse applicable recorded testing agreement, and retain the resulting expectations with the contract. Trace the observable guarantee to its human answer or delegation and identify the concrete seam as your proposal for verifying it. Required checks demonstrate that guarantee; additional checks remain optional within the agreed scope unless a recorded human answer excludes them.

Check for unanswered required decisions before drafting anything. Every testing decision must cite a submitted human answer, a recorded delegation or a retained agreement; ZeNorm supplies what exists as `testingAuthority` in the assignment. `available` means eligible authority exists, not that it covers the contract. Read every `testingAuthority.guaranteeSources` entry and inventory **all** observable guarantees, constraints, exclusions and unanswered required decisions across every scope before asking. Compare them with the actual selected options, consequences, human notes, delegations and applicable retained agreement. Do not turn every newly noticed edge case or optional agent-proposed check into another human testing decision. When input is needed, ask every currently uncovered guarantee and missing required decision in **one useful round**, grouping related guarantees into questions when helpful. Supply `testingAssessment` with the current map version and each source ID exactly once: enumerate its guarantees, cite an actual `authorityId` plus coverage rationale for settled ones, map every gap to its zero-based `questionIndex` in this batch, and explain why exclusions or optional checks need no new decision. The service rejects incomplete inventories and gaps not represented by a question; the assessment itself is agent reasoning, never human authority. After submission, follow up only for requirements, ambiguities or contradictions introduced by the actual answers, rather than another gap already visible before that round. If none settles the observable guarantees your seams verify, or another required decision has no answer, ask those questions with `ask_questions` first and stop for the answers; do not draft and let a rejected save reveal the gap. Ask about a guarantee in plain language, such as "should X be impossible, or just checked?", never which seam to test at. Asking stays the exception: Wayfinder should already have asked, so when the recorded answers cover the contract, draft directly without a question round.

In a direct repository session, ZeNorm's service operations (`testingAuthority`, `testingAssessment`, `ask_questions`, service-assigned identities, revision state, `ready-for-agent`) do not exist; skip them rather than simulating them. Assign stable clause and criterion ids yourself, cite the recorded agreements (ledger entries, issue answers) where a testing decision needs authority, and save the spec at the path you were given. With no question tool, do not stop: resolve technical questions yourself under the recorded rules and state each as an implementation decision, and list only product or scope questions, each with your recommendation, under Open for the Owner. The owner answers what the product should do; a list of technical questions hands back work the spec exists to do. A record that says a point waits for the owner's confirmation stays open until a later record settles it: list it here rather than deciding it quietly. Where two recorded answers overlap on a case (both could govern it), settle the case in one decision and make every criterion that touches it agree.

3. Write the spec in one pass, about two to three pages (roughly 2,000 to 3,000 words): decisions and criteria, not narrative or user stories. It is read whole by the reviewer and by every ticket writer, so length costs each of them, and a spec that restates its sources invites them to drift apart. Say a thing once, in the section that owns it; cite a source instead of paraphrasing it; give each Out of Scope item one line naming its owner. If the draft runs long, cut restatement before you cut a decision or criterion. Write or revise it using the template below, then publish it through the supplied tools or configured local tracker. Preserve the specification identity and retain the returned revision reference. Give behavior clauses and acceptance criteria stable identities, keep their substantive prose, and attach rationale and scoped source references where the workspace needs to address them individually. Use the service-assigned identities for new elements; retain existing ones when revising their continuing meaning. Distinguish evolving discovery drafts and unresolved candidate revisions from approved build-ready intent through the revision state the service records, not through the spec's content: never write approval, review, readiness or draft status into any section, including Further Notes. Reuse actual human decisions; do not infer approval from synthesis, silence, or a previous revision. Apply `ready-for-agent` only when the applicable decisions and handoff are settled; otherwise retain the draft and its specific unresolved obligations. Preserve previous revisions and the scope of earlier approvals.

A fresh [spec review](../planning-review/SKILL.md) checks every saved revision against the map's resolutions before [To Tickets](../to-tickets/SKILL.md) starts. Its findings come back to you: when a spec review of the current revisions failed, repair each named spec rather than rewriting it, changing only what each revise finding names and leaving every other element as it was, without adding scope no resolution settles. Decision findings go to the human as Grilling tickets; revise once they're answered.

After each saved specification edit, identify the affected work and carry its review/reconciliation references into [To Tickets](../to-tickets/SKILL.md) when reconciliation is requested. Record unresolved review obligations when the request ends at synthesis. Saving the revision does not clear those holds.

Before finishing, account for each governing commitment in the behavior, acceptance criteria, testing decisions, or explicit exclusions, and read each acceptance criterion against the decision it rests on: an unqualified criterion over an ordered or conditional decision is a contradiction. Where outcomes can overlap (two refusals, two states, two codes whose conditions both match one input), name the input that sits on the boundary, decide which outcome it gets and why, and write that case into the criterion itself, so a test written from the criterion alone expects what the decision does. This is your working check while you write, not the review: it carries no weight, and the spec review repeats it independently. Every element must trace to a resolution or the destination; don't add detail no answer settled. Where a selective prototype informed the decision, carry its scoped verdict; missing or exploratory verdicts remain unresolved and impose no invented requirements.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

Usually omitted: the acceptance criteria carry the contract. Include a few only when they explain user value the criteria do not; preserve useful existing stories. Each included user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

Stories are not a required workflow stage or a substitute for a complete behavior contract.

## Acceptance Criteria

Verifiable intended behavior connecting this specification's commitments to implementation tickets and evidence. Include relevant constraints and edge cases whether or not stories are present; preserve stable criterion references when revising a contract.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Each page shows what one read returns: status and next actions are derived once, in the domain, from one snapshot, and the UI renders them; it never builds a state or action the contract lacks. Two separately polled reads of the same state disagree for a refetch, and a page that patches over them, or synthesizes an action because none came back, shows a status the domain never had. A decision that names a tool, dependency or gate step the repository lacks adds it as explicit scope; check the repository's manifests before naming one.

Do NOT include implementation file paths or code snippets. They may end up being outdated very quickly. Durable source-document and prototype links belong in References below; associate them with the relevant clauses and criteria as needed for scoped retrieval.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- The observable guarantees required checks demonstrate, with their human authority and the agent-proposed testing seam
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)
- Verification against an approved prototype where its recorded approval requires it, stating which behavior, appearance, or states must be compared

## References

Relevant decisions, research, architecture documents, and prototypes, each with a durable link and a short note on what it governs or informs. For a prototype, identify the selected variant/revision and the recorded approval's scope, linking the approval record when available. Keep exploratory material distinguishable from requirements; only the approved scope governs implementation and verification.

References must resolve from the published spec: use exact artifact/revision and clause/criterion references through ZeNorm tools, artifact-relative links for local documents, and repository permalinks or other durable URLs for an external tracker. Omit this section when there are no relevant sources.

## Existing Records

What happens to records that already exist when this ships: a backfill or migration carried by named behavior clauses, an explicit statement that none is needed and why, or that the contract touches no persisted data. Cite the human answer that settled it.

## Out of Scope

A description of the things that are out of scope for this spec.

## Open for the Owner

Product or scope questions the recorded answers do not settle, each with your recommendation. Technical questions are resolved above as decisions, not listed here. Omit this section when there are none.

## Further Notes

Any further notes about the feature. Status such as "not yet approved" or "draft" belongs to revision metadata, and commentary about how the planning exercise was run belongs to the conversation; neither is a note about the feature.

</spec-template>
