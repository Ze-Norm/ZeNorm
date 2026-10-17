import { SubmitAnswersInput } from "@zenorm/contracts";
import type {
  GrillOutcome,
  MapChanges,
  PlanningRun,
  Project,
  Waypoint,
  WaypointKind,
} from "@zenorm/contracts";
import {
  consistencyFindings,
  consistencyPasses,
  isUniqueConstraintViolation,
  mapExclusions,
  mapFog,
  maps,
  planningRuns,
  questionRounds,
  waypointBlockers,
  waypoints as waypointRows,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { submitAnswers } from "./map.ts";
import { getMapOverview } from "./map-overview.ts";
import {
  failRun,
  frontier,
  isCleared,
  planNext,
  readRounds,
  readWaypoints,
  recordGrill,
  sweepInterruptedRuns,
  tryAgain,
  waypointState,
} from "./planning-runs.ts";
import type { RunOutcomes } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { readPasses } from "./wayfinding-records.ts";
import {
  addProject,
  ANSWERS,
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
  ROUND,
  runningMapRun,
  runsOf,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;
let mapId: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-grilling-");
  project = await addProject(context, "repo");
  mapId = await chartedMap(context, project);
});

afterEach(async () => {
  await closeTestContext(context);
});

const FAILURE = { code: "agent_run_failed", message: "The run failed." } as const;

/** The runs of waypoint `number`'s scope, oldest first. */
function waypointRuns(number: number): PlanningRun[] {
  const { id } = waypointOf(context, mapId, number);
  return runsOf(context, mapId).filter((run) => run.waypointId === id);
}

/** Fails waypoint `number`'s running run and then its retry: the scope stops. */
function stopWaypoint(number: number): PlanningRun {
  failRun(context.user, context.db, grillingRun(context, mapId, number).id, FAILURE);
  const retry = grillingRun(context, mapId, number);
  failRun(context.user, context.db, retry.id, FAILURE);
  return retry;
}

