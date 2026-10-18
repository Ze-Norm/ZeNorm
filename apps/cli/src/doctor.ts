import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { err, ok } from "@zenorm/contracts";
import type { InstanceConfig, Result, StartupError } from "@zenorm/contracts";
import {
  checkCaptureBrowser,
  checkClaudePath,
  checkDatabase,
  checkDataDir,
  checkSignIn,
  checkWebBuild,
  loadConfig,
} from "@zenorm/zenorm/startup";

import { cliConfigPath, withInitHint } from "./cli.ts";
import type { Command, CommandContext, Env } from "./cli.ts";
import { CLAUDE_COMMAND, claudeMissing, findOnPath } from "./init.ts";

/** How long `git --version` may take. */
const GIT_TIMEOUT_MS = 10_000;

/** What doctor checks, in the order it reports them. */
export const DOCTOR_CHECKS = [
  "platform",
  "node",
  "config",
  "data_dir",
  "claude",
  "sign_in",
  "git",
  "web_build",
  "database",
  "capture_browser",
] as const;
export type DoctorCheckName = (typeof DOCTOR_CHECKS)[number];

/**
 * A check passed, failed with its code, found a problem it only reports (with its code; doctor
 * still exits 0), or could not run because a check it needs failed.
 */
export type DoctorOutcome =
  | { readonly kind: "passed"; readonly detail: string }
  | { readonly kind: "failed"; readonly error: StartupError }
  | { readonly kind: "reported"; readonly error: StartupError }
  | { readonly kind: "skipped"; readonly reason: string };

export interface DoctorCheck {
  readonly name: DoctorCheckName;
  readonly outcome: DoctorOutcome;
}

function passed(name: DoctorCheckName, detail: string): DoctorCheck {
  return { name, outcome: { kind: "passed", detail } };
}

function skipped(name: DoctorCheckName, reason: string): DoctorCheck {
  return { name, outcome: { kind: "skipped", reason } };
}

/** The check `name` from `result`: passed with `detail` of its value, or failed with its error. */
function outcome<T>(
  name: DoctorCheckName,
  result: Result<T, StartupError>,
  detail: (value: T) => string,
): DoctorCheck {
  if (!result.ok) return { name, outcome: { kind: "failed", error: result.error } };
  return passed(name, detail(result.value));
}

/** git must run (`git_missing`): projects and delivery runs call it. */
function checkGit(env: Env): Promise<Result<string, StartupError>> {
  return new Promise((resolveCheck) => {
    execFile(
      "git",
      ["--version"],
      { env, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error === null) {
          resolveCheck(ok(stdout.trim()));
          return;
        }
        resolveCheck(
          err({
            code: "git_missing",
            message: `git cannot run (${error.message}); install git and put it on PATH`,
            subject: "git",
          }),
        );
      },
    );
  });
}

/** The config file `run` would read, as an absolute path, and the config it holds. */
interface LoadedConfig {
  readonly file: string;
  readonly config: InstanceConfig;
}

async function readConfig(context: CommandContext): Promise<Result<LoadedConfig, StartupError>> {
  const path = cliConfigPath(context.config, context.env);
  if (!path.ok) return path;
  const config = await loadConfig(path.value);
  if (!config.ok) return err(withInitHint(config.error));
  return ok({ file: resolve(path.value), config: config.value });
}

/** The checks of what the config names; the database's and the browser's come last. */
interface ConfigChecks {
  readonly before: readonly DoctorCheck[];
  readonly database: DoctorCheck;
  readonly captureBrowser: DoctorCheck;
}

/**
 * The screenshot browser's check, once the database check passed: the Chromium build found
 * passes; missing, it fails doctor only when some project has screenshot capture on, and is
 * reported otherwise.
 */
function captureBrowserCheck(context: CommandContext, dataDir: string): DoctorCheck {
  const name = "capture_browser";
  const checked = checkCaptureBrowser(dataDir, context.assets.migrationsFolder, context.env);
  if (!checked.ok) return { name, outcome: { kind: "failed", error: checked.error } };
  const { captureOn, browser } = checked.value;
  if (browser.ok) return passed(name, browser.value.executablePath);
  return { name, outcome: { kind: captureOn ? "failed" : "reported", error: browser.error } };
}

/**
 * The checks without a valid config: the claude `zenorm init` would find on `PATH` (as init,
 * `agent_cli_missing` without one); the rest need the config.
 */
