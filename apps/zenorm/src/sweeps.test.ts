import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { descendantsOf, processTable, serverIdentity, type ServerIdentity } from "@zenorm/agent";
import { installChangeFeed, MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sweepRunFolders, sweepSessions } from "./sweeps.ts";

const execFileAsync = promisify(execFile);

let root: string;
let sessionsDir: string;
let logLines: string[];
function log(line: string): void {
  logLines.push(line);
}

/** Every pid this file spawned (or found below one it spawned); teardown sends each SIGKILL. */
const spawnedPids: number[] = [];
const children: ChildProcess[] = [];

function track(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("spawn gave no pid");
  children.push(child);
  spawnedPids.push(child.pid);
  return child.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Writes the session record for `pid`. `server` is the spawning server's fields, or null for
 * a record written before records named their server.
 */
async function writeRecord(
  pid: number,
  command: string,
  server: ServerIdentity | null,
  startedAt = new Date().toISOString(),
) {
  const base = { pid, command, startedAt, kind: "orchestrator" };
  const record = server === null ? base : { ...base, ...server };
  await writeFile(join(sessionsDir, `${String(pid)}.json`), JSON.stringify(record));
}

/** A server that has stopped: an exited pid. */
async function goneServer(): Promise<ServerIdentity> {
  return { serverPid: await exitedPid(), serverStartedAt: new Date().toISOString() };
}

/** A pid that now runs another process than the recorded server: this one, started an hour off. */
function reusedServer(): ServerIdentity {
  return {
    serverPid: process.pid,
    serverStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
}

async function psCommand(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

/**
 * Forks `command args` in its own group and stays its live parent, as a subreaper (systemd, a
 * container's init) adopts a stopped server's sessions where pid 1 would not. Prints the child's
 * pid, then waits for it.
 */
const SUBREAPER_PERL = [
  "my $p = fork(); die 'fork' unless defined $p;",
  'if ($p) { $| = 1; print "$p\\n"; waitpid($p, 0); exit 0 }',
  "POSIX::setsid();",
  "open(STDOUT, '>', '/dev/null');",
  "exec @ARGV or exit 127;",
].join(" ");

/** Starts `command args` under a live stand-in subreaper; returns both pids once it runs `command`. */
async function underSubreaper(
  command: string,
  args: string[],
): Promise<{ pid: number; reaper: ChildProcess }> {
  const reaper = spawn("perl", ["-MPOSIX", "-e", SUBREAPER_PERL, command, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const reaperPid = track(reaper);
  let out = "";
  reaper.stdout.setEncoding("utf8");
  reaper.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  await until(() => out.includes("\n"), "the stand-in subreaper to print its child's pid");
  const pid = Number(out.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`The subreaper printed no pid: ${out}`);
  spawnedPids.push(pid, -pid);
  await until(
    async () => (await psCommand(pid)).startsWith(command),
    `process ${String(pid)} to run ${command}`,
  );
  expect((await processTable()).find((row) => row.pid === pid)?.ppid).toBe(reaperPid);
  return { pid, reaper };
}

/**
 * Forks, prints the child's pid and exits, so the child is orphaned (reparented to pid 1, or to a
 * subreaper above this test runner, as a crashed server's sessions are); the child leads its own
 * group when `-s` comes first.
 */
const ORPHAN_PERL = [
  "my $own = $ARGV[0] eq '-s'; shift @ARGV if $own;",
  "my $p = fork(); die 'fork' unless defined $p;",
  'if ($p) { print "$p\\n"; exit 0 }',
  "POSIX::setsid() if $own;",
  "open(STDOUT, '>', '/dev/null');",
  "exec @ARGV or exit 127;",
].join(" ");

/** Starts `argv` as an orphan and returns its pid once `ps` shows it reparented. */
async function orphan(argv: string[], ownGroup: boolean): Promise<number> {
  const perl = spawn("perl", ["-MPOSIX", "-e", ORPHAN_PERL, ...(ownGroup ? ["-s"] : []), ...argv], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const forker = perl.pid;
  if (forker === undefined) throw new Error("spawn gave no pid");
  let out = "";
  perl.stdout.setEncoding("utf8");
  perl.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  await once(perl, "close");
  const pid = Number(out.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`The orphan printed no pid: ${out}`);
  spawnedPids.push(pid);
  if (ownGroup) spawnedPids.push(-pid);
  await until(async () => {
    const ppid = (await processTable()).find((row) => row.pid === pid)?.ppid;
    return ppid !== undefined && ppid !== forker;
  }, "the orphan to be reparented");
  return pid;
}

async function exitedPid(): Promise<number> {
  const child = spawn("/usr/bin/true");
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("spawn gave no pid");
  return child.pid;
}

beforeEach(async () => {
  logLines = [];
  root = await mkdtemp(join(tmpdir(), "zenorm-sweeps-"));
  sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
});

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone: the sweep under test killed it.
    }
  }
  await Promise.all(
    children
      .splice(0)
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => once(child, "exit")),
  );
  await rm(root, { recursive: true, force: true });
});

describe("sweepSessions", () => {
  test("kills an orphaned session's group and a grandchild in a separate group", async () => {
    // sh (group leader) -> inner sh -> perl, which leaves for its own session and becomes sleep.
    const script = join(root, "session.sh");
    await writeFile(
      script,
      [
        'trap "" TERM',
        `/bin/sh -c 'perl -MPOSIX -e "POSIX::setsid(); exec q(sleep), q(600)" & wait' &`,
        // `& wait`: a bare last `sleep` would be exec'd in place of the shell, and ps would show it.
        "sleep 600 & wait",
        "",
      ].join("\n"),
    );
    const shellPid = await orphan(["/bin/sh", script], true);
    let grandchild: number | undefined;
    await until(async () => {
      const table = await processTable();
      const below = descendantsOf(shellPid, table);
      grandchild = table.find(
        (row) => below.includes(row.pid) && row.pgid !== shellPid && row.ppid !== shellPid,
      )?.pid;
      return grandchild !== undefined;
    }, "the grandchild in its own group");
    if (grandchild === undefined) throw new Error("unreachable");
    spawnedPids.push(grandchild);
    await writeRecord(shellPid, "/bin/sh", await goneServer());

    await sweepSessions(sessionsDir, log);

    await until(() => !alive(shellPid), "the session to be gone");
    const separate = grandchild;
    await until(() => !alive(separate), "the grandchild to be gone");
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("stops the group of an app a capture left running, as its record names it", async () => {
    // A started app's group: the start command leads it, with a child (its dev server, say).
    const script = join(root, "app.sh");
    await writeFile(script, ["sleep 600 &", "sleep 600 & wait", ""].join("\n"));
    const pid = await orphan(["/bin/sh", script], true);
    let child: number | undefined;
    await until(async () => {
      child = descendantsOf(pid, await processTable())[0];
      return child !== undefined;
    }, "the app's child");
    if (child === undefined) throw new Error("unreachable");
    spawnedPids.push(child);
    // Core's app record: the command as `ps` showed it after the start, kind `app`.
    const record = {
      pid,
      command: await psCommand(pid),
      startedAt: new Date().toISOString(),
      kind: "app",
      ...(await goneServer()),
    };
    await writeFile(join(sessionsDir, `${String(pid)}.json`), JSON.stringify(record));

    await sweepSessions(sessionsDir, log);

    await until(() => !alive(pid), "the app to be gone");
    const appChild = child;
    await until(() => !alive(appChild), "the app's child to be gone");
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain("app session");
  });

  test("signals the pid alone when it does not lead its own group", async () => {
    // Without setsid, the orphan stays in this test runner's group.
    const pid = await orphan(["/bin/sleep", "600"], false);
    await writeRecord(pid, "/bin/sleep", await goneServer());

    await sweepSessions(sessionsDir, log);

    await until(() => !alive(pid), "the session to be gone");
    expect(alive(process.pid)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  test("kills a session whose server is gone while a live stand-in subreaper is its parent", async () => {
    const { pid, reaper } = await underSubreaper("/bin/sleep", ["600"]);
    await writeRecord(pid, "/bin/sleep", await goneServer());

    await sweepSessions(sessionsDir, log);

    await until(() => !alive(pid), "the session to be gone");
    // The subreaper had no signal: it exits on its own once its child is gone.
    expect(reaper.signalCode).toBeNull();
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("spares a session whose recorded server still runs with the recorded start time", async () => {
    // A live server's session: the server is this test process, as `ps` shows it.
    const { pid, reaper } = await underSubreaper("/bin/sleep", ["600"]);
    await writeRecord(pid, "/bin/sleep", serverIdentity());

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(reaper.signalCode).toBeNull();
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("kills a session whose server pid now runs a process started at another time", async () => {
    const { pid } = await underSubreaper("/bin/sleep", ["600"]);
    await writeRecord(pid, "/bin/sleep", reusedServer());

    await sweepSessions(sessionsDir, log);

    await until(() => !alive(pid), "the session to be gone");
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test.each([
    {
      name: "started at another time than its record says",
      command: "/bin/sleep",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    { name: "runs another command", command: "/nowhere/claude", startedAt: undefined },
  ])("spares a reused server pid's session when it $name", async ({ command, startedAt }) => {
    const { pid } = await underSubreaper("/bin/sleep", ["600"]);
    await writeRecord(pid, command, reusedServer(), startedAt);

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("without server fields, kills an orphan whose parent is pid 1", async () => {
    const pid = await orphan(["/bin/sleep", "600"], true);
    // The older rule needs pid 1 to adopt the orphan: no subreaper above this test runner.
    expect((await processTable()).find((row) => row.pid === pid)?.ppid).toBe(1);
    await writeRecord(pid, "/bin/sleep", null);

    await sweepSessions(sessionsDir, log);

    await until(() => !alive(pid), "the session to be gone");
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("without server fields, spares a live process whose parent still runs", async () => {
    // A live server's session, or the person's own `claude`: its parent is not pid 1.
    const sleeper = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
    const pid = track(sleeper);
    await writeRecord(pid, "/bin/sleep", null);

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(sleeper.signalCode).toBeNull();
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("without server fields, spares a session under a live stand-in subreaper", async () => {
    const { pid } = await underSubreaper("/bin/sleep", ["600"]);
    await writeRecord(pid, "/bin/sleep", null);

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("spares an orphan that started at another time than its record says", async () => {
    const pid = await orphan(["/bin/sleep", "600"], true);
    await writeRecord(
      pid,
      "/bin/sleep",
      await goneServer(),
      new Date(Date.now() - 3_600_000).toISOString(),
    );

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("spares an orphan whose command only starts with the recorded one, not on a word", async () => {
    // The record names `<root>/sleep`; the orphan runs `<root>/sleep-foo`.
    const longer = join(root, "sleep-foo");
    await symlink("/bin/sleep", longer);
    const pid = await orphan([longer, "600"], true);
    await writeRecord(pid, join(root, "sleep"), await goneServer());

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("removes a record whose pid now runs another command, without a signal", async () => {
    const pid = await orphan(["/bin/sleep", "600"], true);
    await writeRecord(pid, "/nowhere/claude", await goneServer());

    await sweepSessions(sessionsDir, log);

    expect(alive(pid)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  test("removes a record for a dead pid", async () => {
    await writeRecord(await exitedPid(), "/nowhere/claude", await goneServer());

    await sweepSessions(sessionsDir, log);

    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test.each([
    { name: "not JSON", text: "{ pid: " },
    { name: "the wrong shape", text: JSON.stringify({ pid: "12", command: "/bin/sh" }) },
    {
      name: "an unknown kind",
      text: JSON.stringify({ pid: 12, command: "/bin/sh", startedAt: "", kind: "other" }),
    },
    {
      name: "a numeric startedAt",
      text: JSON.stringify({ pid: 12, command: "/bin/sh", startedAt: 1, kind: "planning" }),
    },
    {
      name: "a server pid without the server's start time",
      text: JSON.stringify({
        pid: 12,
        command: "/bin/sh",
        startedAt: new Date().toISOString(),
        kind: "planning",
        serverPid: 34,
      }),
    },
    {
      name: "a server start time that is not a time",
      text: JSON.stringify({
        pid: 12,
        command: "/bin/sh",
        startedAt: new Date().toISOString(),
        kind: "planning",
        serverPid: 34,
        serverStartedAt: "yesterday",
      }),
    },
  ])("removes a broken record: $name", async ({ text }) => {
    await writeFile(join(sessionsDir, "12.json"), text);

    await sweepSessions(sessionsDir, log);

    expect(await readdir(sessionsDir)).toEqual([]);
    expect(logLines).toHaveLength(1);
  });

  test("an absent sessions folder is fine", async () => {
    await sweepSessions(join(root, "absent"), log);
    expect(logLines).toEqual([]);
  });
});

describe("sweepRunFolders", () => {
  let db: ZeNormDatabase;
  let runsDir: string;
  const knownRunId = "019a0000-0000-7000-8000-000000000001";

  beforeEach(() => {
    const opened = openDatabase(join(root, "zenorm.sqlite"));
    if (!opened.ok) throw new Error(opened.error.code);
    db = opened.value;
    const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
    if (!migrated.ok) throw new Error(migrated.error.code);
    runsDir = join(root, "runs");
    // The database is opened as startup opens it: the feed's triggers in place.
    installChangeFeed(db);
    // The sweep reads only `delivery_runs.id`; the run's other parents are not needed for that.
    // The row still carries the one User, and is written as the system, as every write is.
    db.$client.pragma("foreign_keys = OFF");
    db.$client.prepare(`INSERT INTO write_actor (id, actor_kind) VALUES (1, 'system')`).run();
    db.$client
      .prepare(
        `INSERT INTO delivery_runs (id, project_id, specification_id, ticket_set_id, number, branch,
           worktree_path, base_branch, base_commit, checks, phase, started_at, user_id, executor)
         VALUES (?, 'p', 's', 't', 1, 'zenorm/run-1', ?, 'main', 'abc', '[]', 'preparing', ?,
           (SELECT id FROM users), 'local')`,
      )
      .run(knownRunId, join(runsDir, knownRunId, "worktree"), new Date().toISOString());
    db.$client.prepare(`DELETE FROM write_actor`).run();
  });

  afterEach(() => {
    db.$client.close();
  });

  test("removes a folder with no run and keeps a known run's folder", async () => {
    await mkdir(join(runsDir, knownRunId, "worktree"), { recursive: true });
    await mkdir(join(runsDir, "bogus", "tickets"), { recursive: true });
    await writeFile(join(runsDir, "stray-file"), "x");

    await sweepRunFolders(db, runsDir, log);

    expect(await readdir(runsDir)).toEqual([knownRunId]);
    expect((await stat(join(runsDir, knownRunId, "worktree"))).isDirectory()).toBe(true);
    expect(logLines).toHaveLength(2);
  });

  test("removes a symlink without following it out of the runs folder", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "x");
    await mkdir(runsDir);
    await symlink(outside, join(runsDir, "link"));

    await sweepRunFolders(db, runsDir, log);

    expect(await readdir(runsDir)).toEqual([]);
    expect(await readdir(outside)).toEqual(["keep"]);
  });

  test("an absent runs folder is fine", async () => {
    await sweepRunFolders(db, runsDir, log);
    expect(logLines).toEqual([]);
  });
});