async function overview() {
  const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("the frontier and claims", () => {
  test("confirming claims each unblocked waypoint with one grilling run; blocked ones wait", () => {
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed" });
    expect(waypointOf(context, mapId, 1).claimedAt).not.toBeNull();
    expect(waypointRuns(1)).toMatchObject([
      { purpose: "grilling", state: "running", retryOfRunId: null },
    ]);
    for (const number of [2, 3]) {
      expect(waypointOf(context, mapId, number)).toMatchObject({ status: "open", claimedAt: null });
      expect(waypointRuns(number)).toEqual([]);
    }
  });

  test("resolving a blocker claims the waypoints it unblocks, each with one run, in that write", () => {
    resolve(context, mapId, 1);
    for (const number of [2, 3]) {
      expect(waypointOf(context, mapId, number)).toMatchObject({ status: "claimed" });
      expect(waypointRuns(number)).toMatchObject([{ purpose: "grilling", state: "running" }]);
    }
  });

  test("a waypoint released by a failed retry stays off the frontier until tryAgain claims it", () => {
    const retry = stopWaypoint(1);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "open" });
    // A later write on the map does not claim it again.
    sweepInterruptedRuns(context.db);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "open" });
    expect(waypointRuns(1).filter((run) => run.state === "running")).toEqual([]);

    const tried = tryAgain(context.user, context.db, retry.id);
    if (!tried.ok) throw new Error(tried.error.code);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed" });
    expect(waypointRuns(1).at(-1)).toMatchObject({ state: "running", retryOfRunId: null });
    expect(waypointRuns(1).filter((run) => run.state === "running")).toHaveLength(1);
  });

  describe("each rule, on the derived frontier", () => {
    const AT = "2026-10-07T12:00:00.000Z";
    const MAP = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e70";
    const IDS = [
      "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e81",
      "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e82",
    ] as const;
    const RUN_A = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e91";
    const RUN_B = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e92";
    const RUN_C = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e90";

    function stored(number: 1 | 2, status: Waypoint["status"]): Waypoint {
      return {
        id: number === 1 ? IDS[0] : IDS[1],
        mapId: MAP,
        number,
        kind: "grilling",
        status,
        title: `Waypoint ${String(number)}`,
        question: "Which?",
        claimedAt: null,
        resolution: status === "resolved" ? "Done." : null,
        gist: status === "resolved" ? "Done" : null,
        agentDecided: status === "resolved" ? [] : null,
        resolvedAt: status === "resolved" ? AT : null,
        resolvedHow: status === "resolved" ? "run" : null,
        resolvedByRun: status === "resolved" ? RUN_A : null,
        createdByRun: RUN_A,
        hatchMessageId: null,
        personDecides: false,
      };
    }

    function run(id: string, fields: Partial<PlanningRun>): PlanningRun {
      return {
        id,
        mapId: MAP,
        waypointId: IDS[1],
        specificationId: null,
        purpose: "grilling",
        state: "failed",
        retryOfRunId: null,
        errorCode: "agent_run_failed",
        errorMessage: "Failed",
        cancelReason: null,
        hatchMessageId: null,
        startedAt: AT,
        endedAt: AT,
        ...fields,
      };
    }

    const confirmed = { destinationConfirmedAt: AT };
    const none = { reports: [], taskOutcomes: [] };
    const blocked = [{ waypointNumber: 2, blockerNumber: 1 }];
    const numbers = (waypoints: readonly Waypoint[]) => waypoints.map((w) => w.number);
    const frontierOf = (
      map: { destinationConfirmedAt: string | null },
      waypoints: readonly Waypoint[],
      blockers: readonly { waypointNumber: number; blockerNumber: number }[],
      runs: readonly PlanningRun[],
      outcomes: RunOutcomes,
    ) => frontier({ map, waypoints, blockers, runs, outcomes });

    test("an unconfirmed destination has no frontier", () => {
      expect(
        frontierOf({ destinationConfirmedAt: null }, [stored(1, "open")], [], [], none),
      ).toEqual([]);
    });

    // The confirmed chart's completed code survey.
    const surveyed = [
      run(RUN_C, {
        waypointId: null,
        purpose: "survey",
        state: "completed",
        errorCode: null,
        errorMessage: null,
      }),
    ];

    test("a map waiting on its code survey has no frontier", () => {
      expect(numbers(frontierOf(confirmed, [stored(1, "open")], [], [], none))).toEqual([]);
      const surveying = [
        run(RUN_C, {
          waypointId: null,
          purpose: "survey",
          state: "running",
          errorCode: null,
          errorMessage: null,
          endedAt: null,
        }),
      ];
      expect(numbers(frontierOf(confirmed, [stored(1, "open")], [], surveying, none))).toEqual([]);
      expect(numbers(frontierOf(confirmed, [stored(1, "open")], [], surveyed, none))).toEqual([1]);
    });

    test("an open waypoint with a blocker not yet resolved is off; resolved or out of scope frees it", () => {
      const open2 = stored(2, "open");
      expect(
        numbers(frontierOf(confirmed, [stored(1, "claimed"), open2], blocked, surveyed, none)),
      ).toEqual([]);
      expect(
        numbers(frontierOf(confirmed, [stored(1, "resolved"), open2], blocked, surveyed, none)),
      ).toEqual([2]);
      expect(
        numbers(frontierOf(confirmed, [stored(1, "out_of_scope"), open2], blocked, surveyed, none)),
      ).toEqual([2]);
    });

    test("only open waypoints are on it", () => {
      expect(
        numbers(
          frontierOf(confirmed, [stored(1, "claimed"), stored(2, "resolved")], [], surveyed, none),
        ),
      ).toEqual([]);
    });

    test("a failed retry excludes; a failed first attempt or a completed run does not", () => {
      const waypoints = [stored(1, "resolved"), stored(2, "open")];
      const firstAttempt = run(RUN_A, {});
      const failedRetry = run(RUN_B, { retryOfRunId: RUN_A });
      expect(
        numbers(frontierOf(confirmed, waypoints, blocked, [firstAttempt, failedRetry], none)),
      ).toEqual([]);
      expect(numbers(frontierOf(confirmed, waypoints, blocked, [firstAttempt], none))).toEqual([2]);
      const completed = run(RUN_A, { state: "completed", errorCode: null, errorMessage: null });
      expect(numbers(frontierOf(confirmed, waypoints, blocked, [completed], none))).toEqual([2]);
    });

    describe("a waypoint's state names what holds it off the frontier", () => {
      const noRounds: { waypointId: string | null; status: "pending" | "submitted" }[] = [];
      const stateOf = (
        map: { destinationConfirmedAt: string | null },
        waypoints: readonly Waypoint[],
        runs: readonly PlanningRun[],
        rounds: readonly { waypointId: string | null; status: "pending" | "submitted" }[],
        number: 1 | 2,
      ) => {
        const waypoint = waypoints.find((w) => w.number === number);
        if (waypoint === undefined) throw new Error(`No waypoint ${String(number)}`);
        return waypointState(
          { map, waypoints, blockers: blocked, runs, outcomes: none },
          rounds,
          waypoint,
        );
      };

      test("while the map waits on its code survey, a ready waypoint waits on the survey; a blocked one on its blockers", () => {
        const waypoints = [stored(1, "open"), stored(2, "open")];
        expect(stateOf(confirmed, waypoints, [], noRounds, 1)).toEqual({ kind: "waits_on_survey" });
        expect(stateOf(confirmed, waypoints, [], noRounds, 2)).toEqual({
          kind: "blocked",
          waitsOn: [1],
        });
      });

      test("a stopped scope, a running run and a pending round each name themselves", () => {
        const waypoints = [stored(1, "resolved"), stored(2, "open")];
        const failedRetry = run(RUN_B, { retryOfRunId: RUN_A });
        expect(
          stateOf(confirmed, waypoints, [...surveyed, run(RUN_A, {}), failedRetry], noRounds, 2),
        ).toEqual({ kind: "stopped", run: { runId: RUN_B, code: "agent_run_failed" } });
        const claimed = [stored(1, "resolved"), stored(2, "claimed")];
        const running = run(RUN_A, {
          state: "running",
          errorCode: null,
          errorMessage: null,
          endedAt: null,
        });
        expect(stateOf(confirmed, claimed, [...surveyed, running], noRounds, 2)).toEqual({
          kind: "working",
        });
        const asked = run(RUN_A, { state: "asked", errorCode: null, errorMessage: null });
        expect(
          stateOf(
            confirmed,
            claimed,
            [...surveyed, asked],
            [{ waypointId: IDS[1], status: "pending" }],
            2,
          ),
        ).toEqual({ kind: "waiting_on_you" });
        expect(stateOf(confirmed, [stored(1, "resolved")], surveyed, noRounds, 1)).toEqual({
          kind: "resolved",
        });
      });

      test("a waypoint on the frontier but unclaimed, claimed with nothing in motion, or on an unconfirmed map is a programmer error", () => {
        const ready = [stored(1, "resolved"), stored(2, "open")];
        expect(() => stateOf(confirmed, ready, surveyed, noRounds, 2)).toThrow();
        const idle = [stored(1, "resolved"), stored(2, "claimed")];
        expect(() => stateOf(confirmed, idle, surveyed, noRounds, 2)).toThrow();
        expect(() =>
          stateOf({ destinationConfirmedAt: null }, [stored(1, "open")], [], noRounds, 1),
        ).toThrow();
      });
    });
  });
});

