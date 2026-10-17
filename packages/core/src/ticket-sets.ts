import { err, ok, TicketSetContent } from "@zenorm/contracts";
import type { Disposition, DraftTicketSetRequest, Result, TicketContent } from "@zenorm/contracts";
import { ticketSets, ticketSetVersions } from "@zenorm/db";
import { and, eq, ne } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { now } from "./planning-runs.ts";
import { deliveredTicket, isOpenCarrier, removedCriteria } from "./reconciliation.ts";
import type { SpecRecord } from "./reconciliation.ts";
import type { Reader, RunFailure, Tx } from "./planning-runs.ts";
import {
  findingOf,
  readDirectedVersions,
  readRejections,
  readSetVersion,
  readSpecRevisions,
  readTicketSetOf,
  readTicketsReview,
} from "./specs.ts";
import type { StoredRevision, StoredTicketSet } from "./specs.ts";

function contentInvalid(message: string): RunFailure {
  return { code: "ticket_set_content_invalid", message };
}

function ticketNumber(id: string): number {
  return Number(id.slice(1));
}

/**
 * The number a spec's next ticket set starts from: one past the highest ticket number in
 * the current version of every approved set of the spec's revisions, on any map; 1 when none is
 * approved. A rewrite before approval starts from the same number, as its own set is unapproved.
 */
export function firstTicketNumber(db: Reader, specificationId: string): number {
  let highest = 0;
  for (const revision of readSpecRevisions(db, specificationId)) {
    const set = readTicketSetOf(db, revision.id);
    if (set?.state !== "approved") {
      continue;
    }
    for (const ticket of readSetVersion(db, set.id, set.version).content.tickets) {
      highest = Math.max(highest, ticketNumber(ticket.id));
    }
  }
  return highest + 1;
}

/**
 * Checks a `to_tickets` output for revision `n` of the spec against its stored records; the
 * saved set keeps the agent's ids. Refused, in order: breaking the schema; ticket ids not running
 * `T<first>`, `T<first+1>`, … in order; a disposition of a criterion the revision neither has nor
 * removes, or a second one; a criterion of the revision with none or `removed`; a removed
 * criterion with none or another kind; `work` naming a set ticket that does not carry the
 * criterion; `delivered` naming no delivered ticket; `retained` naming no open, deliverable
 * carrier; `removed` naming a ticket not in the set; a ticket carrying a criterion without
 * its `work`, or carrying none while no `removed` names it; a follow-up naming no delivered
 * ticket; a blocker that is not an earlier ticket of the set.
 */
export function checkTicketSet(
  content: TicketSetContent,
  spec: SpecRecord,
  n: number,
  first: number,
): Result<TicketSetContent, RunFailure> {
  const parsed = TicketSetContent.safeParse(content);
  if (!parsed.success) {
    return err(
      contentInvalid(
        `The ticket set breaks the skill's "The document" rules: ${parsed.error.message}`,
      ),
    );
  }
  const { tickets, dispositions } = parsed.data;
  const misnumbered = tickets.findIndex(
    (ticket, index) => ticket.id !== `T${String(first + index)}`,
  );
  if (misnumbered !== -1) {
    return err(
      contentInvalid(
        `Ticket ${String(tickets[misnumbered]?.id)} is not T${String(first + misnumbered)}: tickets run from T${String(first)} in order`,
      ),
    );
  }
  const position = new Map(tickets.map((ticket, index) => [ticket.id, index]));
  const revision = spec.revisions.find((candidate) => candidate.revision === n);
  if (revision === undefined) {
    throw new Error(`The spec has no r${String(n)}`);
  }
  const criteria = new Set(
    revision.content.clauses.flatMap((clause) => clause.criteria.map((criterion) => criterion.id)),
  );
  const removed = new Set(removedCriteria(spec, n).map((entry) => entry.criterion.id));
  const disposed = new Map<string, Disposition>();
  for (const disposition of dispositions) {
    const known = criteria.has(disposition.criterion) || removed.has(disposition.criterion);
    if (!known || disposed.has(disposition.criterion)) {
      return err(
        contentInvalid(`Disposition of ${disposition.criterion} is unknown or not the only one`),
      );
    }
    disposed.set(disposition.criterion, disposition);
  }
  for (const criterion of criteria) {
    const kind = disposed.get(criterion)?.kind;
    if (kind === undefined || kind === "removed") {
      return err(
        contentInvalid(`Criterion ${criterion} of r${String(n)} has no disposition or is removed`),
      );
    }
  }
  for (const criterion of removed) {
    if (disposed.get(criterion)?.kind !== "removed") {
      return err(
        contentInvalid(`Criterion ${criterion} is taken out in r${String(n)} but not removed`),
      );
    }
  }
  for (const disposition of dispositions) {
    const refusal = dispositionRefusal(disposition, tickets, position, spec, n);
    if (refusal !== null) {
      return err(contentInvalid(refusal));
    }
  }
  for (const [index, ticket] of tickets.entries()) {
    for (const criterion of ticket.criteria) {
      const disposition = disposed.get(criterion);
      if (disposition?.kind !== "work" || disposition.ticket !== ticket.id) {
        return err(
          contentInvalid(`Ticket ${ticket.id} lists ${criterion} without its work disposition`),
        );
      }
    }
    const takesOut = dispositions.some((d) => d.kind === "removed" && d.ticket === ticket.id);
    if (ticket.criteria.length === 0 && !takesOut) {
      return err(contentInvalid(`Ticket ${ticket.id} carries no criterion and takes none out`));
    }
    if (ticket.followUp !== null && deliveredTicket(spec, n, ticket.followUp) === null) {
      return err(
        contentInvalid(
          `Ticket ${ticket.id} follows up ${ticket.followUp}, which no merged run delivered`,
        ),
      );
    }
    for (const blocker of ticket.blockedBy) {
      const blocking = position.get(blocker.ticket);
      if (blocking === undefined || blocking >= index) {
        return err(
          contentInvalid(
            `Ticket ${ticket.id} is blocked by ${blocker.ticket}, not an earlier ticket`,
          ),
        );
      }
    }
  }
  return ok(parsed.data);
}

