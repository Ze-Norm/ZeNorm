import type {
  Clause,
  ClauseSourceView,
  CriterionChange,
  MapOverviewDetail,
  MapSpec,
  NextAction,
  SpecRevisionView,
  SpecRun,
  SpecWaitView,
  StageStatus,
  StageTone,
  TextDelta,
  TicketSetView,
} from "@zenorm/contracts";

/** The stages a map's specs each have their own of (slice 7 D11). */
export type SpecStage = "spec" | "tickets" | "delivery";

export const SPEC_STAGES: readonly SpecStage[] = ["spec", "tickets", "delivery"];

/** Side-by-side tabs hold this many specs; more become the picker (D11). */
export const MAX_SPEC_TABS = 3;

export function isSpecStage(stage: string): stage is SpecStage {
  return SPEC_STAGES.some((entry) => entry === stage);
}

/** A spec's status in one of its stages, as `map.overview` derives it (D8). */
export function specStageStatus(spec: MapSpec, stage: SpecStage): StageStatus {
  const [specStatus, tickets, delivery] = spec.stages;
  switch (stage) {
    case "spec":
      return specStatus;
    case "tickets":
      return tickets;
    case "delivery":
      return delivery;
  }
}

/**
 * The spec a stage shows (slice 7c D9): the one numbered by the route, else the stage's default
 * that `map.overview` decides (`defaultSpecs`); undefined while the map has written none.
 */
export function shownSpec(
  detail: Pick<MapOverviewDetail, "specs" | "defaultSpecs">,
  stage: SpecStage,
  specNumber: number | undefined,
): MapSpec | undefined {
  if (specNumber === undefined) {
    const shown = detail.defaultSpecs[stage];
    if (shown === null) {
      return undefined;
    }
    const spec = detail.specs.find((entry) => entry.number === shown);
    if (spec === undefined) {
      throw new Error(`The overview's default spec ${String(shown)} is not one of its specs`);
    }
    return spec;
  }
  const spec = detail.specs.find((entry) => entry.number === specNumber);
  if (spec === undefined) {
    throw new Error(`This map wrote no spec ${String(specNumber)}`);
  }
  return spec;
}

export type TallyLabel = "need you here" | "being worked" | "done" | "not here yet";

/** One count of the picker's tally. */
export interface TallyCount {
  label: TallyLabel;
  tone: StageTone;
  count: number;
}

/**
 * The picker's tally (D11): how many specs need you in this stage, are being worked, are done, and
 * are not here yet (idle or later), leaving out a count of none.
 */
export function specTally(specs: readonly MapSpec[], stage: SpecStage): TallyCount[] {
  const count = (tones: readonly StageTone[]) =>
    specs.filter((spec) => tones.includes(specStageStatus(spec, stage).tone)).length;
  const counts: TallyCount[] = [
    { label: "need you here", tone: "needs-you", count: count(["needs-you"]) },
    { label: "being worked", tone: "working", count: count(["working"]) },
    { label: "done", tone: "done", count: count(["done"]) },
    { label: "not here yet", tone: "later", count: count(["idle", "later"]) },
  ];
  return counts.filter((entry) => entry.count > 0);
}

/**
 * **Next waiting on you** (D11): the next spec after the one shown that needs you in this stage,
 * looking onward and wrapping round; undefined when no other spec does.
 */
export function nextWaiting(
  specs: readonly MapSpec[],
  stage: SpecStage,
  current: number,
): MapSpec | undefined {
  const here = specs.findIndex((spec) => spec.number === current);
  if (here === -1) {
    throw new Error(`The map wrote no spec ${String(current)}`);
  }
  const onward = [...specs.slice(here + 1), ...specs.slice(0, here)];
  return onward.find((spec) => specStageStatus(spec, stage).tone === "needs-you");
}

/** Where a clause comes from, as its footer names it. */
export type FooterSource =
  | { kind: "waypoint"; mapId: string; mapTitle: string; number: number; title: string }
  | { kind: "destination"; mapId: string; mapTitle: string }
  | { kind: "note"; mapId: string; mapTitle: string };

