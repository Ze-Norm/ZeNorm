import { specRevisions } from "@zenorm/db";
import { and, eq, isNull } from "drizzle-orm";

import { deliveryOutcome, readSpecRuns } from "./delivery.ts";
import type { HatchApplied, HatchApplyContext, HatchApplier } from "./hatch-runs.ts";
import {
  insertRun,
  isCleared,
  isSupersededStop,
  now,
  otherMapWorking,
  readClearing,
  readMap,
  readMapRuns,
  reclearDue,
  scopeRun,
  scopeRuns,
  specRuns,
} from "./planning-runs.ts";
import type { Tx } from "./planning-runs.ts";
import { recordWait, specHold, waitsOn } from "./spec-holds.ts";
import { latestOf, readSpecRevisions, readTicketSetOf } from "./specs.ts";

/**
 * The spec a note is about (L153 (b)): the spec number the page sent with the message (slice 7c
 * D9). A spec change from a message sent with no spec (from Idea or Wayfinding, or from Spec or
 * Tickets while the page showed none) is the agent's mistake, so the run fails
 * `hatch_change_invalid` with the problem and its retry carries it (S7b-4, L142).
 */
function noteSpec(
  { message }: HatchApplyContext,
  kind: "revise_spec" | "rewrite_tickets",
): string | Extract<HatchApplied, { result: "invalid" }> {
  if (message.specificationId !== null) {
    return message.specificationId;
  }
  return {
    result: "invalid",
    failure: {
      code: "hatch_change_invalid",
      message: `The ${kind} change needs a spec on screen, but the message was sent from ${message.stage} with none`,
    },
  };
}

/**
 * The work in flight on the spec (D4's `spec_in_flight`), or null: `working` while its spec scope
 * works (a `spec_review`, spec-scoped `to_spec`, `to_tickets` or `tickets_review` runs or awaits
 * its retry), `stopped` while it is stopped (a superseded stop aside, S7-26; Try again ends a
 * stop), else `delivering` while an active delivery run is on it. The refusal's reply is chosen
 * by it (L180 (1)).
 */
export function specWork(
  tx: Tx,
  mapId: string,
  specificationId: string,
): "working" | "stopped" | "delivering" | null {
  const runs = readMapRuns(tx, mapId);
  const clearing = readClearing(tx, readMap(tx, mapId), runs);
  const scope = specRuns(runs, specificationId);
  const shown = scopeRun(scope);
  const latest = scope.at(-1);
  if (shown === "working") {
    return "working";
  }
  if (shown !== null && latest !== undefined && !isSupersededStop(latest, clearing)) {
    return "stopped";
  }
  return readSpecRuns(tx, specificationId).some((run) => deliveryOutcome(run) === "active")
    ? "delivering"
    : null;
}

/**
 * The work a `rewrite_tickets` note is refused `spec_in_flight` for: this map's `specWork`, else
 * `working` while another map's spec-scoped run on the spec runs or awaits its retry (slice 8b
 * S8b-4: one running run per spec across maps); null when neither. The refusal's reply is chosen
 * by it.
 */
export function noteWork(
  tx: Tx,
  mapId: string,
  specificationId: string,
): "working" | "stopped" | "delivering" | null {
  const work = specWork(tx, mapId, specificationId);
  if (work !== null) {
    return work;
  }
  return otherMapWorking(tx, specificationId, mapId) ? "working" : null;
}

/** Starts the spec-scoped run a note directs, recording the message (S7b-13). */
function startNoteRun(
  tx: Tx,
  { run, message, actor }: HatchApplyContext,
  specificationId: string,
  purpose: "to_spec" | "to_tickets",
): void {
  insertRun(actor, tx, {
    mapId: run.mapId,
    waypointId: null,
    specificationId,
    purpose,
    retryOfRunId: null,
    hatchMessageId: message.id,
  });
}

/**
 * Applies a `revise_spec` change (S7b-11; slice 8b S8b-7) in the hatch run's transaction, on the
 * message's spec. In order (the hold is read first, S8b-4): `spec_waiting` when the map already
 * waits on the spec (a second open wait would break `spec_waits`' partial unique index); when
 * another map holds it (`revision`, `revising` or `tickets`), it records the map's wait with the
 * message's text, the message and the hold seen now, and the reply is core's sentence for the hold
 * (`waited`; nothing is applied until the release run, which carries the message); `spec_in_flight`
 * while this map's own work is in flight on the spec or a delivery run of it is active;
 * `map_uncleared` while the map is un-cleared, its map-scope `to_spec` works or its re-clear is due
 * (S7-10, as `spec.reject`). Otherwise a note on an approved latest revision (on any map) starts a
 * note run, a spec-scoped `to_spec` carrying the message that writes the next revision from this
 * map and supersedes nothing; a note on the map's own draft supersedes it with no rejection
 * recorded and starts that run. The request has the note as feedback; `planNext` then finds the
 * spec's scope running and the revision it writes is reviewed (S7-7). `spec_approved` is no longer
 * returned (L145 (2)).
 */
