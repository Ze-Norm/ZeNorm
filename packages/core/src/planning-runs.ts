import { chartStep, err, ok, ResearchReport } from "@zenorm/contracts";
import type {
  Actor,
  ChartedWaypoint,
  ChartOutcome,
  ConsistencyOutcome,
  GrillOutcome,
  MapRecord,
  MapRound,
  OutOfScopeRuling,
  PlanningRun,
  PlanningRunFailureCode,
  PlanningRunUsage,
  PlanningRunPurpose,
  QuestionRound,
  ResearchOutcome,
  Result,
  RoundWithdrawnReason,
  StoppedRun,
  TaskOutcome,
  TryAgainError,
  UserId,
  WaitingRun,
  Waypoint,
  WaypointAgentDecided,
  WaypointKind,
  WaypointState,
  WaypointStatus,
} from "@zenorm/contracts";
import {
  consistencyFindings,
  consistencyPasses,
  hatchMessages,
  maps,
  planningRuns,
  questionRounds,
  researchReports,
  researchSources,
  taskOutcomes,
  waypointBlockers,
  waypointTouches,
  waypoints,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import {
  addFog,
  applyMapChanges,
  fogLeftUnsettled,
  mapChangesProblem,
  proposalsProblem,
  saveExclusion,
  saveProposal,
  saveSplitOffer,
} from "./map-changes.ts";
import { present } from "./present.ts";
import { followRelease, planAndRelease, reopenStaleReleases } from "./spec-holds.ts";
import {
  dueSpecRuns,
  readMapRevisions,
  readProjectSpecs,
  readSpecRevisions,
  toTicketsDue,
} from "./specs.ts";
import {
  readExclusions,
  readFog,
  readPasses,
  readReports,
  readTaskOutcomes,
} from "./wayfinding-records.ts";
import type { StoredPass, StoredReport, StoredTaskOutcome } from "./wayfinding-records.ts";
import { write } from "./writes.ts";

/** A write transaction on the database (synchronous, better-sqlite3). */
export type Tx = Parameters<Parameters<ZeNormDatabase["transaction"]>[0]>[0];

/** What a read inside or outside a transaction needs. */
export type Reader = Pick<ZeNormDatabase, "select">;

/** A refused output's or a pre-flight failure's code and message, stored on the run. */
export interface RunFailure {
  readonly code: PlanningRunFailureCode;
  readonly message: string;
}

/** The map's planning runs, oldest first. */
export function readMapRuns(db: Reader, mapId: string): PlanningRun[] {
  return db
    .select()
    .from(planningRuns)
    .where(eq(planningRuns.mapId, mapId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all();
}

/**
 * The runs of one waypoint scope: a waypoint's, or the map's own when `waypointId` is null.
 * Spec-scoped runs and `hatch` runs (each message's own scope) are in neither.
 */
export function scopeRuns(
  runs: readonly PlanningRun[],
  waypointId: string | null,
): readonly PlanningRun[] {
  return runs.filter(
    (run) =>
      run.waypointId === waypointId && run.specificationId === null && run.purpose !== "hatch",
  );
}

/** The `hatch` runs answering one message, oldest first: the message's own scope. */
export function hatchRuns(
  runs: readonly PlanningRun[],
  hatchMessageId: string,
): readonly PlanningRun[] {
  return runs.filter((run) => run.purpose === "hatch" && run.hatchMessageId === hatchMessageId);
}

/** The runs of one spec's scope, oldest first. */
export function specRuns(
  runs: readonly PlanningRun[],
  specificationId: string,
): readonly PlanningRun[] {
  return runs.filter((run) => run.specificationId === specificationId);
}

/** The runs of `run`'s own scope: its message's, its spec's, its waypoint's, or the map's. */
export function runScope(runs: readonly PlanningRun[], run: PlanningRun): readonly PlanningRun[] {
  if (run.purpose === "hatch") {
    return hatchRuns(runs, present(run.hatchMessageId, `Hatch run ${run.id}'s message`));
  }
  return run.specificationId === null
    ? scopeRuns(runs, run.waypointId)
    : specRuns(runs, run.specificationId);
}

/** A run that failed on its retry: its scope is stopped while it is the scope's latest. */
function isFailedRetry(run: PlanningRun): boolean {
  return run.state === "failed" && run.retryOfRunId !== null;
}

/** A failed first attempt, whose retry the same transaction inserts. */
function awaitsRetry(run: PlanningRun): boolean {
  return run.state === "failed" && run.retryOfRunId === null;
}

/** The stopped run of a scope, from its runs oldest first; null when the scope is not stopped. */
export function stoppedRun(runs: readonly PlanningRun[]): StoppedRun | null {
  const latest = runs.at(-1);
  if (latest === undefined || !isFailedRetry(latest)) {
    return null;
  }
  if (latest.errorCode === null) {
    throw new Error(`Failed planning run ${latest.id} has no error code`);
  }
  return { runId: latest.id, code: latest.errorCode };
}

/**
 * A waypoint scope's stopped run: a failed retry releases the waypoint to `open`, so the stop
 * stands only while it is `open`. Once the waypoint is resolved or ruled out of scope by other
 * means (the hatch, a ruling), its old stop is no next action and offers no Try again.
 */
export function waypointStoppedRun(
  waypoint: Pick<Waypoint, "status">,
  runs: readonly PlanningRun[],
): StoppedRun | null {
  return waypoint.status === "open" ? stoppedRun(runs) : null;
}

/**
 * What a scope's runs, oldest first, show: `working` while one runs or awaits its retry, the
 * stopped run, or null when neither.
 */
export function scopeRun(runs: readonly PlanningRun[]): "working" | { stopped: StoppedRun } | null {
  const latest = runs.at(-1);
  if (latest === undefined) {
    return null;
  }
  if (latest.state === "running" || awaitsRetry(latest)) {
    return "working";
  }
  const stopped = stoppedRun(runs);
  return stopped === null ? null : { stopped };
}

export function now(): string {
  return new Date().toISOString();
}

/**
 * The User a run inserted under `actor` on the map is attributed to: a `user` actor's, a run
 * actor's (the run whose end started it), and under `system` (the startup sweep) the map's. Never
 * the local user as a fallback.
 */
export function runUserId(tx: Reader, actor: Actor, mapId: string): UserId {
  if (actor.kind !== "system") {
    return actor.userId;
  }
  const map = tx.select({ userId: maps.userId }).from(maps).where(eq(maps.id, mapId)).get();
  if (map === undefined) throw new Error(`Map ${mapId} does not exist`);
  return map.userId;
}

/** Inserts a `running` run, attributed by `actor`, and returns it. */
export function insertRun(
  actor: Actor,
  tx: Tx,
  run: Pick<
    PlanningRun,
    "mapId" | "waypointId" | "specificationId" | "purpose" | "retryOfRunId" | "hatchMessageId"
  >,
): PlanningRun {
  const row: PlanningRun = {
    id: uuidv7(),
    ...run,
    state: "running",
    cancelReason: null,
    errorCode: null,
    errorMessage: null,
    startedAt: now(),
    endedAt: null,
  };
  tx.insert(planningRuns)
    .values({ ...row, userId: runUserId(tx, actor, run.mapId) })
    .run();
  return row;
}

/**
 * The actor a planning run's writes are made as: the run, with its User. An unknown run is a
 * programmer error, and throws.
 */
export function planningRunActor(db: Reader, runId: string): Actor {
  const run = db
    .select({ userId: planningRuns.userId })
    .from(planningRuns)
    .where(eq(planningRuns.id, runId))
    .get();
  if (run === undefined) throw new Error(`Planning run ${runId} does not exist`);
  return { kind: "planning_run", runId, userId: run.userId };
}

/** The columns of a map row that make its `MapRecord`; `fog_next_position` stays in core. */
export const mapRecordColumns = {
  id: maps.id,
  projectId: maps.projectId,
  idea: maps.idea,
  title: maps.title,
  summary: maps.summary,
  destination: maps.destination,
  destinationConfirmedAt: maps.destinationConfirmedAt,
  createdAt: maps.createdAt,
  splitFromMapId: maps.splitFromMapId,
  splitFromRunId: maps.splitFromRunId,
};

export function readMap(db: Reader, mapId: string): MapRecord {
  const map = db.select(mapRecordColumns).from(maps).where(eq(maps.id, mapId)).get();
  if (map === undefined) {
    throw new Error(`No map with id ${mapId}`);
  }
  return map;
}

/**
 * A map's map-level rounds, oldest first, each as stored: a pending one has null answers.
 */
export function mapRoundsOf(rounds: readonly QuestionRound[]): MapRound[] {
  return rounds
    .filter((round) => round.waypointId === null)
    .sort((a, b) => a.number - b.number)
    .map((round) => ({ questions: round.questions, answers: round.answers, final: round.final }));
}

/** The map's question rounds, map-level ones first by number, then each waypoint's by number. */
export function readRounds(db: Reader, mapId: string): QuestionRound[] {
  return db
    .select()
    .from(questionRounds)
    .where(eq(questionRounds.mapId, mapId))
    .orderBy(asc(questionRounds.askedAt), asc(questionRounds.id))
    .all();
}

/** The map's waypoints by number. */
export function readWaypoints(db: Reader, mapId: string): Waypoint[] {
  return db
    .select()
    .from(waypoints)
    .where(eq(waypoints.mapId, mapId))
    .orderBy(asc(waypoints.number))
    .all();
}

/** The map's blockers, by blocked waypoint then blocker number. */
export function readBlockers(
  db: Reader,
  mapId: string,
): { waypointNumber: number; blockerNumber: number }[] {
  return db
    .select({
      waypointNumber: waypointBlockers.waypointNumber,
      blockerNumber: waypointBlockers.blockerNumber,
    })
    .from(waypointBlockers)
    .where(eq(waypointBlockers.mapId, mapId))
    .orderBy(asc(waypointBlockers.waypointNumber), asc(waypointBlockers.blockerNumber))
    .all();
}

/** The purposes that may run on a map before its code survey: its charts, the survey and the hatch. */
const BEFORE_SURVEY_PURPOSES: readonly PlanningRunPurpose[] = ["chart", "survey", "hatch"];

/**
 * Whether the map's work waits on its code survey: no `survey` run completed and no run of any
 * purpose but `chart`, `survey` and `hatch` ever started. Once its destination is confirmed, such a
 * map's only due run is the survey: no waypoint is on the frontier and the map neither clears nor
 * runs a consistency pass. A map whose waypoint or spec work began before surveys existed
 * (migration 0017) is not held back.
 */
export function awaitingSurvey(runs: readonly PlanningRun[]): boolean {
  return runs.every(
    (run) =>
      BEFORE_SURVEY_PURPOSES.includes(run.purpose) &&
      !(run.purpose === "survey" && run.state === "completed"),
  );
}

/** What clearing and the consistency pass read. */
export interface ClearingInput {
  readonly map: Pick<MapRecord, "destinationConfirmedAt">;
  readonly waypoints: readonly Pick<Waypoint, "id" | "status" | "resolvedAt">[];
  readonly rounds: readonly Pick<QuestionRound, "status">[];
  /** The map's planning runs, oldest first. */
  readonly runs: readonly PlanningRun[];
  /** How many fog items the map has. */
  readonly fogCount: number;
  /** The map's consistency passes, oldest first. */
  readonly passes: readonly Pick<StoredPass, "compared">[];
}

/** Whether a run of one of `purposes` runs, or is its scope's latest and awaits its retry. */
function anyWorking(
  runs: readonly PlanningRun[],
  purposes: readonly PlanningRunPurpose[],
): boolean {
  return runs.some(
    (run) =>
      purposes.includes(run.purpose) &&
      (run.state === "running" || (awaitsRetry(run) && isLatestOfScope(run, runs))),
  );
}

/**
 * The map's clearing conditions but fog and consistency: the destination is confirmed, every
 * waypoint is `resolved` or `out_of_scope`, no round is pending, and no `chart`, waypoint or `fog`
 * run runs or awaits its retry; and the map does not wait on its code survey (`awaitingSurvey`).
 */
function quiet(input: ClearingInput): boolean {
  return (
    input.map.destinationConfirmedAt !== null &&
    !awaitingSurvey(input.runs) &&
    input.waypoints.every(
      (waypoint) => waypoint.status === "resolved" || waypoint.status === "out_of_scope",
    ) &&
    input.rounds.every((round) => round.status !== "pending") &&
    !anyWorking(input.runs, ["chart", "grilling", "research", "task", "fog"])
  );
}

/** The clearing conditions but consistency: `quiet`, and no fog remains. */
function settled(input: ClearingInput): boolean {
  return quiet(input) && input.fogCount === 0;
}

/**
 * Whether a `fog` run is due: the map is `quiet` and fog remains. No waypoint run settles fog it
 * does not own, so two parallel last runs never race over it; the fog run sees every resolution at
 * once. It comes before the consistency pass, which then compares the resolutions the fog run
 * decided and waits on the waypoints it opened.
 */
export function fogDue(input: ClearingInput): boolean {
  return quiet(input) && input.fogCount > 0;
}

/** The `resolved` waypoints, by id and `resolved_at`; out-of-scope ones are not counted. */
function resolvedSet(
  mapWaypoints: ClearingInput["waypoints"],
): { waypointId: string; resolvedAt: string }[] {
  return mapWaypoints
    .filter((waypoint) => waypoint.status === "resolved")
    .map((waypoint) => {
      if (waypoint.resolvedAt === null) {
        throw new Error(`Resolved waypoint ${waypoint.id} has no resolved_at`);
      }
      return { waypointId: waypoint.id, resolvedAt: waypoint.resolvedAt };
    });
}

/** A resolved waypoint's identity for a pass: its id and `resolved_at`, so a re-resolved one is new. */
function passKey(pair: { waypointId: string; resolvedAt: string }): string {
  return `${pair.waypointId}@${pair.resolvedAt}`;
}

/** Whether the latest pass compared exactly the current resolved set. */
function latestPassMatches(input: ClearingInput): boolean {
  const latest = input.passes.at(-1);
  if (latest === undefined) {
    return false;
  }
  const current = new Set(resolvedSet(input.waypoints).map(passKey));
  const compared = new Set(latest.compared.map(passKey));
  return current.size === compared.size && [...current].every((pair) => compared.has(pair));
}

/**
 * The most consistency passes a map runs. Two: in the churn walk every pass after the second
 * found only conflicts an earlier pass had already compared or cascades of agent-invented
 * mechanisms; spec review is the net for what the cap leaves.
 */
export const CONSISTENCY_PASSES_MAX = 2;

/** Whether the map has run all its consistency passes: no more are due and clearing needs none. */
export function passesExhausted(input: Pick<ClearingInput, "passes">): boolean {
  return input.passes.length >= CONSISTENCY_PASSES_MAX;
}

/**
 * The ids of the resolved waypoints the latest pass did not compare (by id and `resolved_at`), or
 * null when the map has had no pass: then every waypoint is new.
 */
export function newSinceLastPass(
  mapWaypoints: ClearingInput["waypoints"],
  passes: ClearingInput["passes"],
): ReadonlySet<string> | null {
  const latest = passes.at(-1);
  if (latest === undefined) {
    return null;
  }
  const compared = new Set(latest.compared.map(passKey));
  return new Set(
    resolvedSet(mapWaypoints)
      .filter((pair) => !compared.has(passKey(pair)))
      .map((pair) => pair.waypointId),
  );
}

/**
 * Whether a `consistency` run is due: the map is `settled`, two or more waypoints are resolved, the
 * latest pass did not compare exactly the current resolved set, and the map has passes left
 * (`passesExhausted`). The caller starts it only when the map's own scope is neither running nor
 * stopped.
 */
export function consistencyDue(input: ClearingInput): boolean {
  return (
    settled(input) &&
    resolvedSet(input.waypoints).length >= 2 &&
    !latestPassMatches(input) &&
    !passesExhausted(input)
  );
}

/**
 * Whether the map is cleared: the map is `settled`, no `consistency` run runs or awaits its retry,
 * and either fewer than two waypoints are resolved, the latest pass compared exactly the current
 * resolved set, or the map has run all its passes.
 */
export function isCleared(input: ClearingInput): boolean {
  return (
    settled(input) &&
    !anyWorking(input.runs, ["consistency"]) &&
    (resolvedSet(input.waypoints).length < 2 || latestPassMatches(input) || passesExhausted(input))
  );
}

/** What `isCleared` and `consistencyDue` read of the map, inside or outside a transaction. */
export function readClearing(
  db: Reader,
  map: Pick<MapRecord, "id" | "destinationConfirmedAt">,
  runs: readonly PlanningRun[],
): ClearingInput {
  return {
    map,
    waypoints: readWaypoints(db, map.id),
    rounds: readRounds(db, map.id),
    runs,
    fogCount: readFog(db, map.id).length,
    passes: readPasses(db, map.id),
  };
}

function isLatestOfScope(run: PlanningRun, runs: readonly PlanningRun[]): boolean {
  return runScope(runs, run).at(-1)?.id === run.id;
}

/** The map-level purpose due now, or null, for a map scope that is idle and not stopped. */
function dueMapPurpose(
  tx: Tx,
  map: MapRecord,
  runs: readonly PlanningRun[],
): PlanningRunPurpose | null {
  const rounds = readRounds(tx, map.id);
  const mapRounds = rounds.filter((round) => round.waypointId === null);
  if (map.destinationConfirmedAt === null) {
    if (map.title === null && mapRounds.length === 0) {
      // The first chart.
      return "chart";
    }
    if (mapRounds.length > 0 && mapRounds.every((round) => round.status === "submitted")) {
      // The chart after the map-level round.
      return "chart";
    }
    return null;
  }
  if (awaitingSurvey(runs)) {
    // The code survey, once, before any waypoint run.
    return "survey";
  }
  const clearing = readClearing(tx, map, runs);
  if (fogDue(clearing)) {
    // Fog the last waypoint runs left, settled once they are all resolved.
    return "fog";
  }
  if (consistencyDue(clearing)) {
    return "consistency";
  }
  if (!isCleared(clearing)) {
    return null;
  }
  // The first `to_spec` until one completes (a map whose run named only waits wrote no revision),
  // then the re-clear.
  return draftedRun(runs) === undefined || reclearDue(tx, map.id, runs) ? "to_spec" : null;
}

/** Each run's position among the map's runs oldest first (by `started_at`, then id). */
export function runPositions(
  runs: readonly PlanningRun[],
): (run: Pick<PlanningRun, "id">) => number {
  const positions = new Map(runs.map((run, index) => [run.id, index]));
  return (run) => {
    const position = positions.get(run.id);
    if (position === undefined) {
      throw new Error(`Planning run ${run.id} is not among the map's runs`);
    }
    return position;
  };
}

/** The map's latest completed map-scope `to_spec` (its first draft or a re-clear), if any. */
function draftedRun(runs: readonly PlanningRun[]): PlanningRun | undefined {
  return scopeRuns(runs, null)
    .filter((run) => run.purpose === "to_spec" && run.state === "completed")
    .at(-1);
}

/**
 * Whether the map's re-clear `to_spec` is due: a map-scope `to_spec` completed (it wrote revisions,
 * or named only waits) and, after the latest one ended, a waypoint was created (by a run started
 * after it among the map's runs; a review recorded while that run worked opens none, and no
 * waypoint run works while it does), resolved (its `resolved_at` is later, or its resolving run
 * started after it), or ruled out of scope (by a run started after it). No basis column; the caller
 * checks the map is cleared.
 */
export function reclearDue(db: Reader, mapId: string, runs: readonly PlanningRun[]): boolean {
  const drafted = draftedRun(runs);
  if (drafted === undefined) {
    if (readMapRevisions(db, mapId).length > 0) {
      throw new Error(`Map ${mapId} has revisions but no completed map-scope to_spec run`);
    }
    return false;
  }
  const position = runPositions(runs);
  const after = (runId: string | null): boolean =>
    runId !== null && position({ id: runId }) > position(drafted);
  const endedAt = present(drafted.endedAt, `Completed run ${drafted.id}'s ended_at`);
  const ruledBy = new Map(
    readExclusions(db, mapId).flatMap((exclusion) =>
      exclusion.waypointId === null ? [] : [[exclusion.waypointId, exclusion.createdByRun]],
    ),
  );
  return readWaypoints(db, mapId).some(
    (waypoint) =>
      after(waypoint.createdByRun) ||
      (waypoint.status === "resolved" &&
        (after(waypoint.resolvedByRun) ||
          present(waypoint.resolvedAt, `Waypoint ${waypoint.id}'s resolved_at`) > endedAt)) ||
      (waypoint.status === "out_of_scope" && after(rulingRun(ruledBy, waypoint.id))),
  );
}

/** The run that ruled an out-of-scope waypoint out (its Out of scope line's writer). */
function rulingRun(ruledBy: ReadonlyMap<string, string>, waypointId: string): string {
  const runId = ruledBy.get(waypointId);
  if (runId === undefined) {
    throw new Error(`Out-of-scope waypoint ${waypointId} has no exclusion`);
  }
  return runId;
}

/**
 * Whether a stopped run is superseded: it no longer drives a status or **Try again**, and its scope
 * reads idle. A stopped map-scope `to_spec` (or legacy `to_tickets`) is superseded while the map's
 * fog run or consistency pass is due; a stopped spec-scoped `to_spec` or `spec_review` while the
 * map is un-cleared, or once any map-scope run started after it (a pass or the re-clear). A stopped
 * `to_tickets` on an approved spec never is, nor is a waypoint's run. False for a run that is not
 * its scope's stopped run.
 */
export function isSupersededStop(run: PlanningRun, clearing: ClearingInput): boolean {
  if (stoppedRun(runScope(clearing.runs, run))?.runId !== run.id) {
    return false;
  }
  if (run.specificationId === null) {
    return (
      run.waypointId === null &&
      (run.purpose === "to_spec" || run.purpose === "to_tickets") &&
      (fogDue(clearing) || consistencyDue(clearing))
    );
  }
  if (run.purpose !== "to_spec" && run.purpose !== "spec_review") {
    return false;
  }
  const position = runPositions(clearing.runs);
  return (
    !isCleared(clearing) ||
    scopeRuns(clearing.runs, null).some((other) => position(other) > position(run))
  );
}

/** Whether a scope's latest run is `purpose` and runs or awaits its retry. */
function isWorking(runs: readonly PlanningRun[], purpose: PlanningRunPurpose): boolean {
  const latest = runs.at(-1);
  return latest?.purpose === purpose && (latest.state === "running" || awaitsRetry(latest));
}

/**
 * Ends every running spec-scoped `to_spec` of the map `cancelled`, `replaced`: the transaction
 * starting the re-clear replaces them; a result arriving later saves nothing.
 */
function replaceRepairs(tx: Tx, mapId: string): void {
  tx.update(planningRuns)
    .set({ state: "cancelled", cancelReason: "replaced", endedAt: now() })
    .where(
      and(
        eq(planningRuns.mapId, mapId),
        eq(planningRuns.state, "running"),
        eq(planningRuns.purpose, "to_spec"),
        isNotNull(planningRuns.specificationId),
      ),
    )
    .run();
}

/**
 * Whether a map other than `mapId` has a spec-scoped run on the spec that runs or awaits its retry:
 * `planning_runs_one_running_per_specification` spans maps, so nothing due on `mapId` starts under
 * it, and a `rewrite_tickets` note is refused `spec_in_flight`.
 */
export function otherMapWorking(db: Reader, specificationId: string, mapId: string): boolean {
  const runs = db
    .select()
    .from(planningRuns)
    .where(eq(planningRuns.specificationId, specificationId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all()
    .filter((run) => run.mapId !== mapId);
  const latestByMap = new Map(runs.map((run) => [run.mapId, run]));
  return [...latestByMap.values()].some(
    (latest) => latest.state === "running" || awaitsRetry(latest),
  );
}

/** Whether a scope's latest run is running. */
function isRunning(runs: readonly PlanningRun[]): boolean {
  return runs.at(-1)?.state === "running";
}

/** The saved outcomes a waypoint's completed run may leave it waiting on. */
export interface RunOutcomes {
  readonly reports: readonly Pick<StoredReport, "runId" | "answered" | "gap">[];
  readonly taskOutcomes: readonly Pick<StoredTaskOutcome, "runId" | "outcome" | "facts">[];
}

/** The map's research reports and task outcomes, as `waitingRun` reads them. */
export function readRunOutcomes(db: Reader, mapId: string): RunOutcomes {
  return { reports: readReports(db, mapId), taskOutcomes: readTaskOutcomes(db, mapId) };
}

/**
 * The run a waypoint waits on, from its scope's runs oldest first: the waypoint is `open` and its
 * latest run `completed` with an unanswered research report or a `failed` task outcome. Null when
 * it is not waiting.
 */
export function waitingRun(
  waypoint: Pick<Waypoint, "status">,
  runs: readonly PlanningRun[],
  outcomes: RunOutcomes,
): WaitingRun | null {
  const latest = runs.at(-1);
  if (waypoint.status !== "open" || latest?.state !== "completed") {
    return null;
  }
  if (outcomes.reports.some((report) => report.runId === latest.id && !report.answered)) {
    return { runId: latest.id, reason: "research_unanswered" };
  }
  if (
    outcomes.taskOutcomes.some(
      (outcome) => outcome.runId === latest.id && outcome.outcome === "failed",
    )
  ) {
    return { runId: latest.id, reason: "task_failed" };
  }
  return null;
}

/**
 * What keeps an `open` waypoint off the map's frontier, or null when nothing does: its scope is
 * stopped (a waypoint released by a failed retry stays off until `tryAgain`); it waits on the
 * person (it stays off until `tryAgain`); it has blockers that are not `resolved` or `out_of_scope`
 * (`waitsOn`, ascending); the map's destination is not confirmed; or the map waits on its code
 * survey (`awaitingSurvey`). A failed first attempt awaiting its retry, or a completed run that
 * left no waiting outcome, holds nothing. `frontier` and `waypointState` both read it, so a
 * waypoint shows held for exactly the reason the frontier passes it over.
 */
export type FrontierHold =
  | { readonly kind: "stopped"; readonly run: StoppedRun }
  | { readonly kind: "waiting"; readonly run: WaitingRun }
  | { readonly kind: "blocked"; readonly waitsOn: readonly number[] }
  | { readonly kind: "destination" }
  | { readonly kind: "survey" };

/** What `frontierHold` and `waypointState` read of the map. */
export interface FrontierInput {
  readonly map: Pick<MapRecord, "destinationConfirmedAt">;
  readonly waypoints: readonly Waypoint[];
  readonly blockers: readonly { waypointNumber: number; blockerNumber: number }[];
  readonly runs: readonly PlanningRun[];
  readonly outcomes: RunOutcomes;
}

/** See `FrontierHold`; `waypoint` must be `open`. */
export function frontierHold(input: FrontierInput, waypoint: Waypoint): FrontierHold | null {
  if (waypoint.status !== "open") {
    throw new Error(`Waypoint ${waypoint.id} is ${waypoint.status}, not open`);
  }
  const scope = scopeRuns(input.runs, waypoint.id);
  const stopped = stoppedRun(scope);
  if (stopped !== null) {
    return { kind: "stopped", run: stopped };
  }
  const waiting = waitingRun(waypoint, scope, input.outcomes);
  if (waiting !== null) {
    return { kind: "waiting", run: waiting };
  }
  const settled = new Set(
    input.waypoints
      .filter((other) => other.status === "resolved" || other.status === "out_of_scope")
      .map((other) => other.number),
  );
  const waitsOn = input.blockers
    .filter((blocker) => blocker.waypointNumber === waypoint.number)
    .map((blocker) => blocker.blockerNumber)
    .filter((number) => !settled.has(number))
    .sort((a, b) => a - b);
  if (waitsOn.length > 0) {
    return { kind: "blocked", waitsOn };
  }
  if (input.map.destinationConfirmedAt === null) {
    return { kind: "destination" };
  }
  if (awaitingSurvey(input.runs)) {
    return { kind: "survey" };
  }
  return null;
}

/** The map's frontier: every `open` waypoint of any kind nothing holds back. */
export function frontier(input: FrontierInput): Waypoint[] {
  return input.waypoints.filter(
    (waypoint) => waypoint.status === "open" && frontierHold(input, waypoint) === null,
  );
}

/**
 * A waypoint's one state as Wayfinding shows it (`WaypointState`): resolved or ruled out of scope
 * by its status; else its pending round waits on you; else its run works or awaits its retry; else,
 * open, what holds it off the frontier. Every write on a map claims its frontier (`planNext`), and
 * a claimed waypoint always has a pending round or a working run, so anything else is a programmer
 * error, as is a waypoint on a map whose destination is not confirmed (charting confirms it in the
 * transaction that inserts the waypoints).
 */
export function waypointState(
  input: FrontierInput,
  rounds: readonly Pick<QuestionRound, "waypointId" | "status">[],
  waypoint: Waypoint,
): WaypointState {
  switch (waypoint.status) {
    case "resolved":
      return { kind: "resolved" };
    case "out_of_scope":
      return { kind: "out_of_scope" };
    case "open":
    case "claimed":
      break;
  }
  if (rounds.some((round) => round.waypointId === waypoint.id && round.status === "pending")) {
    return { kind: "waiting_on_you" };
  }
  if (scopeRun(scopeRuns(input.runs, waypoint.id)) === "working") {
    return { kind: "working" };
  }
  if (waypoint.status === "claimed") {
    throw new Error(`Claimed waypoint ${waypoint.id} has no pending round and no working run`);
  }
  const hold = frontierHold(input, waypoint);
  if (hold === null) {
    throw new Error(`Open waypoint ${waypoint.id} is on the frontier but not claimed`);
  }
  switch (hold.kind) {
    case "stopped":
      return { kind: "stopped", run: hold.run };
    case "waiting":
      return { kind: "waiting", run: hold.run };
    case "blocked":
      return { kind: "blocked", waitsOn: [...hold.waitsOn] };
    case "survey":
      return { kind: "waits_on_survey" };
    case "destination":
      throw new Error(`Waypoint ${waypoint.id} is on a map whose destination is not confirmed`);
  }
}

/** The purpose of a waypoint's runs, by its kind. */
export const KIND_PURPOSE: Record<WaypointKind, PlanningRunPurpose> = {
  grilling: "grilling",
  research: "research",
  task: "task",
};

/** Sets an open waypoint `claimed`; the guard makes any other status a programmer error. */
export function claim(tx: Tx, waypointId: string): void {
  const updated = tx
    .update(waypoints)
    .set({ status: "claimed", claimedAt: now() })
    .where(and(eq(waypoints.id, waypointId), eq(waypoints.status, "open")))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${waypointId} was not open when claimed`);
  }
}

/**
 * Whether a claimed waypoint is due a fresh run of its kind (a Grilling or Task waypoint): its
 * latest round is submitted and no run started since (the latest run of its scope is the one that
 * asked that round).
 */
function answeredSinceLastRun(
  waypoint: Waypoint,
  rounds: readonly QuestionRound[],
  runs: readonly PlanningRun[],
): boolean {
  const latestRound = rounds
    .filter((round) => round.waypointId === waypoint.id)
    .sort((a, b) => a.number - b.number)
    .at(-1);
  const latestRun = scopeRuns(runs, waypoint.id).at(-1);
  return (
    latestRound?.status === "submitted" &&
    latestRun?.state === "asked" &&
    latestRun.id === latestRound.askedByRun
  );
}

/**
 * Inserts the runs due on the map, inside the write transaction that made them due: the retry of
 * each scope's failed first attempt; the release (`claimed → open`) of each waypoint whose retry
 * failed; the claim and run of its kind (`grilling`, `research` or `task`) of each frontier
 * waypoint, and a run of its kind per claimed waypoint answered since its last run; then the map's
 * own due run — the first `chart`, the `chart` after the map-level round, the code `survey` once
 * the destination is confirmed, the due `fog` run, the due `consistency` pass, `to_spec` on
 * clearing or on the re-clear, whose start replaces the map's running repairs; and per idle spec
 * its due `spec_review`, repair `to_spec` or `to_tickets` (`dueSpecRuns`). A scope with a running
 * run or a stopped one (unless superseded) is never started. Every write on a map calls it, through
 * `planAndRelease` only: starting a run can supersede a stopped spec-scoped run and so end a hold,
 * so the release must follow. `plan-next-callers.test.ts` holds this.
 */
export function planNext(actor: Actor, tx: Tx, mapId: string): void {
  const map = readMap(tx, mapId);
  const runs = readMapRuns(tx, mapId);
  const scopes = new Map(
    runs.map((run) => [
      run.purpose === "hatch"
        ? `hatch|${String(run.hatchMessageId)}`
        : `${String(run.waypointId)}|${String(run.specificationId)}`,
      run,
    ]),
  );
  for (const scoped of scopes.values()) {
    const latest = runScope(runs, scoped).at(-1);
    if (latest !== undefined && awaitsRetry(latest)) {
      const retry = insertRun(actor, tx, {
        mapId,
        waypointId: latest.waypointId,
        specificationId: latest.specificationId,
        purpose: latest.purpose,
        retryOfRunId: latest.id,
        hatchMessageId: latest.hatchMessageId,
      });
      // A release run's retry keeps its wait released.
      followRelease(tx, latest.id, retry.id);
    }
  }
  const afterRetries = readMapRuns(tx, mapId);
  for (const waypoint of readWaypoints(tx, mapId)) {
    if (
      waypoint.status === "claimed" &&
      stoppedRun(scopeRuns(afterRetries, waypoint.id)) !== null
    ) {
      tx.update(waypoints)
        .set({ status: "open" })
        .where(and(eq(waypoints.id, waypoint.id), eq(waypoints.status, "claimed")))
        .run();
    }
  }
  const mapWaypoints = readWaypoints(tx, mapId);
  const rounds = readRounds(tx, mapId);
  const due = frontier({
    map,
    waypoints: mapWaypoints,
    blockers: readBlockers(tx, mapId),
    runs: afterRetries,
    outcomes: readRunOutcomes(tx, mapId),
  });
  for (const waypoint of due) {
    // A running scope means its waypoint is already claimed, so it is never on the frontier.
    if (isRunning(scopeRuns(afterRetries, waypoint.id))) {
      throw new Error(`Frontier waypoint ${waypoint.id} already has a running run`);
    }
    claim(tx, waypoint.id);
    insertRun(actor, tx, {
      mapId,
      waypointId: waypoint.id,
      specificationId: null,
      purpose: KIND_PURPOSE[waypoint.kind],
      retryOfRunId: null,
      hatchMessageId: null,
    });
  }
  for (const waypoint of mapWaypoints) {
    if (waypoint.status === "claimed" && answeredSinceLastRun(waypoint, rounds, afterRetries)) {
      insertRun(actor, tx, {
        mapId,
        waypointId: waypoint.id,
        specificationId: null,
        purpose: KIND_PURPOSE[waypoint.kind],
        retryOfRunId: null,
        hatchMessageId: null,
      });
    }
  }
  const current = readMapRuns(tx, mapId);
  const clearing = readClearing(tx, map, current);
  const cleared = isCleared(clearing);
  const mapScope = scopeRuns(current, null);
  // No review or repair starts on an un-cleared map, nor while the map-scope `to_spec` works or is
  // due: the re-clear writes the next revision of every draft.
  const writesOpen = cleared && !isWorking(mapScope, "to_spec") && !reclearDue(tx, mapId, current);
  const idle = (specificationId: string): boolean => {
    const scope = specRuns(current, specificationId);
    const latest = scope.at(-1);
    if (latest === undefined) {
      return true;
    }
    if (latest.state === "running" || awaitsRetry(latest)) {
      return false;
    }
    return stoppedRun(scope) === null || isSupersededStop(latest, clearing);
  };
  // One running run per spec across the project: another map's run on the spec gates it.
  const idleAcrossMaps = (specificationId: string): boolean =>
    idle(specificationId) && !otherMapWorking(tx, specificationId, mapId);
  for (const due of dueSpecRuns(tx, map, { idle: idleAcrossMaps, writesOpen })) {
    insertRun(actor, tx, {
      mapId,
      waypointId: null,
      retryOfRunId: null,
      hatchMessageId: null,
      ...due,
    });
  }
  startMapRun(actor, tx, map, current, clearing);
  startHatchRun(actor, tx, mapId);
  // A release run this transaction cancelled or superseded reopens its wait.
  reopenStaleReleases(tx, mapId);
}

/**
 * Whether the map's writes are open: it is cleared, and its map-scope `to_spec` neither works nor
 * is due (the re-clear writes the next revision of every draft).
 */
export function writesOpen(db: Reader, mapId: string): boolean {
  const runs = readMapRuns(db, mapId);
  const clearing = readClearing(db, readMap(db, mapId), runs);
  return (
    isCleared(clearing) &&
    !isWorking(scopeRuns(runs, null), "to_spec") &&
    !reclearDue(db, mapId, runs)
  );
}

/**
 * Whether the map's scope on the spec is idle, as `planNext` reads it: its latest run neither runs
 * nor awaits its retry, and it is not stopped (a superseded stop is idle).
 */
export function specIdle(db: Reader, mapId: string, specificationId: string): boolean {
  const runs = readMapRuns(db, mapId);
  const scope = specRuns(runs, specificationId);
  const latest = scope.at(-1);
  if (latest === undefined) {
    return true;
  }
  if (latest.state === "running" || awaitsRetry(latest)) {
    return false;
  }
  return (
    stoppedRun(scope) === null ||
    isSupersededStop(latest, readClearing(db, readMap(db, mapId), runs))
  );
}

/** Starts the map scope's due run when the scope is idle. */
function startMapRun(
  actor: Actor,
  tx: Tx,
  map: MapRecord,
  current: readonly PlanningRun[],
  clearing: ClearingInput,
): void {
  const mapId = map.id;
  const mapScope = scopeRuns(current, null);
  if (isRunning(mapScope)) {
    return;
  }
  const latestOfMap = mapScope.at(-1);
  if (latestOfMap !== undefined && stoppedRun(mapScope) !== null) {
    // A stopped draft run does not block a due fog run or pass; it supersedes it.
    if (isSupersededStop(latestOfMap, clearing)) {
      insertRun(actor, tx, {
        mapId,
        waypointId: null,
        specificationId: null,
        purpose: fogDue(clearing) ? "fog" : "consistency",
        retryOfRunId: null,
        hatchMessageId: null,
      });
    }
    return;
  }
  const purpose = dueMapPurpose(tx, map, current);
  if (purpose === "to_spec") {
    replaceRepairs(tx, mapId);
  }
  if (purpose !== null) {
    insertRun(actor, tx, {
      mapId,
      waypointId: null,
      specificationId: null,
      purpose,
      retryOfRunId: null,
      hatchMessageId: null,
    });
  }
}

/**
 * Starts the run answering the map's oldest unreplied message: one `hatch` run at a time per map,
 * none while the map's `chart` runs or awaits its retry. A stopped oldest message holds the queue
 * until Try again answers it, so the messages are answered oldest first.
 */
function startHatchRun(actor: Actor, tx: Tx, mapId: string): void {
  const runs = readMapRuns(tx, mapId);
  const mapScope = scopeRuns(runs, null);
  if (isWorking(mapScope, "chart")) {
    return;
  }
  const oldest = tx
    .select({ id: hatchMessages.id })
    .from(hatchMessages)
    .where(and(eq(hatchMessages.mapId, mapId), isNull(hatchMessages.repliedAt)))
    .orderBy(asc(hatchMessages.sentAt), asc(hatchMessages.id))
    .get();
  if (oldest === undefined || hatchRuns(runs, oldest.id).length > 0) {
    return;
  }
  if (runs.some((run) => run.purpose === "hatch" && run.state === "running")) {
    throw new Error(`Map ${mapId} runs a hatch run for a message after its oldest unreplied one`);
  }
  insertRun(actor, tx, {
    mapId,
    waypointId: null,
    specificationId: null,
    purpose: "hatch",
    retryOfRunId: null,
    hatchMessageId: oldest.id,
  });
}

/** The run, which the caller holds running; anything else is a programmer error. */
export function runningRun(tx: Tx, runId: string): PlanningRun {
  const run = tx.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
  if (run === undefined) {
    throw new Error(`No planning run with id ${runId}`);
  }
  if (run.state !== "running") {
    throw new Error(`Planning run ${runId} is ${run.state}, not running`);
  }
  return run;
}

/** Ends a running run; the guard makes a second end a programmer error. */
export function endRun(
  tx: Tx,
  runId: string,
  end: { state: "asked" | "completed" } | { state: "failed"; failure: RunFailure },
): void {
  const values =
    end.state === "failed"
      ? {
          state: end.state,
          errorCode: end.failure.code,
          errorMessage: end.failure.message,
          endedAt: now(),
        }
      : { state: end.state, endedAt: now() };
  const updated = tx
    .update(planningRuns)
    .set(values)
    .where(and(eq(planningRuns.id, runId), eq(planningRuns.state, "running")))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Planning run ${runId} was not running when it ended`);
  }
}

/**
 * Ends a running run `cancelled` with its reason (`reopened`, or `replaced`: a ticket-set run whose
 * revision a newer one replaced); its result arriving later saves nothing and is not retried.
 * Returns whether the run was running.
 */
export function cancelRun(tx: Tx, runId: string, reason: "reopened" | "replaced"): boolean {
  const updated = tx
    .update(planningRuns)
    .set({ state: "cancelled", cancelReason: reason, endedAt: now() })
    .where(and(eq(planningRuns.id, runId), eq(planningRuns.state, "running")))
    .run();
  return updated.changes === 1;
}

/**
 * Withdraws a pending round with the time and its reason (`superseded` or `waypoint_out_of_scope`);
 * a round that is not pending is a programmer error.
 */
export function withdrawRound(tx: Tx, roundId: string, reason: RoundWithdrawnReason): void {
  const withdrawn = tx
    .update(questionRounds)
    .set({ status: "withdrawn", withdrawnAt: now(), withdrawnReason: reason })
    .where(and(eq(questionRounds.id, roundId), eq(questionRounds.status, "pending")))
    .run();
  if (withdrawn.changes !== 1) {
    throw new Error(`Question round ${roundId} is not pending`);
  }
}

/**
 * Whether the run was ended `cancelled` (`replaced`, `reopened`) while its port call was out: its
 * result then saves nothing.
 */
export function isReplaced(tx: Reader, runId: string): boolean {
  const run = tx.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
  if (run === undefined) {
    throw new Error(`No planning run with id ${runId}`);
  }
  return run.state === "cancelled";
}

/**
 * Stores the usage the run's CLI call reported, whatever the run's state: it is written before the
 * run's outcome, and a cancel can end the run meanwhile.
 */
export function recordRunUsage(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  usage: PlanningRunUsage,
): void {
  const updated = write(db, actor, (tx) =>
    tx
      .update(planningRuns)
      .set(usage)
      .where(eq(planningRuns.id, runId))
      .returning({ id: planningRuns.id })
      .all(),
  );
  if (updated.length !== 1) throw new Error(`Planning run ${runId} does not exist`);
}

/**
 * Ends a running run `failed` with its code and inserts what is due, its retry first; a replaced
 * run's failure is dropped.
 */
export function failRun(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  failure: RunFailure,
): void {
  write(db, actor, (tx) => {
    if (isReplaced(tx, runId)) {
      // A replaced repair's failure arriving later saves nothing and is not retried.
      return;
    }
    const run = runningRun(tx, runId);
    endRun(tx, runId, { state: "failed", failure });
    planAndRelease(actor, tx, run.mapId);
  });
}

/**
 * The first blocker problem of a confirming chart's waypoints: a position naming no waypoint of the
 * list is `waypoint_blocker_unknown`; else blockers forming a cycle (a waypoint blocking itself
 * included) are `waypoint_blocker_cycle`. Null when there is none.
 */
export function blockerProblem(charted: readonly ChartedWaypoint[]): RunFailure | null {
  for (const [index, waypoint] of charted.entries()) {
    const unknown = waypoint.blockedBy.find((position) => position > charted.length);
    if (unknown !== undefined) {
      return {
        code: "waypoint_blocker_unknown",
        message: `Waypoint ${String(index + 1)} is blocked by position ${String(unknown)}, but the chart has ${String(charted.length)} waypoints`,
      };
    }
  }
  // Depth-first search over positions; `visiting` holds the current path.
  const done = new Set<number>();
  const visiting = new Set<number>();
  function cycleFrom(position: number): boolean {
    if (done.has(position)) return false;
    if (visiting.has(position)) return true;
    visiting.add(position);
    const waypoint = charted[position - 1];
    if (waypoint === undefined) {
      throw new Error(`No charted waypoint at position ${String(position)}`);
    }
    if (waypoint.blockedBy.some(cycleFrom)) return true;
    visiting.delete(position);
    done.add(position);
    return false;
  }
  for (let position = 1; position <= charted.length; position += 1) {
    if (cycleFrom(position)) {
      return {
        code: "waypoint_blocker_cycle",
        message: `The chart's blockers form a cycle through waypoint ${String(position)}`,
      };
    }
  }
  return null;
}

/** A charted waypoint's touch resolved to its stored spec. */
interface ResolvedTouch {
  readonly specificationId: string;
  readonly revision: number;
  readonly criteria: readonly string[];
}

/**
 * Resolves each charted waypoint's touches against the map's project: a touch names a spec of the
 * project by number, that spec's latest approved revision (an earlier one while another map's draft
 * is latest), and only criteria of that revision, and a waypoint names a spec once. Any other value
 * is `touch_reference_unknown`.
 */
function resolveTouches(
  tx: Tx,
  projectId: string,
  charted: readonly ChartedWaypoint[],
): Result<ResolvedTouch[][], RunFailure> {
  const specs = new Map(readProjectSpecs(tx, projectId).map((spec) => [spec.number, spec]));
  const resolved: ResolvedTouch[][] = [];
  for (const [index, waypoint] of charted.entries()) {
    const position = String(index + 1);
    const named = new Set<number>();
    const touches: ResolvedTouch[] = [];
    for (const touch of waypoint.touches) {
      const unknown = (why: string): Result<ResolvedTouch[][], RunFailure> =>
        err({
          code: "touch_reference_unknown",
          message: `Waypoint ${position} touches spec ${String(touch.specNumber)} revision ${String(touch.revision)}: ${why}`,
        });
      if (named.has(touch.specNumber)) {
        return unknown("the waypoint names that spec twice");
      }
      named.add(touch.specNumber);
      const spec = specs.get(touch.specNumber);
      if (spec === undefined) {
        return unknown("the project has no such spec");
      }
      const approved = readSpecRevisions(tx, spec.id)
        .filter((revision) => revision.approvedAt !== null)
        .at(-1);
      if (approved === undefined) {
        return unknown("the spec has no approved revision");
      }
      if (approved.revision !== touch.revision) {
        return unknown(`the spec's latest approved revision is ${String(approved.revision)}`);
      }
      const ids = new Set(
        approved.content.clauses.flatMap((clause) => clause.criteria.map((c) => c.id)),
      );
      const missing = touch.criteria.find((criterion) => !ids.has(criterion));
      if (missing !== undefined) {
        return unknown(`that revision has no criterion ${missing}`);
      }
      touches.push({
        specificationId: spec.id,
        revision: touch.revision,
        criteria: touch.criteria,
      });
    }
    resolved.push(touches);
  }
  return ok(resolved);
}

/**
 * Saves a chart run's outcome in one transaction and inserts what it makes due. An outcome that
 * does not fit `chartStep` of the map's map-level rounds (a proposal after a round, a follow-up
 * before any round, after a final round or at the cap, a confirmation before any round) is refused
 * `agent_output_invalid`, writing nothing but the failed run. A follow-up replaces the map's title,
 * summary and proposed destination and asks the next map-level round with its `final`; the run ends
 * `asked`. A proposal saves the map's title, summary and proposed destination, asks the first
 * map-level round, never final, and saves the maps it offers to split off the idea, pending
 * (idea-phase split); the run ends `asked`, or fails `agent_output_invalid` on an offer outside its
 * bounds, writing nothing. A confirmation confirms the destination and saves its waypoints with
 * their kinds, numbered one plus the map's highest, with their blockers, its fog items, its Out of
 * scope lines and its proposals of new maps, pending; the run ends `completed`. Blockers naming an
 * unknown position or forming a cycle are refused with their code, fog with no waypoint
 * `fog_left_unsettled`, a proposal outside its bounds `agent_output_invalid`, a touch naming
 * anything but a spec's latest approved revision and its criteria `touch_reference_unknown`:
 * nothing is written and the run fails. Valid touches are saved with their waypoints and never
 * change.
 */
export function recordChart(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: ChartOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    const run = runningRun(tx, runId);
    if (run.purpose !== "chart") {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not a chart`);
    }
    const at = now();
    const step = chartStep(mapRoundsOf(readRounds(tx, run.mapId)));
    const fits =
      step === "propose"
        ? outcome.kind === "proposal"
        : step === "choose"
          ? outcome.kind !== "proposal"
          : outcome.kind === "confirmation";
    if (!fits) {
      return refuse(actor, tx, run, {
        code: "agent_output_invalid",
        message: `A chart at step ${step} cannot return a ${outcome.kind}.`,
      });
    }
    if (outcome.kind === "followUp") {
      const { title, summary, destination, round } = outcome.followUp;
      tx.update(maps).set({ title, summary, destination }).where(eq(maps.id, run.mapId)).run();
      insertMapRound(tx, run, round, at);
      endRun(tx, runId, { state: "asked" });
      planAndRelease(actor, tx, run.mapId);
      return ok(null);
    }
    if (outcome.kind === "proposal") {
      const { title, summary, destination, round, split } = outcome.proposal;
      const splitProblem = proposalsProblem(split);
      if (splitProblem !== null) {
        endRun(tx, runId, { state: "failed", failure: splitProblem });
        planAndRelease(actor, tx, run.mapId);
        return err(splitProblem);
      }
      tx.update(maps).set({ title, summary, destination }).where(eq(maps.id, run.mapId)).run();
      // The first map-level round is never final.
      insertMapRound(tx, run, { ...round, final: false }, at);
      for (const offer of split) {
        saveSplitOffer(tx, run, offer);
      }
      endRun(tx, runId, { state: "asked" });
      planAndRelease(actor, tx, run.mapId);
      return ok(null);
    }
    const { title, summary, destination, waypoints: charted } = outcome.confirmation;
    const { fog, outOfScope, proposals } = outcome.confirmation;
    const problem =
      blockerProblem(charted) ??
      fogLeftUnsettled(
        [
          ...readWaypoints(tx, run.mapId).map((waypoint) => waypoint.status),
          ...charted.map((): WaypointStatus => "open"),
        ],
        fog.length,
      ) ??
      proposalsProblem(proposals);
    if (problem !== null) {
      endRun(tx, runId, { state: "failed", failure: problem });
      planAndRelease(actor, tx, run.mapId);
      return err(problem);
    }
    const map = tx
      .select({ projectId: maps.projectId })
      .from(maps)
      .where(eq(maps.id, run.mapId))
      .get();
    if (map === undefined) {
      throw new Error(`No map with id ${run.mapId}`);
    }
    const touches = resolveTouches(tx, map.projectId, charted);
    if (!touches.ok) {
      return refuse(actor, tx, run, touches.error);
    }
    // A confirmation may refine the map's title and summary as it refines the destination.
    tx.update(maps)
      .set({ title, summary, destination, destinationConfirmedAt: at })
      .where(eq(maps.id, run.mapId))
      .run();
    const highest = readWaypoints(tx, run.mapId).reduce((h, w) => Math.max(h, w.number), 0);
    const numberAt = (position: number) => highest + position;
    for (const [index, waypoint] of charted.entries()) {
      const waypointId = uuidv7();
      tx.insert(waypoints)
        .values({
          id: waypointId,
          mapId: run.mapId,
          number: numberAt(index + 1),
          kind: waypoint.kind,
          status: "open",
          title: waypoint.title,
          question: waypoint.question,
          claimedAt: null,
          resolution: null,
          gist: null,
          agentDecided: null,
          resolvedAt: null,
          resolvedHow: null,
          resolvedByRun: null,
          createdByRun: runId,
          personDecides: false,
        })
        .run();
      const own = touches.value[index];
      if (own === undefined) {
        throw new Error(`No resolved touches for charted waypoint ${String(index + 1)}`);
      }
      for (const touch of own) {
        tx.insert(waypointTouches)
          .values({
            waypointId,
            specificationId: touch.specificationId,
            revision: touch.revision,
            criteria: [...touch.criteria],
          })
          .run();
      }
    }
    for (const [index, waypoint] of charted.entries()) {
      // A repeated position names one blocker once.
      for (const position of new Set(waypoint.blockedBy)) {
        tx.insert(waypointBlockers)
          .values({
            mapId: run.mapId,
            waypointNumber: numberAt(index + 1),
            blockerNumber: numberAt(position),
          })
          .run();
      }
    }
    addFog(tx, run, fog);
    for (const line of outOfScope) {
      saveExclusion(tx, run, line, null, null);
    }
    for (const proposal of proposals) {
      saveProposal(tx, run, {
        title: proposal.title,
        idea: proposal.idea,
        line: proposal.line,
        waypointId: null,
      });
    }
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/** Asks the map's next map-level round, numbered one past its highest, pending. */
function insertMapRound(
  tx: Tx,
  run: PlanningRun,
  round: {
    readonly intro: string;
    readonly final: boolean;
    readonly questions: QuestionRound["questions"];
  },
  at: string,
): void {
  const mapRounds = readRounds(tx, run.mapId).filter((r) => r.waypointId === null);
  const latestNumber = mapRounds.reduce((highest, r) => Math.max(highest, r.number), 0);
  tx.insert(questionRounds)
    .values({
      id: uuidv7(),
      mapId: run.mapId,
      waypointId: null,
      number: latestNumber + 1,
      final: round.final,
      status: "pending",
      askedByRun: run.id,
      intro: round.intro,
      questions: round.questions,
      answers: null,
      askedAt: at,
      submittedAt: null,
    })
    .run();
}

/** The waypoint's rounds by number. */
export function waypointRounds(
  rounds: readonly QuestionRound[],
  waypointId: string,
): QuestionRound[] {
  return rounds
    .filter((round) => round.waypointId === waypointId)
    .sort((a, b) => a.number - b.number);
}

/**
 * The reply time of the latest applied `reopen` message on the map that reopened the waypoint; else
 * null. A reopen reaches its own waypoint and every waypoint its waypoint blocks, transitively (a
 * waypoint's blockers never change once it exists), so the message's `change.waypoint` must be this
 * waypoint or one of its transitive blockers. It counts only when the waypoint has a round
 * submitted before that reply: one merely `open`, with nothing answered, had nothing for the reopen
 * to undo. Derived from the messages, not the waypoint's `hatch_message_id`, which a later `reword`
 * or `run_waypoint` overwrites. This is how a reopen is found on a waypoint whose earlier
 * resolution left no completed run (a plain choice in records from when a plain choice resolved the
 * waypoint itself).
 */
export function reopenedAt(
  db: Reader,
  waypoint: Pick<Waypoint, "id" | "mapId" | "number">,
  waypointRoundList: readonly QuestionRound[],
): string | null {
  const blockers = readBlockers(db, waypoint.mapId);
  const reached = new Set<number>([waypoint.number]);
  const queue = [waypoint.number];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const blocker of blockers) {
      if (blocker.waypointNumber === next && !reached.has(blocker.blockerNumber)) {
        reached.add(blocker.blockerNumber);
        queue.push(blocker.blockerNumber);
      }
    }
  }
  const replies = db
    .select({
      id: hatchMessages.id,
      change: hatchMessages.change,
      repliedAt: hatchMessages.repliedAt,
    })
    .from(hatchMessages)
    .where(and(eq(hatchMessages.mapId, waypoint.mapId), isNotNull(hatchMessages.change)))
    .all()
    .flatMap((message) =>
      message.change?.kind === "reopen" && reached.has(message.change.waypoint)
        ? [present(message.repliedAt, `Reopen message ${message.id}'s reply time`)]
        : [],
    )
    .sort();
  const latest = replies.at(-1);
  if (latest === undefined) {
    return null;
  }
  const answeredBefore = waypointRoundList.some(
    (round) =>
      round.waypointId === waypoint.id && round.status === "submitted" && round.askedAt < latest,
  );
  return answeredBefore ? latest : null;
}

/** Whether a round was asked before the reopen at `reopenAt` (the reopen's reply time). */
function askedBeforeReopen(round: QuestionRound, reopenAt: string | null): boolean {
  return reopenAt !== null && round.askedAt < reopenAt;
}

/**
 * The waypoint's rounds since its work last ended, oldest first: those asked by a run after the
 * latest run of its scope that ended `completed` (it resolved or ruled out the waypoint, which a
 * reopen undid) or `cancelled` (a reopen stopped it), and after its latest reopen (`reopenAt`, from
 * `reopenedAt`). Earlier rounds stay as the record but no longer make a run "after a final round";
 * withdrawn rounds are left out.
 */
export function currentRounds(
  waypointRoundList: readonly QuestionRound[],
  scope: readonly PlanningRun[],
  reopenAt: string | null,
): QuestionRound[] {
  const ended = scope.findLastIndex(
    (run) => run.state === "completed" || run.state === "cancelled",
  );
  const later = new Set(scope.slice(ended + 1).map((run) => run.id));
  return waypointRoundList.filter(
    (round) =>
      round.status !== "withdrawn" &&
      later.has(round.askedByRun) &&
      !askedBeforeReopen(round, reopenAt),
  );
}

/**
 * A grilling waypoint's rounds split at its latest reopen. Only a reopen returns a resolved
 * waypoint to work, and a completed `grilling` run either resolved its waypoint or ruled it out of
 * scope for good, so a waypoint whose scope holds a completed run was reopened: the rounds asked up
 * to that run are `superseded` context, the later ones `live`. A waypoint resolved by a plain
 * choice left no completed run; it was reopened when a reopen message reached it (`reopenAt`, from
 * `reopenedAt`), and the rounds asked before that reply are superseded too. `currentRounds` cuts at
 * the same reopen, so a reopened waypoint is never "after a final round". Withdrawn rounds were
 * never answered and are in neither.
 */
export function reopenSplit(
  waypointRoundList: readonly QuestionRound[],
  scope: readonly PlanningRun[],
  reopenAt: string | null,
): { reopened: boolean; superseded: QuestionRound[]; live: QuestionRound[] } {
  const resolved = scope.findLastIndex((run) => run.state === "completed");
  const before = new Set(scope.slice(0, resolved + 1).map((run) => run.id));
  const kept = waypointRoundList.filter((round) => round.status !== "withdrawn");
  const superseded = (round: QuestionRound) =>
    before.has(round.askedByRun) || askedBeforeReopen(round, reopenAt);
  return {
    reopened: resolved !== -1 || reopenAt !== null,
    superseded: kept.filter(superseded),
    live: kept.filter((round) => !superseded(round)),
  };
}

/**
 * Saves a `grilling` run's outcome in one transaction and inserts what it makes due: a round on its
 * waypoint, numbered one plus the waypoint's highest (the run ends `asked`), or, with its map
 * changes, the waypoint's resolution, `resolved_how = run`, or its out-of-scope ruling; the run
 * ends `completed`. A round from a run started after a `final` round is refused
 * `agent_output_invalid`, as is a resolution of a reopened waypoint with no round asked since the
 * reopen, a resolution or ruling of a `personDecides` waypoint with no answered round (a
 * decision-routed review finding is the person's call), and map changes `mapChangesProblem` refuses
 * with their code: the run fails and nothing else is written.
 */
export function recordGrill(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: GrillOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run cancelled while its call was out saves nothing and is not retried.
      return ok(null);
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "grilling" || run.waypointId === null) {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not a waypoint's grilling`);
    }
    const waypointId = run.waypointId;
    const waypoint = tx.select().from(waypoints).where(eq(waypoints.id, waypointId)).get();
    if (waypoint?.status !== "claimed") {
      throw new Error(`Waypoint ${waypointId} is not claimed while its run ${runId} runs`);
    }
    const rounds = waypointRounds(readRounds(tx, run.mapId), waypointId);
    const at = now();
    if (outcome.round !== null) {
      const current = currentRounds(
        rounds,
        scopeRuns(readMapRuns(tx, run.mapId), waypointId),
        reopenedAt(tx, waypoint, rounds),
      );
      if (current.at(-1)?.final === true) {
        const failure: RunFailure = {
          code: "agent_output_invalid",
          message: "The run after a final round asked another round instead of resolving.",
        };
        endRun(tx, runId, { state: "failed", failure });
        planAndRelease(actor, tx, run.mapId);
        return err(failure);
      }
      const { intro, final, questions } = outcome.round;
      tx.insert(questionRounds)
        .values({
          id: uuidv7(),
          mapId: run.mapId,
          waypointId,
          number: rounds.reduce((highest, r) => Math.max(highest, r.number), 0) + 1,
          final,
          status: "pending",
          askedByRun: runId,
          intro,
          questions,
          answers: null,
          askedAt: at,
          submittedAt: null,
        })
        .run();
      endRun(tx, runId, { state: "asked" });
      planAndRelease(actor, tx, run.mapId);
      return ok(null);
    }
    if (outcome.mapChanges === null) {
      throw new Error(`Grilling run ${runId}'s outcome asks no round but has no map changes`);
    }
    if (
      waypoint.personDecides &&
      !reopenSplit(
        rounds,
        scopeRuns(readMapRuns(tx, run.mapId), waypointId),
        reopenedAt(tx, waypoint, rounds),
      ).live.some((round) => round.status === "submitted")
    ) {
      // A planning review routed this waypoint's finding to the person: the run never settles it
      // alone, by resolution or out-of-scope ruling, before the person answers a round.
      return refuse(actor, tx, run, {
        code: "agent_output_invalid",
        message:
          "A planning review left this waypoint's decision to the person and no round has been answered: ask a round instead of settling it.",
      });
    }
    const ruling = outcome.outOfScope;
    const problem =
      rulingProblem(ruling) ??
      mapChangesProblem(
        tx,
        waypoint,
        ruling === null ? "resolved" : "out_of_scope",
        outcome.mapChanges,
      );
    if (problem !== null) {
      endRun(tx, runId, { state: "failed", failure: problem });
      planAndRelease(actor, tx, run.mapId);
      return err(problem);
    }
    if (ruling !== null) {
      ruleOutOfScope(tx, run, waypointId, ruling);
    } else {
      if (outcome.resolution === null) {
        throw new Error(`Grilling run ${runId}'s outcome has no round, resolution or ruling`);
      }
      const split = reopenSplit(
        rounds,
        scopeRuns(readMapRuns(tx, run.mapId), waypointId),
        reopenedAt(tx, waypoint, rounds),
      );
      if (split.reopened && split.live.length === 0) {
        // A reopened waypoint is decided again with the person, never re-settled from the
        // superseded rounds: its resolution needs a round asked since the reopen.
        return refuse(actor, tx, run, {
          code: "agent_output_invalid",
          message:
            "The waypoint was reopened and no round has been asked since: ask a new round instead of resolving it.",
        });
      }
      tx.update(waypoints)
        .set({
          status: "resolved",
          resolution: outcome.resolution.resolution,
          gist: outcome.resolution.gist,
          agentDecided: outcome.resolution.agentDecided,
          resolvedAt: at,
          resolvedHow: "run",
          resolvedByRun: runId,
        })
        .where(and(eq(waypoints.id, waypointId), eq(waypoints.status, "claimed")))
        .run();
    }
    applyMapChanges(tx, run, outcome.mapChanges);
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/** The problem of an out-of-scope ruling's proposal outside its bounds (map proposals), or null. */
function rulingProblem(ruling: OutOfScopeRuling | null): RunFailure | null {
  if (ruling?.proposal === undefined) {
    return null;
  }
  return proposalsProblem([{ idea: ruling.proposal.idea, line: null }]);
}

/**
 * Rules a claimed waypoint out of scope: `claimed → out_of_scope`, and the run's reason saved as
 * the waypoint's Out of scope line. A proposal the ruling carries is saved pending, attached to the
 * waypoint, whose line is its line (map proposals).
 */
export function ruleOutOfScope(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  waypointId: string,
  ruling: OutOfScopeRuling,
): void {
  const updated = tx
    .update(waypoints)
    .set({ status: "out_of_scope" })
    .where(and(eq(waypoints.id, waypointId), eq(waypoints.status, "claimed")))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${waypointId} was not claimed when ruled out of scope`);
  }
  saveExclusion(tx, run, ruling.reason, waypointId, null);
  if (ruling.proposal !== undefined) {
    saveProposal(tx, run, {
      title: ruling.proposal.title,
      idea: ruling.proposal.idea,
      line: null,
      waypointId,
    });
  }
}

/** The running waypoint run of `purpose` and its claimed waypoint; anything else is a programmer error. */
function claimedRun(
  tx: Tx,
  runId: string,
  purpose: PlanningRunPurpose,
): { run: PlanningRun; waypoint: Waypoint } {
  const run = runningRun(tx, runId);
  if (run.purpose !== purpose || run.waypointId === null) {
    throw new Error(`Planning run ${runId} is a ${run.purpose} run, not a waypoint's ${purpose}`);
  }
  const waypoint = tx.select().from(waypoints).where(eq(waypoints.id, run.waypointId)).get();
  if (waypoint?.status !== "claimed") {
    throw new Error(`Waypoint ${run.waypointId} is not claimed while its run ${runId} runs`);
  }
  return { run, waypoint };
}

/** Ends a refused run `failed` with its code and inserts what is due, its retry first. */
export function refuse(
  actor: Actor,
  tx: Tx,
  run: PlanningRun,
  failure: RunFailure,
): Result<never, RunFailure> {
  endRun(tx, run.id, { state: "failed", failure });
  planAndRelease(actor, tx, run.mapId);
  return err(failure);
}

/** Sets a claimed waypoint `resolved` by its run (`resolved_how = run`). */
export function resolveByRun(
  tx: Tx,
  run: PlanningRun,
  waypointId: string,
  resolved: { resolution: string; gist: string; agentDecided: WaypointAgentDecided },
): void {
  const updated = tx
    .update(waypoints)
    .set({
      status: "resolved",
      resolution: resolved.resolution,
      gist: resolved.gist,
      agentDecided: resolved.agentDecided,
      resolvedAt: now(),
      resolvedHow: "run",
      resolvedByRun: run.id,
    })
    .where(and(eq(waypoints.id, waypointId), eq(waypoints.status, "claimed")))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${waypointId} was not claimed when its run resolved it`);
  }
}

/** Returns a claimed waypoint to `open` after an unanswered report or a failed task. */
function release(tx: Tx, waypointId: string): void {
  const updated = tx
    .update(waypoints)
    .set({ status: "open" })
    .where(and(eq(waypoints.id, waypointId), eq(waypoints.status, "claimed")))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Waypoint ${waypointId} was not claimed when its run returned it`);
  }
}

