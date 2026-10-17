import type { Project } from "@zenorm/contracts";
import { maps, specRevisions } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordResearch } from "./planning-runs.ts";
import { approveSpecRevision } from "./planning.ts";
import { prepareRun } from "./run-work.ts";
import { recordSpecReview, recordSpecs } from "./spec-runs.ts";
import type { RunWork } from "./run-work.ts";
import {
  addProject,
  answerDestination,
  CONFIRMATION,
  chartedMap,
  closeTestContext,
  confirm,
  deliveredSpec,
  draftedSpec,
  grillingRun,
  holdByRevision,
  holdByTickets,
  insertNextRevision,
  insertRun,
  insertTouch,
  insertWait,
  latestRun,
  newMap,
  NO_MAP_CHANGES,
  openTestContext,
  PASSED_REVIEW,
  propose,
  resolvedChain,
  runningMapRun,
  runningSpecRun,
  runsOf,
  SPEC,
  TICKETS,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { DeliveredSpec, TestContext, DraftContent } from "./test-support.ts";

/** A later revision of SPEC: 1.2 reworded and 1.3 added. */
const REVISED: DraftContent = {
  ...SPEC,
  clauses: SPEC.clauses.map((clause) => ({
    ...clause,
    criteria: [
      { id: "1.1", text: "A CSV file downloads." },
      { id: "1.2", text: "Every row is exported, quoted." },
      { id: "1.3", text: "The header row names every column." },
    ],
  })),
};

let context: TestContext;
let project: Project;
let delivered: DeliveredSpec;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-spec-requests-");
  project = await addProject(context, "repo");
  delivered = await deliveredSpec(context, project);
});

afterEach(async () => {
  await closeTestContext(context);
});

async function work(runId: string): Promise<RunWork> {
  const prepared = await prepareRun(context.db, runId);
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.value;
}

function runningOf(mapId: string, purpose: string): string {
  const run = runsOf(context, mapId).find(
    (candidate) => candidate.state === "running" && candidate.purpose === purpose,
  );
  if (run === undefined) throw new Error(`Map ${mapId} has no running ${purpose}`);
  return run.id;
}

/** Waypoint `number` of `mapId` touches spec 1's r1 on criterion 1.2 (T1 delivered it). */
function touch(mapId: string, number: number): void {
  insertTouch(context, {
    waypointId: waypointOf(context, mapId, number).id,
    specificationId: delivered.specificationId,
    revision: 1,
    criteria: ["1.2"],
  });
}

/** The touch a run reads for `touch`: 1.2's r1 text and its baseline ticket, run and commit. */
function runTouch() {
  return {
    specNumber: 1,
    specTitle: SPEC.title,
    revision: 1,
    content: SPEC,
    criteria: [
      {
        id: "1.2",
        text: "Every row is exported.",
        baseline: { ticket: "T1", run: delivered.run.number, commit: delivered.finalCommit },
      },
    ],
  };
}

function mapTitle(mapId: string): string {
  const row = context.db.select({ title: maps.title }).from(maps).where(eq(maps.id, mapId)).get();
  if (row?.title == null) throw new Error(`Map ${mapId} has no title`);
  return row.title;
}

/** SPEC with a second clause, C2. */
const TWO_CLAUSES: DraftContent = {
  ...SPEC,
  clauses: [
    ...SPEC.clauses,
    {
      id: "C2",
      title: "Quoting",
      text: "Fields are quoted.",
      criteria: [{ id: "2.1", text: "A comma inside a field is quoted." }],
      sources: [{ kind: "destination" }],
      reliesOn: [],
      adds: ["new behaviour"],
    },
  ],
};

function wait(mapId: string): void {
  insertWait(context, {
    mapId,
    specificationId: delivered.specificationId,
    note: "Quote every row.",
    hatchMessageId: null,
    hold: { kind: "revision", mapId: delivered.mapId, revision: 1 },
    released: null,
  });
}

