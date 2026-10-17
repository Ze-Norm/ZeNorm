import { MapOverviewDetail } from "@zenorm/contracts";
import type { MapSpec, Project, StageTone } from "@zenorm/contracts";
import { execFileSync } from "node:child_process";

import {
  consistencyFindings,
  deliveryRunEvents,
  consistencyPasses,
  mapExclusions,
  mapFog,
  planningRuns,
  researchReports,
  researchSources,
  taskOutcomes,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WAIT_LINES } from "./map-activity.ts";
import { markMerged } from "./mark-merged.ts";
import { defaultSpec, getMapOverview, listMapOverviews } from "./map-overview.ts";
import {
  SPEC,
  addProject,
  chartedMap,
  clearedMap,
  closeTestContext,
  reviewedTicketSet,
  insertReview,
  insertRevision,
  insertRun,
  insertSpec,
  insertTicketSet,
  newMap,
  openTestContext,
  propose,
  resolve,
  runningMapRun,
  waypointOf,
  REQUIRED_CHECKS,
  appendLine,
  commitOnRunBranch,
  deliverableTicketSet,
  endRun,
  markTicketStarted,
  saveChecks,
  startedRun,
  TICKETS,
  TICKETS_REVISE_FINDING,
  deliveredSpec,
  holdByDelivery,
  holdByTickets,
  insertNextRevision,
  insertReleasedWait,
  insertTicketSetWith,
  insertWait,
  replacedTicketSet,
  writeTestData,
} from "./test-support.ts";
import type { DeliveredSpec, TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };

let context: TestContext;
let project: Project;
let mapId: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-map-overview-");
  project = await saveChecks(context, await addProject(context, "repo"), REQUIRED_CHECKS);
  mapId = await newMap(context, project, "Export data");
});

afterEach(async () => {
  await closeTestContext(context);
});

// The overviews await the project's filesystem and git checks; a chart that completes during
// that await must land wholly inside or wholly outside the snapshot.
describe("the overview is one snapshot", () => {
  test("map.overviews: a first chart completing during the project checks is read whole", async () => {
    const pending = listMapOverviews(context.db, RUNNERS);
    propose(context, mapId);
    const overviews = await pending;
    expect(overviews).toHaveLength(1);
    expect(overviews[0]?.map.title).not.toBeNull();
    expect(overviews[0]?.status.stages[0]).toMatchObject({ stage: "idea", tone: "done" });
  });

  test("map.overview: a first chart completing during the project check is read whole", async () => {
    const pending = getMapOverview(context.db, mapId, RUNNERS);
    propose(context, mapId);
    const result = await pending;
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.map.title).not.toBeNull();
    expect(result.value.status.stages[0]).toMatchObject({ stage: "idea", tone: "done" });
  });
});

