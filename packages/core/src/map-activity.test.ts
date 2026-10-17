import { ActivityLine } from "@zenorm/contracts";
import type { HatchChange, Question, Verdict } from "@zenorm/contracts";
import { hatchMessages } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WAIT_LINES, mapActivity } from "./map-activity.ts";
import { getMapOverview } from "./map-overview.ts";
import { rejectTicketSet } from "./planning.ts";
import {
  FAILED_TICKETS_REVIEW,
  addProject,
  chartedMap,
  closeTestContext,
  draftedTicketSet,
  heldTicketSet,
  insertMessage,
  openTestContext,
  recordRunningTicketSet,
  recordRunningTicketsReview,
  reviewedTicketSet,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import type {
  ActivityRevision,
  ActivityRun,
  ActivitySpec,
  ActivityTicketSet,
  MapActivityInput,
} from "./map-activity.ts";

/** Minute `n` of the test day, as stored. */
function at(n: number): string {
  return new Date(Date.UTC(2026, 9, 7, 12, n)).toISOString();
}

const PASSED: Verdict = { reviewedCommit: "a".repeat(40), summary: "Good.", findings: [] };
const BLOCKED: Verdict = {
  ...PASSED,
  findings: [
    {
      axis: "spec",
      severity: "blocking",
      file: null,
      title: "No",
      detail: "No toggle.",
      criterion: null,
    },
  ],
};

/** A revision written at `writtenAt`, titled `title`, with no review, approval or rejection. */
function revision(
  title: string,
  writtenAt: string,
  fields: Partial<ActivityRevision>,
): ActivityRevision {
  return {
    title,
    first: true,
    laterMapOfDelivered: false,
    writtenAt,
    writtenByRun: SPEC_WRITER,
    reviews: [],
    approvedAt: null,
    rejection: null,
    ...fields,
  };
}

const MAP_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e70";
const WAYPOINT_IDS = [
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e81",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e82",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e83",
];
const RUN_IDS = [
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e71",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e72",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e73",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e74",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e75",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e76",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e77",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e78",
];

const SPEC_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e90";
/** The spec-scoped `to_spec` run that writes a test's revisions, and the `to_tickets` run its versions. */
const SPEC_WRITER = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e91";
const TICKETS_WRITER = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e92";

function runId(index: number): string {
  const id = RUN_IDS[index];
  if (id === undefined) throw new Error(`No run id ${String(index)}`);
  return id;
}

function waypointId(number: number): string {
  const id = WAYPOINT_IDS[number - 1];
  if (id === undefined) throw new Error(`No waypoint id ${String(number)}`);
  return id;
}

/** Waypoint `number`, resolved at `resolvedAt` or not. */
function waypoint(
  number: number,
  resolvedAt: string | null,
): MapActivityInput["waypoints"][number] {
  return {
    id: waypointId(number),
    number,
    kind: "grilling",
    title: "Which columns",
    resolvedAt,
    resolvedHow: resolvedAt === null ? null : "run",
    createdByRun: runId(0),
  };
}

/** Planning run `index` of `RUN_IDS`, started at `startedAt`. */
function planningRun(
  index: number,
  startedAt: string,
  fields: Partial<MapActivityInput["planningRuns"][number]>,
): MapActivityInput["planningRuns"][number] {
  return {
    id: runId(index),
    mapId: MAP_ID,
    waypointId: null,
    specificationId: null,
    purpose: "chart",
    state: "completed",
    retryOfRunId: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    hatchMessageId: null,
    startedAt,
    endedAt: startedAt,
    ...fields,
  };
}

type Run = ActivityRun;

/** Run 1 started at `startedAt`, active, or ended at 59 with `end`'s fields. */
function run(startedAt: string, end: Partial<Run> | null): Run {
  return {
    number: 1,
    baseBranch: "main",
    mergedAt: null,
    startedAt,
    endedAt: end === null ? null : at(59),
    verdict: null,
    failure: null,
    ...end,
  };
}

/** The completed runs that write a test's spec revisions and ticket set versions, no note's. */
const WRITERS = [
  { ...planningRun(0, at(0), { purpose: "to_spec", specificationId: SPEC_ID }), id: SPEC_WRITER },
  {
    ...planningRun(0, at(0), { purpose: "to_tickets", specificationId: SPEC_ID }),
    id: TICKETS_WRITER,
  },
];

/** A charted map: created, and its destination round asked at the same instant. */
function input(overrides: Partial<MapActivityInput>): MapActivityInput {
  return {
    map: { createdAt: at(0), destinationConfirmedAt: null },
    rounds: [{ waypointId: null, number: 1, questions: [], askedAt: at(0), submittedAt: null }],
    waypoints: [],
    blockers: [],
    planningRuns: WRITERS,
    specs: [],
    reports: [],
    taskOutcomes: [],
    exclusions: [],
    passes: [],
    hatchChanges: [],
    waits: [],
    touches: [],
    ...overrides,
  };
}

/** A spec written, approved, its tickets written and approved, at those times. */
function approvedWithSet(
  written: string,
  approved: string,
  tickets: string,
  setApproved: string,
  runs: readonly Run[],
): ActivitySpec {
  return {
    id: SPEC_ID,
    number: 1,
    revisions: [revision("Dark mode", written, { approvedAt: approved })],
    ticketSets: [
      {
        revision: 1,
        follows: false,
        revisionApprovedAt: at(0),
        title: "Dark mode",
        runs,
        versions: [
          {
            tickets: 2,
            dispositions: [],
            writtenAt: tickets,
            writtenByRun: TICKETS_WRITER,
            review: null,
          },
        ],
        approvedAt: setApproved,
        rejections: [],
      },
    ],
  };
}

interface Case {
  readonly line: string;
  readonly input: MapActivityInput;
  /**
   * The lines after the map's first two, as `[stage, at, data]`: tests assert the stage, the time
   * and the stored data a line carries (a reason, a count), never its words; null carries none.
   */
  readonly expected: readonly (readonly [string, string, string | null])[];
}

const cases: readonly Case[] = [
  { line: "Map started; the agent asked about the destination", input: input({}), expected: [] },
  {
    line: "You answered the destination round",
    input: input({
      rounds: [{ waypointId: null, number: 1, questions: [], askedAt: at(0), submittedAt: at(1) }],
    }),
    expected: [["wayfinding", at(1), null]],
  },
  {
    line: "Destination confirmed with n waypoints",
    input: input({
      map: { createdAt: at(0), destinationConfirmedAt: at(2) },
      rounds: [{ waypointId: null, number: 1, questions: [], askedAt: at(0), submittedAt: at(1) }],
      waypoints: [1, 2, 3].map((number) => waypoint(number, null)),
    }),
    expected: [
      ["wayfinding", at(1), null],
      ["wayfinding", at(2), "3"],
    ],
  },
  {
    line: "Spec written; You rejected it: <reason>; revised; approved",
    input: input({
      specs: [
        {
          id: SPEC_ID,
          number: 1,
          revisions: [
            revision("Dark mode", at(2), { rejection: { reason: "Cover JSON too", at: at(3) } }),
            revision("Dark mode", at(4), { first: false, approvedAt: at(5) }),
          ],
          ticketSets: [],
        },
      ],
    }),
    expected: [
      ["spec", at(2), "Dark mode"],
      ["spec", at(3), "Cover JSON too"],
      ["spec", at(4), "Dark mode"],
      ["spec", at(5), "Dark mode"],
    ],
  },
  {
    line: "Tickets written; You rejected them: <reason>; rewritten; approved",
    input: input({
      specs: [
        {
          id: SPEC_ID,
          number: 1,
          revisions: [revision("Dark mode", at(2), { approvedAt: at(3) })],
          ticketSets: [
            {
              revision: 1,
              follows: false,
              revisionApprovedAt: at(0),
              title: "Dark mode",
              runs: [],
              versions: [
                {
                  tickets: 2,
                  dispositions: [],
                  writtenAt: at(6),
                  writtenByRun: TICKETS_WRITER,
                  review: null,
                },
                {
                  tickets: 3,
                  dispositions: [],
                  writtenAt: at(8),
                  writtenByRun: TICKETS_WRITER,
                  review: null,
                },
              ],
              approvedAt: at(9),
              rejections: [{ reason: "Split the toggle.", at: at(7) }],
            },
          ],
        },
      ],
    }),
    expected: [
      ["spec", at(2), "Dark mode"],
      ["spec", at(3), "Dark mode"],
      ["tickets", at(6), "2"],
      ["tickets", at(7), "Split the toggle."],
      ["tickets", at(8), "3"],
      ["tickets", at(9), "Dark mode"],
    ],
  },
  {
    line: "a review passed; a review with findings, repairing; each names its spec",
    input: input({
      specs: [
        {
          id: SPEC_ID,
          number: 1,
          // A repair rewrites the draft in place: one revision, a review per rewrite.
          revisions: [
            revision("Export", at(2), {
              reviews: [
                { outcome: "findings", at: at(3), findings: 2, repairing: true },
                { outcome: "passed", at: at(5) },
              ],
            }),
          ],
          ticketSets: [],
        },
        {
          id: SPEC_ID,
          number: 1,
          revisions: [revision("Import", at(2), { reviews: [{ outcome: "passed", at: at(6) }] })],
          ticketSets: [],
        },
      ],
    }),
    expected: [
      ["spec", at(2), "Export"],
      ["spec", at(2), "Import"],
      ["spec", at(3), "2"],
      ["spec", at(5), "Export"],
      ["spec", at(6), "Import"],
    ],
  },
];

/** The spec's set approved at 5 with these runs: its lines up to then are idea … tickets. */
function delivered(runs: readonly Run[]): MapActivityInput {
  return input({ specs: [approvedWithSet(at(2), at(3), at(4), at(5), runs)] });
}

/** Idea, Wayfinding, then the spec written and approved and its set written and approved. */
const BEFORE_DELIVERY = ["idea", "wayfinding", "spec", "spec", "tickets", "tickets"] as const;

describe("mapActivity delivery lines", () => {
  const FAILURE = { code: "delivery_checks_failed", message: "Failed" } as const;
  test.each([
    { outcome: "passed", end: { verdict: PASSED }, link: 1 },
    { outcome: "blocked", end: { verdict: BLOCKED }, link: null },
    { outcome: "failed", end: { failure: FAILURE }, link: null },
    { outcome: "cancelled", end: {}, link: null },
  ] as const)("a run's start and its $outcome end, the passed one opening the run", (item) => {
    const lines = mapActivity(delivered([run(at(10), item.end)]));
    expect(lines.map((line) => line.stage)).toEqual([...BEFORE_DELIVERY, "delivery", "delivery"]);
    const [started, ended] = lines.slice(-2);
    expect([started?.at, started?.spec, started?.waypoint]).toEqual([at(10), null, null]);
    expect([ended?.at, ended?.spec, ended?.waypoint]).toEqual([at(59), item.link, null]);
    for (const line of [started, ended]) {
      expect(line?.text).toContain("Dark mode");
    }
  });

  test("an active run has only its start line", () => {
    const lines = mapActivity(delivered([run(at(10), null)]));
    expect(lines.map((line) => line.stage)).toEqual([...BEFORE_DELIVERY, "delivery"]);
    expect(lines.at(-1)?.at).toBe(at(10));
  });

  test("a merged run: started, passed, then merged at its merge time, oldest first", () => {
    const lines = mapActivity(
      delivered([run(at(10), { verdict: PASSED, mergedAt: at(70), baseBranch: "trunk" })]),
    );
    const delivery = lines.filter((line) => line.stage === "delivery");
    expect(delivery.map((line) => [line.at, line.spec])).toEqual([
      [at(10), null],
      [at(59), 1],
      [at(70), null],
    ]);
    expect(delivery[2]?.text).toContain("trunk");
  });

  test("a second run is started again from clean and named by its number", () => {
    const lines = mapActivity(
      delivered([
        { ...run(at(30), { verdict: PASSED }), number: 2, endedAt: at(40) },
        run(at(10), {}),
      ]),
    );
    const delivery = lines.filter((line) => line.stage === "delivery");
    expect(delivery.map((line) => [line.at, line.spec])).toEqual([
      [at(10), null],
      [at(30), null],
      [at(40), 1],
      [at(59), null],
    ]);
    // The second run's lines differ from the first's start and end, and name run 2.
    expect(delivery[1]?.text).not.toBe(delivery[0]?.text);
    expect(delivery[2]?.text).toContain("Run 2");
  });

  test("a map's first run of the spec starts delivery though an earlier map ran it before", () => {
    const only = mapActivity(delivered([{ ...run(at(10), {}), number: 2 }]));
    const first = only.find((line) => line.stage === "delivery");
    const fromOne = mapActivity(delivered([run(at(10), {})])).find(
      (line) => line.stage === "delivery",
    );
    // Run 2 of the spec, the first on this map, reads as run 1 does on the map that ran first.
    expect(first?.text).toBe(fromOne?.text);
  });

  test("no run line is written for a spec with no ticket set", () => {
    expect(
      mapActivity(input({}))
        .map((line) => line.stage)
        .includes("delivery"),
    ).toBe(false);
  });
});

describe("mapActivity", () => {
  test.each(cases)("$line", (item) => {
    const activity = mapActivity(item.input);
    expect(ActivityLine.array().parse(activity)).toEqual(activity);
    const expected = [["idea", at(0), null], ["wayfinding", at(0), null], ...item.expected];
    expect(activity).toHaveLength(expected.length);
    expected.forEach(([stage, time, data], index) => {
      const line = activity[index];
      expect(line?.stage).toBe(stage);
      expect(line?.at).toBe(time);
      if (data !== null) {
        expect(line?.text).toContain(data);
      }
    });
  });

  test("findings sent to Wayfinding: one line per waypoint, each opening it", () => {
    const lines = mapActivity(
      input({
        waypoints: [waypoint(1, null), waypoint(2, null)],
        specs: [
          {
            id: SPEC_ID,
            number: 1,
            revisions: [
              revision("Dark mode", at(2), {
                reviews: [{ outcome: "escalated", at: at(3), waypoints: [2] }],
              }),
            ],
            ticketSets: [],
          },
        ],
      }),
    );
    const sent = lines.filter((line) => line.at === at(3));
    expect(sent.map((line) => [line.stage, line.waypoint])).toEqual([["spec", 2]]);
    expect(sent[0]?.text).toContain("Dark mode");
  });

  test("lines from every record come out oldest first, newest last", () => {
    const lines = mapActivity(
      input({
        rounds: [
          { waypointId: null, number: 1, questions: [], askedAt: at(0), submittedAt: at(1) },
        ],
        specs: [
          approvedWithSet(at(2), at(3), at(4), at(5), [
            { ...run(at(20), { verdict: PASSED }), number: 2, endedAt: at(30) },
            run(at(6), {}),
          ]),
        ],
      }),
    );
    const times = lines.map((line) => Date.parse(line.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(lines.map((line) => line.stage)).toEqual([
      "idea",
      "wayfinding",
      "wayfinding",
      "spec",
      "spec",
      "tickets",
      "tickets",
      "delivery",
      "delivery",
      "delivery",
      "delivery",
    ]);
  });

  test("no line names a skill, a criterion id or a revision number", () => {
    const lines = mapActivity(
      input({
        rounds: [
          { waypointId: null, number: 1, questions: [], askedAt: at(0), submittedAt: at(1) },
        ],
        specs: [
          {
            ...approvedWithSet(at(4), at(5), at(6), at(7), [
              run(at(8), { verdict: BLOCKED, mergedAt: null }),
            ]),
            revisions: [
              revision("Dark mode", at(2), {
                rejection: { reason: "Again", at: at(3) },
                reviews: [{ outcome: "findings", at: at(2), findings: 2, repairing: true }],
              }),
              revision("Dark mode", at(4), {
                first: false,
                approvedAt: at(5),
                reviews: [{ outcome: "passed", at: at(4) }],
              }),
            ],
          },
        ],
      }),
    );
    for (const { text } of lines) {
      expect(text).not.toMatch(
        /skill|implement-spec|code-review|\bS\d+-\d+\b|\b[rvCT]\d+\b|\d+\.\d+|revision \d|version \d/i,
      );
    }
  });
});

describe("mapActivity numbers every destination round", () => {
  test("three map-level rounds, two submitted: each asked and answered line by number, in time order", () => {
    const destinationRound = (number: number, asked: number, submitted: number | null) => ({
      waypointId: null,
      number,
      questions: [],
      askedAt: at(asked),
      submittedAt: submitted === null ? null : at(submitted),
    });
    const lines = mapActivity(
      input({
        rounds: [
          destinationRound(1, 0, 1),
          destinationRound(2, 2, 3),
          destinationRound(3, 4, null),
        ],
      }),
    );
    expect(
      lines.filter((line) => line.stage === "wayfinding").map((line) => [line.text, line.at]),
    ).toEqual([
      ["The agent asked destination round 1.", at(0)],
      ["You answered destination round 1.", at(1)],
      ["The agent asked destination round 2.", at(2)],
      ["You answered destination round 2.", at(3)],
      ["The agent asked destination round 3.", at(4)],
    ]);
  });
});

describe("mapActivity Wayfinding lines", () => {
  /** Each line as `[stage, waypoint, at]`: tests assert the stage and what a line opens, not its words. */
  function shape(lines: readonly ActivityLine[]) {
    return lines.map((line) => [line.stage, line.waypoint, line.at]);
  }

  const timedOut = { errorCode: "agent_timed_out", errorMessage: "Timed out" } as const;

  test("one line per transition from charting to clearing, waypoint lines opening their waypoint", () => {
    const wp = waypointId(1);
    const activity = mapActivity(
      input({
        map: { createdAt: at(0), destinationConfirmedAt: at(4) },
        rounds: [
          { waypointId: null, number: 1, questions: [], askedAt: at(1), submittedAt: at(2) },
          { waypointId: wp, number: 1, questions: [], askedAt: at(5), submittedAt: at(6) },
        ],
        waypoints: [waypoint(1, at(7))],
        planningRuns: [
          planningRun(0, at(0), { state: "asked", endedAt: at(1) }),
          planningRun(1, at(2), { state: "failed", endedAt: at(3), ...timedOut }),
          planningRun(2, at(3), { retryOfRunId: runId(1), endedAt: at(4) }),
          planningRun(3, at(4), {
            purpose: "grilling",
            waypointId: wp,
            state: "asked",
            endedAt: at(5),
          }),
          planningRun(4, at(6), { purpose: "grilling", waypointId: wp, endedAt: at(7) }),
          planningRun(5, at(7), { purpose: "to_spec", state: "running", endedAt: null }),
        ],
      }),
    );
    expect(ActivityLine.array().parse(activity)).toEqual(activity);
    expect(shape(activity)).toEqual([
      ["idea", null, at(0)], // map started
      ["idea", null, at(0)], // being charted
      ["wayfinding", null, at(1)], // destination asked
      ["wayfinding", null, at(2)], // destination answered
      ["wayfinding", null, at(3)], // the confirming chart failed and is retried
      ["wayfinding", null, at(4)], // destination confirmed with one waypoint
      ["wayfinding", 1, at(5)], // questions written for waypoint 1
      ["wayfinding", null, at(6)], // answered on waypoint 1
      ["wayfinding", 1, at(7)], // waypoint 1 resolved
      ["spec", null, at(7)], // map cleared, spec being written (on Spec)
    ]);
  });

  test("one line per Research, Task, map-change and pass transition", () => {
    const id = (n: number) => `0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5f${String(n).padStart(2, "0")}`;
    const run = (n: number) => id(n);
    const wp = (n: number) => id(50 + n);
    const on = (
      n: number,
      waypoint: number | null,
      purpose: MapActivityInput["planningRuns"][number]["purpose"],
      start: number,
      end: number,
      state: MapActivityInput["planningRuns"][number]["state"] = "completed",
    ) => ({
      ...planningRun(0, at(start), { purpose, state, endedAt: at(end) }),
      id: run(n),
      waypointId: waypoint === null ? null : wp(waypoint),
    });
    const point = (
      n: number,
      kind: "grilling" | "research" | "task",
      resolvedAt: string | null,
      createdBy: number,
    ) => ({
      id: wp(n),
      number: n,
      kind,
      title: `Waypoint ${String(n)}`,
      resolvedAt,
      resolvedHow: resolvedAt === null ? null : ("run" as const),
      createdByRun: run(createdBy),
    });
    const activity = mapActivity(
      input({
        map: { createdAt: at(0), destinationConfirmedAt: at(1) },
        rounds: [
          { waypointId: wp(2), number: 1, questions: [], askedAt: at(7), submittedAt: at(8) },
        ],
        waypoints: [
          point(1, "research", at(5), 0),
          point(2, "task", at(11), 0),
          point(3, "grilling", at(13), 0),
          point(4, "grilling", null, 6),
          point(5, "grilling", null, 8),
        ],
        planningRuns: [
          on(0, null, "chart", 0, 1),
          on(1, 1, "research", 2, 3),
          on(2, 1, "research", 4, 5),
          on(3, 2, "task", 6, 7, "asked"),
          on(4, 2, "task", 8, 9),
          on(5, 2, "task", 10, 11),
          on(6, 3, "grilling", 12, 13),
          on(7, 4, "grilling", 14, 15),
          on(8, null, "consistency", 16, 17),
          on(9, null, "consistency", 18, 19),
        ],
        reports: [
          { runId: run(1), answered: false },
          { runId: run(2), answered: true },
        ],
        taskOutcomes: [
          { runId: run(4), outcome: "failed" },
          { runId: run(5), outcome: "done" },
        ],
        exclusions: [
          { waypointId: null, createdByRun: run(0) },
          { waypointId: null, createdByRun: run(6) },
          { waypointId: wp(4), createdByRun: run(7) },
        ],
        passes: [
          { runId: run(8), findingCount: 1 },
          { runId: run(9), findingCount: 0 },
        ],
      }),
    );
    expect(ActivityLine.array().parse(activity)).toEqual(activity);
    expect(shape(activity)).toEqual([
      ["idea", null, at(0)], // map started
      ["idea", null, at(0)], // being charted
      ["wayfinding", null, at(1)], // destination confirmed
      ["wayfinding", null, at(2)], // research started
      ["wayfinding", 1, at(3)], // research could not answer
      ["wayfinding", null, at(4)], // research started again (Try again)
      ["wayfinding", 1, at(5)], // research finished
      ["wayfinding", null, at(6)], // task started
      ["wayfinding", 2, at(7)], // task asked you
      ["wayfinding", null, at(8)], // you answered
      ["wayfinding", 2, at(9)], // task failed (the run after your answers is no new start)
      ["wayfinding", null, at(10)], // task started again (Try again)
      ["wayfinding", 2, at(11)], // task done
      ["wayfinding", 3, at(13)], // waypoint 3 resolved
      ["wayfinding", null, at(13)], // a fog item moved out of scope (the chart's line has none)
      ["wayfinding", 3, at(13)], // one new waypoint charted by waypoint 3
      ["wayfinding", 4, at(15)], // waypoint 4 ruled out of scope
      ["wayfinding", null, at(17)], // the pass opened one conflict
      ["wayfinding", null, at(19)], // the pass found the resolutions agree
    ]);
    // Only the two repeated starts share their text.
    expect(new Set(activity.map((line) => line.text)).size).toBe(activity.length - 2);
  });

  test("a scope stopped after its retry has its own line, with its code", () => {
    const activity = mapActivity(
      input({
        rounds: [],
        planningRuns: [
          planningRun(0, at(0), { state: "failed", endedAt: at(1), ...timedOut }),
          planningRun(1, at(1), {
            state: "failed",
            retryOfRunId: runId(0),
            endedAt: at(2),
            ...timedOut,
          }),
        ],
      }),
    );
    expect(shape(activity)).toEqual([
      ["idea", null, at(0)],
      ["idea", null, at(0)],
      ["idea", null, at(1)],
      ["idea", null, at(2)],
    ]);
    // The code stays off the line; the stop and the retry read differently.
    expect(activity.at(-1)?.text).not.toContain("agent_timed_out");
    expect(activity.at(-1)?.text).not.toBe(activity.at(-2)?.text);
  });
  test("a count of one agrees in number: a task's one question and a pass's one conflict", () => {
    const question = (n: number): Question => ({
      topic: `Topic ${String(n)}`,
      text: "Which?",
      options: [],
    });
    /** The task-asked line and the pass line for `count`, with the count itself blanked out. */
    const counted = (count: number) => {
      const numbers = Array.from({ length: count }, (_, index) => index + 1);
      const activity = mapActivity(
        input({
          map: { createdAt: at(0), destinationConfirmedAt: at(1) },
          rounds: [
            {
              waypointId: waypointId(1),
              number: 1,
              questions: numbers.map(question),
              askedAt: at(3),
              submittedAt: null,
            },
          ],
          waypoints: [{ ...waypoint(1, null), kind: "task" as const, createdByRun: runId(0) }],
          planningRuns: [
            { ...planningRun(0, at(0), { purpose: "chart", endedAt: at(1) }) },
            {
              ...planningRun(1, at(2), { purpose: "task", state: "asked", endedAt: at(3) }),
              waypointId: waypointId(1),
            },
            { ...planningRun(2, at(4), { purpose: "consistency", endedAt: at(5) }) },
          ],
          passes: [{ runId: runId(2), findingCount: count }],
        }),
      );
      return [at(3), at(5)].map((when) => {
        const line = activity.find((candidate) => candidate.at === when);
        if (line === undefined) throw new Error(`No line at ${when}`);
        return line.text.replace(String(count), "#");
      });
    };
    const [taskOne, passOne] = counted(1);
    const [taskTwo, passTwo] = counted(2);
    // The one-count lines read differently from the two-count lines beyond the count itself.
    expect(taskOne).not.toBe(taskTwo);
    expect(passOne).not.toBe(passTwo);
    // The pass line's place for the opened waypoints agrees in number too ("as a waypoint").
    expect(passOne?.split(" ").length).not.toBe(passTwo?.split(" ").length);
  });

  /** A grilling run on waypoint `number`, completed at `end` unless given a state. */
  const grilled = (index: number, number: number, start: number, end: number) =>
    planningRun(index, at(start), {
      purpose: "grilling",
      waypointId: waypointId(number),
      endedAt: at(end),
    });
  const mapScopeSpec = (
    index: number,
    start: number,
    fields: Partial<MapActivityInput["planningRuns"][number]> = {},
  ) => planningRun(index, at(start), { purpose: "to_spec", endedAt: at(start + 1), ...fields });

  test("every resolution a waypoint had keeps its line after a reopen, from its runs", () => {
    // Waypoint 1 resolved at 3, reopened (now open, no resolution), re-asked and resolved at 9
    // by a run whose result is current; a run that ruled waypoint 2 out of scope has no line.
    const activity = mapActivity(
      input({
        map: { createdAt: at(0), destinationConfirmedAt: at(1) },
        rounds: [],
        waypoints: [waypoint(1, null), { ...waypoint(2, null), title: "Which rows" }],
        planningRuns: [
          planningRun(0, at(0), { endedAt: at(1) }),
          grilled(1, 1, 2, 3),
          grilled(2, 1, 5, 6),
          grilled(3, 2, 7, 8),
        ],
        exclusions: [{ waypointId: waypointId(2), createdByRun: runId(3) }],
      }),
    );
    const resolved = activity.filter((line) => line.waypoint === 1);
    expect(resolved.map((line) => line.at)).toEqual([at(3), at(6)]);
    // Waypoint 2's one line is its ruling's, not a resolution's.
    expect(activity.filter((line) => line.waypoint === 2).map((line) => line.at)).toEqual([at(8)]);
  });

  test("a stored plain-choice resolution keeps its line from resolved_at", () => {
    const activity = mapActivity(
      input({
        rounds: [],
        waypoints: [{ ...waypoint(1, at(4)), resolvedHow: "plain_choice" }],
        planningRuns: [planningRun(0, at(0), { endedAt: at(1) })],
      }),
    );
    expect(activity.filter((line) => line.waypoint === 1).map((line) => line.at)).toEqual([at(4)]);
  });

  test("every clear and re-clear has a Map cleared line, a retry or Try again none", () => {
    const activity = mapActivity(
      input({
        map: { createdAt: at(0), destinationConfirmedAt: at(1) },
        rounds: [],
        waypoints: [waypoint(1, null), waypoint(2, null)],
        planningRuns: [
          planningRun(0, at(0), { endedAt: at(1) }),
          grilled(1, 1, 2, 3),
          grilled(2, 2, 3, 4),
          // The first clear, retried, stopped, and Try again.
          mapScopeSpec(3, 5, { state: "failed", ...timedOut }),
          mapScopeSpec(4, 6, { state: "failed", retryOfRunId: runId(3), ...timedOut }),
          mapScopeSpec(5, 8),
          // Waypoint 1 reopened and resolved again: the re-clear.
          grilled(6, 1, 10, 11),
          mapScopeSpec(7, 12),
        ],
      }),
    );
    // On Spec.
    const cleared = activity.filter((line) => line.text.startsWith("Map cleared"));
    expect(cleared.map((line) => line.stage)).toEqual(["spec", "spec"]);
    // The first clear and the re-clear; the retry and the Try again add none.
    expect(cleared.map((line) => line.at)).toEqual([at(5), at(12)]);
    expect(cleared[0]?.text).toContain("2");
    expect(cleared.at(-1)?.text).toBe(cleared[0]?.text);
  });
});

describe("Map cleared counts the decisions as of that clear", () => {
  const plain = (number: number, resolvedAt: string | null) => ({
    ...waypoint(number, resolvedAt),
    resolvedHow: resolvedAt === null ? null : ("plain_choice" as const),
  });
  const chart = planningRun(0, at(0), { endedAt: at(1) });
  const clear = planningRun(1, at(5), { purpose: "to_spec", endedAt: at(6) });
  const clearedLine = (overrides: Partial<MapActivityInput>) =>
    mapActivity(input({ map: { createdAt: at(0), destinationConfirmedAt: at(1) }, ...overrides }))
      .filter((line) => line.text.startsWith("Map cleared"))
      .map((line) => [line.text, line.at]);

  test("a later reopen of a plain-choice waypoint, a waypoint opened later and a later ruling change nothing", () => {
    const asCleared = clearedLine({
      waypoints: [plain(1, at(2)), plain(2, at(3))],
      planningRuns: [chart, clear],
    });
    // After the clear: waypoint 1 reopened (its plain-choice resolution cleared), waypoint 3
    // opened by a hatch run, then ruled out of scope by another.
    const opener = planningRun(2, at(8), { purpose: "hatch", endedAt: at(9) });
    const ruler = planningRun(3, at(10), { purpose: "hatch", endedAt: at(11) });
    const later = clearedLine({
      waypoints: [plain(1, null), plain(2, at(3)), { ...plain(3, null), createdByRun: opener.id }],
      planningRuns: [chart, clear, opener, ruler],
      exclusions: [{ waypointId: waypointId(3), createdByRun: ruler.id }],
    });

    expect(asCleared).toHaveLength(1);
    expect(later).toEqual(asCleared);
  });

  test("a waypoint ruled out of scope before the clear is no decision of it", () => {
    const ruling = planningRun(2, at(3), {
      purpose: "grilling",
      waypointId: waypointId(3),
      endedAt: at(4),
    });
    const withRuling = clearedLine({
      waypoints: [plain(1, at(2)), plain(2, at(3)), plain(3, null)],
      planningRuns: [chart, ruling, clear],
      exclusions: [{ waypointId: waypointId(3), createdByRun: ruling.id }],
    });
    const twoDecisions = clearedLine({
      waypoints: [plain(1, at(2)), plain(2, at(3))],
      planningRuns: [chart, clear],
    });

    expect(withRuling).toEqual(twoDecisions);
  });
});

describe("mapActivity hatch lines", () => {
  const HATCH_RUN = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e93";
  const NOTE_MESSAGE = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e94";
  const hatchRun = { ...planningRun(0, at(9), { purpose: "hatch" }), id: HATCH_RUN };
  const NO_FOG = {
    newWaypoints: [],
    fogOutOfScope: [],
    fogDecided: [],
    fogSettledHere: [],
    newFog: [],
  };

  /** Each line after the map's first two as `[stage, waypoint, at]`: never its words. */
  function shape(lines: readonly ActivityLine[]) {
    return lines.slice(2).map((line) => [line.stage, line.waypoint, line.at]);
  }

  const changes: readonly [string, HatchChange][] = [
    ["reopen", { kind: "reopen", waypoint: 2 }],
    ["reword", { kind: "reword", waypoint: 2, title: "Which rows", question: "Which rows?" }],
    [
      "rule_out_of_scope",
      { kind: "rule_out_of_scope", waypoint: 2, reason: "Not this map.", fog: NO_FOG },
    ],
    ["run_waypoint", { kind: "run_waypoint", waypoint: 2 }],
    ["accept_report", { kind: "accept_report", waypoint: 2, gist: "CSV only.", fog: NO_FOG }],
  ];

  test.each(changes)("an applied %s has one Wayfinding line opening its waypoint", (_, change) => {
    const lines = mapActivity(
      input({
        waypoints: [waypoint(1, null), waypoint(2, null)],
        planningRuns: [...WRITERS, hatchRun],
        hatchChanges: [{ change, runId: HATCH_RUN, appliedAt: at(10) }],
      }),
    );
    expect(ActivityLine.array().parse(lines)).toEqual(lines);
    expect(shape(lines)).toEqual([["wayfinding", 2, at(10)]]);
  });

  test("an applied open_waypoint opens the first waypoint its run charted", () => {
    const lines = mapActivity(
      input({
        waypoints: [
          waypoint(1, null),
          { ...waypoint(3, null), createdByRun: HATCH_RUN },
          { ...waypoint(2, null), createdByRun: HATCH_RUN },
        ],
        planningRuns: [...WRITERS, hatchRun],
        hatchChanges: [
          {
            change: {
              kind: "open_waypoint",
              waypointKind: "research",
              title: "Which formats",
              question: "Which formats?",
              blockedBy: [1],
              fog: NO_FOG,
            },
            runId: HATCH_RUN,
            appliedAt: at(10),
          },
        ],
      }),
    );
    expect(shape(lines)).toEqual([["wayfinding", 2, at(10)]]);
  });

  test("a waypoint the hatch ruled out of scope has the note's line only", () => {
    const lines = mapActivity(
      input({
        waypoints: [waypoint(1, null), waypoint(2, null)],
        planningRuns: [...WRITERS, { ...hatchRun, endedAt: at(10) }],
        exclusions: [{ waypointId: waypointId(2), createdByRun: HATCH_RUN }],
        hatchChanges: [
          {
            change: { kind: "rule_out_of_scope", waypoint: 2, reason: "Not now.", fog: NO_FOG },
            runId: HATCH_RUN,
            appliedAt: at(10),
          },
        ],
      }),
    );
    expect(shape(lines)).toEqual([["wayfinding", 2, at(10)]]);
  });

  test("a revision and a ticket set version a note's runs wrote are told apart, review after", () => {
    const noteSpecRun = {
      ...planningRun(0, at(3), { purpose: "to_spec", specificationId: SPEC_ID }),
      id: runId(4),
      hatchMessageId: NOTE_MESSAGE,
    };
    const noteTicketsRun = {
      ...planningRun(0, at(7), { purpose: "to_tickets", specificationId: SPEC_ID }),
      id: runId(5),
      hatchMessageId: NOTE_MESSAGE,
    };
    const spec = (byNote: boolean): MapActivityInput =>
      input({
        planningRuns: [...WRITERS, noteSpecRun, noteTicketsRun],
        specs: [
          {
            id: SPEC_ID,
            number: 1,
            revisions: [
              revision("Dark mode", at(2), {}),
              revision("Dark mode", at(4), {
                first: false,
                writtenByRun: byNote ? noteSpecRun.id : SPEC_WRITER,
                reviews: [{ outcome: "passed", at: at(5) }],
                approvedAt: at(6),
              }),
            ],
            ticketSets: [
              {
                revision: 1,
                follows: false,
                revisionApprovedAt: at(0),
                title: "Dark mode",
                runs: [],
                versions: [
                  {
                    tickets: 2,
                    dispositions: [],
                    writtenAt: at(7),
                    writtenByRun: TICKETS_WRITER,
                    review: null,
                  },
                  {
                    tickets: 3,
                    dispositions: [],
                    writtenAt: at(8),
                    writtenByRun: byNote ? noteTicketsRun.id : TICKETS_WRITER,
                    review: null,
                  },
                ],
                approvedAt: null,
                rejections: [],
              },
            ],
          },
        ],
      });
    const byNote = mapActivity(spec(true));
    const plain = mapActivity(spec(false));
    const expected = [
      ["spec", null, at(2)],
      ["spec", null, at(4)], // revised (from the note)
      ["spec", null, at(5)], // its review passed
      ["spec", null, at(6)],
      ["tickets", null, at(7)],
      ["tickets", null, at(8)], // rewritten (from the note)
    ];
    expect(shape(byNote)).toEqual(expected);
    expect(shape(plain)).toEqual(expected);
    const differing = byNote.filter((line, index) => line.text !== plain[index]?.text);
    expect(differing.map((line) => [line.stage, line.at])).toEqual([
      ["spec", at(4)],
      ["tickets", at(8)],
    ]);
    // Only the note's revision line opens the spec ("Open the revision").
    expect(byNote.slice(2).map((line) => line.spec)).toEqual([null, 1, null, null, null, null]);
    expect(plain.slice(2).map((line) => line.spec)).toEqual([null, null, null, null, null, null]);
  });

  test("a completed re-clear that wrote no revision has its Spec line; one that wrote has none", () => {
    const reclear = (wrote: boolean): MapActivityInput => {
      const run = planningRun(4, at(5), { purpose: "to_spec", endedAt: at(6) });
      return input({
        planningRuns: [...WRITERS, planningRun(3, at(1), { purpose: "to_spec" }), run],
        specs: [
          {
            id: SPEC_ID,
            number: 1,
            revisions: [
              revision("Dark mode", at(1), { writtenByRun: runId(3), approvedAt: at(2) }),
              ...(wrote
                ? [revision("Dark mode", at(6), { first: false, writtenByRun: runId(4) })]
                : []),
            ],
            ticketSets: [],
          },
        ],
      });
    };
    const unchanged = shape(mapActivity(reclear(false)));
    expect(unchanged.filter(([, , time]) => time === at(6))).toEqual([["spec", null, at(6)]]);
    const revised = mapActivity(reclear(true)).filter((line) => line.at === at(6));
    expect(revised).toHaveLength(1);
    expect(revised[0]?.text).toContain("Dark mode");
  });

  test("no hatch line without an applied change (a reply only, a refusal)", () => {
    const lines = mapActivity(
      input({
        waypoints: [waypoint(1, null)],
        planningRuns: [...WRITERS, { ...hatchRun, endedAt: at(10) }],
      }),
    );
    expect(shape(lines)).toEqual([]);
  });
});

describe("map.overview hatch lines from stored messages", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await openTestContext("zenorm-activity-");
  });

  afterEach(async () => {
    await closeTestContext(context);
  });

  /** Stores `change` on a replied message, as the hatch run's transaction does. */
  function applied(messageId: string, change: HatchChange): void {
    writeTestData(context, (tx) =>
      tx.update(hatchMessages).set({ change }).where(eq(hatchMessages.id, messageId)).run(),
    );
  }

  test("an applied change has its line; a reply only and a refusal have none", async () => {
    const project = await addProject(context, "repo");
    const mapId = await chartedMap(context, project);
    const message = { stage: "wayfinding", specificationId: null, text: "Note" } as const;
    insertMessage(context, mapId, { ...message, state: "replied" });
    insertMessage(context, mapId, { ...message, state: { refused: "waypoint_state" } });
    const before = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!before.ok) throw new Error(before.error.code);

    const reopened = insertMessage(context, mapId, { ...message, state: "replied" });
    applied(reopened, { kind: "reopen", waypoint: 2 });
    const after = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!after.ok) throw new Error(after.error.code);

    const repliedAt = after.value.messages.at(-1)?.status;
    if (repliedAt?.state !== "replied") throw new Error("The message is not replied");
    const added = after.value.activity.filter(
      (line) => !before.value.activity.some((old) => old.text === line.text && old.at === line.at),
    );
    expect(added.map(({ stage, waypoint, at }) => ({ stage, waypoint, at }))).toEqual([
      { stage: "wayfinding", waypoint: 2, at: repliedAt.repliedAt },
    ]);
  });
});

