import { LOCAL_EXECUTOR } from "@zenorm/contracts";
import type { DeliveryPhase, DeliveryRun, SpecRun } from "@zenorm/contracts";

import { checkOutcome, plural } from "@/pages/stages/delivery/words";

/** The four steps ZeNorm runs, in order; the fifth, Merge, is the person's. */
export const RUN_STEPS = ["prepare", "implement", "verify", "review"] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** How a step stands in a run (slice 8 D9). */
export type StepMark = "done" | "working" | "stopped" | "not-reached";

/**
 * How the Merge step stands: done once merged, the person's once the run passes, working while
 * ZeNorm opens the pull request and stopped when the run ended or was interrupted there (5.4).
 */
export type MergeMark = "done" | "yours" | "working" | "stopped" | "not-reached";

/**
 * The step each stored phase is in: `publishing`, ZeNorm opening the pull request, is the Merge
 * step's, so no step is added beside the four ZeNorm runs and Merge (5.4).
 */
const PHASE_STEP: Record<DeliveryPhase, RunStep | "merge"> = {
  preparing: "prepare",
  implementing: "implement",
  verifying: "verify",
  reviewing: "review",
  publishing: "merge",
};

/** The index of the step a phase is in, Merge after the four ZeNorm runs. */
function phaseIndex(phase: DeliveryPhase): number {
  const step = PHASE_STEP[phase];
  return step === "merge" ? RUN_STEPS.length : RUN_STEPS.indexOf(step);
}

/**
 * Each of ZeNorm's steps marked from the run's stored phase (slice 8 D9): a passed run (merged or
 * not) has every step done; otherwise the phase's step is working while the run runs and stopped
 * once it ended or was interrupted, earlier steps are done and later ones not reached. A run in
 * `publishing` has passed every one of the four.
 */
export function stepMark(run: DeliveryRun, step: RunStep): StepMark {
  if (run.state === "passed") {
    return "done";
  }
  const at = phaseIndex(run.phase);
  const index = RUN_STEPS.indexOf(step);
  if (index < at) {
    return "done";
  }
  if (index > at) {
    return "not-reached";
  }
  return run.state === "running" ? "working" : "stopped";
}

/** A repair attempt a run is making (C3): its number, the run's pinned limit and the failing checks. */
export interface RepairAttempt {
  readonly attempt: number;
  readonly limit: number;
  /** The checks that did not pass in the check pass the attempt repairs. */
  readonly failing: number;
}

/**
 * The repair attempt the run is in, or null: a run is repairing while it is back in `implementing`
 * with an attempt counted. The failing checks are those of the stored check pass, which the next
 * pass replaces. A run from before repairs (no pinned limit) never is.
 */
export function repairAttempt(run: DeliveryRun): RepairAttempt | null {
  const { repairAttempts, repairLimit } = run;
  if (
    run.phase !== "implementing" ||
    repairAttempts === null ||
    repairAttempts === 0 ||
    repairLimit === null
  ) {
    return null;
  }
  if (run.checkResults === null) {
    throw new Error(`Run ${String(run.number)} repairs failing checks it has no results of`);
  }
  const failing = run.checkResults.filter((result) => checkOutcome(result) !== "passed").length;
  return { attempt: repairAttempts, limit: repairLimit, failing };
}

/** The Implement step's line while a repair attempt runs: "Repairing 2 failing checks, attempt 1 of 3". */
export function repairLine({ attempt, limit, failing }: RepairAttempt): string {
  return `Repairing ${plural(failing, "failing check")}, attempt ${String(attempt)} of ${String(limit)}.`;
}

/**
 * The Verify line of a run that made repair attempts (C3): "All checks passed after 2 repair
 * attempts" once its checks passed, "Still failing after 3 of 3 repair attempts" once it failed
 * on its checks with its limit spent; null for a run that made none, which keeps today's line.
 */
export function repairedVerifyLine(run: DeliveryRun, passed: boolean): string | null {
  const { repairAttempts, repairLimit } = run;
  if (repairAttempts === null || repairLimit === null || repairAttempts === 0) {
    return null;
  }
  return passed
    ? `All checks passed after ${plural(repairAttempts, "repair attempt")}.`
    : `Still failing after ${String(repairAttempts)} of ${plural(repairLimit, "repair attempt")}.`;
}

/**
 * The Merge step's mark: done once merged; the person's once the run passed; while the run is in
 * `publishing`, working as it runs and stopped once it failed, was cancelled or was interrupted.
 */
export function mergeMark(run: DeliveryRun): MergeMark {
  if (run.mergedAt !== null) {
    return "done";
  }
  if (run.state === "passed") {
    return "yours";
  }
  if (run.phase !== "publishing") {
    return "not-reached";
  }
  return run.state === "running" ? "working" : "stopped";
}

/** How the agent's own review and checks stand, the last row of the Implement step. */
export type ClosingMark = "waiting" | "running" | "done" | "stopped";

/**
 * The agent's review and checks (the implement-spec skill's closing steps): once every ticket is
 * merged, the local orchestrator reviews its branch and runs the checks itself before it ends,
 * while the run stays in `implementing`. Waiting while tickets remain, running once every ticket
 * is merged, done once the run is past Implement, and stopped when the run ended in it with every
 * ticket merged. Null when there is no row: another executor's session, a run from before `0010`
 * (no ticket rows), or a run that ended before every ticket was merged.
 */
export function closingMark(run: SpecRun): ClosingMark | null {
  if (run.executor !== LOCAL_EXECUTOR || run.tickets === null) {
    return null;
  }
  if (run.state === "passed" || phaseIndex(run.phase) > RUN_STEPS.indexOf("implement")) {
    return "done";
  }
  const merged = run.tickets.every((ticket) => ticket.status.state === "merged");
  if (run.state === "running") {
    return merged && run.phase === "implementing" ? "running" : "waiting";
  }
  return merged && run.phase === "implementing" ? "stopped" : null;
}