describe("the snapshot reads the Wayfinding records", () => {
  const at = "2026-10-08T12:00:00.000Z";

  /** A completed run of `purpose`, on `waypointId` or the map. */
  function completedRun(
    charted: string,
    purpose: "research" | "task" | "consistency",
    waypointId: string | null,
  ): string {
    const id = uuidv7();
    writeTestData(context, (tx) =>
      tx
        .insert(planningRuns)
        .values({
          userId: context.user.userId,
          id,
          mapId: charted,
          waypointId,
          purpose,
          state: "completed",
          retryOfRunId: null,
          errorCode: null,
          errorMessage: null,
          startedAt: at,
          endedAt: at,
        })
        .run(),
    );
    return id;
  }

  test("fog, Out of scope lines, reports with sources, task outcomes, findings and exclusions", async () => {
    const charted = await chartedMap(context, project);
    resolve(context, charted, 1);
    const [one, two, three] = [1, 2, 3].map((number) => waypointOf(context, charted, number));
    if (one === undefined || two === undefined || three === undefined) {
      throw new Error("The chart made fewer than three waypoints");
    }
    const chartRunId = one.createdByRun;
    for (const [position, text] of [
      [2, "Whether the export is scheduled."],
      [1, "Who may export."],
    ] as const) {
      writeTestData(context, (tx) =>
        tx
          .insert(mapFog)
          .values({ mapId: charted, position, text, createdByRun: chartRunId })
          .run(),
      );
    }
    writeTestData(context, (tx) =>
      tx
        .insert(mapExclusions)
        .values([
          {
            mapId: charted,
            position: 2,
            text: "Not this map.",
            waypointId: three.id,
            createdByRun: chartRunId,
          },
          {
            mapId: charted,
            position: 1,
            text: "Imports.",
            waypointId: null,
            createdByRun: chartRunId,
          },
        ])
        .run(),
    );
    const unanswered = completedRun(charted, "research", two.id);
    const answered = completedRun(charted, "research", two.id);
    const report = {
      waypointId: two.id,
      summary: "What the docs say.",
      findings: [],
      limitations: ["Only the docs."],
      uncertainties: [],
    };
    writeTestData(context, (tx) =>
      tx
        .insert(researchReports)
        .values([
          {
            ...report,
            runId: answered,
            answered: true,
            gap: null,
            findings: [{ title: "UTF-8", detail: "Docs say UTF-8.", sources: [1] }],
          },
          { ...report, runId: unanswered, answered: false, gap: "Whether BOMs are written." },
        ])
        .run(),
    );
    writeTestData(context, (tx) =>
      tx
        .insert(researchSources)
        .values([
          {
            reportRunId: answered,
            position: 2,
            kind: "repository_file",
            title: "README",
            url: null,
            excerpt: "Second.",
          },
          {
            reportRunId: answered,
            position: 1,
            kind: "external",
            title: "Docs",
            url: "https://example.com/docs",
            excerpt: "First.",
          },
        ])
        .run(),
    );
    const taskRunId = completedRun(charted, "task", three.id);
    writeTestData(context, (tx) =>
      tx
        .insert(taskOutcomes)
        .values({
          runId: taskRunId,
          waypointId: three.id,
          outcome: "failed",
          action: "Read the config.",
          facts: "It is absent.",
        })
        .run(),
    );
    const passRunId = completedRun(charted, "consistency", null);
    const passId = uuidv7();
    writeTestData(context, (tx) =>
      tx
        .insert(consistencyPasses)
        .values({
          id: passId,
          mapId: charted,
          runId: passRunId,
          compared: [{ waypointId: one.id, resolvedAt: at }],
        })
        .run(),
    );
    writeTestData(context, (tx) =>
      tx
        .insert(consistencyFindings)
        .values({
          createdWaypointId: two.id,
          passId,
          kind: "undefined_term",
          waypointNumbers: [1],
          title: two.title,
          explanation: "Waypoint 1 says “record” without defining it.",
          question: two.question,
        })
        .run(),
    );

    const result = await getMapOverview(context.db, charted, RUNNERS);
    if (!result.ok) throw new Error(result.error.code);
    const { wayfinding } = result.value;
    expect(wayfinding.fog).toEqual([
      { position: 1, text: "Who may export." },
      { position: 2, text: "Whether the export is scheduled." },
    ]);
    expect(wayfinding.outOfScope).toEqual([
      { text: "Imports.", waypoint: null, splitMapId: null },
      { text: "Not this map.", waypoint: 3, splitMapId: null },
    ]);
    const [first, second, third] = wayfinding.waypoints;
    expect(first).toMatchObject({ reports: [], taskOutcomes: [], finding: null, exclusion: null });
    expect(second?.reports).toEqual([
      {
        runId: unanswered,
        answered: false,
        summary: "What the docs say.",
        gap: "Whether BOMs are written.",
        findings: [],
        sources: [],
        limitations: ["Only the docs."],
        uncertainties: [],
      },
      {
        runId: answered,
        answered: true,
        summary: "What the docs say.",
        gap: null,
        findings: [{ title: "UTF-8", detail: "Docs say UTF-8.", sources: [1] }],
        sources: [
          { kind: "external", title: "Docs", url: "https://example.com/docs", excerpt: "First." },
          { kind: "repository_file", title: "README", url: null, excerpt: "Second." },
        ],
        limitations: ["Only the docs."],
        uncertainties: [],
      },
    ]);
    expect(second?.finding).toEqual({
      kind: "undefined_term",
      waypointNumbers: [1],
      explanation: "Waypoint 1 says “record” without defining it.",
    });
    expect(second).toMatchObject({ taskOutcomes: [], exclusion: null });
    expect(third).toMatchObject({
      reports: [],
      taskOutcomes: [
        { runId: taskRunId, outcome: "failed", action: "Read the config.", facts: "It is absent." },
      ],
      finding: null,
      exclusion: "Not this map.",
    });
  });
});

