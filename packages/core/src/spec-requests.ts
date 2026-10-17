import type {
  Disposition,
  DraftSpecsRequest,
  DraftTicketSetRequest,
  EarlierFindings,
  MapRecord,
  PlanningRun,
  ReviewSpecRequest,
  ReviseSpecRequest,
  ReviewTicketSetRequest,
  SpecFeedback,
  SpecRevisionRef,
  TicketsEarlierFindings,
  TouchingWaypoint,
} from "@zenorm/contracts";

import { readCodeSurvey } from "./code-survey.ts";
import { clauseReferences } from "./spec-references.ts";
import { deliveryOf, readSpecRecord, removedCriteria, textDelta } from "./reconciliation.ts";
import type { SpecRecord } from "./reconciliation.ts";
import {
  deliveredRunOf,
  openWaits,
  projectSpecContexts,
  readingsOf,
  runTouches,
  touchedSpecIds,
} from "./spec-context.ts";

import {
  readMap,
  readMapRuns,
  readWaypoints,
  runPositions,
  scopeRuns,
  specRuns,
} from "./planning-runs.ts";
import type { Reader } from "./planning-runs.ts";
import {
  earlierReviews,
  latestOf,
  noteAfter,
  readMapSpecs,
  readNoteDirectedRevisions,
  readNoteText,
  readReview,
  readReviews,
  readSpec,
  readDirectedVersions,
  readSpecRevisions,
  readTicketsReview,
  retiredIds,
} from "./specs.ts";
import { releasedWaitOf } from "./spec-holds.ts";
import type { StoredRevision } from "./specs.ts";
import { firstTicketNumber, pendingRewrite } from "./ticket-sets.ts";
import { readExclusions, readReports } from "./wayfinding-records.ts";
import { present } from "./present.ts";
import { approvedRevision, firstAttempt, reviewedVersion, runNote } from "./ticket-set-runs.ts";

/** The project and map fields every spec run's request carries. */
export interface SpecRunBase {
  readonly projectName: string;
  readonly projectFolder: string;
  readonly baseBranch: string;
  readonly idea: string;
}

/** The map a spec run reads: its title, destination, resolved waypoints and Out of scope. */
function specMapContext(db: Reader, map: MapRecord, base: SpecRunBase) {
  const reports = readReports(db, map.id);
  return {
    ...base,
    survey: readCodeSurvey(db, map.id),
    title: present(map.title, `Map ${map.id}'s title`),
    destination: present(map.destination, `Map ${map.id}'s destination`),
    waypoints: readWaypoints(db, map.id)
      .filter((waypoint) => waypoint.status === "resolved")
      .map((waypoint) => {
        const fields = {
          number: waypoint.number,
          title: waypoint.title,
          question: waypoint.question,
          resolution: present(waypoint.resolution, `Waypoint ${waypoint.id}'s resolution`),
          gist: present(waypoint.gist, `Waypoint ${waypoint.id}'s gist`),
          agentDecided: present(waypoint.agentDecided, `Waypoint ${waypoint.id}'s agentDecided`),
          touches: runTouches(db, waypoint.id),
        };
        if (waypoint.kind !== "research") {
          return { ...fields, kind: waypoint.kind };
        }
        // Its resolution is its latest report's summary (an answered report, or one accepted
        // through the hatch); reports are oldest first.
        const report = reports.filter((candidate) => candidate.waypointId === waypoint.id).at(-1);
        if (report === undefined) {
          throw new Error(`Resolved research waypoint ${waypoint.id} has no report`);
        }
        return {
          ...fields,
          kind: waypoint.kind,
          research: {
            findings: report.findings.map(({ title, detail }) => ({ title, detail })),
            sources: report.sources.map(({ title, url }) => ({ title, url })),
          },
        };
      }),
    outOfScope: readExclusions(db, map.id).map((exclusion) => exclusion.text),
    waits: openWaits(db, map.id),
  };
}

/** Each spec of the project the map has not written a revision of, with its hold. */
export function otherProjectSpecs(db: Reader, map: MapRecord) {
  const own = new Set(readMapSpecs(db, map.id).map((spec) => spec.id));
  return projectSpecContexts(db, map.projectId, map.id, own);
}

/** The map's resolved waypoints touching the spec, with their resolutions. */
function touchingWaypoints(db: Reader, mapId: string, specificationId: string): TouchingWaypoint[] {
  return readWaypoints(db, mapId)
    .filter(
      (waypoint) =>
        waypoint.status === "resolved" && touchedSpecIds(db, waypoint.id).includes(specificationId),
    )
    .map((waypoint) => ({
      number: waypoint.number,
      title: waypoint.title,
      resolution: present(waypoint.resolution, `Waypoint ${waypoint.id}'s resolution`),
    }));
}

