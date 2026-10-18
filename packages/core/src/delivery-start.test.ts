import { execFileSync } from "node:child_process";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { LOCAL_EXECUTOR } from "@zenorm/contracts";
import type { Project, TicketSetContent } from "@zenorm/contracts";
import { deliveryRuns, projects } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  cancelDelivery,
  getDeliveryRun,
  prepareDelivery,
  renderTickets,
  setDeliveryPhase,
  startDelivery,
  toDeliveryRun,
} from "./delivery.ts";
import { getMapOverview } from "./map-overview.ts";
import { getProject, saveProjectSettings } from "./project.ts";
import { readRunTicketRows } from "./run-tickets.ts";
import { readSetVersion } from "./specs.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  deliveredSpec,
  insertNextRevision,
  NO_APP_SETTINGS,
  commitOnRunBranch,
  deliverableTicketSet,
  endRun,
  openTestContext,
  REPAIR_LIMIT,
  REQUIRED_CHECKS,
  SPEC,
  saveChecks,
  startedRun,
  TICKETS,
  runFolder,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-delivery-start-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

function runCount(): number {
  return context.db.select().from(deliveryRuns).all().length;
}

function start(ticketSetId: string) {
  return startDelivery(context.user, context.db, {
    ticketSetId,
    runsDir: join(context.root, "runs"),
    executor: LOCAL_EXECUTOR,
  });
}

describe("delivery.start pins the project's checks and base branch", () => {
  test("a later save changes neither", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    expect(run).toMatchObject({ checks: REQUIRED_CHECKS, baseBranch: "main", phase: "preparing" });

    execFileSync("git", ["branch", "develop"], { cwd: project.folderPath });
    await saveProjectSettings(context.user, context.db, {
      projectId: project.id,
      baseBranch: "develop",
      requiredChecks: ["pnpm test"],
      repairLimit: 3,
      fixCommands: ["pnpm format"],
      ...NO_APP_SETTINGS,
    });

    const stored = await getDeliveryRun(context.db, run.id);
    expect(stored.ok && stored.value).toMatchObject({
      checks: REQUIRED_CHECKS,
      baseBranch: "main",
      projectId: project.id,
      repairLimit: REPAIR_LIMIT,
      fixCommands: [],
    });
  });

  test("a start inserts one ticket row per pinned ticket, in order, none started", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    expect(readRunTicketRows(context.db, run.id)).toEqual([
      {
        runId: run.id,
        ticket: "T1",
        position: 1,
        startedAt: null,
        mergedAt: null,
        commit: null,
        summary: null,
      },
      {
        runId: run.id,
        ticket: "T2",
        position: 2,
        startedAt: null,
        mergedAt: null,
        commit: null,
        summary: null,
      },
    ]);
  });
});

describe("delivery.start refuses in order, writing nothing", () => {
  test("project_checks_missing when the project has no checks", async () => {
    const set = await deliverableTicketSet(context, project);
    await saveChecks(context, project, []);
    expect(await start(set.ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "project_checks_missing", data: { projectId: project.id } },
    });
    expect(runCount()).toBe(0);
  });

  test("project_repair_limit_missing while a new project has no saved repair limit; saving 0 lifts it", async () => {
    expect(project).toMatchObject({ repairLimit: null, fixCommands: [] });
    expect(project.startDeliveryBlockers).toContain("project_repair_limit_missing");
    const set = await deliverableTicketSet(context, project);
    // A save always carries a limit: only a project stored before repairs has checks and none.
    writeTestData(context, (tx) =>
      tx.update(projects).set({ repairLimit: null }).where(eq(projects.id, project.id)).run(),
    );
    const blocked = await getProject(context.db, project.id);
    expect(blocked.ok && blocked.value.startDeliveryBlockers).toEqual([
      "project_repair_limit_missing",
    ]);
    expect(await start(set.ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "project_repair_limit_missing", data: { projectId: project.id } },
    });
    expect(runCount()).toBe(0);

    await saveProjectSettings(context.user, context.db, {
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: REQUIRED_CHECKS,
      repairLimit: 0,
      fixCommands: [],
      ...NO_APP_SETTINGS,
    });
    const lifted = await getProject(context.db, project.id);
    expect(lifted.ok && lifted.value.startDeliveryBlockers).toEqual([]);
    expect((await start(set.ticketSetId)).ok).toBe(true);
    expect(runCount()).toBe(1);
  });

  test("the checks blocker wins over the repair limit blocker", async () => {
    const set = await deliverableTicketSet(context, project);
    writeTestData(context, (tx) =>
      tx
        .update(projects)
        .set({ requiredChecks: [], repairLimit: null })
        .where(eq(projects.id, project.id))
        .run(),
    );
    expect(await start(set.ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "project_checks_missing" },
    });
    expect(runCount()).toBe(0);
  });

  test("the branch blocker wins over the checks blocker", async () => {
    const set = await deliverableTicketSet(context, project);
    await saveProjectSettings(context.user, context.db, {
      projectId: project.id,
      baseBranch: "trunk",
      requiredChecks: [],
      repairLimit: 0,
      fixCommands: [],
      ...NO_APP_SETTINGS,
    });
    expect((await getProject(context.db, project.id)).ok).toBe(true);
    expect(await start(set.ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "project_branch_missing", data: { baseBranch: "trunk" } },
    });
    expect(runCount()).toBe(0);
  });

  test("the checks blocker wins over an active run", async () => {
    const first = await deliverableTicketSet(context, project);
    await startedRun(context, first.ticketSetId);
    const second = await deliverableTicketSet(context, project);
    await saveChecks(context, project, []);
    expect(await start(second.ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "project_checks_missing" },
    });
    expect(runCount()).toBe(1);
  });

  test("delivery_already_passed wins over a missing folder", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const finalCommit = await commitOnRunBranch(context, run);
    await endRun(context, run.id, { outcome: "passed", finalCommit });
    await rename(project.folderPath, join(context.root, "moved"));
    expect(await start(set.ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "delivery_already_passed" },
    });
  });
});

