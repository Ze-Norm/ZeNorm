import { describe, expect, test } from "vitest";

import { z } from "zod";

import {
  Answer,
  CreateMapInput,
  CreateProjectInput,
  DELIVERY_CHECK_TIMEOUT_MINUTES_LIMIT,
  DELIVERY_ORCHESTRATOR_MAX_TURNS_LIMIT,
  DELIVERY_ORCHESTRATOR_TIMEOUT_MINUTES_LIMIT,
  DELIVERY_REVIEWER_MAX_TURNS_LIMIT,
  DELIVERY_REVIEWER_TIMEOUT_MINUTES_LIMIT,
  DeliveryConfig,
  DomainCode,
  InstanceConfig,
  MAP_IDEA_MAX_LENGTH,
  MODEL_LIMIT_STORED_CAPS,
  MapRecord,
  PlanningRunFailureCode,
  Project,
  ProjectInspection,
  QuestionRound,
  questionRoundDraft,
  REJECTION_REASON_MAX_LENGTH,
  RejectionReason,
  SpecDecisionErrorCode,
  SubmitAnswersInput,
  MapOverviewDetail,
  NextActionLabel,
  TicketSetDecisionErrorCode,
  TicketSetReview,
  TicketSetView,
  WayfindingWaypoint,
} from "./index.ts";
import { LIMITS } from "./limits.fixture.ts";

const QuestionRoundDraft = questionRoundDraft(LIMITS);

const validInput = { folderPath: "/repos/zenorm", baseBranch: "main" };
const validProject = {
  id: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e70",
  name: "zenorm",
  folderPath: "/repos/zenorm",
  baseBranch: "main",
  requiredChecks: ["pnpm test"],
  repairLimit: 2,
  fixCommands: ["pnpm format"],
  createdAt: "2026-10-07T12:00:00.000Z",
  folder: "present",
  startDeliveryBlockers: [],
  activeRun: null,
};
const opusLimits = {
  questionText: { aim: 200, max: 200 },
  questionTopic: { aim: 80, max: 80 },
  optionDetail: { aim: 180, max: 200 },
  optionLabel: { aim: 80, max: 80 },
  roundIntro: { aim: 250, max: 300 },
  mapTitle: { aim: 120, max: 120 },
  mapSummary: { aim: 1000, max: 1000 },
  destination: { aim: 1000, max: 1000 },
  waypointTitle: { aim: 120, max: 120 },
  waypointQuestion: { aim: 1000, max: 1000 },
  resolution: { aim: 700, max: 1000 },
  gist: { aim: 200, max: 200 },
  agentDecided: { aim: 120, max: 200 },
  mapLine: { aim: 500, max: 500 },
  findingExplanation: { aim: 4000, max: 4000 },
  researchSummary: { aim: 4000, max: 4000 },
  researchFindingTitle: { aim: 120, max: 120 },
  researchFindingDetail: { aim: 2000, max: 2000 },
  researchSourceTitle: { aim: 200, max: 200 },
  researchExcerpt: { aim: 2000, max: 2000 },
  researchNote: { aim: 1000, max: 1000 },
  taskAction: { aim: 1000, max: 1000 },
  taskFacts: { aim: 4000, max: 4000 },
  surveyText: { aim: 400, max: 400 },
  surveyName: { aim: 200, max: 200 },
  hatchReply: { aim: 2000, max: 2000 },
  waitNote: { aim: 4000, max: 4000 },
  specTitle: { aim: 120, max: 120 },
  specProse: { aim: 500, max: 600 },
  clauseTitle: { aim: 120, max: 120 },
  clauseText: { aim: 350, max: 500 },
  criterionText: { aim: 500, max: 500 },
  clauseName: { aim: 200, max: 200 },
  contentLine: { aim: 500, max: 500 },
  removalReason: { aim: 300, max: 300 },
  ticketTitle: { aim: 90, max: 120 },
  ticketBuild: { aim: 1000, max: 2500 },
  dispositionText: { aim: 1000, max: 1000 },
  ticketSetSlicing: { aim: 2000, max: 2000 },
  ticketSetExecution: { aim: 1000, max: 1000 },
  specReviewSummary: { aim: 800, max: 1500 },
  ticketsReviewSummary: { aim: 800, max: 1500 },
  ticketsReviewFindingTitle: { aim: 120, max: 120 },
  ticketsReviewFindingExplanation: { aim: 1000, max: 1000 },
  ticketsReviewFindingQuestion: { aim: 500, max: 500 },
};
const validConfig = {
  server: { host: "127.0.0.1", port: 4310 },
  dataDir: "/var/zenorm",
  agent: {
    claudePath: "/usr/local/bin/claude",
    wayfindingModel: "claude-opus-5-5",
    specModel: "claude-sonnet-5-5",
    models: { "claude-opus-5-5": opusLimits, "claude-sonnet-5-5": LIMITS },
    effort: "medium",
    maxTurns: 12,
    timeoutSeconds: 240,
  },
  delivery: {
    model: "claude-sonnet-5-5",
    effort: "medium",
    orchestratorMaxTurns: 200,
    orchestratorTimeoutMinutes: 120,
    reviewerMaxTurns: 40,
    reviewerTimeoutMinutes: 20,
    checkTimeoutMinutes: 10,
    executor: "local",
  },
  plugins: {},
};
const PROJECT_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e6f";
const ROUND_ID = "0199b8a0-5c6e-7d2a-9f3b-6f5e4d3c2b1a";

