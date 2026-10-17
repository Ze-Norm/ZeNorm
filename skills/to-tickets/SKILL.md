---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker).
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

# To Tickets

Break a plan, spec, or conversation into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.

Use the supplied tracker/tools and triage vocabulary. For direct work in a repository, the tracker is local files under `<slice-slug>/issues/` in the planning folder the session names (step 5). Product runs publish through ZeNorm's supplied operations as described in the shared integration reference.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

Read linked source documents and prototypes needed to understand the work, including their recorded approvals. Carry each slice's relevant sources forward into its References.

When the project keeps a scope trace and demo screens, read them. Every ticket names the trace rows and demo screens it delivers, so the tickets review checks coverage against the approved bar and not only the spec: a scope cut that only a spec recorded can go unnoticed for several specs. Read the orchestrator rulings the project's decision records hold for this work, quote each in the tickets it binds, and make the ticket's body agree with it; a ticket that contradicts a ruling it quotes is a blocker.

Start only from specs whose current revisions passed a [spec review](../planning-review/SKILL.md). Load the full current and revised specifications, governing decisions, applicable testing agreements, and existing tickets with completion/in-progress evidence. Include all affected specifications when one map-led effort spans several. Preserve Matt Pocock's terminology; agile parallels are explanatory.

### 2. Reconcile intent with actual work

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Compare existing intent, revised intent, actual code, and completed/in-progress work, not just specification text changes. Inspect relevant effort branches when code or evidence is absent from this checkout. Account for every commitment as necessary new/changed work, already satisfied with evidence, covered by retained in-progress work, or explicitly excluded/deferred with authority. A wording change need not create code work, and unchanged prose may still require implementation. Do not create tickets for requirements already satisfied. Keep completed tickets/results immutable; necessary later changes use linked follow-ups. Preserve applicable locks and holds.

When the work rebuilds something that already exists (a screen, a procedure, a flow), list what today's version does that the spec does not mention. A specification describes what changes and can stay silent about what should survive; each such behaviour is either kept by a named ticket or raised in the report as a question, never dropped by omission. A rebuilt screen can lose a list the old one showed this way.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Start with the smallest useful journey through the changed behavior, then extend it with **tracer bullet** tickets. Use specification sections for coverage; choose ticket boundaries around working outcomes and implementation risk.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Establish shared behavioral assumptions where they are first consumed. Units, dimensions, identity, permissions and state transitions can couple otherwise separate features; assign their implementation and verification to an early slice and carry that contract into dependents. A later presentation or polish ticket should preserve these established assumptions.

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. Name the behavior or contract each blocker supplies. A ticket with no blockers can start immediately. Assign integration behavior to a named slice, including interactions between features that their individual checks cannot prove.

Keep regression checks and negative constraints with the behavior they protect. Don't write an open-ended absence test or criterion, such as "nothing can create X": no test can prove it. Checking absence from a finite surface the system enumerates is fine, such as a tool missing from an agent's tool list, a route the server doesn't register, or a caller that is refused. When the spec makes something impossible by construction, the ticket builds that mechanism (the schema constraint, the required argument, the signature) and tests that it rejects the invalid case. A separate verification ticket is appropriate when it has a distinct integration risk or substantial verification scope; explain that boundary. Size slices by unfamiliar integrations, state changes and verification difficulty, including fresh-agent context and repeated setup costs. Every implementation ticket costs a full delivery run: a fresh agent's setup and context load, implementation, the full required checks, and independent review. Weigh that fixed overhead against the work the slice adds. When a slice's own implementation and verification are small next to it (a single error path, one flag, a message or edge case of a behavior another slice builds), fold it into the slice it extends. If the whole approved change fits one fresh delivery run (one fresh context window), the breakdown is exactly one ticket; split only when the change would not fit one run. Merge closely coupled small slices when another handoff buys little; split a large journey at an observable intermediate outcome. Ticket count and one specification heading per ticket are not sizing evidence, and neither is the wish to show separate progress.

