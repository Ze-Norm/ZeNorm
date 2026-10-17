import type { TicketsReviewFinding } from "@zenorm/contracts";
import { planningRuns } from "@zenorm/db";
import { eq } from "drizzle-orm";

import type { Reader } from "./planning-runs.ts";
import { readRejections, readSetVersion, readTicketsReview } from "./specs.ts";

/**
 * Whether version `version` of the set is a review repair (slice 7c D5): a `to_tickets` run with
 * no hatch message wrote it, the version before has no rejection, and that version's tickets
 * review failed. A version written by a rejection rewrite or a note (S7b-12), and the first
 * version, are not repairs, so they restart the count (S7c-5).
 */
function isReviewRepair(db: Reader, ticketSetId: string, version: number): boolean {
  if (version < 2) {
    return false;
  }
  const { writtenByRun } = readSetVersion(db, ticketSetId, version);
  const writer = db.select().from(planningRuns).where(eq(planningRuns.id, writtenByRun)).get();
  if (writer === undefined) {
    throw new Error(`Ticket set ${ticketSetId}'s writing run ${writtenByRun} is missing`);
  }
  const before = version - 1;
  return (
    writer.purpose === "to_tickets" &&
    writer.hatchMessageId === null &&
    !readRejections(db, ticketSetId).some((rejection) => rejection.version === before) &&
    readTicketsReview(db, ticketSetId, before)?.review.passed === false
  );
}

/**
 * The positions (from 0) of a failing tickets review's findings that escalate (S7c-5, L30),
 * computed in the transaction recording it from recorded versions, their writing runs, rejections
 * and reviews (no counter, issue 25 item 3; the approved revision, the review's sources, does not
 * change within a set, issue 25 item 1). Every `decision` finding, whatever the count, when there
 * is one (the `revise` ones stay unescalated); else every finding when the version is the second
 * consecutive repair; else none, and the review's repair is due.
 */
export function escalatedTicketsPositions(
  db: Reader,
  ticketSetId: string,
  version: number,
  findings: readonly TicketsReviewFinding[],
): Set<number> {
  const decisions = findings.flatMap((finding, index) =>
    finding.route === "decision" ? [index] : [],
  );
  if (decisions.length > 0) {
    return new Set(decisions);
  }
  return findings.length > 0 &&
    isReviewRepair(db, ticketSetId, version) &&
    isReviewRepair(db, ticketSetId, version - 1)
    ? new Set(findings.map((_, index) => index))
    : new Set();
}
