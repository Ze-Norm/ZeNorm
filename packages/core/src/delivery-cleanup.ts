/**
 * Cleanup after a run ends: its worktrees and ticket branches are removed, its run branch and run
 * folder's files are kept.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Actor, CheckoutError, Result } from "@zenorm/contracts";
import { deliveryRunTickets, deliveryRuns } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

import { runGit } from "./git.ts";
import type { DeletedRun } from "./map-delete.ts";
import { appendRunEvent } from "./run-events.ts";
import { ticketBranchName } from "./run-progress.ts";

/** One cleanup step that failed: what it was on (a path or a branch) and git's message. */
export interface CleanupFailure {
  readonly target: string;
  readonly message: string;
}

/** What `cleanUpDelivery` did. */
export type DeliveryCleanup =
  /** The run has no ticket rows (from before `0010`): nothing was touched and no line written. */
  | { readonly cleaned: false }
  | {
      readonly cleaned: true;
      /** The worktree paths removed, the run worktree first. */
      readonly removedWorktrees: string[];
      /** The ticket branches deleted, by name. */
      readonly deletedBranches: string[];
      /** Each failed step, in order; each is also a ZeNorm line on the run. */
      readonly failures: CleanupFailure[];
    };

function gitMessage(stderr: string, exitCode: number): string {
  const message = stderr.trim();
  return message === "" ? `git exited ${String(exitCode)}` : message;
}

/**
 * Cleans up an ended run, in its project folder `checkedOut`: the folder the run's start
 * resolved while the runner holds the run, else the checkout seam's answer now (after a restart);
 * a checkout failure is the folder being gone. `git worktree remove --force` on the run
 * worktree (when it is on disk; a run that failed before `git worktree add` has none) and on each
 * entry of `<runDir>/tickets`, then `git worktree prune`, then `git branch -D` on each
 * `refs/heads/<run branch>-t*`. Each failing step becomes a ZeNorm line naming its path or branch
 * and git's message, and the remaining steps still run; a project folder that is gone is one such
 * line and stops the rest (no git can run there). A run with no ticket rows (from before `0010`)
 * is left untouched with no line. Never throws on a git failure; an unknown or active run is a
 * programmer error.
 */
