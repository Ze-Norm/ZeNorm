import type { Project } from "@zenorm/contracts";
import { RejectSpecInput, RejectTicketSetInput } from "@zenorm/contracts";
import { planningRuns, specifications, specReviews, specRevisions, ticketSets } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import {
  approveSpecRevision,
  approveTicketSet,
  rejectSpecRevision,
  rejectTicketSet,
} from "./planning.ts";
import { sweepInterruptedRuns } from "./planning-runs.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import { recordTicketSet } from "./ticket-set-runs.ts";
import { readMapRevisions, readSetVersion, readTicketSetOf } from "./specs.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  draftedSpec,
  draftedTicketSet,
  reviewedTicketSet,
  insertTicketSet,
  openTestContext,
  PASSED_REVIEW,
  REVISE_FINDING,
  reviewedSpec,
  reviewOf,
  runningMapRun,
  runningSpecRun,
  runsOf,
  SPEC,
  TICKETS,
  UNKNOWN_ID,
  writeTestData,
} from "./test-support.ts";
import type { TestContext, DraftContent } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-planning-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

function titled(title: string): DraftContent {
  return { ...SPEC, title };
}

function rowCounts() {
  return {
    specs: context.db.select().from(specifications).all().length,
    revisions: context.db.select().from(specRevisions).all().length,
  };
}

describe("map-scope to_spec (S7-4, S7-5)", () => {
  test("a cleared map's to_spec writes each spec at revision 1, numbered per project, in one go", async () => {
    const first = await draftedSpec(context, project);
    const mapId = await clearedMap(context, project);
    const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [
        { specNumber: null, content: titled("Second") },
        { specNumber: null, content: titled("Third") },
      ],
      waits: [],
    });
    expect(recorded.ok).toBe(true);
    const numbers = context.db
      .select({ id: specifications.id, number: specifications.number })
      .from(specifications)
      .all();
    expect(numbers.map((spec) => spec.number).sort()).toEqual([1, 2, 3]);
    const revisions = readMapRevisions(context.db, mapId);
    expect(revisions.map((revision) => [revision.revision, revision.content.title])).toEqual([
      [1, "Second"],
      [1, "Third"],
    ]);
    expect(revisions.every((revision) => revision.mapId === mapId)).toBe(true);
    expect(readMapRevisions(context.db, first.mapId)).toHaveLength(1);
    // Each draft gets its own spec-scoped review (S7-6).
    const reviews = runsOf(context, mapId).filter((run) => run.purpose === "spec_review");
    expect(reviews.map((run) => run.state)).toEqual(["running", "running"]);
    expect(new Set(reviews.map((run) => run.specificationId)).size).toBe(2);
  });

  const clause = SPEC.clauses[0];
  if (clause === undefined) throw new Error("SPEC has no clause");
  test.each<[string, DraftContent]>([
    [
      "a duplicate id",
      { ...SPEC, clauses: [clause, { ...clause, criteria: [{ id: "2.1", text: "x" }] }] },
    ],
    [
      "a criterion outside its clause",
      { ...SPEC, clauses: [{ ...clause, criteria: [{ id: "2.1", text: "x" }] }] },
    ],
    [
      "a source naming an unresolved waypoint",
      { ...SPEC, clauses: [{ ...clause, sources: [{ kind: "waypoint", number: 1 }] }] },
    ],
    ["a clause with no source", { ...SPEC, clauses: [{ ...clause, sources: [] }] }],
    [
      "a source naming a note while no revision is note-directed (S7b-11)",
      { ...SPEC, clauses: [{ ...clause, sources: [{ kind: "note" }] }] },
    ],
    [
      "a was on a first revision",
      { ...SPEC, clauses: [{ ...clause, criteria: [{ id: "1.1", text: "x", was: "1.2" }] }] },
    ],
    [
      "a clause relying on nothing and adding nothing (RC1)",
      { ...SPEC, clauses: [{ ...clause, reliesOn: [], adds: [] }] },
    ],
    [
      "a reliance neither FACTS nor the source has (RC1)",
      { ...SPEC, clauses: [{ ...clause, reliesOn: [{ name: "export_failed", path: null }] }] },
    ],
    [
      "a reliance in a file that is not the project's (RC1)",
      { ...SPEC, clauses: [{ ...clause, reliesOn: [{ name: "Repo", path: "src/missing.ts" }] }] },
    ],
    [
      "an addition FACTS already defines (RC1)",
      { ...SPEC, clauses: [{ ...clause, adds: ["Repo"] }] },
    ],
  ])("%s fails the run spec_content_invalid and writes nothing", async (_name, content) => {
    const mapId = await clearedMap(context, project);
    const run = runningMapRun(context, mapId);
    const recorded = recordSpecs(context.user, context.db, run.id, {
      specs: [
        { specNumber: null, content: SPEC },
        { specNumber: null, content },
      ],
      waits: [],
    });
    expect(recorded).toMatchObject({ ok: false, error: { code: "spec_content_invalid" } });
    expect(rowCounts()).toEqual({ specs: 0, revisions: 0 });
    expect(runsOf(context, mapId).find((candidate) => candidate.id === run.id)).toMatchObject({
      state: "failed",
      errorCode: "spec_content_invalid",
    });
  });
});

