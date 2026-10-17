import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  CodeSurvey,
  AgentConfig,
  PlanningRunConfig,
  DirectedVersion,
  DraftSpecsRequest,
  DraftTicketSetRequest,
  ReviewSpecRequest,
  ReviewTicketSetRequest,
  ReviseSpecRequest,
  SpecRevisionContent,
  SpecRevisionRef,
  TicketSetContent,
  TicketsReviewFinding,
  PlanningCallSession,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { claudeCodePlanningAgent } from "./planning-agent.ts";
import { SURVEY, SURVEY_FACTS } from "./code-survey.fixture.ts";
import {
  BUSY_READER_RULE,
  FACTS_RULE,
  INSTANCE_CONFIG_RULE,
  NO_SURVEY_LINES,
} from "./prompt-parts.ts";
import { planningSkills, SKILLS_DIR } from "./skills.ts";
import {
  SPEC_CONCISION_RULE,
  SPEC_COUNT_RULE,
  NO_WAYPOINTS_TO_CITE_LINE,
  SPEC_DECLARATION_RULE,
  SPEC_REVIEW_REPOSITORY_RULE,
  surveyItemsRule,
  SPEC_SELF_CHECK,
  REMOVED_RULE,
  WAS_RULE,
  SPEC_GROUNDING_RULE,
  SPEC_LITERAL_RULE,
  SPEC_MECHANISM_RULE,
  SPEC_REVIEW_ROUTE_RULE,
  SPEC_TRACING_RULE,
  buildDraftSpecsPrompt,
  buildDraftTicketSetPrompt,
  buildReviewSpecPrompt,
  buildReviewTicketSetPrompt,
  ticketSetShapeLine,
  buildReviseSpecPrompt,
  previousDeliveryLine,
  changesSinceLine,
  REVISION_REVIEW_RULES,
  TICKET_CONCISION_RULE,
  TICKET_SET_RULES,
  TICKET_WRITING_RULES,
  TICKETS_REVIEW_REPOSITORY_RULE,
  TICKETS_REVIEW_RULES,
  waitSourceLine,
} from "./spec-prompt.ts";
import {
  departureLine,
  earlierTicketLine,
  firstTicketNumberLine,
  latestApprovedLine,
  openWaitsLine,
  projectSpecLine,
  readingLine,
  removedCriterionLine,
  textDeltaLine,
  touchingWaypointsLine,
  touchLine,
} from "./revision-prompt-parts.ts";
import {
  draftSpecsJsonSchema,
  draftTicketSetJsonSchema,
  draftSpecsWith,
  draftTicketSetWith,
  type PlanningSkill,
  reviewSpecJsonSchema,
  reviewSpecWith,
  reviewTicketSetJsonSchema,
  reviewTicketSetWith,
  reviseSpecJsonSchema,
  reviseSpecWith,
} from "./specs.ts";
import { consistencyJsonSchema, researchJsonSchema, taskJsonSchema } from "./waypoint-runs.ts";
import {
  chartChoiceJsonSchema,
  chartConfirmationJsonSchema,
  chartProposalJsonSchema,
  grillJsonSchema,
  grillResolutionJsonSchema,
} from "./wayfinding.ts";
import {
  AIMED_LIMITS,
  boundFields,
  DISTINCT_LIMITS,
  LIMITS,
  unstatedLengths,
} from "./limits.fixture.ts";
import { expectRoundsAfterDestination, MAP_ROUNDS } from "./map-rounds.fixture.ts";

/** A cold session whose usage the test does not look at. */
const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

const IDEA = "Reject duplicate folders [fake:two-specs]\nIDEA abc>>> quoted 'like this'.";

let dir: string;
let projectFolder: string;
let skill: PlanningSkill;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-specs-")));
  projectFolder = join(dir, "project");
  mkdirSync(projectFolder);
  const skillPath = join(dir, "skills", "product-to-spec", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "# skill\n");
  skill = { name: "Product To Spec", path: skillPath };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a logged-in `#!/bin/sh` stand-in whose run records its argv and the appended system prompt
 * file's path and content, and prints `output`.
 */
function writeStandIn(output: unknown): string {
  writeFileSync(join(dir, "auth-stdout"), JSON.stringify({ loggedIn: true }));
  writeFileSync(
    join(dir, "run-stdout"),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-1",
      num_turns: 3,
      duration_ms: 1200,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
      result: "",
      structured_output: output,
    }),
  );
  const script = [
    "#!/bin/sh",
    `dir='${dir}'`,
    'if [ "$1" = "auth" ]; then',
    '  cat "$dir/auth-stdout"',
    "  exit 0",
    "fi",
    'printf \'%s\\0\' "$@" > "$dir/argv"',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--append-system-prompt-file" ]; then cat "$arg" > "$dir/system-prompt"; fi',
    '  prev="$arg"',
    "done",
    'cat "$dir/run-stdout"',
    "exit 0",
    "",
  ].join("\n");
  const path = join(dir, "claude");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

/** The repository's planning skills, which the source entries pass in. */
const PLANNING_SKILLS = planningSkills(SKILLS_DIR);

function config(claudePath: string): PlanningRunConfig {
  return {
    claudePath,
    model: "claude-sonnet-5-5",
    limits: LIMITS,
    effort: "medium",
    maxTurns: 12,
    timeoutSeconds: 30,
    sessionsDir: dir,
  };
}

function recordedArgv(): string[] {
  return readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);
}

function flag(argv: string[], name: string): string {
  const value = argv[argv.indexOf(name) + 1];
  if (value === undefined) throw new Error(`argv has no ${name}`);
  return value;
}

/** The skill folder and the system-prompt file naming the SKILL.md by absolute path, removed after. */
function expectSkillArgs(argv: string[]): void {
  expect(flag(argv, "--add-dir")).toBe(join(dir, "skills"));
  const promptFile = flag(argv, "--append-system-prompt-file");
  expect(readFileSync(join(dir, "system-prompt"), "utf8")).toContain(skill.path);
  expect(existsSync(promptFile)).toBe(false);
  expect(argv[0]).toBe("-p");
  expect(flag(argv, "--allowedTools")).toBe("Read,Grep,Glob");
}

function expectIdeaInNonceBlock(prompt: string): void {
  const match = /^<<<IDEA ([0-9a-f-]{36})$/m.exec(prompt);
  const nonce = match?.[1];
  if (nonce === undefined) throw new Error("the prompt has no IDEA start line");
  expect(prompt).toContain(`<<<IDEA ${nonce}\n${IDEA}\nIDEA ${nonce}>>>`);
}

const content: SpecRevisionContent = {
  title: "Reject duplicate and nested project folders",
  problem: "A person can add the same repository twice.",
  solution: "Adding a project compares real paths.",
  clauses: [
    {
      id: "C1",
      title: "Same folder, resolved",
      text: "Two folders are the same when their real paths match.",
      criteria: [
        { id: "1.1", text: "Adding ~/dev/app/ when ~/dev/app is a project is refused." },
        { id: "1.2", text: "Adding a symlink to a project's folder is refused." },
      ],
      sources: [{ kind: "waypoint", number: 1 }],
      reliesOn: [{ name: "addProject", path: "packages/core/src/project.ts" }],
      adds: [],
    },
    {
      id: "C2",
      title: "Nested folders are refused",
      text: "A folder inside a project is refused.",
      criteria: [{ id: "2.1", text: "Adding ~/dev/app/web is refused." }],
      sources: [{ kind: "waypoint", number: 2 }, { kind: "destination" }],
      reliesOn: [],
      adds: ["folder_nested"],
    },
  ],
  outOfScope: ["Renaming a project."],
};

const r1: SpecRevisionRef = { specNumber: 1, revision: 1, content };
const r2: SpecRevisionRef = { specNumber: 1, revision: 2, content };

const map = {
  projectName: "wordcount",
  projectFolder: "/placeholder",
  baseBranch: "main",
  idea: IDEA,
  title: "Reject duplicate folders",
  destination: "Adding a project refuses duplicates and nesting.",
  waypoints: [
    {
      number: 1,
      kind: "grilling" as const,
      title: "Same folder",
      question: "When are two folders the same?",
      resolution: "When their real paths match.",
      gist: "Real paths.",
      agentDecided: ["Compare real paths, not the names typed"],
      touches: [],
    },
    {
      number: 2,
      kind: "research" as const,
      title: "Nesting",
      question: "Is a nested folder refused?",
      resolution: "Yes, both ways.",
      gist: "Both ways.",
      agentDecided: [],
      research: {
        findings: [{ title: "Real paths nest", detail: "A real path under another is nested." }],
        sources: [
          { title: "Node fs.realpath", url: "https://nodejs.org/api/fs.html" },
          { title: "projects.ts", url: null },
        ],
      },
      touches: [],
    },
  ],
  outOfScope: ["Renaming a project."],
  waits: [],
};

const finding = {
  kind: "dropped_resolution" as const,
  route: "revise" as const,
  title: "Resolution dropped",
  explanation: "Waypoint 2 says 'both ways'; no clause refuses a parent folder.",
  question: "Should adding a parent of a project be refused?",
  elementIds: ["C2"],
  waypointNumbers: [2],
};

