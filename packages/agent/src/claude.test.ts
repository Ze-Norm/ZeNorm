import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PlanningCallSession,
  PlanningRunConfig,
  PlanningRunUsage,
  ChartMapRequest,
  ChartProposal,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { RESUME_PROMPT } from "./claude.ts";
import { claudeCodeChartMap, chartProposalJsonSchema } from "./wayfinding.ts";
import { LIMITS } from "./limits.fixture.ts";

/** A cold session whose usage the test does not look at. */
const SESSION: PlanningCallSession = {
  resumeSessionId: null,
  onUsage: () => undefined,
  signal: new AbortController().signal,
};

/** A chart proposal: the output the headless run is exercised with. */
const PROPOSAL: ChartProposal = {
  title: "Count lines or characters",
  summary: "Let people choose the unit wordcount counts.",
  destination: "wordcount counts lines, characters or words, chosen per call.",
  round: {
    intro: "I propose: wordcount counts lines or characters.",
    questions: [
      {
        topic: "Unit",
        text: "Which unit does wordcount count by default?",
        options: [
          { label: "Lines", detail: "As wc -l." },
          { label: "Characters", detail: "As wc -m." },
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
    ],
  },
  split: [],
};

function chartRequest(): ChartMapRequest {
  return {
    projectName: "wordcount",
    projectFolder,
    baseBranch: "main",
    idea: "Let wordcount count lines or characters.",
    projectProposals: [],
    projectMaps: [{ title: null, stage: "idea" }],
    mapRounds: [],
    proposed: null,
    projectSpecs: [],
    split: [],
    refusedAttempt: null,
  };
}

const PROPOSED = { kind: "proposal", proposal: PROPOSAL };

/** `PROPOSAL` as the model writes it: the round's fields at the root. */
const { round: PROPOSAL_ROUND, ...PROPOSAL_READING } = PROPOSAL;
const PROPOSAL_OUTPUT = { ...PROPOSAL_READING, ...PROPOSAL_ROUND };

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
    stop_reason: "tool_use",
    result: "",
    structured_output: structuredOutput,
  });
}

let dir: string;
let projectFolder: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "zenorm-agent-")));
  projectFolder = join(dir, "project");
  mkdirSync(projectFolder);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface StandIn {
  /** `auth status --json` prints `stdout` and exits 0, or runs a shell `body`. */
  auth: { stdout: string } | { body: string };
  /** The run prints `stdout` and exits with `exitCode`, or runs a shell `body`. */
  run: { stdout: string; exitCode: number } | { body: string };
}

/** Writes an executable `#!/bin/sh` stand-in for the Claude Code CLI and returns its path. */
function writeStandIn(standIn: StandIn): string {
  let authBody: string;
  if ("body" in standIn.auth) {
    authBody = standIn.auth.body;
  } else {
    writeFileSync(join(dir, "auth-stdout"), standIn.auth.stdout);
    authBody = '  cat "$dir/auth-stdout"\n  exit 0';
  }
  let runBody: string;
  if ("body" in standIn.run) {
    runBody = standIn.run.body;
  } else {
    writeFileSync(join(dir, "run-stdout"), standIn.run.stdout);
    runBody = `cat "$dir/run-stdout"\nexit ${String(standIn.run.exitCode)}`;
  }
  const script = [
    "#!/bin/sh",
    `dir='${dir}'`,
    'if [ "$1" = "auth" ]; then',
    '  printf \'%s\\0\' "$@" > "$dir/auth-argv"',
    authBody,
    "fi",
    'pwd -P > "$dir/cwd"',
    'printf \'%s\\0\' "$@" > "$dir/argv"',
    runBody,
    "",
  ].join("\n");
  const path = join(dir, "claude");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

function config(claudePath: string, overrides: Partial<PlanningRunConfig> = {}): PlanningRunConfig {
  return {
    claudePath,
    model: "claude-sonnet-5-5",
    limits: LIMITS,
    effort: "medium",
    maxTurns: 12,
    timeoutSeconds: 30,
    sessionsDir: dir,
    ...overrides,
  };
}

function recordedArgv(file: string): string[] {
  const raw = readFileSync(join(dir, file), "utf8");
  // Each argument ends with a NUL, so the split leaves one empty string at the end.
  return raw.split("\0").slice(0, -1);
}

const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });

