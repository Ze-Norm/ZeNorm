import { err, ok } from "@zenorm/contracts";
import type {
  MapNotFoundError,
  MapOverview,
  MapOverviewDetail,
  MapRecord,
  MapSpec,
  PlanningRun,
  Project,
  ProjectMapContext,
  ProjectProposalContext,
  Result,
  SpecRun,
  Stage,
  StageTone,
  WaypointReviewFinding,
  Wayfinding,
} from "@zenorm/contracts";
import { maps, projects, specifications, specWaits } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, desc, eq } from "drizzle-orm";

import { deliveryOutcome, readRuns, readSpecRuns } from "./delivery.ts";
import { readHatchChanges, readHatchMessages } from "./hatch-messages.ts";
import { mapActivity } from "./map-activity.ts";
import type {
  ActivityReview,
  ActivitySpec,
  ActivityTicketsReview,
  ActivityTouch,
  ActivityWait,
} from "./map-activity.ts";
import { readMapsOfProject } from "./map.ts";
import { deriveStatus, reachedStage } from "./map-status.ts";
import type { ReachedSpec, StatusReview, StatusRevision, StatusSpec } from "./map-status.ts";
import type { FrontierInput, Reader } from "./planning-runs.ts";
import {
  mapRecordColumns,
  readBlockers,
  readMap,
  readMapRuns,
  readRounds,
  readWaypoints,
  specRuns,
  waypointState,
} from "./planning-runs.ts";
import { toProject } from "./project.ts";
import { readEscalatedFindings } from "./review-findings.ts";
import type { EscalatedFinding } from "./review-findings.ts";
import { specRunViews } from "./run-tickets.ts";
import { mapSpecViews } from "./spec-views.ts";
import { deliveredRunOf, waypointTouchViews } from "./spec-context.ts";
import { mapWaits } from "./spec-waits.ts";
import {
  earlierReviews,
  latestOf,
  readMapSpecs,
  readRejections,
  readReview,
  readSetVersion,
  readSpecRevisions,
  readTicketSetOf,
  readTicketsReview,
  toTicketsDue,
} from "./specs.ts";
import type { StoredRevision, StoredSpec } from "./specs.ts";
import {
  outOfScopeLines,
  readExclusions,
  readFindings,
  readFog,
  readPasses,
  readProjectProposals,
  readProposals,
  readReports,
  readTaskOutcomes,
} from "./wayfinding-records.ts";
import { ticketSetReview } from "./tickets-reviews.ts";
import { present } from "./present.ts";

/** The in-memory runner state the server holds and `mapStatus` reads. */
export interface RunnerStates {
  /** Whether the delivery runner holds a run: an active run it does not hold is `interrupted`. */
  readonly deliveryHeld: (runId: string) => boolean;
}

/** Ascending by number. */
function byNumber<T extends { number: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.number - b.number);
}

/**
 * The stored rows a map's status reads, once: `overviewOf` builds its overview from them, and
 * another map's overview reads that map's first next action from them (`revisedLater`) without
 * building a second overview.
 */
function statusInputOf(db: Reader, map: MapRecord, project: Project, runners: RunnerStates) {
  const rounds = readRounds(db, map.id);
  const mapWaypoints = readWaypoints(db, map.id);
  const blockers = readBlockers(db, map.id);
  const planningRuns = readMapRuns(db, map.id);
  const specs = readMapSpecs(db, map.id);
  const specRuns = new Map(
    specs.map((spec) => [spec.id, specRunViews(db, spec.id, runners.deliveryHeld)]),
  );
  const runsOf = (specificationId: string): SpecRun[] => {
    const runs = specRuns.get(specificationId);
    if (runs === undefined) {
      throw new Error(`Spec ${specificationId} is not a spec of map ${map.id}`);
    }
    return runs;
  };

  const reports = readReports(db, map.id);
  const outcomes = readTaskOutcomes(db, map.id);
  const runOutcomes = { reports, taskOutcomes: outcomes };
  const fog = readFog(db, map.id);
  const passes = readPasses(db, map.id);
  const waits = mapWaits(db, map, mapWaypoints, planningRuns);
  const common = {
    map,
    rounds,
    waypoints: mapWaypoints,
    blockers,
    planningRuns,
    startDeliveryBlockers: project.startDeliveryBlockers,
    activeRun: project.activeRun,
    runOutcomes,
    fogCount: fog.length,
    passes,
    waits,
  };
  const derived = deriveStatus({
    ...common,
    specs: specs.map((spec) => statusSpec(db, map.id, spec, runsOf(spec.id))),
  });
  return { ...common, specs, runsOf, reports, outcomes, fog, derived };
}

