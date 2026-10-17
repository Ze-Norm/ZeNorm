import type {
  ActiveRun,
  MapGroup,
  MapRecord,
  MapSpec,
  MapStatus,
  NextAction,
  NextActionLabel,
  NextActionRound,
  PlanningRun,
  QuestionRound,
  SpecHoldKind,
  SpecRun,
  SpecWaitView,
  Stage,
  StageTone,
  StartDeliveryBlocker,
  StoppedRun,
  TicketSetReview,
  WaitingRun,
  Waypoint,
  WaypointKind,
} from "@zenorm/contracts";
import { isLastMapRound } from "@zenorm/contracts";

import { checkPassed } from "./delivery.ts";
import type { DeliveryOutcome } from "./delivery.ts";
import { deliveryFailureWords, stoppedRunWords } from "./failure-words.ts";
import {
  isCleared,
  isSupersededStop,
  scopeRun,
  scopeRuns,
  specRuns,
  stoppedRun,
  waypointStoppedRun,
  waitingRun,
} from "./planning-runs.ts";
import type { ClearingInput, RunOutcomes } from "./planning-runs.ts";
import type { StoredPass } from "./wayfinding-records.ts";

/** A revision's planning review as the status reads it: an escalated one sent a finding on. */
export type StatusReview = "pending" | "passed" | "findings" | "escalated";

/** One revision of a spec on this map, as the status reads it. */
export interface StatusRevision {
  /** Its number on the spec, from 1, whichever map wrote the earlier ones. */
  readonly revision: number;
  /** How many clauses (behaviours) the revision has. */
  readonly clauses: number;
  readonly approvedAt: string | null;
  /** When the revision was rejected or superseded; null while it stands. */
  readonly supersededAt: string | null;
  readonly review: StatusReview;
}

/** A spec's ticket set (its current version), as the status reads it. */
export interface StatusTicketSet {
  /** How many tickets its current version has. */
  readonly tickets: number;
  readonly approvedAt: string | null;
  /** Its current version's tickets review, from `ticketSetReview`. */
  readonly review: TicketSetReview | null;
  /**
   * Whether an earlier revision of the spec was approved (on any map): its tickets are then "new
   * tickets" (a rejected revision is not one the code was built on).
   */
  readonly follows: boolean;
  /**
   * Unapproved while a later revision of the spec stands: it is never approved, and its
   * stages read "Replaced by a later revision" before its review.
   */
  readonly replaced: boolean;
  /** Whether its current version carries any criterion as `delivered`. */
  readonly anyDelivered: boolean;
}

/** One spec the map wrote a revision of. */
export interface StatusSpec {
  readonly id: string;
  readonly number: number;
  /** Its revisions written on this map, oldest first; at least one. */
  readonly revisions: readonly StatusRevision[];
  /** The approved revision's ticket set, or null before one is written. */
  readonly ticketSet: StatusTicketSet | null;
  /**
   * Whether its `to_tickets` has work left (`toTicketsDue`): false once its set is approved, so a
   * stopped rewrite of a set approved since drives no status or Try again.
   */
  readonly ticketsDue: boolean;
  /**
   * The delivery runs of its approved revision's set, newest first: a run pinned to another map's
   * revision is not this map's.
   */
  readonly runs: readonly StatusRun[];
}

/** One delivery run as the status reads it. */
export type StatusRun = Pick<
  SpecRun,
  | "number"
  | "state"
  | "phase"
  | "branch"
  | "baseBranch"
  | "finalCommit"
  | "checks"
  | "checkResults"
  | "verdict"
  | "failure"
  | "mergedAt"
  | "pullRequest"
  | "tickets"
>;

/**
 * What `mapStatus` reads: the map, its rounds, waypoints, blockers and planning
 * runs, its spec revisions and ticket sets, and its delivery runs.
 */
export interface MapStatusInput {
  readonly map: Pick<MapRecord, "title" | "destinationConfirmedAt">;
  /** Every round of the map, map-level and on waypoints, oldest first. */
  readonly rounds: readonly Pick<
    QuestionRound,
    "waypointId" | "number" | "final" | "questions" | "status"
  >[];
  /** By number. */
  readonly waypoints: readonly Pick<
    Waypoint,
    "id" | "number" | "kind" | "title" | "status" | "resolvedAt"
  >[];
  /** Each blocker of a waypoint, by the two waypoints' numbers. */
  readonly blockers: readonly { waypointNumber: number; blockerNumber: number }[];
  /** The map's planning runs, oldest first: the map's, its waypoints' and its specs' scopes. */
  readonly planningRuns: readonly PlanningRun[];
  /** The specs the map wrote a revision of, by number. */
  readonly specs: readonly StatusSpec[];
  /** The map's project's blockers, in `delivery.start`'s order. */
  readonly startDeliveryBlockers: readonly StartDeliveryBlocker[];
  /** The map's project's active run, which `delivery_in_progress`'s words name. */
  readonly activeRun: ActiveRun | null;
  /** The map's research reports and task outcomes, which a waiting waypoint's run left. */
  readonly runOutcomes: RunOutcomes;
  /** How many fog items the map has. */
  readonly fogCount: number;
  /** The map's consistency passes, oldest first. */
  readonly passes: readonly Pick<StoredPass, "compared">[];
  /** The map's open waits and released ones whose revision it has not written. */
  readonly waits: readonly SpecWaitView[];
}

/** A map's clearing and its own runs, as the status reads them. */
type ClearingFields = Pick<
  MapStatusInput,
  "map" | "waypoints" | "rounds" | "planningRuns" | "fogCount" | "passes"
>;

/**
 * A delivery run as `reachedStage` reads it: merged or not, and its stored outcome. Whether the
 * runner holds an active run (`running` or `interrupted`) never moves a stage to or from later.
 */
export interface ReachedRun {
  readonly mergedAt: string | null;
  readonly outcome: DeliveryOutcome;
}

/** One spec the map wrote a revision of, as `reachedStage` reads it. */
export interface ReachedSpec {
  readonly id: string;
  readonly number: number;
  /** Its revisions written on this map, oldest first; at least one. */
  readonly revisions: readonly StatusRevision[];
  /** The approved revision's ticket set, or null before one is written. */
  readonly ticketSet: Pick<StatusTicketSet, "tickets" | "approvedAt" | "replaced"> | null;
  /** The delivery runs of its approved revision's set, newest first. */
  readonly runs: readonly ReachedRun[];
}

/**
 * What `reachedStage` reads: the map's stored rows that move a stage to or from later. It reads no
 * runner state, start blocker or active run, none of which does.
 */
export interface ReachedStageInput extends ClearingFields, Pick<MapStatusInput, "waits"> {
  readonly specs: readonly ReachedSpec[];
}

type Action = Omit<NextAction, "stage" | "spec">;

/** One stage's tone and line, and its next actions when it needs you or is working. */
interface Evaluated {
  readonly tone: StageTone;
  readonly line: string;
  readonly actions: readonly Action[];
}

function done(line: string): Evaluated {
  return { tone: "done", line, actions: [] };
}

function later(line: string): Evaluated {
  return { tone: "later", line, actions: [] };
}

/** A next action that opens no round and acts on no stopped or waiting run. */
const NOTHING = { round: null, stopped: null, waiting: null, onMap: null };

