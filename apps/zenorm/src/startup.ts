import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  checkCaptureBrowser as checkBrowser,
  claudeCodeCaptureScreens,
  claudeCodeImplementTicketSet,
  claudeCodePickScreens,
  claudeCodePlanningAgent,
  claudeCodeReviewDelivery,
  claudeCodeWritePullRequest,
  PLAYWRIGHT_MCP_PACKAGE,
  readAuthStatus,
} from "@zenorm/agent";
import type { AuthStatusRead, ClaudeEnv, DeliverySessionConfig } from "@zenorm/agent";
import { err, InstanceConfig, LOCAL_EXECUTOR, ok } from "@zenorm/contracts";
import type { DeliveryExecutor, PlanningAgentError, Result, StartupError } from "@zenorm/contracts";
import {
  anyProjectCapturesScreens,
  checkDatabaseFile,
  claimInstanceLock,
  INSTANCE_LOCK_FILE,
  installChangeFeed,
  migrateDatabase,
  openDatabase,
  pruneChangeFeed,
  users,
} from "@zenorm/db";
import type { DatabaseFileState, ZeNormDatabase } from "@zenorm/db";
import { APP_READY_TIMEOUT_MS, checkPlugins, createApp, createChangeBus } from "@zenorm/server";
import type { Log, ServerPlugin, ZeNormApp } from "@zenorm/server";

import { sweepRunFolders, sweepSessions } from "./sweeps.ts";
import type { SweepLog } from "./sweeps.ts";

export const CONFIG_ENV_VAR = "ZENORM_CONFIG";
export const DATABASE_FILE = "zenorm.sqlite";
/** `<dataDir>/sessions`: the `claude` session records, a folder ZeNorm owns. */
export const SESSIONS_DIR = "sessions";
/** `<dataDir>/runs`: one folder per delivery run, named by its id. */
export const RUNS_DIR = "runs";

/**
 * Where an entry's assets are: the repository's for the entries that run from source
 * (`./source-assets.ts`), the package's own copies for the built `zenorm` command.
 */
export interface ZeNormAssets {
  /** The web build the server serves; `@zenorm/web`'s `webDistDir` for `apps/zenorm`. */
  readonly webDistDir: string;
  /** The folder holding each skill's `SKILL.md`, which planning and delivery sessions read. */
  readonly skillsDir: string;
  /** Drizzle's migrations folder `migrateDatabase` applies. */
  readonly migrationsFolder: string;
}

export interface StartupInput extends ZeNormAssets {
  /** Command-line arguments after the script path (after the command name for `zenorm`). */
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The config file used when neither `--config` nor `ZENORM_CONFIG` is set: the `zenorm`
   * command's `~/.config/zenorm/config.json`. Null for the repository's entries, which require one
   * of the two (`config_path_missing`).
   */
  readonly standardConfigPath: string | null;
  /** Where the startup sweeps write one line per thing they removed or killed. */
  readonly log: SweepLog;
}

export interface Started {
  readonly config: InstanceConfig;
  readonly db: ZeNormDatabase;
  /** `<dataDir>/sessions`, created when absent. */
  readonly sessionsDir: string;
}

/** `parseArgs` errors for arguments the command does not accept. */
const ARGUMENT_ERRORS = [
  "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
];

/** The `--config` value; an unknown flag, a positional or a bare `--config` is `arguments_invalid`. */
function parseConfigArg(args: readonly string[]): Result<string | undefined, StartupError> {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { config: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    return ok(values.config);
  } catch (error: unknown) {
    if (!hasErrorCode(error, ARGUMENT_ERRORS)) {
      throw error;
    }
    return err({
      code: "arguments_invalid",
      message: `${error.message}. The only accepted argument is --config <path>`,
      subject: args.join(" "),
    });
  }
}

/**
 * The config file path from `--config` or `ZENORM_CONFIG`, never both; with neither,
 * `standardConfigPath` when the entry has one, otherwise `config_path_missing`.
 */
export function configPath(
  args: readonly string[],
  env: StartupInput["env"],
  standardConfigPath: string | null,
): Result<string, StartupError> {
  const parsedArgs = parseConfigArg(args);
  if (!parsedArgs.ok) {
    return parsedArgs;
  }
  const fromArgs = parsedArgs.value;
  const fromEnv = env[CONFIG_ENV_VAR];
  const sources = `--config, ${CONFIG_ENV_VAR}`;
  if (fromArgs !== undefined) {
    if (fromEnv !== undefined) {
      return err({
        code: "config_path_ambiguous",
        message: `Both --config and ${CONFIG_ENV_VAR} are set; set only one`,
        subject: sources,
      });
    }
    return ok(fromArgs);
  }
  if (fromEnv === undefined) {
    if (standardConfigPath !== null) {
      return ok(standardConfigPath);
    }
    return err({
      code: "config_path_missing",
      message: `Set the config file path with --config or ${CONFIG_ENV_VAR}`,
      subject: sources,
    });
  }
  return ok(fromEnv);
}

