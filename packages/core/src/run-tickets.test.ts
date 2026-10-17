import type { Project, RunTicket } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getDeliveryRun } from "./delivery.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import { getMapOverview } from "./map-overview.ts";
import { runTickets } from "./run-tickets.ts";
import {
  addProject,
  appendLine,
  asPre0010Run,
  closeTestContext,
  commitOnRunBranch,
  deliverableTicketSet,
  endRun,
  markTicketMerged,
  markTicketStarted,
  openTestContext,
  startedRun,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

const COMMIT = "c".repeat(40);

beforeEach(async () => {
  context = await openTestContext("zenorm-core-run-tickets-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

async function stored(runId: string): Promise<StoredDeliveryRun> {
  const found = await getDeliveryRun(context.db, runId);
  if (!found.ok) throw new Error(found.error.code);
  return found.value;
}

async function ticketsOf(runId: string): Promise<RunTicket[] | null> {
  return runTickets(context.db, await stored(runId));
}

describe("each pinned ticket's status", () => {
  test("starting, then implementing with no line, with its latest line, then merged; T2 waits on T1", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    expect(await ticketsOf(run.id)).toEqual([
      { ticket: "T1", status: { state: "starting" }, failing: [] },
      {
        ticket: "T2",
        status: { state: "waiting", on: [{ ticket: "T1", supplies: "the exporter" }] },
        failing: [],
      },
    ]);

    markTicketStarted(context, run.id, "T1");
    expect((await ticketsOf(run.id))?.[0]?.status).toEqual({ state: "implementing", latest: null });

    appendLine(context, run.id, { who: "implementer", ticket: "T1", text: "First" });
    const latest = appendLine(context, run.id, { who: "implementer", ticket: "T1", text: "Next" });
    appendLine(context, run.id, { who: "orchestrator", ticket: null, text: "Waiting" });
    expect((await ticketsOf(run.id))?.[0]?.status).toEqual({ state: "implementing", latest });

    markTicketMerged(context, run.id, "T1", { commit: COMMIT, summary: "Wrote the exporter." });
    expect(await ticketsOf(run.id)).toEqual([
      {
        ticket: "T1",
        status: { state: "merged", commit: COMMIT, summary: "Wrote the exporter." },
        failing: [],
      },
      { ticket: "T2", status: { state: "starting" }, failing: [] },
    ]);
  });

  test("a line never starts a ticket: a line for an unstarted ticket leaves it waiting", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    appendLine(context, run.id, { who: "implementer", ticket: "T2", text: "Early" });
    expect((await ticketsOf(run.id))?.[1]?.status.state).toBe("waiting");
  });

  test("an ended run: not_delivered with whether it started; merged stays merged", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    markTicketStarted(context, run.id, "T1");
    await endRun(context, run.id, { outcome: "cancelled" });
    expect((await ticketsOf(run.id))?.map((ticket) => ticket.status)).toEqual([
      { state: "not_delivered", started: true },
      { state: "not_delivered", started: false },
    ]);
  });

  test("failing lists the criterion ids the blocking findings name that the ticket carries", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const finalCommit = await commitOnRunBranch(context, run);
    markTicketStarted(context, run.id, "T1");
    markTicketMerged(context, run.id, "T1", { commit: finalCommit, summary: null });
    // T1 carries 1.2, T2 carries 1.1.
    await endRun(context, run.id, { outcome: "blocked", finalCommit, criterion: "1.1" });
    expect(await ticketsOf(run.id)).toEqual([
      {
        ticket: "T1",
        status: { state: "merged", commit: finalCommit, summary: null },
        failing: [],
      },
      { ticket: "T2", status: { state: "not_delivered", started: false }, failing: ["1.1"] },
    ]);
  });

  test("a run with no ticket rows (from before 0010) has tickets: null", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    asPre0010Run(context, run.id);
    expect(await ticketsOf(run.id)).toBeNull();
  });

  test("map.overview carries each spec's runs newest first, with their stored phase and tickets", async () => {
    const set = await deliverableTicketSet(context, project);
    const first = await startedRun(context, set.ticketSetId);
    await endRun(context, first.id, { outcome: "cancelled" });
    asPre0010Run(context, first.id);
    const second = await startedRun(context, set.ticketSetId);
    const result = await getMapOverview(context.db, set.mapId, {
      deliveryHeld: (runId) => runId === second.id,
    });
    if (!result.ok) throw new Error(result.error.code);
    const runs = result.value.specs[0]?.runs;
    expect(runs?.map((run) => [run.number, run.state, run.phase, run.tickets?.length])).toEqual([
      [2, "running", "preparing", 2],
      [1, "cancelled", "preparing", undefined],
    ]);
    expect(runs?.[1]?.tickets).toBeNull();
    expect(runs?.[0]).toMatchObject({ baseBranch: "main", mergedAt: null });
  });
});
