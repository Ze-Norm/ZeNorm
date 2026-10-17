import { MapOverviewDetail, ProjectDetail } from "@zenorm/contracts";
import type { MapSpec, Project, SpecRevisionContent, TicketSetContent } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview, listMapOverviews } from "./map-overview.ts";
import { getProjectDetail } from "./spec-views.ts";
import {
  addProject,
  chartedMap,
  clearedMap,
  closeTestContext,
  deliverableTicketSet,
  deliveredSpec,
  holdByRevision,
  holdByTickets,
  insertNextRevision,
  insertReleasedWait,
  insertTouch,
  insertWait,
  newMap,
  openTestContext,
  replacedTicketSet,
  SPEC,
  startedRun,
  TICKETS,
  waypointOf,
} from "./test-support.ts";
import type { DeliveredSpec, TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };

/** A later revision of SPEC: 1.2 reworded and 1.3 added. */
const REVISED: SpecRevisionContent = {
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

/** REVISED, its one clause sourced from waypoint 1 of the map writing it. */
const FROM_WAYPOINT: SpecRevisionContent = {
  ...REVISED,
  clauses: REVISED.clauses.map((clause) => ({
    ...clause,
    sources: [{ kind: "waypoint", number: 1 }],
  })),
};

/** A set on REVISED whose T3 follows up r1's delivered T1. */
const FOLLOW_UP: TicketSetContent = {
  tickets: [
    {
      id: "T3",
      title: "Quote every row",
      build: "Quote the exporter's fields.",
      blockedBy: [],
      criteria: ["1.2", "1.3"],
      testing: ["Quoted rows round-trip."],
      followUp: "T1",
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
    { criterion: "1.2", kind: "work", ticket: "T3", reason: "Quoting changes the exporter." },
    { criterion: "1.3", kind: "work", ticket: "T3", reason: null },
  ],
  slicing: "One follow-up.",
  execution: "The package tests.",
};

let context: TestContext;
let project: Project;
let delivered: DeliveredSpec;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-delivered-spec-views-");
  project = await addProject(context, "repo");
  delivered = await deliveredSpec(context, project);
});

afterEach(async () => {
  await closeTestContext(context);
});

/** The map's overview, checked against the contract (its refines included). */
async function overview(mapId: string): Promise<MapOverviewDetail> {
  const result = await getMapOverview(context.db, mapId, RUNNERS);
  if (!result.ok) throw new Error(result.error.code);
  return MapOverviewDetail.parse(result.value);
}

async function specOn(mapId: string): Promise<MapSpec> {
  const [spec] = (await overview(mapId)).specs;
  if (spec === undefined) throw new Error(`Map ${mapId} shows no spec`);
  return spec;
}

function storedContent(ticketSetId: string): unknown {
  return context.db.$client
    .prepare("SELECT content FROM ticket_set_versions WHERE ticket_set_id = ? ORDER BY version")
    .all(ticketSetId);
}

describe("ticket set views", () => {
  test("a set whose revision is no longer the latest reads replaced; an approved one never does", async () => {
    const replaced = replacedTicketSet(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: REVISED,
      nextContent: { ...REVISED, outOfScope: ["Excel files.", "PDF files."] },
      state: "awaiting_review",
    });
    const sets = (await specOn(delivered.mapId)).ticketSets;
    expect(sets.find((set) => set.id === replaced.ticketSetId)?.replaced).toBe(true);
    expect(sets.find((set) => set.id === delivered.ticketSetId)).toMatchObject({
      state: "approved",
      replaced: false,
    });
  });

  test("followUps name the earlier ticket, revision, run, commit and map; earlier records are unchanged", async () => {
    const before = storedContent(delivered.ticketSetId);
    const next = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: REVISED,
      approved: true,
      set: { state: "awaiting_review", content: FOLLOW_UP },
    });
    const spec = await specOn(delivered.mapId);
    const set = spec.ticketSets.find((candidate) => candidate.id === next.ticketSetId);
    expect(set?.followUps).toEqual({
      T3: {
        ticket: "T1",
        revision: 1,
        run: delivered.run.number,
        commit: delivered.finalCommit,
        mapId: delivered.mapId,
        mapTitle: spec.revisions[0]?.mapTitle,
      },
    });
    expect(set?.readings["1.1"]?.change).toBe("unchanged");
    expect(set?.readings["1.3"]?.change).toBe("new");
    expect(storedContent(delivered.ticketSetId)).toEqual(before);
  });
});

