import type {
  Disposition,
  ProjectSpec,
  SpecRevisionContent,
  TextDelta,
  TicketSetReview,
  TicketsReviewFindingRecord,
} from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import {
  breakdownLines,
  criteriaSummary,
  dispositionTally,
  heldFindings,
  onTicketCard,
  reconciliationGroups,
  reconciliationRows,
  runInLabels,
  specRowBadges,
  ticketCriteria,
  ticketDecisions,
  ticketSetStateLine,
  ticketsReviewPanel,
} from "./tickets.ts";

const content: SpecRevisionContent = {
  title: "Export",
  problem: "Problem.",
  solution: "Solution.",
  outOfScope: [],
  clauses: [
    {
      id: "C1",
      title: "Export a project",
      text: "Text.",
      sources: [],
      criteria: [
        { id: "1.1", text: "One." },
        { id: "1.2", text: "Two." },
      ],
    },
    {
      id: "C2",
      title: "The button",
      text: "Text.",
      sources: [],
      criteria: [{ id: "2.1", text: "Three." }],
    },
  ],
};

const work = (criterion: string, ticket: string): Disposition => ({
  criterion,
  kind: "work",
  ticket,
  reason: null,
});
const delivered = (criterion: string, ticket: string): Disposition => ({
  criterion,
  kind: "delivered",
  ticket,
  reason: null,
});
const retained = (criterion: string, ticket: string): Disposition => ({
  criterion,
  kind: "retained",
  ticket,
  reason: null,
});
const removed = (criterion: string, ticket: string | null): Disposition => ({
  criterion,
  kind: "removed",
  ticket,
  reason: "Nothing reads it any more.",
});
const satisfied = (criterion: string): Disposition => ({
  criterion,
  kind: "satisfied",
  evidence: "The project page already has an Export button.",
});

function finding(title: string, escalated: boolean): TicketsReviewFindingRecord {
  return {
    kind: "untraced_criterion",
    route: "revise",
    title,
    explanation: "Explanation.",
    question: "Question?",
    ticketNumbers: ["T1"],
    criterionIds: ["1.1"],
    escalated,
  };
}

describe("dispositionTally", () => {
  it("counts each kind and leaves out a kind with none", () => {
    expect(dispositionTally([work("1.1", "T1"), work("1.2", "T1"), satisfied("2.1")])).toBe(
      "2 need work · 1 already done",
    );
    expect(dispositionTally([work("1.1", "T1"), work("1.2", "T2")])).toBe("2 need work");
    expect(dispositionTally([satisfied("1.1")])).toBe("1 already done");
  });

  it("tallies the five kinds in the demo's order", () => {
    expect(
      dispositionTally([
        removed("3.1", null),
        satisfied("2.1"),
        retained("1.3", "T2"),
        delivered("1.2", "T1"),
        work("1.1", "T3"),
        delivered("2.2", "T1"),
      ]),
    ).toBe("1 need work · 2 carry over · 1 retained · 1 already done · 1 removed");
  });
});

/** Revision 2 of `content`: 1.1 unchanged, 1.2 changed, 2.1 removed with C2, 3.1 new under C3. */
const revised: SpecRevisionContent = {
  ...content,
  clauses: [
    {
      id: "C1",
      title: "Export a project",
      text: "Text.",
      sources: [],
      criteria: [
        { id: "1.1", text: "One." },
        { id: "1.2", text: "Two, changed." },
      ],
    },
    {
      id: "C3",
      title: "The menu",
      text: "Text.",
      sources: [],
      criteria: [{ id: "3.1", text: "Four." }],
    },
  ],
};
const [c1, c2] = content.clauses;
if (c1 === undefined || c2 === undefined) {
  throw new Error("The fixture has two clauses");
}
const delta: TextDelta = {
  before: 1,
  after: 2,
  clauses: { C1: "changed", C3: "new" },
  criteria: {
    "1.1": { change: "unchanged", before: null },
    "1.2": { change: "changed", before: { id: "1.2", text: "Two." } },
    "3.1": { change: "new", before: null },
  },
  removedClauses: [c2],
  removedCriteria: [
    { clause: c1, criterion: { id: "1.9", text: "Gone from C1." } },
    { clause: c2, criterion: { id: "2.1", text: "Three." } },
  ],
  outOfScopeAdded: [],
  outOfScopeDropped: [],
};

