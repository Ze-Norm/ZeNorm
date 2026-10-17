import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";
import type { Project } from "@playwright/test";

import { E2E_RUN_ROOT_ENV_VAR } from "./fixture.ts";
import { SONNET_LIMITS } from "./model-limits.ts";
import { LIVE_RUN_WAIT_MS, stopStaleE2eServer, writeRunnerRecord } from "./stale-server.ts";

const HOST = "127.0.0.1";
/**
 * The run's lock: the `webServer` below listens here for the whole run. Pages use each worker's
 * own server (`worker-server.ts`), on a free port; this one only holds the port, so another run's
 * stale-server guard (S9-8, S9-13) waits for this run to end, as it waited on the one shared server.
 */
const LOCK_PORT = 4600;
const LOCK_URL = `http://${HOST}:${String(LOCK_PORT)}`;
const SHUTDOWN_TIMEOUT_MS = 5000;
/**
 * How long an assertion waits for a state. Most states the flows wait on are the agent's: the page
 * sees one when its change arrives on `/events` and the live layer refetches (S9-16, 300 ms
 * coalescing), after a chain of up to three stand-in runs (a waypoint's last run, the consistency
 * pass, the spec draft), each a `node` process, and every refetch runs git once for each
 * project. Idle, a run takes about 0.1 s; under machine load the processes slow several-fold
 * (L114), so 10 s leaves the slower runs room (L123). It hides no lost update: a state that never
 * arrives as a change still fails.
 */
const EXPECT_TIMEOUT_MS = 10_000;
/**
 * How many workers run at once, each with its own server, browser and stand-in runs. On a 14-core
 * Mac the run took 120 s with 4 workers, 97 s with 6, 88 s with 8 and 89 s with 10, where every
 * test ran about 25% slower than with 8: past 8, more workers only slow every run. CI's macOS
 * runner has 3 vCPUs: there more workers starve the runs and flows pass the test timeout, so CI
 * (`CI` set, as GitHub Actions sets it) runs 2.
 */
const LOCAL_WORKERS = 8;
const CI_WORKERS = 2;
const WORKERS = process.env.CI === undefined ? LOCAL_WORKERS : CI_WORKERS;
/**
 * How long one test may take. A flow chains several stand-in runs, and the delivery flows of
 * `completion` take about 22 s on an idle 14-core machine; with the cores contended (2 workers
 * beside 11 busy loops) the longest took 29 s, so on CI's 3 vCPUs Playwright's 30 s leaves no
 * room. Locally the default stays. A lost update still fails by `EXPECT_TIMEOUT_MS`, per state.
 */
const LOCAL_TEST_TIMEOUT_MS = 30_000;
const CI_TEST_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = process.env.CI === undefined ? LOCAL_TEST_TIMEOUT_MS : CI_TEST_TIMEOUT_MS;
const appDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Creates the run's root once, in the runner: `data/` and `config.json` for the lock server, the
 * config every worker's server copies (`worker-server.ts`) with its own port and `data/`. The
 * runner starts the web server before any global setup, and this module is evaluated again in
 * every worker, which inherits the runner's environment and so skips this.
 */
function createRunRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zenorm-e2e-"));
  process.env[E2E_RUN_ROOT_ENV_VAR] = root;
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  // The scripted stand-in (ticket 05); `pnpm check` never runs the real `claude`.
  const agent = {
    claudePath: join(appDir, "e2e", "fake-claude.ts"),
    wayfindingModel: "claude-sonnet-5-5",
    specModel: "claude-sonnet-5-5",
    models: { "claude-sonnet-5-5": SONNET_LIMITS },
    effort: "medium",
    maxTurns: 12,
    timeoutSeconds: 30,
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
  const config = {
    server: { host: HOST, port: LOCK_PORT },
    dataDir,
    agent,
    delivery,
    plugins: {},
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  return root;
}

/**
 * The runner's root: first the stale-server guard (S9-8, D7), which must run here, synchronously,
 * because the runner starts the web server before any global setup; then the fresh run root, and
 * in it this runner's record (S9-13), so another run's guard leaves this run's server alone.
 */
function runnerRoot(): string {
  stopStaleE2eServer(LOCK_PORT, LIVE_RUN_WAIT_MS);
  const created = createRunRoot();
  writeRunnerRecord(created);
  return created;
}

const root = process.env[E2E_RUN_ROOT_ENV_VAR] ?? runnerRoot();

/** Playwright's `env` replaces inheritance, so pass everything on (`PATH` must reach `git`). */
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

/** A project of one spec file, on its workers' own servers. */
function specFile(name: string): Project {
  return { name, testMatch: `${name}.spec.ts`, use: { ...devices["Desktop Chrome"] } };
}

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: WORKERS,
  timeout: TEST_TIMEOUT_MS,
  forbidOnly: process.env.CI !== undefined,
  reporter: "list",
  expect: { timeout: EXPECT_TIMEOUT_MS, toPass: { timeout: EXPECT_TIMEOUT_MS } },
  globalTeardown: "./global-teardown.ts",
  // `baseURL` is each worker's own server's (`worker-server.ts`).
  use: { trace: "retain-on-failure" },
  // Every file runs on its workers' own servers, so none depends on another. Workers take the
  // projects in this order: the files with the longest serial groups first (revisions' flows,
  // maps' chart flow), then the files that run whole in one worker, and last the files that run
  // in parallel, whose short scenarios fill the workers as the run ends.
  projects: [
    specFile("revisions"),
    specFile("maps"),
    // S9-16's live flows: two pages on the worker's server, then a stop and restart of a server of
    // the flow's own on port 4690.
    specFile("live"),
    // S9-2's shutdown timing: each case spawns its own server on a free port, and the file uses
    // Playwright's own `test`, with no worker server.
    { name: "shutdown", testMatch: "shutdown.spec.ts" },
    specFile("projects"),
    specFile("shell"),
    specFile("specs"),
    specFile("completion"),
    specFile("hatch"),
    specFile("tickets"),
    specFile("delivery"),
    specFile("drafts"),
    // The phone layout (`mobile.spec.ts`): one short serial file, its viewport set in the file.
    specFile("mobile"),
  ],
  webServer: {
    command: "node src/main.ts",
    cwd: appDir,
    url: `${LOCK_URL}/healthz`,
    env: { ...inheritedEnv, ZENORM_CONFIG: join(root, "config.json") },
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: SHUTDOWN_TIMEOUT_MS },
    stdout: "pipe",
    stderr: "pipe",
  },
});
