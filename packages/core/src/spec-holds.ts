/**
 * What holds a spec against a map's change: read only, derived from the latest
 * revision, the spec's planning runs on every map and its delivery runs; nothing stores it.
 */
import type { Actor, PlanningRun, SpecHold, SpecHoldKind } from "@zenorm/contracts";
import { maps, planningRuns, specRevisions, specWaits, ticketSets } from "@zenorm/db";
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { deliveryOutcome, readSpecRuns } from "./delivery.ts";
import {
  insertRun,
  isSupersededStop,
  now,
  planNext,
  readClearing,
  readMap,
  readMapRuns,
  runScope,
  scopeRun,
  specIdle,
  specRuns,
  stoppedRun,
  writesOpen,
} from "./planning-runs.ts";
import type { Reader, Tx } from "./planning-runs.ts";
import { latestOf, readSpecRevisions } from "./specs.ts";
import { approvedRevision } from "./ticket-set-runs.ts";

function holdOf(db: Reader, kind: SpecHoldKind, mapId: string, revision: number): SpecHold {
  const row = db.select({ title: maps.title }).from(maps).where(eq(maps.id, mapId)).get();
  if (row?.title == null) {
    throw new Error(`Map ${mapId} holds a spec but has no title`);
  }
  return { kind, mapId, mapTitle: row.title, revision };
}

/**
 * The latest spec-scoped run of `specificationId` on `mapId` while it counts:
 * running, awaiting its retry, or stopped and not superseded; null otherwise.
 */
function countingRun(db: Reader, mapId: string, specificationId: string): PlanningRun | null {
  const runs = readMapRuns(db, mapId);
  const scope = specRuns(runs, specificationId);
  const latest = scope.at(-1);
  const shown = scopeRun(scope);
  if (latest === undefined || shown === null) {
    return null;
  }
  if (shown === "working") {
    return latest;
  }
  return isSupersededStop(latest, readClearing(db, readMap(db, mapId), runs)) ? null : latest;
}

