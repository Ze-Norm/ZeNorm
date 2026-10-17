import { ok } from "@zenorm/contracts";
import type {
  Actor,
  PlanningRun,
  Result,
  TicketSetContent,
  TicketsReviewOutcome,
} from "@zenorm/contracts";
import { ticketSets, ticketSetVersions, ticketsReviewFindings, ticketsReviews } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import {
  endRun,
  isReplaced,
  now,
  readMapRuns,
  refuse,
  runningRun,
  runPositions,
} from "./planning-runs.ts";
import type { Reader, RunFailure } from "./planning-runs.ts";
import { missedDepartures, readSpecRecord, removedCriteria } from "./reconciliation.ts";
import { readNoteText, readSpecRevisions, readTicketSetOf, readTicketsReview } from "./specs.ts";
import type { StoredRevision } from "./specs.ts";
import { checkTicketSet, firstTicketNumber, writeTicketSet } from "./ticket-sets.ts";
import { escalatedTicketsPositions } from "./tickets-escalation.ts";
import { present } from "./present.ts";
import { planAndRelease } from "./spec-holds.ts";
import { write } from "./writes.ts";
/** The text of the hatch message a run carries, or null. */
export function runNote(db: Reader, run: PlanningRun): string | null {
  return run.hatchMessageId === null ? null : readNoteText(db, run.hatchMessageId);
}

/** The spec's latest approved revision of a `to_tickets` run's map; none is a programmer error. */
export function approvedRevision(db: Reader, run: PlanningRun): StoredRevision {
  const specificationId = present(run.specificationId, `To Tickets run ${run.id}'s spec`);
  const approved = readSpecRevisions(db, specificationId)
    .filter((revision) => revision.mapId === run.mapId && revision.approvedAt !== null)
    .at(-1);
  if (approved === undefined) {
    throw new Error(`To Tickets run ${run.id}'s spec has no approved revision on its map`);
  }
  return approved;
}

/**
 * Records a `to_tickets` run's ticket set against the approved revision and the spec's stored
 * records, numbered per spec from `firstTicketNumber`: version 1 in `awaiting_review`, or on a
 * rewrite after a rejection, a note or a failed review version + 1, whose tickets review then
 * starts. Output breaking the schema or a broken reference fails the run
 * `ticket_set_content_invalid` and writes nothing. A run cancelled while its port call was out
 * saves nothing.
 */
export function recordTicketSet(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  content: TicketSetContent,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "to_tickets") {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not to_tickets`);
    }
    const approved = approvedRevision(tx, run);
    const checked = checkTicketSet(
      content,
      readSpecRecord(tx, approved.specificationId),
      approved.revision,
      firstTicketNumber(tx, approved.specificationId),
    );
    if (!checked.ok) {
      return refuse(actor, tx, run, checked.error);
    }
    writeTicketSet(tx, {
      approved,
      runId: run.id,
      content: checked.value,
      note: runNote(tx, run),
    });
    endRun(tx, run.id, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/** The first attempt of a run's retry chain: the run itself when it retries none. */
export function firstAttempt(runs: readonly PlanningRun[], run: PlanningRun): PlanningRun {
  let first = run;
  while (first.retryOfRunId !== null) {
    const retried = runs.find((candidate) => candidate.id === first.retryOfRunId);
    if (retried === undefined) {
      throw new Error(`Planning run ${first.id} retries a run that is not on its map`);
    }
    first = retried;
  }
  return first;
}

/**
 * The ticket set version a `tickets_review` run reviews, pinned at its start: the latest
 * version of the approved revision's set written by a run started before the review's first
 * attempt. A set or version missing is a programmer error: the review starts only on a written set.
 */
export function reviewedVersion(
  db: Reader,
  run: PlanningRun,
): { approved: StoredRevision; ticketSetId: string; version: number; content: TicketSetContent } {
  const approved = approvedRevision(db, run);
  const set = readTicketSetOf(db, approved.id);
  if (set === undefined) {
    throw new Error(`Tickets review run ${run.id}'s approved revision has no ticket set`);
  }
  const runs = readMapRuns(db, run.mapId);
  const position = runPositions(runs);
  const first = firstAttempt(runs, run);
  const reviewed = db
    .select()
    .from(ticketSetVersions)
    .where(eq(ticketSetVersions.ticketSetId, set.id))
    .orderBy(asc(ticketSetVersions.version))
    .all()
    .filter((version) => position({ id: version.writtenByRun }) < position(first))
    .at(-1);
  if (reviewed === undefined) {
    throw new Error(`Tickets review run ${run.id} started before its set's first version`);
  }
  return { approved, ticketSetId: set.id, version: reviewed.version, content: reviewed.content };
}

