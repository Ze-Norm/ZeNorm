import { MAP_IDEA_MAX_LENGTH, MAP_LINE_MAX_LENGTH, MapIdea, MapLine } from "@zenorm/contracts";
import type {
  MapChanges,
  MapProposalKind,
  PlanningRun,
  Waypoint,
  WaypointStatus,
} from "@zenorm/contracts";
import { mapExclusions, mapFog, mapProposals, maps, waypointBlockers, waypoints } from "@zenorm/db";
import { and, eq, max } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Reader, RunFailure, Tx } from "./planning-runs.ts";
import { readFog } from "./wayfinding-records.ts";

/**
 * The fog check of a confirming chart: a chart leaving no waypoint while fog remains is
 * refused `fog_left_unsettled`. `statuses` are every waypoint's status and `fogCount` the number
 * of fog items as the write would leave them; null when the write may go ahead.
 */
export function fogLeftUnsettled(
  statuses: readonly WaypointStatus[],
  fogCount: number,
): RunFailure | null {
  if (fogCount === 0 || statuses.some((status) => status === "open" || status === "claimed")) {
    return null;
  }
  return {
    code: "fog_left_unsettled",
    message: `The output leaves ${String(fogCount)} fog items with no waypoint open or claimed to settle them`,
  };
}

/** The map's next Out of scope line position: one past its highest (lines are never deleted). */
function nextExclusionPosition(tx: Tx, mapId: string): number {
  const row = tx
    .select({ highest: max(mapExclusions.position) })
    .from(mapExclusions)
    .where(eq(mapExclusions.mapId, mapId))
    .get();
  if (row === undefined) {
    throw new Error("An aggregate query returned no row");
  }
  return row.highest === null ? 1 : row.highest + 1;
}

/**
 * Saves one Out of scope line: the map's, or `waypointId`'s when set; linked
 * to `splitMapId`, the map a confirmed proposal split its work into, or to none.
 */
export function saveExclusion(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  text: string,
  waypointId: string | null,
  splitMapId: string | null,
): void {
  tx.insert(mapExclusions)
    .values({
      mapId: run.mapId,
      position: nextExclusionPosition(tx, run.mapId),
      text,
      waypointId,
      createdByRun: run.id,
      splitMapId,
    })
    .run();
}

/**
 * The first of a run's proposals of new maps outside its stored bounds (map proposals): a draft
 * idea is 1 to 4000 characters once trimmed, a line 1 to 500. An output breaking them is refused
 * `agent_output_invalid`, as any other invalid output is, and nothing is saved. Null when every
 * proposal holds, or the output has none.
 */
export function proposalsProblem(
  proposals: readonly { readonly idea: string; readonly line: string | null }[],
): RunFailure | null {
  for (const [index, proposal] of proposals.entries()) {
    const ideaHolds = MapIdea.safeParse(proposal.idea).success;
    const lineHolds = proposal.line === null || MapLine.safeParse(proposal.line).success;
    if (!ideaHolds || !lineHolds) {
      return {
        code: "agent_output_invalid",
        message: `Proposal ${String(index + 1)}'s idea must be 1 to ${String(MAP_IDEA_MAX_LENGTH)} characters and its line 1 to ${String(MAP_LINE_MAX_LENGTH)}`,
      };
    }
  }
  return null;
}

/**
 * Saves a run's pending proposal of a new map (map proposals), its draft idea trimmed: with its own
 * Out of scope line, saved only when the person decides it, or attached to the waypoint the run
 * ruled out (`waypointId`), whose line already exists.
 */
export function saveProposal(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  proposal: {
    readonly title: string;
    readonly idea: string;
    readonly line: string | null;
    readonly waypointId: string | null;
  },
): void {
  if ((proposal.line === null) === (proposal.waypointId === null)) {
    throw new Error(`A proposal of run ${run.id} needs exactly one of its own line and a waypoint`);
  }
  insertProposal(tx, run, { ...proposal, kind: "outside", exclusionPosition: null });
}

/**
 * Saves a first chart's pending offer to split a map off this map's idea (idea-phase split), its
 * draft idea trimmed, with the Out of scope line saying what this map leaves to it: saved, linked,
 * only when the person creates the map; dismissing it keeps the work in this map.
 */
export function saveSplitOffer(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  offer: { readonly title: string; readonly idea: string; readonly line: string },
): void {
  insertProposal(tx, run, { ...offer, kind: "split", waypointId: null, exclusionPosition: null });
}