/** A clause's footer (D9): "From …" and, once a set exists, "Checked by …". */
export interface ClauseFooter {
  from: FooterSource[];
  /** The tickets carrying any of the clause's criteria; empty while the revision has no set. */
  checkedBy: { id: string; title: string }[];
}

/**
 * A clause's footer (D9; slice 8b D2): its resolved sources (core walks them back through every
 * revision, on whichever map, the demo's `clauseSources`), waypoints in their order, then each map's
 * destination, then each map's note through the hatch ("your note", slice 7b S7b-11), each keeping
 * its map (CR-2); and the tickets of the
 * revision's ticket set (undefined while none exists) that carry any of its criteria.
 */
export function clauseFooter(
  clause: Pick<Clause, "criteria">,
  sources: readonly ClauseSourceView[],
  ticketSet: TicketSetView | undefined,
): ClauseFooter {
  const from: FooterSource[] = [];
  const destinations: FooterSource[] = [];
  const notes: FooterSource[] = [];
  for (const source of sources) {
    if (source.kind === "destination" || source.kind === "note") {
      const into = source.kind === "destination" ? destinations : notes;
      if (!into.some((entry) => entry.kind !== "waypoint" && entry.mapId === source.mapId)) {
        into.push({ kind: source.kind, mapId: source.mapId, mapTitle: source.mapTitle });
      }
      continue;
    }
    from.push({
      kind: "waypoint",
      mapId: source.mapId,
      mapTitle: source.mapTitle,
      number: source.waypointNumber,
      title: source.waypointTitle,
    });
  }
  from.push(...destinations, ...notes);
  const ids = new Set(clause.criteria.map((criterion) => criterion.id));
  const checkedBy =
    ticketSet === undefined
      ? []
      : ticketSet.content.tickets
          .filter((ticket) => ticket.criteria.some((id) => ids.has(id)))
          .map((ticket) => ({ id: ticket.id, title: ticket.title }));
  return { from, checkedBy };
}

/**
 * The text delta's criteria count (the demo's `changeTally`): new, changed, moved, removed and
 * unchanged, leaving out a count of none.
 */
