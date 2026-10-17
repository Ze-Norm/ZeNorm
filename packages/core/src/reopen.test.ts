import { LOCAL_EXECUTOR } from "@zenorm/contracts";
import type {
  DraftSpecsRequest,
  GrillWaypointRequest,
  HatchChange,
  Project,
} from "@zenorm/contracts";
import { deliveryRuns, hatchMessages, planningRuns, specReviews, waypoints } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import { recordHatchReply } from "./hatch-runs.ts";
import { getMapOverview } from "./map-overview.ts";
import { approveSpecRevision } from "./planning.ts";
import {
  failRun,
  isCleared,
  planNext,
  readClearing,
  readMap,
  readMapRuns,
  readRounds,
  recordConsistency,
  recordGrill,
  tryAgain,
} from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import { recordTicketSet } from "./ticket-set-runs.ts";
import { latestOf, readMapRevisions, readSpecRevisions, readTicketSetOf } from "./specs.ts";
import {
  CHAIN,
  FAILED_TICKETS_REVIEW,
  PASSED_REVIEW,
  PLAIN_ANSWERS,
  REVISE_FINDING,
  SPEC,
  TICKETS,
  addProject,
  answer,
  answerDestination,
  ask,
  cleanPass,
  clearedMap,
  closeTestContext,
  confirm,
  grillRound,
  grillingRun,
  insertRun,
  newMap,
  openTestContext,
  pendingRoundOn,
  propose,
  recordRunningTicketSet,
  recordRunningTicketsReview,
  resolve,
  resolvedChain,
  runningMapRun,
  runningSpecRun,
  runsOf,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };
const IMPORT_SPEC = { ...SPEC, title: "Import data from CSV" };

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-reopen-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** Sends a message whose hatch run returns a reopen of waypoint `number`; returns the message. */
async function reopen(mapId: string, number: number) {
  return direct(mapId, { kind: "reopen", waypoint: number });
}

/** Sends a message whose hatch run returns `change`; returns the stored message. */
async function direct(mapId: string, change: HatchChange) {
  const sent = await sendHatchMessage(
    context.user,
    context.db,
    { mapId, stage: "wayfinding", specNumber: null, text: "That decision was wrong." },
    RUNNERS,
  );
  if (!sent.ok) throw new Error(sent.error.code);
  const messageId = sent.value.messages.at(-1)?.id;
  const hatch = runsOf(context, mapId).find(
    (run) => run.purpose === "hatch" && run.state === "running" && run.hatchMessageId === messageId,
  );
  if (messageId === undefined || hatch === undefined) throw new Error("No hatch run started");
  const recorded = recordHatchReply(context.user, context.db, hatch.id, { reply: "Done.", change });
  const message = context.db
    .select()
    .from(hatchMessages)
    .where(eq(hatchMessages.id, messageId))
    .get();
  if (message === undefined) throw new Error("The message is gone");
  return { recorded, message, hatchRun: hatch };
}

function runById(mapId: string, id: string) {
  const run = runsOf(context, mapId).find((candidate) => candidate.id === id);
  if (run === undefined) throw new Error(`No run ${id}`);
  return run;
}

/** A chain map whose waypoints are resolved and whose consistency pass is running. */
async function chainWithRunningPass(): Promise<string> {
  const mapId = await newMap(context, project, "Export data");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirm(context, mapId, CHAIN);
  resolve(context, mapId, 1);
  resolve(context, mapId, 2);
  resolve(context, mapId, 3);
  return mapId;
}

/** A resolved chain with spec 1 drafted (its review running); returns its ids. */
async function draftedChain() {
  const mapId = await resolvedChain(context, project);
  const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
    specs: [{ specNumber: null, content: SPEC }],
    waits: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  const revision = readMapRevisions(context.db, mapId).at(-1);
  if (revision === undefined) throw new Error("No revision");
  return { mapId, revision };
}

/** Passes the running review of the map's only reviewing spec and approves `specRevisionId`. */
function passAndApprove(mapId: string, specRevisionId: string): void {
  const reviewed = recordSpecReview(
    context.user,
    context.db,
    runningSpecRun(context, mapId, "spec_review").id,
    PASSED_REVIEW,
  );
  if (!reviewed.ok) throw new Error(reviewed.error.code);
  const approved = approveSpecRevision(context.user, context.db, { specRevisionId });
  if (!approved.ok) throw new Error(approved.error.code);
}