/**
 * The headless CLI run every planning port shares, exercised through the chart proposal: its argv,
 * working directory and each failure code.
 */
describe("the planning agent's headless run, through claudeCodeChartMap", () => {
  test("returns the parsed draft and spawns the auth check and the headless run in the project folder", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });
    const req = chartRequest();

    const result = await claudeCodeChartMap(config(claudePath))(req, SESSION);

    expect(result).toEqual({ ok: true, value: PROPOSED });
    expect(recordedArgv("auth-argv")).toEqual(["auth", "status", "--json"]);
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(projectFolder);

    const schema = chartProposalJsonSchema(LIMITS);
    const argv = recordedArgv("argv");
    expect(argv).toEqual([
      "-p",
      expect.any(String),
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "medium",
      "--max-turns",
      "12",
      "--setting-sources",
      "project",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--disallowedTools",
      "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
      "--json-schema",
      schema,
    ]);
    expect(argv[1]).toContain(req.idea);
    expect(argv[1]).toContain(req.projectName);
    expect(argv[1]).toContain(req.baseBranch);
  });

  test("fastMode adds Claude Code's fast mode settings after the turns", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });
    const opusFast = config(claudePath, { model: "claude-opus-5-5", fastMode: true });

    const result = await claudeCodeChartMap(opusFast)(chartRequest(), SESSION);

    expect(result.ok).toBe(true);
    const argv = recordedArgv("argv");
    const turns = argv.indexOf("--max-turns");
    expect(argv.slice(turns, turns + 5)).toEqual([
      "--max-turns",
      "12",
      "--settings",
      '{"fastMode":true}',
      "--setting-sources",
    ]);
  });

  test("refuses with agent_not_logged_in when auth reports loggedIn false", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: JSON.stringify({ loggedIn: false }) },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_not_logged_in");
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });

  test("refuses with agent_cli_missing when the binary does not exist", async () => {
    const claudePath = join(dir, "no-such-claude");

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error).toMatchObject({
      code: "agent_cli_missing",
      data: { claudePath },
    });
  });

  test("refuses with agent_run_failed on exit 1 with an error_max_turns result", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: null,
          errors: ["Reached maximum number of turns (12)"],
        }),
        exitCode: 1,
      },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error).toMatchObject({
      code: "agent_run_failed",
      data: { exitCode: 1, subtype: "error_max_turns" },
    });
  });

  test("refuses with agent_not_logged_in when the CLI lost its login mid-session (API 401)", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Failed to authenticate: OAuth token revoked.",
          api_error_status: 401,
        }),
        exitCode: 1,
      },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_not_logged_in");
  });

  test("refuses with agent_run_failed on exit 0 with an is_error result", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          structured_output: PROPOSAL_OUTPUT,
        }),
        exitCode: 0,
      },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error).toMatchObject({
      code: "agent_run_failed",
      data: { exitCode: 0, subtype: "success" },
    });
  });

  test("sends SIGTERM and refuses with agent_timed_out when the timer fires", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      // POSIX sh does not run traps during a foreground `sleep`, so sleep in the background and `wait`.
      run: {
        body: [
          "sleep 30 &",
          "pid=$!",
          "trap 'echo TERM > \"$dir/term\"; kill $pid; exit 143' TERM",
          "wait $pid",
          "exit 0",
        ].join("\n"),
      },
    });

    const result = await claudeCodeChartMap(config(claudePath, { timeoutSeconds: 1 }))(
      chartRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error).toMatchObject({
      code: "agent_timed_out",
      data: { timeoutSeconds: 1 },
    });
    expect(existsSync(join(dir, "term"))).toBe(true);
  });

  test("returns agent_cancelled and records no usage when session.signal aborts the run", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        body: [
          "sleep 30 &",
          "pid=$!",
          "trap 'echo TERM > \"$dir/term\"; kill $pid; exit 143' TERM",
          "wait $pid",
          "exit 0",
        ].join("\n"),
      },
    });
    const controller = new AbortController();
    const usages: PlanningRunUsage[] = [];
    const session: PlanningCallSession = {
      resumeSessionId: null,
      onUsage: (usage) => {
        usages.push(usage);
      },
      signal: controller.signal,
    };

    const started = Date.now();
    const pending = claudeCodeChartMap(config(claudePath))(chartRequest(), session);
    // Abort once the run (past the auth step) has started.
    while (!existsSync(join(dir, "argv"))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    const result = await pending;

    expect(result.ok ? null : result.error).toMatchObject({ code: "agent_cancelled", data: {} });
    expect(existsSync(join(dir, "term"))).toBe(true);
    expect(usages).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("refuses with agent_timed_out when the auth step outlasts the deadline, and never runs", async () => {
    const claudePath = writeStandIn({
      auth: {
        body: [
          "  sleep 30 &",
          "  pid=$!",
          "  trap 'echo TERM > \"$dir/auth-term\"; kill $pid; exit 143' TERM",
          "  wait $pid",
          "  exit 0",
        ].join("\n"),
      },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });

    const result = await claudeCodeChartMap(config(claudePath, { timeoutSeconds: 1 }))(
      chartRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error).toMatchObject({
      code: "agent_timed_out",
      data: { timeoutSeconds: 1 },
    });
    expect(existsSync(join(dir, "auth-term"))).toBe(true);
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });

  test("refuses with agent_output_invalid when the run's stdout is not JSON", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: "PONG\n", exitCode: 0 },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses with agent_output_invalid when structured_output fails ChartProposal", async () => {
    const noCriteria = { ...PROPOSAL_OUTPUT, title: "" };
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: successResult(noCriteria), exitCode: 0 },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  });

  test("refuses with agent_output_invalid when auth stdout is not JSON", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: "Logged in as someone\n" },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), SESSION);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });
});

