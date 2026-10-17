import type { AccessAction, AccessDeniedError, CheckAccess, UserId } from "@zenorm/contracts";
import {
  deliveryRuns,
  mapProposals,
  maps,
  planningRuns,
  projects,
  questionRounds,
  specRevisions,
  ticketSets,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

/** What a procedure's input names, from which its project is resolved. */
export type ProjectRef =
  | { readonly projectId: string }
  | { readonly mapId: string }
  | { readonly roundId: string }
  | { readonly proposalId: string }
  | { readonly planningRunId: string }
  | { readonly specRevisionId: string }
  | { readonly ticketSetId: string }
  | { readonly deliveryRunId: string };

function mapProject(db: ZeNormDatabase, mapId: string): string | null {
  const row = db.select({ projectId: maps.projectId }).from(maps).where(eq(maps.id, mapId)).get();
  return row === undefined ? null : row.projectId;
}

function specRevisionMap(db: ZeNormDatabase, specRevisionId: string): string | null {
  const row = db
    .select({ mapId: specRevisions.mapId })
    .from(specRevisions)
    .where(eq(specRevisions.id, specRevisionId))
    .get();
  return row === undefined ? null : row.mapId;
}

/**
 * The one server-side resolver: the project a procedure's input names, through its map, round, map
 * proposal, planning run, spec revision, ticket set or delivery run. `null` when the named record
 * does not exist: the procedure then answers its own not-found code, as before the check.
 */
export function projectOf(db: ZeNormDatabase, ref: ProjectRef): string | null {
  if ("projectId" in ref) {
    const row = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, ref.projectId))
      .get();
    return row === undefined ? null : row.id;
  }
  if ("mapId" in ref) return mapProject(db, ref.mapId);
  if ("roundId" in ref) {
    const row = db
      .select({ mapId: questionRounds.mapId })
      .from(questionRounds)
      .where(eq(questionRounds.id, ref.roundId))
      .get();
    return row === undefined ? null : mapProject(db, row.mapId);
  }
  if ("proposalId" in ref) {
    const row = db
      .select({ mapId: mapProposals.mapId })
      .from(mapProposals)
      .where(eq(mapProposals.id, ref.proposalId))
      .get();
    return row === undefined ? null : mapProject(db, row.mapId);
  }
  if ("planningRunId" in ref) {
    const row = db
      .select({ mapId: planningRuns.mapId })
      .from(planningRuns)
      .where(eq(planningRuns.id, ref.planningRunId))
      .get();
    return row === undefined ? null : mapProject(db, row.mapId);
  }
  if ("specRevisionId" in ref) {
    const mapId = specRevisionMap(db, ref.specRevisionId);
    return mapId === null ? null : mapProject(db, mapId);
  }
  if ("ticketSetId" in ref) {
    const row = db
      .select({ specRevisionId: ticketSets.specRevisionId })
      .from(ticketSets)
      .where(eq(ticketSets.id, ref.ticketSetId))
      .get();
    const mapId = row === undefined ? null : specRevisionMap(db, row.specRevisionId);
    return mapId === null ? null : mapProject(db, mapId);
  }
  const row = db
    .select({ projectId: deliveryRuns.projectId })
    .from(deliveryRuns)
    .where(eq(deliveryRuns.id, ref.deliveryRunId))
    .get();
  return row === undefined ? null : row.projectId;
}

/**
 * The access check at the RPC boundary: resolves `ref` to its project and asks `checkAccess`.
 * Returns the refusal, or null when allowed (an unknown record is left to the procedure's own
 * not-found).
 */
export function accessRefusal(
  db: ZeNormDatabase,
  checkAccess: CheckAccess,
  userId: UserId,
  ref: ProjectRef,
  action: AccessAction,
): AccessDeniedError | null {
  const projectId = projectOf(db, ref);
  if (projectId === null || checkAccess(userId, projectId, action)) return null;
  return {
    code: "access_denied",
    message: `Access to project ${projectId} (${action}) is denied`,
    data: { projectId, action },
  };
}