test("zero specs on a first clear fail the run spec_content_invalid and write nothing (S7b-8)", async () => {
  const mapId = await clearedMap(context, project);
  const run = runningMapRun(context, mapId);
  expect(recordSpecs(context.user, context.db, run.id, { specs: [], waits: [] })).toMatchObject({
    ok: false,
    error: { code: "spec_content_invalid" },
  });
  expect(rowCounts()).toEqual({ specs: 0, revisions: 0 });
  expect(runsOf(context, mapId).find((candidate) => candidate.id === run.id)).toMatchObject({
    state: "failed",
    errorCode: "spec_content_invalid",
  });
});

test("a wait fails the run spec_content_invalid and writes nothing until waits are recorded (S8b-5)", async () => {
  const mapId = await clearedMap(context, project);
  const run = runningMapRun(context, mapId);
  const outcome = {
    specs: [{ specNumber: null, content: SPEC }],
    waits: [{ specNumber: 1, note: "Trim the ends." }],
  };
  expect(recordSpecs(context.user, context.db, run.id, outcome)).toMatchObject({
    ok: false,
    error: { code: "spec_content_invalid" },
  });
  expect(rowCounts()).toEqual({ specs: 0, revisions: 0 });
  expect(runsOf(context, mapId).find((candidate) => candidate.id === run.id)).toMatchObject({
    state: "failed",
    errorCode: "spec_content_invalid",
  });
});

describe("spec_review (S7-6)", () => {
  test("a review with no finding passes, pinned to the revision", async () => {
    const { mapId, specRevisionId } = await reviewedSpec(context, project);
    const stored = reviewOf(context, specRevisionId);
    expect(stored?.review.passed).toBe(true);
    expect(stored?.findings).toEqual([]);
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
  });

  test("a review with a revise finding fails and starts the spec's repair (S7-7)", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project, [
      REVISE_FINDING,
    ]);
    const stored = reviewOf(context, specRevisionId);
    expect(stored?.review.passed).toBe(false);
    expect(stored?.findings.map((finding) => [finding.position, finding.escalated])).toEqual([
      [1, false],
    ]);
    expect(runningSpecRun(context, mapId, "to_spec").specificationId).toBe(specificationId);
  });

  test.each([
    ["an unknown element id", { ...REVISE_FINDING, elementIds: ["C9"] }],
    ["an unresolved waypoint number", { ...REVISE_FINDING, waypointNumbers: [4] }],
  ])("%s fails the run review_reference_unknown and saves no review", async (_name, finding) => {
    const { mapId } = await draftedSpec(context, project);
    const run = runningSpecRun(context, mapId, "spec_review");
    const recorded = recordSpecReview(context.user, context.db, run.id, {
      summary: PASSED_REVIEW.summary,
      findings: [finding],
      verified: [],
    });
    expect(recorded).toMatchObject({ ok: false, error: { code: "review_reference_unknown" } });
    expect(context.db.select().from(specReviews).all()).toEqual([]);
    // The failed first attempt gets its retry (S6a-12 for spec-scoped runs, S7-19).
    expect(runningSpecRun(context, mapId, "spec_review").retryOfRunId).toBe(run.id);
  });
});

