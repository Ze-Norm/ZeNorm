import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { e2eRoot, liveRepo, recordServer, serverRecordFile } from "./fixture.ts";
import {
  acceptAndSend,
  addProject,
  composer,
  confirmDestination,
  openWaypoint,
  questionRound,
  roundEyebrow,
  startMap,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * The two live-update flows. Nothing polls: every state a page shows without a reload arrives as a
 * change on `/events`, refetched through the live layer.
 */

const IDEA = "Show live progress to a second tab";
const LIVE_ALERT = "Live updates stopped. Reconnecting…";
/** The shutdown limit for a stop with nothing ignoring SIGTERM, here with an open stream. */
const STOP_LIMIT_MS = 5_000;
const HOST = "127.0.0.1";
/**
 * The restart flow's own server (not the worker's, which the first flow needs): a fixed port, so the
 * restart listens where the page's stream reconnects.
 */
const RESTART_PORT = 4690;
const RESTART_URL = `http://${HOST}:${String(RESTART_PORT)}`;
const appDir = fileURLToPath(new URL("..", import.meta.url));
/** The web query client's retries of a read that failed to fetch (`QUERY_RETRIES` in `@zenorm/web`). */
const QUERY_RETRIES = 3;

/** Marks the page, so a reload (which drops the mark) fails the flow (the e2e has no DOM types). */
async function markPage(page: Page): Promise<void> {
  await page.evaluate("document.documentElement.dataset.liveMark = 'set'");
}

/**
 * Resolves once the page has handled what it had queued: the browser reports a failed request
 * before the page's own code has seen the rejection, retried or rendered the error.
 */
async function pageSettled(page: Page): Promise<void> {
  await page.evaluate(
    "new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 250))",
  );
}

async function expectNotReloaded(page: Page): Promise<void> {
  expect(await page.evaluate("document.documentElement.dataset.liveMark")).toBe("set");
}

test("two pages on one map: a round answered in one moves the other without a reload", async ({
  page,
  context,
}) => {
  await addProject(page, liveRepo());
  const mapId = await startMap(page, liveRepo(), IDEA);
  await confirmDestination(page, mapId);

  // Page B watches waypoint 1 while its first round waits.
  const other = await context.newPage();
  await openWaypoint(other, mapId, 1);
  await expect(roundEyebrow(other, 1, 1)).toBeVisible();
  await markPage(other);

  // Page A answers that round.
  await openWaypoint(page, mapId, 1);
  await expect(roundEyebrow(page, 1, 1)).toBeVisible();
  await acceptAndSend(page);

  // B sees the answered round, then the agent's next round, from the stream alone.
  await expect(other.getByRole("region", { name: "Round 1" })).toBeVisible();
  await expect(roundEyebrow(other, 2, 1)).toBeVisible();
  await expect(questionRound(other)).toBeVisible();
  await expectNotReloaded(other);
  await other.close();
});

let restartFolder: string | null = null;
let restartServer: ChildProcess | null = null;

/** Starts `node src/main.ts` on `config` and resolves once this child is listening. */
async function startServer(config: string, folder: string): Promise<ChildProcess> {
  const child = spawn("node", ["src/main.ts"], {
    cwd: appDir,
    env: { ...process.env, ZENORM_CONFIG: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  restartServer = child;
  if (child.pid === undefined) throw new Error("The server spawn gave no pid");
  recordServer(child.pid, folder);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(`ZeNorm listening on ${RESTART_URL}`)) resolve();
    });
    child.once("exit", (code) => {
      reject(new Error(`The server exited (${String(code)}) before listening: ${stderr}`));
    });
  });
  return child;
}

/** SIGTERMs the server by its pid; resolves with how long it took to exit, and its exit code. */
async function stopServer(
  child: ChildProcess,
): Promise<{ readonly ms: number; readonly code: number | null }> {
  const { pid } = child;
  if (pid === undefined) throw new Error("The server has no pid");
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  const started = performance.now();
  process.kill(pid, "SIGTERM");
  const code = await exited;
  rmSync(serverRecordFile(pid), { force: true });
  return { ms: performance.now() - started, code };
}