/**
 * A reopened waypoint decided again: its fresh run asks a new round, the person answers it, and the
 * next run resolves it.
 */
function regrill(mapId: string, number: number): void {
  ask(context, mapId, number, false);
  answer(context, mapId, number, PLAIN_ANSWERS);
  resolve(context, mapId, number);
}

/** After a reopen of waypoint 1: asks, answers and re-resolves 1–3, then passes cleanly. */
async function reresolve(mapId: string): Promise<void> {
  // Let the clock move so every re-resolution has a later `resolved_at`.
  await new Promise((done) => setTimeout(done, 5));
  regrill(mapId, 1);
  regrill(mapId, 2);
  regrill(mapId, 3);
  cleanPass(context, mapId);
}

/** Whether the map's one ticket set reads held through `map.overview`. */
async function heldOf(mapId: string): Promise<boolean> {
  const overview = await getMapOverview(context.db, mapId, RUNNERS);
  if (!overview.ok) throw new Error(overview.error.code);
  const review = overview.value.specs[0]?.ticketSets[0]?.review;
  return review?.state === "findings" && review.held;
}

async function mapRequest(runId: string): Promise<DraftSpecsRequest> {
  const prepared = await prepareRun(context.db, runId);
  if (!prepared.ok) throw new Error(prepared.error.code);
  const work = prepared.value;
  if (work.purpose !== "to_spec" || work.scope !== "map") throw new Error(work.purpose);
  return work.request;
}

async function grillRequest(runId: string): Promise<GrillWaypointRequest> {
  const prepared = await prepareRun(context.db, runId);
  if (!prepared.ok) throw new Error(prepared.error.code);
  const work = prepared.value;
  if (work.purpose !== "grilling") throw new Error(work.purpose);
  return work.request;
}

