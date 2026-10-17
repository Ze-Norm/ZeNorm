import type { WaypointTouchView } from "@zenorm/contracts";

/**
 * The Touches card's sentence on the touched revision: the map that wrote it and whether a merged
 * run delivered it.
 */
export function touchOrigin(
  touch: Pick<WaypointTouchView, "writerMapTitle" | "delivered">,
): string {
  return `Its current revision came from “${touch.writerMapTitle}”${touch.delivered ? " and is delivered" : " and isn't delivered yet"}.`;
}

/** The card's closing line on the spec's revisions after the touched one, or null with none. */
export function laterRevisionsLine(laterRevisions: number): string | null {
  if (laterRevisions === 0) {
    return null;
  }
  const one = laterRevisions === 1;
  return `${String(laterRevisions)} later revision${one ? "" : "s"} exist${one ? "s" : ""} already.`;
}