export function changeTally(delta: TextDelta): string {
  const changes = Object.values(delta.criteria);
  const count = (change: CriterionChange) =>
    changes.filter((entry) => entry.change === change).length;
  const parts: [number, string][] = [
    [count("new"), "new"],
    [count("changed"), "changed"],
    [count("moved"), "moved"],
    [delta.removedCriteria.length, "removed"],
    [count("unchanged"), "unchanged"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${String(n)} ${label}`)
    .join(" · ");
}

/**
 * A changed clause's line in the delta panel (the demo's `ChangesPanel` line): its changed, new and
 * moved criteria and those it drops, by id, leaving out a kind with none; empty when only the
 * clause's own wording changed.
 */
export function clauseChangeLine(
  clause: Pick<Clause, "id" | "criteria">,
  delta: TextDelta,
): string {
  const ids = (change: CriterionChange) =>
    clause.criteria
      .filter((criterion) => criterionChange(delta, criterion.id).change === change)
      .map((criterion) => criterion.id);
  const removed = delta.removedCriteria
    .filter((entry) => entry.clause.id === clause.id)
    .map((entry) => entry.criterion.id);
  const parts: [string[], string][] = [
    [ids("changed"), "changed"],
    [ids("new"), "new"],
    [ids("moved"), "moved"],
    [removed, "removed"],
  ];
  return parts
    .filter(([list]) => list.length > 0)
    .map(([list, label]) => `${list.join(", ")} ${label}`)
    .join(" · ");
}

/** A clause's change in the delta; every clause of the revision has one (S8b-10). */
export function clauseChange(delta: TextDelta, clauseId: string): TextDelta["clauses"][string] {
  const change = delta.clauses[clauseId];
  if (change === undefined) {
    throw new Error(`The text delta of revision ${String(delta.after)} has no clause ${clauseId}`);
  }
  return change;
}

/** A criterion's change in the delta; every criterion of the revision has one (S8b-10). */
export function criterionChange(
  delta: TextDelta,
  criterionId: string,
): TextDelta["criteria"][string] {
  const change = delta.criteria[criterionId];
  if (change === undefined) {
    throw new Error(
      `The text delta of revision ${String(delta.after)} has no criterion ${criterionId}`,
    );
  }
  return change;
}

/**
 * The "Was" line under a criterion (the demo's `ClauseBlock`): a changed one's earlier wording,
 * named by its earlier id when that differs; a moved one's earlier id; null for any other.
 */
export type WasLine =
  { kind: "changed"; label: string; text: string } | { kind: "moved"; line: string } | null;

export function wasLine(criterionId: string, change: TextDelta["criteria"][string]): WasLine {
  if (change.change !== "changed" && change.change !== "moved") {
    return null;
  }
  if (change.before === null) {
    throw new Error(`Criterion ${criterionId} is ${change.change} but has no earlier form`);
  }
  if (change.change === "moved") {
    return { kind: "moved", line: `Was ${change.before.id}, same wording.` };
  }
  const label = change.before.id === criterionId ? "Was" : `Was ${change.before.id}`;
  return { kind: "changed", label, text: change.before.text };
}

/**
 * The earlier tickets a clause's criteria carry over in the revision's set (the demo's
 * "Delivered under rN by …"), grouped by the revision each was delivered under (its reading's
 * baseline, E-2), oldest first: each `delivered` disposition's ticket, once each, in order.
 */
export function deliveredUnder(
  clause: Pick<Clause, "criteria">,
  ticketSet: TicketSetView | undefined,
): { revision: number; tickets: string[] }[] {
  if (ticketSet === undefined) {
    return [];
  }
  const ids = new Set(clause.criteria.map((criterion) => criterion.id));
  const groups: { revision: number; tickets: string[] }[] = [];
  for (const disposition of ticketSet.content.dispositions) {
    if (disposition.kind !== "delivered" || !ids.has(disposition.criterion)) {
      continue;
    }
    const baseline = ticketSet.readings[disposition.criterion]?.baseline;
    if (baseline === undefined || baseline === null) {
      throw new Error(
        `Criterion ${disposition.criterion} carries over ${disposition.ticket} with no delivery under any revision`,
      );
    }
    let group = groups.find((entry) => entry.revision === baseline.revision);
    if (group === undefined) {
      group = { revision: baseline.revision, tickets: [] };
      groups.push(group);
    }
    if (!group.tickets.includes(disposition.ticket)) {
      group.tickets.push(disposition.ticket);
    }
  }
  return groups.sort((a, b) => a.revision - b.revision);
}

/** The revisions of a spec this map wrote, oldest first (the demo's `latestRevisionOn` reads the last). */
export function ownRevisions(
  spec: Pick<MapSpec, "number" | "revisions">,
  mapId: string,
): SpecRevisionView[] {
  const own = spec.revisions.filter((entry) => entry.mapId === mapId);
  if (own.length === 0) {
    throw new Error(`Map ${mapId} wrote no revision of spec ${String(spec.number)}`);
  }
  return own;
}

/** The ticket sets of revisions this map wrote, oldest first (a later map's set is that map's). */
export function ownTicketSets(
  spec: Pick<MapSpec, "number" | "revisions" | "ticketSets">,
  mapId: string,
): TicketSetView[] {
  const own = new Set(ownRevisions(spec, mapId).map((entry) => entry.revision));
  return spec.ticketSets.filter((set) => own.has(set.revision));
}

/**
 * The spec's delivery runs pinned to revisions this map wrote, newest first (the demo's `runsOn`;
 * slice 8b D9): another map's runs on the spec are that map's.
 */
export function runsOn<Run extends { ticketSetId: string }>(
  spec: Pick<MapSpec, "number" | "revisions" | "ticketSets"> & { runs: readonly Run[] },
  mapId: string,
): Run[] {
  const sets = new Set(ownTicketSets(spec, mapId).map((set) => set.id));
  return spec.runs.filter((run) => sets.has(run.ticketSetId));
}

/** What this map's latest run says of one clause (the demo's `ClauseBlock`, slice 8 parts). */
export interface ClauseRunMarks {
  /** The clause's criteria the run's blocking findings name: "fails review". */
  failing: string[];
  /** The run is merged and pinned a ticket checking the clause: the tick after "Checked by". */
  merged: boolean;
}

/**
 * The marks this map's latest run (the demo's `latestRunOn`, newest of `runsOn`) puts on a clause:
 * the criteria among `criteria` its blocking findings name, and whether it is merged with one of
 * `checkedBy` in its pinned set. No run, no marks.
 */
export function clauseRunMarks(
  spec: Pick<MapSpec, "number" | "revisions" | "ticketSets"> & {
    runs: readonly Pick<SpecRun, "ticketSetId" | "mergedAt" | "verdict">[];
  },
  mapId: string,
  criteria: readonly string[],
  checkedBy: readonly string[],
): ClauseRunMarks {
  const [latest] = runsOn(spec, mapId);
  if (latest === undefined) {
    return { failing: [], merged: false };
  }
  const { verdict } = latest;
  const failing =
    verdict === null
      ? []
      : criteria.filter((id) =>
          verdict.findings.some(
            (finding) => finding.severity === "blocking" && finding.criterion === id,
          ),
        );
  const pinned = spec.ticketSets.find((set) => set.id === latest.ticketSetId);
  if (pinned === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no ticket set ${latest.ticketSetId}`);
  }
  const merged =
    latest.mergedAt !== null &&
    pinned.content.tickets.some((ticket) => checkedBy.includes(ticket.id));
  return { failing, merged };
}