describe("reconciliationRows", () => {
  it("gives one row per criterion of a first revision, under its clause, in the revision's order", () => {
    const rows = reconciliationRows(
      content,
      null,
      [],
      [satisfied("2.1"), work("1.2", "T2"), work("1.1", "T1")],
    );
    expect(rows.map((row) => [row.clause.id, row.criterion.id, row.removed, row.change])).toEqual([
      ["C1", "1.1", false, null],
      ["C1", "1.2", false, null],
      ["C2", "2.1", false, null],
    ]);
    expect(rows[0]?.disposition).toEqual(work("1.1", "T1"));
  });

  it("orders a later revision's criteria by clause, then the clauses it dropped, removed ones last in a clause", () => {
    const rows = reconciliationRows(revised, delta, delta.removedCriteria, [
      removed("2.1", "T3"),
      work("3.1", "T3"),
      removed("1.9", null),
      work("1.2", "T3"),
      delivered("1.1", "T1"),
    ]);
    expect(rows.map((row) => [row.clause.id, row.criterion.id, row.removed, row.change])).toEqual([
      ["C1", "1.1", false, "unchanged"],
      ["C1", "1.2", false, "changed"],
      ["C1", "1.9", true, "removed"],
      ["C3", "3.1", false, "new"],
      ["C2", "2.1", true, "removed"],
    ]);
  });

  it("shows a criterion an earlier revision dropped, which the delta does not name, under its own clause last (CR-3)", () => {
    const criterion = { id: "4.1", text: "Dropped two revisions ago." };
    const older = {
      clause: { id: "C4", title: "The footer", text: "Text.", sources: [], criteria: [criterion] },
      criterion,
    };
    const rows = reconciliationRows(
      revised,
      delta,
      [...delta.removedCriteria, older],
      [
        removed("2.1", "T3"),
        work("3.1", "T3"),
        removed("1.9", null),
        work("1.2", "T3"),
        delivered("1.1", "T1"),
        removed("4.1", "T3"),
      ],
    );
    expect(rows.map((row) => [row.clause.id, row.criterion.id, row.removed, row.change])).toEqual([
      ["C1", "1.1", false, "unchanged"],
      ["C1", "1.2", false, "changed"],
      ["C1", "1.9", true, "removed"],
      ["C3", "3.1", false, "new"],
      ["C2", "2.1", true, "removed"],
      ["C4", "4.1", true, "removed"],
    ]);
    expect(rows.at(-1)?.disposition).toEqual(removed("4.1", "T3"));
  });

  it("refuses a criterion with no disposition or with two", () => {
    expect(() =>
      reconciliationRows(content, null, [], [work("1.1", "T1"), work("1.2", "T1")]),
    ).toThrow();
    expect(() =>
      reconciliationRows(
        content,
        null,
        [],
        [work("1.1", "T1"), work("1.1", "T2"), work("1.2", "T1"), satisfied("2.1")],
      ),
    ).toThrow();
    expect(() =>
      reconciliationRows(revised, delta, delta.removedCriteria, [
        work("3.1", "T3"),
        removed("1.9", null),
        work("1.2", "T3"),
        delivered("1.1", "T1"),
      ]),
    ).toThrow();
  });

  it("refuses a disposition of a criterion the revision neither has nor removes", () => {
    expect(() =>
      reconciliationRows(
        content,
        null,
        [],
        [work("1.1", "T1"), work("1.2", "T1"), satisfied("2.1"), satisfied("3.1")],
      ),
    ).toThrow();
  });
});

function projectSpec(
  states: readonly ProjectSpec["revisions"][number]["state"][],
  activeRun: number | null,
  mergedRun: ProjectSpec["mergedRun"],
): ProjectSpec {
  return {
    number: 1,
    title: "Export",
    revisions: states.map((state, index) => ({
      revision: index + 1,
      state,
      mapId: "map-1",
      mapTitle: "Export",
      savedAt: "2026-10-01T10:00:00.000Z",
    })),
    activeRun,
    mergedRun,
  };
}

describe("specRowBadges", () => {
  it("reads an active run first, then a merged run, else not delivered", () => {
    expect(
      specRowBadges(projectSpec(["approved"], 2, { number: 1, revision: 1 })).delivery.tone,
    ).toBe("work");
    expect(
      specRowBadges(projectSpec(["approved"], null, { number: 1, revision: 1 })).delivery.tone,
    ).toBe("ok");
    expect(specRowBadges(projectSpec(["draft"], null, null)).delivery.tone).toBe("secondary");
  });

  it("names the latest revision only when it is not the merged one", () => {
    expect(
      specRowBadges(projectSpec(["approved"], null, { number: 1, revision: 1 })).latest,
    ).toBeNull();
    expect(
      specRowBadges(projectSpec(["approved", "draft"], null, { number: 1, revision: 1 })).latest,
    ).not.toBeNull();
    expect(specRowBadges(projectSpec(["approved", "draft"], null, null)).latest).toBeNull();
  });
});