describe("grilling runs and rounds", () => {
  test("the request carries the waypoint, its answered rounds, the others and their pending rounds", async () => {
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    const work = await prepareRun(context.db, grillingRun(context, mapId, 1).id);
    if (!work.ok || work.value.purpose !== "grilling") throw new Error("not a grilling run");
    expect(work.value.request).toMatchObject({
      // The map-level rounds, as the chart reads them: the person's answers bind every waypoint.
      mapRounds: [{ questions: ROUND.questions, answers: ANSWERS, final: false }],
      waypoint: {
        number: 1,
        title: CONFIRMATION.waypoints[0]?.title,
        rounds: [{ questions: ROUND.questions, answers: PLAIN_ANSWERS, final: false }],
      },
      otherWaypoints: [
        { title: CONFIRMATION.waypoints[1]?.title, status: "open", gist: null },
        { title: CONFIRMATION.waypoints[2]?.title, status: "open", gist: null },
      ],
      otherPendingRounds: [],
      afterFinal: false,
    });

    resolve(context, mapId, 1);
    ask(context, mapId, 2, true);
    const third = await prepareRun(context.db, grillingRun(context, mapId, 3).id);
    if (!third.ok || third.value.purpose !== "grilling") throw new Error("not a grilling run");
    expect(third.value.request.otherPendingRounds).toEqual([
      { waypointTitle: CONFIRMATION.waypoints[1]?.title, questions: ROUND.questions },
    ]);
    expect(third.value.request.otherWaypoints[0]).toMatchObject({
      status: "resolved",
      gist: "Gist 1",
    });
  });

  test("a run asks a round, numbered from 1 per waypoint, and ends asked", () => {
    const first = grillingRun(context, mapId, 1);
    ask(context, mapId, 1, false);
    expect(runsOf(context, mapId).find((run) => run.id === first.id)).toMatchObject({
      state: "asked",
    });
    answer(context, mapId, 1, PLAIN_ANSWERS);
    ask(context, mapId, 1, true);
    const { id } = waypointOf(context, mapId, 1);
    const rounds = readRounds(context.db, mapId).filter((round) => round.waypointId === id);
    expect(rounds.map((round) => [round.number, round.final, round.status])).toEqual([
      [1, false, "submitted"],
      [2, true, "pending"],
    ]);
  });

  test("a run resolves its waypoint with no round asked (the agent decided it): resolved_how run, resolved_by_run set, run completed", () => {
    const run = grillingRun(context, mapId, 1);
    const { id } = waypointOf(context, mapId, 1);
    expect(readRounds(context.db, mapId).filter((round) => round.waypointId === id)).toEqual([]);
    const recorded = recordGrill(context.user, context.db, run.id, {
      round: null,
      resolution: {
        resolution: "Resolved 1: CSV, since the repository writes CSV elsewhere.",
        gist: "CSV",
        agentDecided: ["CSV, as the repository writes elsewhere"],
      },
      outOfScope: null,
      mapChanges: NO_MAP_CHANGES,
    });
    expect(recorded.ok).toBe(true);
    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "resolved",
      resolution: "Resolved 1: CSV, since the repository writes CSV elsewhere.",
      gist: "CSV",
      agentDecided: ["CSV, as the repository writes elsewhere"],
      resolvedHow: "run",
      resolvedByRun: run.id,
    });
    expect(runsOf(context, mapId).find((r) => r.id === run.id)).toMatchObject({
      state: "completed",
    });
  });

  test("a second pending round on one waypoint is refused by the index", () => {
    ask(context, mapId, 1, false);
    const pending = readRounds(context.db, mapId).find((round) => round.status === "pending");
    if (pending === undefined) throw new Error("no pending round");
    let caught: unknown;
    try {
      writeTestData(context, (tx) =>
        tx
          .insert(questionRounds)
          .values({ ...pending, id: uuidv7(), number: 2 })
          .run(),
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(isUniqueConstraintViolation(caught)).toBe(true);
  });
});

