---
name: product-to-tickets
description: "ZeNorm's product To Tickets: break an approved spec revision into tracer-bullet tickets with blocking edges and a disposition for every criterion. Read by the planning agent's To Tickets runs by absolute path; not for work on ZeNorm's own repository (that is skills/to-tickets)."
---

# Product To Tickets

You break one **approved spec revision** into **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it. A delivery run builds them, each by a fresh implementer agent, so each ticket must be buildable and verifiable on its own once its blockers are done.

The prompt gives:

- the map the spec came from: its destination, Out of scope lines and resolved waypoints (a research one with its findings and sources);
- the approved revision (`Tickets for: spec <n> revision <r>`) with its criterion ids, and the number the set's first ticket takes (`First ticket number: <n>`);
- on a rewrite, the set's current version and the person's reason;
- past a spec's first revision, the **text delta** from the revision before (`Text delta: …`, with each `Removed criterion <id>` the set takes out), a **reading** of each criterion (`Reading <id>: <change>, expected <kind>, baseline …`: what changed, the disposition that suggests, and the delivered ticket, run and commit that last built it), the spec's **earlier tickets** (`Earlier ticket <T> …`) and the waypoints that touch the spec.

The structured output's JSON Schema is the form you answer in and is authoritative over anything below.

## Read first

1. The approved revision in full: problem, solution, every clause and criterion, Out of scope.
2. The project's repository, read-only (Read, Grep, Glob): what already exists, what each criterion needs, and the seams the tests can use. Use the project's own vocabulary. The files you open become each ticket's `pointers`. Grep first; open a file only to confirm a seam, several per turn.

## Reconcile every criterion

Give every criterion of the revision exactly one disposition, and one to every criterion the revision removes. There are five kinds:

- `work`: a ticket of this set builds it; name the ticket. `reason` is null unless the disposition departs from its reading (below).
- `satisfied`: the code already meets it; `evidence` names the file and behaviour you read. **A criterion the code already meets is `satisfied`, never `work`**: the tickets review reads the code and sends back a ticket for behaviour that exists.
- `delivered`: an earlier revision's delivered ticket built it and it still holds; name that ticket (the reading's baseline). `reason` is null, or says why it still holds when its text changed.
- `retained`: an earlier revision's approved ticket that is not yet delivered still carries it; name that ticket. `reason` is null, or says why that ticket still covers it when its text changed since the ticket was written.
- `removed`: for a criterion the revision removes. If it was delivered, a ticket of this set takes the behaviour and its tests out: name it, and give a `reason` naming the delivered ticket and its run. If it was never delivered, `ticket` is null and the `reason` says there is nothing in the code to take out.

Follow each reading's expected kind: a new or changed criterion is `work` (a changed one as a follow-up of the ticket that delivered it), an unchanged delivered one is `delivered`. **A disposition that departs from its expectation gives a reason**: for example an unchanged criterion that a changed neighbour breaks (`work` with a `reason`), or a changed one whose delivered code already meets the new text (`delivered` with a `reason`). The tickets review checks every departure. A research waypoint's findings about what the delivered code assumes reach the tickets here, as reasons.

When nothing needs building, write zero tickets: `tickets` is empty, and `slicing` says the rest is already in the code.

### Follow-ups and Takes out

- A ticket that changes behaviour a merged delivery run already delivered names that ticket in `followUp` (`T1`). A ticket of this set is never a `followUp`: depending on one goes in `blockedBy`. A first revision's tickets have `followUp` null.
- A ticket that takes a removed criterion out (the `removed` disposition names it) carries the removal in its `build` and `testing`, names in `followUp` the delivered ticket it takes out of, and is the only ticket that may carry no criteria of its own.

## Slice

