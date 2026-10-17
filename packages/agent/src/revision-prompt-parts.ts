import type {
  CriterionReading,
  EarlierTicket,
  ProjectSpecContext,
  RunTouch,
  SpecHold,
  TextDelta,
  TouchingWaypoint,
} from "@zenorm/contracts";

import { specPagePath } from "@zenorm/contracts";

import { block } from "./prompt-parts.ts";

// The prompt parts a later map's revision reads (slice 8b D6, D8): the project's other specs and
// their holds, waypoint touches, the map's open waits, the text delta, the criterion readings, the
// earlier tickets and the waypoints touching a spec. Each plain line here is one the e2e stand-in
// may key on (L107); `apps/zenorm/e2e/fake-claude.ts` names the ones it does.

/** The plain line counting the project's other specs a chart or To Spec run reads. */
export function projectSpecsLine(count: number): string {
  return `Project specs not on this map: ${String(count)}`;
}

function holdText(hold: SpecHold | null): string {
  if (hold === null) return "not held";
  return `held (${hold.kind}) by map “${hold.mapTitle}” at revision ${String(hold.revision)}`;
}

/**
 * The plain line opening one project spec: its number, latest revision, whether that revision is
 * approved and delivered, and its hold.
 */
export function projectSpecLine(spec: ProjectSpecContext): string {
  const approved = spec.approved?.revision === spec.latest.revision;
  return [
    `Project spec ${String(spec.latest.specNumber)}`,
    `latest revision ${String(spec.latest.revision)}`,
    approved ? "approved" : "not approved",
    spec.delivered ? "delivered" : "not delivered",
    `${holdText(spec.hold)}:`,
  ].join(", ");
}

/** The plain line giving a project spec's page, on the map that wrote its latest revision. */
export function specPageLine(spec: ProjectSpecContext): string {
  return `Project spec ${String(spec.latest.specNumber)} page: ${specPagePath(spec.writerMapId, spec.latest.specNumber)}`;
}

/** The plain line naming a project spec's latest approved revision, the one a touch names (S8b-2). */
export function latestApprovedLine(spec: ProjectSpecContext): string {
  return `Project spec ${String(spec.latest.specNumber)} latest approved revision: ${
    spec.approved === null ? "none" : String(spec.approved.revision)
  }`;
}

function criterionIds(ref: {
  content: { clauses: readonly { criteria: readonly { id: string }[] }[] };
}) {
  return ref.content.clauses.flatMap((clause) => clause.criteria.map((c) => c.id)).join(", ");
}

/**
 * The plain line naming a spec's retired ids (E-3): the ids an earlier revision used and its latest
 * drops, which no revision may use again.
 */
export function retiredLine(prefix: string, ids: readonly string[]): string {
  return `${prefix} retired ids: ${ids.length === 0 ? "none" : ids.join(", ")}`;
}

/**
 * Each project spec: its line, its criterion ids and its latest revision in a nonce block, then its
 * latest approved revision; while another map's draft is latest, that approved revision's criterion
 * ids and text too, so a chart can touch it (L213 D-5).
 */
export function projectSpecLines(specs: readonly ProjectSpecContext[], nonce: string): string[] {
  return [
    projectSpecsLine(specs.length),
    "",
    ...specs.flatMap((spec) => {
      const { latest, approved } = spec;
      const earlier =
        approved === null || approved.revision === latest.revision
          ? []
          : [
              `Project spec ${String(approved.specNumber)} approved criterion ids: ${criterionIds(approved)}`,
              ...block(
                `SPEC-${String(approved.specNumber)}-REVISION-${String(approved.revision)}`,
                nonce,
                JSON.stringify(approved.content, null, 2),
              ),
            ];
      return [
        projectSpecLine(spec),
        specPageLine(spec),
        `Project spec ${String(latest.specNumber)} criterion ids: ${criterionIds(latest)}`,
        retiredLine(`Project spec ${String(latest.specNumber)}`, spec.retiredIds),
        ...block(
          `SPEC-${String(latest.specNumber)}-REVISION-${String(latest.revision)}`,
          nonce,
          JSON.stringify(latest.content, null, 2),
        ),
        latestApprovedLine(spec),
        ...earlier,
        "",
      ];
    }),
  ];
}

/** The plain line naming one touch: the spec, the touched revision and its criteria. */
export function touchLine(touch: RunTouch): string {
  return `Touches: spec ${String(touch.specNumber)} revision ${String(touch.revision)} criteria ${touch.criteria
    .map((criterion) => criterion.id)
    .join(", ")}`;
}

/** The plain line giving one touched criterion's baseline: the delivered ticket, run and commit. */
export function baselineLine(criterion: RunTouch["criteria"][number]): string {
  const { baseline } = criterion;
  return baseline === null
    ? `Baseline ${criterion.id}: never delivered`
    : `Baseline ${criterion.id}: ${baseline.ticket}, run ${String(baseline.run)}, commit ${baseline.commit}`;
}

/**
 * A waypoint's touches: each touch's line, the touched criteria's text in a nonce block and each
 * criterion's baseline line; `Touches: none` when it touches no spec.
 */
export function touchLines(touches: readonly RunTouch[], name: string, nonce: string): string[] {
  if (touches.length === 0) return ["Touches: none"];
  return touches.flatMap((touch) => [
    touchLine(touch),
    ...block(
      `${name}-TOUCH-${String(touch.specNumber)}`,
      nonce,
      [
        `Spec title: ${touch.specTitle}`,
        ...touch.criteria.map((criterion) => `${criterion.id}: ${criterion.text}`),
      ].join("\n"),
    ),
    ...touch.criteria.map(baselineLine),
  ]);
}

