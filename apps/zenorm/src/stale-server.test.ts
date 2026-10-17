import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  RUNNER_RECORD_FILE,
  StaleServerError,
  stopStaleE2eServer,
  UNRECORDED_ROOT_MAX_AGE_MS,
} from "../e2e/stale-server.ts";

/**
 * The listener every case spawns as `node src/main.ts` (or `node -e`), on a port the OS picks: it
 * prints the port, then serves until signalled; `IGNORE_TERM=1` makes it ignore SIGTERM, and
 * `EXIT_AFTER_MS` makes it exit by itself after that long. Never port
 * 4600 (the e2e lock), which a running gate may hold.
 */
const LISTENER = `import { createServer } from "node:net";
if (process.env.IGNORE_TERM === "1") process.on("SIGTERM", () => {});
if (process.env.EXIT_AFTER_MS !== undefined) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS));
const server = createServer().listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\\n");
});
`;

let scratch: string;
const children: ChildProcess[] = [];
const roots: string[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "zenorm-stale-server-test-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  await rm(scratch, { recursive: true, force: true });
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface Listener {
  child: ChildProcess;
  pid: number;
  port: number;
}

async function listen(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<Listener> {
  const child = spawn("node", args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const { pid } = child;
  if (pid === undefined) {
    throw new Error("spawn gave no pid");
  }
  const port = await new Promise<number>((resolve) => {
    child.stdout.once("data", (chunk: Buffer) => {
      resolve(Number(chunk.toString().trim()));
    });
  });
  return { child, pid, port };
}

/** The signal that ends `child`. */
function exitSignal(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    child.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
}

/** A folder holding `src/main.ts`, so the listener's command is exactly `node src/main.ts`. */
async function appDir(): Promise<string> {
  const dir = join(scratch, "app");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), LISTENER);
  return dir;
}

interface RunnerRecord {
  pid: number;
  lstart: string;
}

function lstartOf(pid: number): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

/** A stand-in Playwright runner: the test's own child, idle until killed. */
function spawnRunner(): ChildProcess {
  const child = spawn("node", ["-e", "setInterval(() => {}, 1_000_000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("spawn gave no pid");
  }
  return child.pid;
}

/** A record of a live runner: the test's child, still running. */
function liveRunner(): RunnerRecord {
  const pid = pidOf(spawnRunner());
  return { pid, lstart: lstartOf(pid) };
}

/** A record of a runner that has exited (and been reaped), so `ps -p` no longer finds its pid. */
async function deadRunner(): Promise<RunnerRecord> {
  const child = spawnRunner();
  const pid = pidOf(child);
  const record = { pid, lstart: lstartOf(pid) };
  child.kill("SIGKILL");
  await once(child, "exit");
  expect(() => execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" })).toThrow();
  return record;
}

/**
 * A config file in a fresh `zenorm-e2e-*` folder of `tmpdir()`, as an e2e run's (unresolved),
 * with `record` as the root's runner record, or none.
 */
async function e2eConfig(record: RunnerRecord | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zenorm-e2e-"));
  roots.push(dir);
  const config = join(dir, "config.json");
  await writeFile(config, "{}");
  if (record !== null) {
    await writeFile(join(dir, RUNNER_RECORD_FILE), JSON.stringify(record));
  }
  return config;
}

function listening(port: number, pid: number): boolean {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    });
    return output.split("\n").includes(String(pid));
  } catch {
    return false;
  }
}

/** The guard's refusal, waiting for no live run. */
function staleError(port: number): StaleServerError {
  try {
    stopStaleE2eServer(port, 0);
  } catch (error) {
    if (error instanceof StaleServerError) {
      return error;
    }
    throw error;
  }
  throw new Error("the check did not throw");
}