/** The maps other than `mapId` with a planning run on the spec, by their first run. */
function otherMaps(db: Reader, specificationId: string, mapId: string): string[] {
  const rows = db
    .select({ mapId: planningRuns.mapId })
    .from(planningRuns)
    .where(eq(planningRuns.specificationId, specificationId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all();
  return [...new Set(rows.map((row) => row.mapId))].filter((other) => other !== mapId);
}

/**
 * The hold on the spec seen from `mapId`, the first of: `revision` (the latest revision is
 * unapproved and another map wrote it), `revising` (another map's `to_spec` on the spec counts),
 * `tickets` (another map's `to_tickets` or `tickets_review` counts; this map's own are replaced by
 * its next revision), `delivering` (an active delivery run of the spec, `interrupted`
 * included, on any map); null when nothing holds it.
 */
export function specHold(db: Reader, specificationId: string, mapId: string): SpecHold | null {
  const latest = latestOf(readSpecRevisions(db, specificationId));
  if (latest.approvedAt === null && latest.mapId !== mapId) {
    return holdOf(db, "revision", latest.mapId, latest.revision);
  }
  const counting = otherMaps(db, specificationId, mapId).flatMap((other) => {
    const run = countingRun(db, other, specificationId);
    return run === null ? [] : [run];
  });
  const revising = counting.find((run) => run.purpose === "to_spec");
  if (revising !== undefined) {
    return holdOf(db, "revising", revising.mapId, latest.revision);
  }
  const tickets = counting.find(
    (run) => run.purpose === "to_tickets" || run.purpose === "tickets_review",
  );
  if (tickets !== undefined) {
    return holdOf(db, "tickets", tickets.mapId, approvedRevision(db, tickets).revision);
  }
  const active = readSpecRuns(db, specificationId).find((run) => deliveryOutcome(run) === "active");
  if (active !== undefined) {
    const delivered = db
      .select({ mapId: specRevisions.mapId, revision: specRevisions.revision })
      .from(ticketSets)
      .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
      .where(eq(ticketSets.id, active.ticketSetId))
      .get();
    if (delivered === undefined) {
      throw new Error(`Delivery run ${active.id}'s ticket set has no revision`);
    }
    return holdOf(db, "delivering", delivered.mapId, delivered.revision);
  }
  return null;
}

/** The map's open wait on the spec (at most one, `spec_waits`' partial unique index), or undefined. */
function openWait(db: Reader, mapId: string, specificationId: string) {
  return db
    .select()
    .from(specWaits)
    .where(
      and(
        eq(specWaits.mapId, mapId),
        eq(specWaits.specificationId, specificationId),
        isNull(specWaits.releasedAt),
      ),
    )
    .get();
}

/** Whether the map has an open wait on the spec (a note is refused `spec_waiting`). */
export function waitsOn(db: Reader, mapId: string, specificationId: string): boolean {
  return openWait(db, mapId, specificationId) !== undefined;
}

/** Whether the map has an open wait on any spec. */
export function waitsOnAny(db: Reader, mapId: string): boolean {
  return (
    db
      .select({ id: specWaits.id })
      .from(specWaits)
      .where(and(eq(specWaits.mapId, mapId), isNull(specWaits.releasedAt)))
      .get() !== undefined
  );
}

/**
 * Records the map's wait on a held spec with its note: a new open wait stores `hold`
 * (the spec's `specHold` now, written once) and `since` = `at`; when the map
 * already waits on the spec, only the note is replaced (its `since` and stored hold kept).
 */
export function recordWait(
  tx: Tx,
  wait: {
    mapId: string;
    specificationId: string;
    note: string;
    hatchMessageId: string | null;
    hold: SpecHold;
  },
  at: string,
): void {
  const open = openWait(tx, wait.mapId, wait.specificationId);
  if (open !== undefined) {
    tx.update(specWaits).set({ note: wait.note }).where(eq(specWaits.id, open.id)).run();
    return;
  }
  tx.insert(specWaits)
    .values({
      id: uuidv7(),
      mapId: wait.mapId,
      specificationId: wait.specificationId,
      note: wait.note,
      hatchMessageId: wait.hatchMessageId,
      since: at,
      holdKind: wait.hold.kind,
      holdMapId: wait.hold.mapId,
      holdRevision: wait.hold.revision,
      releasedAt: null,
      releasedByRun: null,
    })
    .run();
}

/**
 * Closes the map's open wait on the spec, if any, when the map writes a revision of it:
 * `released_at` = `at` and `released_by_run` the writing run.
 */
export function closeWait(
  tx: Tx,
  wait: { mapId: string; specificationId: string; runId: string },
  at: string,
): void {
  const open = openWait(tx, wait.mapId, wait.specificationId);
  if (open === undefined) {
    return;
  }
  tx.update(specWaits)
    .set({ releasedAt: at, releasedByRun: wait.runId })
    .where(and(eq(specWaits.id, open.id), isNull(specWaits.releasedAt)))
    .run();
}

/** The wait a release run writes for: the wait its `released_by_run` names, or undefined. */
export function releasedWaitOf(db: Reader, runId: string) {
  return db.select().from(specWaits).where(eq(specWaits.releasedByRun, runId)).get();
}

/**
 * Reopens a released wait: `released_at` and `released_by_run` cleared, its `since`, note
 * and stored hold kept. A wait that is not released is a programmer error.
 */
export function reopenWait(tx: Tx, waitId: string): void {
  const reopened = tx
    .update(specWaits)
    .set({ releasedAt: null, releasedByRun: null })
    .where(and(eq(specWaits.id, waitId), isNotNull(specWaits.releasedAt)))
    .run();
  if (reopened.changes !== 1) {
    throw new Error(`Wait ${waitId} was not released when reopened`);
  }
}

/**
 * Moves a release from `fromRunId` to the run that starts again in its scope (a retry, or Try
 * again's fresh run): the wait stays released, by the new run.
 */
export function followRelease(tx: Tx, fromRunId: string, toRunId: string): void {
  tx.update(specWaits)
    .set({ releasedByRun: toRunId })
    .where(eq(specWaits.releasedByRun, fromRunId))
    .run();
}

/**
 * Reopens each of the map's released waits whose release run ended before it wrote: the
 * run was cancelled (a reopen, a re-clear), or it is stopped and superseded (the map was
 * un-cleared, or a map-scope run started after it). `planNext` calls it last, so every
 * transaction that cancels or supersedes a release run reopens its wait.
 */
export function reopenStaleReleases(tx: Tx, mapId: string): void {
  // Only waits whose release run has not completed can be stale: a completed run wrote its
  // revision, so its long-closed waits are never rescanned.
  const released = tx
    .select({ id: specWaits.id, releasedByRun: specWaits.releasedByRun })
    .from(specWaits)
    .innerJoin(planningRuns, eq(planningRuns.id, specWaits.releasedByRun))
    .where(and(eq(specWaits.mapId, mapId), ne(planningRuns.state, "completed")))
    .all();
  if (released.length === 0) {
    return;
  }
  const runs = readMapRuns(tx, mapId);
  const clearing = readClearing(tx, readMap(tx, mapId), runs);
  for (const wait of released) {
    const run = runs.find((candidate) => candidate.id === wait.releasedByRun);
    if (run === undefined) {
      throw new Error(`Wait ${wait.id}'s release run is not a run of map ${mapId}`);
    }
    const stale =
      run.state === "cancelled" ||
      (stoppedRun(runScope(runs, run))?.runId === run.id && isSupersededStop(run, clearing));
    if (stale) {
      reopenWait(tx, wait.id);
    }
  }
}

/** Whether any map runs a planning run on the spec (one running run per spec). */
function specRunning(db: Reader, specificationId: string): boolean {
  return (
    db
      .select({ id: planningRuns.id })
      .from(planningRuns)
      .where(
        and(eq(planningRuns.specificationId, specificationId), eq(planningRuns.state, "running")),
      )
      .get() !== undefined
  );
}

/**
 * Releases the spec's oldest open wait it can: by `since`, then id, the first whose
 * map's writes are open (cleared, no map-scope `to_spec` working or due), whose spec scope on its
 * map is idle and on which nothing holds the spec (`specHold`), while no map runs a run on the
 * spec. It marks the wait released by a new release run, a spec-scoped `to_spec` on the waiting
 * map carrying the wait's `hatch_message_id` (so a note-born wait's revision is note-directed);
 * the request's feedback is the wait's note. The other waits stay open: the release run now
 * holds the spec (`revising`).
 */
export function releaseWaits(actor: Actor, tx: Tx, specificationId: string): void {
  const open = tx
    .select()
    .from(specWaits)
    .where(and(eq(specWaits.specificationId, specificationId), isNull(specWaits.releasedAt)))
    .orderBy(asc(specWaits.since), asc(specWaits.id))
    .all();
  for (const wait of open) {
    if (specRunning(tx, specificationId)) {
      return;
    }
    if (
      !writesOpen(tx, wait.mapId) ||
      !specIdle(tx, wait.mapId, specificationId) ||
      specHold(tx, specificationId, wait.mapId) !== null
    ) {
      continue;
    }
    const run = insertRun(actor, tx, {
      mapId: wait.mapId,
      waypointId: null,
      specificationId,
      purpose: "to_spec",
      retryOfRunId: null,
      hatchMessageId: wait.hatchMessageId,
    });
    const released = tx
      .update(specWaits)
      .set({ releasedAt: now(), releasedByRun: run.id })
      .where(and(eq(specWaits.id, wait.id), isNull(specWaits.releasedAt)))
      .run();
    if (released.changes !== 1) {
      throw new Error(`Wait ${wait.id} was not open when released`);
    }
    return;
  }
}

/**
 * The specs a map's transaction may end a hold on: each spec it wrote a revision of, has a planning
 * run on, or waits on (open or released).
 */
export function mapSpecIds(db: Reader, mapId: string): string[] {
  const written = db
    .select({ id: specRevisions.specificationId })
    .from(specRevisions)
    .where(eq(specRevisions.mapId, mapId))
    .all();
  const run = db
    .select({ id: planningRuns.specificationId })
    .from(planningRuns)
    .where(and(eq(planningRuns.mapId, mapId), isNotNull(planningRuns.specificationId)))
    .all();
  const waited = db
    .select({ id: specWaits.specificationId })
    .from(specWaits)
    .where(eq(specWaits.mapId, mapId))
    .all();
  return [
    ...new Set([...written, ...run, ...waited].flatMap((row) => (row.id === null ? [] : [row.id]))),
  ];
}

/** The maps that wrote a revision of the spec or have a planning run on it, by id. */
function specMapIds(db: Reader, specificationId: string): string[] {
  const written = db
    .select({ mapId: specRevisions.mapId })
    .from(specRevisions)
    .where(eq(specRevisions.specificationId, specificationId))
    .all();
  const run = db
    .select({ mapId: planningRuns.mapId })
    .from(planningRuns)
    .where(eq(planningRuns.specificationId, specificationId))
    .all();
  return [...new Set([...written, ...run].map((row) => row.mapId))].sort();
}

/**
 * Inserts what a write on the map made due, then settles the holds it may have ended: `planNext` of
 * the map first, so a holder's own due `to_tickets` starts and holds; then, per spec the map wrote,
 * runs on or waits on, `planNext` of every other map on that spec (a run the cross-map idle gate
 * held back starts once the run on the spec ends), and `releaseWaits` last. Every transaction that
 * can end a hold calls it in place of `planNext`.
 */
export function planAndRelease(actor: Actor, tx: Tx, mapId: string): void {
  planNext(actor, tx, mapId);
  for (const specificationId of mapSpecIds(tx, mapId)) {
    for (const other of specMapIds(tx, specificationId)) {
      if (other !== mapId) {
        planNext(actor, tx, other);
      }
    }
    releaseWaits(actor, tx, specificationId);
  }
}

/**
 * After a map is deleted (`deleteMap`), what its holds on `specIds` (`mapSpecIds`, read before the
 * delete) held back: `planNext` of every map on each spec, then `releaseWaits`, as
 * `planAndRelease` does for a map that remains.
 */
export function releaseAfterDelete(actor: Actor, tx: Tx, specIds: readonly string[]): void {
  for (const specificationId of specIds) {
    for (const other of specMapIds(tx, specificationId)) {
      planNext(actor, tx, other);
    }
    releaseWaits(actor, tx, specificationId);
  }
}
