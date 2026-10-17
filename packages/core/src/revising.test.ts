/**
 * Slice 8b ticket 03: a map writes the next revision of an approved spec (S8b-3, L125 (3)), and
 * the transaction writing it replaces the ticket-set runs of the revision before (S8b-9, issue 24
 * item 1, L180).
 */
import type { HatchChange, HatchStage, PlanningRun, Project } from "@zenorm/contracts";
import { hatchMessages, planningRuns, specWaits, ticketSets } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import { getMapOverview } from "./map-overview.ts";
import { recordHatchReply } from "./hatch-runs.ts";
import { approveSpecRevision } from "./planning.ts";
import { planNext, readMapRuns } from "./planning-runs.ts";
import { readSpecRecord, removedCriteria } from "./reconciliation.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import {
  dueSpecRuns,
  readProjectSpecs,
  readSpecRevisions,
  readTicketSetOf,
  readTicketsReview,
  toTicketsDue,
} from "./specs.ts";
import type { StoredRevision } from "./specs.ts";
import {
  addProject,
  clearedMap,
  closeTestContext,
  deliverableTicketSet,
  deliveredSpec,
  draftedTicketSet,
  FAILED_TICKETS_REVIEW,
  holdByDelivery,
  holdByRevising,
  holdByRevision,
  holdByTickets,
  openTestContext,
  PASSED_REVIEW,
  PASSED_TICKETS_REVIEW,
  recordRunningTicketsReview,
  resolve,
  reviewedSpec,
  reviewedTicketSet,
  runningMapRun,
  runningSpecRun,
  runsOf,
  SPEC,
  TICKETS,
  writeTestData,
} from "./test-support.ts";
import type { TestContext, DraftContent } from "./test-support.ts";
import { recordTicketSet, recordTicketsReview } from "./ticket-set-runs.ts";

const RUNNERS = { deliveryHeld: () => false };

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-revising-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** SPEC with a new title: every id kept, so no clause needs a source (S7-5). */
function kept(title: string): DraftContent {
  return { ...SPEC, title, clauses: SPEC.clauses.map((clause) => ({ ...clause, sources: [] })) };
}

/** `kept(title)` without criterion 1.2: the revision drops it. */
function dropping(title: string): DraftContent {
  const base = kept(title);
  return {
    ...base,
    clauses: base.clauses.map((clause) => ({
      ...clause,
      criteria: clause.criteria.filter((criterion) => criterion.id !== "1.2"),
    })),
  };
}

function revisions(specificationId: string): StoredRevision[] {
  return readSpecRevisions(context.db, specificationId);
}

/** Each revision as `[revision, writing map, approved, superseded]`. */
function chain(specificationId: string): [number, string, boolean, boolean][] {
  return revisions(specificationId).map((revision) => [
    revision.revision,
    revision.mapId,
    revision.approvedAt !== null,
    revision.supersededAt !== null,
  ]);
}

function runOf(runId: string): PlanningRun {
  const run = context.db.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
  if (run === undefined) throw new Error(`No run ${runId}`);
  return run;
}

/** The map's running spec-scoped runs as `[purpose, spec]`. */
function runningOnSpecs(mapId: string): [string, string | null][] {
  return runsOf(context, mapId)
    .filter((run) => run.state === "running" && run.specificationId !== null)
    .map((run) => [run.purpose, run.specificationId]);
}

/** Sends `text` from `stage` (about spec 1 on Spec and Tickets) and replies with `change`. */
async function note(mapId: string, change: HatchChange, stage: HatchStage) {
  const sent = await sendHatchMessage(
    context.user,
    context.db,
    {
      mapId,
      stage,
      specNumber: stage === "spec" || stage === "tickets" ? 1 : null,
      text: "Change it.",
    },
    RUNNERS,
  );
  if (!sent.ok) throw new Error(sent.error.code);
  const messageId = sent.value.messages.at(-1)?.id;
  const hatch = runsOf(context, mapId).find(
    (run) => run.purpose === "hatch" && run.state === "running" && run.hatchMessageId === messageId,
  );
  if (messageId === undefined || hatch === undefined) throw new Error("No hatch run started");
  const recorded = recordHatchReply(context.user, context.db, hatch.id, { reply: "Done.", change });
  if (!recorded.ok) throw new Error(recorded.error.code);
  const message = context.db
    .select()
    .from(hatchMessages)
    .where(eq(hatchMessages.id, messageId))
    .get();
  if (message === undefined) throw new Error("No message");
  return message;
}

