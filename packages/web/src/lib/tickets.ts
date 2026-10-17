import type {
  Clause,
  ClauseChange,
  Criterion,
  CriterionChange,
  Disposition,
  MapSpec,
  ProjectSpec,
  SpecRevisionContent,
  SpecRevisionView,
  TextDelta,
  TicketContent,
  TicketSetReview,
  TicketSetView,
  TicketsReviewFindingRecord,
  WaypointKind,
} from "@zenorm/contracts";

import { clauseChange } from "@/lib/specs";

/**
 * A ticket set's dispositions tallied by kind for a line of text (slice 7c D7, slice 8b D12; the
 * demo's `dispositionTally`): "2 need work · 1 carry over · 1 removed", a kind with none left out.
 */
export function dispositionTally(dispositions: readonly Disposition[]): string {
  return tallyParts(dispositions)
    .map(([n, label]) => `${String(n)} ${label}`)
    .join(" · ");
}

/** The tally's kinds in the demo's order, each with its plural label. */
const TALLY_ORDER: readonly (readonly [Disposition["kind"], string])[] = [
  ["work", "need work"],
  ["delivered", "carry over"],
  ["retained", "retained"],
  ["satisfied", "already done"],
  ["removed", "removed"],
];

/** The tally's parts (count, label and kind), kinds with none left out. */
export function tallyParts(
  dispositions: readonly Disposition[],
): (readonly [number, string, Disposition["kind"]])[] {
  return TALLY_ORDER.map(
    ([kind, label]) =>
      [
        dispositions.filter((disposition) => disposition.kind === kind).length,
        label,
        kind,
      ] as const,
  ).filter(([n]) => n > 0);
}

/**
 * One row of the reconciliation (slice 8b D12, the demo's `Reconciliation`): a criterion of the
 * revision, or one it removed, under its clause, with the set's disposition of it and how its text
 * changed (null on a first revision, which has no text delta).
 */
export interface ReconciliationRow {
  clause: Clause;
  criterion: Criterion;
  removed: boolean;
  disposition: Disposition;
  change: CriterionChange | "removed" | null;
}

function dispositionOf(dispositions: readonly Disposition[], criterion: string): Disposition {
  const matching = dispositions.filter((disposition) => disposition.criterion === criterion);
  const [disposition] = matching;
  if (disposition === undefined || matching.length !== 1) {
    throw new Error(
      `The ticket set has ${String(matching.length)} dispositions of criterion ${criterion}`,
    );
  }
  return disposition;
}

/**
 * The reconciliation's rows (slice 8b D12, the demo's `Reconciliation`): every criterion of the
 * revision and every one it takes out (`takenOut`, core's `removedCriteria`: the text delta's and
 * one an earlier revision dropped, CR-3), under its clause, the revision's clauses in order, then
 * the clauses its delta dropped, then any other clause a taken-out criterion sat in; within a clause
 * the revision's criteria come before the removed ones. A criterion without exactly one
 * disposition, or a disposition of a criterion the revision neither has nor takes out, is a
 * programmer error: core checks the set against the revision.
 */
export function reconciliationRows(
  content: SpecRevisionContent,
  delta: TextDelta | null,
  takenOut: SpecRevisionView["takenOut"],
  dispositions: readonly Disposition[],
): ReconciliationRow[] {
  const kept: ReconciliationRow[] = content.clauses.flatMap((clause) =>
    clause.criteria.map((criterion) => {
      let change: ReconciliationRow["change"] = null;
      if (delta !== null) {
        const entry = delta.criteria[criterion.id];
        if (entry === undefined) {
          throw new Error(`The text delta has no criterion ${criterion.id}`);
        }
        change = entry.change;
      }
      return {
        clause,
        criterion,
        removed: false,
        disposition: dispositionOf(dispositions, criterion.id),
        change,
      };
    }),
  );
  const removed: ReconciliationRow[] = takenOut.map(({ clause, criterion }) => ({
    clause,
    criterion,
    removed: true,
    disposition: dispositionOf(dispositions, criterion.id),
    change: "removed",
  }));
  const rows = [...kept, ...removed];
  for (const disposition of dispositions) {
    if (!rows.some((row) => row.criterion.id === disposition.criterion)) {
      throw new Error(
        `The ticket set disposes of criterion ${disposition.criterion}, which the revision neither has nor takes out`,
      );
    }
  }
  const clauseIds = [
    ...content.clauses.map((clause) => clause.id),
    ...(delta === null ? [] : delta.removedClauses.map((clause) => clause.id)),
  ];
  for (const { clause } of takenOut) {
    if (!clauseIds.includes(clause.id)) clauseIds.push(clause.id);
  }
  const clauseOrder = (id: string): number => {
    const index = clauseIds.indexOf(id);
    if (index === -1) {
      throw new Error(`Clause ${id} is in neither the revision nor what it removed`);
    }
    return index;
  };
  // A stable sort: within a clause, the revision's criteria stay before the removed ones.
  return rows.sort((a, b) => clauseOrder(a.clause.id) - clauseOrder(b.clause.id));
}