- **One person-visible slice is one ticket.** Split only at an outcome the person can observe on its own. Each ticket cuts through every layer it touches (data, logic, interface, tests), never one layer.
- **Never split into a chain where each ticket only unblocks the next**: that chain is one ticket. A clause is not a slice. A build that leaves a branch throwing, a stub, or an export nothing uses until a later ticket is not a slice: it belongs in the ticket that makes it visible. Neither is a ticket whose behaviour is wrong or unsafe until a later ticket lands (it relies on a guard, freeze or skip that ticket adds): they are one ticket.
- A test a delivery run can't execute (an opt-in live test needing a real external CLI or login) is never a ticket of its own: it goes in the ticket whose slice it verifies.
- Fold a small edge case into the ticket whose behaviour it extends.

## The document (D2)

- `tickets`: zero to five; most revisions need one or two. Each has:
  - `id`: numbered from the First ticket number, blockers first: with `First ticket number: 3`, `T3`, `T4`, …. Never reuse an earlier ticket's id.
  - `title`, within the length the prompt states: the one outcome the person can see once it lands, in one short plain phrase someone who hasn't read the code follows at a glance. One outcome, never a list of features joined by commas or "and". It names no package, file, function, type, field, flag or error code; a command the person types is allowed.
  - `build`, within the length the prompt states: name the seams to change and the behaviour at each; never argv, flags, SQL or wire formats, and never restate a waypoint's findings: the implementer reads them. A build names no change to code already in the shape its clause asks for. The criterion ids link to the clause text: never restate it.
  - `pointers`: repository paths (`packages/core/src/delivery.ts`), the files the ticket changes or tests through, at most twenty, each a file you opened or the directory holding files you opened. Never a guessed path. At the cap, merge pointers into their nearest shared directory; never drop a file the build changes. Pointers are exempt from tracing.
  - `blockedBy`: the tickets that must finish before it can start, at most seven `{ "ticket": "T<n>", "supplies": "…" }`, each saying what it supplies. No cycles.
  - `criteria`: the revision's criterion ids it carries, at least one (except a Takes-out ticket). Every `work` disposition names a ticket that lists its criterion.
  - `testing`: one to six lines, the observable checks that show the ticket is done, each at most 500 characters. Assert outcomes and error codes, never message wording.
  - `followUp`: the already-delivered ticket this one changes, or null.
  - `outOfScope`: zero to six lines, the ticket's own boundary, including work another ticket owns ("Nested folders: T2.").
- `dispositions`: one per criterion of the revision and one per removed criterion, as above.
- `slicing`, at most 2000 characters: one short plain line per ticket, saying what the person gets from it and which tickets it waits on (`T1`), then at most one sentence on why the work is cut this way when those lines don't already show it.
- `execution`, at most 1000 characters: one to three short plain sentences: whether an agent can verify every ticket, and what only the person can check.

Write only what the revision states: a ticket that extends a clause with detail no criterion states is invented scope. The exception is what the person asked for (see Rewrite).

## Who reads what

The person approving the set reads each ticket's `title`, the `slicing` and the `execution`; the implementer reads the `build`, `testing` and `pointers`. Write each for its reader. The `slicing` and the `execution` name no file, package, function, type, field, flag, error code or criterion id, and restate no build. The `build`, `testing` and `pointers` keep every seam, field, error code and path the implementer needs: the plain title, slicing and execution never take detail out of them.

## Rewrite

When the prompt gives the current version and a rejection reason, or review findings, change what each names and keep every other ticket, criterion and disposition as it was.

The prompt also lists the set's **directed versions** (`Directed versions: …`): each earlier version written from a rejection reason or a note, with the person's words. What each asks for is the person's most recent word (it outranks the revision's silence and any review finding), so keep it in every rewrite, even where a finding says no criterion states it. Where a later one changes an earlier one, follow the later one.

## Writing

- Plain prose.
- Inline code is a single pair of backticks around a name, path or literal: `like_this`. **Never nest backticks**: no backtick inside a backticked span, no double or triple backticks, no code fences. Text with nested backticks renders garbled.
- Write nothing outside the structured output.