/**
 * Saves a `research` run's outcome in one transaction and inserts what it makes due: a report, its
 * row keyed by the run and its sources by position, which resolves the waypoint when answered
 * (`resolution` = summary, `resolved_how = run`) and returns it `claimed → open` when not; or an
 * out-of-scope ruling. Its map changes apply in the same transaction and the run ends `completed`.
 * A report breaking `ResearchReport`'s rules is refused `agent_output_invalid`, and map changes
 * `mapChangesProblem` refuses with their code (an unanswered report's waypoint counting as open):
 * the run fails and nothing else is written.
 */
export function recordResearch(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: ResearchOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run cancelled while its call was out saves nothing and is not retried.
      return ok(null);
    }
    const { run, waypoint } = claimedRun(tx, runId, "research");
    const { report, outOfScope: ruling, mapChanges } = outcome;
    if (report === null && ruling === null) {
      throw new Error(`Research run ${runId}'s outcome has neither a report nor a ruling`);
    }
    if (report !== null && !ResearchReport.safeParse(report).success) {
      return refuse(actor, tx, run, {
        code: "agent_output_invalid",
        message:
          "The research report breaks its rules: an answered report needs a finding and a gist and no gap, an unanswered one a gap and no gist, and every finding's sources must exist.",
      });
    }
    const ownStatus: WaypointStatus =
      report === null ? "out_of_scope" : report.answered ? "resolved" : "open";
    const problem = rulingProblem(ruling) ?? mapChangesProblem(tx, waypoint, ownStatus, mapChanges);
    if (problem !== null) {
      return refuse(actor, tx, run, problem);
    }
    if (report === null) {
      if (ruling === null) {
        throw new Error(`Research run ${runId}'s outcome has neither a report nor a ruling`);
      }
      ruleOutOfScope(tx, run, waypoint.id, ruling);
    } else {
      tx.insert(researchReports)
        .values({
          runId,
          waypointId: waypoint.id,
          answered: report.answered,
          summary: report.summary,
          gap: report.gap,
          findings: report.findings,
          limitations: report.limitations,
          uncertainties: report.uncertainties,
        })
        .run();
      for (const [index, source] of report.sources.entries()) {
        tx.insert(researchSources)
          .values({ reportRunId: runId, position: index + 1, ...source })
          .run();
      }
      if (report.answered) {
        if (report.gist === null) {
          throw new Error(`Research run ${runId}'s answered report has no gist`);
        }
        // A report states what research found, not calls: none is the agent's.
        resolveByRun(tx, run, waypoint.id, {
          resolution: report.summary,
          gist: report.gist,
          agentDecided: [],
        });
      } else {
        release(tx, waypoint.id);
      }
    }
    applyMapChanges(tx, run, mapChanges);
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/**
 * Saves a `task` run's outcome in one transaction and inserts what it makes due: a round on its
 * waypoint, `final` false (the run ends `asked`; its submission makes a fresh `task` run due on the
 * still-claimed waypoint), or, with its map changes, `done` (a `task_outcomes` row, and the
 * waypoint resolved with `resolution` = the facts), `failed` (the row, and the waypoint returned
 * `claimed → open` with no automatic retry) or an out-of-scope ruling; the run ends `completed`.
 * Map changes `mapChangesProblem` refuses fail the run with their code (a failed task's waypoint
 * counting as open), writing nothing else.
 */