describe("reopen", () => {
  test("reopening 1 reopens its two-deep resolved dependents in one write; rounds stay; each records the message", async () => {
    const { mapId } = await draftedChain();
    const rounds = readRounds(context.db, mapId).length;

    const { recorded, message } = await reopen(mapId, 1);

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(message.change).toEqual({ kind: "reopen", waypoint: 1 });
    for (const number of [1, 2, 3]) {
      expect(waypointOf(context, mapId, number)).toMatchObject({
        // The frontier claims waypoint 1 at once; 2 and 3 wait on their blockers.
        status: number === 1 ? "claimed" : "open",
        resolution: null,
        gist: null,
        agentDecided: null,
        resolvedAt: null,
        resolvedHow: null,
        resolvedByRun: null,
        hatchMessageId: message.id,
      });
    }
    expect(readRounds(context.db, mapId)).toHaveLength(rounds);
  });

  test("an open dependent is untouched; a claimed one with a running run returns to open and its run is cancelled", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CHAIN);
    resolve(context, mapId, 1);
    const working = grillingRun(context, mapId, 2);

    const { recorded } = await reopen(mapId, 1);

    expect(recorded.ok).toBe(true);
    expect(runById(mapId, working.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "reopened",
    });
    expect(waypointOf(context, mapId, 2)).toMatchObject({ status: "open", hatchMessageId: null });
    expect(waypointOf(context, mapId, 3)).toMatchObject({ status: "open", hatchMessageId: null });
    // The late result saves nothing and starts no retry.
    const before = runsOf(context, mapId).length;
    const late = recordGrill(context.user, context.db, working.id, {
      round: grillRound(false),
      resolution: null,
      outOfScope: null,
      mapChanges: null,
    });
    expect(late).toEqual({ ok: true, value: null });
    expect(runsOf(context, mapId)).toHaveLength(before);
    expect(readRounds(context.db, mapId).filter((round) => round.waypointId !== null)).toEqual([]);
  });

  test("a claimed dependent whose run asked keeps that run and its round is withdrawn superseded", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CHAIN);
    resolve(context, mapId, 1);
    ask(context, mapId, 2, false);
    const round = pendingRoundOn(context, mapId, 2);

    await reopen(mapId, 1);

    expect(runById(mapId, round.askedByRun).state).toBe("asked");
    expect(readRounds(context.db, mapId).find((r) => r.id === round.id)).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "superseded",
    });
    expect(waypointOf(context, mapId, 2).status).toBe("open");
  });

  test("a running consistency pass is cancelled; its late result saves nothing and is not retried", async () => {
    const mapId = await chainWithRunningPass();
    const pass = runningMapRun(context, mapId);
    expect(pass.purpose).toBe("consistency");

    await reopen(mapId, 1);

    expect(runById(mapId, pass.id)).toMatchObject({ state: "cancelled", cancelReason: "reopened" });
    const before = runsOf(context, mapId).length;
    expect(
      recordConsistency(context.user, context.db, pass.id, { findings: [], proposals: [] }),
    ).toEqual({ ok: true, value: { dropped: 0 } });
    expect(runsOf(context, mapId)).toHaveLength(before);
  });

  test("a running map-scope to_spec is cancelled; its late specs save nothing", async () => {
    const mapId = await resolvedChain(context, project);
    const drafting = runningMapRun(context, mapId);

    await reopen(mapId, 1);

    expect(runById(mapId, drafting.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "reopened",
    });
    const before = runsOf(context, mapId).length;
    const late = recordSpecs(context.user, context.db, drafting.id, {
      specs: [{ specNumber: null, content: SPEC }],
      waits: [],
    });
    expect(late).toEqual({ ok: true, value: null });
    expect(readMapRevisions(context.db, mapId)).toEqual([]);
    expect(runsOf(context, mapId)).toHaveLength(before);
  });

  test("a running spec review is cancelled; its late review saves nothing; the draft refuses approval map_uncleared", async () => {
    const { mapId, revision } = await draftedChain();
    const review = runningSpecRun(context, mapId, "spec_review");

    await reopen(mapId, 1);

    expect(runById(mapId, review.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "reopened",
    });
    expect(recordSpecReview(context.user, context.db, review.id, PASSED_REVIEW)).toEqual({
      ok: true,
      value: null,
    });
    expect(context.db.select().from(specReviews).all()).toEqual([]);
    const approved = approveSpecRevision(context.user, context.db, { specRevisionId: revision.id });
    expect(approved.ok ? null : approved.error.code).toBe("map_uncleared");
    // The map's read stays whole on the reopened state.
    expect((await getMapOverview(context.db, mapId, RUNNERS)).ok).toBe(true);
  });

  test("a running spec-scoped repair is cancelled", async () => {
    const { mapId } = await draftedChain();
    const reviewed = recordSpecReview(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "spec_review").id,
      { summary: "One clause is invented.", findings: [REVISE_FINDING], verified: [] },
    );
    if (!reviewed.ok) throw new Error(reviewed.error.code);
    const repair = runningSpecRun(context, mapId, "to_spec");

    await reopen(mapId, 1);

    expect(runById(mapId, repair.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "reopened",
    });
  });

  test("a running to_tickets continues and saves its set (a reopen is applied whatever is in flight)", async () => {
    const { mapId, revision } = await draftedChain();
    passAndApprove(mapId, revision.id);
    const tickets = runningSpecRun(context, mapId, "to_tickets");

    const { recorded, message } = await reopen(mapId, 1);

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(runById(mapId, tickets.id).state).toBe("running");
    expect(recordTicketSet(context.user, context.db, tickets.id, TICKETS).ok).toBe(true);
    // The set's tickets review starts on the un-cleared map.
    const map = readMap(context.db, mapId);
    expect(isCleared(readClearing(context.db, map, readMapRuns(context.db, mapId)))).toBe(false);
    expect(runningSpecRun(context, mapId, "tickets_review").state).toBe("running");
  });

  test("a failed review recorded on the un-cleared map starts its repair; a reopen during the repair leaves it running", async () => {
    const { mapId, revision } = await draftedChain();
    passAndApprove(mapId, revision.id);
    recordRunningTicketSet(context, mapId);
    await reopen(mapId, 1);
    const map = readMap(context.db, mapId);
    expect(isCleared(readClearing(context.db, map, readMapRuns(context.db, mapId)))).toBe(false);

    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    const repair = runningSpecRun(context, mapId, "to_tickets");
    expect(repair.hatchMessageId).toBeNull();

    await reopen(mapId, 2);
    expect(runById(mapId, repair.id).state).toBe("running");
    // N-Spec-4: the overview reads the running repair, never failed-but-unheld.
    const shown = await getMapOverview(context.db, mapId, RUNNERS);
    if (!shown.ok) throw new Error(shown.error.code);
    expect(shown.value.specs[0]?.stages[1]).toMatchObject({
      tone: "working",
      line: "2 tickets · review findings",
    });
    recordRunningTicketSet(context, mapId);
    expect(runningSpecRun(context, mapId, "tickets_review").state).toBe("running");
  });

  test("a reopen and the map's re-clear leave a held set held; nothing starts on it", async () => {
    const { mapId, revision } = await draftedChain();
    passAndApprove(mapId, revision.id);
    recordRunningTicketSet(context, mapId);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    recordRunningTicketSet(context, mapId);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    recordRunningTicketSet(context, mapId);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    expect(await heldOf(mapId)).toBe(true);

    await reopen(mapId, 1);
    expect(await heldOf(mapId)).toBe(true);
    await reresolve(mapId);
    expect(
      recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
        specs: [],
        waits: [],
      }).ok,
    ).toBe(true);

    expect(await heldOf(mapId)).toBe(true);
    expect(
      runsOf(context, mapId).some(
        (run) =>
          run.state === "running" &&
          (run.purpose === "to_tickets" || run.purpose === "tickets_review"),
      ),
    ).toBe(false);
  });

  test("an active delivery run continues through a reopen", async () => {
    const { mapId, revision } = await draftedChain();
    passAndApprove(mapId, revision.id);
    const tickets = runningSpecRun(context, mapId, "to_tickets");
    expect(recordTicketSet(context.user, context.db, tickets.id, TICKETS).ok).toBe(true);
    const set = readTicketSetOf(context.db, revision.id);
    if (set === undefined) throw new Error(`Map ${mapId} has no ticket set`);
    const runId = uuidv7();
    writeTestData(context, (tx) =>
      tx
        .insert(deliveryRuns)
        .values({
          userId: context.user.userId,
          executor: LOCAL_EXECUTOR,
          id: runId,
          specificationId: revision.specificationId,
          ticketSetId: set.id,
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
          startedAt: new Date().toISOString(),
          endedAt: null,
          finalCommit: null,
          checkResults: null,
          verdict: null,
          failure: null,
        })
        .run(),
    );
    const before = context.db.select().from(deliveryRuns).where(eq(deliveryRuns.id, runId)).get();

    const { recorded, message } = await reopen(mapId, 1);

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    const after = context.db.select().from(deliveryRuns).where(eq(deliveryRuns.id, runId)).get();
    expect(after).toEqual(before);
    expect(after?.endedAt).toBeNull();
  });

  test("reopening an open waypoint is refused waypoint_state; an unknown number fails hatch_change_invalid", async () => {
    const { mapId } = await draftedChain();
    await reopen(mapId, 1);

    const refused = await reopen(mapId, 2);
    expect(refused.recorded.ok).toBe(true);
    expect(refused.message.refusal).toBe("waypoint_state");
    expect(refused.message.change).toBeNull();

    const unknown = await reopen(mapId, 9);
    expect(unknown.recorded.ok ? null : unknown.recorded.error.code).toBe("hatch_change_invalid");
    expect(runById(mapId, unknown.hatchRun.id).errorCode).toBe("hatch_change_invalid");
  });
});

