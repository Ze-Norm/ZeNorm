import type {
  DirectedVersion,
  MapRecord,
  PlanningRunPurpose,
  SpecRevisionContent,
  SpecRevisionState,
  TicketSetContent,
  TicketsReviewFinding,
} from "@zenorm/contracts";
import {
  hatchMessages,
  planningRuns,
  specifications,
  specReviewFindings,
  specReviews,
  specRevisions,
  ticketSetRejections,
  ticketSets,
  ticketSetVersions,
  ticketsReviewFindings,
  ticketsReviews,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

type Reader = Pick<ZeNormDatabase, "select">;

export type StoredSpec = typeof specifications.$inferSelect;
export type StoredRevision = typeof specRevisions.$inferSelect;
export type StoredReview = typeof specReviews.$inferSelect;
export type StoredFinding = typeof specReviewFindings.$inferSelect;
export type StoredTicketSet = typeof ticketSets.$inferSelect;
export type StoredRejection = typeof ticketSetRejections.$inferSelect;
export type StoredTicketsReview = typeof ticketsReviews.$inferSelect;
export type StoredTicketsReviewFinding = typeof ticketsReviewFindings.$inferSelect;

/** The revisions the map wrote, oldest first. */
export function readMapRevisions(db: Reader, mapId: string): StoredRevision[] {
  return db
    .select()
    .from(specRevisions)
    .where(eq(specRevisions.mapId, mapId))
    .orderBy(asc(specRevisions.createdAt), asc(specRevisions.revision))
    .all();
}

/** The specs the map wrote a revision of, by number. */
export function readMapSpecs(db: Reader, mapId: string): StoredSpec[] {
  const ids = [...new Set(readMapRevisions(db, mapId).map((row) => row.specificationId))];
  if (ids.length === 0) {
    return [];
  }
  return db
    .select()
    .from(specifications)
    .where(inArray(specifications.id, ids))
    .orderBy(asc(specifications.number))
    .all();
}

/** The project's specs, by number. */
export function readProjectSpecs(db: Reader, projectId: string): StoredSpec[] {
  return db
    .select()
    .from(specifications)
    .where(eq(specifications.projectId, projectId))
    .orderBy(asc(specifications.number))
    .all();
}

/** A spec, by id; a missing one is a programmer error. */
export function readSpec(db: Reader, specificationId: string): StoredSpec {
  const spec = db.select().from(specifications).where(eq(specifications.id, specificationId)).get();
  if (spec === undefined) {
    throw new Error(`No spec with id ${specificationId}`);
  }
  return spec;
}

/** A spec's revisions on every map, by number. */
export function readSpecRevisions(db: Reader, specificationId: string): StoredRevision[] {
  return db
    .select()
    .from(specRevisions)
    .where(eq(specRevisions.specificationId, specificationId))
    .orderBy(asc(specRevisions.revision))
    .all();
}

/** The last of a spec's revisions, by number; a spec without one is a programmer error. */
export function latestOf(revisions: readonly StoredRevision[]): StoredRevision {
  const latest = revisions.at(-1);
  if (latest === undefined) {
    throw new Error("A spec has no revision");
  }
  return latest;
}

/** Whether a revision is undecided: neither approved nor superseded. */
export function isDraft(revision: Pick<StoredRevision, "approvedAt" | "supersededAt">): boolean {
  return revision.approvedAt === null && revision.supersededAt === null;
}

/** A revision's state, from its timestamps (spec D1). */
export function revisionState(
  revision: Pick<StoredRevision, "approvedAt" | "supersededAt" | "rejectionReason">,
): SpecRevisionState {
  if (revision.approvedAt !== null) {
    return "approved";
  }
  if (revision.supersededAt === null) {
    return "draft";
  }
  return revision.rejectionReason === null ? "superseded" : "rejected";
}

/** A stored review with its findings by position. */
export interface ReadReview {
  readonly review: StoredReview;
  readonly findings: StoredFinding[];
}

/**
 * Every review of a revision with its findings, oldest first (by its run's start). A draft
 * rewritten in place (L241) has one per rewrite; the reviews of earlier content come first.
 */
export function readReviews(db: Reader, specRevisionId: string): ReadReview[] {
  return db
    .select({ review: specReviews })
    .from(specReviews)
    .innerJoin(planningRuns, eq(planningRuns.id, specReviews.runId))
    .where(eq(specReviews.specRevisionId, specRevisionId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all()
    .map(({ review }) => ({
      review,
      findings: db
        .select()
        .from(specReviewFindings)
        .where(eq(specReviewFindings.reviewId, review.id))
        .orderBy(asc(specReviewFindings.position))
        .all(),
    }));
}

/**
 * A revision's review of its current content and its findings by position, or null before one is
 * recorded: the review whose run started after the run that wrote the content (L241). A review of
 * content a rewrite replaced is an earlier review (`earlierReviews`).
 */
export function readReview(
  db: Reader,
  revision: Pick<StoredRevision, "id" | "writtenByRun">,
): ReadReview | null {
  const written = runOrder(db, revision.writtenByRun);
  const current = readReviews(db, revision.id).filter(({ review }) =>
    isAfter(runOrder(db, review.runId), written),
  );
  const [review, extra] = current;
  if (extra !== undefined) {
    throw new Error(`Revision ${revision.id} has more than one review of its content`);
  }
  if (review === undefined) {
    return null;
  }
  return review;
}

/** A revision's reviews of content a rewrite in place replaced (L241), oldest first. */
export function earlierReviews(
  db: Reader,
  revision: Pick<StoredRevision, "id" | "writtenByRun">,
): ReadReview[] {
  const written = runOrder(db, revision.writtenByRun);
  return readReviews(db, revision.id).filter(
    ({ review }) => !isAfter(runOrder(db, review.runId), written),
  );
}

/** The ticket set written for a revision, or undefined. */
export function readTicketSetOf(db: Reader, specRevisionId: string): StoredTicketSet | undefined {
  return db.select().from(ticketSets).where(eq(ticketSets.specRevisionId, specRevisionId)).get();
}

/** One version of a ticket set: its content and when it was saved; a missing one is a programmer error. */
export function readSetVersion(
  db: Reader,
  ticketSetId: string,
  version: number,
): { content: TicketSetContent; createdAt: string; writtenByRun: string } {
  const row = db
    .select({
      content: ticketSetVersions.content,
      createdAt: ticketSetVersions.createdAt,
      writtenByRun: ticketSetVersions.writtenByRun,
    })
    .from(ticketSetVersions)
    .where(
      and(eq(ticketSetVersions.ticketSetId, ticketSetId), eq(ticketSetVersions.version, version)),
    )
    .get();
  if (row === undefined) {
    throw new Error(`Ticket set ${ticketSetId} has no version ${String(version)}`);
  }
  return row;
}

/** A ticket set's rejections, oldest first. */
export function readRejections(db: Reader, ticketSetId: string): StoredRejection[] {
  return db
    .select()
    .from(ticketSetRejections)
    .where(eq(ticketSetRejections.ticketSetId, ticketSetId))
    .orderBy(asc(ticketSetRejections.version))
    .all();
}

/** A hatch message's text, by id (S7b-11, S7b-12); a missing one is a programmer error. */
export function readNoteText(db: Reader, hatchMessageId: string): string {
  const row = db
    .select({ text: hatchMessages.text })
    .from(hatchMessages)
    .where(eq(hatchMessages.id, hatchMessageId))
    .get();
  if (row === undefined) {
    throw new Error(`No hatch message with id ${hatchMessageId}`);
  }
  return row.text;
}

/**
 * The set's directed versions up to `upTo`, oldest first (L180 (2)): each version a run carrying a
 * hatch message wrote, with that note (S7b-12), else each version written after the version before
 * it was rejected, with the reason (S7-18). The first version and a review repair have none.
 */
export function readDirectedVersions(
  db: Reader,
  ticketSetId: string,
  upTo: number,
): DirectedVersion[] {
  const rejections = readRejections(db, ticketSetId);
  const directed: DirectedVersion[] = [];
  for (let version = 2; version <= upTo; version += 1) {
    const { writtenByRun } = readSetVersion(db, ticketSetId, version);
    const writer = db
      .select({ hatchMessageId: planningRuns.hatchMessageId })
      .from(planningRuns)
      .where(eq(planningRuns.id, writtenByRun))
      .get();
    if (writer === undefined) {
      throw new Error(`Ticket set ${ticketSetId}'s writing run ${writtenByRun} is missing`);
    }
    if (writer.hatchMessageId !== null) {
      directed.push({ kind: "note", version, text: readNoteText(db, writer.hatchMessageId) });
      continue;
    }
    const rejection = rejections.find((candidate) => candidate.version === version - 1);
    if (rejection !== undefined) {
      directed.push({ kind: "rejection", version, reason: rejection.reason });
    }
  }
  return directed;
}

/** A run's place among runs (by `started_at`, then id), as `readMapRuns` orders them. */
function runOrder(db: Reader, runId: string): { startedAt: string; id: string } {
  const row = db
    .select({ startedAt: planningRuns.startedAt, id: planningRuns.id })
    .from(planningRuns)
    .where(eq(planningRuns.id, runId))
    .get();
  if (row === undefined) {
    throw new Error(`No planning run with id ${runId}`);
  }
  return row;
}

function isAfter(a: { startedAt: string; id: string }, b: { startedAt: string; id: string }) {
  return a.startedAt === b.startedAt ? a.id > b.id : a.startedAt > b.startedAt;
}

/**
 * The note directing the revision after `revision` (S7b-11): the text of the hatch message the
 * latest spec-scoped `to_spec` run on the map writing `next` (else `revision`'s map) carries among those started after `revision`'s
 * writer and, when `next` is given, no later than `next`'s writer; null when none carries one. A
 * note's run (or its retry) writes that next revision, or, when a reopen or the re-clear ended it,
 * the re-clear does.
 */
export function noteAfter(
  db: Reader,
  revision: StoredRevision,
  next: StoredRevision | null,
): string | null {
  const after = runOrder(db, revision.writtenByRun);
  const upTo = next === null ? null : runOrder(db, next.writtenByRun);
  const noted = db
    .select({
      startedAt: planningRuns.startedAt,
      id: planningRuns.id,
      hatchMessageId: planningRuns.hatchMessageId,
    })
    .from(planningRuns)
    .where(
      and(
        eq(planningRuns.mapId, (next ?? revision).mapId),
        eq(planningRuns.specificationId, revision.specificationId),
        eq(planningRuns.purpose, "to_spec"),
        isNotNull(planningRuns.hatchMessageId),
      ),
    )
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all()
    .filter((run) => isAfter(run, after) && (upTo === null || !isAfter(run, upTo)))
    .at(-1);
  return noted?.hatchMessageId == null ? null : readNoteText(db, noted.hatchMessageId);
}

/**
 * The spec's note-directed revisions, by number (S7b-11): each revision written after a note on
 * the revision before it (`noteAfter`), with that note.
 */
export function readNoteDirectedRevisions(
  db: Reader,
  specificationId: string,
): { revision: number; note: string }[] {
  const revisions = readSpecRevisions(db, specificationId);
  return revisions.flatMap((revision, index) => {
    const before = revisions[index - 1];
    const note = before === undefined ? null : noteAfter(db, before, revision);
    return note === null ? [] : [{ revision: revision.revision, note }];
  });
}

/** The clause and criterion ids of a revision's content. */
export function elementIds(content: SpecRevisionContent): Set<string> {
  return new Set(
    content.clauses.flatMap((clause) => [clause.id, ...clause.criteria.map((c) => c.id)]),
  );
}

/** An element id's numbers, for ordering: `C3` → [3], `3.2` → [3, 2]. */
function idNumbers(id: string): number[] {
  return (id.startsWith("C") ? id.slice(1) : id).split(".").map(Number);
}

/** Orders element ids by clause, then criterion, a clause before its criteria. */
export function compareElementIds(a: string, b: string): number {
  const [left, right] = [idNumbers(a), idNumbers(b)];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * The ids a spec has retired (D2, E-3): every clause and criterion id a revision of `revisions`
 * (oldest first) used that the last of them drops. The next revision may not use one again.
 */
export function retiredIds(revisions: readonly SpecRevisionContent[]): string[] {
  const last = revisions.at(-1);
  const kept = last === undefined ? new Set<string>() : elementIds(last);
  const used = new Set(revisions.flatMap((revision) => [...elementIds(revision)]));
  return [...used].filter((id) => !kept.has(id)).sort(compareElementIds);
}

/** A spec run due on the map (slice 7 D6). */
export interface DueSpecRun {
  readonly specificationId: string;
  readonly purpose: PlanningRunPurpose;
}

/** What `dueSpecRuns` reads of the map's runs and clearing, computed by `planNext`. */
export interface SpecRunGate {
  /** Whether the spec's scope neither runs, awaits its retry, nor is stopped (a superseded stop is idle). */
  readonly idle: (specificationId: string) => boolean;
  /**
   * Whether a `spec_review` or a repair may start (S7-10, D6): the map is cleared and its map-scope
   * `to_spec` neither runs nor is due (a due re-clear supersedes the map's drafts).
   */
  readonly writesOpen: boolean;
}

/**
 * Whether a revision's review failed with only unescalated `revise` findings, so a repair is due
 * (S7-7).
 */
export function awaitsRepair(db: Reader, revision: StoredRevision): boolean {
  const reviewed = readReview(db, revision);
  return (
    reviewed !== null &&
    !reviewed.review.passed &&
    reviewed.findings.every((finding) => finding.route === "revise" && !finding.escalated)
  );
}

/** The recorded tickets review of one ticket set version with its findings in order, or null (S7c-2). */
export function readTicketsReview(
  db: Reader,
  ticketSetId: string,
  version: number,
): { review: StoredTicketsReview; findings: StoredTicketsReviewFinding[] } | null {
  const review = db
    .select()
    .from(ticketsReviews)
    .where(
      and(
        eq(ticketsReviews.ticketSetId, ticketSetId),
        eq(ticketsReviews.ticketSetVersion, version),
      ),
    )
    .get();
  if (review === undefined) {
    return null;
  }
  const findings = db
    .select()
    .from(ticketsReviewFindings)
    .where(eq(ticketsReviewFindings.reviewId, review.id))
    .orderBy(asc(ticketsReviewFindings.position))
    .all();
  return { review, findings };
}

/** A stored finding as the agent wrote it, without core's `escalated` mark. */
export function findingOf(finding: StoredTicketsReviewFinding): TicketsReviewFinding {
  return {
    kind: finding.kind,
    route: finding.route,
    title: finding.title,
    explanation: finding.explanation,
    question: finding.question,
    ticketNumbers: finding.ticketNumbers,
    criterionIds: finding.criterionIds,
  };
}

/**
 * True when an approved revision has no ticket set, or its unapproved set's current version is
 * rejected (S7-18) or failed its tickets review with only unescalated `revise` findings, so its
 * review repair is due (slice 7c D5, S7c-4). A held set (an escalated finding) has none due.
 */
function ticketsDue(db: Reader, specRevisionId: string): boolean {
  const set = readTicketSetOf(db, specRevisionId);
  if (set === undefined) {
    return true;
  }
  if (set.state === "approved") {
    return false;
  }
  if (readRejections(db, set.id).some((rejection) => rejection.version === set.version)) {
    return true;
  }
  const reviewed = readTicketsReview(db, set.id, set.version);
  return (
    reviewed !== null &&
    !reviewed.review.passed &&
    reviewed.findings.every((finding) => finding.route === "revise" && !finding.escalated)
  );
}

/**
 * Whether the spec's `to_tickets` on the map has work left: its latest approved revision of the map
 * has no set, or an unapproved set whose current version is rejected, awaits its review repair
 * (S7c-4) or that a note's rewrite has not yet written (S7b-12). False once that set is approved,
 * so a stopped rewrite of a set approved since is not tried again, and once a newer revision
 * replaced it (slice 8b S8b-9).
 */
export function toTicketsDue(db: Reader, mapId: string, specificationId: string): boolean {
  const revisions = readSpecRevisions(db, specificationId);
  const approved = revisions
    .filter((revision) => revision.mapId === mapId && revision.approvedAt !== null)
    .at(-1);
  return (
    approved?.id === latestOf(revisions).id &&
    (ticketsDue(db, approved.id) || noteRewriteDue(db, mapId, specificationId, approved.id))
  );
}

/**
 * Whether a note's rewrite (S7b-12) has work left: the spec's latest `to_tickets` run on the map
 * carries a message, and the revision's set is unapproved and its current version was not written
 * by a run carrying that message.
 */
function noteRewriteDue(
  db: Reader,
  mapId: string,
  specificationId: string,
  specRevisionId: string,
): boolean {
  const latest = db
    .select({ hatchMessageId: planningRuns.hatchMessageId })
    .from(planningRuns)
    .where(
      and(
        eq(planningRuns.mapId, mapId),
        eq(planningRuns.specificationId, specificationId),
        eq(planningRuns.purpose, "to_tickets"),
      ),
    )
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all()
    .at(-1);
  const set = readTicketSetOf(db, specRevisionId);
  if (latest?.hatchMessageId == null || set === undefined || set.state === "approved") {
    return false;
  }
  const writer = readSetVersion(db, set.id, set.version).writtenByRun;
  const written = db
    .select({ hatchMessageId: planningRuns.hatchMessageId })
    .from(planningRuns)
    .where(eq(planningRuns.id, writer))
    .get();
  if (written === undefined) {
    throw new Error(`Ticket set ${set.id}'s writing run ${writer} is missing`);
  }
  return written.hatchMessageId !== latest.hatchMessageId;
}

/**
 * The spec-scoped runs due on the map (D6), for each spec the map wrote a revision of whose scope
 * is idle: while writes are open, a `spec_review` for an unreviewed latest draft, or a repair
 * `to_spec` for a latest draft whose review failed revise-only and unescalated (S7-7) or a latest
 * revision rejected (S7-12); else, whatever the clearing (L127 (1)), a `to_tickets` for an approved
 * revision of this map that is the spec's latest (an older one's set is replaced, S8b-9) with no
 * ticket set or whose set's current version is rejected (the rewrite, S7-18) or failed its review
 * revise-only and unescalated (the review repair, slice 7c D5, S7c-4), else a `tickets_review`
 * for its unapproved set whose current version has no review and no note rewrite due (slice 7c D5,
 * S7c-2). Retries are `planNext`'s.
 */
export function dueSpecRuns(
  db: Reader,
  map: Pick<MapRecord, "id">,
  gate: SpecRunGate,
): DueSpecRun[] {
  const due: DueSpecRun[] = [];
  for (const spec of readMapSpecs(db, map.id)) {
    if (!gate.idle(spec.id)) {
      continue;
    }
    const revisions = readSpecRevisions(db, spec.id);
    const latest = latestOf(revisions);
    if (latest.mapId === map.id && latest.approvedAt === null) {
      if (!gate.writesOpen) {
        continue;
      }
      if (latest.supersededAt === null && readReview(db, latest) === null) {
        due.push({ specificationId: spec.id, purpose: "spec_review" });
      } else if (
        latest.supersededAt === null ? awaitsRepair(db, latest) : latest.rejectionReason !== null
      ) {
        due.push({ specificationId: spec.id, purpose: "to_spec" });
      }
      continue;
    }
    const approved = revisions
      .filter((revision) => revision.mapId === map.id && revision.approvedAt !== null)
      .at(-1);
    if (approved?.id !== latest.id) {
      // A set on a revision that is no longer the spec's latest is replaced: nothing is due for
      // it (slice 8b S8b-9, issue 24 item 1).
      continue;
    }
    if (ticketsDue(db, approved.id)) {
      due.push({ specificationId: spec.id, purpose: "to_tickets" });
      continue;
    }
    const set = readTicketSetOf(db, approved.id);
    if (
      set !== undefined &&
      set.state !== "approved" &&
      !noteRewriteDue(db, map.id, spec.id, approved.id) &&
      readTicketsReview(db, set.id, set.version) === null
    ) {
      // Slice 7c D5, S7c-2: the current version's one review, once no `to_tickets` runs or is due.
      due.push({ specificationId: spec.id, purpose: "tickets_review" });
    }
  }
  return due;
}