export function recordTask(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: TaskOutcome,
): Result<null, RunFailure> {
  return write(db, actor, (tx): Result<null, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run cancelled while its call was out saves nothing and is not retried.
      return ok(null);
    }
    const { run, waypoint } = claimedRun(tx, runId, "task");
    if (outcome.round !== null) {
      const rounds = waypointRounds(readRounds(tx, run.mapId), waypoint.id);
      tx.insert(questionRounds)
        .values({
          id: uuidv7(),
          mapId: run.mapId,
          waypointId: waypoint.id,
          number: rounds.reduce((highest, r) => Math.max(highest, r.number), 0) + 1,
          final: false,
          status: "pending",
          askedByRun: runId,
          intro: outcome.round.intro,
          questions: outcome.round.questions,
          answers: null,
          askedAt: now(),
          submittedAt: null,
        })
        .run();
      endRun(tx, runId, { state: "asked" });
      planAndRelease(actor, tx, run.mapId);
      return ok(null);
    }
    const { done, failed, outOfScope: ruling, mapChanges } = outcome;
    if (mapChanges === null) {
      throw new Error(`Task run ${runId}'s outcome asks no round but has no map changes`);
    }
    const ownStatus: WaypointStatus =
      done !== null ? "resolved" : failed !== null ? "open" : "out_of_scope";
    const problem = rulingProblem(ruling) ?? mapChangesProblem(tx, waypoint, ownStatus, mapChanges);
    if (problem !== null) {
      return refuse(actor, tx, run, problem);
    }
    if (done !== null) {
      tx.insert(taskOutcomes)
        .values({
          runId,
          waypointId: waypoint.id,
          outcome: "done",
          action: done.action,
          facts: done.facts,
        })
        .run();
      resolveByRun(tx, run, waypoint.id, {
        resolution: done.facts,
        gist: done.gist,
        agentDecided: done.agentDecided,
      });
    } else if (failed !== null) {
      tx.insert(taskOutcomes)
        .values({
          runId,
          waypointId: waypoint.id,
          outcome: "failed",
          action: failed.action,
          facts: failed.facts,
        })
        .run();
      release(tx, waypoint.id);
    } else {
      if (ruling === null) {
        throw new Error(`Task run ${runId}'s outcome has no round, done, failed or ruling`);
      }
      ruleOutOfScope(tx, run, waypoint.id, ruling);
    }
    applyMapChanges(tx, run, mapChanges);
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok(null);
  });
}