export async function cleanUpDelivery(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  checkedOut: Result<string, CheckoutError>,
): Promise<DeliveryCleanup> {
  const run = db
    .select({
      branch: deliveryRuns.branch,
      worktreePath: deliveryRuns.worktreePath,
      endedAt: deliveryRuns.endedAt,
    })
    .from(deliveryRuns)
    .where(eq(deliveryRuns.id, runId))
    .get();
  if (run === undefined) {
    throw new Error(`No delivery run with id ${runId}`);
  }
  if (run.endedAt === null) {
    throw new Error(`Delivery run ${runId} is active; cleanup runs after its end`);
  }
  const ticketRows = db
    .select({ ticket: deliveryRunTickets.ticket })
    .from(deliveryRunTickets)
    .where(eq(deliveryRunTickets.runId, runId))
    .all();
  if (ticketRows.length === 0) {
    return { cleaned: false };
  }
  /** Exactly the pinned tickets' branches: `-t*` alone would also match a `…-tweak`. */
  const ticketBranches = new Set(ticketRows.map((row) => ticketBranchName(run.branch, row.ticket)));

  const removedWorktrees: string[] = [];
  const deletedBranches: string[] = [];
  const failures: CleanupFailure[] = [];
  const fail = (target: string, message: string, text: string): void => {
    failures.push({ target, message });
    // Each line is its own write, between the git steps' awaits.
    appendRunEvent(actor, db, { runId, who: "zenorm", ticket: null, text });
  };

  if (!checkedOut.ok) {
    const missing = checkedOut.error.data.folderPath;
    fail(
      missing,
      "The project folder is missing",
      `Cleanup could not run: the project folder ${missing} is missing.`,
    );
    return { cleaned: true, removedWorktrees, deletedBranches, failures };
  }
  const folder = checkedOut.value;
  if (!existsSync(folder)) {
    fail(
      folder,
      "The project folder is missing",
      `Cleanup could not run: the project folder ${folder} is missing.`,
    );
    return { cleaned: true, removedWorktrees, deletedBranches, failures };
  }

  const worktrees: string[] = [];
  if (existsSync(run.worktreePath)) {
    worktrees.push(run.worktreePath);
  }
  const ticketsDir = join(dirname(run.worktreePath), "tickets");
  try {
    const entries = await readdir(ticketsDir);
    worktrees.push(...entries.sort().map((entry) => join(ticketsDir, entry)));
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      fail(ticketsDir, message, `Could not list the ticket worktrees in ${ticketsDir}: ${message}`);
    }
  }

  for (const path of worktrees) {
    const removed = await runGit(folder, ["worktree", "remove", "--force", path]);
    if ("stdout" in removed) {
      removedWorktrees.push(path);
    } else {
      const message = gitMessage(removed.stderr, removed.exitCode);
      fail(path, message, `Could not remove the worktree ${path}: ${message}`);
    }
  }

  const pruned = await runGit(folder, ["worktree", "prune"]);
  if (!("stdout" in pruned)) {
    const message = gitMessage(pruned.stderr, pruned.exitCode);
    fail(folder, message, `Could not prune the worktrees of ${folder}: ${message}`);
  }

  const listed = await runGit(folder, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/heads/${run.branch}-t*`,
  ]);
  if (!("stdout" in listed)) {
    const message = gitMessage(listed.stderr, listed.exitCode);
    fail(folder, message, `Could not list the ticket branches of ${run.branch}: ${message}`);
    return { cleaned: true, removedWorktrees, deletedBranches, failures };
  }
  const branches = listed.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((branch) => ticketBranches.has(branch));
  for (const branch of branches) {
    const deleted = await runGit(folder, ["branch", "-D", branch]);
    if ("stdout" in deleted) {
      deletedBranches.push(branch);
    } else {
      const message = gitMessage(deleted.stderr, deleted.exitCode);
      fail(branch, message, `Could not delete the branch ${branch}: ${message}`);
    }
  }

  return { cleaned: true, removedWorktrees, deletedBranches, failures };
}

/**
 * Removes what delivery runs deleted with their spec (`deleteMap`) left in their project folder
 * `checkedOut`: `git worktree remove --force` on each run worktree and ticket worktree still on
 * disk, then `git worktree prune`, then `git branch -D` on each run branch and ticket branch that
 * still exists. The run folders' other files and anything pushed to the origin repository are
 * kept. The runs' rows are gone, so a failed step is returned, not written as a line; the
 * remaining steps still run, and a project folder that is gone is the one failure. Never throws
 * on a git failure.
 */
export async function cleanUpDeletedRuns(
  runs: readonly DeletedRun[],
  checkedOut: Result<string, CheckoutError>,
): Promise<CleanupFailure[]> {
  if (runs.length === 0) {
    return [];
  }
  if (!checkedOut.ok) {
    return [{ target: checkedOut.error.data.folderPath, message: "The project folder is missing" }];
  }
  const folder = checkedOut.value;
  const failures: CleanupFailure[] = [];
  const worktrees: string[] = [];
  for (const run of runs) {
    if (existsSync(run.worktreePath)) {
      worktrees.push(run.worktreePath);
    }
    const ticketsDir = join(dirname(run.worktreePath), "tickets");
    if (existsSync(ticketsDir)) {
      const entries = await readdir(ticketsDir);
      worktrees.push(...entries.sort().map((entry) => join(ticketsDir, entry)));
    }
  }
  for (const path of worktrees) {
    const removed = await runGit(folder, ["worktree", "remove", "--force", path]);
    if (!("stdout" in removed)) {
      failures.push({ target: path, message: gitMessage(removed.stderr, removed.exitCode) });
    }
  }
  const pruned = await runGit(folder, ["worktree", "prune"]);
  if (!("stdout" in pruned)) {
    failures.push({ target: folder, message: gitMessage(pruned.stderr, pruned.exitCode) });
  }
  for (const branch of runs.flatMap((run) => [...run.ticketBranches, run.branch])) {
    const exists = await runGit(folder, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (!("stdout" in exists)) {
      continue;
    }
    const deleted = await runGit(folder, ["branch", "-D", branch]);
    if (!("stdout" in deleted)) {
      failures.push({ target: branch, message: gitMessage(deleted.stderr, deleted.exitCode) });
    }
  }
  return failures;
}
