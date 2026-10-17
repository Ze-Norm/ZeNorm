/**
 * The reconciliation reads: what a spec's revision changes from the revision before (the text
 * delta), what was delivered (the baseline), what an earlier approved set still carries (the open
 * carrier), and what that leads one to expect of each criterion's disposition. Derived from stored
 * rows, read once by `readSpecRecord` into a `SpecRecord`; nothing here writes or stores a result.
 */
import type {
  Clause,
  Criterion,
  Disposition,
  DispositionKind,
  SpecRevisionContent,
  TextDelta,
  TicketContent,
  TicketSetContent,
  TicketsReviewFinding,
} from "@zenorm/contracts";
import { deliveryRunTickets, deliveryRuns } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, eq } from "drizzle-orm";

import { readSetVersion, readSpecRevisions, readTicketSetOf } from "./specs.ts";

type Reader = Pick<ZeNormDatabase, "select">;

/** One revision of the spec: its number, the map that wrote it, its content and whether approved. */
export interface RevisionRecord {
  readonly revision: number;
  readonly mapId: string;
  readonly content: SpecRevisionContent;
  readonly approved: boolean;
}

/** The ticket set of one revision, at its current version. */
export interface SetRecord {
  readonly id: string;
  readonly revision: number;
  readonly approved: boolean;
  readonly content: TicketSetContent;
}

/**
 * One delivery run of the spec: its set, number, whether Mark merged recorded it, and its ticket
 * rows with the merged commit (null while not merged). A run from before `0010` has no rows.
 */
export interface RunRecord {
  readonly ticketSetId: string;
  readonly number: number;
  readonly merged: boolean;
  readonly tickets: readonly { readonly ticket: string; readonly commit: string | null }[];
}

/** A spec's stored rows the reads need: revisions, sets and runs, each ascending by number. */
export interface SpecRecord {
  readonly revisions: readonly RevisionRecord[];
  readonly sets: readonly SetRecord[];
  readonly runs: readonly RunRecord[];
}

/** Reads the spec's revisions, ticket sets (current version) and delivery runs with their tickets. */
export function readSpecRecord(db: Reader, specificationId: string): SpecRecord {
  const revisions: RevisionRecord[] = [];
  const sets: SetRecord[] = [];
  for (const row of readSpecRevisions(db, specificationId)) {
    revisions.push({
      revision: row.revision,
      mapId: row.mapId,
      content: row.content,
      approved: row.approvedAt !== null,
    });
    const set = readTicketSetOf(db, row.id);
    if (set !== undefined) {
      sets.push({
        id: set.id,
        revision: row.revision,
        approved: set.state === "approved",
        content: readSetVersion(db, set.id, set.version).content,
      });
    }
  }
  const runs = db
    .select({
      id: deliveryRuns.id,
      ticketSetId: deliveryRuns.ticketSetId,
      number: deliveryRuns.number,
      mergedAt: deliveryRuns.mergedAt,
    })
    .from(deliveryRuns)
    .where(eq(deliveryRuns.specificationId, specificationId))
    .orderBy(asc(deliveryRuns.number))
    .all()
    .map((run) => ({
      ticketSetId: run.ticketSetId,
      number: run.number,
      merged: run.mergedAt !== null,
      tickets: db
        .select({ ticket: deliveryRunTickets.ticket, commit: deliveryRunTickets.commit })
        .from(deliveryRunTickets)
        .where(eq(deliveryRunTickets.runId, run.id))
        .orderBy(asc(deliveryRunTickets.position))
        .all(),
    }));
  return { revisions, sets, runs };
}

// --- Lookups --------------------------------------------------------------------------

function revisionN(spec: SpecRecord, n: number): RevisionRecord {
  const found = spec.revisions.find((r) => r.revision === n);
  if (found === undefined) throw new Error(`The spec has no r${String(n)}`);
  return found;
}

function criteriaOf(content: SpecRevisionContent): { clause: Clause; criterion: Criterion }[] {
  return content.clauses.flatMap((clause) =>
    clause.criteria.map((criterion) => ({ clause, criterion })),
  );
}

