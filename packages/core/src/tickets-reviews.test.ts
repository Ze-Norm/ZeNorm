import type {
  Project,
  TicketSetContent,
  TicketSetReview,
  TicketsReviewFinding,
} from "@zenorm/contracts";
import { RejectTicketSetInput } from "@zenorm/contracts";
import { planningRuns, ticketSets, ticketsReviews } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { rejectTicketSet } from "./planning.ts";
import { specRuns } from "./planning-runs.ts";
import { readSpecRevisions, readTicketSetOf } from "./specs.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  deliveredSpec,
  insertNextRevision,
  insertTicketSetWith,
  SPEC,
  TICKETS,
  unreviewedTicketSet,
  insertTicketsRepair,
  insertTicketsReview,
  insertTicketsReviewRun,
  openTestContext,
  runsOf,
  runningSpecRun,
  TICKETS_DECISION_FINDING,
  TICKETS_REVISE_FINDING,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { prepareRun } from "./run-work.ts";
import { ticketsEarlierFindings } from "./spec-requests.ts";
import { recordTicketsReview } from "./ticket-set-runs.ts";
import { pendingRewrite } from "./ticket-sets.ts";
import { ticketSetReview } from "./tickets-reviews.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-tickets-reviews-");
  project = await addProject(context, "reviews");
});

afterEach(async () => {
  await closeTestContext(context);
});

const RUNNERS = { deliveryHeld: () => false };
const REASON = RejectTicketSetInput.shape.reason.parse("Split the exporter.");
const REVISE = { finding: TICKETS_REVISE_FINDING, escalated: false };
const DECISION = { finding: TICKETS_DECISION_FINDING, escalated: true };

/** The review of the map's one ticket set, as `map.overview` gives it. */
async function reviewOf(mapId: string): Promise<TicketSetReview | null> {
  const overview = await getMapOverview(context.db, mapId, RUNNERS);
  if (!overview.ok) throw new Error(overview.error.code);
  const set = overview.value.specs[0]?.ticketSets[0];
  if (set === undefined) throw new Error(`Map ${mapId} has no ticket set`);
  return set.review;
}

/**
 * The review of the map's one ticket set straight from `ticketSetReview`, for a failed review that
 * is neither held nor followed by a running repair: `map.overview` reads that as a programmer error,
 * as recording a revise-only failed review starts its repair.
 */
function storedReviewOf(drafted: { mapId: string; specificationId: string }) {
  const set = readTicketSetOf(context.db, approvedRevision(drafted.specificationId).id);
  if (set === undefined) throw new Error(`Map ${drafted.mapId} has no ticket set`);
  return ticketSetReview(
    context.db,
    specRuns(runsOf(context, drafted.mapId), drafted.specificationId),
    set,
    true,
  );
}

/** When the map's completed tickets review run ended. */
function reviewRunEnd(mapId: string): string {
  const run = runsOf(context, mapId).find(
    (candidate) => candidate.purpose === "tickets_review" && candidate.state === "completed",
  );
  if (run?.endedAt == null) throw new Error(`Map ${mapId} has no completed tickets review`);
  return run.endedAt;
}

/** The spec's approved revision, which its set is written for. */
function approvedRevision(specificationId: string) {
  const approved = readSpecRevisions(context.db, specificationId).find(
    (revision) => revision.approvedAt !== null,
  );
  if (approved === undefined) throw new Error(`Spec ${specificationId} has no approved revision`);
  return approved;
}

