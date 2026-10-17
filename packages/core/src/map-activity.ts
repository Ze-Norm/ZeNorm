import type {
  ActivityLine,
  Disposition,
  HatchChange,
  MapRecord,
  PlanningRun,
  PlanningRunPurpose,
  QuestionRound,
  SpecHoldKind,
  Stage,
  Waypoint,
} from "@zenorm/contracts";

import { deliveryOutcome } from "./delivery.ts";
import { plural, runName } from "./map-status.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import type {
  Exclusion,
  StoredPass,
  StoredReport,
  StoredTaskOutcome,
} from "./wayfinding-records.ts";

/** A revision's planning review outcome as the activity reads it (D13), at the review's end. */
export type ActivityReview =
  | { readonly outcome: "passed"; readonly at: string }
  /** Failed and not escalated; `repairing` when a repair started from it. */
  | {
      readonly outcome: "findings";
      readonly at: string;
      readonly findings: number;
      readonly repairing: boolean;
    }
  /** Sent on to Wayfinding: the numbers of the waypoints its escalated findings opened or linked. */
  | { readonly outcome: "escalated"; readonly at: string; readonly waypoints: readonly number[] };

/** One revision of a spec written on the map (D13). */
export interface ActivityRevision {
  /** The revision's own title. */
  readonly title: string;
  /** True for the spec's first revision, else a revision of it. */
  readonly first: boolean;
  /**
   * True when it revises a spec an earlier map delivered (slice 8b D14): the revision before it is
   * another map's, and a merged run delivered an earlier revision.
   */
  readonly laterMapOfDelivered: boolean;
  readonly writtenAt: string;
  /** The `to_spec` run that wrote it: a note's when that run carries a hatch message (S7b-13). */
  readonly writtenByRun: string;
  /**
   * Its planning reviews, oldest first: one per rewrite of a draft in place (L241), the review of
   * its current content last; empty before the first.
   */
  readonly reviews: readonly ActivityReview[];
  readonly approvedAt: string | null;
  /** The person's rejection, or null. */
  readonly rejection: { readonly reason: string; readonly at: string } | null;
}

/**
 * A ticket set version's tickets review as the activity reads it (slice 7c D10), at the review's
 * end: passed, or failed with its findings, `held` when one escalated. A failed review that is not
 * held starts its repair in the transaction recording it (S7c-4, L175).
 */
export type ActivityTicketsReview =
  | { readonly outcome: "passed"; readonly at: string }
  | {
      readonly outcome: "findings";
      readonly at: string;
      readonly findings: number;
      readonly held: boolean;
    };

/** A spec's ticket set (D13): each version written and reviewed, its approval and its rejections. */
export interface ActivityTicketSet {
  /** The approved revision's title. */
  readonly title: string;
  /** The approved revision's number. */
  readonly revision: number;
  /**
   * Whether an earlier revision of the spec was approved (on any map): its tickets are then checked
   * against what was delivered.
   */
  readonly follows: boolean;
  /** When the revision was approved. */
  readonly revisionApprovedAt: string;
  /**
   * Oldest first, each with the `to_tickets` run that wrote it (a note's, S7b-13) and its recorded
   * tickets review, or null with none.
   */
  readonly versions: readonly {
    readonly tickets: number;
    /** The kind of each of the version's dispositions. */
    readonly dispositions: readonly Disposition["kind"][];
    readonly writtenAt: string;
    readonly writtenByRun: string;
    readonly review: ActivityTicketsReview | null;
  }[];
  readonly approvedAt: string | null;
  /** Oldest first. */
  readonly rejections: readonly { readonly reason: string; readonly at: string }[];
  /** The set's delivery runs (slice 8 D13), in any order. */
  readonly runs: readonly ActivityRun[];
}

/** One delivery run as the activity reads it (slice 8 D13). */
export type ActivityRun = Pick<
  StoredDeliveryRun,
  "number" | "startedAt" | "endedAt" | "verdict" | "failure" | "mergedAt" | "baseBranch"
>;

/** One spec the map wrote a revision of (D13). */
export interface ActivitySpec {
  readonly id: string;
  /** The spec's number in its project. */
  readonly number: number;
  /** Its revisions written on this map, oldest first. */
  readonly revisions: readonly ActivityRevision[];
  /** The ticket set of each revision the map approved, oldest first (slice 8b D14). */
  readonly ticketSets: readonly ActivityTicketSet[];
}

/** A wait the map recorded (slice 8b D14), with the hold it was recorded under (tickets review B3). */
export interface ActivityWait {
  readonly specNumber: number;
  /** The spec's latest title. */
  readonly specTitle: string;
  readonly since: string;
  /** The stored hold's kind, never the live one. */
  readonly holdKind: SpecHoldKind;
  /** The stored holding map's title. */
  readonly holdMapTitle: string;
  /** When it was released, or null while open. */
  readonly releasedAt: string | null;
}