/**
 * Makes the map's re-clear due after its specs were written: a note opens Grilling waypoint
 * `number`, whose run resolves it. Returns the running re-clear.
 */
async function reclearing(mapId: string, number: number): Promise<PlanningRun> {
  await note(
    mapId,
    {
      kind: "open_waypoint",
      waypointKind: "grilling",
      title: "Decide the file name",
      question: "What is the export's file called?",
      blockedBy: [],
      fog: { newWaypoints: [], fogOutOfScope: [], newFog: [], fogDecided: [], fogSettledHere: [] },
    },
    "wayfinding",
  );
  resolve(context, mapId, number);
  const run = runningMapRun(context, mapId);
  expect(run).toMatchObject({ purpose: "to_spec", specificationId: null });
  return run;
}

function recordReview(mapId: string, specificationId: string): void {
  const review = runsOf(context, mapId).find(
    (run) =>
      run.state === "running" &&
      run.purpose === "spec_review" &&
      run.specificationId === specificationId,
  );
  if (review === undefined) throw new Error("No running spec review");
  const recorded = recordSpecReview(context.user, context.db, review.id, PASSED_REVIEW);
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function latestId(specificationId: string): string {
  const latest = revisions(specificationId).at(-1);
  if (latest === undefined) throw new Error("No revision");
  return latest.id;
}

describe("revising from a map (S8b-3, B19)", () => {
  test("a later map naming a delivered spec writes r2 from that map, r1 stays approved, and r2 is reviewed", async () => {
    const delivered = await deliveredSpec(context, project);
    const later = await clearedMap(context, project);

    const recorded = recordSpecs(context.user, context.db, runningMapRun(context, later).id, {
      specs: [{ specNumber: 1, content: kept("Export, revised") }],
      waits: [],
    });

    expect(recorded.ok).toBe(true);
    expect(chain(delivered.specificationId)).toEqual([
      [1, delivered.mapId, true, false],
      [2, later, false, false],
    ]);
    expect(readProjectSpecs(context.db, project.id)).toHaveLength(1);
    expect(runningOnSpecs(later)).toEqual([["spec_review", delivered.specificationId]]);
  });

  test.each([
    ["revision", "revision"],
    ["revising", "revising"],
    ["tickets", "tickets"],
    ["delivering", "delivering"],
  ] as const)(
    "naming a spec held by %s fails spec_content_invalid and writes nothing",
    async (_name, kind) => {
      const first = await deliverableTicketSet(context, project);
      const holder = await clearedMap(context, project);
      if (kind === "revision") {
        holdByRevision(context, {
          specificationId: first.specificationId,
          mapId: holder,
          content: kept("Held"),
          review: "passed",
        });
      } else if (kind === "revising") {
        holdByRevising(context, {
          specificationId: first.specificationId,
          mapId: holder,
          state: "running",
        });
      } else if (kind === "tickets") {
        holdByTickets(context, {
          specificationId: first.specificationId,
          mapId: holder,
          content: kept("Held"),
          set: null,
          purpose: "to_tickets",
          state: "stopped",
        });
      } else {
        await holdByDelivery(context, {
          specificationId: first.specificationId,
          mapId: holder,
          content: kept("Held"),
        });
      }
      const later = await clearedMap(context, project);
      const before = chain(first.specificationId);

      const recorded = recordSpecs(context.user, context.db, runningMapRun(context, later).id, {
        specs: [{ specNumber: 1, content: kept("Export, revised") }],
        waits: [],
      });

      expect(!recorded.ok && recorded.error.code).toBe("spec_content_invalid");
      expect(chain(first.specificationId)).toEqual(before);
      expect(
        readMapRuns(context.db, later)
          .filter((run) => run.purpose === "to_spec")
          .map((run) => [run.state, run.errorCode]),
      ).toEqual([
        ["failed", "spec_content_invalid"],
        ["running", null],
      ]);
    },
  );

  test("a same-map re-clear revises its own approved spec and leaves an unnamed approved spec untouched (L125 (3))", async () => {
    const mapId = await clearedMap(context, project);
    const drafted = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [
        { specNumber: null, content: SPEC },
        { specNumber: null, content: { ...SPEC, title: "Import" } },
      ],
      waits: [],
    });
    if (!drafted.ok) throw new Error(drafted.error.code);
    const [one, two] = readProjectSpecs(context.db, project.id).map((spec) => spec.id);
    if (one === undefined || two === undefined) throw new Error("Two specs expected");
    for (const specificationId of [one, two]) {
      recordReview(mapId, specificationId);
      const approved = approveSpecRevision(context.user, context.db, {
        specRevisionId: latestId(specificationId),
      });
      if (!approved.ok) throw new Error(approved.error.code);
    }
    expect(runningOnSpecs(mapId)).toEqual([
      ["to_tickets", one],
      ["to_tickets", two],
    ]);
    const replacedRun = runsOf(context, mapId).find(
      (run) => run.purpose === "to_tickets" && run.specificationId === one,
    );
    if (replacedRun === undefined) throw new Error("No to_tickets on spec 1");
    const reclear = await reclearing(mapId, 1);

    const recorded = recordSpecs(context.user, context.db, reclear.id, {
      specs: [{ specNumber: 1, content: kept("Export, r2") }],
      waits: [],
    });

    expect(recorded.ok).toBe(true);
    expect(chain(one)).toEqual([
      [1, mapId, true, false],
      [2, mapId, false, false],
    ]);
    expect(chain(two)).toEqual([[1, mapId, true, false]]);
    // Spec 1's set is replaced (S8b-9); spec 2's to_tickets runs on.
    expect(runOf(replacedRun.id)).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
    expect(runningOnSpecs(mapId)).toEqual([
      ["to_tickets", two],
      ["spec_review", one],
    ]);
  });
});

