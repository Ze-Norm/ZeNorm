import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isDefinedError, ORPCError, safe } from "@orpc/client";
import { gitIdentityEnv } from "@zenorm/contracts";
import { createChangeBus, write } from "@zenorm/core";
import { installChangeFeed, openDatabase } from "@zenorm/db";
import { describe, expect, test, vi } from "vitest";

import {
  UNKNOWN_ID,
  SPEC,
  TICKETS,
  DELIVERY_WAIT,
  nthCall,
  planningPorts,
  appOf,
  root,
  db,
  webDistDir,
  log,
  implementPort,
  reviewPort,
  app,
  client,
  clientOf,
  useDatabase,
  addProject,
  approvedSet,
  DELIVERED_FILE,
  PASSING_CHECK,
  gitIn,
  commitDelivery,
  ticketBranch,
  verdictFor,
  startRun,
  deliveryRun,
  firstSpecOf,
  runIn,
  cleanedUp,
  eventsOf,
  commitTicket,
  ticketRefs,
  setUpAppTests,
} from "./app-test-support.ts";

setUpAppTests();

describe("project settings, Mark merged and run activity over /rpc", () => {
  test("project.saveSettings stores the branch, checks, repair limit and fix commands; refusals are coded", async () => {
    const project = await addProject();
    expect(project).toMatchObject({
      requiredChecks: [],
      repairLimit: null,
      fixCommands: [],
      startDeliveryBlockers: ["project_checks_missing", "project_repair_limit_missing"],
      activeRun: null,
    });
    const repair = { repairLimit: 1, fixCommands: ["pnpm format"] };
    const saved = await client.project.saveSettings({
      projectId: project.id,
      baseBranch: "main",
      requiredChecks: [PASSING_CHECK],
      ...repair,
    });
    expect(saved).toMatchObject({
      requiredChecks: [PASSING_CHECK],
      ...repair,
      startDeliveryBlockers: [],
    });
    expect(await client.project.get({ projectId: project.id })).toMatchObject({
      requiredChecks: [PASSING_CHECK],
      ...repair,
    });

    const [invalid] = await safe(
      client.project.saveSettings({
        projectId: project.id,
        baseBranch: "a..b",
        requiredChecks: [],
        ...repair,
      }),
    );
    expect(isDefinedError(invalid) && [invalid.code, invalid.status]).toEqual([
      "project_branch_invalid",
      422,
    ]);
    const [needsShell] = await safe(
      client.project.saveSettings({
        projectId: project.id,
        baseBranch: "main",
        requiredChecks: [PASSING_CHECK, "pnpm lint && pnpm test"],
        ...repair,
      }),
    );
    expect(
      isDefinedError(needsShell) && [needsShell.code, needsShell.status, needsShell.data],
    ).toEqual(["project_check_invalid", 422, { command: "pnpm lint && pnpm test" }]);
    const [fixNeedsShell] = await safe(
      client.project.saveSettings({
        projectId: project.id,
        baseBranch: "main",
        requiredChecks: [PASSING_CHECK],
        repairLimit: 3,
        fixCommands: ["pnpm format | tee log"],
      }),
    );
    expect(
      isDefinedError(fixNeedsShell) && [
        fixNeedsShell.code,
        fixNeedsShell.status,
        fixNeedsShell.data,
      ],
    ).toEqual(["project_fix_command_invalid", 422, { command: "pnpm format | tee log" }]);
    const [unknown] = await safe(
      client.project.saveSettings({
        projectId: UNKNOWN_ID,
        baseBranch: "main",
        requiredChecks: [],
        ...repair,
      }),
    );
    expect(isDefinedError(unknown) && [unknown.code, unknown.status]).toEqual([
      "project_not_found",
      404,
    ]);
    for (const input of [
      { requiredChecks: [PASSING_CHECK, PASSING_CHECK], ...repair },
      {
        requiredChecks: [PASSING_CHECK],
        repairLimit: 1,
        fixCommands: ["pnpm format", "pnpm format"],
      },
      {
        requiredChecks: [PASSING_CHECK],
        repairLimit: 1,
        fixCommands: Array.from({ length: 11 }, (_, index) => `fix ${String(index)}`),
      },
      { requiredChecks: [PASSING_CHECK], repairLimit: 11, fixCommands: [] },
    ]) {
      const [refused] = await safe(
        client.project.saveSettings({ projectId: project.id, baseBranch: "main", ...input }),
      );
      expect(refused instanceof ORPCError && refused.code).toBe("BAD_REQUEST");
    }
    expect(await client.project.get({ projectId: project.id })).toMatchObject({
      baseBranch: "main",
      requiredChecks: [PASSING_CHECK],
      ...repair,
    });
  });

  test("delivery.start refuses project_checks_missing, then project_repair_limit_missing; delivery_in_progress carries the project's active run", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const [noChecks] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(noChecks) && [noChecks.code, noChecks.status]).toEqual([
      "project_checks_missing",
      409,
    ]);
    // A save always carries a limit, so only a stored project (one from before repairs) has checks
    // and no limit. Test data, so `system` is acceptable here.
    write(db, { kind: "system" }, () => {
      db.$client
        .prepare("update projects set required_checks = ? where id = ?")
        .run(JSON.stringify([PASSING_CHECK]), project.id);
    });
    expect((await client.project.get({ projectId: project.id })).startDeliveryBlockers).toEqual([
      "project_repair_limit_missing",
    ]);
    const [noLimit] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(noLimit) && [noLimit.code, noLimit.status, noLimit.data]).toEqual([
      "project_repair_limit_missing",
      409,
      { projectId: project.id },
    ]);
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const active = { runId: run.id, mapId, specNumber: 1, specTitle: SPEC.title };
    expect((await client.project.get({ projectId: project.id })).activeRun).toEqual(active);
    const [inProgress] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(inProgress) && inProgress.code).toBe("delivery_in_progress");
    expect(isDefinedError(inProgress) && inProgress.data).toEqual(active);
    (await nthCall(implementPort.calls, 0)).resolve({
      ok: false,
      error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
    });
    await runIn(mapId, run.id, "failed", "implementing");
    expect((await client.project.get({ projectId: project.id })).activeRun).toBeNull();
  });

  test("delivery.markMerged is refused until git shows the final commit in main, then recorded once", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const [notPassed] = await safe(client.delivery.markMerged({ runId: run.id }));
    expect(isDefinedError(notPassed) && [notPassed.code, notPassed.status]).toEqual([
      "delivery_not_passed",
      409,
    ]);
    const implement = await nthCall(implementPort.calls, 0);
    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);

    const [notMerged] = await safe(client.delivery.markMerged({ runId: run.id }));
    expect(isDefinedError(notMerged) && [notMerged.code, notMerged.status]).toEqual([
      "delivery_not_merged",
      409,
    ]);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Dev",
        "-c",
        "user.email=dev@example.invalid",
        "merge",
        "-q",
        "--no-ff",
      ].concat(["-m", "Merge the run", run.branch]),
      { cwd: project.folderPath },
    );
    const merged = await client.delivery.markMerged({ runId: run.id });
    expect(merged).toMatchObject({ id: run.id, state: "passed", finalCommit });
    expect(merged.mergedAt).not.toBeNull();
    expect((await deliveryRun(mapId, run.id)).mergedAt).toBe(merged.mergedAt);
    expect((await client.delivery.activity({ runId: run.id })).at(-1)).toMatchObject({
      who: "zenorm",
      ticket: null,
      text: `${finalCommit.slice(0, 7)} is in main. The tickets are recorded as delivered.`,
    });

    const [twice] = await safe(client.delivery.markMerged({ runId: run.id }));
    expect(isDefinedError(twice) && [twice.code, twice.status]).toEqual([
      "delivery_already_merged",
      409,
    ]);
    const [missing] = await safe(client.delivery.markMerged({ runId: UNKNOWN_ID }));
    expect(isDefinedError(missing) && [missing.code, missing.status]).toEqual([
      "delivery_run_not_found",
      404,
    ]);
    const [noRun] = await safe(client.delivery.activity({ runId: UNKNOWN_ID }));
    expect(isDefinedError(noRun) && [noRun.code, noRun.status]).toEqual([
      "delivery_run_not_found",
      404,
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("map.overview carries each pinned ticket's status for a run", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await nthCall(implementPort.calls, 0);
    const shown = await deliveryRun(mapId, run.id);
    expect(shown.tickets).toEqual(
      TICKETS.tickets.map((ticket) => ({
        ticket: ticket.id,
        status:
          ticket.blockedBy.length === 0
            ? { state: "starting" }
            : { state: "waiting", on: ticket.blockedBy },
        failing: [],
      })),
    );
    await client.delivery.cancel({ runId: run.id });
  });
});