function criterionById(
  revision: RevisionRecord,
  id: string,
): { clause: Clause; criterion: Criterion } {
  const found = criteriaOf(revision.content).find((c) => c.criterion.id === id);
  if (found === undefined) throw new Error(`No criterion ${id} in r${String(revision.revision)}`);
  return found;
}

/** The latest revision of the spec `mapId` wrote. */
function latestOnMap(spec: SpecRecord, mapId: string): number {
  return Math.max(...spec.revisions.filter((r) => r.mapId === mapId).map((r) => r.revision));
}

// --- The text delta -------------------------------------------------------------------

/**
 * What revision `n` changes from revision n − 1 (whatever became of it), matched by clause and
 * criterion id; null for revision 1. A `was` naming an id the revision before lacks, or a
 * criterion moved between clauses without `was`, is a programmer error: stored revisions passed
 * the id rules.
 */
export function textDelta(spec: SpecRecord, n: number): TextDelta | null {
  const after = revisionN(spec, n);
  if (n === 1) return null;
  const before = revisionN(spec, n - 1);
  const earlier = criteriaOf(before.content);
  const criteria: TextDelta["criteria"] = {};
  const clauses: TextDelta["clauses"] = {};
  const kept = new Set<string>();
  for (const clause of after.content.clauses) {
    const old = before.content.clauses.find((c) => c.id === clause.id);
    for (const criterion of clause.criteria) {
      const fromId = criterion.was ?? criterion.id;
      const was = earlier.find((e) => e.criterion.id === fromId);
      if (criterion.was !== undefined && was === undefined) {
        throw new Error(
          `Criterion ${criterion.id} of r${String(n)} says it was ${criterion.was}, which r${String(n - 1)} doesn't have`,
        );
      }
      if (was !== undefined && criterion.was === undefined && was.clause.id !== clause.id) {
        throw new Error(
          `Criterion ${criterion.id} moved from ${was.clause.id} to ${clause.id} in r${String(n)} without saying so`,
        );
      }
      if (was !== undefined) kept.add(was.criterion.id);
      criteria[criterion.id] =
        was === undefined
          ? { change: "new", before: null }
          : was.criterion.text !== criterion.text
            ? { change: "changed", before: was.criterion }
            : criterion.was !== undefined
              ? { change: "moved", before: was.criterion }
              : { change: "unchanged", before: null };
    }
    if (old === undefined) {
      clauses[clause.id] = "new";
      continue;
    }
    const dropped = old.criteria.some(
      (c) => !kept.has(c.id) && !clause.criteria.some((x) => x.id === c.id),
    );
    const same =
      old.title === clause.title &&
      old.text === clause.text &&
      !dropped &&
      clause.criteria.every((c) => criteria[c.id]?.change === "unchanged");
    clauses[clause.id] = same ? "unchanged" : "changed";
  }
  // A clause that lost a criterion to a move is changed, whichever order the clauses were walked in.
  for (const clause of after.content.clauses) {
    const old = before.content.clauses.find((c) => c.id === clause.id);
    if (
      old !== undefined &&
      clauses[clause.id] === "unchanged" &&
      old.criteria.some((c) => !clause.criteria.some((x) => x.id === c.id))
    ) {
      clauses[clause.id] = "changed";
    }
  }
  return {
    before: before.revision,
    after: after.revision,
    clauses,
    criteria,
    removedClauses: before.content.clauses.filter(
      (c) => !after.content.clauses.some((x) => x.id === c.id),
    ),
    removedCriteria: earlier.filter((e) => !kept.has(e.criterion.id)),
    outOfScopeAdded: after.content.outOfScope.filter((o) => !before.content.outOfScope.includes(o)),
    outOfScopeDropped: before.content.outOfScope.filter(
      (o) => !after.content.outOfScope.includes(o),
    ),
  };
}