/** Revision `n`'s text delta and criterion readings, against `dispositions` when given. */
function reconciliationOf(
  record: SpecRecord,
  n: number,
  dispositions: readonly Disposition[] | null,
) {
  const delta = textDelta(record, n);
  return {
    delta,
    readings: readingsOf(record, n, delta, dispositions),
    // Every criterion the set must take out, not only the delta's.
    takenOut: removedCriteria(record, n),
  };
}

/**
 * What revision `n` changes since the spec's latest approved revision before it: that
 * revision, who wrote it, and the clauses of `n` that a text delta from it through `n` marks new
 * or changed, the rest unchanged; null when no revision before `n` is approved.
 */
function changesOf(db: Reader, mapId: string, record: SpecRecord, n: number) {
  const since = record.revisions.filter((r) => r.revision < n && r.approved).at(-1);
  if (since === undefined) {
    return null;
  }
  const changed = new Set<string>();
  for (let k = since.revision + 1; k <= n; k += 1) {
    const delta = textDelta(record, k);
    if (delta === null) {
      throw new Error(`Revision ${String(k)} after r${String(since.revision)} has no delta`);
    }
    for (const [id, change] of Object.entries(delta.clauses)) {
      if (change !== "unchanged") changed.add(id);
    }
  }
  const reviewed = record.revisions.find((r) => r.revision === n);
  if (reviewed === undefined) {
    throw new Error(`The spec has no r${String(n)}`);
  }
  const ids = reviewed.content.clauses.map((clause) => clause.id);
  return {
    since: since.revision,
    writer:
      since.mapId === mapId
        ? { kind: "this-map" as const }
        : {
            kind: "another-map" as const,
            mapTitle: present(readMap(db, since.mapId).title, `Map ${since.mapId}'s title`),
          },
    changedClauses: ids.filter((id) => changed.has(id)),
    unchangedClauses: ids.filter((id) => !changed.has(id)),
  };
}

function revisionRef(specNumber: number, revision: StoredRevision): SpecRevisionRef {
  return { specNumber, revision: revision.revision, content: revision.content };
}

/**
 * Why a spec's latest revision gets a next one: the person's rejection reason; for a draft a note
 * superseded, the note; else its failed review's summary and every finding (escalated
 * ones included, so a `decision` review's `revise` findings reach the re-clear); null when it
 * has none of these.
 */
function feedbackOf(db: Reader, revision: StoredRevision): SpecFeedback | null {
  if (revision.rejectionReason !== null) {
    return { kind: "rejection", reason: revision.rejectionReason };
  }
  if (revision.supersededAt !== null) {
    // Only a note supersedes a latest revision without writing its next.
    const note = noteAfter(db, revision, null);
    if (note === null) {
      throw new Error(`Latest revision ${revision.id} is superseded with no rejection or note`);
    }
    return { kind: "note", text: note };
  }
  const reviewed = readReview(db, revision);
  if (reviewed === null || reviewed.review.passed) {
    return null;
  }
  return {
    kind: "review",
    summary: reviewed.review.summary,
    findings: reviewed.findings.map((finding) => ({
      kind: finding.kind,
      route: finding.route,
      title: finding.title,
      explanation: finding.explanation,
      question: finding.question,
      elementIds: finding.elementIds,
      waypointNumbers: finding.waypointNumbers,
    })),
  };
}

/**
 * The failed reviews of a spec's revisions before `latest`, and `latest`'s own reviews of content a
 * rewrite in place replaced, oldest first, on whichever map (the repair loop's memory); one
 * entry per review. Only revisions after the latest approved one (on any map) below `latest` count:
 * an approval closes the findings before it. A passed review adds nothing; `latest`'s
 * current review is its feedback, not an earlier finding.
 */
function earlierFindings(
  db: Reader,
  revisions: readonly StoredRevision[],
  latest: StoredRevision,
): EarlierFindings {
  const approved = revisions
    .filter((revision) => revision.revision < latest.revision && revision.approvedAt !== null)
    .at(-1);
  const after = approved === undefined ? 0 : approved.revision;
  return revisions
    .filter((revision) => revision.revision > after && revision.revision <= latest.revision)
    .flatMap((revision) =>
      (revision.id === latest.id ? earlierReviews(db, revision) : readReviews(db, revision.id))
        .filter(({ review }) => !review.passed)
        .map(({ findings }) => ({
          revision: revision.revision,
          findings: findings.map(({ kind, elementIds, explanation }) => ({
            kind,
            elementIds,
            explanation,
          })),
        })),
    );
}

