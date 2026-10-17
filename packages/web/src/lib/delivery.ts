import type {
  MapSpec,
  RunEvent,
  RunTicket,
  RunTicketStatus,
  SpecRevisionView,
  SpecRun,
  TicketContent,
  TicketSetView,
  Verdict,
} from "@zenorm/contracts";

/**
 * Pure helpers of the Delivery page (slice 8 D9), after the demo's `DeliveryStage.tsx`: a run's
 * name, the criteria a blocking finding fails per ticket, and when merged tickets fold away.
 */

/**
 * A run's name where people scan (D7, the demo's `runName`): "Delivery run" ("The delivery run" at
 * the start of a sentence) until the spec has a second run, then "Run n".
 */
export function runName(run: { number: number }, sentenceStart: boolean): string {
  if (run.number > 1) {
    return `Run ${String(run.number)}`;
  }
  return sentenceStart ? "The delivery run" : "Delivery run";
}

/**
 * The criteria of `ticket` that the verdict's blocking findings name (the demo's
 * `failingCriteria`): the pinned set's content decides who carries a criterion, so the finding
 * cards say "carried by T<n>" for a run of any age. A run's ticket rows read core's `failing`.
 */
export function failingCriteria(verdict: Verdict | null, ticket: TicketContent): string[] {
  if (verdict === null) {
    return [];
  }
  return verdict.findings.flatMap((finding) =>
    finding.severity === "blocking" &&
    finding.criterion !== null &&
    ticket.criteria.includes(finding.criterion)
      ? [finding.criterion]
      : [],
  );
}

/** The tickets of the pinned set that carry `criterion`, which a blocking finding fails. */
export function carriersOf(
  verdict: Verdict | null,
  tickets: readonly TicketContent[],
  criterion: string,
): TicketContent[] {
  return tickets.filter((ticket) => failingCriteria(verdict, ticket).includes(criterion));
}

/** Live work first, then what waits on it, then what is done (the demo's `STATUS_ORDER`). */
const STATUS_ORDER: readonly RunTicketStatus["state"][] = [
  "implementing",
  "starting",
  "waiting",
  "not_delivered",
  "merged",
];

/** Rows in the demo's status order; rows of one status keep their pinned order. */
export function inStatusOrder<T extends { status: RunTicketStatus }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status.state) - STATUS_ORDER.indexOf(b.status.state),
  );
}

/** Past this many tickets, merged ones fold into one line while the run works. */
export const FOLD_MERGED_FROM = 5;

/**
 * The fold rule (the demo's `RunTickets`): merged tickets fold into one line while the run works on
 * a set of at least `FOLD_MERGED_FROM` tickets, so the live ones stay in view, until the person shows them.
 */
export function foldsMerged({
  running,
  tickets,
  merged,
  shown,
}: {
  running: boolean;
  tickets: number;
  merged: number;
  shown: boolean;
}): boolean {
  return running && tickets >= FOLD_MERGED_FROM && merged > 0 && !shown;
}

/** The run's ticket set: the approved set it was started from, as the overview carries it. */
export function runTicketSet(spec: MapSpec, run: SpecRun): TicketSetView {
  const set = spec.ticketSets.find((entry) => entry.id === run.ticketSetId);
  if (set === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no ticket set ${run.ticketSetId}`);
  }
  return set;
}

/** The spec revision a ticket set was cut from. */
export function revisionOf(spec: MapSpec, set: TicketSetView): SpecRevisionView {
  const revision = spec.revisions.find((entry) => entry.revision === set.revision);
  if (revision === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no revision ${String(set.revision)}`);
  }
  return revision;
}

/**
 * The run a page shows (`?run=`, D10): run `number`, or the latest (the first, newest first) when
 * absent. `runs` are this map's (`runsOn`), never the spec's every run (slice 8b D9). A number the spec has no run for, or a spec with no run, is the route's error (L100).
 */
export function shownRun<Run extends { number: number }>(
  runs: readonly Run[],
  number: number | undefined,
): Run {
  const shown = number === undefined ? runs[0] : runs.find((entry) => entry.number === number);
  if (shown === undefined) {
    throw new Error(
      number === undefined
        ? "This map has no delivery run"
        : `This map has no delivery run ${String(number)}`,
    );
  }
  return shown;
}

/**
 * Where `ticket` stands in `run`, as `map.overview` carries it (D10, S8-14). A run from before
 * `0010` (`tickets: null`) or a ticket outside the run's pinned set is the route's error (L100).
 */
export function runTicketOf(run: SpecRun, ticket: string): RunTicket {
  if (run.tickets === null) {
    throw new Error(`Run ${String(run.number)} did not record its tickets`);
  }
  const row = run.tickets.find((entry) => entry.ticket === ticket);
  if (row === undefined) {
    throw new Error(`Run ${String(run.number)} has no ticket ${ticket}`);
  }
  return row;
}

/** A ticket's lines in the run's activity, oldest first (D10): the lines tied to it. */
export function ticketLines(events: readonly RunEvent[], ticket: string): RunEvent[] {
  return events.filter((event) => event.ticket === ticket);
}

/**
 * An agent's sentence placed mid-sentence (L197 item 3): its first letter lower-cased only when its
 * second is a lower-case letter, so an acronym such as "API" or a code span keeps its case.
 */
export function midSentence(text: string): string {
  const second = text.charAt(1);
  if (second === "" || second === second.toUpperCase()) {
    return text;
  }
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * A ticket's status as the page shows it. An interrupted run (no runner holds it after a restart)
 * still counts as active in core (D6), but nothing works on its tickets, so a started ticket and
 * one that has not started read as interrupted, never as live (L197 item 13). Display only.
 */
export type ShownTicketStatus = RunTicketStatus | { state: "interrupted"; started: boolean };

export function shownTicketStatus(
  run: Pick<SpecRun, "state">,
  status: RunTicketStatus,
): ShownTicketStatus {
  if (run.state !== "interrupted") {
    return status;
  }
  switch (status.state) {
    case "implementing":
      return { state: "interrupted", started: true };
    case "waiting":
    case "starting":
      return { state: "interrupted", started: false };
    case "merged":
    case "not_delivered":
      return status;
  }
}

/** How long ago the run's last line was, as the demo's liveness count says it. */
export function agoWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${String(seconds)}s ago`
    : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s ago`;
}

const clockFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** A line's time as the demo's activity shows it: "14:03:27", in local time. */
export function lineClock(iso: string): string {
  return clockFormat.format(new Date(iso));
}

/**
 * A merged ticket's report as its row on the Delivery page shows it (the demo's one-line row): the
 * report's first line that has text, without a heading's `#` marks. The whole report is on the
 * ticket's execution page, which the row opens.
 */
export function reportFirstLine(report: string): string | null {
  const line = report
    .split("\n")
    .map((entry) => entry.replace(/^#{1,6}\s+/, "").trim())
    .find((entry) => entry !== "");
  if (line === undefined) {
    // A report of only blank lines has no line to show, like a ticket merged with no report.
    return null;
  }
  return line;
}
