import { ok } from "@zenorm/contracts";
import type {
  ProjectDetail,
  ProjectNotFoundError,
  Result,
  MapSpec,
  PlanningRun,
  ProjectSpec,
  SpecRevisionReview,
  SpecRun,
  SpecRevisionContent,
  SpecRevisionView,
  ClauseSourceView,
  TicketSetView,
} from "@zenorm/contracts";
import { maps, planningRuns, waypoints } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { eq } from "drizzle-orm";

import { deliveryOutcome, readSpecRuns } from "./delivery.ts";
import { readWaypoints, scopeRun, specRuns } from "./planning-runs.ts";
import { deliveryOf, readSpecRecord, removedCriteria, textDelta } from "./reconciliation.ts";
import type { SpecRecord } from "./reconciliation.ts";
import { deliveredRunOf, readingsOf } from "./spec-context.ts";
import { getProject } from "./project.ts";
import type { Reader } from "./planning-runs.ts";
import {
  latestOf,
  readMapSpecs,
  readProjectSpecs,
  readRejections,
  readReview,
  readSetVersion,
  readSpecRevisions,
  readTicketSetOf,
  revisionState,
} from "./specs.ts";
import type { StoredRevision, StoredSpec } from "./specs.ts";
import { ticketSetReview } from "./tickets-reviews.ts";

function mapTitleOf(db: Reader, mapId: string): string {
  const row = db.select({ title: maps.title }).from(maps).where(eq(maps.id, mapId)).get();
  if (row?.title == null) {
    throw new Error(`Map ${mapId} wrote a revision but has no title`);
  }
  return row.title;
}

function runEnd(db: Reader, runId: string): string {
  const row = db
    .select({ endedAt: planningRuns.endedAt })
    .from(planningRuns)
    .where(eq(planningRuns.id, runId))
    .get();
  if (row?.endedAt == null) {
    throw new Error(`Review run ${runId} has not ended`);
  }
  return row.endedAt;
}

function waypointNumber(db: Reader, waypointId: string): number {
  const row = db
    .select({ number: waypoints.number })
    .from(waypoints)
    .where(eq(waypoints.id, waypointId))
    .get();
  if (row === undefined) {
    throw new Error(`No waypoint with id ${waypointId}`);
  }
  return row.number;
}

/** A revision's review: the stored one, else the latest revision's review run, else pending. */
function reviewView(
  db: Reader,
  revision: StoredRevision,
  latest: boolean,
  runs: readonly PlanningRun[],
): SpecRevisionReview {
  const stored = readReview(db, revision);
  if (stored !== null) {
    const reviewedAt = runEnd(db, stored.review.runId);
    if (stored.review.passed) {
      return { state: "passed", summary: stored.review.summary, reviewedAt };
    }
    return {
      state: "findings",
      summary: stored.review.summary,
      reviewedAt,
      findings: stored.findings.map((finding) => ({
        kind: finding.kind,
        route: finding.route,
        title: finding.title,
        explanation: finding.explanation,
        question: finding.question,
        elementIds: finding.elementIds,
        waypointNumbers: finding.waypointNumbers,
        escalated: finding.escalated,
        waypoint: finding.waypointId === null ? null : waypointNumber(db, finding.waypointId),
      })),
    };
  }
  const reviewRun = runs.at(-1);
  if (latest && reviewRun?.purpose === "spec_review") {
    const shown = scopeRun(runs);
    if (shown === "working") {
      return { state: "running" };
    }
    if (shown !== null) {
      return { state: "stopped", stopped: shown.stopped };
    }
  }
  return { state: "pending" };
}

/**
 * Each clause's sources in revision `n`, walked back through every revision up to `n` that holds
 * the clause (the demo's `clauseSources`): a revision keeps the sources of the clause it carries
 * over and adds its own map's, each once. A revision adds its sources only where it wrote the
 * clause or changed it (title, text, criteria or sources) from the revision before: a clause
 * carried over unchanged lists no sources of its own in the demo, so its sources stay credited to
 * the maps that wrote it, though the agent repeats them (S8b-16, N-2).
 */
