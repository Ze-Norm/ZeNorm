import type {
  Disposition,
  Project,
  SpecRevisionContent,
  TicketContent,
  TicketSetContent,
} from "@zenorm/contracts";
import { RejectTicketSetInput } from "@zenorm/contracts";
import {
  isUniqueConstraintViolation,
  planningRuns,
  ticketSetRejections,
  ticketSets,
  ticketSetVersions,
  ticketsReviewFindings,
  ticketsReviews,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { approveSpecRevision, approveTicketSet, rejectTicketSet } from "./planning.ts";
import { failRun, planNext, tryAgain } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { recordTicketSet, recordTicketsReview } from "./ticket-set-runs.ts";
import { readSetVersion, readTicketSetOf } from "./specs.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  deliverableTicketSet,
  deliveredSpec,
  draftedTicketSet,
  insertNextRevision,
  insertTicketSetWith,
  replacedTicketSet,
  insertTicketsRepair,
  insertTicketsReview,
  insertTicketsReviewRun,
  PASSED_TICKETS_REVIEW,
  recordRunningTicketsReview,
  reviewedTicketSet,
  insertRevision,
  insertRun,
  openTestContext,
  reviewedSpec,
  runningSpecRun,
  runsOf,
  SPEC,
  TICKETS,
  TICKETS_REVISE_FINDING,
  unreviewedTicketSet,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-ticket-sets-");
  project = await addProject(context, "tickets");
});

afterEach(async () => {
  await closeTestContext(context);
});

const UNKNOWN_REVIEW_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

const REASON = RejectTicketSetInput.shape.reason.parse("Split the exporter.");

const [T1, T2] = TICKETS.tickets;
if (T1 === undefined || T2 === undefined) {
  throw new Error("TICKETS has two tickets");
}

/** A spec approved with its `to_tickets` running; returns its ids and the run. */
async function awaitingTickets() {
  const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
  const approved = approveSpecRevision(context.user, context.db, { specRevisionId });
  if (!approved.ok) throw new Error(approved.error.code);
  return {
    mapId,
    specificationId,
    specRevisionId,
    run: runningSpecRun(context, mapId, "to_tickets"),
  };
}

/** A rejected set's rewrite run, after `reviewedTicketSet` and a rejection of version 1. */
async function rejectedSet() {
  const drafted = await reviewedTicketSet(context, project);
  expect(
    rejectTicketSet(context.user, context.db, { ticketSetId: drafted.ticketSetId, reason: REASON }),
  ).toEqual({ ok: true, value: drafted.mapId });
  return { ...drafted, run: runningSpecRun(context, drafted.mapId, "to_tickets") };
}

/**
 * Agent output as a port could return it before any check: typed as the set, so a case can reach
 * core with a shape the type rules out (core re-checks the schema and refuses it).
 */
function isPortOutput(content: unknown): content is TicketSetContent {
  return typeof content === "object" && content !== null;
}

function unchecked(content: unknown): TicketSetContent {
  if (!isPortOutput(content)) throw new Error("unreachable");
  return content;
}

/** What the running run asks its port; a failure throws. */
async function runWorkOf(runId: string) {
  const work = await prepareRun(context.db, runId);
  if (!work.ok) throw new Error(work.error.code);
  return work.value;
}

/** The ids of the stored current version's tickets. */
function storedIds(ticketSetId: string, version: number): string[] {
  return readSetVersion(context.db, ticketSetId, version).content.tickets.map((t) => t.id);
}