const set: TicketSetContent = {
  tickets: [
    {
      id: "T1",
      title: "Refuse duplicates",
      build: "Add project refuses a folder that is already a project.",
      blockedBy: [],
      criteria: ["1.1", "1.2", "2.1"],
      testing: ["Each route is refused with its code."],
      followUp: null,
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
    { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
    { criterion: "2.1", kind: "work", ticket: "T1", reason: null },
  ],
  slicing: "One ticket: the change fits one run.",
  execution: "agent-verifiable against a temporary directory.",
};

function draftSpecsRequest(): DraftSpecsRequest {
  return {
    survey: null,
    ...map,
    mapRounds: MAP_ROUNDS,
    projectFolder,
    specs: [
      {
        latest: r1,
        retiredIds: [],
        approved: false,
        feedback: { kind: "review", summary: "One finding.", findings: [finding] },
      },
    ],
    projectSpecs: [],
    refusedAttempt: null,
  };
}

function reviseRequest(): ReviseSpecRequest {
  return {
    survey: null,
    ...map,
    mapRounds: MAP_ROUNDS,
    projectFolder,
    latest: r1,
    references: [],
    retiredIds: [],
    feedback: { kind: "rejection", reason: "Parents too." },
    earlierFindings: [],
    projectSpecs: [],
    refusedAttempt: null,
  };
}

function reviewRequest(): ReviewSpecRequest {
  return {
    survey: null,
    ...map,
    mapRounds: MAP_ROUNDS,
    projectFolder,
    revision: r2,
    references: [],
    before: { ...r1, delivery: null },
    changes: null,
    removed: null,
    earlierFindings: [],
    otherSpecs: [],
    rejection: null,
    noteDirectedRevisions: [],
  };
}

function ticketsRequest(): DraftTicketSetRequest {
  return {
    survey: null,
    ...map,
    projectFolder,
    approved: r2,
    firstTicketNumber: 1,
    delta: null,
    readings: {},
    takenOut: [],
    touchingWaypoints: [],
    earlierTickets: [],
    rewrite: { version: 1, content: set, findings: [], reason: "Split it.", directedVersions: [] },
    earlierFindings: [],
    refusedAttempt: null,
  };
}

const ticketsFinding: TicketsReviewFinding = {
  kind: "untraced_criterion",
  route: "revise",
  title: "T1 adds a CSV format",
  explanation: "T1's build adds a CSV export; no criterion of C1 or C2 states a CSV format.",
  question: "Should adding a project also export the refusals as CSV?",
  ticketNumbers: ["T1"],
  criterionIds: ["1.1"],
};

function ticketsReviewRequest(content: TicketSetContent = set): ReviewTicketSetRequest {
  return {
    survey: null,
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea: IDEA,
    approved: r2,
    delta: null,
    readings: {},
    takenOut: [],
    touchingWaypoints: [],
    ticketSet: { version: 3, content },
    directedVersions: [],
    earlierFindings: [],
  };
}

const directedVersions: DirectedVersion[] = [
  { kind: "rejection", version: 2, reason: "Name the counting function countWords." },
  { kind: "note", version: 3, text: "Use words.txt in the README example." },
];

describe("the four skill-following calls", () => {
  test("DraftSpecs runs with the skill, its schema and prompt, and returns the parsed specs", async () => {
    const output = {
      specs: [
        { specNumber: 1, content },
        { specNumber: null, content },
      ],
      waits: [{ specNumber: 2, note: "Trim the ends." }],
    };
    const result = await draftSpecsWith(config(writeStandIn(output)), skill)(
      draftSpecsRequest(),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expectSkillArgs(argv);
    expect(flag(argv, "--json-schema")).toBe(draftSpecsJsonSchema(LIMITS));
    expectIdeaInNonceBlock(flag(argv, "-p"));
  });

  test("ReviseSpec runs with the skill and returns the next revision", async () => {
    const output = { revision: content, removed: [] };
    const result = await reviseSpecWith(config(writeStandIn(output)), skill)(
      reviseRequest(),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expectSkillArgs(argv);
    expect(flag(argv, "--json-schema")).toBe(reviseSpecJsonSchema(LIMITS));
  });

  test("ReviewSpec runs with the skill and returns the review", async () => {
    const output = { summary: "One finding.", findings: [finding], verified: [] };
    const result = await reviewSpecWith(config(writeStandIn(output)), skill)(
      reviewRequest(),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expectSkillArgs(argv);
    expect(flag(argv, "--json-schema")).toBe(reviewSpecJsonSchema(LIMITS));
    expect(flag(argv, "-p").split("\n")).toContain("Review of: spec 1 revision 2");
  });

  test("DraftTicketSet runs with the skill and returns the set", async () => {
    const result = await draftTicketSetWith(config(writeStandIn(set)), skill)(
      ticketsRequest(),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: set });
    const argv = recordedArgv();
    expectSkillArgs(argv);
    expect(flag(argv, "--json-schema")).toBe(draftTicketSetJsonSchema(LIMITS));
    expect(flag(argv, "-p")).toContain("You have 12 turns:");
  });

  test("ReviewTicketSet runs with the skill, read-only in the project folder, and returns the review", async () => {
    const output = { summary: "One finding.", findings: [ticketsFinding] };
    const result = await reviewTicketSetWith(config(writeStandIn(output)), skill)(
      ticketsReviewRequest(),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expectSkillArgs(argv);
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob");
    expect(flag(argv, "--json-schema")).toBe(reviewTicketSetJsonSchema(LIMITS));
    const prompt = flag(argv, "-p");
    expect(prompt.split("\n")).toContain("Review of: tickets 1 version 3");
    expect(prompt).toContain(skill.path);
  });

  test("ReviewTicketSet output outside the bounds is agent_output_invalid; zero findings pass", async () => {
    const nine = { summary: "Nine.", findings: Array.from({ length: 9 }, () => ticketsFinding) };
    const tooMany = await reviewTicketSetWith(config(writeStandIn(nine)), skill)(
      ticketsReviewRequest(),
      SESSION,
    );
    expect(tooMany.ok ? null : tooMany.error.code).toBe("agent_output_invalid");
    const longQuestion = {
      summary: "One.",
      findings: [{ ...ticketsFinding, question: "x".repeat(501) }],
    };
    const tooLong = await reviewTicketSetWith(config(writeStandIn(longQuestion)), skill)(
      ticketsReviewRequest(),
      SESSION,
    );
    expect(tooLong.ok ? null : tooLong.error.code).toBe("agent_output_invalid");
    const passed = { summary: "Every criterion traces.", findings: [] };
    const clean = await reviewTicketSetWith(config(writeStandIn(passed)), skill)(
      ticketsReviewRequest(),
      SESSION,
    );
    expect(clean).toEqual({ ok: true, value: passed });
  });

  test("DraftSpecs returns zero specs as parsed: core decides whether zero is right (S7b-8)", async () => {
    const result = await draftSpecsWith(config(writeStandIn({ specs: [], waits: [] })), skill)(
      draftSpecsRequest(),
      SESSION,
    );
    expect(result.ok ? result.value.specs : result.error.code).toEqual([]);
  });

  test("output outside the schema's bounds is agent_output_invalid", async () => {
    const tooMany = {
      specs: Array.from({ length: 13 }, () => ({ specNumber: null, content })),
      waits: [],
    };
    const result = await draftSpecsWith(config(writeStandIn(tooMany)), skill)(
      draftSpecsRequest(),
      SESSION,
    );
    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    const nineTickets = {
      ...set,
      tickets: Array.from({ length: 9 }, (_, i) => ({
        ...set.tickets[0],
        id: `T${String(i + 1)}`,
      })),
    };
    const tickets = await draftTicketSetWith(config(writeStandIn(nineTickets)), skill)(
      ticketsRequest(),
      SESSION,
    );
    expect(tickets.ok ? null : tickets.error.code).toBe("agent_output_invalid");
  });

  test("a missing SKILL.md returns agent_skill_missing and starts no CLI", async () => {
    const claudePath = writeStandIn({ revision: content, removed: [] });
    const missing: PlanningSkill = { name: "Product To Spec", path: join(dir, "nope", "SKILL.md") };
    const calls = [
      () => draftSpecsWith(config(claudePath), missing)(draftSpecsRequest(), SESSION),
      () => reviseSpecWith(config(claudePath), missing)(reviseRequest(), SESSION),
      () => reviewSpecWith(config(claudePath), missing)(reviewRequest(), SESSION),
      () => draftTicketSetWith(config(claudePath), missing)(ticketsRequest(), SESSION),
      () => reviewTicketSetWith(config(claudePath), missing)(ticketsReviewRequest(), SESSION),
    ];
    for (const call of calls) {
      const result = await call();
      expect(result).toMatchObject({
        ok: false,
        error: { code: "agent_skill_missing", data: { skillPath: missing.path } },
      });
    }
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });

  test("a To Spec run reads only its own skill: no self-review with the planning review", async () => {
    for (const call of [
      () =>
        draftSpecsWith(config(writeStandIn({ specs: [], waits: [] })), skill)(
          draftSpecsRequest(),
          SESSION,
        ),
      () =>
        reviseSpecWith(config(writeStandIn({ revision: content, removed: [] })), skill)(
          reviseRequest(),
          SESSION,
        ),
    ]) {
      expect((await call()).ok).toBe(true);
      const systemPrompt = readFileSync(join(dir, "system-prompt"), "utf8");
      expect(systemPrompt).toContain(skill.path);
      expect(systemPrompt).not.toContain("product-planning-review");
      expect(systemPrompt).not.toContain("final pass");
      expect(recordedArgv().filter((arg) => arg === "--add-dir")).toHaveLength(1);
    }
  });
});

describe("schema roots (L107)", () => {
  function roots(jsonSchema: string): string {
    const parsed = z
      .looseObject({ properties: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(jsonSchema));
    return Object.keys(parsed.properties).sort().join(",");
  }

  test("the four new roots are distinct from each other and from every other planning schema", () => {
    const fresh = [
      draftSpecsJsonSchema(LIMITS),
      reviseSpecJsonSchema(LIMITS),
      reviewSpecJsonSchema(LIMITS),
      draftTicketSetJsonSchema(LIMITS),
    ].map(roots);
    expect(fresh).toEqual([
      "specs,waits",
      "removed,revision",
      "findings,summary,verified",
      "dispositions,execution,slicing,tickets",
    ]);
    const others = [
      chartProposalJsonSchema(LIMITS),
      chartConfirmationJsonSchema(LIMITS),
      chartChoiceJsonSchema(LIMITS),
      grillJsonSchema(LIMITS),
      grillResolutionJsonSchema(LIMITS),
      researchJsonSchema(LIMITS),
      taskJsonSchema(LIMITS),
      consistencyJsonSchema(LIMITS),
    ].map(roots);
    expect(new Set([...fresh, ...others]).size).toBe(fresh.length + others.length);
  });

  test("the tickets review's roots are the spec review's but verified: the prompt line tells them apart (slice 7c D2)", () => {
    expect(roots(reviewTicketSetJsonSchema(LIMITS))).toBe("findings,summary");
    expect(roots(reviewSpecJsonSchema(LIMITS))).toBe("findings,summary,verified");
    expect(reviewTicketSetJsonSchema(LIMITS)).not.toBe(reviewSpecJsonSchema(LIMITS));
    const spec = buildReviewSpecPrompt(reviewRequest(), LIMITS);
    const tickets = buildReviewTicketSetPrompt(ticketsReviewRequest(), skill.path, LIMITS);
    expect(spec).not.toMatch(/^Review of: tickets /m);
    expect(tickets).not.toMatch(/^Review of: spec /m);
  });
});

describe("the spec prompts' count, tracing, routing and length rules", () => {
  test("a first To Spec run writes one spec by default; tracing is about intent", () => {
    const first = buildDraftSpecsPrompt({ ...draftSpecsRequest(), specs: [] }, LIMITS);
    expect(first).toContain(SPEC_COUNT_RULE.join("\n"));
    expect(first).toContain("Write one spec by default.");
    expect(first).toContain("At most 4 specs.");
    expect(first).not.toContain("one to twelve");
    expect(first).toContain(SPEC_TRACING_RULE.join("\n"));
    expect(first).toContain(BUSY_READER_RULE.join("\n"));
    expect(first).toContain("at most 600 characters");
    // Proof is carried; the writer is never asked to state a mechanism for every value.
    expect(first).toContain(SPEC_GROUNDING_RULE.join("\n"));
    expect(first).not.toContain("State the mechanism for anything a clause requires");
    expect(first).not.toContain("never a lookup on PATH");
    // Instance configuration is referred to by key, never written into the spec.
    expect(first).toContain(INSTANCE_CONFIG_RULE.join("\n"));
    // One sentence covers untraced values and unverified behaviour.
    expect(first).toContain(SPEC_LITERAL_RULE.join("\n"));
    expect(SPEC_LITERAL_RULE.join(" ")).toBe(
      "A concrete value or unverified behaviour not traced to a source is stated as an assumption with a live-test criterion. A clause decides any research finding or assumption it bears on (which folders are writable, what if false), not a test.",
    );
    // The repository's testing convention is always carried, never out of scope.
    expect(first).toContain("Never put the repository's standard testing practice out of scope.");
    // A pre-submit self-check mirrors the review; criteria never restate their clause.
    for (const prompt of [first, buildReviseSpecPrompt(reviseRequest(), LIMITS)]) {
      expect(prompt).toContain(SPEC_SELF_CHECK.join("\n"));
      expect(prompt).toContain(SPEC_CONCISION_RULE.join("\n"));
      expect(prompt).toContain(WAS_RULE.join("\n"));
    }
    expect(buildReviseSpecPrompt(reviseRequest(), LIMITS)).toContain(
      SPEC_GROUNDING_RULE.join("\n"),
    );
  });

  test("every spec and tickets run reads the map's code survey as FACTS, or that it has none", () => {
    const builds = [
      (survey: CodeSurvey | null) =>
        buildDraftSpecsPrompt({ ...draftSpecsRequest(), specs: [], survey }, LIMITS),
      (survey: CodeSurvey | null) => buildReviseSpecPrompt({ ...reviseRequest(), survey }, LIMITS),
      (survey: CodeSurvey | null) => buildReviewSpecPrompt({ ...reviewRequest(), survey }, LIMITS),
      (survey: CodeSurvey | null) =>
        buildDraftTicketSetPrompt({ ...ticketsRequest(), survey }, 12, LIMITS),
      (survey: CodeSurvey | null) =>
        buildReviewTicketSetPrompt({ ...ticketsReviewRequest(), survey }, "/abs/SKILL.md", LIMITS),
    ];
    for (const build of builds) {
      const surveyed = build(SURVEY);
      expect(surveyed).toContain(SURVEY_FACTS);
      expect(surveyed).toContain(FACTS_RULE.join("\n"));
      expect(surveyed).not.toContain(NO_SURVEY_LINES.join("\n"));
      const unsurveyed = build(null);
      expect(unsurveyed).toContain(NO_SURVEY_LINES.join("\n"));
      expect(unsurveyed).not.toContain("<<<FACTS");
    }
  });

  test("the spec review opens the code each clause changes and checks it can be built", () => {
    const prompt = buildReviewSpecPrompt(reviewRequest(), LIMITS);
    expect(prompt).toContain(SPEC_REVIEW_REPOSITORY_RULE.join("\n"));
    const rule = SPEC_REVIEW_REPOSITORY_RULE.join(" ");
    // Each clause is checked against the code it relies on; any other claim is still opened.
    expect(rule).toContain("check each clause against what it relies on");
    expect(rule).toContain(
      "Open the code for any other claim about the code that neither FACTS nor the excerpts cover",
    );
    expect(rule).toContain("cannot be built as written, or that conflicts with how the code works");
    expect(rule).toContain("is a contradiction: revise.");
    // Each new config key, stored field and failure path is checked against the project rules.
    expect(rule).toContain(
      "check each new config key, stored field and failure path against the project instruction files' rules",
    );
    expect(rule).toContain("else open AGENTS.md or CLAUDE.md at the repository root");
    expect(rule).toContain("A breach is a contradiction: revise");
    expect(rule).toContain("reverses an answer the person gave is dropped_resolution.");
    expect(buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS)).not.toContain(rule);
  });

  test("an assumption needs only a proving criterion; repairs never split, move or renumber ids", () => {
    for (const prompt of [
      buildDraftSpecsPrompt({ ...draftSpecsRequest(), specs: [] }, LIMITS),
      buildReviseSpecPrompt(reviseRequest(), LIMITS),
      buildReviewSpecPrompt(reviewRequest(), LIMITS),
    ]) {
      expect(prompt).not.toContain("what happens if it fails");
      expect(prompt).not.toContain("outcome if it fails");
    }
    const was = WAS_RULE.join(" ");
    expect(was).toContain("never split, move or renumber criteria.");
    expect(was).toContain(
      "drop it and add a new criterion with an id no revision of this spec used",
    );
    expect(was).toContain("Leave `was` out unless a criterion truly moved");
    expect(was).not.toContain("split)");
  });

  test("To Spec states behaviour, and a mechanism only where it matters; it stays short", () => {
    for (const prompt of [
      buildDraftSpecsPrompt({ ...draftSpecsRequest(), specs: [] }, LIMITS),
      buildReviseSpecPrompt(reviseRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(SPEC_MECHANISM_RULE.join("\n"));
      // The self-check no longer demands a mechanism for every trigger, detection and fallback.
      expect(prompt).not.toContain("every trigger, detection, fallback and coded error");
      expect(prompt).toContain("at most six clauses and at most three criteria per clause");
      expect(prompt).toContain("merge clauses that serve one\nbehaviour.");
      // A clause's text is plain behaviour; codes, keys and tests sit in its criteria and declarations.
      expect(prompt).toContain(
        "It names no error code, config key, field, column, heading or test, and lists no inputs or cases:",
      );
      expect(prompt).toContain("so never write that one is not added.");
      expect(prompt).toContain("but never a function,\ntype, component, command or flag");
    }
  });

  test("To Spec's self-check is four short bullets and no review pass", () => {
    expect(SPEC_SELF_CHECK.filter((line) => line.startsWith("- "))).toHaveLength(4);
    for (const prompt of [
      buildDraftSpecsPrompt({ ...draftSpecsRequest(), specs: [] }, LIMITS),
      buildReviseSpecPrompt(reviseRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(
        "- every new stored field, state or column says what happens to records that already exist.",
      );
      expect(prompt).toContain(
        "- every new configurable value names its config key and its section in a criterion;",
      );
      expect(prompt).toContain(
        "there (`map_archived`, `delivery.agent`): an existing one or the new one being added, and no",
      );
      expect(prompt).toContain(
        "- nothing contradicts a resolution; each new config key, stored field and failure path keeps the",
      );
      expect(prompt).toContain("else open AGENTS.md or CLAUDE.md at the root");
      expect(prompt).not.toContain("- nothing a resolution settles is dropped;");
      expect(prompt).not.toContain("- parity:");
      expect(prompt).not.toContain("every configuration key states which values are valid");
      expect(prompt).not.toContain("planning review skill");
    }
  });

  test("a repair carries the length and busy-reader rules", () => {
    const prompt = buildReviseSpecPrompt(reviseRequest(), LIMITS);
    expect(prompt).toContain("at most 600 characters");
    expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
    // A repair settles a finding's detail in criteria or adds, not as a sentence in the clause.
    expect(prompt).toContain(
      "about a code, a config key, a mechanism or a test in a criterion or in adds; change a clause's text",
    );
  });

  test("the spec and ticket runs state their model's lengths in both wordings", () => {
    const sonnet = [
      "Keep the problem and the solution to at most 600 characters each and each clause's text",
      "to at most 400 characters; longer output is refused.",
    ].join("\n");
    const opus = [
      "Keep the problem and the solution to about 500 characters (at most 600) each and each clause's text",
      "to about 350 characters (at most 500); longer output is refused.",
    ].join("\n");
    expect(buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS)).toContain(sonnet);
    expect(buildReviseSpecPrompt(reviseRequest(), LIMITS)).toContain(sonnet);
    expect(buildDraftSpecsPrompt(draftSpecsRequest(), AIMED_LIMITS)).toContain(opus);
    expect(buildReviseSpecPrompt(reviseRequest(), AIMED_LIMITS)).toContain(opus);
    expect(buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS)).toContain(
      "Limits: each ticket's title at most 120 characters, its build about 1200 characters (at most 2000), each blocker's supplies, testing line and Out of scope line at most 500 characters, each disposition's reason or evidence at most 1000 characters, the slicing at most 2000 characters, the execution at most 1000 characters; longer output is refused.",
    );
    expect(buildDraftTicketSetPrompt(ticketsRequest(), 12, AIMED_LIMITS)).toContain(
      "Limits: each ticket's title about 90 characters (at most 120), its build about 1000 characters (at most 2500), each blocker's supplies, testing line and Out of scope line at most 500 characters, each disposition's reason or evidence at most 1000 characters, the slicing at most 2000 characters, the execution at most 1000 characters; longer output is refused.",
    );
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).toContain(
      "Limits: the summary at most 1000 characters; longer output is refused.",
    );
    expect(buildReviewSpecPrompt(reviewRequest(), AIMED_LIMITS)).toContain(
      "Limits: the summary about 800 characters (at most 1500); longer output is refused.",
    );
    const reviewTickets = (limits: typeof LIMITS) =>
      buildReviewTicketSetPrompt(ticketsReviewRequest(), "/skills/review/SKILL.md", limits);
    expect(reviewTickets(LIMITS)).toContain(
      "Limits: the summary at most 1000 characters; longer output is refused.",
    );
    expect(reviewTickets(AIMED_LIMITS)).toContain(
      "Limits: the summary about 800 characters (at most 1500); longer output is refused.",
    );
  });

  test("a spec review routes decision only for a gap in the person's intent", () => {
    const prompt = buildReviewSpecPrompt(reviewRequest(), LIMITS);
    expect(prompt).toContain(SPEC_REVIEW_ROUTE_RULE.join("\n"));
    // The materiality bar: only what changes what gets built is a finding.
    const route = SPEC_REVIEW_ROUTE_RULE.join(" ");
    expect(route).toContain(
      "Report a finding only when a competent implementer following the spec",
    );
    // Doubt spares wording and style only, never buildability or an open decision.
    expect(route).toContain("When in doubt on wording or style alone, no finding.");
    expect(route).not.toContain("When in doubt, no finding.");
    // undefined_term names a decision left to the implementer and a stand-in-only criterion.
    expect(route).toContain(
      "undefined_term covers any decision left to the implementer that changes what the person or operator sees",
    );
    expect(route).toContain("which config key and section hold a new value");
    expect(route).toContain("only a stand-in for the real behaviour it claims could prove");
    // Detail settled in a criterion or adds is stated; the review never asks to move it into clause text.
    expect(route).toContain("never ask to move it into the clause's text.");
    expect(route).toContain("is not added: never ask the spec to say so.");
    // Conditional clause text is core's spec lint (spec_content_invalid), not the review's.
    expect(route).not.toContain("a clause whose behaviour depends on an unresolved condition");
    expect(route).not.toContain("unverifiable wording, bookkeeping, missing precision");
    // The review does not flag what only the writer's rules ask for; unverifiable is about the code.
    expect(route).toContain(
      "unverifiable is a clause that depends on something about the code that neither FACTS, the excerpts nor the code you opened settles",
    );
    expect(prompt).not.toContain("with no criterion proving it");
    expect(prompt).not.toContain("is invented_scope: revise.");
    expect(prompt).not.toContain(SPEC_LITERAL_RULE.join("\n"));
    expect(prompt).toContain("Never ask for a criterion that restates its clause");
    // A research finding or assumption a clause ignores or defers is a dropped resolution.
    expect(route).toContain(
      "dropped_resolution includes a research finding or assumption a clause bears on but ignores or defers.",
    );
    // Project rules and guardrails.
    expect(prompt).toContain("against the project instruction files' rules");
    expect(prompt).toContain(
      "enforced\nguardrail with no resolution from the person behind it is a contradiction: decision.",
    );
    // A general rule the person decided covers the case: the writer applies it.
    expect(route).toContain(
      "resolution the person decided states a general rule that covers the case, it routes revise instead",
    );
    // decision only for scope or observable behaviour the conventions do not settle.
    expect(prompt).toContain("neither the sources nor the repository's conventions settle it");
    expect(prompt).toContain("implementation mechanics such as configuration\nvalidation");
    // A chosen mechanism is never invented scope and never escalated; no padding is asked for.
    expect(prompt).toContain(SPEC_MECHANISM_RULE.join("\n"));
    expect(prompt).toContain("invented_scope is behaviour or scope the person would observe");
    expect(prompt).toContain("never invented_scope and never decision: at most revise");
    expect(prompt).toContain("or for an added clause or criterion unless\nsomething a source");
    expect(prompt).toContain(SPEC_TRACING_RULE.join("\n"));
    expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
  });
});

describe("a resolved waypoint's agent-decided calls", () => {
  test("draft, repair and review read them inside its waypoint block, or that there were none", () => {
    for (const prompt of [
      buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS),
      buildReviseSpecPrompt(reviseRequest(), LIMITS),
      buildReviewSpecPrompt(reviewRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(
        "Gist: Real paths.\nAgent decided (calls the agent made without asking the person):\n- Compare real paths, not the names typed\nResolution:",
      );
      expect(prompt).toContain(
        "Gist: Both ways.\nAgent decided: none; the person decided everything in it.\nResolution:",
      );
    }
  });
});

describe("a research waypoint's facts", () => {
  test("draft, repair and review read its findings and sources inside its waypoint block", () => {
    for (const prompt of [
      buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS),
      buildReviseSpecPrompt(reviseRequest(), LIMITS),
      buildReviewSpecPrompt(reviewRequest(), LIMITS),
    ]) {
      expect(prompt).toMatch(
        /Yes, both ways\.\nResearch findings \(the facts behind the resolution\):\n- Real paths nest: A real path under another is nested\.\nResearch sources:\n- Node fs\.realpath \(https:\/\/nodejs\.org\/api\/fs\.html\)\n- projects\.ts\nWAYPOINT-2 [0-9a-f-]{36}>>>/,
      );
      // A grilling waypoint carries no research.
      expect(prompt).toMatch(/When their real paths match\.\nWAYPOINT-1 [0-9a-f-]{36}>>>/);
    }
  });

  test("an empty findings or sources list prints no header", () => {
    const request = reviewRequest();
    const waypoints = request.waypoints.map((waypoint) =>
      waypoint.kind === "research"
        ? { ...waypoint, research: { findings: [], sources: [] } }
        : waypoint,
    );
    const prompt = buildReviewSpecPrompt({ ...request, waypoints }, LIMITS);
    expect(prompt).not.toContain("Research findings");
    expect(prompt).not.toContain("Research sources");
    expect(prompt).toMatch(/Yes, both ways\.\nWAYPOINT-2 [0-9a-f-]{36}>>>/);
  });
});

describe("the earlier findings (the repair loop's memory)", () => {
  const earlierFindings = [
    {
      revision: 1,
      findings: [
        { kind: "invented_scope" as const, elementIds: ["C2", "2.1"], explanation: "Adds CSV." },
      ],
    },
    {
      revision: 2,
      findings: [{ kind: "unverifiable" as const, elementIds: [], explanation: "No test." }],
    },
  ];
  const grouped =
    /EARLIER FINDINGS \(the spec's earlier failed reviews, by revision\):\n<<<EARLIER-FINDINGS [0-9a-f-]{36}\nRevision 1:\n- invented_scope \[C2, 2\.1\]: Adds CSV\.\nRevision 2:\n- unverifiable \[\]: No test\.\nEARLIER-FINDINGS [0-9a-f-]{36}>>>/;

  test("the review reads them grouped by revision, checks each is closed and judges only changes", () => {
    const prompt = buildReviewSpecPrompt(
      { ...reviewRequest(), revision: r2, earlierFindings },
      LIMITS,
    );
    expect(prompt).toMatch(grouped);
    expect(prompt).toContain("A closed finding is not\nraised again.");
    expect(prompt).toContain("Text added to close an earlier finding is not new scope.");
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).not.toContain("EARLIER FINDINGS");
  });

  test("the repair reads them grouped by revision and closes the open ones", () => {
    const prompt = buildReviseSpecPrompt({ ...reviseRequest(), earlierFindings }, LIMITS);
    expect(prompt).toMatch(grouped);
    expect(prompt.split("\n")).toContain(
      "Close each open earlier finding without reopening one that was already closed.",
    );
    expect(buildReviseSpecPrompt(reviseRequest(), LIMITS)).not.toContain("EARLIER FINDINGS");
  });

  const ticketsEarlier = [
    {
      version: 1,
      findings: [
        {
          kind: "contradiction" as const,
          ticketNumbers: ["T1"],
          criterionIds: ["1.1"],
          explanation: "Builds in web.",
        },
      ],
    },
    {
      version: 2,
      findings: [
        {
          kind: "unsupported_evidence" as const,
          ticketNumbers: [],
          criterionIds: [],
          explanation: "Not in the code.",
        },
      ],
    },
  ];
  const ticketsGrouped =
    /EARLIER FINDINGS \(the ticket set's earlier failed reviews, by version\):\n<<<EARLIER-FINDINGS [0-9a-f-]{36}\nVersion 1:\n- contradiction \[T1, 1\.1\]: Builds in web\.\nVersion 2:\n- unsupported_evidence \[\]: Not in the code\.\nEARLIER-FINDINGS [0-9a-f-]{36}>>>/;

  test("the tickets review and the rewrite read the set's computed shape (RC5)", () => {
    const [ticket] = set.tickets;
    if (ticket === undefined) throw new Error("The set has no ticket");
    const tickets = [
      { ...ticket, id: "T1", criteria: ["1.1", "1.2", "2.1"] },
      { ...ticket, id: "T2", criteria: ["2.2"] },
    ];
    expect(ticketSetShapeLine(tickets)).toBe(
      "Shape: criteria per ticket T1 3/4 (75%), T2 1/4 (25%); tickets with fewer than three criteria: T2.",
    );
    const review = ticketsReviewRequest();
    expect(
      buildReviewTicketSetPrompt(review, "/abs/skills/review/SKILL.md", LIMITS).split("\n"),
    ).toContain(ticketSetShapeLine(review.ticketSet.content.tickets));
  });

  test("the tickets review reads them grouped by version and checks each is closed", () => {
    const prompt = buildReviewTicketSetPrompt(
      { ...ticketsReviewRequest(), earlierFindings: ticketsEarlier },
      "/abs/skills/review/SKILL.md",
      LIMITS,
    );
    expect(prompt).toMatch(ticketsGrouped);
    expect(prompt).toContain("A closed finding is not\nraised again.");
    expect(
      buildReviewTicketSetPrompt(ticketsReviewRequest(), "/abs/skills/review/SKILL.md", LIMITS),
    ).not.toContain("EARLIER FINDINGS");
  });

  test("the To Tickets rewrite reads them grouped by version and closes the open ones", () => {
    const prompt = buildDraftTicketSetPrompt(
      {
        ...ticketsRequest(),
        earlierFindings: ticketsEarlier,
      },
      12,
      LIMITS,
    );
    expect(prompt).toMatch(ticketsGrouped);
    expect(prompt.split("\n")).toContain(
      "Close each open earlier finding without reopening one that was already closed.",
    );
    expect(buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS)).not.toContain(
      "EARLIER FINDINGS",
    );
  });
});

describe("the prompts' plain lines (the e2e stand-in keys on them)", () => {
  test("DraftSpecs names the map's specs, resolved waypoints, earlier ids and feedback", () => {
    const lines = buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS).split("\n");
    expect(lines).toContain("Specs on this map: 1");
    expect(lines).toContain("Resolved waypoints: 1, 2");
    expect(lines).toContain("Previous revision clause ids: C1, C2");
    expect(lines).toContain("Previous revision criterion ids: 1.1, 1.2, 2.1");
    expect(lines).toContain("Revise because: review findings 1");
    const first = buildDraftSpecsPrompt({ ...draftSpecsRequest(), specs: [] }, LIMITS).split("\n");
    expect(first).toContain("Specs on this map: 0");
    expect(lines).not.toContain(NO_WAYPOINTS_TO_CITE_LINE);
    const none = buildDraftSpecsPrompt({ ...draftSpecsRequest(), waypoints: [] }, LIMITS).split(
      "\n",
    );
    expect(none).toContain("Resolved waypoints: none");
    expect(none).toContain(NO_WAYPOINTS_TO_CITE_LINE);
  });

  test("ReviseSpec names the revision, its ids and the rejection", () => {
    const prompt = buildReviseSpecPrompt(reviseRequest(), LIMITS);
    const lines = prompt.split("\n");
    expect(lines).toContain("Revising: spec 1 revision 1");
    expect(lines).toContain("Previous revision criterion ids: 1.1, 1.2, 2.1");
    expect(lines).toContain("Revise because: rejection");
    expect(prompt).toMatch(/<<<REJECTION [0-9a-f-]{36}\nParents too\.\nREJECTION [0-9a-f-]{36}>>>/);
    expect(prompt).toContain("A rejection is not a note: cite no note for it.");
    expectIdeaInNonceBlock(prompt);
  });

  test("ReviseSpec and DraftSpecs name the spec's retired ids (E-3, E-6); core refuses a broken id rule", () => {
    const revise = buildReviseSpecPrompt(
      { ...reviseRequest(), retiredIds: ["C3", "3.1", "2.3"] },
      LIMITS,
    );
    expect(revise.split("\n")).toContain("Previous revision retired ids: C3, 3.1, 2.3");
    expect(buildReviseSpecPrompt(reviseRequest(), LIMITS).split("\n")).toContain(
      "Previous revision retired ids: none",
    );
    const draft = buildDraftSpecsPrompt(
      {
        ...draftSpecsRequest(),
        specs: draftSpecsRequest().specs.map((spec) => ({ ...spec, retiredIds: ["1.3"] })),
        projectSpecs: [{ ...projectSpec, retiredIds: ["2.4"] }],
      },
      LIMITS,
    ).split("\n");
    expect(draft).toContain("Previous revision retired ids: 1.3");
    expect(draft).toContain("Project spec 4 retired ids: 2.4");
  });

  test("ReviseSpec asks for removed; ReviewSpec judges the whole revision and reads each removal's reason (RC4)", () => {
    const revise = buildReviseSpecPrompt(reviseRequest(), LIMITS);
    expect(revise).toContain(REMOVED_RULE.join("\n"));
    const review = buildReviewSpecPrompt(
      {
        ...reviewRequest(),
        removed: [{ id: "2.2", reason: "Merged into 2.1." }],
      },
      LIMITS,
    );
    expect(review).not.toContain("judge only text that changed");
    expect(review.split("\n")).toContain(
      "Removed since the previous revision, each with the reviser's reason:",
    );
    expect(review).toMatch(
      /<<<REMOVED [0-9a-f-]{36}\n2\.2: Merged into 2\.1\.\nREMOVED [0-9a-f-]{36}>>>/,
    );
    expect(
      buildReviewSpecPrompt({ ...reviewRequest(), removed: [] }, LIMITS).split("\n"),
    ).toContain("Removed since the previous revision: nothing.");
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).not.toContain("Removed since");
  });

  test("ReviewSpec names the revision under review and the one before", () => {
    const lines = buildReviewSpecPrompt(reviewRequest(), LIMITS).split("\n");
    expect(lines).toContain("Review of: spec 1 revision 2");
    expect(lines).toContain("Revision criterion ids: 1.1, 1.2, 2.1");
    expect(lines).toContain("Previous revision: 1");
    expect(lines).toContain("Resolved waypoints: 1, 2");
    expect(lines).toContain("Other specs on this map: 0");
    const first = buildReviewSpecPrompt({ ...reviewRequest(), revision: r1, before: null }, LIMITS);
    expect(first.split("\n")).toContain(
      "Previous revision: none. This is the spec's first revision.",
    );
  });

  test("ReviewSpec carries the person's rejection, which outranks earlier resolutions (L141)", () => {
    const prompt = buildReviewSpecPrompt(
      {
        ...reviewRequest(),
        rejection: { revision: 1, reason: "Parents too." },
      },
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("The person rejected revision 1 with this reason:");
    expect(prompt).toMatch(/<<<REJECTION [0-9a-f-]{36}\nParents too\.\nREJECTION [0-9a-f-]{36}>>>/);
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).not.toContain("<<<REJECTION");
  });

  test("ReviseSpec carries the problem its previous attempt was refused for (L141)", () => {
    const prompt = buildReviseSpecPrompt(
      {
        ...reviseRequest(),
        refusedAttempt: { problem: "Criterion 2.4's was names 2.1." },
      },
      LIMITS,
    );
    expect(prompt).toMatch(
      /<<<REFUSED [0-9a-f-]{36}\nCriterion 2\.4's was names 2\.1\.\nREFUSED [0-9a-f-]{36}>>>/,
    );
    expect(buildReviseSpecPrompt(reviseRequest(), LIMITS)).not.toContain("<<<REFUSED");
  });

  test("ReviseSpec carries a note as its feedback, which outranks earlier resolutions (S7b-11)", () => {
    const prompt = buildReviseSpecPrompt(
      {
        ...reviseRequest(),
        feedback: { kind: "note", text: "Parents too, after all." },
      },
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Revise because: note");
    expect(prompt).toMatch(
      /<<<NOTE [0-9a-f-]{36}\nParents too, after all\.\nNOTE [0-9a-f-]{36}>>>/,
    );
    expect(prompt).toContain('{ "kind": "note" }');
    expect(prompt).not.toContain("<<<REJECTION");
  });

  test("ReviewSpec carries each note-directed revision and states its rank (S7b-11)", () => {
    const prompt = buildReviewSpecPrompt(
      {
        ...reviewRequest(),
        noteDirectedRevisions: [{ revision: 2, note: "Parents too, after all." }],
      },
      LIMITS,
    );
    const lines = prompt.split("\n");
    expect(lines).toContain("Note-directed revisions: 2");
    expect(lines).toContain("The person's note behind revision 2:");
    expect(prompt).toMatch(
      /<<<NOTE-2 [0-9a-f-]{36}\nParents too, after all\.\nNOTE-2 [0-9a-f-]{36}>>>/,
    );
    expect(prompt).toContain("outranks earlier resolutions");
    const none = buildReviewSpecPrompt(reviewRequest(), LIMITS);
    expect(none.split("\n")).toContain("Note-directed revisions: none");
    expect(none).not.toContain("<<<NOTE");
  });

  test("DraftSpecs carries the problem its previous attempt was refused for, and nothing when null (S7b-15)", () => {
    const prompt = buildDraftSpecsPrompt(
      {
        ...draftSpecsRequest(),
        refusedAttempt: { problem: "Spec 1: Clause C3 is new and has no source" },
      },
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Previous attempt refused: yes");
    expect(prompt).toMatch(
      /<<<REFUSED [0-9a-f-]{36}\nSpec 1: Clause C3 is new and has no source\nREFUSED [0-9a-f-]{36}>>>/,
    );
    const none = buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS);
    expect(none).not.toContain("Previous attempt refused");
    expect(none).not.toContain("<<<REFUSED");
  });

  test("DraftSpecs carries a spec's note feedback on a re-clear (S7b-11)", () => {
    const [spec] = draftSpecsRequest().specs;
    if (spec === undefined) throw new Error("fixture has a spec");
    const lines = buildDraftSpecsPrompt(
      {
        ...draftSpecsRequest(),
        specs: [{ ...spec, feedback: { kind: "note", text: "Parents too." } }],
      },
      LIMITS,
    ).split("\n");
    expect(lines).toContain("Revise because: note");
  });

  test("DraftTicketSet names the approved revision's criterion ids and the rewrite", () => {
    const lines = buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS).split("\n");
    expect(lines).toContain("Tickets for: spec 1 revision 2");
    expect(lines).toContain("Revision criterion ids: 1.1, 1.2, 2.1");
    expect(lines).toContain("Rewrite of ticket set version: 1");
    const fresh = buildDraftTicketSetPrompt(
      { ...ticketsRequest(), rewrite: null },
      12,
      LIMITS,
    ).split("\n");
    expect(fresh).toContain("Rewrite of ticket set version: none");
  });

  test("DraftTicketSet states core's set rules, and a retry carries core's refusal code and problem", () => {
    const none = buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS);
    expect(none).toContain(TICKET_SET_RULES.join("\n"));
    expect(none).not.toContain("ticket_set_content_invalid");
    expect(none).not.toContain("<<<REFUSED");
    const problem = "Ticket T1 lists 6.1 without its work disposition";
    const retried = buildDraftTicketSetPrompt(
      {
        ...ticketsRequest(),
        refusedAttempt: { code: "ticket_set_content_invalid", problem },
      },
      12,
      LIMITS,
    );
    expect(retried.split("\n")).toContain("Previous attempt refused: ticket_set_content_invalid");
    expect(retried).toMatch(
      new RegExp(`<<<REFUSED [0-9a-f-]{36}\n${problem}\nREFUSED [0-9a-f-]{36}>>>`),
    );
  });
});

describe("the tickets review prompt (slice 7c D2, D3)", () => {
  test("carries the version, the approved revision's ids, the skill path and each D3 rule", () => {
    const prompt = buildReviewTicketSetPrompt(
      ticketsReviewRequest(),
      "/abs/skills/review/SKILL.md",
      LIMITS,
    );
    const lines = prompt.split("\n");
    expect(lines).toContain("Review of: tickets 1 version 3");
    expect(lines).toContain(
      "Follow the Tickets review section of the skill at /abs/skills/review/SKILL.md.",
    );
    // L173 (a): the idea, in its nonce block, as the spec review's prompt carries it.
    expectIdeaInNonceBlock(prompt);
    expect(lines).toContain("Spec 1, approved revision 2:");
    expect(lines).toContain("Revision criterion ids: 1.1, 1.2, 2.1");
    expect(lines).toContain("Version ticket ids: T1");
    expect(prompt).toMatch(
      /<<<SPEC-TITLE [0-9a-f-]{36}\nReject duplicate and nested project folders\nSPEC-TITLE [0-9a-f-]{36}>>>/,
    );
    expect(prompt).toContain(JSON.stringify(set, null, 2));
    // The skill's Tickets review section is the single source of the kinds, routes and cases; the
    // prompt adds only the repository step, the decision route and the id names, once each.
    for (const rule of [TICKETS_REVIEW_REPOSITORY_RULE, TICKETS_REVIEW_RULES]) {
      expect(prompt.split(rule.join("\n"))).toHaveLength(2);
    }
    expect(prompt.indexOf(TICKETS_REVIEW_REPOSITORY_RULE.join("\n"))).toBeLessThan(
      prompt.indexOf(TICKETS_REVIEW_RULES.join("\n")),
    );
    expect(prompt).not.toContain("Write every finding's question");
    expect(prompt).not.toContain("- untraced_criterion:");
  });
});

describe("the To Tickets repair request (slice 7c D4)", () => {
  test("a review repair renders the findings and sends no REASON block", () => {
    const base = ticketsRequest();
    if (base.rewrite === null) throw new Error("fixture rewrites");
    const prompt = buildDraftTicketSetPrompt(
      {
        ...base,
        rewrite: { ...base.rewrite, findings: [ticketsFinding], reason: null },
      },
      12,
      LIMITS,
    );
    const lines = prompt.split("\n");
    expect(lines).toContain("Rewrite of ticket set version: 1");
    expect(lines).toContain("Review findings to repair: 1");
    const nonce = /^<<<FINDINGS ([0-9a-f-]{36})$/m.exec(prompt)?.[1];
    if (nonce === undefined) throw new Error("the prompt has no FINDINGS block");
    expect(prompt).toContain(
      `<<<FINDINGS ${nonce}\n${JSON.stringify([ticketsFinding], null, 2)}\nFINDINGS ${nonce}>>>`,
    );
    expect(prompt).not.toContain("<<<REASON");
    expect(prompt).not.toContain("outranks the review findings");
  });

  test("a reason with empty findings sends the REASON block and no findings", () => {
    const prompt = buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS);
    expect(prompt.split("\n")).toContain("Review findings to repair: 0");
    expect(prompt).toMatch(/<<<REASON [0-9a-f-]{36}\nSplit it\.\nREASON [0-9a-f-]{36}>>>/);
    expect(prompt).not.toContain("<<<FINDINGS");
    expect(prompt).not.toContain("outranks the review findings");
  });

  test("a reason beside findings is stated as outranking them (L141)", () => {
    const base = ticketsRequest();
    if (base.rewrite === null) throw new Error("fixture rewrites");
    const prompt = buildDraftTicketSetPrompt(
      {
        ...base,
        rewrite: { ...base.rewrite, findings: [ticketsFinding] },
      },
      12,
      LIMITS,
    );
    expect(prompt).toContain("<<<FINDINGS");
    expect(prompt).toContain("<<<REASON");
    expect(prompt.replace(/\n\s*/g, " ")).toContain(
      "The person's reason is their most recent word and outranks the review findings",
    );
    expect(prompt.indexOf("outranks the review findings")).toBeGreaterThan(
      prompt.indexOf("<<<REASON"),
    );
  });
});

describe("directed versions (L180 (2))", () => {
  test("the tickets review carries each directed version's ask in its block and counts it as traced", () => {
    const prompt = buildReviewTicketSetPrompt(
      { ...ticketsReviewRequest(), directedVersions },
      "/abs/skills/review/SKILL.md",
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Directed versions: 2 (rejection), 3 (note)");
    expect(prompt).toMatch(
      /<<<REJECTION-1 [0-9a-f-]{36}\nName the counting function countWords\.\nREJECTION-1 [0-9a-f-]{36}>>>/,
    );
    expect(prompt).toMatch(
      /<<<NOTE-3 [0-9a-f-]{36}\nUse words\.txt in the README example\.\nNOTE-3 [0-9a-f-]{36}>>>/,
    );
    expect(prompt.replace(/\n\s*/g, " ")).toContain(
      "counts as traced: a ticket detail, name or case it asks for is never untraced_criterion and never a revise finding",
    );
    const none = buildReviewTicketSetPrompt(
      ticketsReviewRequest(),
      "/abs/skills/review/SKILL.md",
      LIMITS,
    );
    expect(none.split("\n")).toContain("Directed versions: none");
    expect(none).not.toContain("<<<REJECTION-");
    expect(none).not.toContain("<<<NOTE-");
  });

  test("a review repair carries each directed version's ask and keeps it over the findings", () => {
    const base = ticketsRequest();
    if (base.rewrite === null) throw new Error("fixture rewrites");
    const prompt = buildDraftTicketSetPrompt(
      {
        ...base,
        rewrite: { ...base.rewrite, findings: [ticketsFinding], reason: null, directedVersions },
      },
      12,
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Directed versions: 2 (rejection), 3 (note)");
    expect(prompt).toMatch(
      /<<<REJECTION-1 [0-9a-f-]{36}\nName the counting function countWords\.\nREJECTION-1 [0-9a-f-]{36}>>>/,
    );
    expect(prompt).toMatch(
      /<<<NOTE-3 [0-9a-f-]{36}\nUse words\.txt in the README example\.\nNOTE-3 [0-9a-f-]{36}>>>/,
    );
    expect(prompt.replace(/\n\s*/g, " ")).toContain(
      "keep it in the tickets you write, even where a review finding says no criterion states it",
    );
    const none = buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS);
    expect(none.split("\n")).toContain("Directed versions: none");
  });
});

describe("the product skills", () => {
  test("live in the skills folder beside the repository's, and state D2, D5 and the backtick rule", () => {
    for (const path of [
      PLANNING_SKILLS.toSpec,
      PLANNING_SKILLS.planningReview,
      PLANNING_SKILLS.toTickets,
    ]) {
      expect(path.startsWith(SKILLS_DIR)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    const toSpec = readFileSync(PLANNING_SKILLS.toSpec, "utf8");
    const toTickets = readFileSync(PLANNING_SKILLS.toTickets, "utf8");
    const review = readFileSync(PLANNING_SKILLS.planningReview, "utf8");
    for (const field of ["`clauses`", "`criteria`", "`sources`", "`outOfScope`", "`was`"]) {
      expect(toSpec).toContain(field);
    }
    for (const field of [
      "`tickets`",
      "`blockedBy`",
      "`dispositions`",
      "`slicing`",
      "`execution`",
      "`pointers`",
    ]) {
      expect(toTickets).toContain(field);
    }
    expect(toTickets).toContain("One person-visible slice is one ticket.");
    expect(toTickets).toContain(
      "Never split into a chain where each ticket only unblocks the next",
    );
    expect(toTickets).toContain("never restate it");
    expect(toTickets).not.toContain("Every ticket costs a full delivery run");
    expect(toTickets).not.toContain("Prefactoring comes first");
    expect(toSpec).toContain('{ "kind": "note" }');
    expect(review).toContain('{ "kind": "note" }');
    expect(toSpec).toContain("`specs` is empty");
    expect(toSpec).toContain("Never nest backticks");
    expect(toSpec).not.toContain("final pass");
    expect(toSpec).toContain("Separate behaviour from mechanism.");
    expect(toSpec).not.toContain("Every trigger, detection, fallback and coded error");
    expect(toSpec).toContain("at most six clauses");
    expect(toSpec).not.toContain("State the mechanism for anything a clause requires");
    expect(toSpec).not.toContain("- Parity:");
    for (const check of [
      "A concrete value or unverified behaviour not traced to a source is stated as an assumption with a live-test criterion. A clause decides any research finding or assumption it bears on (which folders are writable, what if false), not a test.",
      "for each clause that changes existing behaviour, open the code that behaviour lives in when FACTS doesn't already state it.",
    ]) {
      expect(toSpec).toContain(check);
    }
    // No self-review: the real spec review runs next.
    expect(toSpec).not.toContain("Check before you answer");
    expect(toSpec).not.toContain("planning review skill");
    expect(review).toContain("is never `invented_scope` and never `decision`");
    expect(review).toContain("Never ask for an added clause or criterion");
    // unverifiable is about the code, never about wording.
    expect(review).toContain(
      "`unverifiable`: a clause depends on something about the code that neither FACTS, the excerpts nor the code you opened settles.",
    );
    expect(review).not.toContain("concrete literal");
    expect(toTickets).toContain("Never nest backticks");
    const ticketsSection = review.slice(review.indexOf("## Tickets review"));
    expect(review).toContain("## Tickets review");
    for (const rule of [
      "`untraced_criterion`",
      "`contradiction`",
      "`unsupported_evidence`",
      "`revise`",
      "`decision`",
      "exactly one `work` ticket per criterion",
      "CSV format",
      "two incompatible slicings",
      "Review of: tickets",
      "every time",
      "scoped re-review",
    ]) {
      expect(ticketsSection).toContain(rule);
    }
    expect(ticketsSection).not.toContain("uncovered_clause");
    for (const kind of [
      "`contradiction`",
      "`invented_scope`",
      "`dropped_resolution`",
      "a research finding or assumption a clause bears on but ignores or defers",
      "`revise`",
      "`decision`",
    ]) {
      expect(review).toContain(kind);
    }
  });
});

// Slice 8b D6, D8: a later map's revision. Each new request field reaches its prompt.
const touch = {
  specNumber: 4,
  specTitle: "Count words",
  revision: 2,
  content,
  criteria: [
    {
      id: "1.1",
      text: "Counting splits on whitespace.",
      baseline: { ticket: "T1", run: 3, commit: "abc1234" },
    },
  ],
};
const projectSpec = {
  latest: { specNumber: 4, revision: 2, content },
  retiredIds: [],
  approved: { specNumber: 4, revision: 2, content },
  delivered: true,
  hold: null,
  writerMapId: "01a13c3d-5793-7224-8cbe-ebd162ca7eb3",
};
const heldSpec = {
  latest: { specNumber: 5, revision: 3, content },
  retiredIds: [],
  approved: { specNumber: 5, revision: 2, content },
  delivered: false,
  hold: { kind: "revision" as const, mapId: "map-b", mapTitle: "Other map", revision: 3 },
  writerMapId: "01a13c3d-5793-7224-8cbe-ebd162ca7eb4",
};
const wait = { specNumber: 5, note: "Spec 5 also refuses symlinks." };
const touchedMap = {
  ...map,
  waypoints: map.waypoints.map((waypoint, index) =>
    index === 0 ? { ...waypoint, touches: [touch] } : waypoint,
  ),
  waits: [wait],
};
const removed = {
  clause: { id: "C1", title: "Same", text: "Same.", criteria: [], sources: [] },
  criterion: { id: "1.3", text: "Gone." },
};
const delta = {
  before: 1,
  after: 2,
  clauses: { C1: "changed" as const, C2: "unchanged" as const },
  criteria: {
    "1.1": { change: "unchanged" as const, before: null },
    "1.2": { change: "changed" as const, before: { id: "1.2", text: "Old." } },
    "2.1": { change: "new" as const, before: null },
  },
  removedClauses: [],
  removedCriteria: [removed],
  outOfScopeAdded: [],
  outOfScopeDropped: [],
};
const middle = {
  clause: { id: "C3", title: "Gone", text: "Gone.", criteria: [], sources: [] },
  criterion: { id: "3.1", text: "Dropped in a middle revision." },
};
const baseline = { ticket: "T1", revision: 1, run: 3, commit: "abc1234" };
const readings = {
  "1.1": {
    change: "unchanged" as const,
    expectation: { kind: "delivered" as const, why: "Unchanged since T1 delivered it." },
    baseline,
    departure: {
      question: "1.1 is unchanged and T1 delivered it: why does it need work?",
      reason: null,
    },
  },
  "1.2": {
    change: "changed" as const,
    expectation: { kind: "work" as const, why: "Its text changed." },
    baseline,
    departure: null,
  },
};
const earlierTicket = {
  id: "T1",
  title: "Count words",
  criteria: ["1.1", "1.2"],
  revision: 1,
  delivered: { run: 3, commit: "abc1234" },
};
const touchingWaypoint = {
  number: 1,
  title: "Same folder",
  resolution: "When their real paths match.",
};

describe("a later map's revision (slice 8b D6, D8)", () => {
  test("DraftSpecs carries the project specs with holds, each waypoint's touches and the open waits", () => {
    const prompt = buildDraftSpecsPrompt(
      {
        ...draftSpecsRequest(),
        ...touchedMap,
        projectSpecs: [projectSpec, heldSpec],
      },
      LIMITS,
    );
    expect(prompt).toContain(projectSpecLine(projectSpec));
    expect(prompt).toContain(projectSpecLine(heldSpec));
    expect(projectSpecLine(projectSpec)).toContain("approved, delivered, not held:");
    expect(projectSpecLine(heldSpec)).toContain("not approved, not delivered, held (revision)");
    expect(prompt).toContain(touchLine(touch));
    expect(prompt).toContain("Baseline 1.1: T1, run 3, commit abc1234");
    expect(prompt).toContain(openWaitsLine([wait]));
    expect(prompt).toContain(wait.note);
    expect(prompt).toMatch(/^<<<SPEC-4-REVISION-2 \S+$/m);
  });

  test("a held spec names its latest approved revision, its criterion ids and its text (L213 D-5)", () => {
    const prompt = buildDraftSpecsPrompt(
      {
        ...draftSpecsRequest(),
        projectSpecs: [projectSpec, heldSpec],
      },
      LIMITS,
    );
    expect(latestApprovedLine(heldSpec)).toBe("Project spec 5 latest approved revision: 2");
    expect(prompt).toContain(latestApprovedLine(heldSpec));
    expect(prompt).toContain("Project spec 5 approved criterion ids: ");
    expect(prompt).toMatch(/^<<<SPEC-5-REVISION-2 \S+$/m);
    expect(prompt).toMatch(/^<<<SPEC-5-REVISION-3 \S+$/m);
    // An unheld approved spec prints its revision once.
    expect(prompt).toContain(latestApprovedLine(projectSpec));
    expect(prompt).not.toContain("Project spec 4 approved criterion ids:");
    const none = { ...heldSpec, approved: null };
    expect(latestApprovedLine(none)).toBe("Project spec 5 latest approved revision: none");
  });

  test("ReviseSpec carries the project specs, and a wait's note as its feedback", () => {
    const prompt = buildReviseSpecPrompt(
      {
        ...reviseRequest(),
        ...touchedMap,
        projectSpecs: [projectSpec],
        feedback: { kind: "wait", note: "Refuse symlinks too.", noteDirected: false },
      },
      LIMITS,
    );
    expect(prompt).toContain(projectSpecLine(projectSpec));
    expect(prompt).toContain("Revise because: wait");
    expect(prompt).toMatch(/^<<<WAIT \S+\nRefuse symlinks too\.\n/m);
    expect(prompt).toContain(touchLine(touch));
  });

  // S8b-16 (N-1): a release run is offered only the sources core accepts for it.
  test("ReviseSpec: a decision-born wait cites waypoints or the destination, never a note", () => {
    const prompt = buildReviseSpecPrompt(
      {
        ...reviseRequest(),
        feedback: { kind: "wait", note: "Refuse symlinks too.", noteDirected: false },
      },
      LIMITS,
    );
    const lines = prompt.split("\n");
    expect(lines).toContain(waitSourceLine(false));
    expect(lines).toContain('{ "kind": "destination" }. Cite no note for it.');
    expect(prompt).not.toContain('changes cites { "kind": "note" }');
  });

  test("ReviseSpec: a note-directed wait cites the note", () => {
    const prompt = buildReviseSpecPrompt(
      {
        ...reviseRequest(),
        feedback: { kind: "wait", note: "Refuse symlinks too.", noteDirected: true },
      },
      LIMITS,
    );
    const lines = prompt.split("\n");
    expect(lines).toContain(waitSourceLine(true));
    expect(lines).toContain('changes cites { "kind": "note" }.');
    expect(prompt).not.toContain("Cite no note for it.");
  });

  test("ReviewSpec carries touches, open waits, before's delivery and the S8b-17 rules", () => {
    const prompt = buildReviewSpecPrompt(
      {
        ...reviewRequest(),
        ...touchedMap,
        before: { ...r1, delivery: { run: 3, commit: "abc1234" } },
      },
      LIMITS,
    );
    expect(prompt).toContain(previousDeliveryLine({ run: 3, commit: "abc1234" }));
    expect(prompt).toContain(touchLine(touch));
    expect(prompt).toContain(openWaitsLine([wait]));
    for (const line of REVISION_REVIEW_RULES) expect(prompt).toContain(line);
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).toContain(previousDeliveryLine(null));
  });

  test("ReviewSpec names the changes since the approved revision; unchanged clauses are context (L213 D-6)", () => {
    const changes = {
      since: 2,
      writer: { kind: "another-map" as const, mapTitle: "Trim and collapse" },
      changedClauses: ["C1"],
      unchangedClauses: ["C2", "C3"],
    };
    const prompt = buildReviewSpecPrompt({ ...reviewRequest(), changes }, LIMITS);
    expect(changesSinceLine(changes)).toBe(
      "Changes since approved revision 2, written by map “Trim and collapse”",
    );
    expect(prompt).toContain(changesSinceLine(changes));
    expect(prompt.split("\n")).toContain("Clauses new or changed since then: C1");
    expect(prompt.split("\n")).toContain("Clauses unchanged since then: C2, C3");
    expect(prompt).toMatch(/They are context: never report one as a contradiction/);
    expect(changesSinceLine({ ...changes, writer: { kind: "this-map" } })).toBe(
      "Changes since approved revision 2, written by this map",
    );
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).toContain(
      "Changes since approved revision: none.",
    );
  });

  test("DraftTicketSet carries the start number, delta, readings, earlier tickets and touching waypoints", () => {
    const prompt = buildDraftTicketSetPrompt(
      {
        ...ticketsRequest(),
        firstTicketNumber: 3,
        delta,
        readings,
        takenOut: [removed, middle],
        earlierTickets: [earlierTicket],
        touchingWaypoints: [touchingWaypoint],
      },
      12,
      LIMITS,
    );
    expect(prompt).toContain(firstTicketNumberLine(3));
    // Every criterion core takes out, the one dropped in a middle revision too (L213 D-1).
    expect(prompt).toContain(removedCriterionLine(middle));
    expect(prompt).toContain(textDeltaLine(delta));
    expect(prompt).toContain(removedCriterionLine(removed));
    expect(prompt).toContain(readingLine("1.1", readings["1.1"]));
    expect(prompt).toContain("Reading 1.1: unchanged, expected delivered, baseline T1");
    expect(prompt).toContain(earlierTicketLine(earlierTicket));
    expect(prompt).toContain(touchingWaypointsLine([touchingWaypoint]));
    expect(prompt).toContain(touchingWaypoint.resolution);
    // To Tickets writes the dispositions: it sees no departure lines.
    expect(prompt).not.toContain(departureLine("1.1", null));
    expect(buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS)).toContain(textDeltaLine(null));
  });

  test("DraftTicketSet reads the map, its research and the writing rules, and no readings on revision 1", () => {
    const first = buildDraftTicketSetPrompt({ ...ticketsRequest(), readings }, 12, LIMITS);
    expect(first).toContain(map.destination);
    expect(first).toContain("Renaming a project.");
    expect(first).toContain("- Real paths nest: A real path under another is nested.");
    expect(first).toContain("- Node fs.realpath (https://nodejs.org/api/fs.html)");
    expect(first).toContain(TICKET_WRITING_RULES.join("\n"));
    // The title, slicing and execution are the person's, in plain words; the build keeps the detail.
    expect(first).toContain(TICKET_CONCISION_RULE.join("\n"));
    expect(first).toContain(
      "- title: the one outcome the person can see once the ticket lands, in one short plain phrase someone",
    );
    expect(first).toContain("never a list of features joined by\n  commas or and.");
    expect(first).toContain("- slicing: one short plain line per ticket");
    expect(first).toContain(
      "The slicing and the execution name no file, package, function, type, field, flag, error code or",
    );
    expect(first).toContain(
      "the plain title, slicing and execution never take detail out\nof them.",
    );
    // Stated once, before the lengths it is written to.
    expect(first.split(TICKET_CONCISION_RULE.join("\n"))).toHaveLength(2);
    expect(first.indexOf(TICKET_CONCISION_RULE.join("\n"))).toBeLessThan(
      first.indexOf("\nLimits:"),
    );
    // A first revision's readings say only "added, expected work, baseline none".
    expect(first).not.toMatch(/^Reading /m);
    const later = buildDraftTicketSetPrompt({ ...ticketsRequest(), delta, readings }, 12, LIMITS);
    expect(later).toContain(readingLine("1.1", readings["1.1"]));
  });

  test("the tickets review checks pointers and work the code already has, and never traces pointers", () => {
    const prompt = buildReviewTicketSetPrompt(
      ticketsReviewRequest(),
      PLANNING_SKILLS.planningReview,
      LIMITS,
    );
    expect(prompt).toContain(TICKETS_REVIEW_REPOSITORY_RULE.join("\n"));
    // Detail a build or testing line states is stated; the review never asks to move it into a title.
    expect(prompt).toContain("move it into a title, the slicing or the execution.");
    expect(prompt).not.toContain(TICKET_CONCISION_RULE.join("\n"));
  });

  test("the tickets review carries the delta, the readings with each departure and the touching waypoints", () => {
    const prompt = buildReviewTicketSetPrompt(
      { ...ticketsReviewRequest(), delta, readings, touchingWaypoints: [touchingWaypoint] },
      PLANNING_SKILLS.planningReview,
      LIMITS,
    );
    expect(prompt).toContain(textDeltaLine(delta));
    expect(prompt).toContain(readingLine("1.2", readings["1.2"]));
    expect(prompt).toContain(departureLine("1.1", null));
    expect(prompt).toContain(readings["1.1"].departure.question);
    expect(prompt).toContain(touchingWaypointsLine([touchingWaypoint]));
    const reasoned = buildReviewTicketSetPrompt(
      {
        ...ticketsReviewRequest(),
        delta,
        readings: {
          "1.1": {
            ...readings["1.1"],
            departure: { ...readings["1.1"].departure, reason: "The separator moved." },
          },
        },
      },
      PLANNING_SKILLS.planningReview,
      LIMITS,
    );
    expect(reasoned).toContain(departureLine("1.1", "The separator moved."));
    expect(reasoned).toMatch(/^<<<REASON-1\.1 \S+\nThe separator moved\.\n/m);
  });

  test("DraftSpecs returns waits, and DraftTicketSet the new kinds with zero tickets, as parsed", async () => {
    const drafted = await draftSpecsWith(config(writeStandIn({ specs: [], waits: [wait] })), skill)(
      draftSpecsRequest(),
      SESSION,
    );
    expect(drafted.ok ? drafted.value.waits : drafted.error.code).toEqual([wait]);
    const empty = {
      tickets: [],
      dispositions: [
        { criterion: "1.1", kind: "delivered", ticket: "T1", reason: null },
        { criterion: "1.2", kind: "retained", ticket: "T2", reason: null },
        { criterion: "1.3", kind: "removed", ticket: null, reason: "Never delivered." },
      ],
      slicing: "Nothing new to build.",
      execution: "Nothing to run.",
    };
    const written = await draftTicketSetWith(config(writeStandIn(empty)), skill)(
      ticketsRequest(),
      SESSION,
    );
    expect(written.ok ? written.value : written.error.code).toEqual(empty);
  });
});

describe("the product skills for a later map's revision (slice 8b D6, D8)", () => {
  test("state revising, kept ids, waits, the five kinds, departures and the touch rule", () => {
    const toSpec = readFileSync(PLANNING_SKILLS.toSpec, "utf8");
    const toTickets = readFileSync(PLANNING_SKILLS.toTickets, "utf8");
    const review = readFileSync(PLANNING_SKILLS.planningReview, "utf8");
    for (const rule of ["## Revising a project spec", "kept id keeps its meaning", "`waits`"]) {
      expect(toSpec).toContain(rule);
    }
    for (const kind of ["`work`", "`satisfied`", "`delivered`", "`retained`", "`removed`"]) {
      expect(toTickets).toContain(kind);
    }
    for (const rule of ["`followUp`", "First ticket number", "zero tickets", "Takes out"]) {
      expect(toTickets).toContain(rule);
    }
    for (const rule of ["`disposition_without_reason`", "Touch rule", "Kept-id rule"]) {
      expect(review).toContain(rule);
    }
  });
});

describe("claudeCodePlanningAgent", () => {
  function agentConfig(
    claudePath: string,
  ): AgentConfig & { sessionsDir: string; skillsDir: string } {
    return {
      skillsDir: SKILLS_DIR,
      claudePath,
      wayfindingModel: "wayfinding-model-x",
      specModel: "spec-model-y",
      models: {
        "wayfinding-model-x": AIMED_LIMITS,
        "spec-model-y": LIMITS,
        "unused-model-z": LIMITS,
      },
      effort: "medium",
      maxTurns: 12,
      timeoutSeconds: 30,
      sessionsDir: dir,
    };
  }

  test("a wayfinding run gets agent.wayfindingModel", async () => {
    const agent = claudeCodePlanningAgent(agentConfig(writeStandIn({})));
    await agent.chartMap(
      {
        projectName: "wordcount",
        projectFolder,
        baseBranch: "main",
        idea: IDEA,
        projectProposals: [],
        projectMaps: [{ title: null, stage: "idea" }],
        mapRounds: [],
        proposed: null,
        projectSpecs: [],
        split: [],
        refusedAttempt: null,
      },
      SESSION,
    );
    expect(flag(recordedArgv(), "--model")).toBe("wayfinding-model-x");
    expect(flag(recordedArgv(), "--json-schema")).toBe(chartProposalJsonSchema(AIMED_LIMITS));
    expect(recordedArgv().some((arg) => arg.includes("about 180 characters (at most 200)"))).toBe(
      true,
    );
  });

  test("spec runs get agent.specModel", async () => {
    const agent = claudeCodePlanningAgent(agentConfig(writeStandIn({})));
    await agent.draftSpecs(draftSpecsRequest(), SESSION);
    expect(flag(recordedArgv(), "--model")).toBe("spec-model-y");
    expect(flag(recordedArgv(), "--json-schema")).toBe(draftSpecsJsonSchema(LIMITS));
    await agent.draftTicketSet(ticketsRequest(), SESSION);
    expect(flag(recordedArgv(), "--model")).toBe("spec-model-y");
  });
});

describe("clause declarations and the code they rely on (RC1, RC2)", () => {
  const reference = {
    clauseId: "C1",
    name: "addProject",
    path: "packages/core/src/project.ts",
    line: 12,
    meaning: null,
    excerpt: "12: export function addProject() {}",
  };

  test("To Spec, first draft or repair, declares reliesOn and adds", () => {
    expect(buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS)).toContain(
      SPEC_DECLARATION_RULE.join("\n"),
    );
    expect(buildReviseSpecPrompt(reviseRequest(), LIMITS)).toContain(
      SPEC_DECLARATION_RULE.join("\n"),
    );
  });

  test("the repair and the review read each reliance with the code around it", () => {
    const repair = buildReviseSpecPrompt({ ...reviseRequest(), references: [reference] }, LIMITS);
    const review = buildReviewSpecPrompt({ ...reviewRequest(), references: [reference] }, LIMITS);
    for (const prompt of [repair, review]) {
      expect(prompt).toMatch(
        /<<<REFERENCES [0-9a-f-]{36}\nC1 relies on addProject \(packages\/core\/src\/project\.ts:12\)\n12: export function addProject\(\) \{\}\nREFERENCES [0-9a-f-]{36}>>>/,
      );
    }
    const moved = buildReviewSpecPrompt(
      { ...reviewRequest(), references: [{ ...reference, line: null, excerpt: null }] },
      LIMITS,
    );
    expect(moved).toContain(
      "C1 relies on addProject (no longer found in packages/core/src/project.ts)",
    );
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).not.toContain("REFERENCES");
  });

  test("the review settles the survey's unverifiable items a clause depends on, or reports them", () => {
    const surveyed = buildReviewSpecPrompt({ ...reviewRequest(), survey: SURVEY }, LIMITS);
    expect(surveyed).toContain(surveyItemsRule(SURVEY).join("\n"));
    expect(surveyed).toContain("FACTS' unverifiable items (U1 to U1)");
    expect(surveyItemsRule(null)).toEqual([
      "The survey lists no unverifiable item: verified is empty.",
    ]);
  });
});

