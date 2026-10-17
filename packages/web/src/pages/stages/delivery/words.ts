import type {
  ActiveRun,
  CancelDeliveryError,
  CheckPullRequestError,
  CheckResult,
  DeliveryFailure,
  DeliveryRun,
  MapNotFoundError,
  MarkMergedError,
  Project,
  PullRequestState,
  SpecRun,
  StartDeliveryBlocker,
  StartDeliveryError,
} from "@zenorm/contracts";
import type { AccessDeniedError } from "@zenorm/contracts";
import { accessDeniedSentence } from "@/lib/access";

/** The Delivery stage's sentences, each chosen by a code or a state (spec D8; ledger L100). */

/**
 * `project_checks_missing`'s words in a start refusal (slice 8 D7), where no link follows; a card
 * or alert that links Project settings says only the fact (`blockerSentence`, UX audit A2).
 */
const CHECKS_MISSING = "The project has no required checks. Set them in project settings.";
const CHECKS_MISSING_FACT = "The project has no required checks.";

/** `project_repair_limit_missing`'s words, in a start refusal and as a blocker's fact. */
const REPAIR_LIMIT_MISSING = "The project has no repair limit. Set one in project settings.";
const REPAIR_LIMIT_MISSING_FACT = "The project has no repair limit.";

/** `delivery_in_progress`'s words (slice 8 D7, ruling 5), naming the active run's spec. */
function activeRunSentence(activeRun: ActiveRun): string {
  return `“${activeRun.specTitle}” already has an active run in this project.`;
}

export function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

export function mapNotFoundMessage(error: MapNotFoundError): string {
  return `There is no map ${error.data.mapId}.`;
}

/** The sentence shown for a `delivery.start` refusal, chosen by its code. */
export function startRefusalMessage(error: StartDeliveryError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "ticket_set_not_found":
      return "This ticket set no longer exists.";
    case "ticket_set_not_approved":
      return "This ticket set is not approved.";
    case "delivery_nothing_to_deliver":
      return "This ticket set has no tickets, so there is nothing to deliver.";
    case "delivery_already_passed":
      return "This ticket set already has a run ready to merge.";
    case "project_folder_missing":
      return `There is no folder at ${error.data.folderPath}; the project's repository has moved or been deleted.`;
    case "project_branch_missing":
      return "The project's base branch has no commit.";
    case "project_checks_missing":
      return CHECKS_MISSING;
    case "project_repair_limit_missing":
      return REPAIR_LIMIT_MISSING;
    case "delivery_in_progress":
      return activeRunSentence(error.data);
    case "delivery_branch_exists":
      return `The branch ${error.data.branch} already exists in the project's repository.`;
    case "delivery_not_admitted":
      // The refusing admission wrapper's own sentence (S9-17).
      return error.data.reason;
  }
}

/** The sentence shown for a `delivery.cancel` refusal, chosen by its code. */
export function cancelRefusalMessage(error: CancelDeliveryError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "delivery_run_not_found":
      return "This delivery run no longer exists.";
    case "delivery_run_ended":
      return "This delivery run had already ended.";
  }
}

/**
 * Why Start delivery is unavailable, one sentence per blocker (spec D3, D6, D8): the one source
 * for the project page's alert and the next-action card, both of which link Project settings
 * beside the checks sentence.
 */
export function blockerSentence(blocker: StartDeliveryBlocker, project: Project): string {
  switch (blocker) {
    case "project_folder_missing":
      return `The project's folder is missing: there is nothing at ${project.folderPath}.`;
    case "project_branch_missing":
      return `The base branch ${project.baseBranch} has no commit yet.`;
    case "project_checks_missing":
      return CHECKS_MISSING_FACT;
    case "project_repair_limit_missing":
      return REPAIR_LIMIT_MISSING_FACT;
    case "delivery_in_progress":
      if (project.activeRun === null) {
        throw new Error(`Project ${project.id} is blocked by an active run it does not have`);
      }
      return activeRunSentence(project.activeRun);
  }
}

/**
 * What a running run is doing and how far it has got (D9, the demo's `runProgress`): from its
 * stored phase, its merged tickets and its stored check results, as core words the stage line.
 */
