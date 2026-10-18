import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DELIVERY_SCREENS_MAX_COUNT,
  err,
  gitIdentityEnv,
  LOCAL_EXECUTOR,
  ok,
  PULL_REQUEST_FOOTER,
} from "@zenorm/contracts";
import type {
  Actor,
  CaptureFailureCode,
  CaptureScreens,
  CheckoutError,
  CheckResult,
  CodedError,
  DeliveryAgentError,
  DeliveryFailureCode,
  DeliveryPhase,
  ImplementEvent,
  ImplementRequest,
  ImplementTicketSet,
  PickedScreen,
  PickedScreens,
  PickScreens,
  PullRequest,
  PullRequestCapture,
  PullRequestRequest,
  Result,
  ResumedFrom,
  ReviewDelivery,
  RunActor,
  Verdict,
  WritePullRequest,
} from "@zenorm/contracts";
import {
  acceptVerdict,
  appendRunEvent,
  CHECK_KILL_GRACE_MS,
  checkGitHubSignIn,
  checkLogPath,
  checkPassed,
  checkVerdictCriteria,
  cleanUpDelivery,
  countRepairAttempt,
  deliveryIdentities,
  deliveryIdentity,
  endDelivery,
  getDeliveryRun,
  githubOrigin,
  openPullRequest,
  prAssetSource,
  prepareDelivery,
  prepareReview,
  pushRunBranch,
  pushScreenshots,
  readRunTicketRows,
  recordTicketMerged,
  recordTicketStarted,
  runAppSetup,
  runChecksReporting,
  seamsOf,
  setDeliveryPhase,
  startApp,
  storeCheckResults,
  ticketBranchName,
  verifyDelivery,
  verifyTicketMerges,
} from "@zenorm/core";
import type { DeliveryEnd, GitHubRepository, StoredDeliveryRun } from "@zenorm/core";
import { projects } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

import type { Log } from "./app.ts";

/**
 * How long `stop` awaits the executor after aborting `signal`: `"local"`'s 10 s SIGKILL grace plus
 * margin. Past it the run stays `running` for the startup sweep.
 */
export const EXECUTOR_STOP_BOUND_MS = 15_000;

export interface DeliveryRunnerOptions {
  readonly db: ZeNormDatabase;
  /** The executor's name (`delivery.executor`), for the stop bound's log line. */
  readonly executorName: string;
  readonly implementTicketSet: ImplementTicketSet;
  readonly reviewDelivery: ReviewDelivery;
  /** Writes the body of a passing run's pull request on a GitHub project. */
  readonly writePullRequest: WritePullRequest;
  /**
   * Lists the screens a passing run's change makes look different, before its pull request is
   * written, on a run that pinned an app start command and URL.
   */
  readonly pickScreens: PickScreens;
  /** Screenshots the picked screens in the app the runner started from the run worktree. */
  readonly captureScreens: CaptureScreens;
  /** Each check's bound, and each app setup command's. */
  readonly checkTimeoutMinutes: number;
  /** Where a started app's session record is kept until its process group is stopped. */
  readonly sessionsDir: string;
  /** How long the runner waits for a started app's URL to answer (`APP_READY_TIMEOUT_MS`). */
  readonly appReadyTimeoutMs: number;
  /**
   * Called after each landed end write: the end may have started planning work on any map (a
   * release run), which the planning runner launches.
   */
  readonly onEnd: () => void;
  readonly log: Log;
}

/**
 * Drives delivery runs in the background, never inside a request. It stores the run's phase at each
 * transition, the orchestrator's events as ticket records and lines, and ZeNorm's and the
 * reviewer's own lines; after every end it cleans the run up. It holds, in memory only, the abort
 * controller; after a restart an active run is held by no runner and reads as `interrupted`.
 */
export interface DeliveryRunner {
  /**
   * Holds the started run (stored in `preparing`) and starts its driver without awaiting it.
   * `folder` is the one `startDelivery` resolved through the checkout seam: the run's worktree,
   * merge records, verification and cleanup all work in it.
   */
  launch(run: StoredDeliveryRun, folder: string): void;
  /** Whether this runner holds the run. */
  held(runId: string): boolean;
  /**
   * Called once the cancel's end write has landed: writes ZeNorm's cancel line (not on a run
   * from before `0010`). A held run is aborted and cleaned up once the abort settles, or, when the
   * executor has not settled `EXECUTOR_STOP_BOUND_MS` after the abort, logged, cleaned up and no
   * longer held, its later events ignored. A run this runner does not hold (an interrupted run) is
   * cleaned up before this resolves.
   */
  cancelled(runId: string): Promise<void>;
  /**
   * ZeNorm is shutting down: aborts every held run that is not already cancelled, killing its
   * session, and resolves once each driver has settled, so the database can close after the last
   * write. A stopped run keeps no end and no cleanup: after the restart it reads `interrupted`, and
   * its Cancel cleans it up. A run started after this is not driven. A driver still unsettled
   * `EXECUTOR_STOP_BOUND_MS` after the abort is logged and left.
   */
  stop(): Promise<void>;
}

