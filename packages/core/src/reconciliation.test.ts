import type {
  Clause,
  Disposition,
  SpecRevisionContent,
  TicketContent,
  TicketSetContent,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  baseline,
  changeTally,
  deliveredTicket,
  deliveryOf,
  dispositionTally,
  expectation,
  isDeliverable,
  isOpenCarrier,
  missedDepartures,
  openCarrier,
  readSpecRecord,
  removedCriteria,
  tension,
  textDelta,
} from "./reconciliation.ts";
import type { RevisionRecord, RunRecord, SetRecord, SpecRecord } from "./reconciliation.ts";
import {
  addProject,
  asPre0010Run,
  clearedMap,
  closeTestContext,
  deliveredSpec,
  insertNextRevision,
  mergeDelivery,
  openTestContext,
  passedDelivery,
  SPEC,
  TICKETS,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

// --- The separator spec: separatorR1, separatorR2, separatorDeltaTickets ---

const SEPARATOR_MAP = "custom-separator";
const LENGTH_MAP = "slug-length-and-separators";

function revision(
  n: number,
  mapId: string,
  approved: boolean,
  clauses: Clause[],
  outOfScope: string[],
): RevisionRecord {
  const content: SpecRevisionContent = {
    title: "Custom separator option",
    problem: "Callers can't choose the separator.",
    solution: "A `separator` option.",
    clauses,
    outOfScope,
  };
  return { revision: n, mapId, content, approved };
}

const C1_R1: Clause = {
  id: "C1",
  title: "Separator option",
  text: "`separator` replaces '-' between words. It is a single non-alphanumeric character.",
  criteria: [
    { id: "1.1", text: "slugify('a b', { separator: '_' }) returns 'a_b'." },
    { id: "1.2", text: "A letter or a digit is rejected with an error saying what is allowed." },
    { id: "1.3", text: "A separator longer than one character is rejected." },
  ],
  sources: [{ kind: "waypoint", number: 1 }],
  reliesOn: [],
  adds: ["new behaviour"],
};

const C2: Clause = {
  id: "C2",
  title: "Runs collapse to one separator",
  text: "Spaces and punctuation between two words become one separator, however many there are.",
  criteria: [{ id: "2.1", text: "slugify('a  -  b', { separator: '_' }) returns 'a_b'." }],
  sources: [{ kind: "waypoint", number: 1 }],
  reliesOn: [],
  adds: ["new behaviour"],
};

const FOUR_OR_MORE = "A separator of four or more characters is rejected with the same error.";

const C1_R2: Clause = {
  id: "C1",
  title: "Separator option",
  text: "`separator` replaces '-' between words. It is one to three non-alphanumeric characters, put between words exactly as given.",
  criteria: [
    { id: "1.1", text: "slugify('a b', { separator: '_' }) returns 'a_b'." },
    {
      id: "1.2",
      text: "A letter or a digit is rejected with an error saying a separator is one to three non-alphanumeric characters.",
    },
    { id: "1.4", text: "slugify('a b', { separator: '--' }) returns 'a--b'." },
    { id: "1.5", text: FOUR_OR_MORE },
  ],
  sources: [{ kind: "waypoint", number: 2 }],
  reliesOn: [],
  adds: ["new behaviour"],
};

const R1 = revision(1, SEPARATOR_MAP, true, [C1_R1, C2], ["Separators longer than one character."]);
const R2 = revision(
  2,
  LENGTH_MAP,
  false,
  [C1_R2, { ...C2, sources: [] }],
  ["Separators of four or more characters."],
);

function ticket(id: string, criteria: string[]): TicketContent {
  return {
    id,
    title: `Ticket ${id}`,
    build: "Build it.",
    blockedBy: [],
    criteria,
    testing: ["Tests pass."],
    followUp: null,
    outOfScope: [],
    pointers: ["src/index.ts"],
  };
}

const R1_SET: SetRecord = {
  id: "set-r1",
  revision: 1,
  approved: true,
  content: {
    tickets: [ticket("T1", ["1.1", "1.2", "1.3"]), ticket("T2", ["2.1"])],
    dispositions: [
      { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
      { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
      { criterion: "1.3", kind: "work", ticket: "T1", reason: null },
      { criterion: "2.1", kind: "work", ticket: "T2", reason: null },
    ],
    slicing: "Two tickets. T1 adds the option; T2 changes the collapse step to use it.",
    execution: "Agent-verifiable by npm test.",
  },
};

const RESEARCH_REASON =
  "Research 3: T2's collapse step builds a character class from the separator, so once T3 lets '--' through, 'a -- b' collapses to 'a-b'.";

/** `separatorDeltaTickets`: the set the agent writes for r2. */
const DELTA_TICKETS: TicketSetContent = {
  tickets: [
    { ...ticket("T3", ["1.2", "1.4", "1.5"]), followUp: "T1" },
    {
      ...ticket("T4", ["2.1"]),
      blockedBy: [{ ticket: "T3", supplies: "separators longer than one character" }],
      followUp: "T2",
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "delivered", ticket: "T1", reason: null },
    { criterion: "1.2", kind: "work", ticket: "T3", reason: null },
    { criterion: "1.4", kind: "work", ticket: "T3", reason: null },
    { criterion: "1.5", kind: "work", ticket: "T3", reason: null },
    { criterion: "2.1", kind: "work", ticket: "T4", reason: RESEARCH_REASON },
    {
      criterion: "1.3",
      kind: "removed",
      ticket: "T3",
      reason: "T1's validation refuses anything longer than one character.",
    },
  ],
  slicing: "Two tickets for the change from r1.",
  execution: "Agent-verifiable by npm test.",
};

const R2_SET: SetRecord = { id: "set-r2", revision: 2, approved: false, content: DELTA_TICKETS };

const RUN_1: RunRecord = {
  ticketSetId: "set-r1",
  number: 1,
  merged: true,
  tickets: [
    { ticket: "T1", commit: "52b9a0e" },
    { ticket: "T2", commit: "77de012" },
  ],
};

/** The separator spec: r1 delivered and merged, r2 from another map with its set. */
const SEPARATOR: SpecRecord = { revisions: [R1, R2], sets: [R1_SET, R2_SET], runs: [RUN_1] };

/** r1's set approved and never delivered; r2 from another map. */
const UNDELIVERED: SpecRecord = { revisions: [R1, R2], sets: [R1_SET, R2_SET], runs: [] };

// --- Synthetic revisions the separator spec lacks: a moved criterion, new and removed clauses ---

/**
 * r3 from r2: a new clause C3, walked before C1, takes 1.5 by a move (`was`, same wording) and 1.4
 * by a reworded move; C1 keeps 1.1 and 1.2 word for word but lost two criteria, so it is changed;
 * C2 is removed with 2.1. Out of scope unchanged.
 */
const C3: Clause = {
  id: "C3",
  title: "Longer separators",
  text: "A separator may be up to three characters.",
  criteria: [
    { id: "3.1", text: FOUR_OR_MORE, was: "1.5" },
    { id: "3.2", text: "slugify('a b', { separator: '~~' }) returns 'a~~b'.", was: "1.4" },
  ],
  sources: [{ kind: "note" }],
  reliesOn: [],
  adds: ["new behaviour"],
};
const C1_R3: Clause = { ...C1_R2, criteria: C1_R2.criteria.slice(0, 2) };
const R3 = revision(3, LENGTH_MAP, false, [C3, C1_R3], ["Separators of four or more characters."]);

/** r4 from r3: C3 is removed; 3.1 moves back into C1 as 1.6, 3.2 is dropped. */
const R4 = revision(
  4,
  LENGTH_MAP,
  false,
  [{ ...C1_R3, criteria: [...C1_R3.criteria, { id: "1.6", text: FOUR_OR_MORE, was: "3.1" }] }],
  ["Separators of four or more characters."],
);

const MOVES: SpecRecord = { revisions: [R1, R2, R3, R4], sets: [R1_SET], runs: [RUN_1] };

describe("textDelta", () => {
  test("revision 1 has none", () => {
    expect(textDelta(SEPARATOR, 1)).toBeNull();
  });

  test("separator r2: new, changed, unchanged and removed criteria; changed and unchanged clauses; Out of scope added and dropped", () => {
    expect(textDelta(SEPARATOR, 2)).toEqual({
      before: 1,
      after: 2,
      clauses: { C1: "changed", C2: "unchanged" },
      criteria: {
        "1.1": { change: "unchanged", before: null },
        "1.2": { change: "changed", before: C1_R1.criteria[1] },
        "1.4": { change: "new", before: null },
        "1.5": { change: "new", before: null },
        "2.1": { change: "unchanged", before: null },
      },
      removedClauses: [],
      removedCriteria: [{ clause: C1_R1, criterion: C1_R1.criteria[2] }],
      outOfScopeAdded: ["Separators of four or more characters."],
      outOfScopeDropped: ["Separators longer than one character."],
    });
  });

  test("r3: a new clause, a moved criterion, a reworded move, a clause changed only by losing criteria to a move, a removed clause", () => {
    expect(textDelta(MOVES, 3)).toEqual({
      before: 2,
      after: 3,
      clauses: { C3: "new", C1: "changed" },
      criteria: {
        "3.1": { change: "moved", before: C1_R2.criteria[3] },
        "3.2": { change: "changed", before: C1_R2.criteria[2] },
        "1.1": { change: "unchanged", before: null },
        "1.2": { change: "unchanged", before: null },
      },
      removedClauses: [{ ...C2, sources: [] }],
      removedCriteria: [{ clause: { ...C2, sources: [] }, criterion: C2.criteria[0] }],
      outOfScopeAdded: [],
      outOfScopeDropped: [],
    });
  });

  test("r4: a removed clause whose criterion moved out is not a removed criterion; the one dropped is", () => {
    const delta = textDelta(MOVES, 4);
    expect(delta?.clauses).toEqual({ C1: "changed" });
    expect(delta?.criteria["1.6"]).toEqual({ change: "moved", before: C3.criteria[0] });
    expect(delta?.removedClauses).toEqual([C3]);
    expect(delta?.removedCriteria).toEqual([{ clause: C3, criterion: C3.criteria[1] }]);
  });

  test("a `was` the revision before lacks, or a move without `was`, is a programmer error", () => {
    const badWas = revision(
      3,
      LENGTH_MAP,
      false,
      [{ ...C1_R2, criteria: [{ id: "1.6", text: "x", was: "1.3" }] }],
      [],
    );
    expect(() => textDelta({ ...SEPARATOR, revisions: [R1, R2, badWas] }, 3)).toThrow();
    const silentMove = revision(
      3,
      LENGTH_MAP,
      false,
      [
        {
          ...C3,
          criteria: [{ id: "1.1", text: "slugify('a b', { separator: '_' }) returns 'a_b'." }],
        },
      ],
      [],
    );
    expect(() => textDelta({ ...SEPARATOR, revisions: [R1, R2, silentMove] }, 3)).toThrow();
  });

  test("changeTally counts each change in words", () => {
    const r2 = textDelta(SEPARATOR, 2);
    const r3 = textDelta(MOVES, 3);
    if (r2 === null || r3 === null) throw new Error("no delta");
    expect(changeTally(r2)).toBe("2 new · 1 changed · 1 removed · 2 unchanged");
    expect(changeTally(r3)).toBe("1 changed · 1 moved · 1 removed · 2 unchanged");
  });
});

describe("deliveryOf, baseline and openCarrier", () => {
  test("a ticket merged in a merged run is delivered, with its run, commit, revision and map", () => {
    expect(deliveryOf(SEPARATOR, "set-r1", "T2")).toMatchObject({
      ticket: { id: "T2" },
      setId: "set-r1",
      revision: 1,
      mapId: SEPARATOR_MAP,
      run: 1,
      commit: "77de012",
    });
    expect(baseline(SEPARATOR, 2, "1.1")).toMatchObject({
      ticket: { id: "T1" },
      run: 1,
      commit: "52b9a0e",
    });
    expect(openCarrier(SEPARATOR, 2, "1.1")).toBeNull();
  });

  test("a ticket of an unmerged run, or with no merged commit in a merged run, is not delivered", () => {
    const unmerged = { ...SEPARATOR, runs: [{ ...RUN_1, merged: false }] };
    expect(deliveryOf(unmerged, "set-r1", "T1")).toBeNull();
    expect(baseline(unmerged, 2, "1.1")).toBeNull();
    const partly = {
      ...SEPARATOR,
      runs: [
        {
          ...RUN_1,
          tickets: [
            { ticket: "T1", commit: "52b9a0e" },
            { ticket: "T2", commit: null },
          ],
        },
      ],
    };
    expect(deliveryOf(partly, "set-r1", "T2")).toBeNull();
    // T2's set has a merged run, so it is not deliverable and carries nothing.
    expect(openCarrier(partly, 2, "2.1")).toBeNull();
  });

  test("a run from before 0010 (no ticket rows) gives no baseline", () => {
    const pre0010 = { ...SEPARATOR, runs: [{ ...RUN_1, tickets: [] }] };
    expect(baseline(pre0010, 2, "1.1")).toBeNull();
  });

  test("an approved, undelivered set whose revision is its map's latest carries; once its map writes another revision it doesn't", () => {
    expect(openCarrier(UNDELIVERED, 2, "1.1")).toMatchObject({
      ticket: { id: "T1" },
      set: { id: "set-r1" },
    });
    const sameMap = { ...UNDELIVERED, revisions: [R1, { ...R2, mapId: SEPARATOR_MAP }] };
    expect(openCarrier(sameMap, 2, "1.1")).toBeNull();
    const unapproved = { ...UNDELIVERED, sets: [{ ...R1_SET, approved: false }, R2_SET] };
    expect(openCarrier(unapproved, 2, "1.1")).toBeNull();
  });
});

describe("removedCriteria", () => {
  test("separator r2: the criteria r1 had that r2 drops", () => {
    expect(removedCriteria(SEPARATOR, 2)).toEqual(textDelta(SEPARATOR, 2)?.removedCriteria);
  });

  // r3 from a third map words r2 again: 1.3 was dropped in r2, a middle revision.
  const R3_AGAIN = revision(3, "third-map", false, R2.content.clauses, R2.content.outOfScope);

  test("a criterion dropped in a superseded middle revision is taken out when it has a baseline", () => {
    const spec = { ...SEPARATOR, revisions: [R1, R2, R3_AGAIN] };
    expect(textDelta(spec, 3)?.removedCriteria).toEqual([]);
    expect(removedCriteria(spec, 3)).toEqual([{ clause: C1_R1, criterion: C1_R1.criteria[2] }]);
  });

  test("…or an open carrier, and is not when it has neither", () => {
    expect(removedCriteria({ ...UNDELIVERED, revisions: [R1, R2, R3_AGAIN] }, 3)).toEqual([
      { clause: C1_R1, criterion: C1_R1.criteria[2] },
    ]);
    expect(removedCriteria({ revisions: [R1, R2, R3_AGAIN], sets: [], runs: [] }, 3)).toEqual([]);
  });

  test("a criterion an approved set before took out is never taken out again", () => {
    // r2's set, approved, disposes 1.3 `removed`; r3 words r2 again, so 1.3 stays out.
    const approvedR2 = { ...R2, approved: true };
    const approvedSet = { ...R2_SET, approved: true };
    const delivered: SpecRecord = {
      revisions: [R1, approvedR2, R3_AGAIN],
      sets: [R1_SET, approvedSet],
      runs: [
        RUN_1,
        {
          ticketSetId: "set-r2",
          number: 2,
          merged: true,
          tickets: [{ ticket: "T3", commit: "c3" }],
        },
      ],
    };
    expect(removedCriteria(delivered, 3)).toEqual([]);
    // Approved and not yet delivered: that set still takes it out.
    expect(removedCriteria({ ...delivered, runs: [RUN_1] }, 3)).toEqual([]);
    // A set never approved took nothing out: 1.3 is still taken out.
    expect(removedCriteria({ ...delivered, sets: [R1_SET, R2_SET], runs: [RUN_1] }, 3)).toEqual([
      { clause: C1_R1, criterion: C1_R1.criteria[2] },
    ]);
  });

  test("a criterion moved away (`was`) is not removed; a later revision keeps the moved one's chain", () => {
    // r3: 2.1 dropped with C2; 1.5 and 1.4 moved, not removed; 1.3, dropped in r2, delivered by T1.
    expect(removedCriteria(MOVES, 3).map((r) => r.criterion.id)).toEqual(["2.1", "1.3"]);
    // r4: 3.2 dropped from r3; 2.1 dropped in r3 and delivered by T2; 1.3 dropped in r2 and delivered by T1.
    expect(removedCriteria(MOVES, 4).map((r) => r.criterion.id)).toEqual(["3.2", "2.1", "1.3"]);
  });
});

describe("expectation and tension", () => {
  const delta = textDelta(SEPARATOR, 2);

  test("separator r2: each criterion's expectation", () => {
    expect(expectation(SEPARATOR, delta, "1.1")).toEqual({
      kind: "delivered",
      why: "unchanged, delivered by T1 in run 1",
    });
    expect(expectation(SEPARATOR, delta, "1.2")).toEqual({
      kind: "work",
      why: "its wording changed in r2",
    });
    expect(expectation(SEPARATOR, delta, "1.4")).toEqual({ kind: "work", why: "new in r2" });
    expect(expectation(SEPARATOR, delta, "2.1")).toEqual({
      kind: "delivered",
      why: "unchanged, delivered by T2 in run 1",
    });
    expect(expectation(SEPARATOR, null, "1.1")).toEqual({ kind: "work", why: "first revision" });
  });

  test("the wording is also checked against the revision that delivered or carries it", () => {
    // r3 from a third map words r2 again: 1.2 is unchanged from r2 but not from r1, which delivered it.
    const r3 = revision(3, "third-map", false, R2.content.clauses, R2.content.outOfScope);
    const spec = { ...SEPARATOR, revisions: [R1, R2, r3] };
    expect(expectation(spec, textDelta(spec, 3), "1.2")).toEqual({
      kind: "work",
      why: "its wording changed since T1 delivered it under r1",
    });
    const carried = { ...UNDELIVERED, revisions: [R1, R2, r3] };
    expect(expectation(carried, textDelta(carried, 3), "1.2")).toEqual({
      kind: "work",
      why: "its wording changed since T1 of r1 was written for it",
    });
    expect(expectation(carried, textDelta(carried, 3), "1.1")).toEqual({
      kind: "retained",
      why: "unchanged, carried by T1 of r1, not yet delivered",
    });
    const never = { revisions: [R1, R2, r3], sets: [], runs: [] };
    expect(expectation(never, textDelta(never, 3), "1.1")).toEqual({
      kind: "work",
      why: "unchanged, never delivered",
    });
  });

  test("separatorDeltaTickets: 2.1 is unchanged and delivered yet needs work, with its reason; the rest don't depart", () => {
    const departures = DELTA_TICKETS.dispositions.map((d) => [
      d.criterion,
      tension(SEPARATOR, delta, d),
    ]);
    expect(departures).toEqual([
      ["1.1", null],
      ["1.2", null],
      ["1.4", null],
      ["1.5", null],
      [
        "2.1",
        {
          question: "2.1 is unchanged, delivered by T2 in run 1. Why does T4 need to change it?",
          reason: RESEARCH_REASON,
        },
      ],
      ["1.3", null],
    ]);
  });

  const work = (criterion: string, ticketId: string): Disposition => ({
    criterion,
    kind: "work",
    ticket: ticketId,
    reason: null,
  });
  const delivered = (criterion: string, ticketId: string): Disposition => ({
    criterion,
    kind: "delivered",
    ticket: ticketId,
    reason: null,
  });
  const retained = (criterion: string, ticketId: string): Disposition => ({
    criterion,
    kind: "retained",
    ticket: ticketId,
    reason: null,
  });

  test.each([
    [
      "expected work, marked delivered",
      SEPARATOR,
      delivered("1.2", "T1"),
      "1.2 is its wording changed in r2, yet it is marked delivered by T1. Why does what T1 built still meet it?",
    ],
    [
      "expected work, marked retained",
      SEPARATOR,
      retained("1.4", "T1"),
      "1.4 is new in r2, yet it is left to T1, which was written before the change. Why does that ticket still cover it?",
    ],
    [
      "expected delivered, marked retained",
      SEPARATOR,
      retained("1.1", "T1"),
      "1.1 is unchanged, delivered by T1 in run 1, yet it is marked as carried by the open ticket T1.",
    ],
    [
      "expected retained, marked work",
      UNDELIVERED,
      work("1.1", "T3"),
      "1.1 is unchanged, carried by T1 of r1, not yet delivered. Why does T3 carry it again?",
    ],
    [
      "expected retained, marked delivered",
      UNDELIVERED,
      delivered("1.1", "T1"),
      "1.1 is unchanged, carried by T1 of r1, not yet delivered, yet it is marked delivered by T1.",
    ],
  ])("%s", (_, spec, disposition, question) => {
    expect(tension(spec, textDelta(spec, 2), disposition)).toEqual({ question, reason: null });
  });

  test("satisfied and removed never depart", () => {
    expect(
      tension(SEPARATOR, delta, { criterion: "1.1", kind: "satisfied", evidence: "It does." }),
    ).toBeNull();
    expect(
      tension(SEPARATOR, delta, {
        criterion: "1.3",
        kind: "removed",
        ticket: null,
        reason: "Gone.",
      }),
    ).toBeNull();
  });

  test("dispositionTally names each kind with its count", () => {
    expect(dispositionTally(DELTA_TICKETS)).toBe("4 need work · 1 carry over · 1 removed");
    expect(
      dispositionTally({
        ...DELTA_TICKETS,
        dispositions: [
          retained("1.1", "T1"),
          { criterion: "1.2", kind: "satisfied", evidence: "It does." },
        ],
      }),
    ).toBe("1 retained · 1 already done");
  });
});

// --- Stored rows: a real temp repository, a real run and Mark merged ---

describe("the reads over stored rows", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await openTestContext("zenorm-core-reconciliation-");
  });

  afterEach(async () => {
    await closeTestContext(context);
  });

  test("a merged run's ticket is delivered and is r2's baseline", async () => {
    const project = await addProject(context, "repo");
    const delivered = await deliveredSpec(context, project);
    const other = await clearedMap(context, project);
    insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: SPEC,
      approved: true,
      set: null,
    });
    const spec = readSpecRecord(context.db, delivered.specificationId);
    expect(deliveryOf(spec, delivered.ticketSetId, "T1")).toEqual({
      ticket: TICKETS.tickets[0],
      setId: delivered.ticketSetId,
      revision: 1,
      mapId: delivered.mapId,
      run: delivered.run.number,
      commit: delivered.finalCommit,
    });
    expect(baseline(spec, 2, "1.1")).toMatchObject({ ticket: { id: "T2" }, run: 1 });
    expect(expectation(spec, textDelta(spec, 2), "1.2")).toEqual({
      kind: "delivered",
      why: "unchanged, delivered by T1 in run 1",
    });
  });

  test("a passed run not yet merged delivers nothing; its set still carries", async () => {
    const project = await addProject(context, "repo");
    const passed = await passedDelivery(context, project);
    const other = await clearedMap(context, project);
    insertNextRevision(context, {
      specificationId: passed.specificationId,
      mapId: other,
      content: SPEC,
      approved: true,
      set: null,
    });
    const spec = readSpecRecord(context.db, passed.specificationId);
    expect(deliveryOf(spec, passed.ticketSetId, "T1")).toBeNull();
    expect(baseline(spec, 2, "1.2")).toBeNull();
    expect(openCarrier(spec, 2, "1.2")).toMatchObject({ ticket: { id: "T1" } });
  });

  test("a merged run from before 0010 gives no baseline, and its set is not deliverable", async () => {
    const project = await addProject(context, "repo");
    const passed = await passedDelivery(context, project);
    asPre0010Run(context, passed.run.id);
    await mergeDelivery(context, project, passed.run);
    const spec = readSpecRecord(context.db, passed.specificationId);
    expect(baseline(spec, 2, "1.2")).toBeNull();
    const set = spec.sets[0];
    if (set === undefined) throw new Error("no set");
    expect(isDeliverable(spec, set)).toBe(false);
  });

  test("an approved set whose map wrote a newer revision is not deliverable", async () => {
    const project = await addProject(context, "repo");
    const passed = await passedDelivery(context, project);
    const spec1 = readSpecRecord(context.db, passed.specificationId);
    const set = spec1.sets[0];
    if (set === undefined) throw new Error("no set");
    expect(isDeliverable(spec1, set)).toBe(true);
    insertNextRevision(context, {
      specificationId: passed.specificationId,
      mapId: passed.mapId,
      content: SPEC,
      approved: false,
      set: null,
    });
    const spec2 = readSpecRecord(context.db, passed.specificationId);
    expect(isDeliverable(spec2, set)).toBe(false);
    expect(openCarrier(spec2, 2, "1.2")).toBeNull();
  });

  test("an approved r2 from another map with its set in a chosen state reads back", async () => {
    const project = await addProject(context, "repo");
    const delivered = await deliveredSpec(context, project);
    const other = await clearedMap(context, project);
    const next = insertNextRevision(context, {
      specificationId: delivered.specificationId,
      mapId: other,
      content: SPEC,
      approved: true,
      set: {
        state: "review_passed",
        content: {
          ...TICKETS,
          tickets: [],
          dispositions: [
            { criterion: "1.1", kind: "delivered", ticket: "T2", reason: null },
            { criterion: "1.2", kind: "delivered", ticket: "T1", reason: null },
          ],
        },
      },
    });
    const spec = readSpecRecord(context.db, delivered.specificationId);
    expect(spec.revisions.map((r) => [r.revision, r.mapId, r.approved])).toEqual([
      [1, delivered.mapId, true],
      [2, other, true],
    ]);
    expect(spec.sets.map((s) => [s.id, s.revision, s.approved])).toEqual([
      [delivered.ticketSetId, 1, true],
      [next.ticketSetId, 2, false],
    ]);
    expect(spec.runs).toEqual([
      {
        ticketSetId: delivered.ticketSetId,
        number: 1,
        merged: true,
        tickets: [
          { ticket: "T1", commit: delivered.finalCommit },
          { ticket: "T2", commit: delivered.finalCommit },
        ],
      },
    ]);
  });
});