describe("ticketsReviewPanel", () => {
  const at = "2026-10-09T10:00:00.000Z";

  it("reads a pending or running review as running, with the running sentence", () => {
    for (const review of [{ state: "pending" }, { state: "running" }] as const) {
      const panel = ticketsReviewPanel(review);
      expect(panel.badge).toEqual({ tone: "work", label: "review running" });
      expect(panel.text).not.toBeNull();
      expect(panel.findings).toEqual([]);
    }
  });

  it("gives a passed review its summary", () => {
    const panel = ticketsReviewPanel({ state: "passed", summary: "All traced.", reviewedAt: at });
    expect(panel).toEqual({
      badge: { tone: "ok", label: "review passed" },
      text: "All traced.",
      findings: [],
    });
  });

  it("counts the findings and lists each title with its kind and route", () => {
    const one: TicketSetReview = {
      state: "findings",
      summary: "One problem.",
      findings: [finding("T2 adds a CSV format", false)],
      held: false,
      reviewedAt: at,
    };
    expect(ticketsReviewPanel(one)).toEqual({
      badge: { tone: "bad", label: "1 finding" },
      text: "One problem.",
      findings: [
        {
          title: "T2 adds a CSV format",
          kind: "untraced_criterion",
          route: "revise",
          explanation: "Explanation.",
          ticketNumbers: ["T1"],
          criterionIds: ["1.1"],
          escalated: false,
        },
      ],
    });
    const two: TicketSetReview = {
      ...one,
      findings: [finding("A", true), finding("B", false)],
      held: true,
    };
    expect(ticketsReviewPanel(two).badge).toEqual({ tone: "bad", label: "2 findings" });
  });

  it("marks a stopped review, which has no summary", () => {
    const panel = ticketsReviewPanel({
      state: "stopped",
      stopped: { runId: "01JABCDEFGHJKMNPQRSTVWXYZ0", code: "agent_run_failed" },
    });
    expect(panel).toEqual({
      badge: { tone: "bad", label: "review stopped" },
      text: null,
      findings: [],
    });
  });
});

describe("criteriaSummary (UX audit B3)", () => {
  it("reads one kind as all of it, and a lone criterion in the singular", () => {
    expect(criteriaSummary([work("1.1", "T1"), work("1.2", "T1")])).toBe(
      "2 criteria, all need work",
    );
    expect(criteriaSummary([delivered("1.1", "T1"), delivered("1.2", "T1")])).toBe(
      "2 criteria, all carry over",
    );
    expect(criteriaSummary([work("1.1", "T1")])).toBe("1 criterion · needs work");
    expect(criteriaSummary([satisfied("1.1")])).toBe("1 criterion · already done");
  });

  it("counts the criteria before the tally when the kinds differ", () => {
    expect(criteriaSummary([work("1.1", "T1"), satisfied("2.1"), removed("3.1", null)])).toBe(
      "3 criteria · 1 need work · 1 already done · 1 removed",
    );
  });
});

