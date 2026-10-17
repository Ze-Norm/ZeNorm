/**
 * The reads slice 8b's views and requests share (D2, D6, D10): a waypoint's touches, the project's
 * other specs with their holds, a map's waits, criterion readings and the run that delivered a
 * revision. Derived from stored rows on every read; nothing here writes or stores a result.
 */
import type {
  CriterionReading,
  Disposition,
  SpecRevisionContent,
  ProjectSpecContext,
  RunTouch,
  TextDelta,
  WaypointTouchView,
} from "@zenorm/contracts";
import { specifications, specWaits, waypointTouches } from "@zenorm/db";
import { and, asc, eq, isNull } from "drizzle-orm";

import { readSpecRuns } from "./delivery.ts";
import { readMap } from "./planning-runs.ts";
import type { Reader } from "./planning-runs.ts";
import { present } from "./present.ts";
import { baseline, expectation, readSpecRecord, tension } from "./reconciliation.ts";
import type { SpecRecord } from "./reconciliation.ts";
import { specHold } from "./spec-holds.ts";
import { latestOf, readProjectSpecs, readSpecRevisions, retiredIds } from "./specs.ts";

/** A touch of a waypoint, with the touched spec's number and each criterion's text and baseline. */
interface ResolvedTouch {
  readonly specificationId: string;
  readonly specNumber: number;
  readonly specTitle: string;
  readonly revision: number;
  readonly content: SpecRevisionContent;
  readonly criteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly baseline: { ticket: string; run: number; commit: string } | null;
  }[];
}

/**
 * The specs a waypoint touches (S8b-2), by spec number: each named criterion's text in the touched
 * revision and the delivery that built it up to that revision (its baseline, that revision's own
 * set included).
 */
function resolvedTouches(db: Reader, waypointId: string): ResolvedTouch[] {
  const rows = db
    .select({
      specificationId: waypointTouches.specificationId,
      specNumber: specifications.number,
      revision: waypointTouches.revision,
      criteria: waypointTouches.criteria,
    })
    .from(waypointTouches)
    .innerJoin(specifications, eq(specifications.id, waypointTouches.specificationId))
    .where(eq(waypointTouches.waypointId, waypointId))
    .orderBy(asc(specifications.number))
    .all();
  return rows.map((row) => {
    const record = readSpecRecord(db, row.specificationId);
    const touched = record.revisions.find((revision) => revision.revision === row.revision);
    if (touched === undefined) {
      throw new Error(`Waypoint ${waypointId} touches a missing r${String(row.revision)}`);
    }
    const criteria = touched.content.clauses.flatMap((clause) => clause.criteria);
    return {
      specificationId: row.specificationId,
      specNumber: row.specNumber,
      specTitle: touched.content.title,
      revision: row.revision,
      content: touched.content,
      criteria: row.criteria.map((id) => {
        const criterion = criteria.find((candidate) => candidate.id === id);
        if (criterion === undefined) {
          throw new Error(`Waypoint ${waypointId} touches ${id}, not in r${String(row.revision)}`);
        }
        const delivered = baseline(record, row.revision + 1, id);
        return {
          id,
          text: criterion.text,
          baseline:
            delivered === null
              ? null
              : { ticket: delivered.ticket.id, run: delivered.run, commit: delivered.commit },
        };
      }),
    };
  });
}

/**
 * A waypoint's touches as a run reads them (D6): criteria with their baseline ticket and commit,
 * and the touched revision's text (L213 D-7).
 */
export function runTouches(db: Reader, waypointId: string): RunTouch[] {
  return resolvedTouches(db, waypointId).map((touch) => ({
    specNumber: touch.specNumber,
    specTitle: touch.specTitle,
    revision: touch.revision,
    content: touch.content,
    criteria: touch.criteria.map((criterion) => ({ ...criterion })),
  }));
}

/**
 * A waypoint's touches as Wayfinding shows them (D2, D13; the demo's `TouchesCard`): the map that
 * wrote the touched revision, whether a merged run delivered it, how many revisions came after it,
 * and each criterion with its clause's title and whether it was delivered.
 */
export function waypointTouchViews(db: Reader, waypointId: string): WaypointTouchView[] {
  return resolvedTouches(db, waypointId).map((touch) => {
    const record = readSpecRecord(db, touch.specificationId);
    const touched = record.revisions.find((revision) => revision.revision === touch.revision);
    if (touched === undefined) {
      throw new Error(`Waypoint ${waypointId} touches a missing r${String(touch.revision)}`);
    }
    const writer = readMap(db, touched.mapId);
    if (writer.title === null) {
      throw new Error(`Map ${writer.id} wrote r${String(touch.revision)} but has no title`);
    }
    return {
      specNumber: touch.specNumber,
      specTitle: touch.specTitle,
      revision: touch.revision,
      writerMapId: writer.id,
      writerMapTitle: writer.title,
      delivered: deliveredRunOf(db, touch.specificationId, touch.revision) !== null,
      laterRevisions: record.revisions.filter((revision) => revision.revision > touch.revision)
        .length,
      criteria: touch.criteria.map((criterion) => {
        const clause = touched.content.clauses.find((candidate) =>
          candidate.criteria.some((entry) => entry.id === criterion.id),
        );
        if (clause === undefined) {
          throw new Error(`Waypoint ${waypointId} touches ${criterion.id}, in no clause`);
        }
        return {
          id: criterion.id,
          text: criterion.text,
          clauseTitle: clause.title,
          delivered: criterion.baseline !== null,
        };
      }),
    };
  });
}

