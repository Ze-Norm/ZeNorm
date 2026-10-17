import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FogSettlementOutcome,
  PlanningCallSession,
  SettleFogRequest,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { SURVEY } from "./code-survey.fixture.ts";
import { buildFogPrompt, claudeCodeSettleFog, fogJsonSchema, fogCountLine } from "./fog.ts";
import { DECISION_PROSE_RULE, FACTS_RULE, WAYPOINT_QUESTION_RULE } from "./prompt-parts.ts";
import {
  mapChangesRules,
  PROPOSAL_IDEA_RULE,
  PROPOSE_OR_RULE_OUT_RULE,
  SALIENCE_GATE,
} from "./wayfinding-prompt.ts";
import { boundFields, DISTINCT_LIMITS, LIMITS, unstatedLengths } from "./limits.fixture.ts";
import {
  expectedProjectContextLines,
  PROJECT_CONTEXT,
  promptNonce,
  renderedProjectContext,
  suggestionRuleProblems,
} from "./project-suggestions.fixture.ts";
import { expectRoundsAfterDestination, MAP_ROUNDS } from "./map-rounds.fixture.ts";

const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

const REQUEST: SettleFogRequest = {
  projectName: "repo",
  projectFolder: "/tmp/repo",
  baseBranch: "main",
  idea: "Export data",
  ...PROJECT_CONTEXT,
  title: "Data export",
  destination: "A CSV export of every record.",
  mapRounds: MAP_ROUNDS,
  outOfScope: ["PDF export."],
  survey: SURVEY,
  waypoints: [
    {
      number: 1,
      kind: "grilling",
      title: "Columns",
      question: "Which columns?",
      resolution: "Every column, in schema order.",
      decidedByPerson: true,
    },
    {
      number: 2,
      kind: "research",
      title: "Size limit",
      question: "How large can an export be?",
      resolution: "Streams of any size.",
      decidedByPerson: false,
    },
  ],
  fog: [
    { position: 3, text: "Large exports." },
    { position: 5, text: "The header row's wording." },
  ],
};

const OUTCOME: FogSettlementOutcome = {
  fogSettledBy: [{ position: 3, waypoint: 2 }],
  fogDecided: [],
  fogOutOfScope: [],
  fogForPerson: [{ position: 5, title: "Header row", question: "How does the header row read?" }],
  fogProposed: [],
};

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-fog-")));
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

function flag(argv: string[], name: string): string {
  const value = argv[argv.indexOf(name) + 1];
  if (value === undefined) throw new Error(`argv has no ${name}`);
  return value;
}

