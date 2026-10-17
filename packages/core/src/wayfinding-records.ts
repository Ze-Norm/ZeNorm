import type {
  FogItem,
  MapOutOfScopeLine,
  MapProposal,
  MapProposalState,
  ProjectProposalContext,
  Waypoint,
  WaypointFinding,
  WaypointReport,
  WaypointTaskOutcome,
} from "@zenorm/contracts";
import {
  consistencyFindings,
  consistencyPasses,
  mapExclusions,
  mapFog,
  mapProposals,
  maps,
  planningRuns,
  researchReports,
  researchSources,
  taskOutcomes,
  waypoints,
} from "@zenorm/db";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Reader } from "./planning-runs.ts";

/** The map's fog items by position. */
export function readFog(db: Reader, mapId: string): FogItem[] {
  return db
    .select({ position: mapFog.position, text: mapFog.text })
    .from(mapFog)
    .where(eq(mapFog.mapId, mapId))
    .orderBy(asc(mapFog.position))
    .all();
}

/** One stored Out of scope line: its text and the id of its waypoint, or null for the map's. */
export interface Exclusion {
  /** Its position on the map, from 1; lines are never deleted. */
  readonly position: number;
  readonly text: string;
  readonly waypointId: string | null;
  /** The run that wrote the line: a chart, or a waypoint run ruling or moving fog out of scope. */
  readonly createdByRun: string;
  /** The map a confirmed proposal split the line's work into, or null. */
  readonly splitMapId: string | null;
}

/** The map's Out of scope lines by position. */
export function readExclusions(db: Reader, mapId: string): Exclusion[] {
  return db
    .select({
      position: mapExclusions.position,
      text: mapExclusions.text,
      waypointId: mapExclusions.waypointId,
      createdByRun: mapExclusions.createdByRun,
      splitMapId: mapExclusions.splitMapId,
    })
    .from(mapExclusions)
    .where(eq(mapExclusions.mapId, mapId))
    .orderBy(asc(mapExclusions.position))
    .all();
}

/** The waypoint of `waypointId` among the map's; a missing one is a programmer error. */
function waypointOf(mapWaypoints: readonly Waypoint[], waypointId: string): Waypoint {
  const waypoint = mapWaypoints.find((candidate) => candidate.id === waypointId);
  if (waypoint === undefined) {
    throw new Error(`Waypoint ${waypointId} is not on the map it was read with`);
  }
  return waypoint;
}

/** The map's Out of scope lines as the snapshot reads them. */
export function outOfScopeLines(
  exclusions: readonly Exclusion[],
  mapWaypoints: readonly Waypoint[],
): MapOutOfScopeLine[] {
  return exclusions.map(({ text, waypointId, splitMapId }) => ({
    text,
    waypoint: waypointId === null ? null : waypointOf(mapWaypoints, waypointId).number,
    splitMapId,
  }));
}

/** The map's Out of scope line at `position`; a missing one is a programmer error. */
function exclusionAt(exclusions: readonly Exclusion[], position: number): Exclusion {
  const exclusion = exclusions.find((candidate) => candidate.position === position);
  if (exclusion === undefined) {
    throw new Error(`No Out of scope line at position ${String(position)} on the map`);
  }
  return exclusion;
}

/** The map's proposals of new maps, oldest first, as the snapshot reads them. */
export function readProposals(
  db: Reader,
  mapId: string,
  mapWaypoints: readonly Waypoint[],
): MapProposal[] {
  const exclusions = readExclusions(db, mapId);
  return db
    .select()
    .from(mapProposals)
    .where(eq(mapProposals.mapId, mapId))
    .orderBy(asc(mapProposals.createdAt), asc(mapProposals.id))
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      idea: row.idea,
      line: row.line,
      waypoint: row.waypointId === null ? null : waypointOf(mapWaypoints, row.waypointId).number,
      splitsLine:
        row.exclusionPosition === null
          ? null
          : {
              position: row.exclusionPosition,
              text: exclusionAt(exclusions, row.exclusionPosition).text,
            },
      state: row.state,
      newMapId: row.newMapId,
      createdByRun: row.createdByRun,
      createdAt: row.createdAt,
    }));
}

/**
 * Every map proposal of the project, from each of its maps, oldest first (by when it was proposed,
 * then id), as a run that can suggest maps reads it: its title, its line as stored (null for one
 * attached to a waypoint or one splitting an existing line) and its state.
 */
