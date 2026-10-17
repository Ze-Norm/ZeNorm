import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { freePort, recordServer as recordServerFolder, serverRecordFile } from "./fixture.ts";
import { SONNET_LIMITS } from "./model-limits.ts";

/**
 * The shutdown timing: a server stopped by SIGTERM while a chart run is in flight stops the
 * planning run, then closes the database, and exits in time without writing to a closed database.
 * Each case spawns its own `node src/main.ts` on a free port with a scratch config whose
 * `claudePath` is a `/bin/sh` stand-in, so it uses no worker server (`worker-server.ts`): this
 * file imports Playwright's own `test`.
 */

const HOST = "127.0.0.1";
const appDir = fileURLToPath(new URL("..", import.meta.url));
const CLOSED_DATABASE = "database connection is not open";

/**
 * A case runs startup, a project and a map, then a stop of up to 15 s (the agent's 10 s SIGKILL
 * grace for a CLI that ignores SIGTERM); the exit bounds below are the asserted limits.
 */
test.describe.configure({ timeout: 60_000 });

/** How the stand-in's planning call treats the SIGTERM the stop sends its process group. */
type OnTerm = "exit" | "ignore";

interface Case {
  readonly folder: string;
  readonly pidsFile: string;
}

let current: Case | null = null;
let server: ChildProcess | null = null;

/**
 * Writes the stand-in: `auth status --json` answers logged in at once (the call's first step);
 * a planning call (`-p …`) records its pid, then sleeps until signalled. With `ignore`, SIGTERM is
 * ignored, which `sleep` inherits, so only the group's SIGKILL ends it.
 */
async function writeStandIn(folder: string, pidsFile: string, onTerm: OnTerm): Promise<string> {
  const path = join(folder, "claude-stand-in.sh");
  const sleep = onTerm === "exit" ? "exec sleep 600" : "trap '' TERM\nsleep 600";
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "auth" ]; then',
      // With its sign-in method, as startup's sign-in check reads it.
      `  echo '{"loggedIn":true,"authMethod":"claude.ai"}'`,
      "  exit 0",
      "fi",
      `echo $$ >> '${pidsFile}'`,
      sleep,
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

/** The scratch folder: a repository with one commit, `data/`, the stand-in and `config.json`. */
async function createCase(
  onTerm: OnTerm,
  port: number,
): Promise<{ readonly config: string; readonly repo: string }> {
  const folder = await mkdtemp(join(tmpdir(), "zenorm-shutdown-"));
  const pidsFile = join(folder, "stand-in-pids");
  current = { folder, pidsFile };
  const repo = join(folder, "repo");
  const git = ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", repo]);
  execFileSync("git", [...git, "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  const dataDir = join(folder, "data");
  await mkdir(dataDir);
  const agent = {
    claudePath: await writeStandIn(folder, pidsFile, onTerm),
    wayfindingModel: "claude-sonnet-5-5",
    specModel: "claude-sonnet-5-5",
    models: { "claude-sonnet-5-5": SONNET_LIMITS },
    effort: "medium",
    maxTurns: 12,
    timeoutSeconds: 60,
  };
  const delivery = {
    model: "claude-sonnet-5-5",
    effort: "medium",
    orchestratorMaxTurns: 50,
    orchestratorTimeoutMinutes: 2,
    reviewerMaxTurns: 20,
    reviewerTimeoutMinutes: 2,
    checkTimeoutMinutes: 1,
    executor: "local",
  };
  const config = join(folder, "config.json");
  await writeFile(
    config,
    JSON.stringify({ server: { host: HOST, port }, dataDir, agent, delivery, plugins: {} }),
  );
  return { config, repo };
}

/** Calls a procedure the way the web client does (oRPC's `{ json, meta }` body). */
async function rpc(baseUrl: string, path: string, input: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: input, meta: [] }),
  });
  const body: unknown = await response.json();
  if (!response.ok || typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`/rpc/${path} answered ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body.json;
}

function idOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    throw new Error(`No id in ${JSON.stringify(value)}`);
  }
  const { id } = value;
  if (typeof id !== "string") throw new Error(`A non-string id in ${JSON.stringify(value)}`);
  return id;
}

/** Each stand-in pid recorded so far. */
function standInPids(pidsFile: string): number[] {
  if (!existsSync(pidsFile)) return [];
  return readFileSync(pidsFile, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(Number);
}

/**
 * Starts the server on the case's config, adds the repository, starts a map and waits until the
 * chart's planning call is in flight. Returns the server and its collected stderr.
 */
async function serverWithChartInFlight(onTerm: OnTerm): Promise<{
  readonly child: ChildProcess;
  readonly stderr: () => string;
}> {
  // Its child's own listening line below catches a port taken between the probe and the bind.
  const port = await freePort(HOST);
  const baseUrl = `http://${HOST}:${String(port)}`;
  const { config, repo } = await createCase(onTerm, port);
  const child = spawn("node", ["src/main.ts"], {
    cwd: appDir,
    env: { ...process.env, ZENORM_CONFIG: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  recordServer(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // This child's own listening line, so the requests below never reach another process on the
  // port; a port already in use ends the child, which fails here with its stderr.
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(`ZeNorm listening on ${baseUrl}`)) resolve();
    });
    child.once("exit", (code) => {
      reject(new Error(`The server exited (${String(code)}) before listening: ${stderr}`));
    });
  });
  const project = await rpc(baseUrl, "project/create", { folderPath: repo, baseBranch: "main" });
  await rpc(baseUrl, "map/create", { projectId: idOf(project), idea: "Add dark mode" });
  if (current === null) throw new Error("The case was not created");
  const { pidsFile } = current;
  await expect.poll(() => standInPids(pidsFile).length).toBe(1);
  return { child, stderr: () => stderr };
}