/** A spec a waypoint of the map touches (slice 8b D14): delivered when any criterion is. */
export interface ActivityTouch {
  readonly waypoint: number;
  readonly specTitle: string;
  readonly delivered: boolean;
}

/** A change a hatch message applied (D7): the change, the run that replied, and when. */
export interface HatchChangeApplied {
  readonly change: HatchChange;
  readonly runId: string;
  readonly appliedAt: string;
}

/**
 * What `mapActivity` reads: the map's runs, rounds and the stored timestamps of its records (slice
 * 6a spec D11, slice 5 spec D9).
 */
export interface MapActivityInput {
  readonly map: Pick<MapRecord, "createdAt" | "destinationConfirmedAt">;
  /** Every round of the map, map-level and on waypoints. */
  readonly rounds: readonly Pick<
    QuestionRound,
    "waypointId" | "number" | "questions" | "askedAt" | "submittedAt"
  >[];
  readonly waypoints: readonly Pick<
    Waypoint,
    "id" | "number" | "kind" | "title" | "resolvedAt" | "resolvedHow" | "createdByRun"
  >[];
  /** The map's blockers by waypoint number. */
  readonly blockers: readonly { waypointNumber: number; blockerNumber: number }[];
  /** The map's planning runs, oldest first. */
  readonly planningRuns: readonly PlanningRun[];
  /** The specs the map wrote a revision of, by number (D13). */
  readonly specs: readonly ActivitySpec[];
  /** The map's research reports (6b D11). */
  readonly reports: readonly Pick<StoredReport, "runId" | "answered">[];
  /** The map's task outcomes (6b D11). */
  readonly taskOutcomes: readonly Pick<StoredTaskOutcome, "runId" | "outcome">[];
  /** The map's Out of scope lines, with the run that wrote each (6b D11). */
  readonly exclusions: readonly Pick<Exclusion, "waypointId" | "createdByRun">[];
  /** The map's consistency passes (6b D11). */
  readonly passes: readonly Pick<StoredPass, "runId" | "findingCount">[];
  /**
   * The change each replied hatch message applied (D7, L147 Q1), with the `hatch` run that replied
   * and the reply's time; messages that applied none (a reply only, a refusal) are not here.
   */
  readonly hatchChanges: readonly HatchChangeApplied[];
  /** Every wait the map recorded, oldest first (slice 8b D14). */
  readonly waits: readonly ActivityWait[];
  /** Each spec each waypoint of the map touches (slice 8b D14). */
  readonly touches: readonly ActivityTouch[];
}

/** A line that opens no waypoint. */
function line(stage: Stage, text: string, at: string): ActivityLine {
  return { stage, text, waypoint: null, spec: null, specLabel: null, at };
}

/** The stage a planning run's purpose works on. */
const PURPOSE_STAGE: Partial<Record<PlanningRunPurpose, Stage>> = {
  chart: "wayfinding",
  survey: "wayfinding",
  fog: "wayfinding",
  grilling: "wayfinding",
  research: "wayfinding",
  task: "wayfinding",
  consistency: "wayfinding",
  to_spec: "spec",
  spec_review: "spec",
  to_tickets: "tickets",
  tickets_review: "tickets",
};

/** What a planning run was doing, for its failure lines. */
const PURPOSE_WORDS: Partial<Record<PlanningRunPurpose, string>> = {
  chart: "Charting the map",
  survey: "Surveying the code",
  fog: "Settling the fog",
  grilling: "Grilling a waypoint",
  research: "Researching a waypoint",
  task: "Working a task",
  consistency: "Checking that the decisions agree",
  to_spec: "Writing the spec",
  spec_review: "The planning review",
  to_tickets: "Writing the tickets",
  tickets_review: "The tickets review",
};

/** A known value of a partial record; a missing one is a programmer error. */
function known<T>(record: Partial<Record<PlanningRunPurpose, T>>, purpose: PlanningRunPurpose): T {
  const value = record[purpose];
  if (value === undefined) {
    throw new Error(`No planning run of purpose ${purpose} is started in this slice`);
  }
  return value;
}

/**
 * The Wayfinding lines (spec D11), from planning runs and rounds: the map being charted, the
 * destination asked, answered and confirmed, each waypoint's questions written and answered and its
 * resolution, the map cleared and the spec being written, and each failed run retried or stopped.
 */