test.afterEach(async () => {
  const child = restartServer;
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill("SIGKILL");
    await exited;
  }
  if (child?.pid !== undefined) rmSync(serverRecordFile(child.pid), { force: true });
  restartServer = null;
  if (restartFolder !== null) await rm(restartFolder, { recursive: true, force: true });
  restartFolder = null;
});

test("a stopped server shows the live Alert and no error card beside it, and a restart clears it", async ({
  browser,
}) => {
  // A server of this flow's own, on the worker's e2e config but its own data folder and port.
  const folder = await mkdtemp(join(tmpdir(), "zenorm-live-"));
  restartFolder = folder;
  const dataDir = join(folder, "data");
  await mkdir(dataDir);
  const shared: unknown = JSON.parse(await readFile(join(e2eRoot(), "config.json"), "utf8"));
  if (typeof shared !== "object" || shared === null) throw new Error("No worker e2e config");
  const config = join(folder, "config.json");
  await writeFile(
    config,
    JSON.stringify({ ...shared, server: { host: HOST, port: RESTART_PORT }, dataDir }),
  );

  let server = await startServer(config, folder);
  const context = await browser.newContext({ baseURL: RESTART_URL });
  const page = await context.newPage();
  const streamOpened = page.waitForResponse(
    (response) => response.url() === `${RESTART_URL}/events` && response.status() === 200,
  );
  // A project, so the Inbox has cached reads to keep while the server is down.
  await addProject(page, liveRepo());
  await streamOpened;
  await markPage(page);
  const alert = page.getByRole("alert").filter({ hasText: LIVE_ALERT });
  await expect(alert).toHaveCount(0);

  // The shutdown timing still holds with a stream open: the stop ends it before the server closes.
  const { ms, code } = await stopServer(server);
  expect(code).toBe(0);
  expect(ms).toBeLessThan(STOP_LIMIT_MS);
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(LIVE_ALERT);

  // An in-app move to the Inbox while down: its reads fail to fetch, are retried, and run out.
  // The page keeps the cached projects and maps and shows no card beyond the Alert.
  let listFailures = 0;
  const readsRanOut = new Promise<void>((resolve) => {
    page.on("requestfailed", (request) => {
      if (!request.url().startsWith(`${RESTART_URL}/rpc/project/list`)) return;
      listFailures += 1;
      if (listFailures === 1 + QUERY_RETRIES) resolve();
    });
  });
  await page.getByRole("link", { name: /ZeNorm$/ }).click();
  await readsRanOut;
  await pageSettled(page);
  await expect(composer(page)).toBeVisible();
  await expect(composer(page).getByRole("combobox", { name: "Project" })).toBeVisible();
  await expect(page.getByText(/^Could not load/)).toHaveCount(0);
  await expect(alert).toBeVisible();

  // The restart reopens the stream, and its open refetches the Inbox's reads.
  const refetched = Promise.all(
    ["project/list", "map/overviews"].map((procedure) =>
      page.waitForResponse(
        (response) =>
          response.url().startsWith(`${RESTART_URL}/rpc/${procedure}`) && response.status() === 200,
      ),
    ),
  );
  server = await startServer(config, folder);
  await expect(alert).toHaveCount(0);
  await refetched;
  await expect(page.getByText(/^Could not load/)).toHaveCount(0);
  // The restart deleted every feed row the project's add wrote: a reconnect from
  // before them is refused, so the client resyncs instead of missing them.
  const pruned = await context.request.get(`${RESTART_URL}/events`, {
    headers: { "last-event-id": "0" },
  });
  expect(pruned.status()).toBe(409);
  expect(await pruned.text()).toBe("last_event_id_pruned");
  await expectNotReloaded(page);
  await stopServer(server);
  await context.close();
});