/**
 * The reconciliation's rows under their clause (UX audit B1): each clause once, in the rows' order,
 * with its rows and, past a first revision, how its text changed (`"removed"` for a clause the
 * revision dropped; null on a first revision).
 */
export interface ReconciliationGroup {
  clause: Clause;
  change: ClauseChange | "removed" | null;
  rows: ReconciliationRow[];
}

export function reconciliationGroups(
  rows: readonly ReconciliationRow[],
  delta: TextDelta | null,
): ReconciliationGroup[] {
  const groups: ReconciliationGroup[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.clause.id === row.clause.id) {
      last.rows.push(row);
      continue;
    }
    // A clause the delta does not name is one it dropped, or one only a criterion an earlier
    // revision dropped still names (CR-3): removed either way.
    let change: ReconciliationGroup["change"] = null;
    if (delta !== null) {
      change = row.clause.id in delta.clauses ? clauseChange(delta, row.clause.id) : "removed";
    }
    groups.push({ clause: row.clause, change, rows: [row] });
  }
  return groups;
}

/**
 * Whether a row is left to its ticket card: a criterion whose disposition is work, with no
 * departure, is carried by exactly one ticket of the set (core checks it), whose card leads with
 * its text and, past a first revision, how that text changed, so the reconciliation does not
 * repeat it. Everything else (one already done, retained, carried over or taken out, or one the
 * review questioned) stays in the reconciliation.
 */
export function onTicketCard(row: ReconciliationRow, departure: boolean): boolean {
  return row.disposition.kind === "work" && !departure;
}

/**
 * The lede's count of the revision's criteria (UX audit B3): "18 criteria, all need work" when
 * every disposition is of one kind, else the count and the tally ("20 criteria · 18 need work ·
 * 2 removed").
 */
export function criteriaSummary(dispositions: readonly Disposition[]): string {
  const count = dispositions.length;
  const noun = count === 1 ? "criterion" : "criteria";
  const parts = tallyParts(dispositions);
  const [only] = parts;
  if (parts.length === 1 && only !== undefined) {
    const [, label] = only;
    return count === 1
      ? `1 ${noun} · ${singular(label)}`
      : `${String(count)} ${noun}, all ${label}`;
  }
  return `${String(count)} ${noun} · ${dispositionTally(dispositions)}`;
}

/** A tally label for one criterion: "needs work", "carries over"; the rest read the same. */
function singular(label: string): string {
  switch (label) {
    case "need work":
      return "needs work";
    case "carry over":
      return "carries over";
    default:
      return label;
  }
}

/**
 * A ticket set's state for the page's eyebrow (UX audit B3), in the rail's words: "approved <when>",
 * "replaced by revision n" (S8b-9), "rewrite running" or "rewrite stopped" while the spec's To
 * Tickets rewrites the set (`drafting`, after a rejection, a note or a repair; the current
 * version's review is the old one until the rewrite saves), else the review's state: "review
 * running", "awaiting approval", "review needs you" on a held set, "n findings", "review stopped".
 */
export function ticketSetStateLine(
  set: Pick<TicketSetView, "state" | "approvedAt" | "review" | "replaced">,
  replacedBy: number | null,
  drafting: "running" | "stopped" | null,
  formatMoment: (iso: string) => string,
): string {
  if (set.replaced) {
    if (replacedBy === null) {
      throw new Error("A replaced ticket set names no later revision");
    }
    return `replaced by revision ${String(replacedBy)}`;
  }
  if (set.state === "approved") {
    if (set.approvedAt === null) {
      throw new Error("An approved ticket set has no approval time");
    }
    return `approved ${formatMoment(set.approvedAt)}`;
  }
  if (drafting !== null) {
    return `rewrite ${drafting}`;
  }
  if (set.review === null) {
    throw new Error("An unapproved ticket set has no tickets review");
  }
  switch (set.review.state) {
    case "pending":
    case "running":
      return "review running";
    case "stopped":
      return "review stopped";
    case "passed":
      return "awaiting approval";
    case "findings":
      return set.review.held
        ? "review needs you"
        : `${String(set.review.findings.length)} finding${set.review.findings.length === 1 ? "" : "s"} · rewriting`;
  }
}

