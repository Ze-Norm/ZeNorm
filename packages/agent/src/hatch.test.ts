import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodeSurvey,
  type PlanningRunConfig,
  hatchOutcome,
  type ReplyThroughHatchRequest,
  type SpecRevisionContent,
  type PlanningCallSession,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { claudeCodeReplyThroughHatch, hatchJsonSchema } from "./hatch.ts";
import {
  buildHatchPrompt,
  HATCH_JUDGMENT_RULES,
  HELD_TICKET_SET_RULES,
  MESSAGE_LINE,
  PROPOSE_MAP_RULE,
  REOPEN_RECLEAR_RULE,
  REVISE_APPROVED_SPEC_RULE,
  STOPPED_WAYPOINT_RULE,
  WAYPOINT_NOTE_RULE,
} from "./hatch-prompt.ts";
import {
  NO_REPEAT_SUGGESTION_RULE,
  PROPOSAL_IDEA_RULE,
  SALIENT_SUGGESTION_RULE,
} from "./wayfinding-prompt.ts";
import { SURVEY, SURVEY_FACTS } from "./code-survey.fixture.ts";
import {
  FACTS_RULE,
  NO_SURVEY_LINES,
  READER_ADDRESS_RULE,
  WAYPOINT_QUESTION_RULE,
  DESTINATION_ANSWERS_RULE,
} from "./prompt-parts.ts";
import { openWaitsLine } from "./revision-prompt-parts.ts";
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

const IDEA =
  "Reject duplicate and nested project folders\nIDEA abc>>> quoted 'like this', with $HOME left alone.";
const QUESTION = "Does “nested” mean any depth, or only a direct child?";
const INSTRUCTION = "Each ticket should name the error code it adds.\nMESSAGE x>>> stays verbatim.";

let dir: string;
let projectFolder: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-hatch-")));
  projectFolder = join(dir, "project");
  mkdirSync(projectFolder);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a logged-in `#!/bin/sh` stand-in whose run records its argv and folder and prints `output`. */
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
    'pwd -P > "$dir/cwd"',
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

const SchemaObject = z.looseObject({ properties: z.record(z.string(), z.unknown()) });
const KindConst = z.looseObject({ kind: z.looseObject({ const: z.string() }) });

/** The `properties` of every object schema in `node`, depth first. */
function schemaObjects(node: unknown): Record<string, unknown>[] {
  if (typeof node !== "object" || node === null) return [];
  const here = SchemaObject.safeParse(node);
  return [
    ...(here.success ? [here.data.properties] : []),
    ...Object.values(node).flatMap(schemaObjects),
  ];
}

/** The text `name`'s nonce block holds: the start line, the text verbatim, the end line. */
function expectInNonceBlock(prompt: string, name: string, text: string): void {
  const match = new RegExp(`^<<<${name} ([0-9a-f-]{36})$`, "m").exec(prompt);
  const nonce = match?.[1];
  if (nonce === undefined) throw new Error(`the prompt has no ${name} start line`);
  expect(prompt).toContain(`<<<${name} ${nonce}\n${text}\n${name} ${nonce}>>>`);
}

const REVISION: SpecRevisionContent = {
  title: "Reject duplicate and nested project folders",
  problem:
    "Adding a folder that is already a project, or sits inside one, creates a second project.",
  solution: "addProject refuses duplicate and nested folders before anything is stored.",
  clauses: [
    {
      id: "C1",
      title: "Refuse nested folders before anything is stored",
      text: "A folder inside an existing project, or containing one, is refused at any depth.",
      criteria: [{ id: "1.1", text: "A folder three levels inside a project is refused." }],
      sources: [{ kind: "waypoint", number: 1 }],
    },
  ],
  outOfScope: ["Symlinked folders."],
};