function wayfindingLines(input: MapActivityInput): ActivityLine[] {
  const { map } = input;
  const lines: ActivityLine[] = [];
  const firstRuns = input.planningRuns.filter((run) => run.retryOfRunId === null);
  const charts = firstRuns.filter((run) => run.purpose === "chart");
  const [firstChart] = charts;
  if (firstChart !== undefined) {
    lines.push(line("idea", "The agent is charting the map.", firstChart.startedAt));
  }
  for (const round of input.rounds.filter((candidate) => candidate.waypointId === null)) {
    // DR-20: every map-level round is numbered.
    const n = String(round.number);
    lines.push(line("wayfinding", `The agent asked destination round ${n}.`, round.askedAt));
    if (round.submittedAt !== null) {
      lines.push(line("wayfinding", `You answered destination round ${n}.`, round.submittedAt));
    }
  }
  if (map.destinationConfirmedAt !== null) {
    const count = input.waypoints.length;
    lines.push(
      line(
        "wayfinding",
        `Destination confirmed with ${String(count)} waypoint${count === 1 ? "" : "s"}.${deliveredTouchWords(input)}`,
        map.destinationConfirmedAt,
      ),
    );
  }
  for (const waypoint of input.waypoints) {
    const opens = (text: string, at: string): ActivityLine => ({
      stage: "wayfinding",
      text,
      waypoint: waypoint.number,
      spec: null,
      specLabel: null,
      at,
    });
    // Direct dependents only (L106).
    const unblocks = input.blockers.filter(
      (blocker) => blocker.blockerNumber === waypoint.number,
    ).length;
    const unblockWords =
      unblocks === 0
        ? ""
        : ` Its answers unblock ${String(unblocks)} waypoint${unblocks === 1 ? "" : "s"}.`;
    for (const round of input.rounds.filter((candidate) => candidate.waypointId === waypoint.id)) {
      const count = round.questions.length;
      lines.push(
        opens(
          waypoint.kind === "task"
            ? `The task “${waypoint.title}” asked you: ${plural(count, "question")}.${unblockWords}`
            : `Questions written for “${waypoint.title}”: ${String(count)}.${unblockWords}`,
          round.askedAt,
        ),
      );
      if (round.submittedAt !== null) {
        lines.push(
          line(
            "wayfinding",
            `You answered the agent's questions on “${waypoint.title}”.`,
            round.submittedAt,
          ),
        );
      }
    }
    // A Research or Task waypoint's resolution is its report's or outcome's line (6b D11). The
    // lines are history (L155 (c), L156 (3)): every resolution the waypoint ever had keeps its
    // line after a reopen, so they come from the resolving runs, not the current resolution.
    for (const resolved of grillingResolutions(input).filter(
      (resolution) => resolution.waypointId === waypoint.id,
    )) {
      lines.push(opens(`“${waypoint.title}” is resolved.`, resolved.at));
    }
  }
  lines.push(...researchTaskLines(input), ...mapChangeLines(input));
  // Every clear and re-clear (S7b-8) starts a map-scope `to_spec`; a fresh run after Try again
  // continues the stopped one and is no new clear.
  const mapScope = input.planningRuns.filter(
    (run) => run.purpose === "to_spec" && run.specificationId === null,
  );
  for (const [index, run] of mapScope.entries()) {
    const before = mapScope[index - 1];
    if (run.retryOfRunId !== null || before?.state === "failed") continue;
    const decisions = decisionsAt(input, run.startedAt);
    // On Spec, as the demo's `store.tsx` clear line (L160).
    lines.push(
      line(
        "spec",
        `Map cleared${decisions > 1 ? `: your ${String(decisions)} decisions fit together` : ""}. Spec being written.`,
        run.startedAt,
      ),
    );
  }
  const firstAsked = input.rounds.find((round) => round.waypointId === null)?.askedAt;
  /** The first chart and its retry work on Idea (D8); every later chart on Wayfinding. */
  const stageOf = (run: PlanningRun): Stage =>
    run.purpose === "chart" &&
    (firstAsked === undefined || Date.parse(run.startedAt) < Date.parse(firstAsked))
      ? "idea"
      : known(PURPOSE_STAGE, run.purpose);
  for (const run of input.planningRuns) {
    if (run.state !== "failed") continue;
    // A hatch run's state shows on its message in the stream, never as a line (D6, D7, L148).
    if (run.purpose === "hatch") continue;
    if (run.endedAt === null || run.errorCode === null) {
      throw new Error(`Failed planning run ${run.id} has no end time or error code`);
    }
    const words = known(PURPOSE_WORDS, run.purpose);
    lines.push(
      line(
        stageOf(run),
        // The code stays off the line (L141); the next action's detail says why it failed.
        run.retryOfRunId === null
          ? `${words} failed. The agent is trying again.`
          : `${words} failed again. It stopped: Try again.`,
        run.endedAt,
      ),
    );
  }
  return lines;
}

/**
 * The chart line's sentences naming each delivered spec the map's waypoints touch (slice 8b D14,
 * the demo's `fixtures.ts` "One changes the delivered spec “X”."), in the order first touched.
 */
