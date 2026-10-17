import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodeSurvey,
  type PlanningRunConfig,
  type CheckConsistencyRequest,
  consistencyOutcome,
  researchOutcome,
  type ResearchReport,
  type ResearchWaypointRequest,
  type WorkTaskRequest,
  type PlanningCallSession,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { SURVEY, SURVEY_FACTS } from "./code-survey.fixture.ts";
import {
  BUSY_READER_RULE,
  FACTS_RULE,
  INSTANCE_CONFIG_RULE,
  NO_SURVEY_LINES,
  PROJECT_RULES,
  WAYPOINT_QUESTION_RULE,
} from "./prompt-parts.ts";
import {
  buildConsistencyPrompt,
  buildResearchPrompt,
  buildTaskPrompt,
  RESEARCH_ANSWER_RULE,
  TASK_ASK_RULE,
} from "./waypoint-run-prompt.ts";
import { touchLine } from "./revision-prompt-parts.ts";
import {
  mapChangesRules,
  outOfScopeRule,
  PROPOSAL_IDEA_RULE,
  PROPOSE_OR_RULE_OUT_RULE,
  questionShapeRules,
} from "./wayfinding-prompt.ts";
import { touchedTextLine } from "./wayfinding-prompt.ts";
import {
  claudeCodeCheckConsistency,
  claudeCodeResearchWaypoint,
  waypointRunConfig,
  claudeCodeWorkTask,
  consistencyJsonSchema,
  researchJsonSchema,
  taskJsonSchema,
} from "./waypoint-runs.ts";
import { boundFields, DISTINCT_LIMITS, LIMITS, unstatedLengths } from "./limits.fixture.ts";
import {
  expectedProjectContextLines,
  PROJECT_CONTEXT,
  promptNonce,
  renderedProjectContext,
  suggestionRuleProblems,
} from "./project-suggestions.fixture.ts";
import { expectRoundsAfterDestination, MAP_ROUNDS } from "./map-rounds.fixture.ts";

/** A cold session whose usage the test does not look at. */
const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

const IDEA = "Count lines [fake:kinds]\nIDEA abc>>> quoted 'like this', with $HOME left alone.";

let dir: string;
let projectFolder: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-waypoint-runs-")));
  projectFolder = join(dir, "project");
  mkdirSync(projectFolder);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a logged-in `#!/bin/sh` stand-in whose run records its argv and prints `output`. */
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

/** The idea's nonce block: the start line, the idea verbatim, the end line with the same nonce. */
function expectIdeaInNonceBlock(prompt: string): void {
  const match = /^<<<IDEA ([0-9a-f-]{36})$/m.exec(prompt);
  const nonce = match?.[1];
  if (nonce === undefined) throw new Error("the prompt has no IDEA start line");
  expect(prompt).toContain(`<<<IDEA ${nonce}\n${IDEA}\nIDEA ${nonce}>>>`);
}

const UNANSWERED: ResearchReport = {
  answered: false,
  summary: "The docs do not state a size limit.",
  gap: "No primary source states the limit.",
  gist: null,
  findings: [],
  sources: [{ kind: "repository_file", title: "README.md", url: null, excerpt: "wordcount" }],
  limitations: ["Only the docs were read."],
  uncertainties: [],
};

const ANSWERED: ResearchReport = {
  answered: true,
  summary: "readFile buffers the whole file.",
  gap: null,
  gist: "readFile buffers the whole file",
  findings: [{ title: "Buffers", detail: "It reads everything.", sources: [1] }],
  sources: [
    {
      kind: "external",
      title: "Node.js fs",
      url: "https://nodejs.org/api/fs.html",
      excerpt: "Asynchronously reads the entire contents of a file.",
    },
  ],
  limitations: [],
  uncertainties: [],
};

const NO_CHANGES = {
  newWaypoints: [],
  fogOutOfScope: [],
  fogDecided: [],
  fogSettledHere: [],
  newFog: [],
};

