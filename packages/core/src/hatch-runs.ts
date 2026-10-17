import { HATCH_EARLIER_MESSAGES_MAX_COUNT, HatchReply, ok } from "@zenorm/contracts";
import type {
  Actor,
  HatchChange,
  HatchOutcome,
  HatchRefusal,
  HatchSpecWork,
  MapChanges,
  PlanningRun,
  ReplyThroughHatchRequest,
  Result,
  SpecHold,
  SpecHoldKind,
} from "@zenorm/contracts";
import { hatchMessages } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

import { readCodeSurvey } from "./code-survey.ts";
import { deliveryOutcome, readSpecRuns } from "./delivery.ts";
import { readHatchMessages } from "./hatch-messages.ts";
import { applyReopen } from "./hatch-reopen.ts";
import { proposalsProblem, settledFogPositions } from "./map-changes.ts";
import { projectSuggestionContext } from "./map-overview.ts";
import {
  applyAcceptReport,
  applyOpenWaypoint,
  applyProposeMap,
  applyReword,
  applyRuleOutOfScope,
  applyRunWaypoint,
} from "./hatch-directions.ts";
import { applyReviseSpec, applyRewriteTickets, noteWork } from "./hatch-notes.ts";
import {
  endRun,
  hatchRuns,
  isReplaced,
  isSupersededStop,
  now,
  readBlockers,
  readClearing,
  readMap,
  readMapRuns,
  readRunOutcomes,
  readWaypoints,
  refuse,
  runningRun,
  scopeRun,
  scopeRuns,
  specRuns,
  stoppedRun,
  waitingRun,
} from "./planning-runs.ts";
import type { ClearingInput, Reader, RunFailure, Tx } from "./planning-runs.ts";
import { present } from "./present.ts";
import { openWaits } from "./spec-context.ts";
import type { SpecRunBase } from "./spec-requests.ts";
import {
  latestOf,
  readMapSpecs,
  readSpecRevisions,
  readTicketSetOf,
  revisionState,
} from "./specs.ts";
import { hatchTicketsReview, ticketSetReview } from "./tickets-reviews.ts";
import { readExclusions, readFog, readReports } from "./wayfinding-records.ts";
import { planAndRelease } from "./spec-holds.ts";
import { write } from "./writes.ts";

/** A stored hatch message. */
export type StoredHatchMessage = typeof hatchMessages.$inferSelect;

/**
 * Core's fixed reply for each refusal: stored as the message's reply, with the code as its
 * `refusal`, in place of the agent's reply; each applier chooses only the code. A `spec_in_flight`
 * refusal's reply is chosen from `SPEC_IN_FLIGHT_SENTENCES` instead.
 */
export const REFUSAL_SENTENCES: Readonly<Record<Exclude<HatchRefusal, "spec_in_flight">, string>> =
  {
    map_uncleared:
      "I didn't revise the spec: the map has open waypoints, and the spec is rewritten once they are resolved.",
    spec_approved:
      "I didn't revise the spec: it is approved, and it stands as approved. Changing an approved spec isn't possible yet.",
    spec_waiting:
      "I didn't take that change: this map already waits on the spec with a note, and its change is written as the next revision once the spec is free.",
    ticket_set_approved:
      "I didn't rewrite the tickets: the ticket set is approved, and an approved ticket set doesn't change.",
    no_ticket_set: "I didn't rewrite the tickets: this spec has no ticket set yet.",
    waypoint_not_waiting:
      "I didn't do that: the waypoint isn't waiting on you, so there is nothing to run or accept.",
    waypoint_state:
      "I didn't change that waypoint: its state has moved on since you sent this, so the change no longer fits.",
    exclusion_not_found:
      "I didn't propose a map: this map has no Out of scope line at the position I named, so nothing was split off.",
    exclusion_already_split:
      "I didn't propose a map: that Out of scope line is already split off into a map of its own.",
  };

