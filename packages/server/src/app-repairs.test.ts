import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ImplementRequest } from "@zenorm/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  TICKETS_PASSED,
  TICKETS,
  DELIVERY_WAIT,
  nthCall,
  root,
  log,
  ticketSetPort,
  ticketsReviewPort,
  implementPort,
  reviewPort,
  client,
  clearedMapIn,
  overviewWhen,
  firstSpec,
  reviewedSpec,
  approvedSet,
  PASSING_CHECK,
  FAILING_CHECK,
  commitDelivery,
  verdictFor,
  startRun,
  startRunWithRepairs,
  deliveryRun,
  runIn,
  cleanedUp,
  useExecutor,
  REPAIR_FILE,
  REPAIRED_CHECK,
  commitRepair,
  activityTexts,
  repairingExecutor,
  setUpAppTests,
} from "./app-test-support.ts";

setUpAppTests();

describe("repairs of failing checks", () => {
  test("a check failing until a repair commit passes after one attempt, the run implementing during it with its pinned limit", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [PASSING_CHECK, REPAIRED_CHECK], 2);
    expect(run).toMatchObject({ repairLimit: 2, repairAttempts: 0 });
    const runDir = join(root, "runs", run.id);

    const first = await nthCall(implementPort.calls, 0);
    expect(first.request.repair).toBeNull();
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });

    const repair = await nthCall(implementPort.calls, 1);
    expect(repair.request).toMatchObject({
      merged: TICKETS.tickets.map((ticket) => ticket.id),
      resumedFrom: null,
      repair: {
        attempt: 1,
        limit: 2,
        failedChecks: [
          {
            result: { command: REPAIRED_CHECK, exitCode: 1, timedOut: false },
            logPath: join(runDir, "checks", "check-2.log"),
          },
        ],
      },
    });
    expect(repair.request.repair?.failedChecks[0]?.result.outputTail).toContain(REPAIR_FILE);
    // During the attempt the run is implementing, its attempt counted against its pinned limit,
    // which a settings change does not move.
    expect(await deliveryRun(mapId, run.id)).toMatchObject({
      state: "running",
      phase: "implementing",
      repairLimit: 2,
      repairAttempts: 1,
    });
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK],
      repairLimit: 5,
      fixCommands: [],
    });
    expect((await deliveryRun(mapId, run.id)).repairLimit).toBe(2);

    const finalCommit = await commitRepair(repair.request, REPAIR_FILE);
    repair.resolve({ ok: true, value: null });
    const review = await nthCall(reviewPort.calls, 0);
    expect(review.request.finalCommit).toBe(finalCommit);
    expect(review.request.checkResults.map((result) => result.exitCode)).toEqual([0, 0]);
    review.resolve({ ok: true, value: verdictFor(finalCommit, false) });

    const passed = await runIn(mapId, run.id, "passed", "reviewing");
    expect(passed).toMatchObject({ finalCommit, repairLimit: 2, repairAttempts: 1 });
    expect(passed.checkResults?.map((result) => result.exitCode)).toEqual([0, 0]);
    await cleanedUp(run);
    const attempts = (await activityTexts(run.id)).filter((text) =>
      text.startsWith("Repair attempt "),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/^Repair attempt 1 of 2: /);
    expect(attempts[0]).toContain(REPAIRED_CHECK);
    expect(implementPort.calls).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test("a check that keeps failing ends delivery_checks_failed once the limit is spent, each attempt given the output and log paths", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [REPAIRED_CHECK, PASSING_CHECK], 2);
    const runDir = join(root, "runs", run.id);

    const first = await nthCall(implementPort.calls, 0);
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    for (const attempt of [1, 2]) {
      const call = await nthCall(implementPort.calls, attempt);
      expect(call.request.repair).toMatchObject({
        attempt,
        limit: 2,
        failedChecks: [
          {
            result: { command: REPAIRED_CHECK, exitCode: 1 },
            logPath: join(runDir, "checks", "check-1.log"),
          },
        ],
      });
      expect(call.request.repair?.failedChecks[0]?.result.outputTail).toContain(REPAIR_FILE);
      await commitRepair(call.request, `attempt-${String(attempt)}.txt`);
      call.resolve({ ok: true, value: null });
    }

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_checks_failed" });
    expect(failed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
      [REPAIRED_CHECK, 1],
      [PASSING_CHECK, 0],
    ]);
    expect(failed).toMatchObject({ repairLimit: 2, repairAttempts: 2 });
    await cleanedUp(run);
    expect(implementPort.calls).toHaveLength(3);
    expect(reviewPort.calls).toHaveLength(0);
    const attempts = (await activityTexts(run.id)).filter((text) =>
      text.startsWith("Repair attempt "),
    );
    expect(attempts.map((text) => text.slice(0, "Repair attempt 1 of 2".length))).toEqual([
      "Repair attempt 1 of 2",
      "Repair attempt 2 of 2",
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("a repair that adds no commit ends delivery_no_commits without rerunning the checks", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 3);

    const first = await nthCall(implementPort.calls, 0);
    const firstFinal = await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    (await nthCall(implementPort.calls, 1)).resolve({ ok: true, value: null });

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_no_commits" });
    expect(failed).toMatchObject({ finalCommit: firstFinal, repairAttempts: 1 });
    await cleanedUp(run);
    const checkLines = (await activityTexts(run.id)).filter((text) =>
      text.startsWith(`\`${FAILING_CHECK}\``),
    );
    expect(checkLines).toHaveLength(1);
    expect(implementPort.calls).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test("a dirty worktree or a failed session during a repair ends the run with that code, not another attempt", async () => {
    const { mapId, ticketSetId } = await approvedSet();

    const dirty = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 3);
    const first = await nthCall(implementPort.calls, 0);
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    const dirtyRepair = await nthCall(implementPort.calls, 1);
    await commitRepair(dirtyRepair.request, "fix.txt");
    await writeFile(join(dirtyRepair.request.worktreePath, "stray.txt"), "stray\n");
    dirtyRepair.resolve({ ok: true, value: null });
    const dirtyEnd = await runIn(mapId, dirty.id, "failed", "verifying");
    expect(dirtyEnd.failure).toMatchObject({ code: "delivery_worktree_dirty" });
    expect(dirtyEnd.repairAttempts).toBe(1);
    await cleanedUp(dirty);

    const session = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 3);
    const second = await nthCall(implementPort.calls, 2);
    await commitDelivery(second.request);
    second.resolve({ ok: true, value: null });
    (await nthCall(implementPort.calls, 3)).resolve({
      ok: false,
      error: {
        code: "agent_run_failed",
        message: "Exited 1",
        data: { exitCode: 1, subtype: null },
      },
    });
    const sessionEnd = await runIn(mapId, session.id, "failed", "implementing");
    expect(sessionEnd.failure).toMatchObject({ code: "agent_run_failed" });
    expect(sessionEnd.repairAttempts).toBe(1);
    await cleanedUp(session);
    expect(implementPort.calls).toHaveLength(4);
    expect(log).not.toHaveBeenCalled();
  });

  test("a cancel during a repair attempt reads as cancelled while implementing", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 1);
    const first = await nthCall(implementPort.calls, 0);
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    const repair = await nthCall(implementPort.calls, 1);
    await runIn(mapId, run.id, "running", "implementing");

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({
      state: "cancelled",
      phase: "implementing",
      repairAttempts: 1,
    });
    expect(repair.signal.aborted).toBe(true);
    expect(await activityTexts(run.id)).toContain(
      "You cancelled the run. The executor was sent SIGTERM.",
    );
    repair.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    await vi.waitFor(() => {
      expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
    }, DELIVERY_WAIT);
    expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    expect(log).not.toHaveBeenCalled();
  });

  test("through an executor that is not local: a repair commit passes the run, and a spent limit fails it", async () => {
    const requests: ImplementRequest[] = [];
    await useExecutor(repairingExecutor(requests));
    const { mapId, ticketSetId } = await approvedSet();

    const repaired = await startRunWithRepairs(
      ticketSetId,
      [PASSING_CHECK, "git ls-files --error-unmatch repair-1.txt"],
      1,
    );
    const passed = await runIn(mapId, repaired.id, "passed", "reviewing");
    expect(passed).toMatchObject({ repairLimit: 1, repairAttempts: 1 });
    expect(requests.map((request) => request.repair?.attempt)).toEqual([undefined, 1]);
    expect(requests[1]?.merged).toEqual(TICKETS.tickets.map((ticket) => ticket.id));
    await cleanedUp(repaired);

    // A second map's set, whose check looks for a file no attempt within the limit commits.
    const [project] = await client.project.list();
    if (project === undefined) throw new Error("No project is stored");
    const other = await clearedMapIn(project, "Light mode");
    const specRevisionId = await reviewedSpec(other, 1);
    await client.spec.approve({ specRevisionId });
    (await nthCall(ticketSetPort.calls, 1)).resolve({ ok: true, value: TICKETS });
    (await nthCall(ticketsReviewPort.calls, 1)).resolve({ ok: true, value: TICKETS_PASSED });
    const written = await overviewWhen(
      other,
      (read) => firstSpec(read).ticketSets[0]?.state === "review_passed",
    );
    const [set] = firstSpec(written).ticketSets;
    if (set === undefined) throw new Error("No ticket set");
    await client.ticketSet.approve({ ticketSetId: set.id });
    const spent = await startRunWithRepairs(
      set.id,
      ["git ls-files --error-unmatch repair-3.txt"],
      2,
    );
    const failed = await runIn(other, spent.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_checks_failed" });
    expect(failed).toMatchObject({ repairLimit: 2, repairAttempts: 2 });
    const spentRequests = requests.slice(2);
    expect(spentRequests.map((request) => request.repair?.attempt)).toEqual([undefined, 1, 2]);
    for (const request of spentRequests.slice(1)) {
      expect(
        request.repair?.failedChecks.map(({ result, logPath }) => [result.exitCode, logPath]),
      ).toEqual([[1, join(root, "runs", spent.id, "checks", "check-1.log")]]);
      expect(request.repair?.failedChecks[0]?.result.outputTail).toContain("repair-3.txt");
    }
    await cleanedUp(spent);
  });
});

