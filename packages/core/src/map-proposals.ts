import { err, ok } from "@zenorm/contracts";
import type {
  ConfirmProposalError,
  ConfirmProposalInput,
  DismissProposalError,
  DismissProposalInput,
  MapRecord,
  Result,
  UserActor,
} from "@zenorm/contracts";
import { mapExclusions, mapProposals, maps } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, eq, isNull } from "drizzle-orm";

import { saveExclusion } from "./map-changes.ts";
import { insertMap, projectForNewMap } from "./map.ts";
import { now } from "./planning-runs.ts";
import type { Reader, Tx } from "./planning-runs.ts";
import { present } from "./present.ts";
import { planAndRelease } from "./spec-holds.ts";
import { write } from "./writes.ts";

/** A stored map proposal row. */
type StoredProposal = typeof mapProposals.$inferSelect;

/** The refusals a proposal id meets before anything is decided: unknown, or already decided. */
type ProposalRefusal = DismissProposalError;

/** The proposal `proposalId` names, still pending; else its refusal. */
function pendingProposal(db: Reader, proposalId: string): Result<StoredProposal, ProposalRefusal> {
  const proposal = db.select().from(mapProposals).where(eq(mapProposals.id, proposalId)).get();
  if (proposal === undefined) {
    return err({
      code: "proposal_not_found",
      message: `No map proposal with id ${proposalId}`,
      data: { proposalId },
    });
  }
  if (proposal.state !== "pending") {
    return err({
      code: "proposal_already_decided",
      message: `Map proposal ${proposalId} is ${proposal.state}, not pending`,
      data: { proposalId },
    });
  }
  return ok(proposal);
}

/** Decides a pending proposal; one no longer pending is a programmer error. */
function decide(
  tx: Tx,
  proposalId: string,
  decision:
    | { readonly state: "confirmed"; readonly newMapId: string; readonly idea: string }
    | { readonly state: "dismissed" },
): void {
  const values =
    decision.state === "confirmed"
      ? {
          state: decision.state,
          newMapId: decision.newMapId,
          idea: decision.idea,
          decidedAt: now(),
        }
      : { state: decision.state, decidedAt: now() };
  const updated = tx
    .update(mapProposals)
    .set(values)
    .where(and(eq(mapProposals.id, proposalId), eq(mapProposals.state, "pending")))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Map proposal ${proposalId} stopped being pending inside its transaction`);
  }
}

/** The project of the map a proposal was made on; a missing map is a programmer error. */
function projectOfMap(db: Reader, mapId: string): string {
  const map = db.select({ projectId: maps.projectId }).from(maps).where(eq(maps.id, mapId)).get();
  if (map === undefined) {
    throw new Error(`Map ${mapId} of a map proposal does not exist`);
  }
  return map.projectId;
}

/** What confirming a proposal returns: the map it was made on, and the new map. */
export interface ConfirmedProposal {
  readonly mapId: string;
  readonly map: MapRecord;
}

/**
 * Confirms a pending proposal (map proposals) as the confirming User, in one write: the new map is
 * created in the proposal's project from the person's edited idea, naming the map and run it was
 * split from, through `map.create`'s insert, which starts its chart; the proposal's own line is
 * saved on its map linked to the new map, or the existing line it names (a hatch proposal's) or the
 * line of the waypoint it is attached to gains that link, keeping its waypoint. The proposal records
 * the new map and the edited idea; the map's destination, waypoints and fog are untouched. Refuses
 * an unknown proposal, a decided one (`proposal_already_decided`), `map.create`'s refusals
 * (`project_folder_missing`), and an existing line already linked to a map
 * (`exclusion_already_split`): each writes nothing, so the proposal stays pending.
 */
export async function confirmProposal(
  actor: UserActor,
  db: ZeNormDatabase,
  input: ConfirmProposalInput,
): Promise<Result<ConfirmedProposal, ConfirmProposalError>> {
  const found = pendingProposal(db, input.proposalId);
  if (!found.ok) {
    return found;
  }
  const project = await projectForNewMap(db, projectOfMap(db, found.value.mapId));
  if (!project.ok) {
    return project;
  }
  return write(db, actor, (tx): Result<ConfirmedProposal, ConfirmProposalError> => {
    // Read again inside the write: a decision made while the folder was checked wins.
    const pending = pendingProposal(tx, input.proposalId);
    if (!pending.ok) {
      return pending;
    }
    const proposal = pending.value;
    // The existing line the new map takes over, checked before anything is written.
    const existing = proposal.line === null ? existingLine(tx, proposal) : null;
    if (existing !== null && existing.splitMapId !== null) {
      return err({
        code: "exclusion_already_split",
        message: `Out of scope line ${String(existing.position)} of map ${proposal.mapId} is already split into map ${existing.splitMapId}`,
        data: { proposalId: proposal.id },
      });
    }
    const map = insertMap(actor, tx, {
      projectId: project.value.id,
      idea: input.idea,
      splitFromMapId: proposal.mapId,
      splitFromRunId: proposal.createdByRun,
    });
    if (existing === null) {
      saveExclusion(
        tx,
        { id: proposal.createdByRun, mapId: proposal.mapId },
        present(proposal.line, `Map proposal ${proposal.id}'s line`),
        null,
        map.id,
      );
    } else {
      linkLine(tx, proposal.mapId, existing.position, map.id);
    }
    decide(tx, proposal.id, { state: "confirmed", newMapId: map.id, idea: input.idea });
    planAndRelease(actor, tx, proposal.mapId);
    return ok({ mapId: proposal.mapId, map });
  });
}

