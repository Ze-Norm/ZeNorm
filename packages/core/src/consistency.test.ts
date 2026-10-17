import type {
  ConsistencyFinding,
  ConsistencyOutcome,
  PlanningRun,
  Project,
} from "@zenorm/contracts";
import { consistencyFindings, consistencyPasses, mapFog } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import {
  CONSISTENCY_PASSES_MAX,
  consistencyDue,
  failRun,
  isCleared,
  passesExhausted,
  readWaypoints,
  recordConsistency,
  recordGrill,
  sweepInterruptedRuns,
  tryAgain,
} from "./planning-runs.ts";
import type { ClearingInput } from "./planning-runs.ts";
import { recordFogSettlement } from "./fog-settlement.ts";
import { prepareRun } from "./run-work.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import {
  addProject,
  answer,
  answerDestination,
  ask,
  chartedMap,
  cleanPass,
  closeTestContext,
  CONFIRMATION,
  confirm,
  grillingRun,
  newMap,
  NO_MAP_CHANGES,
  openTestContext,
  PLAIN_ANSWERS,
  propose,
  resolve,
  runningMapRun,
  runningSpecRun,
  runsOf,
  SPEC,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { readPasses } from "./wayfinding-records.ts";

let context: TestContext;
let project: Project;
let mapId: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-consistency-");
  project = await addProject(context, "app");
  mapId = await chartedMap(context, project);
});

afterEach(async () => {
  await closeTestContext(context);
});

const CONFLICT: ConsistencyFinding = {
  kind: "conflicting_surfaces",
  waypointNumbers: [1, 2],
  title: "Columns against encoding",
  explanation: "Waypoint 1 says “every column”; waypoint 2 says “ASCII only”.",
  question: "Which wins when a column holds non-ASCII text?",
};

function pass(findings: ConsistencyFinding[]): ConsistencyOutcome {
  return { findings, proposals: [] };
}

function mapRuns(purpose: PlanningRun["purpose"]): PlanningRun[] {
  return runsOf(context, mapId).filter((run) => run.purpose === purpose);
}

function resolveAll(): void {
  resolve(context, mapId, 1);
  resolve(context, mapId, 2);
  resolve(context, mapId, 3);
}