/** The revision a delta revises, from the spec's revisions on every map. */
export function revisionBefore(spec: MapSpec, delta: TextDelta): SpecRevisionView {
  const before = spec.revisions.find((entry) => entry.revision === delta.before);
  if (before === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no revision ${String(delta.before)}`);
  }
  return before;
}

/**
 * The spec a next action is about (tickets review B6): one the map wrote, else one it waits on (a
 * wait's action, or its release run's), which the map's Spec stage shows under Waits; undefined
 * for an action about no spec.
 */
export type ActionSpec =
  | { kind: "spec"; spec: MapSpec; title: string }
  | { kind: "wait"; wait: SpecWaitView; title: string };

export function actionSpec(
  next: Pick<NextAction, "spec">,
  specs: readonly MapSpec[],
  waits: readonly SpecWaitView[],
): ActionSpec | undefined {
  if (next.spec === null) {
    return undefined;
  }
  const spec = specs.find((entry) => entry.number === next.spec);
  if (spec !== undefined) {
    return { kind: "spec", spec, title: spec.title };
  }
  const wait = waits.find((entry) => entry.specNumber === next.spec);
  if (wait !== undefined) {
    return { kind: "wait", wait, title: wait.specTitle };
  }
  throw new Error(
    `A next action names spec ${String(next.spec)}, which the map neither wrote nor waits on`,
  );
}

/** The ticket set written for one revision of a spec; undefined while it has none. */
export function ticketSetFor(spec: MapSpec, revision: number): TicketSetView | undefined {
  return spec.ticketSets.find((entry) => entry.revision === revision);
}

/**
 * A spec's own next action on its Delivery page: its delivery's, else the first naming the spec;
 * undefined when the map's next actions name it in none (never another spec's).
 */
export function specNextAction(
  next: readonly NextAction[],
  specNumber: number,
): NextAction | undefined {
  const own = next.filter((action) => action.spec === specNumber);
  return own.find((action) => action.stage === "delivery") ?? own[0];
}

/** Whether the map waits on spec `specNumber` without having written it (slice 8b E-1). */
export function waitsOnly(
  detail: Pick<MapOverviewDetail, "specs" | "waits">,
  specNumber: number,
): boolean {
  return (
    !detail.specs.some((entry) => entry.number === specNumber) &&
    detail.waits.some((wait) => wait.specNumber === specNumber)
  );
}
