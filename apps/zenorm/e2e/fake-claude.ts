#!/usr/bin/env node
/**
 * The scripted Claude Code CLI stand-in the e2e config points `agent.claudePath` at, so `pnpm check`
 * never runs the real `claude`. It first tells the role from the argv (slice 4 spec, Testing
 * decisions): `--output-format stream-json` is the delivery orchestrator, a `--json-schema` with
 * the root property `reviewedCommit` is the delivery reviewer, anything else is a planning call.
 *
 * - Planning: checks the argv shape of the headless run (slice 2 spec D4) and answers by the
 *   `--json-schema` root properties (slice 6a ticket 01's stand-in keys): a chart by its step (DR-22),
 *   told apart by roots only: `choose` (`waypoints` and `final`, after an answered destination round
 *   that is not the last: a confirmation in the flat shape, `kind` `confirmation` and the follow-up's
 *   `intro`, `final` and `questions` null; its prompt carries the plain line
 *   `Answered destination rounds: <k>`), `confirm` (`waypoints` without `final`, after a final round
 *   or at the cap) and a confirming chart either way (Grilling waypoints 1, 2 and 3, with 2 and 3
 *   blocked by 1, no fog and no Out of scope line), a first chart (`propose`: `summary` without
 *   `waypoints`; the reading, the proposed destination and a two-question destination round, its
 *   fields at the root), a waypoint's grilling (`final` and `decision`: by
 *   the prompt's `Waypoint number:` and `Answered rounds on this waypoint:` lines, waypoint 1 asks a
 *   non-final then a final round, 2 and 3 one final round), a grilling after a final round
 *   (`decision` without `final`: a resolution with no map change), or slice 7's spec calls (L132's stand-in keys), tested
 *   before the chart because a spec review also has a `summary` root: a map's specs (`specs`: one
 *   spec whose clauses name the prompt's `Resolved waypoints:`, or the destination when there are
 *   none; two or four with `[fake:two-specs]` or `[fake:four-specs]`; on a re-clear, the next
 *   revision of each `Spec N, latest revision R, not approved:` with " (revised)" titles), a spec
 *   repair (`revision`: the spec with " (revised)" titles), a spec review (`summary` and `findings`
 *   with a `Review of: spec N revision R` prompt line: no finding, except that
 *   `[fake:review-fails-once]` fails the spec's first review with one `revise` finding,
 *   `[fake:review-escalates]` fails its first three with one, so the third escalates, and
 *   `[fake:review-decision]` fails its first with a `decision` and a `revise` finding, counted by the
 *   prompt's earlier findings (a repair rewrites the draft in place, L241); later reviews pass, so
 *   each path reaches approval once its escalated waypoints are resolved), a tickets review (the same `summary` and
 *   `findings` roots with a `Review of: tickets N version V` prompt line, tested before the spec
 *   review's: see below) or a ticket set (`tickets`, `dispositions`, `slicing` and `execution`: T1
 *   and T2, T2 blocked by T1, each naming `pointers` (`src/index.ts`), a `work` disposition per
 *   criterion; with
 *   `[fake:tickets-already-done]` T1 alone, and criterion 2.1 `satisfied` with evidence and no
 *   ticket; a rewrite's prompt names the version it replaces (`Rewrite of ticket set version: <n>`,
 *   not `none`) and carries the review's `FINDINGS` block, a rejection's or note's `REASON`
 *   block or both, so its titles gain " (revised)").
 * - Orchestrator: checks its flags, then reads the tickets file its prompt names (`Tickets:`, core's
 *   `renderTickets`: `## T<n> <title>`, `Carries criteria …`, `Blocked by …`) and plays slice 8 D4's
 *   stream per ticket in graph order: an orchestrator `Bash` `git worktree add <runDir>/tickets/t<n>
 *   -b <run branch>-t<n> <run branch>`, an `Agent` `tool_use` described `T<n>: <title>`, subagent
 *   lines carrying its `parent_tool_use_id` (a text block, and a `Write` of `zenorm-fake-t<n>.txt`
 *   in the ticket worktree with its result), the `Agent` `tool_result` (a short report), the
 *   ticket's commit in its worktree and an orchestrator `Bash` `git merge --no-ff <run branch>-t<n>`
 *   with its non-error result, run in its working directory (the run worktree); then a success
 *   `result`. Every commit and merge is made under the run identity in its environment, so
 *   verifying passes. Its markers come from the spec file its prompt names (`Spec:`), whose problem
 *   carries the idea's markers (see Planning): `[fake:delivery-held]` holds after T1 is merged and
 *   T2's `Agent` is printed, until `fake-delivery-release` exists under `$ZENORM_E2E_ROOT` (60 s
 *   cap; the hold is async, so the lines before it are flushed); `[fake:delivery-closing-held]`
 *   holds after the last merge, as the real session reviews and runs the checks, until
 *   `fake-delivery-closing-release` exists under `$ZENORM_E2E_ROOT` (60 s cap); `[fake:ticket-unmerged]` skips the
 *   last ticket's merge and deletes its worktree and branch, and still ends with success. When a
 *   `Check:` line contains `[fake:slow]` it waits for SIGTERM before anything else, exit 143. A
 *   repair prompt (`Repair attempt: <n> of <limit>`, with a `FAILING-CHECK-1` block) merges no
 *   ticket: an `Agent` described with no ticket id writes `zenorm-fake-repair-<n>.txt` in the run
 *   worktree, which the orchestrator commits, then a success `result`; with `[fake:repair-held]` in
 *   the spec it holds after printing the `Agent`, until `fake-repair-release` exists under
 *   `$ZENORM_E2E_ROOT` (60 s cap).
 * - Reviewer: checks its read-only tools and answers a verdict naming the prompt's `Final commit:`
 *   with no findings, or, when the spec file its prompt names contains `[fake:review-blocked]`, one
 *   blocking spec finding on `zenorm-fake-t1.txt` whose `criterion` is T1's first criterion (from
 *   the tickets file's `Carries criteria …`).
 * - Pull request writer (a `--json-schema` with the root property `pullRequestBody`): checks its
 *   read-only tools as the reviewer's and answers a body with the PR skill's headings, starting at
 *   `## Why`.
 *
 * Every spec the planning stand-in writes has the fixed problem sentence followed by the idea's
 * `[fake:…]` markers, so the delivery markers above ride in the idea (slice 8 spec review
 * blocker 7).
 *
 * A failed call runs out of turns (`error_max_turns`) and keeps its prompt under
 * `$ZENORM_E2E_ROOT` by its session id; the retry that resumes it (`--resume`) answers that prompt.
 * For every role, a prompt containing `[fake:fail]` fails the run; one containing
 * `[fake:fail-once]` fails only the first time for its idea (or, with no idea, the first time at
 * all), which it records with a marker file under `$ZENORM_E2E_ROOT`. A prompt whose idea contains
 * `[fake:fail-twice]` fails the first two calls for that idea (a first attempt and its retry, so
 * the map stops on Try again), counted in a file under `$ZENORM_E2E_ROOT` named by the idea's
 * hash. `[fake:fail-twice:grilling]`, `[fake:fail-twice:spec]`, `[fake:fail-twice:review]` and
 * `[fake:fail-twice:tickets-review]` do the same for that idea's first two grilling calls, map To
 * Spec calls (`specs`), spec reviews (`Review of: spec`) or tickets reviews (`Review of: tickets`)
 * only, so a waypoint, the Spec stage, a spec review or a tickets review stops;
 * `[fake:fail-twice:hatch]` does it for the idea's first two hatch replies, so a message stops;
 * `[fake:fail-twice:release]` for the idea's first two spec revisions (`revision` root), which on a
 * waiting map are its wait's release run, so the released wait stops on Try again (S9-8). An idea
 * containing `[fake:no-waypoints]` is confirmed with no waypoints, so the map clears at once. An
 * idea containing `[fake:kinds]` is confirmed with Research 1, Task 2 and Grilling 3 (blocked by 1
 * and 2), one fog item and one Out of scope line; waypoint 3's resolution moves the fog out of
 * scope. One containing `[fake:fog-run]` is confirmed with the default waypoints and one fog item;
 * every waypoint's resolution leaves the fog, and the map's fog run (harness change #4; schema root
 * `fogForPerson`) moves every listed fog item out of scope.
 *
 * Hatch replies (slice 7b D2; schema root `reply`, checked before every other root, read-only
 * tools; the prompt carries `Message from the person:`) read their markers from the prompt's `MESSAGE`
 * block only, never from the earlier messages it replays (L153 (d)). A message with no marker gets
 * a reply and no change; otherwise a reply and the one change the marker names:
 * `[fake:hatch-reopen:<n>]` reopens waypoint n; `[fake:hatch-revise]` revises the spec on screen;
 * `[fake:hatch-tickets]` rewrites its ticket set; `[fake:hatch-open]` opens a new Grilling waypoint
 * blocked by none; `[fake:hatch-out-of-scope:<n>]` rules waypoint n out of scope;
 * `[fake:hatch-accept-report:<n>]` accepts waypoint n's unanswered report with a gist; and
 * `[fake:hatch-run:<n>]` runs waypoint n again (waiting or stopped, L157); `[fake:hatch-propose]`
 * proposes a new map with its own Out of scope line; and `[fake:hatch-split:<n>]` proposes one
 * splitting off the map's Out of scope line at position n (map proposals). `open_waypoint`,
 * `rule_out_of_scope` and `accept_report` always carry `fog`: empty lists, unless the change leaves
 * no other waypoint `open` or `claimed` (by the prompt's `Waypoint <n> status:` lines) and the
 * prompt lists fog (`Fog item at position n:`), which then moves out of scope. A spec repair whose
 * prompt says `Revise because: note` (the revision a `[fake:hatch-revise]` note starts) cites
 * `{ kind: "note" }` on C1, so its "your note" source shows (L158 (c)); a ticket set rewrite reads
 * the note as its reason (`REASON` block) like a rejection's.
 *
 * Research and Task runs (slice 6b; schema roots `report` and `done`, read-only tools for Task, the
 * web tools added for Research): a research run answers with one finding and one source; a task
 * run asks one round with options, then (by the prompt's `Answered rounds on this waypoint:` line)
 * is `done`. Neither changes the map. An idea containing `[fake:research-unanswered]` or
 * `[fake:task-failed]` is charted as `[fake:kinds]`; with the first, a research run with no
 * earlier report (`Earlier reports on this waypoint: 0`) cannot answer, and the next answers; with
 * the second, a task run with no earlier outcome (`Earlier outcomes on this task: 0`) fails
 * without asking, and the next is `done`.
 *
 * Consistency passes (slice 6b; schema root `findings`) are clean: no findings. With an idea
 * containing `[fake:conflict]`, the first pass (`Waypoints opened by an earlier pass: 0`) finds
 * one conflict between waypoints 1 and 2, which opens a Grilling waypoint; later passes are clean.
 *
 * An idea containing `[fake:split]` makes the first chart offer two maps split off the idea (CSV
 * imports and nightly exports), each with its title, idea and line (idea-phase split).
 *
 * The destination markers (DR-23) ride in the idea and are read with the chart prompt's
 * `Answered destination rounds: <k>` line; each follow-up (`kind` `followUp` in `choose`'s flat
 * shape) revises the destination, naming the round it follows, and asks one question.
 * `[fake:destination-follow-up]` asks one non-final follow-up at 1, then confirms (`choose` at 2);
 * `[fake:destination-final]` asks a final follow-up at 1, and at 2 expects the `confirm` roots,
 * failing with a mismatch on `choose`; `[fake:destination-cap]` asks a non-final follow-up whenever
 * it gets `choose`, and at 3 expects the `confirm` roots, failing with a mismatch on `choose`. With
 * none of them, `choose` confirms.
 *
 * An idea containing `[fake:propose]` makes every Wayfinding run of its map propose a new map: the
 * confirming chart one (`proposals`), the fog run each fog item (`fogProposed`, instead of moving it
 * out of scope), every consistency pass one, and with `[fake:states]` waypoint 5's out-of-scope
 * ruling attaches one (an idea only; its reason is the line). With `[fake:no-waypoints]` the map
 * clears at once with the chart's proposal undecided, and Spec starts beside it.
 *
 * An idea containing `[fake:survey-held]` holds the map's code survey running until a file
 * `fake-survey-release` exists under `$ZENORM_E2E_ROOT` (20 s cap), so the e2e sees the charted
 * waypoints before any of them starts.
 *
 * An idea containing `[fake:review-held]` holds the planning review of revision 1 running until a
 * file `fake-review-release` exists under `$ZENORM_E2E_ROOT` (the e2e writes it once a note sent
 * meanwhile is refused `spec_in_flight`, S7b-5); it gives up after 20 s.
 *
 * Tickets reviews (slice 7c D2; `Review of: tickets N version V`) pass with no finding, except, by
 * the idea's markers: `[fake:tickets-fail-once]` fails version 1 with one `revise` finding;
 * `[fake:tickets-held]` fails versions 1 to 3 with one each, so version 3's review escalates;
 * `[fake:tickets-decision]` fails version 1 with one `decision` finding; later versions pass. Each
 * finding names the reviewed version's first ticket and the approved revision's first criterion
 * (from the prompt's `Version ticket ids:` and `Revision criterion ids:` lines), so core's
 * reference check (S7c-3) accepts it.
 * `[fake:tickets-review-held]` holds the review of version 1 running until a file
 * `fake-tickets-review-release` exists under `$ZENORM_E2E_ROOT` (20 s cap), as `[fake:review-held]`
 * does with its own file. `[fake:tickets-repair-held:<key>]` holds a repair (a To Tickets rewrite
 * carrying a `FINDINGS` block) running until `fake-tickets-repair-release-<key>` exists (20 s cap),
 * so the e2e sees its status row; each spec file holds by its own key, so files running at once
 * never release each other's repair. `[fake:tickets-long-summary]` gives a review a summary as long as a
 * real reviewer's (L180 (4)), so the panel clamps it. The markers are read from the prompt's `IDEA`
 * block.
 *
 * An idea containing `[fake:states]` (ticket 08's Wayfinding states) is confirmed with Research 1
 * and Grilling 2 unblocked, Task 3 and Research 4 blocked by 2, Grilling 5 unblocked, and one fog
 * item; waypoint 5's first run rules it out of scope. It is never meant to clear.
 *
 * Revising a delivered spec (slice 8b; the prompt lines in `packages/agent/src/revision-prompt-parts.ts`
 * and `spec-prompt.ts` it keys on are named here, so a prompt edit knows what it breaks):
 *
 * - `[fake:three-criteria]` (ticket 10: put it in the idea of the FIRST map, the one whose spec a
 *   later map revises) gives the canned spec a third criterion, `1.2` under C1, carried by T1 with a
 *   `work` disposition (with `[fake:tickets-already-done]`, T1 keeps both). Without it the canned
 *   spec has two criteria and every earlier flow is unchanged; `[fake:revise:<n>]` needs three, and
 *   on a two-criterion spec it is a mismatch naming this marker.
 * - `[fake:revise:<n>]`: the confirming chart reads `Project spec <n>, latest revision <r>,
 *   approved|not approved, delivered|not delivered, held (<kind>) by map “<title>” at revision
 *   <r>|not held:` and `Project spec <n> criterion ids: a, b, c`, and when the line reads `approved`
 *   its first waypoint touches `{ specNumber: n, revision: r, criteria: [b] }` (b, the criterion the
 *   revision changes); while another map's draft is latest it touches the latest approved revision
 *   instead (`… latest approved revision: <r>`, `… approved criterion ids:`, L213 D-5); with no
 *   approved revision, no touch. Touches go only on charted waypoints, never on a hatch
 *   change (L204). A first map To Spec (no `Spec <n>, latest revision …` line of the map's own)
 *   reads spec n's `<<<SPEC-<n>-REVISION-<r> nonce` JSON block and writes its next revision with
 *   `specNumber: n` and ids kept: the first criterion word for word, the second changed, the last
 *   removed and a new one with the next free id of the last's clause (on the gated spec: 1.1 kept,
 *   1.2 changed, 2.1 removed, 2.2 added). The clauses it changes cite this map's `Resolved
 *   waypoints:`; the others cite nothing (core refuses another map's waypoints). When that line
 *   reads `held (…)`, it writes no spec and one wait `{ specNumber: n, note }` instead.
 * - Every next revision the stand-in writes (a re-clear's, a repair's, a release's) starts from the
 *   revision JSON block the prompt shows, not from the canned spec; a re-clear or repair keeps every
 *   criterion and gives " (revised)" titles. Its problem is the canned sentence with THIS map's
 *   idea markers, so a revision's delivery reads the markers of the map that wrote it.
 * - A release run (`Revise because: wait`, with the note in the `<<<WAIT nonce` block) writes the
 *   next revision of the shown (approved) revision with the note as a new criterion of C1, next free
 *   id, C1 citing the source its `Wait from:` line offers (the note, else the destination), every
 *   other id kept, as `[fake:hatch-revise]`'s note revision does (the demo's
 *   `revisionFromNote`). `[fake:hatch-revise]` (`Revise because: note`) works the same on an approved
 *   spec; core decides whether it may. With `[fake:release-held]` in the waiting map's idea, the
 *   release run holds running until `fake-release-run-release` exists under `$ZENORM_E2E_ROOT`
 *   (20 s cap), so the e2e sees the released wait before its revision lands (S8b-10).
 * - To Tickets writes the canned T1 and T2 (unchanged) unless the idea carries `[fake:revise:<n>]`
 *   (a same-map repair's revision 2 has a text delta too); with it, a later set from `First ticket number:
 *   <n>`, each `Reading <id>: <change>, expected <kind>, baseline <T> (revision <r>, run <n>, commit
 *   <c>)|baseline none`, each `Removed criterion <id> (clause <C>)` and each `Earlier ticket <T>
 *   (revision <r>): criteria <ids>|none; delivered in run <n>, commit <c>|not delivered`, as the
 *   demo's `reconcile`: expected `delivered` names the baseline ticket; expected `work` goes to a
 *   ticket following up its baseline ticket, or with no baseline to one ticket per clause; expected
 *   `retained` names the undelivered earlier ticket that carries it, and when none does it is a
 *   mismatch (never a guess); a removed criterion is `removed` with the ticket that follows up the
 *   delivered ticket that built it (else the ticket of its clause, given that follow-up), with a
 *   reason naming that ticket, run and commit, or with no ticket when no delivered earlier ticket
 *   carries it. Tickets are numbered from the first ticket number. On the gated spec: 1.1
 *   `delivered` T1, T3 (follow-up T1) carries 1.2, T4 (follow-up T2) carries 2.2 and takes 2.1 out.
 * - `[fake:departure]` writes the first `delivered` reading `work` with a reason;
 *   `[fake:departure-no-reason]` writes it with no reason until a rewrite carrying a `FINDINGS`
 *   block, which gives one.
 * - `[fake:nothing-new]` (with `[fake:revise:<n>]`, else a mismatch): To Spec's revision adds one
 *   Out of scope line and changes nothing else, so every reading expects `delivered` and To Tickets
 *   writes zero tickets.
 * - The tickets review returns one `disposition_without_reason` finding (route `revise`, the
 *   criterion's id) per `Departure <id>: no reason` line, before any marker's finding, so
 *   `review_departure_missed` never fires on the stand-in.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MISMATCH_EXIT = 2;
const FAIL_MARKER = "[fake:fail]";
const FAIL_ONCE_MARKER = "[fake:fail-once]";
const FAIL_ONCE_FILE = "fake-fail-once";
const FAIL_TWICE_MARKER = "[fake:fail-twice]";
/** The planning calls a scoped fail-twice marker counts, by the marker's suffix. */
const SCOPED_FAIL_TWICE = {
  grilling: "grilling",
  spec: "spec",
  review: "spec-review",
  "tickets-review": "tickets-review",
  hatch: "hatch",
  release: "revise",
} as const;
const TWO_SPECS_MARKER = "[fake:two-specs]";
const FOUR_SPECS_MARKER = "[fake:four-specs]";
const REVIEW_FAILS_ONCE_MARKER = "[fake:review-fails-once]";
const REVIEW_ESCALATES_MARKER = "[fake:review-escalates]";
const REVIEW_DECISION_MARKER = "[fake:review-decision]";
const NO_WAYPOINTS_MARKER = "[fake:no-waypoints]";
const KINDS_MARKER = "[fake:kinds]";
const FOG_RUN_MARKER = "[fake:fog-run]";
const RESEARCH_UNANSWERED_MARKER = "[fake:research-unanswered]";
const TASK_FAILED_MARKER = "[fake:task-failed]";
const CONFLICT_MARKER = "[fake:conflict]";
const STATES_MARKER = "[fake:states]";
/** An idea containing it holds the map's code survey running until the e2e releases it. */
const SURVEY_HELD_MARKER = "[fake:survey-held]";
/** The file under `$ZENORM_E2E_ROOT` that releases a held survey (`fixture.ts` names it too). */
const SURVEY_RELEASE_FILE = "fake-survey-release";
const REVIEW_HELD_MARKER = "[fake:review-held]";
/** The file under `$ZENORM_E2E_ROOT` that releases a held review (`fixture.ts` names it too). */
const REVIEW_RELEASE_FILE = "fake-review-release";
/** The file under `$ZENORM_E2E_ROOT` that releases a held tickets review (its own, so a spec
 * review's release written earlier in the run never frees it). */
