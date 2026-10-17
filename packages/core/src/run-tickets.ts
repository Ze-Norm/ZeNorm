import type {
  RunEvent,
  RunTicket,
  RunTicketStatus,
  SpecRun,
  TicketContent,
} from "@zenorm/contracts";
import { deliveryRunTickets, ticketSets } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, eq } from "drizzle-orm";

import { readSpecRuns, toDeliveryRun } from "./delivery.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import { readRunEvents } from "./run-events.ts";
import { readSetVersion } from "./specs.ts";

type Reader = Pick<ZeNormDatabase, "select">;

/** A run's stored ticket row (S8-7). */
export type StoredRunTicket = typeof deliveryRunTickets.$inferSelect;

/** A run's ticket rows in pinned order; none for a run from before `0010`. */
export function readRunTicketRows(db: Reader, runId: string): StoredRunTicket[] {
  return db
    .select()
    .from(deliveryRunTickets)
    .where(eq(deliveryRunTickets.runId, runId))
    .orderBy(asc(deliveryRunTickets.position))
    .all();
}

/** The pinned tickets of a run's ticket set (an approved set never changes version). */
function pinnedTickets(db: Reader, run: StoredDeliveryRun): TicketContent[] {
  const set = db.select().from(ticketSets).where(eq(ticketSets.id, run.ticketSetId)).get();
  if (set === undefined) {
    throw new Error(`Delivery run ${run.id}'s ticket set ${run.ticketSetId} is missing`);
  }
  return readSetVersion(db, set.id, set.version).content.tickets;
}

/**
 * One ticket's status in a run (D6, the demo's `runTicketStatus`): `merged` once it has a merged
 * record; else, on an ended run, `not_delivered`; on an active run `implementing` once it is
 * started (the started record decides, never a line; `latest` is its latest line or null),
 * `waiting` on its unmerged blockers, or `starting`.
 */
function ticketStatus(
  run: StoredDeliveryRun,
  row: StoredRunTicket,
  ticket: TicketContent,
  rows: ReadonlyMap<string, StoredRunTicket>,
  latest: RunEvent | null,
): RunTicketStatus {
  if (row.mergedAt !== null) {
    if (row.commit === null) {
      throw new Error(`Ticket ${row.ticket} of run ${run.id} is merged with no commit`);
    }
    return { state: "merged", commit: row.commit, summary: row.summary };
  }
  if (run.endedAt !== null) {
    return { state: "not_delivered", started: row.startedAt !== null };
  }
  if (row.startedAt !== null) {
    return { state: "implementing", latest };
  }
  const on = ticket.blockedBy.filter((blocker) => {
    const blockerRow = rows.get(blocker.ticket);
    if (blockerRow === undefined) {
      throw new Error(
        `Ticket ${ticket.id} of run ${run.id} waits on ${blocker.ticket}, not pinned`,
      );
    }
    return blockerRow.mergedAt === null;
  });
  const [first, ...others] = on;
  return first === undefined ? { state: "starting" } : { state: "waiting", on: [first, ...others] };
}

/** A ticket's latest line, or null before its first. */
function latestLine(latest: ReadonlyMap<string, RunEvent>, ticket: string): RunEvent | null {
  const line = latest.get(ticket);
  if (line === undefined) {
    return null;
  }
  return line;
}

/**
 * Each pinned ticket's status in a run, in pinned order (D6), with `failing`: the criterion ids
 * the run's blocking findings name that the ticket carries. Null for a run with no ticket rows
 * (from before `0010`).
 */
export function runTickets(db: Reader, run: StoredDeliveryRun): RunTicket[] | null {
  const rows = readRunTicketRows(db, run.id);
  if (rows.length === 0) {
    return null;
  }
  const byTicket = new Map(rows.map((row) => [row.ticket, row]));
  const tickets = new Map(pinnedTickets(db, run).map((ticket) => [ticket.id, ticket]));
  const latest = new Map<string, RunEvent>();
  for (const event of readRunEvents(db, run.id)) {
    if (event.ticket !== null) {
      latest.set(event.ticket, event);
    }
  }
  const blocking = new Set(
    (run.verdict === null ? [] : run.verdict.findings)
      .filter((finding) => finding.severity === "blocking")
      .flatMap((finding) => (finding.criterion === null ? [] : [finding.criterion])),
  );
  return rows.map((row) => {
    const ticket = tickets.get(row.ticket);
    if (ticket === undefined) {
      throw new Error(`Run ${run.id} has a row for ${row.ticket}, which its set does not pin`);
    }
    return {
      ticket: row.ticket,
      status: ticketStatus(run, row, ticket, byTicket, latestLine(latest, row.ticket)),
      failing: ticket.criteria.filter((criterion) => blocking.has(criterion)),
    };
  });
}

/**
 * A spec's runs as `map.overview` carries them (D2), newest first: each run's state (`held` says
 * whether the delivery runner holds an active run) and its tickets' statuses.
 */
export function specRunViews(
  db: Reader,
  specificationId: string,
  held: (runId: string) => boolean,
): SpecRun[] {
  return readSpecRuns(db, specificationId).map((run) => ({
    ...toDeliveryRun(run, held(run.id)),
    tickets: runTickets(db, run),
  }));
}