const invalid: [string, unknown][] = [
  ["zero tickets", { ...TICKETS, tickets: [], dispositions: TICKETS.dispositions }],
  [
    "a criterion of the revision with no disposition",
    { ...TICKETS, dispositions: TICKETS.dispositions.slice(0, 1) },
  ],
  [
    "a second disposition of one criterion",
    {
      ...TICKETS,
      dispositions: [
        ...TICKETS.dispositions,
        { criterion: "1.1", kind: "satisfied", evidence: "x" },
      ],
    },
  ],
  [
    "a disposition of an unknown criterion",
    {
      ...TICKETS,
      dispositions: [
        ...TICKETS.dispositions,
        { criterion: "9.1", kind: "satisfied", evidence: "x" },
      ],
    },
  ],
  [
    "a work disposition naming a ticket that does not list the criterion",
    {
      ...TICKETS,
      dispositions: [
        { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    },
  ],
  [
    "a work disposition naming an unknown ticket",
    {
      ...TICKETS,
      dispositions: [
        { criterion: "1.1", kind: "work", ticket: "T9", reason: null },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    },
  ],
  [
    "a criterion a ticket lists with no work disposition naming it",
    {
      ...TICKETS,
      dispositions: [
        { criterion: "1.1", kind: "satisfied", evidence: "Already downloads." },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    },
  ],
  [
    "a ticket listing a criterion unknown to the revision",
    { ...TICKETS, tickets: [T1, { ...T2, criteria: ["1.1", "3.1"] }] },
  ],
  [
    "satisfied without evidence",
    {
      ...TICKETS,
      tickets: [T1],
      dispositions: [
        { criterion: "1.1", kind: "satisfied" },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    },
  ],
  [
    "satisfied with empty evidence",
    {
      ...TICKETS,
      tickets: [T1],
      dispositions: [
        { criterion: "1.1", kind: "satisfied", evidence: "" },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    },
  ],
  [
    "another disposition kind",
    {
      ...TICKETS,
      dispositions: [
        { criterion: "1.1", kind: "retained", ticket: "T2", reason: null },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    },
  ],
  [
    "a blocker naming a later ticket",
    {
      ...TICKETS,
      tickets: [
        { ...T1, blockedBy: [{ ticket: "T2", supplies: "the button" }] },
        { ...T2, blockedBy: [] },
      ],
    },
  ],
  [
    "a blocker naming the ticket itself",
    { ...TICKETS, tickets: [T1, { ...T2, blockedBy: [{ ticket: "T2", supplies: "itself" }] }] },
  ],
  [
    "a blocker naming an unknown ticket",
    { ...TICKETS, tickets: [T1, { ...T2, blockedBy: [{ ticket: "T7", supplies: "nothing" }] }] },
  ],
  [
    "a follow-up naming an undelivered ticket",
    { ...TICKETS, tickets: [T1, { ...T2, followUp: "T1" }] },
  ],
  ["two tickets sharing an id", { ...TICKETS, tickets: [T1, { ...T2, id: "T1" }] }],
];

describe("to_tickets content against the revision", () => {
  test.each(invalid)(
    "%s fails the run ticket_set_content_invalid and writes nothing",
    async (_, content) => {
      const { specRevisionId, run } = await awaitingTickets();
      expect(recordTicketSet(context.user, context.db, run.id, unchecked(content))).toMatchObject({
        ok: false,
        error: { code: "ticket_set_content_invalid" },
      });
      expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
      expect(context.db.select().from(ticketSetVersions).all()).toEqual([]);
      const ended = runsOf(context, run.mapId).find((candidate) => candidate.id === run.id);
      expect(ended).toMatchObject({ state: "failed", errorCode: "ticket_set_content_invalid" });
    },
  );

  test("a valid set with a satisfied criterion is saved as version 1 awaiting review", async () => {
    const { specRevisionId, run } = await awaitingTickets();
    const content: TicketSetContent = {
      ...TICKETS,
      tickets: [T1],
      dispositions: [
        { criterion: "1.1", kind: "satisfied", evidence: "The download already exists." },
        { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      ],
    };
    expect(recordTicketSet(context.user, context.db, run.id, content)).toEqual({
      ok: true,
      value: null,
    });
    const set = readTicketSetOf(context.db, specRevisionId);
    expect(set).toMatchObject({ state: "awaiting_review", version: 1, approvedAt: null });
    if (set === undefined) throw new Error("no set");
    expect(readSetVersion(context.db, set.id, 1).content).toEqual(content);
  });

  test("a run cancelled while its port call was out saves nothing", async () => {
    const { specRevisionId, run } = await awaitingTickets();
    writeTestData(context, (tx) =>
      tx
        .update(planningRuns)
        .set({ state: "cancelled", cancelReason: "reopened", endedAt: new Date().toISOString() })
        .where(eq(planningRuns.id, run.id))
        .run(),
    );
    expect(recordTicketSet(context.user, context.db, run.id, TICKETS)).toEqual({
      ok: true,
      value: null,
    });
    expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
    expect(context.db.select().from(ticketSetVersions).all()).toEqual([]);
    const ended = runsOf(context, run.mapId).find((candidate) => candidate.id === run.id);
    expect(ended).toMatchObject({ state: "cancelled", cancelReason: "reopened" });
  });
});

describe("ticket numbering", () => {
  test("a spec's first set numbers from T1", async () => {
    const { ticketSetId } = await reviewedTicketSet(context, project);
    expect(storedIds(ticketSetId, 1)).toEqual(["T1", "T2"]);
  });

  /**
   * Spec 1's revision 1 with an approved set (T1, T2), then revision 2 approved on the same map
   * (rows inserted directly, not by a re-clear) with its
   * `to_tickets` running.
   */
  async function laterRevision() {
    const first = await reviewedTicketSet(context, project);
    expect(approveTicketSet(context.user, context.db, { ticketSetId: first.ticketSetId }).ok).toBe(
      true,
    );
    const writer = insertRun(context, {
      mapId: first.mapId,
      specificationId: first.specificationId,
      purpose: "to_spec",
      state: "completed",
    });
    const specRevisionId = insertRevision(context, {
      specificationId: first.specificationId,
      revision: 2,
      mapId: first.mapId,
      writtenByRun: writer.id,
      content: SPEC,
      approvedAt: new Date().toISOString(),
    });
    const run = insertRun(context, {
      mapId: first.mapId,
      specificationId: first.specificationId,
      purpose: "to_tickets",
      state: "running",
    });
    return { mapId: first.mapId, specRevisionId, run };
  }

  test("with an approved set of an earlier revision, a set from one past its highest is saved with its ids", async () => {
    const { specRevisionId, run } = await laterRevision();
    expect(recordTicketSet(context.user, context.db, run.id, renumbered(TICKETS, 2))).toEqual({
      ok: true,
      value: null,
    });
    const set = readTicketSetOf(context.db, specRevisionId);
    if (set === undefined) throw new Error("no set");
    expect(readSetVersion(context.db, set.id, 1).content).toEqual(renumbered(TICKETS, 2));
  });

  test.each([
    ["from T1", TICKETS],
    ["from T5", renumbered(TICKETS, 4)],
    [
      "out of order",
      {
        ...renumbered(TICKETS, 2),
        tickets: [...renumbered(TICKETS, 2).tickets]
          .reverse()
          .map((t) => ({ ...t, blockedBy: [] })),
      },
    ],
  ])(
    "ids starting anywhere but the start number, or out of order (%s), are refused, writing nothing",
    async (_, content) => {
      const { specRevisionId, run } = await laterRevision();
      expect(recordTicketSet(context.user, context.db, run.id, content)).toMatchObject({
        ok: false,
        error: { code: "ticket_set_content_invalid" },
      });
      expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
    },
  );

  test("a rewrite before approval numbers from the same start", async () => {
    const { mapId, specRevisionId, run } = await laterRevision();
    expect(recordTicketSet(context.user, context.db, run.id, renumbered(TICKETS, 2)).ok).toBe(true);
    const set = readTicketSetOf(context.db, specRevisionId);
    if (set === undefined) throw new Error("no set");
    recordRunningTicketsReview(context, mapId);
    expect(
      rejectTicketSet(context.user, context.db, { ticketSetId: set.id, reason: REASON }).ok,
    ).toBe(true);
    const rewrite = runningSpecRun(context, mapId, "to_tickets");
    expect(recordTicketSet(context.user, context.db, rewrite.id, TICKETS).ok).toBe(false);
    const retry = runningSpecRun(context, mapId, "to_tickets");
    expect(recordTicketSet(context.user, context.db, retry.id, renumbered(TICKETS, 2)).ok).toBe(
      true,
    );
    expect(storedIds(set.id, 2)).toEqual(["T3", "T4"]);
  });
});

/** TICKETS (T1, T2) with every ticket number raised by `by`. */
function renumbered(content: TicketSetContent, by: number): TicketSetContent {
  const raise = (id: string) => `T${String(Number(id.slice(1)) + by)}`;
  return {
    ...content,
    tickets: content.tickets.map((ticket) => ({
      ...ticket,
      id: raise(ticket.id),
      blockedBy: ticket.blockedBy.map((blocker) => ({ ...blocker, ticket: raise(blocker.ticket) })),
    })),
    dispositions: content.dispositions.map((disposition) =>
      disposition.kind === "work"
        ? { ...disposition, ticket: raise(disposition.ticket) }
        : disposition,
    ),
  };
}

describe("rejection and rewrite", () => {
  test("reject records the reason against version 1 and starts the rewrite with it", async () => {
    const { ticketSetId, run } = await rejectedSet();
    expect(context.db.select().from(ticketSetRejections).all()).toMatchObject([
      { ticketSetId, version: 1, reason: REASON },
    ]);
    const work = await runWorkOf(run.id);
    expect(work).toMatchObject({
      purpose: "to_tickets",
      request: { rewrite: { version: 1, content: TICKETS, reason: REASON, findings: [] } },
    });
  });

  test("a first to_tickets asks no rewrite", async () => {
    const { run } = await awaitingTickets();
    expect(await runWorkOf(run.id)).toMatchObject({ request: { rewrite: null } });
  });

  test("the rewrite writes version 2 awaiting review; version 1's content is unchanged", async () => {
    const { mapId, ticketSetId, run } = await rejectedSet();
    const before = readSetVersion(context.db, ticketSetId, 1);
    const rewritten: TicketSetContent = {
      ...TICKETS,
      slicing: "The button first, then the exporter.",
    };
    expect(recordTicketSet(context.user, context.db, run.id, rewritten)).toEqual({
      ok: true,
      value: null,
    });
    const [set] = context.db.select().from(ticketSets).all();
    expect(set).toMatchObject({ id: ticketSetId, state: "awaiting_review", version: 2 });
    expect(readSetVersion(context.db, ticketSetId, 1)).toEqual(before);
    expect(readSetVersion(context.db, ticketSetId, 2).content).toEqual(rewritten);
    // The rewrite's version gets its own review, started with it; approval waits for it.
    expect(
      runsOf(context, mapId)
        .filter((candidate) => candidate.state === "running")
        .map((candidate) => candidate.purpose),
    ).toEqual(["tickets_review"]);
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toMatchObject({
      ok: false,
      error: { code: "review_in_flight" },
    });
    recordRunningTicketsReview(context, mapId);
    expect(context.db.select().from(ticketsReviews).all()).toMatchObject([
      { ticketSetVersion: 1, passed: true },
      { ticketSetVersion: 2, passed: true },
    ]);
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toEqual({
      ok: true,
      value: mapId,
    });
    expect(context.db.select().from(ticketSets).get()).toMatchObject({
      state: "approved",
      version: 2,
    });
  });

  test("version 2 can be rejected in turn; the rewrite writes version 3", async () => {
    const { mapId, ticketSetId, run } = await rejectedSet();
    expect(recordTicketSet(context.user, context.db, run.id, TICKETS).ok).toBe(true);
    recordRunningTicketsReview(context, mapId);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }).ok).toBe(
      true,
    );
    const second = runningSpecRun(context, mapId, "to_tickets");
    expect(await runWorkOf(second.id)).toMatchObject({
      request: { rewrite: { version: 2 } },
    });
    expect(recordTicketSet(context.user, context.db, second.id, TICKETS).ok).toBe(true);
    expect(context.db.select().from(ticketSets).get()).toMatchObject({ version: 3 });
    expect(
      context.db
        .select()
        .from(ticketSetRejections)
        .all()
        .map((rejection) => rejection.version),
    ).toEqual([1, 2]);
  });

  test("an invalid rewrite writes nothing and its retry still asks the rewrite", async () => {
    const { mapId, ticketSetId, run } = await rejectedSet();
    expect(
      recordTicketSet(context.user, context.db, run.id, { ...TICKETS, tickets: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "ticket_set_content_invalid" },
    });
    expect(context.db.select().from(ticketSets).get()).toMatchObject({ version: 1 });
    const retry = runningSpecRun(context, mapId, "to_tickets");
    expect(retry.retryOfRunId).toBe(run.id);
    expect(await runWorkOf(retry.id)).toMatchObject({
      request: { rewrite: { version: 1, reason: REASON } },
    });
    expect(storedIds(ticketSetId, 1)).toEqual(["T1", "T2"]);
  });

  test("a rewrite's retry, and its Try again, carry the code and problem core refused it for", async () => {
    const { mapId, run } = await rejectedSet();
    const refusedFor = async (runId: string) => {
      const work = await runWorkOf(runId);
      if (work.purpose !== "to_tickets") throw new Error("not a to_tickets run");
      return work.request.refusedAttempt;
    };
    const stored = (runId: string) => {
      const found = runsOf(context, mapId).find((candidate) => candidate.id === runId);
      if (found?.errorMessage == null) throw new Error("no stored message");
      return found.errorMessage;
    };
    expect(await refusedFor(run.id)).toBeNull();
    expect(recordTicketSet(context.user, context.db, run.id, { ...TICKETS, tickets: [] }).ok).toBe(
      false,
    );
    const retry = runningSpecRun(context, mapId, "to_tickets");
    expect(retry.retryOfRunId).toBe(run.id);
    expect(await refusedFor(retry.id)).toEqual({
      code: "ticket_set_content_invalid",
      problem: stored(run.id),
    });
    expect(
      recordTicketSet(context.user, context.db, retry.id, { ...TICKETS, tickets: [] }).ok,
    ).toBe(false);
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const again = runningSpecRun(context, mapId, "to_tickets");
    expect(await refusedFor(again.id)).toEqual({
      code: "ticket_set_content_invalid",
      problem: stored(retry.id),
    });
  });

  test("a retry after a failure core did not refuse carries no refusal", async () => {
    const { mapId, run } = await rejectedSet();
    failRun(context.user, context.db, run.id, { code: "agent_run_failed", message: "first" });
    const retry = runningSpecRun(context, mapId, "to_tickets");
    const work = await runWorkOf(retry.id);
    expect(work.purpose === "to_tickets" && work.request.refusedAttempt).toBeNull();
  });

  test("reject refuses review_in_flight while the rewrite runs", async () => {
    const { ticketSetId } = await rejectedSet();
    for (const decided of [
      rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }),
      approveTicketSet(context.user, context.db, { ticketSetId }),
    ]) {
      expect(decided).toMatchObject({ ok: false, error: { code: "review_in_flight" } });
    }
  });

  test("ticket_set_decided comes before review_in_flight", async () => {
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(approveTicketSet(context.user, context.db, { ticketSetId }).ok).toBe(true);
    insertRun(context, { mapId, specificationId, purpose: "to_tickets", state: "running" });
    for (const decided of [
      rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }),
      approveTicketSet(context.user, context.db, { ticketSetId }),
    ]) {
      expect(decided).toMatchObject({ ok: false, error: { code: "ticket_set_decided" } });
    }
  });

  test("a passed version whose rejection rewrite stopped is not decided; Try again stays", async () => {
    const { mapId, ticketSetId, run } = await rejectedSet();
    failRun(context.user, context.db, run.id, { code: "agent_run_failed", message: "first" });
    const retry = runningSpecRun(context, mapId, "to_tickets");
    failRun(context.user, context.db, retry.id, { code: "agent_run_failed", message: "second" });
    expect(runsOf(context, mapId).filter((other) => other.state === "running")).toEqual([]);
    expect(context.db.select().from(ticketSets).get()).toMatchObject({ state: "review_passed" });
    for (const decided of [
      approveTicketSet(context.user, context.db, { ticketSetId }),
      rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }),
    ]) {
      expect(decided).toMatchObject({ ok: false, error: { code: "review_in_flight" } });
    }
    expect(tryAgain(context.user, context.db, retry.id)).toEqual({ ok: true, value: mapId });
  });

  test("Try again on a stopped rewrite starts it again", async () => {
    const { mapId, run } = await rejectedSet();
    failRun(context.user, context.db, run.id, { code: "agent_run_failed", message: "first" });
    const retry = runningSpecRun(context, mapId, "to_tickets");
    failRun(context.user, context.db, retry.id, { code: "agent_run_failed", message: "second" });
    expect(tryAgain(context.user, context.db, retry.id)).toEqual({ ok: true, value: mapId });
    const fresh = runningSpecRun(context, mapId, "to_tickets");
    expect(await runWorkOf(fresh.id)).toMatchObject({ request: { rewrite: { version: 1 } } });
  });
});

