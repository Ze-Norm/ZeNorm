/**
 * Waits released when nothing holds their spec, notes on an approved or delivered spec, the
 * hatch's latest approved revision, Try again on a release run, cross-map planning, and stopped
 * runs and notes on a replaced ticket set.
 */
import { readMapRounds } from "./run-work.ts";
import type {
  ClauseSource,
  HatchChange,
  HatchStage,
  PlanningRun,
  Project,
} from "@zenorm/contracts";
import { hatchMessages, planningRuns, specWaits } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import {
  hatchRequest,
  recordHatchReply,
  SPEC_IN_FLIGHT_SENTENCES,
  SPEC_WAIT_SENTENCES,
} from "./hatch-runs.ts";
import { approveSpecRevision, rejectSpecRevision } from "./planning.ts";
import { completeRun, failRun, readMap, tryAgain } from "./planning-runs.ts";
import { reviseSpecRequest } from "./spec-requests.ts";
import type { SpecRunBase } from "./spec-requests.ts";
import { recordRevision, recordSpecReview, recordSpecs } from "./spec-runs.ts";
import { readNoteDirectedRevisions, readSpecRevisions } from "./specs.ts";
import type { StoredRevision } from "./specs.ts";
import {
  addProject,
  cleanPass,
  clearedMap,
  closeTestContext,
  deliverableTicketSet,
  deliveredSpec,
  draftedTicketSet,
  endRun,
  holdByDelivery,
  holdByRevising,
  holdByRevision,
  holdByTickets,
  insertHatchRun,
  insertMessage,
  insertNextRevision,
  openTestContext,
  PASSED_REVIEW,
  recordRunningTicketSet,
  recordRunningTicketsReview,
  resolve,
  reviewedSpec,
  reviewedTicketSet,
  runningMapRun,
  runningSpecRun,
  runsOf,
  SPEC,
  startedRun,
  TICKETS,
} from "./test-support.ts";
import type { TestContext, DraftContent } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };
const BASE: SpecRunBase = {
  projectName: "repo",
  projectFolder: "/tmp/repo",
  baseBranch: "main",
  idea: "Export data",
};
const NO_FOG = {
  newWaypoints: [],
  fogOutOfScope: [],
  newFog: [],
  fogDecided: [],
  fogSettledHere: [],
};
const WAIT_NOTE = "Add a CSV option.";
const NOTE = "Parents must be exported too.";
const REVISE: HatchChange = { kind: "revise_spec" };
const REWRITE: HatchChange = { kind: "rewrite_tickets" };
const TIMED_OUT = { code: "agent_timed_out", message: "The agent timed out" } as const;

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-release-");
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
  return addingClause(title, { kind: "note" });
}

/** `kept(title)` plus a new clause C2 whose only source is `source`. */
function addingClause(title: string, source: ClauseSource): DraftContent {
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
        sources: [source],
        reliesOn: [],
        adds: ["new behaviour"],
      },
    ],
  };
}

function waitsOf(mapId: string) {
  return context.db.select().from(specWaits).where(eq(specWaits.mapId, mapId)).all();
}

function onlyWait(mapId: string) {
  const waits = waitsOf(mapId);
  const [wait] = waits;
  if (wait === undefined || waits.length !== 1) {
    throw new Error(`Map ${mapId} has ${String(waits.length)} waits`);
  }
  return wait;
}

function runOf(runId: string): PlanningRun {
  const run = context.db.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
  if (run === undefined) throw new Error(`No run ${runId}`);
  return run;
}

function titleOf(mapId: string): string {
  const { title } = readMap(context.db, mapId);
  if (title === null) throw new Error(`Map ${mapId} has no title`);
  return title;
}

function revisions(specificationId: string): StoredRevision[] {
  return readSpecRevisions(context.db, specificationId);
}

function latest(specificationId: string): StoredRevision {
  const found = revisions(specificationId).at(-1);
  if (found === undefined) throw new Error("No revision");
  return found;
}

function running(mapId: string, purpose: PlanningRun["purpose"]): boolean {
  return runsOf(context, mapId).some(
    (run) => run.state === "running" && run.specificationId !== null && run.purpose === purpose,
  );
}

