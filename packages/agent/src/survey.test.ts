import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodeSurveyDraft,
  type PlanningCallSession,
  type PlanningRunConfig,
  SURVEY_AREA_FACTS_MAX_COUNT,
  SURVEY_AREAS_MAX_COUNT,
  SURVEY_IDENTIFIERS_MAX_COUNT,
  SURVEY_SURFACE_FILES_MAX_COUNT,
  SURVEY_UNVERIFIABLE_MAX_COUNT,
  type SurveyCodeRequest,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { boundFields, DISTINCT_LIMITS, LIMITS, unstatedLengths } from "./limits.fixture.ts";
import { PROJECT_RULES } from "./prompt-parts.ts";
import {
  buildSurveyPrompt,
  claudeCodeSurveyCode,
  surveyJsonSchema,
  surveyRunConfig,
} from "./survey.ts";

const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

const REQUEST: SurveyCodeRequest = {
  projectName: "repo",
  projectFolder: "/tmp/repo",
  baseBranch: "main",
  idea: "Export data",
  title: "Data export",
  destination: "A CSV export of every record.",
  waypoints: [{ number: 1, kind: "grilling", title: "Columns", question: "Which columns?" }],
  fog: [{ position: 1, text: "Large exports." }],
  outOfScope: ["PDF export."],
};

const SURVEY: CodeSurveyDraft = {
  entries: [
    {
      area: "packages/core",
      role: "Domain functions.",
      touched: true,
      why: "Records live here.",
      surfaceFiles: ["packages/core/src/records.ts"],
      facts: [
        { claim: "readRecords reads every record.", path: "packages/core/src/records.ts", line: 3 },
      ],
    },
  ],
  identifiers: [{ name: "records", meaning: "The records table.", path: "schema.ts", line: 1 }],
  unverifiable: [],
  lifecycles: [],
};

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-survey-")));
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

describe("the code survey", () => {
  test("its --json-schema roots are entries, identifiers, unverifiable and lifecycles", () => {
    const schema = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(surveyJsonSchema(LIMITS)));
    expect(Object.keys(schema.properties)).toEqual([
      "entries",
      "identifiers",
      "unverifiable",
      "lifecycles",
    ]);
  });

  test("its prompt asks for each touched record's lifecycle, cited at the code that decides it", () => {
    const prompt = buildSurveyPrompt(REQUEST, LIMITS, 48);
    expect(prompt).toContain(
      "- lifecycles: up to 10, one per stateful record the destination creates",
    );
    expect(prompt).toContain("cited at the line that sets the new state");
    expect(prompt).toContain("what, if anything, moves a record out");
  });

  test("its prompt carries the map in nonce blocks and the project's rules", () => {
    const prompt = buildSurveyPrompt(REQUEST, LIMITS, 36);
    for (const name of ["IDEA", "TITLE", "DESTINATION", "WAYPOINT-1", "FOG-1", "OUT-OF-SCOPE-1"]) {
      expect(prompt).toMatch(new RegExp(`^<<<${name} [0-9a-f-]{36}$`, "m"));
    }
    for (const text of [
      REQUEST.idea,
      REQUEST.title,
      REQUEST.destination,
      "Title: Columns",
      "Large exports.",
      "PDF export.",
      ...PROJECT_RULES,
    ]) {
      expect(prompt).toContain(text);
    }
  });

  test("its prompt names the rules files, the workspace layout, every output field and the limits", () => {
    const prompt = buildSurveyPrompt(REQUEST, LIMITS, 36);
    for (const text of [
      "AGENTS.md",
      "CLAUDE.md",
      "CONTEXT.md",
      "workspace manifest",
      "- entries:",
      "- area:",
      "- touched:",
      "why:",
      "- surfaceFiles:",
      "- facts:",
      "- identifiers:",
      "meaning:",
      "- unverifiable:",
      "1-based line",
      "You have 36 turns",
      String(SURVEY_AREAS_MAX_COUNT),
      String(SURVEY_SURFACE_FILES_MAX_COUNT),
      String(SURVEY_AREA_FACTS_MAX_COUNT),
      String(SURVEY_IDENTIFIERS_MAX_COUNT),
      String(SURVEY_UNVERIFIABLE_MAX_COUNT),
      "plain sentence of",
      "at most 400 characters; each identifier name, record and state at most 200 characters.",
    ]) {
      expect(prompt).toContain(text);
    }
    // The rules files are read before the layout, and both before the output is described.
    expect(prompt.indexOf("AGENTS.md")).toBeLessThan(prompt.indexOf("workspace manifest"));
    expect(prompt.indexOf("workspace manifest")).toBeLessThan(prompt.indexOf("- entries:"));
  });

  test("a map with no waypoints, fog or Out of scope lines says it charted no waypoints", () => {
    const prompt = buildSurveyPrompt(
      { ...REQUEST, waypoints: [], fog: [], outOfScope: [] },
      LIMITS,
      36,
    );
    expect(prompt).toContain("The chart charted no waypoints.");
    expect(prompt).not.toMatch(/^<<<(FOG|OUT-OF-SCOPE)-/m);
  });

  test("runs read-only with four times the configured turns and timeout, and states the turns", async () => {
    const claudePath = writeStandIn(SURVEY);
    expect(surveyRunConfig(config(claudePath))).toMatchObject({
      maxTurns: 48,
      timeoutSeconds: 120,
    });

    const result = await claudeCodeSurveyCode(config(claudePath))(
      { ...REQUEST, projectFolder: dir },
      SESSION,
    );

    expect(result).toEqual({ ok: true, value: SURVEY });
    const argv = recordedArgv();
    expect(flag(argv, "--max-turns")).toBe("48");
    expect(flag(argv, "-p")).toContain("You have 48 turns");
    expect(flag(argv, "--json-schema")).toBe(surveyJsonSchema(LIMITS));
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob");
    expect(flag(argv, "--disallowedTools")).toBe("Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch");
  });
});

describe("the code survey's lengths follow the model's limits (agent.models)", () => {
  // Every path's bound (SurveyPath) is structural, not a drafting length.
  const fixedPaths = [300];
  const runs = [
    [
      "a code survey",
      () => ({
        prompt: buildSurveyPrompt(REQUEST, DISTINCT_LIMITS, 36),
        jsonSchema: surveyJsonSchema(DISTINCT_LIMITS),
        fields: ["surveyText", "surveyName"],
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

describe("the survey prompt reads no destination round", () => {
  test("renders no map-level round", () => {
    expect(buildSurveyPrompt(REQUEST, LIMITS, 36)).not.toContain("MAP-ROUND-");
  });
});