describe("revision views", () => {
  test("delta on every revision past 1, a same-map repair's included; sources walk back across maps", async () => {
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: delivered.mapId,
      content: REVISED,
      approved: true,
      // Approving r2 starts its to_tickets: status reads the latest approved revision.
      set: { state: "approved", content: FOLLOW_UP },
    });
    const other = await chartedMap(context, project);
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: FROM_WAYPOINT,
      review: "running",
    });
    const spec = await specOn(delivered.mapId);
    const [r1, r2, r3] = spec.revisions;
    expect(r1?.delta).toBeNull();
    expect(r2?.delta).toMatchObject({ before: 1, after: 2 });
    expect(r3?.delta).toMatchObject({ before: 2, after: 3 });
    expect(r2?.delta?.criteria["1.3"]?.change).toBe("new");
    // r1's destination source stays credited to the map that wrote r1, not to r3's map.
    expect(r3?.clauseSources.C1).toEqual([
      expect.objectContaining({ kind: "destination", mapId: delivered.mapId }),
      expect.objectContaining({
        kind: "waypoint",
        mapId: other,
        waypointNumber: 1,
        waypointTitle: "Which columns",
        waypointKind: "grilling",
      }),
    ]);
    // The merged run that delivered r1's set; none for the later revisions.
    expect(r1?.deliveredRun).toEqual({
      number: delivered.run.number,
      commit: delivered.finalCommit,
    });
    expect(r2?.deliveredRun).toBeNull();
    // r3, by another map, reads as revised later on this map, with that map's first headline.
    expect(spec.revisedLater).toEqual([
      expect.objectContaining({ revision: 3, state: "draft", mapId: other }),
    ]);
    const [first] = (await overview(other)).status.next;
    expect(spec.revisedLater[0]?.headline).toBe(first?.headline);
  });
});

describe("clause sources", () => {
  test("a clause carried over unchanged credits only the maps that wrote or changed it", async () => {
    const other = await chartedMap(context, project);
    const [c1] = SPEC.clauses;
    if (c1 === undefined) throw new Error("SPEC has no C1");
    // r2, by another map: C1 carried over unchanged, its destination source repeated as agents
    // do; C2 new, from that map's destination.
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: {
        ...SPEC,
        clauses: [
          c1,
          {
            id: "C2",
            title: "Header row",
            text: "The CSV file starts with a header row.",
            criteria: [{ id: "2.1", text: "The header row names every column." }],
            sources: [{ kind: "destination" }],
            reliesOn: [],
            adds: ["new behaviour"],
          },
        ],
      },
      review: "running",
    });
    const [, r2] = (await specOn(delivered.mapId)).revisions;
    expect(r2?.clauseSources.C1).toEqual([
      expect.objectContaining({ kind: "destination", mapId: delivered.mapId }),
    ]);
    expect(r2?.clauseSources.C2).toEqual([
      expect.objectContaining({ kind: "destination", mapId: other }),
    ]);
  });
});

describe("waypoint touches", () => {
  test("a touch names the touched revision's writer map, its delivery, its clause titles and the later revisions", async () => {
    const other = await chartedMap(context, project);
    insertTouch(context, {
      waypointId: waypointOf(context, other, 1).id,
      specificationId: delivered.specificationId,
      revision: 1,
      criteria: ["1.2"],
    });
    const before = (await overview(other)).wayfinding.waypoints[0]?.touches;
    expect(before).toEqual([
      {
        specNumber: 1,
        specTitle: SPEC.title,
        revision: 1,
        writerMapId: delivered.mapId,
        writerMapTitle: "Data export",
        delivered: true,
        laterRevisions: 0,
        criteria: [
          { id: "1.2", text: "Every row is exported.", clauseTitle: "CSV export", delivered: true },
        ],
      },
    ]);
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: FROM_WAYPOINT,
      review: "running",
    });
    const after = (await overview(other)).wayfinding.waypoints[0]?.touches;
    expect(after?.[0]).toMatchObject({ revision: 1, laterRevisions: 1, delivered: true });
  });
});

