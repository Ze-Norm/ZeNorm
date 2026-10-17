/**
 * Shared setup for core's tests (not exported from the package): a temporary database, projects
 * over fresh repositories, and maps taken through charting by the run writers, as the server's
 * planning runner would.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CreateMapInput, LOCAL_EXECUTOR, SubmitAnswersInput } from "@zenorm/contracts";
import type {
  UserActor,
  CodeSurvey,
  Answers,
  CheckResult,
  ChartConfirmation,
  ChartFollowUp,
  ChartProposal,
  MapChanges,
  GrillRound,
  HatchRefusal,
  HatchStage,
  PlanningRun,
  RoundWithdrawnReason,
  Project,
  QuestionRound,
  QuestionRoundDraft,
  RunActor,
  RunEvent,
  SpecReviewFinding,
  SpecHoldKind,
  SpecReviewOutcome,
  DraftSpecsOutcome,
  SpecRevisionContent,
  TicketSetContent,
  TicketSetState,
  TicketsReviewFinding,
  TicketsReviewOutcome,
  Waypoint,
} from "@zenorm/contracts";
import {
  deliveryRunTickets,
  hatchMessages,
  installChangeFeed,
  maps,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
  planningRuns,
  projects,
  questionRounds,
  specifications,
  specReviewFindings,
  specReviews,
  specRevisions,
  specWaits,
  ticketSetRejections,
  ticketSets,
  ticketSetVersions,
  ticketsReviewFindings,
  ticketsReviews,
  waypointTouches,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { recordSurvey } from "./code-survey.ts";
import { deliveryIdentity, endDelivery, prepareDelivery, startDelivery } from "./delivery.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import { createMap, submitAnswers } from "./map.ts";
import { markMerged } from "./mark-merged.ts";
import { approveSpecRevision, approveTicketSet } from "./planning.ts";
import {
  readMapRuns,
  readRounds,
  readWaypoints,
  recordChart,
  recordConsistency,
  recordGrill,
} from "./planning-runs.ts";
import type { Tx } from "./planning-runs.ts";
import { createProject, saveProjectSettings } from "./project.ts";
import { appendRunEvent } from "./run-events.ts";
import { coreSeams, setSeams } from "./seams.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import { recordTicketSet, recordTicketsReview } from "./ticket-set-runs.ts";
import { readMapRevisions, readReview, readTicketSetOf } from "./specs.ts";
import { createChangeBus, localUser, setChangeBus, write } from "./writes.ts";

export const UNKNOWN_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

export const ROUND: QuestionRoundDraft = {
  intro: "I propose: a CSV export of every record. Two questions confirm it.",
  questions: [
    {
      topic: "Scope",
      text: "How far should this go?",
      options: [
        { label: "Narrow", detail: "Ships soon." },
        { label: "Wide", detail: "Covers everything." },
      ],
    },
    {
      topic: "Audience",
      text: "Who is it for?",
      options: [
        { label: "Me", detail: "Simple." },
        { label: "Team", detail: "Shared." },
      ],
    },
  ],
};

export const PROPOSAL: ChartProposal = {
  title: "Data export",
  summary: "People want to take their records elsewhere.",
  destination: "A CSV export of every record, offered from the project page.",
  round: ROUND,
  split: [],
};

/** A follow-up on the destination, not final; its round has `ROUND`'s questions. */
export const FOLLOW_UP: ChartFollowUp = {
  title: "Data export and archive",
  summary: "People want to take their records elsewhere, archived ones too.",
  destination: "A CSV export of every record, archived ones included, from the project page.",
  round: {
    intro: "I now propose: a CSV export that includes archived records. Two questions confirm it.",
    final: false,
    questions: ROUND.questions,
  },
};

/** Waypoints 1, 2 and 3, with 2 and 3 blocked by 1. */
export const CONFIRMATION: ChartConfirmation = {
  title: PROPOSAL.title,
  summary: PROPOSAL.summary,
  destination: "A CSV export of every record, from the project page, for the team.",
  waypoints: [
    {
      kind: "grilling",
      title: "Which columns",
      question: "Which columns does the export write?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Which encoding",
      question: "Which encoding does the file use?",
      blockedBy: [1],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Where to offer it",
      question: "Where is the export offered?",
      blockedBy: [1],
      touches: [],
    },
  ],
  fog: [],
  outOfScope: [],
  proposals: [],
};

/** No map change: what a run that settles nothing on its map returns. */
export const NO_MAP_CHANGES: MapChanges = {
  newWaypoints: [],
  fogOutOfScope: [],
  fogDecided: [],
  fogSettledHere: [],
  newFog: [],
};

export const NO_WAYPOINTS: ChartConfirmation = { ...CONFIRMATION, waypoints: [] };

export const ANSWERS: Answers = [
  { optionIndex: 0, note: "", accepted: false },
  { optionIndex: 1, note: "The whole team", accepted: false },
];

/** A first revision: one clause from the destination, two criteria. */
/** A revision's content as To Spec writes it: every clause declares reliesOn and adds. */
export type DraftContent = DraftSpecsOutcome["specs"][number]["content"];

export const SPEC: DraftContent = {
  title: "Export data as CSV",
  problem: "No export.",
  solution: "A CSV exporter.",
  clauses: [
    {
      id: "C1",
      title: "CSV export",
      text: "Every record exports to one CSV file.",
      criteria: [
        { id: "1.1", text: "A CSV file downloads." },
        { id: "1.2", text: "Every row is exported." },
      ],
      sources: [{ kind: "destination" }],
      reliesOn: [],
      adds: ["CSV export"],
    },
  ],
  outOfScope: ["Excel files."],
};

