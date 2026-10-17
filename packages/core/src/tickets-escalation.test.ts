import type {
  MapOverviewDetail,
  PlanningRun,
  Project,
  TicketSetReview,
  TicketsReviewFinding,
} from "@zenorm/contracts";
import { RejectTicketSetInput } from "@zenorm/contracts";
import { ticketSets } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { approveTicketSet, rejectTicketSet } from "./planning.ts";
import { failRun, tryAgain } from "./planning-runs.ts";
import { draftTicketSetRequest, reviewTicketSetRequest } from "./spec-requests.ts";
import type { SpecRunBase } from "./spec-requests.ts";
import { readSetVersion, readTicketsReview, toTicketsDue } from "./specs.ts";
import {
  addProject,
  closeTestContext,
  draftedTicketSet,
  FAILED_TICKETS_REVIEW,
  heldTicketSet,
  openTestContext,
  recordRunningTicketSet,
  recordRunningTicketsReview,
  runningSpecRun,
  runsOf,
  TICKETS_DECISION_FINDING,
  TICKETS_REVISE_FINDING,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-tickets-escalation-");
  project = await addProject(context, "escalation");
});

afterEach(async () => {
  await closeTestContext(context);
});

const RUNNERS = { deliveryHeld: () => false };
const BASE: SpecRunBase = {
  projectName: "escalation",
  projectFolder: "/tmp/escalation",
  baseBranch: "main",
  idea: "Export data",
};
const REASON = RejectTicketSetInput.shape.reason.parse("Split the exporter.");
const FAILURE = { code: "agent_timed_out", message: "The agent timed out" } as const;
const SECOND_REVISE: TicketsReviewFinding = {
  ...TICKETS_REVISE_FINDING,
  title: "Adds a JSON format",
  explanation: "T2 offers JSON, which no criterion states.",
};

function fail(mapId: string, findings: TicketsReviewFinding[]): void {
  recordRunningTicketsReview(context, mapId, { summary: "The tickets need work.", findings });
}

function setOf(ticketSetId: string) {
  const set = context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
  if (set === undefined) throw new Error(`No ticket set ${ticketSetId}`);
  return set;
}

/** Each finding's `escalated` mark in the review of `version`, in order. */
function escalatedOf(ticketSetId: string, version: number): boolean[] {
  const recorded = readTicketsReview(context.db, ticketSetId, version);
  if (recorded === null) throw new Error(`Version ${String(version)} has no review`);
  return recorded.findings.map((finding) => finding.escalated);
}

function specRunsOf(mapId: string, purpose: PlanningRun["purpose"]): PlanningRun[] {
  return runsOf(context, mapId).filter(
    (run) => run.specificationId !== null && run.purpose === purpose,
  );
}

function isRunning(mapId: string, purpose: PlanningRun["purpose"]): boolean {
  return specRunsOf(mapId, purpose).some((run) => run.state === "running");
}

async function overview(mapId: string): Promise<MapOverviewDetail> {
  const result = await getMapOverview(context.db, mapId, RUNNERS);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

/** The review of the map's one ticket set through 02's read (`map.overview`, D11). */
async function reviewOf(mapId: string): Promise<TicketSetReview | null> {
  const set = (await overview(mapId)).specs[0]?.ticketSets[0];
  if (set === undefined) throw new Error(`Map ${mapId} has no ticket set`);
  return set.review;
}

async function heldOf(mapId: string): Promise<boolean> {
  const review = await reviewOf(mapId);
  return review?.state === "findings" && review.held;
}

function expectDecisionsRefused(ticketSetId: string, code: string): void {
  expect(approveTicketSet(context.user, context.db, { ticketSetId })).toMatchObject({
    ok: false,
    error: { code },
  });
  expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON })).toMatchObject({
    ok: false,
    error: { code },
  });
}

