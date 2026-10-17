import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DeliveryRun,
  MapDetail,
  MapOverviewDetail,
  Project,
  QuestionRound,
} from "@zenorm/contracts";
import type { DeliveryExecutor, ImplementRequest, SpecRun } from "@zenorm/contracts";
import { createExamplePlugin } from "@zenorm/plugin-example/server";
import type { ServerPlugin } from "@zenorm/server";
import { SONNET_LIMITS } from "@zenorm/zenorm/e2e/model-limits";
import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";
import { startZeNorm } from "@zenorm/zenorm/startup";
import type { StartedZeNorm } from "@zenorm/zenorm/startup";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Repairs through the real `example` executor: ZeNorm started as `apps/zenorm` does, with the
 * example plugin and `delivery.executor: "example"`, and one map driven over `/rpc` by the stand-in
 * claude to an approved ticket set. A required check looks for the file the executor commits on a
 * repair attempt (`example-executor/repair-<n>.txt`). The executor is wrapped only to record the
 * requests it is given.
 */

/** The stand-in `claude` of `apps/zenorm`'s e2e, for the planning sessions. */
const FAKE_CLAUDE = createRequire(import.meta.url).resolve("@zenorm/zenorm/e2e/fake-claude");
/** The stand-in confirms this idea's map with no waypoints, so it clears at once. */
const IDEA = "Export every record as a CSV file [fake:no-waypoints]";
/** A required check that passes in any repository. */
const PASSING_CHECK = "git status --short";
/** A check that fails until the example executor's repair attempt `n` is committed. */
function repairCheck(attempt: number): string {
  return `git ls-files --error-unmatch example-executor/repair-${String(attempt)}.txt`;
}
/** How long the planning stages and the delivery run may take to reach the next step. */
const STEP_WAIT = { timeout: 50_000, interval: 100 };
const TEST_TIMEOUT_MS = 120_000;
/** The host and port the started app is configured on, and the Host a request to it carries. */
const SERVER = { host: "127.0.0.1", port: 4398 };
const HOST = `${SERVER.host}:${String(SERVER.port)}`;

let root: string;
let running: StartedZeNorm | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-example-repairs-"));
  running = null;
});

afterEach(async () => {
  if (running !== null) {
    const { app, db } = running;
    running = null;
    await Promise.all([app.stopPlanningRuns(), app.stopDeliveryRuns()]);
    await app.stopPlugins();
    db.$client.close();
  }
  await rm(root, { recursive: true, force: true });
});

/** `executor`, recording each implement request into `requests` before delegating to it. */
function recordingExecutor(
  executor: DeliveryExecutor,
  requests: ImplementRequest[],
): DeliveryExecutor {
  return {
    ...executor,
    implementTicketSet: async (request, signal, onEvent) => {
      requests.push(request);
      return await executor.implementTicketSet(request, signal, onEvent);
    },
  };
}

/** The example plugin with its executors wrapped by `recordingExecutor`. */
function recordingExamplePlugin(requests: ImplementRequest[]): ServerPlugin {
  const plugin = createExamplePlugin();
  return {
    ...plugin,
    configure: (section) => {
      const configured = plugin.configure(section);
      if (!configured.ok) return configured;
      const { executors } = configured.value;
      if (executors === null) throw new Error("The example plugin contributes no executor");
      return {
        ok: true,
        value: {
          ...configured.value,
          executors: () => executors().map((executor) => recordingExecutor(executor, requests)),
        },
      };
    },
  };
}