/** Where a ticket of an earlier set was delivered (the demo's `deliveryOf`), from the run records. */
export interface TicketDelivery {
  ticket: TicketContent;
  revision: number;
  run: number;
  commit: string;
  mapId: string;
  mapTitle: string;
}

/**
 * The delivery of one ticket of one of the spec's sets (slice 8b S8b-11): a merged run of that set
 * whose row for the ticket is merged, or null when no merged run delivered it.
 */
export function setTicketDelivery(
  spec: MapSpec,
  set: TicketSetView,
  ticketId: string,
): TicketDelivery | null {
  const ticket = set.content.tickets.find((candidate) => candidate.id === ticketId);
  if (ticket === undefined) {
    throw new Error(`Ticket set ${set.id} has no ticket ${ticketId}`);
  }
  for (const run of spec.runs) {
    if (run.ticketSetId !== set.id || run.mergedAt === null || run.tickets === null) continue;
    const row = run.tickets.find((candidate) => candidate.ticket === ticketId);
    if (row?.status.state === "merged") {
      const revision = spec.revisions.find((candidate) => candidate.revision === set.revision);
      if (revision === undefined) {
        throw new Error(`Spec ${String(spec.number)} has no revision ${String(set.revision)}`);
      }
      return {
        ticket,
        revision: set.revision,
        run: run.number,
        commit: row.status.commit,
        mapId: revision.mapId,
        mapTitle: revision.mapTitle,
      };
    }
  }
  return null;
}

/**
 * The delivery of an earlier ticket a disposition names (a `delivered` criterion): the newest set
 * before `revision` holding a ticket of that id that a merged run delivered, or null.
 */
export function earlierTicketDelivery(
  spec: MapSpec,
  revision: number,
  ticketId: string,
): TicketDelivery | null {
  for (const set of [...spec.ticketSets].reverse()) {
    if (set.revision >= revision) continue;
    if (!set.content.tickets.some((ticket) => ticket.id === ticketId)) continue;
    const delivery = setTicketDelivery(spec, set, ticketId);
    if (delivery !== null) return delivery;
  }
  return null;
}

/** A project spec's badge (slice 8b D13, the demo's `SpecRow`): its delivery, as a `Badge` variant. */
export interface SpecRowBadge {
  tone: "work" | "ok" | "secondary";
  label: string;
}

/**
 * The project page's badges for one spec (the demo's `SpecRow`): "delivery run n running" while a
 * run is active, else "delivered · run n" once a run merged, else "not delivered"; and, when the
 * latest revision is not the merged one, that revision and its state ("r2 draft").
 */