/**
 * Saves a `consistency` run's pass in one transaction and inserts what it makes due: one
 * `consistency_passes` row comparing each resolved waypoint's id and `resolved_at`, and each
 * finding as a new unblocked Grilling waypoint, numbered on from the map's highest, with its
 * `consistency_findings` row; the run ends `completed`. A finding naming a waypoint that is not
 * `resolved` is refused `consistency_waypoint_unknown`: the run fails and nothing else is written.
 * After the first pass, a finding naming no waypoint resolved since the latest pass is dropped (not
 * refused): it opens nothing and is not stored. The value is how many were dropped.
 */
export function recordConsistency(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  outcome: ConsistencyOutcome,
): Result<{ dropped: number }, RunFailure> {
  return write(db, actor, (tx): Result<{ dropped: number }, RunFailure> => {
    if (isReplaced(tx, runId)) {
      // A run cancelled while its call was out saves nothing and is not retried.
      return ok({ dropped: 0 });
    }
    const run = runningRun(tx, runId);
    if (run.purpose !== "consistency" || run.waypointId !== null) {
      throw new Error(`Planning run ${runId} is not the map's consistency run`);
    }
    const mapWaypoints = readWaypoints(tx, run.mapId);
    const resolved = new Set(
      mapWaypoints
        .filter((waypoint) => waypoint.status === "resolved")
        .map((waypoint) => waypoint.number),
    );
    for (const [index, finding] of outcome.findings.entries()) {
      const unknown = finding.waypointNumbers.find((number) => !resolved.has(number));
      if (unknown !== undefined) {
        return refuse(actor, tx, run, {
          code: "consistency_waypoint_unknown",
          message: `Finding ${String(index + 1)} names waypoint ${String(unknown)}, which is not a resolved waypoint of the map`,
        });
      }
    }
    const proposalProblem = proposalsProblem(outcome.proposals);
    if (proposalProblem !== null) {
      return refuse(actor, tx, run, proposalProblem);
    }
    // Delta scope: a later pass reports only conflicts involving a newly resolved waypoint.
    const fresh = newSinceLastPass(mapWaypoints, readPasses(tx, run.mapId));
    const findings =
      fresh === null
        ? outcome.findings
        : outcome.findings.filter((finding) =>
            finding.waypointNumbers.some((number) => {
              const named = mapWaypoints.find((waypoint) => waypoint.number === number);
              if (named === undefined) {
                throw new Error(`Finding names waypoint ${String(number)}, not of the map`);
              }
              return fresh.has(named.id);
            }),
          );
    const passId = uuidv7();
    tx.insert(consistencyPasses)
      .values({
        id: passId,
        mapId: run.mapId,
        runId,
        compared: resolvedSet(mapWaypoints),
      })
      .run();
    applyMapChanges(tx, run, {
      newWaypoints: findings.map((finding) => ({
        kind: "grilling",
        title: finding.title,
        question: finding.question,
        blockedBy: [],
        fromFog: null,
      })),
      fogOutOfScope: [],
      fogDecided: [],
      fogSettledHere: [],
      newFog: [],
    });
    const opened = readWaypoints(tx, run.mapId).filter(
      (waypoint) => waypoint.createdByRun === runId,
    );
    if (opened.length !== findings.length) {
      throw new Error(
        `Consistency run ${runId} opened ${String(opened.length)} waypoints for ${String(findings.length)} findings`,
      );
    }
    for (const [index, finding] of findings.entries()) {
      const waypoint = opened[index];
      if (waypoint === undefined) {
        throw new Error(`Consistency run ${runId} opened no waypoint for finding ${String(index)}`);
      }
      tx.insert(consistencyFindings)
        .values({
          createdWaypointId: waypoint.id,
          passId,
          kind: finding.kind,
          waypointNumbers: finding.waypointNumbers,
          title: finding.title,
          explanation: finding.explanation,
          question: finding.question,
        })
        .run();
    }
    for (const proposal of outcome.proposals) {
      saveProposal(tx, run, {
        title: proposal.title,
        idea: proposal.idea,
        line: proposal.line,
        waypointId: null,
      });
    }
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
    return ok({ dropped: outcome.findings.length - findings.length });
  });
}