/**
 * The button of each action that is the person's. An action that is not the person's has none.
 * `openDelivery` is an interrupted delivery run's: it is cancelled on the Delivery page before
 * delivery starts again.
 * `mergePullRequest` is a passed run's that opened a pull request: it opens Delivery.
 */
export const ACTION_LABELS = {
  answer: "Answer",
  tryAgain: "Try again",
  approveSpec: "Approve the spec",
  approveRevision: "Approve the revision",
  approveTickets: "Approve the tickets",
  tellAgent: "Tell the agent how to fix it",
  startDelivery: "Start delivery",
  startAgain: "Start again from clean",
  openDelivery: "Open Delivery",
  markMerged: "Mark merged",
  mergePullRequest: "Merge PR",
  confirm: "Confirm",
} as const satisfies Record<string, NextActionLabel>;

function needsYou(
  line: string,
  headline: string,
  detail: string | null,
  label: NextActionLabel,
  acts: { round: NextActionRound | null; stopped: StoppedRun | null } = NOTHING,
): Evaluated {
  return {
    tone: "needs-you",
    line,
    actions: [{ who: "you", label, headline, detail, ...acts, waiting: null, onMap: null }],
  };
}

/**
 * A stopped scope's next action: its **Try again** acts on the failed retry, and its detail says
 * why the run stopped, by its code and the run's purpose.
 */
function stoppedAction(
  headline: string,
  stopped: StoppedRun,
  purpose: PlanningRun["purpose"],
): Action {
  return {
    who: "you",
    label: ACTION_LABELS.tryAgain,
    headline,
    detail: stoppedRunWords(stopped.code, purpose),
    round: null,
    stopped,
    waiting: null,
    onMap: null,
  };
}

function working(line: string, headline: string): Evaluated {
  return { tone: "working", line, actions: [agent(headline)] };
}

function agent(headline: string): Action {
  return { who: "agent", label: null, headline, detail: null, ...NOTHING };
}

/** What nobody acts on: a stage resting on a fact. */
function nobody(headline: string, detail: string | null): Action {
  return { who: "nobody", label: null, headline, detail, ...NOTHING };
}

/**
 * A wait action's detail by its live hold's kind, H the holding map.
 */
export const WAIT_DETAIL: Record<SpecHoldKind, (holder: string) => string> = {
  revision: (holder) =>
    `“${holder}” is revising it. This map's change follows once that revision is approved and its tickets are written.`,
  revising: (holder) =>
    `“${holder}” is writing its next revision. This map's change follows once that ends.`,
  tickets: (holder) =>
    `“${holder}” is writing or reviewing its tickets. This map's change follows once that ends.`,
  delivering: (holder) =>
    `A delivery run of it is active on “${holder}”. This map's change follows once the run ends.`,
};

/** "1 question", "2 questions": the count and the word, plural unless the count is one. */
export function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

/** The map's own runs, oldest first. */
function mapScope(input: Pick<MapStatusInput, "planningRuns">): readonly PlanningRun[] {
  return scopeRuns(input.planningRuns, null);
}

/** Whether the map's latest own run is a `chart` run that runs or awaits its retry. */
function charting(input: MapStatusInput): boolean {
  const latest = mapScope(input).at(-1);
  return (
    latest?.purpose === "chart" &&
    (latest.state === "running" || (latest.state === "failed" && latest.retryOfRunId === null))
  );
}

/** The map's stopped `chart` run, or null. */
function stoppedChart(input: MapStatusInput): StoppedRun | null {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "chart" ? stoppedRun(scope) : null;
}

/** The map's stopped `consistency` run (its scope is the map's), or null. */
function stoppedConsistency(input: MapStatusInput): StoppedRun | null {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "consistency" ? stoppedRun(scope) : null;
}

/** The map's stopped `survey` run (its scope is the map's), or null. */
function stoppedSurvey(input: MapStatusInput): StoppedRun | null {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "survey" ? stoppedRun(scope) : null;
}

/** Whether the map's latest own run is a `survey` run that runs or awaits its retry. */
function surveying(input: MapStatusInput): boolean {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "survey" && scopeWorking(scope);
}

/** The map's stopped `fog` run (its scope is the map's), or null. */
function stoppedFog(input: MapStatusInput): StoppedRun | null {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "fog" ? stoppedRun(scope) : null;
}

/** Whether the map's latest own run is a `fog` run that runs or awaits its retry. */
function settlingFog(input: MapStatusInput): boolean {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "fog" && scopeWorking(scope);
}

/** Whether the map's latest own run is a `consistency` run that runs or awaits its retry. */
function checkingConsistency(input: MapStatusInput): boolean {
  const scope = mapScope(input);
  return scope.at(-1)?.purpose === "consistency" && scopeWorking(scope);
}

/** A stopped waypoint scope's headline, by the waypoint's kind. */
const STOPPED_WORDS: Record<WaypointKind, (title: string) => string> = {
  grilling: (title) => `Grilling “${title}” failed.`,
  research: (title) => `Researching “${title}” failed.`,
  task: (title) => `Working the task “${title}” failed.`,
};

/** A working waypoint scope's agent entry, by the waypoint's kind. */
const WORKING_WORDS: Record<WaypointKind, (title: string) => string> = {
  grilling: (title) => `The agent is working “${title}”.`,
  research: (title) => `The agent is researching “${title}”.`,
  task: (title) => `The agent is working the task “${title}”.`,
};

/** A waiting waypoint's headline and detail: the report's gap or the failed task's facts. */
function waitingWords(
  title: string,
  waiting: WaitingRun,
  outcomes: RunOutcomes,
): { headline: string; detail: string } {
  switch (waiting.reason) {
    case "research_unanswered": {
      const report = outcomes.reports.find((candidate) => candidate.runId === waiting.runId);
      if (report === undefined) {
        throw new Error(`Waiting run ${waiting.runId} has no unanswered report`);
      }
      if (report.gap === null) {
        throw new Error(`Unanswered report ${waiting.runId} has no gap`);
      }
      return { headline: `Research could not answer “${title}”.`, detail: report.gap };
    }
    case "task_failed": {
      const outcome = outcomes.taskOutcomes.find((candidate) => candidate.runId === waiting.runId);
      if (outcome === undefined) {
        throw new Error(`Waiting run ${waiting.runId} has no failed task outcome`);
      }
      return { headline: `Task failed: “${title}”.`, detail: outcome.facts };
    }
  }
}

function clearingOf(input: ClearingFields): ClearingInput {
  return {
    map: input.map,
    waypoints: input.waypoints,
    rounds: input.rounds,
    runs: input.planningRuns,
    fogCount: input.fogCount,
    passes: input.passes,
  };
}

function cleared(input: MapStatusInput): boolean {
  return isCleared(clearingOf(input));
}

/** Idea: working during the first chart and its retry, needs-you if it stopped, else done. */
function idea(input: MapStatusInput): Evaluated {
  if (input.map.title !== null) {
    return done("Captured");
  }
  const stopped = stoppedChart(input);
  if (stopped !== null) {
    return needsYou(
      "Charting stopped",
      "Charting the map failed.",
      stoppedRunWords(stopped.code, "chart"),
      ACTION_LABELS.tryAgain,
      { round: null, stopped },
    );
  }
  if (charting(input)) {
    return working(
      "Agent is charting the map",
      "The agent is reading the repository and charting the map.",
    );
  }
  throw new Error("A map with no title has no chart running or stopped");
}

