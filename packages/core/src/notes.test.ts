import { LOCAL_EXECUTOR } from "@zenorm/contracts";
import { readMapRounds } from "./run-work.ts";
import type {
  HatchChange,
  HatchStage,
  MapOverviewDetail,
  PlanningRun,
  Project,
  SpecReviewFinding,
} from "@zenorm/contracts";
import { deliveryRuns, hatchMessages, specReviews, ticketSets } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { renderSpec } from "./delivery.ts";
import { prepareRun } from "./run-work.ts";
import { sendHatchMessage } from "./hatch.ts";
import { recordHatchReply, SPEC_IN_FLIGHT_SENTENCES } from "./hatch-runs.ts";
import { getMapOverview } from "./map-overview.ts";
import { approveSpecRevision, approveTicketSet, rejectTicketSet } from "./planning.ts";
import { failRun, readMap, tryAgain } from "./planning-runs.ts";
import { recordRevision, recordSpecReview, recordSpecs } from "./spec-runs.ts";
import {
  draftSpecsRequest,
  draftTicketSetRequest,
  reviewSpecRequest,
  reviewTicketSetRequest,
  reviseSpecRequest,
} from "./spec-requests.ts";
import { recordTicketSet } from "./ticket-set-runs.ts";
import type { SpecRunBase } from "./spec-requests.ts";
import { readRejections, readReview, readSpecRevisions, readTicketsReview } from "./specs.ts";
import type { StoredRevision } from "./specs.ts";
import {
  addProject,
  answer,
  ask,
  closeTestContext,
  draftedSpec,
  draftedTicketSet,
  FAILED_TICKETS_REVIEW,
  heldTicketSet,
  recordRunningTicketSet,
  recordRunningTicketsReview,
  reviewedTicketSet,
  openTestContext,
  PASSED_REVIEW,
  PLAIN_ANSWERS,
  resolve,
  REVISE_FINDING,
  reviewedSpec,
  runningMapRun,
  runsOf,
  SPEC,
  TICKETS,
  writeTestData,
} from "./test-support.ts";
import type { TestContext, DraftContent } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };
const BASE: SpecRunBase = {
  projectName: "repo",
  projectFolder: "/tmp/repo",
  baseBranch: "main",
  idea: "Export data",
};
const NOTE = "Parents must be exported too.";

/** A decision finding: it opens a Grilling waypoint, so the map reads un-cleared. */
const DECISION: SpecReviewFinding = {
  kind: "undefined_term",
  route: "decision",
  title: "Which records?",
  explanation: "C1 says 'every record', which no source defines.",
  question: "Which records does the export cover?",
  elementIds: ["C1"],
  waypointNumbers: [],
};

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-notes-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** SPEC with a new title: every id kept, so no clause needs a source. */
function kept(title: string): DraftContent {
  return { ...SPEC, title, clauses: SPEC.clauses.map((clause) => ({ ...clause, sources: [] })) };
}

/** `kept(title)` plus a new clause C2 whose only source is a note. */
function citingNote(title: string): DraftContent {
  const base = kept(title);
  return {
    ...base,
    clauses: [
      ...base.clauses,
      {
        id: "C2",
        title: "Parents",
        text: "Parents are exported with their children.",
        criteria: [{ id: "2.1", text: "A parent appears in the export." }],
        sources: [{ kind: "note" }],
        reliesOn: [],
        adds: ["new behaviour"],
      },
    ],
  };
}

function revisions(specificationId: string): StoredRevision[] {
  return readSpecRevisions(context.db, specificationId);
}

function latest(specificationId: string): StoredRevision {
  const found = revisions(specificationId).at(-1);
  if (found === undefined) throw new Error("no revision");
  return found;
}

/** The running run of `purpose` scoped to the spec; anything else throws. */
function specRun(mapId: string, purpose: PlanningRun["purpose"]): PlanningRun {
  const runs = runsOf(context, mapId).filter(
    (run) => run.state === "running" && run.specificationId !== null && run.purpose === purpose,
  );
  const [run] = runs;
  if (run === undefined || runs.length !== 1) {
    throw new Error(`${String(runs.length)} running ${purpose} runs on the map`);
  }
  return run;
}

