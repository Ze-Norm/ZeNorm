import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { isDefinedError, safe } from "@orpc/client";
import type { DeliveryExecutor, ImplementEvent, ImplementRequest } from "@zenorm/contracts";
import { err, gitIdentityEnv, ok } from "@zenorm/contracts";
import { createChangeBus, ticketBranchName } from "@zenorm/core";
import { deliveryRuns } from "@zenorm/db";
import { describe, expect, test, vi } from "vitest";

import type { AppOptions } from "./app.ts";
import { EXECUTOR_STOP_BOUND_MS } from "./delivery.ts";
import {
  TICKETS,
  DELIVERY_WAIT,
  planningPorts,
  localExecutor,
  checked,
  appOf,
  root,
  db,
  webDistDir,
  log,
  surveyRequests,
  implementPort,
  app,
  client,
  clientOf,
  useApp,
  approvedSet,
  PULL_REQUEST_BODY,
  PASSING_CHECK,
  gitIn,
  verdictFor,
  startRun,
  firstSpecOf,
  runIn,
  cleanedUp,
  standInExecutor,
  useExecutor,
  clonePlugin,
  worktreesOf,
  hasRef,
  setUpAppTests,
} from "./app-test-support.ts";

setUpAppTests();

describe("delivery executors", () => {
  test("a resumed run starts from the failed run's branch, keeps its merged tickets and passes", async () => {
    // The first run merges every ticket, then its session is cut off: the case resume exists for.
    const requests: ImplementRequest[] = [];
    await useExecutor({
      name: "fails-after-t1",
      implementTicketSet: (request, _signal, onEvent) => {
        requests.push(request);
        const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
        const git = (args: readonly string[]) =>
          execFileSync("git", args, { cwd: request.worktreePath, env, encoding: "utf8" });
        for (const ticket of request.tickets) {
          if (request.merged.includes(ticket.id)) continue;
          onEvent({ kind: "ticket_started", ticket: ticket.id });
          const branch = ticketBranchName(request.branch, ticket.id);
          git(["checkout", "-q", "-b", branch]);
          git(["commit", "-q", "--allow-empty", "-m", `Ticket ${ticket.id}`]);
          git(["checkout", "-q", request.branch]);
          git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch]);
          onEvent({ kind: "ticket_merged", ticket: ticket.id, summary: `${ticket.id} done.` });
          if (requests.length === 1) {
            return Promise.resolve(
              err({
                code: "agent_not_logged_in",
                message: "The Claude Code CLI lost its login during the session.",
                data: {},
              }),
            );
          }
        }
        return Promise.resolve(ok(null));
      },
      reviewDelivery: (request) => Promise.resolve(ok(verdictFor(request.finalCommit, false))),
      writePullRequest: () => Promise.resolve(ok(PULL_REQUEST_BODY)),
    });
    const { project, mapId, ticketSetId } = await approvedSet();
    const [first] = TICKETS.tickets.map((ticket) => ticket.id);
    if (first === undefined) throw new Error("The set has no ticket");

    const failedRun = await startRun(ticketSetId, [PASSING_CHECK]);
    await runIn(mapId, failedRun.id, "failed", "implementing");
    await cleanedUp(failedRun);
    const head = gitIn(project.folderPath, ["rev-parse", failedRun.branch]);

    const resumed = await client.delivery.resume({ runId: failedRun.id });
    expect(resumed).toMatchObject({ number: 2, baseCommit: failedRun.baseCommit });
    const passed = await runIn(mapId, resumed.id, "passed", "reviewing");

    expect(requests[0]?.resumedFrom).toBeNull();
    expect(requests[1]?.merged).toEqual([first]);
    expect(requests[1]?.resumedFrom).toMatchObject({
      number: 1,
      failure: { code: "agent_not_logged_in" },
      failedChecks: [],
      blockingFindings: [],
    });
    expect(passed.tickets?.every((ticket) => ticket.status.state === "merged")).toBe(true);
    // The resumed branch grew from the failed run's head and holds each ticket's commit once.
    expect(gitIn(project.folderPath, ["merge-base", "--is-ancestor", head, resumed.branch])).toBe(
      "",
    );
    const subjects = gitIn(project.folderPath, ["log", "--format=%s", resumed.branch]).split("\n");
    expect(subjects.filter((subject) => subject === `Ticket ${first}`)).toHaveLength(1);

    const [notResumable] = await safe(client.delivery.resume({ runId: resumed.id }));
    expect(isDefinedError(notResumable) && notResumable.code).toBe("delivery_run_not_resumable");
  });

  test("a run through a stand-in executor ends passed, verified from git, with its worktrees removed", async () => {
    const calls: string[] = [];
    await useExecutor(standInExecutor(calls));
    const { project, mapId, ticketSetId } = await approvedSet();

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "reviewing");

    expect(calls).toEqual(["implement", "review"]);
    expect(implementPort.calls).toHaveLength(0);
    const { tickets } = passed;
    if (tickets === null) throw new Error("The passed run lists no tickets");
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((ticket) => ticket.status.state === "merged")).toBe(true);
    // The run branch holds each ticket's commit, merged in (the cleanup then removes the ticket
    // branches, as for "local").
    const subjects = gitIn(project.folderPath, ["log", "--format=%s", run.branch]).split("\n");
    for (const { ticket } of tickets) {
      expect(subjects).toContain(`Ticket ${ticket}`);
      expect(subjects).toContain(`Merge ${ticketBranchName(run.branch, ticket)}`);
    }
    await cleanedUp(run);
    expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
  });

  test("stop awaits an executor that ignores the abort at most 15 s, logs it and leaves the run running", async () => {
    let implementing: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      implementing = resolve;
    });
    await useExecutor({
      name: "deaf",
      implementTicketSet: () => {
        implementing();
        return new Promise(() => undefined);
      },
      reviewDelivery: () => new Promise(() => undefined),
      writePullRequest: () => new Promise(() => undefined),
    });
    const { ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await reached;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopping = app.stopDeliveryRuns();
      await vi.advanceTimersByTimeAsync(EXECUTOR_STOP_BOUND_MS);
      await stopping;
    } finally {
      vi.useRealTimers();
    }

    expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`"deaf".*${run.id}`)), null);
    const [stored] = db.select().from(deliveryRuns).all();
    expect(stored).toMatchObject({ id: run.id, endedAt: null, phase: "implementing" });
  });
});

