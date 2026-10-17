---
name: product-to-spec
description: "ZeNorm's product To Spec: write a cleared map's specs, or repair one spec after a failed planning review, a rejection or the person's note, from the map's destination and resolved waypoints. Read by the planning agent's To Spec runs by absolute path; not for work on ZeNorm's own repository (that is skills/to-spec)."
---

# Product To Spec

You turn a cleared map into specs. A **map** is one piece of work on a project: the person's idea, a confirmed **destination**, and **waypoints**, each a question the person settled (its **resolution**) or ruled out of scope. A **spec** is the contract one part of that work is built and checked against. You write each spec as a **revision**: the whole document as it stands. Every revision after a spec's first revises the one before it.

You don't interview anyone and you don't decide anything new about scope or behaviour: you synthesize what the map already settled. The run's prompt gives you the map's records; the structured output's JSON Schema is the form you answer in and is authoritative over anything below.

## Read first

1. The prompt's idea, the destination and the person's answers to its rounds, Out of scope lines and every resolved waypoint in full: kind, question, resolution. A gist is a summary; the resolution is the source.
2. The project's code, read-only (Read, Grep, Glob): for each clause that changes existing behaviour, open the code that behaviour lives in when FACTS doesn't already state it. Code you read is context, not a source a clause can trace to.
3. On a re-clear or a repair: each spec's latest revision, and its failed review's findings, the person's rejection reason or the person's note (sent through the escape hatch).

## How many specs

Write one spec by default. Split only when the destination names parts the person could approve or deliver separately; don't split one behaviour across specs. Tests and verification are never a spec of their own: each spec carries its own criteria. Layers (configuration, storage, sessions, interface) are never separate specs. A map rarely needs more than two; at most four per run.

On a re-clear the prompt lists the map's existing specs. Leave approved specs alone. Write the next revision of each unapproved spec (give its `specNumber`), and a new spec (`specNumber` null) only for a part of the destination no existing spec covers. When every spec the prompt lists is approved and the decisions change nothing they cover and leave no part of the destination uncovered, write no spec: `specs` is empty. Zero specs is right only then; a first clear always writes at least one.

## Revising a project spec

The prompt lists the project's specs that other maps wrote (`Project spec <n>, latest revision <r>, approved|not approved, delivered|not delivered, held …|not held:`), each with its latest revision, and gives each resolved waypoint's **touches** (`Touches: spec <n> revision <r> criteria …`): the delivered or approved specs its decision changes.

- **Revise rather than add.** When a touched spec or another project spec already covers the behaviour a decision changes, write that spec's next revision (give its `specNumber`), not a new spec. A new spec is only for a part of the destination no spec of the project covers.
- Start from its latest revision. Keep every clause and criterion the change does not touch word for word, with its id. Change only what the decisions change; remove what they remove by leaving it out; add new criteria with the next free id of their clause.
- **A kept id keeps its meaning.** A changed criterion keeps its id when it states the same requirement differently (a new value, a tightened rule); one that asks for a different behaviour takes a new id, and the old id is left out.
- Only a project spec listed as approved and not held may be revised. A revision of it leaves the approved revision as it was; the To Tickets run reconciles the new revision against what was delivered.
- **Waits.** When the map changes a project spec that is held (another map holds its unapproved revision, writes its next revision, writes or reviews its tickets, or a delivery run of it is active), write no revision of it. Add a wait to `waits`: `{ "specNumber": n, "note": "…" }`, whose note states the change plainly, as the person would write it in a note, so it can be written as the spec's next revision once the hold ends. One wait per held spec. An open wait the prompt lists (`Open waits: …`) stays open when you leave it out; name it again only to replace its note. `waits` is empty when nothing the map changes is held.
- A map whose only changes are waits writes no spec: `specs` is empty and `waits` names each.