function hasSpecRun(mapId: string, purpose: PlanningRun["purpose"]): boolean {
  return runsOf(context, mapId).some(
    (run) => run.state === "running" && run.specificationId !== null && run.purpose === purpose,
  );
}

function review(mapId: string, findings: SpecReviewFinding[]): void {
  const recorded = recordSpecReview(context.user, context.db, specRun(mapId, "spec_review").id, {
    summary: PASSED_REVIEW.summary,
    findings,
    verified: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function repair(mapId: string, content: DraftContent) {
  return recordRevision(context.user, context.db, specRun(mapId, "to_spec").id, {
    revision: content,
    removed: [],
  });
}

function escalatedOf(revision: StoredRevision): boolean[] {
  const stored = readReview(context.db, revision);
  if (stored === null) throw new Error(`Revision ${String(revision.revision)} has no review`);
  return stored.findings.map((finding) => finding.escalated);
}

async function overview(mapId: string): Promise<MapOverviewDetail> {
  const result = await getMapOverview(context.db, mapId, RUNNERS);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

/**
 * Sends `text` from `stage` about spec 1 (none on Idea and Wayfinding) and has its hatch run
 * return `change`; returns the stored message and the hatch run.
 */
async function note(mapId: string, change: HatchChange, stage: HatchStage) {
  const sent = await sendHatchMessage(
    context.user,
    context.db,
    {
      mapId,
      stage,
      specNumber: stage === "spec" || stage === "tickets" ? 1 : null,
      text: NOTE,
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
  const run = runsOf(context, mapId).find((candidate) => candidate.id === hatch.id);
  if (run === undefined) throw new Error("No hatch run");
  return { message, hatch: run };
}

function setOf(ticketSetId: string) {
  const set = context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
  if (set === undefined) throw new Error(`No ticket set ${ticketSetId}`);
  return set;
}

/** Whether the tickets review of `version` escalated a finding. */
function heldOf(ticketSetId: string, version: number): boolean {
  const recorded = readTicketsReview(context.db, ticketSetId, version);
  if (recorded === null) throw new Error(`Version ${String(version)} has no review`);
  return recorded.findings.some((finding) => finding.escalated);
}

const REVISE: HatchChange = { kind: "revise_spec" };
const REWRITE: HatchChange = { kind: "rewrite_tickets" };

describe("spec note", () => {
  test("a note on a passed draft supersedes it with no rejection, starts a spec-scoped to_spec carrying the message, and its revision is reviewed with the note", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project);
    const { message } = await note(mapId, REVISE, "spec");
    expect(message).toMatchObject({ refusal: null, change: REVISE });
    expect(latest(specificationId)).toMatchObject({ revision: 1, rejectionReason: null });
    expect(latest(specificationId).supersededAt).not.toBeNull();
    const revising = specRun(mapId, "to_spec");
    expect(revising.hatchMessageId).toBe(message.id);
    const spec = (await overview(mapId)).specs[0];
    expect(spec?.stages[0]).toMatchObject({ tone: "working", line: "Agent is revising" });
    const map = (await overview(mapId)).map;
    expect(
      reviseSpecRequest(context.db, map, revising, BASE, readMapRounds(context.db, map.id))
        .feedback,
    ).toEqual({
      kind: "note",
      text: NOTE,
    });

    expect(repair(mapId, citingNote("r2")).ok).toBe(true);
    expect(latest(specificationId)).toMatchObject({ revision: 2, supersededAt: null });
    const reviewing = specRun(mapId, "spec_review");
    expect(
      reviewSpecRequest(context.db, map, reviewing, BASE, readMapRounds(context.db, map.id)),
    ).toMatchObject({
      revision: { revision: 2 },
      rejection: null,
      noteDirectedRevisions: [{ revision: 2, note: NOTE }],
    });

    // A later revision may cite the note too, and its review still lists the note-directed one.
    review(mapId, [REVISE_FINDING]);
    expect(repair(mapId, citingNote("r3")).ok).toBe(true);
    expect(
      reviewSpecRequest(
        context.db,
        map,
        specRun(mapId, "spec_review"),
        BASE,
        readMapRounds(context.db, map.id),
      ).noteDirectedRevisions,
    ).toEqual([{ revision: 2, note: NOTE }]);
  });

  test("on a spec with no note-directed revision, a repair citing a note fails spec_content_invalid", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [REVISE_FINDING]);
    expect(repair(mapId, citingNote("r2"))).toMatchObject({
      ok: false,
      error: { code: "spec_content_invalid" },
    });
    const failed = runsOf(context, mapId).find(
      (run) => run.purpose === "to_spec" && run.state === "failed",
    );
    expect(failed?.errorCode).toBe("spec_content_invalid");
    expect(revisions(specificationId)).toHaveLength(1);
  });

  test("a note-directed revision does not restart the count: failed reviews count since the last approval", async () => {
    const { mapId, specificationId, specRevisionId } = await reviewedSpec(context, project);
    await note(mapId, REVISE, "spec");
    // r1's review reads failed, as if the note came straight after a failed review.
    writeTestData(context, (tx) =>
      tx
        .update(specReviews)
        .set({ passed: false })
        .where(eq(specReviews.specRevisionId, specRevisionId))
        .run(),
    );
    expect(repair(mapId, kept("r2")).ok).toBe(true);
    review(mapId, [REVISE_FINDING]);
    expect(escalatedOf(latest(specificationId))).toEqual([false]);
    expect(repair(mapId, kept("r3")).ok).toBe(true);
    review(mapId, [REVISE_FINDING]);
    // r1 and r2 failed before r3's review, the note between them notwithstanding: r3's escalates.
    expect(escalatedOf(latest(specificationId))).toEqual([true]);
  });

  test("refused spec_in_flight while the draft's review runs, writing only the reply; applied after it ends", async () => {
    const { mapId, specificationId } = await draftedSpec(context, project);
    const refused = await note(mapId, REVISE, "spec");
    expect(refused.message).toMatchObject({
      refusal: "spec_in_flight",
      change: null,
      reply: SPEC_IN_FLIGHT_SENTENCES.revise_spec.working,
    });
    expect(refused.hatch.state).toBe("completed");
    expect(latest(specificationId)).toMatchObject({ revision: 1, supersededAt: null });
    expect(hasSpecRun(mapId, "to_spec")).toBe(false);

    review(mapId, []);
    const applied = await note(mapId, REVISE, "spec");
    expect(applied.message).toMatchObject({ refusal: null, change: REVISE });
    expect(specRun(mapId, "to_spec").hatchMessageId).toBe(applied.message.id);
  });

  test("refused map_uncleared on an un-cleared map and while its map-scope to_spec runs", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [DECISION]);
    expect((await note(mapId, REVISE, "spec")).message.refusal).toBe("map_uncleared");
    resolve(context, mapId, 1);
    expect(
      runsOf(context, mapId).some(
        (run) =>
          run.purpose === "to_spec" && run.specificationId === null && run.state === "running",
      ),
    ).toBe(true);
    expect((await note(mapId, REVISE, "spec")).message.refusal).toBe("map_uncleared");
    expect(latest(specificationId)).toMatchObject({ revision: 1, supersededAt: null });
    expect(hasSpecRun(mapId, "to_spec")).toBe(false);
  });

  test("a note on an approved spec writes r2 through a note run, r1 still approved", async () => {
    const { mapId, specificationId } = await reviewedTicketSet(context, project);
    const applied = await note(mapId, REVISE, "spec");
    expect(applied.message).toMatchObject({ refusal: null, change: REVISE });
    const run = specRun(mapId, "to_spec");
    expect(run.hatchMessageId).toBe(applied.message.id);
    expect(latest(specificationId)).toMatchObject({ revision: 1, supersededAt: null });
    expect(
      reviseSpecRequest(
        context.db,
        readMap(context.db, mapId),
        run,
        BASE,
        readMapRounds(context.db, mapId),
      ).feedback,
    ).toEqual({
      kind: "note",
      text: NOTE,
    });
    expect(
      recordRevision(context.user, context.db, run.id, { revision: citingNote("r2"), removed: [] })
        .ok,
    ).toBe(true);
    const [r1, r2] = revisions(specificationId);
    expect(r1).toMatchObject({ revision: 1, supersededAt: null });
    expect(r1?.approvedAt).not.toBeNull();
    expect(r2).toMatchObject({ revision: 2, mapId, approvedAt: null, supersededAt: null });
    expect(hasSpecRun(mapId, "spec_review")).toBe(true);
  });

  test("a spec change from a message with no spec fails the run hatch_change_invalid and is retried", async () => {
    const { mapId } = await reviewedSpec(context, project);
    const sent = await sendHatchMessage(
      context.user,
      context.db,
      { mapId, stage: "wayfinding", specNumber: null, text: NOTE },
      RUNNERS,
    );
    if (!sent.ok) throw new Error(sent.error.code);
    const hatch = runsOf(context, mapId).find(
      (run) => run.purpose === "hatch" && run.state === "running",
    );
    if (hatch === undefined) throw new Error("No hatch run");
    expect(
      recordHatchReply(context.user, context.db, hatch.id, { reply: "Done.", change: REVISE }),
    ).toMatchObject({ ok: false, error: { code: "hatch_change_invalid" } });
    const runs = runsOf(context, mapId).filter((run) => run.purpose === "hatch");
    expect(runs.map((run) => [run.state, run.errorCode])).toEqual([
      ["failed", "hatch_change_invalid"],
      ["running", null],
    ]);
    expect(hasSpecRun(mapId, "to_spec")).toBe(false);
  });
});