function issues(result: {
  success: boolean;
  error?: { issues: { code: string; path: PropertyKey[] }[] };
}) {
  expect(result.success).toBe(false);
  if (result.error === undefined) {
    throw new Error("expected a validation error");
  }
  return result.error.issues.map((issue) => ({ code: issue.code, path: issue.path }));
}

describe("CreateProjectInput", () => {
  test("accepts a folder and a base branch", () => {
    expect(CreateProjectInput.safeParse(validInput)).toEqual({ success: true, data: validInput });
  });

  test("refuses a name key: the name derives from the folder", () => {
    expect(issues(CreateProjectInput.safeParse({ ...validInput, name: "ZeNorm" }))).toEqual([
      { code: "unrecognized_keys", path: [] },
    ]);
  });

  test.each(["repos/zenorm", "./zenorm", "~/zenorm", ""])(
    "rejects the relative path %j",
    (folderPath) => {
      expect(issues(CreateProjectInput.safeParse({ ...validInput, folderPath }))).toEqual([
        { code: "custom", path: ["folderPath"] },
      ]);
    },
  );

  test("rejects an empty branch", () => {
    expect(issues(CreateProjectInput.safeParse({ ...validInput, baseBranch: "" }))).toEqual([
      { code: "too_small", path: ["baseBranch"] },
    ]);
  });

  test("rejects a missing field", () => {
    const withoutBranch = { folderPath: validInput.folderPath };
    expect(issues(CreateProjectInput.safeParse(withoutBranch))).toEqual([
      { code: "invalid_type", path: ["baseBranch"] },
    ]);
  });
});

describe("Project", () => {
  test("accepts a project with its derived fields", () => {
    expect(Project.safeParse(validProject).success).toBe(true);
  });

  test("accepts a 150-character derived name, as a folder's last segment may be", () => {
    const name = "a".repeat(150);
    expect(Project.safeParse({ ...validProject, name }).success).toBe(true);
    const inspection = {
      folderPath: `/repos/${name}`,
      name,
      detectedBaseBranch: "main",
      hasCommit: true,
    };
    expect(ProjectInspection.safeParse(inspection).success).toBe(true);
  });

  test("refuses an unknown folder value", () => {
    expect(issues(Project.safeParse({ ...validProject, folder: "moved" }))).toEqual([
      { code: "invalid_value", path: ["folder"] },
    ]);
  });

  test("accepts every blocker with the active run it names", () => {
    const project = {
      ...validProject,
      requiredChecks: [],
      repairLimit: null,
      fixCommands: [],
      startDeliveryBlockers: [
        "project_checks_missing",
        "project_repair_limit_missing",
        "delivery_in_progress",
      ],
      activeRun: {
        runId: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e71",
        mapId: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e72",
        specNumber: 2,
        specTitle: "Search everything",
      },
    };
    expect(Project.safeParse(project).success).toBe(true);
  });

  test("refuses an unknown start delivery blocker", () => {
    const project = { ...validProject, startDeliveryBlockers: ["ticket_set_not_approved"] };
    expect(issues(Project.safeParse(project))).toEqual([
      { code: "invalid_value", path: ["startDeliveryBlockers", 0] },
    ]);
  });
});

describe("InstanceConfig", () => {
  test("plugins is required and holds any sections, parsed later by each plugin", () => {
    const withoutPlugins = Object.fromEntries(
      Object.entries(validConfig).filter(([key]) => key !== "plugins"),
    );
    expect(InstanceConfig.safeParse(withoutPlugins).success).toBe(false);
    expect(
      InstanceConfig.safeParse({ ...validConfig, plugins: { example: { denied: ["a"] } } }).success,
    ).toBe(true);
  });

  test("delivery.executor is a non-empty name", () => {
    const config = { ...validConfig, delivery: { ...validConfig.delivery, executor: "" } };
    expect(InstanceConfig.safeParse(config).success).toBe(false);
  });

  test("accepts a complete config", () => {
    expect(InstanceConfig.safeParse(validConfig).success).toBe(true);
  });

  test("rejects an unknown top-level key", () => {
    expect(issues(InstanceConfig.safeParse({ ...validConfig, extra: true }))).toEqual([
      { code: "unrecognized_keys", path: [] },
    ]);
  });

  test("rejects an unknown nested key", () => {
    const config = { ...validConfig, server: { ...validConfig.server, tls: false } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "unrecognized_keys", path: ["server"] },
    ]);
  });

  test("rejects a missing top-level key", () => {
    const config = {
      server: validConfig.server,
      agent: validConfig.agent,
      delivery: validConfig.delivery,
      plugins: validConfig.plugins,
    };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["dataDir"] },
    ]);
  });

  test("rejects a missing nested key", () => {
    const config = { ...validConfig, server: { host: "127.0.0.1" } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["server", "port"] },
    ]);
  });

  test("rejects a mistyped port", () => {
    const config = { ...validConfig, server: { ...validConfig.server, port: "4310" } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["server", "port"] },
    ]);
  });

  test("rejects a relative dataDir", () => {
    expect(issues(InstanceConfig.safeParse({ ...validConfig, dataDir: "data" }))).toEqual([
      { code: "custom", path: ["dataDir"] },
    ]);
  });
});

