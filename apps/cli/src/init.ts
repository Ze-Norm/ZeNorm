import { constants } from "node:fs";
import { access, link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isatty } from "node:tty";

import * as prompts from "@clack/prompts";
import { runAuthLogin } from "@zenorm/agent";
import type { AuthStatusRead, LoginMethod } from "@zenorm/agent";
import {
  err,
  InstanceConfig,
  LOCAL_EXECUTOR,
  ok,
  SONNET_LIMITS,
  TESTED_MODEL_LIMITS,
} from "@zenorm/contracts";
import type { ModelLimits, Result, StartupError } from "@zenorm/contracts";
import { readSignIn, signInError } from "@zenorm/zenorm/startup";

import { cliConfigPath, standardConfigPath } from "./cli.ts";
import type { Command, Env } from "./cli.ts";

/** The Claude Code command init looks up on `PATH`. */
const CLAUDE_COMMAND = "claude";

/** How long one `claude auth status` read may take. */
const AUTH_STATUS_TIMEOUT_MS = 30_000;

/** `dataDir` is this folder beside the config file (3.6). */
export const DATA_DIR_NAME = "data";

/** A replaced config file is kept as `<config>.backup-<timestamp>` beside it (3.5). */
export const BACKUP_INFIX = ".backup-";

/** One entry of a menu question: the value it answers and the label the person sees. */
export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * Where init asks and tells; the `zenorm` bin's is the process's terminal, tests script one. Each
 * question resolves with the person's answer, or null once they cancelled it (or the input ended).
 */
export interface InitTerminal {
  /** Whether stdin and stdout are a terminal the person answers on. */
  readonly interactive: boolean;
  /** A yes or no question, `initial` the suggested answer. */
  readonly confirm: (question: string, initial: boolean) => Promise<boolean | null>;
  /** A menu question: resolves with the value of the choice picked. */
  readonly choose: <T extends string>(
    question: string,
    choices: readonly Choice<T>[],
  ) => Promise<T | null>;
  /** A question answered with a typed line. */
  readonly text: (question: string) => Promise<string | null>;
  /** Shows the person one line. */
  readonly say: (line: string) => void;
}

/**
 * The process's terminal, asking with clack's arrow-key prompts: each prompt holds stdin only
 * while it is open, so Claude Code's login has the terminal between them. Ctrl+C or Escape
 * cancels a prompt, which answers null: init refuses, every question coming before its writes.
 */
export function processTerminal(): InitTerminal {
  return {
    interactive: isatty(0) && isatty(1),
    confirm: async (question, initial) => {
      const answer = await prompts.confirm({ message: question, initialValue: initial });
      return prompts.isCancel(answer) ? null : answer;
    },
    choose: async <T extends string>(
      question: string,
      choices: readonly Choice<T>[],
    ): Promise<T | null> => {
      const answer = await prompts.select<string>({
        message: question,
        options: choices.map(({ value, label }) => ({ value, label })),
      });
      if (prompts.isCancel(answer)) return null;
      const chosen = choices.find(({ value }) => value === answer);
      if (chosen === undefined) {
        throw new Error(`the menu answered ${answer}, which it never offered`);
      }
      return chosen.value;
    },
    text: async (question) => {
      // clack answers an empty submission with its `defaultValue`: here the empty line, which the
      // question's reader asks again for.
      const answer = await prompts.text({ message: question, defaultValue: "" });
      return prompts.isCancel(answer) ? null : answer;
    },
    say: (line) => {
      prompts.log.message(line);
    },
  };
}

const NOT_FOUND = ["ENOENT", "ENOTDIR"];

function hasErrorCode(error: unknown, codes: readonly string[]): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

/** Whether anything is at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, NOT_FOUND)) return false;
    throw error;
  }
}

/** Whether `path` is a regular file (through a symlink too) this process may execute. */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, [...NOT_FOUND, "EACCES"])) return false;
    throw error;
  }
}

