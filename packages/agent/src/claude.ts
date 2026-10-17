import { execFile, spawn } from "node:child_process";
import type { ExecException } from "node:child_process";
import { appendFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CancelledError,
  type PlanningCallSession,
  type PlanningRunConfig,
  type PlanningRunUsage,
  err,
  ok,
  type PlanningAgentError,
  type Result,
} from "@zenorm/contracts";
import { z } from "zod";

import { descendantsOf, processTable, serverIdentity } from "./process-table.ts";

/** The prompt a resumed planning call sends in place of its own (a retry after `error_max_turns`). */
export const RESUME_PROMPT = "You ran out of turns; finish and return the structured output.";

/**
 * A structured output the planning agent answers through: the Zod schema that parses it and its
 * draft-07 JSON Schema, the CLI's `--json-schema`. Built once per schema at module load.
 */
export interface StructuredOutput<S extends z.ZodType> {
  readonly schema: S;
  readonly jsonSchema: string;
}

/**
 * Pairs `schema` with its draft-07 JSON Schema string; refinements are not part of the JSON Schema.
 * The JSON Schema is of the schema's input, so a schema may parse a flat shape the model writes and
 * transform it into the port's output type.
 */
export function structuredOutput<S extends z.ZodType>(schema: S): StructuredOutput<S> {
  return {
    schema,
    jsonSchema: JSON.stringify(z.toJSONSchema(schema, { target: "draft-07", io: "input" })),
  };
}

/** How much of the CLI's stderr an error message carries. */
const STDERR_TAIL_CHARS = 2000;

/**
 * After the CLI exits, how long to wait for its stdout to reach end-of-file before parsing what has
 * arrived. The run settles on `exit`, not `close`, because a grandchild could hold the pipes open.
 */
const STDOUT_DRAIN_MS = 1000;

/** How long an aborted CLI has after SIGTERM before it gets SIGKILL, the same grace a check has. */
const ABORT_KILL_GRACE_MS = 10_000;

/** How long, after the SIGKILL, a stopped session's processes have to be gone before its record goes. */
const TREE_GONE_WAIT_MS = 5000;
const TREE_GONE_POLL_MS = 25;

/** The tools a planning call may use: the ones it is given and allowed, and the ones it is denied. */
export interface PlanningTools {
  readonly allowed: string;
  readonly disallowed: string;
}

/** Every planning call but research: read the repository, nothing else (L115 for Task runs). */
export const READ_ONLY_TOOLS: PlanningTools = {
  allowed: "Read,Grep,Glob",
  disallowed: "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
};

/** A research call (spec D2): read the repository and the web, change nothing. */
export const RESEARCH_TOOLS: PlanningTools = {
  allowed: "Read,Grep,Glob,WebFetch,WebSearch",
  disallowed: "Bash,Edit,Write,NotebookEdit",
};

const AuthStatus = z.looseObject({ loggedIn: z.boolean() });

/** `claude auth status --json` with the sign-in method, which a signed-in CLI always names. */
const AuthStatusWithMethod = z.union([
  z.looseObject({ loggedIn: z.literal(true), authMethod: z.string().min(1) }),
  z.looseObject({ loggedIn: z.literal(false) }),
]);

const RunResult = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  structured_output: z.unknown(),
});

const RunSubtype = z.looseObject({ subtype: z.string() });

/** A `result` object's own type, the test of whether the CLI printed one at all. */
const ResultType = z.looseObject({ type: z.literal("result") });

/** The usage fields of a `--output-format json` `result` object, as the CLI names them. */
const ResultUsage = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  session_id: z.string(),
  num_turns: z.number(),
  duration_ms: z.number(),
  total_cost_usd: z.number(),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_read_input_tokens: z.number(),
  }),
});

/**
 * The usage a run's `result` object reports: `none` when stdout is not one JSON `result` object
 * (the CLI died before printing one), `invalid` when it is one without the usage fields.
 */