describe("InstanceConfig agent section", () => {
  test("rejects a config without the agent section", () => {
    const config = {
      server: validConfig.server,
      dataDir: validConfig.dataDir,
      delivery: validConfig.delivery,
      plugins: validConfig.plugins,
    };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["agent"] },
    ]);
  });

  test.each([
    { key: "claudePath", code: "invalid_type" },
    { key: "wayfindingModel", code: "invalid_type" },
    { key: "specModel", code: "invalid_type" },
    { key: "models", code: "invalid_type" },
    // Zod reports a missing enum value as `invalid_value`.
    { key: "effort", code: "invalid_value" },
    { key: "maxTurns", code: "invalid_type" },
    { key: "timeoutSeconds", code: "invalid_type" },
  ])("rejects a missing agent.$key", ({ key, code }) => {
    const agent = Object.fromEntries(
      Object.entries(validConfig.agent).filter(([name]) => name !== key),
    );
    expect(issues(InstanceConfig.safeParse({ ...validConfig, agent }))).toEqual([
      { code, path: ["agent", key] },
    ]);
  });

  test("rejects the old single agent.model: both new keys missing, model unknown", () => {
    const { claudePath, models, effort, maxTurns, timeoutSeconds } = validConfig.agent;
    const agent = {
      claudePath,
      model: "claude-sonnet-5-5",
      models,
      effort,
      maxTurns,
      timeoutSeconds,
    };
    const config = { ...validConfig, agent };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["agent", "wayfindingModel"] },
      { code: "invalid_type", path: ["agent", "specModel"] },
      { code: "unrecognized_keys", path: ["agent"] },
    ]);
  });

  test("rejects an unknown key in the agent section", () => {
    const config = { ...validConfig, agent: { ...validConfig.agent, apiKey: "x" } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "unrecognized_keys", path: ["agent"] },
    ]);
  });

  test("rejects a relative claudePath", () => {
    const config = { ...validConfig, agent: { ...validConfig.agent, claudePath: "claude" } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "custom", path: ["agent", "claudePath"] },
    ]);
  });

  test("rejects an unknown effort", () => {
    const config = { ...validConfig, agent: { ...validConfig.agent, effort: "extreme" } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_value", path: ["agent", "effort"] },
    ]);
  });

  test.each([
    { key: "maxTurns", value: 0, code: "too_small" },
    { key: "maxTurns", value: 51, code: "too_big" },
    { key: "timeoutSeconds", value: 0, code: "too_small" },
    { key: "timeoutSeconds", value: 241, code: "too_big" },
  ])("rejects agent.$key of $value", ({ key, value, code }) => {
    const config = { ...validConfig, agent: { ...validConfig.agent, [key]: value } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([{ code, path: ["agent", key] }]);
  });

  test.each([
    { key: "maxTurns", value: 50 },
    { key: "timeoutSeconds", value: 240 },
  ])("accepts agent.$key at its maximum $value", ({ key, value }) => {
    const config = { ...validConfig, agent: { ...validConfig.agent, [key]: value } };
    expect(InstanceConfig.safeParse(config).success).toBe(true);
  });
});