/** The absolute path of the first executable `name` in `env.PATH`'s absolute folders, else null. */
export async function findOnPath(name: string, env: Env): Promise<string | null> {
  const path = env.PATH;
  if (path === undefined) return null;
  for (const folder of path.split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function inputEnded(configFile: string): StartupError {
  return {
    code: "init_not_interactive",
    message: "The question was cancelled before init had its answer; nothing was written",
    subject: configFile,
  };
}

/**
 * Asks with `ask` until `read` accepts the answer; a cancelled question (null) is
 * `init_not_interactive`.
 */
async function askUntil<A, T>(
  configFile: string,
  ask: () => Promise<A | null>,
  read: (answer: A) => T | null,
): Promise<Result<T, StartupError>> {
  for (;;) {
    const answer = await ask();
    if (answer === null) return err(inputEnded(configFile));
    const value = read(answer);
    if (value !== null) return ok(value);
  }
}

/**
 * Asks a yes/no or menu question with `ask`, whose every answer is one init takes; a cancelled
 * question (null) is `init_not_interactive`.
 */
function askOnce<T>(
  configFile: string,
  ask: () => Promise<T | null>,
): Promise<Result<T, StartupError>> {
  return askUntil(configFile, ask, (answer: T): T | null => answer);
}

/** Claude Code's sign-in, read the way `zenorm run` and `zenorm doctor` read it. */
function readStatus(claudePath: string, env: Env): Promise<Result<AuthStatusRead, StartupError>> {
  return readSignIn(claudePath, env, AUTH_STATUS_TIMEOUT_MS);
}

/** The sign-in methods init offers, the subscription first. */
const LOGIN_CHOICES: readonly Choice<LoginMethod>[] = [
  { value: "subscription", label: "Your Claude subscription" },
  { value: "console", label: "An Anthropic Console account" },
];

/**
 * C4: asks Claude Code whether the person is signed in. Signed in by any method, it shows the
 * method; otherwise it asks subscription or Console, runs Claude Code's own login on the person's
 * terminal and asks again, refusing `agent_not_logged_in` if still signed out.
 */
async function signIn(
  claudePath: string,
  env: Env,
  terminal: InitTerminal,
  configFile: string,
): Promise<Result<null, StartupError>> {
  const status = await readStatus(claudePath, env);
  if (!status.ok) return status;
  if (status.value.loggedIn) {
    terminal.say(`Claude Code is signed in (${status.value.authMethod}).`);
    return ok(null);
  }
  terminal.say(
    "Claude Code is not signed in. Its own sign-in runs next; ZeNorm never sees your keys.",
  );
  const method = await askOnce(configFile, () =>
    terminal.choose("Sign in with which account?", LOGIN_CHOICES),
  );
  if (!method.ok) return method;
  const login = await runAuthLogin(claudePath, method.value, env);
  if (!login.ok) return err(signInError(login.error, claudePath));
  const after = await readStatus(claudePath, env);
  if (!after.ok) return after;
  if (!after.value.loggedIn) {
    return err({
      code: "agent_not_logged_in",
      message:
        "Claude Code is still not signed in after its login. Sign in with `claude auth login`, then run `zenorm init` again",
      subject: claudePath,
    });
  }
  terminal.say(`Claude Code is signed in (${after.value.authMethod}).`);
  return ok(null);
}

/** Whether to replace the config file already at `configFile` (3.5). */
function replaceQuestion(configFile: string): string {
  return `${configFile} already exists. Replace it (the old file is kept as a backup)?`;
}

/**
 * The model menu's last entry, which asks for any other id. It holds spaces, so no model id (none
 * has any) is ever this value.
 */
export const OTHER_MODEL = "other model id";

/** The model init writes into all three model keys, and whether it runs in Claude Code's fast mode. */
export interface ModelChoice {
  readonly model: string;
  readonly fastMode: boolean;
}

/** One entry of the model menu: its value, its label and what it picks. */
type ModelMenuEntry = Choice<string> & ModelChoice;

/** Opus 5.5 in Claude Code's fast mode, the one menu entry whose value is not its model id. */
export const OPUS_FAST = "claude-opus-5-5 fast";

/**
 * The model menu (3.1): the current Claude models, Sonnet first (the suggested answer), then by
 * size, with Opus also in fast mode. Each value is its model id but
 * Opus fast's, which like `OTHER_MODEL` holds a space, so no typed id is ever it.
 */
export const MODEL_MENU: readonly ModelMenuEntry[] = [
  { value: "claude-sonnet-5-5", model: "claude-sonnet-5-5", fastMode: false, label: "Sonnet 5.5" },
  { value: "claude-haiku-5-5", model: "claude-haiku-5-5", fastMode: false, label: "Haiku 5.5" },
  { value: "claude-opus-5-5", model: "claude-opus-5-5", fastMode: false, label: "Opus 5.5" },
  { value: OPUS_FAST, model: "claude-opus-5-5", fastMode: true, label: "Opus 5.5 fast" },
  { value: "claude-fable-5-1", model: "claude-fable-5-1", fastMode: false, label: "Fable 5.1" },
];

/** An entry's label with its model id, and fast mode. */
function menuLabel(entry: ModelMenuEntry): string {
  const fast = entry.fastMode ? ", fast mode" : "";
  return `${entry.label} (${entry.model}${fast})`;
}

/** The model id a typed line names: any non-empty id without spaces. */
function modelId(answer: string): string | null {
  const id = answer.trim();
  return id === "" || /\s/.test(id) ? null : id;
}

/** The tested table of `model`, or null when it has none. */
export function testedLimits(model: string): ModelLimits | null {
  const entry = Object.entries(TESTED_MODEL_LIMITS).find(([id]) => id === model);
  return entry === undefined ? null : entry[1];
}

/** Asks for the one model (3.1): the menu's, or any other id, which never runs in fast mode. */
async function askModel(
  terminal: InitTerminal,
  configFile: string,
): Promise<Result<ModelChoice, StartupError>> {
  const choices: Choice<string>[] = MODEL_MENU.map((entry) => ({
    value: entry.value,
    label: menuLabel(entry),
  }));
  choices.push({ value: OTHER_MODEL, label: "Another model id" });
  const chosen = await askOnce(configFile, () =>
    terminal.choose("Which model should ZeNorm plan and deliver with?", choices),
  );
  if (!chosen.ok) return chosen;
  const entry = MODEL_MENU.find(({ value }) => value === chosen.value);
  if (entry !== undefined) return ok({ model: entry.model, fastMode: entry.fastMode });
  const typed = await askUntil(configFile, () => terminal.text("Which model id?"), modelId);
  return typed.ok ? ok({ model: typed.value, fastMode: false }) : typed;
}

/**
 * The config init writes (3.4): the one model in all three model keys with one `agent.models`
 * entry, fast mode on or off for planning and delivery alike, the claude on `PATH`, `dataDir`
 * beside the config file, and every other key as `config.example.json` has it.
 */
export function initConfig(
  dataDir: string,
  claudePath: string,
  { model, fastMode }: ModelChoice,
  limits: ModelLimits,
): InstanceConfig {
  return {
    server: { host: "127.0.0.1", port: 4310 },
    dataDir,
    agent: {
      claudePath,
      wayfindingModel: model,
      specModel: model,
      models: { [model]: limits },
      effort: "medium",
      maxTurns: 30,
      timeoutSeconds: 180,
      fastMode,
    },
    delivery: {
      model,
      effort: "high",
      fastMode,
      orchestratorMaxTurns: 500,
      orchestratorTimeoutMinutes: 240,
      reviewerMaxTurns: 100,
      reviewerTimeoutMinutes: 60,
      checkTimeoutMinutes: 30,
      executor: LOCAL_EXECUTOR,
    },
    plugins: {},
  };
}

/**
 * Renames `path` to `<path>.backup-<timestamp>` beside it, never over an earlier backup: the
 * backup is a new link (refused if it exists, so the next suffix is tried), then the old name goes.
 */
async function backUp(path: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${String(attempt)}`;
    const backup = `${path}${BACKUP_INFIX}${stamp}${suffix}`;
    try {
      await link(path, backup);
    } catch (error: unknown) {
      if (hasErrorCode(error, ["EEXIST"])) continue;
      throw error;
    }
    await unlink(path);
    return backup;
  }
}

/**
 * Writes the config for `choice` at `configFile` (3.4 to 3.6): validated first, then the data folder
 * (created, or an existing one used as it is), the old file moved to its backup when `replacing`,
 * and the new file.
 */
async function writeConfig(
  configFile: string,
  claudePath: string,
  choice: ModelChoice,
  replacing: boolean,
  terminal: InitTerminal,
): Promise<Result<null, StartupError>> {
  const { model } = choice;
  const tested = testedLimits(model);
  const dataDir = join(dirname(configFile), DATA_DIR_NAME);
  const config = InstanceConfig.safeParse(
    initConfig(dataDir, claudePath, choice, tested ?? SONNET_LIMITS),
  );
  // Every value but the model choice and the paths is fixed here, and fast mode is only ever on
  // for Opus, so a refusal is a bug in init.
  if (!config.success) {
    throw new Error(`init built a config the config check refuses: ${config.error.message}`);
  }
  if (tested === null) {
    terminal.say(
      `${model} uses Sonnet's drafting lengths (agent.models); they may need tuning for it.`,
    );
  }
  if (await exists(dataDir)) {
    terminal.say(`Using the existing data folder ${dataDir}.`);
  } else {
    await mkdir(dataDir, { recursive: true });
    terminal.say(`Created the data folder ${dataDir}.`);
  }
  if (replacing) {
    terminal.say(`Kept the old config as ${await backUp(configFile)}.`);
  }
  await writeFile(configFile, `${JSON.stringify(config.data, null, 2)}\n`, { flag: "wx" });
  return ok(null);
}

