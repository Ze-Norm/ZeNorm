import { describe, expect, test } from "vitest";

import {
  CLAUSE_CRITERIA_MAX_COUNT,
  CLAUSE_TEXT_MAX_LENGTH,
  CLAUSE_TITLE_MAX_LENGTH,
  CONTENT_LINE_MAX_LENGTH,
  CRITERION_TEXT_MAX_LENGTH,
  DISPOSITION_TEXT_MAX_LENGTH,
  SPEC_OUT_OF_SCOPE_MAX_COUNT,
  SPEC_REVIEW_FINDINGS_MAX_COUNT,
  SPEC_REVIEW_SUMMARY_MAX_LENGTH,
  SPEC_REVISION_CLAUSES_MAX_COUNT,
  SPEC_REVISION_PROSE_MAX_LENGTH,
  SPEC_REVISION_TITLE_MAX_LENGTH,
  type SpecReviewFinding,
  specReviewOutcome,
  specRevisionDraft,
  type SpecRevisionContent,
  SpecRevisionContent as SpecRevisionContentSchema,
  TICKET_BLOCKERS_MAX_COUNT,
  TICKET_BUILD_MAX_LENGTH,
  TICKET_CONTENT_TITLE_MAX_LENGTH,
  TICKET_OUT_OF_SCOPE_MAX_COUNT,
  TICKET_POINTERS_MAX_COUNT,
  TICKET_SET_EXECUTION_MAX_LENGTH,
  TICKET_SET_SLICING_MAX_LENGTH,
  TICKET_SET_TICKETS_MAX_COUNT,
  TICKET_TESTING_MAX_COUNT,
  type TicketContent,
  type TicketSetContent,
  TicketSetContent as TicketSetContentSchema,
  ticketSetDraft,
  DRAFT_TICKET_SET_TICKETS_MAX_COUNT,
  WAYPOINT_QUESTION_MAX_LENGTH,
  WAYPOINT_RESOLUTION_MAX_LENGTH,
  WAYPOINT_TITLE_MAX_LENGTH,
} from "./index.ts";
import { LIMITS } from "./limits.fixture.ts";

const SpecReviewOutcome = specReviewOutcome(LIMITS);
const TicketSetDraft = ticketSetDraft(LIMITS);

const text = (length: number): string => "x".repeat(length);

function clause(n: number, criteria: number): SpecRevisionContent["clauses"][number] {
  return {
    id: `C${String(n)}`,
    title: "Same folder, resolved",
    text: "Two folders are the same when their real paths match.",
    criteria: Array.from({ length: criteria }, (_, k) => ({
      id: `${String(n)}.${String(k + 1)}`,
      text: "Adding a symlink to an existing project's folder is rejected.",
    })),
    sources: [{ kind: "waypoint", number: 1 }, { kind: "destination" }],
  };
}

const revision: SpecRevisionContent = {
  title: "Reject duplicate and nested project folders",
  problem: "A person can add the same repository twice.",
  solution: "Adding a project compares real paths.",
  clauses: [clause(1, 2), { ...clause(2, 1), sources: [] }],
  outOfScope: ["Renaming or deleting a project."],
};

function ticket(n: number): TicketContent {
  return {
    id: `T${String(n)}`,
    title: "Refuse a folder that is already a project",
    build: "When a person picks a folder in Add project, ZeNorm refuses a duplicate.",
    blockedBy: n === 1 ? [] : [{ ticket: "T1", supplies: "the resolved real path" }],
    criteria: ["1.1"],
    testing: ["Tests add a project through the real add-project path."],
    followUp: null,
    outOfScope: [],
    pointers: ["src/index.ts"],
  };
}

