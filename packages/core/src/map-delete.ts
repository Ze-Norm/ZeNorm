import { err, ok } from "@zenorm/contracts";
import type {
  CheckoutProject,
  DeleteMapError,
  DeleteMapInput,
  DeletedMap,
  Result,
  UserActor,
} from "@zenorm/contracts";
import {
  codeSurveys,
  consistencyFindings,
  consistencyPasses,
  deliveryRunEvents,
  deliveryRuns,
  deliveryRunTickets,
  hatchMessages,
  mapExclusions,
  mapFog,
  mapProposals,
  maps,
  planningRuns,
  projects,
  questionRounds,
  researchReports,
  researchSources,
  specifications,
  specReviewFindings,
  specReviews,
  specRevisions,
  specWaits,
  taskOutcomes,
  ticketSetRejections,
  ticketSets,
  ticketSetVersions,
  ticketsReviewFindings,
  ticketsReviews,
  waypointBlockers,
  waypoints,
  waypointTouches,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, inArray, like, ne, or, sql } from "drizzle-orm";

import type { Tx } from "./planning-runs.ts";
import { ticketBranchName } from "./run-progress.ts";
import { mapSpecIds, releaseAfterDelete } from "./spec-holds.ts";
import { write } from "./writes.ts";

/** A spec the map wrote a revision of. */
interface WrittenSpec {
  readonly id: string;
  readonly number: number;
}

/** The specs the map wrote a revision of, by number. */
function writtenSpecs(tx: Tx, mapId: string): WrittenSpec[] {
  return tx
    .selectDistinct({ id: specifications.id, number: specifications.number })
    .from(specRevisions)
    .innerJoin(specifications, eq(specifications.id, specRevisions.specificationId))
    .where(eq(specRevisions.mapId, mapId))
    .orderBy(asc(specifications.number))
    .all();
}

/**
 * Another map that worked on the spec, or null: one that wrote a revision of it, ran on it, sent a
 * message about it, touched it from a waypoint or waits on it, or whose run reviewed one of its
 * revisions or wrote one of its ticket sets. A map that only links the spec's page does not count:
 * the delete leaves that link as its text (`unlinkSpecPages`).
 */
function otherSpecMap(tx: Tx, mapId: string, specificationId: string): string | null {
  const candidates = [
    tx
      .select({ mapId: specRevisions.mapId })
      .from(specRevisions)
      .where(
        and(eq(specRevisions.specificationId, specificationId), ne(specRevisions.mapId, mapId)),
      )
      .orderBy(asc(specRevisions.mapId))
      .get(),
    tx
      .select({ mapId: planningRuns.mapId })
      .from(planningRuns)
      .where(and(eq(planningRuns.specificationId, specificationId), ne(planningRuns.mapId, mapId)))
      .orderBy(asc(planningRuns.mapId))
      .get(),
    tx
      .select({ mapId: hatchMessages.mapId })
      .from(hatchMessages)
      .where(
        and(eq(hatchMessages.specificationId, specificationId), ne(hatchMessages.mapId, mapId)),
      )
      .orderBy(asc(hatchMessages.mapId))
      .get(),
    tx
      .select({ mapId: waypoints.mapId })
      .from(waypointTouches)
      .innerJoin(waypoints, eq(waypoints.id, waypointTouches.waypointId))
      .where(and(eq(waypointTouches.specificationId, specificationId), ne(waypoints.mapId, mapId)))
      .orderBy(asc(waypoints.mapId))
      .get(),
    tx
      .select({ mapId: specWaits.mapId })
      .from(specWaits)
      .where(and(eq(specWaits.specificationId, specificationId), ne(specWaits.mapId, mapId)))
      .orderBy(asc(specWaits.mapId))
      .get(),
    tx
      .select({ mapId: planningRuns.mapId })
      .from(specReviews)
      .innerJoin(specRevisions, eq(specRevisions.id, specReviews.specRevisionId))
      .innerJoin(planningRuns, eq(planningRuns.id, specReviews.runId))
      .where(and(eq(specRevisions.specificationId, specificationId), ne(planningRuns.mapId, mapId)))
      .orderBy(asc(planningRuns.mapId))
      .get(),
    tx
      .select({ mapId: planningRuns.mapId })
      .from(ticketSetVersions)
      .innerJoin(ticketSets, eq(ticketSets.id, ticketSetVersions.ticketSetId))
      .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
      .innerJoin(planningRuns, eq(planningRuns.id, ticketSetVersions.writtenByRun))
      .where(and(eq(specRevisions.specificationId, specificationId), ne(planningRuns.mapId, mapId)))
      .orderBy(asc(planningRuns.mapId))
      .get(),
  ];
  const found = candidates.find((row) => row !== undefined);
  return found === undefined ? null : found.mapId;
}

