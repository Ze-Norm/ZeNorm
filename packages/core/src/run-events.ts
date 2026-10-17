import { cutAgentText, err, ok, RUN_EVENT_TEXT_MAX_LENGTH } from "@zenorm/contracts";
import type { Actor, DeliveryActivityError, Result, RunActor, RunEvent } from "@zenorm/contracts";
import { deliveryRunEvents, deliveryRuns } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, eq, max } from "drizzle-orm";

import type { Tx } from "./planning-runs.ts";
import { write } from "./writes.ts";

type Reader = Pick<ZeNormDatabase, "select">;

/**
 * A line's text as stored: at most 500 characters as the contract counts them (UTF-16
 * units, which also bounds SQLite's code-point `length`), cut by the shared `cutAgentText` (never
 * inside a code or bold pair, ending "…"). An empty text is a programmer error.
 */
export function cutRunEventText(text: string): string {
  if (text === "") {
    throw new Error("A run line has no text");
  }
  return cutAgentText(text, RUN_EVENT_TEXT_MAX_LENGTH);
}

/** One line to append to a run's activity. */
export interface RunLine {
  readonly runId: string;
  readonly who: RunActor;
  /** The ticket the line belongs to; null for a line about the whole run. */
  readonly ticket: string | null;
  readonly text: string;
}

/**
 * Inserts a line into a run's activity inside the caller's `write`, numbered
 * `seq = max + 1`, stamped now, its text cut by `cutRunEventText`. An unknown run is a programmer
 * error (the foreign key refuses it).
 */
export function insertRunEvent(tx: Tx, line: RunLine): RunEvent {
  const text = cutRunEventText(line.text);
  const last = tx
    .select({ seq: max(deliveryRunEvents.seq) })
    .from(deliveryRunEvents)
    .where(eq(deliveryRunEvents.runId, line.runId))
    .get();
  // A run's first line is 1: `max` over no rows is null.
  const previous = last === undefined ? null : last.seq;
  const event: RunEvent = {
    seq: previous === null ? 1 : previous + 1,
    at: new Date().toISOString(),
    who: line.who,
    ticket: line.ticket,
    text,
  };
  tx.insert(deliveryRunEvents)
    .values({ runId: line.runId, ...event })
    .run();
  return event;
}

/**
 * Appends a line to a run's activity in its own short `write` (`insertRunEvent`). Any actor; an
 * ended run's lines are appended too.
 */
export function appendRunEvent(actor: Actor, db: ZeNormDatabase, line: RunLine): RunEvent {
  // Cut before the transaction opens, so an empty text throws before any write.
  cutRunEventText(line.text);
  return write(db, actor, (tx): RunEvent => insertRunEvent(tx, line));
}

/** A run's lines, oldest first. */
export function readRunEvents(db: Reader, runId: string): RunEvent[] {
  return db
    .select({
      seq: deliveryRunEvents.seq,
      at: deliveryRunEvents.at,
      who: deliveryRunEvents.who,
      ticket: deliveryRunEvents.ticket,
      text: deliveryRunEvents.text,
    })
    .from(deliveryRunEvents)
    .where(eq(deliveryRunEvents.runId, runId))
    .orderBy(asc(deliveryRunEvents.seq))
    .all();
}

/** `delivery.activity`: a run's lines oldest first, or `delivery_run_not_found`. */
export function getDeliveryActivity(
  db: Reader,
  runId: string,
): Result<RunEvent[], DeliveryActivityError> {
  const run = db
    .select({ id: deliveryRuns.id })
    .from(deliveryRuns)
    .where(eq(deliveryRuns.id, runId))
    .get();
  if (run === undefined) {
    return err({
      code: "delivery_run_not_found",
      message: `No delivery run with id ${runId}`,
      data: { runId },
    });
  }
  return ok(readRunEvents(db, runId));
}