/** Whether a scope's runs, oldest first, show a run running or awaiting its retry. */
function scopeWorking(runs: readonly PlanningRun[]): boolean {
  const latest = runs.at(-1);
  return (
    latest !== undefined &&
    (latest.state === "running" || (latest.state === "failed" && latest.retryOfRunId === null))
  );
}

/** Why Wayfinding is not reached yet (later): the map has no title before its first chart. */
function wayfindingWaits(map: MapStatusInput["map"]): string | null {
  return map.title === null ? "Waits on the chart" : null;
}

/**
 * Wayfinding: later while the map has no title; then needs-you if any round is
 * pending, any `chart`, `survey`, waypoint, `fog` or `consistency` scope is stopped, or any waypoint waits on
 * the person; else working while a `chart`, `survey`, waypoint, `fog` or `consistency` run runs or awaits
 * its retry;
 * else done once cleared. Its next actions: one `you` entry per pending round (the destination
 * round first), then one per stopped scope, then one per waiting waypoint (carrying its waiting
 * run), then one `agent` entry per working run.
 */
function wayfinding(input: MapStatusInput): Evaluated {
  const waits = wayfindingWaits(input.map);
  if (waits !== null) {
    return later(waits);
  }
  // n excludes out-of-scope waypoints (neither compared nor counted).
  const total = input.waypoints.filter((waypoint) => waypoint.status !== "out_of_scope").length;
  const resolved = input.waypoints.filter((waypoint) => waypoint.status === "resolved").length;
  const progress = `${String(resolved)} of ${String(total)} resolved`;

  const answer: Action[] = [];
  const destinationRound = input.rounds.find(
    (round) => round.waypointId === null && round.status === "pending",
  );
  if (destinationRound !== undefined) {
    answer.push({
      who: "you",
      label: ACTION_LABELS.answer,
      // The last round confirms; any earlier one may bring a follow-up.
      headline: isLastMapRound(destinationRound)
        ? "Confirm the destination."
        : `Answer destination round ${String(destinationRound.number)}.`,
      detail: plural(destinationRound.questions.length, "question"),
      round: "destination",
      stopped: null,
      waiting: null,
      onMap: null,
    });
  }
  for (const waypoint of input.waypoints) {
    const round = input.rounds.find(
      (candidate) => candidate.waypointId === waypoint.id && candidate.status === "pending",
    );
    if (round === undefined) continue;
    // Direct dependents only.
    const unblocks = input.blockers.filter(
      (blocker) => blocker.blockerNumber === waypoint.number,
    ).length;
    const questions = plural(round.questions.length, "question");
    answer.push({
      who: "you",
      label: ACTION_LABELS.answer,
      headline: `Answer “${waypoint.title}”.`,
      detail:
        unblocks === 0 ? questions : `${questions} · unblocks ${plural(unblocks, "waypoint")}`,
      round: waypoint.number,
      stopped: null,
      waiting: null,
      onMap: null,
    });
  }

  const tryAgain: Action[] = [];
  const stoppedMap = stoppedChart(input);
  if (stoppedMap !== null) {
    tryAgain.push(stoppedAction("Charting the map failed.", stoppedMap, "chart"));
  }
  const stoppedCodeSurvey = stoppedSurvey(input);
  if (stoppedCodeSurvey !== null) {
    tryAgain.push(stoppedAction("Surveying the code failed.", stoppedCodeSurvey, "survey"));
  }
  const agentWork: Action[] = [];
  if (charting(input)) {
    agentWork.push(agent("The agent is charting the waypoints."));
  }
  if (surveying(input)) {
    agentWork.push(agent("The agent is surveying the code."));
  }
  const waitingOn: Action[] = [];
  for (const waypoint of input.waypoints) {
    const runs = scopeRuns(input.planningRuns, waypoint.id);
    const stopped = waypointStoppedRun(waypoint, runs);
    const waiting = waitingRun(waypoint, runs, input.runOutcomes);
    if (stopped !== null) {
      // A waypoint's runs share its kind's purpose (grilling, research or task).
      tryAgain.push(
        stoppedAction(STOPPED_WORDS[waypoint.kind](waypoint.title), stopped, waypoint.kind),
      );
    } else if (waiting !== null) {
      waitingOn.push({
        who: "you",
        label: ACTION_LABELS.tryAgain,
        ...waitingWords(waypoint.title, waiting, input.runOutcomes),
        round: null,
        stopped: null,
        waiting: { ...waiting, waypoint: waypoint.number },
        onMap: null,
      });
    } else if (scopeWorking(runs)) {
      agentWork.push(agent(WORKING_WORDS[waypoint.kind](waypoint.title)));
    }
  }
  const stoppedFogRun = stoppedFog(input);
  if (stoppedFogRun !== null) {
    tryAgain.push(stoppedAction("Settling the fog failed.", stoppedFogRun, "fog"));
  }
  if (settlingFog(input)) {
    agentWork.push(agent("The agent is settling the fog."));
  }
  const stoppedPass = stoppedConsistency(input);
  if (stoppedPass !== null) {
    tryAgain.push(
      stoppedAction("Checking that the decisions agree failed.", stoppedPass, "consistency"),
    );
  }
  if (checkingConsistency(input)) {
    agentWork.push(agent("The agent is checking that the decisions agree."));
  }

  const actions = [...answer, ...tryAgain, ...waitingOn, ...agentWork];
  if (destinationRound !== undefined) {
    return { tone: "needs-you", line: "Destination waiting on you", actions };
  }
  if (answer.length > 0) {
    return { tone: "needs-you", line: `${progress} · waiting on you`, actions };
  }
  if (stoppedMap !== null) {
    return { tone: "needs-you", line: "Charting stopped", actions };
  }
  if (tryAgain.length > 0) {
    return { tone: "needs-you", line: `${progress} · stopped`, actions };
  }
  if (waitingOn.length > 0) {
    return { tone: "needs-you", line: `${progress} · waiting on you`, actions };
  }
  if (agentWork.length > 0) {
    const line =
      input.map.destinationConfirmedAt === null
        ? "Agent is charting the waypoints"
        : `${progress} · agent working`;
    return { tone: "working", line, actions };
  }
  if (cleared(input)) {
    return done(`Map cleared · ${String(resolved)} resolved`);
  }
  throw new Error("A charted map that is not cleared has no round, stopped scope or run");
}

/** What every spec's stages read of the map: its clearing and its own `to_spec`. */
interface SpecContext {
  readonly clearing: ClearingInput;
  readonly cleared: boolean;
  /** The map-scope `to_spec`: writing (runs or awaits its retry), stopped (not superseded), or idle. */
  readonly mapDraft: "writing" | { readonly stopped: StoppedRun } | "idle";
}

function specContext(input: ClearingFields): SpecContext {
  const clearing = clearingOf(input);
  const scope = mapScope(input);
  const latest = scope.at(-1);
  const shown = scopeRun(scope);
  let mapDraft: SpecContext["mapDraft"] = "idle";
  if (latest?.purpose === "to_spec" && shown !== null) {
    if (shown === "working") {
      mapDraft = "writing";
    } else if (!isSupersededStop(latest, clearing)) {
      mapDraft = shown;
    }
  }
  return { clearing, cleared: isCleared(clearing), mapDraft };
}

