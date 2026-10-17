import type { HatchMessageState, HatchMessageView, PlanningRun } from "@zenorm/contracts";
import { hatchMessages, specifications } from "@zenorm/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { HatchChangeApplied } from "./map-activity.ts";
import { scopeRun } from "./planning-runs.ts";
import type { Reader } from "./planning-runs.ts";

/**
 * A message's state from its row and its `hatch` runs, oldest first: replied once the reply
 * is stored; else working while a run runs or awaits its retry, stopped on a failed retry, and
 * queued before its first run.
 */
export function messageState(
  row: Pick<typeof hatchMessages.$inferSelect, "id" | "reply" | "refusal" | "repliedAt">,
  runs: readonly PlanningRun[],
): HatchMessageState {
  if (row.reply !== null) {
    if (row.repliedAt === null) {
      throw new Error(`Hatch message ${row.id} has a reply without its time`);
    }
    return { state: "replied", reply: row.reply, refusal: row.refusal, repliedAt: row.repliedAt };
  }
  const shown = scopeRun(runs);
  if (shown === "working") {
    return { state: "working" };
  }
  if (shown !== null) {
    return { state: "stopped", stopped: shown.stopped };
  }
  if (runs.length > 0) {
    throw new Error(`Hatch message ${row.id} is unreplied after its runs ended`);
  }
  return { state: "queued" };
}

/** The map's hatch messages, oldest first, each with its spec number and state. */
export function readHatchMessages(
  db: Reader,
  mapId: string,
  planningRuns: readonly PlanningRun[],
): HatchMessageView[] {
  const rows = db
    .select({ message: hatchMessages, specNumber: specifications.number })
    .from(hatchMessages)
    .leftJoin(specifications, eq(hatchMessages.specificationId, specifications.id))
    .where(eq(hatchMessages.mapId, mapId))
    .orderBy(asc(hatchMessages.sentAt), asc(hatchMessages.id))
    .all();
  return rows.map(({ message, specNumber }) => {
    if ((message.specificationId === null) !== (specNumber === null)) {
      throw new Error(`Hatch message ${message.id} names a missing spec`);
    }
    const runs = planningRuns.filter(
      (run) => run.purpose === "hatch" && run.hatchMessageId === message.id,
    );
    return {
      id: message.id,
      stage: message.stage,
      spec: specNumber,
      text: message.text,
      sentAt: message.sentAt,
      status: messageState(message, runs),
    };
  });
}

/**
 * The changes the map's hatch messages applied, oldest first: each with the run that
 * replied and the reply's time, which a stored change always has.
 */
export function readHatchChanges(db: Reader, mapId: string): HatchChangeApplied[] {
  const rows = db
    .select({
      id: hatchMessages.id,
      change: hatchMessages.change,
      runId: hatchMessages.runId,
      repliedAt: hatchMessages.repliedAt,
    })
    .from(hatchMessages)
    .where(and(eq(hatchMessages.mapId, mapId), isNotNull(hatchMessages.change)))
    .orderBy(asc(hatchMessages.sentAt), asc(hatchMessages.id))
    .all();
  return rows.map((row) => {
    if (row.change === null || row.runId === null || row.repliedAt === null) {
      throw new Error(`Hatch message ${row.id} has a change without its run or reply time`);
    }
    return { change: row.change, runId: row.runId, appliedAt: row.repliedAt };
  });
}