async function overview() {
  const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function stage(status: Awaited<ReturnType<typeof overview>>["status"], name: string) {
  const found = status.stages.find((candidate) => candidate.stage === name);
  if (found === undefined) throw new Error(`No stage ${name}`);
  return found;
}

describe("the due consistency pass (S6b-10, D5)", () => {
  const AT = "2026-10-08T12:00:00.000Z";
  const ids = [uuidv7(), uuidv7(), uuidv7()] as const;
  const resolved = (id: string) => ({ id, status: "resolved" as const, resolvedAt: AT });
  const run = (fields: Partial<PlanningRun>): PlanningRun => ({
    id: uuidv7(),
    mapId: uuidv7(),
    waypointId: null,
    specificationId: null,
    purpose: "chart",
    state: "completed",
    retryOfRunId: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    hatchMessageId: null,
    startedAt: AT,
    endedAt: AT,
    ...fields,
  });
  const base: ClearingInput = {
    map: { destinationConfirmedAt: AT },
    waypoints: [resolved(ids[0]), resolved(ids[1])],
    rounds: [{ status: "submitted" }],
    // The confirming chart, then its code survey (harness change #1).
    runs: [run({}), run({ purpose: "survey" })],
    fogCount: 0,
    passes: [],
  };
  const comparedAll = {
    compared: [ids[0], ids[1]].map((waypointId) => ({ waypointId, resolvedAt: AT })),
  };

  test("due when every condition holds, and not due when any one fails", () => {
    expect(consistencyDue(base)).toBe(true);
    expect(isCleared(base)).toBe(false);
    const failing: [string, ClearingInput][] = [
      ["destination not confirmed", { ...base, map: { destinationConfirmedAt: null } }],
      ["fog remains", { ...base, fogCount: 1 }],
      [
        "a waypoint is open",
        {
          ...base,
          waypoints: [...base.waypoints, { id: ids[2], status: "open", resolvedAt: null }],
        },
      ],
      ["a round is pending", { ...base, rounds: [{ status: "pending" }] }],
      ["the code survey has not completed", { ...base, runs: [run({})] }],
      ["a chart runs", { ...base, runs: [...base.runs, run({ state: "running", endedAt: null })] }],
      [
        "a waypoint run awaits its retry",
        {
          ...base,
          runs: [
            ...base.runs,
            run({
              purpose: "research",
              waypointId: ids[0],
              state: "failed",
              errorCode: "agent_timed_out",
              errorMessage: "Timed out",
            }),
          ],
        },
      ],
      [
        "fewer than two resolved",
        {
          ...base,
          waypoints: [resolved(ids[0]), { id: ids[1], status: "out_of_scope", resolvedAt: null }],
        },
      ],
      ["a pass compared exactly the resolved set", { ...base, passes: [comparedAll] }],
    ];
    for (const [rule, input] of failing) {
      expect({ rule, due: consistencyDue(input) }).toEqual({ rule, due: false });
    }
  });

  test("a pass of a different resolved set is no match: due again, not cleared", () => {
    const stale = { compared: [{ waypointId: ids[0], resolvedAt: AT }] };
    expect(consistencyDue({ ...base, passes: [stale] })).toBe(true);
    const restamped = {
      compared: comparedAll.compared.map((pair) => ({
        ...pair,
        resolvedAt: "2026-10-09T00:00:00.000Z",
      })),
    };
    expect(consistencyDue({ ...base, passes: [restamped] })).toBe(true);
    expect(isCleared({ ...base, passes: [comparedAll] })).toBe(true);
  });

  test("once the map has run CONSISTENCY_PASSES_MAX passes, none is due and a stale set clears", () => {
    const stale = { compared: [{ waypointId: ids[0], resolvedAt: AT }] };
    const below = Array.from({ length: CONSISTENCY_PASSES_MAX - 1 }, () => stale);
    expect(passesExhausted({ passes: below })).toBe(false);
    expect(consistencyDue({ ...base, passes: below })).toBe(true);
    expect(isCleared({ ...base, passes: below })).toBe(false);
    const capped = [...below, stale];
    expect(passesExhausted({ passes: capped })).toBe(true);
    expect(consistencyDue({ ...base, passes: capped })).toBe(false);
    expect(isCleared({ ...base, passes: capped })).toBe(true);
  });

  test("a consistency run running or awaiting retry holds clearing back (S6b-11)", () => {
    const passed = { ...base, passes: [comparedAll] };
    expect(
      isCleared({
        ...passed,
        runs: [...base.runs, run({ purpose: "consistency", state: "running", endedAt: null })],
      }),
    ).toBe(false);
    expect(
      isCleared({
        ...passed,
        runs: [
          ...base.runs,
          run({
            purpose: "consistency",
            state: "failed",
            errorCode: "agent_timed_out",
            errorMessage: "Timed out",
          }),
        ],
      }),
    ).toBe(false);
  });
});

describe("the pass on a map (S6b-10, S6b-11)", () => {
  test("resolving the last of three waypoints starts the pass, not to_spec; its request lists every resolved waypoint", async () => {
    resolveAll();
    expect(mapRuns("to_spec")).toEqual([]);
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "consistency") throw new Error("not a consistency run");
    expect(work.value.request.waypoints.map((w) => [w.number, w.kind, w.finding])).toEqual([
      [1, "grilling", null],
      [2, "grilling", null],
      [3, "grilling", null],
    ]);
    expect(work.value.request.outOfScope).toEqual([]);
  });

  test("the request says who stands behind each resolution: the person for an answered round, else the agent alone", async () => {
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    resolveAll();
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "consistency") throw new Error("not a consistency run");
    expect(work.value.request.waypoints.map((w) => [w.number, w.decidedByPerson])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  test("a clean pass records what it compared and clears the map: to_spec starts", () => {
    resolveAll();
    const runId = runningMapRun(context, mapId).id;
    cleanPass(context, mapId);
    const [stored] = context.db.select().from(consistencyPasses).all();
    expect(stored?.runId).toBe(runId);
    expect(stored?.compared).toEqual(
      readWaypoints(context.db, mapId).map((w) => ({ waypointId: w.id, resolvedAt: w.resolvedAt })),
    );
    expect(mapRuns("consistency")).toMatchObject([{ id: runId, state: "completed" }]);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
  });

  test("a finding opens an unblocked Grilling waypoint; it blocks clearing until it settles and a later pass matches", async () => {
    resolveAll();
    const firstPass = runningMapRun(context, mapId).id;
    const recorded = recordConsistency(context.user, context.db, firstPass, pass([CONFLICT]));
    expect(recorded.ok).toBe(true);
    expect(readPasses(context.db, mapId).map((stored) => stored.findingCount)).toEqual([1]);
    const opened = waypointOf(context, mapId, 4);
    expect(opened).toMatchObject({
      kind: "grilling",
      status: "claimed",
      title: CONFLICT.title,
      question: CONFLICT.question,
      createdByRun: firstPass,
    });
    expect(context.db.select().from(consistencyFindings).all()).toMatchObject([
      { createdWaypointId: opened.id, kind: CONFLICT.kind, waypointNumbers: [1, 2] },
    ]);
    expect(mapRuns("to_spec")).toEqual([]);

    const grill = await prepareRun(context.db, grillingRun(context, mapId, 4).id);
    if (!grill.ok || grill.value.purpose !== "grilling") throw new Error("not a grilling run");
    expect(grill.value.request.finding).toMatchObject({
      kind: CONFLICT.kind,
      waypoints: [
        { number: 1, resolution: "Resolved 1." },
        { number: 2, resolution: "Resolved 2." },
      ],
    });

    resolve(context, mapId, 4);
    expect(mapRuns("to_spec")).toEqual([]);
    const second = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!second.ok || second.value.purpose !== "consistency") throw new Error("not a second pass");
    expect(second.value.request.waypoints.find((w) => w.number === 4)?.finding).toEqual({
      kind: CONFLICT.kind,
      waypointNumbers: [1, 2],
    });
    cleanPass(context, mapId);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
  });

  test("a later pass drops a finding naming only waypoints the last pass compared; the capped map then runs to_spec", async () => {
    expect(CONSISTENCY_PASSES_MAX).toBe(2);
    resolveAll();
    const first = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!first.ok || first.value.purpose !== "consistency") throw new Error("not a first pass");
    expect(first.value.request.waypoints.every((w) => w.newSinceLastPass)).toBe(true);
    // The first pass keeps a finding on any resolved waypoints.
    expect(
      recordConsistency(context.user, context.db, first.value.run.id, pass([CONFLICT])),
    ).toEqual({
      ok: true,
      value: { dropped: 0 },
    });
    resolve(context, mapId, 4);

    const second = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!second.ok || second.value.purpose !== "consistency") throw new Error("not a second pass");
    expect(second.value.request.waypoints.map((w) => [w.number, w.newSinceLastPass])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ]);
    const fresh = { ...CONFLICT, waypointNumbers: [1, 4], title: "Waypoint 4 against 1" };
    const recorded = recordConsistency(
      context.user,
      context.db,
      second.value.run.id,
      pass([{ ...CONFLICT, waypointNumbers: [2, 3] }, fresh]),
    );
    expect(recorded).toEqual({ ok: true, value: { dropped: 1 } });
    expect(mapRuns("consistency").map((run) => run.state)).toEqual(["completed", "completed"]);
    expect(waypointOf(context, mapId, 5)).toMatchObject({ title: fresh.title });
    expect(readWaypoints(context.db, mapId)).toHaveLength(5);
    expect(
      context.db
        .select()
        .from(consistencyFindings)
        .all()
        .map((row) => row.waypointNumbers),
    ).toEqual([
      [1, 2],
      [1, 4],
    ]);

    // The cap is reached: resolving waypoint 5 runs no third pass; the map clears to to_spec.
    resolve(context, mapId, 5);
    expect(mapRuns("consistency")).toHaveLength(2);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
  });

  test("a finding naming a waypoint that is not resolved is refused consistency_waypoint_unknown and writes nothing", () => {
    // Waypoint 3 ruled out of scope: neither compared nor counted.
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    const ruled = recordGrill(context.user, context.db, grillingRun(context, mapId, 3).id, {
      round: null,
      resolution: null,
      outOfScope: { reason: "Later." },
      mapChanges: NO_MAP_CHANGES,
    });
    expect(ruled.ok).toBe(true);
    for (const numbers of [[1, 3], [9]]) {
      const runId = runningMapRun(context, mapId).id;
      const before = readWaypoints(context.db, mapId);
      const recorded = recordConsistency(
        context.user,
        context.db,
        runId,
        pass([{ ...CONFLICT, waypointNumbers: numbers }]),
      );
      expect(recorded).toMatchObject({
        ok: false,
        error: { code: "consistency_waypoint_unknown" },
      });
      expect(readWaypoints(context.db, mapId)).toEqual(before);
      expect(context.db.select().from(consistencyPasses).all()).toEqual([]);
      expect(runsOf(context, mapId).find((run) => run.id === runId)).toMatchObject({
        state: "failed",
        errorCode: "consistency_waypoint_unknown",
      });
    }
  });

  test("two resolved waypoints need a pass; one resolved and the rest out of scope clears at once (L4)", async () => {
    const outOfScope = (number: number) => {
      const ruled = recordGrill(context.user, context.db, grillingRun(context, mapId, number).id, {
        round: null,
        resolution: null,
        outOfScope: { reason: "Later." },
        mapChanges: NO_MAP_CHANGES,
      });
      if (!ruled.ok) throw new Error(ruled.error.code);
    };
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    outOfScope(3);
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "consistency") throw new Error("not a consistency run");
    expect(work.value.request.waypoints.map((w) => w.number)).toEqual([1, 2]);

    const other = await chartedMap(context, project);
    mapId = other;
    resolve(context, mapId, 1);
    outOfScope(2);
    outOfScope(3);
    expect(mapRuns("consistency")).toEqual([]);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
  });
});

