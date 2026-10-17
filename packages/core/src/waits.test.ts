/**
 * Waits recorded by To Spec and runs on one spec across maps.
 */
import { readMapRounds } from "./run-work.ts";
import type { HatchChange, HatchStage, PlanningRun, Project } from "@zenorm/contracts";
import { hatchMessages, planningRuns, specWaits } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordHatchReply } from "./hatch-runs.ts";
import { rejectTicketSet } from "./planning.ts";
import { planNext, readMap } from "./planning-runs.ts";
import { specHold } from "./spec-holds.ts";
import { draftSpecsRequest } from "./spec-requests.ts";
import type { SpecRunBase } from "./spec-requests.ts";
import { recordSpecs } from "./spec-runs.ts";
import { readProjectSpecs, readSpecRevisions } from "./specs.ts";
import {
  addProject,
  cleanPass,
  clearedMap,
  closeTestContext,
  deliverableTicketSet,
  holdByRevising,
  holdByRevision,
  insertHatchRun,
  insertMessage,
  insertRevision,
  openTestContext,
  resolve,
  reviewedTicketSet,
  runningMapRun,
  runsOf,
  SPEC,
  writeTestData,
} from "./test-support.ts";
import type { TestContext, DraftContent } from "./test-support.ts";

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

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-waits-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** SPEC with a new title: every id kept, so no clause needs a source. */
function kept(title: string): DraftContent {
  return { ...SPEC, title, clauses: SPEC.clauses.map((clause) => ({ ...clause, sources: [] })) };
}

function waitsOf(mapId: string) {
  return context.db.select().from(specWaits).where(eq(specWaits.mapId, mapId)).all();
}

function runOf(runId: string): PlanningRun {
  const run = context.db.select().from(planningRuns).where(eq(planningRuns.id, runId)).get();
  if (run === undefined) throw new Error(`No run ${runId}`);
  return run;
}

/** Ends a run `completed` directly, as its recording would. */
function complete(runId: string): void {
  writeTestData(context, (tx) =>
    tx
      .update(planningRuns)
      .set({ state: "completed", endedAt: new Date().toISOString() })
      .where(eq(planningRuns.id, runId))
      .run(),
  );
}

function runningOnSpecs(mapId: string): string[] {
  return runsOf(context, mapId)
    .filter((run) => run.state === "running" && run.specificationId !== null)
    .map((run) => run.purpose);
}

/**
 * A note from `stage` (about spec 1 on Spec and Tickets) whose hatch run replies with
 * `change`: the message and its run are inserted directly, as a waiting map's overview is 05's.
 */