/** A spec's own scope: `working` or stopped, with the purpose of its latest run; else null. */
function specScope(
  planningRuns: readonly PlanningRun[],
  spec: Pick<StatusSpec, "id">,
  context: SpecContext,
): { purpose: PlanningRun["purpose"]; shown: "working" | { stopped: StoppedRun } } | null {
  const runs = specRuns(planningRuns, spec.id);
  const latest = runs.at(-1);
  const shown = scopeRun(runs);
  if (latest === undefined || shown === null) {
    return null;
  }
  // A stopped run superseded by the clearing drives no status or Try again.
  if (shown !== "working" && isSupersededStop(latest, context.clearing)) {
    return null;
  }
  return { purpose: latest.purpose, shown };
}

/** The revision a spec's stages read: its latest on this map. */
function latestRevision(spec: Pick<StatusSpec, "number" | "revisions">): StatusRevision {
  const latest = spec.revisions.at(-1);
  if (latest === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no revision on the map`);
  }
  return latest;
}

/** The headline of a spec scope's stopped run, by its purpose. */
const SPEC_STOPPED_WORDS: Partial<
  Record<PlanningRun["purpose"], { line: string; headline: string }>
> = {
  to_spec: { line: "Revising stopped", headline: "Revising the spec failed." },
  spec_review: { line: "Planning review stopped", headline: "The planning review failed." },
  to_tickets: { line: "Writing tickets stopped", headline: "Writing the tickets failed." },
  tickets_review: { line: "Tickets review stopped", headline: "The tickets review failed." },
};

function stoppedSpecScope(purpose: PlanningRun["purpose"], stopped: StoppedRun): Evaluated {
  const words = SPEC_STOPPED_WORDS[purpose];
  if (words === undefined) {
    throw new Error(`A spec scope has a stopped ${purpose} run`);
  }
  return needsYou(
    words.line,
    words.headline,
    stoppedRunWords(stopped.code, purpose),
    ACTION_LABELS.tryAgain,
    { round: null, stopped },
  );
}

const REVISING = working("Agent is revising", "The agent is revising the spec.");

/**
 * Why one spec's Spec stage is not reached yet (later), or null when it is: an unapproved
 * revision with no review or repair on it, while the map's re-clear does not write, waits on
 * Wayfinding when its findings escalated or the map is not cleared.
 */
function specStageWaits(
  planningRuns: readonly PlanningRun[],
  spec: Pick<StatusSpec, "id" | "number" | "revisions">,
  context: SpecContext,
): string | null {
  const latest = latestRevision(spec);
  if (
    latest.approvedAt !== null ||
    specScope(planningRuns, spec, context) !== null ||
    context.mapDraft === "writing"
  ) {
    return null;
  }
  if (latest.review === "escalated") {
    return "Review findings went to Wayfinding";
  }
  // No revision of an un-cleared map is approved or rejected: the spec waits on the map.
  return context.cleared ? null : "Waits on wayfinding";
}

/**
 * One spec's Spec stage: approved is done; its review or repair working; a stopped review or
 * repair (unless superseded) needs you with Try again; every unapproved spec is revised while
 * the map's re-clear writes; escalated findings wait on Wayfinding; any other draft on an
 * un-cleared map waits on Wayfinding; a draft whose review passed awaits your approval.
 */
function specStage(input: MapStatusInput, spec: StatusSpec, context: SpecContext): Evaluated {
  const waits = specStageWaits(input.planningRuns, spec, context);
  if (waits !== null) {
    return later(waits);
  }
  const latest = latestRevision(spec);
  if (latest.approvedAt !== null) {
    return done("Approved");
  }
  const scope = specScope(input.planningRuns, spec, context);
  if (scope !== null) {
    if (scope.shown !== "working") {
      return stoppedSpecScope(scope.purpose, scope.shown.stopped);
    }
    if (scope.purpose === "spec_review") {
      return working("Planning review running", "The planning review is checking the spec.");
    }
    if (scope.purpose === "to_spec") {
      return REVISING;
    }
    throw new Error(`Unapproved spec ${String(spec.number)} has a ${scope.purpose} run`);
  }
  if (context.mapDraft === "writing") {
    return REVISING;
  }
  // Escalated findings and an un-cleared map are later (`specStageWaits`).
  if (context.mapDraft !== "idle") {
    // The map's stopped re-clear writes the next revision, so even a passed draft is not offered
    // for approval; its Try again is the map's.
    return { tone: "idle", line: "Waits on the next revision", actions: [] };
  }
  if (latest.supersededAt === null && latest.review === "passed") {
    // "Revised" past the spec's first revision, whichever map wrote it.
    const revised = latest.revision > 1;
    return needsYou(
      "Awaiting your approval",
      revised ? "Approve the revised spec." : "Approve the spec.",
      `${plural(latest.clauses, "behaviour")} · review passed`,
      revised ? ACTION_LABELS.approveRevision : ACTION_LABELS.approveSpec,
    );
  }
  // A review, repair or re-clear starts in the transaction that makes it due.
  throw new Error(
    `Spec ${String(spec.number)}'s draft has no review, repair or approval to wait on`,
  );
}

/** The latest approved revision of a spec on this map, or undefined. */
function approvedRevision(spec: Pick<StatusSpec, "revisions">): StatusRevision | undefined {
  return spec.revisions.filter((revision) => revision.approvedAt !== null).at(-1);
}

/** A replaced set's line. */
const REPLACED = "Replaced by a later revision";

/**
 * A set's count: "No new tickets" when it has none, else its tickets, "new ticket(s)" past the
 * spec's first revision.
 */
function ticketCount(set: StatusTicketSet): string {
  return set.tickets === 0
    ? "No new tickets"
    : plural(set.tickets, set.follows ? "new ticket" : "ticket");
}

/**
 * The set a review repair rewrites when spec's latest `to_tickets` is one: it
 * carries no hatch message and the set's current version failed a review that is not held; else
 * null. A first `to_tickets` has no set, a rejection rewrite follows a passed review, and a note
 * rewrite carries its message.
 */
function repairOf(input: MapStatusInput, spec: StatusSpec): StatusTicketSet | null {
  const latest = specRuns(input.planningRuns, spec.id).at(-1);
  if (latest?.purpose !== "to_tickets") {
    throw new Error(`Spec ${String(spec.number)}'s latest run is not a to_tickets`);
  }
  const set = spec.ticketSet;
  const review = set?.review;
  if (set === null || latest.hatchMessageId !== null || review?.state !== "findings") {
    return null;
  }
  return review.held ? null : set;
}

/**
 * Why one spec's Tickets stage is not reached yet (later), or null when it is: no
 * revision of the map is approved, or the map's later revision awaits approval; a replaced set is
 * reached.
 */
function ticketsWaits(
  spec: Pick<ReachedSpec, "number" | "revisions" | "ticketSet">,
): string | null {
  if (approvedRevision(spec) === undefined) {
    return "Waits on the spec";
  }
  if (spec.ticketSet?.replaced === true) {
    return null;
  }
  return latestRevision(spec).approvedAt === null ? "Waits on the spec" : null;
}