describe("InstanceConfig agent.models", () => {
  const withAgent = (agent: object) => ({
    ...validConfig,
    agent: { ...validConfig.agent, ...agent },
  });
  const withLimits = (field: string, limit: object) =>
    withAgent({
      models: { ...validConfig.agent.models, "claude-opus-5-5": { ...opusLimits, [field]: limit } },
    });

  test.each([
    { key: "wayfindingModel", model: "claude-opus-5-5" },
    { key: "specModel", model: "claude-sonnet-5-5" },
  ])("rejects agent.$key with no entry", ({ model }) => {
    const models = Object.fromEntries(
      Object.entries(validConfig.agent.models).filter(([name]) => name !== model),
    );
    expect(issues(InstanceConfig.safeParse(withAgent({ models })))).toEqual([
      { code: "custom", path: ["agent", "models", model] },
    ]);
  });

  test("rejects a model both keys name once when it has no entry", () => {
    const config = withAgent({
      specModel: "claude-haiku-5-5",
      wayfindingModel: "claude-haiku-5-5",
    });
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "custom", path: ["agent", "models", "claude-haiku-5-5"] },
    ]);
  });

  test("accepts an entry for a model no key names", () => {
    const models = { ...validConfig.agent.models, "claude-haiku-5-5": LIMITS };
    expect(InstanceConfig.safeParse(withAgent({ models })).success).toBe(true);
  });

  test("rejects an aim above its max", () => {
    const config = withLimits("clauseText", { aim: 501, max: 500 });
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "custom", path: ["agent", "models", "claude-opus-5-5", "clauseText", "aim"] },
    ]);
  });

  test.each(Object.keys(MODEL_LIMIT_STORED_CAPS))("rejects an entry missing %s", (field) => {
    const entry = Object.fromEntries(
      Object.entries(opusLimits).filter(([named]) => named !== field),
    );
    const config = withAgent({
      models: { ...validConfig.agent.models, "claude-opus-5-5": entry },
    });
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["agent", "models", "claude-opus-5-5", field] },
    ]);
  });

  test.each(Object.entries(MODEL_LIMIT_STORED_CAPS))(
    "rejects %s's aim above its max",
    (field, cap) => {
      expect(
        issues(InstanceConfig.safeParse(withLimits(field, { aim: cap, max: cap - 1 }))),
      ).toEqual([{ code: "custom", path: ["agent", "models", "claude-opus-5-5", field, "aim"] }]);
    },
  );

  test("every field the Sonnet and Opus profiles carry is a ModelLimits key", () => {
    expect(Object.keys(opusLimits).sort()).toEqual(Object.keys(MODEL_LIMIT_STORED_CAPS).sort());
    expect(Object.keys(LIMITS).sort()).toEqual(Object.keys(MODEL_LIMIT_STORED_CAPS).sort());
  });

  test.each(Object.entries(MODEL_LIMIT_STORED_CAPS))(
    "accepts %s's max at its stored cap and rejects one above",
    (field, cap) => {
      expect(InstanceConfig.safeParse(withLimits(field, { aim: 1, max: cap })).success).toBe(true);
      expect(issues(InstanceConfig.safeParse(withLimits(field, { aim: 1, max: cap + 1 })))).toEqual(
        [{ code: "custom", path: ["agent", "models", "claude-opus-5-5", field, "max"] }],
      );
    },
  );

  test("rejects an entry missing a field, with an unknown field, or a length below 1", () => {
    const missing = Object.fromEntries(
      Object.entries(opusLimits).filter(([field]) => field !== "ticketBuild"),
    );
    const models = (entry: object) =>
      withAgent({ models: { ...validConfig.agent.models, "claude-opus-5-5": entry } });
    expect(issues(InstanceConfig.safeParse(models(missing)))).toEqual([
      { code: "invalid_type", path: ["agent", "models", "claude-opus-5-5", "ticketBuild"] },
    ]);
    expect(
      issues(
        InstanceConfig.safeParse(models({ ...opusLimits, verdictSummary: { aim: 1, max: 1 } })),
      ),
    ).toEqual([{ code: "unrecognized_keys", path: ["agent", "models", "claude-opus-5-5"] }]);
    expect(
      issues(InstanceConfig.safeParse(withLimits("resolution", { aim: 0, max: 800 }))),
    ).toEqual([
      { code: "too_small", path: ["agent", "models", "claude-opus-5-5", "resolution", "aim"] },
    ]);
    expect(issues(InstanceConfig.safeParse(withLimits("resolution", { aim: 700 })))).toEqual([
      { code: "invalid_type", path: ["agent", "models", "claude-opus-5-5", "resolution", "max"] },
    ]);
  });
});