/** Ends a run `completed` after `store` stores its outcome, and inserts what is due. */
export function completeRun(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  purpose: PlanningRunPurpose,
  store: (tx: Tx, run: PlanningRun) => void,
): void {
  write(db, actor, (tx) => {
    const run = runningRun(tx, runId);
    if (run.purpose !== purpose) {
      throw new Error(`Planning run ${runId} is a ${run.purpose} run, not ${purpose}`);
    }
    store(tx, run);
    endRun(tx, runId, { state: "completed" });
    planAndRelease(actor, tx, run.mapId);
  });
}

/**
 * Starts a fresh run in the scope stopped on `runId`, or of the same kind on the waypoint waiting
 * on `runId`, itself retried once on failure, and inserts what is due. Either way a waypoint is
 * claimed again (`open → claimed`). Refuses an unknown run `planning_run_not_found`, and any run
 * that is neither a failed retry nor a waiting run that is its scope's latest, a superseded stop,
 * or a stopped `to_tickets` whose set was approved since, `planning_run_not_stopped`. Returns the
 * run's map id.
 */
export function tryAgain(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
): Result<string, TryAgainError> {
  return write(db, actor, (tx): Result<string, TryAgainError> => {
    const run = tx.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
    if (run === undefined) {
      return err({
        code: "planning_run_not_found",
        message: `No planning run with id ${runId}`,
        data: { runId },
      });
    }
    const runs = readMapRuns(tx, run.mapId);
    const scope = runScope(runs, run);
    const scopeWaypoint =
      run.waypointId === null
        ? null
        : tx.select().from(waypoints).where(eq(waypoints.id, run.waypointId)).get();
    if (scopeWaypoint === undefined) {
      throw new Error(`Planning run ${run.id}'s waypoint ${String(run.waypointId)} does not exist`);
    }
    const stopped =
      (scopeWaypoint === null ? stoppedRun(scope) : waypointStoppedRun(scopeWaypoint, scope))
        ?.runId === runId &&
      !isSupersededStop(run, readClearing(tx, readMap(tx, run.mapId), runs)) &&
      // A stopped rewrite whose set was approved since has nothing left to write.
      !(
        run.purpose === "to_tickets" &&
        run.specificationId !== null &&
        !toTicketsDue(tx, run.mapId, run.specificationId)
      );
    if (!stopped && !isWaitingOn(tx, run, scope)) {
      return err({
        code: "planning_run_not_stopped",
        message: `Planning run ${runId} is neither a failed retry nor a waiting run that is its scope's latest`,
        data: { runId },
      });
    }
    if (run.purpose === "hatch" && isWorking(scopeRuns(runs, null), "chart")) {
      // No hatch run starts while the chart runs or awaits its retry: Try again on a stopped
      // message waits for the chart, as a queued message does.
      return err({
        code: "planning_run_not_stopped",
        message: `Hatch run ${runId} cannot start again while the map's chart runs`,
        data: { runId },
      });
    }
    if (run.waypointId !== null) {
      // The failed retry released the claim, as did the waiting outcome; trying again claims the
      // waypoint again.
      claim(tx, run.waypointId);
    }
    const fresh = insertRun(actor, tx, {
      mapId: run.mapId,
      waypointId: run.waypointId,
      specificationId: run.specificationId,
      purpose: run.purpose,
      retryOfRunId: null,
      hatchMessageId: run.hatchMessageId,
    });
    // Try again on a stopped release run keeps its wait released, by the new run.
    followRelease(tx, run.id, fresh.id);
    planAndRelease(actor, tx, run.mapId);
    return ok(run.mapId);
  });
}