describe("the review's departure check over separatorDeltaTickets", () => {
  const reasonless = (content: TicketSetContent): TicketSetContent => ({
    ...content,
    dispositions: content.dispositions.map((d) =>
      d.criterion === "2.1" && d.kind === "work" ? { ...d, reason: null } : d,
    ),
  });

  test("2.1, unchanged yet needing work, carries its reason: no finding is needed", () => {
    expect(missedDepartures(SEPARATOR, 2, DELTA_TICKETS, [])).toEqual([]);
  });

  test("without its reason, 2.1 needs a disposition_without_reason finding naming it", () => {
    expect(missedDepartures(SEPARATOR, 2, reasonless(DELTA_TICKETS), [])).toEqual(["2.1"]);
    const finding = { kind: "disposition_without_reason" as const, criterionIds: ["2.1"] };
    expect(missedDepartures(SEPARATOR, 2, reasonless(DELTA_TICKETS), [finding])).toEqual([]);
    const otherKind = { kind: "untraced_criterion" as const, criterionIds: ["2.1"] };
    expect(missedDepartures(SEPARATOR, 2, reasonless(DELTA_TICKETS), [otherKind])).toEqual(["2.1"]);
  });

  test("a retained departure with its reason needs no finding; without one it needs its finding", () => {
    const retainedAs = (reason: string | null): TicketSetContent => ({
      ...DELTA_TICKETS,
      dispositions: DELTA_TICKETS.dispositions.map((d) =>
        d.criterion === "1.1" ? { criterion: "1.1", kind: "retained", ticket: "T1", reason } : d,
      ),
    });
    expect(missedDepartures(SEPARATOR, 2, retainedAs("T1 still covers it."), [])).toEqual([]);
    expect(missedDepartures(SEPARATOR, 2, retainedAs(null), [])).toEqual(["1.1"]);
    const finding = { kind: "disposition_without_reason" as const, criterionIds: ["1.1"] };
    expect(missedDepartures(SEPARATOR, 2, retainedAs(null), [finding])).toEqual([]);
  });

  test("a retained disposition that follows its reading doesn't depart", () => {
    expect(
      tension(UNDELIVERED, textDelta(UNDELIVERED, 2), {
        criterion: "1.1",
        kind: "retained",
        ticket: "T1",
        reason: null,
      }),
    ).toBeNull();
  });

  test("deliveredTicket and isOpenCarrier resolve the ids a later set names", () => {
    expect(deliveredTicket(SEPARATOR, 2, "T1")).toMatchObject({ run: 1, commit: "52b9a0e" });
    expect(deliveredTicket(SEPARATOR, 2, "T3")).toBeNull();
    expect(deliveredTicket(UNDELIVERED, 2, "T1")).toBeNull();
    expect(isOpenCarrier(UNDELIVERED, 2, "1.1", "T1")).toBe(true);
    expect(isOpenCarrier(UNDELIVERED, 2, "1.1", "T2")).toBe(false);
    expect(isOpenCarrier(SEPARATOR, 2, "1.1", "T1")).toBe(false);
  });
});
