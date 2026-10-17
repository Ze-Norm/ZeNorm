import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodeSurvey,
  type PlanningRunConfig,
  ChartConfirmation,
  chartConfirmation,
  type ChartFollowUp,
  type ChartMapRequest,
  type ChartProposal,
  type GrillWaypointRequest,
  type PlanningCallSession,
  WAYPOINT_AGENT_DECIDED_MAX_COUNT,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  chartChoiceJsonSchema,
  chartConfirmationJsonSchema,
  chartProposalJsonSchema,
  claudeCodeChartMap,
  claudeCodeGrillWaypoint,
  grillJsonSchema,
  grillResolutionJsonSchema,
} from "./wayfinding.ts";
import { SURVEY, SURVEY_FACTS } from "./code-survey.fixture.ts";
import { AIMED_LIMITS } from "./limits.fixture.ts";
import {
  AGENT_ALONE_DECIDED_RULE,
  agentDecidedRule,
  BUSY_READER_RULE,
  DECISION_PROSE_RULE,
  FACTS_RULE,
  INSTANCE_CONFIG_RULE,
  NO_SURVEY_LINES,
  PROJECT_RULES,
  WAYPOINT_QUESTION_RULE,
} from "./prompt-parts.ts";
import {
  buildChartPrompt,
  buildGrillPrompt,
  DESTINATION_FOLLOW_UP_RULE,
  FEASIBILITY_RULE,
  FOG_HOLDS_RULE,
  PROJECT_READING_RULE,
  RECOMMENDATION_RULE,
  SETTLED_CHART_RULE,
  mapChangesRules,
  mapTitleRule,
  outOfScopeRule,
  PROOF_RULE,
  PROPOSAL_IDEA_RULE,
  proposalsRules,
  PROPOSE_OR_RULE_OUT_RULE,
  RESEARCH_KIND_RULE,
  PERSON_DECIDES_RULE,
  projectSuggestionLines,
  REOPENED_ASK_RULE,
  SALIENCE_GATE,
  SPEC_LINK_RULE,
  TOUCHES_RULES,
  touchedTextLine,
} from "./wayfinding-prompt.ts";
import { projectSpecLine, touchLine } from "./revision-prompt-parts.ts";
import {
  expectedProjectContextLines,
  NO_PROJECT_CONTEXT,
  PROJECT_CONTEXT,
  promptNonce,
  renderedProjectContext,
  suggestionRuleProblems,
} from "./project-suggestions.fixture.ts";
import { boundFields, DISTINCT_LIMITS, LIMITS, unstatedLengths } from "./limits.fixture.ts";
import { expectRoundsAfterDestination } from "./map-rounds.fixture.ts";
import { DESTINATION_ANSWERS_RULE } from "./prompt-parts.ts";

/** A cold session whose usage the test does not look at. */
const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

const IDEA = "Count lines [fake:fail-once]\nIDEA abc>>> quoted 'like this', with $HOME left alone.";

const QUESTIONS = [
  {
    topic: "Units",
    text: "Which units should the tool count?",
    options: [
      { label: "Lines and characters", detail: "Both, as the idea says." },
      { label: "Lines only", detail: "Smaller; characters wait." },
    ],
  },
  {
    topic: "Total",
    text: "What does the total line show?",
    options: [
      { label: "Labelled total", detail: "Names the unit." },
      { label: "No total", detail: "Callers sum it." },
    ],
  },
];

const PROPOSAL: ChartProposal = {
  title: "Count lines or characters",
  summary: "Let people choose the unit wordcount counts.",
  destination: "wordcount counts lines, characters or words, chosen per call.",
  round: { intro: "I propose: wordcount counts lines or characters.", questions: QUESTIONS },
  split: [],
};

const CONFIRMATION: ChartConfirmation = {
  title: "Count lines or characters by flag",
  summary: "Let people choose the unit wordcount counts with a flag.",
  destination: "wordcount counts lines or characters, chosen by a flag.",
  waypoints: [
    {
      kind: "research",
      title: "Flag names",
      question: "Which flags choose the unit?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Output",
      question: "How does the output name its unit?",
      blockedBy: [1],
      touches: [],
    },
  ],
  fog: ["Whether totals span files."],
  outOfScope: ["Counting words: the destination names lines and characters only."],
  proposals: [],
};

const NO_CHANGES = {
  newWaypoints: [],
  fogOutOfScope: [],
  fogDecided: [],
  fogSettledHere: [],
  newFog: [],
};

const RESOLUTION = {
  resolution: "Flags -l and -c choose the unit; the agent chose to refuse both together.",
  gist: "Flags -l and -c",
  agentDecided: ["Refuse -l and -c together"],
};

/** `RESOLUTION` as the model writes it: the prose is `decision`, at the output's root. */
const DECISION = {
  decision: RESOLUTION.resolution,
  gist: RESOLUTION.gist,
  agentDecided: RESOLUTION.agentDecided,
};

/** The proposal as the model writes it: the round's fields at the root. */
const PROPOSAL_OUTPUT = {
  title: PROPOSAL.title,
  summary: PROPOSAL.summary,
  destination: PROPOSAL.destination,
  split: PROPOSAL.split,
  ...PROPOSAL.round,
};

/** A grilling output's fields left null, as the model writes them, before its outcome's are set. */
const NO_GRILL_OUTCOME = {
  intro: null,
  final: null,
  questions: null,
  decision: null,
  gist: null,
  agentDecided: null,
  outOfScope: null,
};

let dir: string;
let projectFolder: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-wayfinding-")));
  projectFolder = join(dir, "project");
  mkdirSync(projectFolder);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function successResult(structuredOutput: unknown): string {
  return JSON.stringify({
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
    structured_output: structuredOutput,
  });
}

