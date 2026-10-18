import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DeliveryRun,
  InstanceConfig,
  MapDetail,
  MapOverviewDetail,
  Project,
  ProjectInspection,
  QuestionRound,
  SONNET_LIMITS,
} from "@zenorm/contracts";

import { PACKAGED_ASSET_DIRS } from "../src/packaged.ts";
import { packedTarball } from "./packed.ts";

/**
 * The install smoke test, run by CI on Linux after the `pack` task: installs
 * the packed `@ze-norm/cli` with npm into an empty folder outside the repository and checks that
 * better-sqlite3 came from its bundled prebuild, with no node-gyp compile, and is the only
 * runtime dependency. `zenorm --help` and `--version` exit 0 and an unknown option is refused
 * `arguments_invalid`. With a config whose
 * `agent.claudePath` is the repository's stand-in claude (signed in), `zenorm doctor` passes every
 * check; `zenorm run` serves the shipped web app over a freshly migrated database; and one map is
 * driven over `/rpc` from idea to a passed delivery run, so the stand-in planning sessions (To Spec,
 * the planning reviews, To Tickets) and delivery sessions (orchestrator, reviewer) all run on the
 * skills the installed package ships: a missing one would stop its run with `agent_skill_missing`.
 *
 * Not part of `pnpm check`: it installs from the npm registry. Run it with
 * `pnpm exec turbo run pack --filter=@ze-norm/cli && pnpm --filter @ze-norm/cli smoke`.
 */

const HOST = "127.0.0.1";
/** The stand-in checks every call's `--model` and `--effort` against these. */
const MODEL = "claude-sonnet-5-5";
const EFFORT = "medium";
/** The stand-in confirms this idea's map with no waypoints, so it clears at once (`fake-claude.ts`). */
const IDEA = "Export every record as a CSV file [fake:no-waypoints]";
/** A required check that passes in any repository. */
const PASSING_CHECK = "git status --short";
/** `apps/zenorm/src/startup.ts`'s `DATABASE_FILE`, inside the config's `dataDir`. */
const DATABASE_FILE = "zenorm.sqlite";
const POLL_MS = 250;
/** How long one step (a planning stage, the delivery run) may take before the test fails. */
const STEP_TIMEOUT_MS = 120_000;
/** How long `zenorm run` has to exit on SIGTERM before it is killed. */
const STOP_TIMEOUT_MS = 15_000;
const FAKE_CLAUDE = createRequire(import.meta.url).resolve("@zenorm/zenorm/e2e/fake-claude");

type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

/** The running `zenorm run` and the URL it listens on. */
interface Smoke {
  readonly url: string;
  readonly server: ServerProcess;
}

function step(line: string): void {
  console.log(`\n== ${line}`);
}

/**
 * The environment the installed command runs in: this process's, without the variables that
 * would change what it reads (`--config` names the config; the stand-in is signed in).
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ZENORM_CONFIG;
  delete env.ZENORM_FAKE_AUTH_FILE;
  return env;
}

/**
 * Installs the tarball with npm into `installDir`, an empty folder with only a private manifest,
 * printing npm's output with every install script's output: node-gyp logs each line with `gyp`, and
 * any compile writes `build/`. better-sqlite3 ships its binaries in `prebuilds/`, so a clean install
 * has no `build/`, and the installed copy must load and run a query.
 */