/**
 * Saves a hatch run's pending proposal of a new map that splits off the map's existing Out of scope
 * line at `exclusionPosition` (map proposals), its draft idea trimmed; the line gains its link only
 * when the person confirms it. The caller checked that the line exists and links no map.
 */
export function saveSplitProposal(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  proposal: { readonly title: string; readonly idea: string; readonly exclusionPosition: number },
): void {
  insertProposal(tx, run, { ...proposal, kind: "outside", line: null, waypointId: null });
}

/** Inserts a pending proposal naming exactly one of its own line, a waypoint and an existing line. */
function insertProposal(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  proposal: {
    readonly kind: MapProposalKind;
    readonly title: string;
    readonly idea: string;
    readonly line: string | null;
    readonly waypointId: string | null;
    readonly exclusionPosition: number | null;
  },
): void {
  tx.insert(mapProposals)
    .values({
      id: uuidv7(),
      mapId: run.mapId,
      kind: proposal.kind,
      title: proposal.title,
      idea: proposal.idea.trim(),
      line: proposal.line,
      waypointId: proposal.waypointId,
      exclusionPosition: proposal.exclusionPosition,
      state: "pending",
      newMapId: null,
      createdByRun: run.id,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    })
    .run();
}

/** The map's `fog_next_position`. */
function fogNextPosition(db: Reader, mapId: string): number {
  const row = db.select({ next: maps.fogNextPosition }).from(maps).where(eq(maps.id, mapId)).get();
  if (row === undefined) {
    throw new Error(`No map with id ${mapId}`);
  }
  return row.next;
}

/**
 * Saves new fog items at the map's next positions and moves `fog_next_position` past them, so a
 * position is never reused.
 */
export function addFog(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  texts: readonly string[],
): void {
  const first = fogNextPosition(tx, run.mapId);
  for (const [index, text] of texts.entries()) {
    tx.insert(mapFog)
      .values({ mapId: run.mapId, position: first + index, text, createdByRun: run.id })
      .run();
  }
  tx.update(maps)
    .set({ fogNextPosition: first + texts.length })
    .where(eq(maps.id, run.mapId))
    .run();
}

/**
 * The fog positions a run's map changes settle, in order: each graduated into a new waypoint
 * (`fromFog`), moved out of scope, decided by the agent (`fogDecided`), or settled by the run's own
 * resolution (`fogSettledHere`).
 */
export function settledFogPositions(changes: MapChanges): number[] {
  return [
    ...changes.newWaypoints.flatMap((created) =>
      created.fromFog === null ? [] : [created.fromFog],
    ),
    ...changes.fogOutOfScope.map((item) => item.position),
    ...changes.fogDecided.map((item) => item.position),
    ...changes.fogSettledHere,
  ];
}

/**
 * The first problem of a run's map changes, checked before anything is written: a
 * new waypoint blocked by a number naming no existing waypoint is `waypoint_blocker_unknown`; a
 * fog position (`fromFog`, `fogOutOfScope` or `fogDecided`) naming no current item, or used twice, is
 * `fog_item_unknown`; fog settled by the run's own resolution when its outcome resolves nothing
 * is `fog_settled_without_resolution`. `ownStatus` is the status the run's own outcome gives its
 * waypoint.
 * Null when there is none.
 */
export function mapChangesProblem(
  db: Reader,
  waypoint: Pick<Waypoint, "id" | "mapId">,
  ownStatus: WaypointStatus,
  changes: MapChanges,
): RunFailure | null {
  const existing = db
    .select({ number: waypoints.number })
    .from(waypoints)
    .where(eq(waypoints.mapId, waypoint.mapId))
    .all();
  const numbers = new Set(existing.map((row) => row.number));
  for (const [index, created] of changes.newWaypoints.entries()) {
    const unknown = created.blockedBy.find((number) => !numbers.has(number));
    if (unknown !== undefined) {
      return {
        code: "waypoint_blocker_unknown",
        message: `New waypoint ${String(index + 1)} is blocked by waypoint ${String(unknown)}, which the map does not have`,
      };
    }
  }
  if (changes.fogSettledHere.length > 0 && ownStatus !== "resolved") {
    return {
      code: "fog_settled_without_resolution",
      message:
        "The output settles fog with its own resolution but resolves nothing: decide those items (fogDecided), graduate them or move them out of scope",
    };
  }
  const fog = readFog(db, waypoint.mapId);
  const positions = new Set(fog.map((item) => item.position));
  const used = new Set<number>();
  for (const position of settledFogPositions(changes)) {
    if (!positions.has(position) || used.has(position)) {
      return {
        code: "fog_item_unknown",
        message: `Fog position ${String(position)} is not a fog item of the map, or is used twice`,
      };
    }
    used.add(position);
  }
  // Fog the changes leave goes to the map's fog run once no waypoint is open or claimed (harness
  // change #4): a run never settles fog it does not own, so parallel last runs cannot race.
  return null;
}