/**
 * A map-scope `to_spec` run's request: on the map's first clear no spec; on a re-clear
 * each spec the map wrote, with its latest revision, whether that is approved, and its last
 * findings or rejection reason.
 */
export function draftSpecsRequest(
  db: Reader,
  map: MapRecord,
  run: PlanningRun,
  base: SpecRunBase,
  mapRounds: DraftSpecsRequest["mapRounds"],
): DraftSpecsRequest {
  return {
    ...specMapContext(db, map, base),
    mapRounds,
    projectSpecs: otherProjectSpecs(db, map),
    specs: readMapSpecs(db, map.id).map((spec) => {
      const revisions = readSpecRevisions(db, spec.id);
      const latest = latestOf(revisions);
      return {
        latest: revisionRef(spec.number, latest),
        retiredIds: retiredIds(revisions.map((revision) => revision.content)),
        approved: latest.approvedAt !== null,
        feedback: feedbackOf(db, latest),
      };
    }),
    refusedAttempt: mapRefusedAttempt(db, run),
  };
}

/**
 * The problem core refused a map-scope `to_spec`'s previous attempt with: the map
 * scope's run just before `run` (a retry, or a fresh run after Try again) when it is a `to_spec`
 * that failed `spec_content_invalid`; null otherwise.
 */
function mapRefusedAttempt(db: Reader, run: PlanningRun): DraftSpecsRequest["refusedAttempt"] {
  const scope = scopeRuns(readMapRuns(db, run.mapId), null);
  const previous = scope[scope.findIndex((candidate) => candidate.id === run.id) - 1];
  if (previous?.purpose !== "to_spec" || previous.errorCode !== "spec_content_invalid") {
    return null;
  }
  return { problem: present(previous.errorMessage, `Failed run ${previous.id}'s message`) };
}

/** The spec a spec-scoped run works on, and its revisions by number. */
export function runSpec(db: Reader, run: PlanningRun) {
  const specificationId = present(run.specificationId, `Planning run ${run.id}'s spec`);
  return { spec: readSpec(db, specificationId), revisions: readSpecRevisions(db, specificationId) };
}

/**
 * A repair's request (spec-scoped `to_spec`): the spec's latest revision, a draft whose review
 * failed, a rejected one or one a note superseded, with that review's findings, the reason or the
 * note.
 */
export function reviseSpecRequest(
  db: Reader,
  map: MapRecord,
  run: PlanningRun,
  base: SpecRunBase,
  mapRounds: ReviseSpecRequest["mapRounds"],
): ReviseSpecRequest {
  const { spec, revisions } = runSpec(db, run);
  const latest = latestOf(revisions);
  const feedback = revisionFeedback(db, run, latest);
  return {
    ...specMapContext(db, map, base),
    mapRounds,
    projectSpecs: otherProjectSpecs(db, map),
    latest: revisionRef(spec.number, latest),
    references: clauseReferences(latest.content, readCodeSurvey(db, map.id), base.projectFolder),
    retiredIds: retiredIds(revisions.map((revision) => revision.content)),
    feedback,
    earlierFindings: earlierFindings(db, revisions, latest),
    refusedAttempt: refusedAttempt(db, run, latest),
  };
}

/**
 * Why a spec-scoped `to_spec` writes the next revision after `latest`:
 * a release run's wait's note (`wait`); a note run's message on an approved latest (`note`); else a
 * repair's feedback on its map's own unapproved latest (`feedbackOf`). Anything else is a
 * programmer error.
 */
function revisionFeedback(db: Reader, run: PlanningRun, latest: StoredRevision): SpecFeedback {
  const release = releasedWaitOf(db, run.id);
  if (release !== undefined) {
    return { kind: "wait", note: release.note, noteDirected: release.hatchMessageId !== null };
  }
  if (latest.approvedAt !== null && run.hatchMessageId !== null) {
    return { kind: "note", text: readNoteText(db, run.hatchMessageId) };
  }
  const feedback = feedbackOf(db, latest);
  if (latest.mapId !== run.mapId || latest.approvedAt !== null || feedback === null) {
    throw new Error(`Repair run ${run.id}'s spec has no failed, rejected or noted revision`);
  }
  return feedback;
}

/**
 * The problem core refused a repair's previous attempt with: the spec's run just before
 * `run` (a retry, or a fresh run after Try again) when it is a `to_spec` that failed
 * `spec_content_invalid` after `latest` was written; null otherwise.
 */
