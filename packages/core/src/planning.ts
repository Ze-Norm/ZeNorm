import { err, ok } from "@zenorm/contracts";
import type {
  Actor,
  ApproveSpecInput,
  ApproveTicketSetInput,
  PlanningRun,
  RejectSpecInput,
  RejectTicketSetInput,
  Result,
  SpecDecisionError,
  TicketSetDecisionError,
} from "@zenorm/contracts";
import { specRevisions, ticketSetRejections, ticketSets } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, eq, isNull } from "drizzle-orm";

import {
  isCleared,
  isSupersededStop,
  now,
  readClearing,
  readMap,
  readMapRuns,
  reclearDue,
  scopeRuns,
  specRuns,
  stoppedRun,
} from "./planning-runs.ts";
import type { Tx } from "./planning-runs.ts";
import { isDraft, latestOf, readRejections, readReview, readSpecRevisions } from "./specs.ts";
import { planAndRelease } from "./spec-holds.ts";
import { write } from "./writes.ts";

/** The codes `spec.reject` returns: those of `spec.approve` but the review's (S7-12). */
export type SpecRejectError = Exclude<SpecDecisionError, { code: "spec_review_not_passed" }>;

/** Whether a scope's latest run is `purpose` and runs or awaits its retry. */
function working(runs: readonly PlanningRun[], purpose: PlanningRun["purpose"]): boolean {
  const latest = runs.at(-1);
  return (
    latest?.purpose === purpose &&
    (latest.state === "running" || (latest.state === "failed" && latest.retryOfRunId === null))
  );
}

/**
 * The refusals `spec.approve` and `spec.reject` share, in S7-11's order: the revision is not
 * found; not its spec's latest draft; its map un-cleared, its map-scope `to_spec` running, or its
 * re-clear due (stopped or not yet started), which writes the draft's next revision (L127 (3),
 * S7-10, L138); its review running. Returns the revision when none applies.
 */
function specDecisionRefusal(
  tx: Tx,
  specRevisionId: string,
): Result<typeof specRevisions.$inferSelect, SpecRejectError> {
  const row = tx.select().from(specRevisions).where(eq(specRevisions.id, specRevisionId)).get();
  if (row === undefined) {
    return err({
      code: "spec_revision_not_found",
      message: `No spec revision with id ${specRevisionId}`,
      data: { specRevisionId },
    });
  }
  const latest = latestOf(readSpecRevisions(tx, row.specificationId));
  if (!isDraft(row) || latest.id !== row.id) {
    return err({
      code: "spec_revision_decided",
      message: `Spec revision ${specRevisionId} is not its spec's latest draft`,
      data: { specRevisionId },
    });
  }
  const map = readMap(tx, row.mapId);
  const runs = readMapRuns(tx, row.mapId);
  if (
    !isCleared(readClearing(tx, map, runs)) ||
    working(scopeRuns(runs, null), "to_spec") ||
    reclearDue(tx, row.mapId, runs)
  ) {
    return err({
      code: "map_uncleared",
      message: `Spec revision ${specRevisionId}'s map is not cleared or is writing specs`,
      data: { specRevisionId },
    });
  }
  if (working(specRuns(runs, row.specificationId), "spec_review")) {
    return err({
      code: "review_in_flight",
      message: `Spec revision ${specRevisionId}'s planning review is running`,
      data: { specRevisionId },
    });
  }
  return ok(row);
}

/**
 * Approves the spec's latest draft revision (S7-11): refuses, in order, `spec_revision_not_found`,
 * `spec_revision_decided`, `map_uncleared`, `review_in_flight`, `spec_review_not_passed`; else
 * sets `approved_at` and starts the spec's `to_tickets` in the same transaction. Returns the map id.
 */