describe("D6: each request carries its new fields", () => {
  test("ChartMap: each other spec of the project, its latest revision, delivered, its hold", async () => {
    const charting = await newMap(context, project, "Quote the export");
    const prepared = await work(latestRun(context, charting).id);
    if (prepared.purpose !== "chart") throw new Error(prepared.purpose);
    expect(prepared.request.projectSpecs).toEqual([
      {
        latest: { specNumber: 1, revision: 1, content: SPEC },
        retiredIds: [],
        approved: { specNumber: 1, revision: 1, content: SPEC },
        delivered: true,
        hold: null,
        writerMapId: delivered.mapId,
      },
    ]);
  });

  test("E-3: a release run and a chart read the ids earlier revisions retired", async () => {
    // r2 drops 1.2, so 1.2 is retired: the QA chain's release run reused such an id every retry.
    const dropped: DraftContent = {
      ...SPEC,
      clauses: SPEC.clauses.map((clause) => ({
        ...clause,
        criteria: clause.criteria.filter((criterion) => criterion.id !== "1.2"),
      })),
    };
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: dropped,
      approved: true,
      set: null,
    });
    const charting = await newMap(context, project, "Quote the export");
    const chart = await work(latestRun(context, charting).id);
    if (chart.purpose !== "chart") throw new Error(chart.purpose);
    expect(chart.request.projectSpecs.map((spec) => spec.retiredIds)).toEqual([["1.2"]]);

    const waiting = await resolvedChain(context, project);
    const release = insertRun(context, {
      mapId: waiting,
      specificationId: delivered.specificationId,
      purpose: "to_spec",
      state: "running",
    });
    insertWait(context, {
      mapId: waiting,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "revision", mapId: delivered.mapId, revision: 2 },
      released: { runId: release.id },
    });
    const prepared = await work(release.id);
    if (prepared.purpose !== "to_spec" || !("latest" in prepared.request)) {
      throw new Error("expected a spec-scoped to_spec");
    }
    expect(prepared.request.feedback.kind).toBe("wait");
    expect(prepared.request.latest.revision).toBe(2);
    expect(prepared.request.retiredIds).toEqual(["1.2"]);
  });

  test("GrillWaypoint: the waypoint's touches with the touched criteria and their baseline", async () => {
    const charted = await chartedMap(context, project);
    touch(charted, 1);
    const prepared = await work(grillingRun(context, charted, 1).id);
    if (prepared.purpose !== "grilling") throw new Error(prepared.purpose);
    expect(prepared.request.waypoint.touches).toEqual([runTouch()]);
  });

  test("ResearchWaypoint: the waypoint's touches with the touched criteria and their baseline", async () => {
    const mapId = await newMap(context, project, "Quote the export");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, {
      ...CONFIRMATION,
      waypoints: [
        {
          kind: "research",
          title: "Quoting rules",
          question: "How does RFC 4180 quote a field?",
          blockedBy: [],
          touches: [],
        },
      ],
    });
    touch(mapId, 1);
    const prepared = await work(grillingRun(context, mapId, 1).id);
    if (prepared.purpose !== "research") throw new Error(prepared.purpose);
    expect(prepared.request.waypoint.touches).toEqual([runTouch()]);
  });

  test("DraftSpecs: projectSpecs, the resolved waypoints' touches and the map's open waits", async () => {
    const chain = await resolvedChain(context, project);
    touch(chain, 1);
    wait(chain);
    const prepared = await work(runningOf(chain, "to_spec"));
    if (prepared.purpose !== "to_spec" || !("specs" in prepared.request)) {
      throw new Error("expected a map-scope to_spec");
    }
    expect(prepared.request.projectSpecs).toEqual([
      {
        latest: { specNumber: 1, revision: 1, content: SPEC },
        retiredIds: [],
        approved: { specNumber: 1, revision: 1, content: SPEC },
        delivered: true,
        hold: null,
        writerMapId: delivered.mapId,
      },
    ]);
    expect(prepared.request.waits).toEqual([{ specNumber: 1, note: "Quote every row." }]);
    expect(prepared.request.waypoints.map((waypoint) => waypoint.touches)).toEqual([
      [runTouch()],
      [],
      [],
    ]);
  });

  test("ReviseSpec: projectSpecs, the resolved waypoints' touches and the map's open waits", async () => {
    const chain = await resolvedChain(context, project);
    touch(chain, 1);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    const draft = holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: REVISED,
      review: "passed",
    });
    writeTestData(context, (tx) =>
      tx
        .update(specRevisions)
        .set({ rejectionReason: "Quote the header too.", supersededAt: new Date().toISOString() })
        .where(eq(specRevisions.id, draft.specRevisionId))
        .run(),
    );
    const other = await chartedMap(context, project);
    wait(other);
    const revising = insertRun(context, {
      mapId: chain,
      specificationId: delivered.specificationId,
      purpose: "to_spec",
      state: "running",
    });
    const prepared = await work(revising.id);
    if (prepared.purpose !== "to_spec" || !("latest" in prepared.request)) {
      throw new Error("expected a spec-scoped to_spec");
    }
    // The map wrote spec 1, so it is in `latest`, not `projectSpecs` (deviation 7).
    expect(prepared.request.projectSpecs).toEqual([]);
    expect(prepared.request.latest.revision).toBe(2);
    expect(prepared.request.waits).toEqual([]);
    expect(prepared.request.waypoints[0]?.touches).toEqual([runTouch()]);
  });

  test("ReviewSpec: before's delivery, the resolved waypoints' touches and the map's open waits", async () => {
    const chain = await resolvedChain(context, project);
    touch(chain, 1);
    wait(chain);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: REVISED,
      review: "running",
    });
    const prepared = await work(runningOf(chain, "spec_review"));
    if (prepared.purpose !== "spec_review") throw new Error(prepared.purpose);
    expect(prepared.request.before).toEqual({
      specNumber: 1,
      revision: 1,
      content: SPEC,
      delivery: { run: delivered.run.number, commit: delivered.finalCommit },
    });
    expect(prepared.request.waits).toEqual([{ specNumber: 1, note: "Quote every row." }]);
    expect(prepared.request.waypoints[0]?.touches).toEqual([runTouch()]);
    // r2 changes C1 since r1, which the delivering map wrote (L213 D-6).
    expect(prepared.request.changes).toEqual({
      since: 1,
      writer: { kind: "another-map", mapTitle: mapTitle(delivered.mapId) },
      changedClauses: ["C1"],
      unchangedClauses: [],
    });
  });

  test("DraftTicketSet: first ticket number, delta, readings, touching waypoints, earlier tickets", async () => {
    const chain = await resolvedChain(context, project);
    touch(chain, 1);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    const held = holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: REVISED,
      set: null,
      purpose: "to_tickets",
      state: "running",
    });
    const prepared = await work(held.run.id);
    if (prepared.purpose !== "to_tickets") throw new Error(prepared.purpose);
    const request = prepared.request;
    expect(request.approved.revision).toBe(2);
    expect(request.firstTicketNumber).toBe(TICKETS.tickets.length + 1);
    expect(request.delta).toMatchObject({ before: 1, after: 2 });
    expect(request.takenOut).toEqual([]);
    expect(Object.keys(request.readings).sort()).toEqual(["1.1", "1.2", "1.3"]);
    expect(request.touchingWaypoints).toEqual([
      { number: 1, title: CONFIRMATION.waypoints[0]?.title, resolution: "Resolved 1." },
    ]);
    expect(request.earlierTickets).toEqual(
      TICKETS.tickets.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        criteria: ticket.criteria,
        revision: 1,
        delivered: { run: delivered.run.number, commit: delivered.finalCommit },
      })),
    );
  });

  test("DraftTicketSet: a new spec's first set reads the map's destination, Out of scope and research", async () => {
    const mapId = await newMap(context, project, "Quote the export");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, {
      ...CONFIRMATION,
      waypoints: [
        {
          kind: "research",
          title: "Quoting rules",
          question: "How does RFC 4180 quote a field?",
          blockedBy: [],
          touches: [],
        },
      ],
      outOfScope: ["Excel workbooks."],
    });
    const researched = recordResearch(context.user, context.db, grillingRun(context, mapId, 1).id, {
      report: {
        answered: true,
        summary: "A field with a comma or quote is quoted, its quotes doubled.",
        gap: null,
        gist: "Quote and double quotes",
        findings: [
          { title: "Doubling", detail: "A quote inside a field is doubled.", sources: [1] },
        ],
        sources: [
          {
            kind: "external",
            title: "RFC 4180",
            url: "https://www.rfc-editor.org/rfc/rfc4180",
            excerpt: "fields containing double quotes must be enclosed",
          },
        ],
        limitations: [],
        uncertainties: [],
      },
      outOfScope: null,
      mapChanges: NO_MAP_CHANGES,
    });
    if (!researched.ok) throw new Error(researched.error.code);
    const drafted = recordSpecs(context.user, context.db, runningMapRun(context, mapId).id, {
      specs: [{ specNumber: null, content: SPEC }],
      waits: [],
    });
    if (!drafted.ok) throw new Error(drafted.error.code);
    const reviewed = recordSpecReview(
      context.user,
      context.db,
      runningSpecRun(context, mapId, "spec_review").id,
      {
        summary: PASSED_REVIEW.summary,
        findings: [],
        verified: [],
      },
    );
    if (!reviewed.ok) throw new Error(reviewed.error.code);
    const revision = context.db
      .select({ id: specRevisions.id })
      .from(specRevisions)
      .where(eq(specRevisions.mapId, mapId))
      .get();
    if (revision === undefined) throw new Error(`Map ${mapId} has no revision`);
    const approved = approveSpecRevision(context.user, context.db, { specRevisionId: revision.id });
    if (!approved.ok) throw new Error(approved.error.code);

    const prepared = await work(runningSpecRun(context, mapId, "to_tickets").id);
    if (prepared.purpose !== "to_tickets") throw new Error(prepared.purpose);
    const request = prepared.request;
    expect(request.delta).toBeNull();
    expect(request.destination).toBe(CONFIRMATION.destination);
    expect(request.outOfScope).toEqual(["Excel workbooks."]);
    // No waypoint touches the new spec, yet the writer reads the research behind its resolution.
    expect(request.touchingWaypoints).toEqual([]);
    expect(request.waypoints).toEqual([
      expect.objectContaining({
        number: 1,
        kind: "research",
        resolution: "A field with a comma or quote is quoted, its quotes doubled.",
        research: {
          findings: [{ title: "Doubling", detail: "A quote inside a field is doubled." }],
          sources: [{ title: "RFC 4180", url: "https://www.rfc-editor.org/rfc/rfc4180" }],
        },
      }),
    ]);
  });

  test("ReviewTicketSet: delta, readings and the touching waypoints", async () => {
    const chain = await resolvedChain(context, project);
    touch(chain, 1);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    const held = holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: REVISED,
      set: {
        ...TICKETS,
        tickets: TICKETS.tickets
          .filter((ticket) => ticket.id === "T1")
          .map((ticket) => ({ ...ticket, id: "T3", criteria: ["1.2", "1.3"], followUp: "T1" })),
        dispositions: [
          { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
          { criterion: "1.2", kind: "work", ticket: "T3", reason: "Quoting changes it." },
          { criterion: "1.3", kind: "work", ticket: "T3", reason: null },
        ],
      },
      purpose: "tickets_review",
      state: "running",
    });
    const prepared = await work(held.run.id);
    if (prepared.purpose !== "tickets_review") throw new Error(prepared.purpose);
    const request = prepared.request;
    expect(request.approved.revision).toBe(2);
    expect(request.delta).toMatchObject({ before: 1, after: 2 });
    expect(request.readings["1.1"]).toMatchObject({ change: "unchanged" });
    expect(request.readings["1.3"]).toMatchObject({ change: "new" });
    expect(request.touchingWaypoints.map((waypoint) => waypoint.number)).toEqual([1]);
  });
});