function deliveredTouchWords(input: MapActivityInput): string {
  const counts = new Map<string, Set<number>>();
  for (const touch of input.touches) {
    if (!touch.delivered) continue;
    const waypoints = counts.get(touch.specTitle);
    if (waypoints === undefined) {
      counts.set(touch.specTitle, new Set([touch.waypoint]));
    } else {
      waypoints.add(touch.waypoint);
    }
  }
  return [...counts.entries()]
    .map(([title, waypoints]) =>
      waypoints.size === 1
        ? ` One changes the delivered spec “${title}”.`
        : ` ${String(waypoints.size)} change the delivered spec “${title}”.`,
    )
    .join("");
}

/**
 * Each Grilling resolution the map's waypoints ever had, oldest first: a completed `grilling` run
 * that did not rule its waypoint out of scope resolved it at its end (S6a-10, S7b-14); a stored
 * plain-choice resolution (before S7b-14) has no run and reads its `resolved_at`.
 */
function grillingResolutions(input: MapActivityInput): { waypointId: string; at: string }[] {
  const byRuns = input.planningRuns
    .filter(
      (run) =>
        run.purpose === "grilling" &&
        run.state === "completed" &&
        run.waypointId !== null &&
        !input.exclusions.some(
          (exclusion) =>
            exclusion.createdByRun === run.id && exclusion.waypointId === run.waypointId,
        ),
    )
    .map((run) => ({ waypointId: workedBy(input, run).id, at: endOf(run) }));
  const byPlainChoice = input.waypoints.flatMap((waypoint) =>
    waypoint.resolvedHow === "plain_choice" && waypoint.resolvedAt !== null
      ? [{ waypointId: waypoint.id, at: waypoint.resolvedAt }]
      : [],
  );
  return [...byRuns, ...byPlainChoice];
}

/**
 * How many decisions a clear at `at` read (L162 (5)): a clear needs every waypoint resolved or out
 * of scope (S6b-10), so they are the waypoints that existed then (each is created when its run
 * ends) less those ruled out of scope by then; an Out of scope ruling is final. Read from the runs
 * and Out of scope lines, which a later reopen leaves alone, so the count stays as of that clear
 * even when a reopen clears a stored plain-choice resolution (L160).
 */
function decisionsAt(input: MapActivityInput, at: string): number {
  const time = Date.parse(at);
  const by = (runId: string) => Date.parse(endOf(runOf(input, runId))) <= time;
  const existing = input.waypoints.filter((waypoint) => by(waypoint.createdByRun));
  const excluded = new Set(
    input.exclusions.flatMap((exclusion) =>
      exclusion.waypointId !== null && by(exclusion.createdByRun) ? [exclusion.waypointId] : [],
    ),
  );
  return existing.filter((waypoint) => !excluded.has(waypoint.id)).length;
}

/** A completed run's end; a missing one is a programmer error. */
function endOf(run: PlanningRun): string {
  if (run.endedAt === null) {
    throw new Error(`Planning run ${run.id} has a saved outcome but no end time`);
  }
  return run.endedAt;
}

/** The map's run by id; a missing one is a programmer error. */
function runOf(input: MapActivityInput, runId: string): PlanningRun {
  const run = input.planningRuns.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error(`No planning run ${runId} on the map`);
  }
  return run;
}

/** The map's waypoint by id; a missing one is a programmer error. */
function waypointOf(input: MapActivityInput, id: string): MapActivityInput["waypoints"][number] {
  const waypoint = input.waypoints.find((candidate) => candidate.id === id);
  if (waypoint === undefined) {
    throw new Error(`No waypoint ${id} on the map`);
  }
  return waypoint;
}

/** The waypoint a waypoint run works; a map-level run is a programmer error. */
function workedBy(
  input: MapActivityInput,
  run: PlanningRun,
): MapActivityInput["waypoints"][number] {
  if (run.waypointId === null) {
    throw new Error(`Planning run ${run.id} works no waypoint`);
  }
  return waypointOf(input, run.waypointId);
}

function opening(text: string, waypoint: { number: number }, at: string): ActivityLine {
  return { stage: "wayfinding", text, waypoint: waypoint.number, spec: null, specLabel: null, at };
}

/**
 * Research and Task lines (6b D11): research started, finished, could not answer; task started,
 * done, failed. A run started after the task's answered round is no new start. "Finished",
 * "could not answer", "done" and "failed" open the waypoint.
 */
