import { z } from "zod";

import { HatchRefusal } from "./codes.ts";
import { EntityId } from "./map.ts";
import { StoppedRun } from "./wayfinding.ts";

/** The most characters a hatch message holds. */
export const HATCH_MESSAGE_MAX_LENGTH = 4000;
/** A message the person sends through the escape hatch. */
export const HatchMessageText = z.string().min(1).max(HATCH_MESSAGE_MAX_LENGTH);

/** The most characters a hatch reply holds. */
export const HATCH_REPLY_MAX_LENGTH = 2000;
/** A hatch reply: the agent's answer in the stream, 1 to 2000 characters. */
export const HatchReply = z.string().min(1).max(HATCH_REPLY_MAX_LENGTH);

/** The stage a hatch message was sent from: the four planning stages, never `delivery`. */
export const HatchStage = z.enum(["idea", "wayfinding", "spec", "tickets"]);
export type HatchStage = z.infer<typeof HatchStage>;

/** The stages whose messages name no spec (a check constraint keeps the spec null). */
export const HATCH_STAGES_WITHOUT_SPEC: readonly HatchStage[] = ["idea", "wayfinding"];

/**
 * `hatch.send`: the map, the stage on screen, the spec on screen by number (null when the route
 * names none; always null on Idea and Wayfinding) and the text. Blank text reaches core, which
 * refuses it `hatch_message_empty`.
 */
export const SendHatchMessageInput = z
  .strictObject({
    mapId: EntityId,
    stage: HatchStage,
    specNumber: z.int().min(1).nullable(),
    text: z.string().max(HATCH_MESSAGE_MAX_LENGTH),
  })
  .refine(
    (input) => input.specNumber === null || !HATCH_STAGES_WITHOUT_SPEC.includes(input.stage),
    { message: "A message from Idea or Wayfinding names no spec", path: ["specNumber"] },
  );
export type SendHatchMessageInput = z.infer<typeof SendHatchMessageInput>;

/**
 * A message's state as the stream reads it: `queued` until its `hatch` run starts, `working` while
 * that run runs or awaits its retry, `stopped` on a failed retry (Try again acts on
 * `stopped.runId`), `replied` once the reply is stored (a refusal is a reply with its code).
 */
export const HatchMessageState = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("queued") }),
  z.strictObject({ state: z.literal("working") }),
  z.strictObject({ state: z.literal("stopped"), stopped: StoppedRun }),
  z.strictObject({
    state: z.literal("replied"),
    reply: HatchReply,
    refusal: HatchRefusal.nullable(),
    /** ISO 8601 UTC. */
    repliedAt: z.iso.datetime(),
  }),
]);
export type HatchMessageState = z.infer<typeof HatchMessageState>;

/** One message the map was sent through the hatch, with its reply when it has one. */
export const HatchMessageView = z.strictObject({
  id: EntityId,
  stage: HatchStage,
  /** The number of the spec on screen when it was sent; null on Idea and Wayfinding or before any spec. */
  spec: z.int().min(1).nullable(),
  text: HatchMessageText,
  /** ISO 8601 UTC. */
  sentAt: z.iso.datetime(),
  status: HatchMessageState,
});
export type HatchMessageView = z.infer<typeof HatchMessageView>;