/** The headline of a map's first next action, from its status alone. */
function firstHeadline(db: Reader, mapId: string, project: Project, runners: RunnerStates): string {
  const [first] = statusInputOf(db, readMap(db, mapId), project, runners).derived.status.next;
  if (first === undefined) {
    throw new Error(`Map ${mapId}'s status has no next action`);
  }
  return first.headline;
}

function overviewOf(
  db: Reader,
  map: MapRecord,
  project: Project,
  runners: RunnerStates,
): MapOverviewDetail {
  const input = statusInputOf(db, map, project, runners);
  const {
    rounds,
    waypoints: mapWaypoints,
    blockers,
    planningRuns,
    specs,
    runsOf,
    reports,
    outcomes,
    runOutcomes,
    fog,
    passes,
    waits,
  } = input;
  const { status, specStages } = input.derived;
  const mapRounds = byNumber(rounds.filter((round) => round.waypointId === null));
  const exclusions = readExclusions(db, map.id);
  const findings = readFindings(db, map.id);
  const escalated = readEscalatedFindings(db, map.id);
  const touches = new Map(
    mapWaypoints.map((waypoint) => [waypoint.id, waypointTouchViews(db, waypoint.id)]),
  );
  const touchesOf = (waypointId: string) => {
    const views = touches.get(waypointId);
    if (views === undefined) {
      throw new Error(`Waypoint ${waypointId} is not a waypoint of map ${map.id}`);
    }
    return views;
  };
  const frontierInput: FrontierInput = {
    map,
    waypoints: mapWaypoints,
    blockers,
    runs: planningRuns,
    outcomes: runOutcomes,
  };
  const wayfinding: Wayfinding = {
    mapRounds,
    waypoints: mapWaypoints.map((waypoint) => {
      const finding = findings.find((candidate) => candidate.waypointId === waypoint.id);
      const exclusion = exclusions.find((candidate) => candidate.waypointId === waypoint.id);
      return {
        ...waypoint,
        blockedBy: blockers
          .filter((blocker) => blocker.waypointNumber === waypoint.number)
          .map((blocker) => blocker.blockerNumber),
        rounds: byNumber(rounds.filter((round) => round.waypointId === waypoint.id)),
        reports: reports
          .filter((report) => report.waypointId === waypoint.id)
          .map((report) => ({
            runId: report.runId,
            answered: report.answered,
            summary: report.summary,
            gap: report.gap,
            findings: report.findings,
            sources: report.sources,
            limitations: report.limitations,
            uncertainties: report.uncertainties,
          })),
        taskOutcomes: outcomes
          .filter((outcome) => outcome.waypointId === waypoint.id)
          .map((outcome) => ({
            runId: outcome.runId,
            outcome: outcome.outcome,
            action: outcome.action,
            facts: outcome.facts,
          })),
        finding:
          finding === undefined
            ? null
            : {
                kind: finding.kind,
                waypointNumbers: finding.waypointNumbers,
                explanation: finding.explanation,
              },
        reviewFinding: reviewFindingView(
          // The page shows the finding that opened the waypoint; its grilling reads them all.
          escalated.find((candidate) => candidate.waypointId === waypoint.id),
        ),
        exclusion: exclusion === undefined ? null : exclusion.text,
        state: waypointState(frontierInput, rounds, waypoint),
        touches: touchesOf(waypoint.id),
      };
    }),
    fog,
    outOfScope: outOfScopeLines(exclusions, mapWaypoints),
    proposals: readProposals(db, map.id, mapWaypoints),
  };
  const headlines = new Map<string, string>();
  const headlineOf = (mapId: string): string => {
    const known = headlines.get(mapId);
    if (known !== undefined) {
      return known;
    }
    const headline = firstHeadline(db, mapId, project, runners);
    headlines.set(mapId, headline);
    return headline;
  };
  const specViews = mapSpecViews(
    db,
    map.id,
    planningRuns,
    runsOf,
    (spec) => {
      const stages = specStages.get(spec.id);
      if (stages === undefined) {
        throw new Error(`Spec ${spec.id} of map ${map.id} has no derived stages`);
      }
      return stages;
    },
    headlineOf,
  );
  const activity = mapActivity({
    map,
    rounds,
    waypoints: mapWaypoints,
    blockers,
    planningRuns,
    specs: specs.map((spec) => activitySpec(db, map.id, spec, planningRuns)),
    reports,
    taskOutcomes: outcomes,
    exclusions,
    passes,
    hatchChanges: readHatchChanges(db, map.id),
    waits: activityWaits(db, map.id),
    touches: mapWaypoints.flatMap((waypoint) =>
      touchesOf(waypoint.id).map((touch): ActivityTouch => ({
        waypoint: waypoint.number,
        specTitle: touch.specTitle,
        delivered: touch.criteria.some((criterion) => criterion.delivered),
      })),
    ),
  });
  return {
    map,
    project,
    status,
    activity,
    wayfinding,
    specs: specViews,
    messages: readHatchMessages(db, map.id, planningRuns),
    defaultSpecs: {
      spec: defaultSpec(specViews, "spec"),
      tickets: defaultSpec(specViews, "tickets"),
      delivery: defaultSpec(specViews, "delivery"),
    },
    waits,
  };
}

