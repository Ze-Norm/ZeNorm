import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test as base } from "@playwright/test";

import {
  DELIVERY_FLOWS,
  deliveryRepo,
  deliveryRunsRepo,
  draftsRepo,
  composerRepo,
  E2E_ROOT_ENV_VAR,
  e2eRunRoot,
  fakeGhScript,
  fixtureRepo,
  freePort,
  ghBinDir,
  ghStateDir,
  GITHUB_ORIGIN_URL,
  hatchRepo,
  liveRepo,
  mapsDeliveredRepo,
  mapsFlowsRepo,
  mapsRepo,
  nestedInnerRepo,
  nestedOuterRepo,
  noCommitRepo,
  projectsRepo,
  pushTargetRepo,
  recordServer,
  REVISION_FLOWS,
  revisionRepo,
  serverRecordFile,
  specsRepo,
  ticketsRepo,
} from "./fixture.ts";
import { RUNNER_RECORD_FILE } from "./stale-server.ts";

export { expect } from "@playwright/test";

/**
 * One server per Playwright worker. Each worker (one spec file's, or one group's of a file that
 * runs in parallel) makes its own root with every fixture repository, its own database and its
 * own `node src/main.ts` on a free port, and every page of the worker opens on that server
 * (`baseURL`). Files share no state and no server, so none waits on another and no server serves
 * more than one worker's pages. Spec files import `test` and `expect` from here.
 */

const HOST = "127.0.0.1";
/** How long a stopped server has to exit on SIGTERM before it is killed. */
const STOP_WAIT_MS = 15_000;
const appDir = fileURLToPath(new URL("..", import.meta.url));

function git(args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
    stdio: "ignore",
  });
}

/**
 * Makes the worker's root and points `e2eRoot()` at it: the fixture repositories, one commit on
 * `main` each (a repo with no commit, and a nested pair, the inner one created inside the outer),
 * `data/`, the run's runner record (so the stale-server guard reads a live run's root) and
 * `config.json`, the run's config on `port` with the worker's `data/`.
 */
function createWorkerRoot(port: number): string {
  const root = mkdtempSync(join(tmpdir(), "zenorm-e2e-"));
  process.env[E2E_ROOT_ENV_VAR] = root;
  copyFileSync(join(e2eRunRoot(), RUNNER_RECORD_FILE), join(root, RUNNER_RECORD_FILE));
  for (const repo of [
    fixtureRepo(),
    mapsRepo(),
    mapsFlowsRepo(),
    mapsDeliveredRepo(),
    draftsRepo(),
    deliveryRunsRepo(),
    specsRepo(),
    projectsRepo(),
    composerRepo(),
    hatchRepo(),
    ticketsRepo(),
    ...DELIVERY_FLOWS.map((flow) => deliveryRepo(flow)),
    ...REVISION_FLOWS.map((flow) => revisionRepo(flow)),
    liveRepo(),
    nestedOuterRepo(),
    nestedInnerRepo(),
  ]) {
    git(["init", "-q", "-b", "main", repo]);
    git(["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  }
  git(["init", "-q", "-b", "main", noCommitRepo()]);
  // The pull request flow's origin is on github.com; its pushes land in a local bare repository.
  const pullRequestRepo = deliveryRepo("pull-request");
  git(["init", "-q", "--bare", pushTargetRepo()]);
  git(["-C", pullRequestRepo, "remote", "add", "origin", GITHUB_ORIGIN_URL]);
  git(["-C", pullRequestRepo, "config", `url.${pushTargetRepo()}.insteadOf`, GITHUB_ORIGIN_URL]);
  // The fake gh the server runs, first on its PATH (2.4).
  mkdirSync(ghBinDir());
  mkdirSync(ghStateDir());
  writeFileSync(join(ghBinDir(), "gh"), fakeGhScript(ghStateDir()), { mode: 0o755 });
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const run: unknown = JSON.parse(readFileSync(join(e2eRunRoot(), "config.json"), "utf8"));
  if (typeof run !== "object" || run === null) throw new Error("The run's config is no object");
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ ...run, server: { host: HOST, port }, dataDir }),
  );
  return root;
}

interface Server {
  readonly child: ChildProcess;
  readonly stderr: () => string;
}

/**
 * Starts `node src/main.ts` on the worker's config, recorded for the global teardown, and resolves
 * once this child prints its own listening line on `url`; a child that exits first (a port taken
 * since the probe, a config refused) fails the worker with its stderr.
 */
async function startServer(root: string, url: string): Promise<Server> {
  const path = process.env.PATH;
  if (path === undefined) throw new Error("The worker has no PATH to run the server with");
  const child = spawn("node", ["src/main.ts"], {
    cwd: appDir,
    // The fake gh comes first on the server's PATH, so the server runs it as it would the real one.
    env: {
      ...process.env,
      PATH: `${ghBinDir()}${delimiter}${path}`,
      ZENORM_CONFIG: join(root, "config.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("The worker server's spawn gave no pid");
  recordServer(child.pid, root);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const onExit = (code: number | null): void => {
      reject(new Error(`The worker server exited (${String(code)}) before listening: ${stderr}`));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(`ZeNorm listening on ${url}`)) {
        child.off("exit", onExit);
        resolve();
      }
    });
    child.once("exit", onExit);
  });
  return { child, stderr: () => stderr };
}

/** Resolves with the child's exit code once it has exited, at once if it already has. */
async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
}

/**
 * Stops the worker's server: SIGTERM, then SIGKILL past `STOP_WAIT_MS`. A server that exited
 * before the stop fails the worker with its exit code and stderr.
 */
async function stopServer({ child, stderr }: Server): Promise<void> {
  const { pid } = child;
  if (pid === undefined) throw new Error("The worker server has no pid");
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `The worker server exited (${String(child.exitCode)}, ${String(child.signalCode)}) while its tests ran: ${stderr()}`,
    );
  }
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, STOP_WAIT_MS);
  await exited(child);
  clearTimeout(timer);
  rmSync(serverRecordFile(pid), { force: true });
}

interface WorkerServer {
  readonly baseURL: string;
}

export const test = base.extend<object, { workerServer: WorkerServer }>({
  workerServer: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its destructured first parameter, and this one has none.
    async ({}, use) => {
      const port = await freePort(HOST);
      const root = createWorkerRoot(port);
      const baseURL = `http://${HOST}:${String(port)}`;
      const server = await startServer(root, baseURL);
      await use({ baseURL });
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },
});
