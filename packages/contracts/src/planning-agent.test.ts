import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  DirectedVersion,
  SPEC_REMOVAL_REASON_MAX_LENGTH,
  DraftTicketSetRequest,
  ImplementRequest,
  CheckConsistencyRequest,
  MapRound,
  ChartMapRequest,
  chartFollowUp,
  chartStep,
  DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT,
  DESTINATION_ROUNDS_MAX_COUNT,
  isLastMapRound,
  ReviseSpecRequest,
  SettleFogRequest,
  PullRequestRequest,
  ReplyThroughHatchRequest,
  ReviewRequest,
  SurveyCodeRequest,
  questionRoundDraft,
  specRevisionDraft,
  HatchChange,
  STORED_LIMITS,
  taskRound as taskRoundOf,
  ticketSetDraft,
  TICKETS_REVIEW_SUMMARY_MAX_LENGTH,
  ticketsReviewOutcome,
  waypointResolution,
  WAYPOINT_AGENT_DECIDED_MAX_COUNT,
  CHART_MAP_LINES_MAX_COUNT,
  CHART_WAYPOINTS_MAX_COUNT,
  ChartConfirmation,
  chartConfirmation,
  chartProposal,
  codeSurveyDraft,
  consistencyOutcome,
  fogSettlementOutcome,
  MODEL_LIMIT_STORED_CAPS,
  ModelLimits,
  CONSISTENCY_FINDINGS_MAX_COUNT,
  ConsistencyOutcome,
  DRAFT_SPECS_MAX_COUNT,
  draftSpecsOutcome,
  DraftSpecsRequest,
  GrillWaypointRequest,
  HATCH_MESSAGE_MAX_LENGTH,
  ResearchWaypointRequest,
  ReviewSpecRequest,
  ReviewTicketSetRequest,
  SpecFeedback,
  SpecRevisionContent,
  RoundQuestions,
  WorkTaskRequest,
  grillOutcome,
  grillResolutionOutcome,
  HATCH_REPLY_MAX_LENGTH,
  hatchOutcome,
  MAP_LINE_MAX_LENGTH,
  mapChanges,
  researchOutcome,
  reviseSpecOutcome,
  specReviewOutcome,
  taskOutcome,
  TicketSetContent,
  TOUCH_CRITERIA_MAX_COUNT,
  WAYPOINT_GIST_MAX_LENGTH,
  WAYPOINT_TOUCHES_MAX_COUNT,
} from "./index.ts";
import { LIMITS } from "./limits.fixture.ts";

const TicketsReviewOutcome = ticketsReviewOutcome(LIMITS);
const ChartProposal = chartProposal(LIMITS);
const DraftSpecsOutcome = draftSpecsOutcome(LIMITS);
const GrillOutcome = grillOutcome(LIMITS);
const GrillResolutionOutcome = grillResolutionOutcome(LIMITS);
const HatchOutcome = hatchOutcome(LIMITS);
const MapChanges = mapChanges(LIMITS);
const ResearchOutcome = researchOutcome(LIMITS);
const ReviseSpecOutcome = reviseSpecOutcome(LIMITS);
const SpecReviewOutcome = specReviewOutcome(LIMITS);
const TaskOutcome = taskOutcome(LIMITS);

const round = {
  intro: "The destination I propose: wordcount can count lines or characters.",
  questions: [
    {
      topic: "Units",
      text: "Which units should the tool count?",
      options: [
        { label: "Lines and characters", detail: "Both, as the idea says." },
        { label: "Lines only", detail: "Smaller; characters wait." },
      ],
    },
  ],
};

const proposal = {
  title: "Count lines or characters",
  summary: "Let people choose the unit wordcount counts.",
  destination: "wordcount counts lines, characters or words, chosen per call.",
  round,
  split: [],
};

function waypoint(index: number): { title: string; question: string; blockedBy: number[] } {
  return { title: `Waypoint ${String(index)}`, question: "What should hold?", blockedBy: [] };
}

function waypoints(count: number): ReturnType<typeof waypoint>[] {
  return Array.from({ length: count }, (_, index) => waypoint(index + 1));
}

const resolution = {
  resolution: "Use flags -l and -c.",
  gist: "Flags -l and -c",
  agentDecided: [],
};
const grillRound = { ...round, final: false };

/** The root `properties` keys of a schema's draft-07 JSON Schema, as the e2e stand-in reads them. */
function rootProperties(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { target: "draft-07" });
  expect(json.type).toBe("object");
  if (json.properties === undefined) throw new Error("an object schema has no properties");
  return Object.keys(json.properties).sort();
}

describe("ChartProposal", () => {
  test("accepts a title, summary, destination and round", () => {
    expect(ChartProposal.safeParse(proposal).success).toBe(true);
  });

  test("offers 0 to 3 maps to split off, each with a title, an idea and a line", () => {
    const offer = {
      title: "CSV imports",
      idea: "Import records.",
      line: "Imports are their own map.",
    };
    const withSplit = (split: unknown[]) => ChartProposal.safeParse({ ...proposal, split }).success;
    expect(withSplit([offer, offer, offer])).toBe(true);
    expect(withSplit([offer, offer, offer, offer])).toBe(false);
    expect(withSplit([{ ...offer, title: "" }])).toBe(false);
    expect(withSplit([{ title: offer.title, idea: offer.idea }])).toBe(false);
    expect(
      ChartProposal.safeParse({
        title: proposal.title,
        summary: proposal.summary,
        destination: proposal.destination,
        round: proposal.round,
      }).success,
    ).toBe(false);
  });

  test("refuses a proposal without a round", () => {
    const withoutRound = {
      title: proposal.title,
      summary: proposal.summary,
      destination: proposal.destination,
    };
    expect(ChartProposal.safeParse(withoutRound).success).toBe(false);
  });

  test("refuses a final flag on the map-level round", () => {
    expect(ChartProposal.safeParse({ ...proposal, round: grillRound }).success).toBe(false);
  });
});

const noChanges = {
  newWaypoints: [],
  fogOutOfScope: [],
  fogDecided: [],
  fogSettledHere: [],
  newFog: [],
};

