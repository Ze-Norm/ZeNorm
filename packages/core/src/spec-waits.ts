/**
 * A map's waits as `map.overview` shows them: each open wait, and each released
 * one whose revision the map has not yet written, with its live hold and its release run.
 */
import type { PlanningRun, SpecWaitView, Waypoint } from "@zenorm/contracts";
import { maps, specifications, specWaits } from "@zenorm/db";
import { asc, eq } from "drizzle-orm";

import { scopeRun, specRuns } from "./planning-runs.ts";
import type { Reader } from "./planning-runs.ts";
import { touchedSpecIds } from "./spec-context.ts";
import { specHold } from "./spec-holds.ts";
import { latestOf, readSpecRevisions, revisionState } from "./specs.ts";

function mapTitle(db: Reader, mapId: string): string {
  const row = db.select({ title: maps.title }).from(maps).where(eq(maps.id, mapId)).get();
  if (row?.title == null) {
    throw new Error(`Map ${mapId} wrote a waited spec's revision but has no title`);
  }
  return row.title;
}

export function mapWaits(
  db: Reader,
  map: { id: string },
  waypoints: readonly Waypoint[],
  runs: readonly PlanningRun[],
): SpecWaitView[] {
  const rows = db
    .select({
      specificationId: specWaits.specificationId,
      specNumber: specifications.number,
      note: specWaits.note,
      since: specWaits.since,
      releasedAt: specWaits.releasedAt,
    })
    .from(specWaits)
    .innerJoin(specifications, eq(specifications.id, specWaits.specificationId))
    .where(eq(specWaits.mapId, map.id))
    .orderBy(asc(specWaits.since), asc(specWaits.id))
    .all();
  return rows.flatMap((row): SpecWaitView[] => {
    const revisions = readSpecRevisions(db, row.specificationId);
    const releasedAt = row.releasedAt;
    if (
      releasedAt !== null &&
      revisions.some((revision) => revision.mapId === map.id && revision.createdAt >= releasedAt)
    ) {
      return [];
    }
    const touching = waypoints
      .filter((waypoint) => touchedSpecIds(db, waypoint.id).includes(row.specificationId))
      .map((waypoint) => waypoint.number)
      .sort((a, b) => a - b);
    const latest = latestOf(revisions);
    const common = {
      specNumber: row.specNumber,
      specTitle: latest.content.title,
      latest: {
        revision: latest.revision,
        state: revisionState(latest),
        mapId: latest.mapId,
        mapTitle: mapTitle(db, latest.mapId),
        savedAt: latest.createdAt,
        content: latest.content,
      },
      note: row.note,
      since: row.since,
      waypoints: touching,
    };
    if (releasedAt === null) {
      return [
        {
          ...common,
          hold: specHold(db, row.specificationId, map.id),
          released: false,
          run: null,
        },
      ];
    }
    const run = scopeRun(specRuns(runs, row.specificationId));
    if (run === null) {
      throw new Error(
        `Map ${map.id}'s released wait on ${row.specificationId} has no release run in motion`,
      );
    }
    return [{ ...common, hold: null, released: true, run }];
  });
}