function note(mapId: string, change: HatchChange, stage: HatchStage) {
  const onSpec = stage === "spec" || stage === "tickets";
  const specificationId = onSpec ? readProjectSpecs(context.db, project.id)[0]?.id : null;
  if (specificationId === undefined) throw new Error("No spec 1");
  const messageId = insertMessage(context, mapId, {
    state: "queued",
    stage,
    specificationId,
    text: "Change it.",
  });
  const hatch = insertHatchRun(context, mapId, messageId, "running");
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

/** A note opens Grilling waypoint `number`, whose run resolves it: the map's re-clear runs. */
function reclearing(mapId: string, number: number): PlanningRun {
  note(
    mapId,
    {
      kind: "open_waypoint",
      waypointKind: "grilling",
      title: `Decide ${String(number)}`,
      question: "What is the export's file called?",
      blockedBy: [],
      fog: NO_FOG,
    },
    "wayfinding",
  );
  resolve(context, mapId, number);
  if (runningMapRun(context, mapId).purpose === "consistency") {
    cleanPass(context, mapId);
  }
  const run = runningMapRun(context, mapId);
  expect(run).toMatchObject({ purpose: "to_spec", specificationId: null });
  return run;
}

/** Spec 1 approved with an approved set on a first map, and a holder map's revision r2 of it. */
async function heldByRevision() {
  const first = await deliverableTicketSet(context, project);
  const holder = await clearedMap(context, project);
  const held = holdByRevision(context, {
    specificationId: first.specificationId,
    mapId: holder,
    content: kept("Held"),
    review: "passed",
  });
  return { ...first, holder, held };
}

describe("waits recorded by To Spec", () => {
  test("a wait on a held spec is recorded with the hold seen at recording; zero specs is accepted; the map's first To Spec is not started again", async () => {
    const { specificationId, holder } = await heldByRevision();
    const waiting = await clearedMap(context, project);
    const run = runningMapRun(context, waiting);
    const hold = specHold(context.db, specificationId, waiting);

    const recorded = recordSpecs(context.user, context.db, run.id, {
      specs: [],
      waits: [{ specNumber: 1, note: "Parents too." }],
    });

    expect(recorded.ok).toBe(true);
    expect(hold).toMatchObject({ kind: "revision", mapId: holder, revision: 2 });
    expect(waitsOf(waiting)).toMatchObject([
      {
        specificationId,
        note: "Parents too.",
        hatchMessageId: null,
        holdKind: hold?.kind,
        holdMapId: hold?.mapId,
        holdRevision: hold?.revision,
        releasedAt: null,
        releasedByRun: null,
      },
    ]);
    expect(runOf(run.id).state).toBe("completed");
    expect(
      runsOf(context, waiting).filter(
        (other) => other.purpose === "to_spec" && other.id !== run.id,
      ),
    ).toEqual([]);
    expect(readSpecRevisions(context.db, specificationId)).toHaveLength(2);
  });

  test("a re-clear naming the awaited spec replaces the note, keeping since and the stored hold; one leaving it out keeps the wait", async () => {
    const { specificationId, holder } = await heldByRevision();
    const waiting = await clearedMap(context, project);
    expect(
      recordSpecs(context.user, context.db, runningMapRun(context, waiting).id, {
        specs: [],
        waits: [{ specNumber: 1, note: "Parents too." }],
      }).ok,
    ).toBe(true);
    const [recorded] = waitsOf(waiting);
    if (recorded === undefined) throw new Error("No wait");
    const reclear = reclearing(waiting, 1);

    expect(
      recordSpecs(context.user, context.db, reclear.id, {
        specs: [],
        waits: [{ specNumber: 1, note: "Parents and children." }],
      }).ok,
    ).toBe(true);
    expect(waitsOf(waiting)).toEqual([{ ...recorded, note: "Parents and children." }]);

    const next = reclearing(waiting, 2);
    expect(recordSpecs(context.user, context.db, next.id, { specs: [], waits: [] }).ok).toBe(true);
    expect(waitsOf(waiting)).toEqual([{ ...recorded, note: "Parents and children." }]);
    expect(specHold(context.db, specificationId, waiting)?.mapId).toBe(holder);
  });

  test("a wait naming an unheld spec fails spec_content_invalid, writes nothing, and the retry carries the problem", async () => {
    await deliverableTicketSet(context, project);
    const waiting = await clearedMap(context, project);
    const run = runningMapRun(context, waiting);

    const recorded = recordSpecs(context.user, context.db, run.id, {
      specs: [],
      waits: [{ specNumber: 1, note: "Parents too." }],
    });

    expect(!recorded.ok && recorded.error.code).toBe("spec_content_invalid");
    expect(waitsOf(waiting)).toEqual([]);
    const retry = runningMapRun(context, waiting);
    expect(retry.retryOfRunId).toBe(run.id);
    expect(
      draftSpecsRequest(
        context.db,
        readMap(context.db, waiting),
        retry,
        BASE,
        readMapRounds(context.db, waiting),
      ).refusedAttempt,
    ).not.toBeNull();
  });

  test("a wait naming a spec twice, or a spec the run also revises, fails spec_content_invalid", async () => {
    await heldByRevision();
    const waiting = await clearedMap(context, project);

    const twice = recordSpecs(context.user, context.db, runningMapRun(context, waiting).id, {
      specs: [],
      waits: [
        { specNumber: 1, note: "Parents too." },
        { specNumber: 1, note: "Children too." },
      ],
    });
    const unknown = recordSpecs(context.user, context.db, runningMapRun(context, waiting).id, {
      specs: [],
      waits: [{ specNumber: 7, note: "Parents too." }],
    });

    expect(!twice.ok && twice.error.code).toBe("spec_content_invalid");
    expect(!unknown.ok && unknown.error.code).toBe("spec_content_invalid");
    expect(waitsOf(waiting)).toEqual([]);
  });

  test("a wait closes, released by the run, when its map writes a revision of the spec", async () => {
    const first = await deliverableTicketSet(context, project);
    const holder = await clearedMap(context, project);
    const revising = holdByRevising(context, {
      specificationId: first.specificationId,
      mapId: holder,
      state: "running",
    });
    const waiting = await clearedMap(context, project);
    expect(
      recordSpecs(context.user, context.db, runningMapRun(context, waiting).id, {
        specs: [],
        waits: [{ specNumber: 1, note: "Parents too." }],
      }).ok,
    ).toBe(true);
    complete(revising.id);
    expect(specHold(context.db, first.specificationId, waiting)).toBeNull();
    const reclear = reclearing(waiting, 1);

    expect(
      recordSpecs(context.user, context.db, reclear.id, {
        specs: [{ specNumber: 1, content: kept("Parents") }],
        waits: [],
      }).ok,
    ).toBe(true);

    const [wait] = waitsOf(waiting);
    expect(wait?.releasedByRun).toBe(reclear.id);
    expect(wait?.releasedAt).not.toBeNull();
    expect(readSpecRevisions(context.db, first.specificationId).at(-1)).toMatchObject({
      revision: 2,
      mapId: waiting,
    });
  });

  test("a re-clear of a map whose spec another map holds names only its own drafts and is accepted", async () => {
    const first = await deliverableTicketSet(context, project);
    const later = await clearedMap(context, project);
    expect(
      recordSpecs(context.user, context.db, runningMapRun(context, later).id, {
        specs: [{ specNumber: 1, content: kept("Revised") }],
        waits: [],
      }).ok,
    ).toBe(true);
    const reclear = reclearing(first.mapId, 1);

    const left = recordSpecs(context.user, context.db, reclear.id, { specs: [], waits: [] });

    expect(left.ok).toBe(true);
    expect(
      readSpecRevisions(context.db, first.specificationId).map((revision) => [
        revision.revision,
        revision.mapId,
        revision.approvedAt !== null,
        revision.supersededAt !== null,
      ]),
    ).toEqual([
      [1, first.mapId, true, false],
      [2, later, false, false],
    ]);
  });

  test("the held-spec race: the request saw the spec unheld, the record finds it held and fails; the retry records the wait", async () => {
    const first = await deliverableTicketSet(context, project);
    const holder = await clearedMap(context, project);
    const waiting = await clearedMap(context, project);
    const run = runningMapRun(context, waiting);
    const map = readMap(context.db, waiting);
    expect(
      draftSpecsRequest(context.db, map, run, BASE, readMapRounds(context.db, map.id)).projectSpecs,
    ).toMatchObject([{ latest: { specNumber: 1 }, hold: null }]);
    holdByRevising(context, {
      specificationId: first.specificationId,
      mapId: holder,
      state: "running",
    });

    const raced = recordSpecs(context.user, context.db, run.id, {
      specs: [{ specNumber: 1, content: kept("Parents") }],
      waits: [],
    });

    expect(!raced.ok && raced.error.code).toBe("spec_content_invalid");
    expect(readSpecRevisions(context.db, first.specificationId)).toHaveLength(1);
    const retry = runningMapRun(context, waiting);
    const request = draftSpecsRequest(
      context.db,
      map,
      retry,
      BASE,
      readMapRounds(context.db, map.id),
    );
    expect(request.refusedAttempt).not.toBeNull();
    expect(request.projectSpecs).toMatchObject([{ hold: { kind: "revising", mapId: holder } }]);
    expect(
      recordSpecs(context.user, context.db, retry.id, {
        specs: [],
        waits: [{ specNumber: 1, note: "Parents too." }],
      }).ok,
    ).toBe(true);
    expect(waitsOf(waiting)).toMatchObject([{ holdKind: "revising", holdMapId: holder }]);
  });

  test("a second unapproved revision of a spec fails to insert (the partial unique index)", async () => {
    const { specificationId, held } = await heldByRevision();
    const other = await clearedMap(context, project);
    const writer = runningMapRun(context, other);

    expect(() =>
      insertRevision(context, {
        specificationId,
        revision: held.revision + 1,
        mapId: other,
        writtenByRun: writer.id,
        content: kept("Second draft"),
      }),
    ).toThrow();
  });
});

describe("runs on one spec across maps", () => {
  test("during another map's spec-scoped run, a set rejection starts nothing and does not throw; planNext after that run ends starts the to_tickets", async () => {
    const first = await reviewedTicketSet(context, project);
    const holder = await clearedMap(context, project);
    const revising = holdByRevising(context, {
      specificationId: first.specificationId,
      mapId: holder,
      state: "running",
    });

    const rejected = rejectTicketSet(context.user, context.db, {
      ticketSetId: first.ticketSetId,
      reason: "Split the exporter.",
    });

    expect(rejected.ok).toBe(true);
    expect(runningOnSpecs(first.mapId)).toEqual([]);
    complete(revising.id);
    writeTestData(context, (tx) => {
      planNext(context.user, tx, first.mapId);
    });
    expect(runningOnSpecs(first.mapId)).toEqual(["to_tickets"]);
  });

  test("during another map's spec-scoped run, a rewrite_tickets note is refused spec_in_flight", async () => {
    const first = await reviewedTicketSet(context, project);
    const holder = await clearedMap(context, project);
    holdByRevising(context, {
      specificationId: first.specificationId,
      mapId: holder,
      state: "running",
    });

    const message = note(first.mapId, { kind: "rewrite_tickets" }, "tickets");

    expect(message.refusal).toBe("spec_in_flight");
    expect(runningOnSpecs(first.mapId)).toEqual([]);
  });
});
