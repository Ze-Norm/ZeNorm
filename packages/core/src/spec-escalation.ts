import type { PlanningRun, SpecReviewFinding } from "@zenorm/contracts";
import { specReviewFindings, specReviews, specRevisions, waypoints } from "@zenorm/db";
import { and, eq, max } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { readMapRuns, scopeRuns } from "./planning-runs.ts";
import type { Reader, Tx } from "./planning-runs.ts";
import { isDraft, latestOf, readReviews, readSpecRevisions } from "./specs.ts";
import type { StoredRevision } from "./specs.ts";

/**
 * How many failed reviews a spec takes before its next failed review stops the revise loop (RC4):
 * that review's findings all escalate, so no repair is due. Its `decision` findings go to the
 * person (`personDecides`); its `revise` ones open waypoints their grilling may settle from the
 * map's answers, resolutions and FACTS. Counted per spec since its latest approved revision,
 * across maps, clearings, rejections, notes, rewrites in place (L241) and decision-escalated
 * reviews, so nothing resets it.
 */
export const SPEC_REVIEW_FAILED_CAP = 2;

/**
 * Past this many failed reviews every finding of the spec's next failed review is the person's
 * to decide, `revise` ones too: the agent settled a capped finding and the review failed again.
 */
export const SPEC_REVIEW_PERSON_CAP = 3;

/**
 * The failed reviews of the spec's revisions after its latest approved revision before `revision`
 * (all before it when none is approved), `revision`'s own earlier reviews included: a draft
 * rewritten in place (L241) keeps the reviews of the content it replaced. Called before the review
 * being recorded is stored.
 */
function failedReviewsSinceApproval(db: Reader, revision: StoredRevision): number {
  const earlier = readSpecRevisions(db, revision.specificationId).filter(
    (other) => other.revision <= revision.revision,
  );
  const approved = earlier.filter((other) => other.approvedAt !== null).at(-1);
  return earlier
    .filter((other) => approved === undefined || other.revision > approved.revision)
    .flatMap((other) => readReviews(db, other.id))
    .filter(({ review }) => !review.passed).length;
}

/** Which of a failing review's findings escalate, and which of those go to the person. */
export interface Escalation {
  /** The positions (from 0) of the findings that escalate. */
  readonly positions: ReadonlySet<number>;
  /** The positions (from 0) of the escalating findings only the person settles (`personDecides`). */
  readonly personDecides: ReadonlySet<number>;
}

/**
 * Which of a failing review's findings escalate (S7-8, S7-9, RC4), computed in the transaction
 * recording it from recorded revisions and reviews (no counter, issue 25). None when the revision
 * is no longer its spec's latest draft or the map-scope `to_spec` works: that review is saved
 * pinned to its revision and starts nothing (S7-10). Else every finding, to the person, when the
 * spec already failed `SPEC_REVIEW_PERSON_CAP` reviews since its latest approval; else every
 * finding, only the `decision` ones to the person, when it failed `SPEC_REVIEW_FAILED_CAP`; else
 * every `decision` finding, to the person (the `revise` ones stay unescalated, so a repair is due
 * when there is none).
 */