describe("a note's run ended by a reopen", () => {
  test("the re-clear carries the note as the spec's feedback and its revision is note-directed", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project, [DECISION]);
    resolve(context, mapId, 1);
    const first = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [{ specNumber: 1, content: kept("r2") }],
      waits: [],
    });
    expect(first.ok).toBe(true);
    review(mapId, []);
    await note(mapId, REVISE, "spec");
    await note(mapId, { kind: "reopen", waypoint: 1 }, "wayfinding");
    expect(hasSpecRun(mapId, "to_spec")).toBe(false);
    // A reopened waypoint is decided again in a new round.
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    resolve(context, mapId, 1);
    const reclear = runningMapRun(context, mapId);
    const map = readMap(context.db, mapId);
    // The first re-clear rewrote r1 in place; the note superseded it.
    expect(
      draftSpecsRequest(context.db, map, reclear, BASE, readMapRounds(context.db, map.id)).specs,
    ).toMatchObject([
      { latest: { revision: 1 }, approved: false, feedback: { kind: "note", text: NOTE } },
    ]);
    const written = recordSpecs(context.user, context.db, reclear.id, {
      specs: [{ specNumber: 1, content: citingNote("r3") }],
      waits: [],
    });
    expect(written.ok).toBe(true);
    expect(latest(specificationId).revision).toBe(2);
    expect(
      reviewSpecRequest(
        context.db,
        map,
        specRun(mapId, "spec_review"),
        BASE,
        readMapRounds(context.db, map.id),
      ).noteDirectedRevisions,
    ).toEqual([{ revision: 2, note: NOTE }]);
  });
});

