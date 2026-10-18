import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImplementEvent, ImplementRequest } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ticketBranchName } from "@zenorm/plugin-sdk";

import { EXAMPLE_PULL_REQUEST_BODY, exampleExecutor, repairFile } from "./executor.ts";
import type { ExecutorCalls } from "./executor.ts";
import { EXAMPLE_EXECUTOR, EXAMPLE_EXECUTOR_LINE } from "./manifest.ts";

const RUN_BRANCH = "zenorm/example-run";
const IDENTITY = { name: "ZeNorm example", email: "example@zenorm.invalid" };

let root: string;
let repo: string;
let worktree: string;
let baseCommit: string;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function isAncestor(ancestor: string, of: string): boolean {
  try {
    git(repo, ["merge-base", "--is-ancestor", ancestor, of]);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-example-executor-"));
  repo = join(root, "repo");
  worktree = join(root, "worktree");
  git(root, ["init", "-q", "-b", "main", repo]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  baseCommit = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", RUN_BRANCH, worktree, baseCommit]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function request(): ImplementRequest {
  return {
    runDir: join(root, "run"),
    worktreePath: worktree,
    branch: RUN_BRANCH,
    baseCommit,
    specPath: join(root, "run", "spec.md"),
    ticketsPath: join(root, "run", "tickets.md"),
    ticketCount: 2,
    tickets: [
      { id: "T1", title: "First ticket" },
      { id: "T2", title: "Second ticket" },
    ],
    merged: [],
    resumedFrom: null,
    repair: null,
    checks: ["git status --short"],
    fixCommands: [],
    gitIdentity: IDENTITY,
  };
}

describe("the example executor", () => {
  test("given a repair attempt, it merges no ticket and commits the attempt's file on the run branch", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    const executor = exampleExecutor(calls);
    const events: ImplementEvent[] = [];
    const check = `git ls-files --error-unmatch ${repairFile(1)}`;

    const result = await executor.implementTicketSet(
      {
        ...request(),
        merged: ["T1", "T2"],
        repair: {
          attempt: 1,
          limit: 2,
          failedChecks: [
            {
              result: {
                command: check,
                exitCode: 1,
                timedOut: false,
                durationMs: 3,
                outputTail: "did not match any file",
              },
              logPath: join(root, "run", "checks", "check-1.log"),
            },
          ],
        },
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(events.every((event) => event.kind === "line")).toBe(true);
    expect(git(repo, ["branch", "--list", `${RUN_BRANCH}-t*`])).toBe("");
    expect(git(repo, ["rev-list", "--count", `${baseCommit}..${RUN_BRANCH}`])).toBe("1");
    expect(git(repo, ["show", `${RUN_BRANCH}:${repairFile(1)}`])).toBe(check);
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
    expect(calls).toEqual({ implement: 1, review: 0 });
  });

  test("a resumed run's merged tickets are not implemented again", async () => {
    const events: ImplementEvent[] = [];

    const result = await exampleExecutor({ implement: 0, review: 0 }).implementTicketSet(
      { ...request(), merged: ["T1"] },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(events.filter((event) => event.kind !== "line").map((event) => event.ticket)).toEqual([
      "T2",
      "T2",
    ]);
  });

  test("commits each ticket on its branch and merges it before ticket_merged, in order", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    const executor = exampleExecutor(calls);
    expect(executor.name).toBe(EXAMPLE_EXECUTOR);
    const events: ImplementEvent[] = [];
    const mergedAtEvent: boolean[] = [];

    const result = await executor.implementTicketSet(
      request(),
      new AbortController().signal,
      (event) => {
        events.push(event);
        if (event.kind === "ticket_merged") {
          // The runner reads the ticket branch when the event arrives.
          mergedAtEvent.push(isAncestor(ticketBranchName(RUN_BRANCH, event.ticket), RUN_BRANCH));
        }
      },
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(events.map((event) => event.kind)).toEqual([
      "line",
      "ticket_started",
      "ticket_merged",
      "ticket_started",
      "ticket_merged",
    ]);
    expect(events[0]).toEqual({
      kind: "line",
      who: "orchestrator",
      ticket: null,
      text: EXAMPLE_EXECUTOR_LINE,
    });
    expect(events.filter((event) => event.kind !== "line").map((event) => event.ticket)).toEqual([
      "T1",
      "T1",
      "T2",
      "T2",
    ]);
    expect(mergedAtEvent).toEqual([true, true]);

    // The ticket branches are kept; each holds its one file's commit, by the run's identity.
    expect(
      git(repo, ["branch", "--list", `${RUN_BRANCH}-t*`])
        .split("\n")
        .map((line) => line.trim()),
    ).toEqual([`${RUN_BRANCH}-t1`, `${RUN_BRANCH}-t2`]);
    expect(git(repo, ["log", "-1", "--format=%an <%ae>|%s", `${RUN_BRANCH}-t2`])).toBe(
      `${IDENTITY.name} <${IDENTITY.email}>|T2: Second ticket`,
    );
    expect(git(repo, ["show", `${RUN_BRANCH}:example-executor/T1.txt`])).toBe("T1: First ticket");
    // Two merges with --no-ff on the run branch, and a clean worktree on it.
    expect(git(repo, ["rev-list", "--merges", "--count", `${baseCommit}..${RUN_BRANCH}`])).toBe(
      "2",
    );
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(RUN_BRANCH);
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
    expect(calls).toEqual({ implement: 1, review: 0 });
  });

  test("an abort between tickets ends agent_cancelled with the later tickets not started", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    const controller = new AbortController();
    const events: ImplementEvent[] = [];

    const result = await exampleExecutor(calls).implementTicketSet(
      request(),
      controller.signal,
      (event) => {
        events.push(event);
        if (event.kind === "ticket_merged") controller.abort();
      },
    );

    expect(result.ok ? null : result.error.code).toBe("agent_cancelled");
    expect(events.map((event) => event.kind)).toEqual(["line", "ticket_started", "ticket_merged"]);
    expect(git(repo, ["branch", "--list", `${RUN_BRANCH}-t2`])).toBe("");
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
  });

  test("a git step that fails is agent_run_failed", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    // The first ticket's branch already exists, so `checkout -b` fails.
    git(repo, ["branch", ticketBranchName(RUN_BRANCH, "T1"), baseCommit]);

    const result = await exampleExecutor(calls).implementTicketSet(
      request(),
      new AbortController().signal,
      () => undefined,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_run_failed");
  });

  test("its review passes the final commit with no findings", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    const finalCommit = git(worktree, ["rev-parse", "HEAD"]);

    const verdict = await exampleExecutor(calls).reviewDelivery(
      {
        runDir: join(root, "run"),
        worktreePath: worktree,
        baseCommit,
        finalCommit,
        specPath: join(root, "run", "spec.md"),
        ticketsPath: join(root, "run", "tickets.md"),
        diffPath: join(root, "run", "diff.patch"),
        changedFiles: [],
        checkResults: [],
        gitIdentity: IDENTITY,
      },
      new AbortController().signal,
    );

    expect(verdict.ok && verdict.value.reviewedCommit).toBe(finalCommit);
    expect(verdict.ok && verdict.value.findings).toEqual([]);
    expect(calls).toEqual({ implement: 0, review: 1 });
  });

  test("its pull request writer returns the fixed body, at the Summary heading", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    const finalCommit = git(worktree, ["rev-parse", "HEAD"]);

    const body = await exampleExecutor(calls).writePullRequest(
      {
        runDir: join(root, "run"),
        worktreePath: worktree,
        baseCommit,
        finalCommit,
        specPath: join(root, "run", "spec.md"),
        ticketsPath: join(root, "run", "tickets.md"),
        diffPath: join(root, "run", "diff.patch"),
        changedFiles: [],
        implementerReports: [{ ticket: "T1", report: null }],
        checkResults: [],
        verdict: { reviewedCommit: finalCommit, summary: "Fine.", findings: [] },
        capture: { kind: "no_visible_change" },
        gitIdentity: IDENTITY,
      },
      new AbortController().signal,
    );

    expect(body).toEqual({
      ok: true,
      value: { body: EXAMPLE_PULL_REQUEST_BODY, visibleChange: false },
    });
    expect(EXAMPLE_PULL_REQUEST_BODY.startsWith("## Why\n")).toBe(true);
    expect(EXAMPLE_PULL_REQUEST_BODY).toContain("## Tests");
    expect(EXAMPLE_PULL_REQUEST_BODY).toContain("## Risks");
    expect(calls).toEqual({ implement: 0, review: 0 });
  });

  test("its screen picker reports no visible change", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };
    const finalCommit = git(worktree, ["rev-parse", "HEAD"]);

    const picked = await exampleExecutor(calls).pickScreens(
      {
        runDir: join(root, "run"),
        worktreePath: worktree,
        baseCommit,
        finalCommit,
        specPath: join(root, "run", "spec.md"),
        diffPath: join(root, "run", "diff.patch"),
        changedFiles: [],
        gitIdentity: IDENTITY,
      },
      new AbortController().signal,
    );

    expect(picked).toEqual({ ok: true, value: { kind: "no_visible_change" } });
    expect(calls).toEqual({ implement: 0, review: 0 });
  });

  test("its capture returns no images", async () => {
    const calls: ExecutorCalls = { implement: 0, review: 0 };

    const captured = await exampleExecutor(calls).captureScreens(
      {
        runDir: join(root, "run"),
        worktreePath: worktree,
        appUrl: "http://localhost:5173",
        screens: [{ where: "/", changed: "A new heading.", isNew: false }],
        screenshotsDir: join(root, "run", "screenshots"),
        gitIdentity: IDENTITY,
      },
      new AbortController().signal,
    );

    expect(captured).toEqual({ ok: true, value: { images: [], skipped: [] } });
    expect(calls).toEqual({ implement: 0, review: 0 });
  });
});