/** The usage `successResult` reports, as `onUsage` receives it. */
const USAGE: PlanningRunUsage = {
  sessionId: "session-1",
  resultSubtype: "success",
  numTurns: 3,
  durationMs: 1200,
  totalCostUsd: 0.05,
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationInputTokens: 30,
  cacheReadInputTokens: 40,
};

/** A session that records every usage it is given. */
function recordingSession(resumeSessionId: string | null): {
  session: PlanningCallSession;
  usages: PlanningRunUsage[];
} {
  const usages: PlanningRunUsage[] = [];
  return {
    session: {
      resumeSessionId,
      onUsage: (usage) => {
        usages.push(usage);
      },
      signal: new AbortController().signal,
    },
    usages,
  };
}

describe("the run's usage and its resume", () => {
  test("reports the result's usage on a successful run", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });
    const { session, usages } = recordingSession(null);

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), session);

    expect(result.ok).toBe(true);
    expect(usages).toEqual([USAGE]);
  });

  test("reports the usage of an error_max_turns result and still refuses agent_run_failed", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          session_id: "session-9",
          num_turns: 13,
          duration_ms: 90_000,
          total_cost_usd: 1.25,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
        exitCode: 1,
      },
    });
    const { session, usages } = recordingSession(null);

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), session);

    expect(result.ok ? null : result.error).toMatchObject({
      code: "agent_run_failed",
      data: { exitCode: 1, subtype: "error_max_turns" },
    });
    expect(usages).toEqual([
      {
        sessionId: "session-9",
        resultSubtype: "error_max_turns",
        numTurns: 13,
        durationMs: 90_000,
        totalCostUsd: 1.25,
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      },
    ]);
  });

  test("refuses agent_output_invalid when a successful result lacks its usage", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 3,
          structured_output: PROPOSAL_OUTPUT,
        }),
        exitCode: 0,
      },
    });
    const { session, usages } = recordingSession(null);

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), session);

    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
    expect(usages).toEqual([]);
  });

  test("reports no usage when the run prints no result", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: "crashed", exitCode: 1 },
    });
    const { session, usages } = recordingSession(null);

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), session);

    expect(result.ok ? null : result.error.code).toBe("agent_run_failed");
    expect(usages).toEqual([]);
  });

  test("resumes the session with the continuation prompt instead of the request's prompt", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });
    const { session } = recordingSession("session-9");

    const result = await claudeCodeChartMap(config(claudePath))(chartRequest(), session);

    expect(result).toEqual({ ok: true, value: PROPOSED });
    const argv = recordedArgv("argv");
    expect(argv.slice(0, 4)).toEqual(["-p", RESUME_PROMPT, "--resume", "session-9"]);
    expect(argv.slice(4, 6)).toEqual(["--output-format", "json"]);
    expect(argv.slice(-2)).toEqual(["--json-schema", chartProposalJsonSchema(LIMITS)]);
    expect(argv.join("\n")).not.toContain(chartRequest().idea);
  });
});