/**
 * Applies a run's map changes, already checked by `mapChangesProblem`, in the
 * transaction recording its outcome: new waypoints numbered on from the map's highest with their
 * blockers, each graduated fog item deleted, each fog item moved out of scope deleted and its line
 * saved with no waypoint, each fog item the agent decided deleted and saved as a waypoint resolved
 * by the run (its question the item's text, numbered after the new waypoints), new fog at the
 * map's next positions, and each fog item the run's own resolution settles deleted (its decision
 * lives in that resolution). The caller's `planNext` then puts the new waypoints on the frontier.
 */
export function applyMapChanges(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  changes: MapChanges,
): void {
  const highest = tx
    .select({ highest: max(waypoints.number) })
    .from(waypoints)
    .where(eq(waypoints.mapId, run.mapId))
    .get()?.highest;
  if (highest === undefined || highest === null) {
    throw new Error(`Map ${run.mapId} has no waypoint while a waypoint run changes it`);
  }
  for (const [index, created] of changes.newWaypoints.entries()) {
    const number = highest + index + 1;
    tx.insert(waypoints)
      .values({
        id: uuidv7(),
        mapId: run.mapId,
        number,
        kind: created.kind,
        status: "open",
        title: created.title,
        question: created.question,
        claimedAt: null,
        resolution: null,
        gist: null,
        agentDecided: null,
        resolvedAt: null,
        resolvedHow: null,
        resolvedByRun: null,
        createdByRun: run.id,
        personDecides: false,
      })
      .run();
    // A repeated number names one blocker once.
    for (const blockerNumber of new Set(created.blockedBy)) {
      tx.insert(waypointBlockers)
        .values({ mapId: run.mapId, waypointNumber: number, blockerNumber })
        .run();
    }
    if (created.fromFog !== null) {
      deleteFog(tx, run.mapId, created.fromFog);
    }
  }
  for (const item of changes.fogOutOfScope) {
    deleteFog(tx, run.mapId, item.position);
    saveExclusion(tx, run, item.line, null, null);
  }
  const at = new Date().toISOString();
  for (const [index, decided] of changes.fogDecided.entries()) {
    const question = fogText(tx, run.mapId, decided.position);
    deleteFog(tx, run.mapId, decided.position);
    tx.insert(waypoints)
      .values({
        id: uuidv7(),
        mapId: run.mapId,
        number: highest + changes.newWaypoints.length + index + 1,
        kind: "grilling",
        status: "resolved",
        title: decided.title,
        question,
        claimedAt: null,
        resolution: decided.resolution,
        gist: decided.gist,
        // The whole decision is the agent's, as the page says from its lack of rounds: no separate
        // calls are listed (the run writes none).
        agentDecided: [],
        resolvedAt: at,
        resolvedHow: "run",
        resolvedByRun: run.id,
        createdByRun: run.id,
        personDecides: false,
      })
      .run();
  }
  for (const position of changes.fogSettledHere) {
    deleteFog(tx, run.mapId, position);
  }
  addFog(tx, run, changes.newFog);
}

/**
 * Settles a fog item as a proposal of a new map (map proposals): the item is deleted from the fog
 * and the proposal saved pending with its own line; no Out of scope line is saved until the person
 * decides it.
 */
export function proposeFog(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  item: {
    readonly position: number;
    readonly title: string;
    readonly idea: string;
    readonly line: string;
  },
): void {
  deleteFog(tx, run.mapId, item.position);
  saveProposal(tx, run, { title: item.title, idea: item.idea, line: item.line, waypointId: null });
}

/** The text of the map's fog item at `position`; a missing one is a programmer error. */
function fogText(tx: Tx, mapId: string, position: number): string {
  const item = readFog(tx, mapId).find((candidate) => candidate.position === position);
  if (item === undefined) {
    throw new Error(`Map ${mapId} has no fog item at position ${String(position)}`);
  }
  return item.text;
}

function deleteFog(tx: Tx, mapId: string, position: number): void {
  const deleted = tx
    .delete(mapFog)
    .where(and(eq(mapFog.mapId, mapId), eq(mapFog.position, position)))
    .run();
  if (deleted.changes !== 1) {
    throw new Error(`Map ${mapId} has no fog item at position ${String(position)}`);
  }
}
