import type { MapRecord, NextAction, Stage } from "@zenorm/contracts";

/** The five stages in rail order, with the name each shows. */
export const STAGES: readonly { stage: Stage; name: string }[] = [
  { stage: "idea", name: "Idea" },
  { stage: "wayfinding", name: "Wayfinding" },
  { stage: "spec", name: "Spec" },
  { stage: "tickets", name: "Tickets" },
  { stage: "delivery", name: "Delivery" },
];

export function stageName(stage: Stage): string {
  const entry = STAGES.find((s) => s.stage === stage);
  if (entry === undefined) {
    throw new Error(`No stage named ${stage}`);
  }
  return entry.name;
}

/** A map's name: its title once charted, else its idea's first line. */
export function mapName(map: MapRecord): string {
  if (map.title !== null) {
    return map.title;
  }
  const first = map.idea.split("\n")[0];
  if (first === undefined || first.trim() === "") {
    throw new Error(`Map ${map.id} has an idea with an empty first line`);
  }
  return first.trim();
}

/**
 * A stage page's heading for the map: its title once charted, else "Untitled map". The idea's first
 * line can run to a paragraph, so the head never carries it; the crumb, inbox and tab, which cut
 * it to fit, use `mapName`.
 */
export function mapHeading(map: MapRecord): string {
  if (map.title !== null) {
    return map.title;
  }
  return "Untitled map";
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** An ISO timestamp as the app writes it: "Oct 2 · 15:00", in local time. */
export function formatMoment(iso: string): string {
  const date = new Date(iso);
  return `${dayFormat.format(date)} · ${timeFormat.format(date)}`;
}

/** The overview's next actions shown as cards before "Also in motion". */
const OVERVIEW_CARDS = 2;

/**
 * The overview's next actions split into the cards it shows first and the rest it lists under
 * "Also in motion". A map always has a next action.
 */
export function overviewActions(next: readonly NextAction[]): {
  cards: readonly NextAction[];
  rest: readonly NextAction[];
} {
  if (next.length === 0) {
    throw new Error("A map's status has no next action");
  }
  return { cards: next.slice(0, OVERVIEW_CARDS), rest: next.slice(OVERVIEW_CARDS) };
}