describe("one folder per run, from the checkout seam", () => {
  test("a checkout that gives a clone gets a coherent run: worktree, merges, verifying, cleanup and Mark merged in the clone", async () => {
    const clone = join(await realpath(root), "clone");
    const calls: string[] = [];
    useApp(
      await appOf({
        db,
        bus: createChangeBus(log),
        webDistDir,
        log,
        ...planningPorts(),
        plugins: checked(
          [clonePlugin(clone)],
          [localExecutor(), standInExecutor(calls)],
          "stand-in",
        ),
      }),
    );
    const { project, mapId, ticketSetId } = await approvedSet();
    // The planning runs worked in the clone too: the survey was asked of it.
    expect(surveyRequests.map((request) => request.projectFolder)).toEqual([clone]);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    expect(run.executor).toBe("stand-in");
    const passed = await runIn(mapId, run.id, "passed", "reviewing");
    const lines = await cleanedUp(run);

    // The run branch and every ticket's merge are the clone's; the stored folder has none.
    expect(hasRef(clone, `refs/heads/${run.branch}`)).toBe(true);
    expect(hasRef(project.folderPath, `refs/heads/${run.branch}`)).toBe(false);
    const { tickets } = passed;
    if (tickets === null) throw new Error("The passed run lists no tickets");
    for (const { status } of tickets) {
      if (status.state !== "merged") throw new Error(`A ticket is ${status.state}`);
      expect(hasRef(clone, status.commit)).toBe(true);
      expect(hasRef(project.folderPath, status.commit)).toBe(false);
    }
    // Cleanup ran in the clone: no worktree or ticket branch is left, and no step failed.
    expect(worktreesOf(clone)).toEqual([clone]);
    expect(worktreesOf(project.folderPath)).toEqual([project.folderPath]);
    expect(gitIn(clone, ["for-each-ref", `refs/heads/${run.branch}-t*`])).toBe("");
    const texts = lines.map((line) => line.text);
    expect(texts.filter((text) => /could not/i.test(text))).toEqual([]);
    // The executor-neutral words.
    expect(
      texts.filter((text) => text.endsWith(' Starting the executor "stand-in".')),
    ).toHaveLength(1);
    expect(texts.filter((text) => text.includes("Claude Code"))).toEqual([]);

    // Mark merged reads the clone: the final commit is in its main, not the stored folder's.
    gitIn(clone, ["merge", "-q", "--no-ff", "-m", "Merge the run", run.branch]);
    const merged = await client.delivery.markMerged({ runId: run.id });
    expect(merged.mergedAt).not.toBeNull();
    expect(hasRef(project.folderPath, run.branch)).toBe(false);
  });

  test("after a restart, Cancel resolves the folder again through the checkout and cleans up in the clone", async () => {
    const clone = join(await realpath(root), "clone");
    let implementing: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      implementing = resolve;
    });
    const hanging: DeliveryExecutor = {
      name: "hanging",
      implementTicketSet: () => {
        implementing();
        return new Promise(() => undefined);
      },
      reviewDelivery: () => new Promise(() => undefined),
      writePullRequest: () => new Promise(() => undefined),
    };
    const options = (): AppOptions => ({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked([clonePlugin(clone)], [localExecutor(), hanging], "hanging"),
    });
    useApp(await appOf(options()));
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await reached;
    const worktree = join(root, "runs", run.id, "worktree");
    expect(worktreesOf(clone)).toContain(await realpath(worktree));
    expect(worktreesOf(project.folderPath)).toEqual([project.folderPath]);

    // A restarted app holds no run: the run reads interrupted, and its Cancel cleans it up.
    const restarted = clientOf(await appOf(options()));
    await vi.waitFor(async () => {
      const { specs } = await restarted.map.overview({ mapId });
      expect(firstSpecOf(specs).runs[0]?.state).toBe("interrupted");
    }, DELIVERY_WAIT);
    expect((await restarted.delivery.cancel({ runId: run.id })).state).toBe("cancelled");

    expect(existsSync(worktree)).toBe(false);
    expect(worktreesOf(clone)).toEqual([clone]);
    const lines = await restarted.delivery.activity({ runId: run.id });
    expect(lines.at(-1)?.text).toBe(
      `The worktrees were deleted. The branch ${run.branch} is kept.`,
    );
    expect(lines.map((line) => line.text).filter((text) => /could not/i.test(text))).toEqual([]);
  });
});

