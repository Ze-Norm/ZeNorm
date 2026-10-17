import { existsSync } from "node:fs";
import { join } from "node:path";

import { isDefinedError, safe } from "@orpc/client";
import { createChangeBus, write } from "@zenorm/core";
import { deliveryRuns } from "@zenorm/db";
import { describe, expect, test, vi } from "vitest";

import {
  UNKNOWN_ID,
  TICKETS_PASSED,
  TICKETS,
  DELIVERY_WAIT,
  nthCall,
  planningPorts,
  appOf,
  root,
  db,
  webDistDir,
  log,
  ticketSetPort,
  ticketsReviewPort,
  implementPort,
  reviewPort,
  client,
  clientOf,
  clearedMapIn,
  overviewWhen,
  firstSpec,
  reviewedSpec,
  approvedSet,
  DELIVERED_FILE,
  PASSING_CHECK,
  FAILING_CHECK,
  gitIn,
  commitDelivery,
  verdictFor,
  startRun,
  deliveryRun,
  firstSpecOf,
  runIn,
  cleanedUp,
  ticketRefs,
  setUpAppTests,
} from "./app-test-support.ts";

setUpAppTests();

describe("delivery over /rpc", () => {
  test("a run goes preparing, implementing, verifying, reviewing, then passed with its evidence", async () => {
    const { project, mapId, specificationId, ticketSetId } = await approvedSet();
    const baseCommit = gitIn(project.folderPath, ["rev-parse", "main"]);
    const checks = [PASSING_CHECK, "sleep 0.5"];

    const started = await startRun(ticketSetId, checks);
    expect(started).toMatchObject({
      ticketSetId,
      number: 1,
      branch: `zenorm/dark-mode-${specificationId.slice(-8)}-run-1`,
      baseBranch: "main",
      baseCommit,
      checks,
      endedAt: null,
      mergedAt: null,
      state: "running",
      phase: "preparing",
    });
    expect(started).not.toHaveProperty("worktreePath");
    const worktreePath = join(root, "runs", started.id, "worktree");

    const implement = await nthCall(implementPort.calls, 0);
    expect((await deliveryRun(mapId, started.id)).phase).toBe("implementing");
    const running = await client.map.overview({ mapId });
    expect(running.status.stages[4]).toMatchObject({ stage: "delivery", tone: "working" });
    expect(running.status.group).toBe("working");
    const runDir = join(root, "runs", started.id);
    expect(implement.request).toEqual({
      runDir,
      worktreePath,
      branch: started.branch,
      baseCommit,
      specPath: join(runDir, "inputs", "spec.md"),
      ticketsPath: join(runDir, "inputs", "tickets.md"),
      ticketCount: TICKETS.tickets.length,
      tickets: TICKETS.tickets.map((ticket) => ({ id: ticket.id, title: ticket.title })),
      merged: [],
      resumedFrom: null,
      repair: null,
      checks,
      fixCommands: [],
      gitIdentity: { name: "ZeNorm delivery", email: `run-${started.id}@zenorm.invalid` },
    });
    expect(implement.signal.aborted).toBe(false);

    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    await runIn(mapId, started.id, "running", "verifying");
    const review = await nthCall(reviewPort.calls, 0);
    expect((await deliveryRun(mapId, started.id)).phase).toBe("reviewing");
    expect(review.request).toMatchObject({
      runDir,
      worktreePath,
      baseCommit,
      finalCommit,
      diffPath: join(runDir, "review.diff"),
      changedFiles: [DELIVERED_FILE],
    });
    expect(review.request.checkResults.map((result) => result.exitCode)).toEqual([0, 0]);

    const verdict = verdictFor(finalCommit, false);
    review.resolve({ ok: true, value: verdict });
    const passed = await runIn(mapId, started.id, "passed", "reviewing");
    await cleanedUp(started);
    const { status } = await client.map.overview({ mapId });
    // A passed, unmerged run awaits Mark merged.
    expect(status.stages[4]).toMatchObject({ stage: "delivery", tone: "needs-you" });
    expect(status.group).toBe("needs-you");
    expect(status.next[0]?.label).toBe("Mark merged");
    expect(passed).toMatchObject({ finalCommit, verdict, failure: null });
    expect(passed.endedAt).not.toBeNull();
    expect(passed.checkResults?.map((result) => result.command)).toEqual(checks);
    expect(gitIn(project.folderPath, ["rev-parse", started.branch])).toBe(finalCommit);
    expect(log).not.toHaveBeenCalled();
  });

  test("a blocking finding ends blocked; a verdict naming another commit is delivery_verdict_invalid", async () => {
    const { mapId, ticketSetId } = await approvedSet();

    const first = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement1 = await nthCall(implementPort.calls, 0);
    const final1 = await commitDelivery(implement1.request);
    implement1.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({ ok: true, value: verdictFor(final1, true) });
    const blocked = await runIn(mapId, first.id, "blocked", "reviewing");
    expect(blocked).toMatchObject({ finalCommit: final1, verdict: verdictFor(final1, true) });
    expect(blocked.checkResults).toHaveLength(1);
    await cleanedUp(first);

    const second = await startRun(ticketSetId, [PASSING_CHECK]);
    expect(second.number).toBe(2);
    const implement2 = await nthCall(implementPort.calls, 1);
    const final2 = await commitDelivery(implement2.request);
    implement2.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 1)).resolve({
      ok: true,
      value: verdictFor(second.baseCommit, false),
    });
    const failed = await runIn(mapId, second.id, "failed", "reviewing");
    expect(failed.failure).toMatchObject({ code: "delivery_verdict_invalid" });
    expect(failed).toMatchObject({ finalCommit: final2, verdict: null });
    expect(failed.checkResults).toHaveLength(1);
    // After a blocked and a failed end the worktrees and ticket branches are gone.
    await cleanedUp(second);
    const [project] = await client.project.list();
    if (project === undefined) throw new Error("No project is stored");
    expect(ticketRefs(project.folderPath, first.branch)).toBe("");
    expect(ticketRefs(project.folderPath, second.branch)).toBe("");
    expect(gitIn(project.folderPath, ["rev-parse", second.branch])).toBe(final2);
    expect(log).not.toHaveBeenCalled();
  });

  test("no commits fails verifying before any check; a failing check is delivery_checks_failed", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const marker = join(root, "check-ran");

    const first = await startRun(ticketSetId, [`touch ${marker}`, PASSING_CHECK]);
    (await nthCall(implementPort.calls, 0)).resolve({ ok: true, value: null });
    const noCommits = await runIn(mapId, first.id, "failed", "verifying");
    expect(noCommits.failure).toMatchObject({ code: "delivery_no_commits" });
    expect(noCommits).toMatchObject({ finalCommit: null, checkResults: null });
    await cleanedUp(first);
    expect(existsSync(marker)).toBe(false);
    expect(reviewPort.calls).toHaveLength(0);

    const checks = [FAILING_CHECK, PASSING_CHECK];
    const second = await startRun(ticketSetId, checks);
    const implement = await nthCall(implementPort.calls, 1);
    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    const checksFailed = await runIn(mapId, second.id, "failed", "verifying");
    expect(checksFailed.failure).toMatchObject({ code: "delivery_checks_failed" });
    expect(checksFailed.failure?.message).toContain(FAILING_CHECK);
    expect(checksFailed.finalCommit).toBe(finalCommit);
    await cleanedUp(second);
    expect(checksFailed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
      [FAILING_CHECK, 128],
      [PASSING_CHECK, 0],
    ]);
    // A repair limit of 0: no repair attempt, so no second implement call.
    expect(checksFailed).toMatchObject({ repairLimit: 0, repairAttempts: 0 });
    expect(implementPort.calls).toHaveLength(2);
    expect(reviewPort.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("an orchestrator code ends the run failed with that code in phase implementing", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    (await nthCall(implementPort.calls, 0)).resolve({
      ok: false,
      error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
    });

    const failed = await runIn(mapId, run.id, "failed", "implementing");
    expect(failed.failure).toEqual({
      code: "agent_not_logged_in",
      message: "Not logged in",
    });
    expect(failed).toMatchObject({ finalCommit: null, checkResults: null, verdict: null });
    await cleanedUp(run);
    expect(log).not.toHaveBeenCalled();
  });

  test("Cancel ends a running run at once and a late result writes nothing", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({
      id: run.id,
      state: "cancelled",
      phase: "implementing",
      failure: null,
      verdict: null,
      executor: "local",
    });
    expect(cancelled.endedAt).not.toBeNull();
    expect(implement.signal.aborted).toBe(true);
    // `"local"`'s wording is as before.
    const texts = (await client.delivery.activity({ runId: run.id })).map((line) => line.text);
    expect(texts.filter((text) => text.endsWith(" Starting Claude Code."))).toHaveLength(1);
    expect(texts).toContain("You cancelled the run. The executor was sent SIGTERM.");

    implement.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    await vi.waitFor(async () => {
      expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    }, DELIVERY_WAIT);
    // Once the abort settles the runner removes the worktree and keeps the branch.
    await vi.waitFor(() => {
      expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
    }, DELIVERY_WAIT);
    expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);

    const [again] = await safe(client.delivery.cancel({ runId: run.id }));
    expect(isDefinedError(again) && again.code).toBe("delivery_run_ended");
    expect(isDefinedError(again) && again.status).toBe(409);
    const [missing] = await safe(client.delivery.cancel({ runId: UNKNOWN_ID }));
    expect(isDefinedError(missing) && missing.code).toBe("delivery_run_not_found");
    expect(isDefinedError(missing) && missing.status).toBe(404);
    expect(reviewPort.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("Cancel returns the driver's stored end when it lands between the read and the cancel write", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const failure = { code: "agent_run_failed", message: "The agent's run failed" } as const;

    // The cancel's guarded end write is the next transaction: the driver waits on the port. Just
    // before it, the driver's own end lands (this database holds this one run).
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((cancelWrite, config) => {
      // Test data standing in for the driver's end, so `system` is acceptable here.
      write(db, { kind: "system" }, (tx) =>
        tx.update(deliveryRuns).set({ endedAt: new Date().toISOString(), failure }).run(),
      );
      return transaction(cancelWrite, config);
    });
    const answer = await client.delivery.cancel({ runId: run.id });

    expect(answer).toMatchObject({ id: run.id, state: "failed", phase: "implementing", failure });
    expect(await deliveryRun(mapId, run.id)).toMatchObject(answer);

    implement.resolve({
      ok: false,
      error: { code: "agent_run_failed", message: "x", data: { exitCode: 1, subtype: null } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await deliveryRun(mapId, run.id)).toMatchObject(answer);
    expect(log).not.toHaveBeenCalled();
  });

  test("delivery.start refuses an active, passed, unknown or unapproved ticket set", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    await startRun(ticketSetId, [PASSING_CHECK]);
    const [inProgress] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(inProgress) && inProgress.code).toBe("delivery_in_progress");
    expect(isDefinedError(inProgress) && inProgress.status).toBe(409);

    const implement = await nthCall(implementPort.calls, 0);
    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    const [first] = firstSpecOf((await client.map.overview({ mapId })).specs).runs;
    if (first === undefined) throw new Error("No run is stored");
    await runIn(mapId, first.id, "passed", "reviewing");
    const [alreadyPassed] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(alreadyPassed) && alreadyPassed.code).toBe("delivery_already_passed");
    expect(isDefinedError(alreadyPassed) && alreadyPassed.status).toBe(409);

    const [unknown] = await safe(client.delivery.start({ ticketSetId: UNKNOWN_ID }));
    expect(isDefinedError(unknown) && unknown.code).toBe("ticket_set_not_found");
    expect(isDefinedError(unknown) && unknown.status).toBe(404);

    // A second map whose ticket set is drafted but not approved.
    const [project] = await client.project.list();
    if (project === undefined) throw new Error("No project is stored");
    const map = { id: await clearedMapIn(project, "Light mode") };
    const specRevisionId = await reviewedSpec(map.id, 1);
    await client.spec.approve({ specRevisionId });
    (await nthCall(ticketSetPort.calls, 1)).resolve({ ok: true, value: TICKETS });
    (await nthCall(ticketsReviewPort.calls, 1)).resolve({ ok: true, value: TICKETS_PASSED });
    const written = await overviewWhen(
      map.id,
      (read) => firstSpec(read).ticketSets[0]?.state === "review_passed",
    );
    const [drafted] = firstSpec(written).ticketSets;
    if (drafted === undefined) throw new Error("No ticket set");
    const [notApproved] = await safe(client.delivery.start({ ticketSetId: drafted.id }));
    expect(isDefinedError(notApproved) && notApproved.code).toBe("ticket_set_not_approved");
    expect(isDefinedError(notApproved) && notApproved.status).toBe(409);
    expect(firstSpecOf((await client.map.overview({ mapId: map.id })).specs).runs).toEqual([]);
    expect(implementPort.calls).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  test("a throwing port is logged and stored as delivery_internal_error", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const thrown = new Error("boom");
    (await nthCall(implementPort.calls, 0)).reject(thrown);

    const failed = await runIn(mapId, run.id, "failed", "implementing");
    expect(failed.failure).toMatchObject({ code: "delivery_internal_error" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toBe(thrown);
  });

  test("a new app over the same database reads an active run as interrupted, and Cancel ends it", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);

    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    const { specs } = await restarted.map.overview({ mapId });
    expect(firstSpecOf(specs).runs).toMatchObject([
      { ...run, state: "interrupted", phase: "implementing" },
    ]);

    const cancelled = await restarted.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "implementing" });
    // The first app's run was never aborted; its late result loses to the guarded cancel.
    expect(implement.signal.aborted).toBe(false);
    implement.resolve({
      ok: false,
      error: {
        code: "agent_run_failed",
        message: "Exited 1",
        data: { exitCode: 1, subtype: null },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    expect(log).not.toHaveBeenCalled();
  });
});