describe("the fog run", () => {
  test("its --json-schema roots are the five settlements, the proposals among them", () => {
    const schema = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(fogJsonSchema(LIMITS)));
    expect(Object.keys(schema.properties)).toEqual([
      "fogSettledBy",
      "fogDecided",
      "fogOutOfScope",
      "fogForPerson",
      "fogProposed",
    ]);
  });

  test("its prompt carries the propose-or-rule-out rule and the proposal's idea rule", () => {
    const prompt = buildFogPrompt(REQUEST, LIMITS);
    expect(prompt).toContain(PROPOSE_OR_RULE_OUT_RULE.join("\n"));
    expect(prompt).toContain(PROPOSAL_IDEA_RULE.join("\n"));
    expect(prompt).toContain("- fogProposed:");
  });

  test("its prompt carries the no-repeat, no-existing-map and salient-only rules, never propose-when-unsure", () => {
    expect(suggestionRuleProblems(buildFogPrompt(REQUEST, LIMITS))).toEqual([]);
  });

  test("a fog item proposed as a new map parses; an idea or line outside its bounds is agent_output_invalid", async () => {
    const proposed: FogSettlementOutcome = {
      ...OUTCOME,
      fogForPerson: [],
      fogProposed: [
        {
          position: 5,
          title: "Localise the header",
          idea: "Localise the header row.",
          line: "Localisation is its own effort.",
        },
      ],
    };
    const settle = (claudePath: string) =>
      claudeCodeSettleFog({
        claudePath,
        model: "claude-sonnet-5-5",
        limits: LIMITS,
        effort: "medium",
        maxTurns: 12,
        timeoutSeconds: 30,
        sessionsDir: dir,
      })({ ...REQUEST, projectFolder: dir }, SESSION);
    expect(await settle(writeStandIn(proposed))).toEqual({ ok: true, value: proposed });
    for (const item of [
      { position: 5, idea: "i".repeat(4001), line: "Later." },
      { position: 5, idea: "   ", line: "Later." },
      { position: 5, idea: "Localise it.", line: "l".repeat(501) },
    ]) {
      const result = await settle(writeStandIn({ ...proposed, fogProposed: [item] }));
      expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    }
  });

  test("a decided fog item has no agentDecided, and its prose states the decision alone", () => {
    const prompt = buildFogPrompt(REQUEST, LIMITS);
    expect(fogJsonSchema(LIMITS)).not.toContain("agentDecided");
    expect(prompt).not.toContain("agentDecided");
    expect(prompt).toContain(DECISION_PROSE_RULE.join("\n"));
  });

  test("its prompt carries the map, FACTS, every resolution and every fog item in nonce blocks", () => {
    const prompt = buildFogPrompt(REQUEST, LIMITS);
    for (const name of ["IDEA", "TITLE", "DESTINATION", "FACTS", "WAYPOINT-1", "WAYPOINT-2"]) {
      expect(prompt).toMatch(new RegExp(`<<<${name} [0-9a-f-]{36}\\n`));
    }
    expect(prompt).toMatch(/<<<FOG-3 [0-9a-f-]{36}\nLarge exports\.\nFOG-3 [0-9a-f-]{36}>>>/);
    const lines = prompt.split("\n");
    expect(lines).toContain(fogCountLine(2));
    expect(lines).toContain("Fog item at position 3:");
    expect(lines).toContain("Fog item at position 5:");
    expect(lines).toContain("Decided by: the person");
    expect(lines).toContain("Decided by: the agent alone");
    expect(prompt).toContain(FACTS_RULE.join("\n"));
    expect(prompt).toContain(SALIENCE_GATE.join("\n"));
    expect(prompt).toContain(WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`).join("\n"));
    expect(prompt).toContain("settle each fog item exactly once");
    // The waypoint runs' map-change rules are not the fog run's.
    expect(prompt).not.toContain(mapChangesRules(LIMITS)[0]);
  });

  test("its prompt carries the project's map suggestions and maps, titles and lines quoted", () => {
    const prompt = buildFogPrompt(REQUEST, LIMITS);
    expect(prompt).toContain(renderedProjectContext(prompt));
    for (const expected of expectedProjectContextLines(promptNonce(prompt))) {
      expect(prompt).toContain(expected);
    }
  });

  test("runs read-only at the configured budget and returns the parsed settlement", async () => {
    const claudePath = writeStandIn(OUTCOME);
    const result = await claudeCodeSettleFog({
      claudePath,
      model: "claude-sonnet-5-5",
      limits: LIMITS,
      effort: "medium",
      maxTurns: 12,
      timeoutSeconds: 30,
      sessionsDir: dir,
    })({ ...REQUEST, projectFolder: dir }, SESSION);

    expect(result).toEqual({ ok: true, value: OUTCOME });
    const argv = readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);
    expect(flag(argv, "--max-turns")).toBe("12");
    expect(flag(argv, "--json-schema")).toBe(fogJsonSchema(LIMITS));
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob");
  });
});

describe("the fog run's lengths follow the model's limits (agent.models)", () => {
  const fixedPaths: number[] = [];
  const runs = [
    [
      "a fog run",
      () => ({
        prompt: buildFogPrompt(REQUEST, DISTINCT_LIMITS),
        jsonSchema: fogJsonSchema(DISTINCT_LIMITS),
        fields: ["mapTitle", "waypointTitle", "waypointQuestion", "resolution", "gist", "mapLine"],
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

describe("the fog prompt's destination rounds", () => {
  test("renders the map-level rounds right after the destination", () => {
    expectRoundsAfterDestination(buildFogPrompt(REQUEST, LIMITS));
  });
});