export function approveSpecRevision(
  actor: Actor,
  db: ZeNormDatabase,
  input: ApproveSpecInput,
): Result<string, SpecDecisionError> {
  return write(db, actor, (tx): Result<string, SpecDecisionError> => {
    const checked = specDecisionRefusal(tx, input.specRevisionId);
    if (!checked.ok) {
      return checked;
    }
    const row = checked.value;
    if (readReview(tx, row)?.review.passed !== true) {
      return err({
        code: "spec_review_not_passed",
        message: `Spec revision ${row.id}'s planning review has not passed`,
        data: { specRevisionId: row.id },
      });
    }
    tx.update(specRevisions)
      .set({ approvedAt: now() })
      .where(
        and(
          eq(specRevisions.id, row.id),
          isNull(specRevisions.approvedAt),
          isNull(specRevisions.supersededAt),
        ),
      )
      .run();
    planAndRelease(actor, tx, row.mapId);
    return ok(row.mapId);
  });
}

/**
 * Rejects the spec's latest draft revision with a reason (S7-12): the first refusals of
 * `spec.approve`, then supersedes it with the reason stored; `planNext` starts the spec-scoped
 * `to_spec` addressing it in the same transaction (L97). Returns the map id.
 */
export function rejectSpecRevision(
  actor: Actor,
  db: ZeNormDatabase,
  input: RejectSpecInput,
): Result<string, SpecRejectError> {
  return write(db, actor, (tx): Result<string, SpecRejectError> => {
    const checked = specDecisionRefusal(tx, input.specRevisionId);
    if (!checked.ok) {
      return checked;
    }
    const row = checked.value;
    // A repair of the draft running is refused as its review is (writer's choice, 03): one
    // running run per spec (S7-19) leaves no room for the rejection's own repair.
    const runs = readMapRuns(tx, row.mapId);
    const scope = specRuns(runs, row.specificationId);
    if (working(scope, "to_spec")) {
      return err({
        code: "review_in_flight",
        message: `Spec revision ${row.id}'s repair is running`,
        data: { specRevisionId: row.id },
      });
    }
    // A stopped review or repair, unless superseded (S7-26), keeps the spec from reading idle, so
    // the rejection's repair would never start; refuse until its Try again ends it.
    const stopped = scope.at(-1);
    if (
      stopped !== undefined &&
      stoppedRun(scope) !== null &&
      !isSupersededStop(stopped, readClearing(tx, readMap(tx, row.mapId), runs))
    ) {
      return err({
        code: "review_in_flight",
        message: `Spec revision ${row.id}'s review or repair stopped`,
        data: { specRevisionId: row.id },
      });
    }
    tx.update(specRevisions)
      .set({ supersededAt: now(), rejectionReason: input.reason })
      .where(
        and(
          eq(specRevisions.id, row.id),
          isNull(specRevisions.approvedAt),
          isNull(specRevisions.supersededAt),
        ),
      )
      .run();
    planAndRelease(actor, tx, row.mapId);
    return ok(row.mapId);
  });
}

/**
 * The refusals of `ticketSet.approve` and `ticketSet.reject`, in S7c-6's order with slice 8b D7's:
 * not found; approved `ticket_set_decided`; replaced (its revision no longer its spec's latest,
 * S8b-9) `revision_not_latest`; a `to_tickets` or `tickets_review` running or awaiting its retry,
 * or a `to_tickets` stopped after a failed retry (L167 (B1): a rejected or noted version is not
 * decided through a stopped rewrite), `review_in_flight`; the current version not `review_passed`
 * (no review, a stopped `tickets_review`, failed or held) `ticket_set_review_not_passed`. Returns
 * the set and its map id when none applies.
 */