/** Whether `run` is the run its scope's waypoint waits on. */
function isWaitingOn(tx: Tx, run: PlanningRun, scope: readonly PlanningRun[]): boolean {
  if (run.waypointId === null) {
    return false;
  }
  const waypoint = tx.select().from(waypoints).where(eq(waypoints.id, run.waypointId)).get();
  if (waypoint === undefined) {
    throw new Error(`Planning run ${run.id}'s waypoint ${run.waypointId} does not exist`);
  }
  return waitingRun(waypoint, scope, readRunOutcomes(tx, run.mapId))?.runId === run.id;
}

/**
 * The startup sweep: ends every run left `running` `failed` with `planning_run_interrupted`, then
 * inserts what is due on every map (each interrupted first attempt gets its retry).
 */
export function sweepInterruptedRuns(db: ZeNormDatabase): void {
  // ZeNorm acting with no person behind the action; each retry it inserts takes its map's User.
  const actor: Actor = { kind: "system" };
  write(db, actor, (tx) => {
    tx.update(planningRuns)
      .set({
        state: "failed",
        errorCode: "planning_run_interrupted",
        errorMessage: "ZeNorm stopped while this run was in progress.",
        endedAt: now(),
      })
      .where(eq(planningRuns.state, "running"))
      .run();
    for (const { id } of tx.select({ id: maps.id }).from(maps).all()) {
      planAndRelease(actor, tx, id);
    }
  });
}

/** Every running planning run, oldest first: what the runner launches. */
export function runningRuns(db: Reader, mapId: string | null): PlanningRun[] {
  const running = eq(planningRuns.state, "running");
  return db
    .select()
    .from(planningRuns)
    .where(mapId === null ? running : and(running, eq(planningRuns.mapId, mapId)))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all();
}