**Parallel delivery.** In this repository each ticket is built by a fresh agent in its own worktree, and tickets without a blocker between them run at once. Give every file exactly one owner among tickets that can run together: one first ticket (or a short sequence, one per seam) owns every shared file (contracts, ports and stubs, migrations, `apps/zenorm/src/main.ts`, root `AGENTS.md`, config and e2e fixtures, the lockfile) and leaves the full gate green on merge; the per-package or per-screen tickets then run in parallel on disjoint files, each told to stop and report if a shared file needs a change; the live/e2e ticket (Playwright flows, side-by-side record) goes last. Name each shared file's owner, including the easy-to-miss ones (`playwright.config.ts`, e2e helpers, the lockfile): two parallel tickets that each "just add a helper" to the same e2e file conflict at merge. Keeping parallel tickets free of shared files is a valid reason for that first ticket to stand alone. The first ticket's own tests must not assert on content a parallel ticket will replace (a stub page's text). This shape is for breakdowns with several tickets; a change that fits one delivery run is one ticket that owns every file it touches.

Derived state has one source. Status, next actions and the sentence shown for each blocker or error code are computed once, normally in `core`, and screen tickets render what that source returns; they never build their own action, headline or blocker sentence. Say so in each screen ticket and name the source. Both failure modes happen: a page that invents a "needs you" action core never emits, and separate maps from blocker code to words.

Include routine setup in the first working behavior. A separate enabling ticket needs a concrete justification in the slicing audit: a named uncertainty it resolves, an independently useful capability it delivers, or a specific complexity that would make combining it with the first behavior exceed a fresh context. State what its completion establishes and how that changes the next slice. Being required by every later ticket establishes ordering, but does not by itself justify a separate handoff.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Audit the complete breakdown, then quiz the user

Before presenting it, check the whole proposed and retained ticket set against every specification commitment, including constraints, exclusions, edge cases, testing and completion obligations. Resolve missing coverage, contradictions, duplicate/already-satisfied work, false blockers and cycles. Each slice must have an independently observable result, carried testing expectations, an explicit completion boundary, and its own out-of-scope boundary. Preserve valid pending work and its recorded review instead of regenerating it.

Audit whether every ticket can finish autonomously in the available execution environment. Record audit.execution with status `agent-verifiable` or `blocked`, a concrete environment, and an assessment covering all completion obligations, executable behavioral checks and limitations. Missing or blocked assessments prevent publication. Human play/signoff cannot gate MVP ticket completion; subjective feedback remains advisory. Undefined or unavailable hardware targets and incompatible prior agreements must be reconciled through planning before dispatch. Never relabel an unsupported requirement as verified. Check whether any governing decision can only be met through a costly workaround in this environment (for example, hand-written type declarations standing in for an excluded dependency). Name the decision and the workaround in the assessment and raise it with the user in the review request rather than planning around it silently. Required check commands must be single literal invocations (for example `pnpm --dir game test:browser`), without shell composition or redirection; put multi-step work in a named package script. Keep dependency installation in setup instructions, not the required final-check list.

Scale the written audit to the breakdown. Coverage, blocking edges, testing and boundaries already live in validated fields (dispositions, blockers, each ticket's testing and exclusions); don't restate them in prose. Record how the specifications compare with earlier intent, current code and existing work (one sentence when there is none), the execution assessment, and concerns only when there is something the human should weigh. With one ticket, that is the whole audit. A necessary commitment's owning ticket is its evidence; satisfied, retained and excluded commitments cite their own.

With two or more tickets, substantiate the slicing and dependencies in the audit:

- Compare the proposed ordering with one that delivers the smallest central journey before independent refinements. Name the earliest journey-proving ticket and justify prerequisites by behavioral necessity, integration risk or context size; move independent refinements later when they delay that proof.
- Walk a concrete verification scenario for each ticket using only its declared predecessors and existing code. Include the setup, user input and state changes the scenario requires, and name their owners. Trace shared assumptions from their establishing slice to every consumer; fix missing ownership or blockers exposed by this walkthrough.
- For each boundary, name the new observable outcome and the complexity or independence that warrants a separate agent handoff. Distinct feature names or assertions alone do not justify a split: compare the implementation and verification burden of merging closely coupled neighbors. Distinguish substantial integration verification from checks that belong with a feature. State why each separate ticket's work justifies its own delivery run's overhead; merge any slice whose justification rests only on being a separate case or assertion.

This audit is your working check, not the review. It carries no weight: a fresh [tickets review](../planning-review/SKILL.md) traces every acceptance criterion to the spec clause it carries and checks that no necessary clause is left uncovered before the human can approve the breakdown. Write only criteria the spec states; a criterion that extends a clause with detail no answer mentioned is invented scope. When a tickets review of the presented breakdown failed, repair that breakdown rather than composing a new one: change only what each revise finding names, keep every other ticket, criterion and disposition as it was, then present the repaired breakdown. When a finding says a criterion leaves out part of a clause, carry the clause's own words; don't make vague wording ("a concise error") precise with a threshold, count or limit the spec doesn't state.

Revise the breakdown when this audit reveals deferred foundations, implicit integration work or unnecessary handoffs. Record concrete reasons in the existing audit rather than declaring every slice small or vertical. Titles and completion criteria must describe the behavior actually available at that point.

Publish a concise coverage/disposition record through the supplied reconciliation operation, with governing specification revisions and criterion references, evidence for satisfied commitments, and owners for unmet work. Preserve the returned review state and remaining holds; an assessment does not confer human approval. This can live in the existing breakdown; no new tracking framework is required. Recommendations and changed approval scopes remain explicit.

Present the proposed breakdown through the supplied review interaction, or as a numbered list in a direct repository conversation. In ZeNorm, `request_implementation_review` supplies the ticket list, exact contracts and standard review questions; pass only a brief introduction or a specific tradeoff, without repeating that generated presentation. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Reuse approval for unchanged work. Present new or materially changed slices and dependencies for the existing breakdown review; iterate until that proposed breakdown is approved. When asked only to revise planning documentation, retain unapproved changes as drafts rather than blocking the requested edits or inventing approval.

### 5. Publish the tickets to the configured tracker

Publish the approved tickets through the supplied operations. Retain drafts when review is pending. **How** depends on the active environment; preserve the same substantive contract and relationships:

- **ZeNorm** → create or revise necessary implementation tickets through the supplied tools, referencing the governing specification(s) by ID (the service pins the exact revisions), clauses/criteria, coverage assessment, and breakdown review. Use returned identities to establish genuine blocking relationships. Link later changes to completed predecessors as follow-ups; preserve the original results and governing contracts. Respect returned locks and review holds.
- **Local files** → write one file per ticket under `<feature-slug>/issues/<NN>-<slug>.md` in the planning folder, numbered from `01` in dependency order (blockers first). Each file's "Blocked by" lists the numbers/titles it depends on. Use the per-ticket file template in [tracker templates](TRACKER-TEMPLATES.md): one ticket per file, never a single combined file.
- **A real issue tracker (GitHub, Linear, …)** → publish one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers. Use the platform's native blocking / sub-issue relationship where it has one; otherwise set each ticket's "Blocked by" to the blocking issues. Apply the `ready-for-agent` triage label unless instructed otherwise; the tickets are agent-grabbable by construction.

Blockers identify the dependency frontier; applicable approval, claims, locks, and review holds also determine readiness. In ZeNorm, one delivery run per project runs at a time through the executor chosen by `delivery.executor` (local or a plugin's), and implementer subagents build each ticket frontier in parallel. Publishing a breakdown does not dispatch or orchestrate its execution.

Do NOT close or modify any parent issue.

Each ticket's What to build and acceptance criteria must state its actual contract, relevant testing expectations, completion evidence, and exclusions. When a prototype's recorded approval requires implementation to match it, include checkable acceptance criteria comparing the relevant behavior, appearance, or states against the approved scope.

In References, preserve relevant links to the source spec, decisions, research, architecture documents, and prototypes, with a short note on what each governs or informs for this slice. Identify the selected prototype variant/revision and the recorded approval's scope, linking its record when available. Distinguish exploratory references from requirements; prototypes impose only their approved obligations. Use references that resolve from the published ticket: in ZeNorm, the governing criterion references and each cited map, ticket or specification by kind and ID (the service pins its exact revision; never copy revision IDs by hand), artifact-relative links in local files, and repository permalinks or other durable URLs on an external tracker. Omit References when there are no relevant sources.

The per-ticket local file and issue templates are in [tracker templates](TRACKER-TEMPLATES.md); ZeNorm's tools define the product record.

Implementers already work under the rules in the repository's root `AGENTS.md` (no silent defaults, `Result` error codes, guardrails); refer to it rather than restating it. A ticket adds only what `AGENTS.md` cannot know. The conditions below each came from an incident; put one in a ticket only when that ticket does the thing it names, so a small follow-up with no server, screen, agent call or migration carries just the first two:

- Tests assert error codes, status and tone, never message prose: wording changes freely, codes are the contract.
- The e2e holds fixed port 4600 for its whole run (each worker's own server takes a free port), so parallel worktrees wait on each other there; when another worktree holds it, wait and rerun rather than report a failure.
- A ticket that starts a server (a hand run, a browser check, a side-by-side capture) stops it only by PID or port (`lsof -ti tcp:<port>`), never `pkill -f` or another pattern kill, and never touches the person's own ZeNorm server (the port in their config): a pattern kill can take that server down. Hand runs use a copied config with a scratch `dataDir`.
- A ticket that builds or changes a screen clicks through it in a browser on its own spare port (4320–4329) and compares it with its demo screenshot before finishing, because the web has no unit-test seam and mismatches otherwise surface only in the final review. When the spec has a side-by-side table, the last ticket compares every pair at 1440×900 and commits the record. A change that only moves where a screen reads its data, with nothing visible changing, rests on the existing e2e flows instead.
- The ticket that builds or changes an agent call runs the live test (`test:live`) itself and reports what it found: live runs find what a spec cannot (a live run showed that a subagent's `cd` does not persist). The e2e keeps one stand-in, `apps/zenorm/e2e/fake-claude.ts`, extended for the new call by whichever ticket owns `apps/zenorm/e2e`; the agent ticket names the prompt lines or markers the stand-in will read.
- A ticket whose migration drops or rewrites stored data backs up the person's own database, the database file in the `dataDir` of their config, with `sqlite3 … ".backup …"` and says the person is told before the final merge to `main`, since that merge runs the migration on their database.

What the spec leaves open (an error case it doesn't name, code it doesn't say to delete, a behaviour choice between two readings) goes into your report as a question for the orchestrator; it does not become a decision inside a ticket. A ticket that settles a gap is invented scope, and the tickets review will trace it to no clause.

In every form, avoid implementation file paths or code snippets in What to build: they go stale fast. File ownership for parallel delivery and prior-art pointers are the exception; name them. Durable source-document and prototype links belong in References above. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.