describe("reconciliationGroups and onTicketCard (UX audit B1)", () => {
  it("groups a first revision's rows by clause with no change", () => {
    const rows = reconciliationRows(
      content,
      null,
      [],
      [satisfied("2.1"), work("1.2", "T2"), work("1.1", "T1")],
    );
    expect(
      reconciliationGroups(rows, null).map((group) => [
        group.clause.id,
        group.change,
        group.rows.map((row) => row.criterion.id),
      ]),
    ).toEqual([
      ["C1", null, ["1.1", "1.2"]],
      ["C2", null, ["2.1"]],
    ]);
  });

  it("carries each clause's change past a first revision, removed for a clause the delta dropped", () => {
    const rows = reconciliationRows(revised, delta, delta.removedCriteria, [
      removed("2.1", "T3"),
      work("3.1", "T3"),
      removed("1.9", null),
      work("1.2", "T3"),
      delivered("1.1", "T1"),
    ]);
    expect(
      reconciliationGroups(rows, delta).map((group) => [group.clause.id, group.change]),
    ).toEqual([
      ["C1", "changed"],
      ["C3", "new"],
      ["C2", "removed"],
    ]);
  });

  it("leaves a first revision's plain work criterion to its ticket card, not one already done or questioned", () => {
    const rows = reconciliationRows(
      content,
      null,
      [],
      [work("1.1", "T1"), work("1.2", "T2"), satisfied("2.1")],
    );
    const shown = (departure: (id: string) => boolean) =>
      rows
        .filter((row) => !onTicketCard(row, departure(row.criterion.id)))
        .map((row) => row.criterion.id);
    expect(shown(() => false)).toEqual(["2.1"]);
    expect(shown((id) => id === "1.2")).toEqual(["1.2", "2.1"]);
  });

  it("leaves a later revision's plain work criterion to its ticket card, changed or not, and keeps the rest", () => {
    const rows = reconciliationRows(revised, delta, delta.removedCriteria, [
      removed("2.1", "T3"),
      work("3.1", "T3"),
      removed("1.9", null),
      work("1.2", "T3"),
      delivered("1.1", "T1"),
    ]);
    const shown = (departure: (id: string) => boolean) =>
      rows
        .filter((row) => !onTicketCard(row, departure(row.criterion.id)))
        .map((row) => [row.criterion.id, row.change]);
    expect(shown(() => false)).toEqual([
      ["1.1", "unchanged"],
      ["1.9", "removed"],
      ["2.1", "removed"],
    ]);
    expect(shown((id) => id === "3.1")).toEqual([
      ["1.1", "unchanged"],
      ["1.9", "removed"],
      ["3.1", "new"],
      ["2.1", "removed"],
    ]);
  });
});

describe("ticketSetStateLine (UX audit B3)", () => {
  const at = "2026-10-09T10:00:00.000Z";
  const moment = (iso: string) => `at ${iso}`;
  const base = { state: "awaiting_review" as const, approvedAt: null, replaced: false };

  it("reads an approved set with its time, and a replaced one with the later revision", () => {
    expect(
      ticketSetStateLine(
        { ...base, state: "approved", approvedAt: at, review: null },
        null,
        null,
        moment,
      ),
    ).toBe(`approved at ${at}`);
    expect(ticketSetStateLine({ ...base, replaced: true, review: null }, 3, null, moment)).toBe(
      "replaced by revision 3",
    );
    expect(() =>
      ticketSetStateLine({ ...base, replaced: true, review: null }, null, null, moment),
    ).toThrow();
  });

  it("reads the review's state in the rail's words", () => {
    expect(ticketSetStateLine({ ...base, review: { state: "pending" } }, null, null, moment)).toBe(
      "review running",
    );
    expect(
      ticketSetStateLine(
        { ...base, review: { state: "passed", summary: "Fine.", reviewedAt: at } },
        null,
        null,
        moment,
      ),
    ).toBe("awaiting approval");
    expect(
      ticketSetStateLine(
        {
          ...base,
          review: {
            state: "findings",
            summary: "Held.",
            findings: [finding("A", true)],
            held: true,
            reviewedAt: at,
          },
        },
        null,
        null,
        moment,
      ),
    ).toBe("review needs you");
    expect(
      ticketSetStateLine(
        {
          ...base,
          review: {
            state: "findings",
            summary: "Repairing.",
            findings: [finding("A", false), finding("B", false)],
            held: false,
            reviewedAt: at,
          },
        },
        null,
        null,
        moment,
      ),
    ).toBe("2 findings · rewriting");
    expect(() => ticketSetStateLine({ ...base, review: null }, null, null, moment)).toThrow();
  });

  it("reads a running or stopped rewrite ahead of the old version's review", () => {
    const passed = {
      ...base,
      review: { state: "passed" as const, summary: "Fine.", reviewedAt: at },
    };
    expect(ticketSetStateLine(passed, null, "running", moment)).toBe("rewrite running");
    expect(ticketSetStateLine(passed, null, "stopped", moment)).toBe("rewrite stopped");
    expect(
      ticketSetStateLine(
        { ...base, state: "approved", approvedAt: at, review: null },
        null,
        "running",
        moment,
      ),
    ).toBe(`approved at ${at}`);
  });
});