/** The purposes of the map's running spec-scoped runs, oldest first. */
function runningPurposes(mapId: string): string[] {
  return runsOf(context, mapId)
    .filter((run) => run.state === "running" && run.specificationId !== null)
    .map((run) => run.purpose);
}

/** Whether the set's decisions are both refused with `code`. */
function expectDecisionsRefused(ticketSetId: string, code: string): void {
  for (const decided of [
    approveTicketSet(context.user, context.db, { ticketSetId }),
    rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }),
  ]) {
    expect(decided).toMatchObject({ ok: false, error: { code } });
  }
}

describe("the first tickets review", () => {
  test("a written set's first version gets one tickets_review, started in the writing transaction", async () => {
    const { run, mapId } = await awaitingTickets();
    expect(runningPurposes(mapId)).toEqual(["to_tickets"]);
    expect(recordTicketSet(context.user, context.db, run.id, TICKETS).ok).toBe(true);
    expect(runningPurposes(mapId)).toEqual(["tickets_review"]);
    const review = await runWorkOf(runningSpecRun(context, mapId, "tickets_review").id);
    expect(review).toMatchObject({
      purpose: "tickets_review",
      request: {
        projectName: project.name,
        projectFolder: project.folderPath,
        baseBranch: "main",
        idea: "Export data",
        approved: { specNumber: 1, revision: 1, content: SPEC },
        ticketSet: { version: 1, content: TICKETS },
      },
    });
  });

  test("no tickets_review starts while a to_tickets runs", async () => {
    const { mapId, specificationId } = await unreviewedTicketSet(context, project);
    insertRun(context, { mapId, specificationId, purpose: "to_tickets", state: "running" });
    writeTestData(context, (tx) => {
      planNext(context.user, tx, mapId);
    });
    expect(runningPurposes(mapId)).toEqual(["to_tickets"]);
  });

  test("a passed review sets review_passed; a review with a finding sets review_failed, keeping its route and question", async () => {
    const passed = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, passed.mapId);
    expect(context.db.select().from(ticketsReviews).all()).toMatchObject([
      { ticketSetId: passed.ticketSetId, ticketSetVersion: 1, passed: true },
    ]);
    expect(context.db.select().from(ticketSets).get()?.state).toBe("review_passed");
    // One review per version: nothing starts after it.
    expect(runningPurposes(passed.mapId)).toEqual([]);

    const other = await addProject(context, "other");
    const failed = await draftedTicketSet(context, other);
    recordRunningTicketsReview(context, failed.mapId, {
      summary: "One criterion is not traced.",
      findings: [TICKETS_REVISE_FINDING],
    });
    const failedSet = context.db
      .select()
      .from(ticketSets)
      .all()
      .find((set) => set.id === failed.ticketSetId);
    expect(failedSet?.state).toBe("review_failed");
    expect(context.db.select().from(ticketsReviewFindings).all()).toMatchObject([
      {
        position: 1,
        route: TICKETS_REVISE_FINDING.route,
        question: TICKETS_REVISE_FINDING.question,
        escalated: false,
      },
    ]);
  });

  test("a second review of the same version is impossible (unique key)", async () => {
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    const second = insertTicketsReviewRun(context, { mapId, specificationId, state: "running" });
    expect(() =>
      recordTicketsReview(context.user, context.db, second.id, PASSED_TICKETS_REVIEW),
    ).toThrow();
    const [first] = context.db.select().from(ticketsReviews).all();
    if (first === undefined) throw new Error("No review");
    let caught: unknown;
    try {
      writeTestData(context, (tx) =>
        tx
          .insert(ticketsReviews)
          .values({ ...first, id: UNKNOWN_REVIEW_ID, runId: second.id })
          .run(),
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(isUniqueConstraintViolation(caught)).toBe(true);
    expect(context.db.select().from(ticketsReviews).all()).toMatchObject([
      { ticketSetId, ticketSetVersion: 1 },
    ]);
  });

  test.each([
    ["an unknown ticket", { ticketNumbers: ["T9"] }],
    ["an unknown criterion", { criterionIds: ["9.9"] }],
  ])(
    "a finding naming %s fails review_reference_unknown, writes nothing and is retried",
    async (_name, names) => {
      const { mapId } = await draftedTicketSet(context, project);
      const run = runningSpecRun(context, mapId, "tickets_review");
      const recorded = recordTicketsReview(context.user, context.db, run.id, {
        summary: "One finding.",
        findings: [{ ...TICKETS_REVISE_FINDING, ...names }],
      });
      expect(recorded).toMatchObject({ ok: false, error: { code: "review_reference_unknown" } });
      expect(context.db.select().from(ticketsReviews).all()).toEqual([]);
      expect(context.db.select().from(ticketSets).get()?.state).toBe("awaiting_review");
      expect(runningSpecRun(context, mapId, "tickets_review").retryOfRunId).toBe(run.id);
    },
  );
});

describe("the approval gate", () => {
  test("a running review is review_in_flight", async () => {
    const { ticketSetId } = await draftedTicketSet(context, project);
    expectDecisionsRefused(ticketSetId, "review_in_flight");
  });

  test("a stopped review is ticket_set_review_not_passed", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    const review = runningSpecRun(context, mapId, "tickets_review");
    failRun(context.user, context.db, review.id, { code: "agent_run_failed", message: "first" });
    const retry = runningSpecRun(context, mapId, "tickets_review");
    failRun(context.user, context.db, retry.id, { code: "agent_run_failed", message: "second" });
    expectDecisionsRefused(ticketSetId, "ticket_set_review_not_passed");
  });

  test("a failed review is ticket_set_review_not_passed; its repair running comes first", async () => {
    const { mapId, specificationId, ticketSetId } = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, {
      mapId,
      specificationId,
      ticketSetId,
      findings: [{ finding: TICKETS_REVISE_FINDING, escalated: false }],
    });
    expectDecisionsRefused(ticketSetId, "ticket_set_review_not_passed");
    insertRun(context, { mapId, specificationId, purpose: "to_tickets", state: "running" });
    expectDecisionsRefused(ticketSetId, "review_in_flight");
  });

  test("a recorded revise-only failed review starts its repair, so decisions are review_in_flight", async () => {
    const { mapId, ticketSetId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId, {
      summary: "One criterion is not traced.",
      findings: [TICKETS_REVISE_FINDING],
    });
    expectDecisionsRefused(ticketSetId, "review_in_flight");
  });

  test("a held review is ticket_set_review_not_passed", async () => {
    const { mapId, specificationId, ticketSetId } = await unreviewedTicketSet(context, project);
    insertTicketsReview(context, {
      mapId,
      specificationId,
      ticketSetId,
      findings: [{ finding: TICKETS_REVISE_FINDING, escalated: true }],
    });
    expectDecisionsRefused(ticketSetId, "ticket_set_review_not_passed");
  });

  test("a set with no review is ticket_set_review_not_passed; only review_passed approves", async () => {
    const { mapId, specificationId, ticketSetId } = await unreviewedTicketSet(context, project);
    expectDecisionsRefused(ticketSetId, "ticket_set_review_not_passed");
    insertTicketsReview(context, { mapId, specificationId, ticketSetId, findings: [] });
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toEqual({
      ok: true,
      value: mapId,
    });
  });
});

