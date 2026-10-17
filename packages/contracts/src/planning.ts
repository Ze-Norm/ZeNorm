import { z } from "zod";

import { EntityId } from "./map.ts";

export const REJECTION_REASON_MAX_LENGTH = 4000;

/** The person's reason for rejecting a spec revision or a ticket set version; the next one addresses it. */
export const RejectionReason = z.string().trim().min(1).max(REJECTION_REASON_MAX_LENGTH);

/** `spec.approve`: the spec's latest draft revision, by id (S7-11). */
export const ApproveSpecInput = z.strictObject({ specRevisionId: EntityId });
export type ApproveSpecInput = z.infer<typeof ApproveSpecInput>;

/** `spec.reject`: the spec's latest draft revision, by id, and the reason (S7-12). */
export const RejectSpecInput = z.strictObject({
  specRevisionId: EntityId,
  reason: RejectionReason,
});
export type RejectSpecInput = z.infer<typeof RejectSpecInput>;

/** `ticketSet.approve`: the set's current version (S7-17). */
export const ApproveTicketSetInput = z.strictObject({ ticketSetId: EntityId });
export type ApproveTicketSetInput = z.infer<typeof ApproveTicketSetInput>;

/** `ticketSet.reject`: the set's current version and the reason (S7-18). */
export const RejectTicketSetInput = z.strictObject({
  ticketSetId: EntityId,
  reason: RejectionReason,
});
export type RejectTicketSetInput = z.infer<typeof RejectTicketSetInput>;
