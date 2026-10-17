import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChartConfirmation, CodeSurvey, PlanningRun, Project } from "@zenorm/contracts";
import { codeSurveys } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readCodeSurvey, recordSurvey, surveySourceProblem } from "./code-survey.ts";
import { awaitingSurvey, failRun, tryAgain } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import {
  addProject,
  answerDestination,
  closeTestContext,
  CONFIRMATION,
  confirmChart,
  newMap,
  NO_WAYPOINTS,
  openTestContext,
  propose,
  PROPOSAL,
  runningMapRun,
  runsOf,
  survey,
  SURVEY,
  waypointOf,
  writeTestData,
  mapFolder,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-survey-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

const FAILURE = { code: "agent_run_failed", message: "The run failed." } as const;

/** A map whose confirming chart saved `confirmation`; its code survey is then running. */
async function chartConfirmed(confirmation: ChartConfirmation): Promise<string> {
  const mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirmChart(context, mapId, confirmation);
  return mapId;
}

/** The map's runs as `purpose:state`, oldest first. */
function runLines(mapId: string): string[] {
  return runsOf(context, mapId).map((run) => `${run.purpose}:${run.state}`);
}

/** SURVEY with its one fact pointing at `path:line`. */
function factAt(path: string, line: number): CodeSurvey {
  const [entry] = SURVEY.entries;
  if (entry === undefined) throw new Error("SURVEY has no entry");
  return { ...SURVEY, entries: [{ ...entry, facts: [{ claim: "A fact.", path, line }] }] };
}

describe("scheduling the code survey", () => {
  test("a confirmed chart starts the survey, and no waypoint run until it completes", async () => {
    const mapId = await chartConfirmed(CONFIRMATION);
    expect(runLines(mapId)).toEqual(["chart:asked", "chart:completed", "survey:running"]);
    expect(waypointOf(context, mapId, 1).status).toBe("open");

    const prepared = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!prepared.ok || prepared.value.purpose !== "survey") throw new Error("Not a survey");
    expect(prepared.value.request).toMatchObject({
      title: PROPOSAL.title,
      destination: CONFIRMATION.destination,
      waypoints: CONFIRMATION.waypoints.map((waypoint, index) => ({
        number: index + 1,
        title: waypoint.title,
      })),
    });

    survey(context, mapId, SURVEY);
    expect(readCodeSurvey(context.db, mapId)).toEqual(SURVEY);
    expect(runLines(mapId)).toEqual([
      "chart:asked",
      "chart:completed",
      "survey:completed",
      "grilling:running",
    ]);
    expect(waypointOf(context, mapId, 1).status).toBe("claimed");
  });

  test("a map charted with no waypoints writes its specs only after the survey", async () => {
    const mapId = await chartConfirmed(NO_WAYPOINTS);
    expect(runLines(mapId).at(-1)).toBe("survey:running");
    survey(context, mapId, SURVEY);
    expect(runLines(mapId).at(-1)).toBe("to_spec:running");
  });

  test("a failed survey is retried once; a failed retry stops the map until Try again", async () => {
    const mapId = await chartConfirmed(CONFIRMATION);
    failRun(context.user, context.db, runningMapRun(context, mapId).id, FAILURE);
    const retry = runningMapRun(context, mapId);
    expect(retry.purpose).toBe("survey");
    expect(retry.retryOfRunId).not.toBeNull();

    failRun(context.user, context.db, retry.id, FAILURE);
    expect(runLines(mapId)).toEqual([
      "chart:asked",
      "chart:completed",
      "survey:failed",
      "survey:failed",
    ]);
    expect(waypointOf(context, mapId, 1).status).toBe("open");

    const again = tryAgain(context.user, context.db, retry.id);
    expect(again.ok).toBe(true);
    expect(runningMapRun(context, mapId).purpose).toBe("survey");
    survey(context, mapId, SURVEY);
    expect(runLines(mapId).at(-1)).toBe("grilling:running");
  });

  test("only a map whose work began before surveys existed goes on without one", () => {
    const at = "2026-10-08T12:00:00.000Z";
    const run = (purpose: PlanningRun["purpose"], state: PlanningRun["state"]): PlanningRun => ({
      id: `${purpose}-${state}`,
      mapId: "map",
      waypointId: null,
      specificationId: null,
      purpose,
      state,
      retryOfRunId: null,
      errorCode: null,
      errorMessage: null,
      cancelReason: null,
      hatchMessageId: null,
      startedAt: at,
      endedAt: at,
    });
    const chart = run("chart", "completed");
    expect(awaitingSurvey([chart])).toBe(true);
    expect(awaitingSurvey([chart, run("hatch", "completed")])).toBe(true);
    expect(awaitingSurvey([chart, run("survey", "failed")])).toBe(true);
    expect(awaitingSurvey([chart, run("survey", "completed")])).toBe(false);
    expect(awaitingSurvey([chart, run("grilling", "completed")])).toBe(false);
    expect(awaitingSurvey([chart, run("to_spec", "running")])).toBe(false);
  });
});