export function readUsage(
  run: ExitedRun,
): { kind: "usage"; usage: PlanningRunUsage } | { kind: "none" } | { kind: "invalid" } {
  const json = parseJson(run.stdout);
  if (!json.ok || !ResultType.safeParse(json.value).success) return { kind: "none" };
  const result = ResultUsage.safeParse(json.value);
  if (!result.success) return { kind: "invalid" };
  const { data } = result;
  return {
    kind: "usage",
    usage: {
      sessionId: data.session_id,
      resultSubtype: data.subtype,
      numTurns: data.num_turns,
      durationMs: data.duration_ms,
      totalCostUsd: data.total_cost_usd,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      cacheCreationInputTokens: data.usage.cache_creation_input_tokens,
      cacheReadInputTokens: data.usage.cache_read_input_tokens,
    },
  };
}

/** Claude Code's fast mode setting, which `agent.fastMode` and `delivery.fastMode` turn on. */
export const FAST_MODE_SETTINGS = { fastMode: true } as const;

/** `--settings` turning fast mode on when `fastMode` is set, else nothing. */
export function fastModeArgs(fastMode: boolean | undefined): string[] {
  return fastMode === true ? ["--settings", JSON.stringify(FAST_MODE_SETTINGS)] : [];
}

/**
 * The argv of the headless run (slice 2 spec D4.2). The prompt comes straight after `-p`: the tool
 * flags are variadic.
 */
function runArgs(
  config: PlanningRunConfig,
  prompt: string,
  jsonSchema: string,
  tools: PlanningTools,
  resumeSessionId: string | null,
): string[] {
  // A resumed run continues its session with RESUME_PROMPT, not the request's prompt.
  const opening =
    resumeSessionId === null ? ["-p", prompt] : ["-p", RESUME_PROMPT, "--resume", resumeSessionId];
  return [
    ...opening,
    "--output-format",
    "json",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--max-turns",
    String(config.maxTurns),
    ...fastModeArgs(config.fastMode),
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.allowed,
    "--allowedTools",
    tools.allowed,
    "--disallowedTools",
    tools.disallowed,
    "--json-schema",
    jsonSchema,
  ];
}

/** Every way one CLI call can fail before its output is interpreted. */
export type SessionError = PlanningAgentError | CancelledError;

/** Which `claude` process a session record is for (spec D3). */
export type SessionKind = "auth" | "planning" | "orchestrator" | "reviewer";

/**
 * The CLI binary, the call's one deadline (L63), who the call is for, as error messages name it,
 * and how its processes are spawned and recorded (S9-6, spec D3 and D4).
 */
export interface CliCall {
  readonly claudePath: string;
  readonly timeoutSeconds: number;
  /** "The planning agent", "The delivery orchestrator", ... */
  readonly who: string;
  /** Each process's session record is `<sessionsDir>/<pid>.json` while it runs (spec D3). */
  readonly sessionsDir: string;
  /** The run's kind; its auth step is always `"auth"`. */
  readonly kind: Exclude<SessionKind, "auth">;
}

/** How one process is spawned: the call's binary and records, with that process's kind. */
interface SpawnSpec {
  readonly claudePath: string;
  readonly sessionsDir: string;
  readonly kind: SessionKind;
}

/** What a call adds to the plain spawn: every field is stated, none is defaulted. */
export interface RunOptions {
  /** Merged over `process.env`; null runs the CLI with `process.env` as it is. */
  readonly env: Readonly<Record<string, string>> | null;
  /** Aborting it sends SIGTERM to the CLI; the outcome is then `cancelled` whatever the exit. */
  readonly signal: AbortSignal | null;
  /** stdout is appended to this file as it arrives, besides being kept for parsing. */
  readonly stdoutFile: string | null;
  /** Called with each stdout chunk as it arrives; null when the caller reads stdout only at the end. */
  readonly onStdout: ((chunk: string) => void) | null;
  /**
   * Spawns the CLI in its own process group and signals the whole group (L197 item 12, S9-3): a
   * session's subprocesses then stop with it, and once the CLI exits after an abort its leftovers
   * get SIGKILL. A terminal's Ctrl+C no longer reaches the group; the shutdown aborts it instead.
   */
  readonly processGroup: boolean;
}