describe("a review whose set moved on saves nothing", () => {
  test("the set was approved meanwhile", async () => {
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(approveTicketSet(context.user, context.db, { ticketSetId }).ok).toBe(true);
    const late = insertTicketsReviewRun(context, { mapId, specificationId, state: "running" });
    expect(
      recordTicketsReview(context.user, context.db, late.id, {
        summary: "One finding.",
        findings: [TICKETS_REVISE_FINDING],
      }),
    ).toEqual({ ok: true, value: null });
    expect(context.db.select().from(ticketsReviews).all()).toHaveLength(1);
    expect(context.db.select().from(ticketSets).get()?.state).toBe("approved");
    expect(runsOf(context, mapId).find((run) => run.id === late.id)?.state).toBe("completed");
  });

  test("the set was rewritten meanwhile; the new version gets its own review", async () => {
    const { mapId, specificationId, ticketSetId } = await unreviewedTicketSet(context, project);
    const late = insertTicketsReviewRun(context, { mapId, specificationId, state: "running" });
    insertTicketsRepair(context, { mapId, specificationId, ticketSetId, state: "completed" });
    expect(recordTicketsReview(context.user, context.db, late.id, PASSED_TICKETS_REVIEW)).toEqual({
      ok: true,
      value: null,
    });
    expect(context.db.select().from(ticketsReviews).all()).toEqual([]);
    expect(context.db.select().from(ticketSets).get()).toMatchObject({
      state: "awaiting_review",
      version: 2,
    });
    expect(runsOf(context, mapId).find((run) => run.id === late.id)?.state).toBe("completed");
    const fresh = runningSpecRun(context, mapId, "tickets_review");
    expect(await runWorkOf(fresh.id)).toMatchObject({ request: { ticketSet: { version: 2 } } });
  });
});