export const applyReviseSpec: HatchApplier<"revise_spec"> = (tx, context) => {
  const specificationId = noteSpec(context, "revise_spec");
  if (typeof specificationId !== "string") {
    return specificationId;
  }
  const { mapId } = context.run;
  if (waitsOn(tx, mapId, specificationId)) {
    return { result: "refused", refusal: "spec_waiting" };
  }
  const hold = specHold(tx, specificationId, mapId);
  const kind = hold?.kind;
  if (hold !== null && kind !== undefined && kind !== "delivering") {
    recordWait(
      tx,
      {
        mapId,
        specificationId,
        note: context.message.text,
        hatchMessageId: context.message.id,
        hold,
      },
      now(),
    );
    return { result: "waited", hold: { ...hold, kind } };
  }
  if (specWork(tx, mapId, specificationId) !== null) {
    return { result: "refused", refusal: "spec_in_flight" };
  }
  const map = readMap(tx, mapId);
  const runs = readMapRuns(tx, mapId);
  const clearing = readClearing(tx, map, runs);
  const mapScope = scopeRuns(runs, null);
  if (
    !isCleared(clearing) ||
    (scopeRun(mapScope) === "working" && mapScope.at(-1)?.purpose === "to_spec") ||
    reclearDue(tx, mapId, runs)
  ) {
    return { result: "refused", refusal: "map_uncleared" };
  }
  const latest = latestOf(readSpecRevisions(tx, specificationId));
  if (latest.approvedAt !== null) {
    startNoteRun(tx, context, specificationId, "to_spec");
    return { result: "applied" };
  }
  if (latest.mapId !== mapId || latest.supersededAt !== null) {
    // Another map's draft is a hold; a rejected or noted latest has its repair in flight (S7-12).
    throw new Error(
      `Spec ${specificationId}'s latest revision ${latest.id} is not a draft of map ${mapId} with nothing in flight`,
    );
  }
  const superseded = tx
    .update(specRevisions)
    .set({ supersededAt: now() })
    .where(
      and(
        eq(specRevisions.id, latest.id),
        isNull(specRevisions.approvedAt),
        isNull(specRevisions.supersededAt),
      ),
    )
    .run();
  if (superseded.changes !== 1) {
    throw new Error(`Revision ${latest.id} was not a draft when a note superseded it`);
  }
  startNoteRun(tx, context, specificationId, "to_spec");
  return { result: "applied" };
};

/**
 * Applies a `rewrite_tickets` change (S7b-12, D8) in the hatch run's transaction, on the message's
 * spec. Refused, in order (D4): `spec_in_flight` while work is in flight on the spec (a `to_tickets`
 * or an active delivery run among it) or another map's spec-scoped run on it runs or awaits its
 * retry (slice 8b S8b-4: one running run per spec across maps); `no_ticket_set` when the spec has no approved revision on
 * the map, or no set for it; `ticket_set_approved` when that set is approved. Otherwise, from any
 * unapproved state (`awaiting_review` or `review_failed`, L32), it starts a `to_tickets` rewrite
 * carrying the message, whose reason is the note; the run writes version + 1 in `awaiting_review`.
 * No rejection is recorded. On a held set this is the hold's exit (S7c-8, issue 21 item 2): the
 * note outranks the held findings the request also carries (L141), the version it writes gets a
 * full review, and, written by a run carrying a message, it is no review repair, so the count
 * restarts (S7c-5). A running `tickets_review` or review repair is in flight on the spec.
 */
export const applyRewriteTickets: HatchApplier<"rewrite_tickets"> = (tx, context) => {
  const specificationId = noteSpec(context, "rewrite_tickets");
  if (typeof specificationId !== "string") {
    return specificationId;
  }
  const { mapId } = context.run;
  if (noteWork(tx, mapId, specificationId) !== null) {
    return { result: "refused", refusal: "spec_in_flight" };
  }
  const approved = readSpecRevisions(tx, specificationId)
    .filter((revision) => revision.mapId === mapId && revision.approvedAt !== null)
    .at(-1);
  const set = approved === undefined ? undefined : readTicketSetOf(tx, approved.id);
  if (set === undefined) {
    return { result: "refused", refusal: "no_ticket_set" };
  }
  if (set.state === "approved") {
    return { result: "refused", refusal: "ticket_set_approved" };
  }
  if (
    approved !== undefined &&
    approved.revision !== latestOf(readSpecRevisions(tx, specificationId)).revision
  ) {
    // A replaced set (S8b-9, L206 (4)): a later revision of the spec has no set yet, and no
    // `to_tickets` starts on a replaced one.
    return { result: "refused", refusal: "no_ticket_set" };
  }
  startNoteRun(tx, context, specificationId, "to_tickets");
  return { result: "applied" };
};
