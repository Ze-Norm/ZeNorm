import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The command Playwright's `webServer` runs; only a listener running exactly this is a stale e2e server. */
const E2E_SERVER_COMMAND = "node src/main.ts";
/** How long a stale server has to free the port after SIGTERM, then after SIGKILL (spec D7). */
const TERM_WAIT_MS = 10_000;
const KILL_WAIT_MS = 5_000;
const POLL_MS = 100;
/**
 * How long the guard waits for another run's live server to free the port before failing: longer
 * than a whole e2e suite, so two checks on one machine (a delivery run's Verify and a person's own
 * `pnpm check`) run one after the other instead of the second failing.
 */
export const LIVE_RUN_WAIT_MS = 20 * 60 * 1000;
/** The file in each e2e root naming the Playwright runner that made it (S9-13). */
export const RUNNER_RECORD_FILE = "runner.json";
/** A root with no runner record is taken as ended only once its `config.json` is this old. */
export const UNRECORDED_ROOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Why the e2e port cannot be taken: a listener the check may not stop, or one that would not stop. */
export type StaleServerCode = "e2e_port_taken" | "e2e_stale_server_survived";

/** Thrown during config evaluation, which fails the Playwright run before its web server starts. */
export class StaleServerError extends Error {
  readonly code: StaleServerCode;
  readonly pid: number;
  readonly command: string;
  /** The live Playwright runner the listener belongs to, when that is why it is not stopped. */
  readonly runnerPid: number | null;

