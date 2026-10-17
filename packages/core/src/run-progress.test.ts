import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ok } from "@zenorm/contracts";
import type { Project } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanUpDelivery } from "./delivery-cleanup.ts";
import { prepareDelivery } from "./delivery.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import {
  recordTicketMerged,
  recordTicketStarted,
  ticketBranchName,
  verifyTicketMerges,
} from "./run-progress.ts";
import { readRunTicketRows } from "./run-tickets.ts";
import type { StoredRunTicket } from "./run-tickets.ts";
import {
  addProject,
  closeTestContext,
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
  context = await openTestContext("zenorm-core-run-progress-");
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

/** A started run, prepared: its worktree on the run branch. */
async function preparedRun(): Promise<StoredDeliveryRun> {
  const set = await deliverableTicketSet(context, project);
  const run = await startedRun(context, set.ticketSetId);
  const prepared = await prepareDelivery(context.db, run.id, runFolder(context.db, run));
  if (!prepared.ok) throw new Error(prepared.error.code);
  return run;
}

/**
 * The ticket's worktree `<runDir>/tickets/<ticket>` on a new branch `<run branch>-t<n>` from the
 * base commit, with one commit there, as an implementer leaves it; returns the branch head.
 */
async function ticketWork(run: StoredDeliveryRun, ticket: string): Promise<string> {
  const path = join(dirname(run.worktreePath), "tickets", ticket);
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
  return git(path, ["rev-parse", "HEAD"]);
}

/** Merges the ticket's branch into the run branch, as the orchestrator does; the new head. */
function mergeIntoRun(run: StoredDeliveryRun, ticket: string): string {
  git(run.worktreePath, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    `Merge ${ticket}`,
    ticketBranchName(run.branch, ticket),
  ]);
  return git(run.worktreePath, ["rev-parse", "HEAD"]);
}

function rowOf(runId: string, ticket: string): StoredRunTicket {
  const row = readRunTicketRows(context.db, runId).find((found) => found.ticket === ticket);
  if (row === undefined) throw new Error(`No row ${ticket}`);
  return row;
}

describe("a ticket's started record (S8-7, D4 Started)", () => {
  test("is recorded once: a repeat writes nothing and keeps the first time", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);

    expect(recordTicketStarted(context.user, context.db, run.id, "T1")).toBe(true);
    const first = rowOf(run.id, "T1").startedAt;
    expect(first).not.toBeNull();
    expect(recordTicketStarted(context.user, context.db, run.id, "T1")).toBe(false);
    expect(rowOf(run.id, "T1").startedAt).toBe(first);
    expect(rowOf(run.id, "T2").startedAt).toBeNull();
  });

  test("writes nothing once the run has ended (a late event after a cancel)", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    await endRun(context, run.id, { outcome: "cancelled" });

    expect(recordTicketStarted(context.user, context.db, run.id, "T1")).toBe(false);
    expect(rowOf(run.id, "T1").startedAt).toBeNull();
  });

  test("a ticket the run did not pin is a programmer error", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);

    expect(() => recordTicketStarted(context.user, context.db, run.id, "T9")).toThrow();
  });
});