describe("runInLabels (UX audit B2)", () => {
  it("bolds a short label and colon at a paragraph's start, and nothing else", () => {
    expect(runInLabels("Core: save it.\n\nWeb/e2e: show it.")).toBe(
      "**Core:** save it.\n\n**Web/e2e:** show it.",
    );
    expect(runInLabels("Migration test: an existing map loads.")).toBe(
      "**Migration test:** an existing map loads.",
    );
    expect(runInLabels("Turn the stored records into CSV rows.")).toBe(
      "Turn the stored records into CSV rows.",
    );
    expect(runInLabels("See https://example.invalid: nope")).toBe(
      "See https://example.invalid: nope",
    );
    expect(runInLabels("**Core:** already marked")).toBe("**Core:** already marked");
    expect(runInLabels("A long label with five words here: no")).toBe(
      "A long label with five words here: no",
    );
  });
});

describe("heldFindings", () => {
  const at = "2026-10-09T10:00:00.000Z";

  it("gives a held review's escalated findings only", () => {
    const held: TicketSetReview = {
      state: "findings",
      summary: "Held.",
      findings: [finding("A", true), finding("B", false), finding("C", true)],
      held: true,
      reviewedAt: at,
    };
    expect(heldFindings(held).map((f) => f.title)).toEqual(["A", "C"]);
  });

  it("gives none when the review does not hold the set", () => {
    expect(
      heldFindings({
        state: "findings",
        summary: "Repairing.",
        findings: [finding("A", false)],
        held: false,
        reviewedAt: at,
      }),
    ).toEqual([]);
    expect(heldFindings({ state: "passed", summary: "Fine.", reviewedAt: at })).toEqual([]);
    expect(heldFindings(null)).toEqual([]);
  });
});

describe("ticketDecisions (the demo's decisionsBehind; mid QA P-2)", () => {
  const EARLIER = "00000000000000000000000001";
  const LATER = "00000000000000000000000002";
  const waypoint = (mapId: string, number: number, kind: "grilling" | "research") => ({
    kind: "waypoint" as const,
    mapId,
    mapTitle: mapId === EARLIER ? "Earlier" : "Later",
    waypointNumber: number,
    waypointTitle: `Waypoint ${String(number)}`,
    waypointKind: kind,
    waypointGist: kind === "research" ? "Checked." : null,
  });
  const revision = {
    revision: 2,
    clauseSources: {
      C1: [
        { kind: "destination" as const, mapId: EARLIER, mapTitle: "Earlier" },
        waypoint(EARLIER, 1, "grilling"),
        waypoint(LATER, 1, "research"),
      ],
      C2: [
        waypoint(EARLIER, 1, "grilling"),
        waypoint(EARLIER, 3, "grilling"),
        { kind: "note" as const, mapId: EARLIER, mapTitle: "Earlier" },
      ],
    },
  };

  it("lists each map's waypoint once, in clause order, on the map that wrote it", () => {
    expect(
      ticketDecisions(revision, [{ id: "C1" }, { id: "C2" }]).map((entry) => [
        entry.mapId,
        entry.number,
        entry.kind,
      ]),
    ).toEqual([
      [EARLIER, 1, "grilling"],
      [LATER, 1, "research"],
      [EARLIER, 3, "grilling"],
    ]);
  });

  it("refuses a clause the revision has no sources for", () => {
    expect(() => ticketDecisions(revision, [{ id: "C9" }])).toThrow();
  });
});

describe("ticketCriteria (a ticket card leads with what it is approved for)", () => {
  it("gives each criterion's text under its clause, in the revision's order", () => {
    const shown = ticketCriteria(content, ["2.1", "1.2"]);
    expect(shown.map((entry) => entry.clause.id)).toEqual(["C1", "C2"]);
    expect(shown.map((entry) => entry.criteria)).toEqual([
      [{ id: "1.2", text: "Two." }],
      [{ id: "2.1", text: "Three." }],
    ]);
  });

  it("gives nothing for a ticket that carries no criteria (a Takes-out ticket)", () => {
    expect(ticketCriteria(content, [])).toEqual([]);
  });

  it("throws on a criterion the revision does not have", () => {
    expect(() => ticketCriteria(content, ["1.1", "9.9"])).toThrow();
  });
});

describe("breakdownLines (the slicing reads one line per ticket)", () => {
  it("gives each line of the text, blank lines dropped", () => {
    expect(breakdownLines("T1: the export.\nT2: the button (waits on T1).\n\nWhy.")).toEqual([
      "T1: the export.",
      "T2: the button (waits on T1).",
      "Why.",
    ]);
  });

  it("gives one line for a paragraph with no breaks", () => {
    expect(breakdownLines("One paragraph.")).toEqual(["One paragraph."]);
  });
});