/** Why a disposition's reference is broken, or null when it holds. */
function dispositionRefusal(
  disposition: Disposition,
  tickets: readonly TicketContent[],
  position: ReadonlyMap<string, number>,
  spec: SpecRecord,
  n: number,
): string | null {
  switch (disposition.kind) {
    case "satisfied":
      return null;
    case "work": {
      const index = position.get(disposition.ticket);
      const ticket = index === undefined ? undefined : tickets[index];
      return ticket?.criteria.includes(disposition.criterion) === true
        ? null
        : `Criterion ${disposition.criterion}'s work names ${disposition.ticket}, which does not list it`;
    }
    case "delivered":
      return deliveredTicket(spec, n, disposition.ticket) === null
        ? `Criterion ${disposition.criterion} is marked delivered by ${disposition.ticket}, which no merged run delivered`
        : null;
    case "retained":
      return isOpenCarrier(spec, n, disposition.criterion, disposition.ticket)
        ? null
        : `Criterion ${disposition.criterion} is retained by ${disposition.ticket}, which is no open, deliverable carrier of it`;
    case "removed":
      return disposition.ticket === null || position.has(disposition.ticket)
        ? null
        : `Criterion ${disposition.criterion} is taken out by ${disposition.ticket}, which is not in the set`;
  }
}

/**
 * The rewrite a `to_tickets` run of the approved revision addresses: null when the revision has no
 * set (the first version); else its current version, the findings of that version's failed tickets
 * review (empty when it had none) and the reason for the rewrite: the note of a run a hatch message
 * started (`note`), else the reason that version was rejected, else null on a review repair, which
 * is due after a failed review with no escalated finding; and the set's directed versions so far,
 * whose asks a rewrite keeps. A set that is approved, or one with none of the three due (a held
 * set, or no failed review), has no rewrite due, so a `to_tickets` run on it is a programmer error.
 */
export function pendingRewrite(
  db: Reader,
  approved: StoredRevision,
  note: string | null,
): { set: StoredTicketSet; rewrite: NonNullable<DraftTicketSetRequest["rewrite"]> } | null {
  const set = readTicketSetOf(db, approved.id);
  if (set === undefined) {
    if (note !== null) {
      throw new Error(`A note rewrites revision ${approved.id}'s tickets, but it has no set`);
    }
    return null;
  }
  if (set.state === "approved") {
    throw new Error(`Ticket set ${set.id} has no rewrite due`);
  }
  const rejection = readRejections(db, set.id).find(
    (candidate) => candidate.version === set.version,
  );
  const recorded = readTicketsReview(db, set.id, set.version);
  const findings =
    recorded === null || recorded.review.passed ? [] : recorded.findings.map(findingOf);
  let reason: string | null;
  if (note !== null) {
    reason = note;
  } else if (rejection !== undefined) {
    reason = rejection.reason;
  } else if (
    recorded !== null &&
    !recorded.review.passed &&
    !recorded.findings.some((finding) => finding.escalated)
  ) {
    reason = null;
  } else {
    throw new Error(`Ticket set ${set.id} has no rewrite due`);
  }
  return {
    set,
    rewrite: {
      version: set.version,
      content: readSetVersion(db, set.id, set.version).content,
      findings,
      reason,
      directedVersions: readDirectedVersions(db, set.id, set.version),
    },
  };
}

/**
 * Writes a `to_tickets` run's checked set for the approved revision: version 1 in `awaiting_review`
 * when the revision has none; else the rewrite's version + 1 in `awaiting_review` from any
 * unapproved state, bumping the set only where it is unapproved and still at the version rewritten.
 * `note` is the text of the hatch message the run carries, or null. Earlier versions' content rows
 * are never touched.
 */
export function writeTicketSet(
  tx: Tx,
  input: {
    approved: StoredRevision;
    runId: string;
    content: TicketSetContent;
    note: string | null;
  },
): void {
  const at = now();
  const pending = pendingRewrite(tx, input.approved, input.note);
  if (pending === null) {
    const ticketSetId = uuidv7();
    tx.insert(ticketSets)
      .values({
        id: ticketSetId,
        specRevisionId: input.approved.id,
        state: "awaiting_review",
        version: 1,
        createdAt: at,
        updatedAt: at,
        approvedAt: null,
      })
      .run();
    tx.insert(ticketSetVersions)
      .values({
        ticketSetId,
        version: 1,
        content: input.content,
        writtenByRun: input.runId,
        createdAt: at,
      })
      .run();
    return;
  }
  const { set } = pending;
  const version = set.version + 1;
  tx.insert(ticketSetVersions)
    .values({
      ticketSetId: set.id,
      version,
      content: input.content,
      writtenByRun: input.runId,
      createdAt: at,
    })
    .run();
  const bumped = tx
    .update(ticketSets)
    .set({ version, state: "awaiting_review", updatedAt: at })
    .where(
      and(
        eq(ticketSets.id, set.id),
        eq(ticketSets.version, set.version),
        ne(ticketSets.state, "approved"),
      ),
    )
    .run();
  if (bumped.changes !== 1) {
    throw new Error(`Ticket set ${set.id} changed while its rewrite was written`);
  }
}