/** The plain line listing the specs the map waits on, by number. */
export function openWaitsLine(waits: readonly { specNumber: number }[]): string {
  return `Open waits: ${waits.length === 0 ? "none" : waits.map((wait) => String(wait.specNumber)).join(", ")}`;
}

/** The map's open waits: the line, then each wait's note in a nonce block. */
export function openWaitLines(
  waits: readonly { specNumber: number; note: string }[],
  nonce: string,
): string[] {
  return [
    openWaitsLine(waits),
    ...waits.flatMap((wait) => [
      `This map waits to change spec ${String(wait.specNumber)}, with this note:`,
      ...block(`WAIT-${String(wait.specNumber)}`, nonce, wait.note),
    ]),
    "",
  ];
}

/** The plain line naming the id the set's first ticket takes (S8b-12). */
export function firstTicketNumberLine(number: number): string {
  return `First ticket number: ${String(number)}`;
}

/** The plain line naming the revisions a text delta compares, or none for revision 1. */
export function textDeltaLine(delta: TextDelta | null): string {
  return delta === null
    ? "Text delta: none, this is the spec's first revision"
    : `Text delta: revision ${String(delta.before)} to revision ${String(delta.after)}`;
}

/** The plain line naming one criterion the revision takes out, with the clause it sat in. */
export function removedCriterionLine(entry: TextDelta["removedCriteria"][number]): string {
  return `Removed criterion ${entry.criterion.id} (clause ${entry.clause.id})`;
}

/**
 * The text delta: its line, the line of each criterion the revision takes out (core's, the delta's
 * and any dropped in a middle revision no approved set took out, L213 D-1) and the delta in a nonce
 * block.
 */
export function textDeltaLines(
  delta: TextDelta | null,
  takenOut: TextDelta["removedCriteria"],
  nonce: string,
): string[] {
  if (delta === null) return [textDeltaLine(null), ""];
  return [
    textDeltaLine(delta),
    ...takenOut.map(removedCriterionLine),
    ...block("TEXT-DELTA", nonce, JSON.stringify(delta, null, 2)),
    "",
  ];
}

/** The plain line reading one criterion: its change, expected disposition and baseline. */
export function readingLine(id: string, reading: CriterionReading): string {
  const { baseline } = reading;
  const delivered =
    baseline === null
      ? "baseline none"
      : `baseline ${baseline.ticket} (revision ${String(baseline.revision)}, run ${String(baseline.run)}, commit ${baseline.commit})`;
  return `Reading ${id}: ${reading.change}, expected ${reading.expectation.kind}, ${delivered}`;
}

/** The plain line saying whether a disposition that departs from its expectation gives a reason. */
export function departureLine(id: string, reason: string | null): string {
  return `Departure ${id}: ${reason === null ? "no reason" : "reason given"}`;
}

/**
 * Each criterion's reading, in id order: its line and why the expectation holds; with
 * `departures`, a departing disposition's line, the review's question and its reason in a block.
 */
export function readingLines(
  readings: Readonly<Record<string, CriterionReading>>,
  departures: boolean,
  nonce: string,
): string[] {
  return Object.entries(readings).flatMap(([id, reading]) => [
    readingLine(id, reading),
    `  Why: ${reading.expectation.why}`,
    ...(departures && reading.departure !== null
      ? [
          departureLine(id, reading.departure.reason),
          `  Question: ${reading.departure.question}`,
          ...(reading.departure.reason === null
            ? []
            : block(`REASON-${id}`, nonce, reading.departure.reason)),
        ]
      : []),
  ]);
}

/** The plain line giving one earlier ticket: its id, revision, criteria and where it was delivered. */
export function earlierTicketLine(ticket: EarlierTicket): string {
  const criteria = ticket.criteria.length === 0 ? "none" : ticket.criteria.join(", ");
  const delivered =
    ticket.delivered === null
      ? "not delivered"
      : `delivered in run ${String(ticket.delivered.run)}, commit ${ticket.delivered.commit}`;
  return `Earlier ticket ${ticket.id} (revision ${String(ticket.revision)}): criteria ${criteria}; ${delivered}`;
}

/** The spec's earlier tickets: a count line, then each ticket's line and title. */
export function earlierTicketLines(tickets: readonly EarlierTicket[]): string[] {
  return [
    `Earlier tickets: ${String(tickets.length)}`,
    ...tickets.flatMap((ticket) => [earlierTicketLine(ticket), `  Title: ${ticket.title}`]),
    "",
  ];
}

/** The plain line listing the map's resolved waypoints that touch the spec, by number. */
export function touchingWaypointsLine(waypoints: readonly TouchingWaypoint[]): string {
  return `Touching waypoints: ${waypoints.length === 0 ? "none" : waypoints.map((w) => String(w.number)).join(", ")}`;
}

/** The waypoints touching the spec: the line, then each one's title and resolution in a block. */
export function touchingWaypointLines(
  waypoints: readonly TouchingWaypoint[],
  nonce: string,
): string[] {
  return [
    touchingWaypointsLine(waypoints),
    ...waypoints.flatMap((waypoint) =>
      block(
        `TOUCHING-WAYPOINT-${String(waypoint.number)}`,
        nonce,
        [`Title: ${waypoint.title}`, "Resolution:", waypoint.resolution].join("\n"),
      ),
    ),
    "",
  ];
}
