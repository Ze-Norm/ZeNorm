import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { ok } from "@zenorm/contracts";
import type { Project, ProposedMap } from "@zenorm/contracts";
import {
  deliveryRunEvents,
  deliveryRuns,
  deliveryRunTickets,
  maps,
  specifications,
  specRevisions,
  specWaits,
  ticketSets,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanUpDeletedRuns } from "./delivery-cleanup.ts";
import { getMap } from "./map.ts";
import { deleteMap } from "./map-delete.ts";
import { confirmProposal } from "./map-proposals.ts";
import { getMapOverview } from "./map-overview.ts";
import { failRun, recordChart } from "./planning-runs.ts";
import { readRounds, readWaypoints } from "./planning-runs.ts";
import {
  addProject,
  closeTestContext,
  deliveredSpec,
  draftedSpec,
  holdByRevising,
  insertMessage,
  insertWait,
  newMap,
  passedDelivery,
  openTestContext,
  PROPOSAL,
  resolvedChain,
  reviewedTicketSet,
  runningMapRun,
  runsOf,
  UNKNOWN_ID,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { write } from "./writes.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-map-delete-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

const FAILURE = { code: "agent_run_failed", message: "The run failed." } as const;

/** Fails the map's running map-level run and then its retry: nothing is left running. */
function stopMap(mapId: string): void {
  failRun(context.user, context.db, runningMapRun(context, mapId).id, FAILURE);
  failRun(context.user, context.db, runningMapRun(context, mapId).id, FAILURE);
}

/**
 * A map with a full Wayfinding record and nothing in flight: three resolved waypoints in a chain
 * (an answered round on the first), the code survey, a clean consistency pass, a replied hatch
 * message and a queued one, and its To Spec stopped before it wrote a revision.
 */
async function recordedMap(): Promise<string> {
  const mapId = await resolvedChain(context, project);
  insertMessage(context, mapId, {
    state: "replied",
    stage: "wayfinding",
    specificationId: null,
    text: "Does it cover every depth?",
  });
  stopMap(mapId);
  // Queued after the stop, so no write since has started its hatch run.
  insertMessage(context, mapId, {
    state: "queued",
    stage: "idea",
    specificationId: null,
    text: "And the archive?",
  });
  return mapId;
}

/** The last change feed `seq`; every test has written before it reads it. */
function lastSeq(): number {
  const seq: unknown = context.db.$client.prepare("SELECT max(seq) FROM change_feed").pluck().get();
  if (typeof seq !== "number") throw new Error("The change feed is empty");
  return seq;
}

/** Whether `project`'s repository has the local branch. */
function hasBranch(branch: string): boolean {
  const listed = execFileSync("git", ["branch", "--list", branch], {
    cwd: project.folderPath,
    encoding: "utf8",
  });
  return listed.trim() !== "";
}

/** Records the run's pull request in `state`, as Check now would. */
function setPullRequest(runId: string, state: "open" | "closed" | "merged"): void {
  write(context.db, context.user, (tx) =>
    tx
      .update(deliveryRuns)
      .set({ prNumber: 10, prUrl: "https://github.com/o/r/pull/10", prState: state })
      .where(eq(deliveryRuns.id, runId))
      .run(),
  );
}

/** A change feed row, as the triggers store it. */
interface FeedRow {
  readonly op: string;
  readonly project_id: string;
  readonly actor_kind: string;
  readonly entity_type: string;
  readonly entity_id: string;
}

/** The change feed's rows on `mapId` after `seq`, in order. */
function feedAfter(mapId: string, seq: number): FeedRow[] {
  return context.db.$client
    .prepare<[string, number], FeedRow>(
      "SELECT op, project_id, actor_kind, entity_type, entity_id FROM change_feed WHERE map_id = ? AND seq > ? ORDER BY seq",
    )
    .all(mapId, seq);
}

/** Every table but the change feed, with its column names. */
function tables(): { name: string; columns: string[] }[] {
  const client = context.db.$client;
  return client
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'change_feed'`,
    )
    .all()
    .map(({ name }) => ({
      name,
      columns: client
        .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${name}')`)
        .all()
        .map((column) => column.name),
    }));
}

/** Each `table.column` holding one of `ids`. */
function rowsNaming(ids: readonly string[]): string[] {
  const client = context.db.$client;
  const found: string[] = [];
  for (const { name, columns } of tables()) {
    for (const column of columns) {
      const placeholders = ids.map(() => "?").join(", ");
      const row = client
        .prepare(`SELECT 1 FROM "${name}" WHERE "${column}" IN (${placeholders}) LIMIT 1`)
        .get(...ids);
      if (row !== undefined) found.push(`${name}.${column}`);
    }
  }
  return found;
}