describe("a ticket's merged record (S8-7, D4 Merged)", () => {
  test("records the ticket branch's head as the commit, with the summary", async () => {
    const run = await preparedRun();
    const head = await ticketWork(run, "T1");
    mergeIntoRun(run, "T1");

    const recorded = await recordTicketMerged(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      ticket: "T1",
      summary: "Wrote the exporter.",
    });

    expect(recorded).toEqual({ recorded: true, commit: head });
    const row = rowOf(run.id, "T1");
    expect(row.commit).toBe(head);
    expect(row.summary).toBe("Wrote the exporter.");
    expect(row.mergedAt).not.toBeNull();
    expect(rowOf(run.id, "T2").mergedAt).toBeNull();
  });

  test("a null summary is stored as null", async () => {
    const run = await preparedRun();
    const head = await ticketWork(run, "T1");

    await recordTicketMerged(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      ticket: "T1",
      summary: null,
    });

    expect(rowOf(run.id, "T1")).toMatchObject({ commit: head, summary: null });
  });

  test("writes nothing once the run has ended, even after cleanup deleted the branch", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");
    await endRun(context, run.id, { outcome: "cancelled" });

    expect(
      await recordTicketMerged(context.user, context.db, {
        runId: run.id,
        folder: runFolder(context.db, run),
        ticket: "T1",
        summary: "Late.",
      }),
    ).toEqual({ recorded: false, reason: "run_ended" });

    await cleanUpDelivery(context.user, context.db, run.id, ok(runFolder(context.db, run)));
    expect(
      await recordTicketMerged(context.user, context.db, {
        runId: run.id,
        folder: runFolder(context.db, run),
        ticket: "T1",
        summary: "Late.",
      }),
    ).toEqual({ recorded: false, reason: "run_ended" });
    expect(rowOf(run.id, "T1")).toMatchObject({ mergedAt: null, commit: null, summary: null });
  });

  test("a branch missing while the run is active writes nothing and reads branch_missing; verifying then fails delivery_ticket_unmerged (L197 item 10)", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");
    const finalCommit = mergeIntoRun(run, "T1");
    const t1Path = join(dirname(run.worktreePath), "tickets", "T1");
    git(project.folderPath, ["worktree", "remove", "--force", t1Path]);
    git(project.folderPath, ["branch", "-D", ticketBranchName(run.branch, "T1")]);

    expect(
      await recordTicketMerged(context.user, context.db, {
        runId: run.id,
        folder: runFolder(context.db, run),
        ticket: "T1",
        summary: "Done.",
      }),
    ).toEqual({ recorded: false, reason: "branch_missing" });
    expect(rowOf(run.id, "T1")).toMatchObject({ mergedAt: null, commit: null, summary: null });

    const verified = await verifyTicketMerges(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      finalCommit,
    });
    expect(verified).toMatchObject({
      ok: false,
      error: { code: "delivery_ticket_unmerged", data: { tickets: ["T1", "T2"] } },
    });
  });

  test("a summary over 1000 characters is a programmer error (the runner cuts it)", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");

    await expect(
      recordTicketMerged(context.user, context.db, {
        runId: run.id,
        folder: runFolder(context.db, run),
        ticket: "T1",
        summary: "x".repeat(1001),
      }),
    ).rejects.toThrow();
    expect(rowOf(run.id, "T1").mergedAt).toBeNull();
  });
});

describe("merges verified from git (S8-8)", () => {
  test("a ticket merged by the commands but not reported is recorded at its branch head", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");
    mergeIntoRun(run, "T1");
    await recordTicketMerged(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      ticket: "T1",
      summary: "Reported.",
    });
    const t2Head = await ticketWork(run, "T2");
    const finalCommit = mergeIntoRun(run, "T2");

    const verified = await verifyTicketMerges(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      finalCommit,
    });

    expect(verified).toEqual({ ok: true, value: [{ ticket: "T2", commit: t2Head }] });
    expect(rowOf(run.id, "T2")).toMatchObject({ commit: t2Head, summary: null });
    expect(rowOf(run.id, "T1").summary).toBe("Reported.");
  });

  test("every ticket already recorded: nothing to recover", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");
    mergeIntoRun(run, "T1");
    await ticketWork(run, "T2");
    const finalCommit = mergeIntoRun(run, "T2");
    await recordTicketMerged(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      ticket: "T1",
      summary: null,
    });
    await recordTicketMerged(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      ticket: "T2",
      summary: null,
    });

    expect(
      await verifyTicketMerges(context.user, context.db, {
        runId: run.id,
        finalCommit,
        folder: runFolder(context.db, run),
      }),
    ).toEqual({
      ok: true,
      value: [],
    });
  });

  test("a missing ticket branch is delivery_ticket_unmerged", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");
    const finalCommit = mergeIntoRun(run, "T1");

    const verified = await verifyTicketMerges(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      finalCommit,
    });

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.error.code).toBe("delivery_ticket_unmerged");
    expect(verified.error.data.tickets).toEqual(["T2"]);
    expect(rowOf(run.id, "T1").commit).not.toBeNull();
    expect(rowOf(run.id, "T2").commit).toBeNull();
  });

  test("a branch whose head is not an ancestor of the final commit is delivery_ticket_unmerged", async () => {
    const run = await preparedRun();
    await ticketWork(run, "T1");
    await ticketWork(run, "T2");
    const finalCommit = mergeIntoRun(run, "T2");

    const verified = await verifyTicketMerges(context.user, context.db, {
      runId: run.id,
      folder: runFolder(context.db, run),
      finalCommit,
    });

    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.error.code).toBe("delivery_ticket_unmerged");
    expect(verified.error.data.tickets).toEqual(["T1"]);
    expect(rowOf(run.id, "T1").mergedAt).toBeNull();
  });
});