describe("the grilling request's kind, fog and scope fields", () => {
  test("carries the waypoint's kind, the others' numbers and kinds, the fog, the Out of scope lines and the finding", async () => {
    resolve(context, mapId, 1);
    const [one, two] = [1, 2].map((number) => waypointOf(context, mapId, number));
    if (one === undefined || two === undefined) throw new Error("Missing waypoints");
    const chartRunId = one.createdByRun;
    writeTestData(context, (tx) =>
      tx
        .insert(mapFog)
        .values({ mapId, position: 3, text: "Who may export.", createdByRun: chartRunId })
        .run(),
    );
    writeTestData(context, (tx) =>
      tx
        .insert(mapExclusions)
        .values({
          mapId,
          position: 1,
          text: "Imports.",
          waypointId: null,
          createdByRun: chartRunId,
        })
        .run(),
    );
    const passRunId = uuidv7();
    const at = new Date().toISOString();
    writeTestData(context, (tx) =>
      tx
        .insert(planningRuns)
        .values({
          userId: context.user.userId,
          id: passRunId,
          mapId,
          waypointId: null,
          purpose: "consistency",
          state: "completed",
          retryOfRunId: null,
          errorCode: null,
          errorMessage: null,
          startedAt: at,
          endedAt: at,
        })
        .run(),
    );
    const passId = uuidv7();
    writeTestData(context, (tx) =>
      tx
        .insert(consistencyPasses)
        .values({ id: passId, mapId, runId: passRunId, compared: [] })
        .run(),
    );
    writeTestData(context, (tx) =>
      tx
        .insert(consistencyFindings)
        .values({
          createdWaypointId: two.id,
          passId,
          kind: "conflicting_surfaces",
          waypointNumbers: [1],
          title: two.title,
          explanation: "Waypoint 1 writes CSV.",
          question: two.question,
        })
        .run(),
    );

    const work = await prepareRun(context.db, grillingRun(context, mapId, 2).id);
    if (!work.ok || work.value.purpose !== "grilling") throw new Error("not a grilling run");
    expect(work.value.request).toMatchObject({
      waypoint: { number: 2, kind: "grilling" },
      otherWaypoints: [
        { number: 1, kind: "grilling", status: "resolved", gist: "Gist 1", agentDecided: [] },
        { number: 3, kind: "grilling", status: "claimed", gist: null },
      ],
      fog: [{ position: 3, text: "Who may export." }],
      outOfScope: ["Imports."],
      finding: {
        kind: "conflicting_surfaces",
        explanation: "Waypoint 1 writes CSV.",
        waypoints: [{ number: 1, title: one.title, resolution: "Resolved 1." }],
      },
    });
    const third = await prepareRun(context.db, grillingRun(context, mapId, 3).id);
    if (!third.ok || third.value.purpose !== "grilling") throw new Error("not a grilling run");
    expect(third.value.request.finding).toBeNull();
  });
});