describe("retries of the pass (S6b-12)", () => {
  const timedOut = { code: "agent_timed_out", message: "Timed out" } as const;

  test("a failed pass is retried once; a failed retry stops the map scope until Try again", async () => {
    resolveAll();
    const first = runningMapRun(context, mapId);
    failRun(context.user, context.db, first.id, timedOut);
    const retry = runningMapRun(context, mapId);
    expect(retry).toMatchObject({ purpose: "consistency", retryOfRunId: first.id });
    expect(stage((await overview()).status, "wayfinding").tone).toBe("working");

    failRun(context.user, context.db, retry.id, timedOut);
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
    expect(mapRuns("to_spec")).toEqual([]);
    const { status } = await overview();
    expect(stage(status, "wayfinding").tone).toBe("needs-you");
    expect(status.next).toContainEqual(
      expect.objectContaining({
        who: "you",
        stage: "wayfinding",
        stopped: { runId: retry.id, code: "agent_timed_out" },
      }),
    );

    expect(tryAgain(context.user, context.db, retry.id)).toMatchObject({ ok: true });
    expect(runningMapRun(context, mapId)).toMatchObject({
      purpose: "consistency",
      retryOfRunId: null,
    });
  });

  test("the startup sweep fails an interrupted pass and inserts its retry", () => {
    resolveAll();
    const interrupted = runningMapRun(context, mapId);
    sweepInterruptedRuns(context.db);
    expect(runsOf(context, mapId).find((run) => run.id === interrupted.id)).toMatchObject({
      state: "failed",
      errorCode: "planning_run_interrupted",
    });
    expect(runningMapRun(context, mapId)).toMatchObject({
      purpose: "consistency",
      retryOfRunId: interrupted.id,
    });
  });
});