const set: TicketSetContent = {
  tickets: [ticket(1), ticket(2)],
  dispositions: [
    { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
    { criterion: "1.2", kind: "satisfied", evidence: "realpath already runs in add-project." },
  ],
  slicing: "Two tickets: the duplicate check first, nesting on top.",
  execution: "agent-verifiable: both run against a temporary directory.",
};

const finding: SpecReviewFinding = {
  kind: "dropped_resolution",
  route: "revise",
  title: "Resolution dropped: worktrees",
  explanation: "Research 3 says a worktree reports itself as top level; no clause carries it.",
  question: "Should adding a worktree of a project be refused as a duplicate?",
  elementIds: ["C1", "1.2"],
  waypointNumbers: [3],
};

describe("SpecRevisionContent", () => {
  test("accepts the demo's shape, kept clauses naming no source, and `was`", () => {
    expect(SpecRevisionContentSchema.safeParse(revision).success).toBe(true);
    const moved = {
      ...revision,
      clauses: [{ ...clause(1, 1), criteria: [{ id: "1.1", text: "Moved.", was: "2.1" }] }],
    };
    expect(SpecRevisionContentSchema.safeParse(moved).success).toBe(true);
  });

  test("rejects 0 and 13 clauses and a clause with 0 or 9 criteria", () => {
    const counts = [
      { ...revision, clauses: [] },
      {
        ...revision,
        clauses: Array.from({ length: SPEC_REVISION_CLAUSES_MAX_COUNT + 1 }, (_, i) =>
          clause(i + 1, 1),
        ),
      },
      { ...revision, clauses: [clause(1, 0)] },
      { ...revision, clauses: [clause(1, CLAUSE_CRITERIA_MAX_COUNT + 1)] },
    ];
    expect(SPEC_REVISION_CLAUSES_MAX_COUNT).toBe(12);
    expect(CLAUSE_CRITERIA_MAX_COUNT).toBe(8);
    for (const content of counts) {
      expect(SpecRevisionContentSchema.safeParse(content).success).toBe(false);
    }
    const twelve = {
      ...revision,
      clauses: Array.from({ length: 12 }, (_, i) => clause(i + 1, 8)),
    };
    expect(SpecRevisionContentSchema.safeParse(twelve).success).toBe(true);
  });

  test("rejects each field one past its bound and accepts it at the bound", () => {
    const first = clause(1, 1);
    const cases: [number, (length: number) => SpecRevisionContent][] = [
      [SPEC_REVISION_TITLE_MAX_LENGTH, (n) => ({ ...revision, title: text(n) })],
      [SPEC_REVISION_PROSE_MAX_LENGTH, (n) => ({ ...revision, problem: text(n) })],
      [SPEC_REVISION_PROSE_MAX_LENGTH, (n) => ({ ...revision, solution: text(n) })],
      [CLAUSE_TITLE_MAX_LENGTH, (n) => ({ ...revision, clauses: [{ ...first, title: text(n) }] })],
      [CLAUSE_TEXT_MAX_LENGTH, (n) => ({ ...revision, clauses: [{ ...first, text: text(n) }] })],
      [
        CRITERION_TEXT_MAX_LENGTH,
        (n) => ({ ...revision, clauses: [{ ...first, criteria: [{ id: "1.1", text: text(n) }] }] }),
      ],
      [CONTENT_LINE_MAX_LENGTH, (n) => ({ ...revision, outOfScope: [text(n)] })],
    ];
    expect([SPEC_REVISION_TITLE_MAX_LENGTH, SPEC_REVISION_PROSE_MAX_LENGTH]).toEqual([120, 2000]);
    expect([CLAUSE_TITLE_MAX_LENGTH, CLAUSE_TEXT_MAX_LENGTH, CRITERION_TEXT_MAX_LENGTH]).toEqual([
      120, 1000, 500,
    ]);
    for (const [bound, build] of cases) {
      expect(SpecRevisionContentSchema.safeParse(build(bound)).success).toBe(true);
      expect(SpecRevisionContentSchema.safeParse(build(bound + 1)).success).toBe(false);
    }
    const lines = (n: number) => Array.from({ length: n }, () => "A line.");
    expect(
      SpecRevisionContentSchema.safeParse({
        ...revision,
        outOfScope: lines(SPEC_OUT_OF_SCOPE_MAX_COUNT),
      }).success,
    ).toBe(true);
    expect(
      SpecRevisionContentSchema.safeParse({
        ...revision,
        outOfScope: lines(SPEC_OUT_OF_SCOPE_MAX_COUNT + 1),
      }).success,
    ).toBe(false);
  });

  test("accepts a clause citing the person's note (S7b-11)", () => {
    const content = { ...revision, clauses: [{ ...clause(1, 1), sources: [{ kind: "note" }] }] };
    expect(SpecRevisionContentSchema.safeParse(content).success).toBe(true);
    const withNumber = {
      ...revision,
      clauses: [{ ...clause(1, 1), sources: [{ kind: "note", number: 1 }] }],
    };
    expect(SpecRevisionContentSchema.safeParse(withNumber).success).toBe(false);
  });

  test("rejects malformed ids and sources", () => {
    const bad = [
      { ...revision, clauses: [{ ...clause(1, 1), id: "B1" }] },
      { ...revision, clauses: [{ ...clause(1, 1), criteria: [{ id: "C1.1", text: "x" }] }] },
      { ...revision, clauses: [{ ...clause(1, 1), sources: [{ kind: "waypoint", number: 0 }] }] },
      { ...revision, clauses: [{ ...clause(1, 1), sources: [{ kind: "map" }] }] },
    ];
    for (const content of bad) {
      expect(SpecRevisionContentSchema.safeParse(content).success).toBe(false);
    }
  });
});

describe("TicketSetContent", () => {
  test("accepts the demo's shape", () => {
    expect(TicketSetContentSchema.safeParse(set).success).toBe(true);
  });

  test("accepts 0 to 8 tickets and a ticket with 0 criteria, and rejects 9 tickets (slice 8b D2)", () => {
    expect(TICKET_SET_TICKETS_MAX_COUNT).toBe(8);
    const nothingNew = {
      ...set,
      tickets: [],
      dispositions: [{ criterion: "1.1", kind: "delivered", ticket: "T1", reason: null }],
    };
    expect(TicketSetContentSchema.safeParse(nothingNew).success).toBe(true);
    const takesOut = { ...set, tickets: [{ ...ticket(1), criteria: [] }] };
    expect(TicketSetContentSchema.safeParse(takesOut).success).toBe(true);
    const eight = { ...set, tickets: Array.from({ length: 8 }, (_, i) => ticket(i + 1)) };
    expect(TicketSetContentSchema.safeParse(eight).success).toBe(true);
    const nine = { ...set, tickets: Array.from({ length: 9 }, (_, i) => ticket(i + 1)) };
    expect(TicketSetContentSchema.safeParse(nine).success).toBe(false);
  });

  test("accepts the five disposition kinds and a follow-up ticket (slice 8b D2)", () => {
    const content = {
      ...set,
      tickets: [{ ...ticket(1), id: "T3", followUp: "T1" }],
      dispositions: [
        { criterion: "1.1", kind: "work", ticket: "T3", reason: "The rule changed." },
        { criterion: "1.2", kind: "satisfied", evidence: "realpath already runs." },
        { criterion: "1.3", kind: "delivered", ticket: "T1", reason: null },
        { criterion: "1.4", kind: "delivered", ticket: "T1", reason: "Wording only." },
        { criterion: "1.5", kind: "retained", ticket: "T2", reason: null },
        { criterion: "1.8", kind: "retained", ticket: "T2", reason: "Wording only." },
        { criterion: "1.6", kind: "removed", ticket: "T3", reason: "The flag goes." },
        { criterion: "1.7", kind: "removed", ticket: null, reason: "Never delivered." },
      ],
    };
    expect(TicketSetContentSchema.safeParse(content).success).toBe(true);
  });

  test("refuses a removed disposition without a reason and a retained one without a ticket or reason", () => {
    const bad = [
      { criterion: "1.1", kind: "removed", ticket: "T1" },
      { criterion: "1.1", kind: "removed", ticket: null, reason: "" },
      { criterion: "1.1", kind: "retained" },
      { criterion: "1.1", kind: "retained", ticket: "T1" },
      { criterion: "1.1", kind: "retained", ticket: "T1", reason: "" },
      { criterion: "1.1", kind: "delivered", ticket: "T1" },
    ];
    for (const disposition of bad) {
      expect(
        TicketSetContentSchema.safeParse({ ...set, dispositions: [disposition] }).success,
      ).toBe(false);
    }
  });

  test("a stored slice 7 set still parses (Existing Records)", () => {
    const stored: unknown = JSON.parse(JSON.stringify(set));
    expect(TicketSetContentSchema.parse(stored)).toEqual(set);
  });

  test("rejects each field one past its bound and accepts it at the bound", () => {
    const one = ticket(1);
    const lines = (n: number) => Array.from({ length: n }, () => "A line.");
    const blockers = (n: number) =>
      Array.from({ length: n }, () => ({ ticket: "T2", supplies: "a contract" }));
    const cases: [number, (n: number) => TicketSetContent][] = [
      [TICKET_CONTENT_TITLE_MAX_LENGTH, (n) => ({ ...set, tickets: [{ ...one, title: text(n) }] })],
      [TICKET_BUILD_MAX_LENGTH, (n) => ({ ...set, tickets: [{ ...one, build: text(n) }] })],
      [
        TICKET_BLOCKERS_MAX_COUNT,
        (n) => ({ ...set, tickets: [{ ...one, blockedBy: blockers(n) }] }),
      ],
      [
        CONTENT_LINE_MAX_LENGTH,
        (n) => ({
          ...set,
          tickets: [{ ...one, blockedBy: [{ ticket: "T2", supplies: text(n) }] }],
        }),
      ],
      [TICKET_TESTING_MAX_COUNT, (n) => ({ ...set, tickets: [{ ...one, testing: lines(n) }] })],
      [CONTENT_LINE_MAX_LENGTH, (n) => ({ ...set, tickets: [{ ...one, testing: [text(n)] }] })],
      [
        TICKET_OUT_OF_SCOPE_MAX_COUNT,
        (n) => ({ ...set, tickets: [{ ...one, outOfScope: lines(n) }] }),
      ],
      [
        DISPOSITION_TEXT_MAX_LENGTH,
        (n) => ({
          ...set,
          dispositions: [{ criterion: "1.1", kind: "satisfied", evidence: text(n) }],
        }),
      ],
      [
        DISPOSITION_TEXT_MAX_LENGTH,
        (n) => ({
          ...set,
          dispositions: [{ criterion: "1.1", kind: "work", ticket: "T1", reason: text(n) }],
        }),
      ],
      [TICKET_SET_SLICING_MAX_LENGTH, (n) => ({ ...set, slicing: text(n) })],
      [TICKET_SET_EXECUTION_MAX_LENGTH, (n) => ({ ...set, execution: text(n) })],
    ];
    expect([TICKET_BUILD_MAX_LENGTH, TICKET_BLOCKERS_MAX_COUNT, TICKET_TESTING_MAX_COUNT]).toEqual([
      3000, 7, 6,
    ]);
    expect([TICKET_SET_SLICING_MAX_LENGTH, TICKET_SET_EXECUTION_MAX_LENGTH]).toEqual([2000, 1000]);
    for (const [bound, build] of cases) {
      expect(TicketSetContentSchema.safeParse(build(bound)).success).toBe(true);
      expect(TicketSetContentSchema.safeParse(build(bound + 1)).success).toBe(false);
    }
  });

  test("rejects a ticket with no testing line, a satisfied disposition with no evidence, and an unknown kind", () => {
    const bad = [
      { ...set, tickets: [{ ...ticket(1), testing: [] }] },
      { ...set, dispositions: [{ criterion: "1.1", kind: "satisfied" }] },
      { ...set, dispositions: [{ criterion: "1.1", kind: "satisfied", evidence: "" }] },
      { ...set, dispositions: [{ criterion: "1.1", kind: "dropped", ticket: "T1" }] },
      { ...set, tickets: [{ ...ticket(1), id: "1" }] },
    ];
    for (const content of bad) {
      expect(TicketSetContentSchema.safeParse(content).success).toBe(false);
    }
  });

  test("pointers are repository paths; a stored ticket may have none, a drafted one names one", () => {
    const pointed = (pointers: string[]) => ({ ...set, tickets: [{ ...ticket(1), pointers }] });
    expect(TicketSetContentSchema.safeParse(pointed([])).success).toBe(true);
    expect(TicketSetDraft.safeParse(pointed([])).success).toBe(false);
    expect(TicketSetDraft.safeParse(pointed(["packages/core/src/delivery.ts"])).success).toBe(true);
    expect(TICKET_POINTERS_MAX_COUNT).toBe(20);
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `src/${String(i)}.ts`);
    for (const schema of [TicketSetContentSchema, TicketSetDraft]) {
      expect(schema.safeParse(pointed(paths(20))).success).toBe(true);
      expect(schema.safeParse(pointed(paths(21))).success).toBe(false);
    }
    for (const bad of [
      "/abs/path.ts",
      "../outside.ts",
      "src/../../x.ts",
      " src/a.ts",
      "a\nb",
      "",
    ]) {
      expect(TicketSetContentSchema.safeParse(pointed([bad])).success).toBe(false);
    }
    const noPointers: Record<string, unknown> = { ...ticket(1) };
    delete noPointers.pointers;
    expect(TicketSetContentSchema.safeParse({ ...set, tickets: [noPointers] }).success).toBe(false);
  });

  test("a drafted set keeps to five tickets and its model's build max, a stored one may exceed them", () => {
    expect(DRAFT_TICKET_SET_TICKETS_MAX_COUNT).toBe(5);
    const pointed = (n: number) => ({ ...ticket(n), pointers: ["src/a.ts"] });
    const tickets = (n: number) => Array.from({ length: n }, (_, i) => pointed(i + 1));
    expect(TicketSetDraft.safeParse({ ...set, tickets: tickets(5) }).success).toBe(true);
    expect(TicketSetDraft.safeParse({ ...set, tickets: tickets(6) }).success).toBe(false);
    expect(TicketSetContentSchema.safeParse({ ...set, tickets: tickets(6) }).success).toBe(true);
    const built = (length: number) => ({
      ...set,
      tickets: [{ ...pointed(1), build: "b".repeat(length) }],
    });
    expect(TICKET_BUILD_MAX_LENGTH).toBe(3000);
    expect(TicketSetContentSchema.safeParse(built(TICKET_BUILD_MAX_LENGTH)).success).toBe(true);
    expect(TicketSetContentSchema.safeParse(built(TICKET_BUILD_MAX_LENGTH + 1)).success).toBe(
      false,
    );
    expect(TicketSetDraft.safeParse(built(LIMITS.ticketBuild.max)).success).toBe(true);
    expect(TicketSetDraft.safeParse(built(LIMITS.ticketBuild.max + 1)).success).toBe(false);
  });
});