export function readProjectProposals(db: Reader, projectId: string): ProjectProposalContext[] {
  return db
    .select({ title: mapProposals.title, line: mapProposals.line, state: mapProposals.state })
    .from(mapProposals)
    .innerJoin(maps, eq(maps.id, mapProposals.mapId))
    .where(eq(maps.projectId, projectId))
    .orderBy(asc(mapProposals.createdAt), asc(mapProposals.id))
    .all();
}

/**
 * The maps a first chart offered to split off this map's idea, oldest first, with the person's
 * decision on each (idea-phase split).
 */
export function readSplitOffers(
  db: Reader,
  mapId: string,
): { readonly title: string; readonly idea: string; readonly state: MapProposalState }[] {
  return db
    .select({ title: mapProposals.title, idea: mapProposals.idea, state: mapProposals.state })
    .from(mapProposals)
    .where(and(eq(mapProposals.mapId, mapId), eq(mapProposals.kind, "split")))
    .orderBy(asc(mapProposals.createdAt), asc(mapProposals.id))
    .all();
}

/** A research report with the id of its waypoint. */
export type StoredReport = WaypointReport & { readonly waypointId: string };

/** The map's research reports, oldest first (by run id, a UUIDv7), each with its sources by position. */
export function readReports(db: Reader, mapId: string): StoredReport[] {
  const rows = db
    .select({ report: researchReports })
    .from(researchReports)
    .innerJoin(waypoints, eq(waypoints.id, researchReports.waypointId))
    .where(eq(waypoints.mapId, mapId))
    .orderBy(asc(researchReports.runId))
    .all();
  return rows.map(({ report }) => ({
    runId: report.runId,
    waypointId: report.waypointId,
    answered: report.answered,
    summary: report.summary,
    gap: report.gap,
    findings: report.findings,
    sources: db
      .select({
        kind: researchSources.kind,
        title: researchSources.title,
        url: researchSources.url,
        excerpt: researchSources.excerpt,
      })
      .from(researchSources)
      .where(eq(researchSources.reportRunId, report.runId))
      .orderBy(asc(researchSources.position))
      .all(),
    limitations: report.limitations,
    uncertainties: report.uncertainties,
  }));
}

/** A task outcome with the id of its waypoint. */
export type StoredTaskOutcome = WaypointTaskOutcome & { readonly waypointId: string };

/** The map's task outcomes, oldest first (by run id). */
export function readTaskOutcomes(db: Reader, mapId: string): StoredTaskOutcome[] {
  return db
    .select({
      runId: taskOutcomes.runId,
      waypointId: taskOutcomes.waypointId,
      outcome: taskOutcomes.outcome,
      action: taskOutcomes.action,
      facts: taskOutcomes.facts,
    })
    .from(taskOutcomes)
    .innerJoin(waypoints, eq(waypoints.id, taskOutcomes.waypointId))
    .where(eq(waypoints.mapId, mapId))
    .orderBy(asc(taskOutcomes.runId))
    .all();
}

/** A consistency finding with the id of the waypoint it opened. */
export type StoredFinding = WaypointFinding & { readonly waypointId: string };

/** The findings that opened the map's waypoints. */
export function readFindings(db: Reader, mapId: string): StoredFinding[] {
  return db
    .select({
      waypointId: consistencyFindings.createdWaypointId,
      kind: consistencyFindings.kind,
      waypointNumbers: consistencyFindings.waypointNumbers,
      explanation: consistencyFindings.explanation,
    })
    .from(consistencyFindings)
    .innerJoin(waypoints, eq(waypoints.id, consistencyFindings.createdWaypointId))
    .where(eq(waypoints.mapId, mapId))
    .all();
}

/** A consistency pass: its run, what it compared and how many findings it saved. */
export interface StoredPass {
  readonly runId: string;
  readonly compared: readonly { readonly waypointId: string; readonly resolvedAt: string }[];
  readonly findingCount: number;
}

/** The map's consistency passes, oldest first (by their runs' start). */
export function readPasses(db: Reader, mapId: string): StoredPass[] {
  return db
    .select({
      runId: consistencyPasses.runId,
      compared: consistencyPasses.compared,
      findingCount: sql<number>`(select count(*) from ${consistencyFindings} where ${consistencyFindings.passId} = ${consistencyPasses.id})`,
    })
    .from(consistencyPasses)
    .innerJoin(planningRuns, eq(planningRuns.id, consistencyPasses.runId))
    .where(eq(consistencyPasses.mapId, mapId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all();
}
