# ZeNorm language

Matt Pocock's workflow terminology remains canonical. Agile parallels explain familiar concepts without renaming artifacts or adding a second workflow vocabulary.

## Planning

**Discovery draft**:
Evolving intent, questions, and proposed behavior during discovery, without the authority of an approved build-ready specification revision. This describes content's state, not another workflow stage or artifact type.
_Avoid_: Approved specification

**Destination**:
The outcome an effort is finding its way toward; it fixes the scope and completion boundary of its map.

**Map**:
An index of an effort's destination, decisions, remaining uncertainty, and excluded work, linked to the waypoints that hold the detail and to the specifications it informs. It is a working record that changes in place, without revisions. A map-led effort is comparable to an agile epic; the map remains the canonical artifact and may inform multiple specifications.
_Avoid_: Specification, implementation plan

**Project**:
The git repository that its maps plan and deliver against, added explicitly by a person. Every map is created inside exactly one project and works in that project's folder.
_Avoid_: Workspace, organization, map group, working directory

**User**:
The person a human action is recorded against: answers, approvals, claims, annotations, and the delivery runs they start. A self-hosted installation has exactly one.
_Avoid_: Account, member

**Actor**:
The User or agent run a recorded change is attributed to. An agent run's changes also name the User who started it; for automatic work, that is the person whose action made the run eligible.
_Avoid_: Author, owner

**Waypoint**:
A bounded question or investigation on a map, typed as Research, Grilling or a Wayfinder task in the first release, with Prototype deferred. It changes in place, without revisions, can be reopened, and resolves to the same shape whatever its type; Research and Task keep their evidence in their own records.
_Avoid_: Decision ticket, wayfinding ticket, ticket, implementation task

**Question round**:
The set of questions a planning run asks a person at once on a waypoint (or, during charting, on the map), each with its options and recommendation; answered as a whole and never edited after.
A map-level round, on the destination, is a destination round: the first, then up to two follow-up rounds.
_Avoid_: Form, survey, interview step

**Discussion history**:
The retained questions, human answers, and exchanges associated with a map or waypoint.
_Avoid_: Resolution, agent context

**Resolution**:
The recorded answer that closes a waypoint, with pointers to its supporting evidence.
_Avoid_: Discussion history, unconfirmed recommendation

**Gist**:
The one line a resolution contributes to the map's Decisions so far.
_Avoid_: Summary, headline

**Planning run**:
One agent session with one purpose on a map: charting, a waypoint, the consistency pass, writing or reviewing a specification or ticket set, or replying through the escape hatch. It starts fresh and ends when it saves its outcome, asks a round, fails or is cancelled.
_Avoid_: Interaction, session, conversation

**Agent run**:
A planning run or one of a delivery run's sessions (the orchestrator, the independent reviewer); the record that carries a model and its token usage.
_Avoid_: Job, worker

**Change feed**:
The sequenced record of every committed write in a project, carrying the entity, its new version and the Actor; delivered live, kept only until every open stream has been sent it, and never read to decide.
_Avoid_: Event log, audit log, activity log

**Consistency pass**:
A fresh agent run, before a map clears, that compares every resolution against every other for conflicting surfaces, undefined terms and decisions that assume a deferred case; each finding becomes a Grilling waypoint.
_Avoid_: Self-check, audit

**Planning review**:
A fresh agent run, independent of the one that wrote it, that traces a specification to the map's resolutions (spec review) or a ticket set to its specification (tickets review); its findings block To Tickets or approval until revised or decided.
_Avoid_: Self-audit, breakdown review

**Reconciliation**:
An agent’s comparison of retained specification inputs with current planning, and of the intended contract with current code and delivery evidence. Changed requirements return for human review; unchanged intent can be cleared with the comparison retained.
_Avoid_: Restarting an agent, deleting history

**Artifact revision**:
A saved version of a specification's content; earlier versions remain part of the same specification's history. Every revision after the first revises the one before, and each names the map that wrote it. A new revision follows only a person's act on the one before (approval, rejection or a note); until then an agent's rewrite of a draft (a review repair, a re-clear) replaces the draft's content in place, and the draft keeps its number. Maps, waypoints and tickets are not revisioned.
_Avoid_: Replacement artifact, discussion message

**Wayfinder task**:
Mechanical work needed before a decision can be made, represented by the canonical `wayfinder:task` waypoint type. It resolves from a recorded outcome, what was done and the resulting facts; a task that needs the person asks for it as a question round.
_Avoid_: Implementation task, separate Prerequisite artifact type

**Frontier**:
The open, unblocked, unclaimed waypoints available to work now.

**Fog**:
In-scope uncertainty whose questions are not yet precise enough to become waypoints.
_Avoid_: Backlog, out of scope

## Delivery

**Specification**:
A durable, revisioned intended-behavior contract belonging to a project. Each revision retains the destination, exclusions and resolved decision answers it was written from; a later map may write the next revision of a spec an earlier map delivered.
_Avoid_: Map, discovery draft

**Approved specification revision**:
A specification revision whose intended behavior has the applicable recorded human agreement and is ready to govern implementation; approval is scoped to that revision and agreement.
_Avoid_: Automatically approved saved edit

**Specification basis**:
The small snapshot of planning inputs retained with a specification revision. A change to current inputs signals that review is needed; an agent determines whether the contract must change.