const TICKETS_REVIEW_RELEASE_FILE = "fake-tickets-review-release";
const TICKETS_FAIL_ONCE_MARKER = "[fake:tickets-fail-once]";
const TICKETS_HELD_MARKER = "[fake:tickets-held]";
const TICKETS_DECISION_MARKER = "[fake:tickets-decision]";
const TICKETS_REVIEW_HELD_MARKER = "[fake:tickets-review-held]";
const TICKETS_REPAIR_HELD_MARKER = /\[fake:tickets-repair-held:([a-z-]+)\]/;
/** The file under `$ZENORM_E2E_ROOT` that releases a repair held by key `<key>` (`fixture.ts` names it too). */
const TICKETS_REPAIR_RELEASE_FILE_PREFIX = "fake-tickets-repair-release-";
const TICKETS_ALREADY_DONE_MARKER = "[fake:tickets-already-done]";
const TICKETS_LONG_SUMMARY_MARKER = "[fake:tickets-long-summary]";
const RELEASE_HELD_MARKER = "[fake:release-held]";
/** The file under `$ZENORM_E2E_ROOT` that releases a held wait release run (`fixture.ts` names it too). */
const RELEASE_RUN_RELEASE_FILE = "fake-release-run-release";
/** A summary the length of a real reviewer's (600 to 1000 characters, L180 (4), E-3). */
const LONG_TICKETS_SUMMARY = Array.from(
  { length: 8 },
  (_, index) =>
    `Traced part ${String(index + 1)} of the approved revision to its ticket and checked each disposition against the code.`,
).join(" ");
const REVIEW_HELD_MAX_MS = 20_000;
/**
 * The `[fake:delivery-held]` cap: longer than a review's, because the held-run flow checks the
 * ticket rows, Run activity, the ticket page and a reload while it holds (slice 8 ticket 10), each
 * seen only on a 2 s poll. The e2e orchestrator timeout (2 minutes) stays well above it.
 */
const DELIVERY_HELD_MAX_MS = 60_000;
const REVIEW_HELD_POLL_MS = 100;
const E2E_ROOT_ENV_VAR = "ZENORM_E2E_ROOT";
const REVISED = " (revised)";
const SLOW_MARKER = "[fake:slow]";
const REVIEW_BLOCKED_MARKER = "[fake:review-blocked]";
const DELIVERY_HELD_MARKER = "[fake:delivery-held]";
const DELIVERY_RELEASE_FILE = "fake-delivery-release";
const DELIVERY_CLOSING_HELD_MARKER = "[fake:delivery-closing-held]";
/** The file under `$ZENORM_E2E_ROOT` that releases a held closing (`fixture.ts` names it too). */
const DELIVERY_CLOSING_RELEASE_FILE = "fake-delivery-closing-release";
const TICKET_UNMERGED_MARKER = "[fake:ticket-unmerged]";
const REPAIR_HELD_MARKER = "[fake:repair-held]";
/** The file under `$ZENORM_E2E_ROOT` that releases a held repair (`fixture.ts` names it too). */
const REPAIR_RELEASE_FILE = "fake-repair-release";
/** A repair prompt's line (`packages/agent/src/delivery-prompt.ts`'s `repairLines`). */
const REPAIR_ATTEMPT_LINE = /^Repair attempt: (\d+) of (\d+)$/m;
/** Every `[fake:…]` marker in a text, in order. */
const ANY_MARKER = /\[fake:[^\]]+\]/g;
const SIGTERM_EXIT = 143;
/** The hatch prompt's line before the message block (slice 7b D2, L149). */
const HATCH_MESSAGE_LINE = "Message from the person:";
const HATCH_REPLY = "Simulated reply: the records answer this, and nothing on the map changes.";
const HATCH_REVISE_MARKER = "[fake:hatch-revise]";
const HATCH_TICKETS_MARKER = "[fake:hatch-tickets]";
const HATCH_OPEN_MARKER = "[fake:hatch-open]";
/** The Grilling waypoint `[fake:hatch-open]` adds. */
const HATCH_WAYPOINT = {
  title: "Which file name",
  question: "What should the exported file be called?",
};
const HATCH_OUT_OF_SCOPE_REASON = "The person ruled it out of scope through the escape hatch.";
const HATCH_ACCEPTED_GIST = "The report as it stands";
const HATCH_PROPOSE_MARKER = "[fake:hatch-propose]";
/** The map `[fake:hatch-propose]` and `[fake:hatch-split:<n>]` propose (map proposals). */
const HATCH_PROPOSAL = {
  title: "JSON exports",
  idea: "Export records as JSON as well as CSV.",
  line: "JSON exports are their own effort: proposed through the escape hatch.",
};
/** Gates the canned spec's third criterion (1.2 under C1, carried by T1); see the header. */
const THREE_CRITERIA_MARKER = "[fake:three-criteria]";
const THIRD_CRITERION = {
  id: "1.2",
  text: "The file starts with a header row naming each column.",
};
/** `[fake:revise:<n>]`: the map revises project spec n (slice 8b). */
const REVISE_MARKER = /\[fake:revise:(\d+)\]/;
const DEPARTURE_MARKER = "[fake:departure]";
const DEPARTURE_NO_REASON_MARKER = "[fake:departure-no-reason]";
const NOTHING_NEW_MARKER = "[fake:nothing-new]";
const NOTHING_NEW_OUT_OF_SCOPE = "Exporting to other formats: a later map may add them.";
/** What `[fake:revise:<n>]`'s revision appends to the criterion it changes. */
const CHANGED_CRITERION_TAIL = " Dates are written as ISO 8601.";
const ADDED_CRITERION_TEXT = "The Export button says how many records it writes.";
/** The note of the wait `[fake:revise:<n>]` writes on a held spec; its release adds it as a criterion. */
const WAIT_NOTE = "The export writes dates as ISO 8601.";
const DEPARTURE_REASON =
  "Research found that the delivered code assumes the old format, so this criterion needs work again.";

const EXPECTED_FLAGS: readonly (readonly [string, string])[] = [
  ["--output-format", "json"],
  ["--model", "claude-sonnet-5-5"],
  ["--effort", "medium"],
  ["--permission-mode", "dontAsk"],
];
/** Every planning call reads only; a research run may also read the web (slice 6b D2). */
const PLANNING_TOOLS = "Read,Grep,Glob";
const RESEARCH_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch";