describe("a note's to_spec stopped", () => {
  const TIMED_OUT = { code: "agent_timed_out", message: "The agent timed out" } as const;

  /** A cleared map whose spec 1 is r2 with its review passed, its note's to_spec stopped. */
  async function stoppedNoteRun() {
    const { mapId, specificationId } = await reviewedSpec(context, project, [DECISION]);
    resolve(context, mapId, 1);
    const first = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [{ specNumber: 1, content: kept("r2") }],
      waits: [],
    });
    if (!first.ok) throw new Error(first.error.code);
    review(mapId, []);
    const { message } = await note(mapId, REVISE, "spec");
    failRun(context.user, context.db, specRun(mapId, "to_spec").id, TIMED_OUT);
    const retry = specRun(mapId, "to_spec");
    expect(retry.hatchMessageId).toBe(message.id);
    failRun(context.user, context.db, retry.id, TIMED_OUT);
    expect(hasSpecRun(mapId, "to_spec")).toBe(false);
    return { mapId, specificationId, retry };
  }

  test("the stopped scope is in flight in the hatch request, and a note is refused spec_in_flight", async () => {
    const { mapId } = await stoppedNoteRun();
    const sent = await sendHatchMessage(
      context.user,
      context.db,
      { mapId, stage: "spec", specNumber: 1, text: "What does C1 export?" },
      RUNNERS,
    );
    if (!sent.ok) throw new Error(sent.error.code);
    const messageId = sent.value.messages.at(-1)?.id;
    const hatch = runsOf(context, mapId).find(
      (run) =>
        run.purpose === "hatch" && run.state === "running" && run.hatchMessageId === messageId,
    );
    if (hatch === undefined) throw new Error("No hatch run started");

    const prepared = await prepareRun(context.db, hatch.id);

    if (!prepared.ok || prepared.value.purpose !== "hatch") throw new Error("No hatch request");
    expect(prepared.value.request.specs.map((spec) => spec.inFlight)).toEqual([["to_spec"]]);
    expect(
      recordHatchReply(context.user, context.db, hatch.id, { reply: "C1 exports.", change: null })
        .ok,
    ).toBe(true);
    expect((await note(mapId, REVISE, "spec")).message).toMatchObject({
      refusal: "spec_in_flight",
      change: null,
      reply: SPEC_IN_FLIGHT_SENTENCES.revise_spec.stopped,
    });
  });

  test("a reopen and re-resolution: the re-clear writes the next revision with the note, and the stop no longer offers Try again", async () => {
    const { mapId, specificationId, retry } = await stoppedNoteRun();
    expect((await overview(mapId)).specs[0]?.stages[0]).toMatchObject({ tone: "needs-you" });

    await note(mapId, { kind: "reopen", waypoint: 1 }, "wayfinding");
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    resolve(context, mapId, 1);
    const reclear = runningMapRun(context, mapId);
    const map = readMap(context.db, mapId);
    // The first re-clear rewrote r1 in place; the note superseded it.
    expect(
      draftSpecsRequest(context.db, map, reclear, BASE, readMapRounds(context.db, map.id)).specs,
    ).toMatchObject([
      { latest: { revision: 1 }, approved: false, feedback: { kind: "note", text: NOTE } },
    ]);
    const written = recordSpecs(context.user, context.db, reclear.id, {
      specs: [{ specNumber: 1, content: citingNote("r3") }],
      waits: [],
    });

    expect(written.ok).toBe(true);
    expect(latest(specificationId).revision).toBe(2);
    const tried = tryAgain(context.user, context.db, retry.id);
    expect(tried.ok ? null : tried.error.code).toBe("planning_run_not_stopped");
  });
});

