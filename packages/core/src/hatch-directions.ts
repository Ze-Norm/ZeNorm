import type { Waypoint, WaypointStatus } from "@zenorm/contracts";
import { waypointBlockers, waypoints } from "@zenorm/db";
import { and, eq, max } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { stopWaypointWork } from "./hatch-reopen.ts";
import type { HatchApplier } from "./hatch-runs.ts";
import { applyMapChanges, saveExclusion, saveProposal, saveSplitProposal } from "./map-changes.ts";
import {
  KIND_PURPOSE,
  claim,
  insertRun,
  readMapRuns,
  readRunOutcomes,
  readWaypoints,
  resolveByRun,
  scopeRuns,
  stoppedRun,
  waitingRun,
} from "./planning-runs.ts";
import type { Tx } from "./planning-runs.ts";
import { readExclusions, readReports } from "./wayfinding-records.ts";

/** The waypoint a change names; the dispatcher checked the number, so a missing one is a programmer error. */
function targetOf(tx: Tx, mapId: string, number: number): Waypoint {
  const target = readWaypoints(tx, mapId).find((waypoint) => waypoint.number === number);
  if (target === undefined) {
    throw new Error(`Map ${mapId} has no waypoint ${String(number)}`);
  }
  return target;
}

/** Whether a `reword` or `rule_out_of_scope` still fits the waypoint's status (S7b-9, D4). */
function isOpenOrClaimed(status: WaypointStatus): boolean {
  return status === "open" || status === "claimed";
}

/** Records the message that directed the waypoint (S7b-10): its next run's request carries it. */
function recordMessage(tx: Tx, waypointId: string, messageId: string): void {
  const updated = tx
    .update(waypoints)
    .set({ hatchMessageId: messageId })
    .where(eq(waypoints.id, waypointId))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${waypointId} does not exist`);
  }
}

/** The run `target` waits on (S6b-6), or null when it is not waiting on the person. */
function waitingOn(tx: Tx, target: Waypoint) {
  return waitingRun(
    target,
    scopeRuns(readMapRuns(tx, target.mapId), target.id),
    readRunOutcomes(tx, target.mapId),
  );
}

/**
 * Whether `target` waits on the person for a run (L46): it waits on its latest run (S6b-6), or it
 * is `open` with its scope stopped after a failed retry (S6a-12).
 */
function awaitsRun(tx: Tx, target: Waypoint): boolean {
  return (
    waitingOn(tx, target) !== null ||
    (target.status === "open" &&
      stoppedRun(scopeRuns(readMapRuns(tx, target.mapId), target.id)) !== null)
  );
}

/**
 * Applies an `open_waypoint` change (S7b-9, L154 (b)): the named waypoint, of any kind, is added
 * `open` as the map's next number, blocked by existing waypoints only, created by the hatch run and
 * recording the message (S7b-10); then the fog settlement applies, its waypoints numbered after it.
 * Nothing in flight is cancelled: a running map-scope `to_spec` finishes, and the re-clear is due
 * once the new waypoint resolves (S7b-8). A blocker naming the new waypoint itself (the one cycle a
 * new waypoint can form) fails the run `hatch_change_invalid`.
 */
export const applyOpenWaypoint: HatchApplier<"open_waypoint"> = (tx, { run, message }, change) => {
  const highest = tx
    .select({ highest: max(waypoints.number) })
    .from(waypoints)
    .where(eq(waypoints.mapId, run.mapId))
    .get();
  if (highest === undefined) {
    throw new Error("An aggregate query returned no row");
  }
  const number = highest.highest === null ? 1 : highest.highest + 1;
  if (change.blockedBy.includes(number)) {
    return {
      result: "invalid",
      failure: {
        code: "hatch_change_invalid",
        message: `The new waypoint ${String(number)} is blocked by itself`,
      },
    };
  }
  tx.insert(waypoints)
    .values({
      id: uuidv7(),
      mapId: run.mapId,
      number,
      kind: change.waypointKind,
      status: "open",
      title: change.title,
      question: change.question,
      claimedAt: null,
      resolution: null,
      gist: null,
      agentDecided: null,
      resolvedAt: null,
      resolvedHow: null,
      resolvedByRun: null,
      createdByRun: run.id,
      hatchMessageId: message.id,
      personDecides: false,
    })
    .run();
  // A repeated number names one blocker once.
  for (const blockerNumber of new Set(change.blockedBy)) {
    tx.insert(waypointBlockers)
      .values({ mapId: run.mapId, waypointNumber: number, blockerNumber })
      .run();
  }
  applyMapChanges(tx, run, change.fog);
  return { result: "applied" };
};

/**
 * Applies a `reword` change (S7b-9, L8): an `open` or `claimed` waypoint gets the new title and
 * question and records the message (S7b-10); a claimed one has its running run cancelled
 * `reopened` and its pending round withdrawn `superseded`, and returns to `open`, so the frontier
 * claims it with a fresh run. Any other status is refused `waypoint_state` (D4).
 */
export const applyReword: HatchApplier<"reword"> = (tx, { run, message }, change) => {
  const target = targetOf(tx, run.mapId, change.waypoint);
  if (!isOpenOrClaimed(target.status)) {
    return { result: "refused", refusal: "waypoint_state" };
  }
  stopWaypointWork(tx, run.mapId, target.id, "superseded");
  const updated = tx
    .update(waypoints)
    .set({
      status: "open",
      title: change.title,
      question: change.question,
      hatchMessageId: message.id,
    })
    .where(and(eq(waypoints.id, target.id), eq(waypoints.status, target.status)))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${target.id} changed status while it was reworded`);
  }
  return { result: "applied" };
};

