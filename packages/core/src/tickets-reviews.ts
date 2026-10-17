import type { HatchTicketsReview, PlanningRun, TicketSetReview } from "@zenorm/contracts";
import { planningRuns } from "@zenorm/db";
import { eq } from "drizzle-orm";

import { scopeRun } from "./planning-runs.ts";
import type { Reader } from "./planning-runs.ts";
import { findingOf, readRejections, readTicketsReview } from "./specs.ts";
import type { StoredTicketSet } from "./specs.ts";

function reviewEnd(db: Reader, runId: string): string {
  const row = db
    .select({ endedAt: planningRuns.endedAt })
    .from(planningRuns)
    .where(eq(planningRuns.id, runId))
    .get();
  if (row?.endedAt == null) {
    throw new Error(`Tickets review run ${runId} has not ended`);
  }
  return row.endedAt;
}

/**
 * Whether the spec's latest run is a rejection or note rewrite of the set's current version that
 * works or stopped: the version it replaces keeps its review record, but the review it
 * reads is of the version to come, so it reads `pending` ("review running") instead of
 * the replaced version's verdict. A review repair is no such rewrite: its findings stay shown.
 */
function isRewriting(db: Reader, scope: readonly PlanningRun[], set: StoredTicketSet): boolean {
  const latest = scope.at(-1);
  if (latest?.purpose !== "to_tickets" || scopeRun(scope) === null) {
    return false;
  }
  return (
    latest.hatchMessageId !== null ||
    readRejections(db, set.id).some((rejection) => rejection.version === set.version)
  );
}

/**
 * The one read of a ticket set's review state: the tickets review of the set's current version. A
 * recorded review gives `passed`, or `findings` with the stored findings, `held` exactly when one
 * escalated (derived, no column). Without one, an approved set reads null (a record from before
 * tickets reviews). An unapproved set being rewritten from a rejection or a note reads `pending`
 * (`isRewriting`); otherwise one reads `running` while the spec's latest run is a `tickets_review`
 * running or awaiting its retry, `stopped` when it stopped after a failed retry, else `pending`.
 * `scope` is the spec's runs (`specRuns`); `current` is whether the set is the spec's latest
 * approved revision's, the one its spec runs act on.
 */
export function ticketSetReview(
  db: Reader,
  scope: readonly PlanningRun[],
  set: StoredTicketSet,
  current: boolean,
): TicketSetReview | null {
  if (current && set.state !== "approved" && isRewriting(db, scope, set)) {
    return { state: "pending" };
  }
  const recorded = readTicketsReview(db, set.id, set.version);
  if (recorded !== null) {
    const { review, findings } = recorded;
    const reviewedAt = reviewEnd(db, review.runId);
    if (review.passed) {
      return { state: "passed", summary: review.summary, reviewedAt };
    }
    return {
      state: "findings",
      summary: review.summary,
      findings: findings.map((finding) => ({
        ...findingOf(finding),
        escalated: finding.escalated,
      })),
      held: findings.some((finding) => finding.escalated),
      reviewedAt,
    };
  }
  if (set.state === "approved") {
    return null;
  }
  if (current && scope.at(-1)?.purpose === "tickets_review") {
    const shown = scopeRun(scope);
    if (shown === "working") {
      return { state: "running" };
    }
    if (shown !== null) {
      return { state: "stopped", stopped: shown.stopped };
    }
  }
  return { state: "pending" };
}

/** The review state the hatch request carries, from `ticketSetReview`. */
export function hatchTicketsReview(review: TicketSetReview | null): {
  review: HatchTicketsReview;
  heldFindings: { title: string; question: string }[] | null;
} {
  if (review === null) {
    return { review: "none", heldFindings: null };
  }
  switch (review.state) {
    case "pending":
      return { review: "none", heldFindings: null };
    case "running":
    case "stopped":
    case "passed":
      return { review: review.state, heldFindings: null };
    case "findings":
      if (!review.held) {
        return { review: "failed", heldFindings: null };
      }
      return {
        review: "held",
        heldFindings: review.findings
          .filter((finding) => finding.escalated)
          .map((finding) => ({ title: finding.title, question: finding.question })),
      };
  }
}
