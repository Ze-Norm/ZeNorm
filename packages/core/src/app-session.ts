import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { err, ok } from "@zenorm/contracts";
import type { CodedError, Result } from "@zenorm/contracts";

import { CHECK_KILL_GRACE_MS, checkPassed, runCheck } from "./delivery.ts";

const execFileAsync = promisify(execFile);

/**
 * How long ZeNorm waits for a started app's URL to answer before capture fails
 * `capture_app_not_ready`. A fixed constant: no config key names it.
 */
export const APP_READY_TIMEOUT_MS = 120_000;

/** How often the app URL is asked while ZeNorm waits for it. */
const APP_READY_POLL_MS = 250;

/** How long one ask of the app URL may take before it counts as no answer. */
const URL_PROBE_TIMEOUT_MS = 2000;

/** How long a stopped app's group has after SIGTERM before it gets SIGKILL: a check's grace. */
export const APP_STOP_GRACE_MS = CHECK_KILL_GRACE_MS;

/** How long, after the SIGKILL, ZeNorm waits for the app's group to be gone. */
const APP_GONE_WAIT_MS = 5000;
const APP_GONE_POLL_MS = 25;

/** The run folder's folder the app's setup and start write their output to. */
const APP_LOG_DIR = "app";

/** Why the app's setup failed: a setup command did not pass. */
export type AppSetupError = CodedError<"capture_setup_failed">;

/** Why the app did not start: its URL already answered, or it never answered once started. */
export type AppStartError = CodedError<"capture_app_url_in_use" | "capture_app_not_ready">;

/** Where setup command `index` (from 0) writes its whole output: `<runDir>/app/setup-<n>.log`. */
export function appSetupLogPath(runDir: string, index: number): string {
  return join(runDir, APP_LOG_DIR, `setup-${String(index + 1)}.log`);
}

/** Where the started app writes its output: `<runDir>/app/app.log`. */
export function appLogPath(runDir: string): string {
  return join(runDir, APP_LOG_DIR, "app.log");
}

/**
 * Runs the run's pinned app setup commands in order in the run worktree, each split on whitespace
 * and run without a shell in its own process group under `timeoutMs` (the run's check bound), its
 * whole output in `appSetupLogPath`. The first that does not pass stops the setup:
 * `capture_setup_failed` naming it, with its output's tail. None starts once `signal` aborts.
 */
export async function runAppSetup(input: {
  readonly worktreePath: string;
  readonly runDir: string;
  readonly commands: readonly string[];
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<Result<null, AppSetupError>> {
  await mkdir(join(input.runDir, APP_LOG_DIR), { recursive: true });
  for (const [index, command] of input.commands.entries()) {
    if (input.signal.aborted) {
      return err({
        code: "capture_setup_failed",
        message: "The run was cancelled during the app's setup.",
      });
    }
    const result = await runCheck(command, {
      cwd: input.worktreePath,
      env: input.env,
      timeoutMs: input.timeoutMs,
      killGraceMs: CHECK_KILL_GRACE_MS,
      signal: input.signal,
      logPath: appSetupLogPath(input.runDir, index),
    });
    if (!checkPassed(result)) {
      const how = result.timedOut
        ? "timed out"
        : result.exitCode === null
          ? "was stopped"
          : `failed with exit ${String(result.exitCode)}`;
      return err({
        code: "capture_setup_failed",
        message: `The setup command \`${command}\` ${how}.\n${result.outputTail}`,
      });
    }
  }
  return ok(null);
}

/**
 * Whether anything answers HTTP at `url` now: any response, whatever its status, is an answer; a
 * refused or reset connection, or none within `URL_PROBE_TIMEOUT_MS`, is not.
 */
export async function urlAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(URL_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** This server, as a session record names it: its pid and `ps` start time, read once. */
let thisServer: { readonly serverPid: number; readonly serverStartedAt: string } | null = null;

function serverIdentity(): { readonly serverPid: number; readonly serverStartedAt: string } {
  if (thisServer === null) {
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const started = Date.parse(lstart);
    if (Number.isNaN(started)) {
      throw new Error(`Unexpected ps start time for process ${String(process.pid)}: ${lstart}`);
    }
    thisServer = { serverPid: process.pid, serverStartedAt: new Date(started).toISOString() };
  }
  return thisServer;
}

/** What `ps -o command=` shows for `pid`, or null once it is gone. */
async function psCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
    });
    const command = stdout.trim();
    return command === "" ? null : command;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === 1) {
      return null;
    }
    throw error;
  }
}

function errnoOf(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** Signals the group `pid` leads; one gone (ESRCH) or being reaped (EPERM on macOS) is fine. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    const code = errnoOf(error);
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

/** Whether a signal 0 still reaches the group `pid` leads. */
export function groupRuns(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    const code = errnoOf(error);
    if (code === "ESRCH" || code === "EPERM") {
      return false;
    }
    throw error;
  }
}

/** Waits until the group `pid` leads is gone or `ms` has passed; true when it is gone. */
async function untilGroupGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupRuns(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, APP_GONE_POLL_MS));
  }
  return true;
}