describe("Existing Records", () => {
  test("a cleared map with two resolved waypoints and no pass reads un-cleared, gets its pass, and a clean pass clears it without rerunning to_spec", async () => {
    resolveAll();
    cleanPass(context, mapId);
    const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [{ specNumber: null, content: SPEC }],
      waits: [],
    });
    if (!recorded.ok) throw new Error(recorded.error.code);
    const reviewed = recordSpecReview(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "spec_review").id,
      {
        summary: "Every clause traces.",
        findings: [],
        verified: [],
      },
    );
    if (!reviewed.ok) throw new Error(reviewed.error.code);
    // Before 0006 no pass was stored.
    writeTestData(context, (tx) =>
      tx.delete(consistencyPasses).where(eq(consistencyPasses.mapId, mapId)).run(),
    );

    // At startup the sweep's planNext starts the pass; meanwhile the map reads un-cleared.
    sweepInterruptedRuns(context.db);
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
    const meanwhile = (await overview()).status;
    expect(stage(meanwhile, "wayfinding").tone).toBe("working");
    expect(stage(meanwhile, "spec").tone).toBe("later");
    cleanPass(context, mapId);
    expect(mapRuns("to_spec")).toHaveLength(1);
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
    const { status } = await overview();
    expect(stage(status, "wayfinding").tone).toBe("done");
    expect(stage(status, "spec").tone).toBe("needs-you");
  });
});

