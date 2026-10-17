import { tmpdir } from "node:os";

import { err, ok } from "@zenorm/contracts";
import type { Actor, CheckPullRequestError, MarkMergedError, Result } from "@zenorm/contracts";
import { deliveryRuns, projects } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { deliveryOutcome, getDeliveryRun, storedPullRequest } from "./delivery.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import { runGit } from "./git.ts";
import { checkGitHubSignIn, readPullRequestState } from "./github.ts";
import type { GitHubSignInError } from "./github.ts";
import { insertRunEvent } from "./run-events.ts";
import { readRunTicketRows } from "./run-tickets.ts";
import { seamsOf } from "./seams.ts";
import { write } from "./writes.ts";

/** How many characters of a commit id a line shows. */
const SHORT_COMMIT_LENGTH = 7;

/**
 * Mark merged: records a passed run as merged once git shows its final commit in the
 * pinned base branch. Refuses, writing nothing, in order: `delivery_run_not_found`,
 * `delivery_not_passed`, `delivery_already_merged`, `project_folder_missing` (from the checkout
 * seam, which gives the folder: the run has ended, so it is resolved again), then by
 * `git merge-base --is-ancestor <final> refs/heads/<pinned base>` in that folder: exit 1 is
 * `delivery_not_merged` (a squash or rebase merge too: ancestry is the only test), any other
 * failure (the branch or the commit is gone) `delivery_branch_missing`. On exit 0 it sets
 * `merged_at` and writes ZeNorm's line, except on a run with no ticket rows (from before
 * `0010`), which gets no line.
 */
export async function markMerged(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
): Promise<Result<StoredDeliveryRun, MarkMergedError>> {
  const found = await getDeliveryRun(db, runId);
  if (!found.ok) {
    return found;
  }
  const run = found.value;
  if (deliveryOutcome(run) !== "passed") {
    return err({
      code: "delivery_not_passed",
      message: `Delivery run ${runId} did not pass`,
      data: { runId },
    });
  }
  if (run.mergedAt !== null) {
    return alreadyMerged(runId);
  }
  const { finalCommit, baseBranch } = run;
  if (finalCommit === null) {
    throw new Error(`Passed delivery run ${runId} has no final commit`);
  }
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  if (project === undefined) {
    throw new Error(`Delivery run ${runId}'s project ${run.projectId} is missing`);
  }
  const checkedOut = await seamsOf(db).checkout(project);
  if (!checkedOut.ok) {
    return err(checkedOut.error);
  }
  const ancestry = await runGit(checkedOut.value, [
    "merge-base",
    "--is-ancestor",
    finalCommit,
    `refs/heads/${baseBranch}`,
  ]);
  const data = { runId, finalCommit, baseBranch };
  if (!("stdout" in ancestry)) {
    if (ancestry.exitCode === 1) {
      return err({
        code: "delivery_not_merged",
        message: `${finalCommit} is not in ${baseBranch}`,
        data,
      });
    }
    return err({
      code: "delivery_branch_missing",
      message: `git merge-base could not compare ${finalCommit} with ${baseBranch}: ${ancestry.stderr.trim()}`,
      data,
    });
  }
  // The update and its line are one write: one transaction, one publish.
  const updated = write(db, actor, (tx) => {
    const result = tx
      .update(deliveryRuns)
      .set({ mergedAt: new Date().toISOString() })
      .where(and(eq(deliveryRuns.id, runId), isNull(deliveryRuns.mergedAt)))
      .run();
    if (result.changes > 0 && readRunTicketRows(tx, runId).length > 0) {
      insertRunEvent(tx, {
        runId,
        who: "zenorm",
        ticket: null,
        text: `${finalCommit.slice(0, SHORT_COMMIT_LENGTH)} is in ${baseBranch}. The tickets are recorded as delivered.`,
      });
    }
    return result;
  });
  if (updated.changes === 0) {
    return alreadyMerged(runId);
  }
  const stored = await getDeliveryRun(db, runId);
  if (!stored.ok) {
    throw new Error(`Delivery run ${runId} vanished after it was marked merged`);
  }
  return stored;
}

/**
 * How often the server checks every open pull request. A fixed constant: no config key names
 * it.
 */