describe("after a reopen", () => {
  test("the frontier grills the reopened waypoint again: a new round, the pass due again, a new review source set", async () => {
    const { mapId } = await draftedChain();
    const reviewed = recordSpecReview(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "spec_review").id,
      PASSED_REVIEW,
    );
    if (!reviewed.ok) throw new Error(reviewed.error.code);

    await reopen(mapId, 1);

    const fresh = grillingRun(context, mapId, 1);
    const request = await grillRequest(fresh.id);
    expect(request.afterFinal).toBe(false);
    // The round answered before the reopen is superseded context, not a live answer.
    expect(request.waypoint.reopened).toBe(true);
    expect(request.waypoint.rounds).toEqual([]);
    expect(request.waypoint.supersededRounds).toHaveLength(1);
    await new Promise((done) => setTimeout(done, 5));
    ask(context, mapId, 1, false);
    expect(pendingRoundOn(context, mapId, 1).number).toBe(2);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    resolve(context, mapId, 1);
    regrill(mapId, 2);
    regrill(mapId, 3);
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
    cleanPass(context, mapId);
    const reclear = runningMapRun(context, mapId);
    expect(reclear.purpose).toBe("to_spec");
    const specNumber = (await mapRequest(reclear.id)).specs[0]?.latest.specNumber;
    if (specNumber === undefined) throw new Error("No spec listed");
    expect(
      recordSpecs(context.user, context.db, reclear.id, {
        specs: [{ specNumber, content: SPEC }],
        waits: [],
      }).ok,
    ).toBe(true);
    const review = recordSpecReview(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "spec_review").id,
      PASSED_REVIEW,
    );
    expect(review.ok).toBe(true);
    const [before, after] = context.db.select().from(specReviews).all();
    if (before === undefined || after === undefined) throw new Error("Two reviews expected");
    // Every waypoint closed again later, so the second review reads a new source set.
    expect(after.sources).toHaveLength(before.sources.length);
    for (const [index, source] of after.sources.entries()) {
      const earlier = before.sources[index];
      if (earlier === undefined) throw new Error(`No earlier source ${String(index)}`);
      expect(source.closedAt > earlier.closedAt).toBe(true);
    }
  });

  test("a grilling run after a reopened dependent's withdrawn round reads no withdrawn round", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CHAIN);
    resolve(context, mapId, 1);
    ask(context, mapId, 2, false);
    await reopen(mapId, 1);
    regrill(mapId, 1);

    const request = await grillRequest(grillingRun(context, mapId, 2).id);

    expect(request.waypoint.rounds).toEqual([]);
    expect(request.afterFinal).toBe(false);
  });
});