function request(
  message: ReplyThroughHatchRequest["message"],
  refusedAttempt: ReplyThroughHatchRequest["refusedAttempt"],
): ReplyThroughHatchRequest {
  return {
    survey: null,
    projectName: "zenorm",
    projectFolder,
    baseBranch: "main",
    idea: IDEA,
    ...PROJECT_CONTEXT,
    title: "Reject duplicate and nested project folders",
    destination: "Duplicate and nested folders can't become projects.",
    mapRounds: MAP_ROUNDS,
    waypoints: [
      {
        number: 1,
        kind: "grilling",
        title: "Decide nested-folder handling",
        question: "What happens when a folder sits inside a project?",
        status: "resolved",
        blockedBy: [],
        resolution: "Nesting is refused both ways, at any depth.",
        gist: "Nesting refused both ways",
        agentDecided: [],
        waiting: null,
        report: null,
        stopped: false,
      },
      {
        number: 2,
        kind: "research",
        title: "Symlinks",
        question: "Does realpath resolve symlinked folders?",
        status: "open",
        blockedBy: [1],
        resolution: null,
        gist: null,
        agentDecided: null,
        waiting: "research_unanswered",
        report: {
          summary: "realpath resolves symlinks on macOS; Linux was not checked.",
          gap: "Whether realpath resolves symlinks on Linux.",
        },
        stopped: false,
      },
    ],
    fog: [{ position: 3, text: "Network drives" }],
    outOfScope: ["Moving a project: the destination names adding only."],
    waits: [],
    specs: [
      {
        latest: { specNumber: 4, revision: 2, content: REVISION },
        state: "draft",
        ticketSet: { version: 1, state: "awaiting_review", review: "none", heldFindings: null },
        inFlight: ["spec_review"],
      },
    ],
    earlierMessages: [
      {
        stage: "wayfinding",
        specNumber: null,
        text: "What did waypoint 1 decide?",
        reply: "Nesting is refused both ways.",
      },
    ],
    message,
    refusedAttempt,
  };
}

/** Screen 14's question on the spec it asks about (D5's boundary: a reply and no change). */
function questionRequest(): ReplyThroughHatchRequest {
  return request({ stage: "spec", specNumber: 4, text: QUESTION }, null);
}

/** An instruction with no named target, sent from Tickets (D5: `rewrite_tickets`). */
function instructionRequest(): ReplyThroughHatchRequest {
  return request({ stage: "tickets", specNumber: 4, text: INSTRUCTION }, null);
}