/** A planning call's spawn: in its own process group (S9-3), stopped by the runner's `signal` (D2). */
function planningOptions(signal: AbortSignal): RunOptions {
  return { env: null, signal, stdoutFile: null, onStdout: null, processGroup: true };
}

function planningCall(config: PlanningRunConfig): CliCall {
  return {
    claudePath: config.claudePath,
    timeoutSeconds: config.timeoutSeconds,
    who: "The planning agent",
    sessionsDir: config.sessionsDir,
    kind: "planning",
  };
}

/**
 * One planning agent call: the auth check, then the headless run of `prompt` in `projectFolder`,
 * answering through `output` with `tools`. One deadline bounds the whole call: both steps share
 * `timeoutSeconds` (L63). Every expected failure is one of the five `agent_*` codes. The run's
 * usage reaches `session.onUsage` whenever the CLI printed a result, failed or not; a session to
 * resume replaces `prompt` with `RESUME_PROMPT`.
 */
export async function runStructured<S extends z.ZodType>(
  config: PlanningRunConfig,
  session: PlanningCallSession,
  projectFolder: string,
  prompt: string,
  output: StructuredOutput<S>,
  tools: PlanningTools,
): Promise<Result<z.output<S>, PlanningAgentError | CancelledError>> {
  return runStructuredWith(config, session, projectFolder, prompt, output, tools, []);
}

/**
 * `runStructured` with `extraArgs` after the run's own argv: a skill-following call adds its
 * `--add-dir` and `--append-system-prompt-file` there (L51, spec D4).
 */
export async function runStructuredWith<S extends z.ZodType>(
  config: PlanningRunConfig,
  session: PlanningCallSession,
  projectFolder: string,
  prompt: string,
  output: StructuredOutput<S>,
  tools: PlanningTools,
  extraArgs: readonly string[],
): Promise<Result<z.output<S>, PlanningAgentError | CancelledError>> {
  const call = planningCall(config);
  const run = await runSession(
    call,
    [...runArgs(config, prompt, output.jsonSchema, tools, session.resumeSessionId), ...extraArgs],
    projectFolder,
    planningOptions(session.signal),
  );
  // An aborted call (`agent_cancelled`) reports no usage: the runner's stop records nothing (D2).
  if (!run.ok) return err(run.error);
  const usage = readUsage(run.value);
  if (usage.kind === "usage") session.onUsage(usage.usage);
  const interpreted = interpretExit(call, run.value, output.schema);
  // A successful run must report its usage; a failed one keeps its own failure.
  if (interpreted.ok && usage.kind !== "usage") {
    return err(
      outputInvalid(
        "The Claude Code CLI's result lacks its usage (`session_id`, `num_turns`, `duration_ms`, `total_cost_usd` or `usage`).",
        run.value.stderrTail,
      ),
    );
  }
  return interpreted;
}

/** A CLI run that exited by itself (not by the deadline or the abort signal). */
export type ExitedRun = Extract<RunOutcome, { kind: "exited" }>;

/**
 * The auth step, then the run of `args` in `cwd`, under one deadline of `call.timeoutSeconds`
 * (L63). Returns the exited run for the caller to interpret, or the spawn, auth, deadline or
 * cancel failure.
 */
/** The spawn fields every process of `call` shares. */
function callSpawn(call: CliCall): Pick<SpawnSpec, "claudePath" | "sessionsDir"> {
  return { claudePath: call.claudePath, sessionsDir: call.sessionsDir };
}

export async function runSession(
  call: CliCall,
  args: string[],
  cwd: string,
  options: RunOptions,
): Promise<Result<ExitedRun, SessionError>> {
  const deadline = Date.now() + call.timeoutSeconds * 1000;
  const auth = await checkAuth(call, cwd, deadline - Date.now(), {
    env: options.env,
    signal: options.signal,
    stdoutFile: null,
    onStdout: null,
    processGroup: options.processGroup,
  });
  if (!auth.ok) return auth;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return err(timedOut(call, ""));
  const run = await runProcess(
    { ...callSpawn(call), kind: call.kind },
    args,
    cwd,
    remainingMs,
    options,
  );
  switch (run.kind) {
    case "spawn_failed":
      return err(cliMissing(call, run.cause));
    case "timed_out":
      return err(timedOut(call, run.stderrTail));
    case "cancelled":
      return err(cancelled(call, run.stderrTail));
    case "kill_failed":
      return err(killFailed(run.errno, run.stderrTail));
    case "exited":
      return ok(run);
  }
}