describe("a reopened grilling waypoint asks a new round", () => {
  const RESOLUTION = {
    round: null,
    resolution: { resolution: "Same as before.", gist: "Same as before", agentDecided: [] },
    outOfScope: null,
    mapChanges: {
      newWaypoints: [],
      fogOutOfScope: [],
      fogDecided: [],
      fogSettledHere: [],
      newFog: [],
    },
  };

  test("a resolution with no round since the reopen fails agent_output_invalid; the retry carries the problem; a new round then resolves", async () => {
    const mapId = await resolvedChain(context, project);
    await reopen(mapId, 1);
    const fresh = grillingRun(context, mapId, 1);

    const refused = recordGrill(context.user, context.db, fresh.id, RESOLUTION);

    expect(refused.ok ? null : refused.error.code).toBe("agent_output_invalid");
    expect(runById(mapId, fresh.id)).toMatchObject({
      state: "failed",
      errorCode: "agent_output_invalid",
    });
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed", resolution: null });
    const retry = grillingRun(context, mapId, 1);
    expect(retry.retryOfRunId).toBe(fresh.id);
    const request = await grillRequest(retry.id);
    expect(request.refusedAttempt).not.toBeNull();
    expect(request.waypoint.reopened).toBe(true);
    expect(request.waypoint.rounds).toEqual([]);
    expect(request.note).not.toBeNull();

    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    const next = await grillRequest(grillingRun(context, mapId, 1).id);
    expect(next.waypoint.rounds).toHaveLength(1);
    expect(next.refusedAttempt).toBeNull();
    expect(
      recordGrill(context.user, context.db, grillingRun(context, mapId, 1).id, RESOLUTION).ok,
    ).toBe(true);
    expect(waypointOf(context, mapId, 1).status).toBe("resolved");
  });

  test("a dependent reopened with it is refused the same way", async () => {
    const mapId = await resolvedChain(context, project);
    await reopen(mapId, 1);
    regrill(mapId, 1);
    const dependent = grillingRun(context, mapId, 2);

    const refused = recordGrill(context.user, context.db, dependent.id, RESOLUTION);

    expect(refused.ok ? null : refused.error.code).toBe("agent_output_invalid");
    expect(waypointOf(context, mapId, 2).resolution).toBeNull();
  });

  test("a waypoint never reopened still resolves without a new round; a reopened one may be ruled out of scope", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CHAIN);
    expect(
      recordGrill(context.user, context.db, grillingRun(context, mapId, 1).id, RESOLUTION).ok,
    ).toBe(true);
    await reopen(mapId, 1);
    const ruled = recordGrill(context.user, context.db, grillingRun(context, mapId, 1).id, {
      round: null,
      resolution: null,
      outOfScope: { reason: "The note says this decision is no longer needed." },
      mapChanges: {
        newWaypoints: [],
        fogOutOfScope: [],
        fogDecided: [],
        fogSettledHere: [],
        newFog: [],
      },
    });
    expect(ruled.ok).toBe(true);
    expect(waypointOf(context, mapId, 1).status).toBe("out_of_scope");
  });
});