describe("the delivery runner's events, lines and cleanup", () => {
  test("events are stored as emitted, the merged commit is the ticket branch's head, checks are stored as they finish, and the passed run is cleaned up", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const checks = [PASSING_CHECK, "sleep 0.5"];
    const run = await startRun(ticketSetId, checks);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    const long = "x".repeat(600);

    emit({ kind: "line", who: "orchestrator", ticket: null, text: "Read the spec." });
    emit({ kind: "ticket_started", ticket: "T1" });
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Edited `src/a.ts`" });
    const head = await commitTicket(implement.request, "T1", true);
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Added the toggle." });
    emit({ kind: "line", who: "orchestrator", ticket: null, text: long });
    await vi.waitFor(async () => {
      expect((await deliveryRun(mapId, run.id)).tickets).toEqual([
        {
          ticket: "T1",
          status: { state: "merged", commit: head, summary: "Added the toggle." },
          failing: [],
        },
      ]);
    }, DELIVERY_WAIT);

    implement.resolve({ ok: true, value: null });
    // The first check's result is stored while the second still runs.
    const verifying = await vi.waitFor(async () => {
      const read = await deliveryRun(mapId, run.id);
      expect(read.checkResults).toHaveLength(1);
      return read;
    }, DELIVERY_WAIT);
    expect(verifying).toMatchObject({ state: "running", phase: "verifying" });
    const finalCommit = gitIn(implement.request.worktreePath, ["rev-parse", "HEAD"]);
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    await runIn(mapId, run.id, "passed", "reviewing");

    const lines = await cleanedUp(run);
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
    expect(lines.map((line) => [line.who, line.ticket])).toEqual([
      ["zenorm", null], // started
      ["zenorm", null], // the pinned inputs
      ["orchestrator", null],
      ["implementer", "T1"],
      ["orchestrator", null],
      ["zenorm", null], // the executor's exit
      ["zenorm", null], // the merges verified
      ["zenorm", null], // check 1
      ["zenorm", null], // check 2
      ["reviewer", null], // its start
      ["reviewer", null], // its verdict
      ["zenorm", null], // cleanup
    ]);
    expect(lines.slice(2, 5).map((line) => line.text)).toEqual([
      "Read the spec.",
      "Edited `src/a.ts`",
      `${"x".repeat(499)}…`,
    ]);
    for (const line of lines) {
      expect(line.text.length).toBeLessThanOrEqual(500);
    }
    expect((await deliveryRun(mapId, run.id)).tickets).toMatchObject([
      { ticket: "T1", status: { state: "merged", commit: head } },
    ]);
    expect(existsSync(join(implement.request.runDir, "tickets", "t1"))).toBe(false);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["rev-parse", run.branch])).toBe(finalCommit);
    expect(existsSync(join(implement.request.runDir, "inputs", "spec.md"))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  test("a ticket left unmerged fails the run delivery_ticket_unmerged before any check", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const marker = join(root, "check-ran");
    const run = await startRun(ticketSetId, [`touch ${marker}`]);
    const implement = await nthCall(implementPort.calls, 0);
    eventsOf(implement)({ kind: "ticket_started", ticket: "T1" });
    await commitTicket(implement.request, "T1", false);
    await writeFile(join(implement.request.worktreePath, DELIVERED_FILE), "delivered\n");
    const env = { ...process.env, ...gitIdentityEnv(implement.request.gitIdentity) };
    execFileSync("git", ["add", DELIVERED_FILE], { cwd: implement.request.worktreePath, env });
    execFileSync("git", ["commit", "-q", "-m", "Deliver"], {
      cwd: implement.request.worktreePath,
      env,
    });
    implement.resolve({ ok: true, value: null });

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_ticket_unmerged" });
    expect(failed.tickets).toMatchObject([
      { ticket: "T1", status: { state: "not_delivered", started: true } },
    ]);
    const lines = await cleanedUp(run);
    expect(lines.at(-2)).toMatchObject({ who: "zenorm", ticket: null });
    expect(existsSync(marker)).toBe(false);
    expect(reviewPort.calls).toHaveLength(0);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);
    expect(log).not.toHaveBeenCalled();
  });

  test("a ticket branch deleted before its merge is recorded fails the run delivery_ticket_unmerged with a ZeNorm line", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    emit({ kind: "ticket_started", ticket: "T1" });
    await commitTicket(implement.request, "T1", true);
    const { worktreePath, runDir } = implement.request;
    execFileSync("git", ["worktree", "remove", "--force", join(runDir, "tickets", "t1")], {
      cwd: worktreePath,
    });
    execFileSync("git", ["branch", "-D", ticketBranch(run.branch, "T1")], { cwd: worktreePath });
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Merged and deleted." });
    await vi.waitFor(async () => {
      const lines = await client.delivery.activity({ runId: run.id });
      expect(lines.at(-1)).toMatchObject({ who: "zenorm", ticket: "T1" });
    }, DELIVERY_WAIT);
    implement.resolve({ ok: true, value: null });

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_ticket_unmerged" });
    expect(failed.tickets).toMatchObject([
      { ticket: "T1", status: { state: "not_delivered", started: true } },
    ]);
    await cleanedUp(run);
    expect(reviewPort.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("an event after a cancel writes nothing; the cancelled run keeps its phase and is cleaned up once the abort settles", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    await commitTicket(implement.request, "T1", false);
    const before = await client.delivery.activity({ runId: run.id });

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "implementing" });
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Too late." });
    emit({ kind: "ticket_started", ticket: "T1" });
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Too late." });
    const afterCancel = await client.delivery.activity({ runId: run.id });
    expect(afterCancel.slice(0, before.length)).toEqual(before);
    expect(afterCancel.slice(before.length)).toMatchObject([{ who: "zenorm", ticket: null }]);
    // The abort has not settled: the worktrees stay until the session ends.
    expect(existsSync(implement.request.worktreePath)).toBe(true);

    implement.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    const lines = await cleanedUp(run);
    expect(lines).toHaveLength(afterCancel.length + 1);
    expect(await deliveryRun(mapId, run.id)).toMatchObject({
      state: "cancelled",
      phase: "implementing",
      tickets: [{ ticket: "T1", status: { state: "not_delivered", started: false } }],
    });
    expect(existsSync(join(implement.request.runDir, "tickets", "t1"))).toBe(false);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);
    expect(log).not.toHaveBeenCalled();
  });

  test("a shutdown aborts the active session and settles before the database closes; nothing is written after, and the restarted app reads the run interrupted", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    emit({ kind: "ticket_started", ticket: "T1" });
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Edited `a.ts`" });
    await vi.waitFor(async () => {
      expect((await client.delivery.activity({ runId: run.id })).at(-1)?.ticket).toBe("T1");
    }, DELIVERY_WAIT);
    const before = await client.delivery.activity({ runId: run.id });

    let stopped = false;
    const stopping = app.stopDeliveryRuns().then(() => {
      stopped = true;
    });
    expect(implement.signal.aborted).toBe(true);
    // The session has not exited yet, so the database must stay open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    implement.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    await stopping;
    db.$client.close();

    // A late event after the close writes nothing and throws nothing.
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Too late." });
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Too late." });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log).not.toHaveBeenCalled();

    const reopened = openDatabase(join(root, "zenorm.sqlite"));
    if (!reopened.ok) throw new Error(reopened.error.message);
    useDatabase(reopened.value);
    installChangeFeed(db);
    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    expect(await restarted.delivery.activity({ runId: run.id })).toEqual(before);
    const { specs } = await restarted.map.overview({ mapId });
    expect(firstSpecOf(specs).runs).toMatchObject([
      { id: run.id, state: "interrupted", phase: "implementing", endedAt: null },
    ]);
    // No cleanup ran: the worktrees stay for the interrupted run's Cancel.
    expect(existsSync(implement.request.worktreePath)).toBe(true);
    expect(await restarted.delivery.cancel({ runId: run.id })).toMatchObject({
      state: "cancelled",
    });
    await vi.waitFor(() => {
      expect(existsSync(implement.request.worktreePath)).toBe(false);
    }, DELIVERY_WAIT);
    expect(log).not.toHaveBeenCalled();
  });

  test("Cancel of an interrupted run cleans it up; a run from before 0010 gets its end and no line", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    await commitTicket(implement.request, "T1", true);

    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    const cancelled = await restarted.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "implementing" });
    // The cancel handler cleaned up before answering.
    expect(existsSync(implement.request.worktreePath)).toBe(false);
    expect(existsSync(join(implement.request.runDir, "tickets", "t1"))).toBe(false);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);
    const lines = await client.delivery.activity({ runId: run.id });
    expect(lines.slice(-2)).toMatchObject([
      { who: "zenorm", ticket: null }, // the cancel
      { who: "zenorm", ticket: null }, // the cleanup
    ]);

    // A pre-`0010`-shaped run: no ticket rows and no lines.
    const second = await startRun(ticketSetId, [PASSING_CHECK]);
    await nthCall(implementPort.calls, 1);
    // Test data, so `system` is acceptable here.
    write(db, { kind: "system" }, () => {
      db.$client.prepare("DELETE FROM delivery_run_tickets WHERE run_id = ?").run(second.id);
      db.$client.prepare("DELETE FROM delivery_run_events WHERE run_id = ?").run(second.id);
    });
    const again = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    const old = await again.delivery.cancel({ runId: second.id });
    expect(old).toMatchObject({ state: "cancelled", phase: "implementing" });
    expect(await client.delivery.activity({ runId: second.id })).toEqual([]);
    expect(existsSync(join(root, "runs", second.id, "worktree"))).toBe(true);
    expect((await deliveryRun(mapId, second.id)).endedAt).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
