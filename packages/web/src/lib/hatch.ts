import type {
  ActivityLine,
  HatchMessageView,
  HatchStage,
  MapOverviewDetail,
  Stage,
  StoppedRun,
} from "@zenorm/contracts";

import { shownSpec, waitsOnly } from "./specs.ts";

/**
 * One entry of the Activity stream (slice 7b D7, the demo's `LogEntry`): an event line, a message
 * sent through the hatch, or the agent's reply to one (a refusal is a reply). `stage` is what the
 * stage filter reads: a message's and its reply's stage are the message's.
 */
export type StreamEntry =
  | { kind: "event"; stage: Stage; at: string; line: ActivityLine }
  | { kind: "message"; stage: HatchStage; at: string; message: HatchMessageView }
  | { kind: "reply"; stage: HatchStage; at: string; message: HatchMessageView; reply: string };

/** At one moment a message comes before its reply, and the reply before the lines it caused. */
const TIE_ORDER: Record<StreamEntry["kind"], number> = { message: 0, reply: 1, event: 2 };

/**
 * The stream by time (D7): the activity lines and each message at its sent time, then its reply at
 * its replied time. Both inputs come oldest first; equal moments keep the order above.
 */
export function streamEntries(
  activity: readonly ActivityLine[],
  messages: readonly HatchMessageView[],
): StreamEntry[] {
  const entries: StreamEntry[] = activity.map((line) => ({
    kind: "event",
    stage: line.stage,
    at: line.at,
    line,
  }));
  for (const message of messages) {
    entries.push({ kind: "message", stage: message.stage, at: message.sentAt, message });
    if (message.status.state === "replied") {
      entries.push({
        kind: "reply",
        stage: message.stage,
        at: message.status.repliedAt,
        message,
        reply: message.status.reply,
      });
    }
  }
  return entries
    .map((entry, index) => ({ entry, index, time: Date.parse(entry.at) }))
    .sort(
      (a, b) =>
        a.time - b.time || TIE_ORDER[a.entry.kind] - TIE_ORDER[b.entry.kind] || a.index - b.index,
    )
    .map(({ entry }) => entry);
}

/** The stream's filter (D7): the whole map, or the stage on screen. */
export type StreamFilter = "map" | "stage";

/** What the filter shows: every entry, or those of the stage on screen (by a message's stage). */
export function filterStream(
  entries: readonly StreamEntry[],
  filter: StreamFilter,
  stage: Stage,
): StreamEntry[] {
  return filter === "map" ? [...entries] : entries.filter((entry) => entry.stage === stage);
}

/**
 * The messages whose run works, filtered as the stream is (D7: "while the run works"); each shows
 * the working line "The agent is replying." at the stream's end. A queued message shows none: it
 * may wait behind a stopped one (L153).
 */
export function replyingMessages(
  messages: readonly HatchMessageView[],
  filter: StreamFilter,
  stage: Stage,
): HatchMessageView[] {
  return messages.filter(
    (message) =>
      message.status.state === "working" && (filter === "map" || message.stage === stage),
  );
}

/** A message's stopped run, shown under it with **Try again**; null unless its run stopped. */
export function stoppedRun(message: HatchMessageView): StoppedRun | null {
  return message.status.state === "stopped" ? message.status.stopped : null;
}

/** What a key in the composer does (D7): Enter sends, Shift+Enter is a new line. */
export type ComposerKeyAction = "send" | "newline" | "none";

export function composerKeyAction(key: { key: string; shiftKey: boolean }): ComposerKeyAction {
  if (key.key !== "Enter") {
    return "none";
  }
  return key.shiftKey ? "newline" : "send";
}

/** Whether the composer's text can be sent (D7): Send is disabled while it is blank. */
export function canSend(text: string): boolean {
  return text.trim() !== "";
}

/** The clause footer's two prefills (D7, L145): Ask and Propose a change. */
export type ClausePrefill = "ask" | "propose";

/** The composer text a clause footer button opens the hatch with; it sends nothing. */
export function clausePrefill(kind: ClausePrefill, clauseId: string): string {
  switch (kind) {
    case "ask":
      return `About ${clauseId}: `;
    case "propose":
      return `${clauseId} should `;
  }
}

/** The stages a message can be sent from: Delivery shows no hatch (S7b-17). */
export function isHatchStage(stage: Stage): stage is HatchStage {
  return stage !== "delivery";
}

/**
 * The spec a message is about (D7, the demo's `aboutSpec`): on Spec and Tickets the spec the
 * page renders, the route's else `map.overview`'s default (slice 7c D9); on the Spec page of a spec
 * the map only waits on, that spec (slice 8b E-1), and so on its Tickets page
 * (S8b-16, N-4); null on Idea and Wayfinding, or while the map
 * has no spec.
 */
export function aboutSpec(
  detail: Pick<MapOverviewDetail, "specs" | "defaultSpecs" | "waits">,
  stage: HatchStage,
  specNumber: number | undefined,
): number | null {
  if (stage === "idea" || stage === "wayfinding") {
    return null;
  }
  if (specNumber !== undefined && waitsOnly(detail, specNumber)) {
    return specNumber;
  }
  const spec = shownSpec(detail, stage, specNumber);
  return spec === undefined ? null : spec.number;
}