export const PULL_REQUEST_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The runs whose pull request the timer checks: every passed run whose recorded pull
 * request is open, whichever run of its spec is the latest. A closed or merged one is no longer
 * checked; Check now still reads it.
 */
export function openPullRequestRuns(db: ZeNormDatabase): string[] {
  return db
    .select({ id: deliveryRuns.id })
    .from(deliveryRuns)
    .where(and(eq(deliveryRuns.prState, "open"), isNotNull(deliveryRuns.endedAt)))
    .orderBy(asc(deliveryRuns.startedAt))
    .all()
    .map((run) => run.id);
}

/**
 * Check now, and each of the timer's checks: reads the state GitHub reports for the run's
 * recorded pull request and records it. Refuses, writing nothing, in order:
 * `delivery_run_not_found`, `delivery_no_pull_request` (the run opened none), then gh's sign-in
 * check (`delivery_gh_missing`, `delivery_github_not_signed_in`, `delivery_github_unreachable`), then
 * reading the state, whose failure is `delivery_github_unreachable` too.
 *
 * Merged (by a merge, squash or rebase) records the pull request merged and sets `merged_at`,
 * guarded `merged_at IS NULL`, with ZeNorm's line as Mark merged writes it (none on a run with no
 * ticket rows); closed records it closed; open (a reopen) records it open. A state already recorded
 * writes nothing.
 */
export async function checkPullRequest(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  signal: AbortSignal,
): Promise<Result<StoredDeliveryRun, CheckPullRequestError>> {
  const found = await getDeliveryRun(db, runId);
  if (!found.ok) {
    return found;
  }
  const run = found.value;
  const pullRequest = storedPullRequest(run);
  if (pullRequest === null) {
    return err({
      code: "delivery_no_pull_request",
      message: `Delivery run ${runId} opened no pull request`,
      data: { runId },
    });
  }
  // gh is given the pull request's URL and reads no repository: any folder that exists will do.
  const folder = tmpdir();
  const signedIn = await checkGitHubSignIn({ folder, signal });
  if (!signedIn.ok) {
    return err(checkRefusal(runId, signedIn.error));
  }
  const read = await readPullRequestState({ folder, url: pullRequest.url, signal });
  if (!read.ok) {
    return err(checkRefusal(runId, read.error));
  }
  const state = read.value;
  const merging = state === "merged" && run.mergedAt === null;
  if (state === pullRequest.state && !merging) {
    return ok(run);
  }
  const label = `Pull request #${String(pullRequest.number)}`;
  // The update and its line are one write: one transaction, one publish.
  write(db, actor, (tx) => {
    const lined = readRunTicketRows(tx, runId).length > 0;
    const line = (text: string): void => {
      if (lined) {
        insertRunEvent(tx, { runId, who: "zenorm", ticket: null, text });
      }
    };
    if (merging) {
      const result = tx
        .update(deliveryRuns)
        .set({ mergedAt: new Date().toISOString(), prState: "merged" })
        .where(and(eq(deliveryRuns.id, runId), isNull(deliveryRuns.mergedAt)))
        .run();
      if (result.changes > 0) {
        line(
          `${label} is merged into ${run.baseBranch} on GitHub. The tickets are recorded as delivered.`,
        );
        return;
      }
    }
    tx.update(deliveryRuns).set({ prState: state }).where(eq(deliveryRuns.id, runId)).run();
    switch (state) {
      case "closed":
        line(`${label} was closed on GitHub without being merged.`);
        return;
      case "open":
        line(`${label} is open again on GitHub.`);
        return;
      case "merged":
        return;
    }
  });
  const stored = await getDeliveryRun(db, runId);
  if (!stored.ok) {
    throw new Error(`Delivery run ${runId} vanished after its pull request was checked`);
  }
  return stored;
}

/** gh's refusal (the sign-in check's or reading the state's) as Check now's. */
function checkRefusal(runId: string, error: GitHubSignInError): CheckPullRequestError {
  return { code: error.code, message: error.message, data: { runId } };
}

function alreadyMerged(runId: string): Result<never, MarkMergedError> {
  return err({
    code: "delivery_already_merged",
    message: `Delivery run ${runId} is already recorded as merged`,
    data: { runId },
  });
}