// --- A later revision's set against the stored records ---

/** r2 of the delivered spec: 1.1 unchanged, 1.2 removed, 1.3 new, and a new clause C2 with 2.1. */
const R2_SPEC: SpecRevisionContent = {
  ...SPEC,
  clauses: [
    {
      id: "C1",
      title: "CSV export",
      text: "Every record exports to one CSV file, sorted.",
      criteria: [
        { id: "1.1", text: "A CSV file downloads." },
        { id: "1.3", text: "Rows are sorted by date." },
      ],
      sources: [{ kind: "destination" }],
      reliesOn: [],
      adds: ["new behaviour"],
    },
    {
      id: "C2",
      title: "Streaming",
      text: "Large exports stream.",
      criteria: [{ id: "2.1", text: "A large export streams." }],
      sources: [{ kind: "destination" }],
      reliesOn: [],
      adds: ["new behaviour"],
    },
  ],
};

function laterTicket(id: string, criteria: string[]): TicketContent {
  return {
    id,
    title: `Ticket ${id}`,
    build: "Build it.",
    blockedBy: [],
    criteria,
    testing: ["Tests pass."],
    followUp: null,
    outOfScope: [],
    pointers: ["src/index.ts"],
  };
}

/**
 * A valid r2 set: `delivered` (1.1 by T2), `work` with a follow-up (1.3 by T3, following T1),
 * `satisfied` and `removed` with a taking-out ticket (1.2 by T4, which carries nothing).
 */