/** A spec's own status on one of its three stages. */
function specTone(spec: MapSpec, stage: keyof MapOverviewDetail["defaultSpecs"]): StageTone {
  const [specStatus, tickets, delivery] = spec.stages;
  switch (stage) {
    case "spec":
      return specStatus.tone;
    case "tickets":
      return tickets.tone;
    case "delivery":
      return delivery.tone;
  }
}

/**
 * The number of the spec a stage shows without a spec number: the first that needs you there, else
 * the first being worked, else the first; null while the map has none.
 */
export function defaultSpec(
  specs: readonly MapSpec[],
  stage: keyof MapOverviewDetail["defaultSpecs"],
): number | null {
  for (const tone of ["needs-you", "working"]) {
    const spec = specs.find((candidate) => specTone(candidate, stage) === tone);
    if (spec !== undefined) {
      return spec.number;
    }
  }
  const [first] = specs;
  if (first === undefined) {
    return null;
  }
  return first.number;
}

/** The planning review finding that sent a waypoint on, as its page shows it. */
function reviewFindingView(finding: EscalatedFinding | undefined): WaypointReviewFinding | null {
  if (finding === undefined) {
    return null;
  }
  return {
    spec: finding.spec.number,
    specTitle: finding.spec.title,
    explanation: finding.explanation,
    elementIds: [...finding.elementIds],
  };
}

/** A revision's review as the status reads it: an escalated finding sends it on. */
function statusReview(db: Reader, revision: StoredRevision): StatusReview {
  const stored = readReview(db, revision);
  if (stored === null) {
    return "pending";
  }
  if (stored.review.passed) {
    return "passed";
  }
  return stored.findings.some((finding) => finding.escalated) ? "escalated" : "findings";
}

/**
 * A spec's stored rows the status reads: every revision, those on this map as the status reads
 * them, the map's latest approved revision, its ticket set and that set's current content.
 */
function specStatusRows(db: Reader, mapId: string, spec: StoredSpec) {
  const all = readSpecRevisions(db, spec.id);
  const onMap = all.filter((revision) => revision.mapId === mapId);
  const approved = onMap.filter((revision) => revision.approvedAt !== null).at(-1);
  const set = approved === undefined ? undefined : readTicketSetOf(db, approved.id);
  const current = set === undefined ? undefined : readSetVersion(db, set.id, set.version).content;
  const revisions: StatusRevision[] = onMap.map((revision) => ({
    revision: revision.revision,
    clauses: revision.content.clauses.length,
    approvedAt: revision.approvedAt,
    supersededAt: revision.supersededAt,
    review: statusReview(db, revision),
  }));
  const written =
    approved === undefined || set === undefined || current === undefined
      ? null
      : {
          approved,
          set,
          current,
          // As the Tickets page reads it (`spec-views.ts`).
          replaced: set.state !== "approved" && approved.revision !== latestOf(all).revision,
        };
  return { all, revisions, set, written };
}