interface HeldRun {
  /** What the runner's writes on the run are made as: the run, with its User. */
  readonly actor: Actor;
  phase: DeliveryPhase;
  readonly controller: AbortController;
  /** True once this runner's own end write landed (not a cancel's). */
  ended: boolean;
  /** True when the abort came from `stop`, not from a cancel. */
  stopped: boolean;
  /**
   * True once a cancel's bound passed with the driver unsettled: the run was cleaned up and let go,
   * and whatever its executor still does is ignored.
   */
  abandoned: boolean;
  /** The run as it was launched. */
  readonly run: StoredDeliveryRun;
  /** The folder the run's start resolved through the checkout seam. */
  readonly folder: string;
}

/** What is known of a run's outcome so far; a failure stores it with its code. */
interface Evidence {
  finalCommit: string | null;
  checkResults: CheckResult[] | null;
}

const MS_PER_MINUTE = 60_000;

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What a cancel stopped, by the phase the run was in. `"local"`'s sessions are sent SIGTERM;
 * another executor is told through `signal`, however it stops. The checks run here.
 */
function cancelLine(phase: DeliveryPhase, executor: string): string {
  const local = executor === LOCAL_EXECUTOR;
  switch (phase) {
    case "preparing":
      return "You cancelled the run while its worktree was being prepared.";
    case "implementing":
      return local
        ? "You cancelled the run. The executor was sent SIGTERM."
        : "You cancelled the run. The executor was told to stop.";
    case "verifying":
      return "You cancelled the run. A running check was sent SIGTERM.";
    case "reviewing":
      return local
        ? "You cancelled the run. The reviewer was sent SIGTERM."
        : "You cancelled the run. The reviewer was told to stop.";
    case "publishing":
      // Whatever was pushed or opened stays: ZeNorm never deletes a branch or closes a pull
      // request.
      return "You cancelled the run while ZeNorm was opening its pull request. Anything already pushed or opened stays on GitHub.";
  }
}

/** ZeNorm's line naming what the implementing step starts: the run's executor. */
function startingExecutor(executor: string): string {
  return executor === LOCAL_EXECUTOR
    ? "Starting Claude Code."
    : `Starting the executor "${executor}".`;
}

/** ZeNorm's line naming what the run it resumes left to fix, which the executor is given first. */
function resumedFromLine(resumedFrom: ResumedFrom): string {
  const left = [
    ...(resumedFrom.failure === null ? [] : ["why it failed"]),
    ...(resumedFrom.failedChecks.length === 0
      ? []
      : [`the output of ${plural(resumedFrom.failedChecks.length, "failed check")}`]),
    ...(resumedFrom.blockingFindings.length === 0
      ? []
      : [plural(resumedFrom.blockingFindings.length, "blocking finding")]),
  ];
  return `The executor is given what run ${String(resumedFrom.number)} left to fix: ${left.join(", ")}.`;
}

/** ZeNorm's line for a check that finished. */
function checkLine(result: CheckResult): string {
  const command = `\`${result.command}\``;
  if (checkPassed(result)) {
    return `${command} passed.`;
  }
  if (result.timedOut) {
    return `${command} timed out.`;
  }
  if (result.exitCode === null) {
    return `${command} was stopped.`;
  }
  return `${command} failed with exit ${String(result.exitCode)}.`;
}

/** The reviewer's verdict line. */
function verdictLine(verdict: Verdict): string {
  const blocking = verdict.findings.filter((finding) => finding.severity === "blocking").length;
  return blocking > 0
    ? `Verdict: blocked. ${plural(blocking, "blocking finding")}.`
    : "Verdict: passed. No blocking findings.";
}

/** Where the runner writes a pull request's body for gh's `--body-file`, in the run folder. */
const PULL_REQUEST_BODY_FILE = "pull-request.md";

/** The run folder's folder the capture writes its screenshots to. */
const SCREENSHOTS_DIR = "screenshots";

/** The scratch index the screenshots' commit is built in, in the run folder. */
const PR_ASSETS_INDEX_FILE = "pr-assets.index";

/** What the publishing step returns once a cancel stopped it during the capture; nothing stores it. */
const CAPTURE_CANCELLED: DeliveryAgentError = {
  code: "agent_cancelled",
  message: "The run was cancelled while ZeNorm was taking its screenshots.",
  data: {},
};

/** ZeNorm's line for the screen picker's answer: no visible change, or the screens it picked. */
function pickedLine(picked: PickedScreens): string {
  switch (picked.kind) {
    case "no_visible_change":
      return "The screen picker found no visible change, so the pull request has no screenshots and nothing was installed or started.";
    case "screens":
      return `The screen picker picked ${plural(picked.screens.length, "changed screen")}: ${picked.screens
        .map((screen) => `${screen.where}${screen.isNew ? " (new)" : ""}`)
        .join(", ")}.`;
  }
}