const ROUND = {
  intro:
    "I propose: a CSV export of every record, offered from the project page. Two questions confirm it.",
  questions: [
    {
      topic: "Scope",
      text: "How much of the project should this change touch?",
      options: [
        { label: "One screen", detail: "Fast to deliver; other screens stay as they are." },
        { label: "Every screen", detail: "Consistent everywhere; takes longer." },
        { label: "Only the API", detail: "No visible change yet; unblocks later work." },
      ],
    },
    {
      topic: "Audience",
      text: "Who is this change for?",
      options: [
        { label: "Existing users", detail: "Keeps today's flows; limits new reach." },
        { label: "New users", detail: "Smooths onboarding; may move familiar things." },
        { label: "Maintainers", detail: "Eases upkeep; users see little difference." },
      ],
    },
  ],
};

const PROPOSAL = {
  title: "Data export",
  summary: "People want to take their records elsewhere, as a file they can open anywhere.",
  destination: "A CSV export of every record, offered from the project page.",
  split: [],
  ...ROUND,
};

/** `[fake:split]`: the first chart offers two maps split off the idea (idea-phase split). */
const SPLIT_MARKER = "[fake:split]";
const SPLIT_OFFERS = [
  {
    title: "CSV imports",
    idea: "Import records from a CSV file, matching columns by their header.",
    line: "Importing records is its own map, split off this idea.",
  },
  {
    title: "Nightly exports",
    idea: "Run the export every night and keep the last seven files.",
    line: "Scheduled exports are their own map, split off this idea.",
  },
];

const DESTINATION =
  "A CSV export of every record, offered from the project page, for existing users.";

/**
 * The destination markers (DR-23), read with the chart prompt's `Answered destination rounds: <k>`
 * line: `[fake:destination-follow-up]` asks one non-final follow-up at 1, then confirms;
 * `[fake:destination-final]` asks a final follow-up at 1 and expects the `confirm` roots at 2;
 * `[fake:destination-cap]` asks a non-final follow-up at every `choose` and expects the `confirm`
 * roots at 3 (`DESTINATION_ROUNDS_MAX_COUNT`).
 */
const DESTINATION_FOLLOW_UP_MARKER = "[fake:destination-follow-up]";
const DESTINATION_FINAL_MARKER = "[fake:destination-final]";
const DESTINATION_CAP_MARKER = "[fake:destination-cap]";
const ANSWERED_DESTINATION_ROUNDS = "Answered destination rounds: ";

/** The destination a follow-up after `answered` rounds revises the proposal to. */
function followUpDestination(answered: number): string {
  return `A CSV export of every record, offered from the project page, as revised after destination round ${String(answered)}.`;
}

/**
 * A `choose` chart's follow-up in the flat shape (DR-5): the revised title, summary and
 * destination, and one question on what the answers moved; the confirmation's fields null.
 */
function followUp(answered: number, final: boolean): object {
  const destination = followUpDestination(answered);
  return {
    kind: "followUp",
    title: PROPOSAL.title,
    summary: PROPOSAL.summary,
    destination,
    intro: `I revised the destination: ${destination} One question settles what your answers moved.`,
    final,
    questions: [
      {
        topic: "Columns",
        text: `Which columns should the export write, after destination round ${String(answered)}?`,
        options: [
          { label: "Every column", detail: "Complete; wide files." },
          { label: "Visible columns", detail: "Matches the screen; may omit hidden data." },
        ],
      },
    ],
    waypoints: null,
    fog: null,
    outOfScope: null,
    proposals: null,
  };
}

/** A `choose` chart's confirmation in the flat shape (DR-22): the follow-up's round fields null. */
function choiceConfirmation(): object {
  return {
    kind: "confirmation",
    intro: null,
    final: null,
    questions: null,
    ...confirmingChart(),
  };
}

/**
 * A `choose` chart's reply (DR-22, DR-23): with no destination marker, a confirmation; with one, a
 * follow-up or a confirmation by the answered rounds, or a mismatch where the marker expects the
 * `confirm` roots.
 */
function chooseChart(): object {
  if (idea?.includes(DESTINATION_FOLLOW_UP_MARKER) === true) {
    return promptNumber(ANSWERED_DESTINATION_ROUNDS) === 1
      ? followUp(1, false)
      : choiceConfirmation();
  }
  if (idea?.includes(DESTINATION_FINAL_MARKER) === true) {
    const answered = promptNumber(ANSWERED_DESTINATION_ROUNDS);
    if (answered !== 1) {
      mismatch(
        `${DESTINATION_FINAL_MARKER} at ${String(answered)} answered destination rounds expects the confirm roots, not choose`,
      );
    }
    return followUp(answered, true);
  }
  if (idea?.includes(DESTINATION_CAP_MARKER) === true) {
    const answered = promptNumber(ANSWERED_DESTINATION_ROUNDS);
    if (answered >= 3) {
      mismatch(
        `${DESTINATION_CAP_MARKER} at ${String(answered)} answered destination rounds expects the confirm roots, not choose`,
      );
    }
    return followUp(answered, false);
  }
  return choiceConfirmation();
}

/** Three Grilling waypoints; the default chart has no fog and no Out of scope line (slice 6b). */
const WAYPOINTS = [
  {
    kind: "grilling",
    title: "Which columns",
    question: "Which columns does the export write?",
    blockedBy: [],
    touches: [],
  },
  {
    kind: "grilling",
    title: "Which encoding",
    question: "Which encoding does the file use?",
    blockedBy: [1],
    touches: [],
  },
  {
    kind: "grilling",
    title: "Where to offer it",
    question: "Where on the page is the export offered?",
    blockedBy: [1],
    touches: [],
  },
];

/** `[fake:kinds]`: Research 1, Task 2 and Grilling 3, blocked by both (slice 6b). */
const KINDS_WAYPOINTS = [
  {
    kind: "research",
    title: "What Excel expects",
    question: "Which CSV encoding and line ending does Excel open without asking?",
    blockedBy: [],
    touches: [],
  },
  {
    kind: "task",
    title: "Count the record fields",
    question: "How many fields does each stored record have today?",
    blockedBy: [],
    touches: [],
  },
  {
    kind: "grilling",
    title: "Which columns",
    question: "Which columns does the export write?",
    blockedBy: [1, 2],
    touches: [],
  },
];

/**
 * `[fake:states]`: Research 1 and Grilling 2 unblocked, Task 3 and Research 4 blocked by 2, and
 * Grilling 5, which its first run rules out of scope; one fog item (slice 6b, ticket 08).
 */
const STATES_WAYPOINTS = [
  KINDS_WAYPOINTS[0],
  { ...KINDS_WAYPOINTS[2], blockedBy: [] },
  { ...KINDS_WAYPOINTS[1], blockedBy: [2] },
  {
    kind: "research",
    title: "What other tools write",
    question: "Which columns do comparable tools export?",
    blockedBy: [2],
    touches: [],
  },
  {
    kind: "grilling",
    title: "Offer it in the old exporter",
    question: "Should the old exporter offer CSV too?",
    blockedBy: [],
    touches: [],
  },
];
const STATES_OUT_OF_SCOPE_WAYPOINT = 5;
const STATES_OUT_OF_SCOPE_REASON = "The old exporter is being removed; nothing new goes into it.";

/**
 * `[fake:propose]`: every Wayfinding run of the map proposes a new map (map proposals): the
 * confirming chart, a fog run (each fog item), a consistency pass, and, with `[fake:states]`,
 * waypoint 5's out-of-scope ruling (an idea, its reason the line).
 */
const PROPOSE_MARKER = "[fake:propose]";
const CHART_PROPOSAL = {
  title: "CSV imports",
  idea: "Import records from a CSV file",
  line: "Importing CSV files is its own effort: proposed as a new map.",
};
const FOG_PROPOSAL_TITLE = "Background exports";
const FOG_PROPOSAL_IDEA = "Run large exports in the background";
const FOG_PROPOSAL_LINE = "Background exports are their own effort: proposed as a new map.";
const CONSISTENCY_PROPOSAL = {
  title: "Nightly exports",
  idea: "Schedule exports to run every night",
  line: "Scheduled exports are their own effort: proposed as a new map.",
};
const WAYPOINT_PROPOSAL = { title: "Retire the old exporter", idea: "Retire the old exporter." };

/** Whether the idea carries `[fake:propose]`. */
function proposes(): boolean {
  return idea?.includes(PROPOSE_MARKER) === true;
}

const KINDS_FOG = "Whether exports need a size limit.";
const KINDS_OUT_OF_SCOPE = "Importing CSV files: this effort only exports.";
const FOG_RUN_FOG = "Whether the export runs in the background.";
const FOG_OUT_OF_SCOPE_LINE = "Settled outside this export: the stand-in moves it out of scope.";

/** Waypoint 1's two rounds, then the other waypoints' one final round. */
const GRILL_QUESTIONS = [
  {
    topic: "Columns",
    text: "Which columns should the export write?",
    options: [
      { label: "Every column", detail: "Complete; wide files." },
      { label: "Visible columns", detail: "Matches the screen; omits hidden data." },
    ],
  },
  {
    topic: "Header",
    text: "Should the file start with a header row?",
    options: [
      { label: "Header row", detail: "Self-describing; one extra line." },
      { label: "No header", detail: "Pure data; readers must know the order." },
    ],
  },
];

const GRILL_RESOLUTION = {
  kind: "resolution",
  decision:
    "The export follows the person's answers, with their own words applied as the final say.",
  gist: "Settled from your answers and words",
  agentDecided: ["Your own words override the chosen options"],
};

/** A resolving run's map changes: none (slice 6b D3). */
const NO_MAP_CHANGES = {
  newWaypoints: [],
  fogOutOfScope: [],
  fogDecided: [],
  fogSettledHere: [],
  newFog: [],
};

const SPEC_TITLE = "Export data as CSV";

/** The canned specs' titles, in the order a first To Spec writes them. */
const SPEC_TITLES = [SPEC_TITLE, "Import data from CSV", "Schedule exports", "Keep an export log"];

/**
 * The canned problem sentence, followed by the idea's `[fake:…]` markers, so the rendered
 * `inputs/spec.md` carries them to the delivery stand-ins (slice 8 spec review blocker 7).
 */
function specProblem(): string {
  const markers = idea === undefined ? [] : [...idea.matchAll(ANY_MARKER)].map((match) => match[0]);
  return ["People cannot take their data elsewhere.", ...markers].join(" ");
}

/**
 * The canned spec's two clauses, each with one criterion; `sources` come from the prompt. The
 * e2e repositories hold no code, so each clause relies on nothing and declares what it adds.
 */
function specContent(sources: readonly unknown[], suffix: string, title: string) {
  return {
    title: `${title}${suffix}`,
    problem: specProblem(),
    solution: "A CSV export of every record, offered from the project page.",
    clauses: [
      {
        id: "C1",
        title: `Every record exports${suffix}`,
        text: "Exporting writes every record as one CSV row.",
        criteria: [
          { id: "1.1", text: "Exporting writes every record as one CSV row." },
          ...(threeCriteria() ? [THIRD_CRITERION] : []),
        ],
        sources,
        reliesOn: [],
        adds: ["CSV export"],
      },
      {
        id: "C2",
        title: `The project page offers the export${suffix}`,
        text: "The project page has an Export button.",
        criteria: [{ id: "2.1", text: "The project page offers the export." }],
        sources,
        reliesOn: [],
        adds: ["Export button"],
      },
    ],
    outOfScope: [],
  };
}

const FIRST_TICKET_TITLE = "Write the CSV exporter";

/**
 * The first set: T1 and T2 with a `work` disposition per criterion; with `[fake:three-criteria]`,
 * T1 also carries 1.2.
 */
function firstTicketSet() {
  const firstCriteria = threeCriteria() ? ["1.1", THIRD_CRITERION.id] : ["1.1"];
  const [first, second] = TICKET_SET.tickets;
  const [, secondDisposition] = TICKET_SET.dispositions;
  if (first === undefined || second === undefined || secondDisposition === undefined) {
    mismatch("the canned ticket set lacks T1 or T2");
  }
  return {
    ...TICKET_SET,
    tickets: [{ ...first, criteria: firstCriteria }, second],
    dispositions: [
      ...firstCriteria.map((criterion) => ({
        criterion,
        kind: "work",
        ticket: "T1",
        reason: null,
      })),
      secondDisposition,
    ],
  };
}