function researchTaskLines(input: MapActivityInput): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const [index, run] of input.planningRuns.entries()) {
    if (run.retryOfRunId !== null || run.waypointId === null) continue;
    const waypoint = waypointOf(input, run.waypointId);
    if (run.purpose === "research") {
      lines.push(
        line("wayfinding", `The agent is researching “${waypoint.title}”.`, run.startedAt),
      );
    }
    if (run.purpose === "task") {
      const before = input.planningRuns
        .slice(0, index)
        .filter((candidate) => candidate.waypointId === run.waypointId)
        .at(-1);
      if (before?.state !== "asked") {
        lines.push(
          line("wayfinding", `The agent started the task “${waypoint.title}”.`, run.startedAt),
        );
      }
    }
  }
  for (const report of input.reports) {
    const run = runOf(input, report.runId);
    const waypoint = workedBy(input, run);
    lines.push(
      opening(
        report.answered
          ? `Research finished: “${waypoint.title}” is resolved.`
          : `Research could not answer “${waypoint.title}”.`,
        waypoint,
        endOf(run),
      ),
    );
  }
  for (const outcome of input.taskOutcomes) {
    const run = runOf(input, outcome.runId);
    const waypoint = workedBy(input, run);
    lines.push(
      opening(
        outcome.outcome === "done"
          ? `Task done: “${waypoint.title}” is resolved.`
          : `Task failed: “${waypoint.title}”.`,
        waypoint,
        endOf(run),
      ),
    );
  }
  return lines;
}

/**
 * Map-change lines (6b D11): a waypoint ruled out of scope (opening it), n new waypoints charted by
 * waypoint m (opening m), a fog item moved out of scope, and each consistency pass.
 */
function mapChangeLines(input: MapActivityInput): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const exclusion of input.exclusions) {
    const run = runOf(input, exclusion.createdByRun);
    // A waypoint the hatch ruled out of scope has the note's own line (D7, `hatchLines`).
    if (exclusion.waypointId !== null && run.purpose === "hatch") continue;
    if (exclusion.waypointId !== null) {
      const waypoint = waypointOf(input, exclusion.waypointId);
      lines.push(opening(`“${waypoint.title}” was ruled out of scope.`, waypoint, endOf(run)));
    } else if (run.purpose !== "chart") {
      lines.push(line("wayfinding", "A fog item was moved out of scope.", endOf(run)));
    }
  }
  for (const run of input.planningRuns) {
    if (run.waypointId === null) continue;
    const count = input.waypoints.filter((waypoint) => waypoint.createdByRun === run.id).length;
    if (count === 0) continue;
    const by = workedBy(input, run);
    lines.push(
      opening(
        `${String(count)} new waypoint${count === 1 ? "" : "s"} charted by waypoint ${String(by.number)}.`,
        by,
        endOf(run),
      ),
    );
  }
  for (const pass of input.passes) {
    const run = runOf(input, pass.runId);
    lines.push(
      line(
        "wayfinding",
        pass.findingCount === 0
          ? "Consistency pass: the resolutions agree."
          : `Consistency pass: ${plural(pass.findingCount, "conflict")} opened as ${pass.findingCount === 1 ? "a waypoint" : "waypoints"}.`,
        endOf(run),
      ),
    );
  }
  return lines;
}

/** The map's waypoint by number; a missing one is a programmer error. */
function numbered(input: MapActivityInput, number: number): MapActivityInput["waypoints"][number] {
  const waypoint = input.waypoints.find((candidate) => candidate.number === number);
  if (waypoint === undefined) {
    throw new Error(`No waypoint ${String(number)} on the map`);
  }
  return waypoint;
}

/**
 * The waypoint a hatch `open_waypoint` added: the first one its run charted (a fog settlement may
 * chart more after it); none is a programmer error.
 */
function added(input: MapActivityInput, runId: string): MapActivityInput["waypoints"][number] {
  const [first] = input.waypoints
    .filter((waypoint) => waypoint.createdByRun === runId)
    .sort((a, b) => a.number - b.number);
  if (first === undefined) {
    throw new Error(`Hatch run ${runId} added a waypoint the map does not have`);
  }
  return first;
}

/**
 * The lines of the waypoint changes hatch messages applied (D7, S7b-10), each opening the waypoint
 * it changed, at the reply's time. A spec or ticket note's line is its revision's or version's
 * (`specLines`), written when its run saves it.
 */
function hatchLines(input: MapActivityInput): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const { change, runId, appliedAt } of input.hatchChanges) {
    switch (change.kind) {
      case "reopen": {
        const waypoint = numbered(input, change.waypoint);
        lines.push(opening(`Reopened from your note: “${waypoint.title}”.`, waypoint, appliedAt));
        break;
      }
      case "open_waypoint": {
        const waypoint = added(input, runId);
        lines.push(
          opening(`Waypoint added from your note: “${waypoint.title}”.`, waypoint, appliedAt),
        );
        break;
      }
      case "reword": {
        const waypoint = numbered(input, change.waypoint);
        lines.push(opening(`Reworded from your note: “${waypoint.title}”.`, waypoint, appliedAt));
        break;
      }
      case "rule_out_of_scope": {
        const waypoint = numbered(input, change.waypoint);
        lines.push(
          opening(`Ruled out of scope from your note: “${waypoint.title}”.`, waypoint, appliedAt),
        );
        break;
      }
      case "run_waypoint": {
        const waypoint = numbered(input, change.waypoint);
        lines.push(opening(`Run again from your note: “${waypoint.title}”.`, waypoint, appliedAt));
        break;
      }
      case "accept_report": {
        const waypoint = numbered(input, change.waypoint);
        lines.push(
          opening(`Accepted the report from your note: “${waypoint.title}”.`, waypoint, appliedAt),
        );
        break;
      }
      // A proposal of a new map shows on Wayfinding's Proposals, not as a line.
      case "revise_spec":
      case "rewrite_tickets":
      case "propose_map":
        break;
    }
  }
  return lines;
}