describe("the one read of a ticket set's review", () => {
  test("pending while the version has no review and no tickets_review runs", async () => {
    const { mapId } = await unreviewedTicketSet(context, project);

    expect(await reviewOf(mapId)).toEqual({ state: "pending" });
  });

  test("running while its tickets_review runs", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReviewRun(context, { ...drafted, state: "running" });

    expect(await reviewOf(drafted.mapId)).toEqual({ state: "running" });
  });

  test("stopped after its tickets_review's retry failed, naming the stopped run", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    const retry = insertTicketsReviewRun(context, { ...drafted, state: "stopped" });
    const set = readTicketSetOf(context.db, approvedRevision(drafted.specificationId).id);
    if (set === undefined) throw new Error("No ticket set");
    const scope = specRuns(runsOf(context, drafted.mapId), drafted.specificationId);

    // Read directly: `map.overview`'s activity names a stopped tickets review from 06 on.
    const review = ticketSetReview(context.db, scope, set, true);

    expect(review?.state).toBe("stopped");
    expect(review?.state === "stopped" ? review.stopped.runId : null).toBe(retry.id);
    // Only the spec's latest approved revision's set reads its spec's runs.
    expect(ticketSetReview(context.db, scope, set, false)).toEqual({ state: "pending" });
  });

  test("passed with its summary when the review recorded no finding", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [] });

    expect(await reviewOf(drafted.mapId)).toEqual({
      state: "passed",
      summary: "Every criterion traces to its clause.",
      reviewedAt: reviewRunEnd(drafted.mapId),
    });
  });

  test("findings, not held, with each stored finding's route, question and mark", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });

    expect(storedReviewOf(drafted)).toEqual({
      state: "findings",
      summary: "The tickets need work.",
      findings: [{ ...TICKETS_REVISE_FINDING, escalated: false }],
      held: false,
      reviewedAt: reviewRunEnd(drafted.mapId),
    });
  });

  test("held exactly when a finding of the current version's review escalated", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE, DECISION] });

    const review = await reviewOf(drafted.mapId);

    expect(review?.state === "findings" ? review.held : null).toBe(true);
    expect(review?.state === "findings" ? review.findings.map((f) => f.escalated) : null).toEqual([
      false,
      true,
    ]);
  });

  test("a running repair leaves the failed review of the version it rewrites", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });
    insertTicketsRepair(context, { ...drafted, state: "running" });

    expect((await reviewOf(drafted.mapId))?.state).toBe("findings");
  });

  test("reads the current version: a repair's new version is pending, then running", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });
    insertTicketsRepair(context, { ...drafted, state: "completed" });

    expect(await reviewOf(drafted.mapId)).toEqual({ state: "pending" });

    insertTicketsReviewRun(context, { ...drafted, state: "running" });
    expect(await reviewOf(drafted.mapId)).toEqual({ state: "running" });
  });

  test("a stopped repair is not a stopped review", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });
    insertTicketsRepair(context, { ...drafted, state: "stopped" });

    expect(storedReviewOf(drafted)?.state).toBe("findings");
  });

  test("a set approved with no review, from before tickets reviews, reads none", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    // A plain approval from before tickets reviews, which approved a set with no review.
    const at = new Date().toISOString();
    writeTestData(context, (tx) =>
      tx
        .update(ticketSets)
        .set({ state: "approved", approvedAt: at, updatedAt: at })
        .where(eq(ticketSets.id, drafted.ticketSetId))
        .run(),
    );

    expect(await reviewOf(drafted.mapId)).toBeNull();
  });
});

describe("pendingRewrite's findings and review repair", () => {
  test("a failed, unescalated review is repaired with its findings and no reason", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });

    const pending = pendingRewrite(context.db, approvedRevision(drafted.specificationId), null);

    expect(pending?.rewrite.version).toBe(1);
    expect(pending?.rewrite.findings).toEqual([TICKETS_REVISE_FINDING]);
    expect(pending?.rewrite.reason).toBeNull();
  });

  test("a note on a held set carries the note and the held version's findings", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [REVISE, DECISION] });
    const approved = approvedRevision(drafted.specificationId);

    const pending = pendingRewrite(context.db, approved, "Ship the exporter first.");

    expect(pending?.rewrite.reason).toBe("Ship the exporter first.");
    expect(pending?.rewrite.findings).toEqual([TICKETS_REVISE_FINDING, TICKETS_DECISION_FINDING]);
    // Without the note the held set has no rewrite due: only the person releases a hold.
    expect(() => pendingRewrite(context.db, approved, null)).toThrow();
  });

  test("a rejection of a passed version carries its reason and no findings", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, { ...drafted, findings: [] });
    expect(
      rejectTicketSet(context.user, context.db, {
        ticketSetId: drafted.ticketSetId,
        reason: REASON,
      }).ok,
    ).toBe(true);

    const pending = pendingRewrite(context.db, approvedRevision(drafted.specificationId), null);

    expect(pending?.rewrite.reason).toBe(REASON);
    expect(pending?.rewrite.findings).toEqual([]);
  });

  test("a version with no failed review, no note and no rejection has no rewrite due", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    const approved = approvedRevision(drafted.specificationId);

    expect(() => pendingRewrite(context.db, approved, null)).toThrow();

    insertTicketsReview(context, { ...drafted, findings: [] });
    expect(() => pendingRewrite(context.db, approved, null)).toThrow();
  });
});