describe("spec.approve (S7-11)", () => {
  test("spec_revision_not_found for an unknown revision", () => {
    expect(
      approveSpecRevision(context.user, context.db, { specRevisionId: UNKNOWN_ID }),
    ).toMatchObject({
      ok: false,
      error: { code: "spec_revision_not_found" },
    });
  });

  test("review_in_flight while the review runs", async () => {
    const { specRevisionId } = await draftedSpec(context, project);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toMatchObject({
      ok: false,
      error: { code: "review_in_flight", data: { specRevisionId } },
    });
  });

  test("spec_review_not_passed after a failed review", async () => {
    const { specRevisionId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toMatchObject({
      ok: false,
      error: { code: "spec_review_not_passed" },
    });
  });

  test("approval starts the spec's to_tickets; a second approval is spec_revision_decided", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toEqual({
      ok: true,
      value: mapId,
    });
    expect(runningSpecRun(context, mapId, "to_tickets").specificationId).toBe(specificationId);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toMatchObject({
      ok: false,
      error: { code: "spec_revision_decided" },
    });
  });

  test("map_uncleared while the map's to_spec runs", async () => {
    const { mapId, specRevisionId } = await reviewedSpec(context, project);
    // A map-scope to_spec running on the map (03's re-clear) refuses the decision.
    const second = await clearedMap(context, project);
    writeTestData(context, (tx) =>
      tx
        .update(specRevisions)
        .set({ mapId: second, writtenByRun: runningMapRun(context, second).id })
        .run(),
    );
    expect(approveSpecRevision(context.user, context.db, { specRevisionId })).toMatchObject({
      ok: false,
      error: { code: "map_uncleared" },
    });
    expect(mapId).not.toBe(second);
  });
});

describe("spec.reject (S7-12)", () => {
  test("supersedes the draft with the reason and starts the spec's repair", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
    const reason = RejectSpecInput.shape.reason.parse("  Split it.  ");
    expect(rejectSpecRevision(context.user, context.db, { specRevisionId, reason })).toEqual({
      ok: true,
      value: mapId,
    });
    const [revision] = readMapRevisions(context.db, mapId);
    expect(revision?.rejectionReason).toBe("Split it.");
    expect(revision?.supersededAt).not.toBeNull();
    expect(runningSpecRun(context, mapId, "to_spec").specificationId).toBe(specificationId);
    // The map's overview still reads.
    const overview = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    expect(overview.ok).toBe(true);
  });

  test("review_in_flight while the review runs", async () => {
    const { specRevisionId } = await draftedSpec(context, project);
    expect(
      rejectSpecRevision(context.user, context.db, { specRevisionId, reason: "No" }),
    ).toMatchObject({
      ok: false,
      error: { code: "review_in_flight" },
    });
  });
});