/**
 * ZeNorm's line when a run without screenshots changed something visible: where to turn them on.
 */
const CAPTURE_SETUP_HINT =
  "This change is visible in the app. Save an app start command and its URL in Project settings to show screenshots of the changed screens in pull requests.";

/** Whether a verdict passes: no blocking finding. */
function passes(verdict: Verdict): boolean {
  return !verdict.findings.some((finding) => finding.severity === "blocking");
}

/**
 * Cleans up an ended run in `checkedOut`, its project folder, and writes ZeNorm's cleanup line when
 * every step worked (core writes a line per failed step). A run from before `0010` gets neither.
 */
async function cleanUp(
  actor: Actor,
  db: ZeNormDatabase,
  run: { id: string; branch: string },
  checkedOut: Result<string, CheckoutError>,
): Promise<void> {
  const cleanup = await cleanUpDelivery(actor, db, run.id, checkedOut);
  if (cleanup.cleaned && cleanup.failures.length === 0) {
    appendRunEvent(actor, db, {
      runId: run.id,
      who: "zenorm",
      ticket: null,
      text: `The worktrees were deleted. The branch ${run.branch} is kept.`,
    });
  }
}

/** What the runner and its cleanup write as on a run: the run, with its User. */
function deliveryRunActor(run: StoredDeliveryRun): Actor {
  return { kind: "delivery_run", runId: run.id, userId: run.userId };
}

