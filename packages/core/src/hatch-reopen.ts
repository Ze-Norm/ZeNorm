import type { RoundWithdrawnReason } from "@zenorm/contracts";
import { planningRuns, questionRounds, waypoints } from "@zenorm/db";
import { and, eq, inArray } from "drizzle-orm";

import type { HatchApplier } from "./hatch-runs.ts";
import { cancelRun, readBlockers, readWaypoints, withdrawRound } from "./planning-runs.ts";
import type { Tx } from "./planning-runs.ts";
import { planAndRelease } from "./spec-holds.ts";

/** The map runs a reopen cancels: their inputs include the reopened resolutions. */
const CANCELLED_MAP_PURPOSES = ["fog", "consistency", "to_spec", "spec_review"] as const;

/**
 * The numbers of every waypoint `root` blocks, directly or transitively, whatever its status (a
 * resolved waypoint may sit behind an out-of-scope one); `root` itself is not among them.
 */
function dependentsOf(tx: Tx, mapId: string, root: number): Set<number> {
  const blockers = readBlockers(tx, mapId);
  const found = new Set<number>();
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const blocker of blockers) {
      if (blocker.blockerNumber === next && !found.has(blocker.waypointNumber)) {
        found.add(blocker.waypointNumber);
        queue.push(blocker.waypointNumber);
      }
    }
  }
  found.delete(root);
  return found;
}

/**
 * Cancels the waypoint's running runs `reopened` and withdraws its pending rounds with `reason`
 * (`superseded` for a reopen or a reword, `waypoint_out_of_scope` for a rule-out).
 */
export function stopWaypointWork(
  tx: Tx,
  mapId: string,
  waypointId: string,
  reason: RoundWithdrawnReason,
): void {
  const running = tx
    .select({ id: planningRuns.id })
    .from(planningRuns)
    .where(and(eq(planningRuns.waypointId, waypointId), eq(planningRuns.state, "running")))
    .all();
  for (const run of running) {
    cancelRun(tx, run.id, "reopened");
  }
  const pending = tx
    .select({ id: questionRounds.id })
    .from(questionRounds)
    .where(
      and(
        eq(questionRounds.mapId, mapId),
        eq(questionRounds.waypointId, waypointId),
        eq(questionRounds.status, "pending"),
      ),
    )
    .all();
  for (const round of pending) {
    withdrawRound(tx, round.id, reason);
  }
}

/**
 * Applies a `reopen` change in the hatch run's transaction: the waypoint goes `resolved → open`
 * with its resolution columns cleared, and every resolved waypoint it blocks, transitively, reopens
 * the same way; each records the message. Every claimed dependent returns to `open`, its running
 * run cancelled `reopened` and its pending round withdrawn `superseded`. The map's running
 * `consistency`, `to_spec` (map or spec scope) and `spec_review` runs end cancelled `reopened`;
 * `to_tickets`, delivery and `hatch` runs continue. Rounds and reports stay. Never refused for what
 * is in flight; a waypoint not `resolved` is refused `waypoint_state`.
 */
export const applyReopen: HatchApplier<"reopen"> = (tx, { run, message, actor }, change) => {
  const mapWaypoints = readWaypoints(tx, run.mapId);
  const target = mapWaypoints.find((waypoint) => waypoint.number === change.waypoint);
  if (target === undefined) {
    throw new Error(`Map ${run.mapId} has no waypoint ${String(change.waypoint)}`);
  }
  if (target.status !== "resolved") {
    return { result: "refused", refusal: "waypoint_state" };
  }
  const dependents = dependentsOf(tx, run.mapId, target.number);
  for (const waypoint of [
    target,
    ...mapWaypoints.filter((other) => dependents.has(other.number)),
  ]) {
    if (waypoint.status === "resolved") {
      const reopened = tx
        .update(waypoints)
        .set({
          status: "open",
          resolution: null,
          gist: null,
          agentDecided: null,
          resolvedAt: null,
          resolvedHow: null,
          resolvedByRun: null,
          hatchMessageId: message.id,
        })
        .where(and(eq(waypoints.id, waypoint.id), eq(waypoints.status, "resolved")))
        .run();
      if (reopened.changes !== 1) {
        throw new Error(`Waypoint ${waypoint.id} was not resolved when reopened`);
      }
    } else if (waypoint.status === "claimed") {
      stopWaypointWork(tx, run.mapId, waypoint.id, "superseded");
      const released = tx
        .update(waypoints)
        .set({ status: "open" })
        .where(and(eq(waypoints.id, waypoint.id), eq(waypoints.status, "claimed")))
        .run();
      if (released.changes !== 1) {
        throw new Error(`Waypoint ${waypoint.id} was not claimed when its blocker reopened`);
      }
    }
  }
  const mapRuns = tx
    .select({ id: planningRuns.id })
    .from(planningRuns)
    .where(
      and(
        eq(planningRuns.mapId, run.mapId),
        eq(planningRuns.state, "running"),
        inArray(planningRuns.purpose, [...CANCELLED_MAP_PURPOSES]),
      ),
    )
    .all();
  for (const cancelled of mapRuns) {
    cancelRun(tx, cancelled.id, "reopened");
  }
  // The reopen transaction inserts what is due itself (the frontier claims the reopened waypoints
  // once their blockers are settled); the dispatcher's later call finds nothing new.
  planAndRelease(actor, tx, run.mapId);
  return { result: "applied" };
};