describe("waits", () => {
  test("an open wait on an uncleared map whose spec nothing holds reads hold null, not released", async () => {
    const uncleared = await newMap(context, project, "Quote the export");
    insertWait(context, {
      mapId: uncleared,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "revision", mapId: delivered.mapId, revision: 1 },
      released: null,
    });
    expect((await overview(uncleared)).waits).toEqual([
      expect.objectContaining({
        specNumber: 1,
        note: "Quote every row.",
        hold: null,
        released: false,
        run: null,
        waypoints: [],
      }),
    ]);
  });

  test("an open wait carries its live hold", async () => {
    const waiting = await clearedMap(context, project);
    const holder = await clearedMap(context, project);
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: holder,
      content: REVISED,
      review: "running",
    });
    insertWait(context, {
      mapId: waiting,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "revision", mapId: holder, revision: 2 },
      released: null,
    });
    const [held] = (await overview(waiting)).waits;
    expect(held?.released).toBe(false);
    expect(held?.hold).toMatchObject({ kind: "revision", mapId: holder, revision: 2 });
  });

  test("a released wait whose map has not written the revision reads released, with its run", async () => {
    const waiting = await clearedMap(context, project);
    insertReleasedWait(context, {
      mapId: waiting,
      specificationId: delivered.specificationId,
      note: "Quote every row.",
      hatchMessageId: null,
      hold: { kind: "delivering", mapId: delivered.mapId, revision: 1 },
      run: "running",
    });
    expect((await overview(waiting)).waits).toEqual([
      expect.objectContaining({ hold: null, released: true, run: "working" }),
    ]);
  });
});

describe("project specs", () => {
  test("a spec with r1 delivered and merged and r2 drafted by another map", async () => {
    const other = await clearedMap(context, project);
    holdByRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: REVISED,
      review: "running",
    });
    const detail = await getProjectDetail(context.db, project.id);
    if (!detail.ok) throw new Error(detail.error.code);
    const [spec] = ProjectDetail.parse(detail.value).specs;
    expect(spec).toMatchObject({
      number: 1,
      revisions: [
        { revision: 1, state: "approved", mapId: delivered.mapId },
        { revision: 2, state: "draft", mapId: other },
      ],
      activeRun: null,
      mergedRun: { number: delivered.run.number, revision: 1 },
    });
  });

  test("a spec with an active run", async () => {
    const other = await addProject(context, "second");
    const set = await deliverableTicketSet(context, other);
    const run = await startedRun(context, set.ticketSetId);
    const detail = await getProjectDetail(context.db, other.id);
    if (!detail.ok) throw new Error(detail.error.code);
    expect(detail.value.specs).toEqual([
      expect.objectContaining({ activeRun: run.number, mergedRun: null }),
    ]);
  });
});

describe("next actions (contract part)", () => {
  test("every action core derives today has onMap null", async () => {
    await newMap(context, project, "Just an idea");
    await chartedMap(context, project);
    await clearedMap(context, project);
    const holder = await clearedMap(context, project);
    holdByTickets(context, {
      specificationId: delivered.specificationId,
      mapId: holder,
      content: REVISED,
      set: null,
      purpose: "to_tickets",
      state: "stopped",
    });
    const actions = (await listMapOverviews(context.db, RUNNERS)).flatMap((map) => map.status.next);
    expect(actions.length).toBeGreaterThan(4);
    expect(actions.every((action) => action.onMap === null)).toBe(true);
    expect(TICKETS.tickets).toHaveLength(2);
  });
});