function hasErrorCode(error: unknown, codes: readonly string[]): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

const NOT_FOUND = ["ENOENT", "ENOTDIR"];

async function readConfigText(path: string): Promise<Result<string, StartupError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (hasErrorCode(error, [...NOT_FOUND, "EISDIR"])) {
      return err({
        code: "config_file_missing",
        message: `No config file at ${path}`,
        subject: path,
      });
    }
    throw error;
  }
}

/** Whether `path` names a key its parent object in `json` does not have. */
function isMissingKey(json: unknown, path: readonly PropertyKey[]): boolean {
  const key = path.at(-1);
  if (key === undefined || typeof key === "symbol") return false;
  let parent: unknown = json;
  for (const step of path.slice(0, -1)) {
    if (typeof parent !== "object" || parent === null || typeof step === "symbol") return false;
    parent = Object.hasOwn(parent, step) ? Reflect.get(parent, step) : undefined;
  }
  return typeof parent === "object" && parent !== null && !Object.hasOwn(parent, key);
}

/** The words for a required key the config leaves out; `delivery.executor` names its built-in. */
function requiredKeyMessage(subject: string): string {
  if (subject === "delivery.executor") {
    return `${subject} is required: name the executor every delivery run uses ("local" is the built-in executor, Claude Code on this machine)`;
  }
  return `${subject} is required`;
}

/** Reads and validates the instance config file. */
export async function loadConfig(path: string): Promise<Result<InstanceConfig, StartupError>> {
  const text = await readConfigText(path);
  if (!text.ok) {
    return text;
  }
  let json: unknown;
  try {
    json = JSON.parse(text.value);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return err({
      code: "config_file_invalid",
      message: `${path} is not valid JSON: ${error.message}`,
      subject: path,
    });
  }
  const parsed = InstanceConfig.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    if (issue === undefined) {
      throw new Error("Zod reported a failed parse with no issues");
    }
    const keyPath = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      keyPath.push(issue.keys.join(","));
    }
    const subject = keyPath.join(".");
    const reason = isMissingKey(json, issue.path) ? requiredKeyMessage(subject) : issue.message;
    return err({
      code: "config_file_invalid",
      message: `${path}: ${subject}: ${reason}`,
      subject,
    });
  }
  return ok(parsed.data);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: unknown) {
    if (hasErrorCode(error, NOT_FOUND)) {
      return false;
    }
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (hasErrorCode(error, NOT_FOUND)) {
      return false;
    }
    throw error;
  }
}

/** Whether `path` is a regular file this process may execute. */
async function isExecutableFile(path: string): Promise<boolean> {
  if (!(await isFile(path))) {
    return false;
  }
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, ["EACCES"])) {
      return false;
    }
    throw error;
  }
}

/** The config's `dataDir` must be a directory (`data_dir_missing`). */
export async function checkDataDir(dataDir: string): Promise<Result<null, StartupError>> {
  if (await isDirectory(dataDir)) {
    return ok(null);
  }
  return err({
    code: "data_dir_missing",
    message: `dataDir ${dataDir} does not exist or is not a directory`,
    subject: dataDir,
  });
}

/** The config's `agent.claudePath` must be an executable file (`agent_cli_missing`). */
export async function checkClaudePath(claudePath: string): Promise<Result<null, StartupError>> {
  if (await isExecutableFile(claudePath)) {
    return ok(null);
  }
  return err({
    code: "agent_cli_missing",
    message: `agent.claudePath ${claudePath} is not an executable file`,
    subject: claudePath,
  });
}

/** The web build the server serves must have its `index.html` (`web_build_missing`). */
export async function checkWebBuild(webDistDir: string): Promise<Result<null, StartupError>> {
  const indexHtml = join(webDistDir, "index.html");
  if (await isFile(indexHtml)) {
    return ok(null);
  }
  return err({
    code: "web_build_missing",
    message: `No web build at ${indexHtml}; run the @zenorm/web build`,
    subject: indexHtml,
  });
}