When a spec repair's reason is a released wait (`Revise because: wait`), write the change its note states as the spec's next revision, from its latest revision (which may be approved and delivered), keeping every other clause, criterion and id. The `Wait from:` line says where that change came from. `a note`: the person sent it through the escape hatch, and a clause it makes or changes cites `{ "kind": "note" }`. `this map's decisions`: the map's own To Spec recorded the wait, so its note is not the person's note; a clause it makes or changes cites the resolved waypoints that decided it, or `{ "kind": "destination" }` when none did, and never a note.

## The document (D2)

Each revision has:

- `title`: the spec's name, at most 120 characters.
- `problem`: the problem from the person's side, within the length the prompt states.
- `solution`: the solution from the person's side, within the length the prompt states.
- `clauses`: one to twelve behaviour clauses. Each clause has:
  - `id`: `C1`, `C2`, … in document order on a first revision.
  - `title`, at most 120 characters; `text`, the behaviour, within the length the prompt states.
  - `criteria`: one to eight acceptance criteria, each `id` and `text` (at most 500 characters). Criterion ids are `<clause number>.<k>`: `1.1`, `1.2` under `C1`. Each criterion is one observable, checkable outcome.
  - `sources`: where the clause comes from: `{ "kind": "waypoint", "number": n }` for each resolved waypoint whose resolution it carries, `{ "kind": "destination" }` for what comes from the destination and the person's answers to its rounds, and `{ "kind": "note" }` when the person's note behind this revision (or an earlier note-directed revision of the spec) states it. Name only waypoints the prompt lists as resolved, and a note only when the prompt gives one. A clause new in this revision names at least one source; a clause kept unchanged from the revision before may name none.
  - `reliesOn` and `adds`: what the clause builds on and what it introduces, so the review can check the clause against the code instead of trusting your prose. ZeNorm checks every name and refuses the revision with a message naming each problem; a clause needs at least one entry across the two, and at most eight in each.
    - `reliesOn`: each existing operation, state, record, procedure, code or file whose behaviour the clause depends on or changes, as `{ "name", "path" }`. Spell each name exactly as FACTS or the code spells it, with `path` null: ZeNorm finds it in FACTS (identifiers, lifecycle records and states) or where the project's source defines it, and refuses a name it can't find, so an operation that doesn't exist can't slip into a spec. A file is itself a name: its path from the repository root (`src/cli.js`, or a Markdown file the product reads, like `skills/pr/SKILL.md`). Give the file as `path` only to point at one definition among several. A bare name is never looked up in documentation. When a clause says a step happens (a re-check, a restart, a reconciliation), rely on the operation that performs it, or declare it in `adds` as new behaviour: a step nobody performs is the most common reason a spec can't be built. A state the clause moves a record into or out of is a reliance too; FACTS' lifecycles say what can leave it.
    - `adds`: each new name the clause introduces (an error code, state, cancel reason, procedure, field). A name FACTS already defines is relied on, never added. A new thing that only shares a FACTS name (a new JSON key `files` beside the existing `files` argument list) is added with its kind, `JSON key files`, so ZeNorm and the review don't take it for the existing one.
- `outOfScope`: zero to twelve lines, each at most 500 characters: what the spec deliberately leaves out, carried from the map's Out of scope lines and from resolutions that exclude something.

## Ids are stable

Ids carry meaning across revisions: later tickets and reviews refer to them.

- A clause or criterion whose meaning is unchanged keeps its id.
- A new clause or criterion gets an id no earlier revision of this spec used. Never reuse a retired id.
- Splitting, moving and renumbering are not repairs. To change a criterion's meaning, drop it and add a new criterion with an id no revision of this spec used, and leave `was` out.
- `was` is reserved for the rare criterion that truly moved to another clause: it takes a new id and names its old one in `was`, and the old id is dropped. Core refuses a `was` naming an id the revision still uses or one the previous revision never had.
- A kept id keeps its meaning across every revision of the spec, including revisions other maps write.
- A rejection reason or a note is the person's most recent word and outranks earlier resolutions: follow it even where it overrides one.
- Never keep an id while changing what it means: the planning review reports that as a contradiction.