describe("SpecReviewOutcome", () => {
  test("accepts 0 and 8 findings and rejects 9", () => {
    expect(SPEC_REVIEW_FINDINGS_MAX_COUNT).toBe(8);
    const findings = (n: number) => Array.from({ length: n }, () => finding);
    expect(
      SpecReviewOutcome.safeParse({ summary: "Clean.", findings: [], verified: [] }).success,
    ).toBe(true);
    expect(
      SpecReviewOutcome.safeParse({ summary: "Many.", findings: findings(8), verified: [] })
        .success,
    ).toBe(true);
    expect(
      SpecReviewOutcome.safeParse({ summary: "Many.", findings: findings(9), verified: [] })
        .success,
    ).toBe(false);
  });

  test("rejects each field one past its bound and accepts it at the bound", () => {
    const cases: [number, (n: number) => unknown][] = [
      [LIMITS.specReviewSummary.max, (n) => ({ summary: text(n), findings: [], verified: [] })],
      [
        WAYPOINT_TITLE_MAX_LENGTH,
        (n) => ({ summary: "s", findings: [{ ...finding, title: text(n) }], verified: [] }),
      ],
      [
        WAYPOINT_RESOLUTION_MAX_LENGTH,
        (n) => ({ summary: "s", findings: [{ ...finding, explanation: text(n) }], verified: [] }),
      ],
      [
        WAYPOINT_QUESTION_MAX_LENGTH,
        (n) => ({ summary: "s", findings: [{ ...finding, question: text(n) }], verified: [] }),
      ],
    ];
    expect(SPEC_REVIEW_SUMMARY_MAX_LENGTH).toBe(2000);
    for (const [bound, build] of cases) {
      expect(SpecReviewOutcome.safeParse(build(bound)).success).toBe(true);
      expect(SpecReviewOutcome.safeParse(build(bound + 1)).success).toBe(false);
    }
  });

  test("rejects an unknown kind or route and an element that is not a clause or criterion id", () => {
    const bad = [
      { ...finding, kind: "uncovered_clause" },
      { ...finding, route: "escalate" },
      { ...finding, elementIds: ["T1"] },
    ];
    for (const item of bad) {
      expect(SpecReviewOutcome.safeParse({ summary: "s", findings: [item] }).success).toBe(false);
    }
  });

  test("verified names a survey item by number, with its answer, path and line (RC2)", () => {
    const check = { item: 1, answer: "It does.", path: "src/a.ts", line: 3 };
    const outcome = (verified: unknown[]) => ({ summary: "s", findings: [], verified });
    expect(SpecReviewOutcome.safeParse(outcome([check])).success).toBe(true);
    expect(SpecReviewOutcome.safeParse(outcome([{ ...check, item: 0 }])).success).toBe(false);
    expect(SpecReviewOutcome.safeParse(outcome([{ ...check, path: "/abs.ts" }])).success).toBe(
      false,
    );
    expect(SpecReviewOutcome.safeParse({ summary: "s", findings: [] }).success).toBe(false);
  });
});