describe("a waypoint resolved by a plain choice with no run is reopened", () => {
  const RESOLUTION = {
    round: null,
    resolution: { resolution: "Same as before.", gist: "Same as before", agentDecided: [] },
    outOfScope: null,
    mapChanges: {
      newWaypoints: [],
      fogOutOfScope: [],
      fogDecided: [],
      fogSettledHere: [],
      newFog: [],
    },
  };

  /**
   * A map whose waypoint 1 is stored as resolved by a plain choice on its final round with no
   * completed run (the data from when a plain choice resolved the waypoint itself), then reopened
   * by a message.
   */
  async function plainChoiceReopened(): Promise<string> {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CHAIN);
    ask(context, mapId, 1, true);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    // A plain choice once resolved the waypoint itself: no run after the final round.
    const after = grillingRun(context, mapId, 1);
    writeTestData(context, (tx) =>
      tx.delete(planningRuns).where(eq(planningRuns.id, after.id)).run(),
    );
    writeTestData(context, (tx) =>
      tx
        .update(waypoints)
        .set({
          status: "resolved",
          resolution: "Both options as offered.",
          gist: "Both options",
          agentDecided: [],
          resolvedAt: new Date().toISOString(),
          resolvedHow: "plain_choice",
          resolvedByRun: null,
        })
        .where(eq(waypoints.id, waypointOf(context, mapId, 1).id))
        .run(),
    );
    // As the plain choice did, the frontier then claims waypoint 2.
    writeTestData(context, (tx) => {
      planNext(context.user, tx, mapId);
    });
    const scope = runsOf(context, mapId).filter(
      (run) => run.waypointId === waypointOf(context, mapId, 1).id,
    );
    expect(scope.map((run) => run.state)).toEqual(["asked"]);
    // Let the clock move so the reopen's reply is later than every earlier round.
    await new Promise((done) => setTimeout(done, 5));
    const { recorded } = await reopen(mapId, 1);
    if (!recorded.ok) throw new Error(recorded.error.code);
    return mapId;
  }

  test("the fresh run's request is reopened, the final round superseded, not after a final round", async () => {
    const mapId = await plainChoiceReopened();

    const request = await grillRequest(grillingRun(context, mapId, 1).id);

    expect(request.waypoint.reopened).toBe(true);
    expect(request.waypoint.rounds).toEqual([]);
    expect(request.waypoint.supersededRounds).toHaveLength(1);
    expect(request.waypoint.supersededRounds[0]?.final).toBe(true);
    expect(request.afterFinal).toBe(false);
    expect(request.note).not.toBeNull();
  });

  test("a resolution with no new round is refused agent_output_invalid; the retry asks a round, which then resolves", async () => {
    const mapId = await plainChoiceReopened();
    const fresh = grillingRun(context, mapId, 1);

    const refused = recordGrill(context.user, context.db, fresh.id, RESOLUTION);

    expect(refused.ok ? null : refused.error.code).toBe("agent_output_invalid");
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed", resolution: null });
    const retry = grillingRun(context, mapId, 1);
    expect(retry.retryOfRunId).toBe(fresh.id);
    expect((await grillRequest(retry.id)).refusedAttempt).not.toBeNull();
    // The old final round no longer makes the run "after a final round": it may ask.
    ask(context, mapId, 1, false);
    answer(context, mapId, 1, PLAIN_ANSWERS);
    const next = await grillRequest(grillingRun(context, mapId, 1).id);
    expect(next.waypoint.rounds).toHaveLength(1);
    expect(next.waypoint.supersededRounds).toHaveLength(1);
    expect(next.afterFinal).toBe(false);
    expect(
      recordGrill(context.user, context.db, grillingRun(context, mapId, 1).id, RESOLUTION).ok,
    ).toBe(true);
    expect(waypointOf(context, mapId, 1).status).toBe("resolved");
  });

  /** The reopened run's request still reads the reopen, and a resolution without a round is refused. */
  async function expectStillReopened(
    mapId: string,
    message: { text: string; sentAt: string },
  ): Promise<void> {
    const fresh = grillingRun(context, mapId, 1);
    expect(fresh).toMatchObject({ state: "running", retryOfRunId: null });
    const request = await grillRequest(fresh.id);
    expect(request.waypoint.reopened).toBe(true);
    expect(request.waypoint.rounds).toEqual([]);
    expect(request.waypoint.supersededRounds.map((round) => round.final)).toEqual([true]);
    expect(request.afterFinal).toBe(false);
    expect(request.note).toEqual({ text: message.text, sentAt: message.sentAt });

    const refused = recordGrill(context.user, context.db, fresh.id, RESOLUTION);

    expect(refused.ok ? null : refused.error.code).toBe("agent_output_invalid");
    expect(waypointOf(context, mapId, 1)).toMatchObject({ status: "claimed", resolution: null });
    expect(grillingRun(context, mapId, 1).retryOfRunId).toBe(fresh.id);
  }

  test("a reword after the reopen keeps the reopen; a resolution with no new round is refused", async () => {
    const mapId = await plainChoiceReopened();
    // The fresh run asks round 2; the person rewords the waypoint before answering it.
    ask(context, mapId, 1, false);
    const asked = pendingRoundOn(context, mapId, 1);

    const { recorded, message } = await direct(mapId, {
      kind: "reword",
      waypoint: 1,
      title: "Blank filter on list",
      question: "What does list do when the filter is blank after trimming?",
    });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(waypointOf(context, mapId, 1).hatchMessageId).toBe(message.id);
    const withdrawn = readRounds(context.db, mapId).find((round) => round.id === asked.id);
    expect(withdrawn).toMatchObject({ status: "withdrawn", withdrawnReason: "superseded" });
    await expectStillReopened(mapId, message);
  });

  test("run_waypoint after the reopened run stopped keeps the reopen; a resolution with no new round is refused", async () => {
    const mapId = await plainChoiceReopened();
    const failure = { code: "agent_timed_out", message: "The agent timed out" } as const;
    const first = grillingRun(context, mapId, 1);
    failRun(context.user, context.db, first.id, failure);
    failRun(context.user, context.db, grillingRun(context, mapId, 1).id, failure);
    expect(waypointOf(context, mapId, 1).status).toBe("open");

    const { recorded, message } = await direct(mapId, { kind: "run_waypoint", waypoint: 1 });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(waypointOf(context, mapId, 1).hatchMessageId).toBe(message.id);
    await expectStillReopened(mapId, message);
  });

  test("a claimed dependent with a round answered before its blocker's reopen is reopened too", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, CHAIN);
    resolve(context, mapId, 1);
    // Waypoint 2 is mid-grilling: one round answered, its next run running.
    ask(context, mapId, 2, false);
    answer(context, mapId, 2, PLAIN_ANSWERS);
    expect(waypointOf(context, mapId, 2).status).toBe("claimed");
    await new Promise((done) => setTimeout(done, 5));
    const { recorded } = await reopen(mapId, 1);
    if (!recorded.ok) throw new Error(recorded.error.code);
    regrill(mapId, 1);

    const fresh = grillingRun(context, mapId, 2);
    const request = await grillRequest(fresh.id);

    expect(request.waypoint.reopened).toBe(true);
    expect(request.waypoint.rounds).toEqual([]);
    expect(request.waypoint.supersededRounds).toHaveLength(1);
    const refused = recordGrill(context.user, context.db, fresh.id, RESOLUTION);
    expect(refused.ok ? null : refused.error.code).toBe("agent_output_invalid");
  });

  test("a dependent with nothing answered before its blocker's reopen is not reopened", async () => {
    const mapId = await plainChoiceReopened();
    regrill(mapId, 1);

    const request = await grillRequest(grillingRun(context, mapId, 2).id);

    expect(request.waypoint.reopened).toBe(false);
    expect(request.waypoint.supersededRounds).toEqual([]);
    expect(
      recordGrill(context.user, context.db, grillingRun(context, mapId, 2).id, RESOLUTION).ok,
    ).toBe(true);
    expect(waypointOf(context, mapId, 2).status).toBe("resolved");
  });
});