/** One spec as `deriveStatus` reads it: its revisions on this map, its set and its runs. */
function statusSpec(db: Reader, mapId: string, spec: StoredSpec, runs: SpecRun[]): StatusSpec {
  const { all, revisions, set, written } = specStatusRows(db, mapId, spec);
  return {
    id: spec.id,
    number: spec.number,
    revisions,
    ticketSet:
      written === null
        ? null
        : {
            tickets: written.current.tickets.length,
            approvedAt: written.set.approvedAt,
            review: ticketSetReview(
              db,
              specRuns(readMapRuns(db, mapId), spec.id),
              written.set,
              true,
            ),
            follows: all.some(
              (revision) =>
                revision.revision < written.approved.revision && revision.approvedAt !== null,
            ),
            replaced: written.replaced,
            anyDelivered: written.current.dispositions.some(
              (disposition) => disposition.kind === "delivered",
            ),
          },
    ticketsDue: toTicketsDue(db, mapId, spec.id),
    // Only the runs of this map's approved revision's set.
    runs: set === undefined ? [] : runs.filter((run) => run.ticketSetId === set.id),
  };
}

/**
 * One spec as `reachedStage` reads it: as `statusSpec`, its runs by their stored outcome, never the
 * runner's state.
 */
function reachedSpec(db: Reader, mapId: string, spec: StoredSpec): ReachedSpec {
  const { revisions, set, written } = specStatusRows(db, mapId, spec);
  return {
    id: spec.id,
    number: spec.number,
    revisions,
    ticketSet:
      written === null
        ? null
        : {
            tickets: written.current.tickets.length,
            approvedAt: written.set.approvedAt,
            replaced: written.replaced,
          },
    runs:
      set === undefined
        ? []
        : readSpecRuns(db, spec.id)
            .filter((run) => run.ticketSetId === set.id)
            .map((run) => ({ mergedAt: run.mergedAt, outcome: deliveryOutcome(run) })),
  };
}

/** The stage a map has reached (`reachedStage`), from its stored rows alone. */
function readReachedStage(db: Reader, map: MapRecord): Stage {
  const mapWaypoints = readWaypoints(db, map.id);
  const planningRuns = readMapRuns(db, map.id);
  return reachedStage({
    map,
    rounds: readRounds(db, map.id),
    waypoints: mapWaypoints,
    planningRuns,
    fogCount: readFog(db, map.id).length,
    passes: readPasses(db, map.id),
    waits: mapWaits(db, map, mapWaypoints, planningRuns),
    specs: readMapSpecs(db, map.id).map((spec) => reachedSpec(db, map.id, spec)),
  });
}

/**
 * Every map of the project, this map included, oldest first, with its title (null until charted)
 * and the stage it has reached, as a run that can suggest maps reads them.
 */
export function readProjectMaps(db: Reader, projectId: string): ProjectMapContext[] {
  return readMapsOfProject(db, projectId).map((map) => ({
    title: map.title,
    stage: readReachedStage(db, map),
  }));
}

/** What every run that can suggest maps reads of its map's project: its suggestions and maps. */
export function projectSuggestionContext(
  db: Reader,
  projectId: string,
): { projectProposals: ProjectProposalContext[]; projectMaps: ProjectMapContext[] } {
  return {
    projectProposals: readProjectProposals(db, projectId),
    projectMaps: readProjectMaps(db, projectId),
  };
}

/** A run's end; a run that recorded a review has ended (a missing one is a programmer error). */
function endedAt(runs: readonly PlanningRun[], runId: string): string {
  const run = runs.find((candidate) => candidate.id === runId);
  if (run?.endedAt == null) {
    throw new Error(`Review run ${runId} is not an ended run of the map`);
  }
  return run.endedAt;
}

/**
 * A revision's review outcomes for the activity, oldest first, each at its run's end: the
 * reviews of content a rewrite in place replaced, then the review of its current content.
 */