describe("the spec and ticket runs' lengths follow the model's limits (agent.models)", () => {
  const D = DISTINCT_LIMITS;
  // A reliesOn path's, a ticket pointer's and a verified item's path bound is structural.
  const fixedPaths = [300];
  const revision = [
    "specTitle",
    "specProse",
    "clauseTitle",
    "clauseText",
    "criterionText",
    "clauseName",
    "contentLine",
  ] as const;
  const runs = [
    [
      "a map-scope To Spec run",
      () => ({
        prompt: buildDraftSpecsPrompt(draftSpecsRequest(), D),
        jsonSchema: draftSpecsJsonSchema(D),
        fields: ["waitNote", ...revision],
        fixed: fixedPaths,
      }),
    ],
    [
      "a spec repair",
      () => ({
        prompt: buildReviseSpecPrompt(reviseRequest(), D),
        jsonSchema: reviseSpecJsonSchema(D),
        fields: [...revision, "removalReason"],
        fixed: fixedPaths,
      }),
    ],
    [
      "a spec review",
      () => ({
        prompt: buildReviewSpecPrompt(reviewRequest(), D),
        jsonSchema: reviewSpecJsonSchema(D),
        fields: [
          "waypointTitle",
          "waypointQuestion",
          "findingExplanation",
          "surveyText",
          "specReviewSummary",
        ],
        fixed: fixedPaths,
      }),
    ],
    [
      "a To Tickets run",
      () => ({
        prompt: buildDraftTicketSetPrompt(ticketsRequest(), 12, D),
        jsonSchema: draftTicketSetJsonSchema(D),
        fields: [
          "contentLine",
          "ticketTitle",
          "ticketBuild",
          "dispositionText",
          "ticketSetSlicing",
          "ticketSetExecution",
        ],
        fixed: fixedPaths,
      }),
    ],
    [
      "a tickets review",
      () => ({
        prompt: buildReviewTicketSetPrompt(ticketsReviewRequest(), "/skills/review/SKILL.md", D),
        jsonSchema: reviewTicketSetJsonSchema(D),
        fields: [
          "ticketsReviewSummary",
          "ticketsReviewFindingTitle",
          "ticketsReviewFindingExplanation",
          "ticketsReviewFindingQuestion",
        ],
        fixed: [],
      }),
    ],
  ] as const;

  test.each(runs)("%s states every length its --json-schema bounds", (_name, run) => {
    const { prompt, jsonSchema, fields, fixed } = run();
    expect(boundFields(jsonSchema).fields).toEqual(fields);
    expect(boundFields(jsonSchema).fixed).toEqual(fixed);
    expect(unstatedLengths(prompt, jsonSchema, [])).toEqual([]);
  });
});