/** The ids of the specs a waypoint touches. */
export function touchedSpecIds(db: Reader, waypointId: string): string[] {
  return db
    .select({ specificationId: waypointTouches.specificationId })
    .from(waypointTouches)
    .where(eq(waypointTouches.waypointId, waypointId))
    .all()
    .map((row) => row.specificationId);
}

/** The newest merged delivery run of the spec whose set is revision `revision`'s, or null. */
export function deliveredRunOf(
  db: Reader,
  specificationId: string,
  revision: number,
): { number: number; commit: string } | null {
  const record = readSpecRecord(db, specificationId);
  const set = record.sets.find((candidate) => candidate.revision === revision);
  if (set === undefined) {
    return null;
  }
  // `readSpecRuns` is newest first.
  const run = readSpecRuns(db, specificationId).find(
    (candidate) => candidate.ticketSetId === set.id && candidate.mergedAt !== null,
  );
  if (run === undefined) {
    return null;
  }
  return { number: run.number, commit: present(run.finalCommit, `Merged run ${run.id}'s commit`) };
}

/**
 * Each spec of the project not in `excluded` (D6): its latest revision, its latest approved one
 * (the revision a touch names, S8b-2, L213 D-5; null when none is), whether a merged run delivered
 * it, and its hold seen from `mapId` (null when unheld).
 */
export function projectSpecContexts(
  db: Reader,
  projectId: string,
  mapId: string,
  excluded: ReadonlySet<string>,
): ProjectSpecContext[] {
  return readProjectSpecs(db, projectId)
    .filter((spec) => !excluded.has(spec.id))
    .map((spec) => {
      const revisions = readSpecRevisions(db, spec.id);
      const latest = latestOf(revisions);
      const approved = revisions.filter((revision) => revision.approvedAt !== null).at(-1);
      return {
        latest: { specNumber: spec.number, revision: latest.revision, content: latest.content },
        retiredIds: retiredIds(revisions.map((revision) => revision.content)),
        approved:
          approved === undefined
            ? null
            : { specNumber: spec.number, revision: approved.revision, content: approved.content },
        delivered: readSpecRuns(db, spec.id).some((run) => run.mergedAt !== null),
        hold: specHold(db, spec.id, mapId),
        writerMapId: latest.mapId,
      };
    });
}

/** The map's open waits (D6), oldest first: the spec's number and the change it waits to make. */
export function openWaits(db: Reader, mapId: string): { specNumber: number; note: string }[] {
  return db
    .select({ specNumber: specifications.number, note: specWaits.note })
    .from(specWaits)
    .innerJoin(specifications, eq(specifications.id, specWaits.specificationId))
    .where(and(eq(specWaits.mapId, mapId), isNull(specWaits.releasedAt)))
    .orderBy(asc(specWaits.since), asc(specWaits.id))
    .all();
}

/**
 * Each criterion of revision `n` read against the text delta and the baseline (S8b-13): its change
 * (`new` throughout revision 1, which has no delta), its expectation, the delivery that last built
 * it before `n`, and, when `dispositions` are given, the departure of its disposition. The
 * criteria `n` takes out are the delta's `removedCriteria`; the demo reads no expectation of them.
 */
export function readingsOf(
  record: SpecRecord,
  n: number,
  delta: TextDelta | null,
  dispositions: readonly Disposition[] | null,
): Record<string, CriterionReading> {
  const revision = record.revisions.find((candidate) => candidate.revision === n);
  if (revision === undefined) {
    throw new Error(`The spec has no r${String(n)}`);
  }
  const readings: Record<string, CriterionReading> = {};
  for (const criterion of revision.content.clauses.flatMap((clause) => clause.criteria)) {
    const id = criterion.id;
    const change = delta === null ? null : delta.criteria[id];
    if (change === undefined) {
      throw new Error(`Criterion ${id} of r${String(n)} is not in its delta`);
    }
    const earlier = change === null ? null : change.before;
    const earlierId = earlier === null ? id : earlier.id;
    const delivered = baseline(record, n, earlierId);
    const disposition = dispositions?.find((candidate) => candidate.criterion === id);
    readings[id] = {
      change: change === null ? "new" : change.change,
      expectation: expectation(record, delta, id),
      baseline:
        delivered === null
          ? null
          : {
              ticket: delivered.ticket.id,
              revision: delivered.revision,
              run: delivered.run,
              commit: delivered.commit,
            },
      departure: disposition === undefined ? null : tension(record, delta, disposition),
    };
  }
  return readings;
}