export function specRowBadges(spec: ProjectSpec): {
  delivery: SpecRowBadge;
  latest: string | null;
} {
  const latest = spec.revisions.at(-1);
  if (latest === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no revision`);
  }
  let delivery: SpecRowBadge;
  if (spec.activeRun !== null) {
    // `activeRun` counts an interrupted run too, and the project read cannot tell the two apart
    // (the runner's hold is not in the database), so the badge says what it knows.
    delivery = { tone: "work", label: `delivery run ${String(spec.activeRun)} active` };
  } else if (spec.mergedRun !== null) {
    delivery = { tone: "ok", label: `delivered · run ${String(spec.mergedRun.number)}` };
  } else {
    delivery = { tone: "secondary", label: "not delivered" };
  }
  const moved = spec.mergedRun !== null && latest.revision !== spec.mergedRun.revision;
  return {
    delivery,
    latest: moved ? `r${String(latest.revision)} ${latest.state}` : null,
  };
}

/** The colour of the panel's badge, a `Badge` variant. */
export type ReviewBadgeTone = "work" | "ok" | "bad";

/** The Tickets review panel's content (slice 7c D7, the demo's `TicketsReview` and `ReviewBadge`). */
export interface TicketsReviewPanel {
  badge: { tone: ReviewBadgeTone; label: string };
  /** The running sentence while the review is pending or running, else the review's summary; null when stopped (it has none). */
  text: string | null;
  /**
   * Each finding: its title, kind and route as stable codes (CR-4), its explanation, the tickets
   * and criteria it names, and whether it escalated (UX audit B4).
   */
  findings: Pick<
    TicketsReviewFindingRecord,
    "title" | "kind" | "route" | "explanation" | "ticketNumbers" | "criterionIds" | "escalated"
  >[];
}

/** The demo's running sentence, with "against the text delta and the baseline" again (D12, reversing L166). */
export const TICKETS_REVIEW_RUNNING =
  "A fresh agent is tracing every criterion to its clause and checking each disposition against the text delta and the baseline.";

/** The panel for a set's current version's review; a pending review reads as running (L167 (B2)). */
export function ticketsReviewPanel(review: TicketSetReview): TicketsReviewPanel {
  switch (review.state) {
    case "pending":
    case "running":
      return {
        badge: { tone: "work", label: "review running" },
        text: TICKETS_REVIEW_RUNNING,
        findings: [],
      };
    case "stopped":
      return {
        badge: { tone: "bad", label: "review stopped" },
        text: null,
        findings: [],
      };
    case "passed":
      return {
        badge: { tone: "ok", label: "review passed" },
        text: review.summary,
        findings: [],
      };
    case "findings":
      return {
        badge: {
          tone: "bad",
          label: `${String(review.findings.length)} finding${review.findings.length === 1 ? "" : "s"}`,
        },
        text: review.summary,
        findings: review.findings.map(
          ({ title, kind, route, explanation, ticketNumbers, criterionIds, escalated }) => ({
            title,
            kind,
            route,
            explanation,
            ticketNumbers,
            criterionIds,
            escalated,
          }),
        ),
      };
  }
}

/** A held set's escalated findings (S7c-5); an empty list when the review does not hold the set. */
export function heldFindings(review: TicketSetReview | null): TicketsReviewFindingRecord[] {
  if (review?.state !== "findings" || !review.held) {
    return [];
  }
  return review.findings.filter((finding) => finding.escalated);
}

/** A waypoint behind a ticket's clauses, on whichever map wrote it (the demo's `decisionsBehind`). */
export interface TicketDecision {
  mapId: string;
  mapTitle: string;
  number: number;
  title: string;
  kind: WaypointKind;
  gist: string | null;
}

/**
 * The waypoints behind a ticket's clauses (the demo's `decisionsBehind`): each clause's resolved
 * sources in the revision, walked back through every revision across maps (`clauseSources`), in
 * the clauses' order, each map's waypoint once. A clause carried from another map's revision cites
 * that map's waypoints, never this map's (mid QA P-2).
 */
export function ticketDecisions(
  revision: Pick<SpecRevisionView, "revision" | "clauseSources">,
  clauses: readonly Pick<Clause, "id">[],
): TicketDecision[] {
  const decisions: TicketDecision[] = [];
  for (const clause of clauses) {
    const sources = revision.clauseSources[clause.id];
    if (sources === undefined) {
      throw new Error(`Revision ${String(revision.revision)} has no sources for ${clause.id}`);
    }
    for (const source of sources) {
      if (source.kind !== "waypoint") continue;
      if (
        decisions.some(
          (entry) => entry.mapId === source.mapId && entry.number === source.waypointNumber,
        )
      ) {
        continue;
      }
      decisions.push({
        mapId: source.mapId,
        mapTitle: source.mapTitle,
        number: source.waypointNumber,
        title: source.waypointTitle,
        kind: source.waypointKind,
        gist: source.waypointGist,
      });
    }
  }
  return decisions;
}

/**
 * A build or testing line's run-in labels in bold (UX audit B2): a paragraph or line the writer
 * opens with a short label and a colon ("Core: …", "Web/e2e: …", "Migration test: …") reads as
 * a labelled block. Markdown strong, which `AgentText` renders; a label already marked is left.
 */
export function runInLabels(text: string): string {
  return text.replace(/^([A-Z][\w/&-]*(?: [\w/&-]+){0,3}):(?=\s)/gm, "**$1:**");
}

/** One clause a ticket carries criteria from, with just those criteria, as the card leads with them. */
export interface TicketClauseCriteria {
  clause: Clause;
  criteria: Criterion[];
}

/**
 * The criteria a ticket carries, as their text under their clauses (what the person approves the
 * ticket for), in the revision's order. A criterion id the revision does not have is a programmer
 * error: core checks the set against the revision.
 */
export function ticketCriteria(
  content: SpecRevisionContent,
  criteria: readonly string[],
): TicketClauseCriteria[] {
  for (const id of criteria) {
    if (!content.clauses.some((clause) => clause.criteria.some((c) => c.id === id))) {
      throw new Error(`The spec revision has no criterion ${id}`);
    }
  }
  return content.clauses
    .map((clause) => ({
      clause,
      criteria: clause.criteria.filter((criterion) => criteria.includes(criterion.id)),
    }))
    .filter((entry) => entry.criteria.length > 0);
}

/**
 * A set's slicing or execution as its lines: To Tickets writes the slicing one line per ticket, and
 * markdown would join single line breaks into one paragraph. Blank lines between them drop out.
 */
export function breakdownLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}