describe("map changes, out-of-scope rulings and the fog check", () => {
  const resolution = { resolution: "Decided.", gist: "Decided", agentDecided: [] };

  /** A new waypoint of the run's map changes. */
  function created(blockedBy: number[], fromFog: number | null, kind: WaypointKind = "grilling") {
    return { kind, title: "Another", question: "What else?", blockedBy, fromFog };
  }

  /** Waypoint `number`'s resolving outcome with `changes`. */
  function resolving(changes: Partial<MapChanges>): GrillOutcome {
    return {
      round: null,
      resolution,
      outOfScope: null,
      mapChanges: { ...NO_MAP_CHANGES, ...changes },
    };
  }

  /** Everything a refused output must leave as it was. */
  function mapState() {
    return {
      waypoints: readWaypoints(context.db, mapId),
      blockers: context.db.select().from(waypointBlockers).all(),
      fog: context.db.select().from(mapFog).all(),
      exclusions: context.db.select().from(mapExclusions).all(),
      map: context.db.select().from(maps).where(eq(maps.id, mapId)).get(),
    };
  }

  /** Records `outcome` on waypoint `number`'s run and expects it refused `code`, writing nothing. */
  function expectRefused(number: number, outcome: GrillOutcome, code: string) {
    const run = grillingRun(context, mapId, number);
    const before = mapState();
    const recorded = recordGrill(context.user, context.db, run.id, outcome);
    expect(!recorded.ok && recorded.error.code).toBe(code);
    expect(mapState()).toEqual(before);
    const runs = waypointRuns(number);
    expect(runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      state: "failed",
      errorCode: code,
    });
    // The failure's transaction inserts its retry.
    expect(runs.at(-1)).toMatchObject({ state: "running", retryOfRunId: run.id });
  }

  beforeEach(async () => {
    // A map charted with two fog items: waypoint 1 claimed, 2 and 3 blocked by it.
    mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, { ...CONFIRMATION, fog: ["Fog 1.", "Fog 2."] });
  });

  test("applies map changes in the outcome's transaction; new Grilling waypoints join the frontier", () => {
    const run = grillingRun(context, mapId, 1);
    const recorded = recordGrill(
      context.user,
      context.db,
      run.id,
      resolving({
        newWaypoints: [created([1, 3], 1), created([], null, "research"), created([1], null)],
        fogOutOfScope: [{ position: 2, line: "Fog 2 is a later effort." }],
        fogDecided: [],
        fogSettledHere: [],
        newFog: ["Fog 3."],
      }),
    );
    expect(recorded.ok).toBe(true);
    expect(readWaypoints(context.db, mapId)).toMatchObject([
      { number: 1, status: "resolved" },
      { number: 2, status: "claimed" },
      { number: 3, status: "claimed" },
      // Blocked by 3, still unresolved.
      { number: 4, kind: "grilling", status: "open", createdByRun: run.id },
      // Unblocked: claimed with a research run.
      { number: 5, kind: "research", status: "claimed", createdByRun: run.id },
      // Blocked only by the resolved waypoint 1: on the frontier at once.
      { number: 6, kind: "grilling", status: "claimed", createdByRun: run.id },
    ]);
    expect(waypointRuns(6)).toMatchObject([{ purpose: "grilling", state: "running" }]);
    expect(
      context.db
        .select({ w: waypointBlockers.waypointNumber, b: waypointBlockers.blockerNumber })
        .from(waypointBlockers)
        .all()
        .filter((row) => row.w > 3),
    ).toEqual([
      { w: 4, b: 1 },
      { w: 4, b: 3 },
      { w: 6, b: 1 },
    ]);
    expect(context.db.select().from(mapFog).all()).toEqual([
      { mapId, position: 3, text: "Fog 3.", createdByRun: run.id },
    ]);
    expect(context.db.select().from(maps).where(eq(maps.id, mapId)).get()?.fogNextPosition).toBe(4);
    expect(context.db.select().from(mapExclusions).all()).toEqual([
      {
        mapId,
        position: 1,
        text: "Fog 2 is a later effort.",
        waypointId: null,
        createdByRun: run.id,
        splitMapId: null,
      },
    ]);
  });

  test.each([
    [
      "an unknown blocker",
      resolving({ newWaypoints: [created([9], null)] }),
      "waypoint_blocker_unknown",
    ],
    [
      "a blocker naming another new waypoint",
      resolving({ newWaypoints: [created([], null), created([4], null)] }),
      "waypoint_blocker_unknown",
    ],
    ["an unknown fog position", resolving({ newWaypoints: [created([], 7)] }), "fog_item_unknown"],
    [
      "a fog position graduated twice",
      resolving({ newWaypoints: [created([], 1), created([], 1)] }),
      "fog_item_unknown",
    ],
    [
      "a fog position both graduated and moved out of scope",
      resolving({
        newWaypoints: [created([], 1)],
        fogOutOfScope: [{ position: 1, line: "Later." }],
      }),
      "fog_item_unknown",
    ],
    [
      "a fog position moved out of scope twice",
      resolving({
        fogOutOfScope: [
          { position: 2, line: "Later." },
          { position: 2, line: "Later still." },
        ],
      }),
      "fog_item_unknown",
    ],
  ])("refuses %s with its code, writes nothing and fails the run", (_case, outcome, code) => {
    expectRefused(1, outcome, code);
  });

  test("refuses a stale fog position: positions are never reused", () => {
    resolve(context, mapId, 1);
    const graduated = recordGrill(
      context.user,
      context.db,
      grillingRun(context, mapId, 2).id,
      resolving({
        newWaypoints: [created([], 2)],
        fogDecided: [],
        fogSettledHere: [],
        newFog: ["Fog 3."],
      }),
    );
    expect(graduated.ok).toBe(true);
    expect(
      context.db
        .select()
        .from(mapFog)
        .all()
        .map((item) => item.position),
    ).toEqual([1, 3]);
    expectRefused(
      3,
      resolving({ fogOutOfScope: [{ position: 2, line: "Later." }] }),
      "fog_item_unknown",
    );
  });

  test("a ruling sets out_of_scope, saves the linked line, and the waypoint is not resolved", async () => {
    const run = grillingRun(context, mapId, 1);
    const recorded = recordGrill(context.user, context.db, run.id, {
      round: null,
      resolution: null,
      outOfScope: { reason: "Columns are fixed by the importer." },
      mapChanges: NO_MAP_CHANGES,
    });
    expect(recorded.ok).toBe(true);
    const one = waypointOf(context, mapId, 1);
    expect(one).toMatchObject({ status: "out_of_scope", resolution: null, resolvedAt: null });
    expect(context.db.select().from(mapExclusions).all()).toEqual([
      {
        mapId,
        position: 1,
        text: "Columns are fixed by the importer.",
        waypointId: one.id,
        createdByRun: run.id,
        splitMapId: null,
      },
    ]);
    expect(waypointRuns(1).at(-1)).toMatchObject({ id: run.id, state: "completed" });
    // An out-of-scope blocker settles its dependants.
    expect(waypointOf(context, mapId, 2)).toMatchObject({ status: "claimed" });
    const value = await overview();
    expect(value.wayfinding.outOfScope).toEqual([
      { text: "Columns are fixed by the importer.", waypoint: 1, splitMapId: null },
    ]);
    expect(value.wayfinding.waypoints.filter((waypoint) => waypoint.status === "resolved")).toEqual(
      [],
    );
  });

  describe("the last unsettled waypoint", () => {
    beforeEach(() => {
      resolve(context, mapId, 1);
      // Not the last: waypoint 3 is still claimed, so leaving the fog is accepted.
      resolve(context, mapId, 2);
    });

    // Harness change #4: no waypoint run settles fog it does not own; the map's fog run does.
    test.each([
      ["a resolution leaving fog", resolving({})],
      [
        "an out-of-scope ruling leaving fog",
        {
          round: null,
          resolution: null,
          outOfScope: { reason: "Later." },
          mapChanges: NO_MAP_CHANGES,
        },
      ],
      [
        "one leaving a fog item while adding another",
        resolving({
          fogOutOfScope: [
            { position: 1, line: "Later." },
            { position: 2, line: "Later." },
          ],
          newFog: ["Fog 3."],
        }),
      ],
      [
        "one deciding one fog item and leaving the other",
        resolving({
          fogDecided: [
            {
              position: 1,
              title: "Settled",
              resolution: "Decided by the agent.",
              gist: "Settled",
            },
          ],
        }),
      ],
    ] satisfies [string, GrillOutcome][])(
      "%s is accepted, and the map's fog run starts",
      (_, outcome) => {
        const recorded = recordGrill(
          context.user,
          context.db,
          grillingRun(context, mapId, 3).id,
          outcome,
        );
        expect(recorded.ok).toBe(true);
        expect(context.db.select().from(mapFog).all()).not.toEqual([]);
        expect(runningMapRun(context, mapId)).toMatchObject({ purpose: "fog", waypointId: null });
      },
    );

    test("one graduating a fog item and excluding the other is accepted", () => {
      const recorded = recordGrill(
        context.user,
        context.db,
        grillingRun(context, mapId, 3).id,
        resolving({
          newWaypoints: [created([], 1)],
          fogOutOfScope: [{ position: 2, line: "Later." }],
        }),
      );
      expect(recorded.ok).toBe(true);
      expect(context.db.select().from(mapFog).all()).toEqual([]);
      expect(waypointOf(context, mapId, 4)).toMatchObject({ status: "claimed" });
    });

    test("the deadlock case: the last run decides implementation fog itself, and the map clears without the person", async () => {
      // Both fog items are in-scope mechanics: no waypoint and no Out of scope line fits them.
      const run = grillingRun(context, mapId, 3);
      const recorded = recordGrill(
        context.user,
        context.db,
        run.id,
        resolving({
          fogDecided: [
            {
              position: 1,
              title: "Fog 1 settled",
              resolution: "Decided by the agent: fog 1 follows the existing pattern.",
              gist: "Fog 1 follows the existing pattern",
            },
            {
              position: 2,
              title: "Fog 2 settled",
              resolution: "Decided by the agent: fog 2 is derived.",
              gist: "Fog 2 is derived",
            },
          ],
        }),
      );
      expect(recorded.ok).toBe(true);
      expect(context.db.select().from(mapFog).all()).toEqual([]);
      // Each decision is a waypoint resolved by the run, its question the fog item's text.
      expect(readWaypoints(context.db, mapId).slice(3)).toMatchObject([
        {
          number: 4,
          kind: "grilling",
          status: "resolved",
          title: "Fog 1 settled",
          question: "Fog 1.",
          gist: "Fog 1 follows the existing pattern",
          agentDecided: [],
          resolvedHow: "run",
          resolvedByRun: run.id,
          createdByRun: run.id,
        },
        { number: 5, status: "resolved", question: "Fog 2.", resolvedByRun: run.id },
      ]);
      expect(context.db.select().from(mapExclusions).all()).toEqual([]);
      // No round reaches the person; the pass and To Spec read the decisions.
      expect(readRounds(context.db, mapId).filter((round) => round.status === "pending")).toEqual(
        [],
      );
      cleanPass(context, mapId);
      const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
      if (!work.ok || work.value.purpose !== "to_spec") throw new Error("not a to_spec run");
      expect(work.value.request.waypoints.slice(3)).toEqual([
        {
          number: 4,
          kind: "grilling",
          title: "Fog 1 settled",
          question: "Fog 1.",
          resolution: "Decided by the agent: fog 1 follows the existing pattern.",
          gist: "Fog 1 follows the existing pattern",
          agentDecided: [],
          touches: [],
        },
        {
          number: 5,
          kind: "grilling",
          title: "Fog 2 settled",
          question: "Fog 2.",
          resolution: "Decided by the agent: fog 2 is derived.",
          gist: "Fog 2 is derived",
          agentDecided: [],
          touches: [],
        },
      ]);
    });

    test("deciding a fog position that is not a fog item, or one already used, is refused fog_item_unknown", () => {
      const decided = (position: number) => ({
        position,
        title: "Settled",
        resolution: "Decided by the agent.",
        gist: "Settled",
      });
      expectRefused(3, resolving({ fogDecided: [decided(1), decided(9)] }), "fog_item_unknown");
    });

    test("fog the run's own resolution settles is cleared with no duplicate waypoint", () => {
      const recorded = recordGrill(
        context.user,
        context.db,
        grillingRun(context, mapId, 3).id,
        resolving({
          fogSettledHere: [1],
          fogDecided: [
            {
              position: 2,
              title: "Fog 2 settled",
              resolution: "Decided.",
              gist: "Fog 2",
            },
          ],
        }),
      );
      expect(recorded.ok).toBe(true);
      expect(context.db.select().from(mapFog).all()).toEqual([]);
      // Only fog 2 became a waypoint; fog 1's decision lives in waypoint 3's resolution.
      expect(readWaypoints(context.db, mapId).map((waypoint) => waypoint.question)).toEqual([
        ...CONFIRMATION.waypoints.map((waypoint) => waypoint.question),
        "Fog 2.",
      ]);
      expect(waypointOf(context, mapId, 3)).toMatchObject({
        status: "resolved",
        resolution: "Decided.",
      });
    });

    test("fog settled by its own resolution on an outcome that resolves nothing is refused fog_settled_without_resolution", () => {
      expectRefused(
        3,
        {
          round: null,
          resolution: null,
          outOfScope: { reason: "Later." },
          mapChanges: { ...NO_MAP_CHANGES, fogSettledHere: [1, 2] },
        },
        "fog_settled_without_resolution",
      );
    });

    test("fog settled here at an unknown position is refused fog_item_unknown", () => {
      expectRefused(3, resolving({ fogSettledHere: [1, 2, 7] }), "fog_item_unknown");
    });

    test("one excluding all fog is accepted and clears the map", () => {
      const recorded = recordGrill(
        context.user,
        context.db,
        grillingRun(context, mapId, 3).id,
        resolving({
          fogOutOfScope: [
            { position: 1, line: "Later." },
            { position: 2, line: "Later too." },
          ],
        }),
      );
      expect(recorded.ok).toBe(true);
      expect(context.db.select().from(mapFog).all()).toEqual([]);
      cleanPass(context, mapId);
      expect(runsOf(context, mapId).at(-1)).toMatchObject({ purpose: "to_spec", state: "running" });
    });
  });
});