describe("InstanceConfig delivery section", () => {
  test("rejects a config without the delivery section", () => {
    const config = {
      server: validConfig.server,
      dataDir: validConfig.dataDir,
      agent: validConfig.agent,
      plugins: validConfig.plugins,
    };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["delivery"] },
    ]);
  });

  test.each([
    { key: "model", code: "invalid_type" },
    // Zod reports a missing enum value as `invalid_value`.
    { key: "effort", code: "invalid_value" },
    { key: "orchestratorMaxTurns", code: "invalid_type" },
    { key: "orchestratorTimeoutMinutes", code: "invalid_type" },
    { key: "reviewerMaxTurns", code: "invalid_type" },
    { key: "reviewerTimeoutMinutes", code: "invalid_type" },
    { key: "checkTimeoutMinutes", code: "invalid_type" },
    { key: "executor", code: "invalid_type" },
  ])("rejects a missing delivery.$key", ({ key, code }) => {
    const delivery = Object.fromEntries(
      Object.entries(validConfig.delivery).filter(([name]) => name !== key),
    );
    expect(issues(DeliveryConfig.safeParse(delivery))).toEqual([{ code, path: [key] }]);
    expect(issues(InstanceConfig.safeParse({ ...validConfig, delivery }))).toEqual([
      { code, path: ["delivery", key] },
    ]);
  });

  test("rejects an unknown key in the delivery section", () => {
    const delivery = { ...validConfig.delivery, apiKey: "x" };
    expect(issues(DeliveryConfig.safeParse(delivery))).toEqual([
      { code: "unrecognized_keys", path: [] },
    ]);
  });

  const limits = [
    { key: "orchestratorMaxTurns", max: DELIVERY_ORCHESTRATOR_MAX_TURNS_LIMIT },
    { key: "orchestratorTimeoutMinutes", max: DELIVERY_ORCHESTRATOR_TIMEOUT_MINUTES_LIMIT },
    { key: "reviewerMaxTurns", max: DELIVERY_REVIEWER_MAX_TURNS_LIMIT },
    { key: "reviewerTimeoutMinutes", max: DELIVERY_REVIEWER_TIMEOUT_MINUTES_LIMIT },
    { key: "checkTimeoutMinutes", max: DELIVERY_CHECK_TIMEOUT_MINUTES_LIMIT },
  ];

  test("the limits are the spec's", () => {
    expect(limits.map(({ max }) => max)).toEqual([1000, 480, 200, 120, 120]);
  });

  test.each(limits)("rejects delivery.$key of 0", ({ key }) => {
    const delivery = { ...validConfig.delivery, [key]: 0 };
    expect(issues(DeliveryConfig.safeParse(delivery))).toEqual([
      { code: "too_small", path: [key] },
    ]);
  });

  test.each(limits)("rejects delivery.$key of $max + 1", ({ key, max }) => {
    const delivery = { ...validConfig.delivery, [key]: max + 1 };
    expect(issues(DeliveryConfig.safeParse(delivery))).toEqual([{ code: "too_big", path: [key] }]);
  });

  test.each(limits)("accepts delivery.$key at 1 and at $max", ({ key, max }) => {
    for (const value of [1, max]) {
      const delivery = { ...validConfig.delivery, [key]: value };
      expect(DeliveryConfig.safeParse(delivery).success).toBe(true);
    }
  });
});

describe("CreateMapInput", () => {
  test("accepts a valid input and trims the idea", () => {
    const result = CreateMapInput.safeParse({ projectId: PROJECT_ID, idea: "  Add a map  " });
    expect(result.success).toBe(true);
    expect(result.data?.idea).toBe("Add a map");
  });

  test("accepts an idea of exactly the maximum length", () => {
    const idea = "a".repeat(MAP_IDEA_MAX_LENGTH);
    expect(CreateMapInput.safeParse({ projectId: PROJECT_ID, idea }).success).toBe(true);
  });

  test.each(["", "   "])("rejects the blank idea %j", (idea) => {
    expect(issues(CreateMapInput.safeParse({ projectId: PROJECT_ID, idea }))).toEqual([
      { code: "too_small", path: ["idea"] },
    ]);
  });

  test("rejects an idea over the maximum length", () => {
    const idea = "a".repeat(MAP_IDEA_MAX_LENGTH + 1);
    expect(issues(CreateMapInput.safeParse({ projectId: PROJECT_ID, idea }))).toEqual([
      { code: "too_big", path: ["idea"] },
    ]);
  });

  test.each(["not-a-uuid", "0199b8a0-5c6e-4d2a-9f3b-1a2b3c4d5e6f"])(
    "rejects the non-UUIDv7 projectId %j",
    (projectId) => {
      expect(issues(CreateMapInput.safeParse({ projectId, idea: "An idea" }))).toEqual([
        { code: "invalid_format", path: ["projectId"] },
      ]);
    },
  );
});