export function runProgress(run: SpecRun): { doing: string; progress: string } {
  switch (run.phase) {
    case "preparing":
      return { doing: "Preparing the run", progress: "creating the branch" };
    case "implementing": {
      // Back in implementing for a repair attempt (C3): the attempt, not the tickets.
      if (run.repairAttempts !== null && run.repairAttempts > 0 && run.repairLimit !== null) {
        const failing = required(run.checkResults, "check results", run).filter(
          (result) => checkOutcome(result) !== "passed",
        ).length;
        return {
          doing: `Repairing ${plural(failing, "failing check")}`,
          progress: `attempt ${String(run.repairAttempts)} of ${String(run.repairLimit)}`,
        };
      }
      const tickets = required(run.tickets, "ticket rows", run);
      const merged = tickets.filter((ticket) => ticket.status.state === "merged").length;
      return {
        doing: `Implementing ${plural(tickets.length, "ticket")}`,
        progress: `${String(merged)} of ${plural(tickets.length, "ticket")} implemented`,
      };
    }
    case "verifying": {
      const passed =
        run.checkResults === null
          ? 0
          : run.checkResults.filter((result) => checkOutcome(result) === "passed").length;
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

/** An ended run's headline (the demo's `endedHeadline`); a merged run is delivered. */
export function endedHeadline(run: DeliveryRun): string {
  switch (run.state) {
    case "passed":
      if (run.mergedAt !== null) {
        return "Delivered and merged";
      }
      return run.pullRequest === null
        ? "Passed: a verified branch, ready to merge"
        : "Passed: a pull request, ready to merge on GitHub";
    case "blocked":
      return "Blocked by the independent review";
    case "failed":
      return "The run failed";
    case "cancelled":
      return "Cancelled";
    case "running":
    case "interrupted":
      throw new Error(`Run ${String(run.number)} is ${run.state}; it has not ended`);
  }
}

/**
 * A failed run's one sentence (UX audit P1-1): the first line of its stored failure message, as
 * core's `deliveryFailureWords` reads it for the next action's detail (the web cannot import
 * core). The agent's messages carry a stderr tail after that line, which `failureDetail` keeps for
 * the run's head to show on request.
 */
export function failureSentence(failure: DeliveryFailure): string {
  const [first] = failure.message.split("\n");
  if (first === undefined || first.trim() === "") {
    throw new Error(`A ${failure.code} failure has an empty message`);
  }
  return first.trim();
}

/** The rest of a failed run's message after its sentence, or null when the sentence is all of it. */
export function failureDetail(failure: DeliveryFailure): string | null {
  const rest = failure.message.split("\n").slice(1).join("\n").trim();
  return rest === "" ? null : rest;
}

/** The sentence shown beside Mark merged for a `delivery.markMerged` refusal, chosen by its code. */
export function markMergedRefusalMessage(error: MarkMergedError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "delivery_run_not_found":
      return "This delivery run no longer exists.";
    case "delivery_not_passed":
      return "This delivery run did not pass, so there is nothing to mark merged.";
    case "delivery_already_merged":
      return "This delivery run is already recorded as merged.";
    case "project_folder_missing":
      return `There is no folder at ${error.data.folderPath}; the project's repository has moved or been deleted.`;
    case "delivery_not_merged":
      return `${error.data.finalCommit.slice(0, 7)} is not in the project folder's ${error.data.baseBranch} yet. Merge the branch there, or pull ${error.data.baseBranch} if you merged it elsewhere (a squash or rebase merge leaves it out), then mark it merged.`;
    case "delivery_branch_missing":
      return `git could not find ${error.data.baseBranch} or ${error.data.finalCommit.slice(0, 7)} in the project's repository.`;
  }
}

/** The sentence shown beside Check now for a `delivery.checkPullRequest` refusal, by its code (C4). */
export function checkPullRequestRefusalMessage(
  error: CheckPullRequestError | AccessDeniedError,
): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "delivery_run_not_found":
      return "This delivery run no longer exists.";
    case "delivery_no_pull_request":
      return "This delivery run opened no pull request, so there is nothing to check.";
    case "delivery_gh_missing":
      return "The GitHub CLI gh cannot run on the server. Install it and sign in with gh auth login.";
    case "delivery_github_not_signed_in":
      return "gh is not signed in to github.com on the server. Run gh auth login, then check again.";
    case "delivery_github_unreachable":
      return "ZeNorm could not reach GitHub to read the pull request. Check again later.";
  }
}

/** The word a pull request's state shows as on Delivery (C5). */
export function pullRequestStateWord(state: PullRequestState): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "merged":
      return "merged";
  }
}

/** A run's state as its badge in the runs list reads; a merged run reads merged. */
export function stateWord(run: DeliveryRun): string {
  if (run.mergedAt !== null) {
    return "merged";
  }
  switch (run.state) {
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "passed":
      return "passed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export type CheckOutcome = "passed" | "failed" | "timed out";

export function checkOutcome(result: CheckResult): CheckOutcome {
  if (result.timedOut) {
    return "timed out";
  }
  return result.exitCode === 0 ? "passed" : "failed";
}

/** A field the run's state guarantees is set; a null here is a programmer error. */
export function required<T>(value: T | null, what: string, run: DeliveryRun): T {
  if (value === null) {
    throw new Error(`Run ${String(run.number)} is ${run.state} but has no ${what}`);
  }
  return value;
}