const TICKET_SET = {
  tickets: [
    {
      id: "T1",
      title: FIRST_TICKET_TITLE,
      build: "Turn the stored records into CSV rows.",
      blockedBy: [],
      criteria: ["1.1"],
      testing: ["A test exports two records and reads two rows."],
      followUp: null,
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
    {
      id: "T2",
      title: "Add the Export button",
      build: "Offer the export on the project page.",
      blockedBy: [{ ticket: "T1", supplies: "The CSV exporter." }],
      criteria: ["2.1"],
      testing: ["A test clicks Export and receives the file."],
      followUp: null,
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
    { criterion: "2.1", kind: "work", ticket: "T2", reason: null },
  ],
  slicing: "The exporter first, then the button that offers it.",
  execution: "Each ticket's tests run in the package's suite.",
};

function mismatch(reason: string): never {
  process.stderr.write(`fake-claude: ${reason}\n`);
  process.exit(MISMATCH_EXIT);
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index === -1 || value === undefined) {
    mismatch(`missing ${flag}`);
  }
  return value;
}

function print(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const args = process.argv.slice(2);

/**
 * The file holding the stand-in's sign-in state (`zenorm init`'s stand-in tests): one of
 * `AUTH_STATES`. Unset, the stand-in is signed in to claude.ai, as every e2e server needs.
 */
const AUTH_FILE_ENV_VAR = "ZENORM_FAKE_AUTH_FILE";
/** The file each `auth login` appends its arguments to, one JSON array per line. */
const LOGIN_FILE_ENV_VAR = "ZENORM_FAKE_LOGIN_FILE";
/**
 * `signed_out` signs in at `auth login` (to `console` with `--console`, else `claude.ai`);
 * `stays_signed_out` stays signed out whatever the login; the others are signed in by that method.
 */
const AUTH_STATES = ["signed_out", "stays_signed_out", "claude.ai", "console", "third_party"];

function authState(): string {
  const file = process.env[AUTH_FILE_ENV_VAR];
  if (file === undefined) {
    return "claude.ai";
  }
  const state = readFileSync(file, "utf8").trim();
  if (!AUTH_STATES.includes(state)) {
    mismatch(
      `${AUTH_FILE_ENV_VAR} holds ${JSON.stringify(state)}, not one of ${AUTH_STATES.join(", ")}`,
    );
  }
  return state;
}

if (args.join(" ") === "auth status --json") {
  const state = authState();
  if (state === "signed_out" || state === "stays_signed_out") {
    // Claude Code exits 1 when it is not signed in.
    print({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    process.exit(1);
  }
  const apiProvider = state === "third_party" ? "bedrock" : "firstParty";
  print({ loggedIn: true, authMethod: state, apiProvider });
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login") {
  const loginFile = process.env[LOGIN_FILE_ENV_VAR];
  const authFile = process.env[AUTH_FILE_ENV_VAR];
  if (loginFile === undefined || authFile === undefined) {
    mismatch(`auth login needs ${LOGIN_FILE_ENV_VAR} and ${AUTH_FILE_ENV_VAR}`);
  }
  appendFileSync(loginFile, `${JSON.stringify(args.slice(2))}\n`);
  if (authState() === "signed_out") {
    writeFileSync(authFile, args.includes("--console") ? "console" : "claude.ai");
  }
  process.exit(0);
}

if (args[0] !== "-p") {
  mismatch(
    `expected "auth status --json", "auth login …" or "-p <prompt> …", got ${JSON.stringify(args)}`,
  );
}
/** Where `failRun` keeps a failed call's prompt, by the session id its result names. */
function sessionFile(sessionId: string): string {
  return join(e2eRoot("--resume"), `fake-session-${sessionId}`);
}

/**
 * The call's prompt. A resumed call (`--resume <session>`, the retry of a run out of turns) sends
 * only a continuation prompt; it continues the failed call, so it answers that call's prompt.
 */
function callPrompt(): string {
  const given = flagValue(args, "-p");
  if (!args.includes("--resume")) {
    return given;
  }
  const file = sessionFile(flagValue(args, "--resume"));
  if (!existsSync(file)) {
    mismatch("--resume names no session a failed call left");
  }
  return readFileSync(file, "utf8");
}

const prompt = callPrompt();

type Role = "orchestrator" | "reviewer" | "pull-request-writer" | "planning";

/** The root `properties` of the `--json-schema`, which must be an object schema. */
function schemaProperties(): object {
  let schema: unknown;
  try {
    schema = JSON.parse(flagValue(args, "--json-schema"));
  } catch {
    mismatch("--json-schema is not JSON");
  }
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("type" in schema) ||
    schema.type !== "object" ||
    !("properties" in schema) ||
    typeof schema.properties !== "object" ||
    schema.properties === null
  ) {
    mismatch('--json-schema is not a JSON schema with type "object" and properties');
  }
  return schema.properties;
}

function detectRole(): Role {
  const format = args.indexOf("--output-format");
  if (format !== -1 && args[format + 1] === "stream-json") {
    return "orchestrator";
  }
  if (args.includes("--json-schema") && "reviewedCommit" in schemaProperties()) {
    return "reviewer";
  }
  if (args.includes("--json-schema") && "pullRequestBody" in schemaProperties()) {
    return "pull-request-writer";
  }
  return "planning";
}

function expectFlags(expected: readonly (readonly [string, string])[]): void {
  for (const [flag, value] of expected) {
    const actual = flagValue(args, flag);
    if (actual !== value) {
      mismatch(`${flag} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`);
    }
  }
}

const DELIVERY_FLAGS: readonly (readonly [string, string])[] = [
  ["--model", "claude-sonnet-5-5"],
  ["--effort", "medium"],
  ["--permission-mode", "dontAsk"],
];

/** The orchestrator's tools must include the subagent tool and Bash; its system prompt must exist. */
function checkOrchestratorFlags(): void {
  expectFlags(DELIVERY_FLAGS);
  const tools = flagValue(args, "--tools").split(",");
  for (const tool of ["Agent", "Bash"]) {
    if (!tools.includes(tool)) {
      mismatch(`--tools ${JSON.stringify(tools.join(","))} lacks ${tool}`);
    }
  }
  const systemPromptFile = flagValue(args, "--append-system-prompt-file");
  if (!existsSync(systemPromptFile)) {
    mismatch(`--append-system-prompt-file ${systemPromptFile} does not exist`);
  }
}

/**
 * The reviewer and the pull request writer are read-only: no Edit or Write among their tools, and
 * both explicitly denied.
 */
function checkReviewerFlags(): void {
  expectFlags([...DELIVERY_FLAGS, ["--output-format", "json"]]);
  const tools = flagValue(args, "--tools").split(",");
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    if (tools.includes(tool)) {
      mismatch(`the reviewer's --tools ${JSON.stringify(tools.join(","))} include ${tool}`);
    }
  }
  const denied = flagValue(args, "--disallowedTools").split(",");
  for (const tool of ["Edit", "Write"]) {
    if (!denied.includes(tool)) {
      mismatch(`the reviewer's --disallowedTools ${JSON.stringify(denied.join(","))} lack ${tool}`);
    }
  }
}

const role = detectRole();
switch (role) {
  case "orchestrator":
    checkOrchestratorFlags();
    break;
  case "reviewer":
  case "pull-request-writer":
    checkReviewerFlags();
    break;
  case "planning":
    expectFlags([
      ...EXPECTED_FLAGS,
      ["--tools", "report" in schemaProperties() ? RESEARCH_TOOLS : PLANNING_TOOLS],
    ]);
    break;
}

/** The usage fields of every `result` object the fake prints for a planning call. */
const USAGE = {
  num_turns: 13,
  duration_ms: 1000,
  total_cost_usd: 0.01,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 20,
  },
};

/** Runs out of turns; the session keeps the prompt, so a retry that resumes it answers it. */
function failRun(): never {
  const sessionId = randomUUID();
  writeFileSync(sessionFile(sessionId), prompt);
  print({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    session_id: sessionId,
    ...USAGE,
  });
  process.exit(1);
}

if (prompt.includes(FAIL_MARKER)) {
  failRun();
}

/** The idea's text, from the prompt's `<<<IDEA nonce` block (L63); every planning prompt has one. */
function ideaText(): string | undefined {
  return /^<<<IDEA (\S+)\n([\s\S]*?)\nIDEA \1>>>$/m.exec(prompt)?.[2];
}

const idea = ideaText();

function e2eRoot(marker: string): string {
  const root = process.env[E2E_ROOT_ENV_VAR];
  if (root === undefined) {
    mismatch(`${marker} needs ${E2E_ROOT_ENV_VAR}`);
  }
  return root;
}

function ideaHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Fails the first two calls counted under `name` for the idea `text`. */
function failTwice(marker: string, name: string, text: string): void {
  const counter = join(e2eRoot(marker), `${name}-${ideaHash(text)}`);
  const failures = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  if (failures < 2) {
    writeFileSync(counter, String(failures + 1));
    failRun();
  }
}

/**
 * The planning call's kind, by its `--json-schema` root properties (see `structuredOutput`). Every
 * waypoint-run schema also has `outOfScope` and `mapChanges` roots, so neither tells a call apart.
 */
type PlanningKind =
  | "survey"
  | "fog"
  | "hatch"
  | "spec"
  | "revise"
  | "spec-review"
  | "tickets-review"
  | "tickets"
  | "chart"
  | "grilling"
  | "research"
  | "task"
  | "consistency";

function planningKind(): PlanningKind {
  const properties = schemaProperties();
  // The hatch's root `reply` first (slice 7b D2), then slice 7's roots: a spec review's `summary`
  // would otherwise read as a first chart.
  // A code survey's root `entries` (harness change #1) names no other call.
  if ("entries" in properties) {
    return "survey";
  }
  // The fog run's root `fogForPerson` (harness change #4) names no other call.
  if ("fogForPerson" in properties) {
    return "fog";
  }
  if ("reply" in properties) {
    return "hatch";
  }
  if ("specs" in properties) {
    return "spec";
  }
  if ("revision" in properties) {
    return "revise";
  }
  // A tickets review shares the spec review's roots; its prompt line tells them apart (L170 (b)).
  if (
    "summary" in properties &&
    "findings" in properties &&
    prompt.includes("Review of: tickets")
  ) {
    return "tickets-review";
  }
  if ("summary" in properties && "findings" in properties && prompt.includes("Review of: spec")) {
    return "spec-review";
  }
  if (
    "tickets" in properties &&
    "dispositions" in properties &&
    "slicing" in properties &&
    "execution" in properties
  ) {
    return "tickets";
  }
  // A chart's three steps (DR-22): `choose` and `confirm` have `waypoints`, `propose` `summary` alone.
  if ("waypoints" in properties || "summary" in properties) {
    return "chart";
  }
  if ("report" in properties) {
    return "research";
  }
  if ("done" in properties) {
    return "task";
  }
  if ("findings" in properties) {
    return "consistency";
  }
  if ("decision" in properties) {
    return "grilling";
  }
  mismatch(`--json-schema names no planning call: ${JSON.stringify(Object.keys(properties))}`);
}

if (idea?.includes(FAIL_TWICE_MARKER) === true) {
  failTwice(FAIL_TWICE_MARKER, "fake-fail-twice", idea);
}

if (idea !== undefined && role === "planning") {
  const kind = planningKind();
  for (const [scope, scopeKind] of Object.entries(SCOPED_FAIL_TWICE)) {
    const marker = `[fake:fail-twice:${scope}]`;
    if (scopeKind === kind && idea.includes(marker)) {
      failTwice(marker, `fake-fail-twice-${scope}`, idea);
    }
  }
}

if (prompt.includes(FAIL_ONCE_MARKER)) {
  const name = idea === undefined ? FAIL_ONCE_FILE : `${FAIL_ONCE_FILE}-${ideaHash(idea)}`;
  const marker = join(e2eRoot(FAIL_ONCE_MARKER), name);
  if (!existsSync(marker)) {
    writeFileSync(marker, "");
    failRun();
  }
}

/** The value of the prompt's `<label> <value>` line; a missing line is a mismatch. */
function promptValue(label: string): string {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(`${label} `));
  if (line === undefined) {
    mismatch(`the prompt has no \`${label}\` line`);
  }
  return line.slice(label.length + 1);
}

function readPromptFile(label: string): string {
  const path = promptValue(label);
  if (!existsSync(path)) {
    mismatch(`the prompt's \`${label}\` file ${path} does not exist`);
  }
  return readFileSync(path, "utf8");
}

/** The pinned spec the delivery prompt names (`Spec: <path>`); the idea's markers ride in it. */
function deliverySpec(): string {
  return readPromptFile("Spec:");
}

/** One ticket of the rendered `inputs/tickets.md` (core's `renderTickets`). */
interface PinnedTicket {
  id: string;
  title: string;
  criteria: string[];
  blockedBy: string[];
}

/** The tickets of the file the prompt names (`Tickets: <path>`), in their order there. */
function pinnedTickets(): PinnedTicket[] {
  const tickets: PinnedTicket[] = [];
  for (const line of readPromptFile("Tickets:").split("\n")) {
    const heading = /^## (T\d+) (.+)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      tickets.push({ id: heading[1], title: heading[2], criteria: [], blockedBy: [] });
      continue;
    }
    const current = tickets.at(-1);
    if (current === undefined || line.startsWith("## ")) {
      continue;
    }
    const carries = /^Carries criteria (.+)\.$/.exec(line)?.[1];
    if (carries !== undefined) {
      current.criteria = carries.split(", ");
    }
    const blocked = /^Blocked by (.+)\.$/.exec(line)?.[1];
    if (blocked !== undefined && blocked !== "none") {
      current.blockedBy = [...blocked.matchAll(/(T\d+) \(/g)].map((match) => match[0].slice(0, -2));
    }
  }
  if (tickets.length === 0) {
    mismatch("the tickets file has no `## T<n> <title>` heading");
  }
  return tickets;
}

/** The tickets in graph order: each after its blockers, otherwise in file order. */
function graphOrder(tickets: readonly PinnedTicket[]): PinnedTicket[] {
  const ordered: PinnedTicket[] = [];
  while (ordered.length < tickets.length) {
    const next = tickets.find(
      (ticket) =>
        !ordered.includes(ticket) &&
        ticket.blockedBy.every((blocker) => ordered.some((done) => done.id === blocker)),
    );
    if (next === undefined) {
      mismatch("the tickets file's blockers form a cycle or name a missing ticket");
    }
    ordered.push(next);
  }
  return ordered;
}

/** The file ticket `id`'s implementer writes, relative to its worktree. */
function ticketFile(id: string): string {
  return `zenorm-fake-${id.toLowerCase()}.txt`;
}

const SESSION_ID = "00000000-0000-4000-8000-00000000fake";
let toolUses = 0;

function nextToolUseId(): string {
  toolUses += 1;
  return `toolu_fake_${String(toolUses).padStart(4, "0")}`;
}

