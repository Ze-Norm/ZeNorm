import { z } from "zod";

import { EntityId } from "./map.ts";

/**
 * A User's id: 32 lowercase hex characters, as migration `0020` creates the one row
 * (`lower(hex(randomblob(16)))`). Not a UUIDv7, unlike every other entity id.
 */
export const UserId = z.string().regex(/^[0-9a-f]{32}$/);
export type UserId = z.infer<typeof UserId>;

/** The kinds of Actor (CONTEXT.md Actor). */
export const ActorKind = z.enum(["user", "planning_run", "delivery_run", "system"]);
export type ActorKind = z.infer<typeof ActorKind>;

/**
 * The User or agent run a write is attributed to. A run actor also names the User the run is
 * attributed to; `system` is ZeNorm acting with no person behind the action (the startup sweep).
 */
export const Actor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userId: UserId }),
  z.strictObject({ kind: z.literal("planning_run"), runId: EntityId, userId: UserId }),
  z.strictObject({ kind: z.literal("delivery_run"), runId: EntityId, userId: UserId }),
  z.strictObject({ kind: z.literal("system") }),
]);
export type Actor = z.infer<typeof Actor>;

/** A person's Actor: what an RPC procedure writes as, and the only one a map is created by. */
export type UserActor = Extract<Actor, { kind: "user" }>;