describe("mapActivity tickets review lines", () => {
  /** Spec 1's lines on Tickets that open its tickets: stage and spec number, by time. */
  function opening(activity: readonly ActivityLine[]) {
    return activity
      .filter((line) => line.spec !== null)
      .map(({ stage, spec, waypoint, at: time }) => ({ stage, spec, waypoint, at: time }));
  }

  test("each review's line opens the spec's tickets; the versions' written lines stay", () => {
    const activity = mapActivity(
      input({
        specs: [
          {
            id: SPEC_ID,
            number: 4,
            revisions: [revision("Dark mode", at(2), { approvedAt: at(3) })],
            ticketSets: [
              {
                revision: 1,
                follows: false,
                revisionApprovedAt: at(0),
                title: "Dark mode",
                runs: [],
                versions: [
                  {
                    tickets: 2,
                    dispositions: [],
                    writtenAt: at(6),
                    writtenByRun: TICKETS_WRITER,
                    review: { outcome: "findings", at: at(7), findings: 2, held: false },
                  },
                  {
                    tickets: 2,
                    dispositions: [],
                    writtenAt: at(8),
                    writtenByRun: TICKETS_WRITER,
                    review: { outcome: "findings", at: at(9), findings: 1, held: true },
                  },
                  {
                    tickets: 3,
                    dispositions: [],
                    writtenAt: at(10),
                    writtenByRun: TICKETS_WRITER,
                    review: { outcome: "passed", at: at(11) },
                  },
                  {
                    tickets: 3,
                    dispositions: [],
                    writtenAt: at(12),
                    writtenByRun: TICKETS_WRITER,
                    review: null,
                  },
                ],
                approvedAt: null,
                rejections: [],
              },
            ],
          },
        ],
      }),
    );
    expect(ActivityLine.array().parse(activity)).toEqual(activity);
    const opens = { stage: "tickets", spec: 4, waypoint: null } as const;
    expect(opening(activity)).toEqual([
      { ...opens, at: at(7) },
      { ...opens, at: at(9) },
      { ...opens, at: at(11) },
    ]);
    // Every version keeps its written line, which opens nothing.
    for (const written of [at(6), at(8), at(10), at(12)]) {
      expect(
        activity.filter(
          (line) => line.stage === "tickets" && line.at === written && line.spec === null,
        ),
      ).toHaveLength(1);
    }
    // The three outcomes read three different lines.
    expect(
      new Set(activity.filter((line) => line.spec !== null).map((line) => line.text)).size,
    ).toBe(3);
  });
});