/** True when a run was started by a hatch message's note (S7b-13). */
function fromNote(input: MapActivityInput, runId: string): boolean {
  return runOf(input, runId).hatchMessageId !== null;
}

/**
 * A completed map-scope re-clear that wrote no revision: every spec was approved and stands (S7b-8),
 * as the demo's "nothing to change" line. Only after the map's first revision: before it, a run
 * that wrote none named only waits (S8b-5), and its wait lines say so (the demo's waiting map).
 */
function unchangedLines(input: MapActivityInput): ActivityLine[] {
  const writers = new Set(
    input.specs.flatMap((spec) => spec.revisions.map((revision) => revision.writtenByRun)),
  );
  const firstWriter = input.planningRuns.findIndex((run) => writers.has(run.id));
  return input.planningRuns
    .filter(
      (run, index) =>
        run.purpose === "to_spec" &&
        run.specificationId === null &&
        run.state === "completed" &&
        !writers.has(run.id) &&
        firstWriter !== -1 &&
        index > firstWriter,
    )
    .map((run) =>
      line("spec", "Specs checked against your decisions: nothing to change.", endOf(run)),
    );
}

/** The person's reason as the end of a sentence, without doubling its final stop. */
function sentence(reason: string): string {
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** The lines of a revision's planning reviews (D13): passed, repairing, or sent to Wayfinding. */
function reviewLines(input: MapActivityInput, revision: ActivityRevision): ActivityLine[] {
  return revision.reviews.flatMap((review) => reviewLine(input, revision.title, review));
}

function reviewLine(
  input: MapActivityInput,
  title: string,
  review: ActivityReview,
): ActivityLine[] {
  switch (review.outcome) {
    case "passed":
      return [line("spec", `Planning review passed: “${title}”.`, review.at)];
    case "findings": {
      const found = `Planning review found ${plural(review.findings, "problem")} in “${title}”.`;
      const fixes = ` A repair fixes ${review.findings === 1 ? "it" : "them"}.`;
      return [line("spec", review.repairing ? `${found}${fixes}` : found, review.at)];
    }
    case "escalated":
      return review.waypoints.map((number) => {
        const waypoint = input.waypoints.find((candidate) => candidate.number === number);
        if (waypoint === undefined) {
          throw new Error(`An escalated finding opened waypoint ${String(number)}, not on the map`);
        }
        return {
          stage: "spec",
          text: `Planning review of “${title}” sent a decision to Wayfinding: “${waypoint.title}”.`,
          waypoint: number,
          spec: null,
          specLabel: null,
          at: review.at,
        };
      });
  }
}

/**
 * The line of a ticket set version's tickets review (slice 7c D10): passed, found problems a
 * rewrite fixes, or needs you when held. Each carries the spec's number on Tickets, which
 * the activity column renders as "Open the tickets" to the spec's Tickets page (L169).
 */
function ticketsReviewLines(
  spec: number,
  title: string,
  review: ActivityTicketsReview | null,
): ActivityLine[] {
  if (review === null) {
    return [];
  }
  const opens = (text: string): ActivityLine => ({
    ...line("tickets", text, review.at),
    spec,
    specLabel: "Open the tickets",
  });
  if (review.outcome === "passed") {
    return [opens(`Tickets review passed: “${title}”.`)];
  }
  return [
    opens(
      review.held
        ? `Tickets review: “${title}” needs you.`
        : `Tickets review found ${plural(review.findings, "problem")} in “${title}”. A rewrite fixes it.`,
    ),
  ];
}

/**
 * The Spec and Tickets lines (D13, 6b D11 style: no revision numbers or ids): each spec
 * written or revised, its review outcome, its approval and rejection; each ticket set version
 * written, its approval and its rejections; every line names the spec.
 */
function specLines(input: MapActivityInput): ActivityLine[] {
  return input.specs.flatMap((spec) => {
    // One "which an earlier map delivered" line per spec (L138): its first such revision here.
    const laterMap = spec.revisions.find(
      (revision) => revision.laterMapOfDelivered && !fromNote(input, revision.writtenByRun),
    );
    const written = (revision: ActivityRevision): ActivityLine => {
      const { title } = revision;
      // A note's revision opens the spec ("Open the revision", the demo's `writeRevision`, L159 (a)).
      if (!revision.first && fromNote(input, revision.writtenByRun)) {
        return {
          ...line("spec", `Spec revised from your note: “${title}”.`, revision.writtenAt),
          spec: spec.number,
          specLabel: "Open the revision",
        };
      }
      if (revision === laterMap) {
        return {
          ...line(
            "spec",
            `Spec revised: “${title}”, which an earlier map delivered.`,
            revision.writtenAt,
          ),
          spec: spec.number,
          specLabel: "See what the revision changes",
        };
      }
      return line(
        "spec",
        revision.first ? `Spec written: “${title}”.` : `Spec revised: “${title}”.`,
        revision.writtenAt,
      );
    };
    const lines = spec.revisions.flatMap((revision) => {
      const { title } = revision;
      const own: ActivityLine[] = [written(revision), ...reviewLines(input, revision)];
      if (revision.approvedAt !== null) {
        own.push(line("spec", `Approved: “${title}”.`, revision.approvedAt));
      }
      if (revision.rejection !== null) {
        own.push(
          line(
            "spec",
            `You rejected “${title}”: ${sentence(revision.rejection.reason)}`,
            revision.rejection.at,
          ),
        );
      }
      return own;
    });
    for (const set of spec.ticketSets) {
      const { title } = set;
      const checking = checkingAt(input, spec.id, set);
      if (checking !== null) {
        lines.push(line("tickets", "Checking the revision against what was delivered.", checking));
      }
      for (const [index, version] of set.versions.entries()) {
        const count = plural(version.tickets, "ticket");
        lines.push(
          line(
            "tickets",
            index === 0
              ? set.follows
                ? compared(set.revision, version)
                : `Tickets written for “${title}”: ${count}.`
              : fromNote(input, version.writtenByRun)
                ? `Tickets rewritten from your note for “${title}”: ${count}.`
                : `Tickets rewritten for “${title}”: ${count}.`,
            version.writtenAt,
          ),
        );
      }
      lines.push(
        ...set.versions.flatMap((version) =>
          ticketsReviewLines(spec.number, title, version.review),
        ),
      );
      for (const rejection of set.rejections) {
        lines.push(
          line(
            "tickets",
            `You rejected the tickets for “${title}”: ${sentence(rejection.reason)}`,
            rejection.at,
          ),
        );
      }
      if (set.approvedAt !== null) {
        const current = set.versions.at(-1);
        if (current === undefined) {
          throw new Error(`The approved ticket set of spec ${String(spec.number)} has no version`);
        }
        lines.push(
          line(
            "tickets",
            current.tickets === 0
              ? `Approved: the reconciliation of “${title}”. Nothing to deliver.`
              : `Approved: the ticket set for “${title}”.`,
            set.approvedAt,
          ),
        );
      }
    }
    return lines;
  });
}

/**
 * The first version of a set whose revision follows an approved one (F2, the demo's `store.tsx`
 * line): the revision's dispositions tallied, and the new tickets written for the work.
 */
function compared(revision: number, version: ActivityTicketSet["versions"][number]): string {
  const count = (kind: Disposition["kind"]) =>
    version.dispositions.filter((disposition) => disposition === kind).length;
  const tally = (
    [
      [count("work"), "need work"],
      [count("delivered"), "carry over"],
      [count("retained"), "retained"],
      [count("satisfied"), "already done"],
      [count("removed"), "removed"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${String(n)} ${label}`)
    .join(" · ");
  const work =
    version.tickets === 0
      ? "No new ticket is needed"
      : `${plural(version.tickets, "new ticket")} written for the work`;
  const carried = count("delivered") > 0 ? "; what carries over is already in the code" : "";
  return `Revision ${String(revision)} compared with what was delivered: ${tally}. ${work}${carried}. Tickets review running.`;
}

/**
 * When a revision following an approved one started its first `to_tickets` (slice 8b D14, the demo's
 * approval line, `store.tsx` 739): its tickets are checked against what was delivered. Null for
 * the spec's first approved revision.
 */
function checkingAt(
  input: MapActivityInput,
  specificationId: string,
  set: ActivityTicketSet,
): string | null {
  if (!set.follows) {
    return null;
  }
  const approved = Date.parse(set.revisionApprovedAt);
  const first = input.planningRuns.find(
    (run) =>
      run.purpose === "to_tickets" &&
      run.specificationId === specificationId &&
      run.retryOfRunId === null &&
      Date.parse(run.startedAt) >= approved,
  );
  if (first === undefined) {
    // `to_tickets` starts in the transaction approving the revision (D6).
    throw new Error(`Approved revision of spec ${specificationId} has no to_tickets`);
  }
  return first.startedAt;
}

/**
 * A wait's sentence by the hold it was recorded under, X the spec and H the holding map (slice 8b
 * D16, the "Wait line" row).
 */
export const WAIT_LINES: Record<SpecHoldKind, (spec: string, holder: string) => string> = {
  revision: (spec, holder) =>
    `Waiting on “${spec}”: “${holder}” holds its unapproved revision. The change from this map is written as the next revision once that one is approved and its tickets are written.`,
  revising: (spec, holder) =>
    `Waiting on “${spec}”: “${holder}” is writing its next revision. The change from this map is written as the next revision once that work ends.`,
  tickets: (spec, holder) =>
    `Waiting on “${spec}”: “${holder}” is writing or reviewing its tickets. The change from this map is written as the next revision once that work ends.`,
  delivering: (spec, holder) =>
    `Waiting on “${spec}”: a delivery run of it is active on “${holder}”. The change from this map is written as the next revision once the run ends.`,
};

/**
 * Each wait's lines (slice 8b D14): recorded at `since` ("See what waits", by its stored hold), and
 * released at `releasedAt` ("Open the revision"; D16, naming no approval, deviation 9).
 */
function waitLines(input: MapActivityInput): ActivityLine[] {
  return input.waits.flatMap((wait) => {
    const lines: ActivityLine[] = [
      {
        ...line("spec", WAIT_LINES[wait.holdKind](wait.specTitle, wait.holdMapTitle), wait.since),
        spec: wait.specNumber,
        specLabel: "See what waits",
      },
    ];
    if (wait.releasedAt !== null) {
      lines.push({
        ...line(
          "spec",
          `“${wait.specTitle}” is no longer held. The change this map was waiting with is being written as the next revision.`,
          wait.releasedAt,
        ),
        spec: wait.specNumber,
        specLabel: "Open the revision",
      });
    }
    return lines;
  });
}

/**
 * A spec's delivery run lines (slice 8 D13, the demo's `store.tsx`): its start or start again from
 * clean, its end (the passed line opens the run on the spec's Delivery page), and its merge. They
 * are derived from the run row, never from its activity lines (S8-9).
 */
function runLines(spec: number, title: string, run: ActivityRun, first: boolean): ActivityLine[] {
  const lines = [
    line(
      "delivery",
      // The map's first run of the spec starts delivery, whatever its number on the spec (F1, the
      // demo's `runsOn(spec, map).length === 0`): an earlier map may have run the spec before.
      first
        ? `Delivery started: “${title}”.`
        : `Run ${String(run.number)} of “${title}” started again from clean.`,
      run.startedAt,
    ),
  ];
  const outcome = deliveryOutcome(run);
  if (outcome === "active") {
    return lines;
  }
  if (run.endedAt === null) {
    throw new Error("An ended delivery run has no end time");
  }
  const at = run.endedAt;
  const of = `${runName(run, true)} of “${title}”`;
  switch (outcome) {
    case "passed":
      lines.push({ ...line("delivery", `${of} passed.`, at), spec, specLabel: "Open the run" });
      break;
    case "blocked":
      lines.push(line("delivery", `${of} was blocked by the review.`, at));
      break;
    case "failed":
      lines.push(line("delivery", `${of} failed.`, at));
      break;
    case "cancelled":
      lines.push(line("delivery", `${of} cancelled.`, at));
      break;
  }
  if (run.mergedAt !== null) {
    lines.push(
      line(
        "delivery",
        `Merged into ${run.baseBranch}: “${title}” is recorded as delivered.`,
        run.mergedAt,
      ),
    );
  }
  return lines;
}

/** Every spec's delivery run lines (slice 8 D13). */
function deliveryLines(input: MapActivityInput): ActivityLine[] {
  return input.specs.flatMap(({ number, ticketSets }) => {
    const firstRun = Math.min(...ticketSets.flatMap((set) => set.runs.map((run) => run.number)));
    return ticketSets.flatMap((set) =>
      set.runs.flatMap((run) => runLines(number, set.title, run, run.number === firstRun)),
    );
  });
}

/**
 * The map's activity (slice 6a spec D11, slice 5 spec D9), derived from runs, rounds and stored timestamps and never stored: each line with
 * its stage and time, oldest first (newest last). No line names a skill, criterion id or
 * revision number.
 */
export function mapActivity(input: MapActivityInput): ActivityLine[] {
  const lines: ActivityLine[] = [
    line("idea", "Map started from your idea.", input.map.createdAt),
    ...wayfindingLines(input),
  ];
  lines.push(
    ...hatchLines(input),
    ...specLines(input),
    ...waitLines(input),
    ...unchangedLines(input),
    ...deliveryLines(input),
  );
  // A stable sort: lines stored at the same instant keep the order they happen in.
  return lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