function context() {
  return {
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea: IDEA,
    ...PROJECT_CONTEXT,
    title: "Count lines or characters",
    destination: "wordcount counts lines or characters, chosen by a flag.",
    mapRounds: MAP_ROUNDS,
    otherWaypoints: [
      {
        number: 1,
        kind: "grilling" as const,
        title: "Flag names",
        status: "resolved" as const,
        gist: "Flags -l and -c",
        agentDecided: [],
        resolution: "Resolved: Flags -l and -c",
      },
      {
        number: 3,
        kind: "grilling" as const,
        title: "Help text",
        status: "open" as const,
        gist: null,
        agentDecided: null,
        resolution: null,
      },
    ],
    fog: [{ position: 2, text: "How wide characters count" }],
    outOfScope: ["Counting bytes: the destination names lines and characters only."],
    note: null,
  };
}

function researchRequest(earlierReports: ResearchReport[]): ResearchWaypointRequest {
  return {
    survey: null,
    ...context(),
    waypoint: {
      number: 4,
      kind: "research",
      title: "Large files",
      question: "Does readFile buffer?",
      touches: [],
    },
    earlierReports,
  };
}

function taskRequest(): WorkTaskRequest {
  return {
    survey: null,
    ...context(),
    waypoint: {
      number: 5,
      kind: "task",
      title: "Find the CI config",
      question: "Which CI runs the tests?",
      touches: [],
      rounds: [
        {
          questions: [
            {
              topic: "Access",
              text: "Where is the CI configured?",
              options: [
                { label: "Another repository", detail: "The plan reads it from there." },
                { label: "Nowhere yet", detail: "The plan adds CI." },
              ],
            },
          ],
          answers: [
            { optionIndex: 0, note: "In the ops repository, ci/wordcount.yml.", accepted: false },
          ],
        },
      ],
    },
    earlierOutcomes: [
      { outcome: "failed", action: "Searched the repository.", facts: "No CI file found." },
    ],
  };
}

function consistencyRequest(): CheckConsistencyRequest {
  return {
    survey: null,
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea: IDEA,
    ...PROJECT_CONTEXT,
    title: "Count lines or characters",
    destination: "wordcount counts lines or characters, chosen by a flag.",
    mapRounds: MAP_ROUNDS,
    outOfScope: ["Counting bytes."],
    waypoints: [
      {
        number: 1,
        kind: "grilling",
        title: "Flag names",
        question: "Which flags?",
        resolution: "Flags -l and -c.",
        decidedByPerson: true,
        newSinceLastPass: true,
        finding: null,
      },
      {
        number: 2,
        kind: "research",
        title: "Large files",
        question: "Does readFile buffer?",
        resolution: "readFile buffers the whole file.",
        decidedByPerson: false,
        newSinceLastPass: true,
        finding: null,
      },
      {
        number: 4,
        kind: "grilling",
        title: "Total label",
        question: "Which total line ships?",
        resolution: "The labelled total ships.",
        decidedByPerson: true,
        newSinceLastPass: true,
        finding: { kind: "conflicting_surfaces", waypointNumbers: [1, 2] },
      },
    ],
  };
}

describe("buildResearchPrompt", () => {
  test("puts the idea in a nonce block and carries the stand-in's plain lines", () => {
    const prompt = buildResearchPrompt(researchRequest([UNANSWERED]), LIMITS, 24);
    expectIdeaInNonceBlock(prompt);
    const lines = prompt.split("\n");
    expect(lines).toContain("Waypoint number: 4");
    expect(lines).toContain("Earlier reports on this waypoint: 1");
    expect(buildResearchPrompt(researchRequest([]), LIMITS, 24).split("\n")).toContain(
      "Earlier reports on this waypoint: 0",
    );
  });

  test("carries the research rules, the map-change rules, the web tools and the map's context", () => {
    const prompt = buildResearchPrompt(researchRequest([UNANSWERED]), LIMITS, 24);
    expect(prompt).toContain("primary sources");
    expect(prompt).toContain("Stop once the question is answered");
    expect(prompt).toContain("name the gap");
    expect(prompt).toContain("WebSearch and WebFetch");
    expect(prompt).toContain(mapChangesRules(LIMITS).join("\n"));
    expect(prompt).toContain("Set exactly one of report and outOfScope");
    expect(prompt).toContain("is not a preference only the person can confirm");
    // A gap only running something closes is an assumption and a risk, never a gap for the person.
    expect(prompt).toContain(RESEARCH_ANSWER_RULE.join("\n"));
    expect(prompt).toContain("A gap only running something can close is not");
    // A tool's own reference is checked before concluding a capability is absent.
    expect(prompt).toContain("before concluding it is absent. State an absence only with the");
    // Each code dependent of what the change replaces is stated as a finding before any external
    // research, cited as a repository_file source titled with its path (FACTS name them, harness #1).
    const repositoryStep = prompt.indexOf(
      "- For each piece of code that depends on what the change replaces or extends",
    );
    expect(repositoryStep).toBeGreaterThan(-1);
    expect(repositoryStep).toBeLessThan(prompt.indexOf("- For a command-line tool or service"));
    expect(prompt).toContain("whether the new option supports it as the code uses it today");
    expect(prompt).toContain("record one you cannot verify as an assumption");
    expect(prompt).toContain("repository_file's is its path");
    expect(prompt).toContain(PROJECT_RULES.join("\n"));
    expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
    expect(prompt).toContain("How wide characters count");
    expect(prompt).toContain("Counting bytes");
    expect(prompt).toContain("No primary source states the limit.");
  });
});