describe("ticket note", () => {
  test("on an awaiting_review set: a to_tickets rewrite carrying the message, the note its reason; version 2 awaiting_review, no rejection", async () => {
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    const { message } = await note(mapId, REWRITE, "tickets");
    expect(message).toMatchObject({ refusal: null, change: REWRITE });
    const rewriting = specRun(mapId, "to_tickets");
    expect(rewriting.hatchMessageId).toBe(message.id);
    expect(draftTicketSetRequest(context.db, rewriting, BASE).rewrite).toMatchObject({
      version: 1,
      reason: NOTE,
    });
    expect((await overview(mapId)).specs[0]?.stages[1]).toMatchObject({
      tone: "working",
      line: "Agent is writing tickets",
    });
    expect(recordTicketSet(context.user, context.db, rewriting.id, TICKETS).ok).toBe(true);
    const set = context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
    expect(set).toMatchObject({ version: 2, state: "awaiting_review" });
    expect(readRejections(context.db, ticketSetId)).toEqual([]);
    expect(hasSpecRun(mapId, "to_tickets")).toBe(false);
  });

  test("on a review_failed (held) set: the rewrite writes version 2 awaiting_review", async () => {
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    writeTestData(context, (tx) =>
      tx
        .update(ticketSets)
        .set({ state: "review_failed" })
        .where(eq(ticketSets.id, ticketSetId))
        .run(),
    );
    const { message } = await note(mapId, REWRITE, "tickets");
    expect(message.refusal).toBeNull();
    expect(
      recordTicketSet(context.user, context.db, specRun(mapId, "to_tickets").id, TICKETS).ok,
    ).toBe(true);
    const set = context.db.select().from(ticketSets).where(eq(ticketSets.id, ticketSetId)).get();
    expect(set).toMatchObject({ version: 2, state: "awaiting_review" });
    expect(readRejections(context.db, ticketSetId)).toEqual([]);
  });

  test("a stopped note rewrite keeps Try again, and the fresh run carries the message", async () => {
    const { mapId } = await reviewedTicketSet(context, project);
    const { message } = await note(mapId, REWRITE, "tickets");
    const failure = { code: "agent_timed_out", message: "The agent timed out" } as const;
    failRun(context.user, context.db, specRun(mapId, "to_tickets").id, failure);
    const retry = specRun(mapId, "to_tickets");
    expect(retry.hatchMessageId).toBe(message.id);
    failRun(context.user, context.db, retry.id, failure);
    expect((await overview(mapId)).specs[0]?.stages[1]).toMatchObject({ tone: "needs-you" });
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    expect(specRun(mapId, "to_tickets").hatchMessageId).toBe(message.id);
  });

  test("refused ticket_set_approved on an approved set", async () => {
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(approveTicketSet(context.user, context.db, { ticketSetId }).ok).toBe(true);
    expect((await note(mapId, REWRITE, "tickets")).message.refusal).toBe("ticket_set_approved");
    expect(hasSpecRun(mapId, "to_tickets")).toBe(false);
  });

  test("refused no_ticket_set when the spec has none", async () => {
    const { mapId } = await reviewedSpec(context, project);
    expect((await note(mapId, REWRITE, "spec")).message.refusal).toBe("no_ticket_set");
    expect(hasSpecRun(mapId, "to_tickets")).toBe(false);
  });

  test("refused spec_in_flight while a to_tickets runs on the spec", async () => {
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: "Split T2" }).ok).toBe(
      true,
    );
    const rewrite = specRun(mapId, "to_tickets");
    expect((await note(mapId, REWRITE, "tickets")).message.refusal).toBe("spec_in_flight");
    expect(specRun(mapId, "to_tickets").id).toBe(rewrite.id);
  });

  test("refused spec_in_flight while a tickets_review runs on the spec", async () => {
    const { mapId } = await draftedTicketSet(context, project);
    const review = specRun(mapId, "tickets_review");
    // The reply speaks of the tickets, and of no Try again while nothing is stopped.
    expect((await note(mapId, REWRITE, "tickets")).message).toMatchObject({
      refusal: "spec_in_flight",
      reply: SPEC_IN_FLIGHT_SENTENCES.rewrite_tickets.working,
    });
    expect(specRun(mapId, "tickets_review").id).toBe(review.id);
    expect(hasSpecRun(mapId, "to_tickets")).toBe(false);
  });

  test("refused spec_in_flight while a review repair runs, and while it is stopped", async () => {
    const { mapId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    const repair = specRun(mapId, "to_tickets");
    expect((await note(mapId, REWRITE, "tickets")).message).toMatchObject({
      refusal: "spec_in_flight",
      reply: SPEC_IN_FLIGHT_SENTENCES.rewrite_tickets.working,
    });
    expect(specRun(mapId, "to_tickets").id).toBe(repair.id);
    const failure = { code: "agent_timed_out", message: "The agent timed out" } as const;
    failRun(context.user, context.db, repair.id, failure);
    failRun(context.user, context.db, specRun(mapId, "to_tickets").id, failure);
    // A stopped scope's reply, and only it, points at Try again.
    expect((await note(mapId, REWRITE, "tickets")).message).toMatchObject({
      refusal: "spec_in_flight",
      reply: SPEC_IN_FLIGHT_SENTENCES.rewrite_tickets.stopped,
    });
    expect(SPEC_IN_FLIGHT_SENTENCES.rewrite_tickets.stopped).not.toBe(
      SPEC_IN_FLIGHT_SENTENCES.rewrite_tickets.working,
    );
    expect(hasSpecRun(mapId, "to_tickets")).toBe(false);
  });

  test("on a held set the note starts the rewrite carrying the message, the note outranking the held findings; its version is reviewed and restarts the count", async () => {
    const { mapId, ticketSetId } = await heldTicketSet(context, project);
    const { message } = await note(mapId, REWRITE, "tickets");
    expect(message.refusal).toBeNull();
    const rewriting = specRun(mapId, "to_tickets");
    expect(rewriting.hatchMessageId).toBe(message.id);
    expect(draftTicketSetRequest(context.db, rewriting, BASE).rewrite).toMatchObject({
      version: 3,
      findings: FAILED_TICKETS_REVIEW.findings,
      reason: NOTE,
    });
    expect(recordTicketSet(context.user, context.db, rewriting.id, TICKETS).ok).toBe(true);
    expect(setOf(ticketSetId)).toMatchObject({ version: 4, state: "awaiting_review" });
    expect(specRun(mapId, "tickets_review")).toBeDefined();

    // v4 (the note's) fails: a repair, not a hold; v5 (the first repair) fails: another repair.
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    expect(heldOf(ticketSetId, 4)).toBe(false);
    recordRunningTicketSet(context, mapId);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    expect(heldOf(ticketSetId, 5)).toBe(false);
    recordRunningTicketSet(context, mapId);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    expect(heldOf(ticketSetId, 6)).toBe(true);
    expect(hasSpecRun(mapId, "to_tickets")).toBe(false);
  });

  test("a note's ask reaches the review of the version it wrote and the repair after it", async () => {
    const { mapId, ticketSetId } = await heldTicketSet(context, project);
    const { message } = await note(mapId, REWRITE, "tickets");
    const rewriting = specRun(mapId, "to_tickets");
    expect(rewriting.hatchMessageId).toBe(message.id);
    // While the note's rewrite works, the review reads pending, not the held findings.
    expect((await overview(mapId)).specs[0]?.ticketSets[0]?.review).toEqual({ state: "pending" });
    expect(recordTicketSet(context.user, context.db, rewriting.id, TICKETS).ok).toBe(true);
    const noted = { kind: "note", version: 4, text: NOTE } as const;

    // v2 and v3 are repairs, so v4's note is the set's one directed version.
    expect(
      reviewTicketSetRequest(context.db, specRun(mapId, "tickets_review"), BASE).directedVersions,
    ).toEqual([noted]);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    expect(setOf(ticketSetId)).toMatchObject({ version: 4, state: "review_failed" });
    expect(
      draftTicketSetRequest(context.db, specRun(mapId, "to_tickets"), BASE).rewrite,
    ).toMatchObject({
      version: 4,
      reason: null,
      directedVersions: [noted],
    });
  });

  test("revise_spec on an approved spec with its own to_tickets running is refused spec_in_flight", async () => {
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: "Split T2" }).ok).toBe(
      true,
    );
    const rewrite = specRun(mapId, "to_tickets");
    expect((await note(mapId, REVISE, "tickets")).message.refusal).toBe("spec_in_flight");
    expect(specRun(mapId, "to_tickets").id).toBe(rewrite.id);
    expect(revisions(specificationId)).toHaveLength(1);
  });

  test("refused spec_in_flight while an active delivery run is on the spec", async () => {
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    writeTestData(context, (tx) =>
      tx
        .insert(deliveryRuns)
        .values({
          userId: context.user.userId,
          executor: LOCAL_EXECUTOR,
          id: uuidv7(),
          specificationId,
          ticketSetId,
          number: 1,
          branch: "zenorm/export-run-1",
          worktreePath: "/tmp/run/worktree",
          projectId: project.id,
          baseBranch: "main",
          phase: "implementing",
          mergedAt: null,
          baseCommit: "abc123",
          startCommit: "abc123",
          checks: ["git status --short"],
          repairLimit: 0,
          repairAttempts: 0,
          fixCommands: [],
          appSetupCommands: [],
          startedAt: new Date().toISOString(),
          endedAt: null,
          finalCommit: null,
          checkResults: null,
          verdict: null,
          failure: null,
        })
        .run(),
    );
    expect((await note(mapId, REWRITE, "tickets")).message).toMatchObject({
      refusal: "spec_in_flight",
      reply: SPEC_IN_FLIGHT_SENTENCES.rewrite_tickets.delivering,
    });
    // An active delivery run refuses a spec note spec_in_flight; spec_approved is gone.
    expect((await note(mapId, REVISE, "tickets")).message).toMatchObject({
      refusal: "spec_in_flight",
      reply: SPEC_IN_FLIGHT_SENTENCES.revise_spec.delivering,
    });
  });
});

describe("delivery spec rendering", () => {
  test("a clause sourced from a note renders that source", async () => {
    const { mapId, specificationId } = await reviewedSpec(context, project);
    await note(mapId, REVISE, "spec");
    expect(repair(mapId, citingNote("r2")).ok).toBe(true);
    review(mapId, []);
    const r2 = latest(specificationId);
    expect(approveSpecRevision(context.user, context.db, { specRevisionId: r2.id }).ok).toBe(true);
    expect(renderSpec(r2.content)).toContain("a note from the person");
  });
});