**Text delta**:
What a specification revision changes from the one before, derived from the stable identities of its behaviours and criteria: new, changed, moved, removed and unchanged. It describes the text, not the work the code needs.
_Avoid_: Change list, diff of the work

**Baseline**:
What the delivered code does for each criterion of a specification, read from the delivery runs that carried it.
_Avoid_: Current revision, text delta

**Disposition**:
The recorded judgment, made for each criterion when a revision is approved, of what the code needs: work by a named ticket, carried over from a delivered ticket, retained by an open ticket, already done with evidence, or removed and taken out by a ticket. A disposition that departs from the text delta and baseline carries its reason.
_Avoid_: Coverage, status

**Wait**:
A map's recorded block on changing a specification whose latest revision another map holds unapproved or under an active delivery run; released when that revision is approved or the run ends.
_Avoid_: Lock, hold, conflict

**Ticket set**:
The tickets written for one approved specification revision, together with its dispositions, slicing and execution assessment; reviewed and approved as a whole, and immutable once approved.
_Avoid_: Breakdown (as a record), task list

**Ticket set approval**:
The human’s agreement to a whole ticket set at a reviewed version, including its content, dependencies and governing specification revision. A changed set needs review again; a started run retains its approved inputs.
_Avoid_: Breakdown approval, per-ticket approval, inherited approval for changed work

**Internal version**:
A concurrency counter for a mutable map, waypoint or ticket. It does not identify retrievable historical content; snapshots, submitted human rounds and retained delivery inputs provide that evidence.
_Avoid_: Artifact revision

**Story**:
An optional grouping of user value downstream of discovery, connecting specification intent with acceptance criteria.
_Avoid_: Waypoint type, mandatory stage

**Behaviour**:
A clause of a specification, with a stable identity across the specification's revisions, that states one intended behavior and carries its acceptance criteria.
_Avoid_: Rule, requirement

**Acceptance criterion**:
A verifiable statement of intended behavior connecting specification intent, implementation coverage, and evidence.
_Avoid_: Implementation checklist

**Ticket**:
The unit of implementation work: necessary changes determined from existing and revised intent, actual code, and completed or in-progress work, with verifiable acceptance criteria. It belongs to one ticket set and is numbered within its specification, continuing across ticket sets. Written out as an implementation ticket where the contrast with a waypoint matters. It is edited in place or replaced, without revisions.
_Avoid_: Implementation task, Wayfinder task, waypoint, decision ticket

**Delivery run**:
One agent attempt, started by a human, to implement an approved specification's whole ticket set on one branch; numbered within its specification, it pins the revision, the ticket set, the base branch and the required checks it started with. It ends passed, failed, blocked by its independent review, or cancelled. A passed run leaves verified work for the human to merge, and the merge is a separate recorded fact; any other outcome is retried as a new run, either from clean or resuming the ended run: the new run starts from its branch, keeps the tickets it merged, implements the rest, and first fixes what the ended run left: its failure, its failed checks and its blocking findings.
_Avoid_: Per-ticket run, job

**Work lock**:
An editing restriction on a running task and its governing planning artifacts, or on a completed task and its results.
_Avoid_: Review hold, blocking dependency

**Follow-up ticket**:
A new ticket linked to completed work that needs later changes under updated requirements.
_Avoid_: Follow-up task, reopened completed ticket

**Verification evidence**:
A retained result supporting an assessment of whether intended behavior is satisfied.
_Avoid_: Task progress, unexecuted test plan

## Presentation

**Editorial workspace**:
The outline, editable document, contextual conversation/questions, decisions, and supporting artifacts through which a person works with maps, waypoints, specifications and tickets.

**Prototype verdict**:
A human's recorded judgment of a particular prototype revision and its approved behavior or appearance, including limitations, exclusions, and unresolved questions.
_Avoid_: Browser test result, implementation completion

**Stage rail**:
A map workspace's navigation across five stages: Idea (the executive summary and the original idea), Wayfinding, Spec, Tickets and Delivery. It shows each stage's status. It is navigation and adds no workflow gates.
_Avoid_: Phase gate, rigid section progression, Implementation (as a stage name)

**Activity log**:
The readable stream in which a person talks with the planning agent and sees what it has done. Internal prompts and identifiers stay out of it.
_Avoid_: Agent rail, chat panel

**Escape hatch**:
The one conversation with the planning agent, below the activity log, for anything the stages don't offer; a message and its reply are the only conversation in the stream, and any change the reply makes lands on a stage.
_Avoid_: Chat, sidebar

**Work graph**:
An optional explanation or debugging view of planning and delivery artifacts and their relationships.

**Lane**:
A visual grouping of artifact or work types within a view of the work graph.
_Avoid_: Mandatory workflow stage

**Inspector**:
A detail surface for a selected artifact's content, traceability, and activity, accessible from the editorial workspace or optional graph.

## Extension

**Plugin**:
A separately packaged contribution composed into ZeNorm in code through the plugin SDK: its own tables, procedures, pages, slot components, subscribers, channels, agent skills and tools, and wrappers on the named seams. It changes no core record except through core's own procedures as a named User.
_Avoid_: Extension, module, add-on, app

**Slot**:
A named place in the web workspace where plugins render beside core, enumerated by the plugin SDK; an unknown slot fails startup.
_Avoid_: Portal, hook, region

**Seam**:
One of the named functions core calls through the plugin SDK and a plugin may wrap: identity, the access check, project checkout, executor credentials and run admission.
_Avoid_: Hook, middleware, provider