/**
 * A sign-in status read's or login's failure as a refusal: a CLI that cannot be run is
 * `agent_cli_missing`; a status call that fails any other way is `agent_not_logged_in`.
 */
export function signInError(error: PlanningAgentError, claudePath: string): StartupError {
  switch (error.code) {
    case "agent_cli_missing":
    case "agent_not_logged_in":
      return { code: error.code, message: error.message, subject: claudePath };
    case "agent_run_failed":
    case "agent_timed_out":
    case "agent_output_invalid":
      return {
        code: "agent_not_logged_in",
        message: `Could not read Claude Code's sign-in (${error.code}): ${error.message}`,
        subject: claudePath,
      };
  }
}

/** `claude auth status --json` through the agent's auth seam, its failures as refusals. */
export async function readSignIn(
  claudePath: string,
  env: ClaudeEnv,
  timeoutMs: number,
): Promise<Result<AuthStatusRead, StartupError>> {
  const status = await readAuthStatus(claudePath, env, timeoutMs);
  if (!status.ok) {
    return err(signInError(status.error, claudePath));
  }
  return status;
}

/**
 * Claude Code must be signed in, by any method: a status call that exits non-zero or reports
 * signed out is `agent_not_logged_in`. Returns the sign-in method.
 */
export async function checkSignIn(
  claudePath: string,
  env: ClaudeEnv,
  timeoutMs: number,
): Promise<Result<string, StartupError>> {
  const status = await readSignIn(claudePath, env, timeoutMs);
  if (!status.ok) {
    return status;
  }
  if (!status.value.loggedIn) {
    return err({
      code: "agent_not_logged_in",
      message:
        "Claude Code is not signed in. Sign in with `claude auth login` or `zenorm init`, then start ZeNorm again",
      subject: claudePath,
    });
  }
  return ok(status.value.authMethod);
}

/**
 * The database in `dataDir`, opened read-only: absent, or one `migrationsFolder` can migrate
 * (`database_newer_than_build` otherwise). Writes nothing; `zenorm doctor` runs it.
 */
export function checkDatabase(
  dataDir: string,
  migrationsFolder: string,
): Result<DatabaseFileState, StartupError> {
  return checkDatabaseFile(join(dataDir, DATABASE_FILE), migrationsFolder);
}

/** What `checkCaptureBrowser` found: whether capture is on anywhere, and the browser's check. */
export interface CaptureBrowserCheck {
  /** Whether some project in the database has both an app start command and its URL saved. */
  readonly captureOn: boolean;
  /** The screenshot browser's check: the Chromium build found, or `capture_browser_missing`. */
  readonly browser: Result<{ readonly executablePath: string }, StartupError>;
}

/**
 * `zenorm doctor`'s screenshot browser check: whether any project in `dataDir`'s database (read
 * only, as `checkDatabase` reads it; an absent database has none) has screenshot capture on, and
 * whether the Chromium build the pinned Playwright MCP server drives is installed where the server,
 * run with `env`, looks for it (a relative `PLAYWRIGHT_BROWSERS_PATH` resolves against this
 * process's working folder). Writes and downloads nothing. A database it cannot read is the
 * refusal.
 */
export function checkCaptureBrowser(
  dataDir: string,
  migrationsFolder: string,
  env: StartupInput["env"],
): Result<CaptureBrowserCheck, StartupError> {
  const database = checkDatabase(dataDir, migrationsFolder);
  if (!database.ok) {
    return database;
  }
  const captureOn = anyProjectCapturesScreens(join(dataDir, DATABASE_FILE));
  if (!captureOn.ok) {
    return captureOn;
  }
  const found = checkBrowser(env, process.cwd());
  const browser: CaptureBrowserCheck["browser"] = found.ok
    ? ok({ executablePath: found.value.executablePath })
    : err({ ...found.error, subject: PLAYWRIGHT_MCP_PACKAGE });
  return ok({ captureOn: captureOn.value, browser });
}

/**
 * The checks that write nothing: the config, the data directory, the Claude Code CLI, the web
 * build, and Claude Code's sign-in, read with the input's environment (as `zenorm init` and
 * `zenorm doctor` read it) and bounded by `agent.timeoutSeconds`.
 */