/**
 * One spec's Tickets stage: waits on the spec until approved; `to_tickets` working (a review
 * repair reads the review's findings), or stopped with Try again (not superseded by the clearing;
 * a stop whose set was approved since is); the set approved is done, with or without a review (a
 * set approved before tickets reviews has none); else by its review: pending or running is the
 * agent's, stopped needs you with Try again, passed awaits your approval, held needs you to tell
 * the agent how to fix it.
 */
function ticketsStage(input: MapStatusInput, spec: StatusSpec, context: SpecContext): Evaluated {
  // No approved revision, or the map's later revision awaits approval.
  const waits = ticketsWaits(spec);
  if (waits !== null) {
    return later(waits);
  }
  // A replaced set reads so before its review, so a held replaced set never asks you.
  if (spec.ticketSet?.replaced === true) {
    return {
      tone: "idle",
      line: REPLACED,
      actions: [nobody("A later map revises this spec.", null)],
    };
  }
  const scope = specScope(input.planningRuns, spec, context);
  if (scope?.purpose === "to_tickets") {
    if (scope.shown === "working") {
      const repair = repairOf(input, spec);
      return repair === null
        ? working("Agent is writing tickets", "The agent is writing the tickets.")
        : working(
            `${ticketCount(repair)} · review findings`,
            "The tickets review is checking the tickets.",
          );
    }
    if (spec.ticketsDue) {
      return stoppedSpecScope(scope.purpose, scope.shown.stopped);
    }
  }
  const set = spec.ticketSet;
  if (set === null) {
    // `to_tickets` starts in the transaction approving the spec.
    throw new Error(`Approved spec ${String(spec.number)} has no ticket set and no to_tickets`);
  }
  const count = ticketCount(set);
  if (set.approvedAt !== null) {
    return done(`${count} · approved`);
  }
  const review = set.review;
  if (review === null) {
    throw new Error(`Spec ${String(spec.number)}'s unapproved ticket set reads no review`);
  }
  switch (review.state) {
    case "pending":
    case "running":
      // The review starts in the transaction writing the version.
      return working(
        `${count} · tickets review running`,
        "The tickets review is checking the tickets.",
      );
    case "stopped":
      return stoppedSpecScope("tickets_review", review.stopped);
    case "passed":
      // A reviewed set with no tickets is confirmed, not approved.
      return set.tickets === 0
        ? needsYou(
            `${count} · awaiting approval`,
            "Confirm: nothing new to build.",
            "The revision is already covered by the code · review passed",
            ACTION_LABELS.confirm,
          )
        : needsYou(
            `${count} · awaiting approval`,
            "Approve the tickets.",
            `${count} · review passed`,
            ACTION_LABELS.approveTickets,
          );
    case "findings": {
      const escalated = review.findings.find((finding) => finding.escalated);
      if (!review.held || escalated === undefined) {
        // A failed, unheld review starts its repair in the transaction recording it, so
        // its spec scope's latest run is that repair: working, or stopped with Try again (its
        // tickets are due, `toTicketsDue`), both read above. A reopen or un-clear cancels neither.
        throw new Error(
          `Spec ${String(spec.number)}'s failed tickets review has no repair or hold to wait on`,
        );
      }
      return needsYou(
        `${count} · review needs you`,
        "Tell the agent how to fix it.",
        escalated.title,
        ACTION_LABELS.tellAgent,
      );
    }
  }
}

/**
 * A run's name: "Delivery run" ("The delivery run" at the start of a sentence) until the spec has
 * a second run, then "Run n".
 */
export function runName(run: Pick<StatusRun, "number">, sentenceStart: boolean): string {
  if (run.number > 1) {
    return `Run ${String(run.number)}`;
  }
  return sentenceStart ? "The delivery run" : "Delivery run";
}

/**
 * What an active run is doing and how far it has got, from its stored phase, its merged tickets
 * and its stored check results. Lines never decide it.
 */
function runProgress(run: StatusRun): { doing: string; progress: string } {
  switch (run.phase) {
    case "preparing":
      return { doing: "Preparing the run", progress: "creating the branch" };
    case "implementing": {
      if (run.tickets === null) {
        // Only a run from before `0010` has no ticket rows, and none is running.
        throw new Error(`Running run ${String(run.number)} has no ticket rows`);
      }
      const tickets = plural(run.tickets.length, "ticket");
      const merged = run.tickets.filter((ticket) => ticket.status.state === "merged").length;
      return {
        doing: `Implementing ${tickets}`,
        progress: `${String(merged)} of ${tickets} implemented`,
      };
    }
    case "verifying": {
      // Each check's result is stored as it finishes: none stored yet is none passed.
      const passed = run.checkResults === null ? 0 : run.checkResults.filter(checkPassed).length;
      return {
        doing: "Rerunning the required checks",
        progress: `${String(passed)} of ${plural(run.checks.length, "check")} passed`,
      };
    }
    case "reviewing":
      return { doing: "Independent review", progress: "checks passed · independent review" };
    case "publishing":
      return {
        doing: "Opening the pull request",
        progress: "review passed · opening the pull request",
      };
  }
}

/** The words with their first letter in `letter`'s case. */
function withFirst(words: string, letter: "lower" | "upper"): string {
  const first = words.charAt(0);
  return `${letter === "lower" ? first.toLowerCase() : first.toUpperCase()}${words.slice(1)}`;
}

/**
 * A start blocker's line on the rail: a few words, as the rail's cell truncates; the
 * next-action card carries the full sentence (`blockerWords`) and the way past it.
 */
function blockerLine(blocker: StartDeliveryBlocker): string {
  switch (blocker) {
    case "project_folder_missing":
      return "Project folder missing";
    case "project_branch_missing":
      return "Base branch has no commit";
    case "project_checks_missing":
      return "No required checks";
    case "project_repair_limit_missing":
      return "No repair limit";
    case "delivery_in_progress":
      return "Another run is active";
  }
}

/**
 * A start blocker's words: the active run's spec title names the run in progress, so
 * `delivery_in_progress` without one is a programmer error.
 */
function blockerWords(blocker: StartDeliveryBlocker, activeRun: ActiveRun | null): string {
  switch (blocker) {
    case "project_folder_missing":
      return "Project folder is missing";
    case "project_branch_missing":
      return "Base branch has no commit yet";
    case "project_checks_missing":
      return "The project has no required checks. Set them in project settings.";
    case "project_repair_limit_missing":
      return "The project has no repair limit. Set one in project settings.";
    case "delivery_in_progress":
      if (activeRun === null) {
        throw new Error("The project is blocked by an active run it does not have");
      }
      return `“${activeRun.specTitle}” already has an active run in this project.`;
  }
}

/** A run as `reachedStage` reads it: an active run is `active`, held by the runner or not. */
function reachedRun(run: Pick<StatusRun, "mergedAt" | "state">): ReachedRun {
  return {
    mergedAt: run.mergedAt,
    outcome: run.state === "running" || run.state === "interrupted" ? "active" : run.state,
  };
}