describe("a person's Cancel of a deaf executor", () => {
  test("the runner waits 15 s, logs, cleans up and lets go; a later event is ignored with a line", async () => {
    const executor: { onEvent: ((event: ImplementEvent) => void) | null } = { onEvent: null };
    await useExecutor({
      name: "deaf",
      implementTicketSet: (_request, _signal, onEvent) => {
        executor.onEvent = onEvent;
        return new Promise(() => undefined);
      },
      reviewDelivery: () => new Promise(() => undefined),
      writePullRequest: () => new Promise(() => undefined),
    });
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await vi.waitFor(() => {
      expect(executor.onEvent).not.toBeNull();
    }, DELIVERY_WAIT);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cancelled = await client.delivery.cancel({ runId: run.id });
      expect(cancelled.state).toBe("cancelled");
      await vi.advanceTimersByTimeAsync(EXECUTOR_STOP_BOUND_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`"deaf".*${run.id}`)), null);
    const lines = await cleanedUp(run);
    // Off `"local"` the cancel line names no signal.
    expect(lines.map((line) => line.text)).toContain(
      "You cancelled the run. The executor was told to stop.",
    );
    expect((await runIn(mapId, run.id, "cancelled", "implementing")).id).toBe(run.id);
    const { onEvent } = executor;
    if (onEvent === null) throw new Error("The deaf executor was not called");
    onEvent({ kind: "line", who: "orchestrator", ticket: null, text: "Still working." });
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining(run.id), null);
    expect(await client.delivery.activity({ runId: run.id })).toEqual(lines);
  });
});