describe("the review repair (S7c-4, D4)", () => {
  test("a revise-only failed review of v1 starts the repair in its recording transaction; v2 is awaiting_review and gets a full review", async () => {
    const { mapId, specificationId, ticketSetId } = await draftedTicketSet(context, project);

    fail(mapId, [TICKETS_REVISE_FINDING]);

    expect(escalatedOf(ticketSetId, 1)).toEqual([false]);
    expect(setOf(ticketSetId)).toMatchObject({ version: 1, state: "review_failed" });
    const repair = runningSpecRun(context, mapId, "to_tickets");
    expect(repair).toMatchObject({ hatchMessageId: null, retryOfRunId: null });
    expect(toTicketsDue(context.db, mapId, specificationId)).toBe(true);
    expect((await overview(mapId)).specs[0]?.stages[1]?.tone).toBe("working");

    recordRunningTicketSet(context, mapId);

    expect(setOf(ticketSetId)).toMatchObject({ version: 2, state: "awaiting_review" });
    const review = runningSpecRun(context, mapId, "tickets_review");
    expect(reviewTicketSetRequest(context.db, review, BASE).ticketSet).toEqual({
      version: 2,
      content: readSetVersion(context.db, ticketSetId, 2).content,
    });
    expect(isRunning(mapId, "to_tickets")).toBe(false);
  });

  test("the repair request carries the failed review's findings in order with a null reason", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);

    fail(mapId, [TICKETS_REVISE_FINDING, SECOND_REVISE]);

    const repair = runningSpecRun(context, mapId, "to_tickets");
    expect(draftTicketSetRequest(context.db, repair, BASE).rewrite).toEqual({
      version: 1,
      content: readSetVersion(context.db, ticketSetId, 1).content,
      findings: [TICKETS_REVISE_FINDING, SECOND_REVISE],
      reason: null,
      directedVersions: [],
    });
  });

  test("a rejection rewrite's request carries its reason and no findings (its version's review passed)", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId);

    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }).ok).toBe(
      true,
    );

    const rewrite = runningSpecRun(context, mapId, "to_tickets");
    expect(draftTicketSetRequest(context.db, rewrite, BASE).rewrite).toMatchObject({
      version: 1,
      findings: [],
      reason: REASON,
    });
  });

  test("L180 (2): a rejection reason reaches the review of the version it shaped and the repair of that version, and every later one", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }).ok).toBe(
      true,
    );
    const rejected = { kind: "rejection", version: 2, reason: REASON } as const;

    // The rejection rewrite carries the reason as its own; v1 has no directed version before it.
    const rewrite = runningSpecRun(context, mapId, "to_tickets");
    expect(draftTicketSetRequest(context.db, rewrite, BASE).rewrite).toMatchObject({
      version: 1,
      reason: REASON,
      directedVersions: [],
    });
    recordRunningTicketSet(context, mapId);

    // v2's review is told what the rejection asked for.
    const review = runningSpecRun(context, mapId, "tickets_review");
    expect(reviewTicketSetRequest(context.db, review, BASE).directedVersions).toEqual([rejected]);

    // v2 fails revise-only: the repair has no reason of its own but still carries the rejection.
    fail(mapId, [TICKETS_REVISE_FINDING]);
    const repair = runningSpecRun(context, mapId, "to_tickets");
    expect(draftTicketSetRequest(context.db, repair, BASE).rewrite).toEqual({
      version: 2,
      content: readSetVersion(context.db, ticketSetId, 2).content,
      findings: [TICKETS_REVISE_FINDING],
      reason: null,
      directedVersions: [rejected],
    });

    // v3, the repair's, is no directed version, but its review still carries v2's rejection.
    recordRunningTicketSet(context, mapId);
    const again = runningSpecRun(context, mapId, "tickets_review");
    expect(reviewTicketSetRequest(context.db, again, BASE)).toMatchObject({
      ticketSet: { version: 3 },
      directedVersions: [rejected],
    });
  });

  test("a running repair refuses approve and reject review_in_flight, so its set cannot be approved or rejected meanwhile (S7c-10)", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    fail(mapId, [TICKETS_REVISE_FINDING]);

    expectDecisionsRefused(ticketSetId, "review_in_flight");
  });
});

