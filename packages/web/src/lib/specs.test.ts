import type {
  Clause,
  ClauseSourceView,
  CriterionReading,
  Disposition,
  MapSpec,
  NextAction,
  SpecRevisionView,
  SpecWaitView,
  StageTone,
  TextDelta,
  TicketContent,
  TicketSetView,
} from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import { shownRun } from "./delivery.ts";

import {
  actionSpec,
  changeTally,
  clauseChangeLine,
  clauseRunMarks,
  clauseFooter,
  criterionChange,
  deliveredUnder,
  nextWaiting,
  ownRevisions,
  ownTicketSets,
  runsOn,
  shownSpec,
  specNextAction,
  specTally,
  wasLine,
} from "./specs.ts";

/** A spec numbered `number` whose Spec stage has `tone`; its other stages are later. */
function spec(number: number, tone: StageTone): MapSpec {
  return {
    id: `0000000000000000000000000${String(number)}`,
    number,
    title: `Spec ${String(number)}`,
    revisions: [],
    ticketSets: [],
    draftingTickets: null,
    runs: [],
    revisedLater: [],
    stages: [
      { stage: "spec", tone, line: "line" },
      { stage: "tickets", tone: "later", line: "line" },
      { stage: "delivery", tone: "later", line: "line" },
    ],
  };
}

describe("shownSpec", () => {
  const specs = [spec(1, "done"), spec(2, "needs-you")];
  const detail = { specs, defaultSpecs: { spec: 2, tickets: 1, delivery: null } };

  it("shows the route's spec", () => {
    expect(shownSpec(detail, "spec", 1)?.number).toBe(1);
  });

  it("shows the overview's default for the stage without a route number", () => {
    expect(shownSpec(detail, "spec", undefined)?.number).toBe(2);
    expect(shownSpec(detail, "tickets", undefined)?.number).toBe(1);
  });

  it("shows none while the overview has no default", () => {
    expect(shownSpec(detail, "delivery", undefined)).toBeUndefined();
  });

  it("throws for a spec the map did not write", () => {
    expect(() => shownSpec(detail, "spec", 3)).toThrow();
    const stray = { specs, defaultSpecs: { spec: 3, tickets: 1, delivery: 1 } };
    expect(() => shownSpec(stray, "spec", undefined)).toThrow();
  });
});

describe("specTally", () => {
  it("counts the four groups, folding idle into not here yet", () => {
    const specs = [
      spec(1, "needs-you"),
      spec(2, "needs-you"),
      spec(3, "working"),
      spec(4, "done"),
      spec(5, "idle"),
      spec(6, "later"),
    ];
    expect(specTally(specs, "spec").map((entry) => [entry.label, entry.count])).toEqual([
      ["need you here", 2],
      ["being worked", 1],
      ["done", 1],
      ["not here yet", 2],
    ]);
  });

  it("leaves out a group with none", () => {
    const specs = [spec(1, "done"), spec(2, "done"), spec(3, "needs-you"), spec(4, "done")];
    expect(specTally(specs, "spec").map((entry) => [entry.label, entry.count])).toEqual([
      ["need you here", 1],
      ["done", 3],
    ]);
  });
});

describe("nextWaiting", () => {
  const specs = [
    spec(1, "needs-you"),
    spec(2, "done"),
    spec(3, "needs-you"),
    spec(4, "working"),
    spec(5, "done"),
  ];

  it("finds the next spec that needs you after the current", () => {
    expect(nextWaiting(specs, "spec", 1)?.number).toBe(3);
  });

  it("wraps past the last spec", () => {
    expect(nextWaiting(specs, "spec", 3)?.number).toBe(1);
    expect(nextWaiting(specs, "spec", 5)?.number).toBe(1);
  });

  it("has none when only the current spec needs you", () => {
    expect(nextWaiting([spec(1, "needs-you"), spec(2, "done")], "spec", 1)).toBeUndefined();
  });

  it("refuses a spec the map did not write", () => {
    expect(() => nextWaiting(specs, "spec", 9)).toThrow();
  });
});