describe("a clause's reliesOn and adds (RC1)", () => {
  const clause = {
    id: "C1",
    title: "Export",
    text: "Exports.",
    criteria: [{ id: "1.1", text: "It exports." }],
    sources: [{ kind: "destination" }],
  };
  const revision = (fields: object) => ({
    title: "Export",
    problem: "None.",
    solution: "One.",
    clauses: [{ ...clause, ...fields }],
    outOfScope: [],
  });
  const declared = { reliesOn: [{ name: "maps", path: null }], adds: ["export_failed"] };

  test("a stored revision may lack them; To Spec's draft must carry both", () => {
    expect(SpecRevisionContentSchema.safeParse(revision({})).success).toBe(true);
    expect(SpecRevisionContentSchema.safeParse(revision(declared)).success).toBe(true);
    const Draft = specRevisionDraft(LIMITS);
    expect(Draft.safeParse(revision({})).success).toBe(false);
    expect(Draft.safeParse(revision(declared)).success).toBe(true);
  });

  test("a reliance's path is relative to the repository root", () => {
    const at = (path: string) => revision({ ...declared, reliesOn: [{ name: "maps", path }] });
    expect(SpecRevisionContentSchema.safeParse(at("packages/db/src/schema.ts")).success).toBe(true);
    expect(SpecRevisionContentSchema.safeParse(at("/abs/schema.ts")).success).toBe(false);
    expect(SpecRevisionContentSchema.safeParse(at("../up.ts")).success).toBe(false);
  });
});
