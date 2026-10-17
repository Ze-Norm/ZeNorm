import type { ActivityLine, SpecLineLabel } from "@zenorm/contracts";

/**
 * An activity line's text with the spec title it quotes taken out, for a one-spec map, where every
 * line of the Spec, Tickets and Delivery stages names the same spec and the title says
 * nothing. Core quotes the title (“…”) in a few shapes: after "for", "in" or
 * "of" the phrase goes ("Tickets written for “T”: 2 tickets." reads "Tickets written: 2
 * tickets."); as the object after a colon the colon goes with it ("Approved: “T”." reads
 * "Approved.", and the one relative clause core writes becomes its own clause); anywhere else it
 * reads "the spec" ("“T” is no longer held." reads "The spec is no longer held."). A text that
 * does not quote the title word for word is returned as it is.
 */
export function withoutSpecTitle(text: string, specTitle: string): string {
  const quoted = `“${specTitle}”`;
  if (!text.includes(quoted)) {
    return text;
  }
  // A private-use character stands in for the title until the sentence starts are capitalised.
  const marker = "\uE000";
  const stripped = text
    .replaceAll(` for ${quoted}`, "")
    .replaceAll(` in ${quoted}`, "")
    .replaceAll(` of ${quoted}`, "")
    .replaceAll(`: ${quoted}.`, ".")
    .replaceAll(`: ${quoted}, which an earlier map delivered.`, "; an earlier map delivered it.")
    .replaceAll(quoted, marker);
  return stripped.replace(/(^|[.!?] )\uE000/g, "$1The spec").replaceAll(marker, "the spec");
}

/** Where an activity line that carries a spec links, and its words. */
export interface SpecLineLink {
  stage: "spec" | "tickets" | "delivery";
  specNumber: number;
  label: SpecLineLabel;
}

/**
 * The spec link of an activity line: a Spec line opens the spec's latest revision, a Tickets line
 * its tickets, a Delivery line the spec's Delivery page; null when the line carries no spec. The
 * words are the line's own `specLabel`. Only those three stages carry a spec; a spec on any other,
 * or a spec without its label, is a programmer error.
 */
export function specLineLink(line: ActivityLine): SpecLineLink | null {
  if (line.spec === null) {
    return null;
  }
  if (line.specLabel === null) {
    throw new Error(`A ${line.stage} activity line carries spec ${String(line.spec)} but no label`);
  }
  switch (line.stage) {
    case "spec":
    case "tickets":
    case "delivery":
      return { stage: line.stage, specNumber: line.spec, label: line.specLabel };
    case "idea":
    case "wayfinding":
      throw new Error(`A ${line.stage} activity line carries spec ${String(line.spec)}`);
  }
}