async function withoutConfig(env: Env): Promise<ConfigChecks> {
  const found = await findOnPath(CLAUDE_COMMAND, env);
  const onPath = found === null ? err(claudeMissing()) : ok(found);
  const claude = outcome("claude", onPath, (path) => `${path} on PATH; no config names one yet`);
  return {
    before: [
      skipped("data_dir", "needs a valid config"),
      claude,
      skipped("sign_in", "needs a valid config"),
    ],
    database: skipped("database", "needs a valid config"),
    captureBrowser: skipped("capture_browser", "needs the database check"),
  };
}

const DATABASE_DETAIL = {
  absent: "no database yet; zenorm run creates it",
  current: "every applied migration ships with this build",
} as const;

/**
 * The checks of the config's contents: the data folder, the claude executable, its sign-in
 * with the method, and the database opened read-only. One that needs a failed check is skipped.
 */
async function configChecks(
  context: CommandContext,
  config: InstanceConfig,
): Promise<ConfigChecks> {
  const { dataDir } = config;
  const { claudePath, timeoutSeconds } = config.agent;
  const dataDirChecked = await checkDataDir(dataDir);
  const claude = await checkClaudePath(claudePath);
  let signIn = skipped("sign_in", "needs the claude executable");
  if (claude.ok) {
    const method = await checkSignIn(claudePath, context.env, timeoutSeconds * 1000);
    signIn = outcome("sign_in", method, (value) => `signed in (${value})`);
  }
  let database = skipped("database", "needs the data folder");
  if (dataDirChecked.ok) {
    const state = checkDatabase(dataDir, context.assets.migrationsFolder);
    database = outcome("database", state, (found) => DATABASE_DETAIL[found]);
  }
  const captureBrowser =
    database.outcome.kind === "passed"
      ? captureBrowserCheck(context, dataDir)
      : skipped("capture_browser", "needs the database check");
  return {
    before: [
      outcome("data_dir", dataDirChecked, () => dataDir),
      outcome("claude", claude, () => claudePath),
      signIn,
    ],
    database,
    captureBrowser,
  };
}

/**
 * `zenorm doctor`'s checks, every one run whatever an earlier one found, writing
 * nothing. Arguments it does not accept were refused (`arguments_invalid`) before it ran.
 */
export async function runDoctor(context: CommandContext): Promise<readonly DoctorCheck[]> {
  const loaded = await readConfig(context);
  const ofConfig = loaded.ok
    ? await configChecks(context, loaded.value.config)
    : await withoutConfig(context.env);
  const git = await checkGit(context.env);
  const web = await checkWebBuild(context.assets.webDistDir);
  return [
    // `runCli` refused an unsupported platform or Node before the command ran.
    passed("platform", context.platform),
    passed("node", context.nodeVersion),
    outcome("config", loaded, ({ file }) => file),
    ...ofConfig.before,
    outcome("git", git, (version) => version),
    outcome("web_build", web, () => context.assets.webDistDir),
    ofConfig.database,
    ofConfig.captureBrowser,
  ];
}

/** Whether any check failed; doctor then exits 1. A reported check is not a failure. */
export function anyFailed(checks: readonly DoctorCheck[]): boolean {
  return checks.some((check) => check.outcome.kind === "failed");
}

/** One line per check: `ok`, `FAIL` with its code, `note` with its code, or `skip`. */
export function formatDoctorCheck({ name, outcome: result }: DoctorCheck): string {
  switch (result.kind) {
    case "passed":
      return `ok    ${name}: ${result.detail}`;
    case "failed":
      return `FAIL  ${name}: ${result.error.code}: ${result.error.message}`;
    case "reported":
      return `note  ${name}: ${result.error.code}: ${result.error.message}`;
    case "skipped":
      return `skip  ${name}: ${result.reason}`;
  }
}

/** `zenorm doctor`: reports each check with `report`, and exits 1 when any failed. */
export function doctorCommand(report: (check: DoctorCheck) => void): Command {
  return async (context) => {
    const checks = await runDoctor(context);
    for (const check of checks) report(check);
    return ok(anyFailed(checks) ? 1 : 0);
  };
}

/** The `zenorm` bin's report: one line per check on stdout. */
export function printDoctorCheck(check: DoctorCheck): void {
  console.log(formatDoctorCheck(check));
}