function activityReviews(
  db: Reader,
  revision: StoredRevision,
  scope: readonly PlanningRun[],
  runs: readonly PlanningRun[],
): ActivityReview[] {
  const current = readReview(db, revision);
  return [...earlierReviews(db, revision), ...(current === null ? [] : [current])].map(
    (stored): ActivityReview => {
      const at = endedAt(runs, stored.review.runId);
      if (stored.review.passed) {
        return { outcome: "passed", at };
      }
      const escalated = stored.findings.flatMap((finding) =>
        finding.waypointId === null ? [] : [finding.waypointId],
      );
      if (escalated.length > 0) {
        const numbers = readWaypoints(db, revision.mapId)
          .filter((waypoint) => escalated.includes(waypoint.id))
          .map((waypoint) => waypoint.number);
        return { outcome: "escalated", at, waypoints: numbers };
      }
      // A repair starts in the transaction recording the review, so it starts at or after its end.
      const repairing = scope.some(
        (run) => run.purpose === "to_spec" && Date.parse(run.startedAt) >= Date.parse(at),
      );
      return { outcome: "findings", at, findings: stored.findings.length, repairing };
    },
  );
}

/** A ticket set version's recorded tickets review for the activity, at its run's end. */
function activityTicketsReview(
  db: Reader,
  ticketSetId: string,
  version: number,
  runs: readonly PlanningRun[],
): ActivityTicketsReview | null {
  const recorded = readTicketsReview(db, ticketSetId, version);
  if (recorded === null) {
    return null;
  }
  const at = endedAt(runs, recorded.review.runId);
  if (recorded.review.passed) {
    return { outcome: "passed", at };
  }
  return {
    outcome: "findings",
    at,
    findings: recorded.findings.length,
    held: recorded.findings.some((finding) => finding.escalated),
  };
}

/**
 * One spec as the activity reads it: its revisions on this map, each marked when it revises
 * a spec an earlier map delivered, and the ticket set of each revision it approved.
 */
function activitySpec(
  db: Reader,
  mapId: string,
  spec: StoredSpec,
  runs: readonly PlanningRun[],
): ActivitySpec {
  const all = readSpecRevisions(db, spec.id);
  const scope = specRuns(runs, spec.id);
  const revisions = all.filter((revision) => revision.mapId === mapId);
  const laterMapOfDelivered = (revision: StoredRevision): boolean => {
    const before = all.find((candidate) => candidate.revision === revision.revision - 1);
    return (
      before !== undefined &&
      before.mapId !== mapId &&
      all.some(
        (candidate) =>
          candidate.revision < revision.revision &&
          deliveredRunOf(db, spec.id, candidate.revision) !== null,
      )
    );
  };
  return {
    id: spec.id,
    number: spec.number,
    revisions: revisions.map((revision) => ({
      title: revision.content.title,
      first: revision.revision === 1,
      laterMapOfDelivered: laterMapOfDelivered(revision),
      writtenAt: revision.createdAt,
      writtenByRun: revision.writtenByRun,
      reviews: activityReviews(db, revision, scope, runs),
      approvedAt: revision.approvedAt,
      rejection:
        revision.rejectionReason === null
          ? null
          : {
              reason: revision.rejectionReason,
              at: present(revision.supersededAt, `Rejected revision ${revision.id}'s time`),
            },
    })),
    ticketSets: revisions.flatMap((approved) => {
      if (approved.approvedAt === null) {
        return [];
      }
      const set = readTicketSetOf(db, approved.id);
      if (set === undefined) {
        return [];
      }
      return [
        {
          title: approved.content.title,
          revision: approved.revision,
          follows: all.some(
            (revision) => revision.revision < approved.revision && revision.approvedAt !== null,
          ),
          revisionApprovedAt: approved.approvedAt,
          versions: Array.from({ length: set.version }, (_, index) => {
            const version = readSetVersion(db, set.id, index + 1);
            return {
              tickets: version.content.tickets.length,
              dispositions: version.content.dispositions.map((disposition) => disposition.kind),
              writtenAt: version.createdAt,
              writtenByRun: version.writtenByRun,
              review: activityTicketsReview(db, set.id, index + 1, runs),
            };
          }),
          approvedAt: set.approvedAt,
          rejections: readRejections(db, set.id).map((rejection) => ({
            reason: rejection.reason,
            at: rejection.rejectedAt,
          })),
          runs: readRuns(db, set.id),
        },
      ];
    }),
  };
}

