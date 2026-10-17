import type { MapOverviewDetail, Project } from "@zenorm/contracts";
import { MapOverviewDetail as MapOverviewDetailSchema, ProjectDetail } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { approveSpecRevision, approveTicketSet } from "./planning.ts";
import { getProjectDetail } from "./spec-views.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  draftedSpec,
  draftedTicketSet,
  recordRunningTicketsReview,
  openTestContext,
  REVISE_FINDING,
  reviewedSpec,
  SPEC,
  TICKETS,
  REQUIRED_CHECKS,
  saveChecks,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-spec-views-");
  project = await saveChecks(context, await addProject(context, "repo"), REQUIRED_CHECKS);
});

afterEach(async () => {
  await closeTestContext(context);
});

async function overview(mapId: string): Promise<MapOverviewDetail> {
  const result = await getMapOverview(context.db, mapId, RUNNERS);
  if (!result.ok) throw new Error(result.error.code);
  // The read always satisfies the contract it is served under.
  return MapOverviewDetailSchema.parse(result.value);
}

describe("map.overview specs[]", () => {
  test("no spec while To Spec runs", async () => {
    const mapId = await clearedMap(context, project);
    expect((await overview(mapId)).specs).toEqual([]);
  });

  test("a draft whose review runs: revision 1 with its content, the review running", async () => {
    const { mapId, specRevisionId } = await draftedSpec(context, project);
    const { specs, status } = await overview(mapId);
    expect(specs).toMatchObject([
      {
        number: 1,
        title: SPEC.title,
        revisions: [
          {
            id: specRevisionId,
            revision: 1,
            mapId,
            state: "draft",
            content: SPEC,
            review: { state: "running" },
          },
        ],
        ticketSets: [],
        draftingTickets: null,
      },
    ]);
    expect(specs[0]?.stages[0]).toEqual({
      stage: "spec",
      tone: "working",
      line: "Planning review running",
    });
    expect(status.next.find((action) => action.stage === "spec")?.spec).toBe(1);
  });

  test("a passed review awaits approval; a failed one shows its findings", async () => {
    const passed = await reviewedSpec(context, project);
    const { specs } = await overview(passed.mapId);
    expect(specs[0]?.revisions[0]?.review).toMatchObject({ state: "passed" });
    expect(specs[0]?.stages[0]).toMatchObject({
      tone: "needs-you",
      line: "Awaiting your approval",
    });

    const failed = await reviewedSpec(context, project, [REVISE_FINDING]);
    const failedSpecs = (await overview(failed.mapId)).specs;
    expect(failedSpecs[0]?.number).toBe(2);
    expect(failedSpecs[0]?.revisions[0]?.review).toMatchObject({
      state: "findings",
      findings: [{ ...REVISE_FINDING, escalated: false, waypoint: null }],
    });
  });

  test("approval: to_tickets running, then the set awaiting approval, then approved", async () => {
    const { mapId, specRevisionId } = await reviewedSpec(context, project);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId }).ok).toBe(true);
    const writing = (await overview(mapId)).specs[0];
    expect(writing?.draftingTickets).toBe("running");
    expect(writing?.stages[1]).toMatchObject({ tone: "working", line: "Agent is writing tickets" });
  });

  test("a written set awaits approval, then is approved", async () => {
    const set = await draftedTicketSet(context, project);
    const reviewing = (await overview(set.mapId)).specs[0];
    expect(reviewing?.ticketSets).toMatchObject([
      { id: set.ticketSetId, revision: 1, state: "awaiting_review", version: 1, content: TICKETS },
    ]);
    expect(reviewing?.ticketSets[0]?.review).toEqual({ state: "running" });
    expect(reviewing?.stages[1]).toMatchObject({
      tone: "working",
      line: "2 tickets · tickets review running",
    });
    recordRunningTicketsReview(context, set.mapId);
    const awaiting = (await overview(set.mapId)).specs[0];
    expect(awaiting?.ticketSets[0]?.state).toBe("review_passed");
    expect(awaiting?.stages[1]).toMatchObject({ line: "2 tickets · awaiting approval" });
    expect(approveTicketSet(context.user, context.db, { ticketSetId: set.ticketSetId }).ok).toBe(
      true,
    );
    const approved = (await overview(set.mapId)).specs[0];
    expect(approved?.stages[1]).toMatchObject({ tone: "done", line: "2 tickets · approved" });
    expect(approved?.stages[2]).toMatchObject({ tone: "needs-you" });
  });
});

describe("project.get specs", () => {
  test("lists each project spec once with its latest state and writing map", async () => {
    const first = await reviewedSpec(context, project);
    expect(
      approveSpecRevision(context.user, context.db, { specRevisionId: first.specRevisionId }).ok,
    ).toBe(true);
    const second = await draftedSpec(context, project);
    const result = await getProjectDetail(context.db, project.id);
    if (!result.ok) throw new Error(result.error.code);
    const detail = ProjectDetail.parse(result.value);
    expect(detail.specs).toMatchObject([
      {
        number: 1,
        title: SPEC.title,
        revisions: [{ revision: 1, state: "approved", mapId: first.mapId }],
        activeRun: null,
        mergedRun: null,
      },
      {
        number: 2,
        title: SPEC.title,
        revisions: [{ revision: 1, state: "draft", mapId: second.mapId }],
        activeRun: null,
        mergedRun: null,
      },
    ]);
  });
});