/**
 * Why the specs the map wrote cannot go with it, or null when they can: another map worked on one
 * (`map_spec_shared`), or one has a delivery run that is in flight, merged or has its pull request
 * open (`map_spec_delivered`). A run that ended unmerged, with its pull request closed or none, is
 * work the person dropped: it goes with its spec, and its branches after (`cleanUpDeletedRuns`).
 */
function specsRefusal(tx: Tx, mapId: string, specs: readonly WrittenSpec[]): DeleteMapError | null {
  for (const spec of specs) {
    const otherMapId = otherSpecMap(tx, mapId, spec.id);
    if (otherMapId !== null) {
      return {
        code: "map_spec_shared",
        message: `Map ${otherMapId} also worked on spec ${String(spec.number)}`,
        data: { mapId, spec: spec.number, otherMapId },
      };
    }
  }
  for (const spec of specs) {
    const runs = tx
      .select({
        id: deliveryRuns.id,
        endedAt: deliveryRuns.endedAt,
        mergedAt: deliveryRuns.mergedAt,
        prState: deliveryRuns.prState,
      })
      .from(deliveryRuns)
      .where(eq(deliveryRuns.specificationId, spec.id))
      .orderBy(asc(deliveryRuns.id))
      .all();
    for (const run of runs) {
      const reason =
        run.endedAt === null
          ? "active"
          : run.mergedAt !== null || run.prState === "merged"
            ? "merged"
            : run.prState === "open"
              ? "pr_open"
              : null;
      if (reason !== null) {
        return {
          code: "map_spec_delivered",
          message: `Spec ${String(spec.number)} has delivery run ${run.id} (${reason})`,
          data: { mapId, spec: spec.number, runId: run.id, reason },
        };
      }
    }
  }
  return null;
}

/** A markdown link to one of the map's spec pages (`specPagePath`): its text is group 1. */
function specPageLink(mapId: string): RegExp {
  return new RegExp(`\\[([^\\]]*)\\]\\(/maps/${mapId}/spec/\\d+\\)`, "g");
}

/**
 * Leaves every other map's link to one of the map's spec pages as its text and "(deleted)": a chart
 * links another map's spec by its title (`specPagePath`), and the page goes with the map.
 */
function unlinkSpecPages(tx: Tx, mapId: string): void {
  const page = `%/maps/${mapId}/spec/%`;
  const linking = tx
    .select({ id: maps.id, summary: maps.summary, destination: maps.destination })
    .from(maps)
    .where(and(ne(maps.id, mapId), or(like(maps.summary, page), like(maps.destination, page))))
    .orderBy(asc(maps.id))
    .all();
  const unlink = (text: string | null): string | null =>
    text === null ? null : text.replace(specPageLink(mapId), "$1 (deleted)");
  for (const map of linking) {
    tx.update(maps)
      .set({ summary: unlink(map.summary), destination: unlink(map.destination) })
      .where(eq(maps.id, map.id))
      .run();
  }
}

/**
 * Why the map cannot be deleted, checked in `DeleteMapErrorCode`'s order, or null when it can.
 * Every refusal is read before anything is deleted, so a refused delete writes nothing.
 */