describe("one active run per project", () => {
  test("an interrupted run in one spec refuses a start in another until it is cancelled", async () => {
    const first = await deliverableTicketSet(context, project);
    const run = await startedRun(context, first.ticketSetId);
    const second = await deliverableTicketSet(context, project);
    const active = { runId: run.id, mapId: first.mapId, specNumber: 1, specTitle: SPEC.title };

    // Not held by any runner: the run reads interrupted.
    expect(toDeliveryRun(run, false).state).toBe("interrupted");
    const refused = await start(second.ticketSetId);
    expect(refused.ok || refused.error.code).toBe("delivery_in_progress");
    expect(refused.ok || refused.error.data).toEqual(active);
    expect(runCount()).toBe(1);
    const blocked = await getProject(context.db, project.id);
    expect(blocked.ok && blocked.value).toMatchObject({
      activeRun: active,
      startDeliveryBlockers: ["delivery_in_progress"],
    });
    const overview = await getMapOverview(context.db, second.mapId, { deliveryHeld: () => false });
    expect(overview.ok && overview.value.project.activeRun).toEqual(active);
    expect(overview.ok && overview.value.specs[0]?.stages[2]).toMatchObject({ tone: "idle" });

    expect((await cancelDelivery(context.user, context.db, run.id)).ok).toBe(true);
    const next = await start(second.ticketSetId);
    expect(next.ok && next.value.run).toMatchObject({
      number: 1,
      specificationId: second.specificationId,
    });
    const after = await getProject(context.db, project.id);
    expect(after.ok && after.value.activeRun).toMatchObject({ specNumber: 2 });
  });

  test("a project's active run blocks only that project", async () => {
    const set = await deliverableTicketSet(context, project);
    await startedRun(context, set.ticketSetId);
    const other = await addProject(context, "other");
    const otherSet = await deliverableTicketSet(context, other);
    expect((await start(otherSet.ticketSetId)).ok).toBe(true);
  });
});

describe("the stored phase", () => {
  test("a phase write sets an active run's phase and is kept after the end", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    for (const phase of ["implementing", "verifying", "reviewing"] as const) {
      expect(setDeliveryPhase(context.user, context.db, run.id, phase)).toBe(true);
      const stored = await getDeliveryRun(context.db, run.id);
      expect(stored.ok && toDeliveryRun(stored.value, true)).toMatchObject({
        state: "running",
        phase,
      });
      expect(stored.ok && toDeliveryRun(stored.value, false)).toMatchObject({
        state: "interrupted",
        phase,
      });
    }
    await endRun(context, run.id, { outcome: "failed" });
    expect(setDeliveryPhase(context.user, context.db, run.id, "implementing")).toBe(false);
    const ended = await getDeliveryRun(context.db, run.id);
    expect(ended.ok && toDeliveryRun(ended.value, false)).toMatchObject({
      state: "failed",
      phase: "reviewing",
      failure: { code: "delivery_checks_failed", message: "A check failed." },
    });
  });

  test("a run's contract view carries no project id or worktree path", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const view = toDeliveryRun(run, true);
    expect(view).not.toHaveProperty("projectId");
    expect(view).not.toHaveProperty("worktreePath");
  });
});