/**
 * Records a `tickets_review` run's outcome pinned to `(ticket_set_id, ticket_set_version)`:
 * `passed` exactly when it has no finding, each finding with its route and question, marked
 * `escalated` as `escalatedTicketsPositions` computes in this transaction; the set moves to
 * `review_passed` or `review_failed` where it is unapproved and still at that version. A failed
 * review with no escalated finding makes its repair `to_tickets` due, and `planNext` starts it in
 * this transaction; an escalated one holds the set and starts nothing. A finding naming a ticket
 * the version lacks or a criterion the approved revision lacks fails the run
 * `review_reference_unknown` and writes nothing; so does one missing a `disposition_without_reason`
 * finding for a disposition departing with no reason, failing `review_departure_missed`, retried as
 * every planning run. A run whose set was approved or rewritten meanwhile ends completed and saves
 * nothing.
 */
export function recordTicketsReview(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: TicketsReviewOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "tickets_review") {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not tickets_review`);
    }
    const { approved, ticketSetId, version, content } = reviewedVersion(tx, run);
    const set = tx.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
    if (set === undefined) {
      throw new Error(`Ticket set ${ticketSetId} is gone`);
    }
    if (set.state === "approved" || set.version !== version) {
      endRun(tx, run.id, { state: "completed" });
      planAndRelease(actor, tx, run.mapId);
      return ok(null);
    }
    const tickets = new Set(content.tickets.map((ticket) => ticket.id));
    const spec = readSpecRecord(tx, approved.specificationId);
    const criteria = new Set([
      ...approved.content.clauses.flatMap((clause) => clause.criteria.map((c) => c.id)),
      ...removedCriteria(spec, approved.revision).map((entry) => entry.criterion.id),
    ]);
    for (const [index, finding] of outcome.findings.entries()) {
      const unknownTicket = finding.ticketNumbers.find((id) => !tickets.has(id));
      const unknownCriterion = finding.criterionIds.find((id) => !criteria.has(id));
      if (unknownTicket !== undefined || unknownCriterion !== undefined) {
        return refuse(actor, tx, run, {
          code: "review_reference_unknown",
          message:
            unknownTicket === undefined
              ? `Finding ${String(index + 1)} names criterion ${String(unknownCriterion)}, which the approved revision does not have`
              : `Finding ${String(index + 1)} names ${unknownTicket}, which version ${String(version)} does not have`,
        });
      }
    }
    const missed = missedDepartures(spec, approved.revision, content, outcome.findings);
    if (missed.length > 0) {
      return refuse(actor, tx, run, {
        code: "review_departure_missed",
        message: `No disposition_without_reason finding names ${missed.join(", ")}, whose disposition departs with no reason`,
      });
    }
    if (readTicketsReview(tx, ticketSetId, version) !== null) {
      throw new Error(
        `Ticket set ${ticketSetId}'s version ${String(version)} already has a review`,
      );
    }
    const passed = outcome.findings.length === 0;
    const reviewId = uuidv7();
    tx.insert(ticketsReviews)
      .values({
        id: reviewId,
        ticketSetId,
        ticketSetVersion: version,
        runId: run.id,
        passed,
        summary: outcome.summary,
      })
      .run();
    const escalated = escalatedTicketsPositions(tx, ticketSetId, version, outcome.findings);
    for (const [index, finding] of outcome.findings.entries()) {
      tx.insert(ticketsReviewFindings)
        .values({ reviewId, position: index + 1, ...finding, escalated: escalated.has(index) })
        .run();
    }
    tx.update(ticketSets)
      .set({ state: passed ? "review_passed" : "review_failed", updatedAt: now() })
      .where(
        and(
          eq(ticketSets.id, ticketSetId),
          eq(ticketSets.version, version),
          ne(ticketSets.state, "approved"),
        ),
      )
      .run();
    endRun(tx, run.id, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}