describe("buildHatchPrompt", () => {
  test("puts the idea and the message in nonce blocks, the message after `Message from the person:`", () => {
    const prompt = buildHatchPrompt(questionRequest(), LIMITS);
    expectInNonceBlock(prompt, "IDEA", IDEA);
    expectInNonceBlock(prompt, "MESSAGE", QUESTION);
    expect(prompt).toMatch(/^Message from the person:\n<<<MESSAGE [0-9a-f-]{36}$/m);
    expect(MESSAGE_LINE).toBe("Message from the person:");
  });

  test("writes to the person as \"you\" and to the product's users in the project's word", () => {
    expect(buildHatchPrompt(questionRequest(), LIMITS)).toContain(READER_ADDRESS_RULE.join("\n"));
  });

  test("asks an opened or reworded waypoint's question alone", () => {
    expect(buildHatchPrompt(questionRequest(), LIMITS)).toContain(
      WAYPOINT_QUESTION_RULE.map((line) => `  ${line}`).join("\n"),
    );
  });

  test("carries the plain lines the stand-in keys on", () => {
    const lines = buildHatchPrompt(questionRequest(), LIMITS).split("\n");
    expect(lines).toContain("Stage on screen: spec");
    expect(lines).toContain("Spec on screen: 4");
    expect(lines).toContain("Waypoint 1 status: resolved");
    expect(lines).toContain("Waypoint 2 status: open, waiting: research_unanswered");
    expect(lines).toContain("Fog positions: 3");
    expect(lines).toContain(
      "Spec 4: revision 2 draft; ticket set: version 1 awaiting_review, review none; in flight: spec_review",
    );
    expect(lines).toContain("Earlier messages: 1");
    expect(lines).toContain("Previous attempt refused: no");
  });

  test("renders every part of the request", () => {
    const prompt = buildHatchPrompt(instructionRequest(), LIMITS);
    expect(prompt).toContain("Question: What happens when a folder sits inside a project?");
    expect(prompt).toContain("Blocked by: 1");
    expect(prompt).toContain("Resolution: Nesting is refused both ways, at any depth.");
    expect(prompt).toContain("Gist: Nesting refused both ways");
    expect(prompt).toContain("Agent decided: none; the person decided everything in it.");
    expectInNonceBlock(prompt, "FOG-3", "Network drives");
    expectInNonceBlock(
      prompt,
      "OUT-OF-SCOPE-1",
      "Moving a project: the destination names adding only.",
    );
    expectInNonceBlock(prompt, "SPEC-4-REVISION-2", JSON.stringify(REVISION, null, 2));
    expectInNonceBlock(prompt, "EARLIER-MESSAGE-1", "What did waypoint 1 decide?");
    expectInNonceBlock(prompt, "EARLIER-REPLY-1", "Nesting is refused both ways.");
    expect(prompt).toContain("Earlier message 1, sent from wayfinding:");
    expectInNonceBlock(prompt, "MESSAGE", INSTRUCTION);
    const lines = prompt.split("\n");
    expect(lines).toContain("Stage on screen: tickets");
    expect(lines).toContain("Spec on screen: 4");
  });

  test("carries the project's map suggestions and maps, titles and lines quoted (C1)", () => {
    const prompt = buildHatchPrompt(questionRequest(), LIMITS);
    expect(prompt).toContain(renderedProjectContext(prompt));
    for (const expected of expectedProjectContextLines(promptNonce(prompt))) {
      expect(prompt).toContain(expected);
    }
  });

  test("renders an uncharted map with no spec on screen", () => {
    const prompt = buildHatchPrompt(
      {
        ...request({ stage: "idea", specNumber: null, text: "What will you ask first?" }, null),
        title: null,
        destination: null,
        waypoints: [],
        fog: [],
        outOfScope: [],
        specs: [],
        earlierMessages: [],
      },
      LIMITS,
    );
    const lines = prompt.split("\n");
    expect(lines).toContain("Stage on screen: idea");
    expect(lines).toContain("Spec on screen: none");
    expect(lines).toContain("Fog positions: none");
    expect(lines).toContain("Earlier messages: 0");
    expect(prompt).not.toMatch(/^<<<(TITLE|DESTINATION|WAYPOINT-|SPEC-)/m);
  });

  test("on a retry carries the refused problem after its plain line", () => {
    const problem = "Waypoint 9 does not exist.";
    const prompt = buildHatchPrompt(
      request({ stage: "wayfinding", specNumber: null, text: "Reopen 9." }, { problem }),
      LIMITS,
    );
    expect(prompt.split("\n")).toContain("Previous attempt refused: yes");
    expectInNonceBlock(prompt, "REFUSED", problem);
    expect(buildHatchPrompt(questionRequest(), LIMITS)).not.toMatch(/^<<<REFUSED /m);
  });

  test("states each D5 rule for a question and for an instruction", () => {
    expect(HATCH_JUDGMENT_RULES.join("\n")).toMatch(/question[\s\S]*no change/);
    for (const built of [questionRequest(), instructionRequest()]) {
      const prompt = buildHatchPrompt(built, LIMITS);
      for (const line of HATCH_JUDGMENT_RULES) expect(prompt).toContain(line);
      for (const kind of [
        "reopen",
        "open_waypoint",
        "reword",
        "rule_out_of_scope",
        "run_waypoint",
        "accept_report",
        "revise_spec",
        "rewrite_tickets",
        "propose_map",
      ]) {
        expect(prompt).toContain(`- ${kind} {`);
      }
    }
  });

  test("states Waypoint 8's propose_map rule and gives each Out of scope line its position", () => {
    const prompt = buildHatchPrompt(instructionRequest(), LIMITS);
    expect(prompt).toContain(PROPOSE_MAP_RULE.join("\n"));
    expect(prompt).toContain(PROPOSAL_IDEA_RULE.map((line) => `  ${line}`).join("\n"));
    expect(prompt.split("\n")).toContain("Out of scope line at position 1:");
    expect(prompt).toMatch(/^Out of scope line at position 1:\n<<<OUT-OF-SCOPE-1 /m);
  });

  test("its propose_map rule carries the no-repeat, no-existing-map and salient-only rules, never propose-when-unsure", () => {
    const prompt = buildHatchPrompt(instructionRequest(), LIMITS);
    expect(suggestionRuleProblems(prompt)).toEqual([]);
    const rule = PROPOSE_MAP_RULE.join("\n");
    expect(rule).toContain(NO_REPEAT_SUGGESTION_RULE.map((line) => `  ${line}`).join("\n"));
    expect(rule).toContain(SALIENT_SUGGESTION_RULE.map((line) => `  ${line}`).join("\n"));
  });

  test("states that after a reopen the re-clear writes the spec, so the reply asks for no revision (L149 (a))", () => {
    const prompt = buildHatchPrompt(instructionRequest(), LIMITS);
    expect(prompt).toContain(REOPEN_RECLEAR_RULE.join("\n"));
    const rule = prompt.indexOf(REOPEN_RECLEAR_RULE.join("\n"));
    expect(rule).toBeGreaterThan(prompt.indexOf("- reopen {"));
  });

  test("states that a reopen, reword or rerun carries the message to the waypoint's next run (L162 (3))", () => {
    const prompt = buildHatchPrompt(instructionRequest(), LIMITS);
    const rule = WAYPOINT_NOTE_RULE.join("\n");
    expect(prompt).toContain(rule);
    expect(prompt.indexOf(rule)).toBeGreaterThan(prompt.indexOf("- run_waypoint {"));
    for (const kind of ["reopen", "reword", "run_waypoint"]) expect(rule).toContain(kind);
  });

  test("renders a waiting waypoint's unanswered report for an accept_report gist (L162 (4))", () => {
    const prompt = buildHatchPrompt(instructionRequest(), LIMITS);
    expect(prompt).toContain(
      "Unanswered report summary: realpath resolves symlinks on macOS; Linux was not checked.",
    );
    expect(prompt).toContain("Unanswered report gap: Whether realpath resolves symlinks on Linux.");
    const answered = instructionRequest();
    const none: ReplyThroughHatchRequest = {
      ...answered,
      waypoints: answered.waypoints.map((waypoint) => ({
        ...waypoint,
        waiting: null,
        report: null,
      })),
    };
    expect(buildHatchPrompt(none, LIMITS)).not.toContain("Unanswered report summary:");
  });

  test("names the approved specs, and the rule promises no revision of one (L156 (2))", () => {
    const draft = instructionRequest();
    expect(buildHatchPrompt(draft, LIMITS).split("\n")).toContain("Approved specs: none");
    const approved: ReplyThroughHatchRequest = {
      ...draft,
      specs: draft.specs.map((spec) => ({ ...spec, state: "approved" as const })),
    };
    const prompt = buildHatchPrompt(approved, LIMITS);
    expect(prompt.split("\n")).toContain("Approved specs: 4");
    const rule = REOPEN_RECLEAR_RULE.join("\n");
    expect(rule).toMatch(/approved[\s\S]*stands[\s\S]*no revision/);
    expect(prompt.indexOf("Approved specs: 4")).toBeLessThan(prompt.indexOf(rule));
  });

  test("names the map's open waits with their notes, and the rule answers a waited spec with no change (E-4)", () => {
    const none = buildHatchPrompt(instructionRequest(), LIMITS);
    expect(none.split("\n")).toContain(openWaitsLine([]));
    const wait = { specNumber: 7, note: "Accept symlinked folders too." };
    const waiting = buildHatchPrompt({ ...instructionRequest(), waits: [wait] }, LIMITS);
    expect(waiting.split("\n")).toContain(openWaitsLine([wait]));
    expect(waiting).toContain(wait.note);
    const rule = HATCH_JUDGMENT_RULES.join("\n");
    expect(rule).toMatch(/waits on[\s\S]*no change[\s\S]*not saved/);
  });

  test("an approved or delivered spec is changed through revise_spec, never refused as approved (L213 D-3)", () => {
    const draft = instructionRequest();
    const approved: ReplyThroughHatchRequest = {
      ...draft,
      specs: draft.specs.map((spec) => ({ ...spec, state: "approved" as const })),
    };
    const prompt = buildHatchPrompt(approved, LIMITS);
    for (const line of REVISE_APPROVED_SPEC_RULE) expect(prompt).toContain(line);
    const rule = REVISE_APPROVED_SPEC_RULE.join("\n");
    expect(rule).toMatch(/approved or already delivered, propose revise_spec/);
    expect(rule).toMatch(/records the change as a\s+wait/);
    expect(prompt.indexOf(rule)).toBeLessThan(prompt.indexOf("- revise_spec {}:"));
    expect(prompt).not.toMatch(/approved spec\s+cannot be changed/);
    expect(prompt).not.toMatch(/an approved spec or ticket set/);
  });
});