const R2_TICKETS: TicketSetContent = {
  tickets: [
    { ...laterTicket("T3", ["1.3"]), followUp: "T1" },
    {
      ...laterTicket("T4", []),
      blockedBy: [{ ticket: "T3", supplies: "the sorted exporter" }],
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
    { criterion: "1.3", kind: "work", ticket: "T3", reason: null },
    { criterion: "2.1", kind: "satisfied", evidence: "Exports already stream." },
    { criterion: "1.2", kind: "removed", ticket: "T4", reason: "T1 exports every row." },
  ],
  slicing: "Sort, then take the full export out.",
  execution: "Package tests.",
};

const [R2_T3, R2_T4] = R2_TICKETS.tickets;
if (R2_T3 === undefined || R2_T4 === undefined) {
  throw new Error("R2_TICKETS has two tickets");
}

/** R2_TICKETS with 1.2 removed by no ticket: T3 alone. */
const R2_REMOVED_BY_NONE: TicketSetContent = {
  ...R2_TICKETS,
  tickets: [R2_T3],
  dispositions: [
    ...R2_TICKETS.dispositions.filter((d) => d.criterion !== "1.2"),
    { criterion: "1.2", kind: "removed", ticket: null, reason: "Nothing exports partial rows." },
  ],
};

function withDispositions(
  content: TicketSetContent,
  replace: (d: Disposition) => Disposition[],
): TicketSetContent {
  return { ...content, dispositions: content.dispositions.flatMap(replace) };
}

/**
 * Spec 1's r1 delivered (T1, T2 merged in run 1) on its map, and `content` written as the next
 * revision, approved, by `writer` (another map unless given), with its `to_tickets` running.
 */
async function deliveredThenRevised(content: SpecRevisionContent, writer?: "same-map") {
  const delivered = await deliveredSpec(context, project);
  const mapId = writer === "same-map" ? delivered.mapId : await clearedMap(context, project);
  const next = insertNextRevision(context, {
    specificationId: delivered.specificationId,
    mapId,
    content,
    approved: true,
    set: null,
  });
  const run = insertRun(context, {
    mapId,
    specificationId: delivered.specificationId,
    purpose: "to_tickets",
    state: "running",
  });
  return { ...delivered, mapId, specRevisionId: next.specRevisionId, run };
}

const refusedLater: [string, TicketSetContent][] = [
  ["ids from T1", { ...R2_REMOVED_BY_NONE, tickets: [{ ...R2_T3, id: "T1" }] }],
  [
    "a disposition of a criterion the revision neither has nor removes",
    withDispositions(R2_TICKETS, (d) =>
      d.criterion === "2.1" ? [d, { criterion: "9.9", kind: "satisfied", evidence: "Done." }] : [d],
    ),
  ],
  [
    "a second disposition of a criterion",
    withDispositions(R2_TICKETS, (d) => (d.criterion === "2.1" ? [d, d] : [d])),
  ],
  [
    "a criterion of the revision with none",
    withDispositions(R2_TICKETS, (d) => (d.criterion === "2.1" ? [] : [d])),
  ],
  [
    "a criterion of the revision removed",
    withDispositions(R2_TICKETS, (d) =>
      d.criterion === "2.1"
        ? [{ criterion: "2.1", kind: "removed", ticket: null, reason: "Gone." }]
        : [d],
    ),
  ],
  [
    "a removed criterion with none",
    withDispositions(R2_REMOVED_BY_NONE, (d) => (d.criterion === "1.2" ? [] : [d])),
  ],
  [
    "a removed criterion with another kind",
    withDispositions(R2_REMOVED_BY_NONE, (d) =>
      d.criterion === "1.2" ? [{ criterion: "1.2", kind: "satisfied", evidence: "Done." }] : [d],
    ),
  ],
  [
    "work naming a set ticket that does not carry it",
    withDispositions(R2_TICKETS, (d) =>
      d.criterion === "1.3"
        ? [{ criterion: "1.3", kind: "work", ticket: "T4", reason: null }]
        : [d],
    ),
  ],
  [
    "a ticket carrying a criterion without its work",
    { ...R2_TICKETS, tickets: [R2_T3, { ...R2_T4, criteria: ["2.1"] }] },
  ],
  [
    "delivered naming a ticket no merged run delivered",
    withDispositions(R2_TICKETS, (d) =>
      d.criterion === "1.1"
        ? [{ criterion: "1.1", kind: "delivered", ticket: "T3", reason: null }]
        : [d],
    ),
  ],
  [
    "a follow-up naming a ticket no merged run delivered",
    { ...R2_TICKETS, tickets: [{ ...R2_T3, followUp: "T9" }, R2_T4] },
  ],
  [
    "retained naming a delivered ticket",
    withDispositions(R2_TICKETS, (d) =>
      d.criterion === "1.1"
        ? [{ criterion: "1.1", kind: "retained", ticket: "T2", reason: null }]
        : [d],
    ),
  ],
  [
    "removed naming a ticket not in the set",
    withDispositions(R2_TICKETS, (d) =>
      d.criterion === "1.2" ? [{ ...d, kind: "removed", ticket: "T9", reason: "Gone." }] : [d],
    ),
  ],
  [
    "a ticket carrying no criterion that takes none out",
    { ...R2_REMOVED_BY_NONE, tickets: [R2_T3, { ...R2_T4 }] },
  ],
  [
    "a blocker naming a later ticket",
    {
      ...R2_TICKETS,
      tickets: [
        { ...R2_T3, blockedBy: [{ ticket: "T4", supplies: "the removal" }] },
        { ...R2_T4, blockedBy: [] },
      ],
    },
  ],
];

describe("a later revision's set against the stored records", () => {
  test.each(refusedLater)(
    "%s fails the run ticket_set_content_invalid and writes nothing",
    async (_, content) => {
      const { specRevisionId, run } = await deliveredThenRevised(R2_SPEC);
      expect(recordTicketSet(context.user, context.db, run.id, content)).toMatchObject({
        ok: false,
        error: { code: "ticket_set_content_invalid" },
      });
      expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
      const ended = runsOf(context, run.mapId).find((candidate) => candidate.id === run.id);
      expect(ended).toMatchObject({ state: "failed", errorCode: "ticket_set_content_invalid" });
    },
  );

  test.each([
    ["delivered, work with a follow-up, satisfied and removed by a taking-out ticket", R2_TICKETS],
    ["removed by no ticket", R2_REMOVED_BY_NONE],
  ])("a valid set (%s) is saved with its ids unchanged", async (_, content) => {
    const { specRevisionId, run } = await deliveredThenRevised(R2_SPEC);
    expect(recordTicketSet(context.user, context.db, run.id, content)).toEqual({
      ok: true,
      value: null,
    });
    const set = readTicketSetOf(context.db, specRevisionId);
    if (set === undefined) throw new Error("no set");
    expect(readSetVersion(context.db, set.id, 1).content).toEqual(content);
  });

  test("a set with nothing new to build (zero tickets) is saved", async () => {
    const { specRevisionId, run } = await deliveredThenRevised(SPEC);
    const content: TicketSetContent = {
      ...R2_TICKETS,
      tickets: [],
      dispositions: [
        { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
        { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
      ],
    };
    expect(recordTicketSet(context.user, context.db, run.id, content).ok).toBe(true);
    expect(readTicketSetOf(context.db, specRevisionId)).toMatchObject({ state: "awaiting_review" });
  });

  test("a criterion dropped in a replaced middle revision with a baseline must be taken out", async () => {
    const delivered = await deliveredSpec(context, project);
    const mapId = await clearedMap(context, project);
    const middle = { ...R2_SPEC, clauses: R2_SPEC.clauses.slice(0, 1) };
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId,
      content: middle,
      approved: true,
      set: { state: "review_passed", content: R2_REMOVED_BY_NONE },
    });
    const r3 = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId,
      content: R2_SPEC,
      approved: true,
      set: null,
    });
    const run = insertRun(context, {
      mapId,
      specificationId: delivered.specificationId,
      purpose: "to_tickets",
      state: "running",
    });
    const without = withDispositions(R2_REMOVED_BY_NONE, (d) => (d.criterion === "1.2" ? [] : [d]));
    expect(recordTicketSet(context.user, context.db, run.id, without)).toMatchObject({
      ok: false,
      error: { code: "ticket_set_content_invalid" },
    });
    expect(readTicketSetOf(context.db, r3.specRevisionId)).toBeUndefined();
    const retry = runningSpecRun(context, mapId, "to_tickets");
    expect(recordTicketSet(context.user, context.db, retry.id, R2_REMOVED_BY_NONE).ok).toBe(true);
  });

  test("a criterion an approved set of an earlier revision took out is never demanded again", async () => {
    // r1 delivered (T1 carries 1.2); another map's r2 drops 1.2 and its approved set takes it out;
    // the first map's r3 words r2 again.
    const delivered = await deliveredSpec(context, project);
    const other = await clearedMap(context, project);
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: R2_SPEC,
      approved: true,
      set: { state: "approved", content: R2_REMOVED_BY_NONE },
    });
    const r3 = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: R2_SPEC,
      approved: true,
      set: null,
    });
    const nothingNew: TicketSetContent = {
      ...R2_TICKETS,
      tickets: [],
      dispositions: [
        { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
        { criterion: "1.3", kind: "retained", ticket: "T3", reason: null },
        { criterion: "2.1", kind: "satisfied", evidence: "Exports already stream." },
      ],
    };
    const taken = insertRun(context, {
      mapId: delivered.mapId,
      specificationId: delivered.specificationId,
      purpose: "to_tickets",
      state: "running",
    });
    const again = withDispositions(nothingNew, (d) =>
      d.criterion === "2.1"
        ? [d, { criterion: "1.2", kind: "removed", ticket: null, reason: "Gone." }]
        : [d],
    );
    expect(recordTicketSet(context.user, context.db, taken.id, again)).toMatchObject({
      ok: false,
      error: { code: "ticket_set_content_invalid" },
    });
    const retry = runningSpecRun(context, delivered.mapId, "to_tickets");
    expect(recordTicketSet(context.user, context.db, retry.id, nothingNew)).toEqual({
      ok: true,
      value: null,
    });
    expect(readTicketSetOf(context.db, r3.specRevisionId)).toMatchObject({
      state: "awaiting_review",
    });
  });

  /** r1 approved and undelivered (T1, T2); `writer` writes r2 = SPEC approved, its to_tickets running. */
  async function undeliveredThenRevised(writer: "same-map" | "another-map") {
    const set = await deliverableTicketSet(context, project);
    const mapId = writer === "same-map" ? set.mapId : await clearedMap(context, project);
    const next = insertNextRevision(context, {
      specificationId: set.specificationId,
      mapId,
      content: SPEC,
      approved: true,
      set: null,
    });
    const run = insertRun(context, {
      mapId,
      specificationId: set.specificationId,
      purpose: "to_tickets",
      state: "running",
    });
    return { specRevisionId: next.specRevisionId, run };
  }

  const RETAINED: TicketSetContent = {
    ...R2_TICKETS,
    tickets: [],
    dispositions: [
      { criterion: "1.1", kind: "retained", ticket: "T2", reason: null },
      { criterion: "1.2", kind: "retained", ticket: "T1", reason: null },
    ],
  };

  test("retained naming an open carrier of another map's approved, undelivered set is saved", async () => {
    const { run } = await undeliveredThenRevised("another-map");
    expect(recordTicketSet(context.user, context.db, run.id, RETAINED)).toEqual({
      ok: true,
      value: null,
    });
  });

  test("retained is refused on a same-map note: its carrier is no longer deliverable", async () => {
    const { specRevisionId, run } = await undeliveredThenRevised("same-map");
    expect(recordTicketSet(context.user, context.db, run.id, RETAINED)).toMatchObject({
      ok: false,
      error: { code: "ticket_set_content_invalid" },
    });
    expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
  });

  test("retained naming an open ticket that does not carry the criterion is refused", async () => {
    const { run } = await undeliveredThenRevised("another-map");
    const swapped = withDispositions(RETAINED, (d) =>
      d.criterion === "1.1"
        ? [{ criterion: "1.1", kind: "retained", ticket: "T1", reason: null }]
        : [d],
    );
    expect(recordTicketSet(context.user, context.db, run.id, swapped)).toMatchObject({
      ok: false,
      error: { code: "ticket_set_content_invalid" },
    });
  });
});