/** An existing Out of scope line of a proposal's map: its position and the map it links, if any. */
interface ExistingLine {
  readonly position: number;
  readonly splitMapId: string | null;
}

/**
 * The existing Out of scope line a proposal without a line of its own takes over: the one it names
 * (`exclusion_position`, a hatch proposal's) or its waypoint's. A proposal naming neither, or a line
 * that does not exist, is a programmer error.
 */
function existingLine(tx: Tx, proposal: StoredProposal): ExistingLine {
  const target =
    proposal.exclusionPosition !== null
      ? eq(mapExclusions.position, proposal.exclusionPosition)
      : proposal.waypointId !== null
        ? eq(mapExclusions.waypointId, proposal.waypointId)
        : null;
  if (target === null) {
    throw new Error(
      `Map proposal ${proposal.id} has no line of its own, none it names, no waypoint`,
    );
  }
  const line = tx
    .select({ position: mapExclusions.position, splitMapId: mapExclusions.splitMapId })
    .from(mapExclusions)
    .where(and(eq(mapExclusions.mapId, proposal.mapId), target))
    .get();
  if (line === undefined) {
    throw new Error(`The Out of scope line map proposal ${proposal.id} takes over does not exist`);
  }
  return line;
}

/** Links the map's unlinked Out of scope line at `position` to the new map. */
function linkLine(tx: Tx, mapId: string, position: number, newMapId: string): void {
  const linked = tx
    .update(mapExclusions)
    .set({ splitMapId: newMapId })
    .where(
      and(
        eq(mapExclusions.mapId, mapId),
        eq(mapExclusions.position, position),
        isNull(mapExclusions.splitMapId),
      ),
    )
    .run();
  if (linked.changes !== 1) {
    throw new Error(`Map ${mapId} has no unlinked Out of scope line at ${String(position)}`);
  }
}

/**
 * Dismisses a pending proposal (map proposals): an outside proposal's own line is saved on its map
 * as a plain Out of scope line; a split offer's is not, its work staying in this map (idea-phase
 * split); one attached to a ruled-out waypoint or naming an existing line saves nothing more, so
 * that line stays as it is. The map's destination, waypoints and fog are untouched. Refuses an unknown proposal and a
 * decided one (`proposal_already_decided`), writing nothing. The value is the proposal's map.
 */
export function dismissProposal(
  actor: UserActor,
  db: ZeNormDatabase,
  input: DismissProposalInput,
): Result<string, DismissProposalError> {
  return write(db, actor, (tx): Result<string, DismissProposalError> => {
    const pending = pendingProposal(tx, input.proposalId);
    if (!pending.ok) {
      return pending;
    }
    const proposal = pending.value;
    // A dismissed split offer keeps its work in this map: its line is never saved.
    if (proposal.kind === "outside" && proposal.line !== null) {
      saveExclusion(
        tx,
        { id: proposal.createdByRun, mapId: proposal.mapId },
        proposal.line,
        null,
        null,
      );
    }
    decide(tx, proposal.id, { state: "dismissed" });
    planAndRelease(actor, tx, proposal.mapId);
    return ok(proposal.mapId);
  });
}