function cliMissing(call: CliCall, cause: string): PlanningAgentError {
  return {
    code: "agent_cli_missing",
    message: `Cannot run the Claude Code CLI at ${call.claudePath}: ${cause}`,
    data: { claudePath: call.claudePath },
  };
}

function timedOut(call: CliCall, stderrTail: string): PlanningAgentError {
  return {
    code: "agent_timed_out",
    message: withStderr(
      `${call.who} did not finish within ${String(call.timeoutSeconds)} seconds and was stopped.`,
      stderrTail,
    ),
    data: { timeoutSeconds: call.timeoutSeconds },
  };
}

function cancelled(call: CliCall, stderrTail: string): CancelledError {
  return {
    code: "agent_cancelled",
    message: withStderr(`${call.who} was cancelled and stopped.`, stderrTail),
    data: {},
  };
}

export function outputInvalid(message: string, stderrTail: string): PlanningAgentError {
  return { code: "agent_output_invalid", message: withStderr(message, stderrTail), data: {} };
}

export function withStderr(message: string, stderrTail: string): string {
  return stderrTail === ""
    ? message
    : `${message}\nstderr (last ${String(STDERR_TAIL_CHARS)} chars):\n${stderrTail}`;
}

/** The spawn failure codes that mean the configured binary cannot be run. */
function spawnFailureCode(error: unknown): "ENOENT" | "EACCES" | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  if (error.code === "ENOENT" || error.code === "EACCES") return error.code;
  return null;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Step 1 (spec D4.1): `claude auth status --json`, with a SIGTERM after `timeoutMs` (the time left
 * before the call's deadline); stdout is parsed whatever the exit code.
 */
async function checkAuth(
  call: CliCall,
  cwd: string,
  timeoutMs: number,
  options: RunOptions,
): Promise<Result<null, SessionError>> {
  const outcome = await runProcess(
    { ...callSpawn(call), kind: "auth" },
    ["auth", "status", "--json"],
    cwd,
    timeoutMs,
    options,
  );
  if (outcome.kind === "spawn_failed") return err(cliMissing(call, outcome.cause));
  if (outcome.kind === "timed_out") return err(timedOut(call, outcome.stderrTail));
  if (outcome.kind === "cancelled") return err(cancelled(call, outcome.stderrTail));
  if (outcome.kind === "kill_failed") return err(killFailed(outcome.errno, outcome.stderrTail));
  const { stderrTail } = outcome;

  const json = parseJson(outcome.stdout);
  if (!json.ok)
    return err(outputInvalid("`claude auth status --json` did not print JSON.", stderrTail));
  const status = AuthStatus.safeParse(json.value);
  if (!status.success) {
    return err(
      outputInvalid(
        "`claude auth status --json` printed JSON without a boolean `loggedIn`.",
        stderrTail,
      ),
    );
  }
  if (!status.data.loggedIn) {
    return err({
      code: "agent_not_logged_in",
      message: withStderr(
        "The Claude Code CLI is not logged in. Run `claude auth login`.",
        stderrTail,
      ),
      data: {},
    });
  }
  return ok(null);
}

/** Whether Claude Code is signed in, and by which method (`claude.ai`, `third_party`, ...). */
export type AuthStatusRead =
  { readonly loggedIn: true; readonly authMethod: string } | { readonly loggedIn: false };

/** The environment a status read or login runs `claudePath` with, used as it is. */
export type ClaudeEnv = Readonly<Record<string, string | undefined>>;

/**
 * `claude auth status --json`, read for its sign-in method (`zenorm init`, `zenorm doctor`, and
 * the startup check that refuses a signed-out CLI), outside any planning or delivery call: no session record, a SIGTERM after `timeoutMs`. A non-zero
 * exit reads as signed out; stdout must still be the status JSON. The per-call check (`checkAuth`)
 * stays its own.
 */
export function readAuthStatus(
  claudePath: string,
  env: ClaudeEnv,
  timeoutMs: number,
): Promise<Result<AuthStatusRead, PlanningAgentError>> {
  return new Promise((resolve) => {
    execFile(
      claudePath,
      ["auth", "status", "--json"],
      { env, timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve(authStatusOf(claudePath, timeoutMs, error, stdout, stderr));
      },
    );
  });
}

/** Reads a finished `claude auth status --json` (`readAuthStatus`). */
function authStatusOf(
  claudePath: string,
  timeoutMs: number,
  error: ExecException | null,
  stdout: string,
  stderr: string,
): Result<AuthStatusRead, PlanningAgentError> {
  const stderrTail = stderr.slice(-STDERR_TAIL_CHARS);
  const failure = error === null ? null : spawnFailureCode(error);
  if (failure !== null) return err(statusCliMissing(claudePath, failure));
  if (error?.killed === true) {
    return err({
      code: "agent_timed_out",
      message: withStderr(
        `\`claude auth status --json\` did not finish within ${String(timeoutMs)} ms and was stopped.`,
        stderrTail,
      ),
      data: { timeoutSeconds: Math.ceil(timeoutMs / 1000) },
    });
  }
  const json = parseJson(stdout);
  if (!json.ok)
    return err(outputInvalid("`claude auth status --json` did not print JSON.", stderrTail));
  const status = AuthStatusWithMethod.safeParse(json.value);
  if (!status.success) {
    return err(
      outputInvalid(
        "`claude auth status --json` printed JSON without a boolean `loggedIn`, or signed in without an `authMethod`.",
        stderrTail,
      ),
    );
  }
  if (error !== null || !status.data.loggedIn) return ok({ loggedIn: false });
  return ok({ loggedIn: true, authMethod: status.data.authMethod });
}

/** How the person signs Claude Code in: their Claude subscription or an Anthropic Console account. */
export type LoginMethod = "subscription" | "console";

/** `claude auth login`'s arguments for each sign-in method. */
export const LOGIN_ARGS: Readonly<Record<LoginMethod, readonly string[]>> = {
  subscription: ["auth", "login", "--claudeai"],
  console: ["auth", "login", "--console"],
};

/**
 * Runs Claude Code's own sign-in (`claude auth login`) on the person's terminal, with every stdio
 * inherited, and resolves once it exits, whatever its exit code: the caller reads the status again.
 * ZeNorm never sees a key.
 */
export function runAuthLogin(
  claudePath: string,
  method: LoginMethod,
  env: ClaudeEnv,
): Promise<Result<null, PlanningAgentError>> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudePath, [...LOGIN_ARGS[method]], { env, stdio: "inherit" });
    child.on("error", (error) => {
      const failure = spawnFailureCode(error);
      if (failure === null) {
        reject(error);
        return;
      }
      resolve(err(statusCliMissing(claudePath, failure)));
    });
    child.on("exit", () => {
      resolve(ok(null));
    });
  });
}