/** The request with waypoint 1 a Grilling waypoint stopped after a failed retry (S6a-12). */
function stoppedGrillingRequest(text: string): ReplyThroughHatchRequest {
  const base = request({ stage: "wayfinding", specNumber: null, text }, null);
  return {
    ...base,
    waypoints: base.waypoints.map((waypoint) =>
      waypoint.number === 1
        ? { ...waypoint, status: "open" as const, resolution: null, gist: null, stopped: true }
        : waypoint,
    ),
  };
}

describe("stopped waypoints and held ticket sets (slice 7c D8, L164)", () => {
  test("S7c-14: marks a stopped waypoint on its status line and in its block", () => {
    const prompt = buildHatchPrompt(stoppedGrillingRequest("Why did waypoint 1 stop?"), LIMITS);
    const lines = prompt.split("\n");
    expect(lines).toContain("Waypoint 1 status: open, stopped");
    expect(lines).toContain("Waypoint 2 status: open, waiting: research_unanswered");
    expect(prompt).toContain(
      "Stopped: its run failed twice; Try again or run_waypoint runs it again.",
    );
    expect(buildHatchPrompt(questionRequest(), LIMITS)).not.toContain("Stopped:");
  });

  test("S7c-14: run_waypoint runs a waiting or stopped waypoint of any kind (L157)", () => {
    const prompt = buildHatchPrompt(stoppedGrillingRequest("Run waypoint 1 again."), LIMITS);
    expect(prompt).toContain(
      "- run_waypoint {waypoint}: a waypoint waiting on the person or stopped, of any kind, runs again",
    );
    expect(prompt).not.toContain("(an unanswered report or a failed task) runs again");
  });

  test("S7c-14: a reply about a stopped waypoint it does not rerun points at Try again or a note", () => {
    const prompt = buildHatchPrompt(stoppedGrillingRequest("Why did waypoint 1 stop?"), LIMITS);
    const rule = STOPPED_WAYPOINT_RULE.join("\n");
    expect(prompt).toContain(rule);
    expect(prompt.indexOf(rule)).toBeGreaterThan(prompt.indexOf("- run_waypoint {"));
    expect(rule).toMatch(/Try[\s]+again/);
    expect(rule).toContain("note asking to rerun it");
    expect(rule).toMatch(/never say it will run/);
  });

  test("D8: a held set's review and escalated findings are listed, and the held-set rules stated", () => {
    const base = instructionRequest();
    const held: ReplyThroughHatchRequest = {
      ...base,
      specs: base.specs.map((spec) => ({
        ...spec,
        state: "approved" as const,
        inFlight: [],
        ticketSet: {
          version: 3,
          state: "review_failed" as const,
          review: "held" as const,
          heldFindings: [
            {
              title: "Export format undecided",
              question: "Should the export write CSV, JSON or both?",
            },
          ],
        },
      })),
    };
    const prompt = buildHatchPrompt(held, LIMITS);
    const lines = prompt.split("\n");
    expect(lines).toContain(
      "Spec 4: revision 2 approved; ticket set: version 3 review_failed, review held; in flight: none",
    );
    expect(lines).toContain("Spec 4 ticket set held, findings: 1");
    expectInNonceBlock(
      prompt,
      "SPEC-4-HELD-FINDING-1",
      "Title: Export format undecided\nQuestion: Should the export write CSV, JSON or both?",
    );
    const rules = HELD_TICKET_SET_RULES.join("\n");
    expect(prompt).toContain(rules);
    expect(rules).toMatch(/how to fix the tickets is rewrite_tickets/);
    expect(rules).toMatch(/question about the hold gets a reply that names the held findings/);
    expect(buildHatchPrompt(base, LIMITS)).not.toContain("ticket set held, findings:");
  });
});