/**
 * The `spec_in_flight` reply by the change refused and the work in flight on its spec (as
 * `specWork` reads it): a ticket note speaks of the tickets, and only a stop mentions Try again.
 */
export const SPEC_IN_FLIGHT_SENTENCES: Readonly<
  Record<"revise_spec" | "rewrite_tickets", Record<"working" | "stopped" | "delivering", string>>
> = {
  revise_spec: {
    working:
      "I didn't change the spec: the agent is still working on it. Send this again once it has finished.",
    stopped:
      "I didn't change the spec: work on it stopped. Press Try again on it, then send this again.",
    delivering:
      "I didn't change the spec: its tickets are being delivered. Send this again once delivery has finished.",
  },
  rewrite_tickets: {
    working:
      "I didn't rewrite the tickets: the agent is still writing or reviewing them. Send this again once it has finished.",
    stopped:
      "I didn't rewrite the tickets: work on them stopped. Press Try again on it, then send this again.",
    delivering:
      "I didn't rewrite the tickets: they are being delivered. Send this again once delivery has finished.",
  },
};

/** The holds a note waits on; a `delivering` hold refuses it `spec_in_flight`. */
export type WaitHoldKind = Exclude<SpecHoldKind, "delivering">;

/**
 * Core's reply when a `revise_spec` note waits, by the hold it waits on: stored as the message's
 * reply with `refusal` and `change` null. “X” is the spec, “H” the holder and rN the hold's
 * revision.
 */
export const SPEC_WAIT_SENTENCES: Readonly<
  Record<WaitHoldKind, (wait: { spec: string; holder: string; revision: number }) => string>
> = {
  revision: ({ spec, holder, revision }) =>
    `“${spec}” has moved on. “${holder}” holds its unapproved revision r${String(revision)}. One unapproved revision at a time, so your change waits on this map as a blocker: when r${String(revision)} is approved there and its tickets are written, I write it as the next revision with your note as it stands.`,
  revising: ({ spec, holder, revision }) =>
    `“${spec}” has moved on. “${holder}” is writing the next revision after r${String(revision)}. One change at a time, so your change waits on this map as a blocker: once that work ends, I write it as the next revision with your note as it stands.`,
  tickets: ({ spec, holder, revision }) =>
    `“${spec}” has moved on. “${holder}” is writing or reviewing the tickets of r${String(revision)}. One change at a time, so your change waits on this map as a blocker: once that work ends, I write it as the next revision with your note as it stands.`,
};

/**
 * The reply stored for a refused change: `SPEC_IN_FLIGHT_SENTENCES` for `spec_in_flight`, by
 * `noteWork` read in the refusing transaction, else `REFUSAL_SENTENCES`. Only the two note changes
 * are refused `spec_in_flight`, on the message's spec; anything else is a programmer error.
 */
function refusalSentence(
  tx: Tx,
  { run, message }: HatchApplyContext,
  change: HatchChange,
  refusal: HatchRefusal,
): string {
  if (refusal !== "spec_in_flight") {
    return REFUSAL_SENTENCES[refusal];
  }
  if (change.kind !== "revise_spec" && change.kind !== "rewrite_tickets") {
    throw new Error(`A ${change.kind} change was refused spec_in_flight`);
  }
  const work = noteWork(
    tx,
    run.mapId,
    present(message.specificationId, `Hatch message ${message.id}'s spec`),
  );
  if (work === null) {
    throw new Error(
      `Hatch message ${message.id} was refused spec_in_flight with no work in flight`,
    );
  }
  return SPEC_IN_FLIGHT_SENTENCES[change.kind][work];
}

/**
 * What an applier did with its change: applied it (its writes are in the transaction), refused it
 * with a refusal code, or found it invalid with the problem the run fails with (a blocker cycle, a
 * bad fog settlement). An applier writes nothing unless it returns `applied`.
 */