function statusCliMissing(claudePath: string, cause: string): PlanningAgentError {
  return {
    code: "agent_cli_missing",
    message: `Cannot run the Claude Code CLI at ${claudePath}: ${cause}`,
    data: { claudePath },
  };
}

type RunOutcome =
  | { kind: "spawn_failed"; cause: "ENOENT" | "EACCES" }
  | { kind: "timed_out"; stderrTail: string }
  | { kind: "cancelled"; stderrTail: string }
  /** Signalling the CLI's process group failed with an errno other than ESRCH or EPERM. */
  | { kind: "kill_failed"; errno: string; stderrTail: string }
  | {
      kind: "exited";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderrTail: string;
    };

/** The record `runProcess` keeps at `<sessionsDir>/<pid>.json` while a process runs (spec D3). */
export interface SessionRecord {
  readonly pid: number;
  /** What `ps -o command=` shows first for the pid: `claudePath`. */
  readonly command: string;
  readonly startedAt: string;
  readonly kind: SessionKind;
  /** The spawning server's pid, so a later sweep can tell whether that server is gone (C6). */
  readonly serverPid: number;
  /** The spawning server's `ps` start time (ISO), to tell it from a process reusing its pid. */
  readonly serverStartedAt: string;
}

/** What a stopped session left behind, as `ps` last showed it (CR-2). */
interface SessionTree {
  /** Every descendant of the session's pid seen so far. */
  readonly pids: Set<number>;
  /** Each group a descendant leads (the Bash tool's own groups, spike surprise 8). */
  readonly groups: Set<number>;
}

