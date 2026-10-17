import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ok } from "@zenorm/contracts";
import type { Project } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanUpDelivery } from "./delivery-cleanup.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import { readRunEvents } from "./run-events.ts";
import { ticketBranchName } from "./run-progress.ts";
import {
  addProject,
  asPre0010Run,
  closeTestContext,
  commitOnRunBranch,
  deliverableTicketSet,
  endRun,
  openTestContext,
  startedRun,
  runFolder,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-delivery-cleanup-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  ).replace(/\n$/, "");
}

function ticketPath(run: StoredDeliveryRun, ticket: string): string {
  return join(dirname(run.worktreePath), "tickets", ticket);
}

/** A ticket worktree on its own branch `<run branch>-t<n>` with one commit, as implementers leave. */
async function ticketWork(run: StoredDeliveryRun, ticket: string): Promise<void> {
  const path = ticketPath(run, ticket);
  await mkdir(dirname(path), { recursive: true });
  git(project.folderPath, [
    "worktree",
    "add",
    "-q",
    "-b",
    ticketBranchName(run.branch, ticket),
    path,
    run.baseCommit,
  ]);
  await writeFile(join(path, `${ticket}.txt`), `${ticket}\n`);
  git(path, ["add", `${ticket}.txt`]);
  git(path, ["commit", "-q", "-m", `Implement ${ticket}`]);
}

/** A run with its worktree, a commit on the run branch and two ticket worktrees, then ended. */
async function endedRunWithWorktrees(): Promise<StoredDeliveryRun> {
  const set = await deliverableTicketSet(context, project);
  const run = await startedRun(context, set.ticketSetId);
  const finalCommit = await commitOnRunBranch(context, run);
  await ticketWork(run, "T1");
  await ticketWork(run, "T2");
  await endRun(context, run.id, { outcome: "passed", finalCommit });
  return run;
}

function worktreeList(): string {
  return git(project.folderPath, ["worktree", "list", "--porcelain"]);
}

function ticketRefs(run: StoredDeliveryRun): string {
  return git(project.folderPath, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/heads/${run.branch}-t*`,
  ]);
}

function branchExists(branch: string): boolean {
  return (
    git(project.folderPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]) !== ""
  );
}

describe("cleanup after a run ends", () => {
  test("removes the run and ticket worktrees and the ticket branches; keeps the run branch and files", async () => {
    const run = await endedRunWithWorktrees();
    expect(worktreeList()).toContain(run.id);

    const cleaned = await cleanUpDelivery(
      context.user,
      context.db,
      run.id,
      ok(runFolder(context.db, run)),
    );

    expect(cleaned).toEqual({
      cleaned: true,
      removedWorktrees: [run.worktreePath, ticketPath(run, "T1"), ticketPath(run, "T2")],
      deletedBranches: [ticketBranchName(run.branch, "T1"), ticketBranchName(run.branch, "T2")],
      failures: [],
    });
    expect(worktreeList()).not.toContain(run.id);
    expect(ticketRefs(run)).toBe("");
    expect(branchExists(run.branch)).toBe(true);
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(existsSync(join(dirname(run.worktreePath), "inputs", "spec.md"))).toBe(true);
    expect(existsSync(join(dirname(run.worktreePath), "inputs", "tickets.md"))).toBe(true);
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });

  test("deletes only the pinned tickets' branches: a `-tweak` or unpinned `-t9` sibling survives", async () => {
    const run = await endedRunWithWorktrees();
    git(project.folderPath, ["branch", `${run.branch}-tweak`, run.branch]);
    git(project.folderPath, ["branch", `${run.branch}-t9`, run.branch]);

    const cleaned = await cleanUpDelivery(
      context.user,
      context.db,
      run.id,
      ok(runFolder(context.db, run)),
    );

    if (!cleaned.cleaned) throw new Error("not cleaned");
    expect(cleaned.deletedBranches).toEqual([
      ticketBranchName(run.branch, "T1"),
      ticketBranchName(run.branch, "T2"),
    ]);
    expect(cleaned.failures).toEqual([]);
    expect(branchExists(`${run.branch}-tweak`)).toBe(true);
    expect(branchExists(`${run.branch}-t9`)).toBe(true);
  });

  test("a failing step adds a ZeNorm line naming the path, and the remaining steps run", async () => {
    const run = await endedRunWithWorktrees();
    const locked = ticketPath(run, "T1");
    git(project.folderPath, ["worktree", "lock", locked]);

    const cleaned = await cleanUpDelivery(
      context.user,
      context.db,
      run.id,
      ok(runFolder(context.db, run)),
    );

    if (!cleaned.cleaned) throw new Error("not cleaned");
    expect(cleaned.removedWorktrees).toEqual([run.worktreePath, ticketPath(run, "T2")]);
    expect(cleaned.deletedBranches).toEqual([ticketBranchName(run.branch, "T2")]);
    expect(cleaned.failures.map((failure) => failure.target)).toContain(locked);
    const lines = readRunEvents(context.db, run.id);
    expect(lines.length).toBe(cleaned.failures.length);
    expect(lines.every((line) => line.who === "zenorm" && line.ticket === null)).toBe(true);
    expect(lines.some((line) => line.text.includes(locked))).toBe(true);
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(existsSync(ticketPath(run, "T2"))).toBe(false);
    expect(branchExists(run.branch)).toBe(true);
    expect(branchExists(ticketBranchName(run.branch, "T2"))).toBe(false);
  });

  test("a run with no ticket rows (from before 0010) is left untouched, with no line", async () => {
    const run = await endedRunWithWorktrees();
    asPre0010Run(context, run.id);

    expect(
      await cleanUpDelivery(context.user, context.db, run.id, ok(runFolder(context.db, run))),
    ).toEqual({ cleaned: false });

    expect(existsSync(run.worktreePath)).toBe(true);
    expect(existsSync(ticketPath(run, "T1"))).toBe(true);
    expect(ticketRefs(run)).not.toBe("");
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });

  test("a run that failed before its worktree was added cleans up with no line", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    await endRun(context, run.id, { outcome: "failed" });

    expect(
      await cleanUpDelivery(context.user, context.db, run.id, ok(runFolder(context.db, run))),
    ).toEqual({
      cleaned: true,
      removedWorktrees: [],
      deletedBranches: [],
      failures: [],
    });
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });

  test("an active run is a programmer error", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);

    await expect(
      cleanUpDelivery(context.user, context.db, run.id, ok(runFolder(context.db, run))),
    ).rejects.toThrow();
  });
});