describe("recording the code survey", () => {
  test("a path the project does not have is refused survey_source_unknown and retried", async () => {
    const mapId = await chartConfirmed(CONFIRMATION);
    const run = runningMapRun(context, mapId);
    const refused = recordSurvey(
      context.user,
      context.db,
      run.id,
      mapFolder(context, mapId),
      factAt("src/missing.ts", 1),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "survey_source_unknown" } });
    expect(readCodeSurvey(context.db, mapId)).toBeNull();
    expect(context.db.select().from(codeSurveys).all()).toEqual([]);
    expect(runsOf(context, mapId).find((other) => other.id === run.id)).toMatchObject({
      state: "failed",
      errorCode: "survey_source_unknown",
    });
    expect(runningMapRun(context, mapId)).toMatchObject({
      purpose: "survey",
      retryOfRunId: run.id,
    });
  });

  test("each source is checked: area, surface file, fact, identifier and lifecycle lines", async () => {
    const folder = project.folderPath;
    await writeFile(join(folder, "two-lines.ts"), "one\ntwo\n");
    const [entry] = SURVEY.entries;
    if (entry === undefined) throw new Error("SURVEY has no entry");
    const code = (content: CodeSurvey) => {
      const problem = surveySourceProblem(folder, content);
      return problem === null ? "accepted" : problem.code;
    };

    expect(code(factAt("two-lines.ts", 2))).toBe("accepted");
    expect(code(factAt("two-lines.ts", 3))).toBe("survey_source_unknown");
    expect(code(factAt(".", 1))).toBe("survey_source_unknown");
    expect(code({ ...SURVEY, entries: [{ ...entry, area: "." }] })).toBe("accepted");
    expect(code({ ...SURVEY, entries: [{ ...entry, area: "packages" }] })).toBe(
      "survey_source_unknown",
    );
    expect(code({ ...SURVEY, entries: [{ ...entry, surfaceFiles: ["."] }] })).toBe(
      "survey_source_unknown",
    );
    const identifier = { name: "Two", meaning: "A name.", path: "two-lines.ts", line: 9 };
    expect(code({ ...SURVEY, identifiers: [identifier] })).toBe("survey_source_unknown");
    const lifecycle = (line: number, terminalLine: number) => ({
      ...SURVEY,
      lifecycles: [
        {
          record: "run",
          states: ["running", "failed"],
          transitions: [
            { from: "running", to: "failed", by: "failRun", path: "two-lines.ts", line },
          ],
          terminal: [
            { state: "failed", exits: "nothing", path: "two-lines.ts", line: terminalLine },
          ],
        },
      ],
    });
    expect(code(lifecycle(1, 2))).toBe("accepted");
    expect(code(lifecycle(3, 2))).toBe("survey_source_unknown");
    expect(code(lifecycle(1, 3))).toBe("survey_source_unknown");
  });

  test("each later run's request carries the map's survey, and null for a map without one", async () => {
    const mapId = await chartConfirmed(CONFIRMATION);
    survey(context, mapId, SURVEY);
    const grilling = runsOf(context, mapId).find(
      (run) => run.purpose === "grilling" && run.state === "running",
    );
    if (grilling === undefined) throw new Error("No grilling run");
    const prepared = await prepareRun(context.db, grilling.id);
    if (!prepared.ok || prepared.value.purpose !== "grilling")
      throw new Error("Not a grilling run");
    expect(prepared.value.request.survey).toEqual(SURVEY);

    // A map whose work began before surveys existed has no stored survey.
    writeTestData(context, (tx) => tx.delete(codeSurveys).run());
    const unsurveyed = await prepareRun(context.db, grilling.id);
    if (!unsurveyed.ok || unsurveyed.value.purpose !== "grilling") {
      throw new Error("Not a grilling run");
    }
    expect(unsurveyed.value.request.survey).toBeNull();
  });

  test("a map charted with no waypoints writes its specs from the survey", async () => {
    const mapId = await chartConfirmed(NO_WAYPOINTS);
    survey(context, mapId, SURVEY);
    const prepared = await prepareRun(context.db, runningMapRun(context, mapId).id);
    if (!prepared.ok || prepared.value.purpose !== "to_spec") throw new Error("Not a To Spec run");
    expect(prepared.value.request.survey).toEqual(SURVEY);
  });

  test("the map keeps one current survey", async () => {
    const mapId = await chartConfirmed(CONFIRMATION);
    survey(context, mapId, SURVEY);
    expect(context.db.select().from(codeSurveys).all()).toHaveLength(1);
    expect(readCodeSurvey(context.db, mapId)).toEqual(SURVEY);
    expect(readCodeSurvey(context.db, "unknown-map")).toBeNull();
  });
});