describe("map.overview reads each spec's stages and next actions from stored rows", () => {
  test("two specs: one approved with its set approved, one a draft whose review passed", async () => {
    const cleared = await clearedMap(context, project);
    const drafting = runningMapRun(context, cleared);
    writeTestData(context, (tx) =>
      tx
        .update(planningRuns)
        .set({ state: "completed", endedAt: new Date().toISOString() })
        .where(eq(planningRuns.id, drafting.id))
        .run(),
    );
    const at = new Date().toISOString();
    const written = (number: number, title: string, approvedAt: string | null) => {
      const specificationId = insertSpec(context, project.id, number);
      const specRevisionId = insertRevision(context, {
        specificationId,
        revision: 1,
        mapId: cleared,
        writtenByRun: drafting.id,
        content: { ...SPEC, title },
        approvedAt,
      });
      const review = insertRun(context, {
        mapId: cleared,
        specificationId,
        purpose: "spec_review",
        state: "completed",
      });
      insertReview(context, { specRevisionId, runId: review.id, findings: [] });
      return { specificationId, specRevisionId };
    };
    const first = written(1, "Export as CSV", at);
    const tickets = insertRun(context, {
      mapId: cleared,
      specificationId: first.specificationId,
      purpose: "to_tickets",
      state: "completed",
    });
    insertTicketSet(context, {
      specRevisionId: first.specRevisionId,
      runId: tickets.id,
      version: 1,
      state: "approved",
      rejected: [],
    });
    written(2, "Export as JSON", null);

    const result = await getMapOverview(context.db, cleared, RUNNERS);
    if (!result.ok) throw new Error(result.error.code);
    const { specs, status, activity } = result.value;
    expect(specs.map((spec) => [spec.number, spec.stages.map((stage) => stage.tone)])).toEqual([
      [1, ["done", "done", "needs-you"]],
      [2, ["needs-you", "later", "later"]],
    ]);
    expect(status.next.map((action) => [action.who, action.stage, action.spec])).toEqual([
      ["you", "spec", 2],
      ["you", "delivery", 1],
    ]);
    expect(status.stages.map((stage) => stage.tone)).toEqual([
      "done",
      "done",
      "needs-you",
      "idle",
      "needs-you",
    ]);
    // Each spec's written, reviewed and approved lines name it.
    for (const title of ["Export as CSV", "Export as JSON"]) {
      expect(
        activity.filter((line) => line.stage === "spec" && line.text.includes(title)).length,
      ).toBeGreaterThanOrEqual(2);
    }
    expect(
      activity.filter((line) => line.stage === "tickets").map((line) => line.waypoint),
    ).toEqual([null, null]);
  });
});