async function checkStartup(input: StartupInput): Promise<Result<InstanceConfig, StartupError>> {
  const path = configPath(input.args, input.env, input.standardConfigPath);
  if (!path.ok) {
    return path;
  }
  const config = await loadConfig(path.value);
  if (!config.ok) {
    return config;
  }
  const dataDir = await checkDataDir(config.value.dataDir);
  if (!dataDir.ok) {
    return dataDir;
  }
  const { claudePath, timeoutSeconds } = config.value.agent;
  const claude = await checkClaudePath(claudePath);
  if (!claude.ok) {
    return claude;
  }
  const web = await checkWebBuild(input.webDistDir);
  if (!web.ok) {
    return web;
  }
  const signedIn = await checkSignIn(claudePath, input.env, timeoutSeconds * 1000);
  if (!signedIn.ok) {
    return signedIn;
  }
  return config;
}

/**
 * Opens what the checked config names: the session records' folder, and the migrated database,
 * refused `database_newer_than_build` before migrating when it holds a migration this build does
 * not ship; then sweeps what an earlier server left behind (every change feed row, surviving
 * `claude` sessions, orphaned run folders).
 */
async function openStartup(
  input: StartupInput,
  config: InstanceConfig,
): Promise<Result<Started, StartupError>> {
  const { dataDir } = config;
  const sessionsDir = join(dataDir, SESSIONS_DIR);
  await mkdir(sessionsDir, { recursive: true });
  const opened = openDatabase(join(dataDir, DATABASE_FILE));
  if (!opened.ok) {
    return opened;
  }
  const db = opened.value;
  // Before anything is migrated or swept: a second ZeNorm on this data folder would sweep the
  // first one's sessions and runs as interrupted.
  const claimed = claimInstanceLock(db, join(dataDir, INSTANCE_LOCK_FILE));
  if (!claimed.ok) {
    db.$client.close();
    return claimed;
  }
  const migrated = migrateDatabase(db, input.migrationsFolder);
  if (!migrated.ok) {
    db.$client.close();
    return migrated;
  }
  // The instance has exactly one User; `0020_users_actor_change_feed.sql` creates it.
  const userCount = db.select({ id: users.id }).from(users).all().length;
  if (userCount !== 1) {
    db.$client.close();
    return err({
      code: userCount === 0 ? "user_missing" : "user_ambiguous",
      message: `The database holds ${String(userCount)} users; an instance has exactly one`,
      subject: db.$client.name,
    });
  }
  // The change feed and the `user_id` refusals are TEMP triggers, rebuilt on every open.
  installChangeFeed(db);
  // No stream is open before the server listens, so no feed row is needed.
  pruneChangeFeed(db, "all");
  await sweepSessions(sessionsDir, input.log);
  await sweepRunFolders(db, join(dataDir, RUNS_DIR), input.log);
  return ok({ config, db, sessionsDir });
}

/**
 * Everything that must hold before the server listens: the config, the data directory, the
 * Claude Code CLI, the web build, Claude Code's sign-in, the session records' folder, the data
 * folder's lock (`data_dir_in_use` while another ZeNorm holds it, until the database closes) and
 * the migrated database (a database newer than the build is refused before anything is migrated);
 * then the startup sweeps. Returns the first failure as a coded `StartupError`.
 */
export async function startup(input: StartupInput): Promise<Result<Started, StartupError>> {
  const config = await checkStartup(input);
  if (!config.ok) {
    return config;
  }
  return await openStartup(input, config.value);
}

/** The name the app registers the Claude Code pair under; it lives in contracts. */
export { LOCAL_EXECUTOR };

/**
 * The `"local"` delivery executor: the Claude Code orchestrator, reviewer and pull
 * request writer with their session records, built from the config as before, following the skills
 * in `skillsDir`. The writer runs under the reviewer's settings, so no config key is added.
 * `delivery.executor` only selects it, so the sessions never see that key.
 */
export function localExecutor(
  config: InstanceConfig,
  sessionsDir: string,
  skillsDir: string,
): DeliveryExecutor {
  const { delivery } = config;
  // One `claude` binary serves planning and delivery.
  const deliveryAgent: DeliverySessionConfig = {
    claudePath: config.agent.claudePath,
    sessionsDir,
    skillsDir,
    model: delivery.model,
    effort: delivery.effort,
    fastMode: delivery.fastMode,
    orchestratorMaxTurns: delivery.orchestratorMaxTurns,
    orchestratorTimeoutMinutes: delivery.orchestratorTimeoutMinutes,
    reviewerMaxTurns: delivery.reviewerMaxTurns,
    reviewerTimeoutMinutes: delivery.reviewerTimeoutMinutes,
    checkTimeoutMinutes: delivery.checkTimeoutMinutes,
  };
  return {
    name: LOCAL_EXECUTOR,
    implementTicketSet: claudeCodeImplementTicketSet(deliveryAgent),
    reviewDelivery: claudeCodeReviewDelivery(deliveryAgent),
    writePullRequest: claudeCodeWritePullRequest(deliveryAgent),
    pickScreens: claudeCodePickScreens(deliveryAgent),
    captureScreens: claudeCodeCaptureScreens(deliveryAgent),
  };
}

