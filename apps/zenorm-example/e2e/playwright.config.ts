import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";
import { SONNET_LIMITS } from "@zenorm/zenorm/e2e/model-limits";
import {
  LIVE_RUN_WAIT_MS,
  stopStaleE2eServer,
  writeRunnerRecord,
} from "@zenorm/zenorm/e2e/stale-server";

import { E2E_ROOT_ENV_VAR, repo, REPO_NAMES } from "./fixture.ts";

/**
 * The example composition's Playwright project (S9-20): `apps/zenorm-example` composed with the
 * example plugin, on its own port, under the same shared lock as `apps/zenorm`'s e2e.
 */
const HOST = "127.0.0.1";
const PORT = 4650;
const BASE_URL = `http://${HOST}:${String(PORT)}`;
const SHUTDOWN_TIMEOUT_MS = 5000;
/** As `apps/zenorm`'s e2e (L123): the live layer's refetch after a chain of stand-in runs. */
const EXPECT_TIMEOUT_MS = 10_000;
const appDir = fileURLToPath(new URL("..", import.meta.url));
/** This app's web build, composed with the example plugin; `pnpm build` writes it before `e2e`. */
const webDistDir = join(appDir, "dist");
/** The scripted stand-in `claude` of `apps/zenorm`'s e2e; only planning runs use it here. */
const fakeClaude = createRequire(import.meta.url).resolve("@zenorm/zenorm/e2e/fake-claude");

function git(args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
    stdio: "ignore",
  });
}

function configOf(dataDir: string, plugins: Readonly<Record<string, unknown>>, executor: string) {
  return {
    server: { host: HOST, port: PORT },
    dataDir,
    agent: {
      claudePath: fakeClaude,
      wayfindingModel: "claude-sonnet-5-5",
      specModel: "claude-sonnet-5-5",
      models: { "claude-sonnet-5-5": SONNET_LIMITS },
      effort: "medium",
      maxTurns: 12,
      timeoutSeconds: 30,
    },
    delivery: {
      model: "claude-sonnet-5-5",
      effort: "medium",
      orchestratorMaxTurns: 50,
      orchestratorTimeoutMinutes: 2,
      reviewerMaxTurns: 20,
      reviewerTimeoutMinutes: 2,
      checkTimeoutMinutes: 1,
      executor,
    },
    plugins,
  };
}

/**
 * Creates the temp root once, in the runner: the three repositories, `data/`, and the seed (a map
 * in `denied-repo`, added with no plugin), then `config.json` with the `example` section and
 * `delivery.executor: "example"`. Workers inherit the root and skip this.
 */
function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zenorm-e2e-example-"));
  process.env[E2E_ROOT_ENV_VAR] = root;
  for (const name of REPO_NAMES) {
    git(["init", "-q", "-b", "main", repo(name)]);
    git(["-C", repo(name), "commit", "-q", "--allow-empty", "-m", "init"]);
  }
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(configOf(dataDir, {}, "local")));
  execFileSync(
    process.execPath,
    [join(appDir, "e2e", "seed.ts"), configPath, webDistDir, repo("denied-repo")],
    { cwd: appDir, stdio: "ignore" },
  );
  const example = {
    deniedProjectNames: ["denied-repo"],
    refusedDeliveryProjectNames: ["refused-repo"],
  };
  writeFileSync(configPath, JSON.stringify(configOf(dataDir, { example }, "example")));
  return root;
}

/** As `apps/zenorm`'s: the stale-server guard (S9-8, S9-13) first, then the root and its record. */
function runnerRoot(): string {
  stopStaleE2eServer(PORT, LIVE_RUN_WAIT_MS);
  const created = createRoot();
  writeRunnerRecord(created);
  return created;
}

const root = process.env[E2E_ROOT_ENV_VAR] ?? runnerRoot();

/** Playwright's `env` replaces inheritance, so pass everything on (`PATH` must reach `git`). */
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: "list",
  expect: { timeout: EXPECT_TIMEOUT_MS },
  globalTeardown: "./global-teardown.ts",
  use: { baseURL: BASE_URL, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [{ name: "example", testMatch: "example.spec.ts" }],
  webServer: {
    command: "node src/main.ts",
    cwd: appDir,
    url: `${BASE_URL}/healthz`,
    env: { ...inheritedEnv, ZENORM_CONFIG: join(root, "config.json") },
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: SHUTDOWN_TIMEOUT_MS },
    stdout: "pipe",
    stderr: "pipe",
  },
});