/** The ids of the map and of every run, waypoint and round on it. */
function idsOn(mapId: string): string[] {
  return [
    mapId,
    ...runsOf(context, mapId).map((run) => run.id),
    ...readWaypoints(context.db, mapId).map((waypoint) => waypoint.id),
    ...readRounds(context.db, mapId).map((round) => round.id),
  ];
}

describe("map.delete", () => {
  test("deletes the map and every row recorded on it, leaving the project's other maps as they were", async () => {
    const kept = await recordedMap();
    const mapId = await recordedMap();
    const ids = idsOn(mapId);
    expect(ids.length).toBeGreaterThan(10);
    expect(rowsNaming(ids)).not.toEqual([]);
    const keptIds = idsOn(kept);
    const keptOverview = await getMapOverview(context.db, kept, { deliveryHeld: () => false });
    const before = lastSeq();

    const deleted = deleteMap(context.user, context.db, { mapId, deleteSpecs: [] });

    expect(deleted).toEqual({
      ok: true,
      value: {
        map: { mapId, projectId: project.id },
        runs: [],
        project: { id: project.id, folderPath: project.folderPath },
      },
    });
    expect(rowsNaming(ids)).toEqual([]);
    const gone = await getMap(context.db, mapId);
    expect(gone.ok ? null : gone.error.code).toBe("map_not_found");
    expect(idsOn(kept)).toEqual(keptIds);
    expect(await getMapOverview(context.db, kept, { deliveryHeld: () => false })).toEqual(
      keptOverview,
    );
    expect(context.db.$client.pragma("foreign_key_check")).toEqual([]);

    // One feed row per deleted row, each by the person, the map's last.
    const feed = feedAfter(mapId, before);
    expect(feed.length).toBeGreaterThan(10);
    expect(feed.every((row) => row.op === "delete" && row.project_id === project.id)).toBe(true);
    expect(feed.every((row) => row.actor_kind === "user")).toBe(true);
    expect(feed.at(-1)).toMatchObject({ entity_type: "maps", entity_id: mapId });
  });

  test("deletes a map whose first chart stopped before it named the map", async () => {
    const mapId = await newMap(context, project, "Export data");
    stopMap(mapId);

    expect(deleteMap(context.user, context.db, { mapId, deleteSpecs: [] }).ok).toBe(true);
    expect(context.db.select().from(maps).all()).toEqual([]);
  });

  test("refuses an unknown map, writing nothing", () => {
    const before = lastSeq();
    const refused = deleteMap(context.user, context.db, { mapId: UNKNOWN_ID, deleteSpecs: [] });
    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_not_found",
      data: { mapId: UNKNOWN_ID },
    });
    expect(lastSeq()).toBe(before);
  });

  test("refuses a map that wrote a spec revision, naming its specs, writing nothing", async () => {
    const { mapId } = await draftedSpec(context, project);
    const ids = idsOn(mapId);
    const before = lastSeq();

    const refused = deleteMap(context.user, context.db, { mapId, deleteSpecs: [] });

    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_wrote_spec",
      data: { mapId, specs: [1] },
    });
    expect(lastSeq()).toBe(before);
    expect(idsOn(mapId)).toEqual(ids);
  });

  test("with deleteSpecs, deletes the map with the specs it wrote and their ticket sets", async () => {
    const kept = await recordedMap();
    const keptIds = idsOn(kept);
    const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project);
    const ids = idsOn(mapId);

    const deleted = deleteMap(context.user, context.db, { mapId, deleteSpecs: [1] });

    expect(deleted.ok ? deleted.value.map : null).toEqual({ mapId, projectId: project.id });
    expect(rowsNaming([...ids, specificationId, ticketSetId])).toEqual([]);
    expect(context.db.select().from(specifications).all()).toEqual([]);
    expect(context.db.select().from(specRevisions).all()).toEqual([]);
    expect(context.db.select().from(ticketSets).all()).toEqual([]);
    expect(idsOn(kept)).toEqual(keptIds);
    expect(context.db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  test("with deleteSpecs, refuses a spec another map worked on, naming that map, writing nothing", async () => {
    const { mapId, specificationId } = await draftedSpec(context, project);
    const reviser = await newMap(context, project, "Revise the export");
    stopMap(reviser);
    holdByRevising(context, { specificationId, mapId: reviser, state: "stopped" });
    const before = lastSeq();

    const refused = deleteMap(context.user, context.db, { mapId, deleteSpecs: [1] });

    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_spec_shared",
      data: { mapId, spec: 1, otherMapId: reviser },
    });
    expect(lastSeq()).toBe(before);
  });

  test("with deleteSpecs, leaves another map's link to a deleted spec's page as its text", async () => {
    const { mapId } = await reviewedTicketSet(context, project);
    const linker = await newMap(context, project, "Import data");
    const elsewhere = "[an export](/maps/01a13d02-d725-769e-92a6-124d1186b863/spec/2)";
    write(context.db, context.user, (tx) =>
      tx
        .update(maps)
        .set({
          summary: `Like [the export](/maps/${mapId}/spec/1) and ${elsewhere}.`,
          destination: `Imports what [the export](/maps/${mapId}/spec/1) writes.`,
        })
        .where(eq(maps.id, linker))
        .run(),
    );

    const deleted = deleteMap(context.user, context.db, { mapId, deleteSpecs: [1] });

    expect(deleted.ok ? null : deleted.error).toBeNull();
    const kept = context.db
      .select({ summary: maps.summary, destination: maps.destination })
      .from(maps)
      .where(eq(maps.id, linker))
      .get();
    expect(kept).toEqual({
      summary: `Like the export (deleted) and ${elsewhere}.`,
      destination: "Imports what the export (deleted) writes.",
    });
  });

  test("refuses deleteSpecs that are not exactly the specs the map wrote, naming them, writing nothing", async () => {
    const { mapId } = await draftedSpec(context, project);
    const before = lastSeq();

    const refused = deleteMap(context.user, context.db, { mapId, deleteSpecs: [2] });

    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_wrote_spec",
      data: { mapId, specs: [1] },
    });
    expect(lastSeq()).toBe(before);
  });

  test("with deleteSpecs, refuses a spec with a merged delivery run, naming the run, writing nothing", async () => {
    const delivered = await deliveredSpec(context, project);
    const before = lastSeq();

    const refused = deleteMap(context.user, context.db, {
      mapId: delivered.mapId,
      deleteSpecs: [1],
    });

    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_spec_delivered",
      data: { mapId: delivered.mapId, spec: 1, runId: delivered.run.id, reason: "merged" },
    });
    expect(lastSeq()).toBe(before);
  });

  test("with deleteSpecs, refuses a spec whose delivery run's pull request is open or merged, writing nothing", async () => {
    const delivered = await passedDelivery(context, project);
    for (const [state, reason] of [
      ["open", "pr_open"],
      ["merged", "merged"],
    ] as const) {
      setPullRequest(delivered.run.id, state);
      const before = lastSeq();

      const refused = deleteMap(context.user, context.db, {
        mapId: delivered.mapId,
        deleteSpecs: [1],
      });

      expect(refused.ok ? null : refused.error).toMatchObject({
        code: "map_spec_delivered",
        data: { mapId: delivered.mapId, spec: 1, runId: delivered.run.id, reason },
      });
      expect(lastSeq()).toBe(before);
    }
  });

  test("with deleteSpecs, deletes a spec's unmerged run whose pull request was closed, and its branch and worktree after", async () => {
    const delivered = await passedDelivery(context, project);
    setPullRequest(delivered.run.id, "closed");
    expect(hasBranch(delivered.run.branch)).toBe(true);
    expect(existsSync(delivered.run.worktreePath)).toBe(true);

    const deleted = deleteMap(context.user, context.db, {
      mapId: delivered.mapId,
      deleteSpecs: [1],
    });

    if (!deleted.ok) throw new Error(deleted.error.code);
    expect(deleted.value.runs).toEqual([
      {
        id: delivered.run.id,
        branch: delivered.run.branch,
        worktreePath: delivered.run.worktreePath,
        ticketBranches: [`${delivered.run.branch}-t1`, `${delivered.run.branch}-t2`],
      },
    ]);
    expect(context.db.select().from(deliveryRuns).all()).toEqual([]);
    expect(context.db.select().from(deliveryRunTickets).all()).toEqual([]);
    expect(context.db.select().from(deliveryRunEvents).all()).toEqual([]);
    expect(context.db.select().from(specifications).all()).toEqual([]);
    expect(context.db.$client.pragma("foreign_key_check")).toEqual([]);

    const failures = await cleanUpDeletedRuns(deleted.value.runs, ok(project.folderPath));

    expect(failures).toEqual([]);
    expect(hasBranch(delivered.run.branch)).toBe(false);
    expect(existsSync(delivered.run.worktreePath)).toBe(false);
  });

  test("refuses a map with a planning run in flight, naming the run, writing nothing", async () => {
    const mapId = await newMap(context, project, "Export data");
    const chart = runningMapRun(context, mapId);
    const before = lastSeq();

    const refused = deleteMap(context.user, context.db, { mapId, deleteSpecs: [] });

    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_run_in_flight",
      data: { mapId, runId: chart.id },
    });
    expect(lastSeq()).toBe(before);
  });

  test("refuses both maps of a confirmed split, naming the other, writing nothing", async () => {
    const IMPORTS: ProposedMap = {
      title: "CSV imports",
      idea: "Import records from a CSV file.",
      line: "Imports are their own map.",
    };
    const parent = await newMap(context, project, "Export and import data");
    const proposed = recordChart(context.user, context.db, runningMapRun(context, parent).id, {
      kind: "proposal",
      proposal: { ...PROPOSAL, split: [IMPORTS] },
    });
    if (!proposed.ok) throw new Error(proposed.error.code);
    const [offer] = context.db.$client
      .prepare<[], { id: string }>(`SELECT id FROM map_proposals`)
      .all();
    if (offer === undefined) throw new Error("No split offer");
    const confirmed = await confirmProposal(context.user, context.db, {
      proposalId: offer.id,
      idea: IMPORTS.idea,
    });
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const child = confirmed.value.map.id;
    stopMap(child);
    const before = lastSeq();

    const refusedParent = deleteMap(context.user, context.db, {
      mapId: parent,
      deleteSpecs: [],
    });
    const refusedChild = deleteMap(context.user, context.db, { mapId: child, deleteSpecs: [] });

    expect(refusedParent.ok ? null : refusedParent.error).toMatchObject({
      code: "map_split_linked",
      data: { mapId: parent, linkedMapId: child },
    });
    expect(refusedChild.ok ? null : refusedChild.error).toMatchObject({
      code: "map_split_linked",
      data: { mapId: child, linkedMapId: parent },
    });
    expect(lastSeq()).toBe(before);
  });

  test("refuses a map another map's wait names as holding its spec, writing nothing", async () => {
    const delivered = await deliveredSpec(context, project);
    const reviser = await newMap(context, project, "Revise the export");
    stopMap(reviser);
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: reviser,
      state: "stopped",
    });
    const waiter = await newMap(context, project, "Change the export");
    stopMap(waiter);
    insertWait(context, {
      mapId: waiter,
      specificationId: delivered.specificationId,
      note: "Add a column.",
      hatchMessageId: null,
      hold: { kind: "revising", mapId: reviser, revision: 1 },
      released: null,
    });
    const before = lastSeq();

    const refused = deleteMap(context.user, context.db, { mapId: reviser, deleteSpecs: [] });

    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "map_waited_on",
      data: { mapId: reviser, waitingMapId: waiter },
    });
    expect(lastSeq()).toBe(before);
  });

  test("ends the map's hold: a wait it held back is released, and its run starts", async () => {
    const delivered = await deliveredSpec(context, project);
    const reviser = await newMap(context, project, "Revise the export");
    stopMap(reviser);
    holdByRevising(context, {
      specificationId: delivered.specificationId,
      mapId: reviser,
      state: "stopped",
    });
    // A cleared map's wait, recorded against the delivering map; the reviser's stopped run holds
    // the spec since.
    const waiter = await resolvedChain(context, project);
    stopMap(waiter);
    const waitId = insertWait(context, {
      mapId: waiter,
      specificationId: delivered.specificationId,
      note: "Add a column.",
      hatchMessageId: null,
      hold: { kind: "delivering", mapId: delivered.mapId, revision: 1 },
      released: null,
    });

    expect(deleteMap(context.user, context.db, { mapId: reviser, deleteSpecs: [] }).ok).toBe(true);

    const wait = context.db.select().from(specWaits).where(eq(specWaits.id, waitId)).get();
    expect(wait?.releasedByRun).not.toBeNull();
    expect(runsOf(context, waiter).find((run) => run.id === wait?.releasedByRun)).toMatchObject({
      purpose: "to_spec",
      state: "running",
      specificationId: delivered.specificationId,
    });
  });
});
