import { rm } from "node:fs/promises";

import { CreateMapInput, SubmitAnswersInput } from "@zenorm/contracts";
import type {
  Answers,
  ChartConfirmation,
  ChartedWaypoint,
  Project,
  WaypointKind,
  PlanningRun,
  PlanningRunUsage,
} from "@zenorm/contracts";
import {
  isUniqueConstraintViolation,
  mapExclusions,
  mapFog,
  maps,
  planningRuns,
  questionRounds,
  waypointBlockers,
  waypointTouches,
  waypoints,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { validate, version } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createMap, getMap, submitAnswers } from "./map.ts";
import { getMapOverview } from "./map-overview.ts";
import { approveSpecRevision } from "./planning.ts";
import {
  blockerProblem,
  failRun,
  readRounds,
  recordRunUsage,
  readWaypoints,
  recordChart,
  sweepInterruptedRuns,
  tryAgain,
} from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import {
  addProject,
  allRuns,
  answerDestination,
  answerMapRound,
  confirmChart,
  followUp,
  FOLLOW_UP,
  ANSWERS,
  chartedMap,
  clearedMap,
  closeTestContext,
  CONFIRMATION,
  confirm,
  draftedSpec,
  draftedTicketSet,
  grillingRun,
  insertRevision,
  insertRun,
  insertSpec,
  reviewedSpec,
  runningSpecRun,
  latestRun,
  newMap,
  NO_WAYPOINTS,
  openTestContext,
  pendingMapRound,
  propose,
  PROPOSAL,
  resolve,
  REVISE_FINDING,
  ROUND,
  runningMapRun,
  runsOf,
  SPEC,
  SURVEY,
  UNKNOWN_ID,
  waypointOf,
  cleanPass,
  unreviewedTicketSet,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-runs-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

function mapRow(mapId: string) {
  const map = context.db.select().from(maps).where(eq(maps.id, mapId)).get();
  if (map === undefined) throw new Error(`No map ${mapId}`);
  return map;
}

/** Counts of every Wayfinding row, to show a refusal wrote nothing. */
function rowCounts() {
  return {
    maps: context.db.select().from(maps).all().length,
    runs: context.db.select().from(planningRuns).all().length,
    rounds: context.db.select().from(questionRounds).all().length,
    waypoints: context.db.select().from(waypoints).all().length,
    blockers: context.db.select().from(waypointBlockers).all().length,
  };
}

const FAILURE = { code: "agent_run_failed", message: "The run failed." } as const;

describe("map.create (S6a-2)", () => {
  test("stores the map and its first chart run, running, and returns at once", async () => {
    const created = await createMap(
      context.user,
      context.db,
      CreateMapInput.parse({ projectId: project.id, idea: "  Export data  " }),
    );
    if (!created.ok) throw new Error(created.error.code);
    const { map } = created.value;
    expect(validate(map.id) && version(map.id)).toBe(7);
    expect(map).toMatchObject({
      idea: "Export data",
      title: null,
      summary: null,
      destination: null,
      destinationConfirmedAt: null,
    });
    expect(runsOf(context, map.id)).toMatchObject([
      { purpose: "chart", state: "running", waypointId: null, retryOfRunId: null },
    ]);
    expect((await getMap(context.db, map.id)).ok).toBe(true);
  });

  test("project_not_found and project_folder_missing are its only refusals, writing nothing", async () => {
    const unknown = await createMap(
      context.user,
      context.db,
      CreateMapInput.parse({ projectId: UNKNOWN_ID, idea: "X" }),
    );
    expect(!unknown.ok && unknown.error.code).toBe("project_not_found");
    await rm(project.folderPath, { recursive: true, force: true });
    const missing = await createMap(
      context.user,
      context.db,
      CreateMapInput.parse({ projectId: project.id, idea: "X" }),
    );
    expect(!missing.ok && missing.error.code).toBe("project_folder_missing");
    expect(rowCounts()).toEqual({ maps: 0, runs: 0, rounds: 0, waypoints: 0, blockers: 0 });
  });
});

describe("the first chart (S6a-3)", () => {
  test("saves title, summary and proposed destination and asks map-level round 1; the run ends asked", async () => {
    const mapId = await newMap(context, project, "Export data");
    const chart = runningMapRun(context, mapId);
    const request = await prepareRun(context.db, chart.id);
    if (!request.ok || request.value.purpose !== "chart") throw new Error("not a chart");
    expect(request.value.request).toEqual({
      projectName: project.name,
      projectFolder: project.folderPath,
      baseBranch: "main",
      idea: "Export data",
      projectProposals: [],
      projectMaps: [{ title: null, stage: "idea" }],
      mapRounds: [],
      proposed: null,
      projectSpecs: [],
      split: [],
      refusedAttempt: null,
    });

    propose(context, mapId);

    expect(mapRow(mapId)).toMatchObject({
      title: PROPOSAL.title,
      summary: PROPOSAL.summary,
      destination: PROPOSAL.destination,
      destinationConfirmedAt: null,
    });
    expect(readRounds(context.db, mapId)).toMatchObject([
      {
        waypointId: null,
        number: 1,
        final: false,
        status: "pending",
        askedByRun: chart.id,
        intro: ROUND.intro,
        questions: ROUND.questions,
        answers: null,
      },
    ]);
    expect(runsOf(context, mapId)).toMatchObject([{ id: chart.id, state: "asked" }]);
  });

  test("map-level rounds are numbered from 1 per map", async () => {
    const first = await newMap(context, project, "One");
    const second = await newMap(context, project, "Two");
    propose(context, first);
    propose(context, second);
    expect(readRounds(context.db, first).map((round) => round.number)).toEqual([1]);
    expect(readRounds(context.db, second).map((round) => round.number)).toEqual([1]);
  });

  test("no chart starts while the map-level round is pending", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
  });
});

