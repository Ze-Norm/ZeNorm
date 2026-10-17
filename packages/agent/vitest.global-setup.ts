import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup (CR-10): a test worker killed mid-test (an aborted gate, a cancelled
 * turbo task, an OOM) leaves its TERM-ignoring stand-ins and its temp folder behind, because their
 * cleanup runs inside the worker. Before and after the run this removes leftovers older than
 * STALE_MS: processes whose command line carries MARKER and temp folders named with it. Younger
 * ones may belong to a run in another worktree and are left alone.
 */
const MARKER = "zenorm-delivery-";
const STALE_MS = 10 * 60 * 1000;

/** Seconds from `ps`'s etime, `[[dd-]hh:]mm:ss`. */
function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  if (days === undefined || clock === undefined) throw new Error(`Unreadable etime ${etime}`);
  const parts = clock.split(":").map(Number);
  if (parts.some((part) => !Number.isInteger(part))) throw new Error(`Unreadable etime ${etime}`);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

function killStaleProcesses(): void {
  const listed = spawnSync("ps", ["-Ao", "pid=,etime=,command="], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`ps failed with status ${String(listed.status)}`);
  for (const line of listed.stdout.split("\n")) {
    if (!line.includes(`/${MARKER}`)) continue;
    const match = /^\s*(\d+)\s+(\S+)\s/.exec(line);
    if (match === null) continue;
    const [, pidText, etime] = match;
    if (pidText === undefined || etime === undefined) continue;
    const pid = Number(pidText);
    if (pid === process.pid || elapsedSeconds(etime) * 1000 < STALE_MS) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

function removeStaleFolders(): void {
  const root = tmpdir();
  const now = Date.now();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(MARKER)) continue;
    const path = join(root, name);
    if (now - statSync(path).mtimeMs < STALE_MS) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

function sweep(): void {
  killStaleProcesses();
  removeStaleFolders();
}

export default function setup(): () => void {
  sweep();
  return sweep;
}