describe("ChartConfirmation", () => {
  const empty = {
    title: proposal.title,
    summary: proposal.summary,
    destination: proposal.destination,
    waypoints: [],
    fog: [],
    outOfScope: [],
    proposals: [],
  };

  test("accepts zero waypoints, fog items and Out of scope lines", () => {
    expect(ChartConfirmation.safeParse(empty).success).toBe(true);
  });

  test("requires the map's title and summary beside the destination", () => {
    const { title, summary, ...withoutReading } = empty;
    expect(ChartConfirmation.safeParse({ ...withoutReading, summary }).success).toBe(false);
    expect(ChartConfirmation.safeParse({ ...withoutReading, title }).success).toBe(false);
    expect(ChartConfirmation.safeParse({ ...empty, title: null }).success).toBe(false);
    expect(ChartConfirmation.safeParse({ ...empty, summary: "" }).success).toBe(false);
  });

  test("refuses a confirmation that leaves out its proposals", () => {
    const withoutProposals = {
      destination: proposal.destination,
      waypoints: [],
      fog: [],
      outOfScope: [],
    };
    expect(ChartConfirmation.safeParse(withoutProposals).success).toBe(false);
  });

  test("accepts proposals of new maps, each with a title, its idea 1 to 4000 characters and line at most 500", () => {
    const withProposal = (idea: string, line: string, title = "CSV imports") =>
      ChartConfirmation.safeParse({ ...empty, proposals: [{ title, idea, line }] }).success;
    expect(withProposal("i".repeat(4000), "l".repeat(500))).toBe(true);
    expect(withProposal("Import CSV files.", "Imports are their own effort.")).toBe(true);
    expect(withProposal("", "Later.")).toBe(false);
    expect(withProposal("   ", "Later.")).toBe(false);
    expect(withProposal("i".repeat(4001), "Later.")).toBe(false);
    expect(withProposal("Import CSV files.", "l".repeat(501))).toBe(false);
    expect(withProposal("Import CSV files.", "Later.", "")).toBe(false);
    expect(withProposal("Import CSV files.", "Later.", "t".repeat(121))).toBe(false);
    expect(
      ChartConfirmation.safeParse({
        ...empty,
        proposals: [{ idea: "Import CSV files.", line: "Later." }],
      }).success,
    ).toBe(false);
  });

  test("accepts twelve waypoints of each kind with blockers by position", () => {
    const kinds = ["grilling", "research", "task"] as const;
    const twelve = waypoints(CHART_WAYPOINTS_MAX_COUNT).map((item, index) => ({
      ...item,
      kind: kinds[index % 3],
      blockedBy: index === 0 ? [] : [1],
      touches: [],
    }));
    expect(CHART_WAYPOINTS_MAX_COUNT).toBe(12);
    expect(ChartConfirmation.safeParse({ ...empty, waypoints: twelve }).success).toBe(true);
  });

  test("a waypoint names 0 to 3 touches, each with 1 to 12 criteria", () => {
    expect(WAYPOINT_TOUCHES_MAX_COUNT).toBe(3);
    expect(TOUCH_CRITERIA_MAX_COUNT).toBe(12);
    const criteria = (count: number) =>
      Array.from({ length: count }, (_, i) => `1.${String(i + 1)}`);
    const touch = (specNumber: number, count: number) => ({
      specNumber,
      revision: 1,
      criteria: criteria(count),
    });
    const charted = (touches: unknown[]) => ({
      ...empty,
      waypoints: [{ ...waypoint(1), kind: "grilling", blockedBy: [], touches }],
    });
    const parses = (touches: unknown[]) => ChartConfirmation.safeParse(charted(touches)).success;
    expect(parses([])).toBe(true);
    expect(parses([touch(1, 12), touch(2, 1), touch(3, 3)])).toBe(true);
    expect(parses([touch(1, 1), touch(2, 1), touch(3, 1), touch(4, 1)])).toBe(false);
    expect(parses([touch(1, 0)])).toBe(false);
    expect(parses([touch(1, 13)])).toBe(false);
    expect(parses([{ ...touch(1, 1), revision: 0 }])).toBe(false);
    expect(parses([{ ...touch(1, 1), criteria: ["C1"] }])).toBe(false);
    expect(
      ChartConfirmation.safeParse({
        ...empty,
        waypoints: [{ ...waypoint(1), kind: "grilling", blockedBy: [] }],
      }).success,
    ).toBe(false);
  });

  test("refuses thirteen waypoints", () => {
    const thirteen = waypoints(13).map((item) => ({ ...item, kind: "grilling" }));
    expect(ChartConfirmation.safeParse({ ...empty, waypoints: thirteen }).success).toBe(false);
  });

  test("refuses a waypoint without a kind, or of an unknown kind", () => {
    expect(ChartConfirmation.safeParse({ ...empty, waypoints: [waypoint(1)] }).success).toBe(false);
    expect(
      ChartConfirmation.safeParse({ ...empty, waypoints: [{ ...waypoint(1), kind: "prototype" }] })
        .success,
    ).toBe(false);
  });

  test("accepts eight fog items and eight Out of scope lines, and refuses nine of either", () => {
    expect(CHART_MAP_LINES_MAX_COUNT).toBe(8);
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${String(i)}`);
    expect(
      ChartConfirmation.safeParse({ ...empty, fog: lines(8), outOfScope: lines(8) }).success,
    ).toBe(true);
    expect(ChartConfirmation.safeParse({ ...empty, fog: lines(9) }).success).toBe(false);
    expect(ChartConfirmation.safeParse({ ...empty, outOfScope: lines(9) }).success).toBe(false);
  });

  test("refuses a fog line over 500 characters", () => {
    expect(MAP_LINE_MAX_LENGTH).toBe(500);
    expect(ChartConfirmation.safeParse({ ...empty, fog: ["f".repeat(500)] }).success).toBe(true);
    expect(ChartConfirmation.safeParse({ ...empty, fog: ["f".repeat(501)] }).success).toBe(false);
  });

  test("keeps two to four options on the map-level questions it reads", () => {
    const one = { ...round.questions[0], options: [round.questions[0]?.options[0]] };
    expect(
      ChartProposal.safeParse({ ...proposal, round: { ...round, questions: [one] } }).success,
    ).toBe(false);
    const none = { ...round.questions[0], options: [] };
    expect(
      ChartProposal.safeParse({ ...proposal, round: { ...round, questions: [none] } }).success,
    ).toBe(false);
  });
});

const ruling = { reason: "Exports to other formats are a later effort." };

describe("GrillOutcome", () => {
  test("accepts a round alone, and a resolution or a ruling with map changes", () => {
    const outcome = { round: null, resolution: null, outOfScope: null, mapChanges: null };
    expect(GrillOutcome.safeParse({ ...outcome, round: grillRound }).success).toBe(true);
    expect(GrillOutcome.safeParse({ ...outcome, resolution, mapChanges: noChanges }).success).toBe(
      true,
    );
    expect(
      GrillOutcome.safeParse({ ...outcome, outOfScope: ruling, mapChanges: noChanges }).success,
    ).toBe(true);
  });

  test("refuses zero or two alternatives", () => {
    const outcome = { round: null, resolution: null, outOfScope: null, mapChanges: noChanges };
    expect(GrillOutcome.safeParse(outcome).success).toBe(false);
    expect(GrillOutcome.safeParse({ ...outcome, resolution, outOfScope: ruling }).success).toBe(
      false,
    );
    expect(
      GrillOutcome.safeParse({ ...outcome, round: grillRound, resolution, mapChanges: null })
        .success,
    ).toBe(false);
  });

  test("refuses map changes beside a round, and none without one", () => {
    const outcome = { round: null, resolution: null, outOfScope: null, mapChanges: null };
    expect(
      GrillOutcome.safeParse({ ...outcome, round: grillRound, mapChanges: noChanges }).success,
    ).toBe(false);
    expect(GrillOutcome.safeParse({ ...outcome, resolution }).success).toBe(false);
  });

  test("refuses a round question with no options or one", () => {
    const outcome = { round: null, resolution: null, outOfScope: null, mapChanges: null };
    for (const options of [[], [round.questions[0]?.options[0]]]) {
      const question = { ...round.questions[0], options };
      expect(
        GrillOutcome.safeParse({ ...outcome, round: { ...grillRound, questions: [question] } })
          .success,
      ).toBe(false);
    }
  });

  test("refuses a gist over 200 characters and accepts one of exactly 200", () => {
    expect(WAYPOINT_GIST_MAX_LENGTH).toBe(200);
    const outcome = { round: null, outOfScope: null, mapChanges: noChanges };
    const at = { resolution: "Decided.", gist: "g".repeat(200), agentDecided: [] };
    const over = { resolution: "Decided.", gist: "g".repeat(201), agentDecided: [] };
    expect(GrillOutcome.safeParse({ ...outcome, resolution: at }).success).toBe(true);
    expect(GrillOutcome.safeParse({ ...outcome, resolution: over }).success).toBe(false);
  });
});

describe("a resolution's agentDecided", () => {
  const schema = waypointResolution(LIMITS);
  const decided = (agentDecided: string[]) => ({ ...resolution, agentDecided });

  test("takes 0 to 3 lines within the model's limit and refuses a fourth or a longer one", () => {
    expect(WAYPOINT_AGENT_DECIDED_MAX_COUNT).toBe(3);
    expect(schema.safeParse(decided([])).success).toBe(true);
    expect(schema.safeParse(decided(["a", "b", "c"])).success).toBe(true);
    expect(schema.safeParse(decided(["a", "b", "c", "d"])).success).toBe(false);
    expect(schema.safeParse(decided(["x".repeat(LIMITS.agentDecided.max)])).success).toBe(true);
    expect(schema.safeParse(decided(["x".repeat(LIMITS.agentDecided.max + 1)])).success).toBe(
      false,
    );
    expect(schema.safeParse(decided([""])).success).toBe(false);
  });

  test("is required: a resolution without it is refused", () => {
    const without = { resolution: resolution.resolution, gist: resolution.gist };
    expect(schema.safeParse(without).success).toBe(false);
  });

  test("a fog item the agent decided carries no agentDecided: the whole decision is the agent's", () => {
    const fogDecided = mapChanges(LIMITS).shape.fogDecided.element;
    const item = { position: 1, title: "Flags", resolution: resolution.resolution, gist: "Flags" };
    expect(fogDecided.safeParse(item).success).toBe(true);
    expect(fogDecided.safeParse({ ...item, agentDecided: [] }).success).toBe(false);
  });
});

describe("GrillResolutionOutcome", () => {
  test("accepts a resolution or a ruling, with map changes", () => {
    expect(
      GrillResolutionOutcome.safeParse({ resolution, outOfScope: null, mapChanges: noChanges })
        .success,
    ).toBe(true);
    expect(
      GrillResolutionOutcome.safeParse({
        resolution: null,
        outOfScope: ruling,
        mapChanges: noChanges,
      }).success,
    ).toBe(true);
  });

  test("refuses zero or two alternatives", () => {
    expect(
      GrillResolutionOutcome.safeParse({
        resolution: null,
        outOfScope: null,
        mapChanges: noChanges,
      }).success,
    ).toBe(false);
    expect(
      GrillResolutionOutcome.safeParse({ resolution, outOfScope: ruling, mapChanges: noChanges })
        .success,
    ).toBe(false);
  });

  test("refuses any round, even a null one", () => {
    const outcome = { resolution, outOfScope: null, mapChanges: noChanges };
    expect(GrillResolutionOutcome.safeParse({ ...outcome, round: grillRound }).success).toBe(false);
    expect(GrillResolutionOutcome.safeParse({ ...outcome, round: null }).success).toBe(false);
  });

  test("refuses a gist over 200 characters", () => {
    expect(
      GrillResolutionOutcome.safeParse({
        resolution: { resolution: "Decided.", gist: "g".repeat(201), agentDecided: [] },
        outOfScope: null,
        mapChanges: noChanges,
      }).success,
    ).toBe(false);
  });
});

describe("the seven output schemas' JSON Schemas", () => {
  test("each has an object root, told apart by its root properties alone", () => {
    expect(rootProperties(ChartProposal)).toEqual([
      "destination",
      "round",
      "split",
      "summary",
      "title",
    ]);
    expect(rootProperties(ChartConfirmation)).toEqual([
      "destination",
      "fog",
      "outOfScope",
      "proposals",
      "summary",
      "title",
      "waypoints",
    ]);
    expect(rootProperties(GrillOutcome)).toEqual([
      "mapChanges",
      "outOfScope",
      "resolution",
      "round",
    ]);
    expect(rootProperties(GrillResolutionOutcome)).toEqual([
      "mapChanges",
      "outOfScope",
      "resolution",
    ]);
    expect(rootProperties(ResearchOutcome)).toEqual(["mapChanges", "outOfScope", "report"]);
    expect(rootProperties(TaskOutcome)).toEqual([
      "done",
      "failed",
      "mapChanges",
      "outOfScope",
      "round",
    ]);
    expect(rootProperties(ConsistencyOutcome)).toEqual(["findings", "proposals"]);
  });

  test("the research, task and consistency keys are each a root of exactly one schema", () => {
    const schemas = [
      ChartProposal,
      ChartConfirmation,
      GrillOutcome,
      GrillResolutionOutcome,
      ResearchOutcome,
      TaskOutcome,
      ConsistencyOutcome,
    ];
    for (const [key, owner] of [
      ["report", ResearchOutcome],
      ["done", TaskOutcome],
      ["findings", ConsistencyOutcome],
    ] as const) {
      expect(schemas.filter((schema) => rootProperties(schema).includes(key))).toEqual([owner]);
    }
    const sets = schemas.map((schema) => rootProperties(schema).join(","));
    expect(new Set(sets).size).toBe(schemas.length);
  });
});

const newWaypoint = {
  kind: "grilling",
  title: "Total label",
  question: "What does the total line say?",
  blockedBy: [1],
  fromFog: null,
};

describe("MapChanges", () => {
  test("accepts six new waypoints, fog moved out of scope and four new fog items", () => {
    const changes = {
      newWaypoints: Array.from({ length: 6 }, () => newWaypoint),
      fogOutOfScope: [{ position: 2, line: "Unicode width is out of scope." }],
      fogDecided: [],
      fogSettledHere: [],
      newFog: ["a", "b", "c", "d"],
    };
    expect(MapChanges.safeParse(changes).success).toBe(true);
  });

  test("refuses seven new waypoints", () => {
    const changes = { ...noChanges, newWaypoints: Array.from({ length: 7 }, () => newWaypoint) };
    expect(MapChanges.safeParse(changes).success).toBe(false);
  });

  test("refuses five new fog items", () => {
    const changes = {
      ...noChanges,
      fogDecided: [],
      fogSettledHere: [],
      newFog: ["a", "b", "c", "d", "e"],
    };
    expect(MapChanges.safeParse(changes).success).toBe(false);
  });
});

const externalSource = {
  kind: "external",
  title: "Node.js fs docs",
  url: "https://nodejs.org/api/fs.html",
  excerpt: "fs.readFile reads the entire contents of a file.",
};

const answeredReport = {
  answered: true,
  summary: "readFile reads the whole file.",
  gap: null,
  gist: "readFile buffers the whole file",
  findings: [{ title: "Buffers whole file", detail: "It reads everything.", sources: [1] }],
  sources: [externalSource],
  limitations: [],
  uncertainties: [],
};

const unansweredReport = {
  ...answeredReport,
  answered: false,
  gap: "No primary source states the limit.",
  gist: null,
  findings: [],
};

describe("ResearchOutcome", () => {
  test("accepts an answered report, an unanswered one, or a ruling, each with map changes", () => {
    for (const outcome of [
      { report: answeredReport, outOfScope: null, mapChanges: noChanges },
      { report: unansweredReport, outOfScope: null, mapChanges: noChanges },
      { report: null, outOfScope: { reason: "Not this map." }, mapChanges: noChanges },
    ]) {
      expect(ResearchOutcome.safeParse(outcome).success).toBe(true);
    }
  });

  test("refuses zero or two alternatives", () => {
    for (const outcome of [
      { report: null, outOfScope: null, mapChanges: noChanges },
      { report: answeredReport, outOfScope: { reason: "Not this map." }, mapChanges: noChanges },
    ]) {
      expect(ResearchOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses an answered report without a finding, without a gist, or with a gap", () => {
    for (const report of [
      { ...answeredReport, findings: [] },
      { ...answeredReport, gist: null },
      { ...answeredReport, gap: "Something is missing." },
    ]) {
      const outcome = { report, outOfScope: null, mapChanges: noChanges };
      expect(ResearchOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses an unanswered report without a gap or with a gist", () => {
    for (const report of [
      { ...unansweredReport, gap: null },
      { ...unansweredReport, gist: "A gist." },
    ]) {
      const outcome = { report, outOfScope: null, mapChanges: noChanges };
      expect(ResearchOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses a URL on a non-external source, none on an external one, and an unknown kind", () => {
    for (const source of [
      { ...externalSource, kind: "repository_file" },
      { ...externalSource, url: null },
      { ...externalSource, kind: "blog" },
    ]) {
      const outcome = {
        report: { ...answeredReport, sources: [source] },
        outOfScope: null,
        mapChanges: noChanges,
      };
      expect(ResearchOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses a finding citing a source position the report lacks", () => {
    const findings = [{ title: "T", detail: "D", sources: [2] }];
    const outcome = {
      report: { ...answeredReport, findings },
      outOfScope: null,
      mapChanges: noChanges,
    };
    expect(ResearchOutcome.safeParse(outcome).success).toBe(false);
  });
});

const taskRound = {
  intro: "I need one fact from you.",
  questions: [
    {
      topic: "Access",
      text: "Which account owns the bucket?",
      options: [
        { label: "Yours", detail: "The plan uses your credentials." },
        { label: "Another team's", detail: "The plan waits on their access." },
      ],
    },
  ],
};
const taskDone = {
  action: "Read the config.",
  facts: "The bucket is eu-west-1.",
  gist: "eu-west-1",
  agentDecided: [],
};
const taskFailed = { action: "Read the config.", facts: "No config names the bucket." };

describe("TaskOutcome", () => {
  test("accepts a round alone, and done, failed or a ruling with map changes", () => {
    const none = { round: null, done: null, failed: null, outOfScope: null };
    for (const outcome of [
      { ...none, round: taskRound, mapChanges: null },
      { ...none, done: taskDone, mapChanges: noChanges },
      { ...none, failed: taskFailed, mapChanges: noChanges },
      { ...none, outOfScope: ruling, mapChanges: noChanges },
    ]) {
      expect(TaskOutcome.safeParse(outcome).success).toBe(true);
    }
  });

  test("refuses zero or two alternatives", () => {
    for (const outcome of [
      { round: null, done: null, failed: null, outOfScope: null, mapChanges: noChanges },
      { round: null, done: taskDone, failed: taskFailed, outOfScope: null, mapChanges: noChanges },
    ]) {
      expect(TaskOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses a round question with no options or one", () => {
    const [first] = taskRound.questions;
    for (const options of [[], first?.options.slice(0, 1)]) {
      const outcome = {
        round: { ...taskRound, questions: [{ ...first, options }] },
        done: null,
        failed: null,
        outOfScope: null,
        mapChanges: null,
      };
      expect(TaskOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses map changes beside a round, and none without one", () => {
    const none = { round: null, done: null, failed: null, outOfScope: null };
    for (const outcome of [
      { ...none, round: taskRound, mapChanges: noChanges },
      { ...none, done: taskDone, mapChanges: null },
    ]) {
      expect(TaskOutcome.safeParse(outcome).success).toBe(false);
    }
  });

  test("refuses four questions in a round", () => {
    const questions = Array.from({ length: 4 }, () => taskRound.questions[0]);
    const outcome = {
      round: { ...taskRound, questions },
      done: null,
      failed: null,
      outOfScope: null,
      mapChanges: null,
    };
    expect(TaskOutcome.safeParse(outcome).success).toBe(false);
  });
});

const finding = {
  kind: "conflicting_surfaces",
  waypointNumbers: [1, 2],
  title: "Total label versus plain output",
  explanation: "Waypoint 1 says “12 total lines”; waypoint 2 says the output is unchanged.",
  question: "Which total line ships?",
};

describe("ConsistencyOutcome", () => {
  test("accepts no findings and three findings", () => {
    expect(CONSISTENCY_FINDINGS_MAX_COUNT).toBe(3);
    expect(ConsistencyOutcome.safeParse({ findings: [], proposals: [] }).success).toBe(true);
    const three = Array.from({ length: 3 }, () => finding);
    expect(ConsistencyOutcome.safeParse({ findings: three, proposals: [] }).success).toBe(true);
  });

  test("refuses four findings", () => {
    const four = Array.from({ length: 4 }, () => finding);
    expect(ConsistencyOutcome.safeParse({ findings: four, proposals: [] }).success).toBe(false);
  });

  test("refuses an outcome that leaves out its proposals", () => {
    expect(ConsistencyOutcome.safeParse({ findings: [] }).success).toBe(false);
  });

  test("refuses a finding naming no waypoint, and an unknown kind", () => {
    for (const bad of [
      { ...finding, waypointNumbers: [] },
      { ...finding, kind: "style" },
    ]) {
      expect(ConsistencyOutcome.safeParse({ findings: [bad], proposals: [] }).success).toBe(false);
    }
  });
});

const NO_FOG = {
  newWaypoints: [],
  fogOutOfScope: [],
  fogDecided: [],
  fogSettledHere: [],
  newFog: [],
};

/** One change of each of the eight kinds. */
const HATCH_CHANGES = [
  { kind: "reopen", waypoint: 2 },
  {
    kind: "open_waypoint",
    waypointKind: "research",
    title: "Symlinked folders",
    question: "Does a symlink into a project count as nested?",
    blockedBy: [1],
    fog: NO_FOG,
  },
  { kind: "reword", waypoint: 3, title: "Nesting depth", question: "How deep does nesting reach?" },
  {
    kind: "rule_out_of_scope",
    waypoint: 4,
    reason: "Symlinks: the destination names folders only.",
    fog: {
      newWaypoints: [],
      fogOutOfScope: [{ position: 1, line: "Network drives." }],
      fogDecided: [],
      fogSettledHere: [],
      newFog: [],
    },
  },
  { kind: "run_waypoint", waypoint: 5 },
  { kind: "accept_report", waypoint: 5, gist: "realpath resolves symlinks", fog: NO_FOG },
  { kind: "revise_spec" },
  { kind: "rewrite_tickets" },
  {
    kind: "propose_map",
    title: "Imports",
    idea: "Import records.",
    line: "Imports.",
    splitsLine: null,
  },
] as const;

describe("HatchOutcome", () => {
  test("accepts a reply with no change and with each of the nine kinds of change", () => {
    expect(HatchOutcome.safeParse({ reply: "Any depth.", change: null }).success).toBe(true);
    expect(HATCH_CHANGES.map((change) => change.kind)).toHaveLength(9);
    for (const change of HATCH_CHANGES) {
      expect(HatchOutcome.safeParse({ reply: "Done.", change }).success).toBe(true);
    }
  });

  test("a propose_map carries exactly one of its own line and an existing line's position", () => {
    const proposal = { kind: "propose_map", title: "Imports", idea: "Import records." };
    const parses = (change: object) => HatchOutcome.safeParse({ reply: "Done.", change }).success;
    expect(parses({ ...proposal, line: "Imports.", splitsLine: null })).toBe(true);
    expect(parses({ ...proposal, line: null, splitsLine: 2 })).toBe(true);
    expect(parses({ ...proposal, line: "Imports.", splitsLine: 2 })).toBe(false);
    expect(parses({ ...proposal, line: null, splitsLine: null })).toBe(false);
    expect(parses({ ...proposal, line: null, splitsLine: 0 })).toBe(false);
    expect(parses({ ...proposal, idea: " ", line: "Imports.", splitsLine: null })).toBe(false);
    expect(parses({ ...proposal, line: "Imports." })).toBe(false);
  });

  test("bounds the reply: 1 to 2000 characters", () => {
    expect(HatchOutcome.safeParse({ reply: "", change: null }).success).toBe(false);
    expect(
      HatchOutcome.safeParse({ reply: "x".repeat(HATCH_REPLY_MAX_LENGTH), change: null }).success,
    ).toBe(true);
    expect(
      HatchOutcome.safeParse({ reply: "x".repeat(HATCH_REPLY_MAX_LENGTH + 1), change: null })
        .success,
    ).toBe(false);
  });

  test("rejects an unknown kind of change and a missing change", () => {
    expect(
      HatchOutcome.safeParse({ reply: "Done.", change: { kind: "edit_destination" } }).success,
    ).toBe(false);
    expect(HatchOutcome.safeParse({ reply: "Done." }).success).toBe(false);
  });

  test("rejects a change carrying the fields of another kind", () => {
    for (const change of [
      { kind: "reopen", waypoint: 2, title: "Nesting depth" },
      { kind: "revise_spec", waypoint: 2 },
      { kind: "rewrite_tickets", fog: NO_FOG },
      { kind: "run_waypoint", waypoint: 5, gist: "realpath resolves symlinks" },
      { kind: "reword", waypoint: 3, title: "Nesting depth", question: "How deep?", fog: NO_FOG },
    ]) {
      expect(HatchOutcome.safeParse({ reply: "Done.", change }).success).toBe(false);
    }
  });

  test("rejects a change missing its own fields", () => {
    expect(HatchOutcome.safeParse({ reply: "Done.", change: { kind: "reopen" } }).success).toBe(
      false,
    );
    expect(
      HatchOutcome.safeParse({
        reply: "Done.",
        change: { kind: "accept_report", waypoint: 5, gist: "realpath" },
      }).success,
    ).toBe(false);
  });

  test("its root `reply` is a root of no other planning call's output schema", () => {
    expect(rootProperties(HatchOutcome)).toEqual(["change", "reply"]);
    const others = [
      ChartProposal,
      ChartConfirmation,
      GrillOutcome,
      GrillResolutionOutcome,
      ResearchOutcome,
      TaskOutcome,
      ConsistencyOutcome,
      DraftSpecsOutcome,
      ReviseSpecOutcome,
      SpecReviewOutcome,
      TicketSetContent,
    ];
    for (const schema of others) {
      const roots = rootProperties(schema);
      expect(roots).not.toContain("reply");
      expect(roots).not.toContain("change");
    }
  });
});

describe("notes and problems on the planning requests", () => {
  test("the grilling, research and task requests take a nullable note with text and time", () => {
    const note = { text: "Use --lines.", sentAt: "2026-10-08T09:30:00.000Z" };
    for (const schema of [
      GrillWaypointRequest.shape.note,
      ResearchWaypointRequest.shape.note,
      WorkTaskRequest.shape.note,
    ]) {
      expect(schema.safeParse(note).success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(undefined).success).toBe(false);
      expect(schema.safeParse({ text: "", sentAt: note.sentAt }).success).toBe(false);
      expect(schema.safeParse({ text: note.text, sentAt: "today" }).success).toBe(false);
      expect(
        schema.safeParse({ ...note, text: "x".repeat(HATCH_MESSAGE_MAX_LENGTH + 1) }).success,
      ).toBe(false);
    }
  });

  test("the grilling request's waypoint marks a reopen and its superseded rounds; a refused attempt carries its problem", () => {
    const waypoint = GrillWaypointRequest.shape.waypoint;
    const base = {
      number: 1,
      kind: "grilling",
      title: "Output",
      question: "How does it read?",
      rounds: [],
      touches: [],
    };
    const full = { ...base, reopened: false, supersededRounds: [], personDecides: false };
    expect(waypoint.safeParse({ ...full, reopened: true }).success).toBe(true);
    expect(waypoint.safeParse({ ...full, personDecides: true }).success).toBe(true);
    expect(waypoint.safeParse({ ...base, reopened: false, supersededRounds: [] }).success).toBe(
      false,
    );
    expect(
      waypoint.safeParse({ ...base, supersededRounds: [], personDecides: false }).success,
    ).toBe(false);
    expect(waypoint.safeParse({ ...base, reopened: false, personDecides: false }).success).toBe(
      false,
    );
    const refused = GrillWaypointRequest.shape.refusedAttempt;
    expect(refused.safeParse({ problem: "Ask a new round." }).success).toBe(true);
    expect(refused.safeParse(null).success).toBe(true);
    expect(refused.safeParse(undefined).success).toBe(false);
    expect(refused.safeParse({ problem: "" }).success).toBe(false);
  });

  test("SpecFeedback accepts a note with its text", () => {
    expect(SpecFeedback.safeParse({ kind: "note", text: "Parents too." }).success).toBe(true);
    expect(SpecFeedback.safeParse({ kind: "note", text: "" }).success).toBe(false);
    expect(SpecFeedback.safeParse({ kind: "note", reason: "Parents too." }).success).toBe(false);
  });

  test("ReviewSpecRequest carries the note-directed revisions, each with its note", () => {
    const schema = ReviewSpecRequest.shape.noteDirectedRevisions;
    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse([{ revision: 2, note: "Parents too." }]).success).toBe(true);
    expect(schema.safeParse([{ revision: 0, note: "Parents too." }]).success).toBe(false);
    expect(schema.safeParse([{ revision: 2 }]).success).toBe(false);
  });

  test("ReviewSpecRequest carries the earlier findings by revision, each with at least one", () => {
    const schema = ReviewSpecRequest.shape.earlierFindings;
    const finding = { kind: "invented_scope", elementIds: ["C1", "1.2"], explanation: "Adds CSV." };
    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse([{ revision: 1, findings: [finding] }]).success).toBe(true);
    expect(schema.safeParse([{ revision: 1, findings: [] }]).success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  test("both tickets requests carry the earlier findings by version, each with at least one", () => {
    const finding = {
      kind: "contradiction",
      ticketNumbers: ["T1"],
      criterionIds: ["1.1"],
      explanation: "T1 builds in web.",
    };
    for (const schema of [
      ReviewTicketSetRequest.shape.earlierFindings,
      DraftTicketSetRequest.shape.earlierFindings,
    ]) {
      expect(schema.safeParse([]).success).toBe(true);
      expect(schema.safeParse([{ version: 1, findings: [finding] }]).success).toBe(true);
      expect(schema.safeParse([{ version: 1, findings: [] }]).success).toBe(false);
      expect(schema.safeParse([{ version: 0, findings: [finding] }]).success).toBe(false);
      expect(schema.safeParse(undefined).success).toBe(false);
    }
  });

  test("DraftSpecsRequest carries the refused problem, nullable", () => {
    const schema = DraftSpecsRequest.shape.refusedAttempt;
    expect(schema.safeParse({ problem: "Spec 1: no source" }).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse({ problem: "" }).success).toBe(false);
  });

  test("DraftSpecsOutcome parses zero specs; core decides whether zero is right", () => {
    expect(DraftSpecsOutcome.safeParse({ specs: [], waits: [] }).success).toBe(true);
  });

  test("DraftSpecsOutcome names 0 to 12 waits, each a spec number and a note", () => {
    const wait = (specNumber: number, note: string) => ({ specNumber, note });
    const parses = (waits: unknown[]) => DraftSpecsOutcome.safeParse({ specs: [], waits }).success;
    const twelve = Array.from({ length: 12 }, (_, i) => wait(i + 1, "Trim the ends."));
    expect(parses(twelve)).toBe(true);
    expect(parses([...twelve, wait(13, "One more.")])).toBe(false);
    expect(parses([wait(1, "n".repeat(HATCH_MESSAGE_MAX_LENGTH))])).toBe(true);
    expect(parses([wait(1, "n".repeat(HATCH_MESSAGE_MAX_LENGTH + 1))])).toBe(false);
    expect(parses([wait(1, "")])).toBe(false);
    expect(parses([wait(0, "Trim the ends.")])).toBe(false);
    expect(DraftSpecsOutcome.safeParse({ specs: [] }).success).toBe(false);
  });
});

describe("the tickets review", () => {
  const finding = {
    kind: "untraced_criterion",
    route: "revise",
    title: "T1 adds a CSV format",
    explanation: "T1's build adds `--csv`; no criterion of C1 states a CSV format.",
    question: "Should the export also write CSV?",
    ticketNumbers: ["T1"],
    criterionIds: ["1.1"],
  };
  const parses = (outcome: unknown) => TicketsReviewOutcome.safeParse(outcome).success;

  test("the outcome accepts zero findings and eight, each kind and route", () => {
    expect(parses({ summary: "Every criterion traces.", findings: [] })).toBe(true);
    expect(parses({ summary: "Eight.", findings: Array.from({ length: 8 }, () => finding) })).toBe(
      true,
    );
    for (const kind of [
      "untraced_criterion",
      "uncovered_clause",
      "contradiction",
      "unsupported_evidence",
    ]) {
      for (const route of ["revise", "decision"]) {
        expect(parses({ summary: "One.", findings: [{ ...finding, kind, route }] })).toBe(true);
      }
    }
  });

  test("the outcome refuses each bound exceeded, an unknown kind and an unknown route", () => {
    const one = (patch: object) => ({ summary: "One.", findings: [{ ...finding, ...patch }] });
    expect(parses({ summary: "x".repeat(1001), findings: [] })).toBe(false);
    expect(parses({ summary: "x".repeat(1000), findings: [] })).toBe(true);
    expect(TICKETS_REVIEW_SUMMARY_MAX_LENGTH).toBe(2000);
    expect(parses({ summary: "Nine.", findings: Array.from({ length: 9 }, () => finding) })).toBe(
      false,
    );
    expect(parses(one({ title: "x".repeat(121) }))).toBe(false);
    expect(parses(one({ title: "x".repeat(120) }))).toBe(true);
    expect(parses(one({ explanation: "x".repeat(1001) }))).toBe(false);
    expect(parses(one({ explanation: "x".repeat(1000) }))).toBe(true);
    expect(parses(one({ question: "x".repeat(501) }))).toBe(false);
    expect(parses(one({ question: "x".repeat(500) }))).toBe(true);
    expect(parses(one({ kind: "invented_scope" }))).toBe(false);
    expect(parses(one({ kind: "disposition_without_reason" }))).toBe(true);
    expect(parses(one({ route: "escalate" }))).toBe(false);
    expect(parses(one({ ticketNumbers: [1] }))).toBe(false);
  });

  test("a rewrite carries a null reason with findings, or a reason with empty findings", () => {
    const rewrite = DraftTicketSetRequest.shape.rewrite;
    const content = {
      tickets: [
        {
          id: "T1",
          title: "Export",
          build: "Add the export.",
          blockedBy: [],
          criteria: ["1.1"],
          testing: ["The export is tested."],
          followUp: null,
          outOfScope: [],
          pointers: ["src/index.ts"],
        },
      ],
      dispositions: [{ criterion: "1.1", kind: "work", ticket: "T1", reason: null }],
      slicing: "One ticket.",
      execution: "Agent-verifiable.",
    };
    const base = { version: 1, content, directedVersions: [] };
    expect(rewrite.safeParse({ ...base, findings: [finding], reason: null }).success).toBe(true);
    expect(rewrite.safeParse({ ...base, findings: [], reason: "Split it." }).success).toBe(true);
    expect(rewrite.safeParse({ ...base, findings: [finding], reason: "Split it." }).success).toBe(
      true,
    );
    expect(rewrite.safeParse({ ...base, findings: [], reason: null }).success).toBe(false);
    expect(rewrite.safeParse({ ...base, reason: "Split it." }).success).toBe(false);
    // A rewrite always states the set's directed versions, even when there are none.
    expect(
      rewrite.safeParse({ version: 1, content, findings: [], reason: "Split it." }).success,
    ).toBe(false);
  });

  test("a directed version is a rejection reason or a note behind version 2 or later", () => {
    const parses = (value: unknown) => DirectedVersion.safeParse(value).success;
    expect(parses({ kind: "rejection", version: 2, reason: "Name it toCsv." })).toBe(true);
    expect(parses({ kind: "note", version: 3, text: "Use stock.csv." })).toBe(true);
    // The first version is never written from a rejection or a note.
    expect(parses({ kind: "rejection", version: 1, reason: "Name it toCsv." })).toBe(false);
    expect(parses({ kind: "rejection", version: 2, reason: " " })).toBe(false);
    expect(parses({ kind: "note", version: 2, reason: "Use stock.csv." })).toBe(false);
    expect(parses({ kind: "review", version: 2, text: "Use stock.csv." })).toBe(false);
  });

  test("a hatch spec's ticket set carries its review, and held findings exactly when held", () => {
    const set = ReplyThroughHatchRequest.shape.specs.element.shape.ticketSet;
    const base = { version: 3, state: "review_failed" };
    const held = [{ title: finding.title, question: finding.question }];
    for (const review of ["none", "running", "stopped", "passed", "failed"]) {
      expect(set.safeParse({ ...base, review, heldFindings: null }).success).toBe(true);
      expect(set.safeParse({ ...base, review, heldFindings: held }).success).toBe(false);
    }
    expect(set.safeParse({ ...base, review: "held", heldFindings: held }).success).toBe(true);
    expect(set.safeParse({ ...base, review: "held", heldFindings: null }).success).toBe(false);
    expect(set.safeParse({ ...base, review: "held", heldFindings: [] }).success).toBe(false);
    expect(set.safeParse({ ...base, review: "pending", heldFindings: null }).success).toBe(false);
  });

  test("the hatch reads tickets_review as spec work and a stopped waypoint", () => {
    const spec = ReplyThroughHatchRequest.shape.specs.element.shape;
    expect(spec.inFlight.safeParse(["tickets_review", "to_tickets"]).success).toBe(true);
    const waypoint = ReplyThroughHatchRequest.shape.waypoints.element;
    const stopped = {
      number: 2,
      kind: "grilling",
      title: "Columns",
      question: "Which columns?",
      status: "open",
      blockedBy: [],
      resolution: null,
      gist: null,
      agentDecided: null,
      waiting: null,
      report: null,
      stopped: true,
    };
    expect(waypoint.safeParse(stopped).success).toBe(true);
    expect(waypoint.safeParse({ ...stopped, stopped: undefined }).success).toBe(false);
  });
});

describe("the drafting bounds: tight on the agent's output, wide on stored records", () => {
  const text = (length: number) => "x".repeat(length);
  const question = round.questions[0];
  if (question === undefined) throw new Error("The round fixture has no question");
  const withQuestion = (changed: Partial<typeof question>) => ({
    ...grillRound,
    questions: [{ ...question, ...changed }],
  });
  const grill = (outcome: object) =>
    GrillOutcome.safeParse({
      round: null,
      resolution: null,
      outOfScope: null,
      mapChanges: null,
      ...outcome,
    }).success;

  test("a round's question text, option detail and intro are bounded by the limits' maxes", () => {
    expect([LIMITS.questionText.max, LIMITS.optionDetail.max, LIMITS.roundIntro.max]).toEqual([
      200, 200, 300,
    ]);
    const options = (detail: string) =>
      question.options.map((option, index) => (index === 0 ? { ...option, detail } : option));
    expect(grill({ round: withQuestion({ text: text(200) }) })).toBe(true);
    expect(grill({ round: withQuestion({ text: text(201) }) })).toBe(false);
    expect(grill({ round: withQuestion({ options: options(text(200)) }) })).toBe(true);
    expect(grill({ round: withQuestion({ options: options(text(201)) }) })).toBe(false);
    expect(grill({ round: { ...grillRound, intro: text(300) } })).toBe(true);
    expect(grill({ round: { ...grillRound, intro: text(301) } })).toBe(false);
    expect(
      ChartProposal.safeParse({ ...proposal, round: withQuestion({ text: text(201) }) }).success,
    ).toBe(false);
    expect(
      TaskOutcome.safeParse({
        round: { ...taskRound, questions: [{ ...taskRound.questions[0], text: text(201) }] },
        done: null,
        failed: null,
        outOfScope: null,
        mapChanges: null,
      }).success,
    ).toBe(false);
  });

  test("stored rounds keep the wider bounds, so rounds asked before still load", () => {
    expect(
      RoundQuestions.safeParse([
        {
          ...question,
          text: text(1000),
          options: question.options.map((option) => ({ ...option, detail: text(500) })),
        },
      ]).success,
    ).toBe(true);
  });

  test("a resolution is bounded by the limits' max", () => {
    expect(LIMITS.resolution.max).toBe(800);
    const mapChanges = noChanges;
    expect(grill({ resolution: { ...resolution, resolution: text(800) }, mapChanges })).toBe(true);
    expect(grill({ resolution: { ...resolution, resolution: text(801) }, mapChanges })).toBe(false);
  });

  test("To Spec writes at most four specs, each problem, solution and clause text bounded", () => {
    expect([DRAFT_SPECS_MAX_COUNT, LIMITS.specProse.max, LIMITS.clauseText.max]).toEqual([
      4, 600, 400,
    ]);
    const clause = {
      id: "C1",
      title: "Export",
      text: "The export writes every record.",
      criteria: [{ id: "1.1", text: "An export holds every record." }],
      sources: [{ kind: "destination" }],
      reliesOn: [],
      adds: ["export"],
    };
    const content = {
      title: "Export",
      problem: "No export.",
      solution: "An export.",
      clauses: [clause],
      outOfScope: [],
    };
    const specs = (count: number, changed: object) => ({
      specs: Array.from({ length: count }, () => ({
        specNumber: null,
        content: { ...content, ...changed },
      })),
      waits: [],
    });
    expect(DraftSpecsOutcome.safeParse(specs(4, {})).success).toBe(true);
    expect(DraftSpecsOutcome.safeParse(specs(5, {})).success).toBe(false);
    expect(DraftSpecsOutcome.safeParse(specs(1, { problem: text(600) })).success).toBe(true);
    for (const changed of [
      { problem: text(601) },
      { solution: text(601) },
      { clauses: [{ ...clause, text: text(401) }] },
    ]) {
      expect(DraftSpecsOutcome.safeParse(specs(1, changed)).success).toBe(false);
      expect(
        ReviseSpecOutcome.safeParse({ revision: { ...content, ...changed }, removed: [] }).success,
      ).toBe(false);
    }
    // A repair declares its removals: required, each an element id with a reason.
    expect(ReviseSpecOutcome.safeParse({ revision: content }).success).toBe(false);
    expect(
      ReviseSpecOutcome.safeParse({
        revision: content,
        removed: [{ id: "1.2", reason: "Merged into 1.1." }],
      }).success,
    ).toBe(true);
    for (const removal of [
      { id: "T1", reason: "x" },
      { id: "1.2", reason: "" },
      { id: "1.2", reason: text(SPEC_REMOVAL_REASON_MAX_LENGTH + 1) },
    ]) {
      expect(ReviseSpecOutcome.safeParse({ revision: content, removed: [removal] }).success).toBe(
        false,
      );
    }
    // A stored revision keeps the wider bounds.
    expect(
      SpecRevisionContent.safeParse({
        ...content,
        problem: text(2000),
        clauses: [{ ...clause, text: text(1000) }],
      }).success,
    ).toBe(true);
  });
});

describe("the drafting bounds follow the run's model's limits (agent.models)", () => {
  const text = (length: number) => "x".repeat(length);
  // Each field a distinct max below its cap, none the Sonnet profile's, so a bound read from
  // elsewhere fails.
  const limits: ModelLimits = {
    questionText: { aim: 100, max: 111 },
    questionTopic: { aim: 40, max: 71 },
    optionDetail: { aim: 100, max: 122 },
    optionLabel: { aim: 40, max: 63 },
    roundIntro: { aim: 100, max: 133 },
    mapTitle: { aim: 50, max: 101 },
    mapSummary: { aim: 100, max: 702 },
    destination: { aim: 100, max: 713 },
    waypointTitle: { aim: 50, max: 102 },
    waypointQuestion: { aim: 100, max: 724 },
    resolution: { aim: 100, max: 944 },
    gist: { aim: 50, max: 155 },
    agentDecided: { aim: 50, max: 144 },
    mapLine: { aim: 100, max: 377 },
    findingExplanation: { aim: 100, max: 2911 },
    researchSummary: { aim: 100, max: 2922 },
    researchFindingTitle: { aim: 50, max: 103 },
    researchFindingDetail: { aim: 100, max: 1511 },
    researchSourceTitle: { aim: 50, max: 166 },
    researchExcerpt: { aim: 100, max: 1522 },
    researchNote: { aim: 100, max: 735 },
    taskAction: { aim: 100, max: 746 },
    taskFacts: { aim: 100, max: 2933 },
    surveyText: { aim: 100, max: 311 },
    surveyName: { aim: 50, max: 177 },
    hatchReply: { aim: 100, max: 1533 },
    waitNote: { aim: 100, max: 2944 },
    specTitle: { aim: 50, max: 104 },
    specProse: { aim: 100, max: 555 },
    clauseTitle: { aim: 50, max: 105 },
    clauseText: { aim: 100, max: 466 },
    criterionText: { aim: 100, max: 388 },
    clauseName: { aim: 50, max: 188 },
    contentLine: { aim: 100, max: 399 },
    removalReason: { aim: 100, max: 244 },
    ticketTitle: { aim: 50, max: 77 },
    ticketBuild: { aim: 100, max: 2888 },
    dispositionText: { aim: 100, max: 757 },
    ticketSetSlicing: { aim: 100, max: 1544 },
    ticketSetExecution: { aim: 100, max: 768 },
    specReviewSummary: { aim: 100, max: 1299 },
    ticketsReviewSummary: { aim: 100, max: 1388 },
    ticketsReviewFindingTitle: { aim: 50, max: 106 },
    ticketsReviewFindingExplanation: { aim: 100, max: 779 },
    ticketsReviewFindingQuestion: { aim: 100, max: 433 },
  };
  const question = questionRoundDraft(limits).shape.questions.element;
  const ticket = ticketSetDraft(limits).shape.tickets.element;
  const revision = specRevisionDraft(limits);
  const clause = revision.shape.clauses.element;
  const proposal = chartProposal(limits);
  const confirmation = chartConfirmation(limits);
  const changes = mapChanges(limits);
  const fog = fogSettlementOutcome(limits);
  const consistency = consistencyOutcome(limits).shape.findings.element;
  const specReview = specReviewOutcome(limits);
  const ticketsReview = ticketsReviewOutcome(limits).shape.findings.element;
  const report = researchOutcome(limits).shape.report.unwrap();
  const task = taskOutcome(limits);
  const survey = codeSurveyDraft(limits);
  const area = survey.shape.entries.element;
  const identifier = survey.shape.identifiers.element;
  const lifecycle = survey.shape.lifecycles.element;
  const transition = lifecycle.shape.transitions.element;
  const terminal = lifecycle.shape.terminal.element;
  const hatchChanges = hatchOutcome(limits).shape.change.unwrap().options;
  const ticketSet = ticketSetDraft(limits);
  const dispositions = ticketSet.shape.dispositions.element.options;
  const fields: [keyof ModelLimits, z.ZodType][] = [
    ["questionText", question.shape.text],
    ["questionText", taskRoundOf(limits).shape.questions.element.shape.text],
    ["questionTopic", question.shape.topic],
    ["optionDetail", question.shape.options.element.shape.detail],
    ["optionLabel", question.shape.options.element.shape.label],
    ["roundIntro", questionRoundDraft(limits).shape.intro],
    ["roundIntro", taskRoundOf(limits).shape.intro],
    ["mapTitle", proposal.shape.title],
    ["mapSummary", proposal.shape.summary],
    ["destination", proposal.shape.destination],
    ["destination", confirmation.shape.destination],
    ["waypointTitle", confirmation.shape.waypoints.element.shape.title],
    ["waypointTitle", changes.shape.newWaypoints.element.shape.title],
    ["waypointTitle", changes.shape.fogDecided.element.shape.title],
    ["waypointTitle", fog.shape.fogForPerson.element.shape.title],
    ["waypointTitle", consistency.shape.title],
    ["waypointTitle", specReview.shape.findings.element.shape.title],
    ["waypointTitle", hatchChanges[2].shape.title],
    ["waypointQuestion", confirmation.shape.waypoints.element.shape.question],
    ["waypointQuestion", changes.shape.newWaypoints.element.shape.question],
    ["waypointQuestion", fog.shape.fogForPerson.element.shape.question],
    ["waypointQuestion", consistency.shape.question],
    ["waypointQuestion", specReview.shape.findings.element.shape.question],
    ["waypointQuestion", hatchChanges[1].shape.question],
    ["resolution", waypointResolution(limits).shape.resolution],
    ["gist", waypointResolution(limits).shape.gist],
    ["gist", report.shape.gist.unwrap()],
    ["gist", task.shape.done.unwrap().shape.gist],
    ["gist", hatchChanges[5].shape.gist],
    ["agentDecided", waypointResolution(limits).shape.agentDecided.element],
    ["agentDecided", task.shape.done.unwrap().shape.agentDecided.element],
    ["mapLine", confirmation.shape.fog.element],
    ["mapLine", confirmation.shape.outOfScope.element],
    ["mapLine", changes.shape.newFog.element],
    ["mapLine", changes.shape.fogOutOfScope.element.shape.line],
    ["mapLine", fog.shape.fogOutOfScope.element.shape.line],
    ["mapLine", grillOutcome(limits).shape.outOfScope.unwrap().shape.reason],
    ["mapLine", hatchChanges[3].shape.reason],
    ["findingExplanation", consistency.shape.explanation],
    ["findingExplanation", specReview.shape.findings.element.shape.explanation],
    ["researchSummary", report.shape.summary],
    ["researchFindingTitle", report.shape.findings.element.shape.title],
    ["researchFindingDetail", report.shape.findings.element.shape.detail],
    ["researchSourceTitle", report.shape.sources.element.shape.title],
    ["researchExcerpt", report.shape.sources.element.shape.excerpt],
    ["researchNote", report.shape.gap.unwrap()],
    ["researchNote", report.shape.limitations.element],
    ["researchNote", report.shape.uncertainties.element],
    ["taskAction", task.shape.done.unwrap().shape.action],
    ["taskAction", task.shape.failed.unwrap().shape.action],
    ["taskFacts", task.shape.done.unwrap().shape.facts],
    ["taskFacts", task.shape.failed.unwrap().shape.facts],
    ["surveyText", area.shape.role],
    ["surveyText", area.shape.why],
    ["surveyText", area.shape.facts.element.shape.claim],
    ["surveyText", identifier.shape.meaning],
    ["surveyText", survey.shape.unverifiable.element],
    ["surveyText", transition.shape.by],
    ["surveyText", terminal.shape.exits],
    ["surveyText", specReview.shape.verified.element.shape.answer],
    ["surveyName", identifier.shape.name],
    ["surveyName", lifecycle.shape.record],
    ["surveyName", lifecycle.shape.states.element],
    ["surveyName", transition.shape.from],
    ["surveyName", transition.shape.to],
    ["surveyName", terminal.shape.state],
    ["hatchReply", hatchOutcome(limits).shape.reply],
    ["waitNote", draftSpecsOutcome(limits).shape.waits.element.shape.note],
    ["specTitle", revision.shape.title],
    ["specProse", revision.shape.problem],
    ["specProse", revision.shape.solution],
    ["clauseTitle", clause.shape.title],
    ["clauseText", clause.shape.text],
    ["criterionText", clause.shape.criteria.element.shape.text],
    ["clauseName", clause.shape.reliesOn.element.shape.name],
    ["clauseName", clause.shape.adds.element],
    ["contentLine", revision.shape.outOfScope.element],
    ["contentLine", ticket.shape.blockedBy.element.shape.supplies],
    ["contentLine", ticket.shape.testing.element],
    ["contentLine", ticket.shape.outOfScope.element],
    ["removalReason", reviseSpecOutcome(limits).shape.removed.element.shape.reason],
    ["ticketTitle", ticket.shape.title],
    ["ticketBuild", ticket.shape.build],
    ["dispositionText", dispositions[0].shape.reason.unwrap()],
    ["dispositionText", dispositions[1].shape.evidence],
    ["dispositionText", dispositions[4].shape.reason],
    ["ticketSetSlicing", ticketSet.shape.slicing],
    ["ticketSetExecution", ticketSet.shape.execution],
    ["specReviewSummary", specReview.shape.summary],
    ["ticketsReviewSummary", ticketsReviewOutcome(limits).shape.summary],
    ["ticketsReviewFindingTitle", ticketsReview.shape.title],
    ["ticketsReviewFindingExplanation", ticketsReview.shape.explanation],
    ["ticketsReviewFindingQuestion", ticketsReview.shape.question],
  ];

  test("every field has a distinct max below its stored cap", () => {
    const maxes = Object.values(limits).map((limit) => limit.max);
    expect(new Set(maxes).size).toBe(maxes.length);
    for (const field of ModelLimits.keyof().options) {
      expect(limits[field].max).toBeLessThan(MODEL_LIMIT_STORED_CAPS[field]);
      expect(fields.some(([named]) => named === field)).toBe(true);
    }
  });

  test.each(fields)("%s accepts its max and refuses one more", (field, schema) => {
    const { max } = limits[field];
    expect(schema.safeParse(text(max)).success).toBe(true);
    expect(schema.safeParse(text(max + 1)).success).toBe(false);
  });

  test("the stored hatch change reads back what any model's limits allow", () => {
    const fogDecided = [{ position: 1, title: "Flags", resolution: text(4000), gist: "Flags" }];
    const fog = { ...noChanges, fogDecided };
    const change = { kind: "accept_report", waypoint: 1, gist: "Done", fog };
    expect(STORED_LIMITS.resolution.max).toBe(4000);
    expect(HatchChange.safeParse(change).success).toBe(true);
    expect(hatchOutcome(limits).safeParse({ reply: "Done.", change }).success).toBe(false);
  });
});

describe("MapRound", () => {
  const answered = {
    questions: round.questions,
    answers: [{ optionIndex: 0, note: "", accepted: true }],
    final: false,
  };

  test("parses an answered round and a pending one with null answers", () => {
    expect(MapRound.safeParse(answered).success).toBe(true);
    expect(MapRound.safeParse({ ...answered, answers: null }).success).toBe(true);
  });

  test("refuses a round without final", () => {
    const withoutFinal = { questions: answered.questions, answers: answered.answers };
    expect(MapRound.safeParse(withoutFinal).success).toBe(false);
  });
});

describe("requests that do not carry the destination's rounds", () => {
  /** The keys a schema refused as unrecognized when parsing `value`. */
  function refusedKeys(schema: z.ZodType, value: unknown): string[] {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      return [];
    }
    return parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys : [],
    );
  }

  test.each([
    ["SurveyCodeRequest", SurveyCodeRequest],
    ["DraftTicketSetRequest", DraftTicketSetRequest],
    ["ReviewTicketSetRequest", ReviewTicketSetRequest],
    ["ImplementRequest", ImplementRequest],
    ["ReviewRequest", ReviewRequest],
    ["PullRequestRequest", PullRequestRequest],
  ])("%s refuses a mapRounds key", (_name, schema) => {
    expect(schema.safeParse({ mapRounds: [] }).success).toBe(false);
    expect(refusedKeys(schema, { mapRounds: [] })).toEqual(["mapRounds"]);
  });

  test.each([
    ["GrillWaypointRequest", GrillWaypointRequest],
    ["ResearchWaypointRequest", ResearchWaypointRequest],
    ["WorkTaskRequest", WorkTaskRequest],
    ["SettleFogRequest", SettleFogRequest],
    ["CheckConsistencyRequest", CheckConsistencyRequest],
    ["DraftSpecsRequest", DraftSpecsRequest],
    ["ReviseSpecRequest", ReviseSpecRequest],
    ["ReviewSpecRequest", ReviewSpecRequest],
    ["ReplyThroughHatchRequest", ReplyThroughHatchRequest],
  ])("%s takes a mapRounds key", (_name, schema) => {
    expect(refusedKeys(schema, { mapRounds: [] })).toEqual([]);
  });
});

describe("chartStep", () => {
  const answered = (final: boolean) => ({
    questions: round.questions,
    answers: [{ optionIndex: 0, note: "", accepted: true }],
    final,
  });

  test.each([
    ["no round", [], "propose"],
    ["one non-final round", [answered(false)], "choose"],
    ["two non-final rounds", [answered(false), answered(false)], "choose"],
    ["two rounds with a final second", [answered(false), answered(true)], "confirm"],
    ["three non-final rounds", [answered(false), answered(false), answered(false)], "confirm"],
    [
      "three rounds with a final third",
      [answered(false), answered(false), answered(true)],
      "confirm",
    ],
  ])("%s is %s", (_case, rounds, step) => {
    expect(chartStep(rounds)).toBe(step);
  });

  test("the cap is 3 rounds, a follow-up 1 to 3 questions", () => {
    expect(DESTINATION_ROUNDS_MAX_COUNT).toBe(3);
    expect(DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT).toBe(3);
  });

  test("a list holding a pending round throws", () => {
    expect(() => chartStep([answered(false), { ...answered(false), answers: null }])).toThrow();
  });
});

describe("isLastMapRound", () => {
  test.each([
    [1, false, false],
    [2, false, false],
    [2, true, true],
    [3, false, true],
    [3, true, true],
  ])("round %i with final %s is last: %s", (number, final, last) => {
    expect(isLastMapRound({ number, final })).toBe(last);
  });
});

describe("ChartMapRequest's proposed", () => {
  const request = {
    projectName: "wordcount",
    projectFolder: "/repo/wordcount",
    baseBranch: "main",
    idea: "Let wordcount count lines or characters.",
    projectProposals: [],
    projectMaps: [],
    mapRounds: [],
    proposed: null,
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  };
  const proposed = {
    title: "Counting modes",
    summary: "Count lines or characters.",
    destination: "wordcount counts lines or characters on request.",
  };
  const answeredRound = {
    questions: round.questions,
    answers: [{ optionIndex: 0, note: "", accepted: true }],
    final: false,
  };

  test("null with no rounds, set with rounds", () => {
    expect(ChartMapRequest.safeParse(request).success).toBe(true);
    expect(
      ChartMapRequest.safeParse({ ...request, mapRounds: [answeredRound], proposed }).success,
    ).toBe(true);
  });

  test("set with no rounds, or null with rounds, fails the parse", () => {
    expect(ChartMapRequest.safeParse({ ...request, proposed }).success).toBe(false);
    expect(ChartMapRequest.safeParse({ ...request, mapRounds: [answeredRound] }).success).toBe(
      false,
    );
  });
  test("refusedAttempt carries the refused attempt's problem or null", () => {
    const refused = ChartMapRequest.shape.refusedAttempt;
    expect(refused.safeParse({ problem: "Set title and summary." }).success).toBe(true);
    expect(refused.safeParse(null).success).toBe(true);
    expect(refused.safeParse(undefined).success).toBe(false);
    expect(refused.safeParse({ problem: "" }).success).toBe(false);
    const { refusedAttempt, ...withoutRefused } = request;
    expect(refusedAttempt).toBeNull();
    expect(ChartMapRequest.safeParse(withoutRefused).success).toBe(false);
  });
});

describe("chartFollowUp", () => {
  const ChartFollowUp = chartFollowUp(LIMITS);
  const followUp = (count: number) => ({
    title: "Counting modes",
    summary: "Count lines or characters.",
    destination: "wordcount counts lines, characters or words on request.",
    round: {
      intro: "I now propose: lines, characters or words.",
      final: true,
      questions: Array.from({ length: count }, () => round.questions[0]),
    },
  });

  test("takes 1 to 3 questions", () => {
    expect(ChartFollowUp.safeParse(followUp(1)).success).toBe(true);
    expect(ChartFollowUp.safeParse(followUp(3)).success).toBe(true);
    expect(ChartFollowUp.safeParse(followUp(0)).success).toBe(false);
    expect(ChartFollowUp.safeParse(followUp(4)).success).toBe(false);
  });

  test("requires final", () => {
    const { round: withFinal, ...reading } = followUp(1);
    const withoutFinal = { intro: withFinal.intro, questions: withFinal.questions };
    expect(ChartFollowUp.safeParse({ ...reading, round: withoutFinal }).success).toBe(false);
  });
});