/**
 * Records the server's pid with its scratch folder: a worker killed before `afterEach`
 * leaves the record for the global teardown, which kills the server by that pid only.
 */
function recordServer(child: ChildProcess): void {
  if (child.pid === undefined) throw new Error("The server spawn gave no pid");
  if (current === null) throw new Error("The case was not created");
  recordServerFolder(child.pid, current.folder);
}

/** Whether no process is left in the group `pid` led; EPERM is a group macOS is still reaping. */
function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return false;
    throw error;
  }
}

/** Every recorded stand-in's process group is gone once the server has exited. */
async function expectStandInsGone(): Promise<void> {
  if (current === null) throw new Error("The case was not created");
  const pids = standInPids(current.pidsFile);
  expect(pids).toHaveLength(1);
  await expect.poll(() => pids.filter((pid) => !groupGone(pid)), { timeout: 2_000 }).toEqual([]);
}

/** SIGTERMs the server and resolves with how long it took to exit, and its exit code. */
async function stopServer(
  child: ChildProcess,
): Promise<{ readonly ms: number; readonly code: number | null }> {
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  const started = performance.now();
  child.kill("SIGTERM");
  const code = await exited;
  return { ms: performance.now() - started, code };
}

test.afterEach(async () => {
  if (server !== null && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      server?.once("exit", () => {
        resolve();
      });
    });
    server.kill("SIGKILL");
    await exited;
  }
  if (server?.pid !== undefined) rmSync(serverRecordFile(server.pid), { force: true });
  server = null;
  if (current !== null) {
    // The stand-in leads its own process group; kill the group of each recorded pid.
    for (const pid of standInPids(current.pidsFile)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await rm(current.folder, { recursive: true, force: true });
  }
  current = null;
});

test("SIGTERM with a chart in flight on a CLI that exits on SIGTERM exits within 5 s", async () => {
  const { child, stderr } = await serverWithChartInFlight("exit");

  const { ms, code } = await stopServer(child);

  expect(code).toBe(0);
  expect(ms).toBeLessThan(5_000);
  expect(stderr()).not.toContain(CLOSED_DATABASE);
  await expectStandInsGone();
});

test("SIGTERM with a chart in flight on a CLI that ignores SIGTERM exits within 15 s", async () => {
  const { child, stderr } = await serverWithChartInFlight("ignore");

  const { ms, code } = await stopServer(child);

  expect(code).toBe(0);
  // The stand-in ignored the SIGTERM, so the stop waited out the agent's 10 s grace.
  expect(ms).toBeGreaterThanOrEqual(9_000);
  expect(ms).toBeLessThan(15_000);
  expect(stderr()).not.toContain(CLOSED_DATABASE);
  await expectStandInsGone();
});