/** An `assistant` stream line; `parent` is the `Agent` tool use a subagent's line belongs to. */
function printAssistant(content: readonly unknown[], parent: string | null): void {
  print({
    type: "assistant",
    message: { role: "assistant", content },
    parent_tool_use_id: parent,
    session_id: SESSION_ID,
  });
}

/** Prints a `tool_use` line and returns its id. */
function printToolUse(name: string, input: object, parent: string | null): string {
  const id = nextToolUseId();
  printAssistant([{ type: "tool_use", id, name, input }], parent);
  return id;
}

/** Prints the `user` line carrying a tool's result. */
function printToolResult(id: string, content: unknown, parent: string | null): void {
  print({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
    },
    parent_tool_use_id: parent,
    session_id: SESSION_ID,
  });
}

/**
 * An orchestrator `Bash` call: prints its `tool_use`, runs `git` with `gitArgs` in `cwd` and prints
 * the non-error result. A failing git command throws, so the stand-in exits non-zero.
 */
function orchestratorGit(gitArgs: readonly string[], cwd: string): void {
  const command = ["git", ...gitArgs]
    .map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))
    .join(" ");
  const id = printToolUse("Bash", { command, description: `Run ${command}` }, null);
  const output = execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_MERGE_AUTOEDIT: "no" },
  });
  printToolResult(
    id,
    output.trim() === "" ? "(Bash completed with no output)" : output.trim(),
    null,
  );
}

/** An orchestrator `Bash` `cd`, which only changes where the stand-in runs its next commands. */
function orchestratorCd(path: string): void {
  const id = printToolUse("Bash", { command: `cd ${path}`, description: "Change directory" }, null);
  printToolResult(id, "(Bash completed with no output)", null);
}

/** Polls, still running, until the e2e writes the release file; never released is a mismatch. */
async function holdUntilReleasedAsync(marker: string, file: string): Promise<void> {
  const release = join(e2eRoot(marker), file);
  for (let waited = 0; !existsSync(release); waited += REVIEW_HELD_POLL_MS) {
    if (waited >= DELIVERY_HELD_MAX_MS) {
      mismatch(`${marker} was not released within ${String(DELIVERY_HELD_MAX_MS)} ms`);
    }
    await sleep(REVIEW_HELD_POLL_MS);
  }
}

/**
 * The orchestrator (slice 8 D4's stream shape): per ticket in graph order, a ticket worktree, an
 * `Agent` subagent writing the ticket's file, its commit there and a `git merge --no-ff` into the
 * run worktree, then a success `result`. The hold is async, so the lines printed before it reach
 * the runner while it holds.
 */
async function orchestrate(): Promise<void> {
  const slow = prompt
    .split("\n")
    .some((line) => line.startsWith("Check: ") && line.includes(SLOW_MARKER));
  if (slow) {
    process.on("SIGTERM", () => {
      process.exit(SIGTERM_EXIT);
    });
    // An open timer keeps the process alive until the signal arrives.
    setInterval(() => undefined, 1 << 30);
    return;
  }
  const repairAttempt = REPAIR_ATTEMPT_LINE.exec(prompt)?.[1];
  if (repairAttempt !== undefined) {
    await repair(repairAttempt);
    return;
  }
  const spec = deliverySpec();
  const pinned = pinnedTickets();
  if (String(pinned.length) !== promptValue("Ticket count:")) {
    mismatch(`the tickets file has ${String(pinned.length)} tickets, not the prompt's count`);
  }
  const tickets = graphOrder(pinned);
  const branch = promptValue("Run branch:");
  const runWorktree = process.cwd();
  const runDir = dirname(dirname(promptValue("Tickets:")));
  print({ type: "system", subtype: "init", cwd: runWorktree, session_id: SESSION_ID });
  printAssistant(
    [{ type: "text", text: "I'll read the spec and tickets, then work the graph." }],
    null,
  );

  for (const [index, ticket] of tickets.entries()) {
    const number = ticket.id.slice(1);
    const ticketBranch = `${branch}-t${number}`;
    const ticketWorktree = join(runDir, "tickets", `t${number}`);
    const last = index === tickets.length - 1;
    orchestratorGit(["worktree", "add", ticketWorktree, "-b", ticketBranch, branch], runWorktree);

    const agent = printToolUse(
      "Agent",
      {
        description: `${ticket.id}: ${ticket.title}`,
        prompt: `Implement ticket ${ticket.id} in ${ticketWorktree}.`,
        subagent_type: "general-purpose",
      },
      null,
    );
    if (index === 1 && spec.includes(DELIVERY_HELD_MARKER)) {
      await holdUntilReleasedAsync(DELIVERY_HELD_MARKER, DELIVERY_RELEASE_FILE);
    }
    const file = ticketFile(ticket.id);
    const filePath = join(ticketWorktree, file);
    const content = `Delivered ${ticket.id} by the e2e stand-in.\n`;
    printAssistant([{ type: "text", text: `I'll write ${file} for ${ticket.id}.` }], agent);
    const write = printToolUse("Write", { file_path: filePath, content }, agent);
    writeFileSync(filePath, content);
    printToolResult(write, `File created successfully at: ${filePath}`, agent);
    printToolResult(
      agent,
      [{ type: "text", text: `${ticket.id} is implemented: ${file} is written.` }],
      null,
    );

    orchestratorCd(ticketWorktree);
    orchestratorGit(["add", file], ticketWorktree);
    orchestratorGit(["commit", "-m", `${ticket.id}: ${ticket.title}`], ticketWorktree);
    orchestratorCd(runWorktree);
    if (last && spec.includes(TICKET_UNMERGED_MARKER)) {
      orchestratorGit(["worktree", "remove", "--force", ticketWorktree], runWorktree);
      orchestratorGit(["branch", "-D", ticketBranch], runWorktree);
      continue;
    }
    orchestratorGit(["merge", "--no-ff", ticketBranch], runWorktree);
  }

  if (spec.includes(DELIVERY_CLOSING_HELD_MARKER)) {
    printAssistant([{ type: "text", text: "Every ticket is merged. Running the checks." }], null);
    await holdUntilReleasedAsync(DELIVERY_CLOSING_HELD_MARKER, DELIVERY_CLOSING_RELEASE_FILE);
  }
  printAssistant([{ type: "text", text: "The ticket set is worked on the run branch." }], null);
  print({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: toolUses,
    result: "The ticket set is worked on the run branch.",
    session_id: SESSION_ID,
  });
}

/**
 * A repair attempt (C2): one `Agent`, described with no ticket id, writes
 * `zenorm-fake-repair-<attempt>.txt` in the run worktree; the orchestrator commits it on the run
 * branch and ends with success. It merges no ticket. With `[fake:repair-held]` in the spec it holds
 * after the `Agent` line until the e2e releases it.
 */
async function repair(attempt: string): Promise<void> {
  if (!/^<<<FAILING-CHECK-1 \S+$/m.test(prompt)) {
    mismatch("the repair prompt has no FAILING-CHECK-1 block");
  }
  const spec = deliverySpec();
  const runWorktree = process.cwd();
  print({ type: "system", subtype: "init", cwd: runWorktree, session_id: SESSION_ID });
  printAssistant(
    [{ type: "text", text: "I'll have one implementer fix the failing checks." }],
    null,
  );
  const agent = printToolUse(
    "Agent",
    {
      description: "Fix the failing checks",
      prompt: "Fix the failing checks in the run worktree.",
      subagent_type: "general-purpose",
    },
    null,
  );
  if (spec.includes(REPAIR_HELD_MARKER)) {
    await holdUntilReleasedAsync(REPAIR_HELD_MARKER, REPAIR_RELEASE_FILE);
  }
  const file = `zenorm-fake-repair-${attempt}.txt`;
  const filePath = join(runWorktree, file);
  const content = `Repair attempt ${attempt} by the e2e stand-in.\n`;
  const write = printToolUse("Write", { file_path: filePath, content }, agent);
  writeFileSync(filePath, content);
  printToolResult(write, `File created successfully at: ${filePath}`, agent);
  printToolResult(
    agent,
    [{ type: "text", text: `The checks are fixed: ${file} is written.` }],
    null,
  );
  orchestratorGit(["add", file], runWorktree);
  orchestratorGit(["commit", "-m", `Repair attempt ${attempt}`], runWorktree);
  printAssistant([{ type: "text", text: "The failing checks are repaired." }], null);
  print({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: toolUses,
    result: "The failing checks are repaired.",
    session_id: SESSION_ID,
  });
}

/**
 * The verdict on the prompt's `Final commit:`: no findings, or with `[fake:review-blocked]` in the
 * spec the prompt names, one blocking finding citing T1's first criterion.
 */
function review(): unknown {
  const finalCommit = /^Final commit: ([0-9a-f]{40})$/m.exec(prompt)?.[1];
  if (finalCommit === undefined) {
    mismatch("the reviewer prompt has no `Final commit: <sha>` line");
  }
  if (!deliverySpec().includes(REVIEW_BLOCKED_MARKER)) {
    return {
      reviewedCommit: finalCommit,
      summary: "The change matches the tickets.",
      findings: [],
    };
  }
  const first = pinnedTickets()[0];
  const criterion = first?.criteria[0];
  if (first === undefined || criterion === undefined) {
    mismatch("the tickets file's first ticket carries no criterion");
  }
  return {
    reviewedCommit: finalCommit,
    summary: "The change misses a criterion.",
    findings: [
      {
        axis: "spec",
        severity: "blocking",
        file: ticketFile(first.id),
        title: "The change misses a criterion",
        detail: "The stand-in reviewer blocks when the spec carries the marker.",
        criterion,
      },
    ],
  };
}

/**
 * The pull request body for the prompt's `Final commit:`: the PR skill's Why, What, Tests and Risks
 * headings, starting at Why.
 */
function pullRequestBody(): string {
  const finalCommit = /^Final commit: ([0-9a-f]{40})$/m.exec(prompt)?.[1];
  if (finalCommit === undefined) {
    mismatch("the pull request writer prompt has no `Final commit: <sha>` line");
  }
  return [
    "## Why",
    "",
    "The stand-in's tickets needed their files.",
    "",
    "## What",
    "",
    `- The stand-in delivered every ticket at ${finalCommit.slice(0, 7)}: each ticket's file is committed.`,
    "",
    "## Tests",
    "",
    "The stand-in ran no tests.",
    "",
    "## Risks",
    "",
    "None: the change only adds files.",
    "",
  ].join("\n");
}

/** The integer on the prompt's line starting with `label`; a missing line is a mismatch. */
function promptNumber(label: string): number {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(label));
  if (line === undefined) {
    mismatch(`the prompt has no \`${label}\` line`);
  }
  const value = Number(line.slice(label.length));
  if (!Number.isInteger(value)) {
    mismatch(`the prompt's \`${label}\` line has no number: ${line}`);
  }
  return value;
}

/** A waypoint's next round: waypoint 1 asks a non-final then a final round; 2 and 3 one final. */
function grill(): unknown {
  const waypoint = promptNumber("Waypoint number: ");
  if (idea?.includes(STATES_MARKER) === true && waypoint === STATES_OUT_OF_SCOPE_WAYPOINT) {
    return {
      kind: "outOfScope",
      intro: null,
      final: null,
      questions: null,
      decision: null,
      gist: null,
      agentDecided: null,
      outOfScope: proposes()
        ? { reason: STATES_OUT_OF_SCOPE_REASON, proposal: WAYPOINT_PROPOSAL }
        : { reason: STATES_OUT_OF_SCOPE_REASON },
      mapChanges: NO_MAP_CHANGES,
    };
  }
  const answered = promptNumber("Answered rounds on this waypoint: ");
  const rounds = waypoint === 1 ? 2 : 1;
  if (answered >= rounds) {
    mismatch(
      `waypoint ${String(waypoint)} has ${String(answered)} answered rounds; the stand-in asks ${String(rounds)}`,
    );
  }
  const final = answered === rounds - 1;
  return {
    kind: "round",
    intro: final
      ? "One last round: these answers settle the waypoint."
      : "Two choices first; your answers may open more.",
    final,
    questions: GRILL_QUESTIONS,
    decision: null,
    gist: null,
    agentDecided: null,
    outOfScope: null,
    mapChanges: null,
  };
}

/** Whether the idea is charted as `[fake:kinds]`: Research 1, Task 2 and Grilling 3. */
function chartsKinds(): boolean {
  return [KINDS_MARKER, RESEARCH_UNANSWERED_MARKER, TASK_FAILED_MARKER].some(
    (marker) => idea?.includes(marker) === true,
  );
}

/** A research run's report: answered, unless `[fake:research-unanswered]` and no earlier report. */
function researchOutput(): unknown {
  const earlier = promptNumber("Earlier reports on this waypoint: ");
  const report =
    idea?.includes(RESEARCH_UNANSWERED_MARKER) === true && earlier === 0
      ? {
          answered: false,
          summary: "The stand-in found nothing on what Excel expects.",
          gap: "Which encoding Excel opens without asking.",
          gist: null,
          findings: [],
          sources: [],
          limitations: ["The stand-in reads no source."],
          uncertainties: [],
        }
      : {
          answered: true,
          summary: "Excel opens UTF-8 with a byte order mark and CRLF line endings without asking.",
          gap: null,
          gist: "UTF-8 with BOM, CRLF",
          findings: [
            {
              title: "Byte order mark",
              detail: "Excel reads a UTF-8 file as UTF-8 only when it starts with a BOM.",
              sources: [1],
            },
          ],
          sources: [
            {
              kind: "external",
              title: "Excel CSV import",
              url: "https://support.microsoft.com/excel-csv",
              excerpt: "Save the file as CSV UTF-8 to keep its characters.",
            },
          ],
          limitations: [],
          uncertainties: [],
        };
  return { report, outOfScope: null, mapChanges: NO_MAP_CHANGES };
}

/**
 * A task run's outcome: one round with options, then `done`; with `[fake:task-failed]`, `failed`
 * when there is no earlier outcome, then `done`.
 */