describe("the e2e stale-server guard (S9-8, D7)", () => {
  test("a listener whose command does not match fails the check with its PID and command, untouched", async () => {
    const dummy = await listen(["--input-type=module", "-e", LISTENER], scratch, {});
    const error = staleError(dummy.port);
    expect(error.code).toBe("e2e_port_taken");
    expect(error.pid).toBe(dummy.pid);
    expect(error.command.startsWith("node --input-type=module -e")).toBe(true);
    expect(dummy.child.exitCode).toBeNull();
    expect(dummy.child.signalCode).toBeNull();
    expect(listening(dummy.port, dummy.pid)).toBe(true);
  });

  test("`node src/main.ts` whose ZENORM_CONFIG is no e2e run's fails the check, untouched", async () => {
    const config = join(scratch, "config.json");
    await writeFile(config, "{}");
    const dummy = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const error = staleError(dummy.port);
    expect(error.code).toBe("e2e_port_taken");
    expect(error.pid).toBe(dummy.pid);
    expect(error.command).toBe("node src/main.ts");
    expect(listening(dummy.port, dummy.pid)).toBe(true);
  });

  test("a stale e2e server (its runner gone) is stopped by SIGTERM and the port is free", async () => {
    const config = await e2eConfig(await deadRunner());
    // `tmpdir()` here may be a symlinked path (`/var/folders/…`); the check realpaths it.
    expect(await realpath(config)).toMatch(/\/zenorm-e2e-[^/]+\/config\.json$/);
    const stale = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const exited = exitSignal(stale.child);
    stopStaleE2eServer(stale.port, 0);
    expect(listening(stale.port, stale.pid)).toBe(false);
    expect(await exited).toBe("SIGTERM");
  });

  test(
    "a stale e2e server that ignores SIGTERM is killed after 10 s",
    { timeout: 30_000 },
    async () => {
      const config = await e2eConfig(await deadRunner());
      const stale = await listen(["src/main.ts"], await appDir(), {
        ZENORM_CONFIG: config,
        IGNORE_TERM: "1",
      });
      const exited = exitSignal(stale.child);
      const started = Date.now();
      stopStaleE2eServer(stale.port, 0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
      expect(await exited).toBe("SIGKILL");
    },
  );

  test("the server of a run whose runner is alive fails the check with the runner's PID, untouched", async () => {
    const runner = liveRunner();
    const config = await e2eConfig(runner);
    const live = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const error = staleError(live.port);
    expect(error.code).toBe("e2e_port_taken");
    expect(error.pid).toBe(live.pid);
    expect(error.runnerPid).toBe(runner.pid);
    expect(live.child.exitCode).toBeNull();
    expect(live.child.signalCode).toBeNull();
    expect(listening(live.port, live.pid)).toBe(true);
  });

  test("the server of a live run that ends within the wait is waited for, then the port is free", async () => {
    const runner = liveRunner();
    const config = await e2eConfig(runner);
    const live = await listen(["src/main.ts"], await appDir(), {
      ZENORM_CONFIG: config,
      EXIT_AFTER_MS: "1000",
    });
    const started = Date.now();
    stopStaleE2eServer(live.port, 30_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(listening(live.port, live.pid)).toBe(false);
  });

  test("a runner record whose pid is alive with another start time (pid reuse) is a stale run", async () => {
    const runner = liveRunner();
    const config = await e2eConfig({ pid: runner.pid, lstart: "Thu Jan  1 00:00:00 1970" });
    const stale = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const exited = exitSignal(stale.child);
    stopStaleE2eServer(stale.port, 0);
    expect(listening(stale.port, stale.pid)).toBe(false);
    expect(await exited).toBe("SIGTERM");
  });

  test("a root with no runner record younger than the limit fails the check, untouched", async () => {
    const config = await e2eConfig(null);
    const live = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const error = staleError(live.port);
    expect(error.code).toBe("e2e_port_taken");
    expect(error.pid).toBe(live.pid);
    expect(error.runnerPid).toBeNull();
    expect(listening(live.port, live.pid)).toBe(true);
  });

  test("a root with no runner record older than the limit is a stale run", async () => {
    const config = await e2eConfig(null);
    const old = new Date(Date.now() - UNRECORDED_ROOT_MAX_AGE_MS - 60_000);
    await utimes(config, old, old);
    const stale = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const exited = exitSignal(stale.child);
    stopStaleE2eServer(stale.port, 0);
    expect(listening(stale.port, stale.pid)).toBe(false);
    expect(await exited).toBe("SIGTERM");
  });

  test("a malformed runner record fails the check, untouched", async () => {
    const config = await e2eConfig(null);
    await writeFile(join(config, "..", RUNNER_RECORD_FILE), JSON.stringify({ pid: "x" }));
    const live = await listen(["src/main.ts"], await appDir(), { ZENORM_CONFIG: config });
    const error = staleError(live.port);
    expect(error.code).toBe("e2e_port_taken");
    expect(error.runnerPid).toBeNull();
    expect(listening(live.port, live.pid)).toBe(true);
  });

  test("a free port passes", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port");
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    expect(() => {
      stopStaleE2eServer(address.port, 0);
    }).not.toThrow();
  });
});
