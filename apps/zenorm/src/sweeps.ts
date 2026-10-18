import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { descendantsOf, parseStartTime, processTable, type ProcessRow } from "@zenorm/agent";
import { deliveryRuns } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { z } from "zod";

/** One line per thing a sweep did. */
export type SweepLog = (line: string) => void;

const execFileAsync = promisify(execFile);

const sessionFields = {
  pid: z.number().int().positive(),
  command: z.string().min(1),
  startedAt: z.iso.datetime(),
  kind: z.enum(["auth", "planning", "orchestrator", "reviewer", "app"]),
};

/**
 * A session record, `<sessionsDir>/<pid>.json`: a `claude` session's, written by `packages/agent`'s
 * `runProcess`, or (kind `app`) a capture's started app's, written by `packages/core`'s `startApp`
 * with the command `ps` showed for it; `startedAt` is an ISO string. It names the server that spawned it, or,
 * written before records did, carries neither server field. Each shape is strict, so a
 * record with one server field and not the other is broken, never read as the older shape.
 */
const SessionRecord = z.union([
  z.strictObject({
    ...sessionFields,
    serverPid: z.number().int().positive(),
    serverStartedAt: z.iso.datetime(),
  }),
  z.strictObject(sessionFields),
]);
type SessionRecord = z.infer<typeof SessionRecord>;

/** How long the sweep waits for a killed group (or pid) to be gone. */
const KILL_WAIT_MS = 5000;
const KILL_POLL_MS = 50;

/**
 * How far apart `ps`'s start time (1 s resolution) and the record's `startedAt` (written right
 * after the spawn) may be for the process to be the one the record names.
 */
const START_SLACK_MS = 3000;

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** Whether a signal 0 to `target` (a pid, or a negated group id) reaches a process. */
function reaches(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      // The process exists but belongs to someone else: it cannot be a session of ours.
      return false;
    }
    throw error;
  }
}

/** SIGKILL to `target`; a process already gone (ESRCH) or not ours (EPERM) is fine. */
function kill(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

/** `ps -o <field>= -p <pid>` in the C locale; null when no such process (ps exits 1). */
async function psField(pid: number, field: "command" | "lstart"): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout.trim();
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === 1) {
      return null;
    }
    throw error;
  }
}

/** Whether `command` (from `ps`) runs `recorded`: equal, or `recorded` then a space. */
function runsCommand(command: string, recorded: string): boolean {
  return command === recorded || command.startsWith(`${recorded} `);
}

/**
 * Why the session `record` names is not orphaned, or null when it is. A record that names its
 * server is orphaned when that server's pid is gone, or now runs a process that started at
 * another time than the record says (the pid was reused): under a subreaper (systemd, a
 * container's init) an orphan's parent is not pid 1. A record without server fields keeps
 * the older rule: orphaned when its parent is pid 1.
 */
async function whyNotOrphaned(record: SessionRecord, own: ProcessRow): Promise<string | null> {
  const pid = String(record.pid);
  if (!("serverPid" in record)) {
    return own.ppid === 1
      ? null
      : `process ${pid} is not orphaned (its parent ${String(own.ppid)} still runs)`;
  }
  const serverLstart = await psField(record.serverPid, "lstart");
  if (serverLstart === null) {
    return null;
  }
  const serverStarted = parseStartTime(record.serverPid, serverLstart);
  if (Math.abs(serverStarted - Date.parse(record.serverStartedAt)) > START_SLACK_MS) {
    return null;
  }
  return `process ${pid} is not orphaned (its server ${String(record.serverPid)} still runs)`;
}

/**
 * Why the live process `own` is not the orphaned session `record` names, or null when it is:
 * it must be orphaned (see `whyNotOrphaned`; so no live server owns it and it is not the
 * person's own `claude`), it must have started when the record says, and it must run the recorded
 * command. Anything else is spared.
 */