  constructor(
    code: StaleServerCode,
    pid: number,
    command: string,
    reason: string,
    runnerPid: number | null,
  ) {
    super(`${code}: port listener ${String(pid)} (${command}): ${reason}`);
    this.name = "StaleServerError";
    this.code = code;
    this.pid = pid;
    this.command = command;
    this.runnerPid = runnerPid;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The PIDs listening on TCP `port`; `lsof` exits 1 with no output when there are none. */
function listeners(port: number): number[] {
  let output: string;
  try {
    output = execFileSync("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (isExit(error, 1) && error.stdout === "") {
      return [];
    }
    throw error;
  }
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map(Number);
}

interface ExitError {
  status: number | null;
  stdout: string;
}

function isExit(error: unknown, status: number): error is ExitError {
  return (
    error instanceof Error &&
    "status" in error &&
    error.status === status &&
    "stdout" in error &&
    typeof error.stdout === "string"
  );
}

/** `ps`'s output for `pid`, or null once the process is gone (`ps` exits 1). */
function ps(args: readonly string[], pid: number): string | null {
  try {
    return execFileSync("ps", [...args, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (isExit(error, 1)) {
      return null;
    }
    throw error;
  }
}

/**
 * Waits, synchronously, until `pid` no longer listens on `port`; true if it stopped in time. The
 * port, not the process, is what the web server needs (a killed child of the caller stays a
 * zombie until reaped, which this blocking wait never lets happen). The wait is by the clock, not
 * by poll count, since each `lsof` can itself take a while on a loaded machine.
 */
function waitFreed(pid: number, port: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!listeners(port).includes(pid)) {
      return true;
    }
    sleepSync(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return !listeners(port).includes(pid);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Why the listener is not a stale e2e server, or null when it is: its command is exactly
 * `node src/main.ts` and its `ZENORM_CONFIG`, realpathed, is `<realpath(tmpdir())>/zenorm-e2e-<suffix>/config.json`
 * (`ps` shows `/var/folders/…`, the realpath `/private/var/…`).
 */
type Verdict = { stale: true } | { stale: false; reason: string; runnerPid: number | null };

function notStale(reason: string): Verdict {
  return { stale: false, reason, runnerPid: null };
}

/** A Playwright runner's pid and its `ps -o lstart=` (compared as text, never parsed). */
interface RunnerRecord {
  pid: number;
  lstart: string;
}

/** `pid`'s start time as `ps -o lstart=` prints it, or null once the process is gone. */
function startTime(pid: number): string | null {
  const output = ps(["-o", "lstart="], pid);
  return output === null ? null : output.trim();
}

/**
 * Records, synchronously, the calling Playwright runner in `<root>/runner.json` (S9-13), so a later
 * run's guard stops this root's server only once this runner is gone.
 */
export function writeRunnerRecord(root: string): void {
  const lstart = startTime(process.pid);
  if (lstart === null) {
    throw new Error(`ps shows no start time for the runner itself (${String(process.pid)})`);
  }
  const record: RunnerRecord = { pid: process.pid, lstart };
  writeFileSync(join(root, RUNNER_RECORD_FILE), JSON.stringify(record));
}

function parseRunnerRecord(text: string): RunnerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    Number.isInteger(value.pid) &&
    typeof value.pid === "number" &&
    value.pid > 0 &&
    "lstart" in value &&
    typeof value.lstart === "string" &&
    value.lstart !== ""
  ) {
    return { pid: value.pid, lstart: value.lstart };
  }
  return null;
}

/**
 * Whether the e2e run owning `config` (a realpathed `<root>/config.json`) has ended: its root's
 * runner record names a pid that is gone, or alive with another start time (pid reuse). A root
 * with no record has ended only once its `config.json` (written once, by `createRoot`) is older
 * than `UNRECORDED_ROOT_MAX_AGE_MS`. A malformed record is never taken as ended.
 */
function runVerdict(config: string): Verdict {
  const recordPath = join(dirname(config), RUNNER_RECORD_FILE);
  if (!existsSync(recordPath)) {
    const age = Date.now() - statSync(config).mtimeMs;
    if (age > UNRECORDED_ROOT_MAX_AGE_MS) {
      return { stale: true };
    }
    return notStale(
      `its root has no ${RUNNER_RECORD_FILE} and is younger than ${String(UNRECORDED_ROOT_MAX_AGE_MS / 60_000)} min`,
    );
  }
  const record = parseRunnerRecord(readFileSync(recordPath, "utf8"));
  if (record === null) {
    return notStale(`its root's ${RUNNER_RECORD_FILE} is malformed`);
  }
  const lstart = startTime(record.pid);
  if (lstart === null || lstart !== record.lstart) {
    return { stale: true };
  }
  return {
    stale: false,
    reason: `its Playwright runner ${String(record.pid)} is still running`,
    runnerPid: record.pid,
  };
}

/**
 * Whether the listener is a stale e2e server: its command is exactly `node src/main.ts`, its
 * `ZENORM_CONFIG`, realpathed, is `<realpath(tmpdir())>/zenorm-e2e-<suffix>/config.json`
 * (`ps` shows `/var/folders/…`, the realpath `/private/var/…`), and that run has ended.
 */
function verdict(pid: number, command: string): Verdict {
  if (command !== E2E_SERVER_COMMAND) {
    return notStale(`its command is not \`${E2E_SERVER_COMMAND}\``);
  }
  const environment = ps(["eww"], pid);
  if (environment === null) {
    return notStale("it exited while its environment was read");
  }
  const config = /(?:^|\s)ZENORM_CONFIG=(\S+)/.exec(environment)?.[1];
  if (config === undefined) {
    return notStale("it has no ZENORM_CONFIG");
  }
  let resolved: string;
  try {
    resolved = realpathSync(config);
  } catch (error) {
    return notStale(`its ZENORM_CONFIG ${config} cannot be resolved (${String(error)})`);
  }
  const pattern = new RegExp(
    `^${escapeRegExp(realpathSync(tmpdir()))}/zenorm-e2e-[^/]+/config\\.json$`,
  );
  if (!pattern.test(resolved)) {
    return notStale(`its ZENORM_CONFIG ${resolved} is not an e2e run's config`);
  }
  return runVerdict(resolved);
}

/**
 * The e2e stale-server guard (S9-8, spec D7), run synchronously while the Playwright runner
 * evaluates its config, before it starts the web server. Every listener on `port` that is a stale
 * e2e server (see `verdict`) is stopped by PID: SIGTERM, up to 10 s for the port to free, then
 * SIGKILL. Another run's live server (S9-13) is waited for, up to `liveRunWaitMs`, to free the
 * port; past that it fails the run with the live runner's PID. Any other listener fails the run with
 * its PID and command. Never a pattern kill.
 */
export function stopStaleE2eServer(port: number, liveRunWaitMs: number): void {
  for (const pid of listeners(port)) {
    const output = ps(["-o", "command="], pid);
    if (output === null) {
      continue;
    }
    const command = output.trim();
    const result = verdict(pid, command);
    if (!result.stale) {
      if (result.runnerPid !== null && waitFreed(pid, port, liveRunWaitMs)) {
        continue;
      }
      throw new StaleServerError("e2e_port_taken", pid, command, result.reason, result.runnerPid);
    }
    process.kill(pid, "SIGTERM");
    if (waitFreed(pid, port, TERM_WAIT_MS)) {
      continue;
    }
    process.kill(pid, "SIGKILL");
    if (!waitFreed(pid, port, KILL_WAIT_MS)) {
      throw new StaleServerError(
        "e2e_stale_server_survived",
        pid,
        command,
        "it still listens after SIGKILL",
        null,
      );
    }
  }
}