export interface ZeNormInput extends StartupInput {
  /** The composition's server plugins, in order; `apps/zenorm` passes `[]`. */
  readonly plugins: readonly ServerPlugin[];
  /** Where the app's unexpected errors and plain lines (`error` null) go. */
  readonly logError: Log;
}

export interface StartedZeNorm extends Started {
  readonly app: ZeNormApp;
}

/**
 * `startup`'s checks; then `plugins` checked with the `"local"` executor, before the database is
 * opened or migrated (the manifests, every plugin's config section, the executor registry); then
 * `startup`'s opening, the app composed with the planning agent and the plugins (the rest of the
 * plugin startup codes) and each plugin's `start` (`plugin_start_failed`). A failure closes what
 * was opened and is the coded `StartupError`. The app is returned unlaunched: the caller calls
 * `app.launch()` once it is ready to serve, which for `startAndListen` is once the port is bound,
 * so a refused bind marks no run interrupted and relaunches none. `apps/zenorm-example` composes
 * its plugin through this too.
 */
export async function startZeNorm(
  input: ZeNormInput,
): Promise<Result<StartedZeNorm, StartupError>> {
  const checked = await checkStartup(input);
  if (!checked.ok) {
    return checked;
  }
  const config = checked.value;
  // The local executor's factories only close over the config; they touch no disk.
  const plugins = checkPlugins({
    plugins: input.plugins,
    pluginConfig: config.plugins,
    executors: [localExecutor(config, join(config.dataDir, SESSIONS_DIR), input.skillsDir)],
    executor: config.delivery.executor,
  });
  if (!plugins.ok) {
    return plugins;
  }
  const started = await openStartup(input, config);
  if (!started.ok) {
    return started;
  }
  const { db, sessionsDir } = started.value;
  const created = createApp({
    db,
    // The after-commit bus every write publishes to.
    bus: createChangeBus(input.logError),
    webDistDir: input.webDistDir,
    log: input.logError,
    server: config.server,
    ...claudeCodePlanningAgent({ ...config.agent, sessionsDir, skillsDir: input.skillsDir }),
    plugins: plugins.value,
    delivery: {
      runsDir: join(config.dataDir, RUNS_DIR),
      checkTimeoutMinutes: config.delivery.checkTimeoutMinutes,
      sessionsDir,
      appReadyTimeoutMs: APP_READY_TIMEOUT_MS,
    },
  });
  if (!created.ok) {
    db.$client.close();
    return created;
  }
  const app = created.value;
  const pluginsStarted = await app.startPlugins();
  if (!pluginsStarted.ok) {
    // Nothing was launched or subscribed; the started plugins were stopped.
    db.$client.close();
    return pluginsStarted;
  }
  return ok({ ...started.value, app });
}

/** The steps of a shutdown on SIGTERM or SIGINT. */
export interface ShutdownSteps {
  /** Stops accepting connections; resolves once the open ones have ended. */
  readonly closeServer: () => Promise<void>;
  /** Aborts the active planning calls; resolves once their drivers have settled. */
  readonly stopPlanningRuns: () => Promise<void>;
  /** Aborts the active delivery sessions; resolves once their drivers have settled. */
  readonly stopDeliveryRuns: () => Promise<void>;
  /** Stops each plugin in reverse order, each bounded at 5 s. */
  readonly stopPlugins: () => Promise<void>;
  readonly closeDatabase: () => void;
}

/**
 * Shuts ZeNorm down (`node --watch` sends SIGTERM on every save): it stops
 * accepting connections, stops the planning and delivery runs together (their agent process
 * groups are killed and awaited), then stops the plugins, and closes the database only after
 * all of them, so no write hits a closed connection. The stopped runs read interrupted after the
 * restart.
 */
export async function shutDown(steps: ShutdownSteps): Promise<void> {
  const serverClosed = steps.closeServer();
  await Promise.all([steps.stopPlanningRuns(), steps.stopDeliveryRuns()]);
  await steps.stopPlugins();
  await serverClosed;
  steps.closeDatabase();
}