function deleteRefusal(
  tx: Tx,
  mapId: string,
  specs: readonly WrittenSpec[],
  deleteSpecs: readonly number[],
): DeleteMapError | null {
  const numbers = specs.map((spec) => spec.number);
  if (specs.length > 0 && numbers.join(",") !== deleteSpecs.join(",")) {
    return {
      code: "map_wrote_spec",
      message: `Map ${mapId} wrote a revision of spec ${numbers.join(", ")}`,
      data: { mapId, specs: numbers },
    };
  }
  const specsRefused = specsRefusal(tx, mapId, specs);
  if (specsRefused !== null) {
    return specsRefused;
  }
  const running = tx
    .select({ id: planningRuns.id })
    .from(planningRuns)
    .where(and(eq(planningRuns.mapId, mapId), eq(planningRuns.state, "running")))
    .orderBy(asc(planningRuns.id))
    .get();
  if (running !== undefined) {
    return {
      code: "map_run_in_flight",
      message: `Map ${mapId} has planning run ${running.id} in flight`,
      data: { mapId, runId: running.id },
    };
  }
  const linked = splitLinkedMap(tx, mapId);
  if (linked !== null) {
    return {
      code: "map_split_linked",
      message: `Map ${mapId} is linked by a split to map ${linked}`,
      data: { mapId, linkedMapId: linked },
    };
  }
  // A wait records its hold when it is written and never changes (`spec_waits.hold_map_id`): a
  // stopped spec-scoped To Spec holds a spec without a revision, so a map with none can be named.
  const waiting = tx
    .select({ mapId: specWaits.mapId })
    .from(specWaits)
    .where(and(eq(specWaits.holdMapId, mapId), ne(specWaits.mapId, mapId)))
    .orderBy(asc(specWaits.mapId))
    .get();
  if (waiting !== undefined) {
    return {
      code: "map_waited_on",
      message: `Map ${waiting.mapId} waits on a spec map ${mapId} holds`,
      data: { mapId, waitingMapId: waiting.mapId },
    };
  }
  return null;
}

/**
 * Another map a split links to this one, or null: the map it was split from, a map split from it,
 * or a map another map's confirmed proposal or Out of scope line names as this one. A confirmed
 * proposal must name its map (`map_proposals_new_map_ck`), so the link cannot be cut.
 */
function splitLinkedMap(tx: Tx, mapId: string): string | null {
  const own = tx
    .select({ splitFromMapId: maps.splitFromMapId })
    .from(maps)
    .where(eq(maps.id, mapId))
    .get();
  if (own === undefined) {
    throw new Error(`Map ${mapId} vanished inside its delete`);
  }
  if (own.splitFromMapId !== null) {
    return own.splitFromMapId;
  }
  const child = tx
    .select({ id: maps.id })
    .from(maps)
    .where(eq(maps.splitFromMapId, mapId))
    .orderBy(asc(maps.id))
    .get();
  if (child !== undefined) {
    return child.id;
  }
  const proposal = tx
    .select({ mapId: mapProposals.mapId })
    .from(mapProposals)
    .where(and(eq(mapProposals.newMapId, mapId), ne(mapProposals.mapId, mapId)))
    .orderBy(asc(mapProposals.mapId))
    .get();
  if (proposal !== undefined) {
    return proposal.mapId;
  }
  const line = tx
    .select({ mapId: mapExclusions.mapId })
    .from(mapExclusions)
    .where(and(eq(mapExclusions.splitMapId, mapId), ne(mapExclusions.mapId, mapId)))
    .orderBy(asc(mapExclusions.mapId))
    .get();
  return line === undefined ? null : line.mapId;
}

/** A delivery run deleted with its spec: what it left outside the database, in its project folder. */
export interface DeletedRun {
  readonly id: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly ticketBranches: readonly string[];
}

/**
 * What `deleteMap` deleted: the map and its project, the delivery runs that went with its specs,
 * and the project to check out to remove their branches.
 */
export interface MapDeletion {
  readonly map: DeletedMap;
  readonly runs: readonly DeletedRun[];
  readonly project: CheckoutProject;
}

/**
 * Deletes every row recorded on the map, then the map. The order is the change feed's (`FEED_TABLES`
 * in `@zenorm/db`): each delete trigger finds its row's map and project through the row's parent, so
 * a row goes before the parent it is read through, and every row before `maps`. The map's own rows
 * reference each other both ways (a run and its hatch message, a waypoint and the run that resolved
 * it), so foreign keys are checked at commit, once every row is gone. `specIds` are the specs the map
 * wrote, deleted with it: their delivery runs, ticket sets, revisions and the specs themselves.
 * Returns the delivery runs deleted.
 */