describe("SubmitAnswersInput", () => {
  test("accepts answers and trims each note", () => {
    const result = SubmitAnswersInput.safeParse({
      roundId: ROUND_ID,
      answers: [
        { optionIndex: 0, note: "", accepted: true },
        { optionIndex: null, note: "  my words  ", accepted: false },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.answers[1]?.note).toBe("my words");
  });

  test.each([
    { optionIndex: -1, code: "too_small" },
    { optionIndex: 1.5, code: "invalid_type" },
  ])("rejects optionIndex $optionIndex", ({ optionIndex, code }) => {
    const input = { roundId: ROUND_ID, answers: [{ optionIndex, note: "", accepted: false }] };
    expect(issues(SubmitAnswersInput.safeParse(input))).toEqual([
      { code, path: ["answers", 0, "optionIndex"] },
    ]);
  });

  test("Answer trims its note", () => {
    expect(Answer.parse({ optionIndex: null, note: "\n words \t", accepted: false }).note).toBe(
      "words",
    );
  });

  test("Answer requires accepted", () => {
    expect(issues(Answer.safeParse({ optionIndex: 0, note: "" }))).toEqual([
      { code: "invalid_type", path: ["accepted"] },
    ]);
  });
});

describe("QuestionRoundDraft", () => {
  const option = { label: "Yes", detail: "Gives this, costs that." };
  const question = { topic: "Scope", text: "What is in scope?", options: [option, option] };
  const draft = { intro: "A few questions.", questions: [question] };

  test("accepts a valid draft", () => {
    expect(QuestionRoundDraft.safeParse(draft).success).toBe(true);
  });

  test.each([
    { count: 0, code: "too_small" },
    { count: 6, code: "too_big" },
  ])("rejects $count questions", ({ count, code }) => {
    const questions = Array.from({ length: count }, () => question);
    expect(issues(QuestionRoundDraft.safeParse({ ...draft, questions }))).toEqual([
      { code, path: ["questions"] },
    ]);
  });

  test.each([
    { count: 1, code: "too_small" },
    { count: 5, code: "too_big" },
  ])("rejects $count options", ({ count, code }) => {
    const options = Array.from({ length: count }, () => option);
    const questions = [{ ...question, options }];
    expect(issues(QuestionRoundDraft.safeParse({ ...draft, questions }))).toEqual([
      { code, path: ["questions", 0, "options"] },
    ]);
  });

  test("rejects an empty option label", () => {
    const questions = [{ ...question, options: [option, { ...option, label: "" }] }];
    expect(issues(QuestionRoundDraft.safeParse({ ...draft, questions }))).toEqual([
      { code: "too_small", path: ["questions", 0, "options", 1, "label"] },
    ]);
  });

  test("rejects an unknown key", () => {
    expect(issues(QuestionRoundDraft.safeParse({ ...draft, recommendation: 0 }))).toEqual([
      { code: "unrecognized_keys", path: [] },
    ]);
  });

  test("converts to a draft-07 JSON Schema that forbids extra properties", () => {
    const schema = z.toJSONSchema(QuestionRoundDraft, { target: "draft-07" });
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("RejectionReason", () => {
  test("trims the reason", () => {
    expect(RejectionReason.parse("  Too broad.  ")).toBe("Too broad.");
  });

  test("accepts a reason of exactly the maximum length", () => {
    const reason = "a".repeat(REJECTION_REASON_MAX_LENGTH);
    expect(RejectionReason.safeParse(reason).success).toBe(true);
  });

  test.each(["", "   "])("rejects the blank reason %j", (reason) => {
    expect(issues(RejectionReason.safeParse(reason))).toEqual([{ code: "too_small", path: [] }]);
  });

  test("rejects an over-long reason", () => {
    const reason = "a".repeat(REJECTION_REASON_MAX_LENGTH + 1);
    expect(issues(RejectionReason.safeParse(reason))).toEqual([{ code: "too_big", path: [] }]);
  });
});

describe("PlanningRunFailureCode", () => {
  test("is a domain code throughout", () => {
    for (const code of PlanningRunFailureCode.options) {
      expect(DomainCode.options).toContain(code);
    }
  });

  test("carries the spec and ticket outputs' refusals and a missing skill", () => {
    for (const code of [
      "agent_skill_missing",
      "spec_content_invalid",
      "ticket_set_content_invalid",
      "review_reference_unknown",
    ]) {
      expect(PlanningRunFailureCode.options).toContain(code);
    }
  });
});

describe("decision refusals", () => {
  test("spec.approve's refusals are in the order they are checked", () => {
    expect(SpecDecisionErrorCode.options).toEqual([
      "spec_revision_not_found",
      "spec_revision_decided",
      "map_uncleared",
      "review_in_flight",
      "spec_review_not_passed",
    ]);
  });

  test("ticketSet.approve's refusals are in the order they are checked", () => {
    expect(TicketSetDecisionErrorCode.options).toEqual([
      "ticket_set_not_found",
      "ticket_set_decided",
      "revision_not_latest",
      "review_in_flight",
      "ticket_set_review_not_passed",
    ]);
  });

  test("every refusal is a domain code", () => {
    for (const code of [
      ...SpecDecisionErrorCode.options,
      ...TicketSetDecisionErrorCode.options,
      "spec_not_found",
    ]) {
      expect(DomainCode.options).toContain(code);
    }
  });
});

describe("MapRecord", () => {
  const map = {
    id: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e72",
    projectId: PROJECT_ID,
    idea: "Export data",
    title: null,
    summary: null,
    destination: null,
    destinationConfirmedAt: null,
    createdAt: "2026-10-07T12:00:00.000Z",
    splitFromMapId: null,
    splitFromRunId: null,
  };

  test("accepts an uncharted map and a charted one", () => {
    expect(MapRecord.safeParse(map).success).toBe(true);
    const charted = {
      ...map,
      title: "Data export",
      summary: "People take their data elsewhere.",
      destination: "A CSV export of every record.",
      destinationConfirmedAt: "2026-10-07T12:01:00.000Z",
    };
    expect(MapRecord.safeParse(charted).success).toBe(true);
  });
});

describe("QuestionRound and WayfindingWaypoint", () => {
  const RUN_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e73";
  const round = {
    id: ROUND_ID,
    mapId: PROJECT_ID,
    waypointId: null,
    number: 1,
    final: false,
    status: "pending",
    askedByRun: RUN_ID,
    intro: "A few questions.",
    questions: [
      {
        topic: "Scope",
        text: "What is in scope?",
        options: [
          { label: "Yes", detail: "Gives this." },
          { label: "No", detail: "Costs that." },
        ],
      },
    ],
    answers: null,
    askedAt: "2026-10-07T12:00:00.000Z",
    submittedAt: null,
    withdrawnAt: null,
    withdrawnReason: null,
  };

  test("a stored question has two to four options, never none", () => {
    const [question] = round.questions;
    if (question === undefined) throw new Error("The fixture round has no question");
    const withOptions = (count: number) => ({
      ...round,
      questions: [
        {
          ...question,
          options: Array.from({ length: count }, (_, i) => ({
            label: `Option ${String(i)}`,
            detail: "Gives this.",
          })),
        },
      ],
    });
    expect(
      [0, 1, 2, 4, 5].map((count) => QuestionRound.safeParse(withOptions(count)).success),
    ).toEqual([false, false, true, true, false]);
  });

  test("accepts a pending map-level round and refuses an unknown status", () => {
    expect(QuestionRound.safeParse(round).success).toBe(true);
    expect(issues(QuestionRound.safeParse({ ...round, status: "answered" }))).toEqual([
      { code: "invalid_value", path: ["status"] },
    ]);
  });

  test("accepts a waypoint with its blockers, rounds, records and each of its states", () => {
    const waypoint = {
      id: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e74",
      mapId: PROJECT_ID,
      number: 2,
      kind: "grilling",
      status: "open",
      title: "Which format",
      question: "Which file format should the export write?",
      claimedAt: null,
      resolution: null,
      gist: null,
      agentDecided: null,
      resolvedAt: null,
      resolvedHow: null,
      resolvedByRun: null,
      createdByRun: RUN_ID,
      hatchMessageId: null,
      personDecides: false,
      blockedBy: [1],
      rounds: [],
      reports: [
        {
          runId: RUN_ID,
          answered: false,
          summary: "The vendor's docs do not say.",
          gap: "Whether the API pages results.",
          findings: [],
          sources: [
            { kind: "external", title: "API docs", url: "https://example.com", excerpt: "…" },
          ],
          limitations: [],
          uncertainties: [],
        },
      ],
      taskOutcomes: [
        { runId: RUN_ID, outcome: "failed", action: "Read the config.", facts: "It is absent." },
      ],
      finding: {
        kind: "conflicting_surfaces",
        waypointNumbers: [1],
        explanation: "Waypoint 1 says CSV.",
      },
      reviewFinding: null,
      exclusion: null,
      state: { kind: "stopped", run: { runId: RUN_ID, code: "planning_run_interrupted" } },
      touches: [],
    };
    expect(WayfindingWaypoint.safeParse(waypoint).success).toBe(true);
    expect(
      WayfindingWaypoint.safeParse({
        ...waypoint,
        reviewFinding: {
          spec: 1,
          specTitle: "Export as CSV",
          explanation: "C1 says every record.",
          elementIds: ["C1"],
        },
      }).success,
    ).toBe(true);
    expect(
      WayfindingWaypoint.safeParse({
        ...waypoint,
        state: { kind: "waiting", run: { runId: RUN_ID, reason: "research_unanswered" } },
      }).success,
    ).toBe(true);
    expect(
      WayfindingWaypoint.safeParse({
        ...waypoint,
        state: { kind: "waiting", run: { runId: RUN_ID, reason: "stopped" } },
      }).success,
    ).toBe(false);
    expect(
      WayfindingWaypoint.safeParse({
        ...waypoint,
        taskOutcomes: [{ runId: RUN_ID, outcome: "done", action: "Read it.", facts: "" }],
      }).success,
    ).toBe(false);
    for (const kind of [
      "resolved",
      "out_of_scope",
      "waiting_on_you",
      "working",
      "waits_on_survey",
    ]) {
      expect(WayfindingWaypoint.safeParse({ ...waypoint, state: { kind } }).success).toBe(true);
    }
    expect(
      WayfindingWaypoint.safeParse({ ...waypoint, state: { kind: "blocked", waitsOn: [1] } })
        .success,
    ).toBe(true);
    // A blocked waypoint names what it waits on; a state carries only its own fields.
    expect(
      WayfindingWaypoint.safeParse({ ...waypoint, state: { kind: "blocked", waitsOn: [] } })
        .success,
    ).toBe(false);
    expect(
      WayfindingWaypoint.safeParse({ ...waypoint, state: { kind: "working", waitsOn: [1] } })
        .success,
    ).toBe(false);
    expect(WayfindingWaypoint.safeParse({ ...waypoint, state: { kind: "stopped" } }).success).toBe(
      false,
    );
    expect(WayfindingWaypoint.safeParse({ ...waypoint, state: { kind: "idle" } }).success).toBe(
      false,
    );
    // The state replaced the run.
    expect(WayfindingWaypoint.safeParse({ ...waypoint, run: "working" }).success).toBe(false);
  });
});

describe("the tickets review overview fields", () => {
  const at = "2026-10-09T12:00:00.000Z";
  const finding = {
    kind: "untraced_criterion",
    route: "revise",
    title: "Adds a CSV format",
    explanation: "No criterion states it.",
    question: "Should the export offer CSV?",
    ticketNumbers: ["T1"],
    criterionIds: ["1.1"],
  };
  const failed = { state: "findings", summary: "One finding.", reviewedAt: at };

  test("a review is held exactly when a finding escalated", () => {
    const escalated = { ...finding, escalated: true };
    const unescalated = { ...finding, escalated: false };
    const parse = (review: unknown) => TicketSetReview.safeParse(review).success;
    expect(parse({ ...failed, findings: [escalated, unescalated], held: true })).toBe(true);
    expect(parse({ ...failed, findings: [unescalated], held: false })).toBe(true);
    expect(parse({ ...failed, findings: [escalated], held: false })).toBe(false);
    expect(parse({ ...failed, findings: [unescalated], held: true })).toBe(false);
    expect(parse({ ...failed, findings: [], held: false })).toBe(false);
    expect(parse({ ...failed, findings: [{ ...unescalated, route: "later" }], held: false })).toBe(
      false,
    );
    expect(parse({ state: "pending" })).toBe(true);
    expect(parse({ state: "none" })).toBe(false);
  });

  test("a ticket set view carries its review, null for a set approved with none", () => {
    const review = TicketSetView.shape.review;
    expect(review.safeParse(null).success).toBe(true);
    expect(review.safeParse(undefined).success).toBe(false);
  });

  test("map.overview carries each spec stage's default spec, null with none", () => {
    const defaults = MapOverviewDetail.shape.defaultSpecs;
    expect(defaults.safeParse({ spec: 1, tickets: 2, delivery: null }).success).toBe(true);
    expect(defaults.safeParse({ spec: 1, tickets: 2 }).success).toBe(false);
    expect(defaults.safeParse({ spec: 0, tickets: null, delivery: null }).success).toBe(false);
  });

  test("the held row's label is a next-action label", () => {
    expect(NextActionLabel.options).toContain("Tell the agent how to fix it");
  });
});

describe("InstanceConfig fastMode", () => {
  const opusAgent = {
    ...validConfig.agent,
    wayfindingModel: "claude-opus-5-5",
    specModel: "claude-opus-5-5",
  };
  const opusDelivery = { ...validConfig.delivery, model: "claude-opus-5-5" };

  test("is optional in both sections, so a config without it loads", () => {
    expect(InstanceConfig.safeParse(validConfig).success).toBe(true);
  });

  test("accepts fast mode on with Opus planning and delivery models", () => {
    const config = {
      ...validConfig,
      agent: { ...opusAgent, fastMode: true },
      delivery: { ...opusDelivery, fastMode: true },
    };
    expect(InstanceConfig.safeParse(config).success).toBe(true);
  });

  test("accepts fast mode off with any model", () => {
    const config = {
      ...validConfig,
      agent: { ...validConfig.agent, fastMode: false },
      delivery: { ...validConfig.delivery, fastMode: false },
    };
    expect(InstanceConfig.safeParse(config).success).toBe(true);
  });

  test("rejects agent.fastMode when a planning model is not Opus", () => {
    // validConfig plans with Opus and Sonnet: one issue, for Sonnet.
    const config = { ...validConfig, agent: { ...validConfig.agent, fastMode: true } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "custom", path: ["agent", "fastMode"] },
    ]);
  });

  test("rejects delivery.fastMode when the delivery model is not Opus", () => {
    const config = { ...validConfig, delivery: { ...validConfig.delivery, fastMode: true } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "custom", path: ["delivery", "fastMode"] },
    ]);
  });

  test("rejects a fastMode that is not a boolean", () => {
    const config = { ...validConfig, delivery: { ...opusDelivery, fastMode: "yes" } };
    expect(issues(InstanceConfig.safeParse(config))).toEqual([
      { code: "invalid_type", path: ["delivery", "fastMode"] },
    ]);
  });
});