export type HatchApplied =
  | { readonly result: "applied" }
  /** A `revise_spec` note recorded as the map's wait on a held spec, with the hold. */
  | { readonly result: "waited"; readonly hold: SpecHold & { readonly kind: WaitHoldKind } }
  | { readonly result: "refused"; readonly refusal: HatchRefusal }
  | {
      readonly result: "invalid";
      readonly failure: RunFailure & {
        readonly code: "hatch_change_invalid";
      };
    };

/**
 * What an applier reads besides its change: the hatch run, the message it answers, and the actor
 * the outcome is written as (a run it inserts is attributed by it).
 */
export interface HatchApplyContext {
  readonly actor: Actor;
  readonly run: PlanningRun;
  readonly message: StoredHatchMessage;
}

/** Applies one change kind in the outcome's transaction. */
export type HatchApplier<K extends HatchChange["kind"]> = (
  tx: Tx,
  context: HatchApplyContext,
  change: Extract<HatchChange, { kind: K }>,
) => HatchApplied;

/** One applier per change kind. */
export type HatchAppliers = { readonly [K in HatchChange["kind"]]: HatchApplier<K> };

/**
 * The appliers: reopen, the waypoint directions, the spec and ticket notes, and a proposal of a new
 * map.
 */
export const HATCH_APPLIERS: HatchAppliers = {
  reopen: applyReopen,
  open_waypoint: applyOpenWaypoint,
  reword: applyReword,
  rule_out_of_scope: applyRuleOutOfScope,
  run_waypoint: applyRunWaypoint,
  accept_report: applyAcceptReport,
  revise_spec: applyReviseSpec,
  rewrite_tickets: applyRewriteTickets,
  propose_map: applyProposeMap,
};

/** The message a `hatch` run answers; a run without one is a programmer error. */
function runMessage(db: Reader, run: PlanningRun): StoredHatchMessage {
  const messageId = present(run.hatchMessageId, `Hatch run ${run.id}'s message`);
  const message = db.select().from(hatchMessages).where(eq(hatchMessages.id, messageId)).get();
  if (message === undefined) {
    throw new Error(`Hatch run ${run.id}'s message ${messageId} does not exist`);
  }
  return message;
}

/**
 * What runs on a spec (for the `spec_in_flight` refusal): its running planning runs and an active
 * delivery.
 */
function inFlight(
  db: Reader,
  runs: readonly PlanningRun[],
  clearing: ClearingInput,
  specificationId: string,
): HatchSpecWork[] {
  const work = new Set<HatchSpecWork>();
  const scope = specRuns(runs, specificationId);
  const latest = scope.at(-1);
  // A stopped spec scope is in flight, as the `spec_in_flight` refusal reads it, until Try again or
  // a supersession ends the stop.
  const shown = scopeRun(scope);
  const stopped =
    shown !== null && shown !== "working" && latest !== undefined
      ? !isSupersededStop(latest, clearing)
      : false;
  for (const run of scope) {
    if (run.state !== "running" && !(stopped && run === latest)) continue;
    if (
      run.purpose !== "spec_review" &&
      run.purpose !== "to_spec" &&
      run.purpose !== "to_tickets" &&
      run.purpose !== "tickets_review"
    ) {
      throw new Error(
        `Spec ${specificationId} runs a ${run.purpose} run, which no hatch request names`,
      );
    }
    work.add(run.purpose);
  }
  if (readSpecRuns(db, specificationId).some((run) => deliveryOutcome(run) === "active")) {
    work.add("delivery");
  }
  return [...work];
}

/**
 * The problem core failed the previous attempt at this message with: the message's run just before
 * `run` (a retry, or a fresh run after Try again) when it failed `hatch_change_invalid`; null
 * otherwise.
 */
function refusedAttempt(
  runs: readonly PlanningRun[],
  run: PlanningRun,
): ReplyThroughHatchRequest["refusedAttempt"] {
  const scope = hatchRuns(runs, present(run.hatchMessageId, `Hatch run ${run.id}'s message`));
  const previous = scope[scope.findIndex((candidate) => candidate.id === run.id) - 1];
  if (previous?.errorCode !== "hatch_change_invalid") {
    return null;
  }
  return { problem: present(previous.errorMessage, `Failed run ${previous.id}'s message`) };
}