function taskOutput(): unknown {
  const done = {
    kind: "done",
    intro: null,
    questions: null,
    done: {
      action: "Counted the fields of the stored record type.",
      facts: "Each stored record has 12 fields.",
      gist: "12 fields per record",
      agentDecided: [],
    },
    failed: null,
    outOfScope: null,
    mapChanges: NO_MAP_CHANGES,
  };
  if (idea?.includes(TASK_FAILED_MARKER) === true) {
    if (promptNumber("Earlier outcomes on this task: ") > 0) {
      return done;
    }
    return {
      kind: "failed",
      intro: null,
      questions: null,
      done: null,
      failed: {
        action: "Tried to read the stored record type.",
        facts: "The stand-in could not find the record type.",
      },
      outOfScope: null,
      mapChanges: NO_MAP_CHANGES,
    };
  }
  if (promptNumber("Answered rounds on this waypoint: ") > 0) {
    return done;
  }
  return {
    kind: "round",
    intro: "One thing before I count.",
    questions: [
      {
        topic: "Records",
        text: "Which record type does the export read?",
        options: [
          { label: "The ledger entries", detail: "The export reads the stored ledger." },
          { label: "Another record type", detail: "Name it in your words." },
        ],
      },
    ],
    done: null,
    failed: null,
    outOfScope: null,
    mapChanges: null,
  };
}

/** Every fog position the prompt lists (`Fog item at position n:`). */
function fogPositions(): number[] {
  return [...prompt.matchAll(/^Fog item at position (\d+):$/gm)].map((match) => Number(match[1]));
}

/** Map changes moving every listed fog item out of scope. */
function fogMovedOutOfScope(): unknown {
  return {
    ...NO_MAP_CHANGES,
    fogOutOfScope: fogPositions().map((position) => ({ position, line: FOG_OUT_OF_SCOPE_LINE })),
  };
}

/**
 * A resolving run's map changes: none, except that `[fake:kinds]`'s waypoint 3 moves the fog out of
 * scope. Any other fog is left to the map's fog run.
 */
function resolvingMapChanges(): unknown {
  if (chartsKinds() && promptNumber("Waypoint number: ") === 3) {
    return fogMovedOutOfScope();
  }
  return NO_MAP_CHANGES;
}

/**
 * The map's fog run (harness change #4): every listed fog item moves out of scope; with
 * `[fake:propose]`, every one is proposed as a new map instead.
 */
function fogRunOutput(): unknown {
  if (proposes()) {
    return {
      fogSettledBy: [],
      fogDecided: [],
      fogOutOfScope: [],
      fogForPerson: [],
      fogProposed: fogPositions().map((position) => ({
        position,
        title: FOG_PROPOSAL_TITLE,
        idea: FOG_PROPOSAL_IDEA,
        line: FOG_PROPOSAL_LINE,
      })),
    };
  }
  return {
    fogSettledBy: [],
    fogDecided: [],
    fogOutOfScope: fogPositions().map((position) => ({ position, line: FOG_OUT_OF_SCOPE_LINE })),
    fogForPerson: [],
    fogProposed: [],
  };
}

function revised(title: string): string {
  return `${title}${REVISED}`;
}

/**
 * A consistency pass's findings: none, except that `[fake:conflict]`'s first pass (no waypoint
 * opened by an earlier pass) finds one conflict between waypoints 1 and 2.
 */
/**
 * The code survey's reply: the e2e repositories hold only an empty commit, so it names the
 * repository root, which every project has, and no file or line.
 */
const SURVEY = {
  entries: [
    {
      area: ".",
      role: "The project's repository root.",
      touched: true,
      why: "The repository holds no code yet; the destination adds it.",
      surfaceFiles: [],
      facts: [],
    },
  ],
  identifiers: [],
  unverifiable: ["The repository holds no code to survey."],
  lifecycles: [],
};

function consistencyOutput(): unknown {
  const firstPass = promptNumber("Waypoints opened by an earlier pass: ") === 0;
  if (proposes()) {
    return { findings: [], proposals: [CONSISTENCY_PROPOSAL] };
  }
  if (idea?.includes(CONFLICT_MARKER) !== true || !firstPass) {
    return { findings: [], proposals: [] };
  }
  return {
    findings: [
      {
        kind: "conflicting_surfaces",
        waypointNumbers: [1, 2],
        title: "Columns against encoding",
        explanation:
          "Waypoint 1 says “every column is exported”; waypoint 2 says “ASCII only”, which some columns are not.",
        question: "Which wins when a column holds text outside ASCII?",
      },
    ],
    proposals: [],
  };
}

/** The clause sources a map's specs name: its resolved waypoints, or the destination when none. */
function clauseSources(): unknown[] {
  const line = /^Resolved waypoints: (.+)$/m.exec(prompt)?.[1];
  if (line === undefined) {
    mismatch("the To Spec prompt has no `Resolved waypoints:` line");
  }
  if (line === "none") {
    return [{ kind: "destination" }];
  }
  return line.split(", ").map((number) => ({ kind: "waypoint", number: Number(number) }));
}

/** Whether the idea gates the canned spec's third criterion (`[fake:three-criteria]`). */
function threeCriteria(): boolean {
  return idea?.includes(THREE_CRITERIA_MARKER) === true;
}

/** The project spec `[fake:revise:<n>]` names, if the idea carries it. */
function reviseTarget(): number | undefined {
  const number = idea === undefined ? undefined : REVISE_MARKER.exec(idea)?.[1];
  return number === undefined ? undefined : Number(number);
}

/** A spec revision document as the stand-in writes and reads it back (the shown JSON). */
interface ShownCriterion {
  id: string;
  text: string;
  was?: string;
}
interface ShownClause {
  id: string;
  title: string;
  text: string;
  criteria: ShownCriterion[];
  sources: unknown[];
}
interface ShownRevision {
  title: string;
  problem: string;
  solution: string;
  clauses: ShownClause[];
  outOfScope: string[];
}

/** Parses a `SPEC-<n>-REVISION-<r>` block's JSON; the stand-in only ever reads its own documents. */
function parseShown(text: string, name: string): ShownRevision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    mismatch(`the ${name} block is not JSON`);
  }
  if (!isShownRevision(parsed)) {
    mismatch(`the ${name} block is not a spec revision`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isShownCriterion(value: unknown): value is ShownCriterion {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.was === undefined || typeof value.was === "string")
  );
}

function isShownClause(value: unknown): value is ShownClause {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.criteria) &&
    value.criteria.every(isShownCriterion) &&
    Array.isArray(value.sources)
  );
}

function isShownRevision(value: unknown): value is ShownRevision {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.problem === "string" &&
    typeof value.solution === "string" &&
    Array.isArray(value.clauses) &&
    value.clauses.every(isShownClause) &&
    isStringArray(value.outOfScope)
  );
}

/** The first `SPEC-<specNumber>-REVISION-<r>` block of the prompt (the map's own specs come first). */
function shownRevision(specNumber: number): ShownRevision {
  const name = `SPEC-${String(specNumber)}-REVISION-`;
  const match = new RegExp(
    `^<<<${name}(\\d+) (\\S+)\\n([\\s\\S]*?)\\n${name}\\1 \\2>>>$`,
    "m",
  ).exec(prompt);
  if (match?.[3] === undefined) {
    mismatch(`the prompt shows no revision of spec ${String(specNumber)}`);
  }
  return parseShown(match[3], `${name}${String(match[1])}`);
}

/** The first spec revision block of the prompt: a spec repair's latest revision. */
function firstShownRevision(): ShownRevision {
  const number = /^<<<SPEC-(\d+)-REVISION-\d+ \S+$/m.exec(prompt)?.[1];
  if (number === undefined) {
    mismatch("the prompt shows no spec revision");
  }
  return shownRevision(Number(number));
}

function withoutRevised(title: string): string {
  return title.replaceAll(REVISED, "");
}

/**
 * A repair of a shown revision: " (revised)" titles, kept ids and no sources (every clause is kept),
 * and the problem from this map's idea, so the revision's delivery reads this idea's markers.
 */
function repaired(shown: ShownRevision): ShownRevision {
  return {
    ...shown,
    title: revised(withoutRevised(shown.title)),
    problem: specProblem(),
    clauses: shown.clauses.map((clause) => ({
      ...clause,
      title: revised(withoutRevised(clause.title)),
      sources: [],
    })),
  };
}

/** The ids `[fake:revise:<n>]` keeps, changes and removes, in the shown order; three or more. */
function revisedIds(ids: readonly string[]): { kept: string; changed: string; removed: string } {
  const [kept, changed] = ids;
  const removed = ids.at(-1);
  if (ids.length < 3 || kept === undefined || changed === undefined || removed === undefined) {
    mismatch(
      `[fake:revise:<n>] needs a spec with three criteria (${ids.join(", ")}); chart its first map with ${THREE_CRITERIA_MARKER}`,
    );
  }
  return { kept, changed, removed };
}

/**
 * `[fake:revise:<n>]`'s next revision of a shown revision, ids kept: the first criterion word for
 * word, the second changed, the last removed and a new one with the next free id of the last's
 * clause. The clauses it changes cite this map's resolved waypoints; the others cite nothing.
 */
function laterRevision(shown: ShownRevision): ShownRevision {
  const ids = shown.clauses.flatMap((clause) => clause.criteria.map((criterion) => criterion.id));
  const { changed, removed } = revisedIds(ids);
  const [clauseNumber] = removed.split(".");
  const sources = clauseSources();
  return {
    ...shown,
    problem: specProblem(),
    clauses: shown.clauses.map((clause) => {
      const touched = clause.criteria.some(
        (criterion) => criterion.id === changed || criterion.id === removed,
      );
      const criteria = clause.criteria
        .filter((criterion) => criterion.id !== removed)
        .map((criterion) =>
          criterion.id === changed
            ? { ...criterion, text: `${criterion.text}${CHANGED_CRITERION_TAIL}` }
            : criterion,
        );
      if (clause.id === `C${String(clauseNumber)}`) {
        const next = Math.max(
          ...clause.criteria.map((criterion) => Number(criterion.id.split(".")[1])),
        );
        criteria.push({
          id: `${String(clauseNumber)}.${String(next + 1)}`,
          text: ADDED_CRITERION_TEXT,
        });
      }
      return { ...clause, criteria, sources: touched ? sources : [] };
    }),
  };
}

/** `[fake:nothing-new]`'s next revision: one Out of scope line more, every clause as it was. */
function nothingNewRevision(shown: ShownRevision): ShownRevision {
  return {
    ...shown,
    problem: specProblem(),
    clauses: shown.clauses.map((clause) => ({ ...clause, sources: [] })),
    outOfScope: [...shown.outOfScope, NOTHING_NEW_OUT_OF_SCOPE],
  };
}

/** The prompt's `Project spec <n>, latest revision <r>, …:` line, read (slice 8b D6). */
function projectSpecStatus(specNumber: number): {
  revision: number;
  approved: boolean;
  held: boolean;
} {
  const match = new RegExp(
    `^Project spec ${String(specNumber)}, latest revision (\\d+), (approved|not approved), (?:delivered|not delivered), (held \\(\\w+\\) by map “.*” at revision \\d+|not held):$`,
    "m",
  ).exec(prompt);
  if (match === null) {
    mismatch(`the prompt has no \`Project spec ${String(specNumber)}, latest revision …\` line`);
  }
  return {
    revision: Number(match[1]),
    approved: match[2] === "approved",
    held: match[3] !== "not held",
  };
}

/**
 * The touch `[fake:revise:<n>]`'s confirming chart puts on its first waypoint: spec n's latest
 * approved revision and the criterion the revision changes. While another map's draft is the
 * latest revision, the approved one comes from the prompt's `Project spec <n> latest approved
 * revision: <r>` and `Project spec <n> approved criterion ids:` lines (L213 D-5). None when spec n
 * has no approved revision.
 */
function revisionTouch(): unknown {
  const target = reviseTarget();
  if (target === undefined) {
    return null;
  }
  const status = projectSpecStatus(target);
  const approved = status.approved ? status.revision : latestApprovedRevision(target);
  if (approved === null) {
    return null;
  }
  const idsLine = status.approved ? "criterion ids" : "approved criterion ids";
  const ids = new RegExp(`^Project spec ${String(target)} ${idsLine}: (.+)$`, "m").exec(
    prompt,
  )?.[1];
  if (ids === undefined) {
    mismatch(`the prompt has no \`Project spec ${String(target)} ${idsLine}:\` line`);
  }
  const { changed } = revisedIds(ids.split(", "));
  return { specNumber: target, revision: approved, criteria: [changed] };
}

/** Spec n's latest approved revision from its `… latest approved revision: <r>|none` line. */
function latestApprovedRevision(specNumber: number): number | null {
  const value = new RegExp(
    `^Project spec ${String(specNumber)} latest approved revision: (\\d+|none)$`,
    "m",
  ).exec(prompt)?.[1];
  if (value === undefined) {
    mismatch(
      `the prompt has no \`Project spec ${String(specNumber)} latest approved revision:\` line`,
    );
  }
  return value === "none" ? null : Number(value);
}

/** The confirming chart's waypoints, the first touching `[fake:revise:<n>]`'s spec (L202 (1)). */
function withRevisionTouch<T extends object | undefined>(waypoints: readonly T[]): T[] {
  const touch = revisionTouch();
  return waypoints.map((waypoint, index) =>
    touch !== null && index === 0 ? { ...waypoint, touches: [touch] } : waypoint,
  );
}

/** One `Reading <id>: …` line of a To Tickets prompt (slice 8b D8). */
interface Reading {
  id: string;
  change: string;
  expected: string;
  baseline: string | null;
}