/**
 * Why one spec's Delivery stage is not reached yet (later), or null when it is: no approved set;
 * or, while the map's later revision awaits approval, nothing offers to start a run of the approved
 * set, so no run with tickets to deliver, or an unmerged blocked, failed or cancelled one, waits on
 * the tickets. A replaced set is reached. `latest` is the spec's latest run, if any.
 */
function deliveryWaits(
  spec: Pick<ReachedSpec, "number" | "revisions" | "ticketSet">,
  latest: ReachedRun | undefined,
): string | null {
  const set = spec.ticketSet;
  if (set?.replaced === true) {
    return null;
  }
  const approvedSet = set !== null && set.approvedAt !== null ? set : null;
  if (approvedSet === null) {
    return "Waits on the tickets";
  }
  if (latestRevision(spec).approvedAt !== null) {
    return null;
  }
  if (latest === undefined) {
    return approvedSet.tickets === 0 ? null : "Waits on the tickets";
  }
  const restarts =
    latest.outcome === "blocked" || latest.outcome === "failed" || latest.outcome === "cancelled";
  return latest.mergedAt === null && restarts ? "Waits on the tickets" : null;
}

/**
 * One spec's Delivery stage, from its latest run: none waits on a start blocker or awaits Start
 * delivery; a merged run is done; a running one is the agent's; a passed one awaits Merge PR when
 * it opened a pull request, else Mark merged; an interrupted one Open Delivery; a blocked, failed
 * or cancelled one Start again from clean. A spec whose own run is the project's active one shows
 * that run, never the blocker. While the map's later revision awaits approval, nothing offers to
 * start a run: no run, or a blocked, failed or cancelled one, waits on the tickets.
 */
function deliveryStage(input: MapStatusInput, spec: StatusSpec): Evaluated {
  const run = spec.runs[0];
  const waits = deliveryWaits(spec, run === undefined ? undefined : reachedRun(run));
  if (waits !== null) {
    return later(waits);
  }
  const set = spec.ticketSet;
  if (set?.replaced === true) {
    return { tone: "idle", line: REPLACED, actions: [] };
  }
  const approvedSet = set !== null && set.approvedAt !== null ? set : null;
  if (approvedSet === null) {
    // No approved set is later (`deliveryWaits`).
    throw new Error(`Spec ${String(spec.number)}'s Delivery is reached with no approved set`);
  }
  if (run === undefined) {
    if (approvedSet.tickets === 0) {
      return {
        tone: "done",
        line: "Nothing to deliver",
        actions: [
          nobody("Nothing to deliver.", "The revision changed no behaviour the code lacks."),
        ],
      };
    }
    const [blocker] = input.startDeliveryBlockers;
    if (blocker !== undefined) {
      return { tone: "idle", line: blockerLine(blocker), actions: [] };
    }
    return needsYou(
      "Ready to start",
      "Tickets approved. Start delivery.",
      `${plural(approvedSet.tickets, approvedSet.follows ? "new ticket" : "ticket")} on one branch${approvedSet.anyDelivered ? " · the rest is already in the code" : ""}`,
      ACTION_LABELS.startDelivery,
    );
  }
  const name = runName(run, false);
  const Name = runName(run, true);
  // A merged run is a passed one Mark merged recorded.
  if (run.mergedAt !== null) {
    return done(`${name} merged`);
  }
  // While the map's later revision awaits approval, Start again from clean would start a run of
  // the approved set too: that run waits on the tickets (`deliveryWaits`).
  switch (run.state) {
    case "running": {
      const { doing, progress } = runProgress(run);
      return {
        tone: "working",
        line: `${name} · ${progress}`,
        actions: [
          {
            ...agent(`${Name}: ${withFirst(doing, "lower")}.`),
            detail: `${withFirst(progress, "upper")}.`,
          },
        ],
      };
    }
    case "interrupted":
      return needsYou(
        `${name} interrupted`,
        `${Name} was interrupted. Cancel it, then start again.`,
        "ZeNorm stopped while the run was in progress.",
        ACTION_LABELS.openDelivery,
      );
    case "passed": {
      if (run.finalCommit === null) {
        throw new Error(`${name} passed without a final commit`);
      }
      if (run.pullRequest !== null && run.pullRequest.state === "closed") {
        // Closed unmerged: no longer checked on the timer; Check now reads a reopen.
        return needsYou(
          `${name} passed · pull request closed`,
          `${Name} passed. Its pull request was closed on GitHub.`,
          `Pull request #${String(run.pullRequest.number)} was closed without being merged. Reopen and merge it on GitHub, then Check now.`,
          ACTION_LABELS.mergePullRequest,
        );
      }
      if (run.pullRequest !== null) {
        return needsYou(
          `${name} passed · pull request open`,
          `${Name} passed. Merge its pull request on GitHub.`,
          `Merge pull request #${String(run.pullRequest.number)} into ${run.baseBranch} on GitHub.`,
          ACTION_LABELS.mergePullRequest,
        );
      }
      return needsYou(
        `${name} passed · ready to merge`,
        `${Name} passed. Merge the branch, then mark it merged.`,
        `Merge ${run.branch} into ${run.baseBranch} yourself, in the project folder, where the branch is. Mark merged checks that ${run.finalCommit.slice(0, 7)} is in the folder's ${run.baseBranch}, then records the tickets as delivered.`,
        ACTION_LABELS.markMerged,
      );
    }
    case "blocked": {
      if (run.verdict === null) {
        throw new Error(`${name} is blocked without a stored verdict`);
      }
      return needsYou(
        `${name} blocked by review`,
        `${Name} was blocked by the review.`,
        plural(run.verdict.findings.length, "finding"),
        ACTION_LABELS.startAgain,
      );
    }
    case "failed": {
      if (run.failure === null) {
        throw new Error(`${name} failed without a stored failure`);
      }
      // The sentence the run's head shows, never the code.
      return needsYou(
        `${name} failed`,
        `${Name} failed.`,
        deliveryFailureWords(run.failure.message),
        ACTION_LABELS.startAgain,
      );
    }
    case "cancelled":
      return needsYou(
        `${name} cancelled`,
        `${Name} was cancelled.`,
        "Start delivery again when you are ready.",
        ACTION_LABELS.startAgain,
      );
  }
}

/** One stage across the map's specs, each spec's evaluation with its number. */
type PerSpec = readonly { readonly spec: number; readonly evaluated: Evaluated }[];

/**
 * A stage across several specs: one spec reads as its own; several read "k of n specs done", plus
 * the first needs-you spec's line, else the first working one's; all done is done; all later reads
 * as the first; else idle.
 */
function acrossSpecs(perSpec: PerSpec): { tone: StageTone; line: string } {
  const [first] = perSpec;
  if (first === undefined) {
    throw new Error("A stage across specs has no spec");
  }
  if (perSpec.length === 1) {
    return first.evaluated;
  }
  const statuses = perSpec.map(({ evaluated }) => evaluated);
  const finished = statuses.filter((status) => status.tone === "done").length;
  const through = `${String(finished)} of ${String(statuses.length)} specs done`;
  const waiting =
    statuses.find((status) => status.tone === "needs-you") ??
    statuses.find((status) => status.tone === "working");
  if (waiting !== undefined) {
    return { tone: waiting.tone, line: `${through} · ${waiting.line}` };
  }
  if (finished === statuses.length) {
    return { tone: "done", line: through };
  }
  if (statuses.every((status) => status.tone === "later")) {
    return first.evaluated;
  }
  return { tone: "idle", line: through };
}