describe("fix commands on the implement calls", () => {
  test("the first call and each repair carry the run's pinned fix commands, unmoved by a settings change mid-run", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const fixCommands = ["pnpm format", "pnpm lint --fix"];
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK, REPAIRED_CHECK],
      repairLimit: 1,
      fixCommands,
    });
    const run = await client.delivery.start({ ticketSetId });

    const first = await nthCall(implementPort.calls, 0);
    expect(first.request.fixCommands).toEqual(fixCommands);
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK, REPAIRED_CHECK],
      repairLimit: 1,
      fixCommands: ["pnpm prettier --write ."],
    });
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });

    const repair = await nthCall(implementPort.calls, 1);
    expect(repair.request.repair).toMatchObject({ attempt: 1, limit: 1 });
    expect(repair.request.fixCommands).toEqual(fixCommands);
    const finalCommit = await commitRepair(repair.request, REPAIR_FILE);
    repair.resolve({ ok: true, value: null });
    const review = await nthCall(reviewPort.calls, 0);
    review.resolve({ ok: true, value: verdictFor(finalCommit, false) });

    await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);
    expect(implementPort.calls).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test("a run of a project with no fix commands gives the executor none", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);

    const first = await nthCall(implementPort.calls, 0);
    expect(first.request.fixCommands).toEqual([]);
    const finalCommit = await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);
  });
});