function ticket(id: string, criteria: string[]): TicketContent {
  return {
    id,
    title: `Ticket ${id}`,
    build: "Build it.",
    blockedBy: [],
    criteria,
    testing: ["Test it."],
    followUp: null,
    outOfScope: [],
    pointers: ["src/index.ts"],
  };
}

function set(tickets: TicketContent[], dispositions: Disposition[]): TicketSetView {
  return {
    id: "00000000000000000000000001",
    revision: 1,
    state: "awaiting_review",
    version: 1,
    content: { tickets, dispositions, slicing: "Slicing.", execution: "Execution." },
    savedAt: "2026-10-08T10:00:00.000Z",
    approvedAt: null,
    rejections: [],
    review: { state: "pending" },
    replaced: false,
    readings: {},
    followUps: {},
  };
}

const WORK: Disposition[] = [{ criterion: "1.1", kind: "work", ticket: "T1", reason: null }];

describe("clauseFooter", () => {
  const clause: Pick<Clause, "criteria"> = {
    criteria: [
      { id: "1.1", text: "One" },
      { id: "1.2", text: "Two" },
    ],
  };
  const THIS = "00000000000000000000000001";
  const EARLIER = "00000000000000000000000002";
  const second: ClauseSourceView = {
    kind: "waypoint",
    mapId: THIS,
    mapTitle: "This",
    waypointNumber: 2,
    waypointTitle: "Second",
    waypointKind: "grilling",
    waypointGist: null,
  };
  const sources: ClauseSourceView[] = [
    { kind: "destination", mapId: EARLIER, mapTitle: "Earlier" },
    second,
    {
      kind: "waypoint",
      mapId: EARLIER,
      mapTitle: "Earlier",
      waypointNumber: 1,
      waypointTitle: "First",
      waypointKind: "research",
      waypointGist: "Checked the exporter.",
    },
  ];

  it("names the waypoints in the sources' order, on whichever map, then the destination", () => {
    expect(clauseFooter(clause, sources, undefined).from).toEqual([
      { kind: "waypoint", mapId: THIS, mapTitle: "This", number: 2, title: "Second" },
      { kind: "waypoint", mapId: EARLIER, mapTitle: "Earlier", number: 1, title: "First" },
      { kind: "destination", mapId: EARLIER, mapTitle: "Earlier" },
    ]);
  });

  it("keeps each destination's map, once per map", () => {
    const both: ClauseSourceView[] = [
      { kind: "destination", mapId: EARLIER, mapTitle: "Earlier" },
      { kind: "destination", mapId: THIS, mapTitle: "This" },
      { kind: "destination", mapId: EARLIER, mapTitle: "Earlier" },
    ];
    expect(clauseFooter(clause, both, undefined).from).toEqual([
      { kind: "destination", mapId: EARLIER, mapTitle: "Earlier" },
      { kind: "destination", mapId: THIS, mapTitle: "This" },
    ]);
  });

  it("has no Checked by before a ticket set exists", () => {
    expect(clauseFooter(clause, sources, undefined).checkedBy).toEqual([]);
  });

  it("is checked by each ticket carrying any of its criteria once a set exists", () => {
    const tickets = [ticket("T1", ["1.2"]), ticket("T2", ["2.1"]), ticket("T3", ["1.1", "2.1"])];
    expect(clauseFooter(clause, sources, set(tickets, WORK)).checkedBy.map((t) => t.id)).toEqual([
      "T1",
      "T3",
    ]);
  });

  it("names a note source last, as your note", () => {
    const noted: ClauseSourceView[] = [
      { kind: "note", mapId: THIS, mapTitle: "This" },
      second,
      { kind: "destination", mapId: THIS, mapTitle: "This" },
    ];
    expect(clauseFooter(clause, noted, undefined).from.map((source) => source.kind)).toEqual([
      "waypoint",
      "destination",
      "note",
    ]);
  });
});