/**
 * Applies a `rule_out_of_scope` change (S7b-9, L8): an `open` or `claimed` waypoint moves to
 * `out_of_scope` with the reason as its Out of scope line, written by the hatch run; its running run
 * is cancelled `reopened` and its pending round withdrawn `waypoint_out_of_scope`; it records the
 * message (S7b-10) and the fog settlement applies; fog it leaves goes to the map's fog run (harness
 * change #4). Any other status is refused `waypoint_state` (D4).
 */
export const applyRuleOutOfScope: HatchApplier<"rule_out_of_scope"> = (
  tx,
  { run, message },
  change,
) => {
  const target = targetOf(tx, run.mapId, change.waypoint);
  if (!isOpenOrClaimed(target.status)) {
    return { result: "refused", refusal: "waypoint_state" };
  }
  stopWaypointWork(tx, run.mapId, target.id, "waypoint_out_of_scope");
  const updated = tx
    .update(waypoints)
    .set({ status: "out_of_scope", hatchMessageId: message.id })
    .where(and(eq(waypoints.id, target.id), eq(waypoints.status, target.status)))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${target.id} changed status while it was ruled out of scope`);
  }
  saveExclusion(tx, run, change.reason, target.id, null);
  applyMapChanges(tx, run, change.fog);
  return { result: "applied" };
};

/**
 * Applies a `run_waypoint` change (S7b-9, L46): a waypoint waiting on the person (an unanswered
 * report or a `failed` task, S6b-6, or a scope stopped after a failed retry, S6a-12) is claimed with a fresh run of its kind and records the message
 * (S7b-10). One not waiting is refused `waypoint_not_waiting` (D4).
 */
export const applyRunWaypoint: HatchApplier<"run_waypoint"> = (
  tx,
  { run, message, actor },
  change,
) => {
  const target = targetOf(tx, run.mapId, change.waypoint);
  if (!awaitsRun(tx, target)) {
    return { result: "refused", refusal: "waypoint_not_waiting" };
  }
  recordMessage(tx, target.id, message.id);
  claim(tx, target.id);
  insertRun(actor, tx, {
    mapId: run.mapId,
    waypointId: target.id,
    specificationId: null,
    purpose: KIND_PURPOSE[target.kind],
    retryOfRunId: null,
    hatchMessageId: null,
  });
  return { result: "applied" };
};

/**
 * Applies an `accept_report` change (S7b-9, L9): the hatch run claims a waypoint waiting on an
 * unanswered research report (`open → claimed`) and resolves it (`claimed → resolved`) with the
 * report's summary as the resolution and the change's gist, `resolved_how` `run`, `resolved_by_run`
 * the hatch run; it records the message (S7b-10) and the fog settlement applies. A waypoint not
 * waiting on a report is refused `waypoint_not_waiting` (D4).
 */
export const applyAcceptReport: HatchApplier<"accept_report"> = (tx, { run, message }, change) => {
  const target = targetOf(tx, run.mapId, change.waypoint);
  const waiting = waitingOn(tx, target);
  if (waiting?.reason !== "research_unanswered") {
    return { result: "refused", refusal: "waypoint_not_waiting" };
  }
  const report = readReports(tx, run.mapId).find((candidate) => candidate.runId === waiting.runId);
  if (report === undefined) {
    throw new Error(`Waiting run ${waiting.runId} has no report`);
  }
  recordMessage(tx, target.id, message.id);
  claim(tx, target.id);
  // The person directed the acceptance and the report states facts, not calls: none is the agent's.
  resolveByRun(tx, run, target.id, {
    resolution: report.summary,
    gist: change.gist,
    agentDecided: [],
  });
  applyMapChanges(tx, run, change.fog);
  return { result: "applied" };
};

/**
 * Applies a `propose_map` change (map proposals): a pending proposal of a new map is saved, created
 * by the hatch run, at any stage and without touching the map's waypoints, fog or stage. With its
 * own line, the line is saved when the person decides it. Splitting off an existing Out of scope
 * line (`splitsLine`) names that line, which gains its link only when the person confirms; a
 * position naming no line of the map is refused `exclusion_not_found`, a line already linked to a
 * map `exclusion_already_split`.
 */
export const applyProposeMap: HatchApplier<"propose_map"> = (tx, { run }, change) => {
  if (change.splitsLine === null) {
    if (change.line === null) {
      throw new Error(`Hatch run ${run.id}'s propose_map has neither a line nor a line it splits`);
    }
    saveProposal(tx, run, {
      title: change.title,
      idea: change.idea,
      line: change.line,
      waypointId: null,
    });
    return { result: "applied" };
  }
  const position = change.splitsLine;
  const line = readExclusions(tx, run.mapId).find((candidate) => candidate.position === position);
  if (line === undefined) {
    return { result: "refused", refusal: "exclusion_not_found" };
  }
  if (line.splitMapId !== null) {
    return { result: "refused", refusal: "exclusion_already_split" };
  }
  saveSplitProposal(tx, run, {
    title: change.title,
    idea: change.idea,
    exclusionPosition: position,
  });
  return { result: "applied" };
};