/** Writes a logged-in `#!/bin/sh` stand-in whose run records its argv and prints `output`. */
function writeStandIn(output: unknown): string {
  writeFileSync(join(dir, "auth-stdout"), JSON.stringify({ loggedIn: true }));
  writeFileSync(join(dir, "run-stdout"), successResult(output));
  const script = [
    "#!/bin/sh",
    `dir='${dir}'`,
    'if [ "$1" = "auth" ]; then',
    '  cat "$dir/auth-stdout"',
    "  exit 0",
    "fi",
    'printf \'%s\\0\' "$@" > "$dir/argv"',
    'cat "$dir/run-stdout"',
    "exit 0",
    "",
  ].join("\n");
  const path = join(dir, "claude");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

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

function jsonSchema(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" }));
}

/** A `--json-schema`'s root property names, in order. */
function roots(schema: string): string {
  return Object.keys(
    z.object({ properties: z.record(z.string(), z.unknown()) }).parse(JSON.parse(schema))
      .properties,
  ).join(",");
}

function chartRequest(mapRounds: ChartMapRequest["mapRounds"]): ChartMapRequest {
  return {
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea: IDEA,
    ...NO_PROJECT_CONTEXT,
    mapRounds,
    proposed:
      mapRounds.length === 0
        ? null
        : { title: PROPOSAL.title, summary: PROPOSAL.summary, destination: PROPOSAL.destination },
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  };
}

const SUBMITTED_ROUND: ChartMapRequest["mapRounds"][number] = {
  questions: QUESTIONS,
  answers: [
    { optionIndex: 0, note: "", accepted: true },
    { optionIndex: null, note: "Label it like `12 total lines`.", accepted: false },
  ],
  final: false,
};

/** A final follow-up after `SUBMITTED_ROUND`: the chart's step is `confirm`. */
const CONFIRM_ROUNDS: ChartMapRequest["mapRounds"] = [
  SUBMITTED_ROUND,
  { ...SUBMITTED_ROUND, final: true },
];

/** `CONFIRMATION` as a `choose` chart writes it: flat, the follow-up's round fields null. */
const CHOICE_CONFIRMATION = {
  kind: "confirmation",
  intro: null,
  final: null,
  questions: null,
  ...CONFIRMATION,
};

/** A follow-up as the port returns it: the revised reading and destination, and its round. */
const FOLLOW_UP: ChartFollowUp = {
  title: "Count lines, characters or words",
  summary: "Let people choose any of three units.",
  destination: "wordcount counts lines, characters or words, chosen by a flag.",
  round: {
    intro: "Your answer adds words: wordcount counts lines, characters or words.",
    final: true,
    questions: QUESTIONS.slice(0, 1),
  },
};

/** `FOLLOW_UP` as a `choose` chart writes it: flat, the confirmation's fields null. */
const CHOICE_FOLLOW_UP = {
  kind: "followUp",
  title: FOLLOW_UP.title,
  summary: FOLLOW_UP.summary,
  destination: FOLLOW_UP.destination,
  ...FOLLOW_UP.round,
  waypoints: null,
  fog: null,
  outOfScope: null,
  proposals: null,
};

function grillRequest(overrides: Partial<GrillWaypointRequest> = {}): GrillWaypointRequest {
  return {
    survey: null,
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea: IDEA,
    ...NO_PROJECT_CONTEXT,
    title: PROPOSAL.title,
    destination: CONFIRMATION.destination,
    mapRounds: [SUBMITTED_ROUND],
    waypoint: {
      number: 3,
      kind: "grilling",
      title: "Output",
      question: "How does the output name its unit?",
      touches: [],
      rounds: [
        {
          questions: QUESTIONS,
          answers: [
            { optionIndex: 1, note: "", accepted: false },
            { optionIndex: 0, note: "", accepted: true },
          ],
          final: false,
        },
      ],
      reopened: false,
      supersededRounds: [],
      personDecides: false,
    },
    otherWaypoints: [
      {
        number: 1,
        kind: "grilling",
        title: "Flag names",
        status: "resolved",
        gist: "Flags -l and -c",
        agentDecided: ["Refuse -l and -c together"],
        resolution: "Resolved: Flags -l and -c",
      },
      {
        number: 2,
        kind: "research",
        title: "Help text",
        status: "claimed",
        gist: null,
        agentDecided: null,
        resolution: null,
      },
    ],
    otherPendingRounds: [{ waypointTitle: "Help text", questions: QUESTIONS }],
    fog: [{ position: 4, text: "Whether totals span files." }],
    outOfScope: ["Counting words."],
    finding: null,
    reviewFindings: [],
    note: null,
    afterFinal: false,
    refusedAttempt: null,
    ...overrides,
  };
}

/** The idea's nonce block: the start line, the idea verbatim, the end line with the same nonce. */
function expectIdeaInNonceBlock(prompt: string): void {
  const match = /^<<<IDEA ([0-9a-f-]{36})$/m.exec(prompt);
  const nonce = match?.[1];
  if (nonce === undefined) throw new Error("the prompt has no IDEA start line");
  expect(prompt).toContain(`<<<IDEA ${nonce}\n${IDEA}\nIDEA ${nonce}>>>`);
}

describe("buildChartPrompt", () => {
  test("asks each waypoint's question alone, without background or options, as map changes do", () => {
    const confirming = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    expect(confirming).toContain(WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`).join("\n"));
    expect(mapChangesRules(LIMITS).join("\n")).toContain(
      WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`).join("\n"),
    );
  });

  test("puts the idea verbatim in a nonce block, with a fresh nonce per call", () => {
    const first = buildChartPrompt(chartRequest([]), LIMITS);
    const second = buildChartPrompt(chartRequest([]), LIMITS);
    expectIdeaInNonceBlock(first);
    expectIdeaInNonceBlock(second);
    expect(/^<<<IDEA (.+)$/m.exec(first)?.[1]).not.toBe(/^<<<IDEA (.+)$/m.exec(second)?.[1]);
  });

  test("the proposal reads the idea at the project's own unit: the whole group recommended, narrower and wider as alternatives", () => {
    const prompt = buildChartPrompt(chartRequest([]), LIMITS);
    expect(prompt).toContain(PROJECT_READING_RULE.join("\n"));
    const rule = PROJECT_READING_RULE.join(" ");
    expect(rule).toContain(
      "neither wider nor narrower than the unit the project itself treats as that thing",
    );
    expect(rule).toContain("the recommended option covers the whole group");
    expect(rule).toContain("offer narrower and wider readings as alternatives");
    expect(prompt).not.toContain("Read the idea literally");
  });

  test("the first chart may split an idea too big for one map; the confirming chart reads each decision", () => {
    expect(buildChartPrompt(chartRequest([]), LIMITS)).toContain(
      "Is this idea one map or several?",
    );
    expect(buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS)).not.toContain("Split offer");
    const prompt = buildChartPrompt(
      {
        ...chartRequest([SUBMITTED_ROUND]),
        split: [
          { title: "CSV imports", idea: "Import records from CSV.", state: "confirmed" },
          { title: "Nightly exports", idea: "Export every night.", state: "dismissed" },
        ],
      },
      LIMITS,
    );
    expect(prompt).toContain("Split offer 1, created as its own map: leave its work out");
    expect(prompt).toContain("Split offer 2, dismissed: its work stays in this map");
    expect(prompt).toMatch(/<<<SPLIT-1 [0-9a-f-]{36}\nCSV imports\n\nImport records from CSV\./);
  });

  test("a first chart's split offers parse; one outside its bounds is agent_output_invalid", async () => {
    const offer = {
      title: "CSV imports",
      idea: "Import records.",
      line: "Imports are their own map.",
    };
    const split = await claudeCodeChartMap(
      config(writeStandIn({ ...PROPOSAL_OUTPUT, split: [offer] })),
    )(chartRequest([]), SESSION);
    expect(split).toEqual({
      ok: true,
      value: { kind: "proposal", proposal: { ...PROPOSAL, split: [offer] } },
    });
    const tooMany = await claudeCodeChartMap(
      config(writeStandIn({ ...PROPOSAL_OUTPUT, split: [offer, offer, offer, offer] })),
    )(chartRequest([]), SESSION);
    expect(tooMany.ok ? null : tooMany.error.code).toBe("agent_output_invalid");
  });

  test("the confirming chart charts nothing the destination or map-level answers already state", () => {
    expect(buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS)).toContain(
      SETTLED_CHART_RULE.join("\n"),
    );
    expect(buildChartPrompt(chartRequest([]), LIMITS)).not.toContain(SETTLED_CHART_RULE.join("\n"));
  });

  test("setup state is never asked; a burden on users who don't use the capability is salient", () => {
    for (const prompt of [
      buildChartPrompt(chartRequest([]), LIMITS),
      buildGrillPrompt(grillRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(INSTANCE_CONFIG_RULE.join("\n"));
    }
    expect(INSTANCE_CONFIG_RULE.join(" ")).toContain(
      "whether a tool is installed, whether the person is signed in",
    );
    expect(SALIENCE_GATE.join(" ")).toContain(
      "adds required setup, configuration or steps for users who do not use the new capability",
    );
  });

  test("recommendations keep the destination achievable and never re-ask what is settled", () => {
    const rule = RECOMMENDATION_RULE.join("\n");
    for (const prompt of [
      buildChartPrompt(chartRequest([]), LIMITS),
      buildGrillPrompt(grillRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(rule);
    }
    expect(rule).toContain(
      "is never the recommendation unless the risk is severe and named concretely",
    );
    expect(rule).toContain("workable mitigation as the");
    // A recommendation follows the project's rules; a rule-breaking option names the rule.
    expect(rule).toContain(
      "The recommended option complies with the rules the project's instruction",
    );
    expect(rule).toContain(
      "only if its detail names the rule it breaks, and is never the recommendation.",
    );
    // A choice a project rule settles is decided per the rule, in every chart and grill prompt.
    expect(rule).toContain("A choice such a rule settles is no question");
    expect(rule).toContain("decide it per the rule and cite the rule");
    for (const prompt of [
      buildChartPrompt(chartRequest([]), LIMITS),
      buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS),
      buildGrillPrompt(grillRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(SALIENCE_GATE.join("\n"));
    }
    expect(SALIENCE_GATE.join(" ")).toContain(
      "decide any choice a rule in the project's instruction files settles, per that rule, citing the rule; never ask it.",
    );
    expect(rule).toContain(
      "Never ask what the destination, a map-level answer or another resolution already settles.",
    );
    expect(SALIENCE_GATE.join(" ")).toContain(
      "Nor decide alone a refusal or block on the ordinary path of the capability the destination asks for",
    );
    expect(SALIENCE_GATE.join(" ")).toContain(
      "A refusal in an edge state off that path is yours: decide it and state it as an assumption",
    );
    // A general rule the person stated in an answer settles the cases it covers, in every chart and grill prompt.
    expect(SALIENCE_GATE.join(" ")).toContain(
      "A general rule the person stated in an answer settles every case it covers the same way: decide each, and say the decision is derived from that answer",
    );
  });

  test("a grill reads the map-level rounds and the person's answers, as the chart does", () => {
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    expect(prompt).toContain("Map-level round 1:");
    expect(prompt).toMatch(/<<<MAP-ROUND-1-QUESTION-2 [0-9a-f-]{36}\n/);
    expect(prompt).toContain("Label it like `12 total lines`.");
  });

  test("the proposal prompt carries destination first and an intro that states it", () => {
    const prompt = buildChartPrompt(chartRequest([]), LIMITS);
    expect(prompt).toContain("Destination first.");
    expect(prompt).toContain("state the proposed destination");
    expect(prompt).toContain("Recommendation first");
  });

  test("a first chart and every proposal title the map by one rule: a name of a few words", () => {
    const rule = mapTitleRule(AIMED_LIMITS).join("\n");
    expect(rule).toContain("in a few words (about 40 characters (at most 80))");
    expect(rule).toContain("not a sentence. No colon and subtitle");
    const chart = buildChartPrompt(chartRequest([]), AIMED_LIMITS);
    expect(chart).toContain(rule);
    expect(chart).toContain("its name as the title rule above sets out");
    expect(proposalsRules(AIMED_LIMITS).join("\n")).toContain(rule);
    expect(outOfScopeRule(AIMED_LIMITS).join("\n")).toContain(rule);
  });

  test("the confirmation prompt carries the wayfinder rules and the submitted answers", () => {
    const prompt = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    expectIdeaInNonceBlock(prompt);
    expect(prompt).toContain("Destination first.");
    expect(prompt).toContain("Keep each waypoint bounded");
    expect(prompt).toContain("does not overlap its neighbours");
    expect(prompt).toContain(
      "Block a waypoint on every waypoint whose answer would change its options",
    );
    expect(prompt).toContain("0 to 12 waypoints");
    expect(prompt).toContain("Chosen option: Lines and characters");
    expect(prompt).toContain("accepted your recommendation");
    expect(prompt).toContain("Label it like `12 total lines`.");
  });

  test("the confirmation prompt carries the kinds, fog and Out of scope rules", () => {
    const prompt = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    expect(prompt).toContain("research: a named unknown fact that could change a decision");
    expect(prompt).toContain("that reading the repository or the\n  web answers");
    expect(prompt).toContain("task: mechanical work a decision needs");
    expect(prompt).toContain("Choose the kind by who can settle the question.");
    expect(prompt).toContain("Then the fog (0 to 8 lines)");
    expect(prompt).toContain("With no waypoint charted, chart no fog.");
    expect(prompt).toContain("Then the Out of scope lines (0 to 8)");
  });

  test("how the change is proven is never asked, in the destination round or as an either/or", () => {
    for (const prompt of [
      buildChartPrompt(chartRequest([]), LIMITS),
      buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS),
      buildGrillPrompt(grillRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(PROOF_RULE.join("\n"));
    }
    expect(PROOF_RULE.join(" ")).toContain("never ask it in the destination round");
  });

  test("both chart prompts carry the salience gate and the busy-reader rule", () => {
    for (const prompt of [
      buildChartPrompt(chartRequest([]), LIMITS),
      buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS),
    ]) {
      expect(prompt).toContain(SALIENCE_GATE.join("\n"));
      expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
    }
    const confirm = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    expect(confirm).toContain("never a Grilling waypoint");
    expect(confirm).toContain("passes the salience gate");
  });

  test("fog never holds implementation mechanics, and waypoint runs leave other fog to the fog run", () => {
    expect(buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS)).toContain(
      FOG_HOLDS_RULE.join("\n"),
    );
    const rules = mapChangesRules(LIMITS).join("\n");
    expect(rules).toContain("- fogDecided and fogOutOfScope: leave empty.");
    expect(rules).toContain("the map's fog run settles it");
    expect(rules).toContain("Implementation mechanics never go into fog");
    expect(buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS)).toContain(
      "never for engineering work",
    );
  });

  test("research is charted only for what sources answer; proof is never fog; feasibility blocks", () => {
    const confirm = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    expect(confirm).toContain(RESEARCH_KIND_RULE.map((line) => `  ${line}`).join("\n"));
    expect(FOG_HOLDS_RULE.join(" ")).toContain("test coverage, stand-in or live tests");
    expect(confirm).toContain("Block a grilling waypoint on the research that settles");
    const rules = mapChangesRules(LIMITS).join("\n");
    expect(rules).toContain("never one only running");
    expect(rules).toContain("- fogSettledHere: positions of fog items your own resolution");
  });

  test("the proposal prompt carries no kinds, fog or Out of scope rules", () => {
    const prompt = buildChartPrompt(chartRequest([]), LIMITS);
    expect(prompt).not.toContain("Then the fog");
    expect(prompt).not.toContain("Then the Out of scope lines");
  });
});

describe("buildGrillPrompt", () => {
  test("puts the idea in a nonce block and carries the stand-in's two plain lines", () => {
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    expectIdeaInNonceBlock(prompt);
    const lines = prompt.split("\n");
    expect(lines).toContain("Waypoint number: 3");
    expect(lines).toContain("Answered rounds on this waypoint: 1");
  });

  test("counts zero answered rounds on a fresh waypoint", () => {
    const request = grillRequest();
    const prompt = buildGrillPrompt(
      { ...request, waypoint: { ...request.waypoint, rounds: [] } },
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Answered rounds on this waypoint: 0");
  });

  test("carries the grilling rules", () => {
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    expect(prompt).toContain("Recommendation first");
    expect(prompt).toContain("Every option is a real choice");
    expect(prompt).toContain("Options are parallel");
    expect(prompt).toContain("Questions in the round are independent");
    expect(prompt).toContain("Ask only about your own waypoint");
    expect(prompt).toContain("Mark the round final only when its answers will settle");
    expect(prompt).toContain("Set kind to round, resolution or\noutOfScope");
    expect(prompt).toContain("Flags -l and -c");
    expect(prompt).toContain("Waypoint: Help text");
  });

  test("carries the salience gate with the skills' sentences, the bounds and the busy-reader rule", () => {
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    expect(prompt).toContain(SALIENCE_GATE.join("\n"));
    expect(SALIENCE_GATE.join(" ")).toContain(
      "Ask about observable behavior and meaningful tradeoffs; derive routine record structures and mechanics from those answers.",
    );
    expect(SALIENCE_GATE.join(" ")).toContain(
      "Ask about an assumption only if it changes scope or creates a prerequisite; otherwise leave implementation flexibility in the answer.",
    );
    expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
    expect(prompt).toContain("the question itself (at most 200 characters)");
    expect(prompt).toContain("a detail (at most 200 characters)");
    expect(prompt).toContain("intro of at most 300 characters.");
    expect(prompt).toContain("decision: the settled decision in prose, at most 800 characters,");
    const aimed = buildGrillPrompt(grillRequest(), AIMED_LIMITS);
    expect(aimed).toContain("the question itself (at most 200 characters)");
    expect(aimed).toContain("a detail (about 180 characters (at most 200))");
    expect(aimed).toContain("intro of about 250 characters (at most 300).");
    expect(aimed).toContain(
      "decision: the settled decision in prose, about 700 characters (at most 1000),",
    );
    expect(buildChartPrompt(chartRequest([]), AIMED_LIMITS)).toContain(
      "confirming; about 250 characters (at most 300).",
    );
    expect(buildChartPrompt(chartRequest([]), LIMITS)).toContain(
      "confirming; at most 300 characters.",
    );
    expect(prompt).not.toContain("the decisions are theirs");
    expect(mapChangesRules(LIMITS).join("\n")).toContain(
      "Ordinary implementation choices are not waypoints",
    );
    expect(buildGrillPrompt(grillRequest({ afterFinal: true }), LIMITS)).toContain(
      SALIENCE_GATE.join("\n"),
    );
  });

  test("options carry their feasibility; no run is told to settle fog it does not own", () => {
    expect(buildGrillPrompt(grillRequest(), LIMITS)).toContain(FEASIBILITY_RULE.join("\n"));
    const request = grillRequest();
    const last = buildGrillPrompt(
      {
        ...request,
        otherWaypoints: request.otherWaypoints.map((other) => ({
          ...other,
          status: "resolved",
          gist: "Settled",
          agentDecided: [],
          resolution: "Resolved: Settled",
        })),
      },
      LIMITS,
    );
    expect(last).not.toContain("You are the last unsettled waypoint");
    expect(last).not.toContain("Other waypoints open or claimed");
  });

  test("project rules, guardrails and research-consistent premises; other waypoints show their resolutions", () => {
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    expect(prompt).toContain(PROJECT_RULES.join("\n"));
    expect(PROJECT_RULES.join(" ")).not.toContain("AGENTS.md");
    expect(SALIENCE_GATE.join(" ")).toContain(
      "removes or weakens an existing safety guarantee, permission boundary or enforced guardrail",
    );
    expect(prompt).toContain("never state an absence or limit they contradict");
    // Instance configuration is never asked: the gate in every chart and grill prompt says so.
    expect(prompt).toContain(INSTANCE_CONFIG_RULE.join("\n"));
    expect(buildChartPrompt(chartRequest([]), LIMITS)).toContain(INSTANCE_CONFIG_RULE.join("\n"));
    expect(prompt).toContain("Resolution:\nResolved: Flags -l and -c");
    expect(prompt).toContain(
      "Agent decided (calls the agent made without asking the person):\n- Refuse -l and -c together",
    );
    for (const chart of [
      buildChartPrompt(chartRequest([]), LIMITS),
      buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS),
    ]) {
      expect(chart).toContain(PROJECT_RULES.join("\n"));
    }
  });

  test("a waypoint may be resolved with no round when nothing passes the gate, except a reopened one", () => {
    const request = grillRequest();
    const fresh = buildGrillPrompt(
      { ...request, waypoint: { ...request.waypoint, rounds: [] } },
      LIMITS,
    );
    expect(fresh).toContain(
      "Resolve without asking when no open question passes the salience gate",
    );
    // Resolving with no answered round is wholly the agent's call: agentDecided stays empty, and the
    // prose states the decision alone, complete, with no account of the process.
    expect(fresh).toContain(AGENT_ALONE_DECIDED_RULE.join("\n"));
    expect(fresh).not.toContain(agentDecidedRule(LIMITS.agentDecided, 3)[0]);
    expect(fresh).toContain(DECISION_PROSE_RULE.join("\n"));
    expect(fresh).not.toContain("without answering individually, say so");
    expect(fresh).not.toContain("the person can reopen");
    // With an answered round, the calls the agent made itself are listed, and also in the prose.
    const answered = buildGrillPrompt(request, LIMITS);
    expect(answered).toContain(
      agentDecidedRule(LIMITS.agentDecided, WAYPOINT_AGENT_DECIDED_MAX_COUNT).join("\n"),
    );
    expect(answered).not.toContain(AGENT_ALONE_DECIDED_RULE[0]);
    const rule = agentDecidedRule(LIMITS.agentDecided, 3).join(" ");
    for (const part of [
      "a reader might want to   overrule",
      "at most 3",
      "An empty list is normal and better than padding",
      "the gist carries what the person settled, the list only your calls the gist does not state",
      "A fact in the gist never appears in the list, however reworded",
      "Each item is also stated plainly in your prose",
    ]) {
      expect(rule.replace(/\s+/g, " ")).toContain(part.replace(/\s+/g, " "));
    }
    const reopened = buildGrillPrompt(
      {
        ...request,
        waypoint: {
          ...request.waypoint,
          rounds: [],
          reopened: true,
          supersededRounds: request.waypoint.rounds,
        },
      },
      LIMITS,
    );
    expect(reopened).toContain(REOPENED_ASK_RULE.join("\n"));
    expect(reopened).not.toContain("Resolve without asking");
  });

  test("carries the kind, the numbered others, the fog, the Out of scope lines and the map-change rules", () => {
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    const lines = prompt.split("\n");
    expect(lines).toContain("Kind: grilling");
    expect(lines).toContain("Number: 2");
    expect(lines).toContain("Kind: research");
    expect(lines).toContain("Fog item at position 4:");
    expect(lines).toContain("Whether totals span files.");
    expect(lines).toContain("Counting words.");
    expect(prompt).toContain(mapChangesRules(LIMITS).join("\n"));
    expect(prompt).toContain("set outOfScope with the reason");
    expect(prompt).toContain("Set mapChanges exactly when you ask\nno round.");
    expect(prompt).not.toContain("A consistency check over the map's resolved waypoints");
  });

  test("carries the finding that opened the waypoint, with the resolutions it names", () => {
    const prompt = buildGrillPrompt(
      grillRequest({
        finding: {
          kind: "conflicting_surfaces",
          explanation: "Waypoint 1 says -l; waypoint 2 says --lines.",
          waypoints: [{ number: 1, title: "Flag names", resolution: "Flags -l and -c." }],
        },
      }),
      LIMITS,
    );
    expect(prompt).toContain("A consistency check over the map's resolved waypoints");
    expect(prompt).toContain("Kind: conflicting_surfaces");
    expect(prompt).toContain("Explanation: Waypoint 1 says -l; waypoint 2 says --lines.");
    expect(prompt).toContain("Waypoint 1 (Flag names) resolved: Flags -l and -c.");
    // The run settles a finding itself unless the answer passes the salience gate.
    expect(prompt).not.toContain("do not decide it yourself");
    expect(prompt).toContain("otherwise decide it yourself and resolve");
    expect(prompt).toContain("A conflict\nover implementation mechanics");
  });

  test("carries the planning review finding that sent the waypoint on, with its spec and ids", () => {
    const prompt = buildGrillPrompt(
      grillRequest({
        reviewFindings: [
          {
            kind: "undefined_term",
            explanation: "C1 says 'every line', which no source defines.",
            spec: { number: 2, title: "Count lines" },
            elementIds: ["C1", "1.2"],
          },
        ],
      }),
      LIMITS,
    );
    expect(prompt).toContain("Spec: 2 (Count lines)");
    expect(prompt).toContain("Kind: undefined_term");
    expect(prompt).toContain("Explanation: C1 says 'every line', which no source defines.");
    expect(prompt).toContain("Clauses and criteria named: C1, 1.2");
    // The salience gate applies: the run may settle it itself, with no round.
    expect(prompt).not.toContain("do not decide it yourself");
    expect(prompt).toContain("otherwise decide it yourself and resolve with no round");
    expect(buildGrillPrompt(grillRequest(), LIMITS)).not.toContain("REVIEW-FINDING");
  });

  test("carries every review finding that sent the waypoint on, one block each", () => {
    const finding = {
      kind: "undefined_term" as const,
      spec: { number: 2, title: "Count lines" },
      elementIds: ["C1"],
    };
    const prompt = buildGrillPrompt(
      grillRequest({
        reviewFindings: [
          { ...finding, explanation: "C1 says 'every line'." },
          { ...finding, explanation: "C1 says 'blank lines'." },
        ],
      }),
      LIMITS,
    );
    expect(prompt).toContain("Planning reviews found 2 findings this waypoint settles");
    expect(prompt).toContain("Explanation: C1 says 'every line'.");
    expect(prompt).toContain("Explanation: C1 says 'blank lines'.");
    expect(prompt.split("REVIEW-FINDING").length - 1).toBe(4);
  });

  test("a personDecides waypoint with no answered round must ask: the rule, and no self-resolve", () => {
    const request = grillRequest({
      reviewFindings: [
        {
          kind: "existing_records",
          explanation: "The startup sign-in check was never decided by the person.",
          spec: { number: 2, title: "Count lines" },
          elementIds: [],
        },
      ],
    });
    const unasked = buildGrillPrompt(
      {
        ...request,
        waypoint: { ...request.waypoint, rounds: [], personDecides: true },
      },
      LIMITS,
    );
    expect(unasked.split("\n")).toContain(PERSON_DECIDES_RULE);
    expect(unasked).not.toContain("otherwise decide it yourself and resolve with no round");
    expect(unasked).not.toContain("Resolve without asking");
    // Once the person answered a round, the run may resolve.
    const answered = buildGrillPrompt(
      {
        ...request,
        waypoint: { ...request.waypoint, personDecides: true },
      },
      LIMITS,
    );
    expect(answered).not.toContain(PERSON_DECIDES_RULE);
    expect(answered).not.toContain("otherwise decide it yourself and resolve with no round");
    expect(buildGrillPrompt(request, LIMITS)).not.toContain(PERSON_DECIDES_RULE);
  });

  test("carries the person's note about the waypoint, and nothing when it is null", () => {
    const prompt = buildGrillPrompt(
      grillRequest({
        note: { text: "Use --lines, not -l.", sentAt: "2026-10-08T09:30:00.000Z" },
      }),
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Note from the person: sent 2026-10-08T09:30:00.000Z");
    expect(prompt).toMatch(/<<<NOTE [0-9a-f-]{36}\nUse --lines, not -l\.\nNOTE [0-9a-f-]{36}>>>/);
    const none = buildGrillPrompt(grillRequest(), LIMITS);
    expect(none).not.toContain("Note from the person:");
    expect(none).not.toContain("<<<NOTE");
  });

  test("a reopened waypoint's earlier rounds are superseded context, and with none since it must ask", () => {
    const request = grillRequest();
    const reopened = buildGrillPrompt(
      {
        ...request,
        waypoint: {
          ...request.waypoint,
          rounds: [],
          reopened: true,
          supersededRounds: request.waypoint.rounds,
        },
        note: { text: "Decide the total again.", sentAt: "2026-10-08T09:30:00.000Z" },
      },
      LIMITS,
    );
    const lines = reopened.split("\n");
    expect(lines).toContain("Reopened after a resolution: yes");
    expect(lines).toContain("Answered rounds on this waypoint: 0");
    expect(reopened).toMatch(/<<<SUPERSEDED-ROUND-1-QUESTION-1 [0-9a-f-]{36}\n/);
    expect(reopened).not.toMatch(/<<<ROUND-1-QUESTION-1 /);
    expect(reopened).toContain(REOPENED_ASK_RULE.join("\n"));
    // Once a round is asked since the reopen, the run may resolve again.
    const asked = buildGrillPrompt(
      {
        ...request,
        waypoint: {
          ...request.waypoint,
          reopened: true,
          supersededRounds: request.waypoint.rounds,
        },
      },
      LIMITS,
    );
    expect(asked).not.toContain(REOPENED_ASK_RULE.join("\n"));
    expect(asked).toMatch(/<<<ROUND-1-QUESTION-1 /);
    const fresh = buildGrillPrompt(request, LIMITS);
    expect(fresh.split("\n")).toContain("Reopened after a resolution: no");
    expect(fresh).not.toContain("SUPERSEDED-ROUND");
    expect(fresh).not.toContain(REOPENED_ASK_RULE.join("\n"));
  });

  test("a refused previous attempt carries its problem in a nonce block, and nothing when null", () => {
    const problem = "The waypoint was reopened and no round has been asked since.";
    const prompt = buildGrillPrompt(grillRequest({ refusedAttempt: { problem } }), LIMITS);
    expect(prompt).toMatch(/<<<REFUSED [0-9a-f-]{36}\nThe waypoint was reopened/);
    expect(buildGrillPrompt(grillRequest(), LIMITS)).not.toContain("<<<REFUSED");
  });

  test("after a final round it asks only for a resolution", () => {
    const prompt = buildGrillPrompt(grillRequest({ afterFinal: true }), LIMITS);
    expect(prompt).toContain("Do not ask another");
    expect(prompt).toContain("Set kind to resolution or outOfScope");
    expect(prompt).toContain(mapChangesRules(LIMITS).join("\n"));
    expect(prompt).not.toContain("Mark the round final");
  });
});

describe("claudeCodeChartMap", () => {
  test("with no map-level round it sends the proposal schema and returns the proposal", async () => {
    const claudePath = writeStandIn(PROPOSAL_OUTPUT);

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest([]), SESSION);

    expect(result).toEqual({ ok: true, value: { kind: "proposal", proposal: PROPOSAL } });
    expect(roots(chartProposalJsonSchema(LIMITS))).toBe(
      "title,summary,destination,split,intro,questions",
    );
    expect(flag(recordedArgv(), "--json-schema")).toBe(chartProposalJsonSchema(LIMITS));
  });

  test("sends one schema per step: propose, choose, confirm after a final round and at the cap", async () => {
    const third = { ...SUBMITTED_ROUND, final: false };
    const steps = [
      [[], PROPOSAL_OUTPUT, "title,summary,destination,split,intro,questions"],
      [
        [SUBMITTED_ROUND],
        CHOICE_CONFIRMATION,
        "kind,title,summary,destination,intro,final,questions,waypoints,fog,outOfScope,proposals",
      ],
      [
        CONFIRM_ROUNDS,
        CONFIRMATION,
        "title,summary,destination,waypoints,fog,outOfScope,proposals",
      ],
      [
        [SUBMITTED_ROUND, SUBMITTED_ROUND, third],
        CONFIRMATION,
        "title,summary,destination,waypoints,fog,outOfScope,proposals",
      ],
    ] as const;
    for (const [mapRounds, output, rootSet] of steps) {
      const result = await claudeCodeChartMap(config(writeStandIn(output)))(
        chartRequest([...mapRounds]),
        SESSION,
      );
      expect(result.ok).toBe(true);
      expect(roots(flag(recordedArgv(), "--json-schema"))).toBe(rootSet);
    }
    expect(chartChoiceJsonSchema(LIMITS)).not.toContain('"split"');
    expect(chartConfirmationJsonSchema(LIMITS)).toBe(jsonSchema(chartConfirmation(LIMITS)));
    expect(flag(recordedArgv(), "--json-schema")).toBe(chartConfirmationJsonSchema(LIMITS));
  });

  test("a choose chart returns a confirmation or a follow-up", async () => {
    const choose = async (output: unknown) =>
      await claudeCodeChartMap(config(writeStandIn(output)))(
        chartRequest([SUBMITTED_ROUND]),
        SESSION,
      );

    expect(await choose(CHOICE_CONFIRMATION)).toEqual({
      ok: true,
      value: { kind: "confirmation", confirmation: CONFIRMATION },
    });
    expect(flag(recordedArgv(), "--json-schema")).toBe(chartChoiceJsonSchema(LIMITS));
    expect(await choose(CHOICE_FOLLOW_UP)).toEqual({
      ok: true,
      value: { kind: "followUp", followUp: FOLLOW_UP },
    });
  });

  test("a choose chart's fields that do not match its kind, or a follow-up of 0 or 4 questions, are agent_output_invalid", async () => {
    const choose = async (output: unknown) =>
      await claudeCodeChartMap(config(writeStandIn(output)))(
        chartRequest([SUBMITTED_ROUND]),
        SESSION,
      );
    const followUpFields = {
      intro: FOLLOW_UP.round.intro,
      final: false,
      questions: FOLLOW_UP.round.questions,
    };
    const confirmationFields = {
      waypoints: [],
      fog: [],
      outOfScope: [],
      proposals: [],
    };
    const refused = [
      ...Object.entries(followUpFields).map(([name, value]) => ({
        ...CHOICE_CONFIRMATION,
        [name]: value,
      })),
      ...Object.entries(confirmationFields).map(([name, value]) => ({
        ...CHOICE_FOLLOW_UP,
        [name]: value,
      })),
      { ...CHOICE_CONFIRMATION, waypoints: null },
      { ...CHOICE_FOLLOW_UP, intro: null },
      { ...CHOICE_FOLLOW_UP, questions: [] },
      { ...CHOICE_FOLLOW_UP, questions: [...QUESTIONS, ...QUESTIONS] },
      { ...CHOICE_CONFIRMATION, destination: null },
      { ...CHOICE_CONFIRMATION, title: null },
      { ...CHOICE_CONFIRMATION, summary: null },
      { ...CHOICE_FOLLOW_UP, title: null },
      { ...CHOICE_FOLLOW_UP, summary: null },
      { ...CHOICE_FOLLOW_UP, kind: "proposal" },
    ];
    for (const output of refused) {
      const result = await choose(output);
      expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    }
  });

  test("the choose prompt carries the follow-up rule, the count line, the proposed destination and the rounds once", () => {
    const prompt = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    const lines = prompt.split("\n");
    expect(prompt).toContain(DESTINATION_FOLLOW_UP_RULE.join("\n"));
    expect(lines).toContain("Answered destination rounds: 1");
    expect(prompt).toMatch(/<<<TITLE [0-9a-f-]{36}\nCount lines or characters\n/);
    expect(prompt).toMatch(
      /<<<SUMMARY [0-9a-f-]{36}\nLet people choose the unit wordcount counts\.\n/,
    );
    expect(prompt).toContain(`\n${PROPOSAL.destination}\nDESTINATION `);
    expectRoundsAfterDestination(prompt);
    // Every rule of the confirming chart, for its confirmation.
    for (const rule of [
      SETTLED_CHART_RULE,
      TOUCHES_RULES,
      FOG_HOLDS_RULE,
      PROPOSE_OR_RULE_OUT_RULE,
    ]) {
      expect(prompt).toContain(rule.join("\n"));
    }
  });

  test("the confirm prompt renders every round once, the proposed destination and the count line, and no follow-up rule", () => {
    const prompt = buildChartPrompt(chartRequest(CONFIRM_ROUNDS), LIMITS);
    expect(prompt).toContain(`\n${PROPOSAL.destination}\nDESTINATION `);
    expect(prompt.split("\n")).toContain("Answered destination rounds: 2");
    expectRoundsAfterDestination(prompt);
    expect(prompt).toMatch(/<<<MAP-ROUND-2-QUESTION-2 [0-9a-f-]{36}\n/);
    expect(prompt.split(DESTINATION_ANSWERS_RULE.join("\n"))).toHaveLength(2);
    expect(prompt).not.toContain(DESTINATION_FOLLOW_UP_RULE[0]);
    expect(prompt).toContain(SETTLED_CHART_RULE.join("\n"));
    const proposing = buildChartPrompt(chartRequest([]), LIMITS);
    expect(proposing).not.toContain(DESTINATION_FOLLOW_UP_RULE[0]);
    expect(proposing).not.toContain(DESTINATION_ANSWERS_RULE[0]);
  });

  test("the choose and confirm prompts set the map's title and summary beside the destination, with the title rule", () => {
    const titleRule = mapTitleRule(LIMITS).join("\n");
    for (const mapRounds of [[SUBMITTED_ROUND], CONFIRM_ROUNDS]) {
      const prompt = buildChartPrompt(chartRequest(mapRounds), LIMITS);
      const reading = prompt.indexOf("title, summary and destination are always set");
      expect(reading).toBeGreaterThan(-1);
      expect(prompt.indexOf(titleRule, reading)).toBeGreaterThan(reading);
      expect(prompt.indexOf(titleRule, reading)).toBeLessThan(prompt.indexOf("Then chart 0 to 12"));
    }
  });

  test("every chart prompt renders the refused attempt's problem, and none when null", () => {
    for (const mapRounds of [[], [SUBMITTED_ROUND], CONFIRM_ROUNDS]) {
      const request = chartRequest(mapRounds);
      const prompt = buildChartPrompt(
        { ...request, refusedAttempt: { problem: "kind is confirmation: null intro." } },
        LIMITS,
      );
      expect(prompt).toMatch(/<<<REFUSED [0-9a-f-]{36}\nkind is confirmation: null intro\.\n/);
      expect(buildChartPrompt(request, LIMITS)).not.toContain("<<<REFUSED");
    }
  });

  test("DESTINATION_FOLLOW_UP_RULE gains no paragraph", () => {
    expect(DESTINATION_FOLLOW_UP_RULE.length).toBeLessThanOrEqual(9);
    expect(DESTINATION_FOLLOW_UP_RULE).not.toContain("");
  });

  test("refuses thirteen waypoints with agent_output_invalid", async () => {
    const waypoint = CONFIRMATION.waypoints[0];
    const claudePath = writeStandIn({
      ...CONFIRMATION,
      waypoints: Array.from({ length: 13 }, () => waypoint),
    });

    const result = await claudeCodeChartMap(config(claudePath))(
      chartRequest(CONFIRM_ROUNDS),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("a confirmation's proposals of new maps parse; an idea or line outside its bounds is agent_output_invalid", async () => {
    const proposing: ChartConfirmation = {
      ...CONFIRMATION,
      proposals: [
        { title: "Count words", idea: "Count words.", line: "Word counts are their own effort." },
      ],
    };
    const confirmWith = async (output: unknown) =>
      await claudeCodeChartMap(config(writeStandIn(output)))(chartRequest(CONFIRM_ROUNDS), SESSION);

    expect(await confirmWith(proposing)).toEqual({
      ok: true,
      value: { kind: "confirmation", confirmation: proposing },
    });
    expect(roots(chartConfirmationJsonSchema(LIMITS))).toBe(
      "title,summary,destination,waypoints,fog,outOfScope,proposals",
    );
    for (const proposal of [
      { title: "New map", idea: "", line: "Later." },
      { title: "New map", idea: "w".repeat(4001), line: "Later." },
      { title: "New map", idea: "Count words.", line: "l".repeat(501) },
    ]) {
      const result = await confirmWith({ ...CONFIRMATION, proposals: [proposal] });
      expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    }
  });

  test("the confirming prompt carries the propose-or-rule-out rule; the first chart's does not", () => {
    const confirming = buildChartPrompt(chartRequest([SUBMITTED_ROUND]), LIMITS);
    expect(confirming).toContain(proposalsRules(LIMITS).join("\n"));
    expect(confirming).toContain(PROPOSE_OR_RULE_OUT_RULE.join("\n"));
    expect(buildChartPrompt(chartRequest([]), LIMITS)).not.toContain(PROPOSE_OR_RULE_OUT_RULE[0]);
  });
});

describe("claudeCodeGrillWaypoint", () => {
  test("an out-of-scope ruling may attach a proposal with an idea and no line; its prompt says how", async () => {
    const outOfScope = {
      reason: "Word counts are another effort.",
      proposal: { title: "New map", idea: "Count words." },
    };
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "outOfScope",
      outOfScope,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result).toEqual({
      ok: true,
      value: { round: null, resolution: null, outOfScope, mapChanges: NO_CHANGES },
    });
    const prompt = buildGrillPrompt(grillRequest(), LIMITS);
    expect(prompt).toContain(outOfScopeRule(LIMITS).join("\n"));
    expect(prompt).toContain(PROPOSE_OR_RULE_OUT_RULE.join("\n"));
    expect(prompt).toContain(PROPOSAL_IDEA_RULE.join("\n"));
  });

  test("sends the grill schema and returns a round", async () => {
    const round = { intro: "Two choices on output.", final: true, questions: QUESTIONS };
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "round",
      ...round,
      mapChanges: null,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result).toEqual({
      ok: true,
      value: { round, resolution: null, outOfScope: null, mapChanges: null },
    });
    expect(roots(grillJsonSchema(LIMITS))).toBe(
      "kind,intro,final,questions,decision,gist,agentDecided,outOfScope,mapChanges",
    );
    expect(flag(recordedArgv(), "--json-schema")).toBe(grillJsonSchema(LIMITS));
  });

  test("refuses both a round and a resolution with agent_output_invalid", async () => {
    const round = { intro: "Two choices.", final: false, questions: QUESTIONS };
    const claudePath = writeStandIn({
      kind: "round",
      ...round,
      ...DECISION,
      outOfScope: null,
      mapChanges: null,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("returns an out-of-scope ruling with its map changes", async () => {
    const outOfScope = { reason: "Not this map." };
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "outOfScope",
      outOfScope,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result).toEqual({
      ok: true,
      value: { round: null, resolution: null, outOfScope, mapChanges: NO_CHANGES },
    });
  });

  test("refuses a resolution without map changes with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "resolution",
      ...DECISION,
      mapChanges: null,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses neither a round nor a resolution with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "resolution",
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses a decision without its gist with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "resolution",
      decision: DECISION.decision,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses a decision and gist without agentDecided with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "resolution",
      decision: DECISION.decision,
      gist: DECISION.gist,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses a kind its fields do not match with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "outOfScope",
      ...DECISION,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses a round missing its questions with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "round",
      intro: "Two choices.",
      final: false,
      mapChanges: null,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses the old nested shape with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      round: null,
      resolution: RESOLUTION,
      outOfScope: null,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("after a final round sends the resolution-only schema and returns the resolution", async () => {
    const claudePath = writeStandIn({
      kind: "resolution",
      ...DECISION,
      outOfScope: null,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(
      grillRequest({ afterFinal: true }),
      SESSION,
    );

    expect(result).toEqual({
      ok: true,
      value: { round: null, resolution: RESOLUTION, outOfScope: null, mapChanges: NO_CHANGES },
    });
    expect(roots(grillResolutionJsonSchema(LIMITS))).toBe(
      "kind,decision,gist,agentDecided,outOfScope,mapChanges",
    );
    expect(flag(recordedArgv(), "--json-schema")).toBe(grillResolutionJsonSchema(LIMITS));
  });

  test("after a final round refuses a round with agent_output_invalid", async () => {
    const round = { intro: "One more.", final: false, questions: QUESTIONS };
    const claudePath = writeStandIn({
      kind: "round",
      ...round,
      decision: null,
      gist: null,
      agentDecided: null,
      outOfScope: null,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(
      grillRequest({ afterFinal: true }),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses a gist over 200 characters with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      ...NO_GRILL_OUTCOME,
      kind: "resolution",
      decision: "Decided.",
      gist: "g".repeat(201),
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeGrillWaypoint(config(claudePath))(grillRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });
});

// The chart reads the project's specs and may name touches; the grilling reads its waypoint's
// touches with their baselines.
const TOUCHED_CONTENT = {
  title: "Count words",
  problem: "People cannot count words.",
  solution: "A word count.",
  clauses: [
    {
      id: "C1",
      title: "Words",
      text: "Counting words.",
      criteria: [
        { id: "1.1", text: "Counting splits on whitespace." },
        { id: "1.2", text: "Counting ignores punctuation." },
      ],
      sources: [{ kind: "destination" as const }],
    },
  ],
  outOfScope: [],
};
const TOUCH = {
  specNumber: 2,
  specTitle: "Count words",
  revision: 1,
  content: TOUCHED_CONTENT,
  criteria: [
    { id: "1.1", text: "Counting splits on whitespace.", baseline: null },
    {
      id: "1.2",
      text: "Counting ignores punctuation.",
      baseline: { ticket: "T2", run: 1, commit: "def5678" },
    },
  ],
};
const PROJECT_SPEC = {
  retiredIds: [],
  latest: {
    specNumber: 2,
    revision: 1,
    content: {
      title: "Count words",
      problem: "People cannot count words.",
      solution: "A word count.",
      clauses: [
        {
          id: "C1",
          title: "Words",
          text: "Counting words.",
          criteria: [{ id: "1.1", text: "Counting splits on whitespace." }],
          sources: [{ kind: "destination" as const }],
        },
      ],
      outOfScope: [],
    },
  },
  delivered: true,
  hold: null,
  writerMapId: "01a13c3d-5793-7224-8cbe-ebd162ca7eb3",
};
const PROJECT_SPEC_APPROVED = { ...PROJECT_SPEC, approved: PROJECT_SPEC.latest };

describe("a later map's chart and grilling", () => {
  test("the chart reads the project specs; the confirming chart states the touch rules", () => {
    const request = { ...chartRequest([SUBMITTED_ROUND]), projectSpecs: [PROJECT_SPEC_APPROVED] };
    const confirming = buildChartPrompt(request, LIMITS);
    expect(confirming).toContain(projectSpecLine(PROJECT_SPEC_APPROVED));
    expect(confirming).toContain("Project spec 2 criterion ids: 1.1");
    for (const line of TOUCHES_RULES) expect(confirming).toContain(line);
    const proposing = buildChartPrompt({ ...request, mapRounds: [], proposed: null }, LIMITS);
    expect(proposing).toContain(projectSpecLine(PROJECT_SPEC_APPROVED));
    expect(proposing).not.toContain(TOUCHES_RULES[0]);
  });

  test("both charts give each project spec's page and say to link a spec they name there", () => {
    const request = { ...chartRequest([SUBMITTED_ROUND]), projectSpecs: [PROJECT_SPEC_APPROVED] };
    const page = "Project spec 2 page: /maps/01a13c3d-5793-7224-8cbe-ebd162ca7eb3/spec/2";
    for (const prompt of [
      buildChartPrompt(request, LIMITS),
      buildChartPrompt({ ...request, mapRounds: [], proposed: null }, LIMITS),
    ]) {
      expect(prompt.split("\n")).toContain(page);
      for (const line of SPEC_LINK_RULE) expect(prompt).toContain(line);
    }
  });

  test("a spec another map's draft holds is touched at its latest approved revision", () => {
    const held = {
      latest: { ...PROJECT_SPEC.latest, revision: 2 },
      retiredIds: [],
      approved: PROJECT_SPEC.latest,
      delivered: true,
      hold: { kind: "revision" as const, mapId: "map-b", mapTitle: "Other map", revision: 2 },
      writerMapId: "01a13c3d-5793-7224-8cbe-ebd162ca7eb3",
    };
    const confirming = buildChartPrompt(
      { ...chartRequest([SUBMITTED_ROUND]), projectSpecs: [held] },
      LIMITS,
    );
    expect(projectSpecLine(held)).toContain("latest revision 2, not approved");
    expect(confirming).toContain(projectSpecLine(held));
    expect(confirming.split("\n")).toContain("Project spec 2 latest approved revision: 1");
    expect(confirming.split("\n")).toContain("Project spec 2 approved criterion ids: 1.1");
    const rules = TOUCHES_RULES.join("\n");
    expect(rules).toMatch(/latest approved revision/);
    expect(rules).toMatch(/holds[\s\S]*touched all the same/);
    expect(rules).not.toMatch(/Never touch a spec\s+listed as not approved/);
  });

  test("a confirming chart's touches come back as parsed", async () => {
    const touched = {
      ...CONFIRMATION,
      waypoints: CONFIRMATION.waypoints.map((waypoint, index) =>
        index === 0
          ? { ...waypoint, touches: [{ specNumber: 2, revision: 1, criteria: ["1.1"] }] }
          : waypoint,
      ),
    };
    const result = await claudeCodeChartMap(config(writeStandIn(touched)))(
      chartRequest(CONFIRM_ROUNDS),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: { kind: "confirmation", confirmation: touched } });
  });

  test("the grilling reads its waypoint's touches with each criterion's baseline", () => {
    const base = grillRequest();
    const prompt = buildGrillPrompt(
      { ...base, waypoint: { ...base.waypoint, touches: [TOUCH] } },
      LIMITS,
    );
    expect(prompt).toContain(touchLine(TOUCH));
    expect(prompt).toContain("Baseline 1.1: never delivered");
    expect(prompt).toContain("Baseline 1.2: T2, run 1, commit def5678");
    expect(buildGrillPrompt(base, LIMITS)).toContain("Touches: none");
  });

  test("the grilling reads the touched revision's approved text", () => {
    const base = grillRequest();
    const prompt = buildGrillPrompt(
      { ...base, waypoint: { ...base.waypoint, touches: [TOUCH] } },
      LIMITS,
    );
    expect(prompt).toContain(touchedTextLine(TOUCH));
    expect(prompt).toMatch(/^<<<TOUCHED-SPEC-2-REVISION-1 \S+$/m);
    expect(prompt).toContain('"problem": "People cannot count words."');
    expect(buildGrillPrompt(base, LIMITS)).not.toContain("<<<TOUCHED-SPEC-");
  });
});

describe("the project's map suggestions and maps", () => {
  test("each suggestion's title and line, each map's title, quoted; states and stages plain; nothing else", () => {
    const nonce = "00000000-0000-4000-8000-000000000000";
    const text = projectSuggestionLines(PROJECT_CONTEXT, nonce).join("\n");
    for (const expected of expectedProjectContextLines(nonce)) {
      expect(text).toContain(expected);
    }
    // A confirmed suggestion reads as created.
    expect(text).not.toContain("confirmed");
    // The blocks hold the suggestions' titles and lines and the maps' titles, and nothing more.
    const quoted = [...text.matchAll(/^<<<(\S+) (\S+)\n([\s\S]*?)\n\1 \2>>>$/gm)].map(
      (match) => match[3],
    );
    expect(quoted).toEqual([
      "CSV imports",
      "Importing CSV is left to its own map.",
      "Nightly exports",
      "Scheduled exports are left to their own map.",
      "Retire the old exporter",
      "Keep an export log",
      "Data export",
      "CSV imports",
      "Export settings",
    ]);
    // Outside the blocks: the two headings, one plain line per suggestion and per map.
    const plain = text
      .replace(/^<<<(\S+) (\S+)\n[\s\S]*?\n\1 \2>>>$/gm, "")
      .split("\n")
      .filter((line) => line !== "");
    expect(plain).toEqual([
      "Every map suggestion made in this project so far, on any of its maps, oldest first:",
      "Suggestion 1, created (it is a map of its own now):",
      "Its Out of scope line:",
      "Suggestion 2, dismissed (the person said no):",
      "Its Out of scope line:",
      "Suggestion 3, pending (the person has not decided it yet):",
      "Suggestion 4, dismissed (the person said no):",
      "Every map of this project, this one included, oldest first, with the latest of its stages (idea,",
      "wayfinding, spec, tickets, delivery) it has reached:",
      "Map 1, stage delivery, titled:",
      "Map 2, stage spec, titled:",
      "Map 3, stage wayfinding, titled:",
      "Map 4, untitled (not charted yet), stage idea.",
    ]);
  });

  test("with none, the lists say so", () => {
    const text = projectSuggestionLines(NO_PROJECT_CONTEXT, "n").join("\n");
    expect(text).toContain("No map has been suggested in this project yet.");
    expect(text).toContain("The project has no map yet.");
  });

  test("every chart and the grilling carry them, the chart's project specs list unchanged", () => {
    const prompts = [
      buildChartPrompt({ ...chartRequest([]), ...PROJECT_CONTEXT }, LIMITS),
      buildChartPrompt({ ...chartRequest([SUBMITTED_ROUND]), ...PROJECT_CONTEXT }, LIMITS),
      buildChartPrompt({ ...chartRequest(CONFIRM_ROUNDS), ...PROJECT_CONTEXT }, LIMITS),
      buildGrillPrompt(grillRequest(PROJECT_CONTEXT), LIMITS),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(renderedProjectContext(prompt));
      for (const expected of expectedProjectContextLines(promptNonce(prompt))) {
        expect(prompt).toContain(expected);
      }
    }
    for (const chart of prompts.slice(0, 3)) {
      expect(chart).toContain(
        "The project's specs that other maps wrote, each with its latest revision:",
      );
    }
  });
});

describe("the suggestion rules (map suggestions that don't repeat)", () => {
  test("every chart and the grilling carry the no-repeat, no-existing-map and salient-only rules, never propose-when-unsure", () => {
    for (const prompt of [
      buildChartPrompt({ ...chartRequest([]), ...PROJECT_CONTEXT }, LIMITS),
      buildChartPrompt({ ...chartRequest([SUBMITTED_ROUND]), ...PROJECT_CONTEXT }, LIMITS),
      buildChartPrompt({ ...chartRequest(CONFIRM_ROUNDS), ...PROJECT_CONTEXT }, LIMITS),
      buildGrillPrompt(grillRequest(PROJECT_CONTEXT), LIMITS),
      buildGrillPrompt(grillRequest({ ...PROJECT_CONTEXT, afterFinal: true }), LIMITS),
    ]) {
      expect(suggestionRuleProblems(prompt)).toEqual([]);
    }
  });

  test("the shared rule says what dismissed and created mean, and rules the rest out", () => {
    const rule = PROPOSE_OR_RULE_OUT_RULE.join(" ");
    expect(rule).toContain("A dismissed one means the person said no");
    expect(rule).toContain("a created one is its own map now");
    expect(rule).toContain("even reworded");
    expect(rule).toContain("at any stage");
    expect(rule).toContain("rule it out with a plain Out of scope line");
    expect(rule).not.toMatch(/unsure/i);
  });
});

describe("the map's code survey", () => {
  test("each prompt carries the survey as FACTS, or says the map has none", () => {
    const builds = [
      (survey: CodeSurvey | null) => buildGrillPrompt(grillRequest({ survey }), LIMITS),
    ];
    for (const build of builds) {
      const surveyed = build(SURVEY);
      expect(surveyed).toContain(SURVEY_FACTS);
      expect(surveyed).toContain(FACTS_RULE.join("\n"));
      const unsurveyed = build(null);
      expect(unsurveyed).toContain(NO_SURVEY_LINES.join("\n"));
      expect(unsurveyed).not.toContain("<<<FACTS");
    }
  });
});

describe("the wayfinding runs' lengths follow the model's limits (agent.models)", () => {
  const D = DISTINCT_LIMITS;
  const fixedPaths: number[] = [];
  const round = [
    "questionText",
    "questionTopic",
    "optionDetail",
    "optionLabel",
    "roundIntro",
  ] as const;
  const changes = [
    "mapTitle",
    "waypointTitle",
    "waypointQuestion",
    "resolution",
    "gist",
    "agentDecided",
    "mapLine",
  ] as const;
  const runs = [
    [
      "a first chart",
      () => ({
        prompt: buildChartPrompt(chartRequest([]), D),
        jsonSchema: chartProposalJsonSchema(D),
        fields: [...round, "mapTitle", "mapSummary", "destination", "mapLine"],
        exempt: [],
      }),
    ],
    [
      "a choose chart",
      () => ({
        prompt: buildChartPrompt(chartRequest([SUBMITTED_ROUND]), D),
        jsonSchema: chartChoiceJsonSchema(D),
        fields: [
          ...round,
          "mapTitle",
          "mapSummary",
          "destination",
          "waypointTitle",
          "waypointQuestion",
          "mapLine",
        ],
        exempt: [],
      }),
    ],
    [
      "a confirm chart",
      () => ({
        prompt: buildChartPrompt(chartRequest(CONFIRM_ROUNDS), D),
        jsonSchema: chartConfirmationJsonSchema(D),
        fields: [
          "mapTitle",
          "mapSummary",
          "destination",
          "waypointTitle",
          "waypointQuestion",
          "mapLine",
        ],
        exempt: [],
      }),
    ],
    [
      "a grilling run",
      () => ({
        prompt: buildGrillPrompt(grillRequest(), D),
        jsonSchema: grillJsonSchema(D),
        fields: [...round, ...changes],
        exempt: [],
      }),
    ],
    [
      "a grilling run after a final round",
      () => ({
        prompt: buildGrillPrompt(grillRequest({ afterFinal: true }), D),
        jsonSchema: grillResolutionJsonSchema(D),
        fields: [...changes],
        exempt: [],
      }),
    ],
  ] as const;

  test.each(runs)("%s states every length its --json-schema bounds", (_name, run) => {
    const { prompt, jsonSchema, fields, exempt } = run();
    expect(boundFields(jsonSchema).fields).toEqual(fields);
    expect(boundFields(jsonSchema).fixed).toEqual(fixedPaths);
    expect(unstatedLengths(prompt, jsonSchema, exempt)).toEqual([]);
  });
});

describe("the grilling prompt's destination rounds", () => {
  test("renders the map-level rounds after the destination, under DESTINATION_ANSWERS_RULE once", () => {
    expectRoundsAfterDestination(buildGrillPrompt(grillRequest(), LIMITS));
  });
});