function installPackage(installDir: string, tarball: string): void {
  const manifest = { name: "zenorm-smoke", private: true };
  writeFileSync(join(installDir, "package.json"), `${JSON.stringify(manifest)}\n`);
  const install = spawnSync(
    "npm",
    ["install", "--foreground-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: installDir, encoding: "utf8", env: childEnv() },
  );
  if (install.error !== undefined) throw install.error;
  const output = `${install.stdout}${install.stderr}`;
  process.stdout.write(output);
  if (install.status !== 0) {
    throw new Error(`npm install exited ${String(install.status)}`);
  }
  if (/^gyp /m.test(output)) {
    throw new Error("npm install compiled better-sqlite3 with node-gyp instead of its prebuild");
  }
  const build = join(installDir, "node_modules", "better-sqlite3", "build");
  if (existsSync(build)) {
    throw new Error(`better-sqlite3 was built by node-gyp (${build})`);
  }
  const load = spawnSync(
    process.execPath,
    ["-e", 'new (require("better-sqlite3"))(":memory:").prepare("select 1").get()'],
    { cwd: installDir, encoding: "utf8", env: childEnv() },
  );
  if (load.error !== undefined) throw load.error;
  if (load.status !== 0) {
    throw new Error(`better-sqlite3 does not load from the install:\n${load.stderr}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The installed package's manifest, as the tarball published it. */
function readInstalledManifest(packageDir: string): Record<string, unknown> {
  const path = join(packageDir, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(manifest)) throw new Error(`${path} is not a JSON object`);
  return manifest;
}

/** How one `zenorm` run ended. */
interface BinRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the installed `zenorm` with `args` to its end; its output is printed too. */
function runBin(bin: string, args: readonly string[]): BinRun {
  const run = spawnSync(bin, [...args], { encoding: "utf8", env: childEnv() });
  if (run.error !== undefined) throw run.error;
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Whether `line` is a JSON object or array, as a JSON refusal line would be. */
function isJsonLine(line: string): boolean {
  if (!line.startsWith("{") && !line.startsWith("[")) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * The published manifest's only runtime dependency is better-sqlite3 (the command library is
 * bundled); `zenorm --help` and `zenorm --version` exit 0, the version the manifest's; and an
 * unknown option exits 1 with a readable `arguments_invalid` refusal on stderr (no terminal), no
 * line of it JSON.
 */
function checkCommandLine(bin: string, packageDir: string): void {
  const { dependencies, version: published } = readInstalledManifest(packageDir);
  if (!isRecord(dependencies) || Object.keys(dependencies).join(",") !== "better-sqlite3") {
    throw new Error(
      `The published dependencies are ${JSON.stringify(dependencies)}; only better-sqlite3 is expected`,
    );
  }
  if (typeof published !== "string") {
    throw new Error("The published manifest has no version");
  }
  const help = runBin(bin, ["--help"]);
  if (help.status !== 0 || !help.stdout.startsWith("Usage: zenorm ")) {
    throw new Error(`zenorm --help exited ${String(help.status)} without its usage on stdout`);
  }
  const version = runBin(bin, ["--version"]);
  if (version.status !== 0 || version.stdout !== `${published}\n`) {
    throw new Error(
      `zenorm --version exited ${String(version.status)} printing ${JSON.stringify(version.stdout)}, not ${published}`,
    );
  }
  const unknown = runBin(bin, ["run", "--bogus"]);
  const lines = unknown.stderr.split("\n");
  if (
    unknown.status !== 1 ||
    !lines.includes("  code: arguments_invalid") ||
    lines.some((line) => isJsonLine(line))
  ) {
    throw new Error(
      `zenorm run --bogus exited ${String(unknown.status)} without a readable arguments_invalid refusal: ${unknown.stderr}`,
    );
  }
}

/** A port free on `HOST` now. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The port probe has no TCP address"));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

/** The config `zenorm run` reads: the stand-in claude, a fresh `dataDir`, no plugins. */
function writeConfig(root: string, port: number, dataDir: string): string {
  const config = InstanceConfig.parse({
    server: { host: HOST, port },
    dataDir,
    agent: {
      claudePath: FAKE_CLAUDE,
      wayfindingModel: MODEL,
      specModel: MODEL,
      models: { [MODEL]: SONNET_LIMITS },
      effort: EFFORT,
      maxTurns: 12,
      timeoutSeconds: 30,
    },
    delivery: {
      model: MODEL,
      effort: EFFORT,
      orchestratorMaxTurns: 50,
      orchestratorTimeoutMinutes: 2,
      reviewerMaxTurns: 20,
      reviewerTimeoutMinutes: 2,
      checkTimeoutMinutes: 1,
      executor: "local",
    },
    plugins: {},
  });
  const file = join(root, "config.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** `zenorm doctor` must exit 0 with every check passing (`ok`), none failed or skipped. */
function runDoctor(bin: string, configFile: string): void {
  const doctor = spawnSync(bin, ["doctor", "--config", configFile], {
    encoding: "utf8",
    env: childEnv(),
  });
  if (doctor.error !== undefined) throw doctor.error;
  process.stdout.write(doctor.stdout);
  process.stderr.write(doctor.stderr);
  const lines = doctor.stdout.split("\n").filter((line) => line !== "");
  const notPassing = lines.filter((line) => !line.startsWith("ok "));
  if (doctor.status !== 0 || lines.length === 0 || notPassing.length > 0) {
    throw new Error(
      `zenorm doctor exited ${String(doctor.status)} with checks not passing: ${notPassing.join("; ")}`,
    );
  }
}

/** Starts `zenorm run` and resolves once it prints its listening line on `url`. */
async function startServer(bin: string, configFile: string, url: string): Promise<ServerProcess> {
  const child = spawn(bin, ["run", "--config", configFile], {
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const onExit = (code: number | null): void => {
      reject(new Error(`zenorm run exited (${String(code)}) before listening`));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdout += chunk.toString();
      if (stdout.includes(`ZeNorm listening on ${url}`)) {
        child.off("exit", onExit);
        resolve();
      }
    });
    child.once("exit", onExit);
  });
  return child;
}

function exited(server: ServerProcess): boolean {
  return server.exitCode !== null || server.signalCode !== null;
}

/** SIGTERM, then SIGKILL past `STOP_TIMEOUT_MS`; the server must stop in order, exit code 0. */
async function stopServer(server: ServerProcess): Promise<void> {
  if (exited(server)) {
    throw new Error(`zenorm run exited (${String(server.exitCode)}) before it was stopped`);
  }
  const exit = new Promise<number | null>((resolve) => {
    server.once("exit", (code) => {
      resolve(code);
    });
  });
  server.kill("SIGTERM");
  const timer = setTimeout(() => {
    server.kill("SIGKILL");
  }, STOP_TIMEOUT_MS);
  const code = await exit;
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`zenorm run exited ${String(code)} on SIGTERM`);
  }
}

/** Calls an oRPC procedure over `/rpc/<path>` and returns its answer's JSON; a refusal fails. */
async function rpc(smoke: Smoke, path: string, input: unknown): Promise<unknown> {
  const response = await fetch(`${smoke.url}/rpc/${path}`, {
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

/**
 * The codes of every stopped planning run the overview shows: a next action's, a spec review's,
 * a To Tickets run's or a tickets review's. A missing skill stops its run with
 * `agent_skill_missing`.
 */
function stoppedCodes(view: MapOverviewDetail): string[] {
  const codes: string[] = [];
  for (const action of view.status.next) {
    if (action.stopped !== null) codes.push(action.stopped.code);
  }
  for (const spec of view.specs) {
    for (const revision of spec.revisions) {
      if (revision.review.state === "stopped") codes.push(revision.review.stopped.code);
    }
    if (spec.draftingTickets !== null && spec.draftingTickets !== "running") {
      codes.push(spec.draftingTickets.stopped.code);
    }
    for (const { review } of spec.ticketSets) {
      if (review !== null && review.state === "stopped") codes.push(review.stopped.code);
    }
  }
  return codes;
}

/** The map's overview; a stopped planning run fails the test with its code. */
async function overview(smoke: Smoke, mapId: string): Promise<MapOverviewDetail> {
  const view = MapOverviewDetail.parse(await rpc(smoke, "map/overview", { mapId }));
  const codes = stoppedCodes(view);
  if (codes.length > 0) {
    throw new Error(`A planning run stopped: ${codes.join(", ")}`);
  }
  return view;
}

/** Polls `read` until it returns a value; fails past `STEP_TIMEOUT_MS` or if the server exits. */
async function waitFor<T>(
  smoke: Smoke,
  what: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    if (exited(smoke.server)) {
      throw new Error(`zenorm run exited while the test waited for ${what}`);
    }
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`Waited ${String(STEP_TIMEOUT_MS / 1000)} s for ${what}`);
    }
    await sleep(POLL_MS);
  }
}

/** A git repository at `<root>/project` with one commit on `main`, for the map's project. */
function createRepository(root: string): string {
  const repo = join(root, "project");
  const identity = ["-c", "user.name=zenorm-smoke", "-c", "user.email=smoke@zenorm.invalid"];
  execFileSync("git", [...identity, "init", "-q", "-b", "main", repo], { stdio: "inherit" });
  execFileSync("git", [...identity, "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], {
    stdio: "inherit",
  });
  return repo;
}

/**
 * Drives one map in the repository at `repo` from idea to a passed delivery run, as the person
 * would with every recommendation accepted: the destination round, the spec and its tickets once
 * each review passed, the required check, then Start delivery.
 */
async function deliverOneMap(smoke: Smoke, repo: string): Promise<void> {
  const inspection = ProjectInspection.parse(
    await rpc(smoke, "project/inspect", { folderPath: repo }),
  );
  if (inspection.detectedBaseBranch === null) {
    throw new Error(`${repo} has no branch checked out`);
  }
  const project = Project.parse(
    await rpc(smoke, "project/create", {
      folderPath: inspection.folderPath,
      baseBranch: inspection.detectedBaseBranch,
    }),
  );
  const { map } = MapDetail.parse(
    await rpc(smoke, "map/create", { projectId: project.id, idea: IDEA }),
  );
  const mapId = map.id;

  step("Planning: the destination round");
  const round = await waitFor(smoke, "the destination round", async () => {
    const view = await overview(smoke, mapId);
    return view.wayfinding.mapRounds.find((candidate) => candidate.status === "pending");
  });
  QuestionRound.parse(
    await rpc(smoke, "questionRound/submit", {
      roundId: round.id,
      answers: round.questions.map(() => ({ optionIndex: 0, note: "", accepted: true })),
    }),
  );

  step("Planning: the spec and its review");
  const revision = await waitFor(smoke, "the spec's passed review", async () => {
    const view = await overview(smoke, mapId);
    const latest = view.specs.at(0)?.revisions.at(-1);
    if (latest === undefined) return undefined;
    if (latest.review.state === "findings") {
      throw new Error(`The spec review found: ${latest.review.summary}`);
    }
    return latest.state === "draft" && latest.review.state === "passed" ? latest : undefined;
  });
  MapOverviewDetail.parse(await rpc(smoke, "spec/approve", { specRevisionId: revision.id }));

  step("Planning: the tickets and their review");
  const ticketSet = await waitFor(smoke, "the tickets' passed review", async () => {
    const view = await overview(smoke, mapId);
    const latest = view.specs.at(0)?.ticketSets.at(-1);
    if (latest === undefined) return undefined;
    if (latest.review === null) return undefined;
    if (latest.review.state === "findings") {
      throw new Error(`The tickets review found: ${latest.review.summary}`);
    }
    return latest.review.state === "passed" ? latest : undefined;
  });
  MapOverviewDetail.parse(await rpc(smoke, "ticketSet/approve", { ticketSetId: ticketSet.id }));

  step("Delivery: one run");
  Project.parse(
    await rpc(smoke, "project/saveSettings", {
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK],
      // A project needs a saved repair limit before it can start delivery; 0 is no repair.
      repairLimit: 0,
      fixCommands: [],
      appStartCommand: null,
      appUrl: null,
      appSetupCommands: [],
    }),
  );
  const run = DeliveryRun.parse(await rpc(smoke, "delivery/start", { ticketSetId: ticketSet.id }));
  const ended = await waitFor(smoke, "the delivery run's end", async () => {
    const view = await overview(smoke, mapId);
    const found = view.specs.at(0)?.runs.find((candidate) => candidate.id === run.id);
    return found !== undefined && found.state !== "running" ? found : undefined;
  });
  if (ended.state !== "passed") {
    const failure = ended.failure === null ? "" : `: ${ended.failure.code}`;
    throw new Error(`The delivery run ended ${ended.state}${failure}`);
  }
}

const tarball = packedTarball();
const root = mkdtempSync(join(tmpdir(), "zenorm-smoke-"));
const installDir = join(root, "install");
const dataDir = join(root, "data");
mkdirSync(installDir);
mkdirSync(dataDir);

step(`Installing ${tarball} into ${installDir}`);
installPackage(installDir, tarball);
const bin = join(installDir, "node_modules", ".bin", "zenorm");
const installedPackage = join(installDir, "node_modules", "@ze-norm", "cli");
const installedDist = join(installedPackage, "dist");

step("zenorm --help, --version and an unknown option");
checkCommandLine(bin, installedPackage);

const port = await freePort();
const url = `http://${HOST}:${String(port)}`;
const configFile = writeConfig(root, port, dataDir);

step("zenorm doctor, before the first run");
runDoctor(bin, configFile);

step("zenorm run");
const server = await startServer(bin, configFile, url);
try {
  const smoke: Smoke = { url, server };
  const page = await fetch(`${url}/`);
  const html = await page.text();
  const shippedIndex = join(installedDist, PACKAGED_ASSET_DIRS.webDistDir, "index.html");
  if (!page.ok || html !== readFileSync(shippedIndex, "utf8")) {
    throw new Error(`GET / did not answer the shipped ${shippedIndex}`);
  }
  if (!existsSync(join(dataDir, DATABASE_FILE))) {
    throw new Error(`zenorm run left no database in ${dataDir}`);
  }
  await deliverOneMap(smoke, createRepository(root));
  step("Stopping zenorm run");
  await stopServer(server);
} finally {
  if (!exited(server)) server.kill("SIGKILL");
}

step("zenorm doctor, over the migrated database");
runDoctor(bin, configFile);

rmSync(root, { recursive: true, force: true });
step("The install smoke test passed");