function ticketSetRefusal(
  tx: Tx,
  ticketSetId: string,
): Result<{ set: typeof ticketSets.$inferSelect; mapId: string }, TicketSetDecisionError> {
  const found = tx
    .select({ set: ticketSets, revision: specRevisions })
    .from(ticketSets)
    .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
    .where(eq(ticketSets.id, ticketSetId))
    .get();
  if (found === undefined) {
    return err({
      code: "ticket_set_not_found",
      message: `No ticket set with id ${ticketSetId}`,
      data: { ticketSetId },
    });
  }
  if (found.set.state === "approved") {
    return err({
      code: "ticket_set_decided",
      message: `Ticket set ${ticketSetId} is approved`,
      data: { ticketSetId },
    });
  }
  if (
    found.revision.revision !==
    latestOf(readSpecRevisions(tx, found.revision.specificationId)).revision
  ) {
    return err({
      code: "revision_not_latest",
      message: `Ticket set ${ticketSetId}'s revision is no longer its spec's latest: the set is replaced`,
      data: { ticketSetId },
    });
  }
  const runs = specRuns(readMapRuns(tx, found.revision.mapId), found.revision.specificationId);
  if (
    working(runs, "to_tickets") ||
    working(runs, "tickets_review") ||
    (runs.at(-1)?.purpose === "to_tickets" && stoppedRun(runs) !== null)
  ) {
    return err({
      code: "review_in_flight",
      message: `Ticket set ${ticketSetId}'s tickets are being written or reviewed, or their rewrite or review stopped`,
      data: { ticketSetId },
    });
  }
  if (found.set.state !== "review_passed") {
    return err({
      code: "ticket_set_review_not_passed",
      message: `Ticket set ${ticketSetId}'s version ${String(found.set.version)} has no passed review`,
      data: { ticketSetId },
    });
  }
  return ok({ set: found.set, mapId: found.revision.mapId });
}

/**
 * Approves a ticket set's current version (S7c-6): the refusals above, then `review_passed →
 * approved` (issue 21 item 1; slice 7's interim relaxation removed). Returns the map id.
 */
export function approveTicketSet(
  actor: Actor,
  db: ZeNormDatabase,
  input: ApproveTicketSetInput,
): Result<string, TicketSetDecisionError> {
  return write(db, actor, (tx): Result<string, TicketSetDecisionError> => {
    const checked = ticketSetRefusal(tx, input.ticketSetId);
    if (!checked.ok) {
      return checked;
    }
    const { set, mapId } = checked.value;
    const at = now();
    const updated = tx
      .update(ticketSets)
      .set({ state: "approved", approvedAt: at, updatedAt: at })
      .where(and(eq(ticketSets.id, set.id), eq(ticketSets.state, "review_passed")))
      .run();
    if (updated.changes !== 1) {
      throw new Error(`Ticket set ${set.id} changed while it was approved`);
    }
    planAndRelease(actor, tx, mapId);
    return ok(mapId);
  });
}

/**
 * Rejects a ticket set's current version with a reason (S7c-7, S7-18): the refusals above, then
 * records the reason against the version, which makes the rewrite `to_tickets` due (D6); `planNext`
 * starts it in the same transaction. Its version is written `awaiting_review` (L32) and gets its
 * own review. Returns the map id.
 */
export function rejectTicketSet(
  actor: Actor,
  db: ZeNormDatabase,
  input: RejectTicketSetInput,
): Result<string, TicketSetDecisionError> {
  return write(db, actor, (tx): Result<string, TicketSetDecisionError> => {
    const checked = ticketSetRefusal(tx, input.ticketSetId);
    if (!checked.ok) {
      return checked;
    }
    const { set, mapId } = checked.value;
    if (readRejections(tx, set.id).some((rejection) => rejection.version === set.version)) {
      return err({
        code: "ticket_set_decided",
        message: `Ticket set ${set.id}'s version ${String(set.version)} is already rejected`,
        data: { ticketSetId: set.id },
      });
    }
    tx.insert(ticketSetRejections)
      .values({
        ticketSetId: set.id,
        version: set.version,
        reason: input.reason,
        rejectedAt: now(),
      })
      .run();
    planAndRelease(actor, tx, mapId);
    return ok(mapId);
  });
}