/** Starts ZeNorm with the recording example plugin and the `example` executor. */
async function start(requests: ImplementRequest[]): Promise<StartedZeNorm> {
  const dataDir = join(root, "data");
  const webDistDir = join(root, "web");
  await mkdir(dataDir, { recursive: true });
  await mkdir(webDistDir, { recursive: true });
  await writeFile(join(webDistDir, "index.html"), "<!doctype html>");
  const config = {
    server: SERVER,
    dataDir,
    agent: {
      claudePath: FAKE_CLAUDE,
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
      executor: "example",
    },
    plugins: { example: { deniedProjectNames: [], refusedDeliveryProjectNames: [] } },
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const started = await startZeNorm({
    args: ["--config", configPath],
    // The stand-in claude's `#!/usr/bin/env node` finds node on `PATH`; the config is `--config`'s.
    env: { PATH: process.env.PATH },
    webDistDir,
    ...SOURCE_ASSETS,
    standardConfigPath: null,
    log: () => undefined,
    logError: () => undefined,
    plugins: [recordingExamplePlugin(requests)],
  });
  if (!started.ok) throw new Error(started.error.code);
  started.value.app.launch();
  running = started.value;
  return started.value;
}

/** One oRPC call on the started app; a refusal fails the test. */
async function rpc(app: StartedZeNorm["app"], path: string, input: unknown): Promise<unknown> {
  const response = await app.fetch(
    new Request(`http://${HOST}/rpc/${path}`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ json: input, meta: [] }),
    }),
  );
  const body: unknown = await response.json();
  if (!response.ok || typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`/rpc/${path} answered ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body.json;
}

async function overview(app: StartedZeNorm["app"], mapId: string): Promise<MapOverviewDetail> {
  return MapOverviewDetail.parse(await rpc(app, "map/overview", { mapId }));
}

/** A git repository at `<root>/project` on `main` with one commit. */
function repository(): string {
  const folderPath = join(root, "project");
  const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
  execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "init"]);
  return folderPath;
}

/** Runs git in `folderPath`; returns its trimmed output. */
function gitIn(folderPath: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", folderPath, ...args], { encoding: "utf8" }).trim();
}

/**
 * Drives one map from idea to an approved ticket set with every recommendation accepted, saves
 * `checks` and `repairLimit`, starts delivery and waits for the run to end. Returns the started
 * run, the ended run and the project's folder.
 */
async function deliver(
  app: StartedZeNorm["app"],
  checks: readonly string[],
  repairLimit: number,
): Promise<{ started: DeliveryRun; ended: SpecRun; folderPath: string }> {
  const folderPath = repository();
  const project = Project.parse(
    await rpc(app, "project/create", { folderPath, baseBranch: "main" }),
  );
  const { map } = MapDetail.parse(
    await rpc(app, "map/create", { projectId: project.id, idea: IDEA }),
  );

  const round = await vi.waitFor(async () => {
    const pending = (await overview(app, map.id)).wayfinding.mapRounds.find(
      (candidate) => candidate.status === "pending",
    );
    if (pending === undefined) throw new Error("No destination round yet");
    return pending;
  }, STEP_WAIT);
  QuestionRound.parse(
    await rpc(app, "questionRound/submit", {
      roundId: round.id,
      answers: round.questions.map(() => ({ optionIndex: 0, note: "", accepted: true })),
    }),
  );

  const revision = await vi.waitFor(async () => {
    const latest = (await overview(app, map.id)).specs.at(0)?.revisions.at(-1);
    if (latest?.state !== "draft" || latest.review.state !== "passed") {
      throw new Error("No reviewed spec yet");
    }
    return latest;
  }, STEP_WAIT);
  await rpc(app, "spec/approve", { specRevisionId: revision.id });

  const ticketSet = await vi.waitFor(async () => {
    const latest = (await overview(app, map.id)).specs.at(0)?.ticketSets.at(-1);
    if (latest?.review?.state !== "passed") {
      throw new Error("No reviewed ticket set yet");
    }
    return latest;
  }, STEP_WAIT);
  await rpc(app, "ticketSet/approve", { ticketSetId: ticketSet.id });

  await rpc(app, "project/saveSettings", {
    projectId: project.id,
    baseBranch: project.baseBranch,
    requiredChecks: [...checks],
    repairLimit,
    fixCommands: [],
  });
  const started = DeliveryRun.parse(
    await rpc(app, "delivery/start", { ticketSetId: ticketSet.id }),
  );
  const ended = await vi.waitFor(async () => {
    const spec = (await overview(app, map.id)).specs.at(0);
    const run = spec?.runs.find((candidate) => candidate.id === started.id);
    if (run === undefined || run.state === "running") throw new Error("The run has not ended");
    return run;
  }, STEP_WAIT);
  return { started, ended, folderPath };
}

describe("repairs through the example executor", () => {
  test(
    "a check looking for the repair file fails before the attempt and passes after it: passed with one attempt",
    async () => {
      const requests: ImplementRequest[] = [];
      const { app } = await start(requests);
      const check = repairCheck(1);

      const { started, ended, folderPath } = await deliver(app, [PASSING_CHECK, check], 2);

      expect(ended).toMatchObject({
        state: "passed",
        failure: null,
        repairLimit: 2,
        repairAttempts: 1,
      });
      expect(ended.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
        [PASSING_CHECK, 0],
        [check, 0],
      ]);
      expect(requests.map((request) => request.repair?.attempt)).toEqual([undefined, 1]);
      // Before the attempt the check failed: the repair request carries it, with its output.
      expect(
        requests[1]?.repair?.failedChecks.map(({ result }) => [result.command, result.exitCode]),
      ).toEqual([[check, 1]]);
      expect(requests[1]?.repair?.failedChecks[0]?.result.outputTail).toContain(
        "example-executor/repair-1.txt",
      );
      // The run branch's final commit holds the file the executor committed.
      if (ended.finalCommit === null) throw new Error("The passed run has no final commit");
      gitIn(folderPath, ["cat-file", "-e", `${ended.finalCommit}:example-executor/repair-1.txt`]);
      expect(gitIn(folderPath, ["rev-parse", started.branch])).toBe(ended.finalCommit);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a check no attempt within the limit satisfies ends delivery_checks_failed, each attempt given the failing output",
    async () => {
      const requests: ImplementRequest[] = [];
      const { app } = await start(requests);
      const check = repairCheck(3);

      const { started, ended } = await deliver(app, [check, PASSING_CHECK], 2);

      expect(ended.state).toBe("failed");
      expect(ended.failure).toMatchObject({ code: "delivery_checks_failed" });
      expect(ended).toMatchObject({ repairLimit: 2, repairAttempts: 2 });
      expect(ended.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
        [check, 1],
        [PASSING_CHECK, 0],
      ]);
      expect(requests.map((request) => request.repair?.attempt)).toEqual([undefined, 1, 2]);
      for (const request of requests.slice(1)) {
        expect(
          request.repair?.failedChecks.map(({ result }) => [result.command, result.exitCode]),
        ).toEqual([[check, 1]]);
        const logPath = join("runs", started.id, "checks", "check-1.log");
        expect(request.repair?.failedChecks[0]?.logPath).toContain(logPath);
        expect(request.repair?.failedChecks[0]?.result.outputTail).toContain(
          "example-executor/repair-3.txt",
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