/** A map-level stage: its tone and line, and its next actions, each with the spec it is about. */
interface StageEvaluation {
  readonly tone: StageTone;
  readonly line: string;
  readonly actions: readonly (Action & { readonly spec: number | null })[];
}

function mapLevel(evaluated: Evaluated): StageEvaluation {
  return { ...evaluated, actions: evaluated.actions.map((action) => ({ ...action, spec: null })) };
}

function fromSpecs(perSpec: PerSpec): StageEvaluation {
  return {
    ...acrossSpecs(perSpec),
    actions: perSpec.flatMap(({ spec, evaluated }) =>
      evaluated.actions.map((action) => ({ ...action, spec })),
    ),
  };
}

/** A wait the map's Spec stage reads. */
type HeldWait = SpecWaitView & { readonly hold: NonNullable<SpecWaitView["hold"]> };

/** The map's open waits that a hold keeps waiting: an unheld one gives no action. */
function heldWaits(input: Pick<MapStatusInput, "waits">): readonly HeldWait[] {
  return input.waits.flatMap((wait) =>
    !wait.released && wait.hold !== null ? [{ ...wait, hold: wait.hold }] : [],
  );
}

/**
 * A held wait's action: carried out on the holding map, which is this map for its own active
 * delivery run.
 */
function waitAction(wait: HeldWait): Action & { readonly spec: number } {
  return {
    who: "another-map",
    label: null,
    headline: `Waiting on “${wait.specTitle}”.`,
    detail: WAIT_DETAIL[wait.hold.kind](wait.hold.mapTitle),
    round: null,
    stopped: null,
    waiting: null,
    onMap: wait.hold.mapId,
    spec: wait.specNumber,
  };
}

/**
 * A released wait's Spec stage: its release run, a spec-scoped `to_spec` writing the map's next
 * revision, working or stopped with Try again, until that revision lands.
 */
function releasedWait(wait: SpecWaitView): Evaluated {
  const run = wait.run;
  if (run === null) {
    throw new Error(`The released wait on spec ${String(wait.specNumber)} has no release run`);
  }
  if (run === "working") {
    return working(
      "Agent is revising",
      `The agent is writing the next revision of “${wait.specTitle}”.`,
    );
  }
  return stoppedSpecScope("to_spec", run.stopped);
}

/**
 * Why the Spec stage across the map is not reached yet (later), or null when it is: with the map's
 * `to_spec` not stopped and no held wait, before any spec an idle `to_spec` on an un-cleared map
 * waits on Wayfinding; with specs (a released wait's unwritten one among them), every one of them
 * later reads as the first. `perSpec` is each spec's own Spec stage line when later, else null.
 */
function specsStageWaits(
  context: SpecContext,
  perSpec: readonly (string | null)[],
  heldCount: number,
): string | null {
  if (typeof context.mapDraft === "object" || heldCount > 0) {
    return null;
  }
  const [first] = perSpec;
  if (first === undefined) {
    return context.mapDraft === "idle" && !context.cleared ? "Waits on wayfinding" : null;
  }
  return perSpec.every((line) => line !== null) ? first : null;
}

/** The map's Spec stage lines, per spec, as `specsStageWaits` reads them (see `deriveStatus`). */
function reachedSpecLines(input: ReachedStageInput, context: SpecContext): (string | null)[] {
  const released = releasedWaits(input.waits);
  return [
    ...input.specs.map((spec) =>
      releasedWaitOf(released, spec.number) === undefined
        ? specStageWaits(input.planningRuns, spec, context)
        : null,
    ),
    // A released wait's run is never later.
    ...unwrittenWaits(released, input.specs).map(() => null),
  ];
}

/**
 * The Spec stage across the map: before any spec, the map's `to_spec` stopped or writing, else a
 * held wait's holder, else waits on Wayfinding; with specs, across them, the map's stopped re-clear
 * first, and "· waits on another map" when nothing there needs you or works. Each held wait adds
 * its `another-map` action.
 */
function specsStage(
  context: SpecContext,
  perSpec: PerSpec,
  held: readonly HeldWait[],
): StageEvaluation {
  const waiting = specsStageWaits(
    context,
    perSpec.map(({ evaluated }) => (evaluated.tone === "later" ? evaluated.line : null)),
    held.length,
  );
  if (waiting !== null) {
    return mapLevel(later(waiting));
  }
  const { mapDraft } = context;
  const waits = held.map(waitAction);
  const withWaits = (evaluation: StageEvaluation): StageEvaluation => ({
    ...evaluation,
    actions: [...evaluation.actions, ...waits],
  });
  const stopped =
    typeof mapDraft === "object"
      ? needsYou(
          "Writing the spec stopped",
          "Writing the spec failed.",
          stoppedRunWords(mapDraft.stopped.code, "to_spec"),
          ACTION_LABELS.tryAgain,
          { round: null, stopped: mapDraft.stopped },
        )
      : null;
  if (perSpec.length === 0) {
    if (stopped !== null) {
      return withWaits(mapLevel(stopped));
    }
    if (mapDraft === "writing") {
      return withWaits(
        mapLevel(working("Agent is writing the spec", "The agent is writing the spec.")),
      );
    }
    const [first] = held;
    if (first !== undefined) {
      return withWaits({ tone: "idle", line: `Waits on “${first.hold.mapTitle}”`, actions: [] });
    }
    // An un-cleared map with no spec is later (`specsStageWaits`). A cleared map with no spec has
    // its `to_spec` running or stopped, or a held wait (a wait-only map). An open
    // wait nothing holds is released in the transaction that ends its hold while the map's writes
    // are open, so it never reads here.
    throw new Error(
      "A cleared map with no spec has no to_spec running or stopped and no held wait",
    );
  }
  const across = fromSpecs(perSpec);
  if (stopped !== null) {
    return withWaits({
      tone: stopped.tone,
      line: stopped.line,
      actions: [...mapLevel(stopped).actions, ...across.actions],
    });
  }
  if (held.length === 0 || across.tone === "needs-you" || across.tone === "working") {
    return withWaits(across);
  }
  const count = held.length === 1 ? "waits" : `${String(held.length)} wait`;
  return withWaits({ ...across, tone: "idle", line: `${across.line} · ${count} on another map` });
}

/** The one `nobody` entry of a quiet map: what it is resting on. */
function quietAction(
  input: MapStatusInput,
  stages: readonly { stage: Stage; evaluated: StageEvaluation }[],
): NextAction {
  const reached = stages.filter(({ evaluated }) => evaluated.tone !== "later").at(-1);
  if (reached === undefined) {
    throw new Error("Every stage of the map is later; Idea is always reached");
  }
  const { stage, evaluated } = reached;
  const [only, ...others] = input.specs;
  // A quiet Delivery is about the map's one spec; with several it is about all of them.
  const spec = only !== undefined && others.length === 0 ? only.number : null;
  if (stage === "delivery" && evaluated.tone === "done") {
    return {
      who: "nobody",
      label: null,
      stage,
      headline: "Delivered and merged.",
      // With several specs, every one of them is merged.
      detail: spec === null ? `${plural(input.specs.length, "spec")}.` : null,
      ...NOTHING,
      spec,
    };
  }
  const [blocker] = input.startDeliveryBlockers;
  if (stage === "delivery" && evaluated.tone === "idle" && blocker !== undefined) {
    return {
      who: "nobody",
      label: null,
      stage,
      headline: "Start delivery is unavailable.",
      detail: blockerWords(blocker, input.activeRun),
      ...NOTHING,
      spec,
    };
  }
  return {
    who: "nobody",
    label: null,
    stage,
    headline: "Nothing is in motion.",
    detail: null,
    ...NOTHING,
    spec: null,
  };
}