describe("buildTaskPrompt", () => {
  test("puts the idea in a nonce block and carries the stand-in's plain lines", () => {
    const prompt = buildTaskPrompt(taskRequest(), LIMITS, 24);
    expectIdeaInNonceBlock(prompt);
    const lines = prompt.split("\n");
    expect(lines).toContain("Waypoint number: 5");
    expect(lines).toContain("Answered rounds on this waypoint: 1");
    expect(lines).toContain("Earlier outcomes on this task: 1");
  });

  test("carries the read-only rule, the option rules, the fog rule and earlier work", () => {
    const prompt = buildTaskPrompt(taskRequest(), LIMITS, 24);
    expect(prompt).toContain("You can only read the repository");
    expect(prompt).not.toContain("give no options");
    // A Task round asks like every round: options, the recommendation first.
    expect(prompt).toContain(questionShapeRules(LIMITS).join("\n"));
    expect(prompt).toContain("Chosen option: Another repository: The plan reads it from there.");
    expect(prompt).toContain("Set kind to round, done, failed or outOfScope");
    // Only what only the person has; never engineering work; delivery-verified facts are assumptions.
    expect(prompt).toContain(TASK_ASK_RULE.join("\n"));
    expect(prompt).toContain("Never hand them engineering work");
    // Instance configuration is supplied at setup, never asked.
    expect(prompt).toContain(
      INSTANCE_CONFIG_RULE.map((line, index) => `${index === 0 ? "- " : "  "}${line}`).join("\n"),
    );
    expect(prompt).toContain("record it in facts as an assumption and a risk for the spec");
    expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
    expect(prompt).toContain("In the ops repository, ci/wordcount.yml.");
    expect(prompt).toContain("No CI file found.");
  });
});

describe("the person's note on a waypoint request", () => {
  const note = { text: "Look in the ops repository first.", sentAt: "2026-10-08T09:30:00.000Z" };
  const noteBlock =
    /<<<NOTE [0-9a-f-]{36}\nLook in the ops repository first\.\nNOTE [0-9a-f-]{36}>>>/;

  test("the research and task prompts render a note, and nothing when it is null", () => {
    for (const build of [
      (withNote: typeof note | null) =>
        buildResearchPrompt({ ...researchRequest([]), note: withNote }, LIMITS, 24),
      (withNote: typeof note | null) =>
        buildTaskPrompt({ ...taskRequest(), note: withNote }, LIMITS, 24),
    ]) {
      const prompt = build(note);
      expect(prompt.split("\n")).toContain("Note from the person: sent 2026-10-08T09:30:00.000Z");
      expect(prompt).toMatch(noteBlock);
      const none = build(null);
      expect(none).not.toContain("Note from the person:");
      expect(none).not.toContain("<<<NOTE");
    }
  });
});

describe("the project's map suggestions and maps", () => {
  test("the research, task and consistency prompts carry them, titles and lines quoted", () => {
    for (const prompt of [
      buildResearchPrompt(researchRequest([]), LIMITS, 24),
      buildTaskPrompt(taskRequest(), LIMITS, 24),
      buildConsistencyPrompt(consistencyRequest(), LIMITS),
    ]) {
      expect(prompt).toContain(renderedProjectContext(prompt));
      for (const expected of expectedProjectContextLines(promptNonce(prompt))) {
        expect(prompt).toContain(expected);
      }
    }
  });
});