/** How many criteria a revision adds, changes, moves and removes, in words. */
export function changeTally(delta: TextDelta): string {
  const changes = Object.values(delta.criteria);
  const count = (change: string) => changes.filter((x) => x.change === change).length;
  const parts: [number, string][] = [
    [count("new"), "new"],
    [count("changed"), "changed"],
    [count("moved"), "moved"],
    [delta.removedCriteria.length, "removed"],
    [count("unchanged"), "unchanged"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${String(n)} ${label}`)
    .join(" · ");
}

// --- The baseline ---------------------------------------------------------------------

/** Where a ticket was delivered: the run, the commit, and the set's revision and map. */
export interface Delivery {
  readonly ticket: TicketContent;
  readonly setId: string;
  readonly revision: number;
  readonly mapId: string;
  readonly run: number;
  readonly commit: string;
}

function setById(spec: SpecRecord, setId: string): SetRecord {
  const found = spec.sets.find((s) => s.id === setId);
  if (found === undefined) throw new Error(`The spec has no ticket set ${setId}`);
  return found;
}

/**
 * Where the set's ticket was delivered: its row, in a run of that set with `merged_at`
 * set, has a merged commit. Null while it isn't; a run from before `0010` has no rows, so never.
 * Keyed by set as well as ticket: a replaced set and its successor may share ticket ids.
 */
export function deliveryOf(spec: SpecRecord, setId: string, ticketId: string): Delivery | null {
  const set = setById(spec, setId);
  const ticket = set.content.tickets.find((t) => t.id === ticketId);
  if (ticket === undefined) throw new Error(`Ticket set ${setId} has no ticket ${ticketId}`);
  for (const run of spec.runs) {
    if (run.ticketSetId !== setId || !run.merged) continue;
    const row = run.tickets.find((t) => t.ticket === ticketId);
    if (row?.commit !== undefined && row.commit !== null) {
      return {
        ticket,
        setId,
        revision: set.revision,
        mapId: revisionN(spec, set.revision).mapId,
        run: run.number,
        commit: row.commit,
      };
    }
  }
  return null;
}

/**
 * The delivery that last built a criterion before revision `n`: the newest earlier set's
 * ticket carrying it that was delivered.
 */
export function baseline(spec: SpecRecord, n: number, criterionId: string): Delivery | null {
  for (const set of [...spec.sets].reverse()) {
    if (set.revision >= n) continue;
    for (const ticket of set.content.tickets) {
      if (!ticket.criteria.includes(criterionId)) continue;
      const delivery = deliveryOf(spec, set.id, ticket.id);
      if (delivery !== null) return delivery;
    }
  }
  return null;
}

/**
 * Whether a set can still be delivered: approved, no merged run, and its revision the latest its
 * own map wrote.
 */
export function isDeliverable(spec: SpecRecord, set: SetRecord): boolean {
  return (
    set.approved &&
    !spec.runs.some((run) => run.ticketSetId === set.id && run.merged) &&
    latestOnMap(spec, revisionN(spec, set.revision).mapId) === set.revision
  );
}

/**
 * A ticket of an earlier deliverable set that carries the criterion and hasn't been delivered.
 */
export function openCarrier(
  spec: SpecRecord,
  n: number,
  criterionId: string,
): { ticket: TicketContent; set: SetRecord } | null {
  for (const set of [...spec.sets].reverse()) {
    if (set.revision >= n || !isDeliverable(spec, set)) continue;
    const ticket = set.content.tickets.find(
      (t) => t.criteria.includes(criterionId) && deliveryOf(spec, set.id, t.id) === null,
    );
    if (ticket !== undefined) return { ticket, set };
  }
  return null;
}

/**
 * Whether an approved set of a revision before `n` disposes the criterion `removed`: that set took
 * it out, delivered or not, so no later revision takes it out again.
 */
function takenOutByApprovedSet(spec: SpecRecord, n: number, criterionId: string): boolean {
  return spec.sets.some(
    (set) =>
      set.revision < n &&
      set.approved &&
      set.content.dispositions.some((d) => d.criterion === criterionId && d.kind === "removed"),
  );
}

/**
 * Every criterion revision `n` takes out: one revision n − 1 had that `n` doesn't
 * keep, and one an earlier revision had that the revisions since dropped, when it
 * has a baseline or an open carrier before `n` (so one dropped in a replaced or superseded middle
 * revision is still taken out) and no approved set before `n` took it out already. Each
 * with the clause it sat in, from the latest revision holding it; revision n − 1's first, then
 * older ones newest first. Ids are never reused.
 */
export function removedCriteria(
  spec: SpecRecord,
  n: number,
): { clause: Clause; criterion: Criterion }[] {
  let kept = new Set(criteriaOf(revisionN(spec, n).content).map((c) => c.criterion.id));
  const removed: { clause: Clause; criterion: Criterion }[] = [];
  const seen = new Set<string>();
  for (let j = n - 1; j >= 1; j -= 1) {
    const later = revisionN(spec, j + 1);
    kept = new Set(
      criteriaOf(later.content)
        .filter((c) => kept.has(c.criterion.id))
        .map((c) => c.criterion.was ?? c.criterion.id),
    );
    for (const entry of criteriaOf(revisionN(spec, j).content)) {
      const id = entry.criterion.id;
      if (kept.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (
        j === n - 1 ||
        (!takenOutByApprovedSet(spec, n, id) &&
          (baseline(spec, n, id) !== null || openCarrier(spec, n, id) !== null))
      ) {
        removed.push(entry);
      }
    }
  }
  return removed;
}

// --- Expectations and departures ------------------------------------------------------

/** What the text delta and the baseline lead one to expect of a criterion's disposition. */
export interface Expectation {
  readonly kind: DispositionKind;
  readonly why: string;
}

/**
 * The expectation of a criterion: work when the criterion is new or reworded (since the
 * revision before, or since the revision that delivered or carries it), delivered when its
 * baseline still holds, retained when an open carrier still covers it.
 */
export function expectation(
  spec: SpecRecord,
  delta: TextDelta | null,
  criterionId: string,
): Expectation {
  if (delta === null) return { kind: "work", why: "first revision" };
  const n = delta.after;
  const change = delta.criteria[criterionId];
  if (change === undefined) throw new Error(`Criterion ${criterionId} isn't in r${String(n)}`);
  if (change.change === "new") return { kind: "work", why: `new in r${String(n)}` };
  if (change.change === "changed") {
    return { kind: "work", why: `its wording changed in r${String(n)}` };
  }
  const earlierId = change.before === null ? criterionId : change.before.id;
  // The text delta compares with the revision before, which may itself never have been delivered.
  // The baseline is what was delivered, so the wording is also checked against the revision that was.
  const text = criterionById(revisionN(spec, n), criterionId).criterion.text;
  const delivered = baseline(spec, n, earlierId);
  if (delivered !== null) {
    if (criterionById(revisionN(spec, delivered.revision), earlierId).criterion.text !== text) {
      return {
        kind: "work",
        why: `its wording changed since ${delivered.ticket.id} delivered it under r${String(delivered.revision)}`,
      };
    }
    return {
      kind: "delivered",
      why: `unchanged, delivered by ${delivered.ticket.id} in run ${String(delivered.run)}`,
    };
  }
  const open = openCarrier(spec, n, earlierId);
  if (open !== null) {
    if (criterionById(revisionN(spec, open.set.revision), earlierId).criterion.text !== text) {
      return {
        kind: "work",
        why: `its wording changed since ${open.ticket.id} of r${String(open.set.revision)} was written for it`,
      };
    }
    return {
      kind: "retained",
      why: `unchanged, carried by ${open.ticket.id} of r${String(open.set.revision)}, not yet delivered`,
    };
  }
  return { kind: "work", why: "unchanged, never delivered" };
}

/**
 * The question the tickets review asks when a disposition departs from its expectation, with
 * the disposition's reason; null when it doesn't depart.
 */
export function tension(
  spec: SpecRecord,
  delta: TextDelta | null,
  d: Disposition,
): { question: string; reason: string | null } | null {
  if (d.kind === "removed" || d.kind === "satisfied") return null;
  const expected = expectation(spec, delta, d.criterion);
  if (expected.kind === d.kind) return null;
  const reason = d.reason;
  if (expected.kind === "delivered" && d.kind === "work") {
    return {
      question: `${d.criterion} is ${expected.why}. Why does ${d.ticket} need to change it?`,
      reason,
    };
  }
  if (expected.kind === "retained" && d.kind === "work") {
    return {
      question: `${d.criterion} is ${expected.why}. Why does ${d.ticket} carry it again?`,
      reason,
    };
  }
  if (expected.kind === "work" && d.kind === "delivered") {
    return {
      question: `${d.criterion} is ${expected.why}, yet it is marked delivered by ${d.ticket}. Why does what ${d.ticket} built still meet it?`,
      reason,
    };
  }
  if (expected.kind === "work" && d.kind === "retained") {
    return {
      question: `${d.criterion} is ${expected.why}, yet it is left to ${d.ticket}, which was written before the change. Why does that ticket still cover it?`,
      reason,
    };
  }
  if (expected.kind === "delivered" && d.kind === "retained") {
    return {
      question: `${d.criterion} is ${expected.why}, yet it is marked as carried by the open ticket ${d.ticket}.`,
      reason,
    };
  }
  if (expected.kind === "retained" && d.kind === "delivered") {
    return {
      question: `${d.criterion} is ${expected.why}, yet it is marked delivered by ${d.ticket}.`,
      reason,
    };
  }
  throw new Error(
    `Unhandled disposition ${d.kind} against expected ${expected.kind} for ${d.criterion}`,
  );
}

/** The dispositions of a set, tallied by kind, for a line of text. */
export function dispositionTally(content: TicketSetContent): string {
  const count = (kind: DispositionKind) =>
    content.dispositions.filter((d) => d.kind === kind).length;
  const parts: [number, string][] = [
    [count("work"), "need work"],
    [count("delivered"), "carry over"],
    [count("retained"), "retained"],
    [count("satisfied"), "already done"],
    [count("removed"), "removed"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${String(n)} ${label}`)
    .join(" · ");
}

// --- Checks over references ------------------------------------------

/**
 * The delivery of the ticket a revision-`n` set names by id (a `delivered` disposition or a
 * follow-up): the newest earlier set's ticket of that id that a merged run
 * delivered; null when none did.
 */
export function deliveredTicket(spec: SpecRecord, n: number, ticketId: string): Delivery | null {
  for (const set of [...spec.sets].reverse()) {
    if (set.revision >= n || !set.content.tickets.some((t) => t.id === ticketId)) continue;
    const delivery = deliveryOf(spec, set.id, ticketId);
    if (delivery !== null) return delivery;
  }
  return null;
}

/**
 * Whether `ticketId` is an open, deliverable carrier of the criterion before revision `n`: a
 * ticket of an earlier deliverable set, not delivered, carrying the criterion or the one it was
 * in revision n − 1.
 */
export function isOpenCarrier(
  spec: SpecRecord,
  n: number,
  criterionId: string,
  ticketId: string,
): boolean {
  const before = n === 1 ? undefined : textDelta(spec, n)?.criteria[criterionId]?.before;
  const earlierId = before === undefined || before === null ? criterionId : before.id;
  return spec.sets.some(
    (set) =>
      set.revision < n &&
      isDeliverable(spec, set) &&
      set.content.tickets.some(
        (t) =>
          t.id === ticketId &&
          t.criteria.includes(earlierId) &&
          deliveryOf(spec, set.id, t.id) === null,
      ),
  );
}

/**
 * The criteria of a set's dispositions that depart from their expectation with no reason
 * and that no `disposition_without_reason` finding names: each fails the tickets review
 * `review_departure_missed`. A departure with a reason needs no finding; core never judges one.
 */
export function missedDepartures(
  spec: SpecRecord,
  n: number,
  content: TicketSetContent,
  findings: readonly Pick<TicketsReviewFinding, "kind" | "criterionIds">[],
): string[] {
  const delta = textDelta(spec, n);
  const named = new Set(
    findings
      .filter((finding) => finding.kind === "disposition_without_reason")
      .flatMap((finding) => finding.criterionIds),
  );
  return content.dispositions
    .filter((d) => {
      const departure = tension(spec, delta, d);
      return departure !== null && departure.reason === null && !named.has(d.criterion);
    })
    .map((d) => d.criterion);
}