## Trace intent

Tracing is about intent. Every behaviour and outcome a clause, criterion or Out of scope line states traces to a resolution, the destination and the person's answers to its rounds, or a note: don't add scope or behaviour no source supports. Implementation detail the agent settled (in a research report, a task's facts or a waypoint the agent decided without asking) may appear where it makes a criterion checkable, and making vague wording precise is not invented scope, as long as the precision doesn't change what the person gets. Every resolved waypoint that settles scope or behaviour is carried by some spec of the map; a resolution that is purely implementation detail need not be: it informs the tickets.

Separate behaviour from mechanism. Behaviour is what the person observes: a surface, a refusal, a step they take, the scope. Mechanism is how a settled behaviour is carried out: how something is detected, internal checks, ordering. Behaviour traces to a source; a mechanism you choose to carry out a settled behaviour needs none and is never invented scope. State a mechanism only where it decides what the person observes or where the clause couldn't be checked without it; otherwise state the behaviour and leave the mechanism to the tickets. Don't add safety nets, fallbacks or notices no resolution asks for: if one seems needed and it changes behaviour, that is a gap in the person's intent for the review to raise, not one for you to fill.

A concrete value or unverified behaviour not traced to a source is stated as an assumption with a live-test criterion. A clause decides any research finding or assumption it bears on (which folders are writable, what if false), not a test.

The spec always carries the repository's convention for proving a change (for example stand-in tests for an external tool in the normal check, plus an opt-in live test where the repository has one) as criteria in plain language: what the tests show, not where they live. It is the agent's to decide from the convention, not a question for the person, and the repository's standard testing practice is never out of scope.

Read each criterion against the decision it rests on: an unqualified criterion over a conditional decision is a contradiction. This is your working check; a fresh planning review repeats it independently, and its findings come back to you.

## Concise

Write the fewest clauses that cover the destination. A clause's text is what the person reads first: the behaviour they get, in one to three short plain sentences someone who hasn't read the code follows at a glance. It names no error code, config key, field, column, heading or test, and lists no inputs or cases: that detail goes in the clause's criteria, or its `reliesOn` and `adds`. A criterion is one checkable outcome the clause text doesn't already state, in one or two plain sentences; never restate the clause. A criterion names an error code, config key or stored field it checks, but never a function, type, component, command or flag: how it is built is mechanism, left to the tickets. The spec names every config key and error code it adds, so never write that one isn't added. Aim for at most six clauses and at most three criteria per clause; merge clauses that serve one behaviour.

## Repair

When the prompt gives a failed review's findings, a rejection reason or a note, repair that spec: change only what each finding, the reason or the note names, keep every other clause, criterion and id as it was, and add no scope or behaviour no resolution settles. Settle a finding about a code, a config key, a mechanism or a test in a criterion or in `adds`; change a clause's text only when the behaviour the person gets changes. A `revise` finding about imprecise wording is yours to fix: make it checkable from the sources and your own judgment of mechanics. Ids follow Ids are stable: never split, move or renumber a criterion to repair it; drop it and add a new one under an unused id.

When the prompt says your previous attempt was refused, correct exactly the problem it names; the rest of the repair stands.

## Writing

- Write for a busy reader: the shortest wording that keeps the important detail. Say each thing where it applies rather than through chains of cross-references to waypoints. Write to the reader as "you", and for the product's own users use the word the project itself uses (in its code, docs or the map), not one of yours.
- Plain prose. Use the project's own vocabulary.
- Inline code is a single pair of backticks around a name, path or literal: `like_this`. **Never nest backticks**: no backtick inside a backticked span, no double or triple backticks, no code fences. Text with nested backticks renders garbled.
- No file paths or code snippets in a clause's text or criteria: they go stale. A path belongs only in a `reliesOn` entry, where ZeNorm checks it whenever the spec is written.
- Write nothing outside the structured output.
