import { z } from "zod";

import { EntityId, MapTitle } from "./map.ts";
import { Clause, ClauseId, ContentLine, Criterion, CriterionId, TicketId } from "./spec-content.ts";

// The reads that compare a spec's revisions with each other and with what was delivered. Core
// derives them from stored rows; nothing stores them.

/** How a clause of a revision differs from the revision before. */
export const ClauseChange = z.enum(["new", "changed", "unchanged"]);
export type ClauseChange = z.infer<typeof ClauseChange>;

/** How a criterion of a revision differs from the revision before. */
export const CriterionChange = z.enum(["new", "changed", "moved", "unchanged"]);
export type CriterionChange = z.infer<typeof CriterionChange>;

/**
 * What a revision changes from the revision before it, by clause and criterion id (CONTEXT Text
 * delta), with the revisions by number.
 */
export const TextDelta = z.strictObject({
  before: z.int().min(1),
  after: z.int().min(2),
  clauses: z.record(ClauseId, ClauseChange),
  /** Every criterion of the revision, with its earlier form when it changed or moved. */
  criteria: z.record(
    CriterionId,
    z.strictObject({ change: CriterionChange, before: Criterion.nullable() }),
  ),
  removedClauses: z.array(Clause),
  /** Criteria the revision drops, each with the clause it sat in, those of dropped clauses included. */
  removedCriteria: z.array(z.strictObject({ clause: Clause, criterion: Criterion })),
  outOfScopeAdded: z.array(ContentLine),
  outOfScopeDropped: z.array(ContentLine),
});
export type TextDelta = z.infer<typeof TextDelta>;

/** A disposition kind. */
export const DispositionKind = z.enum(["work", "satisfied", "delivered", "retained", "removed"]);
export type DispositionKind = z.infer<typeof DispositionKind>;

/**
 * One criterion of a revision read against the text delta and the baseline: its change, what that
 * leads one to expect (`expectation`), the delivery that last built it (`baseline`) and, when the
 * set's disposition departs from the expectation, the review's question and the disposition's
 * reason (`tension`).
 */
export const CriterionReading = z.strictObject({
  change: CriterionChange,
  expectation: z.strictObject({ kind: DispositionKind, why: z.string().min(1) }),
  baseline: z
    .strictObject({
      ticket: TicketId,
      revision: z.int().min(1),
      run: z.int().min(1),
      commit: z.string().min(1),
    })
    .nullable(),
  departure: z
    .strictObject({ question: z.string().min(1), reason: z.string().min(1).nullable() })
    .nullable(),
});
export type CriterionReading = z.infer<typeof CriterionReading>;

/** What holds a spec against another map's change. */
export const SpecHoldKind = z.enum(["revision", "revising", "tickets", "delivering"]);
export type SpecHoldKind = z.infer<typeof SpecHoldKind>;

/**
 * The hold on a spec: its kind, the holding map and the revision it holds. `revision` is, by kind:
 * `revision` the unapproved latest revision; `revising` the latest revision the run writes the next
 * one after; `tickets` the approved revision whose set the run writes or reviews; `delivering` the
 * revision whose set the active run delivers.
 */
export const SpecHold = z.strictObject({
  kind: SpecHoldKind,
  mapId: EntityId,
  mapTitle: MapTitle,
  revision: z.int().min(1),
});
export type SpecHold = z.infer<typeof SpecHold>;

/** A spec's page on a map: the path agent text may link a spec by, and the one the web opens. */
export function specPagePath(mapId: string, specNumber: number): string {
  return `/maps/${mapId}/spec/${String(specNumber)}`;
}

const SPEC_PAGE_PATH = /^\/maps\/([^/]+)\/spec\/(\d+)$/;

/** The map and spec number of a spec page path; null for any other link. */
export function parseSpecPagePath(href: string): { mapId: string; specNumber: number } | null {
  const match = SPEC_PAGE_PATH.exec(href);
  if (match === null) return null;
  const [, mapId, number] = match;
  if (mapId === undefined || number === undefined || !EntityId.safeParse(mapId).success) {
    return null;
  }
  const specNumber = Number(number);
  return specNumber >= 1 ? { mapId, specNumber } : null;
}