export function escalatedPositions(
  db: Reader,
  revision: StoredRevision,
  findings: readonly SpecReviewFinding[],
): Escalation {
  const latest = latestOf(readSpecRevisions(db, revision.specificationId));
  const mapScope = scopeRuns(readMapRuns(db, revision.mapId), null).at(-1);
  const drafting =
    mapScope?.purpose === "to_spec" &&
    (mapScope.state === "running" ||
      (mapScope.state === "failed" && mapScope.retryOfRunId === null));
  if (findings.length === 0 || latest.id !== revision.id || !isDraft(revision) || drafting) {
    return { positions: new Set(), personDecides: new Set() };
  }
  const all = new Set(findings.map((_, index) => index));
  const decisions = new Set(
    findings.flatMap((finding, index) => (finding.route === "decision" ? [index] : [])),
  );
  const failed = failedReviewsSinceApproval(db, revision);
  if (failed >= SPEC_REVIEW_PERSON_CAP) {
    return { positions: all, personDecides: all };
  }
  if (failed >= SPEC_REVIEW_FAILED_CAP) {
    return { positions: all, personDecides: decisions };
  }
  return { positions: decisions, personDecides: decisions };
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  const sorted = (numbers: readonly number[]) => [...new Set(numbers)].sort((x, y) => x - y);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/**
 * Whether an earlier escalated finding raises the same problem as `finding`: the same kind, and
 * either both name the same resolved waypoints, or both are of the same spec and name a clause or
 * criterion in common (ids are stable across a spec's revisions, so a re-raised finding matches).
 * Two findings naming nothing are never the same: nothing shows they are.
 */
export function sameProblem(
  earlier: {
    readonly waypointNumbers: readonly number[];
    readonly elementIds: readonly string[];
    readonly specificationId: string;
  },
  finding: SpecReviewFinding,
  specificationId: string,
): boolean {
  if (earlier.waypointNumbers.length > 0 && finding.waypointNumbers.length > 0) {
    return sameNumbers(earlier.waypointNumbers, finding.waypointNumbers);
  }
  return (
    earlier.specificationId === specificationId &&
    earlier.elementIds.some((id) => finding.elementIds.includes(id))
  );
}

/**
 * The waypoint an escalated finding goes to (S7-8, S7-9): the waypoint of an escalated finding of
 * the map's earlier reviews raising the same problem (`sameProblem`) while that waypoint is not
 * yet closed (open, or claimed by its grilling), else a new unblocked Grilling waypoint with the
 * finding's title and question, numbered after the map's highest and created by the review run.
 * A finding never links a waypoint its own review opened (`openedByReview`): the reviewer
 * reported them apart, and each reaches a grilling. `personDecides` marks the waypoint so, on
 * creation or link: only the person settles it.
 */
export function escalationWaypoint(
  tx: Tx,
  run: Pick<PlanningRun, "id" | "mapId">,
  revision: Pick<StoredRevision, "specificationId">,
  finding: SpecReviewFinding,
  personDecides: boolean,
  openedByReview: ReadonlySet<string>,
): string {
  const matching = tx
    .select({
      waypointId: specReviewFindings.waypointId,
      waypointNumbers: specReviewFindings.waypointNumbers,
      elementIds: specReviewFindings.elementIds,
      specificationId: specRevisions.specificationId,
      status: waypoints.status,
    })
    .from(specReviewFindings)
    .innerJoin(specReviews, eq(specReviews.id, specReviewFindings.reviewId))
    .innerJoin(specRevisions, eq(specRevisions.id, specReviews.specRevisionId))
    .innerJoin(waypoints, eq(waypoints.id, specReviewFindings.waypointId))
    .where(
      and(
        eq(specRevisions.mapId, run.mapId),
        eq(specReviewFindings.escalated, true),
        eq(specReviewFindings.kind, finding.kind),
      ),
    )
    .all()
    .find(
      (candidate) =>
        candidate.waypointId !== null &&
        !openedByReview.has(candidate.waypointId) &&
        (candidate.status === "open" || candidate.status === "claimed") &&
        sameProblem(candidate, finding, revision.specificationId),
    );
  if (matching?.waypointId != null) {
    if (personDecides) {
      // A finding for the person linking a waypoint leaves it to them, whatever opened it.
      tx.update(waypoints)
        .set({ personDecides: true })
        .where(eq(waypoints.id, matching.waypointId))
        .run();
    }
    return matching.waypointId;
  }
  const highest = tx
    .select({ highest: max(waypoints.number) })
    .from(waypoints)
    .where(eq(waypoints.mapId, run.mapId))
    .get()?.highest;
  // A map charted with no waypoint numbers its first from 1.
  const number = highest === undefined || highest === null ? 1 : highest + 1;
  const id = uuidv7();
  tx.insert(waypoints)
    .values({
      id,
      mapId: run.mapId,
      number,
      kind: "grilling",
      status: "open",
      title: finding.title,
      question: finding.question,
      claimedAt: null,
      resolution: null,
      gist: null,
      agentDecided: null,
      resolvedAt: null,
      resolvedHow: null,
      resolvedByRun: null,
      createdByRun: run.id,
      personDecides,
    })
    .run();
  return id;
}