async function whyNotOurs(record: SessionRecord, own: ProcessRow): Promise<string | null> {
  const pid = String(record.pid);
  const owned = await whyNotOrphaned(record, own);
  if (owned !== null) {
    return owned;
  }
  const lstart = await psField(record.pid, "lstart");
  const command = await psField(record.pid, "command");
  if (lstart === null || command === null) {
    return `process ${pid} is gone`;
  }
  const started = parseStartTime(record.pid, lstart);
  if (Math.abs(started - Date.parse(record.startedAt)) > START_SLACK_MS) {
    return `process ${pid} started at ${new Date(started).toISOString()}, not at the record's ${record.startedAt}`;
  }
  if (!runsCommand(command, record.command)) {
    return `process ${pid} now runs another command`;
  }
  return null;
}

async function waitUntilGone(target: number): Promise<boolean> {
  const deadline = Date.now() + KILL_WAIT_MS;
  while (reaches(target)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
  }
  return true;
}

/**
 * Kills a recorded session that is still running: its group (or the pid alone when it
 * does not lead a group) and every descendant, collected before any signal, because the
 * Bash tool runs in its own process group.
 */
async function killSession(
  record: SessionRecord,
  own: ProcessRow,
  table: readonly ProcessRow[],
  log: SweepLog,
): Promise<void> {
  const descendants = descendantsOf(record.pid, table);
  const target = own.pgid === record.pid ? -record.pid : record.pid;
  kill(target);
  for (const pid of descendants) {
    kill(pid);
  }
  const what = target < 0 ? `process group ${String(record.pid)}` : `process ${String(record.pid)}`;
  const gone = await waitUntilGone(target);
  log(
    gone
      ? `Killed the surviving ${record.kind} session's ${what} (${record.command}) and ${String(descendants.length)} descendants`
      : `Sent SIGKILL to the surviving ${record.kind} session's ${what} (${record.command}) and ${String(descendants.length)} descendants, but it was still there after ${String(KILL_WAIT_MS)} ms`,
  );
}

async function readRecord(path: string): Promise<SessionRecord | null> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  const parsed = SessionRecord.safeParse(json);
  return parsed.success ? parsed.data : null;
}

async function entries(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Kills the session `record` names when it is ours and orphaned, else logs why not. */
async function sweepRecord(record: SessionRecord, path: string, log: SweepLog): Promise<void> {
  const table = await processTable();
  const own = table.find((row) => row.pid === record.pid);
  if (own === undefined) {
    log(`Removed session record ${path}: process ${String(record.pid)} is gone`);
    return;
  }
  const reason = await whyNotOurs(record, own);
  if (reason !== null) {
    log(`Removed session record ${path} without a signal: ${reason}`);
    return;
  }
  await killSession(record, own, table, log);
}

/**
 * The startup process sweep: for each session record left by an earlier server,
 * kills the session's processes when the recorded pid is orphaned, started when the record says
 * and runs the recorded command; spares any other process; and removes the record in every case.
 */
export async function sweepSessions(sessionsDir: string, log: SweepLog): Promise<void> {
  const names = await entries(sessionsDir);
  if (names === null) {
    return;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const path = join(sessionsDir, name);
    const record = await readRecord(path);
    if (record === null) {
      log(`Removed unreadable session record ${path}`);
    } else {
      await sweepRecord(record, path, log);
    }
    await rm(path);
  }
}

/**
 * The orphaned run folder sweep: removes each entry of `runsDir` that names no
 * delivery run. `rm` removes a symlink itself, never what it points to.
 */
export async function sweepRunFolders(
  db: ZeNormDatabase,
  runsDir: string,
  log: SweepLog,
): Promise<void> {
  const names = await entries(runsDir);
  if (names === null) {
    return;
  }
  const known = new Set(
    db
      .select({ id: deliveryRuns.id })
      .from(deliveryRuns)
      .all()
      .map((row) => row.id),
  );
  for (const name of names) {
    if (!known.has(name)) {
      const path = join(runsDir, name);
      await rm(path, { recursive: true });
      log(`Removed orphaned run folder ${path}: no delivery run has this id`);
    }
  }
}