describe("no waypoint run carries a fog duty", () => {
  test("research and task prompts with every other waypoint resolved name no duty to settle fog", () => {
    const resolved = <R extends ResearchWaypointRequest | WorkTaskRequest>(request: R): R => ({
      ...request,
      otherWaypoints: request.otherWaypoints.map((other) => ({ ...other, status: "resolved" })),
    });
    for (const prompt of [
      buildResearchPrompt(resolved(researchRequest([])), LIMITS, 24),
      buildTaskPrompt(resolved(taskRequest()), LIMITS, 24),
    ]) {
      expect(prompt).not.toContain("You are the last unsettled waypoint");
      expect(prompt).not.toContain("settle all fog");
      expect(prompt).toContain("the map's fog run settles it");
    }
  });
});

describe("buildConsistencyPrompt", () => {
  test("puts the idea in a nonce block and carries the stand-in's plain lines", () => {
    const prompt = buildConsistencyPrompt(consistencyRequest(), LIMITS);
    expectIdeaInNonceBlock(prompt);
    const lines = prompt.split("\n");
    expect(lines).toContain("Resolved waypoints compared: 3");
    expect(lines).toContain("Waypoints opened by an earlier pass: 1");
    expect(lines).toContain("New since the last pass: yes");
  });

  test("carries the pass rules and every resolution", () => {
    const prompt = buildConsistencyPrompt(consistencyRequest(), LIMITS);
    expect(prompt).toContain("Decide nothing: recommend no fix");
    expect(prompt).toContain("explicitly reconciles two earlier ones settles their conflict");
    expect(prompt).toContain("quotes the wording");
    expect(prompt).toContain("The labelled total ships.");
    expect(prompt).not.toContain("mapChanges");
  });

  test("reports only conflicts the person would care about, at most three, never bookkeeping", () => {
    const prompt = buildConsistencyPrompt(consistencyRequest(), LIMITS);
    expect(prompt).toContain("Report only a conflict\nthe person would care about");
    expect(prompt).toContain("Bookkeeping is never a finding");
    expect(prompt).toContain("Return 0 to 3 findings");
    expect(prompt).toContain("When in doubt, report no finding.");
    // Who stands behind each resolution; agent-only conflicts are not findings.
    const lines = prompt.split("\n");
    expect(lines.filter((line) => line === "Decided by: the person")).toHaveLength(2);
    expect(lines.filter((line) => line === "Decided by: the agent alone")).toHaveLength(1);
    expect(prompt).toContain("A conflict between resolutions the agent decided alone");
    expect(prompt).toContain(PROJECT_RULES.join("\n"));
    expect(prompt).toContain(BUSY_READER_RULE.join("\n"));
    expect(prompt).toContain(WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`).join("\n"));
  });
});

describe("claudeCodeResearchWaypoint", () => {
  test("sends the research schema and allows exactly the five research tools", async () => {
    const output = { report: ANSWERED, outOfScope: null, mapChanges: NO_CHANGES };
    const claudePath = writeStandIn(output);

    const result = await claudeCodeResearchWaypoint(config(claudePath))(
      researchRequest([]),
      SESSION,
    );

    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expect(researchJsonSchema(LIMITS)).toBe(jsonSchema(researchOutcome(LIMITS)));
    expect(flag(argv, "--json-schema")).toBe(researchJsonSchema(LIMITS));
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob,WebFetch,WebSearch");
    expect(flag(argv, "--allowedTools")).toBe("Read,Grep,Glob,WebFetch,WebSearch");
    expect(flag(argv, "--disallowedTools")).toBe("Bash,Edit,Write,NotebookEdit");
  });

  test("runs with twice the configured turns and timeout, and its prompt states the turns", async () => {
    const claudePath = writeStandIn({ report: ANSWERED, outOfScope: null, mapChanges: NO_CHANGES });
    expect(waypointRunConfig(config(claudePath))).toMatchObject({
      maxTurns: 24,
      timeoutSeconds: 60,
    });

    await claudeCodeResearchWaypoint(config(claudePath))(researchRequest([]), SESSION);

    const argv = recordedArgv();
    expect(flag(argv, "--max-turns")).toBe("24");
    expect(flag(argv, "-p")).toContain("You have 24 turns:");
  });

  test("refuses an answered report without a finding with agent_output_invalid", async () => {
    const report = { ...ANSWERED, findings: [] };
    const claudePath = writeStandIn({ report, outOfScope: null, mapChanges: NO_CHANGES });

    const result = await claudeCodeResearchWaypoint(config(claudePath))(
      researchRequest([]),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });
});

describe("claudeCodeWorkTask", () => {
  test("sends the task schema with the read-only tools and returns a round with options", async () => {
    const round = {
      intro: "One fact.",
      questions: [
        {
          topic: "Owner",
          text: "Who owns CI?",
          options: [
            { label: "You", detail: "The plan uses your access." },
            { label: "Another team", detail: "The plan waits on their access." },
          ],
        },
      ],
    };
    const outcome = { done: null, failed: null, outOfScope: null, mapChanges: null };
    const claudePath = writeStandIn({ kind: "round", ...round, ...outcome });

    const result = await claudeCodeWorkTask(config(claudePath))(taskRequest(), SESSION);

    expect(result).toEqual({ ok: true, value: { round, ...outcome } });
    const argv = recordedArgv();
    expect(
      Object.keys(
        z
          .object({ properties: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(taskJsonSchema(LIMITS))).properties,
      ).join(","),
    ).toBe("kind,intro,questions,done,failed,outOfScope,mapChanges");
    expect(flag(argv, "--json-schema")).toBe(taskJsonSchema(LIMITS));
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob");
    expect(flag(argv, "--allowedTools")).toBe("Read,Grep,Glob");
    expect(flag(argv, "--disallowedTools")).toBe("Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch");
  });

  test("runs with twice the configured turns and timeout, and its prompt states the turns", async () => {
    const claudePath = writeStandIn({
      kind: "done",
      intro: null,
      questions: null,
      done: { action: "Read.", facts: "Found.", gist: "Found", agentDecided: [] },
      failed: null,
      outOfScope: null,
      mapChanges: NO_CHANGES,
    });

    await claudeCodeWorkTask(config(claudePath))(taskRequest(), SESSION);

    const argv = recordedArgv();
    expect(flag(argv, "--max-turns")).toBe("24");
    expect(flag(argv, "-p")).toContain("You have 24 turns:");
  });

  test("refuses done and failed together with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      kind: "done",
      intro: null,
      questions: null,
      done: { action: "Read.", facts: "Found.", gist: "Found", agentDecided: [] },
      failed: { action: "Read.", facts: "Not found." },
      outOfScope: null,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeWorkTask(config(claudePath))(taskRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses a kind its fields do not match with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      kind: "failed",
      intro: null,
      questions: null,
      done: { action: "Read.", facts: "Found.", gist: "Found", agentDecided: [] },
      failed: null,
      outOfScope: null,
      mapChanges: NO_CHANGES,
    });

    const result = await claudeCodeWorkTask(config(claudePath))(taskRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });
});

describe("claudeCodeCheckConsistency", () => {
  test("sends the consistency schema with the read-only tools and returns the findings", async () => {
    const output = {
      findings: [
        {
          kind: "undefined_term",
          waypointNumbers: [2],
          title: "Large file",
          explanation: "“large” is never defined.",
          question: "What counts as a large file?",
        },
      ],
      proposals: [],
    };
    const claudePath = writeStandIn(output);

    const result = await claudeCodeCheckConsistency(config(claudePath))(
      consistencyRequest(),
      SESSION,
    );

    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expect(consistencyJsonSchema(LIMITS)).toBe(jsonSchema(consistencyOutcome(LIMITS)));
    expect(flag(argv, "--json-schema")).toBe(consistencyJsonSchema(LIMITS));
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob");
  });

  test("refuses a finding naming no waypoint with agent_output_invalid", async () => {
    const claudePath = writeStandIn({
      findings: [
        {
          kind: "undefined_term",
          waypointNumbers: [],
          title: "T",
          explanation: "E",
          question: "Q",
        },
      ],
      proposals: [],
    });

    const result = await claudeCodeCheckConsistency(config(claudePath))(
      consistencyRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("returns the pass's proposals of new maps; an idea or line outside its bounds is agent_output_invalid", async () => {
    const output = {
      findings: [],
      proposals: [
        { title: "New map", idea: "Count words too.", line: "Word counts are their own effort." },
      ],
    };
    const result = await claudeCodeCheckConsistency(config(writeStandIn(output)))(
      consistencyRequest(),
      SESSION,
    );
    expect(result).toEqual({ ok: true, value: output });
    for (const proposal of [
      { title: "New map", idea: "w".repeat(4001), line: "Later." },
      { title: "New map", idea: "Count words.", line: "l".repeat(501) },
    ]) {
      const refused = await claudeCodeCheckConsistency(
        config(writeStandIn({ findings: [], proposals: [proposal] })),
      )(consistencyRequest(), SESSION);
      expect(refused.ok ? null : refused.error.code).toBe("agent_output_invalid");
    }
  });

  test("its prompt carries the propose-or-rule-out rule and keeps conflicts as findings", () => {
    const prompt = buildConsistencyPrompt(consistencyRequest(), LIMITS);
    expect(prompt).toContain(PROPOSE_OR_RULE_OUT_RULE.join("\n"));
    expect(prompt).toContain(PROPOSAL_IDEA_RULE.join("\n"));
    expect(prompt).toContain(
      "A conflict between resolutions is always a finding, never a proposal.",
    );
  });
});

describe("the research and task runs' rulings may carry a proposal", () => {
  test("their prompts carry the propose-or-rule-out rule for a ruling's proposal", () => {
    for (const prompt of [
      buildResearchPrompt(researchRequest([]), LIMITS, 24),
      buildTaskPrompt(taskRequest(), LIMITS, 24),
    ]) {
      expect(prompt).toContain(outOfScopeRule(LIMITS).join("\n"));
      expect(prompt).toContain(PROPOSE_OR_RULE_OUT_RULE.join("\n"));
      expect(prompt).toContain("set outOfScope.proposal with its title and idea");
    }
  });

  test("the consistency, research and task prompts carry the no-repeat, no-existing-map and salient-only rules, never propose-when-unsure", () => {
    for (const prompt of [
      buildConsistencyPrompt(consistencyRequest(), LIMITS),
      buildResearchPrompt(researchRequest([]), LIMITS, 24),
      buildTaskPrompt(taskRequest(), LIMITS, 24),
    ]) {
      expect(suggestionRuleProblems(prompt)).toEqual([]);
    }
  });

  test("the research and task prompts still describe outOfScope.proposal", () => {
    for (const prompt of [
      buildResearchPrompt(researchRequest([]), LIMITS, 24),
      buildTaskPrompt(taskRequest(), LIMITS, 24),
    ]) {
      expect(prompt).toContain("outOfScope.proposal");
      expect(prompt).toContain("Leave proposal out for a plain ruling.");
    }
  });

  test("a task's out-of-scope ruling with a proposal parses into its outcome", async () => {
    const outOfScope = {
      reason: "Exports are another effort.",
      proposal: { title: "New map", idea: "Export counts." },
    };
    const result = await claudeCodeWorkTask(
      config(
        writeStandIn({
          kind: "outOfScope",
          intro: null,
          questions: null,
          done: null,
          failed: null,
          outOfScope,
          mapChanges: NO_CHANGES,
        }),
      ),
    )(taskRequest(), SESSION);
    expect(result).toEqual({
      ok: true,
      value: { round: null, done: null, failed: null, outOfScope, mapChanges: NO_CHANGES },
    });
  });
});

describe("a research waypoint's touches", () => {
  test("the prompt names each touched criterion's baseline commit, so research reads the delivered code", () => {
    const touch = {
      specNumber: 3,
      specTitle: "Separators",
      revision: 2,
      content: TOUCHED_CONTENT,
      criteria: [
        {
          id: "2.1",
          text: "Separators collapse.",
          baseline: { ticket: "T4", run: 2, commit: "0a1b2c3" },
        },
      ],
    };
    const base = researchRequest([]);
    const prompt = buildResearchPrompt(
      {
        ...base,
        waypoint: { ...base.waypoint, touches: [touch] },
      },
      LIMITS,
      24,
    );
    expect(prompt).toContain(touchLine(touch));
    expect(prompt).toContain("Baseline 2.1: T4, run 2, commit 0a1b2c3");
    expect(buildResearchPrompt(base, LIMITS, 24)).toContain("Touches: none");
    // The touched revision's approved text, not only ids.
    expect(prompt).toContain(touchedTextLine(touch));
    expect(prompt).toMatch(/^<<<TOUCHED-SPEC-3-REVISION-2 \S+$/m);
  });

  test("a task reads its touches and the touched revision's approved text", () => {
    const touch = {
      specNumber: 2,
      specTitle: "Separators",
      revision: 5,
      content: TOUCHED_CONTENT,
      criteria: [{ id: "2.1", text: "Separators collapse.", baseline: null }],
    };
    const base = taskRequest();
    const prompt = buildTaskPrompt(
      { ...base, waypoint: { ...base.waypoint, touches: [touch] } },
      LIMITS,
      24,
    );
    expect(prompt).toContain(touchLine(touch));
    expect(prompt).toContain(touchedTextLine(touch));
    expect(prompt).toMatch(/^<<<TOUCHED-SPEC-2-REVISION-5 \S+$/m);
    expect(prompt).toContain('"text": "Separators collapse after trimming."');
    expect(buildTaskPrompt(base, LIMITS, 24)).toContain("Touches: none");
  });
});

const TOUCHED_CONTENT = {
  title: "Separators",
  problem: "Separators repeat.",
  solution: "Collapse them.",
  clauses: [
    {
      id: "C2",
      title: "Collapse",
      text: "Separators collapse after trimming.",
      criteria: [{ id: "2.1", text: "Separators collapse." }],
      sources: [{ kind: "destination" as const }],
    },
  ],
  outOfScope: [],
};

describe("the map's code survey", () => {
  test("each prompt carries the survey as FACTS, or says the map has none", () => {
    const builds = [
      (survey: CodeSurvey | null) =>
        buildResearchPrompt({ ...researchRequest([]), survey }, LIMITS, 24),
      (survey: CodeSurvey | null) => buildTaskPrompt({ ...taskRequest(), survey }, LIMITS, 24),
      (survey: CodeSurvey | null) =>
        buildConsistencyPrompt({ ...consistencyRequest(), survey }, LIMITS),
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

describe("the research, task and consistency runs' lengths follow the model's limits (agent.models)", () => {
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
  // A decided fog item's resolution reaches these runs only through mapChanges.fogDecided, which
  // their prompts say to leave empty.
  const runs = [
    [
      "a research run",
      () => ({
        prompt: buildResearchPrompt(researchRequest([]), D, 24),
        jsonSchema: researchJsonSchema(D),
        fields: [
          ...changes.filter((field) => field !== "agentDecided"),
          "researchSummary",
          "researchFindingTitle",
          "researchFindingDetail",
          "researchSourceTitle",
          "researchExcerpt",
          "researchNote",
        ],
        exempt: ["resolution" as const],
      }),
    ],
    [
      "a task run",
      () => ({
        prompt: buildTaskPrompt(taskRequest(), D, 24),
        jsonSchema: taskJsonSchema(D),
        fields: [...round, ...changes, "taskAction", "taskFacts"],
        exempt: ["resolution" as const],
      }),
    ],
    [
      "a consistency pass",
      () => ({
        prompt: buildConsistencyPrompt(consistencyRequest(), D),
        jsonSchema: consistencyJsonSchema(D),
        fields: ["mapTitle", "waypointTitle", "waypointQuestion", "mapLine", "findingExplanation"],
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

describe("the destination rounds in the Research, Task and consistency prompts", () => {
  test("each renders the map-level rounds right after the destination", () => {
    expectRoundsAfterDestination(buildResearchPrompt(researchRequest([]), LIMITS, 24));
    expectRoundsAfterDestination(buildTaskPrompt(taskRequest(), LIMITS, 24));
    expectRoundsAfterDestination(buildConsistencyPrompt(consistencyRequest(), LIMITS));
  });
});