describe("submitting the map-level round (S6a-9, S6a-4)", () => {
  let mapId: string;
  let roundId: string;

  beforeEach(async () => {
    mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    roundId = pendingMapRound(context, mapId);
  });

  function submit(answers: Answers) {
    return submitAnswers(context.user, context.db, SubmitAnswersInput.parse({ roundId, answers }));
  }

  test("stores the answers and starts a fresh chart, whose request carries the answered round", async () => {
    const submitted = submit(ANSWERS);
    if (!submitted.ok) throw new Error(submitted.error.code);
    expect(submitted.value).toMatchObject({ status: "submitted", answers: ANSWERS });
    const chart = runningMapRun(context, mapId);
    expect(chart.purpose).toBe("chart");
    const request = await prepareRun(context.db, chart.id);
    if (!request.ok || request.value.purpose !== "chart") throw new Error("not a chart");
    expect(request.value.request.mapRounds).toEqual([
      { questions: ROUND.questions, answers: ANSWERS, final: false },
    ]);
    // What round 1 was asked about (DR-3).
    expect(request.value.request.proposed).toEqual({
      title: PROPOSAL.title,
      summary: PROPOSAL.summary,
      destination: PROPOSAL.destination,
    });
  });

  test("accepts an accepted answer (option 0, no words) and one with an option and words", () => {
    const result = submit([
      { optionIndex: 0, note: "", accepted: true },
      { optionIndex: 1, note: "Also the auditors", accepted: false },
    ]);
    expect(result.ok).toBe(true);
  });

  test.each([
    ["too few answers", [ANSWERS[0]], null],
    [
      "an option the question lacks",
      [ANSWERS[0], { optionIndex: 2, note: "", accepted: false }],
      1,
    ],
    [
      "neither an option nor words",
      [{ optionIndex: null, note: "", accepted: false }, ANSWERS[1]],
      0,
    ],
    ["accepted on option 1", [{ optionIndex: 1, note: "", accepted: true }, ANSWERS[1]], 0],
    ["accepted with words", [{ optionIndex: 0, note: "Mine", accepted: true }, ANSWERS[1]], 0],
    ["accepted with no option", [{ optionIndex: null, note: "", accepted: true }, ANSWERS[1]], 0],
  ])("round_answers_invalid for %s, writing nothing", (_case, answers, questionIndex) => {
    const before = rowCounts();
    const result = submit(answers.filter((answer) => answer !== undefined));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "round_answers_invalid", data: { roundId, questionIndex } },
    });
    expect(rowCounts()).toEqual(before);
    expect(readRounds(context.db, mapId)[0]?.status).toBe("pending");
  });

  test("round_already_submitted once submitted, and the round is unchanged", () => {
    expect(submit(ANSWERS).ok).toBe(true);
    const stored = readRounds(context.db, mapId);
    const again = submit([
      { optionIndex: 1, note: "", accepted: false },
      { optionIndex: 0, note: "", accepted: false },
    ]);
    expect(!again.ok && again.error.code).toBe("round_already_submitted");
    expect(readRounds(context.db, mapId)).toEqual(stored);
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toHaveLength(1);
  });

  test("round_not_found for an unknown round", () => {
    const result = submitAnswers(
      context.user,
      context.db,
      SubmitAnswersInput.parse({ roundId: UNKNOWN_ID, answers: ANSWERS }),
    );
    expect(!result.ok && result.error.code).toBe("round_not_found");
  });
});