/** A `hatch` run's request, built from the stored records. */
export function hatchRequest(
  db: Reader,
  run: PlanningRun,
  base: SpecRunBase,
  mapRounds: ReplyThroughHatchRequest["mapRounds"],
): ReplyThroughHatchRequest {
  const map = readMap(db, run.mapId);
  const runs = readMapRuns(db, map.id);
  const blockers = readBlockers(db, map.id);
  const outcomes = readRunOutcomes(db, map.id);
  const reports = readReports(db, map.id);
  const clearing = readClearing(db, map, runs);
  const messageId = present(run.hatchMessageId, `Hatch run ${run.id}'s message`);
  const messages = readHatchMessages(db, map.id, runs);
  const message = messages.find((candidate) => candidate.id === messageId);
  if (message === undefined) {
    throw new Error(`Hatch run ${run.id}'s message ${messageId} is not on map ${map.id}`);
  }
  const earlierMessages = messages
    .filter((earlier) => earlier.id !== messageId)
    .flatMap((earlier) =>
      earlier.status.state === "replied"
        ? [
            {
              stage: earlier.stage,
              specNumber: earlier.spec,
              text: earlier.text,
              reply: earlier.status.reply,
            },
          ]
        : [],
    )
    .slice(-HATCH_EARLIER_MESSAGES_MAX_COUNT);
  return {
    ...base,
    ...projectSuggestionContext(db, map.projectId),
    survey: readCodeSurvey(db, map.id),
    title: map.title,
    destination: map.destination,
    mapRounds,
    waypoints: readWaypoints(db, map.id).map((waypoint) => {
      // The report an unanswered research waypoint waits on.
      const unansweredReport = (runId: string) => {
        const report = reports.find((candidate) => candidate.runId === runId);
        if (report === undefined) {
          throw new Error(`Waiting run ${runId} has no report`);
        }
        return { summary: report.summary, gap: present(report.gap, `Report ${runId}'s gap`) };
      };
      const waiting = waitingRun(waypoint, scopeRuns(runs, waypoint.id), outcomes);
      return {
        number: waypoint.number,
        kind: waypoint.kind,
        title: waypoint.title,
        question: waypoint.question,
        status: waypoint.status,
        blockedBy: blockers
          .filter((blocker) => blocker.waypointNumber === waypoint.number)
          .map((blocker) => blocker.blockerNumber),
        resolution: waypoint.resolution,
        gist: waypoint.gist,
        agentDecided: waypoint.agentDecided,
        waiting: waiting === null ? null : waiting.reason,
        report: waiting?.reason === "research_unanswered" ? unansweredReport(waiting.runId) : null,
        // As `run_waypoint`'s applier reads a stopped waypoint.
        stopped: waypoint.status === "open" && stoppedRun(scopeRuns(runs, waypoint.id)) !== null,
      };
    }),
    fog: readFog(db, map.id),
    outOfScope: readExclusions(db, map.id).map((exclusion) => exclusion.text),
    waits: openWaits(db, map.id),
    specs: readMapSpecs(db, map.id).map((spec) => {
      const revisions = readSpecRevisions(db, spec.id);
      const latest = latestOf(revisions);
      // The set is written for the spec's approved revision on this map.
      const approved = revisions
        .filter((revision) => revision.mapId === map.id && revision.approvedAt !== null)
        .at(-1);
      const set = approved === undefined ? undefined : readTicketSetOf(db, approved.id);
      return {
        latest: { specNumber: spec.number, revision: latest.revision, content: latest.content },
        state: revisionState(latest),
        ticketSet:
          set === undefined
            ? null
            : {
                version: set.version,
                state: set.state,
                // The one read of the set's review.
                ...hatchTicketsReview(ticketSetReview(db, specRuns(runs, spec.id), set, true)),
              },
        inFlight: inFlight(db, runs, clearing, spec.id),
      };
    }),
    earlierMessages,
    message: { stage: message.stage, specNumber: message.spec, text: message.text },
    refusedAttempt: refusedAttempt(runs, run),
  };
}