export function createDeliveryRunner({
  db,
  executorName,
  implementTicketSet,
  reviewDelivery,
  writePullRequest,
  pickScreens,
  captureScreens,
  checkTimeoutMinutes,
  sessionsDir,
  appReadyTimeoutMs,
  onEnd,
  log,
}: DeliveryRunnerOptions): DeliveryRunner {
  const held = new Map<string, HeldRun>();
  /** Each held run's driver, settled once its end, abort and cleanup are done. */
  const drivers = new Map<string, Promise<void>>();
  let stopping = false;

  /**
   * The one guarded end write; true when it landed. `delivery_run_ended` means a cancel landed
   * first, which is the guard working; an unknown run is a programmer error.
   */
  async function end(runId: string, entry: HeldRun, outcome: DeliveryEnd): Promise<boolean> {
    const ended = await endDelivery(entry.actor, db, runId, outcome);
    if (ended.ok) {
      entry.ended = true;
      onEnd();
      return true;
    }
    switch (ended.error.code) {
      case "delivery_run_ended":
        return false;
      case "delivery_run_not_found":
        throw new Error(`Delivery run ${runId} vanished before its end was stored`);
    }
  }

  /** A failure end; the run's stored phase says where it failed, and so does its line. */
  async function fail(
    runId: string,
    entry: HeldRun,
    error: { readonly code: DeliveryFailureCode; readonly message: string },
    evidence: Evidence,
  ): Promise<void> {
    const landed = await end(runId, entry, {
      kind: "failure",
      failure: { code: error.code, message: error.message },
      finalCommit: evidence.finalCommit,
      checkResults: evidence.checkResults,
    });
    if (landed) {
      appendRunEvent(entry.actor, db, {
        runId,
        who: "zenorm",
        ticket: null,
        text: `The run failed while ${entry.phase}: ${error.message}`,
      });
    }
  }

  /**
   * Preparing, implementing, verifying, reviewing, publishing (a passing run on a GitHub project)
   * and the end write; stops once aborted.
   */
  async function drive(run: StoredDeliveryRun, entry: HeldRun, evidence: Evidence): Promise<void> {
    const { signal } = entry.controller;
    // A call, not a property read: a cancel flips it during each await, which narrowing ignores.
    const aborted = (): boolean => signal.aborted;
    const gitIdentity = deliveryIdentity(run.id);
    /** Stores the phase the run enters; an ended run (a cancel landed) keeps its own. */
    const enter = (phase: DeliveryPhase): void => {
      entry.phase = phase;
      setDeliveryPhase(entry.actor, db, run.id, phase);
    };
    /** Appends a line while the run is held and not cancelled; a late one writes nothing. */
    const say = (who: RunActor, ticket: string | null, text: string): void => {
      if (aborted()) return;
      appendRunEvent(entry.actor, db, { runId: run.id, who, ticket, text });
    };

    say(
      "zenorm",
      null,
      run.resumedFromRunId === null
        ? `Run ${String(run.number)} started. Creating the branch ${run.branch} and a worktree from ${run.baseBranch}.`
        : `Run ${String(run.number)} started, resuming the run whose branch is at ${run.startCommit.slice(0, 7)}. Creating the branch ${run.branch} and a worktree there.`,
    );
    const prepared = await prepareDelivery(db, run.id, entry.folder);
    if (aborted()) return;
    if (!prepared.ok) {
      await fail(run.id, entry, prepared.error, evidence);
      return;
    }
    const { runDir, specPath, ticketsPath, ticketCount, tickets, specRevision, specTitle } =
      prepared.value;
    const alreadyMerged = prepared.value.merged;
    const { resumedFrom } = prepared.value;
    say(
      "zenorm",
      null,
      `Pinned spec r${String(specRevision)}, ${plural(ticketCount, "ticket")} and ${plural(run.checks.length, "required check")}.${alreadyMerged.length === 0 ? "" : ` Already merged: ${alreadyMerged.join(", ")}.`} ${startingExecutor(run.executor)}`,
    );
    if (resumedFrom !== null) {
      say("zenorm", null, resumedFromLine(resumedFrom));
    }

    /**
     * The orchestrator's events: lines are stored at once, in emission order; a merge records its
     * commit through git, so merges queue behind each other. Every write is skipped once the run is
     * cancelled, and core's records are guarded on the run being active too.
     */
    let merges: Promise<void> = Promise.resolve();
    // A failed merge record is kept here, not left as a rejected promise, and thrown after the port.
    const mergeErrors: unknown[] = [];
    const onEvent = (event: ImplementEvent): void => {
      if (aborted()) {
        if (entry.abandoned) {
          log(
            `Ignored a ${event.kind} event from delivery executor "${executorName}" for delivery run ${run.id}, let go after its cancel`,
            null,
          );
        }
        return;
      }
      try {
        switch (event.kind) {
          case "line":
            say(event.who, event.ticket, event.text);
            return;
          case "ticket_started":
            recordTicketStarted(entry.actor, db, run.id, event.ticket);
            return;
          case "ticket_merged": {
            const { ticket, summary } = event;
            merges = merges
              .then(async () => {
                if (aborted()) return;
                const recorded = await recordTicketMerged(entry.actor, db, {
                  runId: run.id,
                  ticket,
                  summary,
                  folder: entry.folder,
                });
                // The orchestrator deleted the branch after merging it: verifying fails the run
                // `delivery_ticket_unmerged` naming the ticket.
                if (!recorded.recorded && recorded.reason === "branch_missing") {
                  say(
                    "zenorm",
                    ticket,
                    `${ticket}'s branch ${ticketBranchName(run.branch, ticket)} was gone when its merge was recorded.`,
                  );
                }
              })
              .catch((error: unknown) => {
                mergeErrors.push(error);
              });
            return;
          }
        }
      } catch (error: unknown) {
        log(`Could not store an event of delivery run ${run.id}`, error);
      }
    };

    const { repairLimit } = run;
    if (repairLimit === null) {
      throw new Error(`Delivery run ${run.id} was launched with no pinned repair limit`);
    }
    let request: ImplementRequest = {
      runDir,
      worktreePath: run.worktreePath,
      branch: run.branch,
      baseCommit: run.baseCommit,
      specPath,
      ticketsPath,
      ticketCount,
      tickets,
      merged: alreadyMerged,
      resumedFrom,
      repair: null,
      checks: run.checks,
      // Pinned at start; every call, first and repair, carries the same.
      fixCommands: run.fixCommands,
      gitIdentity,
    };
    /** The final commit the previous check pass ran on, once a repair attempt follows it. */
    let repairedFrom: string | null = null;
    let finalCommit: string;
    let checkResults: CheckResult[];

    // Implementing, verifying and the checks; again on each repair attempt while checks fail.
    for (;;) {
      enter("implementing");
      const implemented = await implementTicketSet(request, signal, onEvent);
      // Every merge is recorded before verifying reads the records (a throw is an internal error).
      await merges;
      const [mergeError] = mergeErrors;
      if (mergeErrors.length > 0) {
        throw mergeError;
      }
      if (aborted()) return;
      if (!implemented.ok) {
        await fail(run.id, entry, implemented.error, evidence);
        return;
      }
      say("zenorm", null, "The executor exited cleanly. Verifying its commits and merges.");

      enter("verifying");
      const verified = await verifyDelivery({
        worktreePath: run.worktreePath,
        branch: run.branch,
        baseCommit: run.baseCommit,
        repairedFrom,
        identities: deliveryIdentities(db, run.id),
      });
      if (aborted()) return;
      if (!verified.ok) {
        await fail(run.id, entry, verified.error, evidence);
        return;
      }
      finalCommit = verified.value.finalCommit;
      evidence.finalCommit = finalCommit;

      const merged = await verifyTicketMerges(entry.actor, db, {
        runId: run.id,
        finalCommit,
        folder: entry.folder,
      });
      if (aborted()) return;
      if (!merged.ok) {
        await fail(run.id, entry, merged.error, evidence);
        return;
      }
      say(
        "zenorm",
        null,
        `Every ticket is merged into ${run.branch} at ${finalCommit.slice(0, 7)}. Rerunning the required checks.`,
      );

      checkResults = await runChecksReporting(
        {
          worktreePath: run.worktreePath,
          runDir,
          checks: run.checks,
          timeoutMs: checkTimeoutMinutes * MS_PER_MINUTE,
          killGraceMs: CHECK_KILL_GRACE_MS,
          env: { ...process.env, ...gitIdentityEnv(gitIdentity) },
          signal,
        },
        (resultsSoFar) => {
          if (aborted()) return;
          storeCheckResults(entry.actor, db, run.id, resultsSoFar);
          const last = resultsSoFar.at(-1);
          if (last === undefined) {
            throw new Error("A check reported no result");
          }
          say("zenorm", null, checkLine(last));
        },
      );
      if (aborted()) return;
      evidence.checkResults = checkResults;
      const failedChecks = checkResults.flatMap((result, index) =>
        checkPassed(result) ? [] : [{ result, logPath: checkLogPath(runDir, index) }],
      );
      if (failedChecks.length === 0) {
        break;
      }
      const commands = failedChecks.map(({ result }) => `\`${result.command}\``).join(", ");
      const attempt = (request.repair === null ? 0 : request.repair.attempt) + 1;
      if (attempt > repairLimit) {
        await fail(
          run.id,
          entry,
          { code: "delivery_checks_failed", message: `These checks did not pass: ${commands}` },
          evidence,
        );
        return;
      }
      // Guarded on the run being active: a cancel that landed first ends the drive.
      if (!countRepairAttempt(entry.actor, db, run.id)) {
        return;
      }
      say(
        "zenorm",
        null,
        `Repair attempt ${String(attempt)} of ${String(repairLimit)}: ${plural(failedChecks.length, "check")} did not pass (${commands}). The executor is given ${failedChecks.length === 1 ? "its" : "their"} output to fix and commit.`,
      );
      repairedFrom = finalCommit;
      request = {
        ...request,
        // Every ticket merged so far: the executor merges none again.
        merged: readRunTicketRows(db, run.id)
          .filter((row) => row.mergedAt !== null)
          .map((row) => row.ticket),
        resumedFrom: null,
        repair: { attempt, limit: repairLimit, failedChecks },
      };
    }

    enter("reviewing");
    const review = await prepareReview({
      runDir,
      worktreePath: run.worktreePath,
      baseCommit: run.baseCommit,
      finalCommit,
    });
    if (aborted()) return;
    say(
      "reviewer",
      null,
      `A fresh, read-only session started. Reading the branch's diff against spec r${String(specRevision)}.`,
    );
    const reviewed = await reviewDelivery(
      {
        runDir,
        worktreePath: run.worktreePath,
        baseCommit: run.baseCommit,
        finalCommit,
        specPath,
        ticketsPath,
        diffPath: review.diffPath,
        changedFiles: review.changedFiles,
        checkResults,
        gitIdentity,
      },
      signal,
    );
    if (aborted()) return;
    if (!reviewed.ok) {
      await fail(run.id, entry, reviewed.error, evidence);
      return;
    }
    const verdict = reviewed.value;
    const criteria = checkVerdictCriteria(db, run.id, verdict);
    if (!criteria.ok) {
      await fail(run.id, entry, criteria.error, evidence);
      return;
    }
    const accepted = await acceptVerdict({
      worktreePath: run.worktreePath,
      branch: run.branch,
      finalCommit,
      statusSnapshot: review.statusSnapshot,
      verdict,
    });
    if (aborted()) return;
    if (!accepted.ok) {
      await fail(run.id, entry, accepted.error, evidence);
      return;
    }

    // A passing run on a project whose origin is on github.com ends by opening its pull request; a
    // blocked run, or one with no such origin, ends here as before.
    const origin = passes(verdict) ? await githubOrigin(entry.folder) : null;
    if (aborted()) return;
    if (origin === null) {
      if (
        await end(run.id, entry, {
          kind: "verdict",
          verdict,
          finalCommit,
          checkResults,
          pullRequest: null,
        })
      ) {
        appendRunEvent(entry.actor, db, {
          runId: run.id,
          who: "reviewer",
          ticket: null,
          text: verdictLine(verdict),
        });
      }
      return;
    }

    enter("publishing");
    say("reviewer", null, verdictLine(verdict));
    const published = await publish({
      run,
      entry,
      origin,
      title: specTitle,
      say: (text) => {
        say("zenorm", null, text);
      },
      request: {
        runDir,
        worktreePath: run.worktreePath,
        baseCommit: run.baseCommit,
        finalCommit,
        specPath,
        ticketsPath,
        diffPath: review.diffPath,
        changedFiles: review.changedFiles,
        implementerReports: readRunTicketRows(db, run.id).map((row) => ({
          ticket: row.ticket,
          report: row.summary,
        })),
        checkResults,
        verdict,
        gitIdentity,
      },
    });
    if (aborted()) return;
    if (!published.ok) {
      await fail(run.id, entry, published.error, evidence);
      return;
    }
    const pullRequest = published.value;
    if (
      await end(run.id, entry, { kind: "verdict", verdict, finalCommit, checkResults, pullRequest })
    ) {
      appendRunEvent(entry.actor, db, {
        runId: run.id,
        who: "zenorm",
        ticket: null,
        text: `Opened pull request #${String(pullRequest.number)} on ${origin.owner}/${origin.name}: merge it on GitHub.`,
      });
    }
  }

  /**
   * The publishing step of a passing run on a GitHub project: on a run that pinned an app start
   * command and URL, the screen picker first lists the changed screens, which one line says (none,
   * the screens, or `capture_picker_failed`, which never fails the run); listed screens are then
   * captured (`captureScreensOf`), any capture failure one line with its code; then the pull
   * request writer writes the body from the capture outcome, and on a run without that capture a
   * visible change adds the line
   * suggesting the app settings; ZeNorm adds its footer, then gh's sign-in is checked, the run
   * branch is pushed to origin and the pull request is opened on origin's repository against the
   * pinned base, titled with the spec's title. The first failure is the run's; nothing pushed or opened is ever undone. Each
   * step stops once the run is aborted, and the driver then stores nothing.
   */
  async function publish(input: {
    readonly run: StoredDeliveryRun;
    readonly entry: HeldRun;
    readonly origin: GitHubRepository;
    readonly title: string;
    /** The writer's request but its capture outcome, which this step adds. */
    readonly request: Omit<PullRequestRequest, "capture">;
    readonly say: (text: string) => void;
  }): Promise<
    Result<PullRequest, { readonly code: DeliveryFailureCode; readonly message: string }>
  > {
    const { run, entry, origin, say } = input;
    const { signal } = entry.controller;
    const { folder } = entry;
    const repository = `${origin.owner}/${origin.name}`;
    // Capture is on for a run that pinned both an app start command and its URL.
    const { appStartCommand, appUrl } = run;
    const captureOn = appStartCommand !== null && appUrl !== null;
    let capture: PullRequestCapture = { kind: "off" };
    if (captureOn) {
      const { request } = input;
      const picked = await pickScreens(
        {
          runDir: request.runDir,
          worktreePath: request.worktreePath,
          baseCommit: request.baseCommit,
          finalCommit: request.finalCommit,
          specPath: request.specPath,
          diffPath: request.diffPath,
          changedFiles: request.changedFiles,
          gitIdentity: request.gitIdentity,
        },
        signal,
      );
      // A cancel stops the publishing step; any other failure is the capture's alone.
      if (!picked.ok && signal.aborted) return picked;
      if (!picked.ok) {
        say(
          `Screenshots are missing (capture_picker_failed): the screen picker failed: ${picked.error.message}`,
        );
        capture = { kind: "failed", code: "capture_picker_failed" };
      } else {
        say(pickedLine(picked.value));
        capture =
          picked.value.kind === "no_visible_change"
            ? { kind: "no_visible_change" }
            : await captureScreensOf({
                run,
                folder,
                request,
                appStartCommand,
                appUrl,
                screens: picked.value.screens,
                signal,
                say,
              });
        if (signal.aborted) return err(CAPTURE_CANCELLED);
      }
    }
    say(`Writing the pull request for ${repository}.`);
    const written = await writePullRequest({ ...input.request, capture }, signal);
    if (!written.ok) return written;
    const { body, visibleChange } = written.value;
    if (!captureOn && visibleChange) {
      say(CAPTURE_SETUP_HINT);
    }
    const bodyFile = join(input.request.runDir, PULL_REQUEST_BODY_FILE);
    await writeFile(bodyFile, `${body.trimEnd()}${PULL_REQUEST_FOOTER}`);
    const signedIn = await checkGitHubSignIn({ folder, signal });
    if (!signedIn.ok) return signedIn;
    say(`Pushing ${run.branch} to origin.`);
    const pushed = await pushRunBranch({ folder, branch: run.branch, signal });
    if (!pushed.ok) return pushed;
    say(`Opening the pull request into ${run.baseBranch} on ${repository}.`);
    return await openPullRequest({
      folder,
      repository: origin,
      baseBranch: run.baseBranch,
      branch: run.branch,
      title: input.title,
      bodyFile,
      signal,
    });
  }

  /**
   * The capture of the picked screens, after the picker listed them: the run's pinned setup
   * commands under the check bound, the app started from the run worktree and waited for, the
   * capture port called once with the screens, the app's process group stopped whatever happened,
   * the six-screen cap enforced on the images, and the images pushed to the run's pr-assets branch.
   * Each step that fails ends the capture with one line naming its code, and the writer is told the
   * capture failed; nothing here fails the run. Once aborted it returns at once, and the caller
   * stops the publishing step.
   */
  async function captureScreensOf(input: {
    readonly run: StoredDeliveryRun;
    readonly folder: string;
    readonly request: Omit<PullRequestRequest, "capture">;
    readonly appStartCommand: string;
    readonly appUrl: string;
    readonly screens: readonly PickedScreen[];
    readonly signal: AbortSignal;
    readonly say: (text: string) => void;
  }): Promise<PullRequestCapture> {
    const { run, request, appStartCommand, appUrl, screens, signal, say } = input;
    const aborted = (): boolean => signal.aborted;
    const failed = (error: CodedError<CaptureFailureCode>): PullRequestCapture => {
      say(`Screenshots are missing (${error.code}): ${error.message}`);
      return { kind: "failed", code: error.code };
    };
    if (run.appSetupCommands.length > 0) {
      say(
        `Setting up the app with ${run.appSetupCommands.map((command) => `\`${command}\``).join(", ")}.`,
      );
    }
    const setUp = await runAppSetup({
      worktreePath: request.worktreePath,
      runDir: request.runDir,
      commands: run.appSetupCommands,
      timeoutMs: checkTimeoutMinutes * MS_PER_MINUTE,
      env: process.env,
      signal,
    });
    if (aborted()) return { kind: "off" };
    if (!setUp.ok) return failed(setUp.error);
    say(`Starting the app with \`${appStartCommand}\` and waiting for ${appUrl} to answer.`);
    const started = await startApp({
      worktreePath: request.worktreePath,
      runDir: request.runDir,
      command: appStartCommand,
      url: appUrl,
      env: process.env,
      sessionsDir,
      readyTimeoutMs: appReadyTimeoutMs,
      signal,
    });
    if (aborted()) return { kind: "off" };
    if (!started.ok) return failed(started.error);
    const app = started.value;
    const screenshotsDir = join(request.runDir, SCREENSHOTS_DIR);
    const shoot = async (): ReturnType<CaptureScreens> => {
      try {
        await mkdir(screenshotsDir, { recursive: true });
        say(`The app answers at ${appUrl}. A browser session is taking the screenshots.`);
        return await captureScreens(
          {
            runDir: request.runDir,
            worktreePath: request.worktreePath,
            appUrl,
            screens: [...screens],
            screenshotsDir,
            gitIdentity: request.gitIdentity,
          },
          signal,
        );
      } finally {
        // Whatever the capture came to, the app's whole process group stops before anything else.
        await app.stop();
      }
    };
    const captured = await shoot();
    if (aborted()) return { kind: "off" };
    if (!captured.ok && captured.error.code === "capture_browser_missing") {
      return failed(captured.error);
    }
    if (!captured.ok) {
      return failed({
        code: "capture_session_failed",
        message: `the capture session failed: ${captured.error.message}`,
      });
    }
    const { images, skipped } = captured.value;
    const shown = new Set(images.map((image) => image.screen));
    if (shown.size > DELIVERY_SCREENS_MAX_COUNT) {
      return failed({
        code: "capture_too_many_screens",
        message: `the capture returned images of ${plural(shown.size, "screen")}, more than the ${String(DELIVERY_SCREENS_MAX_COUNT)} a pull request shows.`,
      });
    }
    const skippedScreens = new Set(skipped.map((screen) => screen.screen));
    const notShown = screens.filter(
      (screen) => !shown.has(screen.where) && !skippedScreens.has(screen.where),
    );
    if (images.length === 0) {
      say(
        `The browser session took no screenshot${skipped.length === 0 ? "" : `; it skipped ${plural(skipped.length, "screen")}`}.`,
      );
      return { kind: "captured", images: [], skipped, notShown };
    }
    const pushed = await pushScreenshots({
      folder: input.folder,
      runBranch: run.branch,
      files: images.map((image) => ({ path: join(screenshotsDir, image.file), name: image.file })),
      env: gitIdentityEnv(request.gitIdentity),
      indexFile: join(request.runDir, PR_ASSETS_INDEX_FILE),
      signal,
    });
    if (aborted()) return { kind: "off" };
    if (!pushed.ok) return failed(pushed.error);
    const { branch } = pushed.value;
    say(`Pushed ${plural(images.length, "screenshot")} to ${branch} on origin.`);
    return {
      kind: "captured",
      images: images.map((image) => ({
        screen: image.screen,
        caption: image.caption,
        src: prAssetSource(branch, image.file),
      })),
      skipped,
      notShown,
    };
  }

  /** An unexpected throw: logged, then stored as `delivery_internal_error` unless cancelled. */
  async function internalError(
    run: StoredDeliveryRun,
    entry: HeldRun,
    evidence: Evidence,
    error: unknown,
  ): Promise<void> {
    log(`Unexpected error while delivering run ${run.id} in phase ${entry.phase}`, error);
    if (entry.controller.signal.aborted) return;
    try {
      await fail(
        run.id,
        entry,
        {
          code: "delivery_internal_error",
          message: "The run stopped on an unexpected error; the server log has the details.",
        },
        evidence,
      );
    } catch (writeError: unknown) {
      log(`Could not store the internal error of delivery run ${run.id}`, writeError);
    }
  }

  /**
   * After the driver settles: cleans up a run whose end this runner wrote or whose cancel it
   * aborted. A run another runner ended (a cancel from a restarted app) is left to it.
   */
  async function settle(run: StoredDeliveryRun, entry: HeldRun): Promise<void> {
    if (!entry.ended && !entry.controller.signal.aborted) return;
    // The cancel's bound passed first, and its cleanup ran then.
    if (entry.abandoned) return;
    // Stopped by a shutdown: the run stays active, to read interrupted after the restart.
    if (entry.stopped && !entry.ended) return;
    try {
      await cleanUp(entry.actor, db, run, ok(entry.folder));
    } catch (error: unknown) {
      log(`Could not clean up delivery run ${run.id}`, error);
    }
  }

  /**
   * A person's Cancel is bounded like a stop: when the driver has not settled
   * `EXECUTOR_STOP_BOUND_MS` after the abort, the run is logged, let go and cleaned up. Its end is
   * the cancel's, already stored.
   */
  function boundCancel(run: StoredDeliveryRun, entry: HeldRun, driver: Promise<void>): void {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<"bound">((resolve) => {
      timer = setTimeout(() => {
        resolve("bound");
      }, EXECUTOR_STOP_BOUND_MS);
    });
    void Promise.race([driver.then(() => "settled" as const), bound])
      .then(async (outcome) => {
        clearTimeout(timer);
        if (outcome === "settled") return;
        log(
          `Delivery executor "${executorName}" did not settle delivery run ${run.id} within ${String(EXECUTOR_STOP_BOUND_MS / 1000)} s of the cancel; cleaning it up and ignoring its later events`,
          null,
        );
        entry.abandoned = true;
        held.delete(run.id);
        drivers.delete(run.id);
        await cleanUp(entry.actor, db, run, ok(entry.folder));
      })
      .catch((error: unknown) => {
        log(`Could not clean up delivery run ${run.id}`, error);
      });
  }

  return {
    launch(run, folder) {
      if (held.has(run.id)) {
        throw new Error(`Delivery run ${run.id} is already held`);
      }
      if (stopping) {
        return;
      }
      const entry: HeldRun = {
        actor: deliveryRunActor(run),
        phase: "preparing",
        controller: new AbortController(),
        ended: false,
        stopped: false,
        abandoned: false,
        run,
        folder,
      };
      const evidence: Evidence = { finalCommit: null, checkResults: null };
      held.set(run.id, entry);
      const driven = drive(run, entry, evidence)
        .catch((error: unknown) => internalError(run, entry, evidence, error))
        .then(() => settle(run, entry))
        .finally(() => {
          held.delete(run.id);
          drivers.delete(run.id);
        });
      drivers.set(run.id, driven);
    },
    held(runId) {
      return held.has(runId);
    },
    async stop() {
      stopping = true;
      for (const entry of held.values()) {
        if (!entry.controller.signal.aborted) {
          entry.stopped = true;
          entry.controller.abort();
        }
      }
      // The executor gets a bound, so one that ignores `signal` cannot hold the shutdown.
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<"bound">((resolve) => {
        timer = setTimeout(() => {
          resolve("bound");
        }, EXECUTOR_STOP_BOUND_MS);
      });
      const outcome = await Promise.race([
        Promise.all(drivers.values()).then(() => "settled" as const),
        bound,
      ]);
      clearTimeout(timer);
      if (outcome === "bound") {
        for (const runId of drivers.keys()) {
          log(
            `Delivery executor "${executorName}" did not settle delivery run ${runId} within ${String(EXECUTOR_STOP_BOUND_MS / 1000)} s of the stop; the run stays running for the startup sweep`,
            null,
          );
        }
      }
    },
    async cancelled(runId) {
      const entry = held.get(runId);
      if (entry !== undefined) {
        entry.controller.abort();
        appendRunEvent(entry.actor, db, {
          runId,
          who: "zenorm",
          ticket: null,
          text: cancelLine(entry.phase, entry.run.executor),
        });
        const driver = drivers.get(runId);
        if (driver === undefined) {
          throw new Error(`Held delivery run ${runId} has no driver`);
        }
        boundCancel(entry.run, entry, driver);
        return;
      }
      if (readRunTicketRows(db, runId).length === 0) {
        return;
      }
      const found = await getDeliveryRun(db, runId);
      if (!found.ok) {
        throw new Error(`Cancelled delivery run ${runId} vanished`);
      }
      // The runner's line and cleanup on the run are the run's own writes; the Cancel's end write
      // was the person's.
      const actor = deliveryRunActor(found.value);
      appendRunEvent(actor, db, {
        runId,
        who: "zenorm",
        ticket: null,
        text: "You cancelled the interrupted run.",
      });
      // Not held (after a restart): the folder is resolved again through the checkout seam.
      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, found.value.projectId))
        .get();
      if (project === undefined) {
        throw new Error(`Delivery run ${runId}'s project ${found.value.projectId} is missing`);
      }
      await cleanUp(actor, db, found.value, await seamsOf(db).checkout(project));
    },
  };
}
