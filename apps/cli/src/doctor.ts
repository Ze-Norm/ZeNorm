import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { err, ok } from "@zenorm/contracts";
import type { InstanceConfig, Result, StartupError } from "@zenorm/contracts";
import {
  checkClaudePath,
  checkDatabase,
  checkDataDir,
  checkSignIn,
  checkWebBuild,
  loadConfig,
} from "@zenorm/zenorm/startup";

import { cliConfigPath } from "./cli.ts";
import type { Command, CommandContext, Env } from "./cli.ts";

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
] as const;
export type DoctorCheckName = (typeof DOCTOR_CHECKS)[number];

/** A check passed, failed with its code, or could not run because a check it needs failed. */
export type DoctorOutcome =
  | { readonly kind: "passed"; readonly detail: string }
  | { readonly kind: "failed"; readonly error: StartupError }
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
  if (!config.ok) return config;
  return ok({ file: resolve(path.value), config: config.value });
}

/** The checks of what the config names; the database's comes last in the report. */
interface ConfigChecks {
  readonly before: readonly DoctorCheck[];
  readonly database: DoctorCheck;
}

const WITHOUT_CONFIG: ConfigChecks = {
  before: [
    skipped("data_dir", "needs a valid config"),
    skipped("claude", "needs a valid config"),
    skipped("sign_in", "needs a valid config"),
  ],
  database: skipped("database", "needs a valid config"),
};

const DATABASE_DETAIL = {
  absent: "no database yet; zenorm run creates it",
  current: "every applied migration ships with this build",
} as const;

/**
 * The checks of the config's contents (5.4): the data folder, the claude executable, its sign-in
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
  return {
    before: [
      outcome("data_dir", dataDirChecked, () => dataDir),
      outcome("claude", claude, () => claudePath),
      signIn,
    ],
    database,
  };
}

/**
 * `zenorm doctor`'s checks (C5, 5.4), every one run whatever an earlier one found, writing
 * nothing. Arguments it does not accept were refused (`arguments_invalid`) before it ran.
 */
export async function runDoctor(context: CommandContext): Promise<readonly DoctorCheck[]> {
  const loaded = await readConfig(context);
  let ofConfig = WITHOUT_CONFIG;
  if (loaded.ok) ofConfig = await configChecks(context, loaded.value.config);
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
  ];
}

/** Whether any check failed; doctor then exits 1. */
export function anyFailed(checks: readonly DoctorCheck[]): boolean {
  return checks.some((check) => check.outcome.kind === "failed");
}

/** One line per check: `ok`, `FAIL` with its code, or `skip`. */
export function formatDoctorCheck({ name, outcome: result }: DoctorCheck): string {
  switch (result.kind) {
    case "passed":
      return `ok    ${name}: ${result.detail}`;
    case "failed":
      return `FAIL  ${name}: ${result.error.code}: ${result.error.message}`;
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
