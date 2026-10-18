import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { appSetupLogPath, groupRuns, runAppSetup, startApp, urlAnswers } from "./app-session.ts";

/**
 * A stand-in app: it starts a child in its own process group (as a dev server's watcher would be)
 * and writes the child's pid to `<pidFile>`, then serves HTTP on `<port>` (`serve`) or never
 * listens (`hang`).
 */
const STAND_IN_APP = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [mode, port, pidFile] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(child.pid));
if (mode === "serve") {
  createServer((request, response) => response.end("app")).listen(Number(port), "127.0.0.1");
} else {
  setInterval(() => {}, 1000);
}
`;

/** A setup command stand-in that exits with the code it is given. */
const EXIT_WITH = "process.exitCode = Number(process.argv[2]);\n";

let root: string;
let worktree: string;
let runDir: string;
let sessionsDir: string;
let appScript: string;
let exitScript: string;
let pidFile: string;
let port: number;
let url: string;
const servers: Server[] = [];

/** A port nothing listens on, found by binding port 0 and closing it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port was bound");
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return address.port;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-app-"));
  worktree = join(root, "worktree");
  runDir = join(root, "run");
  sessionsDir = join(root, "sessions");
  await mkdir(worktree);
  await mkdir(runDir);
  await mkdir(sessionsDir);
  appScript = join(root, "app.mjs");
  exitScript = join(root, "exit.mjs");
  pidFile = join(root, "child.pid");
  await writeFile(appScript, STAND_IN_APP);
  await writeFile(exitScript, EXIT_WITH);
  port = await freePort();
  url = `http://127.0.0.1:${String(port)}`;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
  await rm(root, { recursive: true, force: true });
});

function appCommand(mode: "serve" | "hang"): string {
  return `${process.execPath} ${appScript} ${mode} ${String(port)} ${pidFile}`;
}

async function start(
  mode: "serve" | "hang",
  signal: AbortSignal,
  readyTimeoutMs = 20_000,
): ReturnType<typeof startApp> {
  return await startApp({
    worktreePath: worktree,
    runDir,
    command: appCommand(mode),
    url,
    env: process.env,
    sessionsDir,
    readyTimeoutMs,
    signal,
  });
}

/** Whether a signal 0 reaches `pid`. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPid(): number {
  return Number(readFileSync(pidFile, "utf8"));
}

describe("runAppSetup", () => {
  test("runs every command in order in the worktree, each logged", async () => {
    const setup = await runAppSetup({
      worktreePath: worktree,
      runDir,
      commands: [`${process.execPath} ${exitScript} 0`, `${process.execPath} --version`],
      timeoutMs: 20_000,
      env: process.env,
      signal: new AbortController().signal,
    });

    expect(setup).toEqual({ ok: true, value: null });
    expect(await readFile(appSetupLogPath(runDir, 1), "utf8")).toContain(process.version);
  });

  test("a failing command is capture_setup_failed, and the commands after it do not run", async () => {
    const setup = await runAppSetup({
      worktreePath: worktree,
      runDir,
      commands: [`${process.execPath} ${exitScript} 3`, `${process.execPath} --version`],
      timeoutMs: 20_000,
      env: process.env,
      signal: new AbortController().signal,
    });

    expect(setup).toMatchObject({ ok: false, error: { code: "capture_setup_failed" } });
    expect(existsSync(appSetupLogPath(runDir, 1))).toBe(false);
  });

  test("a command past its bound is capture_setup_failed", async () => {
    const setup = await runAppSetup({
      worktreePath: worktree,
      runDir,
      commands: [appCommand("hang")],
      timeoutMs: 300,
      env: process.env,
      signal: new AbortController().signal,
    });

    expect(setup).toMatchObject({ ok: false, error: { code: "capture_setup_failed" } });
    await vi.waitFor(() => {
      expect(alive(childPid())).toBe(false);
    });
  });
});

describe("startApp", () => {
  test("a URL already answering is capture_app_url_in_use, and nothing is started", async () => {
    const server = createServer((_request, response) => response.end("someone else"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    const started = await start("serve", new AbortController().signal);

    expect(started).toMatchObject({ ok: false, error: { code: "capture_app_url_in_use" } });
    expect(existsSync(pidFile)).toBe(false);
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  test("an answering app keeps an app session record until its whole group is stopped", async () => {
    const started = await start("serve", new AbortController().signal);
    if (!started.ok) throw new Error(started.error.message);
    const app = started.value;

    expect(await urlAnswers(url)).toBe(true);
    const record: unknown = JSON.parse(await readFile(app.recordFile, "utf8"));
    expect(record).toMatchObject({
      pid: app.pid,
      kind: "app",
      serverPid: process.pid,
    });
    expect(record).toHaveProperty("command", expect.stringContaining(appScript));
    expect(groupRuns(app.pid)).toBe(true);
    const child = childPid();
    expect(alive(child)).toBe(true);

    await app.stop();

    expect(groupRuns(app.pid)).toBe(false);
    await vi.waitFor(() => {
      expect(alive(child)).toBe(false);
    });
    expect(existsSync(app.recordFile)).toBe(false);
    expect(await urlAnswers(url)).toBe(false);
  });

  test("an app that never answers is capture_app_not_ready, its group stopped and its record gone", async () => {
    const started = await start("hang", new AbortController().signal, 3000);

    expect(started).toMatchObject({ ok: false, error: { code: "capture_app_not_ready" } });
    await vi.waitFor(() => {
      expect(alive(childPid())).toBe(false);
    });
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  test("a start command that cannot run is capture_app_not_ready", async () => {
    const started = await startApp({
      worktreePath: worktree,
      runDir,
      command: join(root, "no-such-app"),
      url,
      env: process.env,
      sessionsDir,
      readyTimeoutMs: 1000,
      signal: new AbortController().signal,
    });

    expect(started).toMatchObject({ ok: false, error: { code: "capture_app_not_ready" } });
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  test("a cancel stops a started app's group by itself", async () => {
    const controller = new AbortController();
    const started = await start("serve", controller.signal);
    if (!started.ok) throw new Error(started.error.message);
    const app = started.value;
    const child = childPid();

    controller.abort();

    await vi.waitFor(() => {
      expect(groupRuns(app.pid)).toBe(false);
      expect(alive(child)).toBe(false);
      expect(existsSync(app.recordFile)).toBe(false);
    });
    // A stop after the cancel's is the same stop.
    await app.stop();
  });

  test("a cancel while waiting for the URL is capture_app_not_ready, the group stopped", async () => {
    const controller = new AbortController();
    const starting = start("hang", controller.signal);
    await vi.waitFor(() => {
      expect(existsSync(pidFile)).toBe(true);
    });

    controller.abort();

    expect(await starting).toMatchObject({ ok: false, error: { code: "capture_app_not_ready" } });
    await vi.waitFor(() => {
      expect(alive(childPid())).toBe(false);
    });
    expect(await readdir(sessionsDir)).toEqual([]);
  });
});
