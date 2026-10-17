import type { GrillWaypointRequest, SpecReviewFinding } from "@zenorm/contracts";
import { specifications, specReviewFindings, specReviews, specRevisions } from "@zenorm/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { Reader } from "./planning-runs.ts";

/** A planning review finding that sent a waypoint of the map on. */
export interface EscalatedFinding {
  readonly waypointId: string;
  readonly kind: SpecReviewFinding["kind"];
  readonly explanation: string;
  readonly elementIds: readonly string[];
  /** The spec it was found in: its number and the reviewed revision's title. */
  readonly spec: { readonly number: number; readonly title: string };
}

/**
 * Every escalated finding behind the waypoints of the map that a planning review sent on, in the
 * order they were recorded: the one that opened a waypoint first, then any later review's finding
 * raising the same problem that linked it.
 */
export function readEscalatedFindings(db: Reader, mapId: string): EscalatedFinding[] {
  const rows = db
    .select({
      waypointId: specReviewFindings.waypointId,
      kind: specReviewFindings.kind,
      explanation: specReviewFindings.explanation,
      elementIds: specReviewFindings.elementIds,
      number: specifications.number,
      content: specRevisions.content,
    })
    .from(specReviewFindings)
    .innerJoin(specReviews, eq(specReviews.id, specReviewFindings.reviewId))
    .innerJoin(specRevisions, eq(specRevisions.id, specReviews.specRevisionId))
    .innerJoin(specifications, eq(specifications.id, specRevisions.specificationId))
    .where(and(eq(specRevisions.mapId, mapId), isNotNull(specReviewFindings.waypointId)))
    .orderBy(asc(specRevisions.createdAt), asc(specReviewFindings.position))
    .all();
  return rows.map((row) => {
    const { waypointId } = row;
    if (waypointId === null) {
      throw new Error("An escalated finding has no waypoint");
    }
    return {
      waypointId,
      kind: row.kind,
      explanation: row.explanation,
      elementIds: row.elementIds,
      spec: { number: row.number, title: row.content.title },
    };
  });
}

/**
 * Every planning review finding that sent a waypoint on, as its grilling run reads them: none for a
 * waypoint no review sent on.
 */
export function grillReviewFindings(
  db: Reader,
  mapId: string,
  waypointId: string,
): GrillWaypointRequest["reviewFindings"] {
  return readEscalatedFindings(db, mapId)
    .filter((candidate) => candidate.waypointId === waypointId)
    .map((finding) => ({
      kind: finding.kind,
      explanation: finding.explanation,
      spec: finding.spec,
      elementIds: [...finding.elementIds],
    }));
}