function deleteMapRows(tx: Tx, mapId: string, specIds: readonly string[]): DeletedRun[] {
  tx.run(sql`PRAGMA defer_foreign_keys = ON`);
  const runIds = tx
    .select({ id: planningRuns.id })
    .from(planningRuns)
    .where(eq(planningRuns.mapId, mapId))
    .all()
    .map((row) => row.id);
  const waypointIds = tx
    .select({ id: waypoints.id })
    .from(waypoints)
    .where(eq(waypoints.mapId, mapId))
    .all()
    .map((row) => row.id);
  const passIds = tx
    .select({ id: consistencyPasses.id })
    .from(consistencyPasses)
    .where(eq(consistencyPasses.mapId, mapId))
    .all()
    .map((row) => row.id);

  if (runIds.length > 0) {
    const specReviewIds = tx
      .select({ id: specReviews.id })
      .from(specReviews)
      .where(inArray(specReviews.runId, runIds))
      .all()
      .map((row) => row.id);
    const ticketsReviewIds = tx
      .select({ id: ticketsReviews.id })
      .from(ticketsReviews)
      .where(inArray(ticketsReviews.runId, runIds))
      .all()
      .map((row) => row.id);
    if (specReviewIds.length > 0) {
      tx.delete(specReviewFindings)
        .where(inArray(specReviewFindings.reviewId, specReviewIds))
        .run();
    }
    if (ticketsReviewIds.length > 0) {
      tx.delete(ticketsReviewFindings)
        .where(inArray(ticketsReviewFindings.reviewId, ticketsReviewIds))
        .run();
    }
    tx.delete(specReviews).where(inArray(specReviews.runId, runIds)).run();
    tx.delete(ticketsReviews).where(inArray(ticketsReviews.runId, runIds)).run();
    tx.delete(researchSources).where(inArray(researchSources.reportRunId, runIds)).run();
    tx.delete(researchReports).where(inArray(researchReports.runId, runIds)).run();
    tx.delete(taskOutcomes).where(inArray(taskOutcomes.runId, runIds)).run();
  }
  if (passIds.length > 0) {
    tx.delete(consistencyFindings).where(inArray(consistencyFindings.passId, passIds)).run();
  }
  if (waypointIds.length > 0) {
    tx.delete(waypointTouches).where(inArray(waypointTouches.waypointId, waypointIds)).run();
  }
  const runs = specIds.length > 0 ? deleteSpecRows(tx, specIds) : [];

  tx.delete(consistencyPasses).where(eq(consistencyPasses.mapId, mapId)).run();
  tx.delete(codeSurveys).where(eq(codeSurveys.mapId, mapId)).run();
  tx.delete(mapProposals).where(eq(mapProposals.mapId, mapId)).run();
  tx.delete(mapExclusions).where(eq(mapExclusions.mapId, mapId)).run();
  tx.delete(mapFog).where(eq(mapFog.mapId, mapId)).run();
  tx.delete(specWaits).where(eq(specWaits.mapId, mapId)).run();
  tx.delete(questionRounds).where(eq(questionRounds.mapId, mapId)).run();
  tx.delete(waypointBlockers).where(eq(waypointBlockers.mapId, mapId)).run();
  tx.delete(hatchMessages).where(eq(hatchMessages.mapId, mapId)).run();
  tx.delete(waypoints).where(eq(waypoints.mapId, mapId)).run();
  tx.delete(planningRuns).where(eq(planningRuns.mapId, mapId)).run();
  const deleted = tx.delete(maps).where(eq(maps.id, mapId)).run();
  if (deleted.changes !== 1) {
    throw new Error(`Map ${mapId} was not deleted`);
  }
  return runs;
}

/**
 * Deletes the specs, their delivery runs with their tickets and lines, their revisions and their
 * ticket sets with the versions and rejections, in the change feed's order: a run's rows find their
 * map through the run and a run through its ticket set, and a ticket set its map through its
 * revision, so each goes first. The specs' reviews went with the map's runs, which wrote them.
 * Returns the delivery runs deleted.
 */