/** An app ZeNorm started for a capture, running in its own process group. */
export interface RunningApp {
  /** The start command's pid, which leads the app's process group. */
  readonly pid: number;
  /** `<sessionsDir>/<pid>.json`, kept until the group is stopped. */
  readonly recordFile: string;
  /**
   * Stops the app's whole process group: SIGTERM, SIGKILL `APP_STOP_GRACE_MS` later when it is
   * still there, then waits for it to be gone and removes its session record. Every call after the
   * first awaits the same stop.
   */
  stop(): Promise<void>;
}

/**
 * Starts the run's pinned app start command in the run worktree for a capture, after checking its
 * URL does not already answer (`capture_app_url_in_use`, starting nothing). The command is split on
 * whitespace and run without a shell, in its own process group, with `env`, its output in
 * `appLogPath`. While the group runs it has a session record `<sessionsDir>/<pid>.json` of kind
 * `app`, so the startup sweep stops an app left running by a ZeNorm that stopped mid-capture.
 * ZeNorm then waits up to `readyTimeoutMs` (`APP_READY_TIMEOUT_MS` for a run) for the URL to answer:
 * when it does not, or the app exits first, or `signal` aborts, the group is stopped and capture
 * fails `capture_app_not_ready`. Once started, `signal` aborting stops the group too, so a cancel
 * stops the app whatever the capture is doing. The caller stops it on every other end.
 */
export async function startApp(input: {
  readonly worktreePath: string;
  readonly runDir: string;
  readonly command: string;
  readonly url: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionsDir: string;
  readonly readyTimeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<Result<RunningApp, AppStartError>> {
  const { command, url, signal } = input;
  const aborted = (): boolean => signal.aborted;
  if (await urlAnswers(url)) {
    return err({
      code: "capture_app_url_in_use",
      message: `Something already answers at ${url}, so ZeNorm did not start the app: stop whatever runs there.`,
    });
  }
  const notReady = (why: string): AppStartError => ({
    code: "capture_app_not_ready",
    message: `The app started with \`${command}\` ${why}`,
  });
  if (signal.aborted) {
    return err(notReady("was not started: the run was cancelled."));
  }
  const [file, ...args] = command.split(/\s+/);
  if (file === undefined || file === "") {
    throw new Error(`App start command ${JSON.stringify(command)} is empty`);
  }
  await mkdir(join(input.runDir, APP_LOG_DIR), { recursive: true });
  const log = openSync(appLogPath(input.runDir), "a");
  const child = spawn(file, args, {
    cwd: input.worktreePath,
    env: input.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  /** How the start command's process exited, once it has: read while ZeNorm waits for the URL. */
  const state: { exited: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    exited: null,
  };
  child.on("exit", (code, exitSignal) => {
    state.exited = { code, signal: exitSignal };
  });
  const spawned = await new Promise<string | null>((resolve) => {
    child.once("spawn", () => {
      resolve(null);
    });
    child.once("error", (error) => {
      resolve(errnoOf(error) ?? error.message);
    });
  });
  const childPid = child.pid;
  if (spawned !== null) {
    return err(notReady(`could not be started (${spawned}).`));
  }
  if (childPid === undefined) {
    throw new Error(`The app started with ${JSON.stringify(command)} spawned with no pid`);
  }
  const pid: number = childPid;

  const recordFile = join(input.sessionsDir, `${String(pid)}.json`);
  const startedAt = new Date().toISOString();
  let stopping: Promise<void> | null = null;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      signalGroup(pid, "SIGTERM");
      if (!(await untilGroupGone(pid, APP_STOP_GRACE_MS))) {
        signalGroup(pid, "SIGKILL");
        await untilGroupGone(pid, APP_GONE_WAIT_MS);
      }
      await rm(recordFile, { force: true });
    })();
    return stopping;
  }
  function onAbort(): void {
    void stop();
  }
  const app: RunningApp = { pid, recordFile, stop };
  signal.addEventListener("abort", onAbort, { once: true });
  // The record names what `ps` shows for the pid, which the sweep compares before any signal.
  const shown = await psCommand(pid);
  if (shown !== null) {
    await writeFile(
      recordFile,
      JSON.stringify({ pid, command: shown, startedAt, kind: "app", ...serverIdentity() }),
    );
  }

  const deadline = Date.now() + input.readyTimeoutMs;
  for (;;) {
    if (aborted()) {
      await app.stop();
      return err(notReady("was stopped: the run was cancelled."));
    }
    if (await urlAnswers(url)) {
      return ok(app);
    }
    const ended = state.exited;
    if (ended !== null) {
      await app.stop();
      return err(
        notReady(
          `exited (${ended.code === null ? `signal ${String(ended.signal)}` : `exit ${String(ended.code)}`}) before ${url} answered. Its output is in ${appLogPath(input.runDir)}.`,
        ),
      );
    }
    if (Date.now() >= deadline) {
      await app.stop();
      return err(
        notReady(
          `did not answer at ${url} within ${String(Math.round(input.readyTimeoutMs / 1000))} seconds. Its output is in ${appLogPath(input.runDir)}.`,
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, APP_READY_POLL_MS));
  }
}