// --- A later revision's set ---

/** Another map's r2 of the delivered spec 1 (SPEC's text) with a set of `content` in `state`. */
async function revisedSet(content: TicketSetContent, state: "approved" | "review_passed") {
  const delivered = await deliveredSpec(context, project);
  const mapId = await clearedMap(context, project);
  const next = insertNextRevision(context, {
    specificationId: delivered.specificationId,
    mapId,
    content: SPEC,
    approved: true,
    set: { state, content },
  });
  if (next.ticketSetId === null) throw new Error("no set");
  return { delivered, ticketSetId: next.ticketSetId };
}

const NOTHING_NEW: TicketSetContent = {
  ...TICKETS,
  tickets: [],
  dispositions: [
    { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
    { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
  ],
};

describe("Nothing to deliver", () => {
  test("an approved zero-ticket set is refused delivery_nothing_to_deliver, writing no run", async () => {
    const { ticketSetId } = await revisedSet(NOTHING_NEW, "approved");
    const before = runCount();
    expect(await start(ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "delivery_nothing_to_deliver", data: { ticketSetId } },
    });
    expect(runCount()).toBe(before);
  });

  test("an unapproved zero-ticket set is refused ticket_set_not_approved first", async () => {
    const { ticketSetId } = await revisedSet(NOTHING_NEW, "review_passed");
    const before = runCount();
    expect(await start(ticketSetId)).toMatchObject({
      ok: false,
      error: { code: "ticket_set_not_approved" },
    });
    expect(runCount()).toBe(before);
  });
});

describe("the run's tickets.md says what each ticket changes", () => {
  test("a follow-up names the earlier ticket, run and commit; a taking-out ticket names the criterion", async () => {
    const followUp: TicketSetContent = {
      ...TICKETS,
      tickets: [
        {
          id: "T3",
          title: "Reword the button",
          build: "Change it.",
          blockedBy: [],
          criteria: ["1.1"],
          testing: ["The button still downloads."],
          followUp: "T2",
          outOfScope: [],
          pointers: ["src/index.ts"],
        },
      ],
      dispositions: [
        { criterion: "1.1", kind: "work", ticket: "T3", reason: "The label changes." },
        { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
      ],
    };
    const { delivered, ticketSetId } = await revisedSet(followUp, "approved");
    const run = await startedRun(context, ticketSetId);
    const prepared = await prepareDelivery(context.db, run.id, runFolder(context.db, run));
    if (!prepared.ok) throw new Error(prepared.error.code);
    const tickets = await readFile(prepared.value.ticketsPath, "utf8");
    const line = tickets.split("\n").find((text) => text.startsWith("Follow-up to "));
    expect(line).toBeDefined();
    for (const id of ["T2", `run ${String(delivered.run.number)}`, delivered.finalCommit]) {
      expect(line).toContain(id);
    }
    expect(readSetVersion(context.db, delivered.ticketSetId, 1).content).toEqual(TICKETS);
  });

  test("renderTickets writes a Takes out line on the ticket a removed disposition names", () => {
    const takesOut: TicketSetContent = {
      ...TICKETS,
      tickets: TICKETS.tickets.slice(0, 1).map((ticket) => ({ ...ticket, id: "T3", criteria: [] })),
      dispositions: [
        { criterion: "1.3", kind: "removed", ticket: "T3", reason: "No partial export." },
      ],
    };
    const lines = renderTickets(takesOut, {}).split("\n");
    const ticketAt = lines.indexOf("## T3 Write the CSV exporter");
    const line = lines.slice(ticketAt).find((text) => text.startsWith("Takes out "));
    expect(line).toContain("1.3");
  });

  test("renderTickets lists each ticket's pointers, says none for a pre-pointer ticket, and leaves planning records out", () => {
    const set: TicketSetContent = {
      ...TICKETS,
      tickets: TICKETS.tickets.map((ticket, index) => ({
        ...ticket,
        pointers: index === 0 ? ["src/export.ts", "src/export.test.ts"] : [],
      })),
    };
    const tickets = renderTickets(set, {});
    expect(tickets).toContain("Pointers:\n\n- src/export.ts\n- src/export.test.ts\n");
    expect(tickets).toContain("Pointers: none recorded.");
    for (const heading of ["## Dispositions", "## Slicing", "## Execution"]) {
      expect(tickets).not.toContain(heading);
    }
  });
});