/**
 * The one `nobody` entry of a map nothing moves on: its one spec's resting fact
 * (a replaced set, nothing to deliver); with several specs a replaced set's first, else the quiet
 * map's.
 */
function restingOn(
  input: MapStatusInput,
  stages: readonly { stage: Stage; evaluated: StageEvaluation }[],
  actions: readonly NextAction[],
): NextAction {
  const resting = actions.filter((action) => action.who === "nobody");
  const [only] = resting;
  if (only !== undefined && input.specs.length === 1) {
    return only;
  }
  const replaced = resting.find((action) => action.stage === "tickets");
  return replaced ?? quietAction(input, stages);
}

/** A map's status and each spec's three stages, derived together from one input. */
export interface DerivedStatus {
  readonly status: MapStatus;
  /** Each spec's Spec, Tickets and Delivery stages, by spec id. */
  readonly specStages: ReadonlyMap<string, MapSpec["stages"]>;
}

/** Who a next action waits on, in the order the map lists them: yours first. */
const WHO_ORDER: readonly NextAction["who"][] = ["you", "agent", "another-map", "nobody"];

/**
 * The map's released waits. A released wait's run writes the map's next revision of its spec until
 * that revision lands: the spec's Spec stage is that run's, and a spec the map has not written
 * yet reads as one.
 */
function releasedWaits(waits: readonly SpecWaitView[]): readonly SpecWaitView[] {
  return waits.filter((wait) => wait.released);
}

/** The released wait on the spec numbered `number`, or undefined. */
function releasedWaitOf(
  released: readonly SpecWaitView[],
  number: number,
): SpecWaitView | undefined {
  return released.find((wait) => wait.specNumber === number);
}

/** The released waits on specs the map has not written a revision of yet. */
function unwrittenWaits(
  released: readonly SpecWaitView[],
  specs: readonly Pick<StatusSpec, "number">[],
): readonly SpecWaitView[] {
  return released.filter((wait) => !specs.some((spec) => spec.number === wait.specNumber));
}

/**
 * The latest of a map's five stages that its stage rail does not show as later (not reached yet),
 * as `deriveStatus` gives the tones (`quietAction` reads it so): Idea is always reached. Pure and
 * synchronous; it reads no runner state, start blocker or active run, since none of them moves a
 * stage to or from later (they only tell running from interrupted runs, and an idle Delivery's
 * blocker from its Start delivery).
 */
export function reachedStage(input: ReachedStageInput): Stage {
  const context = specContext(input);
  const everyLater = (waits: (spec: ReachedSpec) => string | null): boolean =>
    input.specs.every((spec) => waits(spec) !== null);
  // In stage order; no spec at all is later on Tickets and Delivery, as every spec later is.
  const stages: readonly (readonly [Stage, boolean])[] = [
    ["wayfinding", wayfindingWaits(input.map) === null],
    [
      "spec",
      specsStageWaits(context, reachedSpecLines(input, context), heldWaits(input).length) === null,
    ],
    ["tickets", !everyLater(ticketsWaits)],
    ["delivery", !everyLater((spec) => deliveryWaits(spec, spec.runs[0]))],
  ];
  let last: Stage = "idea";
  for (const [stage, isReached] of stages) {
    if (isReached) {
      last = stage;
    }
  }
  return last;
}

/**
 * A map's status, pure: each stage's tone and line (across the map's specs), every next action
 * (yours first, then the agent's, each in stage and spec order; one `nobody` entry for a quiet
 * map), its Inbox group, and each spec's own three stages.
 */
export function deriveStatus(input: MapStatusInput): DerivedStatus {
  const context = specContext(input);
  const released = releasedWaits(input.waits);
  const perSpec = input.specs.map((spec) => {
    const wait = releasedWaitOf(released, spec.number);
    return {
      spec,
      stages: {
        spec: wait === undefined ? specStage(input, spec, context) : releasedWait(wait),
        tickets: ticketsStage(input, spec, context),
        delivery: deliveryStage(input, spec),
      },
    };
  });
  const of = (stage: "spec" | "tickets" | "delivery"): PerSpec =>
    perSpec.map((item) => ({ spec: item.spec.number, evaluated: item.stages[stage] }));
  const unwritten: PerSpec = unwrittenWaits(released, input.specs).map((wait) => ({
    spec: wait.specNumber,
    evaluated: releasedWait(wait),
  }));

  const ide = { stage: "idea" as const, evaluated: mapLevel(idea(input)) };
  const way = { stage: "wayfinding" as const, evaluated: mapLevel(wayfinding(input)) };
  const sp = {
    stage: "spec" as const,
    evaluated: specsStage(context, [...of("spec"), ...unwritten], heldWaits(input)),
  };
  const tix = {
    stage: "tickets" as const,
    evaluated:
      perSpec.length === 0 ? mapLevel(later("Waits on the spec")) : fromSpecs(of("tickets")),
  };
  const del = {
    stage: "delivery" as const,
    evaluated:
      perSpec.length === 0 ? mapLevel(later("Waits on the tickets")) : fromSpecs(of("delivery")),
  };
  const all = [ide, way, sp, tix, del];

  const actions: NextAction[] = all.flatMap(({ stage, evaluated }) =>
    evaluated.actions.map((action) => ({ ...action, stage })),
  );
  const next = actions
    .filter((action) => action.who !== "nobody")
    .sort((a, b) => WHO_ORDER.indexOf(a.who) - WHO_ORDER.indexOf(b.who));
  const tones = all.map(({ evaluated }) => evaluated.tone);
  let group: MapGroup = "quiet";
  if (tones.includes("needs-you")) {
    group = "needs-you";
  } else if (tones.includes("working")) {
    group = "working";
  }

  function entry<TStage extends Stage>(item: { stage: TStage; evaluated: StageEvaluation }) {
    return { stage: item.stage, tone: item.evaluated.tone, line: item.evaluated.line };
  }
  function own<TStage extends Stage>(stage: TStage, evaluated: Evaluated) {
    return { stage, tone: evaluated.tone, line: evaluated.line };
  }

  return {
    status: {
      stages: [entry(ide), entry(way), entry(sp), entry(tix), entry(del)],
      next: next.length === 0 ? [restingOn(input, all, actions)] : next,
      group,
    },
    specStages: new Map(
      perSpec.map(({ spec, stages }) => [
        spec.id,
        [
          own("spec", stages.spec),
          own("tickets", stages.tickets),
          own("delivery", stages.delivery),
        ] as const,
      ]),
    ),
  };
}

/** A map's status, without the per-spec stages. */
export function mapStatus(input: MapStatusInput): MapStatus {
  return deriveStatus(input).status;
}
