import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Parses what `ps -o lstart=` prints for `pid` in the C locale (macOS and procps alike, e.g.
 * `Wed Oct 14 10:00:00 2026`) into ms since the epoch, at `ps`'s 1 s resolution. A start time that
 * does not parse is a programmer error.
 */
export function parseStartTime(pid: number, lstart: string): number {
  const started = Date.parse(lstart);
  if (Number.isNaN(started)) {
    throw new Error(`Unexpected ps start time for process ${String(pid)}: ${lstart}`);
  }
  return started;
}

/** The server a session record names: this process's pid and `ps` start time. */
export interface ServerIdentity {
  readonly serverPid: number;
  /** ISO string of `ps`'s start time for `serverPid`. */
  readonly serverStartedAt: string;
}

let thisServer: ServerIdentity | null = null;

/**
 * This process's pid and its start time as `ps` shows it, taken once per process: a later sweep
 * compares the pid's `ps` start time with it to tell this server from a process that reuses its pid.
 */
export function serverIdentity(): ServerIdentity {
  if (thisServer === null) {
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    thisServer = {
      serverPid: process.pid,
      serverStartedAt: new Date(parseStartTime(process.pid, lstart)).toISOString(),
    };
  }
  return thisServer;
}

/** One row of `ps -A -o pid=,ppid=,pgid=`. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/**
 * Parses `ps -A -o pid=,ppid=,pgid=` output. A line that is not three integers is a programmer
 * error: `ps` printed something this parser does not know, never a process to skip.
 */
export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const fields = line.split(/\s+/);
      if (fields.length !== 3 || !fields.every((field) => /^\d+$/.test(field))) {
        throw new Error(`Unexpected ps line: ${line}`);
      }
      const [pid, ppid, pgid] = fields.map(Number);
      if (pid === undefined || ppid === undefined || pgid === undefined) {
        throw new Error(`Unexpected ps line: ${line}`);
      }
      return { pid, ppid, pgid };
    });
}

/** Every process's pid, parent pid and group id, from one `ps -A`. */
export async function processTable(): Promise<readonly ProcessRow[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  return parseProcessTable(stdout);
}

/** Every descendant of `root` in `table`, children before their own children. */
export function descendantsOf(root: number, table: readonly ProcessRow[]): number[] {
  const found: number[] = [];
  const queue = [root];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const row of table) {
      if (row.ppid === parent && row.pid !== root && !found.includes(row.pid)) {
        found.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return found;
}