const SeenRecord = z.strictObject({
  pid: z.int(),
  command: z.string(),
  startedAt: z.iso.datetime(),
  kind: z.enum(["auth", "planning", "orchestrator", "reviewer"]),
  serverPid: z.int(),
  serverStartedAt: z.iso.datetime(),
});

/** Whether no process (or group, negated) `target` is left; EPERM is one macOS is reaping. */
function gone(target: number): boolean {
  try {
    process.kill(target, 0);
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      return error.code === "ESRCH" || error.code === "EPERM";
    }
    throw error;
  }
}

/**
 * Copies the session records to `$dir/records`. `runProcess` writes a record just after the spawn,
 * so the stand-in can start before it exists; this waits until the copy is non-empty.
 */
const COPY_RECORDS = `until cat "$dir/sessions/"*.json > "$dir/records" 2>/dev/null && [ -s "$dir/records" ]; do sleep 0.02; done`;

/** A run body that copies the session records it sees, then waits on TERM-able `sleep 30`. */
const RECORDING_SLEEPER = [
  COPY_RECORDS,
  'echo $$ > "$dir/pid"',
  "sleep 30 &",
  "pid=$!",
  "trap 'kill $pid; exit 143' TERM",
  "wait $pid",
  "exit 0",
].join("\n");

/**
 * The session record `runProcess` keeps while a process runs: written right after the spawn,
 * removed once the process (and, after an abort or a timeout, its group) is gone.
 */