function refusedAttempt(
  db: Reader,
  run: PlanningRun,
  latest: StoredRevision,
): ReviseSpecRequest["refusedAttempt"] {
  const runs = readMapRuns(db, run.mapId);
  const scope = specRuns(runs, latest.specificationId);
  const previous = scope[scope.findIndex((candidate) => candidate.id === run.id) - 1];
  if (
    previous?.purpose !== "to_spec" ||
    previous.errorCode !== "spec_content_invalid" ||
    startedBefore(runs, previous, latest)
  ) {
    return null;
  }
  return { problem: present(previous.errorMessage, `Failed run ${previous.id}'s message`) };
}

/**
 * Whether `run` started before `latest` was written: by the map's run order when this map wrote
 * it, else by time (another map's revision).
 */
function startedBefore(
  runs: readonly PlanningRun[],
  run: PlanningRun,
  latest: StoredRevision,
): boolean {
  if (latest.mapId === run.mapId) {
    const position = runPositions(runs);
    return position(run) < position({ id: latest.writtenByRun });
  }
  return run.startedAt < latest.createdAt;
}

/**
 * The revision a `spec_review` run reviews, pinned at its start: its spec's latest
 * revision of the run's map written by a run started before the review's first attempt. A
 * re-clear while the review runs supersedes it; the review is still saved against it.
 */
export function reviewedRevision(db: Reader, run: PlanningRun): StoredRevision {
  const { revisions } = runSpec(db, run);
  const runs = readMapRuns(db, run.mapId);
  const position = runPositions(runs);
  const first = firstAttempt(runs, run);
  const reviewed = revisions
    .filter(
      (revision) =>
        revision.mapId === run.mapId && position({ id: revision.writtenByRun }) < position(first),
    )
    .at(-1);
  if (reviewed?.approvedAt !== null) {
    throw new Error(`Review run ${run.id}'s spec has no draft of map ${run.mapId} to review`);
  }
  return reviewed;
}

/** A `spec_review` run's request. */
export function reviewSpecRequest(
  db: Reader,
  map: MapRecord,
  run: PlanningRun,
  base: SpecRunBase,
  mapRounds: ReviewSpecRequest["mapRounds"],
): ReviewSpecRequest {
  const revision = reviewedRevision(db, run);
  const spec = readSpec(db, revision.specificationId);
  const revisions = readSpecRevisions(db, spec.id);
  const before = revisions.find((candidate) => candidate.revision === revision.revision - 1);
  const otherSpecs = readMapSpecs(db, map.id)
    .filter((other) => other.id !== spec.id)
    .map((other) => revisionRef(other.number, latestOf(readSpecRevisions(db, other.id))));
  const rejected = revisions
    .filter((earlier) => earlier.revision < revision.revision && earlier.rejectionReason !== null)
    .at(-1);
  return {
    ...specMapContext(db, map, base),
    mapRounds,
    revision: revisionRef(spec.number, revision),
    references: clauseReferences(revision.content, readCodeSurvey(db, map.id), base.projectFolder),
    changes: changesOf(db, map.id, readSpecRecord(db, spec.id), revision.revision),
    before:
      before === undefined
        ? null
        : {
            ...revisionRef(spec.number, before),
            delivery: deliveryAt(db, spec.id, before.revision),
          },
    removed: revision.removed,
    earlierFindings: earlierFindings(db, revisions, revision),
    otherSpecs,
    rejection:
      rejected === undefined
        ? null
        : {
            revision: rejected.revision,
            reason: present(rejected.rejectionReason, `Revision ${rejected.id}'s reason`),
          },
    // The note-directed revisions up to the reviewed one outrank earlier resolutions.
    noteDirectedRevisions: readNoteDirectedRevisions(db, spec.id).filter(
      (directed) => directed.revision <= revision.revision,
    ),
  };
}

/**
 * A `to_tickets` run's request: the spec's latest approved revision of the run's map and, on
 * a rewrite after a rejection, a note or a failed review (the review repair),
 * the set's current version, its failed review's findings and the reason, the note or null
 * (`pendingRewrite`).
 */