function promptReadings(): Reading[] {
  return [
    ...prompt.matchAll(
      /^Reading (\S+): (new|changed|moved|unchanged), expected (\w+), (?:baseline (T\d+) \(revision \d+, run \d+, commit \S+\)|baseline none)$/gm,
    ),
  ].map((match) => ({
    id: String(match[1]),
    change: String(match[2]),
    expected: String(match[3]),
    // eslint-disable-next-line no-restricted-syntax -- the optional baseline group is absent for "baseline none", which is null
    baseline: match[4] ?? null,
  }));
}

/** One `Earlier ticket <T> (revision <r>): …` line of a To Tickets prompt. */
interface EarlierTicketLine {
  id: string;
  criteria: string[];
  delivered: { run: string; commit: string } | null;
}

function promptEarlierTickets(): EarlierTicketLine[] {
  return [
    ...prompt.matchAll(
      /^Earlier ticket (T\d+) \(revision \d+\): criteria (.+); (?:delivered in run (\d+), commit (\S+)|not delivered)$/gm,
    ),
  ].map((match) => ({
    id: String(match[1]),
    criteria: match[2] === "none" ? [] : String(match[2]).split(", "),
    delivered:
      match[3] === undefined || match[4] === undefined ? null : { run: match[3], commit: match[4] },
  }));
}

/** A ticket of a later set while it is built: its criteria, follow-up and the criteria it takes out. */
interface LaterGroup {
  criteria: string[];
  followUp: string | null;
  takesOut: string[];
}

type LaterDisposition =
  | { criterion: string; kind: "work"; group: string; reason: string | null }
  | { criterion: string; kind: "delivered"; ticket: string; reason: string | null }
  | { criterion: string; kind: "retained"; ticket: string; reason: null }
  | { criterion: string; kind: "removed"; group: string | null; reason: string };

/**
 * A later revision's set, from the prompt's readings as the demo's `reconcile` does: `delivered`
 * names the baseline ticket; `work` goes to a ticket following up the baseline ticket (or, with no
 * baseline, one per clause); `retained` names the earlier ticket carrying it; each removed criterion
 * is taken out by the ticket following up the delivered ticket that built it (else the ticket of its
 * clause, else a ticket of its own), or is `removed` with no ticket when none delivered it. Tickets
 * are numbered from `First ticket number:`. `[fake:departure]` writes the first `delivered`
 * reading `work` with a reason; `[fake:departure-no-reason]` with none until a repair.
 */
function laterTicketSet() {
  const first = promptNumber("First ticket number: ");
  const readings = promptReadings();
  const earlier = promptEarlierTickets();
  const departs =
    idea?.includes(DEPARTURE_MARKER) === true || idea?.includes(DEPARTURE_NO_REASON_MARKER) === true
      ? readings.find((reading) => reading.expected === "delivered")
      : undefined;
  const departureReason =
    idea?.includes(DEPARTURE_NO_REASON_MARKER) === true && !/^<<<FINDINGS \S+$/m.test(prompt)
      ? null
      : DEPARTURE_REASON;
  const groups = new Map<string, LaterGroup>();
  const groupFor = (key: string, followUp: string | null): LaterGroup => {
    const found = groups.get(key);
    if (found !== undefined) {
      return found;
    }
    const group: LaterGroup = { criteria: [], followUp, takesOut: [] };
    groups.set(key, group);
    return group;
  };
  const dispositions: LaterDisposition[] = readings.map((reading) => {
    const { id, baseline } = reading;
    if (reading === departs || reading.expected === "work") {
      // eslint-disable-next-line no-restricted-syntax -- a reading with no baseline is grouped under its own criterion number, not defaulted
      const key = baseline ?? `C${String(id.split(".")[0])}`;
      groupFor(key, baseline).criteria.push(id);
      return {
        criterion: id,
        kind: "work",
        group: key,
        reason: reading === departs ? departureReason : null,
      };
    }
    if (reading.expected === "delivered") {
      if (baseline === null) {
        mismatch(`reading ${id} expects delivered with no baseline`);
      }
      return {
        criterion: id,
        kind: "delivered",
        ticket: baseline,
        reason:
          reading.change === "unchanged"
            ? null
            : "The delivered code already does what the new text says.",
      };
    }
    if (reading.expected === "retained") {
      const carrier = earlier.findLast(
        (ticket) => ticket.delivered === null && ticket.criteria.includes(id),
      );
      if (carrier === undefined) {
        mismatch(`reading ${id} expects retained, but no undelivered earlier ticket carries it`);
      }
      return { criterion: id, kind: "retained", ticket: carrier.id, reason: null };
    }
    mismatch(`the stand-in writes no disposition for reading ${id}'s expected ${reading.expected}`);
  });
  for (const [, id, clause] of prompt.matchAll(/^Removed criterion (\S+) \(clause (C\d+)\)$/gm)) {
    const criterion = String(id);
    const carrier = earlier.findLast(
      (ticket) => ticket.delivered !== null && ticket.criteria.includes(criterion),
    );
    if (carrier?.delivered === undefined || carrier.delivered === null) {
      dispositions.push({
        criterion,
        kind: "removed",
        group: null,
        reason: "No delivered ticket built it, so nothing in the code takes it out.",
      });
      continue;
    }
    const key = groups.has(carrier.id)
      ? carrier.id
      : groups.has(String(clause))
        ? String(clause)
        : carrier.id;
    const group = groupFor(key, carrier.id);
    group.followUp ??= carrier.id;
    group.takesOut.push(criterion);
    dispositions.push({
      criterion,
      kind: "removed",
      group: key,
      reason: `${carrier.id} built it in run ${carrier.delivered.run}, commit ${carrier.delivered.commit}; this ticket takes it out.`,
    });
  }
  const ids = new Map([...groups.keys()].map((key, index) => [key, `T${String(first + index)}`]));
  const ticketOf = (key: string): string => {
    const ticket = ids.get(key);
    if (ticket === undefined) {
      mismatch(`no ticket for ${key}`);
    }
    return ticket;
  };
  const tickets = [...groups.entries()].map(([key, group]) => ({
    id: ticketOf(key),
    title:
      group.followUp === null
        ? `Build criteria ${group.criteria.join(", ")}`
        : `Change what ${group.followUp} built`,
    build: [
      group.criteria.length === 0 ? "" : `Make criteria ${group.criteria.join(", ")} hold.`,
      group.takesOut.length === 0
        ? ""
        : `Take criteria ${group.takesOut.join(", ")} out of the code.`,
    ]
      .filter((sentence) => sentence !== "")
      .join(" "),
    blockedBy: [],
    criteria: group.criteria,
    testing: ["The package's tests cover the change."],
    followUp: group.followUp,
    outOfScope: [],
    pointers: ["src/index.ts"],
  }));
  return {
    tickets,
    dispositions: dispositions.map((disposition) => {
      switch (disposition.kind) {
        case "work":
          return {
            criterion: disposition.criterion,
            kind: "work",
            ticket: ticketOf(disposition.group),
            reason: disposition.reason,
          };
        case "removed":
          return {
            criterion: disposition.criterion,
            kind: "removed",
            ticket: disposition.group === null ? null : ticketOf(disposition.group),
            reason: disposition.reason,
          };
        case "delivered":
        case "retained":
          return disposition;
      }
    }),
    slicing:
      tickets.length === 0
        ? "Nothing new to build: every criterion is already delivered."
        : "One ticket per delivered ticket it changes, and one per clause for new criteria.",
    execution: "Each ticket's tests run in the package's suite.",
  };
}

/** One `disposition_without_reason` finding per `Departure <id>: no reason` line (slice 8b S8b-13). */
function departureFindings(): unknown[] {
  return [...prompt.matchAll(/^Departure (\S+): no reason$/gm)].map(([, id]) => ({
    kind: "disposition_without_reason",
    route: "revise",
    title: `${String(id)} departs with no reason`,
    explanation: `The disposition of ${String(id)} departs from its expected kind and gives no reason.`,
    question: `Why does ${String(id)} need a different disposition than its reading expects?`,
    ticketNumbers: [],
    criterionIds: [String(id)],
  }));
}

/**
 * A map To Spec's specs: on a re-clear, the next revision of each spec the prompt lists as not
 * approved (kept ids, so no clause needs a source); else one spec, or two or four by the markers.
 */
function draftSpecsOutput(): unknown {
  const listed = [
    ...prompt.matchAll(/^Spec (\d+), latest revision \d+, (approved|not approved):$/gm),
  ];
  if (listed.length > 0) {
    return {
      specs: listed.flatMap(([, number, approval]) =>
        approval === "approved"
          ? []
          : [
              {
                specNumber: Number(number),
                content: repaired(shownRevision(Number(number))),
              },
            ],
      ),
      waits: [],
    };
  }
  const target = reviseTarget();
  if (target !== undefined) {
    if (projectSpecStatus(target).held) {
      return { specs: [], waits: [{ specNumber: target, note: WAIT_NOTE }] };
    }
    const shown = shownRevision(target);
    return {
      specs: [
        {
          specNumber: target,
          content:
            idea?.includes(NOTHING_NEW_MARKER) === true
              ? nothingNewRevision(shown)
              : laterRevision(shown),
        },
      ],
      waits: [],
    };
  }
  if (idea?.includes(NOTHING_NEW_MARKER) === true) {
    mismatch(`${NOTHING_NEW_MARKER} needs a [fake:revise:<n>] marker naming the spec it revises`);
  }
  const count =
    idea?.includes(FOUR_SPECS_MARKER) === true
      ? 4
      : idea?.includes(TWO_SPECS_MARKER) === true
        ? 2
        : 1;
  return {
    specs: SPEC_TITLES.slice(0, count).map((title) => ({
      specNumber: null,
      content: specContent(clauseSources(), "", title),
    })),
    waits: [],
  };
}

/** A finding on clause C1, routed `revise` or `decision`. */
function specFinding(route: "revise" | "decision"): unknown {
  return route === "revise"
    ? {
        kind: "invented_scope",
        route,
        title: "C1 promises more than the waypoints settle",
        explanation: "C1 says “every record”, which no resolution settles.",
        question: "Should the export cover every record, or only the ones on screen?",
        elementIds: ["C1"],
        waypointNumbers: [],
      }
    : {
        kind: "undefined_term",
        route,
        title: "Which records count as exported",
        explanation: "C1 says “every record” but no source says which records a project has.",
        question: "Which records does the export cover?",
        elementIds: ["C1"],
        waypointNumbers: [],
      };
}

/** Blocks, still running, until the e2e writes the release file; a review never released fails. */
function holdUntilReleased(marker: string, file: string): void {
  const release = join(e2eRoot(marker), file);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; !existsSync(release); waited += REVIEW_HELD_POLL_MS) {
    if (waited >= REVIEW_HELD_MAX_MS) {
      mismatch(`${marker} was not released within ${String(REVIEW_HELD_MAX_MS)} ms`);
    }
    Atomics.wait(sleeper, 0, 0, REVIEW_HELD_POLL_MS);
  }
}

/** A spec review's verdict on `Review of: spec N revision R`, by the idea's review markers. */
function specReviewOutput(): unknown {
  const revision = /^Review of: spec \d+ revision (\d+)$/m.exec(prompt)?.[1];
  if (revision === undefined) {
    mismatch("the spec review prompt has no `Review of: spec N revision R` line");
  }
  const number = Number(revision);
  if (idea?.includes(REVIEW_HELD_MARKER) === true && number === 1) {
    holdUntilReleased(REVIEW_HELD_MARKER, REVIEW_RELEASE_FILE);
  }
  // A repair or re-clear rewrites a draft in place (L241), so a review's place in the loop is told
  // by the spec's earlier failed reviews (the prompt's `Revision N:` lines under EARLIER FINDINGS).
  const earlierBlock = /^<<<EARLIER-FINDINGS (\S+)$([\s\S]*?)^EARLIER-FINDINGS \1>>>$/m.exec(
    prompt,
  );
  const listed = earlierBlock?.[2];
  const failedBefore = listed === undefined ? 0 : [...listed.matchAll(/^Revision \d+:$/gm)].length;
  const findings =
    idea?.includes(REVIEW_DECISION_MARKER) === true && failedBefore === 0
      ? [specFinding("decision"), specFinding("revise")]
      : (idea?.includes(REVIEW_FAILS_ONCE_MARKER) === true && failedBefore === 0) ||
          (idea?.includes(REVIEW_ESCALATES_MARKER) === true && failedBefore < 3)
        ? [specFinding("revise")]
        : [];
  return {
    summary:
      findings.length === 0
        ? "The spec carries every resolution of the map."
        : "The spec says more than its sources settle.",
    findings,
    verified: [],
  };
}

/** The first id on the prompt's `<label> ids: a, b` line; a missing line is a mismatch. */
function firstId(label: string): string {
  const id = new RegExp(`^${label} ids: ([^,\\s]+)`, "m").exec(prompt)?.[1];
  if (id === undefined) {
    mismatch(`the prompt has no \`${label} ids:\` line`);
  }
  return id;
}

/**
 * The version's first ticket and the approved revision's first criterion, from the prompt's
 * `Version ticket ids:` and `Revision criterion ids:` lines, so a finding names only ids the
 * version and the revision carry (S7c-3).
 */
function reviewedIds(): { ticket: string; criterion: string } {
  return { ticket: firstId("Version ticket"), criterion: firstId("Revision criterion") };
}

/** A tickets review finding on the reviewed version's first ticket, routed `revise` or `decision`. */
function ticketsFinding(route: "revise" | "decision"): unknown {
  const { ticket, criterion } = reviewedIds();
  return route === "revise"
    ? {
        kind: "untraced_criterion",
        route,
        title: `${ticket} adds detail ${criterion} does not state`,
        explanation: `${ticket}'s build names a column order that criterion ${criterion} never states.`,
        question: `Should ${ticket} drop the column order, since ${criterion} does not ask for one?`,
        ticketNumbers: [ticket],
        criterionIds: [criterion],
      }
    : {
        kind: "contradiction",
        route,
        title: `${criterion} admits two slicings`,
        explanation: `${criterion} can ship before or after the button, and the clause picks neither.`,
        question: `Should ${ticket} ship the exporter on its own, or together with the button?`,
        ticketNumbers: [ticket],
        criterionIds: [criterion],
      };
}