describe("escalation and the derived hold (S7c-5, L30)", () => {
  test("v1 fails, v2 (repair) fails, v3 (repair) fails: v3's review escalates every finding, v2's does not", async () => {
    const { mapId, specificationId, ticketSetId } = await draftedTicketSet(context, project);

    fail(mapId, [TICKETS_REVISE_FINDING]);
    recordRunningTicketSet(context, mapId);
    fail(mapId, [TICKETS_REVISE_FINDING]);
    expect(escalatedOf(ticketSetId, 2)).toEqual([false]);
    expect(isRunning(mapId, "to_tickets")).toBe(true);
    recordRunningTicketSet(context, mapId);
    fail(mapId, [TICKETS_REVISE_FINDING, SECOND_REVISE]);

    expect(escalatedOf(ticketSetId, 1)).toEqual([false]);
    expect(escalatedOf(ticketSetId, 3)).toEqual([true, true]);
    expect(isRunning(mapId, "to_tickets")).toBe(false);
    expect(specRunsOf(mapId, "to_tickets")).toHaveLength(3);
    expect(toTicketsDue(context.db, mapId, specificationId)).toBe(false);
  });

  test("a held set reads held through the review read with no state change; approve and reject are refused ticket_set_review_not_passed", async () => {
    const { mapId, ticketSetId } = await heldTicketSet(context, project);

    expect(setOf(ticketSetId)).toMatchObject({ version: 3, state: "review_failed" });
    expect(await heldOf(mapId)).toBe(true);
    expect((await overview(mapId)).specs[0]?.stages[1]?.tone).toBe("needs-you");
    expectDecisionsRefused(ticketSetId, "ticket_set_review_not_passed");
    expect(setOf(ticketSetId)).toMatchObject({ version: 3, state: "review_failed" });
  });

  test("a decision finding on v1 escalates that finding only and starts no repair", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);

    fail(mapId, [TICKETS_REVISE_FINDING, TICKETS_DECISION_FINDING]);

    expect(escalatedOf(ticketSetId, 1)).toEqual([false, true]);
    expect(specRunsOf(mapId, "to_tickets")).toHaveLength(1);
    expect(isRunning(mapId, "to_tickets")).toBe(false);
    expect(await heldOf(mapId)).toBe(true);
  });

  test("a decision finding on a repair's version escalates the decision only, whatever the count", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    fail(mapId, [TICKETS_REVISE_FINDING]);
    recordRunningTicketSet(context, mapId);

    fail(mapId, [TICKETS_DECISION_FINDING, TICKETS_REVISE_FINDING]);

    expect(escalatedOf(ticketSetId, 2)).toEqual([true, false]);
    expect(isRunning(mapId, "to_tickets")).toBe(false);
  });

  test("a rejection rewrite restarts the count: its version's failure starts a repair, not a hold", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    fail(mapId, [TICKETS_REVISE_FINDING]);
    recordRunningTicketSet(context, mapId);
    recordRunningTicketsReview(context, mapId);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }).ok).toBe(
      true,
    );
    recordRunningTicketSet(context, mapId);

    fail(mapId, [TICKETS_REVISE_FINDING]);
    expect(escalatedOf(ticketSetId, 3)).toEqual([false]);
    expect(isRunning(mapId, "to_tickets")).toBe(true);
    recordRunningTicketSet(context, mapId);
    fail(mapId, [TICKETS_REVISE_FINDING]);
    expect(escalatedOf(ticketSetId, 4)).toEqual([false]);
    expect(isRunning(mapId, "to_tickets")).toBe(true);
    recordRunningTicketSet(context, mapId);
    fail(mapId, [TICKETS_REVISE_FINDING]);

    expect(escalatedOf(ticketSetId, 5)).toEqual([true]);
    expect(await heldOf(mapId)).toBe(true);
  });
});

describe("a stopped repair (S7c-9, S7c-10)", () => {
  test("keeps Try again, refuses approval review_in_flight, and the fresh repair carries the findings", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    fail(mapId, FAILED_TICKETS_REVIEW.findings);
    failRun(context.user, context.db, runningSpecRun(context, mapId, "to_tickets").id, FAILURE);
    const retry = runningSpecRun(context, mapId, "to_tickets");
    failRun(context.user, context.db, retry.id, FAILURE);

    const shown = await overview(mapId);
    expect(shown.specs[0]?.stages[1]?.tone).toBe("needs-you");
    expect(shown.specs[0]?.draftingTickets).toMatchObject({ stopped: { runId: retry.id } });
    expect(shown.status.next.find((action) => action.stage === "tickets")?.stopped?.runId).toBe(
      retry.id,
    );
    expectDecisionsRefused(ticketSetId, "review_in_flight");

    expect(tryAgain(context.user, context.db, retry.id)).toEqual({ ok: true, value: mapId });
    const fresh = runningSpecRun(context, mapId, "to_tickets");
    expect(fresh.hatchMessageId).toBeNull();
    expect(draftTicketSetRequest(context.db, fresh, BASE).rewrite).toMatchObject({
      version: 1,
      findings: FAILED_TICKETS_REVIEW.findings,
      reason: null,
    });
  });
});