describe("the spec prompts' destination rounds (DR-16, DR-17)", () => {
  const PHRASE = "the destination and the person's answers to its rounds";

  test("To Spec, its repair and the spec review render the map-level rounds right after the destination", () => {
    expectRoundsAfterDestination(buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS));
    expectRoundsAfterDestination(buildReviseSpecPrompt(reviseRequest(), LIMITS));
    expectRoundsAfterDestination(buildReviewSpecPrompt(reviewRequest(), LIMITS));
  });

  test("To Tickets and the tickets review render no map-level round", () => {
    expect(buildDraftTicketSetPrompt(ticketsRequest(), 12, LIMITS)).not.toContain("MAP-ROUND-");
    expect(buildReviewTicketSetPrompt(ticketsReviewRequest(), skill.path, LIMITS)).not.toContain(
      "MAP-ROUND-",
    );
  });

  test("the tracing rule, the revision sources line and invented_scope name the destination's answers", () => {
    expect(SPEC_TRACING_RULE.join(" ")).toContain(PHRASE);
    const revising = buildDraftSpecsPrompt(draftSpecsRequest(), LIMITS);
    expect(revising).toMatch(/^Every clause new in a revision names its sources: /m);
    expect(revising).toContain(
      `${PHRASE}, both cited as { "kind": "destination" };\ncite a note only when this prompt gives one.`,
    );
    expect(SPEC_TRACING_RULE.join(" ")).not.toMatch(/, or a note\./);
    expect(SPEC_TRACING_RULE.join(" ")).toContain(
      `${PHRASE} (cited as { "kind": "destination" }), or, only where this prompt gives one, a note.`,
    );
    expect(buildReviewSpecPrompt(reviewRequest(), LIMITS)).toContain(
      `that no resolution, nor\n${PHRASE}, supports: a new surface`,
    );
  });
});