/** A tickets review's verdict on `Review of: tickets N version V`, by the idea's tickets markers. */
function ticketsReviewOutput(): unknown {
  const line = /^Review of: tickets \d+ version (\d+)$/m.exec(prompt)?.[1];
  if (line === undefined) {
    mismatch("the tickets review prompt has no `Review of: tickets N version V` line");
  }
  const version = Number(line);
  if (idea?.includes(TICKETS_REVIEW_HELD_MARKER) === true && version === 1) {
    holdUntilReleased(TICKETS_REVIEW_HELD_MARKER, TICKETS_REVIEW_RELEASE_FILE);
  }
  const findings = [
    ...departureFindings(),
    ...(idea?.includes(TICKETS_DECISION_MARKER) === true && version === 1
      ? [ticketsFinding("decision")]
      : (idea?.includes(TICKETS_FAIL_ONCE_MARKER) === true && version === 1) ||
          (idea?.includes(TICKETS_HELD_MARKER) === true && version <= 3)
        ? [ticketsFinding("revise")]
        : []),
  ];
  if (idea?.includes(TICKETS_LONG_SUMMARY_MARKER) === true) {
    return { summary: LONG_TICKETS_SUMMARY, findings };
  }
  return {
    summary:
      findings.length === 0
        ? "Every ticket traces to the approved revision, and every criterion is covered."
        : "A ticket departs from the approved revision.",
    findings,
  };
}

/**
 * A To Tickets run's set: T1 and T2 with a `work` disposition each, or with
 * `[fake:tickets-already-done]` T1 alone and criterion 2.1 `satisfied` with evidence. A rewrite
 * (`Rewrite of ticket set version: <n>`) repairs review findings (`FINDINGS` block) or follows a
 * rejection or note (`REASON` block); its titles gain " (revised)".
 */
function ticketSetOutput(): unknown {
  // A same-map repair's revision 2 has a text delta too, and keeps the canned set (51 flows).
  const set = reviseTarget() === undefined ? firstSetOutput() : laterTicketSet();
  // The line is always sent; a rewrite names the version it replaces (L137 (b)).
  if (!/^Rewrite of ticket set version: \d+$/m.test(prompt)) {
    return set;
  }
  if (!/^<<<(FINDINGS|REASON) \S+$/m.test(prompt)) {
    mismatch("the To Tickets rewrite prompt has neither a FINDINGS nor a REASON block");
  }
  const repairHeld = idea === undefined ? null : TICKETS_REPAIR_HELD_MARKER.exec(idea);
  const repairKey = repairHeld?.[1];
  if (repairHeld !== null && repairKey !== undefined && /^<<<FINDINGS \S+$/m.test(prompt)) {
    holdUntilReleased(repairHeld[0], `${TICKETS_REPAIR_RELEASE_FILE_PREFIX}${repairKey}`);
  }
  return {
    ...set,
    tickets: set.tickets.map((ticket) => ({ ...ticket, title: revised(ticket.title) })),
  };
}

/** A set with no `[fake:revise:<n>]`: the canned set, or with `[fake:tickets-already-done]` T1 alone. */
function firstSetOutput() {
  const first = firstTicketSet();
  return idea?.includes(TICKETS_ALREADY_DONE_MARKER) === true
    ? {
        ...first,
        tickets: first.tickets.slice(0, 1),
        dispositions: [
          ...first.dispositions.filter((disposition) => disposition.ticket === "T1"),
          {
            criterion: "2.1",
            kind: "satisfied",
            evidence: "The project page already has an Export button (src/project-page.tsx).",
          },
        ],
      }
    : first;
}

/** The message the hatch run replies to, from the prompt's `MESSAGE` block (L153 (d)). */
function hatchMessage(): string {
  if (!prompt.includes(HATCH_MESSAGE_LINE)) {
    mismatch(`the hatch prompt has no \`${HATCH_MESSAGE_LINE}\` line`);
  }
  const text = /^<<<MESSAGE (\S+)\n([\s\S]*?)\nMESSAGE \1>>>$/m.exec(prompt)?.[2];
  if (text === undefined) {
    mismatch("the hatch prompt has no MESSAGE block");
  }
  return text;
}

/** The waypoint number a `[fake:hatch-<name>:<n>]` marker in `message` names, if it is there. */
function hatchTarget(message: string, name: string): number | undefined {
  const number = new RegExp(`\\[fake:hatch-${name}:(\\d+)\\]`).exec(message)?.[1];
  return number === undefined ? undefined : Number(number);
}

/**
 * A hatch change's fog settlement (L157): every fog item moves out of scope when no waypoint but
 * `target` is still `open` or `claimed`; otherwise none.
 */
function hatchFog(target: number | null): unknown {
  const others = [...prompt.matchAll(/^Waypoint (\d+) status: (open|claimed)\b/gm)].filter(
    (match) => Number(match[1]) !== target,
  );
  return others.length === 0 ? fogMovedOutOfScope() : NO_MAP_CHANGES;
}

/** A hatch run's reply to the prompt's message (slice 7b D2): by its marker, one change or none. */
function hatchOutput(): unknown {
  const message = hatchMessage();
  const reply = (text: string, change: unknown) => ({ reply: text, change });
  const reopen = hatchTarget(message, "reopen");
  if (reopen !== undefined) {
    return reply(`Simulated reply: waypoint ${String(reopen)} is reopened.`, {
      kind: "reopen",
      waypoint: reopen,
    });
  }
  if (message.includes(HATCH_REVISE_MARKER)) {
    return reply("Simulated reply: the spec's next revision follows your note.", {
      kind: "revise_spec",
    });
  }
  if (message.includes(HATCH_TICKETS_MARKER)) {
    return reply("Simulated reply: the tickets are rewritten from your note.", {
      kind: "rewrite_tickets",
    });
  }
  if (message.includes(HATCH_OPEN_MARKER)) {
    return reply("Simulated reply: a waypoint is added for your question.", {
      kind: "open_waypoint",
      waypointKind: "grilling",
      title: HATCH_WAYPOINT.title,
      question: HATCH_WAYPOINT.question,
      blockedBy: [],
      fog: NO_MAP_CHANGES,
    });
  }
  const outOfScope = hatchTarget(message, "out-of-scope");
  if (outOfScope !== undefined) {
    return reply(`Simulated reply: waypoint ${String(outOfScope)} is out of scope.`, {
      kind: "rule_out_of_scope",
      waypoint: outOfScope,
      reason: HATCH_OUT_OF_SCOPE_REASON,
      fog: hatchFog(outOfScope),
    });
  }
  const accept = hatchTarget(message, "accept-report");
  if (accept !== undefined) {
    return reply(`Simulated reply: waypoint ${String(accept)}'s report is accepted.`, {
      kind: "accept_report",
      waypoint: accept,
      gist: HATCH_ACCEPTED_GIST,
      fog: hatchFog(accept),
    });
  }
  const run = hatchTarget(message, "run");
  if (run !== undefined) {
    return reply(`Simulated reply: waypoint ${String(run)} runs again.`, {
      kind: "run_waypoint",
      waypoint: run,
    });
  }
  if (message.includes(HATCH_PROPOSE_MARKER)) {
    return reply("Simulated reply: I proposed a new map for that work.", {
      kind: "propose_map",
      title: HATCH_PROPOSAL.title,
      idea: HATCH_PROPOSAL.idea,
      line: HATCH_PROPOSAL.line,
      splitsLine: null,
    });
  }
  const split = hatchTarget(message, "split");
  if (split !== undefined) {
    return reply(`Simulated reply: I proposed splitting off Out of scope line ${String(split)}.`, {
      kind: "propose_map",
      title: HATCH_PROPOSAL.title,
      idea: HATCH_PROPOSAL.idea,
      line: null,
      splitsLine: split,
    });
  }
  return reply(HATCH_REPLY, null);
}

/**
 * A spec repair: the latest revision the prompt shows with " (revised)" titles; a note's repair
 * cites the note on C1 (S7b-11, L158 (c)); a wait's release (`Revise because: wait`) adds the wait's
 * note as a criterion of C1 with the next free id (the demo's `revisionFromNote`), C1 citing the
 * source its `Wait from:` line offers. Every repair keeps each id, so `removed` is empty.
 */
function reviseOutput(): unknown {
  const revision = repaired(firstShownRevision());
  if (/^Revise because: wait$/m.test(prompt)) {
    if (idea?.includes(RELEASE_HELD_MARKER) === true) {
      holdUntilReleased(RELEASE_HELD_MARKER, RELEASE_RUN_RELEASE_FILE);
    }
    const note = /^<<<WAIT (\S+)\n([\s\S]*?)\nWAIT \1>>>$/m.exec(prompt)?.[2];
    if (note === undefined) {
      mismatch("the wait release prompt has no WAIT block");
    }
    const [first, ...rest] = revision.clauses;
    if (first === undefined) {
      mismatch("the shown revision has no clause");
    }
    const next = Math.max(...first.criteria.map((criterion) => Number(criterion.id.split(".")[1])));
    const added = { id: `${first.id.slice(1)}.${String(next + 1)}`, text: note };
    // The changed clause cites the source the prompt offers (S8b-16, N-1): the note for a
    // note's wait, else the destination; core refuses a note on a decision-born wait.
    const from = /^Wait from: (a note|this map's decisions)$/m.exec(prompt)?.[1];
    if (from === undefined) {
      mismatch("the wait release prompt has no Wait from line");
    }
    const source = from === "a note" ? { kind: "note" } : { kind: "destination" };
    return {
      revision: {
        ...revision,
        clauses: [{ ...first, criteria: [...first.criteria, added], sources: [source] }, ...rest],
      },
      removed: [],
    };
  }
  if (!/^Revise because: note$/m.test(prompt)) {
    return { revision, removed: [] };
  }
  const [first, ...rest] = revision.clauses;
  if (first === undefined) {
    mismatch("the shown revision has no clause");
  }
  return {
    revision: { ...revision, clauses: [{ ...first, sources: [{ kind: "note" }] }, ...rest] },
    removed: [],
  };
}

/** The canned reply for the run's kind; a rewrite's titles gain " (revised)". */
function structuredOutput(): unknown {
  const properties = schemaProperties();
  switch (planningKind()) {
    case "survey":
      if (idea?.includes(SURVEY_HELD_MARKER) === true) {
        holdUntilReleased(SURVEY_HELD_MARKER, SURVEY_RELEASE_FILE);
      }
      return SURVEY;
    case "fog":
      return fogRunOutput();
    case "hatch":
      return hatchOutput();
    case "spec":
      return draftSpecsOutput();
    case "revise":
      return reviseOutput();
    case "spec-review":
      return specReviewOutput();
    case "tickets-review":
      return ticketsReviewOutput();
    case "tickets":
      return ticketSetOutput();
    case "chart":
      // `choose` (DR-22): a confirmation or, by the destination markers, a follow-up (DR-23).
      if ("waypoints" in properties && "final" in properties) {
        return chooseChart();
      }
      // `confirm`: after a final round or at the cap.
      if ("waypoints" in properties) {
        return confirmingChart();
      }
      return idea?.includes(SPLIT_MARKER) === true
        ? { ...PROPOSAL, split: SPLIT_OFFERS }
        : PROPOSAL;
    case "research":
      return researchOutput();
    case "task":
      return taskOutput();
    case "consistency":
      return consistencyOutput();
    case "grilling":
      if ("final" in properties) {
        return grill();
      }
      return { ...GRILL_RESOLUTION, outOfScope: null, mapChanges: resolvingMapChanges() };
  }
}

/**
 * A confirming chart's reply, by the idea's markers; `[fake:propose]` adds its proposal. The map's
 * title and summary are the proposal's (L253), so every flow's map title is unchanged.
 */
function confirmingChart(): object {
  const chart = chartByMarkers();
  return {
    title: PROPOSAL.title,
    summary: PROPOSAL.summary,
    ...chart,
    proposals: proposes() ? [CHART_PROPOSAL] : [],
  };
}

/** A confirming chart's waypoints, fog and Out of scope lines, by the idea's markers. */
function chartByMarkers(): object {
  if (chartsKinds()) {
    return {
      destination: DESTINATION,
      waypoints: withRevisionTouch(KINDS_WAYPOINTS),
      fog: [KINDS_FOG],
      outOfScope: [KINDS_OUT_OF_SCOPE],
    };
  }
  if (idea?.includes(STATES_MARKER) === true) {
    return {
      destination: DESTINATION,
      waypoints: withRevisionTouch(STATES_WAYPOINTS),
      fog: [KINDS_FOG],
      outOfScope: [],
    };
  }
  const noWaypoints = idea?.includes(NO_WAYPOINTS_MARKER) === true;
  const fogRun = idea?.includes(FOG_RUN_MARKER) === true;
  return {
    destination: DESTINATION,
    waypoints: noWaypoints ? [] : withRevisionTouch(WAYPOINTS),
    fog: fogRun ? [FOG_RUN_FOG] : [],
    outOfScope: [],
  };
}

switch (role) {
  case "orchestrator":
    await orchestrate();
    break;
  case "reviewer":
    print({ type: "result", subtype: "success", is_error: false, structured_output: review() });
    break;
  case "pull-request-writer":
    print({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: { pullRequestBody: pullRequestBody() },
    });
    break;
  case "planning":
    print({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: randomUUID(),
      ...USAGE,
      structured_output: structuredOutput(),
    });
    break;
}