/**
 * `zenorm init` (C3, C4): the config path as `run` reads it, a terminal to ask on
 * (`init_not_interactive`), the claude on `PATH` (`agent_cli_missing`), whether to replace an
 * existing file, Claude Code's sign-in (`agent_not_logged_in`), then the model and the config.
 * Nothing is written before the sign-in holds.
 */
export function initCommand(terminal: InitTerminal): Command {
  return async (context) => {
    const path = cliConfigPath(context.config, context.env);
    if (!path.ok) return path;
    const configFile = resolve(path.value);
    if (!terminal.interactive) {
      return err({
        code: "init_not_interactive",
        message: "zenorm init asks its questions on a terminal; run it in one",
        subject: configFile,
      });
    }
    const claudePath = await findOnPath(CLAUDE_COMMAND, context.env);
    if (claudePath === null) {
      return err({
        code: "agent_cli_missing",
        message:
          "No `claude` on PATH. Install Claude Code (https://docs.claude.com/en/docs/claude-code), then run `zenorm init` again",
        subject: CLAUDE_COMMAND,
      });
    }
    terminal.say(`Using Claude Code at ${claudePath}.`);
    const existing = await exists(configFile);
    // No, the suggested answer, keeps the file (3.5).
    const replace = existing
      ? await askOnce(configFile, () => terminal.confirm(replaceQuestion(configFile), false))
      : ok(false);
    if (!replace.ok) return replace;
    // Keeping the file still runs the sign-in (3.5).
    const signedIn = await signIn(claudePath, context.env, terminal, configFile);
    if (!signedIn.ok) return signedIn;
    if (existing && !replace.value) {
      terminal.say(`Kept ${configFile} as it is.`);
      return ok(0);
    }
    const model = await askModel(terminal, configFile);
    if (!model.ok) return model;
    const written = await writeConfig(configFile, claudePath, model.value, existing, terminal);
    if (!written.ok) return written;
    const run =
      configFile === standardConfigPath(context.env)
        ? "zenorm run"
        : `zenorm run --config ${configFile}`;
    terminal.say(`Wrote ${configFile}. Start ZeNorm with: ${run}`);
    return ok(0);
  };
}