describe("re-clear", () => {
  test("a re-resolution makes to_spec due; its request lists the approved spec and the draft", async () => {
    const mapId = await resolvedChain(context, project);
    const drafted = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [
        { specNumber: null, content: SPEC },
        { specNumber: null, content: IMPORT_SPEC },
      ],
      waits: [],
    });
    if (!drafted.ok) throw new Error(drafted.error.code);
    const [first, second] = readMapRevisions(context.db, mapId);
    if (first === undefined || second === undefined) throw new Error("Two specs expected");
    for (const review of runsOf(context, mapId).filter(
      (run) => run.purpose === "spec_review" && run.state === "running",
    )) {
      const recorded = recordSpecReview(context.user, context.db, review.id, PASSED_REVIEW);
      if (!recorded.ok) throw new Error(recorded.error.code);
    }
    const approved = approveSpecRevision(context.user, context.db, { specRevisionId: first.id });
    if (!approved.ok) throw new Error(approved.error.code);

    await reopen(mapId, 1);
    await reresolve(mapId);

    const reclear = runningMapRun(context, mapId);
    expect(reclear.purpose).toBe("to_spec");
    const request = await mapRequest(reclear.id);
    expect(request.specs.map((spec) => spec.approved)).toEqual([true, false]);
    expect(request.refusedAttempt).toBeNull();

    // Zero specs, or one omitting the draft, fails spec_content_invalid; the retry carries it.
    const zero = recordSpecs(context.user, context.db, reclear.id, { specs: [], waits: [] });
    expect(zero.ok ? null : zero.error.code).toBe("spec_content_invalid");
    const retry = runningMapRun(context, mapId);
    expect((await mapRequest(retry.id)).refusedAttempt).not.toBeNull();
    const specNumber = request.specs[1]?.latest.specNumber;
    if (specNumber === undefined) throw new Error("No draft listed");
    expect(
      recordSpecs(context.user, context.db, retry.id, {
        specs: [{ specNumber, content: IMPORT_SPEC }],
        waits: [],
      }).ok,
    ).toBe(true);

    // The approved spec stands; the draft is rewritten in place.
    const firstLatest = latestOf(readSpecRevisions(context.db, first.specificationId));
    expect(firstLatest.id).toBe(first.id);
    expect(firstLatest.approvedAt).not.toBeNull();
    expect(latestOf(readSpecRevisions(context.db, second.specificationId))).toMatchObject({
      revision: 1,
      content: IMPORT_SPEC,
    });
  });

  test("with every spec approved the re-clear records zero specs and changes nothing", async () => {
    const { mapId, revision } = await draftedChain();
    passAndApprove(mapId, revision.id);
    const tickets = runningSpecRun(context, mapId, "to_tickets");
    expect(recordTicketSet(context.user, context.db, tickets.id, TICKETS).ok).toBe(true);
    const review = runningSpecRun(context, mapId, "tickets_review");
    const revisions = readMapRevisions(context.db, mapId);

    await reopen(mapId, 1);
    // The reopen leaves the tickets review of the approved revision running.
    expect(runById(mapId, review.id).state).toBe("running");
    await reresolve(mapId);

    const reclear = runningMapRun(context, mapId);
    expect(recordSpecs(context.user, context.db, reclear.id, { specs: [], waits: [] })).toEqual({
      ok: true,
      value: null,
    });
    expect(runById(mapId, reclear.id).state).toBe("completed");
    expect(readMapRevisions(context.db, mapId)).toEqual(revisions);
    // Nothing is due again: no map run starts after it; the tickets review still runs.
    expect(
      runsOf(context, mapId)
        .filter(
          (run) => run.state === "running" && run.waypointId === null && run.purpose !== "hatch",
        )
        .map((run) => run.id),
    ).toEqual([review.id]);
  });

  test("zero specs on a first clear fails spec_content_invalid; the retry and Try again carry the problem", async () => {
    const mapId = await clearedMap(context, project);
    const first = runningMapRun(context, mapId);
    expect((await mapRequest(first.id)).refusedAttempt).toBeNull();

    const zero = recordSpecs(context.user, context.db, first.id, { specs: [], waits: [] });
    expect(zero.ok ? null : zero.error.code).toBe("spec_content_invalid");
    const retry = runningMapRun(context, mapId);
    expect((await mapRequest(retry.id)).refusedAttempt?.problem).toBe(
      runById(mapId, first.id).errorMessage,
    );

    expect(recordSpecs(context.user, context.db, retry.id, { specs: [], waits: [] }).ok).toBe(
      false,
    );
    const again = tryAgain(context.user, context.db, retry.id);
    expect(again.ok).toBe(true);
    const fresh = runningMapRun(context, mapId);
    expect(fresh.id).not.toBe(retry.id);
    expect((await mapRequest(fresh.id)).refusedAttempt).not.toBeNull();
  });

  test("a running spec-scoped repair is replaced by the re-clear", async () => {
    const { mapId, revision } = await draftedChain();
    await reopen(mapId, 1);
    await new Promise((done) => setTimeout(done, 5));
    regrill(mapId, 1);
    regrill(mapId, 2);
    regrill(mapId, 3);
    const repair = insertRun(context, {
      mapId,
      specificationId: revision.specificationId,
      purpose: "to_spec",
      state: "running",
    });

    cleanPass(context, mapId);

    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
    expect(runById(mapId, repair.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "replaced",
    });
  });
});