function changeInvalid(message: string): RunFailure {
  return { code: "hatch_change_invalid", message };
}

/** The fog settlement a change carries, when its kind carries one. */
function changeFog(change: HatchChange): MapChanges | null {
  switch (change.kind) {
    case "open_waypoint":
    case "rule_out_of_scope":
    case "accept_report":
      return change.fog;
    case "reopen":
    case "reword":
    case "run_waypoint":
    case "revise_spec":
    case "rewrite_tickets":
    case "propose_map":
      return null;
  }
}

/** The waypoint numbers a change names: its target, the new waypoint's blockers and its fog's. */
function namedWaypoints(change: HatchChange): number[] {
  const fog = changeFog(change);
  const fogBlockers = fog === null ? [] : fog.newWaypoints.flatMap((created) => created.blockedBy);
  switch (change.kind) {
    case "reopen":
    case "reword":
    case "rule_out_of_scope":
    case "run_waypoint":
    case "accept_report":
      return [change.waypoint, ...fogBlockers];
    case "open_waypoint":
      return [...change.blockedBy, ...fogBlockers];
    case "revise_spec":
    case "rewrite_tickets":
    case "propose_map":
      return [];
  }
}

/**
 * The dispatcher's check before any applier: every waypoint number the change names is on the map,
 * and every fog position its settlement names is a fog item, each used once; the first such problem
 * fails the run `hatch_change_invalid`. A `propose_map` whose draft idea or line is outside its
 * stored bounds fails it `agent_output_invalid`, as a Wayfinding run's proposal does. Null when
 * there is none.
 */
function changeProblem(db: Reader, mapId: string, change: HatchChange): RunFailure | null {
  const numbers = new Set(readWaypoints(db, mapId).map((waypoint) => waypoint.number));
  const unknown = namedWaypoints(change).find((number) => !numbers.has(number));
  if (unknown !== undefined) {
    return changeInvalid(
      `The ${change.kind} change names waypoint ${String(unknown)}, which the map does not have`,
    );
  }
  if (change.kind === "propose_map") {
    return proposalsProblem([{ idea: change.idea, line: change.line }]);
  }
  const fog = changeFog(change);
  if (fog === null) {
    return null;
  }
  if (fog.fogSettledHere.length > 0) {
    // A hatch change writes no resolution of its own that could carry a fog item's decision.
    return changeInvalid(
      `The ${change.kind} change settles fog with a resolution of its own, which a hatch change does not write`,
    );
  }
  const positions = new Set(readFog(db, mapId).map((item) => item.position));
  const used = new Set<number>();
  for (const position of settledFogPositions(fog)) {
    if (!positions.has(position) || used.has(position)) {
      return changeInvalid(
        `The ${change.kind} change names fog position ${String(position)}, which is not a fog item of the map or is used twice`,
      );
    }
    used.add(position);
  }
  return null;
}

/** Calls the change's own applier, narrowed by kind. */
function applyChange(
  tx: Tx,
  appliers: HatchAppliers,
  context: HatchApplyContext,
  change: HatchChange,
): HatchApplied {
  switch (change.kind) {
    case "reopen":
      return appliers.reopen(tx, context, change);
    case "open_waypoint":
      return appliers.open_waypoint(tx, context, change);
    case "reword":
      return appliers.reword(tx, context, change);
    case "rule_out_of_scope":
      return appliers.rule_out_of_scope(tx, context, change);
    case "run_waypoint":
      return appliers.run_waypoint(tx, context, change);
    case "accept_report":
      return appliers.accept_report(tx, context, change);
    case "revise_spec":
      return appliers.revise_spec(tx, context, change);
    case "rewrite_tickets":
      return appliers.rewrite_tickets(tx, context, change);
    case "propose_map":
      return appliers.propose_map(tx, context, change);
  }
}

