import type { FogSettlementOutcome, GrillOutcome, Project } from "@zenorm/contracts";
import { mapExclusions, mapFog } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordFogSettlement } from "./fog-settlement.ts";
import { readWaypoints, recordGrill } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import {
  addProject,
  answerDestination,
  ANSWERS,
  cleanPass,
  closeTestContext,
  CONFIRMATION,
  confirm,
  grillingRun,
  newMap,
  NO_MAP_CHANGES,
  openTestContext,
  propose,
  resolve,
  ROUND,
  runningMapRun,
  runsOf,
  waypointOf,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;
let mapId: string;

beforeEach(async () => {
  context = await openTestContext("zenorm-fog-");
  project = await addProject(context, "repo");
  // Waypoint 1 claimed, 2 and 3 blocked by it; two fog items.
  mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirm(context, mapId, { ...CONFIRMATION, fog: ["Fog 1.", "Fog 2."] });
  resolve(context, mapId, 1);
});

afterEach(async () => {
  await closeTestContext(context);
});

/** A resolving outcome that leaves every fog item to the map's fog run. */
function leavingFog(number: number): GrillOutcome {
  return {
    round: null,
    resolution: {
      resolution: `Resolved ${String(number)}.`,
      gist: `Gist ${String(number)}`,
      agentDecided: [],
    },
    outOfScope: null,
    mapChanges: NO_MAP_CHANGES,
  };
}

const NOTHING: FogSettlementOutcome = {
  fogSettledBy: [],
  fogDecided: [],
  fogOutOfScope: [],
  fogForPerson: [],
  fogProposed: [],
};

/** Waypoints 2 and 3, worked in parallel, both resolve leaving the fog; the fog run starts. */
function raceToTheEnd(): string {
  // Both runs are out at once, each seeing the other claimed (RC5).
  const second = grillingRun(context, mapId, 2);
  const third = grillingRun(context, mapId, 3);
  expect(recordGrill(context.user, context.db, third.id, leavingFog(3)).ok).toBe(true);
  expect(recordGrill(context.user, context.db, second.id, leavingFog(2)).ok).toBe(true);
  const fogRun = runningMapRun(context, mapId);
  expect(fogRun).toMatchObject({ purpose: "fog", waypointId: null, specificationId: null });
  return fogRun.id;
}

describe("the fog run (harness change #4)", () => {
  test("two parallel last waypoints leaving fog are not refused; the fog run settles it and the map clears", async () => {
    const fogRunId = raceToTheEnd();
    expect(runsOf(context, mapId).filter((run) => run.state === "failed")).toEqual([]);

    const work = await prepareRun(context.db, fogRunId);
    if (!work.ok || work.value.purpose !== "fog") throw new Error("not a fog run");
    expect(work.value.request.fog.map((item) => item.position)).toEqual([1, 2]);
    // The destination's rounds, as stored (DR-14).
    expect(work.value.request.mapRounds).toEqual([
      { questions: ROUND.questions, answers: ANSWERS, final: false },
    ]);
    expect(work.value.request.waypoints.map((waypoint) => waypoint.number)).toEqual([1, 2, 3]);

    const recorded = recordFogSettlement(context.user, context.db, fogRunId, {
      ...NOTHING,
      fogSettledBy: [{ position: 1, waypoint: 2 }],
      fogOutOfScope: [{ position: 2, line: "Fog 2 is a later effort." }],
    });
    expect(recorded.ok).toBe(true);
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(context.db.select().from(mapExclusions).all()).toMatchObject([
      { text: "Fog 2 is a later effort.", waypointId: null, createdByRun: fogRunId },
    ]);
    // Settled fog makes the consistency pass due; a clean pass clears the map into To Spec.
    cleanPass(context, mapId);
    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
  });

  test("an item only the person can settle opens a Grilling waypoint only the person settles; the map waits on it", () => {
    const fogRunId = raceToTheEnd();
    const recorded = recordFogSettlement(context.user, context.db, fogRunId, {
      ...NOTHING,
      fogDecided: [
        {
          position: 1,
          title: "Fog 1 settled",
          resolution: "Decided by the agent: fog 1 follows the pattern; the person can reopen it.",
          gist: "Fog 1 follows the pattern",
        },
      ],
      fogForPerson: [{ position: 2, title: "Fog 2", question: "Which way should fog 2 go?" }],
    });
    expect(recorded.ok).toBe(true);
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(readWaypoints(context.db, mapId).slice(3)).toMatchObject([
      // The person's waypoint, claimed at once by a grilling run.
      { number: 4, kind: "grilling", status: "claimed", question: "Which way should fog 2 go?" },
      { number: 5, status: "resolved", question: "Fog 1.", resolvedByRun: fogRunId },
    ]);
    expect(waypointOf(context, mapId, 4).personDecides).toBe(true);
    // The map neither clears nor runs its pass while the person's waypoint is unsettled.
    expect(
      runsOf(context, mapId).filter((run) => run.waypointId === null && run.state === "running"),
    ).toEqual([]);
    expect(
      recordGrill(context.user, context.db, grillingRun(context, mapId, 4).id, leavingFog(4)),
    ).toMatchObject({ ok: false, error: { code: "agent_output_invalid" } });
    resolve(context, mapId, 4);
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
  });

  test.each([
    [
      "an item left out",
      { ...NOTHING, fogOutOfScope: [{ position: 1, line: "Later." }] },
      "fog_left_unsettled",
    ],
    [
      "an unknown position",
      {
        ...NOTHING,
        fogOutOfScope: [
          { position: 1, line: "Later." },
          { position: 2, line: "Later." },
          { position: 9, line: "Later." },
        ],
      },
      "fog_item_unknown",
    ],
    [
      "a position used twice",
      {
        ...NOTHING,
        fogOutOfScope: [
          { position: 1, line: "Later." },
          { position: 2, line: "Later." },
        ],
        fogSettledBy: [{ position: 1, waypoint: 1 }],
      },
      "fog_item_unknown",
    ],
    [
      "an item settled by a waypoint that is not resolved",
      {
        ...NOTHING,
        fogOutOfScope: [{ position: 1, line: "Later." }],
        fogSettledBy: [{ position: 2, waypoint: 9 }],
      },
      "fog_settled_without_resolution",
    ],
  ] satisfies [string, FogSettlementOutcome, string][])(
    "a settlement with %s is refused with its code, writes nothing and is retried",
    (_, outcome, code) => {
      const fogRunId = raceToTheEnd();
      const fogBefore = context.db.select().from(mapFog).all();
      const recorded = recordFogSettlement(context.user, context.db, fogRunId, outcome);
      expect(!recorded.ok && recorded.error.code).toBe(code);
      expect(context.db.select().from(mapFog).all()).toEqual(fogBefore);
      expect(readWaypoints(context.db, mapId)).toHaveLength(3);
      expect(runningMapRun(context, mapId)).toMatchObject({
        purpose: "fog",
        retryOfRunId: fogRunId,
      });
    },
  );
});