/**
 * Adds to `tree` every descendant of `root`, and of each process already in it, from a fresh `ps`,
 * with each group one of them leads. A descendant's pid is found by walking parents, so the walk
 * runs before the session is signalled: once it exits, its children belong to pid 1.
 */
async function observeTree(root: number, tree: SessionTree): Promise<void> {
  const table = await processTable();
  for (const start of [root, ...tree.pids]) {
    for (const pid of descendantsOf(start, table)) tree.pids.add(pid);
  }
  for (const row of table) {
    if (tree.pids.has(row.pid) && tree.pids.has(row.pgid)) tree.groups.add(row.pgid);
  }
}

/** Signals `target`: null when sent or the target is gone (ESRCH) or exiting (EPERM), else the errno. */
function signalTarget(target: number, killSignal: NodeJS.Signals): string | null {
  try {
    process.kill(target, killSignal);
    return null;
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && typeof error.code === "string")) {
      return String(error);
    }
    if (error.code === "ESRCH" || error.code === "EPERM") return null;
    return error.code;
  }
}

/** Whether a signal 0 still reaches `target`; EPERM is a group macOS is reaping (see `kill`). */
function stillThere(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EPERM")
    ) {
      return false;
    }
    throw error;
  }
}

/** Waits until none of `targets` is reachable, or `TREE_GONE_WAIT_MS` has passed. */
async function untilGone(targets: readonly number[]): Promise<void> {
  const deadline = Date.now() + TREE_GONE_WAIT_MS;
  while (targets.some(stillThere) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TREE_GONE_POLL_MS));
  }
}

/**
 * Runs the CLI with `args` in `cwd` and sends it a SIGTERM after `timeoutMs`, or when
 * `options.signal` aborts; an aborted CLI that has not exited 10 s after the SIGTERM gets SIGKILL.
 * Used for every step: the auth check (D4.1) and each headless run. While the process runs, its
 * session record is `<sessionsDir>/<pid>.json`; it is removed once the process has exited and, after
 * an abort or a timeout, its group, its descendants and the groups they lead have had SIGKILL and are
 * gone (or the wait for them is over; CR-2).
 */
