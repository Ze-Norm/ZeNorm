import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { e2eRunRoot, SERVER_RECORDS_DIR } from "./fixture.ts";

/** The command line every server the e2e spawns runs (`worker-server.ts`, `live`, `shutdown`). */
const E2E_SERVER_COMMAND = "node src/main.ts";

/** `ps -o command= -p <pid>`; null when no such process (ps exits 1). */
function commandOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch (error: unknown) {
    if (error instanceof Error && "status" in error && error.status === 1) return null;
    throw error;
  }
}

/**
 * Kills each server a killed worker left behind, by its recorded pid only and only while that pid
 * still runs the server's command, and removes its folder.
 */
function stopLeftServers(): void {
  const dir = join(e2eRunRoot(), SERVER_RECORDS_DIR);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Unexpected server file ${name}`);
    if (commandOf(pid) === E2E_SERVER_COMMAND) process.kill(pid, "SIGKILL");
    rmSync(readFileSync(join(dir, name), "utf8"), { recursive: true, force: true });
  }
}

export default function globalTeardown(): void {
  stopLeftServers();
  rmSync(e2eRunRoot(), { recursive: true, force: true });
}