describe("the session records", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir);
  });

  async function untilFile(name: string): Promise<void> {
    while (!existsSync(join(dir, name))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** The session record the stand-in copied while it ran. */
  function seenRecord(): z.infer<typeof SeenRecord> {
    return SeenRecord.parse(JSON.parse(readFileSync(join(dir, "records"), "utf8")));
  }

  test("the run's record is there while it runs and gone after it exits", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: {
        body: [COPY_RECORDS, 'echo $$ > "$dir/pid"', `cat "$dir/run-stdout"`].join("\n"),
      },
    });
    writeFileSync(join(dir, "run-stdout"), successResult(PROPOSAL_OUTPUT));
    const before = Date.now();

    const result = await claudeCodeChartMap(config(claudePath, { sessionsDir }))(
      chartRequest(),
      SESSION,
    );

    expect(result).toEqual({ ok: true, value: PROPOSED });
    // Only the run's own record: the auth step's was removed when it exited.
    const { startedAt, serverStartedAt, ...record } = seenRecord();
    expect(record).toEqual({
      pid: Number(readFileSync(join(dir, "pid"), "utf8").trim()),
      command: claudePath,
      kind: "planning",
      // The server that spawned it is this test process.
      serverPid: process.pid,
    });
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(before - 1000);
    // `ps`'s start time for this process, at 1 s resolution: no later than the spawn.
    expect(Date.parse(serverStartedAt)).toBeLessThanOrEqual(Date.parse(startedAt));
    expect(Date.parse(serverStartedAt)).toBeGreaterThanOrEqual(
      Date.now() - process.uptime() * 1000 - 3000,
    );
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test("the auth step's record names its kind", async () => {
    const claudePath = writeStandIn({
      auth: {
        body: `  ${COPY_RECORDS}\n  echo '{"loggedIn":false}'\n  exit 0`,
      },
      run: { stdout: "", exitCode: 0 },
    });

    const result = await claudeCodeChartMap(config(claudePath, { sessionsDir }))(
      chartRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_not_logged_in");
    expect(seenRecord()).toMatchObject({ command: claudePath, kind: "auth" });
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test("the record is gone after an abort", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { body: RECORDING_SLEEPER },
    });
    const controller = new AbortController();

    const pending = claudeCodeChartMap(config(claudePath, { sessionsDir }))(chartRequest(), {
      ...SESSION,
      signal: controller.signal,
    });
    await untilFile("pid");
    expect(readdirSync(sessionsDir)).toEqual([
      `${readFileSync(join(dir, "pid"), "utf8").trim()}.json`,
    ]);
    controller.abort();
    const result = await pending;

    expect(result.ok ? null : result.error.code).toBe("agent_cancelled");
    expect(seenRecord()).toMatchObject({ kind: "planning" });
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test(
    "an abort of a CLI that ignores SIGTERM kills its grandchild in its own group before the record goes",
    { timeout: 30_000 },
    async () => {
      // The ignored TERM is inherited, so only the SIGKILL after the 10 s grace stops anything.
      const claudePath = writeStandIn({
        auth: { stdout: LOGGED_IN },
        run: {
          body: [
            "trap '' TERM",
            `/bin/sh -c 'perl -MPOSIX -e "POSIX::setsid(); exec q(sleep), q(600)" & echo $! > "$0/grandchild"; wait' "$dir" &`,
            'echo $$ > "$dir/pid"',
            "sleep 600 & wait $!",
          ].join("\n"),
        },
      });
      const controller = new AbortController();
      const pending = claudeCodeChartMap(config(claudePath, { sessionsDir }))(chartRequest(), {
        ...SESSION,
        signal: controller.signal,
      });
      await untilFile("pid");
      await untilFile("grandchild");
      const grandchild = Number(readFileSync(join(dir, "grandchild"), "utf8").trim());
      try {
        expect(grandchild).toBeGreaterThan(0);
        controller.abort();
        const result = await pending;

        expect(result.ok ? null : result.error.code).toBe("agent_cancelled");
        expect(gone(grandchild)).toBe(true);
        expect(gone(-grandchild)).toBe(true);
        expect(readdirSync(sessionsDir)).toEqual([]);
      } finally {
        if (!gone(grandchild)) process.kill(grandchild, "SIGKILL");
      }
    },
  );

  test("the record is gone after a timeout", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { body: RECORDING_SLEEPER },
    });

    const result = await claudeCodeChartMap(config(claudePath, { sessionsDir, timeoutSeconds: 1 }))(
      chartRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_timed_out");
    expect(seenRecord()).toMatchObject({ kind: "planning" });
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test("a project folder gone before the spawn is agent_cli_missing, with nothing left", async () => {
    const claudePath = writeStandIn({
      auth: { stdout: LOGGED_IN },
      run: { stdout: successResult(PROPOSAL_OUTPUT), exitCode: 0 },
    });
    rmSync(projectFolder, { recursive: true });

    const result = await claudeCodeChartMap(config(claudePath, { sessionsDir }))(
      chartRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_cli_missing");
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  test("no record is written when the binary cannot be spawned", async () => {
    const result = await claudeCodeChartMap(config(join(dir, "missing-claude"), { sessionsDir }))(
      chartRequest(),
      SESSION,
    );

    expect(result.ok ? null : result.error.code).toBe("agent_cli_missing");
    expect(readdirSync(sessionsDir)).toEqual([]);
  });
});