// --- Departures ---

describe("the tickets review must name every reasonless departure", () => {
  /**
   * Spec 1's r1 delivered (T1, T2), then another map's r2 with the same text, approved, whose set
   * gives 1.1 `work` by T3 (a departure: it is unchanged and delivered) with `reason`, and 1.2
   * `delivered` by T1; its tickets review running.
   */
  async function departingSet(reason: string | null) {
    const delivered = await deliveredSpec(context, project);
    const mapId = await clearedMap(context, project);
    const { specificationId } = delivered;
    const next = insertNextRevision(context, {
      specificationId,
      mapId,
      content: SPEC,
      approved: true,
      set: null,
    });
    const content: TicketSetContent = {
      ...TICKETS,
      tickets: TICKETS.tickets.slice(1, 2).map((ticket) => ({
        ...ticket,
        id: "T3",
        blockedBy: [],
        followUp: "T2",
      })),
      dispositions: [
        { criterion: "1.1", kind: "work", ticket: "T3", reason },
        { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
      ],
    };
    const ticketSetId = insertTicketSetWith(context, {
      mapId,
      specificationId,
      specRevisionId: next.specRevisionId,
      content,
      state: "awaiting_review",
      review: null,
    });
    const run = insertTicketsReviewRun(context, { mapId, specificationId, state: "running" });
    return { mapId, specificationId, ticketSetId, run };
  }

  const DEPARTURE_FINDING: TicketsReviewFinding = {
    kind: "disposition_without_reason",
    route: "revise",
    title: "1.1 changes delivered code without saying why",
    explanation: "1.1 is unchanged and delivered by T2, yet T3 changes it.",
    question: "Why does T3 need to change 1.1?",
    ticketNumbers: ["T3"],
    criterionIds: ["1.1"],
  };

  test("an outcome missing the finding fails review_departure_missed and writes nothing", async () => {
    const { mapId, specificationId, ticketSetId, run } = await departingSet(null);
    const retry = () => {
      const latest = specRuns(runsOf(context, mapId), specificationId).at(-1);
      if (latest?.purpose !== "tickets_review" || latest.state !== "running") {
        throw new Error("The tickets review's retry is not running");
      }
      return latest;
    };
    const outcomes = [
      { summary: "Clean.", findings: [] },
      {
        summary: "Another point.",
        findings: [{ ...TICKETS_REVISE_FINDING, ticketNumbers: ["T3"] }],
      },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const current = index === 0 ? run : retry();
      expect(recordTicketsReview(context.user, context.db, current.id, outcome)).toMatchObject({
        ok: false,
        error: { code: "review_departure_missed" },
      });
      expect(
        context.db
          .select()
          .from(ticketsReviews)
          .where(eq(ticketsReviews.ticketSetId, ticketSetId))
          .all(),
      ).toEqual([]);
      expect(readTicketSetOf(context.db, readTicketSetRevision(ticketSetId))?.state).toBe(
        "awaiting_review",
      );
    }
    expect(runsOf(context, mapId).find((r) => r.id === run.id)).toMatchObject({
      state: "failed",
      errorCode: "review_departure_missed",
    });
  });

  test("with its finding the review fails and the repair to_tickets is due", async () => {
    const { mapId, specificationId, ticketSetId, run } = await departingSet(null);
    const outcome = { summary: "One departure.", findings: [DEPARTURE_FINDING] };
    expect(recordTicketsReview(context.user, context.db, run.id, outcome)).toEqual({
      ok: true,
      value: null,
    });
    expect(
      context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get(),
    ).toMatchObject({
      state: "review_failed",
    });
    const scope = specRuns(runsOf(context, mapId), specificationId);
    expect(scope.at(-1)).toMatchObject({ purpose: "to_tickets", state: "running" });
  });

  test("a departure with a reason needs no finding", async () => {
    const { ticketSetId, run } = await departingSet(
      "Research 3: T2's button breaks on sorted rows.",
    );
    expect(
      recordTicketsReview(context.user, context.db, run.id, { summary: "Clean.", findings: [] }),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(
      context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get(),
    ).toMatchObject({
      state: "review_passed",
    });
  });
});

/** The revision id of a ticket set. */
function readTicketSetRevision(ticketSetId: string): string {
  const set = context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
  if (set === undefined) throw new Error(`No ticket set ${ticketSetId}`);
  return set.specRevisionId;
}

// --- Earlier findings (the repair loop's memory, as a spec's) ---

describe("the tickets requests' earlier findings", () => {
  const OTHER = { ...TICKETS_REVISE_FINDING, explanation: "T1 builds in the wrong package." };
  const brief = (finding: TicketsReviewFinding) => ({
    kind: finding.kind,
    ticketNumbers: finding.ticketNumbers,
    criterionIds: finding.criterionIds,
    explanation: finding.explanation,
  });

  test("carry the failed reviews before the version, only after the latest passed one", async () => {
    const drafted = await unreviewedTicketSet(context, project);
    const { ticketSetId } = drafted;
    const repair = () => insertTicketsRepair(context, { ...drafted, state: "completed" });
    const v1 = { version: 1, findings: [brief(TICKETS_REVISE_FINDING)] };
    const v2 = { version: 2, findings: [brief(OTHER)] };
    const v4 = { version: 4, findings: [brief(TICKETS_REVISE_FINDING)] };
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });
    repair();
    insertTicketsReview(context, { ...drafted, findings: [{ finding: OTHER, escalated: false }] });
    repair();
    expect(ticketsEarlierFindings(context.db, ticketSetId, 1)).toEqual([]);
    expect(ticketsEarlierFindings(context.db, ticketSetId, 2)).toEqual([v1]);
    expect(ticketsEarlierFindings(context.db, ticketSetId, 3)).toEqual([v1, v2]);
    // v3 passes, then the person rejects it: v3's pass closes v1's and v2's findings.
    insertTicketsReview(context, { ...drafted, findings: [] });
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }).ok).toBe(
      true,
    );
    // The rejection's rewrite of v3 carries no earlier finding: v3's pass closed them.
    const rewrite = runningSpecRun(context, drafted.mapId, "to_tickets");
    const rejected = await prepareRun(context.db, rewrite.id);
    if (!rejected.ok || rejected.value.purpose !== "to_tickets") throw new Error("not to_tickets");
    expect(rejected.value.request.rewrite).toMatchObject({ version: 3, findings: [] });
    expect(rejected.value.request.earlierFindings).toEqual([]);
    // The test writes v4 itself.
    writeTestData(context, (tx) =>
      tx.delete(planningRuns).where(eq(planningRuns.id, rewrite.id)).run(),
    );
    repair();
    insertTicketsReview(context, { ...drafted, findings: [REVISE] });
    repair();

    expect(ticketsEarlierFindings(context.db, ticketSetId, 5)).toEqual([v4]);

    // The review of v5 carries v4's findings.
    const reviewRun = insertTicketsReviewRun(context, { ...drafted, state: "running" });
    const review = await prepareRun(context.db, reviewRun.id);
    if (!review.ok || review.value.purpose !== "tickets_review") throw new Error("not a review");
    expect(review.value.request.ticketSet.version).toBe(5);
    expect(review.value.request.earlierFindings).toEqual([v4]);
    writeTestData(context, (tx) =>
      tx.delete(planningRuns).where(eq(planningRuns.id, reviewRun.id)).run(),
    );

    // v5's repair carries v5's findings as the rewrite's, and only v4's as earlier.
    insertTicketsReview(context, { ...drafted, findings: [{ finding: OTHER, escalated: false }] });
    const repairRun = insertTicketsRepair(context, { ...drafted, state: "running" });
    const draft = await prepareRun(context.db, repairRun.id);
    if (!draft.ok || draft.value.purpose !== "to_tickets") throw new Error("not to_tickets");
    expect(draft.value.request.rewrite?.version).toBe(5);
    expect(draft.value.request.earlierFindings).toEqual([v4]);
  });
});