function runProcess(
  spec: SpawnSpec,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: RunOptions,
): Promise<RunOutcome> {
  const { signal, stdoutFile, onStdout, processGroup } = options;
  if (signal?.aborted === true) return Promise.resolve({ kind: "cancelled", stderrTail: "" });
  // A missing records folder is a programmer error: startup creates it (spec D3).
  if (!statSync(spec.sessionsDir).isDirectory()) {
    throw new Error(`The sessions folder ${spec.sessionsDir} is not a directory`);
  }
  return new Promise<RunOutcome>((resolve, reject) => {
    const child = spawn(spec.claudePath, args, {
      cwd,
      env: options.env === null ? process.env : { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: processGroup,
    });
    const { stdout, stderr } = child;
    const recordFile =
      child.pid === undefined ? null : join(spec.sessionsDir, `${String(child.pid)}.json`);
    /** Removes the session record once the process is gone. */
    const cleanUp = (): void => {
      if (recordFile !== null) rmSync(recordFile, { force: true });
    };
    if (recordFile !== null && child.pid !== undefined) {
      const record: SessionRecord = {
        pid: child.pid,
        command: spec.claudePath,
        startedAt: new Date().toISOString(),
        kind: spec.kind,
        ...serverIdentity(),
      };
      writeFileSync(recordFile, JSON.stringify(record));
    }
    /**
     * Signals the CLI, or its whole process group. A group that is gone (ESRCH) or exiting (EPERM,
     * which macOS returns while the group's members are being reaped) is no error. Any other errno
     * is returned, never thrown: every caller is a timer or event handler, and the run must settle.
     */
    const kill = (killSignal: NodeJS.Signals): string | null => {
      if (!processGroup || child.pid === undefined) {
        child.kill(killSignal);
        return null;
      }
      return signalTarget(-child.pid, killSignal);
    };
    /** What the CLI started, seen before each signal of a stop (CR-2). */
    const tree: SessionTree = { pids: new Set(), groups: new Set() };
    /** Every pid and negated group a stop sends SIGKILL to besides the CLI's own. */
    const treeTargets = (): number[] => [...tree.pids, ...[...tree.groups].map((group) => -group)];

    let out = "";
    let errTail = "";
    let stdoutEnded = false;
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let settled = false;
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      out += chunk;
      if (stdoutFile !== null) appendFileSync(stdoutFile, chunk);
      if (onStdout !== null) onStdout(chunk);
    });
    stdout.on("end", () => {
      stdoutEnded = true;
    });
    stderr.on("data", (chunk: string) => {
      errTail = (errTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let killTimer: NodeJS.Timeout | undefined;
    const settle = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    /** A programmer error while stopping the CLI (an unreadable `ps`, say) rejects the run. */
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    /** Signals the CLI; an unexpected errno settles the run as `kill_failed`. */
    const signalOrSettle = (killSignal: NodeJS.Signals): void => {
      const errno = kill(killSignal);
      if (errno !== null) settle({ kind: "kill_failed", errno, stderrTail: errTail });
    };
    /** SIGKILL to the CLI (its group) and to every process and group of its tree (CR-2). */
    const killTree = (): void => {
      const errnos = [kill("SIGKILL"), ...treeTargets().map((t) => signalTarget(t, "SIGKILL"))];
      const errno = errnos.find((found) => found !== null);
      if (errno !== undefined) {
        settle({ kind: "kill_failed", errno, stderrTail: errTail });
      }
    };
    /** Looks at the CLI's process tree, then runs `next` unless the CLI has exited meanwhile. */
    const observeThen = (next: () => void): void => {
      if (child.pid === undefined) {
        next();
        return;
      }
      observeTree(child.pid, tree).then(() => {
        if (!exited) next();
      }, fail);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      observeThen(() => {
        signalOrSettle("SIGTERM");
      });
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      observeThen(() => {
        signalOrSettle("SIGTERM");
        killTimer = setTimeout(() => {
          observeThen(killTree);
        }, ABORT_KILL_GRACE_MS);
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      cleanUp();
      const failure = spawnFailureCode(error);
      if (failure === null) {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        settled = true;
        reject(error);
        return;
      }
      settle({ kind: "spawn_failed", cause: failure });
    });

    child.on("exit", (exitCode, exitSignal) => {
      exited = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (aborted || timedOut) {
        const stopped: RunOutcome = aborted
          ? { kind: "cancelled", stderrTail: errTail }
          : { kind: "timed_out", stderrTail: errTail };
        // What the CLI left running after an abort or a timeout stops with it: its group, and every
        // descendant seen since the stop began with each group one leads (the Bash tool's, CR-2).
        // The record goes once they are gone, or once they have had SIGKILL and the wait is over.
        const pid = child.pid;
        const finish = async (): Promise<void> => {
          if (pid !== undefined) await observeTree(pid, tree);
          killTree();
          await untilGone([...(processGroup && pid !== undefined ? [-pid] : []), ...treeTargets()]);
          cleanUp();
          settle(stopped);
        };
        finish().catch(fail);
        return;
      }
      cleanUp();
      const finish = (): void => {
        settle({ kind: "exited", exitCode, signal: exitSignal, stdout: out, stderrTail: errTail });
      };
      if (stdoutEnded) {
        finish();
        return;
      }
      const drain = setTimeout(finish, STDOUT_DRAIN_MS);
      stdout.once("end", () => {
        clearTimeout(drain);
        finish();
      });
    });
  });
}

/** The `agent_run_failed` error for a run whose process group could not be signalled. */
function killFailed(errno: string, stderrTail: string): PlanningAgentError {
  return runFailed(`could not be signalled (${errno})`, null, null, stderrTail);
}

/** The `agent_run_failed` error for a run that exited non-zero or reported a failed result. */
export function runFailed(
  how: string,
  exitCode: number | null,
  subtype: string | null,
  stderrTail: string,
): PlanningAgentError {
  return {
    code: "agent_run_failed",
    message: withStderr(`The Claude Code CLI ${how}.`, stderrTail),
    data: { exitCode, subtype },
  };
}

/** The API status a session's error `result` carries when the CLI's login was revoked or expired. */
const API_UNAUTHORIZED = 401;

/** An error `result`: the CLI's own text, and the API status when an API call failed it. */
const ResultError = z.looseObject({
  is_error: z.literal(true),
  result: z.string(),
  api_error_status: z.number().nullable().optional(),
});

/**
 * The error for a session that exited non-zero or reported a failed `result`. An error `result`
 * with API status 401 means the CLI lost its login mid-session, `agent_not_logged_in`; any other
 * error `result` puts the CLI's own text in the `agent_run_failed` message.
 */
export function sessionFailed(
  how: string,
  run: ExitedRun,
  result: unknown,
  subtype: string | null,
): PlanningAgentError {
  const error = ResultError.safeParse(result);
  if (!error.success) return runFailed(how, run.exitCode, subtype, run.stderrTail);
  const text = error.data.result.replace(/\.$/, "");
  if (error.data.api_error_status === API_UNAUTHORIZED) {
    return {
      code: "agent_not_logged_in",
      message: withStderr(
        `The Claude Code CLI lost its login during the session (${text}). Run \`claude auth login\`.`,
        run.stderrTail,
      ),
      data: {},
    };
  }
  return runFailed(`${how}: ${text}`, run.exitCode, subtype, run.stderrTail);
}

/** How a non-zero exit reads in an error message. */
export function exitDescription(run: ExitedRun): string {
  return run.exitCode === null
    ? `was killed by ${String(run.signal)}`
    : `exited with code ${String(run.exitCode)}`;
}

/**
 * Interprets a `--output-format json` run (slice 2's rule): exit 0, one `result` object with
 * subtype `success` and `is_error` false, and a `structured_output` that parses as `schema`.
 */
export function interpretExit<S extends z.ZodType>(
  call: CliCall,
  run: ExitedRun,
  schema: S,
): Result<z.output<S>, PlanningAgentError> {
  const json = parseJson(run.stdout);

  if (run.exitCode !== 0) {
    const parsed = json.ok ? RunSubtype.safeParse(json.value) : null;
    const subtype = parsed?.success === true ? parsed.data.subtype : null;
    return err(
      sessionFailed(
        `${exitDescription(run)} (result subtype: ${String(subtype)})`,
        run,
        json.ok ? json.value : null,
        subtype,
      ),
    );
  }

  if (!json.ok)
    return err(outputInvalid("The Claude Code CLI did not print one JSON object.", run.stderrTail));
  const result = RunResult.safeParse(json.value);
  if (!result.success) {
    return err(
      outputInvalid(
        "The Claude Code CLI printed JSON that is not a `result` object.",
        run.stderrTail,
      ),
    );
  }
  if (result.data.is_error || result.data.subtype !== "success") {
    return err(
      sessionFailed(
        `reported a failed run (subtype ${result.data.subtype}, is_error ${String(result.data.is_error)})`,
        run,
        result.data,
        result.data.subtype,
      ),
    );
  }
  const parsed = schema.safeParse(result.data.structured_output);
  if (!parsed.success) {
    return err(
      outputInvalid(
        `${call.who}'s structured output does not match its schema: ${z.prettifyError(parsed.error)}`,
        run.stderrTail,
      ),
    );
  }
  return ok(parsed.data);
}