/**
 * Every wait the map recorded, open, released or landed, with the hold it was
 * recorded under (its stored kind, map and revision), never the live one.
 */
function activityWaits(db: Reader, mapId: string): ActivityWait[] {
  return db
    .select({
      specificationId: specWaits.specificationId,
      specNumber: specifications.number,
      since: specWaits.since,
      holdKind: specWaits.holdKind,
      holdMapId: specWaits.holdMapId,
      releasedAt: specWaits.releasedAt,
    })
    .from(specWaits)
    .innerJoin(specifications, eq(specifications.id, specWaits.specificationId))
    .where(eq(specWaits.mapId, mapId))
    .orderBy(asc(specWaits.since), asc(specWaits.id))
    .all()
    .map((row) => {
      const holder = readMap(db, row.holdMapId).title;
      if (holder === null) {
        throw new Error(`Map ${row.holdMapId} holds a spec with no title`);
      }
      return {
        specNumber: row.specNumber,
        specTitle: latestOf(readSpecRevisions(db, row.specificationId)).content.title,
        since: row.since,
        holdKind: row.holdKind,
        holdMapTitle: holder,
        releasedAt: row.releasedAt,
      };
    });
}

/**
 * Every Project row's derived Project, by id; the filesystem and git checks run here, one project
 * after another. Deriving them all at once is faster on a quiet server, but every open page reads
 * this on every change, and the bursts of git processes slowed the agent's runs and the browser:
 * with four e2e workers the delivery flows took half again as long.
 */
async function deriveProjects(db: ZeNormDatabase): Promise<Map<string, Project>> {
  const derived = new Map<string, Project>();
  for (const row of db.select().from(projects).all()) {
    derived.set(row.id, await toProject(db, row));
  }
  return derived;
}

/**
 * Every map with its project and status, newest first. The projects are derived
 * first (awaiting the filesystem and git); every database read then runs in one synchronous
 * transaction, so the maps, rounds, waypoints and runs are one snapshot. A map whose project
 * was added after the derivation sends the read round again with that project derived.
 */
export async function listMapOverviews(
  db: ZeNormDatabase,
  runners: RunnerStates,
): Promise<MapOverview[]> {
  for (;;) {
    const derived = await deriveProjects(db);
    const overviews = db.transaction((tx): MapOverview[] | null => {
      const rows = tx
        .select(mapRecordColumns)
        .from(maps)
        .orderBy(desc(maps.createdAt), desc(maps.id))
        .all();
      const result: MapOverview[] = [];
      for (const map of rows) {
        const project = derived.get(map.projectId);
        if (project === undefined) {
          const added = tx.select().from(projects).where(eq(projects.id, map.projectId)).get();
          if (added === undefined) {
            throw new Error(`Map ${map.id} references missing project ${map.projectId}`);
          }
          return null;
        }
        const { status } = overviewOf(tx, map, project, runners);
        result.push({ map, project, status });
      }
      return result;
    });
    if (overviews !== null) return overviews;
  }
}

/**
 * The map's one snapshot: project, status, activity and Wayfinding. The project is derived first;
 * the map and everything else are then read in one synchronous transaction.
 */
export async function getMapOverview(
  db: ZeNormDatabase,
  mapId: string,
  runners: RunnerStates,
): Promise<Result<MapOverviewDetail, MapNotFoundError>> {
  const first = db.select().from(maps).where(eq(maps.id, mapId)).get();
  if (first === undefined) {
    return err({ code: "map_not_found", message: `No map with id ${mapId}`, data: { mapId } });
  }
  const projectRow = db.select().from(projects).where(eq(projects.id, first.projectId)).get();
  if (projectRow === undefined) {
    throw new Error(`Map ${mapId} references missing project ${first.projectId}`);
  }
  const project = await toProject(db, projectRow);
  return db.transaction((tx) => {
    // A map is never removed and never changes project, so the re-read finds it.
    const map = tx.select(mapRecordColumns).from(maps).where(eq(maps.id, mapId)).get();
    if (map === undefined) throw new Error(`Map ${mapId} disappeared`);
    return ok(overviewOf(tx, map, project, runners));
  });
}