/** The run that released the map's only wait, which must be released. */
function releaseRun(mapId: string): PlanningRun {
  const wait = onlyWait(mapId);
  if (wait.releasedByRun === null) throw new Error(`Map ${mapId}'s wait is open`);
  return runOf(wait.releasedByRun);
}

/** A cleared map whose To Spec names only a wait on spec 1 with `note`. */
async function waiting(note: string): Promise<string> {
  const mapId = await clearedMap(context, project);
  const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
    specs: [],
    waits: [{ specNumber: 1, note }],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  return mapId;
}

/** A cleared map whose To Spec writes spec 1's next revision, its review running. */
async function reviser(title: string): Promise<string> {
  const mapId = await clearedMap(context, project);
  const recorded = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
    specs: [{ specNumber: 1, content: kept(title) }],
    waits: [],
  });
  if (!recorded.ok) throw new Error(recorded.error.code);
  return mapId;
}

function passReview(mapId: string): void {
  const recorded = recordSpecReview(
    context.user,
    context.db,
    runningSpecRun(context, mapId, "spec_review").id,
    PASSED_REVIEW,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function approveLatest(specificationId: string): void {
  const approved = approveSpecRevision(context.user, context.db, {
    specRevisionId: latest(specificationId).id,
  });
  if (!approved.ok) throw new Error(approved.error.code);
}

/** The holder's revision approved, its tickets written and reviewed: its ticket-set runs end. */
function ticketsEnd(holder: string): void {
  recordRunningTicketSet(context, holder);
  recordRunningTicketsReview(context, holder);
}

/** Ends a spec-scoped run `completed`, as a run ending with nothing to save does. */
function complete(run: PlanningRun): void {
  completeRun(context.user, context.db, run.id, run.purpose, () => undefined);
}

/**
 * Sends `text` about spec 1 from `stage` on `mapId` and has its hatch run reply with `change`;
 * returns the stored message.
 */
async function note(mapId: string, change: HatchChange, stage: HatchStage, text: string) {
  const sent = await sendHatchMessage(
    context.user,
    context.db,
    { mapId, stage, specNumber: stage === "spec" || stage === "tickets" ? 1 : null, text },
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
 * A note on a waiting map opens Grilling waypoint `number` (the map wrote no spec, so the message
 * and its run are inserted directly): the map is un-cleared.
 */
function unclear(mapId: string, number: number): void {
  hatchChange(mapId, {
    kind: "open_waypoint",
    waypointKind: "grilling",
    title: `Decide ${String(number)}`,
    question: "What is the export's file called?",
    blockedBy: [],
    fog: NO_FOG,
  });
}

/** A Wayfinding message on `mapId` whose hatch run applies `change` (inserted directly). */
function hatchChange(mapId: string, change: HatchChange): void {
  const messageId = insertMessage(context, mapId, {
    state: "queued",
    stage: "wayfinding",
    specificationId: null,
    text: "Change the map.",
  });
  const hatch = insertHatchRun(context, mapId, messageId, "running");
  const recorded = recordHatchReply(context.user, context.db, hatch.id, { reply: "Done.", change });
  if (!recorded.ok) throw new Error(recorded.error.code);
}

/** Resolves waypoint `number`; the map's re-clear `to_spec` then runs (after a clean pass). */
function reclear(mapId: string, number: number): PlanningRun {
  resolve(context, mapId, number);
  if (runningMapRun(context, mapId).purpose === "consistency") {
    cleanPass(context, mapId);
  }
  const run = runningMapRun(context, mapId);
  expect(run).toMatchObject({ purpose: "to_spec", specificationId: null });
  return run;
}

/** Spec 1's r1 approved on a first map (its set reviewed), and a `revising` hold on it there. */
async function heldByRevising() {
  const first = await reviewedTicketSet(context, project);
  const revising = holdByRevising(context, {
    specificationId: first.specificationId,
    mapId: first.mapId,
    state: "running",
  });
  return { ...first, revising };
}

describe("release", () => {
  test("a revision hold: approval starts the holder's to_tickets first; the wait releases when its ticket-set runs end, and the release revision closes it", async () => {
    const { specificationId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    const waiter = await waiting(WAIT_NOTE);
    expect(onlyWait(waiter)).toMatchObject({
      holdKind: "revision",
      holdMapId: holder,
      holdRevision: 2,
      releasedAt: null,
    });

    passReview(holder);
    approveLatest(specificationId);
    expect(running(holder, "to_tickets")).toBe(true);
    expect(onlyWait(waiter).releasedAt).toBeNull();
    recordRunningTicketSet(context, holder);
    expect(running(holder, "tickets_review")).toBe(true);
    expect(onlyWait(waiter).releasedAt).toBeNull();
    expect(running(waiter, "to_spec")).toBe(false);

    recordRunningTicketsReview(context, holder);
    const release = releaseRun(waiter);
    expect(release).toMatchObject({
      mapId: waiter,
      specificationId,
      purpose: "to_spec",
      state: "running",
      hatchMessageId: null,
    });
    expect(onlyWait(waiter).releasedAt).not.toBeNull();
    const request = reviseSpecRequest(
      context.db,
      readMap(context.db, waiter),
      release,
      BASE,
      readMapRounds(context.db, waiter),
    );
    expect(request.feedback).toEqual({ kind: "wait", note: WAIT_NOTE, noteDirected: false });
    expect(request.latest.revision).toBe(2);

    expect(
      recordRevision(context.user, context.db, release.id, {
        revision: kept("Waited"),
        removed: [],
      }).ok,
    ).toBe(true);
    expect(revisions(specificationId).map((revision) => revision.mapId)).toEqual([
      expect.any(String),
      holder,
      waiter,
    ]);
    expect(revisions(specificationId)[1]?.approvedAt).not.toBeNull();
    expect(latest(specificationId)).toMatchObject({ revision: 3, approvedAt: null });
    expect(onlyWait(waiter).releasedByRun).toBe(release.id);
    expect(runOf(release.id).state).toBe("completed");
    expect(running(waiter, "spec_review")).toBe(true);
  });

  // A wait To Spec recorded on a map with no waypoints, released on a spec with no
  // note-directed revision: no waypoint decided the change and there is no note, so its new clause
  // cites the destination; a note source is refused.
  async function releasedDecisionWait() {
    const { specificationId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    const waiter = await waiting(WAIT_NOTE);
    passReview(holder);
    approveLatest(specificationId);
    ticketsEnd(holder);
    const release = releaseRun(waiter);
    const request = reviseSpecRequest(
      context.db,
      readMap(context.db, waiter),
      release,
      BASE,
      readMapRounds(context.db, waiter),
    );
    expect(request.feedback).toEqual({ kind: "wait", note: WAIT_NOTE, noteDirected: false });
    expect(request.waypoints).toEqual([]);
    return { specificationId, waiter, release };
  }

  test("a decision-born release on a map with no waypoints may not cite a note", async () => {
    const { specificationId, release } = await releasedDecisionWait();
    const recorded = recordRevision(context.user, context.db, release.id, {
      revision: citingNote("Noted"),
      removed: [],
    });
    expect(!recorded.ok && recorded.error.code).toBe("spec_content_invalid");
    expect(latest(specificationId).revision).toBe(2);
    expect(runOf(release.id)).toMatchObject({ state: "failed", errorCode: "spec_content_invalid" });
  });

  test("a decision-born release on a map with no waypoints cites the destination", async () => {
    const { specificationId, waiter, release } = await releasedDecisionWait();
    const revision = addingClause("Waited", { kind: "destination" });
    expect(recordRevision(context.user, context.db, release.id, { revision, removed: [] }).ok).toBe(
      true,
    );
    expect(latest(specificationId)).toMatchObject({ revision: 3, mapId: waiter });
    expect(readNoteDirectedRevisions(context.db, specificationId)).toEqual([]);
  });

  test("a revision hold rejected: the holder's repair runs and the wait stays open", async () => {
    const { specificationId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    const waiter = await waiting(WAIT_NOTE);
    passReview(holder);
    const rejected = rejectSpecRevision(context.user, context.db, {
      specRevisionId: latest(specificationId).id,
      reason: "Name the format.",
    });
    expect(rejected.ok).toBe(true);
    expect(running(holder, "to_spec")).toBe(true);
    expect(onlyWait(waiter).releasedAt).toBeNull();
    expect(running(waiter, "to_spec")).toBe(false);
  });

  test("a revising hold: the holder's spec-scoped to_spec ending releases the wait", async () => {
    const { specificationId, mapId, revising } = await heldByRevising();
    const waiter = await waiting(WAIT_NOTE);
    expect(onlyWait(waiter)).toMatchObject({
      holdKind: "revising",
      holdMapId: mapId,
      holdRevision: 1,
    });
    complete(revising);
    expect(releaseRun(waiter)).toMatchObject({ specificationId, state: "running" });
  });

  test("a tickets hold: the wait releases once the holder's to_tickets and tickets_review end", async () => {
    const { specificationId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    passReview(holder);
    approveLatest(specificationId);
    const waiter = await waiting(WAIT_NOTE);
    expect(onlyWait(waiter)).toMatchObject({
      holdKind: "tickets",
      holdMapId: holder,
      holdRevision: 2,
    });
    recordRunningTicketSet(context, holder);
    expect(onlyWait(waiter).releasedAt).toBeNull();
    recordRunningTicketsReview(context, holder);
    expect(releaseRun(waiter)).toMatchObject({ specificationId, state: "running" });
  });

  test("a delivering hold: the delivery run's end releases the wait", async () => {
    const { specificationId } = await deliveredSpec(context, project);
    const holder = await clearedMap(context, project);
    const held = await holdByDelivery(context, {
      specificationId,
      mapId: holder,
      content: kept("Delivering"),
    });
    const waiter = await waiting(WAIT_NOTE);
    expect(onlyWait(waiter)).toMatchObject({
      holdKind: "delivering",
      holdMapId: holder,
      holdRevision: 2,
      releasedAt: null,
    });
    await endRun(context, held.run.id, { outcome: "failed" });
    expect(releaseRun(waiter)).toMatchObject({ specificationId, state: "running" });
  });

  test("two waiting maps are released in turn: the oldest first, the second once the first's change has ended", async () => {
    const { specificationId, revising } = await heldByRevising();
    const first = await waiting("First change.");
    const second = await waiting("Second change.");
    complete(revising);
    const release = releaseRun(first);
    expect(onlyWait(second).releasedAt).toBeNull();

    expect(
      recordRevision(context.user, context.db, release.id, { revision: kept("First"), removed: [] })
        .ok,
    ).toBe(true);
    expect(onlyWait(second).releasedAt).toBeNull();
    passReview(first);
    approveLatest(specificationId);
    expect(onlyWait(second).releasedAt).toBeNull();
    ticketsEnd(first);

    const next = releaseRun(second);
    expect(next).toMatchObject({ mapId: second, specificationId, state: "running" });
    expect(
      reviseSpecRequest(
        context.db,
        readMap(context.db, second),
        next,
        BASE,
        readMapRounds(context.db, second),
      ),
    ).toMatchObject({
      feedback: { kind: "wait", note: "Second change.", noteDirected: false },
      latest: { revision: 2 },
    });
  });

  test("an un-cleared waiting map is skipped, and released once its re-clear ends", async () => {
    const { specificationId, revising } = await heldByRevising();
    const waiter = await waiting(WAIT_NOTE);
    unclear(waiter, 1);
    complete(revising);
    expect(onlyWait(waiter).releasedAt).toBeNull();
    expect(running(waiter, "to_spec")).toBe(false);

    const reclearing = reclear(waiter, 1);
    expect(onlyWait(waiter).releasedAt).toBeNull();
    expect(recordSpecs(context.user, context.db, reclearing.id, { specs: [], waits: [] }).ok).toBe(
      true,
    );
    expect(releaseRun(waiter)).toMatchObject({ specificationId, state: "running" });
  });

  test("a release run cancelled by the re-clear, then by a reopen, reopens its wait each time with since kept", async () => {
    const { revising } = await heldByRevising();
    const waiter = await waiting(WAIT_NOTE);
    const since = onlyWait(waiter).since;
    complete(revising);
    const release = releaseRun(waiter);

    unclear(waiter, 1);
    const reclearing = reclear(waiter, 1);
    expect(runOf(release.id)).toMatchObject({ state: "cancelled", cancelReason: "replaced" });
    expect(onlyWait(waiter)).toMatchObject({ since, releasedAt: null, releasedByRun: null });

    expect(recordSpecs(context.user, context.db, reclearing.id, { specs: [], waits: [] }).ok).toBe(
      true,
    );
    const again = releaseRun(waiter);
    expect(again.id).not.toBe(release.id);
    expect(onlyWait(waiter).since).toBe(since);

    // A reopen through the hatch cancels the release run `reopened` and reopens the wait too.
    hatchChange(waiter, { kind: "reopen", waypoint: 1 });
    expect(runOf(again.id)).toMatchObject({ state: "cancelled", cancelReason: "reopened" });
    expect(onlyWait(waiter)).toMatchObject({ since, releasedAt: null, releasedByRun: null });
  });

  test("a stopped release run superseded by an un-clear reopens its wait", async () => {
    const { revising } = await heldByRevising();
    const waiter = await waiting(WAIT_NOTE);
    const since = onlyWait(waiter).since;
    complete(revising);
    failRun(context.user, context.db, releaseRun(waiter).id, TIMED_OUT);
    const retry = releaseRun(waiter);
    failRun(context.user, context.db, retry.id, TIMED_OUT);
    expect(onlyWait(waiter).releasedByRun).toBe(retry.id);

    unclear(waiter, 1);
    expect(onlyWait(waiter)).toMatchObject({ since, releasedAt: null, releasedByRun: null });
  });

  test("a delivery started during a release run: its result saves nothing, the wait is open again and the run completes", async () => {
    const { specificationId, mapId, ticketSetId } = await deliverableTicketSet(context, project);
    const revising = holdByRevising(context, { specificationId, mapId, state: "running" });
    const waiter = await waiting(WAIT_NOTE);
    const since = onlyWait(waiter).since;
    complete(revising);
    const release = releaseRun(waiter);
    await startedRun(context, ticketSetId);

    expect(
      recordRevision(context.user, context.db, release.id, { revision: kept("Late"), removed: [] })
        .ok,
    ).toBe(true);
    expect(revisions(specificationId)).toHaveLength(1);
    expect(runOf(release.id).state).toBe("completed");
    expect(onlyWait(waiter)).toMatchObject({
      since,
      releasedAt: null,
      holdKind: "revising",
      note: WAIT_NOTE,
    });
  });

  test("Try again on a stopped release run starts it again, its wait released by the new run", async () => {
    const { revising } = await heldByRevising();
    const waiter = await waiting(WAIT_NOTE);
    complete(revising);
    const first = releaseRun(waiter);
    const releasedAt = onlyWait(waiter).releasedAt;
    failRun(context.user, context.db, first.id, TIMED_OUT);
    const retry = releaseRun(waiter);
    expect(retry.retryOfRunId).toBe(first.id);
    failRun(context.user, context.db, retry.id, TIMED_OUT);
    expect(onlyWait(waiter).releasedByRun).toBe(retry.id);

    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const fresh = releaseRun(waiter);
    expect(fresh).toMatchObject({ state: "running", retryOfRunId: null });
    expect(fresh.id).not.toBe(retry.id);
    expect(onlyWait(waiter).releasedAt).toBe(releasedAt);
  });
});

describe("across maps", () => {
  test("a to_tickets held back by another map's spec-scoped run starts in the transaction that ends that run", async () => {
    const { specificationId, mapId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    passReview(holder);
    const revising = holdByRevising(context, { specificationId, mapId, state: "running" });
    approveLatest(specificationId);
    expect(running(holder, "to_tickets")).toBe(false);
    complete(revising);
    expect(running(holder, "to_tickets")).toBe(true);
  });
});

describe("notes on an approved or delivered spec", () => {
  test("a note on a delivered spec writes r2 through a note run, r1 still approved", async () => {
    const { mapId, specificationId } = await deliveredSpec(context, project);
    const message = await note(mapId, REVISE, "spec", NOTE);
    expect(message).toMatchObject({ refusal: null, change: REVISE });
    const run = runningSpecRun(context, mapId, "to_spec");
    expect(run.hatchMessageId).toBe(message.id);
    expect(
      recordRevision(context.user, context.db, run.id, {
        revision: citingNote("Noted"),
        removed: [],
      }).ok,
    ).toBe(true);
    const [r1, r2] = revisions(specificationId);
    expect(r1?.approvedAt).not.toBeNull();
    expect(r1?.supersededAt).toBeNull();
    expect(r2).toMatchObject({ revision: 2, mapId, approvedAt: null });
    expect(readNoteDirectedRevisions(context.db, specificationId)).toEqual([
      { revision: 2, note: NOTE },
    ]);
  });

  test.each(["revision", "revising", "tickets"] as const)(
    "on a spec another map holds by %s, it records a wait with the message, its hold and a reply with refusal and change null",
    async (kind) => {
      const { mapId, specificationId } = await reviewedTicketSet(context, project);
      const holder = await clearedMap(context, project);
      const revision =
        kind === "revision"
          ? holdByRevision(context, {
              specificationId,
              mapId: holder,
              content: kept("Drafted"),
              review: "passed",
            }).revision
          : kind === "revising"
            ? (holdByRevising(context, { specificationId, mapId: holder, state: "running" }), 1)
            : holdByTickets(context, {
                specificationId,
                mapId: holder,
                content: kept("Ticketing"),
                set: null,
                purpose: "to_tickets",
                state: "running",
              }).revision;
      const message = await note(mapId, REVISE, "spec", NOTE);
      expect(message).toMatchObject({
        refusal: null,
        change: null,
        reply: SPEC_WAIT_SENTENCES[kind]({
          spec: latest(specificationId).content.title,
          holder: titleOf(holder),
          revision,
        }),
      });
      expect(onlyWait(mapId)).toMatchObject({
        note: NOTE,
        hatchMessageId: message.id,
        holdKind: kind,
        holdMapId: holder,
        holdRevision: revision,
        releasedAt: null,
      });
      expect(running(mapId, "to_spec")).toBe(false);

      const second = await note(mapId, REVISE, "spec", "And JSON.");
      expect(second.refusal).toBe("spec_waiting");
      expect(waitsOf(mapId)).toHaveLength(1);
    },
  );

  test("a note during an active delivery run is spec_in_flight, not a wait", async () => {
    const { mapId, specificationId } = await deliveredSpec(context, project);
    const holder = await clearedMap(context, project);
    await holdByDelivery(context, { specificationId, mapId: holder, content: kept("Delivering") });
    const message = await note(mapId, REVISE, "spec", NOTE);
    expect(message).toMatchObject({
      refusal: "spec_in_flight",
      reply: SPEC_IN_FLIGHT_SENTENCES.revise_spec.delivering,
    });
    expect(waitsOf(mapId)).toHaveLength(0);
  });

  test("a note-born wait's release run carries the message; its revision is note-directed", async () => {
    const { mapId, specificationId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    const message = await note(mapId, REVISE, "spec", NOTE);
    expect(onlyWait(mapId)).toMatchObject({ holdKind: "revision", hatchMessageId: message.id });

    passReview(holder);
    approveLatest(specificationId);
    ticketsEnd(holder);
    const release = releaseRun(mapId);
    expect(release).toMatchObject({ purpose: "to_spec", hatchMessageId: message.id });
    expect(
      reviseSpecRequest(
        context.db,
        readMap(context.db, mapId),
        release,
        BASE,
        readMapRounds(context.db, mapId),
      ).feedback,
    ).toEqual({ kind: "wait", note: NOTE, noteDirected: true });
    expect(
      recordRevision(context.user, context.db, release.id, {
        revision: citingNote("Noted"),
        removed: [],
      }).ok,
    ).toBe(true);
    expect(latest(specificationId)).toMatchObject({ revision: 3, mapId });
    expect(readNoteDirectedRevisions(context.db, specificationId)).toEqual([
      { revision: 3, note: NOTE },
    ]);
  });

  test("a note run that finds its spec held when it records saves nothing and records the wait with the note", async () => {
    const { mapId, specificationId, ticketSetId } = await deliverableTicketSet(context, project);
    const message = await note(mapId, REVISE, "spec", NOTE);
    const run = runningSpecRun(context, mapId, "to_spec");
    const delivery = await startedRun(context, ticketSetId);

    expect(
      recordRevision(context.user, context.db, run.id, {
        revision: citingNote("Late"),
        removed: [],
      }).ok,
    ).toBe(true);
    expect(revisions(specificationId)).toHaveLength(1);
    expect(runOf(run.id).state).toBe("completed");
    expect(onlyWait(mapId)).toMatchObject({
      note: NOTE,
      hatchMessageId: message.id,
      holdKind: "delivering",
      holdMapId: mapId,
      holdRevision: 1,
      releasedAt: null,
    });

    await endRun(context, delivery.id, { outcome: "cancelled" });
    expect(releaseRun(mapId)).toMatchObject({ hatchMessageId: message.id, state: "running" });
  });

  test("a rewrite_tickets note on a replaced set is refused no_ticket_set and starts nothing", async () => {
    const { mapId } = await reviewedTicketSet(context, project);
    const holder = await reviser("Held");
    passReview(holder);
    const message = await note(mapId, REWRITE, "tickets", NOTE);
    expect(message.refusal).toBe("no_ticket_set");
    expect(running(mapId, "to_tickets")).toBe(false);
  });
});

describe("a stopped ticket-set run on a replaced set", () => {
  test.each(["to_tickets", "tickets_review"] as const)(
    "a stopped %s is cancelled replaced by the same map's re-clear; the new revision's review starts",
    async (purpose) => {
      const { mapId, specificationId } =
        purpose === "to_tickets" ? await approvedSpec() : await draftedTicketSet(context, project);
      const first = runningSpecRun(context, mapId, purpose);
      failRun(context.user, context.db, first.id, TIMED_OUT);
      const stopped = runningSpecRun(context, mapId, purpose);
      failRun(context.user, context.db, stopped.id, TIMED_OUT);
      expect(runOf(stopped.id).state).toBe("failed");

      unclear(mapId, 1);
      const reclearing = reclear(mapId, 1);
      const recorded = recordSpecs(context.user, context.db, reclearing.id, {
        specs: [{ specNumber: 1, content: kept("Next") }],
        waits: [],
      });
      expect(recorded.ok).toBe(true);
      expect(latest(specificationId).revision).toBe(2);
      expect(runOf(stopped.id)).toMatchObject({
        state: "cancelled",
        cancelReason: "replaced",
        errorCode: null,
      });
      expect(running(mapId, "spec_review")).toBe(true);
      const again = tryAgain(context.user, context.db, stopped.id);
      expect(again.ok ? null : again.error.code).toBe("planning_run_not_stopped");
    },
  );
});

describe("the hatch reads the latest approved revision", () => {
  test("with two approved revisions on one map, the hatch request reads the later one and its set", async () => {
    const { mapId, specificationId } = await reviewedTicketSet(context, project);
    insertNextRevision(context, {
      specificationId,
      mapId,
      content: kept("Second"),
      approved: true,
      set: { state: "awaiting_review", content: TICKETS },
    });
    const messageId = insertMessage(context, mapId, {
      state: "queued",
      stage: "spec",
      specificationId,
      text: NOTE,
    });
    const hatch = insertHatchRun(context, mapId, messageId, "running");
    const [spec] = hatchRequest(
      context.db,
      hatch,
      BASE,
      readMapRounds(context.db, hatch.mapId),
    ).specs;
    expect(spec).toMatchObject({
      latest: { revision: 2 },
      state: "approved",
      ticketSet: { version: 1, state: "awaiting_review" },
    });
  });
});

/** Spec 1's r1 approved on a cleared map, its first `to_tickets` running. */
async function approvedSpec() {
  const reviewed = await reviewedSpec(context, project);
  approveLatest(reviewed.specificationId);
  return reviewed;
}