describe("waypoint round submission: every final round starts the grilling run", () => {
  test("an options-only final round leaves the waypoint claimed with a fresh grilling run after the final round", async () => {
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    ask(context, mapId, 1, true);
    const runsBefore = waypointRuns(1).length;
    answer(context, mapId, 1, PLAIN_ANSWERS);

    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "claimed",
      resolution: null,
      gist: null,
      resolvedHow: null,
    });
    expect(waypointRuns(1)).toHaveLength(runsBefore + 1);
    expect(waypointRuns(1).at(-1)).toMatchObject({ state: "running", retryOfRunId: null });
    expect(waypointOf(context, mapId, 2)).toMatchObject({ status: "open" });
    const work = await prepareRun(context.db, grillingRun(context, mapId, 1).id);
    if (!work.ok || work.value.purpose !== "grilling") throw new Error("not a grilling run");
    expect(work.value.request.afterFinal).toBe(true);
  });

  test("the run's resolution resolves it: resolution, gist and resolved_by_run are the run's, resolved_how run", () => {
    ask(context, mapId, 1, true);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    const run = grillingRun(context, mapId, 1);
    resolve(context, mapId, 1);

    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "resolved",
      resolution: "Resolved 1.",
      gist: "Gist 1",
      resolvedHow: "run",
      resolvedByRun: run.id,
    });
    expect(waypointOf(context, mapId, 1).resolvedAt).not.toBeNull();
    // The resolution claims what it unblocks.
    expect(waypointOf(context, mapId, 2)).toMatchObject({ status: "claimed" });
  });

  test("words on any answer of the waypoint, even an earlier round's, insert a fresh grilling run", () => {
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, [
      { optionIndex: 0, note: "", accepted: true },
      { optionIndex: 1, note: "Only my team", accepted: false },
    ]);
    ask(context, mapId, 1, true);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed", resolution: null });
    expect(waypointRuns(1).at(-1)).toMatchObject({ state: "running", retryOfRunId: null });
  });

  test("a waypoint stored as resolved by plain choice still reads resolved with its gist", async () => {
    ask(context, mapId, 1, true);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    resolve(context, mapId, 1);
    const { id } = waypointOf(context, mapId, 1);
    writeTestData(context, (tx) =>
      tx
        .update(waypointRows)
        .set({ gist: "Narrow; Team", resolvedHow: "plain_choice", resolvedByRun: null })
        .where(eq(waypointRows.id, id))
        .run(),
    );

    const stored = (await overview()).wayfinding.waypoints.find((w) => w.number === 1);
    expect(stored).toMatchObject({
      status: "resolved",
      gist: "Narrow; Team",
      resolvedHow: "plain_choice",
      resolvedByRun: null,
    });
  });

  test("a run after a final round can only resolve: a round is refused agent_output_invalid", () => {
    ask(context, mapId, 1, true);
    answer(context, mapId, 1, [
      { optionIndex: 0, note: "With a caveat", accepted: false },
      { optionIndex: 0, note: "", accepted: false },
    ]);
    const run = grillingRun(context, mapId, 1);
    const recorded = recordGrill(context.user, context.db, run.id, {
      round: { intro: "One more.", final: false, questions: ROUND.questions },
      resolution: null,
      outOfScope: null,
      mapChanges: null,
    });
    expect(recorded.ok ? null : recorded.error.code).toBe("agent_output_invalid");
    expect(runsOf(context, mapId).find((r) => r.id === run.id)).toMatchObject({
      state: "failed",
      errorCode: "agent_output_invalid",
    });
    expect(readRounds(context.db, mapId).filter((round) => round.status === "pending")).toEqual([]);
  });

  test("a submission refused writes nothing", () => {
    ask(context, mapId, 1, true);
    const pending = readRounds(context.db, mapId).find((round) => round.status === "pending");
    if (pending === undefined) throw new Error("no pending round");
    const refused = submitAnswers(
      context.user,
      context.db,
      SubmitAnswersInput.parse({ roundId: pending.id, answers: PLAIN_ANSWERS.slice(0, 1) }),
    );
    expect(refused.ok ? null : refused.error.code).toBe("round_answers_invalid");
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed" });
  });
});