export function draftTicketSetRequest(
  db: Reader,
  run: PlanningRun,
  base: SpecRunBase,
): DraftTicketSetRequest {
  const specificationId = present(run.specificationId, `To Tickets run ${run.id}'s spec`);
  const spec = readSpec(db, specificationId);
  const approved = approvedRevision(db, run);
  const pending = pendingRewrite(db, approved, runNote(db, run));
  const record = readSpecRecord(db, specificationId);
  return {
    ...specMapContext(db, readMap(db, run.mapId), base),
    approved: revisionRef(spec.number, approved),
    rewrite: pending === null ? null : pending.rewrite,
    // The rewritten version's own findings are the rewrite's; only the ones before it are earlier.
    earlierFindings:
      pending === null ? [] : ticketsEarlierFindings(db, pending.set.id, pending.set.version),
    firstTicketNumber: firstTicketNumber(db, specificationId),
    ...reconciliationOf(record, approved.revision, null),
    touchingWaypoints: touchingWaypoints(db, run.mapId, specificationId),
    // Only approved sets' tickets: a replaced or never-approved set's are not earlier tickets.
    earlierTickets: record.sets
      .filter((set) => set.revision < approved.revision && set.approved)
      .flatMap((set) =>
        set.content.tickets.map((ticket) => {
          const delivered = deliveryOf(record, set.id, ticket.id);
          return {
            id: ticket.id,
            title: ticket.title,
            criteria: [...ticket.criteria],
            revision: set.revision,
            delivered: delivered === null ? null : { run: delivered.run, commit: delivered.commit },
          };
        }),
      ),
    refusedAttempt: ticketsRefusedAttempt(db, run, specificationId),
  };
}

/**
 * The failed tickets reviews of a set's versions before version `before`, oldest first (the repair
 * loop's memory, as `earlierFindings` is a spec's). Only versions after the latest one up to
 * `before` whose review passed count: a passed review closes the findings before it. A version
 * with no review or a passed one adds nothing.
 */
export function ticketsEarlierFindings(
  db: Reader,
  ticketSetId: string,
  before: number,
): TicketsEarlierFindings {
  const reviews = Array.from({ length: before }, (_, index) => ({
    version: index + 1,
    reviewed: readTicketsReview(db, ticketSetId, index + 1),
  }));
  const passed = reviews.filter(({ reviewed }) => reviewed?.review.passed === true).at(-1);
  const after = passed === undefined ? 0 : passed.version;
  return reviews
    .filter(({ version }) => version > after && version < before)
    .flatMap(({ version, reviewed }) =>
      reviewed === null || reviewed.review.passed
        ? []
        : [
            {
              version,
              findings: reviewed.findings.map(
                ({ kind, ticketNumbers, criterionIds, explanation }) => ({
                  kind,
                  ticketNumbers,
                  criterionIds,
                  explanation,
                }),
              ),
            },
          ],
    );
}

/**
 * The code and problem core refused a `to_tickets` run's previous attempt with: the spec's run
 * just before `run` (a retry, or a fresh run after Try again) when it is a `to_tickets` that failed
 * `ticket_set_content_invalid`; null otherwise.
 */
function ticketsRefusedAttempt(
  db: Reader,
  run: PlanningRun,
  specificationId: string,
): DraftTicketSetRequest["refusedAttempt"] {
  const scope = specRuns(readMapRuns(db, run.mapId), specificationId);
  const previous = scope[scope.findIndex((candidate) => candidate.id === run.id) - 1];
  if (previous?.purpose !== "to_tickets" || previous.errorCode !== "ticket_set_content_invalid") {
    return null;
  }
  return {
    code: "ticket_set_content_invalid",
    problem: present(previous.errorMessage, `Failed run ${previous.id}'s message`),
  };
}

/**
 * A `tickets_review` run's request: the approved revision, the version under review
 * and the set's directed versions up to it, whose asks the reviewer treats as traced.
 */
export function reviewTicketSetRequest(
  db: Reader,
  run: PlanningRun,
  base: SpecRunBase,
): ReviewTicketSetRequest {
  const { approved, ticketSetId, version, content } = reviewedVersion(db, run);
  const spec = readSpec(db, approved.specificationId);
  return {
    ...base,
    approved: revisionRef(spec.number, approved),
    ticketSet: { version, content },
    directedVersions: readDirectedVersions(db, ticketSetId, version),
    earlierFindings: ticketsEarlierFindings(db, ticketSetId, version),
    survey: readCodeSurvey(db, run.mapId),
    ...reconciliationOf(
      readSpecRecord(db, approved.specificationId),
      approved.revision,
      content.dispositions,
    ),
    touchingWaypoints: touchingWaypoints(db, run.mapId, approved.specificationId),
  };
}

/** The merged run that delivered revision `revision`'s set, as a request names it, or null. */
function deliveryAt(
  db: Reader,
  specificationId: string,
  revision: number,
): { run: number; commit: string } | null {
  const delivered = deliveredRunOf(db, specificationId, revision);
  return delivered === null ? null : { run: delivered.number, commit: delivered.commit };
}