/** An r1 → r2 delta: 1.1 kept, 1.2 changed, 2.1 removed, 2.2 new, 1.3 moved. */
const DELTA: TextDelta = {
  before: 1,
  after: 2,
  clauses: { C1: "changed", C2: "changed" },
  criteria: {
    "1.1": { change: "unchanged", before: null },
    "1.2": { change: "changed", before: { id: "1.2", text: "Separators collapse to one hyphen." } },
    "1.3": { change: "moved", before: { id: "2.3", text: "Underscores become hyphens." } },
    "1.4": { change: "changed", before: { id: "2.4", text: "Dots are dropped." } },
    "2.2": { change: "new", before: null },
  },
  removedClauses: [],
  removedCriteria: [
    {
      clause: { id: "C2", title: "Dots", text: "Dots.", criteria: [], sources: [] },
      criterion: { id: "2.1", text: "Dots become hyphens." },
    },
  ],
  outOfScopeAdded: ["Unicode"],
  outOfScopeDropped: [],
};

describe("changeTally", () => {
  it("counts each change, removed from the removed criteria, leaving out none", () => {
    expect(changeTally(DELTA)).toBe("1 new · 2 changed · 1 moved · 1 removed · 1 unchanged");
    expect(
      changeTally({
        ...DELTA,
        criteria: { "1.1": { change: "unchanged", before: null } },
        removedCriteria: [],
      }),
    ).toBe("1 unchanged");
  });
});

describe("clauseChangeLine", () => {
  const C1: Pick<Clause, "id" | "criteria"> = {
    id: "C1",
    criteria: [
      { id: "1.1", text: "a" },
      { id: "1.2", text: "b" },
      { id: "1.3", text: "c" },
    ],
  };
  const C2: Pick<Clause, "id" | "criteria"> = { id: "C2", criteria: [{ id: "2.2", text: "d" }] };

  it("lists changed, new, moved and removed ids in that order", () => {
    expect(clauseChangeLine(C1, DELTA)).toBe("1.2 changed · 1.3 moved");
    expect(clauseChangeLine(C2, DELTA)).toBe("2.2 new · 2.1 removed");
  });

  it("is empty when only the clause's wording changed", () => {
    expect(clauseChangeLine({ id: "C3", criteria: [{ id: "1.1", text: "a" }] }, DELTA)).toBe("");
  });

  it("throws on a criterion the delta does not know", () => {
    expect(() =>
      clauseChangeLine({ id: "C9", criteria: [{ id: "9.1", text: "x" }] }, DELTA),
    ).toThrow();
  });
});

describe("wasLine", () => {
  it("gives a changed criterion's earlier wording, naming the earlier id when it differs", () => {
    expect(wasLine("1.2", criterionChange(DELTA, "1.2"))).toEqual({
      kind: "changed",
      label: "Was",
      text: "Separators collapse to one hyphen.",
    });
    expect(wasLine("1.4", criterionChange(DELTA, "1.4"))).toEqual({
      kind: "changed",
      label: "Was 2.4",
      text: "Dots are dropped.",
    });
  });

  it("names a moved criterion's earlier id", () => {
    expect(wasLine("1.3", criterionChange(DELTA, "1.3"))).toEqual({
      kind: "moved",
      line: "Was 2.3, same wording.",
    });
  });

  it("has none for a new or unchanged criterion, and throws on a changed one with no earlier form", () => {
    expect(wasLine("2.2", criterionChange(DELTA, "2.2"))).toBeNull();
    expect(wasLine("1.1", criterionChange(DELTA, "1.1"))).toBeNull();
    expect(() => wasLine("1.2", { change: "changed", before: null })).toThrow();
  });
});

