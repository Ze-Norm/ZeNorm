import { SubmitAnswersInput } from "@zenorm/contracts";
import { readMapRounds } from "./run-work.ts";
import type {
  Answers,
  ChartConfirmation,
  MapChanges,
  PlanningRun,
  Project,
  ResearchOutcome,
  ResearchReport,
  TaskOutcome,
  Waypoint,
} from "@zenorm/contracts";
import {
  mapExclusions,
  mapFog,
  questionRounds,
  researchReports,
  researchSources,
  taskOutcomes,
  waypoints as waypointsTable,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { submitAnswers } from "./map.ts";
import { getMapOverview } from "./map-overview.ts";
import {
  failRun,
  frontier,
  readMap,
  readRounds,
  readWaypoints,
  recordResearch,
  recordTask,
  sweepInterruptedRuns,
  tryAgain,
} from "./planning-runs.ts";
import type { RunOutcomes } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { draftSpecsRequest } from "./spec-requests.ts";
import {
  addProject,
  answerDestination,
  closeTestContext,
  confirm,
  grillingRun,
  newMap,
  NO_MAP_CHANGES,
  openTestContext,
  propose,
  runningMapRun,
  runsOf,
  waypointOf,
  writeTestData,
  ANSWERS as DESTINATION_ANSWERS,
  ROUND,
  PROPOSAL,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;
let mapId: string;

/** Research 1 and Task 2, Grilling 3 blocked by both; one fog item and one Out of scope line. */
const KINDS: ChartConfirmation = {
  title: PROPOSAL.title,
  summary: PROPOSAL.summary,
  destination: "Move the HTTP client to built-in fetch behind the proxy.",
  waypoints: [
    {
      kind: "research",
      title: "Proxy support",
      question: "Does built-in fetch honour the proxy variables?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "task",
      title: "Count the call sites",
      question: "How many files call the old client?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Migration order",
      question: "Which call sites move first?",
      blockedBy: [1, 2],
      touches: [],
    },
  ],
  fog: ["Retries on flaky networks."],
  outOfScope: ["Changing the proxy itself."],
  proposals: [],
};

const ANSWERED: ResearchReport = {
  answered: true,
  summary: "Built-in fetch honours the proxy variables from Node 24.",
  gap: null,
  gist: "fetch honours the proxy from Node 24",
  findings: [{ title: "Proxy support", detail: "Node 24 reads HTTP_PROXY.", sources: [1, 2] }],
  sources: [
    {
      kind: "external",
      title: "Node 24 release notes",
      url: "https://nodejs.org/en/blog/release/v24.0.0",
      excerpt: "fetch now honours HTTP_PROXY.",
    },
    { kind: "repository_file", title: "package.json", url: null, excerpt: '"node": ">=22"' },
  ],
  limitations: ["Only the release notes were read."],
  uncertainties: [],
};

const UNANSWERED: ResearchReport = {
  answered: false,
  summary: "The release notes do not say.",
  gap: "Whether Node 22 honours the proxy variables.",
  gist: null,
  findings: [],
  sources: [],
  limitations: [],
  uncertainties: ["The changelog may be incomplete."],
};

function research(report: ResearchReport, mapChanges: MapChanges = NO_MAP_CHANGES) {
  const outcome: ResearchOutcome = { report, outOfScope: null, mapChanges };
  return outcome;
}

const TASK_ROUND: TaskOutcome = {
  round: {
    intro: "One thing before I count.",
    questions: [
      {
        topic: "Scope",
        text: "Which folders count as call sites?",
        options: [
          { label: "Only src", detail: "Tests and scripts are left out." },
          { label: "Every folder", detail: "Tests and scripts count too." },
        ],
      },
    ],
  },
  done: null,
  failed: null,
  outOfScope: null,
  mapChanges: null,
};

const DONE: TaskOutcome = {
  round: null,
  done: {
    action: "Counted the imports.",
    facts: "12 files import the client.",
    gist: "12 files",
    agentDecided: ["Counted static imports only"],
  },
  failed: null,
  outOfScope: null,
  mapChanges: NO_MAP_CHANGES,
};

const FAILED: TaskOutcome = {
  round: null,
  done: null,
  failed: { action: "Tried to count the imports.", facts: "The src folder is unreadable." },
  outOfScope: null,
  mapChanges: NO_MAP_CHANGES,
};

const ANSWERS: Answers = [{ optionIndex: 0, note: "And lib.", accepted: false }];

/** A map in `project` charted with `confirmation`. */
async function charted(confirmation: ChartConfirmation): Promise<string> {
  const id = await newMap(context, project, "Move to fetch");
  propose(context, id);
  answerDestination(context, id);
  confirm(context, id, confirmation);
  return id;
}

function waypointRuns(number: number): PlanningRun[] {
  const { id } = waypointOf(context, mapId, number);
  return runsOf(context, mapId).filter((run) => run.waypointId === id);
}

function latestOf(number: number): PlanningRun {
  const latest = waypointRuns(number).at(-1);
  if (latest === undefined) throw new Error(`Waypoint ${String(number)} has no run`);
  return latest;
}

function researchOn(number: number, outcome: ResearchOutcome): void {
  const recorded = recordResearch(
    context.user,
    context.db,
    grillingRun(context, mapId, number).id,
    outcome,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function taskOn(number: number, outcome: TaskOutcome): void {
  const recorded = recordTask(
    context.user,
    context.db,
    grillingRun(context, mapId, number).id,
    outcome,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function pendingRound(number: number) {
  const { id } = waypointOf(context, mapId, number);
  const round = readRounds(context.db, mapId).find(
    (candidate) => candidate.waypointId === id && candidate.status === "pending",
  );
  if (round === undefined) throw new Error(`Waypoint ${String(number)} has no pending round`);
  return round;
}

async function overviewWaypoint(number: number) {
  const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
  if (!result.ok) throw new Error(result.error.code);
  const waypoint = result.value.wayfinding.waypoints.find((w) => w.number === number);
  if (waypoint === undefined) throw new Error(`No waypoint ${String(number)}`);
  return { overview: result.value, waypoint };
}

/** What a refused output must leave unchanged. */
function mapState() {
  return {
    waypoints: readWaypoints(context.db, mapId),
    fog: context.db.select().from(mapFog).all(),
    exclusions: context.db.select().from(mapExclusions).all(),
    reports: context.db.select().from(researchReports).all(),
    sources: context.db.select().from(researchSources).all(),
    outcomes: context.db.select().from(taskOutcomes).all(),
  };
}

beforeEach(async () => {
  context = await openTestContext("zenorm-research-task-");
  project = await addProject(context, "repo");
  mapId = await charted(KINDS);
});

afterEach(async () => {
  await closeTestContext(context);
});

describe("the frontier over every kind (S6b-6)", () => {
  test("each unblocked waypoint is claimed with a run of its kind; a blocked one waits", () => {
    expect(readWaypoints(context.db, mapId)).toMatchObject([
      { number: 1, kind: "research", status: "claimed" },
      { number: 2, kind: "task", status: "claimed" },
      { number: 3, kind: "grilling", status: "open" },
    ]);
    expect(waypointRuns(1)).toMatchObject([{ purpose: "research", state: "running" }]);
    expect(waypointRuns(2)).toMatchObject([{ purpose: "task", state: "running" }]);
    expect(waypointRuns(3)).toEqual([]);
  });

  test("a Grilling waypoint is claimed once its Research and Task blockers resolve", () => {
    researchOn(1, research(ANSWERED));
    expect(waypointOf(context, mapId, 3).status).toBe("open");
    taskOn(2, DONE);
    expect(waypointOf(context, mapId, 3).status).toBe("claimed");
    expect(waypointRuns(3)).toMatchObject([{ purpose: "grilling", state: "running" }]);
  });

  test("a waiting waypoint is claimed by no write until tryAgain", () => {
    researchOn(1, research(UNANSWERED));
    const waiting = latestOf(1);
    // Another write on the map runs planNext; the waiting waypoint stays open with no new run.
    taskOn(2, DONE);
    expect(waypointOf(context, mapId, 1).status).toBe("open");
    expect(latestOf(1).id).toBe(waiting.id);
    expect(waypointOf(context, mapId, 3).status).toBe("open");
  });

  test("the pure frontier excludes an open waypoint waiting on an unanswered report or failed task", () => {
    const [one, two] = readWaypoints(context.db, mapId);
    if (one === undefined || two === undefined) throw new Error("No waypoints");
    const open = (waypoint: Waypoint): Waypoint => ({ ...waypoint, status: "open" });
    const completed = (waypoint: Waypoint, id: string): PlanningRun => ({
      id,
      mapId,
      waypointId: waypoint.id,
      specificationId: null,
      purpose: waypoint.kind === "research" ? "research" : "task",
      retryOfRunId: null,
      state: "completed",
      errorCode: null,
      errorMessage: null,
      cancelReason: null,
      hatchMessageId: null,
      startedAt: "2026-10-08T00:00:00.000Z",
      endedAt: "2026-10-08T00:00:01.000Z",
    });
    const runs = [completed(one, "run-1"), completed(two, "run-2")];
    const confirmed = { destinationConfirmedAt: "2026-10-08T00:00:00.000Z" };
    const numbers = (outcomes: RunOutcomes) =>
      frontier({
        map: confirmed,
        waypoints: [open(one), open(two)],
        blockers: [],
        runs,
        outcomes,
      }).map((w) => w.number);
    expect(numbers({ reports: [], taskOutcomes: [] })).toEqual([1, 2]);
    expect(
      numbers({
        reports: [{ runId: "run-1", answered: false, gap: "No source." }],
        taskOutcomes: [{ runId: "run-2", outcome: "failed", facts: "Stopped." }],
      }),
    ).toEqual([]);
  });
});

describe("Research runs (S6b-7)", () => {
  test("an answered report resolves the waypoint with its summary; one report row and its sources", () => {
    const run = grillingRun(context, mapId, 1);
    researchOn(1, research(ANSWERED));
    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "resolved",
      resolution: ANSWERED.summary,
      gist: ANSWERED.gist,
      // A report states facts, not calls.
      agentDecided: [],
      resolvedHow: "run",
      resolvedByRun: run.id,
    });
    expect(latestOf(1)).toMatchObject({ id: run.id, state: "completed" });
    expect(context.db.select().from(researchReports).all()).toEqual([
      {
        runId: run.id,
        waypointId: waypointOf(context, mapId, 1).id,
        answered: true,
        summary: ANSWERED.summary,
        gap: null,
        findings: ANSWERED.findings,
        limitations: ANSWERED.limitations,
        uncertainties: ANSWERED.uncertainties,
      },
    ]);
    expect(context.db.select().from(researchSources).all()).toEqual(
      ANSWERED.sources.map((source, index) => ({
        reportRunId: run.id,
        position: index + 1,
        ...source,
      })),
    );
  });

  test("an unanswered report returns the waypoint claimed → open with the report attached, no retry", async () => {
    const run = grillingRun(context, mapId, 1);
    researchOn(1, research(UNANSWERED));
    expect(waypointOf(context, mapId, 1).status).toBe("open");
    expect(waypointRuns(1)).toMatchObject([{ id: run.id, state: "completed" }]);
    expect(context.db.select().from(researchReports).all()).toMatchObject([
      { runId: run.id, answered: false, gap: UNANSWERED.gap },
    ]);
    const { waypoint, overview } = await overviewWaypoint(1);
    expect(waypoint.reports).toMatchObject([{ runId: run.id, answered: false }]);
    expect(waypoint.state).toEqual({
      kind: "waiting",
      run: { runId: run.id, reason: "research_unanswered" },
    });
    expect(overview.status.stages.find((s) => s.stage === "wayfinding")?.tone).toBe("needs-you");
  });

  test.each([
    ["answered with no finding", { ...ANSWERED, findings: [] }],
    ["answered with no gist", { ...ANSWERED, gist: null }],
    ["unanswered with no gap", { ...UNANSWERED, gap: null }],
    ["unanswered with a gist", { ...UNANSWERED, gist: "A gist" }],
    [
      "a finding naming a missing source",
      { ...ANSWERED, findings: [{ title: "T", detail: "D", sources: [3] }] },
    ],
  ])("a report %s is refused agent_output_invalid, writing nothing", (_name, report) => {
    const run = grillingRun(context, mapId, 1);
    const before = mapState();
    const recorded = recordResearch(context.user, context.db, run.id, research(report));
    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(mapState()).toEqual(before);
    expect(waypointRuns(1)).toMatchObject([
      { id: run.id, state: "failed", errorCode: "agent_output_invalid" },
      { state: "running", retryOfRunId: run.id, purpose: "research" },
    ]);
  });

  test("a research run may rule its waypoint out of scope and return map changes (S6b-5, S6b-3)", () => {
    const run = grillingRun(context, mapId, 1);
    researchOn(1, {
      report: null,
      outOfScope: { reason: "The proxy is someone else's." },
      mapChanges: {
        ...NO_MAP_CHANGES,
        fogDecided: [],
        fogSettledHere: [],
        newFog: ["Proxy ownership."],
      },
    });
    const one = waypointOf(context, mapId, 1);
    expect(one.status).toBe("out_of_scope");
    expect(
      context.db.select().from(mapExclusions).where(eq(mapExclusions.waypointId, one.id)).all(),
    ).toMatchObject([{ text: "The proxy is someone else's.", createdByRun: run.id }]);
    expect(
      context.db
        .select()
        .from(mapFog)
        .all()
        .map((item) => item.text),
    ).toEqual(["Retries on flaky networks.", "Proxy ownership."]);
    expect(context.db.select().from(researchReports).all()).toEqual([]);
  });

  test("the request carries the map context and this waypoint's earlier reports", async () => {
    researchOn(1, research(UNANSWERED));
    const again = tryAgain(context.user, context.db, latestOf(1).id);
    expect(again.ok).toBe(true);
    const work = await prepareRun(context.db, latestOf(1).id);
    if (!work.ok || work.value.purpose !== "research") throw new Error("not a research run");
    expect(work.value.request).toMatchObject({
      destination: KINDS.destination,
      // The destination's rounds, as stored (DR-14).
      mapRounds: [{ questions: ROUND.questions, answers: DESTINATION_ANSWERS, final: false }],
      waypoint: { number: 1, kind: "research", title: "Proxy support" },
      otherWaypoints: [
        { number: 2, kind: "task", status: "claimed" },
        { number: 3, kind: "grilling", status: "open" },
      ],
      fog: [{ position: 1, text: "Retries on flaky networks." }],
      outOfScope: ["Changing the proxy itself."],
      earlierReports: [UNANSWERED],
    });
  });
});

describe("a spec run reads a research waypoint's facts", () => {
  const BASE = { projectName: "repo", projectFolder: "/tmp/repo", baseBranch: "main", idea: "I" };

  test("its report's findings and sources' titles and URLs ride with the resolution", () => {
    researchOn(1, research(ANSWERED));
    const request = draftSpecsRequest(
      context.db,
      readMap(context.db, mapId),
      latestOf(1),
      BASE,
      readMapRounds(context.db, mapId),
    );
    expect(request.waypoints).toEqual([
      {
        number: 1,
        kind: "research",
        title: "Proxy support",
        question: "Does built-in fetch honour the proxy variables?",
        resolution: ANSWERED.summary,
        gist: ANSWERED.gist,
        agentDecided: [],
        research: {
          findings: [{ title: "Proxy support", detail: "Node 24 reads HTTP_PROXY." }],
          sources: [
            { title: "Node 24 release notes", url: "https://nodejs.org/en/blog/release/v24.0.0" },
            { title: "package.json", url: null },
          ],
        },
        touches: [],
      },
    ]);
  });

  test("a resolved research waypoint with no report is a programmer error", () => {
    researchOn(1, research(ANSWERED));
    writeTestData(context, (tx) => tx.delete(researchSources).run());
    writeTestData(context, (tx) => tx.delete(researchReports).run());
    expect(() =>
      draftSpecsRequest(
        context.db,
        readMap(context.db, mapId),
        latestOf(1),
        BASE,
        readMapRounds(context.db, mapId),
      ),
    ).toThrow();
  });
});

describe("the fog check with waiting waypoints (S6b-4)", () => {
  beforeEach(async () => {
    mapId = await charted({
      ...KINDS,
      waypoints: KINDS.waypoints.filter((waypoint) => waypoint.kind === "research"),
    });
  });

  test("an unanswered report leaving only its own waypoint open with fog is not refused", () => {
    const recorded = recordResearch(
      context.user,
      context.db,
      grillingRun(context, mapId, 1).id,
      research(UNANSWERED),
    );
    expect(recorded.ok).toBe(true);
    expect(waypointOf(context, mapId, 1).status).toBe("open");
    expect(context.db.select().from(mapFog).where(eq(mapFog.mapId, mapId)).all()).toHaveLength(1);
  });

  test("an answered report leaving the fog with no waypoint open is accepted; the map's fog run starts", () => {
    const recorded = recordResearch(
      context.user,
      context.db,
      grillingRun(context, mapId, 1).id,
      research(ANSWERED),
    );
    expect(recorded.ok).toBe(true);
    expect(runningMapRun(context, mapId).purpose).toBe("fog");
  });
});

describe("Task runs (S6b-8)", () => {
  test("a round is saved with its options, the run ends asked; answering starts a fresh task run", async () => {
    const run = grillingRun(context, mapId, 2);
    taskOn(2, TASK_ROUND);
    expect(latestOf(2)).toMatchObject({ id: run.id, state: "asked" });
    const round = pendingRound(2);
    expect(round).toMatchObject({
      number: 1,
      final: false,
      askedByRun: run.id,
      questions: TASK_ROUND.round?.questions,
    });
    const submitted = submitAnswers(
      context.user,
      context.db,
      SubmitAnswersInput.parse({ roundId: round.id, answers: ANSWERS }),
    );
    expect(submitted.ok).toBe(true);
    // A Task round never settles (S6b-9): the waypoint stays claimed with a fresh task run.
    expect(waypointOf(context, mapId, 2).status).toBe("claimed");
    expect(waypointRuns(2)).toMatchObject([
      { id: run.id, state: "asked" },
      { purpose: "task", state: "running", retryOfRunId: null },
    ]);
    const work = await prepareRun(context.db, latestOf(2).id);
    if (!work.ok || work.value.purpose !== "task") throw new Error("not a task run");
    // The destination's rounds, as stored (DR-14), beside the task's own round.
    expect(work.value.request.mapRounds).toEqual([
      { questions: ROUND.questions, answers: DESTINATION_ANSWERS, final: false },
    ]);
    expect(work.value.request.waypoint).toMatchObject({
      number: 2,
      kind: "task",
      rounds: [{ questions: TASK_ROUND.round?.questions, answers: ANSWERS }],
    });
    expect(work.value.request.earlierOutcomes).toEqual([]);
  });

  test("done writes the outcome and resolves the waypoint with the facts", () => {
    const run = grillingRun(context, mapId, 2);
    taskOn(2, DONE);
    expect(waypointOf(context, mapId, 2)).toMatchObject({
      status: "resolved",
      resolution: "12 files import the client.",
      gist: "12 files",
      agentDecided: ["Counted static imports only"],
      resolvedHow: "run",
      resolvedByRun: run.id,
    });
    expect(context.db.select().from(taskOutcomes).all()).toEqual([
      {
        runId: run.id,
        waypointId: waypointOf(context, mapId, 2).id,
        outcome: "done",
        action: "Counted the imports.",
        facts: "12 files import the client.",
      },
    ]);
    expect(latestOf(2)).toMatchObject({ id: run.id, state: "completed" });
  });

  test("failed writes the outcome, ends the run completed, returns the waypoint to open with no retry", async () => {
    const run = grillingRun(context, mapId, 2);
    taskOn(2, FAILED);
    expect(waypointOf(context, mapId, 2).status).toBe("open");
    expect(waypointRuns(2)).toMatchObject([{ id: run.id, state: "completed" }]);
    expect(context.db.select().from(taskOutcomes).all()).toMatchObject([
      { runId: run.id, outcome: "failed", facts: "The src folder is unreadable." },
    ]);
    const { waypoint } = await overviewWaypoint(2);
    expect(waypoint.taskOutcomes).toMatchObject([{ runId: run.id, outcome: "failed" }]);
    expect(waypoint.state).toEqual({
      kind: "waiting",
      run: { runId: run.id, reason: "task_failed" },
    });
  });

  test("a task run may rule its waypoint out of scope and return map changes (S6b-5, S6b-3)", () => {
    taskOn(2, {
      ...DONE,
      done: null,
      outOfScope: { reason: "Counting is not needed." },
      mapChanges: {
        newWaypoints: [
          {
            kind: "grilling",
            title: "Retries",
            question: "Retry how?",
            blockedBy: [1],
            fromFog: 1,
          },
        ],
        fogOutOfScope: [],
        fogDecided: [],
        fogSettledHere: [],
        newFog: [],
      },
    });
    expect(waypointOf(context, mapId, 2).status).toBe("out_of_scope");
    expect(waypointOf(context, mapId, 4)).toMatchObject({ kind: "grilling", status: "open" });
    expect(context.db.select().from(mapFog).all()).toEqual([]);
    expect(context.db.select().from(taskOutcomes).all()).toEqual([]);
  });

  test("the request after a failure carries the earlier outcomes (L116 (2))", async () => {
    taskOn(2, FAILED);
    expect(tryAgain(context.user, context.db, latestOf(2).id).ok).toBe(true);
    const work = await prepareRun(context.db, latestOf(2).id);
    if (!work.ok || work.value.purpose !== "task") throw new Error("not a task run");
    expect(work.value.request.earlierOutcomes).toEqual([
      {
        outcome: "failed",
        action: "Tried to count the imports.",
        facts: "The src folder is unreadable.",
      },
    ]);
    expect(work.value.request.waypoint.rounds).toEqual([]);
  });
});

describe("Task round submission", () => {
  beforeEach(() => {
    taskOn(2, TASK_ROUND);
  });

  test.each([
    ["an option out of range", [{ optionIndex: 2, note: "", accepted: false }]],
    ["no option and no words", [{ optionIndex: null, note: "", accepted: false }]],
  ])("an answer with %s is refused round_answers_invalid", (_name, answers) => {
    const round = pendingRound(2);
    const submitted = submitAnswers(
      context.user,
      context.db,
      SubmitAnswersInput.parse({ roundId: round.id, answers }),
    );
    expect(!submitted.ok && submitted.error.code).toBe("round_answers_invalid");
    expect(
      context.db.select().from(questionRounds).where(eq(questionRounds.id, round.id)).get(),
    ).toMatchObject({ status: "pending", answers: null });
  });

  test("the recommendation is accepted like any round's", () => {
    const round = pendingRound(2);
    const submitted = submitAnswers(
      context.user,
      context.db,
      SubmitAnswersInput.parse({
        roundId: round.id,
        answers: [{ optionIndex: 0, note: "", accepted: true }],
      }),
    );
    expect(submitted.ok).toBe(true);
  });
});

describe("Try again on a waiting waypoint, retries and the sweep (S6b-12)", () => {
  test("tryAgain on a waiting research run claims the waypoint with a fresh run, itself retried once", () => {
    researchOn(1, research(UNANSWERED));
    const waiting = latestOf(1);
    const again = tryAgain(context.user, context.db, waiting.id);
    expect(again.ok && again.value).toBe(mapId);
    expect(waypointOf(context, mapId, 1).status).toBe("claimed");
    const fresh = latestOf(1);
    expect(fresh).toMatchObject({ purpose: "research", state: "running", retryOfRunId: null });
    failRun(context.user, context.db, fresh.id, { code: "agent_run_failed", message: "Failed" });
    expect(latestOf(1)).toMatchObject({
      purpose: "research",
      state: "running",
      retryOfRunId: fresh.id,
    });
  });

  test("tryAgain on a failed task's run claims it with a fresh task run that settles it", () => {
    taskOn(2, FAILED);
    expect(tryAgain(context.user, context.db, latestOf(2).id).ok).toBe(true);
    expect(waypointOf(context, mapId, 2).status).toBe("claimed");
    expect(latestOf(2)).toMatchObject({ purpose: "task", state: "running", retryOfRunId: null });
    taskOn(2, DONE);
    expect(waypointOf(context, mapId, 2).status).toBe("resolved");
  });

  test("tryAgain is refused on a completed run that resolved its waypoint", () => {
    researchOn(1, research(ANSWERED));
    const resolving = latestOf(1);
    const again = tryAgain(context.user, context.db, resolving.id);
    expect(!again.ok && again.error.code).toBe("planning_run_not_stopped");
  });

  test("tryAgain is refused on a waiting run no longer its waypoint's latest", () => {
    researchOn(1, research(UNANSWERED));
    const first = latestOf(1);
    expect(tryAgain(context.user, context.db, first.id).ok).toBe(true);
    researchOn(1, research(UNANSWERED));
    const again = tryAgain(context.user, context.db, first.id);
    expect(!again.ok && again.error.code).toBe("planning_run_not_stopped");
    expect(tryAgain(context.user, context.db, latestOf(1).id).ok).toBe(true);
  });

  test("a failed research or task run is retried once, then stops and releases its waypoint", () => {
    for (const number of [1, 2]) {
      const first = latestOf(number);
      failRun(context.user, context.db, first.id, { code: "agent_run_failed", message: "Failed" });
      const retry = latestOf(number);
      expect(retry).toMatchObject({
        purpose: first.purpose,
        state: "running",
        retryOfRunId: first.id,
      });
      expect(waypointOf(context, mapId, number).status).toBe("claimed");
      failRun(context.user, context.db, retry.id, { code: "agent_run_failed", message: "Failed" });
      expect(waypointOf(context, mapId, number).status).toBe("open");
      expect(latestOf(number).id).toBe(retry.id);
      expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
      expect(latestOf(number)).toMatchObject({ purpose: first.purpose, state: "running" });
    }
  });

  test("the startup sweep interrupts running research and task runs and retries each", () => {
    const research1 = latestOf(1);
    const task2 = latestOf(2);
    sweepInterruptedRuns(context.db);
    for (const [number, run] of [
      [1, research1],
      [2, task2],
    ] as const) {
      expect(waypointRuns(number)).toMatchObject([
        { id: run.id, state: "failed", errorCode: "planning_run_interrupted" },
        { purpose: run.purpose, state: "running", retryOfRunId: run.id },
      ]);
    }
    expect(
      context.db
        .select({ status: waypointsTable.status })
        .from(waypointsTable)
        .where(eq(waypointsTable.mapId, mapId))
        .all()
        .map((row) => row.status),
    ).toEqual(["claimed", "claimed", "open"]);
  });
});