describe("map.overview's default spec on each spec stage", () => {
  /** A spec numbered `number` with the given tone on Spec, Tickets and Delivery. */
  function specWith(number: number, tones: readonly [StageTone, StageTone, StageTone]): MapSpec {
    return {
      id: uuidv7(),
      number,
      title: `Spec ${String(number)}`,
      revisions: [],
      ticketSets: [],
      revisedLater: [],
      draftingTickets: null,
      runs: [],
      stages: [
        { stage: "spec", tone: tones[0], line: "A line" },
        { stage: "tickets", tone: tones[1], line: "A line" },
        { stage: "delivery", tone: tones[2], line: "A line" },
      ],
    };
  }

  test("the first spec needing you there, else the first being worked, else the first", () => {
    const specs = [
      specWith(1, ["done", "done", "idle"]),
      specWith(2, ["working", "needs-you", "later"]),
      specWith(3, ["needs-you", "working", "later"]),
      specWith(4, ["working", "working", "working"]),
    ];

    expect(defaultSpec(specs, "spec")).toBe(3);
    expect(defaultSpec(specs, "tickets")).toBe(2);
    expect(defaultSpec(specs, "delivery")).toBe(4);
    expect(defaultSpec(specs.slice(0, 1), "delivery")).toBe(1);
    expect(defaultSpec([], "spec")).toBeNull();
  });

  test("null on every stage while the map has no spec", async () => {
    const mapId = await clearedMap(context, project);

    const overview = await getMapOverview(context.db, mapId, RUNNERS);

    expect(overview.ok ? overview.value.defaultSpecs : null).toEqual({
      spec: null,
      tickets: null,
      delivery: null,
    });
  });

  test("each stage's default from the specs' derived stages", async () => {
    const { mapId } = await reviewedTicketSet(context, project);

    const overview = await getMapOverview(context.db, mapId, RUNNERS);
    if (!overview.ok) throw new Error(overview.error.code);

    expect(overview.value.defaultSpecs).toEqual({ spec: 1, tickets: 1, delivery: 1 });
  });
});