describe("the confirming chart (S6a-4, S6a-5, S6a-6)", () => {
  let mapId: string;

  beforeEach(async () => {
    mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
  });

  test("confirms the destination and saves Grilling waypoints 1 to 3 with their blockers", () => {
    const chart = runningMapRun(context, mapId);
    confirm(context, mapId, CONFIRMATION);

    const map = mapRow(mapId);
    expect(map.destination).toBe(CONFIRMATION.destination);
    expect(map.destinationConfirmedAt).not.toBeNull();
    expect(readWaypoints(context.db, mapId)).toMatchObject(
      CONFIRMATION.waypoints.map((waypoint, index) => ({
        number: index + 1,
        kind: "grilling",
        // Waypoint 1 is on the frontier and claimed at once (S6a-7); 2 and 3 wait on it.
        status: index === 0 ? "claimed" : "open",
        title: waypoint.title,
        question: waypoint.question,
        createdByRun: chart.id,
        resolution: null,
      })),
    );
    expect(
      context.db
        .select({ w: waypointBlockers.waypointNumber, b: waypointBlockers.blockerNumber })
        .from(waypointBlockers)
        .all(),
    ).toEqual([
      { w: 2, b: 1 },
      { w: 3, b: 1 },
    ]);
    expect(runsOf(context, mapId).find((run) => run.id === chart.id)).toMatchObject({
      state: "completed",
    });
  });

  test("numbers waypoints one plus the map's highest", () => {
    const chart = runningMapRun(context, mapId);
    writeTestData(context, (tx) =>
      tx
        .insert(waypoints)
        .values({
          id: UNKNOWN_ID,
          mapId,
          number: 4,
          kind: "grilling",
          status: "open",
          title: "Earlier",
          question: "Earlier?",
          claimedAt: null,
          resolution: null,
          gist: null,
          resolvedAt: null,
          resolvedHow: null,
          resolvedByRun: null,
          createdByRun: chart.id,
          personDecides: false,
        })
        .run(),
    );
    confirm(context, mapId, CONFIRMATION);
    expect(readWaypoints(context.db, mapId).map((waypoint) => waypoint.number)).toEqual([
      4, 5, 6, 7,
    ]);
    expect(
      context.db
        .select()
        .from(waypointBlockers)
        .all()
        .map((row) => row.blockerNumber),
    ).toEqual([5, 5]);
  });

  test("with zero waypoints the map clears and the same write inserts to_spec (S6a-11)", () => {
    confirm(context, mapId, NO_WAYPOINTS);
    expect(readWaypoints(context.db, mapId)).toEqual([]);
    expect(latestRun(context, mapId)).toMatchObject({ purpose: "to_spec", state: "running" });
  });

  function withBlockers(...blockedBy: number[][]): ChartConfirmation {
    return {
      title: PROPOSAL.title,
      summary: PROPOSAL.summary,
      destination: "Somewhere",
      waypoints: blockedBy.map((list, index): ChartedWaypoint => ({
        kind: "grilling",
        title: `Waypoint ${String(index + 1)}`,
        question: "What holds?",
        blockedBy: list,
        touches: [],
      })),
      fog: [],
      outOfScope: [],
      proposals: [],
    };
  }

  /** A waypoint of `kind` titled by its position. */
  function charted(kind: WaypointKind, position: number, blockedBy: number[]): ChartedWaypoint {
    return {
      kind,
      title: `Waypoint ${String(position)}`,
      question: "What holds?",
      blockedBy,
      touches: [],
    };
  }

  const lines = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}.`);

  test("saves each waypoint's kind, 8 fog items and 8 Out of scope lines in its transaction (S6b-2)", async () => {
    const chart = runningMapRun(context, mapId);
    confirm(context, mapId, {
      title: PROPOSAL.title,
      summary: PROPOSAL.summary,
      destination: "Somewhere",
      waypoints: [
        charted("research", 1, []),
        charted("task", 2, []),
        charted("grilling", 3, [1, 2]),
        charted("grilling", 4, []),
      ],
      fog: lines("Fog", 8),
      outOfScope: lines("Not this", 8),
      proposals: [],
    });
    // Every kind is on the frontier (S6b-6): each unblocked waypoint is claimed with a run of its kind.
    expect(readWaypoints(context.db, mapId)).toMatchObject([
      { number: 1, kind: "research", status: "claimed" },
      { number: 2, kind: "task", status: "claimed" },
      { number: 3, kind: "grilling", status: "open" },
      { number: 4, kind: "grilling", status: "claimed" },
    ]);
    expect(
      runsOf(context, mapId)
        .filter((run) => run.waypointId !== null)
        .map((run) => run.purpose),
    ).toEqual(["research", "task", "grilling"]);
    expect(context.db.select().from(mapFog).all()).toEqual(
      lines("Fog", 8).map((text, index) => ({
        mapId,
        position: index + 1,
        text,
        createdByRun: chart.id,
      })),
    );
    expect(mapRow(mapId).fogNextPosition).toBe(9);
    expect(context.db.select().from(mapExclusions).all()).toEqual(
      lines("Not this", 8).map((text, index) => ({
        mapId,
        position: index + 1,
        text,
        waypointId: null,
        createdByRun: chart.id,
        splitMapId: null,
      })),
    );
    const overview = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!overview.ok) throw new Error(overview.error.code);
    expect(overview.value.wayfinding.fog).toEqual(
      lines("Fog", 8).map((text, index) => ({ position: index + 1, text })),
    );
    expect(overview.value.wayfinding.outOfScope).toEqual(
      lines("Not this", 8).map((text) => ({ text, waypoint: null, splitMapId: null })),
    );
  });

  test("saves no fog and no Out of scope line when the chart has none (S6b-2)", () => {
    confirm(context, mapId, CONFIRMATION);
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(context.db.select().from(mapExclusions).all()).toEqual([]);
    expect(mapRow(mapId).fogNextPosition).toBe(1);
  });

  test.each([
    ["an unknown position", withBlockers([], [3]), "waypoint_blocker_unknown"],
    ["a cycle", withBlockers([2], [1]), "waypoint_blocker_cycle"],
    ["a waypoint blocking itself", withBlockers([1]), "waypoint_blocker_cycle"],
    [
      "both an unknown position and a cycle",
      withBlockers([2], [1], [9]),
      "waypoint_blocker_unknown",
    ],
    [
      "fog with no waypoint (S6b-4)",
      { ...NO_WAYPOINTS, fog: ["Who may export."] },
      "fog_left_unsettled",
    ],
  ])("refuses %s with its code, writes nothing and fails the run", (_case, confirmation, code) => {
    const chart = runningMapRun(context, mapId);
    const before = mapRow(mapId);
    const recorded = recordChart(context.user, context.db, chart.id, {
      kind: "confirmation",
      confirmation,
    });
    expect(!recorded.ok && recorded.error.code).toBe(code);
    expect(mapRow(mapId)).toEqual(before);
    expect(readWaypoints(context.db, mapId)).toEqual([]);
    expect(context.db.select().from(waypointBlockers).all()).toEqual([]);
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(context.db.select().from(mapExclusions).all()).toEqual([]);
    const runs = runsOf(context, mapId);
    expect(runs.find((run) => run.id === chart.id)).toMatchObject({
      state: "failed",
      errorCode: code,
    });
    // The failure's transaction inserts its retry (S6a-12).
    expect(runs.at(-1)).toMatchObject({
      purpose: "chart",
      state: "running",
      retryOfRunId: chart.id,
    });
  });

  test("blockerProblem accepts a chain and repeated positions", () => {
    expect(blockerProblem(withBlockers([], [1, 1], [2, 1]).waypoints)).toBeNull();
  });
});

describe("retry and Try again (S6a-12)", () => {
  /** The one running run not on a waypoint: the map's own, or its one spec's. */
  function runningOf(mapId: string): PlanningRun {
    const running = runsOf(context, mapId).filter(
      (run) => run.waypointId === null && run.state === "running",
    );
    const [run] = running;
    if (run === undefined || running.length > 1) throw new Error("Not one running run");
    return run;
  }

  /** Fails the map's running map-level or spec run and returns its id. */
  function failRunning(mapId: string): string {
    const run = runningOf(mapId);
    failRun(context.user, context.db, run.id, FAILURE);
    return run.id;
  }

  /** Each purpose this ticket retries, with a map whose run of that purpose is running. */
  const purposes: [string, () => Promise<string>][] = [
    ["chart", () => newMap(context, project, "Export data")],
    ["to_spec", () => clearedMap(context, project)],
    [
      "to_tickets",
      async () => {
        const { mapId, specRevisionId } = await reviewedSpec(context, project);
        const approved = approveSpecRevision(context.user, context.db, { specRevisionId });
        if (!approved.ok) throw new Error(approved.error.code);
        return mapId;
      },
    ],
  ];

  test.each(purposes)(
    "%s: one retry in the failure's transaction; a failed retry stops the map until tryAgain",
    async (purpose, start) => {
      const mapId = await start();
      const first = failRunning(mapId);
      const retry = runningOf(mapId);
      expect(retry).toMatchObject({ purpose, retryOfRunId: first });

      const failedRetry = failRunning(mapId);
      expect(failedRetry).toBe(retry.id);
      expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
      expect(latestRun(context, mapId)).toMatchObject({
        id: failedRetry,
        state: "failed",
        errorCode: FAILURE.code,
      });

      const again = tryAgain(context.user, context.db, failedRetry);
      expect(again).toEqual({ ok: true, value: mapId });
      const fresh = runningOf(mapId);
      expect(fresh).toMatchObject({ purpose, retryOfRunId: null });

      // The fresh run is itself retried once.
      failRunning(mapId);
      expect(runningOf(mapId)).toMatchObject({ purpose, retryOfRunId: fresh.id });
    },
  );

  test("planning_run_not_found for an unknown run", () => {
    expect(tryAgain(context.user, context.db, UNKNOWN_ID)).toMatchObject({
      ok: false,
      error: { code: "planning_run_not_found", data: { runId: UNKNOWN_ID } },
    });
  });

  test("planning_run_not_stopped for a running run, a failed first attempt and a stopped run no longer latest", async () => {
    const mapId = await newMap(context, project, "Export data");
    const running = runningMapRun(context, mapId).id;
    expect(tryAgain(context.user, context.db, running)).toMatchObject({
      ok: false,
      error: { code: "planning_run_not_stopped" },
    });
    const first = failRunning(mapId);
    expect(!tryAgain(context.user, context.db, first).ok).toBe(true);
    const failedRetry = failRunning(mapId);
    expect(tryAgain(context.user, context.db, failedRetry).ok).toBe(true);
    const before = allRuns(context).length;
    expect(tryAgain(context.user, context.db, failedRetry)).toMatchObject({
      ok: false,
      error: { code: "planning_run_not_stopped" },
    });
    expect(allRuns(context)).toHaveLength(before);
  });
});

describe("resuming a run that ran out of turns", () => {
  const OUT_OF_TURNS: PlanningRunUsage = {
    sessionId: "session-9",
    resultSubtype: "error_max_turns",
    numTurns: 13,
    durationMs: 90_000,
    totalCostUsd: 1.25,
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 4,
  };
  const MAX_TURNS_FAILURE = { code: "agent_run_failed", message: "Out of turns." } as const;

  /** The map's one running run. */
  function running(mapId: string): PlanningRun {
    const [run, ...rest] = runsOf(context, mapId).filter((each) => each.state === "running");
    if (run === undefined || rest.length > 0) throw new Error("Not one running run");
    return run;
  }

  async function resumes(runId: string): Promise<string | null> {
    const work = await prepareRun(context.db, runId);
    if (!work.ok) throw new Error(work.error.code);
    return work.value.resumeSessionId;
  }

  test("stores the call's usage on the run", async () => {
    const mapId = await newMap(context, project, "Export data");
    const first = running(mapId);

    recordRunUsage(context.user, context.db, first.id, OUT_OF_TURNS);

    const stored = context.db
      .select()
      .from(planningRuns)
      .where(eq(planningRuns.id, first.id))
      .get();
    expect(stored).toMatchObject({ ...OUT_OF_TURNS, state: "running" });
  });

  test("a first attempt starts cold; the retry of an error_max_turns run resumes its session once", async () => {
    const mapId = await newMap(context, project, "Export data");
    const first = running(mapId);
    expect(await resumes(first.id)).toBeNull();

    recordRunUsage(context.user, context.db, first.id, OUT_OF_TURNS);
    failRun(context.user, context.db, first.id, MAX_TURNS_FAILURE);
    const retry = running(mapId);
    expect(retry.retryOfRunId).toBe(first.id);
    expect(await resumes(retry.id)).toBe("session-9");

    // Running out of turns again fails as before: the scope stops, nothing resumes it.
    recordRunUsage(context.user, context.db, retry.id, {
      ...OUT_OF_TURNS,
      sessionId: "session-10",
    });
    failRun(context.user, context.db, retry.id, MAX_TURNS_FAILURE);
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
    expect(latestRun(context, mapId)).toMatchObject({ id: retry.id, state: "failed" });

    // Try again starts a fresh, cold run.
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    expect(await resumes(running(mapId).id)).toBeNull();
  });

  test("the retry of a run that failed otherwise, or printed no result, starts cold", async () => {
    const mapId = await newMap(context, project, "Export data");
    const first = running(mapId);
    recordRunUsage(context.user, context.db, first.id, {
      ...OUT_OF_TURNS,
      resultSubtype: "error_during_execution",
    });
    failRun(context.user, context.db, first.id, MAX_TURNS_FAILURE);
    expect(await resumes(running(mapId).id)).toBeNull();

    const otherMapId = await newMap(context, project, "Import data");
    failRun(context.user, context.db, running(otherMapId).id, FAILURE);
    expect(await resumes(running(otherMapId).id)).toBeNull();
  });
});

describe("startup (S6a-13)", () => {
  test("each run left running ends failed with planning_run_interrupted and is retried", async () => {
    const first = await newMap(context, project, "One");
    const second = await newMap(context, project, "Two");
    const firstChart = runningMapRun(context, first);
    // The second map's first chart already failed once: its retry runs when ZeNorm stops.
    failRun(context.user, context.db, runningMapRun(context, second).id, FAILURE);
    const secondRetry = runningMapRun(context, second);

    sweepInterruptedRuns(context.db);

    expect(runsOf(context, first)).toMatchObject([
      { id: firstChart.id, state: "failed", errorCode: "planning_run_interrupted" },
      { purpose: "chart", state: "running", retryOfRunId: firstChart.id },
    ]);
    // An interrupted retry stops its scope: Try again, not a third attempt.
    expect(runsOf(context, second).at(-1)).toMatchObject({
      id: secondRetry.id,
      state: "failed",
      errorCode: "planning_run_interrupted",
    });
    expect(runsOf(context, second).filter((run) => run.state === "running")).toEqual([]);
  });

  test("an interrupted tickets_review is retried (S7c-10)", async () => {
    const { mapId, specificationId } = await draftedTicketSet(context, project);
    const review = runningSpecRun(context, mapId, "tickets_review");
    sweepInterruptedRuns(context.db);
    expect(runsOf(context, mapId).find((run) => run.id === review.id)).toMatchObject({
      state: "failed",
      errorCode: "planning_run_interrupted",
    });
    expect(runningSpecRun(context, mapId, "tickets_review")).toMatchObject({
      retryOfRunId: review.id,
      specificationId,
    });
  });

  test("Existing Records: an unapproved set with no review gets one at startup", async () => {
    const { mapId } = await unreviewedTicketSet(context, project);
    expect(runsOf(context, mapId).some((run) => run.state === "running")).toBe(false);
    sweepInterruptedRuns(context.db);
    expect(runningSpecRun(context, mapId, "tickets_review").retryOfRunId).toBeNull();
  });

  test("a second running run in one scope is refused by the index", async () => {
    const mapId = await newMap(context, project, "Export data");
    const chart = runningMapRun(context, mapId);
    let caught: unknown;
    try {
      writeTestData(context, (tx) =>
        tx
          .insert(planningRuns)
          .values({ ...chart, id: UNKNOWN_ID, purpose: "to_spec", userId: context.user.userId })
          .run(),
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(isUniqueConstraintViolation(caught)).toBe(true);
  });
});

describe("drafting from runs (D3, S6a-11)", () => {
  test("the spec draft request carries the reading, destination and map-level rounds, and no round", async () => {
    const mapId = await clearedMap(context, project);
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "to_spec") throw new Error("not a to_spec run");
    expect(work.value.request).toEqual({
      projectName: project.name,
      projectFolder: project.folderPath,
      baseBranch: "main",
      idea: "Export data",
      title: PROPOSAL.title,
      destination: NO_WAYPOINTS.destination,
      mapRounds: [{ questions: ROUND.questions, answers: ANSWERS, final: false }],
      waypoints: [],
      outOfScope: [],
      waits: [],
      survey: SURVEY,
      projectSpecs: [],
      specs: [],
      refusedAttempt: null,
    });
  });

  test("the spec draft request carries each resolved waypoint's number, kind, title, question, resolution and gist, and the Out of scope lines (S6b-11)", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CONFIRMATION);
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    resolve(context, mapId, 3);
    cleanPass(context, mapId);
    const chartRunId = waypointOf(context, mapId, 1).createdByRun;
    for (const [position, text] of [
      [2, "Exports to PDF are a later effort."],
      [1, "Imports are out of scope."],
    ] as const) {
      writeTestData(context, (tx) =>
        tx
          .insert(mapExclusions)
          .values({ mapId, position, text, waypointId: null, createdByRun: chartRunId })
          .run(),
      );
    }
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "to_spec") throw new Error("not a to_spec run");
    expect(work.value.request.outOfScope).toEqual([
      "Imports are out of scope.",
      "Exports to PDF are a later effort.",
    ]);
    expect(work.value.request.waypoints).toEqual(
      CONFIRMATION.waypoints.map((waypoint, index) => ({
        number: index + 1,
        kind: "grilling",
        title: waypoint.title,
        question: waypoint.question,
        resolution: `Resolved ${String(index + 1)}.`,
        gist: `Gist ${String(index + 1)}`,
        agentDecided: [],
        touches: [],
      })),
    );
  });

  test("the map's to_spec retries, stops and is tried again like any run (S6a-12)", async () => {
    const mapId = await clearedMap(context, project);
    failRun(context.user, context.db, runningMapRun(context, mapId).id, FAILURE);
    const retry = runningMapRun(context, mapId);
    expect(retry.purpose).toBe("to_spec");
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(runsOf(context, mapId).some((run) => run.state === "running")).toBe(false);
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [{ specNumber: null, content: SPEC }],
      waits: [],
    });
    expect(recorded.ok).toBe(true);
  });

  test("a spec-scoped run retries, stops and is tried again in its own scope (S7-19)", async () => {
    const { mapId, specificationId } = await draftedSpec(context, project);
    const review = runningSpecRun(context, mapId, "spec_review");
    failRun(context.user, context.db, review.id, FAILURE);
    const retry = runningSpecRun(context, mapId, "spec_review");
    expect(retry).toMatchObject({ retryOfRunId: review.id, specificationId });
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(runsOf(context, mapId).some((run) => run.state === "running")).toBe(false);
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    expect(runningSpecRun(context, mapId, "spec_review").specificationId).toBe(specificationId);
  });

  test("a tickets_review failing twice stops, and Try again restarts it (S7c-10)", async () => {
    const { mapId, specificationId } = await draftedTicketSet(context, project);
    const review = runningSpecRun(context, mapId, "tickets_review");
    failRun(context.user, context.db, review.id, FAILURE);
    const retry = runningSpecRun(context, mapId, "tickets_review");
    expect(retry).toMatchObject({ retryOfRunId: review.id, specificationId });
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(runsOf(context, mapId).some((run) => run.state === "running")).toBe(false);
    expect(tryAgain(context.user, context.db, retry.id)).toEqual({ ok: true, value: mapId });
    expect(runningSpecRun(context, mapId, "tickets_review").retryOfRunId).toBeNull();
  });

  test("the review and To Tickets requests carry the revision (D3)", async () => {
    const { mapId, specRevisionId } = await draftedSpec(context, project);
    const review = await prepareRun(context.db, runningSpecRun(context, mapId, "spec_review").id);
    if (!review.ok || review.value.purpose !== "spec_review") throw new Error("not a review");
    expect(review.value.request).toMatchObject({
      revision: { specNumber: 1, revision: 1, content: SPEC },
      before: null,
      otherSpecs: [],
    });
    const recorded = recordSpecReview(context.user, context.db, review.value.run.id, {
      summary: "Fine.",
      findings: [],
      verified: [],
    });
    expect(recorded.ok).toBe(true);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId }).ok).toBe(true);
    const tickets = await prepareRun(context.db, runningSpecRun(context, mapId, "to_tickets").id);
    if (!tickets.ok || tickets.value.purpose !== "to_tickets") throw new Error("not to_tickets");
    expect(tickets.value.request).toMatchObject({
      approved: { specNumber: 1, revision: 1, content: SPEC },
      rewrite: null,
    });
  });

  test("a project folder that is gone fails the attempt with project_folder_missing before the port", async () => {
    const mapId = await newMap(context, project, "Export data");
    await rm(project.folderPath, { recursive: true, force: true });
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    expect(!work.ok && work.error.code).toBe("project_folder_missing");
  });
});

describe("touches on charting (slice 8b S8b-2)", () => {
  /** Spec 1 r1 approved on a first map; a second map whose confirming chart is running. */
  async function chartingOnApprovedSpec(): Promise<{ mapId: string; specificationId: string }> {
    const { specificationId } = await draftedTicketSet(context, project);
    const mapId = await newMap(context, project, "Trim the exported rows");
    propose(context, mapId);
    answerDestination(context, mapId);
    return { mapId, specificationId };
  }

  function touching(...touches: ChartedWaypoint["touches"]): ChartConfirmation {
    const [first, ...rest] = CONFIRMATION.waypoints;
    if (first === undefined) throw new Error("CONFIRMATION has no waypoint");
    return { ...CONFIRMATION, waypoints: [{ ...first, touches }, ...rest] };
  }

  test("a valid touch is stored with its waypoint", async () => {
    const { mapId, specificationId } = await chartingOnApprovedSpec();
    confirm(context, mapId, touching({ specNumber: 1, revision: 1, criteria: ["1.2", "1.1"] }));
    expect(context.db.select().from(waypointTouches).all()).toEqual([
      {
        waypointId: waypointOf(context, mapId, 1).id,
        specificationId,
        revision: 1,
        criteria: ["1.2", "1.1"],
      },
    ]);
  });

  test.each([
    ["an unknown spec", { specNumber: 2, revision: 1, criteria: ["1.1"] }],
    ["another revision", { specNumber: 1, revision: 2, criteria: ["1.1"] }],
    ["an unknown criterion", { specNumber: 1, revision: 1, criteria: ["1.1", "1.3"] }],
  ])("refuses %s: touch_reference_unknown, no waypoint and no touch", async (_case, touch) => {
    const { mapId } = await chartingOnApprovedSpec();
    expectRefused(mapId, touching(touch));
  });

  test("refuses a spec named twice on one waypoint", async () => {
    const { mapId } = await chartingOnApprovedSpec();
    const touch = { specNumber: 1, revision: 1, criteria: ["1.1"] };
    expectRefused(mapId, touching(touch, { ...touch, criteria: ["1.2"] }));
  });

  test("touches the latest approved revision while another map's draft is latest (L213 D-5)", async () => {
    const { mapId, specificationId } = await chartingOnApprovedSpec();
    const holder = await clearedMap(context, project);
    const writer = insertRun(context, {
      mapId: holder,
      specificationId,
      purpose: "to_spec",
      state: "completed",
    });
    insertRevision(context, {
      specificationId,
      revision: 2,
      mapId: holder,
      writtenByRun: writer.id,
      content: SPEC,
    });
    expectRefused(mapId, touching({ specNumber: 1, revision: 2, criteria: ["1.1"] }));
    // The failed chart's retry runs; touching r1, the latest approved revision, saves.
    confirm(context, mapId, touching({ specNumber: 1, revision: 1, criteria: ["1.1"] }));
    expect(context.db.select().from(waypointTouches).all()).toEqual([
      {
        waypointId: waypointOf(context, mapId, 1).id,
        specificationId,
        revision: 1,
        criteria: ["1.1"],
      },
    ]);
  });

  test("refuses a spec with no approved revision", async () => {
    const other = await clearedMap(context, project);
    const specificationId = insertSpec(context, project.id, 1);
    const writer = insertRun(context, {
      mapId: other,
      specificationId,
      purpose: "to_spec",
      state: "completed",
    });
    insertRevision(context, {
      specificationId,
      revision: 1,
      mapId: other,
      writtenByRun: writer.id,
      content: SPEC,
    });
    const mapId = await newMap(context, project, "Trim the exported rows");
    propose(context, mapId);
    answerDestination(context, mapId);
    expectRefused(mapId, touching({ specNumber: 1, revision: 1, criteria: ["1.1"] }));
  });

  test("refuses a spec of another project", async () => {
    const other = await addProject(context, "other");
    const otherMap = await clearedMap(context, other);
    const specificationId = insertSpec(context, other.id, 1);
    const writer = insertRun(context, {
      mapId: otherMap,
      specificationId,
      purpose: "to_spec",
      state: "completed",
    });
    insertRevision(context, {
      specificationId,
      revision: 1,
      mapId: otherMap,
      writtenByRun: writer.id,
      content: SPEC,
      approvedAt: new Date().toISOString(),
    });
    const mapId = await newMap(context, project, "Trim the exported rows");
    propose(context, mapId);
    answerDestination(context, mapId);
    expectRefused(mapId, touching({ specNumber: 1, revision: 1, criteria: ["1.1"] }));
  });

  test("a touch never changes: a newer approved revision leaves it naming its own", async () => {
    const { mapId, specificationId } = await chartingOnApprovedSpec();
    confirm(context, mapId, touching({ specNumber: 1, revision: 1, criteria: ["1.1"] }));
    const stored = context.db.select().from(waypointTouches).all();
    resolve(context, mapId, 1);
    const writer = insertRun(context, {
      mapId,
      specificationId,
      purpose: "to_spec",
      state: "completed",
    });
    insertRevision(context, {
      specificationId,
      revision: 2,
      mapId,
      writtenByRun: writer.id,
      content: SPEC,
      approvedAt: new Date().toISOString(),
    });
    expect(waypointOf(context, mapId, 1).status).toBe("resolved");
    expect(context.db.select().from(waypointTouches).all()).toEqual(stored);
    expect(stored).toMatchObject([{ revision: 1, criteria: ["1.1"] }]);
  });

  function expectRefused(mapId: string, confirmation: ChartConfirmation): void {
    const chart = runningMapRun(context, mapId);
    const recorded = recordChart(context.user, context.db, chart.id, {
      kind: "confirmation",
      confirmation,
    });
    expect(!recorded.ok && recorded.error.code).toBe("touch_reference_unknown");
    expect(readWaypoints(context.db, mapId)).toEqual([]);
    expect(context.db.select().from(waypointTouches).all()).toEqual([]);
    expect(mapRow(mapId).destinationConfirmedAt).toBeNull();
    expect(runsOf(context, mapId).find((run) => run.id === chart.id)).toMatchObject({
      state: "failed",
      errorCode: "touch_reference_unknown",
    });
  }
});

describe("the destination's rounds reach every run that decides or checks scope (DR-14)", () => {
  /** Round 1 as `propose` and `answerDestination` store it. */
  const SUBMITTED = [{ questions: ROUND.questions, answers: ANSWERS, final: false }];

  async function prepared(runId: string) {
    const work = await prepareRun(context.db, runId);
    if (!work.ok) throw new Error(work.error.code);
    return work.value;
  }

  test("the grilling request", async () => {
    const mapId = await chartedMap(context, project);
    const work = await prepared(grillingRun(context, mapId, 1).id);
    if (work.purpose !== "grilling") throw new Error(work.purpose);
    expect(work.request.mapRounds).toEqual(SUBMITTED);
  });

  test("the consistency request", async () => {
    const mapId = await chartedMap(context, project);
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    resolve(context, mapId, 3);
    const work = await prepared(runningMapRun(context, mapId).id);
    if (work.purpose !== "consistency") throw new Error(work.purpose);
    expect(work.request.mapRounds).toEqual(SUBMITTED);
  });

  test("the To Spec request", async () => {
    const mapId = await clearedMap(context, project);
    const work = await prepared(runningMapRun(context, mapId).id);
    if (work.purpose !== "to_spec" || work.scope !== "map") throw new Error(work.purpose);
    expect(work.request.mapRounds).toEqual(SUBMITTED);
  });

  test("the repair's request", async () => {
    const { mapId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    const work = await prepared(runningSpecRun(context, mapId, "to_spec").id);
    if (work.purpose !== "to_spec" || work.scope !== "spec") throw new Error(work.purpose);
    expect(work.request.mapRounds).toEqual(SUBMITTED);
  });

  test("the spec review's request", async () => {
    const { mapId } = await draftedSpec(context, project);
    const work = await prepared(runningSpecRun(context, mapId, "spec_review").id);
    if (work.purpose !== "spec_review") throw new Error(work.purpose);
    expect(work.request.mapRounds).toEqual(SUBMITTED);
  });
});

describe("destination rounds: the chart's follow-up (DR-7 to DR-10)", () => {
  let mapId: string;

  beforeEach(async () => {
    mapId = await newMap(context, project, "Export data");
  });

  /** The map with round 1 answered, and follow-ups asked and answered up to round `last`. */
  function answeredThrough(last: number, finalAt: number | null): void {
    propose(context, mapId);
    answerMapRound(context, mapId, 1);
    for (let number = 2; number <= last; number += 1) {
      followUp(context, mapId, {
        ...FOLLOW_UP,
        round: { ...FOLLOW_UP.round, final: number === finalAt },
      });
      answerMapRound(context, mapId, number);
    }
  }

  function mapLevelRounds() {
    return readRounds(context.db, mapId).filter((round) => round.waypointId === null);
  }

  test("the first chart's round is stored not final (DR-9)", () => {
    propose(context, mapId);
    expect(mapLevelRounds()).toMatchObject([{ number: 1, final: false }]);
  });

  test("a follow-up replaces the map's reading and asks round 2, pending; the run ends asked (DR-7)", () => {
    answeredThrough(1, null);
    const chart = runningMapRun(context, mapId);
    const content = { ...FOLLOW_UP, round: { ...FOLLOW_UP.round, final: true } };
    followUp(context, mapId, content);

    expect(mapRow(mapId)).toMatchObject({
      title: FOLLOW_UP.title,
      summary: FOLLOW_UP.summary,
      destination: FOLLOW_UP.destination,
      destinationConfirmedAt: null,
    });
    expect(mapLevelRounds()).toMatchObject([
      { number: 1, status: "submitted", final: false },
      {
        number: 2,
        final: true,
        status: "pending",
        askedByRun: chart.id,
        intro: FOLLOW_UP.round.intro,
        questions: FOLLOW_UP.round.questions,
        answers: null,
        submittedAt: null,
      },
    ]);
    expect(runsOf(context, mapId)).toMatchObject([
      { purpose: "chart", state: "asked" },
      { id: chart.id, state: "asked" },
    ]);
    // Nothing runs while round 2 is pending.
    expect(runsOf(context, mapId).filter((run) => run.state === "running")).toEqual([]);
  });

  test("after round 2 is submitted a chart is due and starts, seeing the follow-up's reading (DR-10, DR-3)", async () => {
    answeredThrough(2, null);
    const chart = runningMapRun(context, mapId);
    expect(chart.purpose).toBe("chart");
    const work = await prepareRun(context.db, chart.id);
    if (!work.ok || work.value.purpose !== "chart") throw new Error("not a chart");
    expect(work.value.request.mapRounds).toEqual([
      { questions: ROUND.questions, answers: ANSWERS, final: false },
      { questions: FOLLOW_UP.round.questions, answers: ANSWERS, final: false },
    ]);
    expect(work.value.request.proposed).toEqual({
      title: FOLLOW_UP.title,
      summary: FOLLOW_UP.summary,
      destination: FOLLOW_UP.destination,
    });
  });

  test.each([
    ["a proposal after round 1", 1, null, "proposal"],
    ["a follow-up with no round yet", 0, null, "followUp"],
    ["a follow-up after a final round 2", 2, 2, "followUp"],
    ["a follow-up after three rounds", 3, null, "followUp"],
    ["a follow-up after a final round 3", 3, 3, "followUp"],
    ["a confirmation with no round yet", 0, null, "confirmation"],
  ] as const)(
    "refuses %s with agent_output_invalid, writing nothing but the failed run; the retry carries the problem (DR-8)",
    async (_case, last, finalAt, kind) => {
      if (last > 0) answeredThrough(last, finalAt);
      const chart = runningMapRun(context, mapId);
      const before = mapRow(mapId);
      const roundsBefore = mapLevelRounds();
      const counts = rowCounts();
      const outcome =
        kind === "proposal"
          ? { kind, proposal: PROPOSAL }
          : kind === "followUp"
            ? { kind, followUp: FOLLOW_UP }
            : { kind, confirmation: NO_WAYPOINTS };
      const recorded = recordChart(context.user, context.db, chart.id, outcome);

      expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
      expect(mapRow(mapId)).toEqual(before);
      expect(mapLevelRounds()).toEqual(roundsBefore);
      // The failed run's retry is the only other row (S6a-12).
      expect(rowCounts()).toEqual({ ...counts, runs: counts.runs + 1 });
      const runs = runsOf(context, mapId);
      expect(runs.find((run) => run.id === chart.id)).toMatchObject({
        state: "failed",
        errorCode: "agent_output_invalid",
      });
      const retry = runningMapRun(context, mapId);
      expect(retry).toMatchObject({ purpose: "chart", state: "running", retryOfRunId: chart.id });
      expect(runs.at(-1)?.id).toBe(retry.id);
      const work = await prepareRun(context.db, retry.id);
      if (!work.ok || work.value.purpose !== "chart") throw new Error("not a chart");
      expect(work.value.request.refusedAttempt).not.toBeNull();
    },
  );

  test("a chart run started by Try again after an agent_output_invalid retry carries its problem (DR-8)", async () => {
    answeredThrough(1, null);
    const chart = runningMapRun(context, mapId);
    const proposal = { kind: "proposal", proposal: PROPOSAL } as const;
    const first = recordChart(context.user, context.db, chart.id, proposal);
    expect(!first.ok && first.error.code).toBe("agent_output_invalid");
    const retry = runningMapRun(context, mapId);
    expect(retry.retryOfRunId).toBe(chart.id);
    const second = recordChart(context.user, context.db, retry.id, proposal);
    expect(!second.ok && second.error.code).toBe("agent_output_invalid");
    const failedRetry = runsOf(context, mapId).find((run) => run.id === retry.id);
    expect(failedRetry).toMatchObject({
      state: "failed",
      errorCode: "agent_output_invalid",
    });
    expect(typeof failedRetry?.errorMessage).toBe("string");

    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const fresh = runningMapRun(context, mapId);
    expect(fresh).toMatchObject({ purpose: "chart", state: "running" });
    expect(fresh.id).not.toBe(retry.id);
    const work = await prepareRun(context.db, fresh.id);
    if (!work.ok || work.value.purpose !== "chart") throw new Error("not a chart");
    expect(work.value.request.refusedAttempt?.problem).toBe(failedRetry?.errorMessage);
  });

  test("a chart after a run that core did not refuse carries no refused attempt (DR-8)", async () => {
    const first = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!first.ok || first.value.purpose !== "chart") throw new Error("not a chart");
    expect(first.value.request.refusedAttempt).toBeNull();
    answeredThrough(2, null);
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "chart") throw new Error("not a chart");
    expect(work.value.request.refusedAttempt).toBeNull();
  });

  test.each([
    ["at choose", 1, null],
    ["at confirm", 2, 2],
  ])(
    "a confirmation %s stores its title, summary and destination (DR-8, L253)",
    (_case, last, finalAt) => {
      answeredThrough(last, finalAt);
      const stored = mapRow(mapId);
      const confirmation = {
        ...NO_WAYPOINTS,
        title: "Record export",
        summary: "People take every record elsewhere as CSV.",
        destination: "A CSV export of every record, from the project page.",
      };
      expect([stored.title, stored.summary, stored.destination]).not.toContain(confirmation.title);
      expect(stored.summary).not.toBe(confirmation.summary);
      expect(stored.destination).not.toBe(confirmation.destination);
      confirmChart(context, mapId, confirmation);
      expect(mapRow(mapId)).toMatchObject({
        title: confirmation.title,
        summary: confirmation.summary,
        destination: confirmation.destination,
      });
    },
  );

  test.each([
    ["after a final round 2", 2, 2],
    ["after round 3", 3, null],
  ])("saves a confirmation %s", (_case, last, finalAt) => {
    answeredThrough(last, finalAt);
    confirmChart(context, mapId, NO_WAYPOINTS);
    expect(mapRow(mapId)).toMatchObject({ destination: NO_WAYPOINTS.destination });
    expect(mapRow(mapId).destinationConfirmedAt).not.toBeNull();
  });
});