/** Stores the message's reply with the run that replied, in the outcome's transaction. */
function storeReply(
  tx: Tx,
  run: PlanningRun,
  message: StoredHatchMessage,
  reply: { text: string; refusal: HatchRefusal | null; change: HatchChange | null },
): void {
  const stored = tx
    .update(hatchMessages)
    .set({
      runId: run.id,
      reply: reply.text,
      refusal: reply.refusal,
      change: reply.change,
      repliedAt: now(),
    })
    .where(eq(hatchMessages.id, message.id))
    .run();
  if (stored.changes !== 1) {
    throw new Error(`Hatch message ${message.id} was not stored`);
  }
}

/**
 * Saves a `hatch` run's outcome with the given appliers, in one transaction: a run cancelled while
 * its call was out saves nothing; a reply outside 1–2000 characters fails the run
 * `agent_output_invalid`; a change naming an unknown waypoint or fog position, or one its applier
 * finds invalid, fails it with the problem (retried); otherwise the reply is stored with the
 * applied change, or core's sentence and the code when the applier refuses (not retried), and the
 * run completes. Nothing is written before a failure.
 */
export function recordHatchReplyWith(
  appliers: HatchAppliers,
): (
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: HatchOutcome,
) => Result<null, RunFailure> {
  return (actor, db, runId, outcome) =>
    write(db, actor, (tx): Result<null, RunFailure> => {
      if (isReplaced(tx, runId)) {
        // A run cancelled while its call was out saves nothing and is not retried.
        return ok(null);
      }
      const run = runningRun(tx, runId);
      if (run.purpose !== "hatch") {
        throw new Error(`Planning run ${runId} is a ${run.purpose} run, not a hatch run`);
      }
      const message = runMessage(tx, run);
      if (message.reply !== null) {
        throw new Error(`Hatch message ${message.id} is replied while its run ${runId} runs`);
      }
      if (!HatchReply.safeParse(outcome.reply).success) {
        return refuse(actor, tx, run, {
          code: "agent_output_invalid",
          message: `The reply has ${String(outcome.reply.length)} characters; it must have 1 to 2000`,
        });
      }
      const { change } = outcome;
      if (change === null) {
        storeReply(tx, run, message, { text: outcome.reply, refusal: null, change: null });
      } else {
        const problem = changeProblem(tx, run.mapId, change);
        if (problem !== null) {
          return refuse(actor, tx, run, problem);
        }
        const applied = applyChange(tx, appliers, { actor, run, message }, change);
        switch (applied.result) {
          case "invalid":
            return refuse(actor, tx, run, applied.failure);
          case "refused":
            storeReply(tx, run, message, {
              text: refusalSentence(tx, { actor, run, message }, change, applied.refusal),
              refusal: applied.refusal,
              change: null,
            });
            break;
          case "applied":
            storeReply(tx, run, message, { text: outcome.reply, refusal: null, change });
            break;
          case "waited":
            // A wait is not refused, and nothing is applied until its release run.
            storeReply(tx, run, message, {
              text: SPEC_WAIT_SENTENCES[applied.hold.kind]({
                spec: latestOf(
                  readSpecRevisions(
                    tx,
                    present(message.specificationId, `Hatch message ${message.id}'s spec`),
                  ),
                ).content.title,
                holder: applied.hold.mapTitle,
                revision: applied.hold.revision,
              }),
              refusal: null,
              change: null,
            });
            break;
        }
      }
      endRun(tx, runId, { state: "completed" });
      planAndRelease(actor, tx, run.mapId);
      return ok(null);
    });
}

/** Saves a `hatch` run's outcome with the change appliers. */
export const recordHatchReply = recordHatchReplyWith(HATCH_APPLIERS);