describe("map.overview Delivery from stored runs", () => {
  async function overview(id: string, held: boolean) {
    const result = await getMapOverview(context.db, id, { deliveryHeld: () => held });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  test("a passed run awaits Mark merged under Needs you; merged, its stage is done and the map quiet", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const finalCommit = await commitOnRunBranch(context, run);
    await endRun(context, run.id, { outcome: "passed", finalCommit });

    const passed = await overview(set.mapId, false);
    expect(passed.status.group).toBe("needs-you");
    expect(passed.status.next).toMatchObject([
      { who: "you", stage: "delivery", label: "Mark merged", spec: 1 },
    ]);
    expect(passed.specs[0]?.stages[2].tone).toBe("needs-you");
    const listed = (await listMapOverviews(context.db, RUNNERS)).find(
      (item) => item.map.id === set.mapId,
    );
    expect(listed?.status.group).toBe("needs-you");
    // The passed line opens the run on the spec's Delivery page.
    expect(passed.activity.filter((line) => line.stage === "delivery")).toMatchObject([
      { spec: null },
      { spec: 1 },
    ]);

    execFileSync(
      "git",
      ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", "merge", "-q", "--no-ff"].concat([
        "-m",
        "Merge the run",
        run.branch,
      ]),
      { cwd: project.folderPath, stdio: "ignore" },
    );
    const merged = await markMerged(context.user, context.db, run.id);
    expect(merged.ok).toBe(true);

    const done = await overview(set.mapId, false);
    expect(done.status.group).toBe("quiet");
    expect(done.status.stages[4].tone).toBe("done");
    expect(done.status.next).toMatchObject([
      { who: "nobody", stage: "delivery", label: null, detail: null },
    ]);
    expect(done.specs[0]?.stages[2].tone).toBe("done");
    const lines = done.activity.filter((line) => line.stage === "delivery");
    expect(lines).toHaveLength(3);
    const times = lines.map((line) => Date.parse(line.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("deleting a run's lines changes no stage, next action or ticket status", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    markTicketStarted(context, run.id, "T1");
    appendLine(context, run.id, { who: "implementer", ticket: "T1", text: "Edited `src/a.ts`" });
    appendLine(context, run.id, { who: "orchestrator", ticket: null, text: "Working." });

    const shape = (detail: Awaited<ReturnType<typeof overview>>) => ({
      status: detail.status,
      stages: detail.specs.map((spec) => spec.stages),
      tickets: detail.specs.map((spec) =>
        spec.runs.map((one) => one.tickets?.map((ticket) => [ticket.ticket, ticket.status.state])),
      ),
    });
    const before = await overview(set.mapId, true);
    expect(before.specs[0]?.runs[0]?.tickets?.[0]?.status).toMatchObject({
      state: "implementing",
      latest: { ticket: "T1" },
    });

    writeTestData(context, (tx) =>
      tx.delete(deliveryRunEvents).where(eq(deliveryRunEvents.runId, run.id)).run(),
    );
    const after = await overview(set.mapId, true);
    expect(shape(after)).toEqual(shape(before));
    expect(after.status.next).toMatchObject([{ who: "agent", stage: "delivery" }]);
    expect(after.specs[0]?.runs[0]?.tickets?.[0]?.status).toEqual({
      state: "implementing",
      latest: null,
    });
  });
});

describe("map.overview for revisions and waits", () => {
  let delivered: DeliveredSpec;

  beforeEach(async () => {
    delivered = await deliveredSpec(context, project);
  });

  async function overviewOf(
    map: string,
    runners: { deliveryHeld: (runId: string) => boolean } = RUNNERS,
  ): Promise<MapOverviewDetail> {
    const result = await getMapOverview(context.db, map, runners);
    if (!result.ok) throw new Error(result.error.code);
    return MapOverviewDetail.parse(result.value);
  }

  function nextOf(detail: MapOverviewDetail): string[] {
    return detail.status.next.map(
      (action) => `${action.who}:${action.stage}:${String(action.spec)}`,
    );
  }

  function specTones(detail: MapOverviewDetail): StageTone[] {
    const [only] = detail.specs;
    if (only === undefined) throw new Error("The map shows no spec");
    return only.stages.map((stage) => stage.tone);
  }

  test.each(["running", "stopped"] as const)(
    "a released wait's run %s on a spec the map has not written gives its action, no throw",
    async (run) => {
      const waiting = await clearedMap(context, project);
      const released = insertReleasedWait(context, {
        mapId: waiting,
        specificationId: delivered.specificationId,
        note: "Quote every row.",
        hatchMessageId: null,
        hold: { kind: "delivering", mapId: delivered.mapId, revision: 1 },
        run,
      });
      const detail = await overviewOf(waiting);
      expect(detail.specs).toEqual([]);
      const spec = detail.status.stages[2];
      if (run === "running") {
        expect(spec.tone).toBe("working");
        expect(nextOf(detail)).toContain("agent:spec:1");
      } else {
        expect(spec.tone).toBe("needs-you");
        expect(detail.status.next[0]).toMatchObject({
          who: "you",
          stage: "spec",
          spec: 1,
          label: "Try again",
          stopped: { runId: released.run.id },
        });
      }
    },
  );

  test.each(["awaiting_review", "review_passed"] as const)(
    "a replaced set (%s) reads idle on Tickets and Delivery, never yours",
    async (state) => {
      replacedTicketSet(context, {
        specificationId: delivered.specificationId,
        mapId: delivered.mapId,
        content: SPEC,
        nextContent: { ...SPEC, outOfScope: ["PDF files."] },
        state,
      });
      const detail = await overviewOf(delivered.mapId);
      expect(specTones(detail).slice(1)).toEqual(["idle", "idle"]);
      expect(detail.status.next.filter((action) => action.who === "you")).toEqual([]);
    },
  );

  test("guard: a failed, unheld tickets review with no repair throws", async () => {
    const next = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: SPEC,
      approved: true,
      set: null,
    });
    insertTicketSetWith(context, {
      mapId: delivered.mapId,
      specificationId: delivered.specificationId,
      specRevisionId: next.specRevisionId,
      content: TICKETS,
      state: "review_failed",
      review: [{ finding: TICKETS_REVISE_FINDING, escalated: false }],
    });
    await expect(getMapOverview(context.db, delivered.mapId, RUNNERS)).rejects.toThrow(
      /failed tickets review has no repair or hold/,
    );
  });

  test("a wait on this map's own active delivery run names this map as the holder", async () => {
    const { run } = await holdByDelivery(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: SPEC,
    });
    insertWait(context, {
      mapId: delivered.mapId,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "delivering", mapId: delivered.mapId, revision: 2 },
      released: null,
    });
    const detail = await overviewOf(delivered.mapId, {
      deliveryHeld: (runId) => runId === run.id,
    });
    const wait = detail.status.next.find((action) => action.who === "another-map");
    expect(wait).toMatchObject({ label: null, onMap: delivered.mapId, stage: "spec", spec: 1 });
  });

  test("with two approved revisions on the map, status reads the later one's set", async () => {
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: SPEC,
      approved: true,
      set: { state: "approved", content: TICKETS },
    });
    const detail = await overviewOf(delivered.mapId);
    // r1's merged run is not r2's: r2's set awaits Start delivery.
    expect(specTones(detail)).toEqual(["done", "done", "needs-you"]);
    expect(detail.status.next[0]).toMatchObject({ who: "you", label: "Start delivery" });
  });

  test("Delivery ignores a run pinned to another map's revision", async () => {
    const other = await chartedMap(context, project);
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: SPEC,
      approved: true,
      set: { state: "approved", content: TICKETS },
    });
    const detail = await overviewOf(other);
    expect(specTones(detail)[2]).toBe("needs-you");
    expect(detail.status.next).toContainEqual(
      expect.objectContaining({ who: "you", stage: "delivery", label: "Start delivery" }),
    );
  });

  test("the wait line follows the stored hold after the live hold has moved on", async () => {
    const waiting = await clearedMap(context, project);
    const holder = await chartedMap(context, project);
    holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: holder,
      content: SPEC,
      set: TICKETS,
      purpose: "tickets_review",
      state: "running",
    });
    insertWait(context, {
      mapId: waiting,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "revision", mapId: holder, revision: 2 },
      released: null,
    });
    const detail = await overviewOf(waiting);
    const [wait] = detail.waits;
    expect(wait?.hold?.kind).toBe("tickets");
    const holderTitle = (await overviewOf(holder)).map.title;
    if (wait === undefined || holderTitle === null) throw new Error("No wait or holder title");
    const lines = detail.activity.filter((line) => line.specLabel === "See what waits");
    expect(lines).toEqual([
      {
        stage: "spec",
        text: WAIT_LINES.revision(wait.specTitle, holderTitle),
        waypoint: null,
        spec: 1,
        specLabel: "See what waits",
        at: wait.since,
      },
    ]);
  });

  test("a released wait adds its release line, opening the revision", async () => {
    const waiting = await clearedMap(context, project);
    insertReleasedWait(context, {
      mapId: waiting,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "delivering", mapId: delivered.mapId, revision: 1 },
      run: "running",
    });
    const lines = (await overviewOf(waiting)).activity.filter((line) => line.spec === 1);
    expect(lines.map((line) => [line.stage, line.specLabel])).toEqual([
      ["spec", "See what waits"],
      ["spec", "Open the revision"],
    ]);
  });

  test("a later map's revisions of a delivered spec give one Spec revised line", async () => {
    const other = await chartedMap(context, project);
    for (const mapOf of [other, delivered.mapId, other]) {
      insertNextRevision(context, {
        specificationId: delivered.specificationId,
        mapId: mapOf,
        content: SPEC,
        approved: true,
        set: { state: "approved", content: TICKETS },
      });
    }
    const activity = (await overviewOf(other)).activity;
    expect(
      activity.filter((line) => line.specLabel === "See what the revision changes"),
    ).toHaveLength(1);
  });
});