describe("Existing Records with a stopped draft run (L121)", () => {
  test("a stopped to_spec retry does not block the due pass; the overview reads working; a clean pass runs to_spec fresh", async () => {
    resolveAll();
    cleanPass(context, mapId);
    const timedOut = { code: "agent_timed_out", message: "Timed out" } as const;
    const first = runningMapRun(context, mapId);
    failRun(context.user, context.db, first.id, timedOut);
    const retry = runningMapRun(context, mapId);
    failRun(context.user, context.db, retry.id, timedOut);
    // Before 0006 no pass was stored.
    writeTestData(context, (tx) =>
      tx.delete(consistencyPasses).where(eq(consistencyPasses.mapId, mapId)).run(),
    );

    sweepInterruptedRuns(context.db);
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
    const { status } = await overview();
    expect(stage(status, "wayfinding").tone).toBe("working");
    expect(stage(status, "spec").tone).toBe("later");
    expect(status.next.some((action) => action.stopped?.runId === retry.id)).toBe(false);
    expect(tryAgain(context.user, context.db, retry.id)).toMatchObject({
      ok: false,
      error: { code: "planning_run_not_stopped" },
    });

    cleanPass(context, mapId);
    expect(runningMapRun(context, mapId)).toMatchObject({
      purpose: "to_spec",
      retryOfRunId: null,
    });
  });
});

describe("a final round answered by plain choices and fog (S7b-14, L120)", () => {
  async function fogged(fog: string[]): Promise<void> {
    mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, { ...CONFIRMATION, fog });
  }

  function answerThird(): void {
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    ask(context, mapId, 3, true);
    answer(context, mapId, 3, PLAIN_ANSWERS);
  }

  function resolveThird(fogOutOfScope: { position: number; line: string }[]) {
    return recordGrill(context.user, context.db, grillingRun(context, mapId, 3).id, {
      round: null,
      resolution: { resolution: "Resolved 3.", gist: "Gist 3", agentDecided: [] },
      outOfScope: null,
      mapChanges: {
        newWaypoints: [],
        fogOutOfScope,
        fogDecided: [],
        fogSettledHere: [],
        newFog: [],
      },
    });
  }

  test("the last waypoint stays claimed with a running grilling run while fog remains", async () => {
    await fogged(["Retries on flaky networks."]);
    answerThird();
    expect(waypointOf(context, mapId, 3)).toMatchObject({ status: "claimed", resolvedHow: null });
    expect(grillingRun(context, mapId, 3)).toMatchObject({ purpose: "grilling", state: "running" });
  });

  test("the run's resolution leaving the fog is accepted; the fog run comes before the consistency pass", async () => {
    await fogged(["Retries on flaky networks."]);
    answerThird();
    const recorded = resolveThird([]);
    expect(recorded.ok).toBe(true);
    // Every waypoint is resolved and fog remains: the fog run, not the pass (harness change #4).
    const fogRun = runningMapRun(context, mapId);
    expect(fogRun.purpose).toBe("fog");
    expect(readPasses(context.db, mapId)).toEqual([]);
    const settled = recordFogSettlement(context.user, context.db, fogRun.id, {
      fogSettledBy: [],
      fogDecided: [
        {
          position: 1,
          title: "Retries",
          resolution: "Decided by the agent: no retries; the person can reopen it.",
          gist: "No retries",
        },
      ],
      fogOutOfScope: [],
      fogForPerson: [],
      fogProposed: [],
    });
    expect(settled.ok).toBe(true);
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    // The pass then compares the fog run's decision with the other resolutions.
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
  });

  test("the run's resolution settling the fog resolves the last waypoint by run", async () => {
    await fogged(["Retries on flaky networks."]);
    answerThird();
    const run = grillingRun(context, mapId, 3);
    const recorded = resolveThird([{ position: 1, line: "Retries are a later effort." }]);
    expect(recorded.ok).toBe(true);
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(waypointOf(context, mapId, 3)).toMatchObject({
      status: "resolved",
      gist: "Gist 3",
      resolvedHow: "run",
      resolvedByRun: run.id,
    });
  });

  test("with no fog, the last waypoint answered by plain choices resolves through its run", async () => {
    await fogged([]);
    answerThird();
    expect(waypointOf(context, mapId, 3)).toMatchObject({ status: "claimed", resolvedHow: null });
    const recorded = resolveThird([]);
    expect(recorded.ok).toBe(true);
    expect(waypointOf(context, mapId, 3)).toMatchObject({ status: "resolved", resolvedHow: "run" });
  });
});
