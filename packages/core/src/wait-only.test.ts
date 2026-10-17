/**
 * Slice 8b ticket 11: a map whose To Spec named only waits (a wait-only map, L206 (1), (2)) reads
 * its overview, status, Inbox, activity and notes without throwing, as the demo's waiting map.
 */
import { readMapRounds } from "./run-work.ts";
import { MapOverviewDetail } from "@zenorm/contracts";
import type { PlanningRun, Project } from "@zenorm/contracts";
import { planningRuns } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import { hatchRequest } from "./hatch-runs.ts";
import { getMapOverview, listMapOverviews } from "./map-overview.ts";
import type { SpecRunBase } from "./spec-requests.ts";
import { recordSpecs } from "./spec-runs.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  deliverableTicketSet,
  holdByRevision,
  insertSpec,
  insertWait,
  openTestContext,
  runningMapRun,
  runsOf,
  SPEC,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };
const BASE: SpecRunBase = {
  projectName: "repo",
  projectFolder: "/tmp/repo",
  baseBranch: "main",
  idea: "Export data",
};

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-wait-only-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/**
 * S8b-03's repro: spec 1 approved and delivered-ready on a first map, a holder map's unapproved
 * revision r2 of it, and a waiting map whose To Spec named only a wait on spec 1.
 */
async function waitOnlyMap() {
  const first = await deliverableTicketSet(context, project);
  const holder = await clearedMap(context, project);
  holdByRevision(context, {
    specificationId: first.specificationId,
    mapId: holder,
    content: {
      ...SPEC,
      title: "Held",
      clauses: SPEC.clauses.map((clause) => ({ ...clause, sources: [] })),
    },
    review: "passed",
  });
  const waiting = await clearedMap(context, project);
  const recorded = recordSpecs(context.user, context.db, runningMapRun(context, waiting).id, {
    specs: [],
    waits: [{ specNumber: 1, note: "Trim the ends." }],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  return { holder, waiting };
}

async function overviewOf(mapId: string) {
  const read = await getMapOverview(context.db, mapId, RUNNERS);
  if (!read.ok) throw new Error(read.error.code);
  return read.value;
}

describe("a wait-only map (L206 (2), S8b-16)", () => {
  test("its status waits on the holder: Spec idle, later stages, one another-map action, quiet", async () => {
    const { holder, waiting } = await waitOnlyMap();

    const { status, specs, waits } = await overviewOf(waiting);

    expect(specs).toEqual([]);
    expect(waits).toMatchObject([{ specNumber: 1, released: false, hold: { mapId: holder } }]);
    expect(status.stages.map(({ stage, tone }) => [stage, tone])).toEqual([
      ["idea", "done"],
      ["wayfinding", "done"],
      ["spec", "idle"],
      ["tickets", "later"],
      ["delivery", "later"],
    ]);
    expect(status.next).toMatchObject([
      { who: "another-map", label: null, onMap: holder, spec: 1, stage: "spec" },
    ]);
    expect(status.group).toBe("quiet");
  });

  test("its wait carries the spec's latest revision, on the holder, for its Spec page (E-1)", async () => {
    const { holder, waiting } = await waitOnlyMap();

    const { waits } = await overviewOf(waiting);

    expect(waits).toMatchObject([
      {
        specNumber: 1,
        latest: { revision: 2, state: "draft", mapId: holder, content: { title: "Held" } },
      },
    ]);
    expect(MapOverviewDetail.parse(await overviewOf(waiting)).waits).toHaveLength(1);
  });

  test("the Inbox lists it quiet", async () => {
    const { waiting } = await waitOnlyMap();

    const row = (await listMapOverviews(context.db, RUNNERS)).find(
      (overview) => overview.map.id === waiting,
    );

    expect(row?.status.group).toBe("quiet");
    expect(row?.status.next.map((action) => action.who)).toEqual(["another-map"]);
  });

  test("its activity has the wait line and no nothing-to-change line (the demo's waiting map)", async () => {
    const { waiting } = await waitOnlyMap();

    const { activity } = await overviewOf(waiting);

    // The clear, then the wait: the run that named only a wait checked no spec (S7b-8's line).
    expect(
      activity
        .filter((line) => line.stage === "spec")
        .map(({ spec, specLabel }) => ({ spec, specLabel })),
    ).toEqual([
      { spec: null, specLabel: null },
      { spec: 1, specLabel: "See what waits" },
    ]);
  });

  test("a note with no spec is accepted and its hatch request builds (S7b-2)", async () => {
    const { waiting } = await waitOnlyMap();

    const sent = await sendHatchMessage(
      context.user,
      context.db,
      { mapId: waiting, stage: "spec", specNumber: null, text: "Trim the start too." },
      RUNNERS,
    );

    expect(sent.ok).toBe(true);
    const hatch = runsOf(context, waiting).find(
      (run) => run.purpose === "hatch" && run.state === "running",
    );
    if (hatch === undefined) throw new Error("No hatch run started");
    expect(
      hatchRequest(context.db, hatch, BASE, readMapRounds(context.db, hatch.mapId)),
    ).toMatchObject({
      specs: [],
      message: { stage: "spec", specNumber: null },
    });
  });

  test("a note naming the spec it waits on is refused spec_waiting, and writes nothing (L213 D-8)", async () => {
    const { waiting } = await waitOnlyMap();
    insertSpec(context, project.id, 2);

    for (const stage of ["spec", "tickets"] as const) {
      const sent = await sendHatchMessage(
        context.user,
        context.db,
        { mapId: waiting, stage, specNumber: 1, text: "Trim the start too." },
        RUNNERS,
      );
      expect(sent.ok ? null : sent.error.code).toBe("spec_waiting");
    }
    // A spec it neither wrote nor waits on is still spec_not_found.
    const other = await sendHatchMessage(
      context.user,
      context.db,
      { mapId: waiting, stage: "spec", specNumber: 2, text: "Trim the start too." },
      RUNNERS,
    );
    expect(other.ok ? null : other.error.code).toBe("spec_not_found");
    expect((await overviewOf(waiting)).messages).toEqual([]);
  });
});

/** Ends a run `completed` directly, as its recording would. */
function complete(run: PlanningRun): void {
  writeTestData(context, (tx) =>
    tx
      .update(planningRuns)
      .set({ state: "completed", endedAt: new Date().toISOString() })
      .where(eq(planningRuns.id, run.id))
      .run(),
  );
}

test("L209 guard (L175 (3)): an open wait nothing holds, on a cleared map with no spec and its to_spec idle, throws", async () => {
  // Unreachable once S8b-6 releases such a wait in the transaction that ends its hold.
  const first = await deliverableTicketSet(context, project);
  const waiting = await clearedMap(context, project);
  complete(runningMapRun(context, waiting));
  insertWait(context, {
    mapId: waiting,
    specificationId: first.specificationId,
    note: "Trim the ends.",
    hatchMessageId: null,
    hold: { kind: "revision", mapId: first.mapId, revision: 1 },
    released: null,
  });

  await expect(getMapOverview(context.db, waiting, RUNNERS)).rejects.toThrow(/no held wait/);
});