function deleteSpecRows(tx: Tx, specIds: readonly string[]): DeletedRun[] {
  const runs = tx
    .select({
      id: deliveryRuns.id,
      branch: deliveryRuns.branch,
      worktreePath: deliveryRuns.worktreePath,
    })
    .from(deliveryRuns)
    .where(inArray(deliveryRuns.specificationId, specIds))
    .orderBy(asc(deliveryRuns.id))
    .all()
    .map((run): DeletedRun => {
      const tickets = tx
        .select({ ticket: deliveryRunTickets.ticket })
        .from(deliveryRunTickets)
        .where(eq(deliveryRunTickets.runId, run.id))
        .orderBy(asc(deliveryRunTickets.position))
        .all();
      return {
        ...run,
        ticketBranches: tickets.map((row) => ticketBranchName(run.branch, row.ticket)),
      };
    });
  if (runs.length > 0) {
    const runIds = runs.map((run) => run.id);
    tx.delete(deliveryRunEvents).where(inArray(deliveryRunEvents.runId, runIds)).run();
    tx.delete(deliveryRunTickets).where(inArray(deliveryRunTickets.runId, runIds)).run();
    tx.delete(deliveryRuns).where(inArray(deliveryRuns.id, runIds)).run();
  }
  const revisionIds = tx
    .select({ id: specRevisions.id })
    .from(specRevisions)
    .where(inArray(specRevisions.specificationId, specIds))
    .all()
    .map((row) => row.id);
  const ticketSetIds = tx
    .select({ id: ticketSets.id })
    .from(ticketSets)
    .where(inArray(ticketSets.specRevisionId, revisionIds))
    .all()
    .map((row) => row.id);
  if (ticketSetIds.length > 0) {
    tx.delete(ticketSetRejections)
      .where(inArray(ticketSetRejections.ticketSetId, ticketSetIds))
      .run();
    tx.delete(ticketSetVersions).where(inArray(ticketSetVersions.ticketSetId, ticketSetIds)).run();
    tx.delete(ticketSets).where(inArray(ticketSets.id, ticketSetIds)).run();
  }
  tx.delete(specRevisions).where(inArray(specRevisions.specificationId, specIds)).run();
  const deleted = tx.delete(specifications).where(inArray(specifications.id, specIds)).run();
  if (deleted.changes !== specIds.length) {
    throw new Error(`Specs ${specIds.join(", ")} were not all deleted`);
  }
  return runs;
}

/**
 * Deletes a map and everything recorded on it, by `actor`'s User. Refuses an unknown map
 * (`map_not_found`), a map that wrote a spec revision (`map_wrote_spec`) unless `deleteSpecs` names
 * exactly those specs, which deletes them too with their ended, unmerged delivery runs and refuses
 * one another map worked on (`map_spec_shared`) or one with a delivery run in flight, merged or
 * with its pull request open (`map_spec_delivered`); also one with a planning run in flight
 * (`map_run_in_flight`), one a split links to another map (`map_split_linked`) and one another
 * map's wait names (`map_waited_on`), writing nothing. Another map's link to one of the map's spec
 * pages is left as its text. The value names the map's project and the delivery runs deleted, whose
 * branches `cleanUpDeletedRuns` removes after.
 */
export function deleteMap(
  actor: UserActor,
  db: ZeNormDatabase,
  input: DeleteMapInput,
): Result<MapDeletion, DeleteMapError> {
  return write(db, actor, (tx): Result<MapDeletion, DeleteMapError> => {
    const map = tx
      .select({ projectId: maps.projectId, folderPath: projects.folderPath })
      .from(maps)
      .innerJoin(projects, eq(projects.id, maps.projectId))
      .where(eq(maps.id, input.mapId))
      .get();
    if (map === undefined) {
      return err({
        code: "map_not_found",
        message: `No map with id ${input.mapId}`,
        data: { mapId: input.mapId },
      });
    }
    const written = writtenSpecs(tx, input.mapId);
    const refusal = deleteRefusal(tx, input.mapId, written, input.deleteSpecs);
    if (refusal !== null) {
      return err(refusal);
    }
    // Read before the rows go: the specs the map's holds may have held other maps back on. The
    // specs deleted with the map held no other map: one another map worked on was refused.
    const deletedSpecIds = written.map((spec) => spec.id);
    const specIds = mapSpecIds(tx, input.mapId).filter((id) => !deletedSpecIds.includes(id));
    unlinkSpecPages(tx, input.mapId);
    const runs = deleteMapRows(tx, input.mapId, deletedSpecIds);
    releaseAfterDelete(actor, tx, specIds);
    return ok({
      map: { mapId: input.mapId, projectId: map.projectId },
      runs,
      project: { id: map.projectId, folderPath: map.folderPath },
    });
  });
}