describe("deliveredUnder", () => {
  const clause: Pick<Clause, "criteria"> = {
    criteria: [
      { id: "1.1", text: "a" },
      { id: "1.2", text: "b" },
    ],
  };

  const under = (ticket: string, revision: number): CriterionReading => ({
    change: "unchanged",
    expectation: { kind: "delivered", why: "Kept." },
    baseline: { ticket, revision, run: 1, commit: "abc1234" },
    departure: null,
  });

  it("lists each delivered disposition's ticket of the clause once, by the revision it was delivered under", () => {
    const dispositions: Disposition[] = [
      { criterion: "1.1", kind: "delivered", ticket: "T1", reason: null },
      { criterion: "1.2", kind: "delivered", ticket: "T1", reason: "Still holds." },
      { criterion: "2.1", kind: "delivered", ticket: "T2", reason: null },
      { criterion: "1.2", kind: "work", ticket: "T3", reason: null },
    ];
    const readings = { "1.1": under("T1", 2), "1.2": under("T1", 2), "2.1": under("T2", 1) };
    expect(
      deliveredUnder(clause, { ...set([ticket("T3", ["1.2"])], dispositions), readings }),
    ).toEqual([{ revision: 2, tickets: ["T1"] }]);
  });

  it("names one revision per group, oldest first", () => {
    const dispositions: Disposition[] = [
      { criterion: "1.1", kind: "delivered", ticket: "T4", reason: null },
      { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
    ];
    const readings = { "1.1": under("T4", 3), "1.2": under("T1", 1) };
    expect(deliveredUnder(clause, { ...set([], dispositions), readings })).toEqual([
      { revision: 1, tickets: ["T1"] },
      { revision: 3, tickets: ["T4"] },
    ]);
  });

  it("throws on a carried criterion with no baseline", () => {
    const dispositions: Disposition[] = [
      { criterion: "1.1", kind: "delivered", ticket: "T1", reason: null },
    ];
    expect(() => deliveredUnder(clause, set([], dispositions))).toThrow();
    const readings = { "1.1": { ...under("T1", 1), baseline: null } };
    expect(() => deliveredUnder(clause, { ...set([], dispositions), readings })).toThrow();
  });

  it("is empty without a set or a delivered disposition", () => {
    expect(deliveredUnder(clause, undefined)).toEqual([]);
    expect(deliveredUnder(clause, set([ticket("T1", ["1.1"])], WORK))).toEqual([]);
  });
});

describe("actionSpec", () => {
  const specs = [spec(1, "done")];
  const wait: SpecWaitView = {
    specNumber: 4,
    specTitle: "Slugify",
    latest: {
      revision: 2,
      state: "draft",
      mapId: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e81",
      mapTitle: "Holder",
      savedAt: "2026-10-08T10:00:00.000Z",
      content: { title: "Slugify", problem: "P.", solution: "S.", clauses: [], outOfScope: [] },
    },
    note: "Trim the ends.",
    since: "2026-10-08T10:00:00.000Z",
    hold: null,
    released: false,
    run: null,
    waypoints: [],
  };

  it("resolves the map's spec first, then a spec it waits on, and none for no spec", () => {
    expect(actionSpec({ spec: 1 }, specs, [wait])).toMatchObject({ kind: "spec", title: "Spec 1" });
    expect(actionSpec({ spec: 4 }, specs, [wait])).toMatchObject({
      kind: "wait",
      title: "Slugify",
    });
    expect(actionSpec({ spec: null }, specs, [wait])).toBeUndefined();
  });

  it("throws on a spec the map neither wrote nor waits on", () => {
    expect(() => actionSpec({ spec: 9 }, specs, [wait])).toThrow();
  });
});

describe("ownRevisions", () => {
  it("keeps the revisions this map wrote and throws when it wrote none", () => {
    const base = spec(1, "done");
    const revision = (n: number, mapId: string): SpecRevisionView => ({
      id: `0000000000000000000000000${String(n)}`,
      revision: n,
      mapId,
      mapTitle: "Map",
      state: "approved",
      content: { title: "Spec", problem: "P.", solution: "S.", clauses: [], outOfScope: [] },
      savedAt: "2026-10-08T10:00:00.000Z",
      approvedAt: "2026-10-08T10:00:00.000Z",
      supersededAt: null,
      rejectionReason: null,
      review: { state: "pending" },
      delta: null,
      takenOut: [],
      clauseSources: {},
      deliveredRun: null,
    });
    const shared = { ...base, revisions: [revision(1, "a"), revision(2, "b"), revision(3, "a")] };
    expect(ownRevisions(shared, "a").map((entry) => entry.revision)).toEqual([1, 3]);
    expect(() => ownRevisions(shared, "c")).toThrow();
  });
});

describe("ownTicketSets and runsOn", () => {
  const revision = (n: number, mapId: string): SpecRevisionView => ({
    id: `0000000000000000000000000${String(n)}`,
    revision: n,
    mapId,
    mapTitle: "Map",
    state: "approved",
    content: { title: "Spec", problem: "P.", solution: "S.", clauses: [], outOfScope: [] },
    savedAt: "2026-10-08T10:00:00.000Z",
    approvedAt: "2026-10-08T10:00:00.000Z",
    supersededAt: null,
    rejectionReason: null,
    review: { state: "pending" },
    delta: null,
    takenOut: [],
    clauseSources: {},
    deliveredRun: null,
  });
  const first = { ...set([ticket("T1", ["1.1"])], WORK), id: "00000000000000000000000011" };
  const later = {
    ...set([ticket("T2", ["1.1"])], WORK),
    id: "00000000000000000000000012",
    revision: 2,
  };
  const shared = {
    number: 1,
    revisions: [revision(1, "a"), revision(2, "b")],
    ticketSets: [first, later],
    runs: [
      { number: 2, ticketSetId: later.id },
      { number: 1, ticketSetId: first.id },
    ],
  };

  it("keeps the sets and runs of revisions this map wrote", () => {
    expect(ownTicketSets(shared, "a").map((entry) => entry.id)).toEqual([first.id]);
    expect(runsOn(shared, "a").map((run) => run.number)).toEqual([1]);
    expect(runsOn(shared, "b").map((run) => run.number)).toEqual([2]);
  });

  it("marks a clause from this map's latest run: failing criteria, and a tick once merged", () => {
    const finding = (criterion: string | null, severity: "blocking" | "note") => ({
      axis: "spec" as const,
      severity,
      file: null,
      title: "T",
      detail: "D",
      criterion,
    });
    const verdict = {
      reviewedCommit: "a".repeat(40),
      summary: "S.",
      findings: [finding("1.1", "blocking"), finding("1.2", "note"), finding(null, "blocking")],
    };
    const runs = (mergedAt: string | null) => [
      { number: 2, ticketSetId: later.id, mergedAt: null, verdict: null },
      { number: 1, ticketSetId: first.id, mergedAt, verdict },
    ];
    const blocked = { ...shared, runs: runs(null) };
    expect(clauseRunMarks(blocked, "a", ["1.1", "1.2"], ["T1"])).toEqual({
      failing: ["1.1"],
      merged: false,
    });
    const merged = { ...shared, runs: runs("2026-10-08T11:00:00.000Z") };
    expect(clauseRunMarks(merged, "a", ["1.2"], ["T1"])).toEqual({ failing: [], merged: true });
    // A clause no pinned ticket checks gets no tick; another map's run marks nothing here.
    expect(clauseRunMarks(merged, "a", ["1.2"], ["T9"]).merged).toBe(false);
    expect(clauseRunMarks(merged, "b", ["1.1"], ["T2"])).toEqual({ failing: [], merged: false });
  });

  it("gives a later map no run while only the earlier map's run exists", () => {
    const earlierOnly = { ...shared, runs: [{ number: 1, ticketSetId: first.id }] };
    expect(runsOn(earlierOnly, "b")).toEqual([]);
    expect(() => shownRun(runsOn(earlierOnly, "b"), undefined)).toThrow();
    expect(shownRun(runsOn(earlierOnly, "a"), undefined).number).toBe(1);
  });
});

describe("specNextAction", () => {
  function action(stage: NextAction["stage"], spec: number | null): NextAction {
    return {
      who: "you",
      label: "Answer",
      stage,
      headline: `${stage} ${String(spec)}`,
      detail: null,
      round: null,
      stopped: null,
      waiting: null,
      spec,
      onMap: null,
    };
  }

  it("never shows another spec's action: undefined when none names the spec", () => {
    expect(specNextAction([action("spec", 1), action("delivery", null)], 2)).toBeUndefined();
  });

  it("prefers the spec's delivery action, else its first", () => {
    const tickets = action("tickets", 2);
    const delivery = action("delivery", 2);
    expect(specNextAction([action("spec", 1), tickets, delivery], 2)).toBe(delivery);
    expect(specNextAction([action("spec", 1), tickets], 2)).toBe(tickets);
  });
});