/** A ticket set for SPEC: two tickets, T2 blocked by T1. */
export const TICKETS: TicketSetContent = {
  tickets: [
    {
      id: "T1",
      title: "Write the CSV exporter",
      build: "Build it.",
      blockedBy: [],
      criteria: ["1.2"],
      testing: ["Every row is in the file."],
      followUp: null,
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
    {
      id: "T2",
      title: "Add the Export button",
      build: "Wire it.",
      blockedBy: [{ ticket: "T1", supplies: "the exporter" }],
      criteria: ["1.1"],
      testing: ["The button downloads the file."],
      followUp: null,
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "work", ticket: "T2", reason: null },
    { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
  ],
  slicing: "Exporter first, then the button.",
  execution: "Both verify with the package tests.",
};

/** A review with no finding: it passes. */
export const PASSED_REVIEW: SpecReviewOutcome = {
  summary: "Every clause traces.",
  findings: [],
  verified: [],
};

/** A revise finding on C1. */
export const REVISE_FINDING: SpecReviewFinding = {
  kind: "invented_scope",
  route: "revise",
  title: "Invented clause",
  explanation: "C1 says 'every record', which no source settles.",
  question: "Should every record export?",
  elementIds: ["C1"],
  waypointNumbers: [],
};

export interface TestContext {
  readonly root: string;
  readonly db: ZeNormDatabase;
  /** The instance's one User as the `user` actor: what a procedure-style write is made as. */
  readonly user: UserActor;
}

export async function openTestContext(prefix: string): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const opened = openDatabase(join(root, "zenorm.sqlite"));
  if (!opened.ok) throw new Error(opened.error.message);
  const migrated = migrateDatabase(opened.value, MIGRATIONS_FOLDER);
  if (!migrated.ok) throw new Error(migrated.error.message);
  return testContextOf(root, opened.value);
}

/**
 * The test context over a migrated database at `root`: it installs the change feed and the
 * `user_id` refusals (so a write outside `write` fails with `actor_missing`, and a run or map
 * without its User with `user_id_missing`), sets the database's change bus, which `write` needs,
 * and names the one User as the `user` actor.
 */
export function testContextOf(root: string, db: ZeNormDatabase): TestContext {
  installChangeFeed(db);
  // No test subscribes a subscriber that throws; one that does fails the test loudly.
  setChangeBus(
    db,
    createChangeBus((message, error) => {
      throw new Error(message, { cause: error });
    }),
  );
  // Core's own seams, as an app with no plugins composes them.
  setSeams(db, coreSeams(db));
  return { root, db, user: { kind: "user", userId: localUser(db).id } };
}

/**
 * Writes fixture rows as `system`. This is test data, not ZeNorm acting on its own: `system` is
 * reserved for the startup sweep in the app, and a fixture is the one place
 * a write may borrow it, so the installed feed triggers accept the rows. A test that asserts an
 * actor writes through the core function with the actor it checks.
 */
export function writeTestData<T>(context: TestContext, fn: (tx: Tx) => T): T {
  return write(context.db, { kind: "system" }, fn);
}

export async function closeTestContext(context: TestContext): Promise<void> {
  context.db.$client.close();
  await rm(context.root, { recursive: true, force: true });
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A Project over a fresh repository on `main` with one commit holding a README. */
export async function addProject(context: TestContext, name: string): Promise<Project> {
  const path = join(context.root, name);
  await mkdir(path);
  git(path, ["init", "-q", "-b", "main"]);
  await writeFile(join(path, "README.md"), "# Repo\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-q", "-m", "init"]);
  const created = await createProject(context.user, context.db, {
    folderPath: path,
    baseBranch: "main",
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

/** A new map in `project`; its first chart run is running. */
export async function newMap(
  context: TestContext,
  project: Project,
  idea: string,
): Promise<string> {
  const created = await createMap(
    context.user,
    context.db,
    CreateMapInput.parse({ projectId: project.id, idea }),
  );
  if (!created.ok) throw new Error(created.error.code);
  return created.value.map.id;
}

/** The map's planning runs, oldest first. */
export function runsOf(context: TestContext, mapId: string): PlanningRun[] {
  return readMapRuns(context.db, mapId);
}

/** The map's latest planning run; the map has one. */
export function latestRun(context: TestContext, mapId: string): PlanningRun {
  const run = runsOf(context, mapId).at(-1);
  if (run === undefined) throw new Error(`Map ${mapId} has no planning run`);
  return run;
}

/** Every planning run, oldest first. */
export function allRuns(context: TestContext): PlanningRun[] {
  return context.db
    .select()
    .from(planningRuns)
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all();
}

/** The one running run of the map's own scope (hatch runs are each message's own). */
export function runningMapRun(context: TestContext, mapId: string): PlanningRun {
  const running = runsOf(context, mapId).filter(
    (run) =>
      run.waypointId === null &&
      run.specificationId === null &&
      run.purpose !== "hatch" &&
      run.state === "running",
  );
  const [run] = running;
  if (run === undefined || running.length !== 1) {
    throw new Error(`Map ${mapId} has ${String(running.length)} running map-level runs`);
  }
  return run;
}

/** Saves the first chart's proposal; the destination round is then pending. */
export function propose(context: TestContext, mapId: string): void {
  const chart = runningMapRun(context, mapId);
  const recorded = recordChart(context.user, context.db, chart.id, {
    kind: "proposal",
    proposal: PROPOSAL,
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** The map's pending map-level round's id. */
export function pendingMapRound(context: TestContext, mapId: string): string {
  const round = readRounds(context.db, mapId).find(
    (candidate) => candidate.waypointId === null && candidate.status === "pending",
  );
  if (round === undefined) throw new Error(`Map ${mapId} has no pending map-level round`);
  return round.id;
}

/** Answers the pending destination round; the confirming chart is then running. */
export function answerDestination(context: TestContext, mapId: string): void {
  const submitted = submitAnswers(
    context.user,
    context.db,
    SubmitAnswersInput.parse({ roundId: pendingMapRound(context, mapId), answers: ANSWERS }),
  );
  if (!submitted.ok) throw new Error(submitted.error.code);
}

/** Saves the running chart's follow-up; the next map-level round is then pending. */
export function followUp(context: TestContext, mapId: string, content: ChartFollowUp): void {
  const chart = runningMapRun(context, mapId);
  const recorded = recordChart(context.user, context.db, chart.id, {
    kind: "followUp",
    followUp: content,
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/**
 * Answers map-level round `number`, which must be the pending one, with `ANSWERS`; the chart is
 * then running.
 */
export function answerMapRound(context: TestContext, mapId: string, number: number): void {
  const round = readRounds(context.db, mapId).find(
    (candidate) => candidate.waypointId === null && candidate.number === number,
  );
  if (round?.status !== "pending")
    throw new Error(`Map-level round ${String(number)} is not pending`);
  answerDestination(context, mapId);
}

/** A code survey of `addProject`'s repository: its README, one line long. */
export const SURVEY: CodeSurvey = {
  entries: [
    {
      area: "README.md",
      role: "The repository's readme.",
      touched: false,
      why: "The destination changes no documentation.",
      surfaceFiles: ["README.md"],
      facts: [{ claim: "The readme is a single heading.", path: "README.md", line: 1 }],
    },
  ],
  identifiers: [{ name: "Repo", meaning: "The readme's heading.", path: "README.md", line: 1 }],
  unverifiable: [],
};

/** Saves the confirming chart's outcome, without the code survey it starts. */
export function confirmChart(
  context: TestContext,
  mapId: string,
  confirmation: ChartConfirmation,
): void {
  const chart = runningMapRun(context, mapId);
  const recorded = recordChart(context.user, context.db, chart.id, {
    kind: "confirmation",
    confirmation,
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Saves `survey` as the running `survey` run's outcome. */
export function survey(context: TestContext, mapId: string, content: CodeSurvey): void {
  const run = runningMapRun(context, mapId);
  if (run.purpose !== "survey") throw new Error(`The running map run is ${run.purpose}`);
  const recorded = recordSurvey(
    context.user,
    context.db,
    run.id,
    mapFolder(context, mapId),
    content,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Saves the confirming chart's outcome, then the code survey it starts. */
export function confirm(
  context: TestContext,
  mapId: string,
  confirmation: ChartConfirmation,
): void {
  confirmChart(context, mapId, confirmation);
  survey(context, mapId, SURVEY);
}

/** A map charted with no waypoints: cleared, its `to_spec` run running. */
export async function clearedMap(context: TestContext, project: Project): Promise<string> {
  const mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirm(context, mapId, NO_WAYPOINTS);
  return mapId;
}

/** The spec-scoped running run of `purpose` on the map; anything else throws. */
export function runningSpecRun(
  context: TestContext,
  mapId: string,
  purpose: PlanningRun["purpose"],
): PlanningRun {
  const running = runsOf(context, mapId).filter(
    (run) => run.state === "running" && run.specificationId !== null && run.purpose === purpose,
  );
  const [run] = running;
  if (run === undefined || running.length > 1) {
    throw new Error(`Map ${mapId} has ${String(running.length)} running ${purpose} runs`);
  }
  return run;
}

/** A cleared map with spec 1's revision 1 written, its review running; returns its ids. */
export async function draftedSpec(
  context: TestContext,
  project: Project,
): Promise<{ mapId: string; specificationId: string; specRevisionId: string }> {
  const mapId = await clearedMap(context, project);
  const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
    specs: [{ specNumber: null, content: SPEC }],
    waits: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  const revision = readMapRevisions(context.db, mapId).at(-1);
  if (revision === undefined) throw new Error(`Map ${mapId} has no spec revision`);
  return { mapId, specificationId: revision.specificationId, specRevisionId: revision.id };
}

/** `draftedSpec` with its review recorded: passed unless findings are given. */
export async function reviewedSpec(
  context: TestContext,
  project: Project,
  findings: readonly SpecReviewFinding[] = [],
): Promise<{ mapId: string; specificationId: string; specRevisionId: string }> {
  const drafted = await draftedSpec(context, project);
  const review = runningSpecRun(context, drafted.mapId, "spec_review");
  const recorded = recordSpecReview(context.user, context.db, review.id, {
    summary: PASSED_REVIEW.summary,
    findings: [...findings],
    verified: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  return drafted;
}

/**
 * A passed, approved spec with ticket set version 1 written, awaiting review, its tickets review
 * running; returns its ids.
 */
export async function draftedTicketSet(
  context: TestContext,
  project: Project,
): Promise<{ mapId: string; specificationId: string; ticketSetId: string }> {
  const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
  const approved = approveSpecRevision(context.user, context.db, { specRevisionId });
  if (!approved.ok) throw new Error(approved.error.code);
  const recorded = recordTicketSet(
    context.user,
    context.db,
    runningSpecRun(context, mapId, "to_tickets").id,
    TICKETS,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
  const set = readTicketSetOf(context.db, specRevisionId);
  if (set === undefined) throw new Error(`Map ${mapId} has no ticket set`);
  return { mapId, specificationId, ticketSetId: set.id };
}

/** A passed tickets review's outcome (no finding). */
export const PASSED_TICKETS_REVIEW: TicketsReviewOutcome = {
  summary: "Every criterion traces to its clause.",
  findings: [],
};

/** Records the spec's running `tickets_review` with `outcome` (passed by default); throws on a refusal. */
export function recordRunningTicketsReview(
  context: TestContext,
  mapId: string,
  outcome: TicketsReviewOutcome = PASSED_TICKETS_REVIEW,
): void {
  const recorded = recordTicketsReview(
    context.user,
    context.db,
    runningSpecRun(context, mapId, "tickets_review").id,
    outcome,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** `draftedTicketSet` with version 1's tickets review recorded passed: the set can be decided. */
export async function reviewedTicketSet(
  context: TestContext,
  project: Project,
): Promise<{ mapId: string; specificationId: string; ticketSetId: string }> {
  const drafted = await draftedTicketSet(context, project);
  recordRunningTicketsReview(context, drafted.mapId);
  return drafted;
}

/**
 * `draftedTicketSet` as a set from before tickets reviews: its tickets review run deleted, so the
 * test inserts the review runs and records it reads.
 */
export async function unreviewedTicketSet(
  context: TestContext,
  project: Project,
): Promise<{ mapId: string; specificationId: string; ticketSetId: string }> {
  const drafted = await draftedTicketSet(context, project);
  deleteRunningTicketsReview(context, drafted.mapId);
  return drafted;
}

/**
 * Deletes the map's running `tickets_review` row, so a test inserts the review runs it reads; the
 * next write on the map starts the review again.
 */
export function deleteRunningTicketsReview(context: TestContext, mapId: string): void {
  writeTestData(context, (tx) =>
    tx
      .delete(planningRuns)
      .where(eq(planningRuns.id, runningSpecRun(context, mapId, "tickets_review").id))
      .run(),
  );
}

/** Inserts a spec row numbered `number` in the project; returns its id. */
export function insertSpec(context: TestContext, projectId: string, number: number): string {
  const id = uuidv7();
  writeTestData(context, (tx) => tx.insert(specifications).values({ id, projectId, number }).run());
  return id;
}

/**
 * Inserts a planning run row as given (spec-scoped when `specificationId` is set; a `to_spec`,
 * `to_tickets` or `hatch` run may name its message); returns it.
 */
export function insertRun(
  context: TestContext,
  run: Pick<PlanningRun, "mapId" | "specificationId" | "purpose" | "state"> &
    Partial<
      Pick<
        PlanningRun,
        "errorCode" | "errorMessage" | "retryOfRunId" | "cancelReason" | "hatchMessageId"
      >
    >,
): PlanningRun {
  const ended = run.state !== "running";
  const row: PlanningRun = {
    id: uuidv7(),
    mapId: run.mapId,
    waypointId: null,
    specificationId: run.specificationId,
    purpose: run.purpose,
    state: run.state,
    retryOfRunId: run.retryOfRunId === undefined ? null : run.retryOfRunId,
    errorCode: run.errorCode === undefined ? null : run.errorCode,
    errorMessage: run.errorMessage === undefined ? null : run.errorMessage,
    cancelReason: run.cancelReason === undefined ? null : run.cancelReason,
    hatchMessageId: run.hatchMessageId === undefined ? null : run.hatchMessageId,
    startedAt: new Date().toISOString(),
    endedAt: ended ? new Date().toISOString() : null,
  };
  writeTestData(context, (tx) =>
    tx
      .insert(planningRuns)
      .values({ ...row, userId: context.user.userId })
      .run(),
  );
  return row;
}

/** Inserts a revision row written by `writtenByRun` on `mapId`; returns its id. */
export function insertRevision(
  context: TestContext,
  revision: {
    specificationId: string;
    revision: number;
    mapId: string;
    writtenByRun: string;
    content: SpecRevisionContent;
    approvedAt?: string | null;
    supersededAt?: string | null;
    rejectionReason?: string | null;
  },
): string {
  const id = uuidv7();
  writeTestData(context, (tx) =>
    tx
      .insert(specRevisions)
      .values({
        id,
        specificationId: revision.specificationId,
        revision: revision.revision,
        mapId: revision.mapId,
        writtenByRun: revision.writtenByRun,
        content: revision.content,
        createdAt: new Date().toISOString(),
        approvedAt: revision.approvedAt === undefined ? null : revision.approvedAt,
        supersededAt: revision.supersededAt === undefined ? null : revision.supersededAt,
        rejectionReason: revision.rejectionReason === undefined ? null : revision.rejectionReason,
      })
      .run(),
  );
  return id;
}

/** Inserts a review of the revision by `runId` with its findings (none escalated); returns its id. */
export function insertReview(
  context: TestContext,
  review: { specRevisionId: string; runId: string; findings: readonly SpecReviewFinding[] },
): string {
  const id = uuidv7();
  writeTestData(context, (tx) =>
    tx
      .insert(specReviews)
      .values({
        id,
        specRevisionId: review.specRevisionId,
        runId: review.runId,
        passed: review.findings.length === 0,
        summary: PASSED_REVIEW.summary,
        sources: [],
      })
      .run(),
  );
  for (const [index, finding] of review.findings.entries()) {
    writeTestData(context, (tx) =>
      tx
        .insert(specReviewFindings)
        .values({
          reviewId: id,
          position: index + 1,
          ...finding,
          escalated: false,
          waypointId: null,
        })
        .run(),
    );
  }
  return id;
}

/**
 * Inserts a ticket set for the revision at `version` (each version from 1 with TICKETS, written by
 * `runId`), in `state`, with a rejection of each version in `rejected`; returns its id.
 */
export function insertTicketSet(
  context: TestContext,
  set: {
    specRevisionId: string;
    runId: string;
    version: number;
    state: TicketSetState;
    rejected: readonly number[];
  },
): string {
  const id = uuidv7();
  const at = new Date().toISOString();
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSets)
      .values({
        id,
        specRevisionId: set.specRevisionId,
        state: set.state,
        version: set.version,
        createdAt: at,
        updatedAt: at,
        approvedAt: set.state === "approved" ? at : null,
      })
      .run(),
  );
  for (let version = 1; version <= set.version; version += 1) {
    writeTestData(context, (tx) =>
      tx
        .insert(ticketSetVersions)
        .values({
          ticketSetId: id,
          version,
          content: TICKETS,
          writtenByRun: set.runId,
          createdAt: at,
        })
        .run(),
    );
  }
  for (const version of set.rejected) {
    writeTestData(context, (tx) =>
      tx
        .insert(ticketSetRejections)
        .values({ ticketSetId: id, version, reason: "Split the exporter.", rejectedAt: at })
        .run(),
    );
  }
  return id;
}

/** A tickets review finding the approved revision settles (revise). */
export const TICKETS_REVISE_FINDING: TicketsReviewFinding = {
  kind: "untraced_criterion",
  route: "revise",
  title: "Adds a CSV format",
  explanation: "T1 offers CSV, which no criterion states.",
  question: "Should the export offer CSV?",
  ticketNumbers: ["T1"],
  criterionIds: ["1.1"],
};

/** A tickets review finding only the person can settle (decision). */
export const TICKETS_DECISION_FINDING: TicketsReviewFinding = {
  kind: "contradiction",
  route: "decision",
  title: "Two slicings of the export",
  explanation: "1.1 admits an exporter first or a button first; the clause picks neither.",
  question: "Should the exporter or the button ship first?",
  ticketNumbers: ["T1", "T2"],
  criterionIds: ["1.1"],
};

/** A failed tickets review's outcome with one `revise` finding: its repair is due. */
export const FAILED_TICKETS_REVIEW: TicketsReviewOutcome = {
  summary: "One criterion is not traced.",
  findings: [TICKETS_REVISE_FINDING],
};

/**
 * Records the spec's running `to_tickets` (a first version, a rewrite or a review repair) with
 * TICKETS; throws on a refusal. Its version's tickets review then starts.
 */
export function recordRunningTicketSet(context: TestContext, mapId: string): void {
  const recorded = recordTicketSet(
    context.user,
    context.db,
    runningSpecRun(context, mapId, "to_tickets").id,
    TICKETS,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/**
 * `draftedTicketSet` whose versions 1, 2 and 3 each fail a revise-only review, 2 and 3 written by
 * review repairs: version 3 is the second consecutive repair, so its review escalates and the set
 * is held.
 */
export async function heldTicketSet(
  context: TestContext,
  project: Project,
): Promise<{ mapId: string; specificationId: string; ticketSetId: string }> {
  const drafted = await draftedTicketSet(context, project);
  recordRunningTicketsReview(context, drafted.mapId, FAILED_TICKETS_REVIEW);
  recordRunningTicketSet(context, drafted.mapId);
  recordRunningTicketsReview(context, drafted.mapId, FAILED_TICKETS_REVIEW);
  recordRunningTicketSet(context, drafted.mapId);
  recordRunningTicketsReview(context, drafted.mapId, FAILED_TICKETS_REVIEW);
  return drafted;
}

/** A failed run: what a stopped run and its failed retry carry. */
const FAILED_RUN = {
  state: "failed",
  errorCode: "agent_timed_out",
  errorMessage: "The agent timed out",
} as const;

/**
 * Inserts a spec's spec-scoped run of `purpose` as `state` describes it: `running`; `stopped` (a
 * failed run and its failed retry); or `completed`. Returns the last run inserted.
 */
function insertSpecRun(
  context: TestContext,
  run: {
    mapId: string;
    specificationId: string;
    purpose: "tickets_review" | "to_tickets" | "to_spec";
    state: "running" | "stopped" | "completed";
  },
): PlanningRun {
  const scope = { mapId: run.mapId, specificationId: run.specificationId, purpose: run.purpose };
  if (run.state !== "stopped") {
    return insertRun(context, { ...scope, state: run.state });
  }
  const first = insertRun(context, { ...scope, ...FAILED_RUN });
  return insertRun(context, { ...scope, ...FAILED_RUN, retryOfRunId: first.id });
}

/** Inserts a `tickets_review` run of the spec: running, stopped after a failed retry, or completed. */
export function insertTicketsReviewRun(
  context: TestContext,
  run: { mapId: string; specificationId: string; state: "running" | "stopped" | "completed" },
): PlanningRun {
  return insertSpecRun(context, { ...run, purpose: "tickets_review" });
}

/**
 * Records a tickets review of the set's current version by a completed `tickets_review` run, with
 * `findings` in order (each with its `escalated` mark), and sets the set `review_passed` or
 * `review_failed`, as recording does. Returns the review's id.
 */
export function insertTicketsReview(
  context: TestContext,
  review: {
    mapId: string;
    specificationId: string;
    ticketSetId: string;
    findings: readonly { finding: TicketsReviewFinding; escalated: boolean }[];
  },
): string {
  const set = context.db
    .select()
    .from(ticketSets)
    .where(eq(ticketSets.id, review.ticketSetId))
    .get();
  if (set === undefined) throw new Error(`No ticket set ${review.ticketSetId}`);
  const run = insertTicketsReviewRun(context, { ...review, state: "completed" });
  const id = uuidv7();
  const passed = review.findings.length === 0;
  writeTestData(context, (tx) =>
    tx
      .insert(ticketsReviews)
      .values({
        id,
        ticketSetId: set.id,
        ticketSetVersion: set.version,
        runId: run.id,
        passed,
        summary: passed ? "Every criterion traces to its clause." : "The tickets need work.",
      })
      .run(),
  );
  for (const [index, { finding, escalated }] of review.findings.entries()) {
    writeTestData(context, (tx) =>
      tx
        .insert(ticketsReviewFindings)
        .values({ reviewId: id, position: index + 1, ...finding, escalated })
        .run(),
    );
  }
  writeTestData(context, (tx) =>
    tx
      .update(ticketSets)
      .set({ state: passed ? "review_passed" : "review_failed" })
      .where(eq(ticketSets.id, set.id))
      .run(),
  );
  return id;
}

/**
 * Inserts a review repair (a `to_tickets` run with no hatch message) of the spec:
 * running, stopped after a failed retry, or completed, which writes the set's next version (TICKETS)
 * in `awaiting_review`, as a repair's write does. Returns the last run inserted.
 */
export function insertTicketsRepair(
  context: TestContext,
  repair: {
    mapId: string;
    specificationId: string;
    ticketSetId: string;
    state: "running" | "stopped" | "completed";
  },
): PlanningRun {
  const run = insertSpecRun(context, { ...repair, purpose: "to_tickets" });
  if (repair.state !== "completed") {
    return run;
  }
  const set = context.db
    .select()
    .from(ticketSets)
    .where(eq(ticketSets.id, repair.ticketSetId))
    .get();
  if (set === undefined) throw new Error(`No ticket set ${repair.ticketSetId}`);
  const version = set.version + 1;
  const at = new Date().toISOString();
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSetVersions)
      .values({
        ticketSetId: set.id,
        version,
        content: TICKETS,
        writtenByRun: run.id,
        createdAt: at,
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .update(ticketSets)
      .set({ version, state: "awaiting_review", updatedAt: at })
      .where(eq(ticketSets.id, set.id))
      .run(),
  );
  return run;
}

/** A waypoint round: two questions; `final` as given. */
export function grillRound(final: boolean): GrillRound {
  return { intro: "Two choices on the columns.", final, questions: ROUND.questions };
}

/** Both answers an option without words: a final round answered so still starts the grilling run. */
export const PLAIN_ANSWERS: Answers = [
  { optionIndex: 0, note: "", accepted: true },
  { optionIndex: 1, note: "", accepted: false },
];

/** A map charted with CONFIRMATION: waypoint 1 claimed and grilling, 2 and 3 blocked by it. */
export async function chartedMap(context: TestContext, project: Project): Promise<string> {
  const mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirm(context, mapId, CONFIRMATION);
  return mapId;
}

/** The map's waypoint by number. */
export function waypointOf(context: TestContext, mapId: string, number: number): Waypoint {
  const waypoint = readWaypoints(context.db, mapId).find((w) => w.number === number);
  if (waypoint === undefined) throw new Error(`Map ${mapId} has no waypoint ${String(number)}`);
  return waypoint;
}

/** The one running run of waypoint `number`'s scope. */
export function grillingRun(context: TestContext, mapId: string, number: number): PlanningRun {
  const { id } = waypointOf(context, mapId, number);
  const running = runsOf(context, mapId).filter(
    (run) => run.waypointId === id && run.state === "running",
  );
  const [run] = running;
  if (run === undefined || running.length !== 1) {
    throw new Error(`Waypoint ${String(number)} has ${String(running.length)} running runs`);
  }
  return run;
}

/** Waypoint `number`'s running run asks a round. */
export function ask(context: TestContext, mapId: string, number: number, final: boolean): void {
  const recorded = recordGrill(context.user, context.db, grillingRun(context, mapId, number).id, {
    round: grillRound(final),
    resolution: null,
    outOfScope: null,
    mapChanges: null,
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Waypoint `number`'s running run resolves it, after an answered round when the person decides it. */
export function resolve(context: TestContext, mapId: string, number: number): void {
  const waypoint = waypointOf(context, mapId, number);
  if (
    waypoint.personDecides &&
    !readRounds(context.db, mapId).some(
      (round) => round.waypointId === waypoint.id && round.status === "submitted",
    )
  ) {
    // Only the person settles it: its grilling asks a round, and the person answers it, first.
    const asked = recordGrill(context.user, context.db, grillingRun(context, mapId, number).id, {
      round: grillRound(false),
      resolution: null,
      outOfScope: null,
      mapChanges: null,
    });
    if (!asked.ok) throw new Error(asked.error.code);
    answer(context, mapId, number, PLAIN_ANSWERS);
  }
  const recorded = recordGrill(context.user, context.db, grillingRun(context, mapId, number).id, {
    round: null,
    resolution: {
      resolution: `Resolved ${String(number)}.`,
      gist: `Gist ${String(number)}`,
      agentDecided: [],
    },
    outOfScope: null,
    mapChanges: NO_MAP_CHANGES,
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Waypoint `number`'s pending round. */
export function pendingRoundOn(context: TestContext, mapId: string, number: number): QuestionRound {
  const { id } = waypointOf(context, mapId, number);
  const round = readRounds(context.db, mapId).find(
    (candidate) => candidate.waypointId === id && candidate.status === "pending",
  );
  if (round === undefined) throw new Error(`Waypoint ${String(number)} has no pending round`);
  return round;
}

/** Answers waypoint `number`'s pending round. */
export function answer(
  context: TestContext,
  mapId: string,
  number: number,
  answers: Answers,
): void {
  const submitted = submitAnswers(
    context.user,
    context.db,
    SubmitAnswersInput.parse({ roundId: pendingRoundOn(context, mapId, number).id, answers }),
  );
  if (!submitted.ok) throw new Error(submitted.error.code);
}

/** The map's running `consistency` run finds nothing: a clean pass. */
export function cleanPass(context: TestContext, mapId: string): void {
  const run = runningMapRun(context, mapId);
  if (run.purpose !== "consistency") throw new Error(`The running map run is ${run.purpose}`);
  const recorded = recordConsistency(context.user, context.db, run.id, {
    findings: [],
    proposals: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** A message's state as a helper stores it: unreplied, replied, or replied with a refusal. */
export type StoredMessageState = "queued" | "replied" | { refused: HatchRefusal };

/**
 * Inserts a hatch message on `mapId` from `stage` (`specificationId` null on Idea and Wayfinding).
 * A replied or refused one gets the completed `hatch` run that replied; returns the message id.
 */
export function insertMessage(
  context: TestContext,
  mapId: string,
  message: {
    state: StoredMessageState;
    stage: HatchStage;
    specificationId: string | null;
    text: string;
  },
): string {
  const id = uuidv7();
  writeTestData(context, (tx) =>
    tx
      .insert(hatchMessages)
      .values({
        id,
        mapId,
        stage: message.stage,
        specificationId: message.specificationId,
        text: message.text,
        sentAt: new Date().toISOString(),
        runId: null,
        reply: null,
        refusal: null,
        change: null,
        repliedAt: null,
      })
      .run(),
  );
  if (message.state === "queued") {
    return id;
  }
  const run = insertHatchRun(context, mapId, id, "completed");
  const { state } = message;
  writeTestData(context, (tx) =>
    tx
      .update(hatchMessages)
      .set({
        runId: run.id,
        reply: "Yes: any depth.",
        refusal: state === "replied" ? null : state.refused,
        repliedAt: new Date().toISOString(),
      })
      .where(eq(hatchMessages.id, id))
      .run(),
  );
  return id;
}

/**
 * Inserts the `hatch` run of a message in the given state: `running`, `stopped` (a failed first
 * attempt and its failed retry; returns the retry), or `completed`; returns the (latest) run.
 */
export function insertHatchRun(
  context: TestContext,
  mapId: string,
  messageId: string,
  state: "running" | "stopped" | "completed",
): PlanningRun {
  const hatch = {
    mapId,
    specificationId: null,
    purpose: "hatch",
    hatchMessageId: messageId,
  } as const;
  if (state !== "stopped") {
    return insertRun(context, { ...hatch, state });
  }
  const failed = {
    state: "failed",
    errorCode: "agent_timed_out",
    errorMessage: "The agent timed out",
  } as const;
  const first = insertRun(context, { ...hatch, ...failed });
  return insertRun(context, { ...hatch, ...failed, retryOfRunId: first.id });
}

/** Withdraws the pending round `roundId` with `reason` (as a reopen or a direction does). */
export function withdrawRound(
  context: TestContext,
  roundId: string,
  reason: RoundWithdrawnReason,
): void {
  const withdrawn = writeTestData(context, (tx) =>
    tx
      .update(questionRounds)
      .set({ status: "withdrawn", withdrawnAt: new Date().toISOString(), withdrawnReason: reason })
      .where(and(eq(questionRounds.id, roundId), eq(questionRounds.status, "pending")))
      .run(),
  );
  if (withdrawn.changes !== 1) {
    throw new Error(`Round ${roundId} is not pending`);
  }
}

/** Waypoints 1, 2 and 3 in a chain: 2 blocked by 1, 3 blocked by 2 (a two-deep cascade). */
export const CHAIN: ChartConfirmation = {
  ...CONFIRMATION,
  waypoints: CONFIRMATION.waypoints.map((waypoint, index) => ({
    ...waypoint,
    blockedBy: index === 0 ? [] : [index],
  })),
};

/**
 * A map charted with CHAIN whose waypoint 1 asked and settled a final round and whose 2 and 3
 * were resolved by their runs, then cleanly passed: cleared, its first `to_spec` running.
 */
export async function resolvedChain(context: TestContext, project: Project): Promise<string> {
  const mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirm(context, mapId, CHAIN);
  ask(context, mapId, 1, true);
  answer(context, mapId, 1, PLAIN_ANSWERS);
  resolve(context, mapId, 1);
  resolve(context, mapId, 2);
  resolve(context, mapId, 3);
  cleanPass(context, mapId);
  return mapId;
}

// --- Delivery: for 04, 05 and 07, which may not edit this file. ---

/** The required checks the delivery helpers save: one that passes in any repository. */
export const REQUIRED_CHECKS = ["git status --short"];

/** The repair limit the delivery helpers save: 0, no repair, so a failing check ends the run. */
export const REPAIR_LIMIT = 0;

/**
 * Saves `project`'s settings with its base branch kept, `checks` as its required checks, the
 * repair limit `REPAIR_LIMIT` and no fix commands.
 */
export async function saveChecks(
  context: TestContext,
  project: Project,
  checks: readonly string[],
): Promise<Project> {
  const saved = await saveProjectSettings(context.user, context.db, {
    projectId: project.id,
    baseBranch: project.baseBranch,
    requiredChecks: [...checks],
    repairLimit: REPAIR_LIMIT,
    fixCommands: [],
  });
  if (!saved.ok) throw new Error(saved.error.code);
  return saved.value;
}

/**
 * A deliverable spec in `project`'s real temp repository (`addProject`): `REQUIRED_CHECKS` saved,
 * and an approved ticket set of `TICKETS` (T2 blocked by T1, which supplies "the exporter").
 */
export async function deliverableTicketSet(
  context: TestContext,
  project: Project,
): Promise<{ mapId: string; specificationId: string; ticketSetId: string }> {
  await saveChecks(context, project, REQUIRED_CHECKS);
  const reviewed = await reviewedTicketSet(context, project);
  const approved = approveTicketSet(context.user, context.db, {
    ticketSetId: reviewed.ticketSetId,
  });
  if (!approved.ok) throw new Error(approved.error.code);
  return reviewed;
}

/** `delivery.start` on the set, with its runs under `<root>/runs`: the run and its ticket rows. */
export async function startedRun(
  context: TestContext,
  ticketSetId: string,
): Promise<StoredDeliveryRun> {
  const started = await startDelivery(context.user, context.db, {
    ticketSetId,
    runsDir: join(context.root, "runs"),
    executor: LOCAL_EXECUTOR,
  });
  if (!started.ok) throw new Error(started.error.code);
  return started.value.run;
}

/** The stored folder of the run's project: what core's checkout seam gives its start. */
export function runFolder(db: ZeNormDatabase, run: { projectId: string }): string {
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  if (project === undefined) throw new Error(`No project ${run.projectId}`);
  return project.folderPath;
}

/** The stored folder of the map's project. */
export function mapFolder(context: TestContext, mapId: string): string {
  const map = context.db.select().from(maps).where(eq(maps.id, mapId)).get();
  if (map === undefined) throw new Error(`No map ${mapId}`);
  return runFolder(context.db, map);
}

/** Records a run's ticket as started now (the runner's `ticket_started`, by a direct row write). */
export function markTicketStarted(context: TestContext, runId: string, ticket: string): void {
  const updated = writeTestData(context, (tx) =>
    tx
      .update(deliveryRunTickets)
      .set({ startedAt: new Date().toISOString() })
      .where(and(eq(deliveryRunTickets.runId, runId), eq(deliveryRunTickets.ticket, ticket)))
      .run(),
  );
  if (updated.changes !== 1) throw new Error(`Run ${runId} has no ticket ${ticket}`);
}

/** Records a run's ticket as merged now at `commit` (the runner's `ticket_merged`, by a row write). */
export function markTicketMerged(
  context: TestContext,
  runId: string,
  ticket: string,
  merged: { commit: string; summary: string | null },
): void {
  const updated = writeTestData(context, (tx) =>
    tx
      .update(deliveryRunTickets)
      .set({ mergedAt: new Date().toISOString(), commit: merged.commit, summary: merged.summary })
      .where(and(eq(deliveryRunTickets.runId, runId), eq(deliveryRunTickets.ticket, ticket)))
      .run(),
  );
  if (updated.changes !== 1) throw new Error(`Run ${runId} has no ticket ${ticket}`);
}

/**
 * Prepares a started run (its worktree on the run branch) and commits one file there as the run
 * identity; returns the run branch's new head, the final commit a verdict end records.
 */
export async function commitOnRunBranch(
  context: TestContext,
  run: StoredDeliveryRun,
): Promise<string> {
  const prepared = await prepareDelivery(context.db, run.id, runFolder(context.db, run));
  if (!prepared.ok) throw new Error(prepared.error.code);
  await writeFile(join(run.worktreePath, "delivered.txt"), "delivered\n");
  const { email } = deliveryIdentity(run.id);
  execFileSync("git", ["add", "delivered.txt"], { cwd: run.worktreePath, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=ZeNorm delivery",
      "-c",
      `user.email=${email}`,
      "commit",
      "-q",
      "-m",
      "Deliver",
    ],
    { cwd: run.worktreePath, stdio: "ignore" },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: run.worktreePath,
    encoding: "utf8",
  }).trim();
}

/** Appends one line to a run's activity. */
export function appendLine(
  context: TestContext,
  runId: string,
  line: { who: RunActor; ticket: string | null; text: string },
): RunEvent {
  return appendRunEvent(context.user, context.db, { runId, ...line });
}

const PASSED_CHECK_RESULT: CheckResult = {
  command: "git status --short",
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  outputTail: "",
};

/** How a test ends a run: each outcome, with the final commit a verdict or failure records. */
export type TestRunEnd =
  | { readonly outcome: "passed"; readonly finalCommit: string }
  | { readonly outcome: "blocked"; readonly finalCommit: string; readonly criterion: string | null }
  | { readonly outcome: "failed" }
  | { readonly outcome: "cancelled" };

/**
 * Ends an active run in `end`'s outcome through `endDelivery`: passed with no finding; blocked with
 * one blocking finding naming `criterion`; failed `delivery_checks_failed`; cancelled.
 */
export async function endRun(
  context: TestContext,
  runId: string,
  end: TestRunEnd,
): Promise<StoredDeliveryRun> {
  const ended = await endDelivery(
    context.user,
    context.db,
    runId,
    end.outcome === "cancelled"
      ? { kind: "cancelled" }
      : end.outcome === "failed"
        ? {
            kind: "failure",
            failure: { code: "delivery_checks_failed", message: "A check failed." },
            finalCommit: null,
            checkResults: null,
          }
        : {
            kind: "verdict",
            finalCommit: end.finalCommit,
            checkResults: [PASSED_CHECK_RESULT],
            pullRequest: null,
            verdict: {
              reviewedCommit: end.finalCommit,
              summary: "Reviewed.",
              findings:
                end.outcome === "passed"
                  ? []
                  : [
                      {
                        axis: "spec",
                        severity: "blocking",
                        file: null,
                        title: "A blocking finding",
                        detail: "Detail.",
                        criterion: end.criterion,
                      },
                    ],
            },
          },
  );
  if (!ended.ok) throw new Error(ended.error.code);
  return ended.value;
}

/** Makes a run look like one started before `0010`: its ticket rows deleted (it has no lines). */
export function asPre0010Run(context: TestContext, runId: string): void {
  writeTestData(context, (tx) =>
    tx.delete(deliveryRunTickets).where(eq(deliveryRunTickets.runId, runId)).run(),
  );
}

// --- Revising a delivered spec: for 02–05 and 07, which may not edit this file. ---

/** A spec delivered through a real run: its map, spec, r1, approved set, and the passed run. */
export interface DeliveredSpec {
  readonly mapId: string;
  readonly specificationId: string;
  readonly specRevisionId: string;
  readonly ticketSetId: string;
  readonly run: StoredDeliveryRun;
  readonly finalCommit: string;
}

/**
 * A passed, not yet merged run of spec 1's r1 in `project`'s real temp repository: the approved
 * set of `TICKETS` (T2 blocked by T1), the run branch with one commit, and both ticket rows merged
 * at that commit.
 */
export async function passedDelivery(
  context: TestContext,
  project: Project,
): Promise<DeliveredSpec> {
  const set = await deliverableTicketSet(context, project);
  const [revision] = readMapRevisions(context.db, set.mapId);
  if (revision === undefined) throw new Error(`Map ${set.mapId} has no revision`);
  const run = await startedRun(context, set.ticketSetId);
  const finalCommit = await commitOnRunBranch(context, run);
  for (const ticket of TICKETS.tickets) {
    markTicketStarted(context, run.id, ticket.id);
    markTicketMerged(context, run.id, ticket.id, { commit: finalCommit, summary: null });
  }
  await endRun(context, run.id, { outcome: "passed", finalCommit });
  return { ...set, specRevisionId: revision.id, run, finalCommit };
}

/** Merges the run branch into `project`'s base branch, then records it through Mark merged. */
export async function mergeDelivery(
  context: TestContext,
  project: Project,
  run: StoredDeliveryRun,
): Promise<void> {
  git(project.folderPath, ["merge", "-q", "--no-ff", "-m", "Merge the run", run.branch]);
  const merged = await markMerged(context.user, context.db, run.id);
  if (!merged.ok) throw new Error(merged.error.code);
}

/** Spec 1 of `project` with r1 delivered: `passedDelivery`, merged (`merged_at` set). */
export async function deliveredSpec(
  context: TestContext,
  project: Project,
): Promise<DeliveredSpec> {
  const delivered = await passedDelivery(context, project);
  await mergeDelivery(context, project, delivered.run);
  return delivered;
}

/** Inserts a touch of a waypoint on a spec's revision directly (charting is its only writer). */
export function insertTouch(
  context: TestContext,
  touch: { waypointId: string; specificationId: string; revision: number; criteria: string[] },
): void {
  writeTestData(context, (tx) => tx.insert(waypointTouches).values(touch).run());
}

/**
 * Inserts the spec's next revision as written by `mapId` (another map's change of a delivered spec
 * when `mapId` is not the writer of the latest): a completed spec-scoped `to_spec` run on that map,
 * the revision with `content`, approved when `approved`, and, when `set` is given, its ticket set at
 * version 1 with `set.content` written by a completed `to_tickets` run, in `set.state`. Earlier
 * revisions are left as they are (an approved revision is never superseded).
 */
export function insertNextRevision(
  context: TestContext,
  next: {
    specificationId: string;
    mapId: string;
    content: SpecRevisionContent;
    approved: boolean;
    set: { state: TicketSetState; content: TicketSetContent } | null;
  },
): { specRevisionId: string; revision: number; ticketSetId: string | null } {
  const latest = context.db
    .select({ revision: specRevisions.revision })
    .from(specRevisions)
    .where(eq(specRevisions.specificationId, next.specificationId))
    .orderBy(desc(specRevisions.revision))
    .get();
  if (latest === undefined) throw new Error(`Spec ${next.specificationId} has no revision`);
  const at = new Date().toISOString();
  const written = insertRun(context, {
    mapId: next.mapId,
    specificationId: next.specificationId,
    purpose: "to_spec",
    state: "completed",
  });
  const revision = latest.revision + 1;
  const specRevisionId = insertRevision(context, {
    specificationId: next.specificationId,
    revision,
    mapId: next.mapId,
    writtenByRun: written.id,
    content: next.content,
    approvedAt: next.approved ? at : null,
  });
  const { set } = next;
  if (set === null) return { specRevisionId, revision, ticketSetId: null };
  const tickets = insertRun(context, {
    mapId: next.mapId,
    specificationId: next.specificationId,
    purpose: "to_tickets",
    state: "completed",
  });
  const ticketSetId = uuidv7();
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSets)
      .values({
        id: ticketSetId,
        specRevisionId,
        state: set.state,
        version: 1,
        createdAt: at,
        updatedAt: at,
        approvedAt: set.state === "approved" ? at : null,
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSetVersions)
      .values({
        ticketSetId,
        version: 1,
        content: set.content,
        writtenByRun: tickets.id,
        createdAt: at,
      })
      .run(),
  );
  return { specRevisionId, revision, ticketSetId };
}

/** A wait's stored hold: what held the spec when the wait was recorded. */
export interface StoredHold {
  readonly kind: SpecHoldKind;
  readonly mapId: string;
  readonly revision: number;
}

/**
 * Inserts a wait of `mapId` on the spec directly (03 records them through To Spec and notes), with
 * its stored hold, `since` now: open when `released` is null, else released now by `released.runId`.
 * Returns its id.
 */
export function insertWait(
  context: TestContext,
  wait: {
    mapId: string;
    specificationId: string;
    note: string;
    hatchMessageId: string | null;
    hold: StoredHold;
    released: { runId: string } | null;
  },
): string {
  const id = uuidv7();
  const at = new Date().toISOString();
  writeTestData(context, (tx) =>
    tx
      .insert(specWaits)
      .values({
        id,
        mapId: wait.mapId,
        specificationId: wait.specificationId,
        note: wait.note,
        hatchMessageId: wait.hatchMessageId,
        since: at,
        holdKind: wait.hold.kind,
        holdMapId: wait.hold.mapId,
        holdRevision: wait.hold.revision,
        releasedAt: wait.released === null ? null : at,
        releasedByRun: wait.released === null ? null : wait.released.runId,
      })
      .run(),
  );
  return id;
}

/**
 * Inserts a released wait with its release run (07's release): a spec-scoped `to_spec` run of the
 * wait's map on the spec, `running` or `stopped` (a failed run and its failed retry), then the wait
 * released by it. Returns the wait's id and the run.
 */
export function insertReleasedWait(
  context: TestContext,
  wait: {
    mapId: string;
    specificationId: string;
    note: string;
    hatchMessageId: string | null;
    hold: StoredHold;
    run: "running" | "stopped";
  },
): { waitId: string; run: PlanningRun } {
  const run = insertSpecRun(context, {
    mapId: wait.mapId,
    specificationId: wait.specificationId,
    purpose: "to_spec",
    state: wait.run,
  });
  const waitId = insertWait(context, { ...wait, released: { runId: run.id } });
  return { waitId, run };
}

/**
 * A draft's review, as a written draft always has one: a `spec_review` run of `mapId` on the spec,
 * `running`, or `passed` (completed, its review recorded with no finding: the draft awaits approval).
 */
function draftReview(
  context: TestContext,
  draft: { specificationId: string; mapId: string; specRevisionId: string },
  review: "running" | "passed",
): void {
  const run = insertRun(context, {
    mapId: draft.mapId,
    specificationId: draft.specificationId,
    purpose: "spec_review",
    state: review === "running" ? "running" : "completed",
  });
  if (review === "passed") {
    insertReview(context, { specRevisionId: draft.specRevisionId, runId: run.id, findings: [] });
  }
}

/**
 * Holds the spec by a `revision` hold: `mapId` writes its next revision, unapproved, with
 * its review `running` or `passed`.
 */
export function holdByRevision(
  context: TestContext,
  hold: {
    specificationId: string;
    mapId: string;
    content: SpecRevisionContent;
    review: "running" | "passed";
  },
): { specRevisionId: string; revision: number } {
  const next = insertNextRevision(context, {
    specificationId: hold.specificationId,
    mapId: hold.mapId,
    content: hold.content,
    approved: false,
    set: null,
  });
  draftReview(context, { ...hold, specRevisionId: next.specRevisionId }, hold.review);
  return { specRevisionId: next.specRevisionId, revision: next.revision };
}

/**
 * Holds the spec by a `revising` hold: `mapId`'s spec-scoped `to_spec` run on it, `running`
 * or `stopped` (a failed run and its failed retry). Returns the last run inserted.
 */
export function holdByRevising(
  context: TestContext,
  hold: { specificationId: string; mapId: string; state: "running" | "stopped" },
): PlanningRun {
  return insertSpecRun(context, { ...hold, purpose: "to_spec" });
}

/**
 * Holds the spec by a `tickets` hold: `mapId` writes the spec's next revision with
 * `content`, approved (a ticket-set run reads its map's latest approved revision); then, when `set`
 * is given, that revision's set of `set` (`insertTicketSetWith`, version 1 in `awaiting_review`);
 * then its `purpose` run on the spec, `running` or `stopped`. A `tickets_review` reviews a set, so
 * it needs `set`. Returns the revision, the set (or null) and the last run.
 */
export function holdByTickets(
  context: TestContext,
  hold: {
    specificationId: string;
    mapId: string;
    content: SpecRevisionContent;
    set: TicketSetContent | null;
    purpose: "to_tickets" | "tickets_review";
    state: "running" | "stopped";
  },
): { specRevisionId: string; revision: number; ticketSetId: string | null; run: PlanningRun } {
  if (hold.purpose === "tickets_review" && hold.set === null) {
    throw new Error("A tickets_review hold needs the set it reviews");
  }
  const next = insertNextRevision(context, {
    specificationId: hold.specificationId,
    mapId: hold.mapId,
    content: hold.content,
    approved: true,
    set: null,
  });
  const ticketSetId =
    hold.set === null
      ? null
      : insertTicketSetWith(context, {
          mapId: hold.mapId,
          specificationId: hold.specificationId,
          specRevisionId: next.specRevisionId,
          content: hold.set,
          state: "awaiting_review",
          review: null,
        });
  const run = insertSpecRun(context, {
    mapId: hold.mapId,
    specificationId: hold.specificationId,
    purpose: hold.purpose,
    state: hold.state,
  });
  return { specRevisionId: next.specRevisionId, revision: next.revision, ticketSetId, run };
}

/**
 * Holds the spec by a `delivering` hold in `project`'s real temp repository (its checks
 * saved, as `deliveredSpec` leaves them): `mapId` writes the spec's next revision with `content`,
 * approved, with an approved set of `TICKETS`, and a delivery run starts on it. The stored run is
 * the same whether it reads `running` or `interrupted`: that is whether a runner holds it.
 */
export async function holdByDelivery(
  context: TestContext,
  hold: { specificationId: string; mapId: string; content: SpecRevisionContent },
): Promise<{
  specRevisionId: string;
  revision: number;
  ticketSetId: string;
  run: StoredDeliveryRun;
}> {
  const next = insertNextRevision(context, {
    ...hold,
    approved: true,
    set: { state: "approved", content: TICKETS },
  });
  if (next.ticketSetId === null) throw new Error("insertNextRevision wrote no ticket set");
  const run = await startedRun(context, next.ticketSetId);
  return {
    specRevisionId: next.specRevisionId,
    revision: next.revision,
    ticketSetId: next.ticketSetId,
    run,
  };
}

/**
 * A replaced set: `mapId` writes the spec's next revision, approved, with a set of
 * `TICKETS` in `state` (never `approved`), then the revision after it, unapproved, with
 * `nextContent`, its review running. Returns the set, its revision and the replacing revision.
 */
export function replacedTicketSet(
  context: TestContext,
  replaced: {
    specificationId: string;
    mapId: string;
    content: SpecRevisionContent;
    nextContent: SpecRevisionContent;
    state: Exclude<TicketSetState, "approved">;
  },
): { ticketSetId: string; revision: number; replacingRevision: number } {
  const written = insertNextRevision(context, {
    specificationId: replaced.specificationId,
    mapId: replaced.mapId,
    content: replaced.content,
    approved: true,
    set: { state: replaced.state, content: TICKETS },
  });
  if (written.ticketSetId === null) throw new Error("insertNextRevision wrote no ticket set");
  const replacing = insertNextRevision(context, {
    specificationId: replaced.specificationId,
    mapId: replaced.mapId,
    content: replaced.nextContent,
    approved: false,
    set: null,
  });
  draftReview(
    context,
    {
      specificationId: replaced.specificationId,
      mapId: replaced.mapId,
      specRevisionId: replacing.specRevisionId,
    },
    "running",
  );
  return {
    ticketSetId: written.ticketSetId,
    revision: written.revision,
    replacingRevision: replacing.revision,
  };
}

/**
 * Inserts a ticket set of any `content` (zero tickets, any disposition kinds, follow-ups, ids from
 * any start) on the revision `specRevisionId` of the spec: version 1 written by a completed
 * `to_tickets` run of `mapId`; when `review` is given, a tickets review of it with those findings
 * (`insertTicketsReview`); then the set is put in `state` (`approved_at` set exactly when
 * approved). Returns its id.
 */
export function insertTicketSetWith(
  context: TestContext,
  set: {
    mapId: string;
    specificationId: string;
    specRevisionId: string;
    content: TicketSetContent;
    state: TicketSetState;
    review: readonly { finding: TicketsReviewFinding; escalated: boolean }[] | null;
  },
): string {
  const run = insertRun(context, {
    mapId: set.mapId,
    specificationId: set.specificationId,
    purpose: "to_tickets",
    state: "completed",
  });
  const id = uuidv7();
  const at = new Date().toISOString();
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSets)
      .values({
        id,
        specRevisionId: set.specRevisionId,
        state: set.state,
        version: 1,
        createdAt: at,
        updatedAt: at,
        approvedAt: set.state === "approved" ? at : null,
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSetVersions)
      .values({
        ticketSetId: id,
        version: 1,
        content: set.content,
        writtenByRun: run.id,
        createdAt: at,
      })
      .run(),
  );
  if (set.review !== null) {
    insertTicketsReview(context, {
      mapId: set.mapId,
      specificationId: set.specificationId,
      ticketSetId: id,
      findings: set.review,
    });
    writeTestData(context, (tx) =>
      tx.update(ticketSets).set({ state: set.state }).where(eq(ticketSets.id, id)).run(),
    );
  }
  return id;
}

/** The review of a revision's current content (by the revision's id), or null. */
export function reviewOf(context: TestContext, specRevisionId: string) {
  const revision = context.db
    .select()
    .from(specRevisions)
    .where(eq(specRevisions.id, specRevisionId))
    .get();
  if (revision === undefined) throw new Error(`No revision ${specRevisionId}`);
  return readReview(context.db, revision);
}