describe("replaced sets (S8b-9, issue 24, L180)", () => {
  test("a same-map re-clear cancels its own tickets_review replaced; its late result saves nothing and nothing is due for the set", async () => {
    const { mapId, specificationId, ticketSetId } = await draftedTicketSet(context, project);
    const review = runningSpecRun(context, mapId, "tickets_review");
    // The spec review's decision opens no waypoint here, so a note opens one.
    const reclear = await reclearing(mapId, 1);

    expect(
      recordSpecs(context.user, context.db, reclear.id, {
        specs: [{ specNumber: 1, content: kept("Export, r2") }],
        waits: [],
      }).ok,
    ).toBe(true);

    expect(runOf(review.id)).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
    expect(recordTicketsReview(context.user, context.db, review.id, PASSED_TICKETS_REVIEW).ok).toBe(
      true,
    );
    expect(readTicketsReview(context.db, ticketSetId, 1)).toBeNull();
    expect(runOf(review.id).state).toBe("cancelled");
    expect(toTicketsDue(context.db, mapId, specificationId)).toBe(false);
    expect(dueSpecRuns(context.db, { id: mapId }, { idle: () => true, writesOpen: false })).toEqual(
      [],
    );
  });

  test("a same-map re-clear cancels its own to_tickets replaced; its late set is not saved", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
    const approved = approveSpecRevision(context.user, context.db, { specRevisionId });
    if (!approved.ok) throw new Error(approved.error.code);
    const tickets = runningSpecRun(context, mapId, "to_tickets");
    const reclear = await reclearing(mapId, 1);

    expect(
      recordSpecs(context.user, context.db, reclear.id, {
        specs: [{ specNumber: 1, content: kept("Export, r2") }],
        waits: [],
      }).ok,
    ).toBe(true);

    expect(runOf(tickets.id)).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
    expect(recordTicketSet(context.user, context.db, tickets.id, TICKETS).ok).toBe(true);
    expect(readTicketSetOf(context.db, specRevisionId)).toBeUndefined();
    expect(toTicketsDue(context.db, mapId, specificationId)).toBe(false);
  });

  test("another map's revision replaces a set whose runs ended: nothing is due for it, before or after that revision is approved", async () => {
    const first = await reviewedTicketSet(context, project);
    const later = await clearedMap(context, project);
    expect(
      recordSpecs(context.user, context.db, runningMapRun(context, later).id, {
        specs: [{ specNumber: 1, content: kept("Export, revised") }],
        waits: [],
      }).ok,
    ).toBe(true);
    const gate = { idle: () => true, writesOpen: true };

    expect(dueSpecRuns(context.db, { id: first.mapId }, gate)).toEqual([]);
    expect(toTicketsDue(context.db, first.mapId, first.specificationId)).toBe(false);

    recordReview(later, first.specificationId);
    const approved = approveSpecRevision(context.user, context.db, {
      specRevisionId: latestId(first.specificationId),
    });
    if (!approved.ok) throw new Error(approved.error.code);
    writeTestData(context, (tx) => {
      planNext(context.user, tx, first.mapId);
    });

    expect(dueSpecRuns(context.db, { id: first.mapId }, gate)).toEqual([]);
    expect(runningOnSpecs(first.mapId)).toEqual([]);
    expect(runningOnSpecs(later)).toEqual([["to_tickets", first.specificationId]]);
  });

  test("a criterion dropped in a replaced revision is still taken out by the next set (removedCriteria)", async () => {
    const delivered = await deliveredSpec(context, project);
    const later = await clearedMap(context, project);
    expect(
      recordSpecs(context.user, context.db, runningMapRun(context, later).id, {
        specs: [{ specNumber: 1, content: dropping("Export, r2") }],
        waits: [],
      }).ok,
    ).toBe(true);
    recordReview(later, delivered.specificationId);
    const approved = approveSpecRevision(context.user, context.db, {
      specRevisionId: latestId(delivered.specificationId),
    });
    if (!approved.ok) throw new Error(approved.error.code);
    const tickets = runningSpecRun(context, later, "to_tickets");
    const reclear = await reclearing(later, 1);

    expect(
      recordSpecs(context.user, context.db, reclear.id, {
        specs: [{ specNumber: 1, content: dropping("Export, r3") }],
        waits: [],
      }).ok,
    ).toBe(true);

    expect(runOf(tickets.id)).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
    const record = readSpecRecord(context.db, delivered.specificationId);
    expect(removedCriteria(record, 3).map((entry) => entry.criterion.id)).toEqual(["1.2"]);
    // The revision's view carries it, though r3's text delta (from r2) does not (CR-3).
    const shown = await getMapOverview(context.db, later, RUNNERS);
    if (!shown.ok) throw new Error(shown.error.code);
    const r3 = shown.value.specs[0]?.revisions.find((revision) => revision.revision === 3);
    expect(r3?.delta?.removedCriteria).toEqual([]);
    expect(r3?.takenOut.map((entry) => entry.criterion.id)).toEqual(["1.2"]);
  });

  describe("the L180 boundary: a failed, unheld review whose repair is in flight", () => {
    async function repairInFlight() {
      const drafted = await draftedTicketSet(context, project);
      recordRunningTicketsReview(context, drafted.mapId, FAILED_TICKETS_REVIEW);
      const repair = runningSpecRun(context, drafted.mapId, "to_tickets");
      return { ...drafted, repair };
    }

    test("another map's change records a wait (tickets hold) and writes no revision", async () => {
      const { mapId, specificationId, repair } = await repairInFlight();
      const later = await clearedMap(context, project);
      const run = runningMapRun(context, later);

      const named = recordSpecs(context.user, context.db, run.id, {
        specs: [{ specNumber: 1, content: kept("Export, revised") }],
        waits: [],
      });
      expect(!named.ok && named.error.code).toBe("spec_content_invalid");
      const retry = runningMapRun(context, later);
      const waited = recordSpecs(context.user, context.db, retry.id, {
        specs: [],
        waits: [{ specNumber: 1, note: "Parents too." }],
      });

      expect(waited.ok).toBe(true);
      expect(chain(specificationId)).toEqual([[1, mapId, true, false]]);
      expect(runOf(repair.id).state).toBe("running");
      expect(
        context.db
          .select()
          .from(specWaits)
          .where(eq(specWaits.mapId, later))
          .all()
          .map((wait) => [wait.holdKind, wait.holdMapId, wait.holdRevision, wait.releasedAt]),
      ).toEqual([["tickets", mapId, 1, null]]);
    });

    test("this map's rewrite_tickets note is refused spec_in_flight", async () => {
      const { mapId, repair } = await repairInFlight();

      const message = await note(mapId, { kind: "rewrite_tickets" }, "tickets");

      expect(message.refusal).toBe("spec_in_flight");
      expect(runOf(repair.id).state).toBe("running");
    });

    test("this map's own re-clear cancels the repair replaced; its late version is not saved", async () => {
      const { mapId, ticketSetId, repair } = await repairInFlight();
      const reclear = await reclearing(mapId, 1);

      expect(
        recordSpecs(context.user, context.db, reclear.id, {
          specs: [{ specNumber: 1, content: kept("Export, r2") }],
          waits: [],
        }).ok,
      ).toBe(true);

      expect(runOf(repair.id)).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
      expect(recordTicketSet(context.user, context.db, repair.id, TICKETS).ok).toBe(true);
      const set = context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
      expect(set).toMatchObject({ version: 1, state: "review_failed" });
    });
  });
});