describe("to_tickets and ticketSet decisions (S7-13 shape, S7-17, S7-18)", () => {
  test("to_tickets writes version 1 awaiting review", async () => {
    const { ticketSetId } = await draftedTicketSet(context, project);
    const [set] = context.db.select().from(ticketSets).all();
    expect(set).toMatchObject({ id: ticketSetId, state: "awaiting_review", version: 1 });
    expect(readSetVersion(context.db, ticketSetId, 1).content).toEqual(TICKETS);
  });

  test("tickets not numbered from T1 are refused, writing nothing (S8b-12, replacing L137)", async () => {
    const { mapId, specRevisionId } = await reviewedSpec(context, project);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId }).ok).toBe(true);
    const run = runningSpecRun(context, mapId, "to_tickets");
    const ids = ["T9", "T4"];
    const renamed = (id: string): string => {
      const index = TICKETS.tickets.findIndex((ticket) => ticket.id === id);
      const to = ids[index];
      if (to === undefined) throw new Error(`No ticket ${id}`);
      return to;
    };
    const misnumbered = {
      ...TICKETS,
      tickets: TICKETS.tickets.map((ticket) => ({
        ...ticket,
        id: renamed(ticket.id),
        blockedBy: ticket.blockedBy.map((blocker) => ({
          ...blocker,
          ticket: renamed(blocker.ticket),
        })),
      })),
      dispositions: TICKETS.dispositions.map((disposition) =>
        disposition.kind === "work"
          ? { ...disposition, ticket: renamed(disposition.ticket) }
          : disposition,
      ),
    };
    expect(recordTicketSet(context.user, context.db, run.id, misnumbered)).toMatchObject({
      ok: false,
      error: { code: "ticket_set_content_invalid" },
    });
    expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
  });

  test("review_in_flight while to_tickets runs, after ticket_set_not_found", async () => {
    const { mapId, specRevisionId } = await reviewedSpec(context, project);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId }).ok).toBe(true);
    const run = runningSpecRun(context, mapId, "to_tickets");
    // A set whose spec's to_tickets still runs (04's rewrite) refuses both decisions.
    const ticketSetId = insertTicketSet(context, {
      specRevisionId,
      runId: run.id,
      version: 1,
      state: "awaiting_review",
      rejected: [],
    });
    for (const decided of [
      approveTicketSet(context.user, context.db, { ticketSetId }),
      rejectTicketSet(context.user, context.db, { ticketSetId, reason: "No" }),
    ]) {
      expect(decided).toMatchObject({
        ok: false,
        error: { code: "review_in_flight", data: { ticketSetId } },
      });
    }
  });

  test("approve from review_passed; then ticket_set_decided", async () => {
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toEqual({
      ok: true,
      value: mapId,
    });
    const [set] = context.db.select().from(ticketSets).all();
    expect(set?.state).toBe("approved");
    expect(set?.approvedAt).not.toBeNull();
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toMatchObject({
      ok: false,
      error: { code: "ticket_set_decided" },
    });
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: "No" })).toMatchObject({
      ok: false,
      error: { code: "ticket_set_decided" },
    });
  });

  test("ticket_set_not_found for an unknown set", () => {
    expect(approveTicketSet(context.user, context.db, { ticketSetId: UNKNOWN_ID })).toMatchObject({
      ok: false,
      error: { code: "ticket_set_not_found" },
    });
  });

  test("reject records the reason against the current version and starts the rewrite", async () => {
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    const reason = RejectTicketSetInput.shape.reason.parse("Split the exporter.");
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason })).toEqual({
      ok: true,
      value: mapId,
    });
    expect(runningSpecRun(context, mapId, "to_tickets").specificationId).toBe(specificationId);
    // The rejected version stays review_passed until its rewrite writes version 2 (L32).
    const [set] = context.db.select().from(ticketSets).all();
    expect(set).toMatchObject({ state: "review_passed", version: 1 });
  });
});

describe("Existing Records", () => {
  test("on startup a cleared map with no revision gets a running to_spec", async () => {
    const mapId = await clearedMap(context, project);
    const run = runningMapRun(context, mapId);
    // 0007 deleted the map's to_spec runs: the map is cleared with none.
    writeTestData(context, (tx) =>
      tx.delete(planningRuns).where(eq(planningRuns.id, run.id)).run(),
    );
    sweepInterruptedRuns(context.db);
    const started = runningMapRun(context, mapId);
    expect(started.purpose).toBe("to_spec");
    expect(started.specificationId).toBeNull();
  });
});