describe("map.overview tickets review lines from recorded reviews", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await openTestContext("zenorm-activity-");
  });

  afterEach(async () => {
    await closeTestContext(context);
  });

  async function overview(mapId: string) {
    const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  /** The lines opening the map's spec's tickets, and the current version's review time. */
  async function reviewLines(mapId: string) {
    const shown = await overview(mapId);
    const spec = shown.specs[0];
    if (spec === undefined) throw new Error(`Map ${mapId} has no spec`);
    const review = spec.ticketSets[0]?.review;
    if (review?.state !== "passed" && review?.state !== "findings") {
      throw new Error("The current version has no recorded review");
    }
    return {
      number: spec.number,
      reviewedAt: review.reviewedAt,
      lines: shown.activity.filter((line) => line.spec !== null),
    };
  }

  test("a passed review: one line opening the spec's Tickets page", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await reviewedTicketSet(context, project);
    const { number, reviewedAt, lines } = await reviewLines(mapId);
    expect(lines.map(({ stage, spec, at: time }) => ({ stage, spec, at: time }))).toEqual([
      { stage: "tickets", spec: number, at: reviewedAt },
    ]);
  });

  test("a failed review that starts a repair: one line opening the tickets", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    const { number, reviewedAt, lines } = await reviewLines(mapId);
    expect(lines.map(({ stage, spec, at: time }) => ({ stage, spec, at: time }))).toEqual([
      { stage: "tickets", spec: number, at: reviewedAt },
    ]);
  });

  test("a held set: each of its three reviews has a line, the escalating one last", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await heldTicketSet(context, project);
    const { number, reviewedAt, lines } = await reviewLines(mapId);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.stage === "tickets" && line.spec === number)).toBe(true);
    expect(lines.at(-1)?.at).toBe(reviewedAt);
    // Two repairs' lines read alike; the hold's differs.
    expect(lines[0]?.text).toBe(lines[1]?.text);
    expect(lines[2]?.text).not.toBe(lines[1]?.text);
  });

  test("a rewrite keeps its written line, which opens nothing", async () => {
    const project = await addProject(context, "repo");
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: "Split T2" }).ok).toBe(
      true,
    );
    const before = (await overview(mapId)).activity.length;
    recordRunningTicketSet(context, mapId);
    const added = (await overview(mapId)).activity.slice(before);
    expect(added.filter((line) => line.stage === "tickets" && line.spec === null)).toHaveLength(1);
  });
});