describe("claudeCodeReplyThroughHatch", () => {
  test("sends the hatch schema with the read-only tools from the project folder", async () => {
    const output = { reply: "Any depth. Nothing to change.", change: null };
    const claudePath = writeStandIn(output);

    const result = await claudeCodeReplyThroughHatch(config(claudePath))(
      questionRequest(),
      SESSION,
    );

    expect(result).toEqual({ ok: true, value: output });
    const argv = recordedArgv();
    expect(hatchJsonSchema(LIMITS)).toBe(
      JSON.stringify(z.toJSONSchema(hatchOutcome(LIMITS), { target: "draft-07" })),
    );
    expect(flag(argv, "--json-schema")).toBe(hatchJsonSchema(LIMITS));
    const root = z
      .looseObject({ properties: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(hatchJsonSchema(LIMITS)));
    expect(Object.keys(root.properties)).toEqual(["reply", "change"]);
    expect(flag(argv, "--tools")).toBe("Read,Grep,Glob");
    expect(flag(argv, "--allowedTools")).toBe("Read,Grep,Glob");
    expect(flag(argv, "--disallowedTools")).toBe("Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch");
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(projectFolder);
  });

  test("returns a change", async () => {
    const output = { reply: "I'll rewrite the tickets.", change: { kind: "rewrite_tickets" } };
    const claudePath = writeStandIn(output);

    const result = await claudeCodeReplyThroughHatch(config(claudePath))(
      instructionRequest(),
      SESSION,
    );

    expect(result).toEqual({ ok: true, value: output });
  });

  test("its --json-schema carries propose_map, and a proposal with a line or a position is returned", async () => {
    const member = schemaObjects(JSON.parse(hatchJsonSchema(LIMITS))).find(
      (properties) => KindConst.safeParse(properties).data?.kind.const === "propose_map",
    );
    expect(member === undefined ? null : Object.keys(member)).toEqual([
      "kind",
      "title",
      "idea",
      "line",
      "splitsLine",
    ]);
    for (const change of [
      {
        kind: "propose_map",
        title: "New map",
        idea: "Import records from CSV.",
        line: "Imports.",
        splitsLine: null,
      },
      {
        kind: "propose_map",
        title: "New map",
        idea: "Move projects between folders.",
        line: null,
        splitsLine: 1,
      },
    ]) {
      const output = { reply: "I proposed a map for it.", change };
      const claudePath = writeStandIn(output);
      const result = await claudeCodeReplyThroughHatch(config(claudePath))(
        instructionRequest(),
        SESSION,
      );
      expect(result).toEqual({ ok: true, value: output });
    }
  });

  test("refuses a propose_map with both or neither of line and splitsLine with agent_output_invalid", async () => {
    for (const change of [
      {
        kind: "propose_map",
        title: "New map",
        idea: "Import records.",
        line: "Imports.",
        splitsLine: 1,
      },
      {
        kind: "propose_map",
        title: "New map",
        idea: "Import records.",
        line: null,
        splitsLine: null,
      },
      { kind: "propose_map", title: "New map", idea: "", line: "Imports.", splitsLine: null },
    ]) {
      const claudePath = writeStandIn({ reply: "Done.", change });
      const result = await claudeCodeReplyThroughHatch(config(claudePath))(
        instructionRequest(),
        SESSION,
      );
      expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    }
  });

  test("refuses an empty reply or a change with another kind's fields with agent_output_invalid", async () => {
    for (const output of [
      { reply: "", change: null },
      { reply: "Done.", change: { kind: "revise_spec", waypoint: 1 } },
    ]) {
      const claudePath = writeStandIn(output);
      const result = await claudeCodeReplyThroughHatch(config(claudePath))(
        questionRequest(),
        SESSION,
      );
      expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    }
  });
});

describe("the map's code survey (harness change #1)", () => {
  test("each prompt carries the survey as FACTS, or says the map has none", () => {
    const builds = [
      (survey: CodeSurvey | null) => buildHatchPrompt({ ...questionRequest(), survey }, LIMITS),
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

describe("the hatch reply's lengths follow the model's limits (agent.models)", () => {
  const fixedPaths: number[] = [];
  // A decided fog item's resolution reaches a reply only through a change's fog, whose lists the
  // prompt says to leave empty.
  const runs = [
    [
      "a hatch reply",
      () => ({
        prompt: buildHatchPrompt(questionRequest(), DISTINCT_LIMITS),
        jsonSchema: hatchJsonSchema(DISTINCT_LIMITS),
        fields: [
          "mapTitle",
          "waypointTitle",
          "waypointQuestion",
          "resolution",
          "gist",
          "mapLine",
          "hatchReply",
        ],
        exempt: ["resolution" as const],
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

describe("the hatch prompt's destination rounds (DR-16, D7)", () => {
  test("renders the map-level rounds right after the destination", () => {
    expectRoundsAfterDestination(buildHatchPrompt(questionRequest(), LIMITS));
  });

  test("renders a pending round's questions", () => {
    const pending = MAP_ROUNDS.map((round) => ({ ...round, answers: null }));
    const prompt = buildHatchPrompt({ ...questionRequest(), mapRounds: pending }, LIMITS);
    expectRoundsAfterDestination(prompt);
    expect(prompt).not.toContain("<<<MAP-ROUND-1-ANSWER-");
    expect(prompt).toContain(HATCH_JUDGMENT_RULES.join("\n"));
  });

  test("says an open round is answered on its stage page, not through the hatch", () => {
    expect(HATCH_JUDGMENT_RULES.join("\n")).toMatch(/open round[\s\S]*stage page/);
  });

  test("writes no round before the first chart", () => {
    const prompt = buildHatchPrompt(
      { ...questionRequest(), title: null, destination: null, mapRounds: [] },
      LIMITS,
    );
    expect(prompt).not.toContain("MAP-ROUND-");
    expect(prompt).not.toContain(DESTINATION_ANSWERS_RULE.join("\n"));
  });
});