function clauseSources(
  db: Reader,
  record: SpecRecord,
  n: number,
): Record<string, ClauseSourceView[]> {
  const revision = record.revisions.find((candidate) => candidate.revision === n);
  if (revision === undefined) {
    throw new Error(`The spec has no r${String(n)}`);
  }
  const sources: Record<string, ClauseSourceView[]> = {};
  for (const clause of revision.content.clauses) {
    const found: ClauseSourceView[] = [];
    const seen = new Set<string>();
    let previous: SpecRevisionContent["clauses"][number] | undefined;
    for (const earlier of record.revisions) {
      if (earlier.revision > n) break;
      const before = previous;
      const held = earlier.content.clauses.find((candidate) => candidate.id === clause.id);
      previous = held;
      if (held === undefined) continue;
      if (before !== undefined && sameClause(before, held)) continue;
      for (const source of held.sources) {
        const view = sourceView(db, earlier.mapId, source);
        const key = JSON.stringify(view);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(view);
      }
    }
    sources[clause.id] = found;
  }
  return sources;
}

/** Whether a clause reads the same in two revisions: title, text, criteria and sources. */
function sameClause(
  before: SpecRevisionContent["clauses"][number],
  after: SpecRevisionContent["clauses"][number],
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function sourceView(
  db: Reader,
  mapId: string,
  source: SpecRevisionView["content"]["clauses"][number]["sources"][number],
): ClauseSourceView {
  if (source.kind !== "waypoint") {
    return { kind: source.kind, mapId, mapTitle: mapTitleOf(db, mapId) };
  }
  const waypoint = readWaypoints(db, mapId).find((candidate) => candidate.number === source.number);
  if (waypoint === undefined) {
    throw new Error(`A clause comes from waypoint ${String(source.number)}, not on map ${mapId}`);
  }
  return {
    kind: "waypoint",
    mapId,
    mapTitle: mapTitleOf(db, mapId),
    waypointNumber: source.number,
    waypointTitle: waypoint.title,
    waypointKind: waypoint.kind,
    waypointGist: waypoint.gist,
  };
}

function revisionView(
  db: Reader,
  record: SpecRecord,
  revision: StoredRevision,
  latest: boolean,
  runs: readonly PlanningRun[],
): SpecRevisionView {
  return {
    id: revision.id,
    revision: revision.revision,
    mapId: revision.mapId,
    mapTitle: mapTitleOf(db, revision.mapId),
    state: revisionState(revision),
    content: revision.content,
    savedAt: revision.createdAt,
    approvedAt: revision.approvedAt,
    supersededAt: revision.supersededAt,
    rejectionReason: revision.rejectionReason,
    review: reviewView(db, revision, latest, runs),
    delta: textDelta(record, revision.revision),
    takenOut: removedCriteria(record, revision.revision),
    clauseSources: clauseSources(db, record, revision.revision),
    deliveredRun: deliveredRunOf(db, revision.specificationId, revision.revision),
  };
}

/**
 * The earlier delivered ticket each ticket of the set follows up (S8b-14): the newest earlier set's
 * ticket of that id that a merged run delivered.
 */
function followUpsOf(
  db: Reader,
  record: SpecRecord,
  revision: number,
  content: TicketSetView["content"],
): TicketSetView["followUps"] {
  const followUps: TicketSetView["followUps"] = {};
  for (const ticket of content.tickets) {
    if (ticket.followUp === null) continue;
    const earlier = ticket.followUp;
    const delivery = [...record.sets]
      .reverse()
      .filter((set) => set.revision < revision && set.content.tickets.some((t) => t.id === earlier))
      .map((set) => deliveryOf(record, set.id, earlier))
      .find((found) => found !== null);
    if (delivery === undefined) {
      throw new Error(`Ticket ${ticket.id} follows up ${earlier}, which no earlier run delivered`);
    }
    followUps[ticket.id] = {
      ticket: earlier,
      revision: delivery.revision,
      run: delivery.run,
      commit: delivery.commit,
      mapId: delivery.mapId,
      mapTitle: mapTitleOf(db, delivery.mapId),
    };
  }
  return followUps;
}

/**
 * The set written for `revision`, with its review from the one read (slice 7c D11);
 * `latestApproved` when the revision is the spec's latest approved one, whose set its runs act on.
 */
function ticketSetView(
  db: Reader,
  record: SpecRecord,
  revision: StoredRevision,
  scope: readonly PlanningRun[],
  latestApproved: boolean,
  specLatest: number,
): TicketSetView | null {
  const set = readTicketSetOf(db, revision.id);
  if (set === undefined) {
    return null;
  }
  const current = readSetVersion(db, set.id, set.version);
  return {
    id: set.id,
    revision: revision.revision,
    state: set.state,
    version: set.version,
    content: current.content,
    savedAt: current.createdAt,
    approvedAt: set.approvedAt,
    rejections: readRejections(db, set.id).map((rejection) => ({
      version: rejection.version,
      reason: rejection.reason,
      rejectedAt: rejection.rejectedAt,
    })),
    review: ticketSetReview(db, scope, set, latestApproved),
    replaced: set.state !== "approved" && revision.revision !== specLatest,
    readings: readingsOf(
      record,
      revision.revision,
      textDelta(record, revision.revision),
      current.content.dispositions,
    ),
    followUps: followUpsOf(db, record, revision.revision, current.content),
  };
}

/**
 * The specs the map wrote a revision of (D7), by number, each with its revisions on every map,
 * its ticket sets, its `to_tickets`, its three stages, which `stagesOf` derives, and its delivery
 * runs, which `runsOf` reads (slice 8 D2).
 */
export function mapSpecViews(
  db: Reader,
  mapId: string,
  runs: readonly PlanningRun[],
  runsOf: (specificationId: string) => SpecRun[],
  stagesOf: (spec: StoredSpec) => MapSpec["stages"],
  headlineOf: (mapId: string) => string,
): MapSpec[] {
  return readMapSpecs(db, mapId).map((spec) => {
    const scope = specRuns(runs, spec.id);
    const revisions = readSpecRevisions(db, spec.id);
    const record = readSpecRecord(db, spec.id);
    const mine = Math.max(
      ...revisions.filter((revision) => revision.mapId === mapId).map((r) => r.revision),
    );
    const latest = latestOf(revisions);
    const shown = scope.at(-1)?.purpose === "to_tickets" ? scopeRun(scope) : null;
    const tickets = shown === "working" ? "running" : shown;
    const approved = revisions.filter((revision) => revision.approvedAt !== null).at(-1);
    return {
      id: spec.id,
      number: spec.number,
      title: latest.content.title,
      revisions: revisions.map((revision) =>
        revisionView(db, record, revision, revision.id === latest.id, scope),
      ),
      ticketSets: revisions.flatMap((revision) => {
        const view = ticketSetView(
          db,
          record,
          revision,
          scope,
          revision.id === approved?.id,
          latest.revision,
        );
        return view === null ? [] : [view];
      }),
      draftingTickets: tickets,
      stages: stagesOf(spec),
      runs: runsOf(spec.id),
      revisedLater: revisions
        .filter((revision) => revision.revision > mine && revision.mapId !== mapId)
        .map((revision) => ({
          revision: revision.revision,
          state: revisionState(revision),
          mapId: revision.mapId,
          mapTitle: mapTitleOf(db, revision.mapId),
          savedAt: revision.createdAt,
          headline: headlineOf(revision.mapId),
        })),
    };
  });
}

/** The project's specs once each (D12): number, latest title, state and writing map. */
export function projectSpecs(db: Reader, projectId: string): ProjectSpec[] {
  return readProjectSpecs(db, projectId).map((spec) => {
    const revisions = readSpecRevisions(db, spec.id);
    const latest = latestOf(revisions);
    // Newest first.
    const runs = readSpecRuns(db, spec.id);
    const active = runs.find((run) => deliveryOutcome(run) === "active");
    const merged = runs.find((run) => run.mergedAt !== null);
    const record = readSpecRecord(db, spec.id);
    const mergedSet =
      merged === undefined ? undefined : record.sets.find((set) => set.id === merged.ticketSetId);
    if (merged !== undefined && mergedSet === undefined) {
      throw new Error(`Merged run ${merged.id}'s ticket set is not of spec ${spec.id}`);
    }
    return {
      number: spec.number,
      title: latest.content.title,
      revisions: revisions.map((revision) => ({
        revision: revision.revision,
        state: revisionState(revision),
        mapId: revision.mapId,
        mapTitle: mapTitleOf(db, revision.mapId),
        savedAt: revision.createdAt,
      })),
      activeRun: active === undefined ? null : active.number,
      mergedRun:
        merged === undefined || mergedSet === undefined
          ? null
          : { number: merged.number, revision: mergedSet.revision },
    };
  });
}

/** `project.get` (D12): the project with each of its specs once, or `project_not_found`. */
export async function getProjectDetail(
  db: ZeNormDatabase,
  projectId: string,
): Promise<Result<ProjectDetail, ProjectNotFoundError>> {
  const found = await getProject(db, projectId);
  if (!found.ok) {
    return found;
  }
  return ok({ ...found.value, specs: projectSpecs(db, projectId) });
}