/** A revision's set (`follows` an approved one or not), approved at `approvedAt` (or not), its one version of `tickets`. */
function setOf(
  follows: boolean,
  revisionApprovedAt: string,
  tickets: number,
  writtenAt: string,
  approvedAt: string | null,
): ActivityTicketSet {
  return {
    title: "Dark mode",
    revision: 1,
    follows,
    revisionApprovedAt,
    versions: [
      { tickets, dispositions: [], writtenAt, writtenByRun: TICKETS_WRITER, review: null },
    ],
    approvedAt,
    rejections: [],
    runs: [],
  };
}

describe("mapActivity lines for revisions and waits", () => {
  const confirmed = {
    map: { createdAt: at(0), destinationConfirmedAt: at(2) },
    rounds: [{ waypointId: null, number: 1, questions: [], askedAt: at(0), submittedAt: at(1) }],
    waypoints: [1, 2].map((number) => waypoint(number, null)),
  };
  const chartLine = (activity: readonly ActivityLine[]) =>
    activity.find((line) => line.stage === "wayfinding" && line.at === at(2));

  test("the chart line names a delivered spec a waypoint touches, opening nothing", () => {
    const plain = chartLine(mapActivity(input(confirmed)));
    const undelivered = chartLine(
      mapActivity(
        input({ ...confirmed, touches: [{ waypoint: 1, specTitle: "Export", delivered: false }] }),
      ),
    );
    const touched = chartLine(
      mapActivity(
        input({
          ...confirmed,
          touches: [
            { waypoint: 1, specTitle: "Export", delivered: true },
            { waypoint: 2, specTitle: "Import", delivered: false },
          ],
        }),
      ),
    );
    expect(undelivered?.text).toBe(plain?.text);
    expect(touched?.text).not.toBe(plain?.text);
    expect(touched).toMatchObject({ stage: "wayfinding", spec: null, specLabel: null });
  });

  test("a wait's line at since by its stored hold, and its release line at released_at", () => {
    const lines = mapActivity(
      input({
        waits: [
          {
            specNumber: 2,
            specTitle: "Export",
            since: at(3),
            holdKind: "tickets",
            holdMapTitle: "Holder",
            releasedAt: at(5),
          },
        ],
      }),
    ).slice(2);
    expect(lines).toEqual([
      {
        stage: "spec",
        text: WAIT_LINES.tickets("Export", "Holder"),
        waypoint: null,
        spec: 2,
        specLabel: "See what waits",
        at: at(3),
      },
      expect.objectContaining({
        stage: "spec",
        spec: 2,
        specLabel: "Open the revision",
        at: at(5),
      }),
    ]);
  });

  test("past r1, the first to_tickets checks the revision against what was delivered", () => {
    const tickets = (index: number, startedAt: string, retryOf: string | null) =>
      planningRun(index, startedAt, {
        purpose: "to_tickets",
        specificationId: SPEC_ID,
        retryOfRunId: retryOf,
      });
    const lines = mapActivity(
      input({
        planningRuns: [...WRITERS, tickets(0, at(4), null), tickets(1, at(5), runId(0))],
        specs: [
          {
            id: SPEC_ID,
            number: 1,
            revisions: [revision("Dark mode", at(2), { first: false, approvedAt: at(3) })],
            ticketSets: [setOf(true, at(3), 2, at(6), null)],
          },
        ],
      }),
    ).slice(2);
    expect(lines.map((line) => [line.stage, line.at, line.spec])).toEqual([
      ["spec", at(2), null],
      ["spec", at(3), null],
      ["tickets", at(4), null],
      ["tickets", at(6), null],
    ]);
  });

  test("a first revision's tickets have no checking line", () => {
    const lines = mapActivity(
      input({
        specs: [
          {
            id: SPEC_ID,
            number: 1,
            revisions: [revision("Dark mode", at(2), { approvedAt: at(3) })],
            ticketSets: [setOf(false, at(3), 2, at(6), null)],
          },
        ],
      }),
    ).slice(2);
    expect(lines.map((line) => [line.stage, line.at])).toEqual([
      ["spec", at(2)],
      ["spec", at(3)],
      ["tickets", at(6)],
    ]);
  });

  test("past r1, the tickets line compares the revision with what was delivered", () => {
    const written = (
      follows: boolean,
      tickets: number,
      dispositions: ActivityTicketSet["versions"][number]["dispositions"],
    ) => {
      const set = setOf(follows, at(3), tickets, at(6), null);
      const versions = set.versions.map((version) => ({ ...version, dispositions }));
      return mapActivity(
        input({
          planningRuns: [
            ...WRITERS,
            planningRun(0, at(4), {
              purpose: "to_tickets",
              specificationId: SPEC_ID,
              retryOfRunId: null,
            }),
          ],
          specs: [
            {
              id: SPEC_ID,
              number: 1,
              revisions: [revision("Dark mode", at(2), { first: false, approvedAt: at(3) })],
              ticketSets: [{ ...set, revision: 2, versions }],
            },
          ],
        }),
      ).find((line) => line.at === at(6))?.text;
    };
    const first = written(false, 2, ["work", "work", "delivered"]);
    const compared = written(true, 2, ["work", "work", "delivered"]);
    expect(compared).not.toBe(first);
    // The tally, the new tickets and the carried work each change the line.
    expect(written(true, 2, ["work", "work", "satisfied"])).not.toBe(compared);
    expect(written(true, 0, ["delivered", "satisfied"])).not.toBe(
      written(true, 1, ["delivered", "satisfied"]),
    );
    expect(written(true, 0, ["satisfied"])).not.toBe(written(true, 0, ["retained"]));
    expect(written(true, 0, ["removed"])).not.toBe(written(false, 0, ["removed"]));
  });

  test("a confirmed set with no tickets has its own approval line; each approved revision keeps its set's lines", () => {
    const approvalOf = (tickets: number) =>
      mapActivity(
        input({
          specs: [
            {
              id: SPEC_ID,
              number: 1,
              revisions: [revision("Dark mode", at(2), { approvedAt: at(3) })],
              ticketSets: [setOf(false, at(3), tickets, at(6), at(7))],
            },
          ],
        }),
      ).find((line) => line.at === at(7));
    const nothing = approvalOf(0);
    expect(nothing).toMatchObject({ stage: "tickets", spec: null, specLabel: null });
    expect(nothing?.text).not.toBe(approvalOf(2)?.text);

    const two = mapActivity(
      input({
        specs: [
          {
            id: SPEC_ID,
            number: 1,
            revisions: [revision("Dark mode", at(2), { approvedAt: at(3) })],
            ticketSets: [setOf(false, at(3), 2, at(4), at(5)), setOf(false, at(3), 1, at(8), null)],
          },
        ],
      }),
    );
    expect(two.filter((line) => line.stage === "tickets").map((line) => line.at)).toEqual([
      at(4),
      at(5),
      at(8),
    ]);
  });

  test("a later map's revisions of a delivered spec give one Spec revised line, the first", () => {
    const lines = mapActivity(
      input({
        specs: [
          {
            id: SPEC_ID,
            number: 3,
            revisions: [
              revision("Dark mode", at(2), { first: false, laterMapOfDelivered: true }),
              revision("Dark mode", at(4), { first: false, laterMapOfDelivered: true }),
            ],
            ticketSets: [],
          },
        ],
      }),
    ).slice(2);
    expect(lines.map((line) => [line.at, line.spec, line.specLabel])).toEqual([
      [at(2), 3, "See what the revision changes"],
      [at(4), null, null],
    ]);
  });
});