describe("grilling retries", () => {
  test("a failed first run leaves the waypoint claimed while its retry runs", () => {
    const first = grillingRun(context, mapId, 1);
    failRun(context.user, context.db, first.id, FAILURE);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed" });
    expect(grillingRun(context, mapId, 1)).toMatchObject({ retryOfRunId: first.id });
  });

  test("the failed retry's transaction sets claimed → open; tryAgain sets open → claimed with its run", () => {
    const retry = stopWaypoint(1);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "open" });
    const tried = tryAgain(context.user, context.db, retry.id);
    if (!tried.ok) throw new Error(tried.error.code);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed" });
    expect(grillingRun(context, mapId, 1)).toMatchObject({ retryOfRunId: null });
  });

  test("startup ends an interrupted grilling run and retries it; an interrupted retry releases the waypoint", () => {
    sweepInterruptedRuns(context.db);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed" });
    expect(waypointRuns(1).map((run) => run.state)).toEqual(["failed", "running"]);
    sweepInterruptedRuns(context.db);
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "open" });
    expect(waypointRuns(1).at(-1)).toMatchObject({
      state: "failed",
      errorCode: "planning_run_interrupted",
    });
  });
});

describe("clearing", () => {
  test("resolving the last waypoint clears the map and inserts to_spec with the resolved waypoints", async () => {
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    expect(runsOf(context, mapId).filter((run) => run.purpose === "to_spec")).toEqual([]);
    resolve(context, mapId, 3);
    cleanPass(context, mapId);
    const work = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!work.ok || work.value.purpose !== "to_spec") throw new Error("not a to_spec run");
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

  test("each condition holds the map back", () => {
    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    resolve(context, mapId, 3);
    cleanPass(context, mapId);
    const map = { destinationConfirmedAt: "2026-10-07T12:00:00.000Z" };
    const waypoints = readWaypoints(context.db, mapId);
    const rounds = readRounds(context.db, mapId);
    const runs = runsOf(context, mapId).filter((run) => run.purpose !== "to_spec");
    const passes = readPasses(context.db, mapId);
    const clearing = { map, waypoints, rounds, runs, fogCount: 0, passes };
    expect(isCleared(clearing)).toBe(true);

    // Destination not confirmed.
    expect(isCleared({ ...clearing, map: { destinationConfirmedAt: null } })).toBe(false);
    // Fog remains.
    expect(isCleared({ ...clearing, fogCount: 1 })).toBe(false);
    // A waypoint neither resolved nor out of scope.
    const unresolved = waypoints.map((w, i) =>
      i === 0 ? { ...w, status: "claimed" as const } : w,
    );
    expect(isCleared({ ...clearing, waypoints: unresolved })).toBe(false);
    // A round pending.
    expect(isCleared({ ...clearing, rounds: [...rounds, { status: "pending" as const }] })).toBe(
      false,
    );
    // A grilling run running, or a failed first attempt awaiting its retry.
    const last = runs.at(-1);
    if (last === undefined) throw new Error("no run");
    const later = { ...last, id: uuidv7(), startedAt: "2099-01-01T00:00:00.000Z" };
    expect(
      isCleared({ ...clearing, runs: [...runs, { ...later, state: "running", endedAt: null }] }),
    ).toBe(false);
    expect(
      isCleared({
        ...clearing,
        runs: [
          ...runs,
          { ...later, state: "failed", errorCode: "agent_run_failed", errorMessage: "Failed" },
        ],
      }),
    ).toBe(false);
  });
});

describe("the waypoint's state in map.overview", () => {
  async function stateOf(number: number) {
    return (await overview()).wayfinding.waypoints.find((w) => w.number === number)?.state;
  }

  test("working while its run runs or awaits retry, stopped with run id and code, then waiting on you", async () => {
    expect(await stateOf(1)).toEqual({ kind: "working" });
    expect(await stateOf(2)).toEqual({ kind: "blocked", waitsOn: [1] });
    failRun(context.user, context.db, grillingRun(context, mapId, 1).id, FAILURE);
    expect(await stateOf(1)).toEqual({ kind: "working" });
    const retry = grillingRun(context, mapId, 1);
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(await stateOf(1)).toEqual({
      kind: "stopped",
      run: { runId: retry.id, code: FAILURE.code },
    });
    const tried = tryAgain(context.user, context.db, retry.id);
    if (!tried.ok) throw new Error(tried.error.code);
    ask(context, mapId, 1, false);
    expect(await stateOf(1)).toEqual({ kind: "waiting_on_you" });
  });

  test("a stopped run on a waypoint since ruled out of scope is no next action and offers no Try again", async () => {
    failRun(context.user, context.db, grillingRun(context, mapId, 1).id, FAILURE);
    const retry = grillingRun(context, mapId, 1);
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(await stateOf(1)).toEqual({
      kind: "stopped",
      run: { runId: retry.id, code: FAILURE.code },
    });
    // Ruled out by other means (as the hatch does): its line saved, the waypoint out of scope.
    const { id } = waypointOf(context, mapId, 1);
    writeTestData(context, (tx) => {
      tx.update(waypointRows).set({ status: "out_of_scope" }).where(eq(waypointRows.id, id)).run();
      tx.insert(mapExclusions)
        .values({ mapId, position: 1, text: "Later.", waypointId: id, createdByRun: retry.id })
        .run();
      planNext(context.user, tx, mapId);
    });
    expect(await stateOf(1)).toEqual({ kind: "out_of_scope" });
    const detail = await overview();
    expect(detail.status.next.filter((action) => action.stopped !== null)).toEqual([]);
    expect(detail.status.stages[1].line).not.toContain("stopped");
    const tried = tryAgain(context.user, context.db, retry.id);
    expect(!tried.ok && tried.error.code).toBe("planning_run_not_stopped");
  });

  test("status and activity reflect grilling (tone and what lines open, not words)", async () => {
    ask(context, mapId, 1, true);
    const detail = await overview();
    expect(detail.status.stages[1]).toMatchObject({ stage: "wayfinding", tone: "needs-you" });
    expect(detail.status.next[0]).toMatchObject({ who: "you", round: 1, stopped: null });
    expect(detail.activity.at(-1)).toMatchObject({ stage: "wayfinding", waypoint: 1 });
  });
});

test("a waypoint has at most one running run (its unique index)", () => {
  const run = grillingRun(context, mapId, 1);
  let caught: unknown;
  try {
    writeTestData(context, (tx) =>
      tx
        .insert(planningRuns)
        .values({ ...run, id: uuidv7(), userId: context.user.userId })
        .run(),
    );
  } catch (error: unknown) {
    caught = error;
  }
  expect(isUniqueConstraintViolation(caught)).toBe(true);
  expect(
    context.db.select().from(planningRuns).where(eq(planningRuns.id, run.id)).get(),
  ).toBeDefined();
});