describe("approve and reject refuse a replaced set", () => {
  /** A replaced set of another map: r2 approved with a set in `state`, then r3 unapproved. */
  async function replaced(state: "review_passed" | "awaiting_review") {
    const delivered = await deliveredSpec(context, project);
    const mapId = await clearedMap(context, project);
    const written = replacedTicketSet(context, {
      specificationId: delivered.specificationId,
      mapId,
      content: SPEC,
      nextContent: R2_SPEC,
      state,
    });
    return { ...written, mapId, specificationId: delivered.specificationId };
  }

  test("ticket_set_not_found, then ticket_set_decided before revision_not_latest", async () => {
    expect(
      approveTicketSet(context.user, context.db, { ticketSetId: UNKNOWN_REVIEW_ID }),
    ).toMatchObject({
      ok: false,
      error: { code: "ticket_set_not_found" },
    });
    const delivered = await deliveredSpec(context, project);
    const mapId = await clearedMap(context, project);
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId,
      content: SPEC,
      approved: false,
      set: null,
    });
    expect(
      approveTicketSet(context.user, context.db, { ticketSetId: delivered.ticketSetId }),
    ).toMatchObject({
      ok: false,
      error: { code: "ticket_set_decided" },
    });
  });

  test("a replaced set with a passed review is refused revision_not_latest by both", async () => {
    const { ticketSetId } = await replaced("review_passed");
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toMatchObject({
      ok: false,
      error: { code: "revision_not_latest" },
    });
    expect(
      rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }),
    ).toMatchObject({
      ok: false,
      error: { code: "revision_not_latest" },
    });
    expect(
      context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get(),
    ).toMatchObject({
      state: "review_passed",
      approvedAt: null,
    });
    expect(context.db.select().from(ticketSetRejections).all()).toEqual([]);
  });

  test("a replaced set whose review is also in flight reads revision_not_latest first", async () => {
    const delivered = await deliveredSpec(context, project);
    const mapId = await clearedMap(context, project);
    const { specificationId } = delivered;
    const written = insertNextRevision(context, {
      specificationId,
      mapId,
      content: SPEC,
      approved: true,
      set: { state: "awaiting_review", content: R2_REMOVED_BY_NONE },
    });
    const ticketSetId = written.ticketSetId;
    if (ticketSetId === null) throw new Error("no set");
    insertNextRevision(context, {
      specificationId,
      mapId,
      content: R2_SPEC,
      approved: false,
      set: null,
    });
    // Its review runs (the latest run of the spec on the map), so the set is in flight too.
    insertTicketsReviewRun(context, { mapId, specificationId, state: "running" });
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toMatchObject({
      ok: false,
      error: { code: "revision_not_latest" },
    });
    expect(
      rejectTicketSet(context.user, context.db, { ticketSetId, reason: REASON }),
    ).toMatchObject({
      ok: false,
      error: { code: "revision_not_latest" },
    });
  });

  test("a reviewed zero-ticket set is approved like any set", async () => {
    const delivered = await deliveredSpec(context, project);
    const mapId = await clearedMap(context, project);
    const next = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId,
      content: SPEC,
      approved: true,
      set: null,
    });
    const ticketSetId = insertTicketSetWith(context, {
      mapId,
      specificationId: delivered.specificationId,
      specRevisionId: next.specRevisionId,
      content: {
        ...R2_TICKETS,
        tickets: [],
        dispositions: [
          { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
          { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
        ],
      },
      state: "review_passed",
      review: [],
    });
    expect(approveTicketSet(context.user, context.db, { ticketSetId })).toEqual({
      ok: true,
      value: mapId,
    });
  });
});