describe("S8b-8: ticket-set requests read the map's latest approved revision", () => {
  test.each(["to_tickets", "tickets_review"] as const)(
    "%s on a map with two approved revisions reads the second",
    async (purpose) => {
      const held = holdByTickets(context, {
        specificationId: delivered.specificationId,
        mapId: delivered.mapId,
        content: REVISED,
        set: purpose === "tickets_review" ? TICKETS : null,
        purpose,
        state: "running",
      });
      const prepared = await work(held.run.id);
      if (prepared.purpose !== "to_tickets" && prepared.purpose !== "tickets_review") {
        throw new Error(prepared.purpose);
      }
      expect(prepared.request.approved).toMatchObject({ specNumber: 1, revision: 2 });
    },
  );
});

describe("L213: the mid-QA fixes at the request seam", () => {
  test("D-6: ReviewSpec's changes run from the latest approved revision through every revision between", async () => {
    const chain = await resolvedChain(context, project);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    // r2 adds C2 and is rejected; r3 words r2 again, so r2 → r3 alone changes nothing.
    const r2 = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: TWO_CLAUSES,
      approved: false,
      set: null,
    });
    writeTestData(context, (tx) =>
      tx
        .update(specRevisions)
        .set({ rejectionReason: "Quote more.", supersededAt: new Date().toISOString() })
        .where(eq(specRevisions.id, r2.specRevisionId))
        .run(),
    );
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: TWO_CLAUSES,
      review: "running",
    });
    const prepared = await work(runningOf(chain, "spec_review"));
    if (prepared.purpose !== "spec_review") throw new Error(prepared.purpose);
    expect(prepared.request.revision.revision).toBe(3);
    expect(prepared.request.changes).toEqual({
      since: 1,
      writer: { kind: "another-map", mapTitle: mapTitle(delivered.mapId) },
      changedClauses: ["C2"],
      unchangedClauses: ["C1"],
    });
  });

  test("D-6: a spec's first chain, with no approved revision, has no changes", async () => {
    const prepared = await work(
      runningOf((await draftedSpec(context, project)).mapId, "spec_review"),
    );
    if (prepared.purpose !== "spec_review") throw new Error(prepared.purpose);
    expect(prepared.request.changes).toBeNull();
  });

  test("D-6: a revision after this map's own approved revision names this map", async () => {
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: REVISED,
      review: "running",
    });
    const prepared = await work(runningOf(delivered.mapId, "spec_review"));
    if (prepared.purpose !== "spec_review") throw new Error(prepared.purpose);
    expect(prepared.request.changes).toMatchObject({ since: 1, writer: { kind: "this-map" } });
  });

  test("D-2: earlier tickets list only approved sets' tickets, never a replaced set's", async () => {
    const chain = await resolvedChain(context, project);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    // r2's set was written and never approved; r3 replaced it.
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: REVISED,
      approved: true,
      set: {
        state: "review_passed",
        content: {
          ...TICKETS,
          tickets: TICKETS.tickets.map((ticket) => ({ ...ticket, id: "T3" })).slice(0, 1),
        },
      },
    });
    const held = holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: REVISED,
      set: null,
      purpose: "to_tickets",
      state: "running",
    });
    const prepared = await work(held.run.id);
    if (prepared.purpose !== "to_tickets") throw new Error(prepared.purpose);
    expect(prepared.request.firstTicketNumber).toBe(3);
    expect(prepared.request.earlierTickets.map((ticket) => [ticket.id, ticket.revision])).toEqual(
      TICKETS.tickets.map((ticket) => [ticket.id, 1]),
    );
  });

  test("D-1: takenOut lists a delivered criterion a never-approved middle revision dropped", async () => {
    const chain = await resolvedChain(context, project);
    insertRun(context, {
      mapId: chain,
      specificationId: null,
      purpose: "to_spec",
      state: "completed",
    });
    const without12: DraftContent = {
      ...SPEC,
      clauses: SPEC.clauses.map((clause) => ({
        ...clause,
        criteria: clause.criteria.filter((criterion) => criterion.id !== "1.2"),
      })),
    };
    const r2 = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: without12,
      approved: false,
      set: null,
    });
    writeTestData(context, (tx) =>
      tx
        .update(specRevisions)
        .set({ rejectionReason: "Keep it short.", supersededAt: new Date().toISOString() })
        .where(eq(specRevisions.id, r2.specRevisionId))
        .run(),
    );
    const held = holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: chain,
      content: without12,
      set: null,
      purpose: "to_tickets",
      state: "running",
    });
    const prepared = await work(held.run.id);
    if (prepared.purpose !== "to_tickets") throw new Error(prepared.purpose);
    expect(prepared.request.delta?.removedCriteria).toEqual([]);
    expect(prepared.request.takenOut.map((entry) => entry.criterion.id)).toEqual(["1.2"]);
  });

  test("D-5: ChartMap reads a held spec's latest approved revision beside its draft", async () => {
    const holder = await chartedMap(context, project);
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: holder,
      content: REVISED,
      review: "running",
    });
    const charting = await newMap(context, project, "Quote the export");
    const prepared = await work(latestRun(context, charting).id);
    if (prepared.purpose !== "chart") throw new Error(prepared.purpose);
    expect(prepared.request.projectSpecs).toMatchObject([
      {
        latest: { specNumber: 1, revision: 2, content: REVISED },
        approved: { specNumber: 1, revision: 1, content: SPEC },
        hold: { kind: "revision", revision: 2 },
      },
    ]);
  });

  test("D-7: a task waypoint's request carries its touches with the touched revision's text", async () => {
    const mapId = await newMap(context, project, "Quote the export");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, {
      ...CONFIRMATION,
      waypoints: [
        {
          kind: "task",
          title: "List the export's columns",
          question: "Which columns does the export write?",
          blockedBy: [],
          touches: [],
        },
      ],
    });
    touch(mapId, 1);
    const prepared = await work(grillingRun(context, mapId, 1).id);
    if (prepared.purpose !== "task") throw new Error(prepared.purpose);
    expect(prepared.request.waypoint.touches).toEqual([runTouch()]);
    expect(prepared.request.waypoint.touches[0]?.content).toEqual(SPEC);
  });
});
