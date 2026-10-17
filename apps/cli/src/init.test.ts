import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOGIN_ARGS } from "@zenorm/agent";
import type { LoginMethod } from "@zenorm/agent";
import { OPUS_LIMITS, SONNET_LIMITS } from "@zenorm/contracts";
import type { InstanceConfig, StartupError } from "@zenorm/contracts";
import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";
import { loadConfig, startup } from "@zenorm/zenorm/startup";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCli, standardConfigPath } from "./cli.ts";
import type { CliInput, Env } from "./cli.ts";
import { withCommands } from "./commands.ts";
import { doctorCommand } from "./doctor.ts";
import {
  BACKUP_INFIX,
  DATA_DIR_NAME,
  initCommand,
  MODEL_MENU,
  OPUS_FAST,
  OTHER_MODEL,
} from "./init.ts";
import type { Choice, InitTerminal } from "./init.ts";
import { MINIMUM_NODE_VERSION, packagedAssets } from "./packaged.ts";

/** The repository's stand-in claude (`apps/zenorm/e2e/fake-claude.ts`). */
const FAKE_CLAUDE = createRequire(import.meta.url).resolve("@zenorm/zenorm/e2e/fake-claude");
const TESTED_MODEL = "claude-sonnet-5-5";
const UNTESTED_MODEL = "claude-untested-1";

let home: string;
let binDir: string;
let authFile: string;
let loginFile: string;
let configDir: string;
let configFile: string;
let reported: StartupError[];

/** The stand-in's sign-in state (`fake-claude.ts`'s `AUTH_STATES`). */
type AuthState = "signed_out" | "stays_signed_out" | "claude.ai" | "third_party";

/**
 * One scripted answer: a boolean for a yes/no question, a choice's value for a menu, a line for a
 * text question, or null for a cancelled question.
 */
type Answer = string | boolean | null;

/**
 * A terminal that answers `answers` in order, then answers null (its input ended); it records the
 * questions asked. An answer of the wrong kind for its question fails the test.
 */
function scriptedTerminal(
  answers: readonly Answer[],
  interactive: boolean,
): { terminal: InitTerminal; asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (question: string): Answer => {
    asked.push(question);
    const answer = queue.shift();
    return answer === undefined ? null : answer;
  };
  return {
    asked,
    terminal: {
      interactive,
      confirm: (question) => {
        const answer = next(question);
        if (typeof answer === "string") {
          throw new Error(`the script answers the yes/no question "${question}" with ${answer}`);
        }
        return Promise.resolve(answer);
      },
      choose: <T extends string>(
        question: string,
        choices: readonly Choice<T>[],
      ): Promise<T | null> => {
        const answer = next(question);
        if (answer === null) return Promise.resolve(null);
        const chosen = choices.find(({ value }) => value === answer);
        if (chosen === undefined) {
          throw new Error(`the script picks ${String(answer)}, not a choice of "${question}"`);
        }
        return Promise.resolve(chosen.value);
      },
      text: (question) => {
        const answer = next(question);
        if (typeof answer === "boolean") {
          throw new Error(`the script gives the text question "${question}" a boolean`);
        }
        return Promise.resolve(answer);
      },
      say: () => undefined,
    },
  };
}

/** `HOME` at the test's folder, `PATH` only the folder holding the stand-in claude. */
function env(path: string): Env {
  return {
    HOME: home,
    PATH: path,
    ZENORM_FAKE_AUTH_FILE: authFile,
    ZENORM_FAKE_LOGIN_FILE: loginFile,
  };
}

/** Runs `zenorm <argv>` with `init` asking on `terminal`. */
async function zenorm(
  argv: readonly string[],
  terminal: InitTerminal,
  path: string,
): Promise<number | "serving"> {
  const input: CliInput = {
    argv,
    env: env(path),
    platform: "linux",
    nodeVersion: MINIMUM_NODE_VERSION,
    assets: packagedAssets(join(home, "dist")),
    writeOut: () => {
      throw new Error("these tests ask for no help or version");
    },
  };
  const doctor = doctorCommand(() => undefined);
  return runCli(input, withCommands({ init: initCommand(terminal), doctor }), (error) => {
    reported.push(error);
  });
}

/** `zenorm init` with the stand-in on `PATH`, signed in as `state`, answering `answers`. */
async function init(state: AuthState, answers: readonly Answer[]): Promise<number | "serving"> {
  await writeFile(authFile, state);
  return zenorm(["init"], scriptedTerminal(answers, true).terminal, binDir);
}

function codes(): string[] {
  return reported.map(({ code }) => code);
}

/** The arguments each `claude auth login` was run with, after `auth login`. */
async function logins(): Promise<unknown[]> {
  if (!existsSync(loginFile)) return [];
  const lines = (await readFile(loginFile, "utf8")).trim().split("\n");
  return lines.map((line): unknown => JSON.parse(line));
}

function loginArgs(method: LoginMethod): readonly string[] {
  return LOGIN_ARGS[method].slice(2);
}

async function backups(): Promise<string[]> {
  const names = await readdir(configDir);
  return names.filter((name) => name.startsWith(`config.json${BACKUP_INFIX}`));
}

async function loadWritten(): Promise<InstanceConfig> {
  const loaded = await loadConfig(configFile);
  if (!loaded.ok) throw new Error(`${loaded.error.code}: ${loaded.error.message}`);
  return loaded.value;
}

/** `zenorm run`'s startup from the written config, with the repository's assets: it migrates. */
async function runStarts(): Promise<void> {
  const webDistDir = join(home, "web");
  await mkdir(webDistDir, { recursive: true });
  await writeFile(join(webDistDir, "index.html"), "<!doctype html>");
  const started = await startup({
    args: [],
    env: { HOME: home },
    standardConfigPath: standardConfigPath({ HOME: home }),
    webDistDir,
    ...SOURCE_ASSETS,
    log: () => undefined,
  });
  if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
  started.value.db.$client.close();
}

beforeEach(async () => {
  reported = [];
  home = await mkdtemp(join(tmpdir(), "zenorm-init-"));
  binDir = join(home, "bin");
  await mkdir(binDir);
  // `claude` on PATH runs the stand-in with this Node, whatever else is on the machine's PATH.
  const claude = join(binDir, "claude");
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  await chmod(claude, 0o755);
  authFile = join(home, "fake-auth");
  loginFile = join(home, "fake-logins");
  configDir = join(home, ".config", "zenorm");
  configFile = join(configDir, "config.json");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("zenorm init writes a config run starts from (3.1 to 3.4)", () => {
  test("a tested model: its own table, the claude on PATH and dataDir beside the config", async () => {
    expect(await init("claude.ai", [TESTED_MODEL])).toBe(0);
    expect(reported).toEqual([]);
    const config = await loadWritten();
    expect(config.agent.wayfindingModel).toBe(TESTED_MODEL);
    expect(config.agent.specModel).toBe(TESTED_MODEL);
    expect(config.delivery.model).toBe(TESTED_MODEL);
    expect(config.agent.models).toEqual({ [TESTED_MODEL]: SONNET_LIMITS });
    expect(config.agent.claudePath).toBe(join(binDir, "claude"));
    expect(config.dataDir).toBe(join(configDir, DATA_DIR_NAME));
    expect((await stat(config.dataDir)).isDirectory()).toBe(true);
    // 3.4: every other key as the example config has it.
    expect(config.server).toEqual({ host: "127.0.0.1", port: 4310 });
    expect(config.agent).toMatchObject({
      effort: "medium",
      maxTurns: 30,
      timeoutSeconds: 180,
      fastMode: false,
    });
    expect(config.delivery).toEqual({
      model: TESTED_MODEL,
      effort: "high",
      fastMode: false,
      orchestratorMaxTurns: 500,
      orchestratorTimeoutMinutes: 240,
      reviewerMaxTurns: 100,
      reviewerTimeoutMinutes: 60,
      checkTimeoutMinutes: 30,
      executor: "local",
    });
    expect(config.plugins).toEqual({});
    await runStarts();
  });

  test("an untested model id gets Sonnet's table under its own id", async () => {
    expect(await init("claude.ai", [OTHER_MODEL, UNTESTED_MODEL])).toBe(0);
    expect(reported).toEqual([]);
    const config = await loadWritten();
    expect(config.agent.wayfindingModel).toBe(UNTESTED_MODEL);
    expect(config.agent.specModel).toBe(UNTESTED_MODEL);
    expect(config.delivery.model).toBe(UNTESTED_MODEL);
    expect(config.agent.models).toEqual({ [UNTESTED_MODEL]: SONNET_LIMITS });
    expect(config.agent.fastMode).toBe(false);
    expect(config.delivery.fastMode).toBe(false);
    await runStarts();
  });

  test("the menu offers Sonnet first, then Haiku, Opus, Opus fast and Fable", () => {
    expect(MODEL_MENU.map(({ model, fastMode }) => [model, fastMode])).toEqual([
      ["claude-sonnet-5-5", false],
      ["claude-haiku-5-5", false],
      ["claude-opus-5-5", false],
      ["claude-opus-5-5", true],
      ["claude-fable-5-1", false],
    ]);
  });

  test.each(MODEL_MENU.map((entry) => [entry.value, entry] as const))(
    "%s writes its model and fast mode for planning and delivery alike",
    async (_value, entry) => {
      expect(await init("claude.ai", [entry.value])).toBe(0);
      expect(reported).toEqual([]);
      const config = await loadWritten();
      expect(config.agent.wayfindingModel).toBe(entry.model);
      expect(config.agent.specModel).toBe(entry.model);
      expect(config.delivery.model).toBe(entry.model);
      expect(config.agent.fastMode).toBe(entry.fastMode);
      expect(config.delivery.fastMode).toBe(entry.fastMode);
      // Sonnet and Opus have tables of their own; every other model gets Sonnet's under its own id.
      const limits = entry.model === "claude-opus-5-5" ? OPUS_LIMITS : SONNET_LIMITS;
      expect(config.agent.models).toEqual({ [entry.model]: limits });
      await runStarts();
    },
  );

  test("Opus fast is the one entry whose value is not its model id", () => {
    expect(
      MODEL_MENU.filter(({ value, model }) => value !== model).map(({ value }) => value),
    ).toEqual([OPUS_FAST]);
  });

  test("another model id that names no model is asked again", async () => {
    expect(await init("claude.ai", [OTHER_MODEL, "", "  ", "two words", TESTED_MODEL])).toBe(0);
    expect((await loadWritten()).agent.wayfindingModel).toBe(TESTED_MODEL);
  });

  test("--config names the file, with dataDir beside it", async () => {
    await writeFile(authFile, "claude.ai");
    const chosen = join(home, "elsewhere", "zenorm.json");
    const { terminal } = scriptedTerminal([TESTED_MODEL], true);
    expect(await zenorm(["init", "--config", chosen], terminal, binDir)).toBe(0);
    const loaded = await loadConfig(chosen);
    expect(loaded.ok && loaded.value.dataDir).toBe(join(home, "elsewhere", DATA_DIR_NAME));
    expect(existsSync(configFile)).toBe(false);
  });

  test("an unknown flag is arguments_invalid", async () => {
    const { terminal, asked } = scriptedTerminal([], true);
    expect(await zenorm(["init", "--model", TESTED_MODEL], terminal, binDir)).toBe(1);
    expect(codes()).toEqual(["arguments_invalid"]);
    expect(asked).toEqual([]);
  });
});

describe("refusals that write nothing (3.3, 4.1)", () => {
  test("no claude on PATH is agent_cli_missing", async () => {
    const empty = join(home, "empty");
    await mkdir(empty);
    const { terminal, asked } = scriptedTerminal([TESTED_MODEL], true);
    expect(await zenorm(["init"], terminal, empty)).toBe(1);
    expect(codes()).toEqual(["agent_cli_missing"]);
    expect(asked).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  test("still signed out after the login is agent_not_logged_in", async () => {
    expect(await init("stays_signed_out", ["subscription", TESTED_MODEL])).toBe(1);
    expect(codes()).toEqual(["agent_not_logged_in"]);
    expect(await logins()).toEqual([loginArgs("subscription")]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  test("no terminal is init_not_interactive", async () => {
    const { terminal, asked } = scriptedTerminal([TESTED_MODEL], false);
    expect(await zenorm(["init"], terminal, binDir)).toBe(1);
    expect(codes()).toEqual(["init_not_interactive"]);
    expect(asked).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  test("input that ends before the model is chosen is init_not_interactive", async () => {
    expect(await init("claude.ai", [])).toBe(1);
    expect(codes()).toEqual(["init_not_interactive"]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });
});

describe("a cancelled question is init_not_interactive with nothing written (3.7)", () => {
  test.each([
    { question: "the sign-in method", state: "signed_out", answers: [null] },
    { question: "the model", state: "claude.ai", answers: [null] },
    { question: "the other model id", state: "claude.ai", answers: [OTHER_MODEL, null] },
  ] as const)("cancelling $question", async ({ state, answers }) => {
    expect(await init(state, answers)).toBe(1);
    expect(codes()).toEqual(["init_not_interactive"]);
    expect(await logins()).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  test("cancelling the replace question keeps the file and writes no backup", async () => {
    const original = '{ "kept": true }\n';
    await mkdir(configDir, { recursive: true });
    await writeFile(configFile, original);
    expect(await init("signed_out", [null])).toBe(1);
    expect(codes()).toEqual(["init_not_interactive"]);
    expect(await logins()).toEqual([]);
    expect(await readFile(configFile, "utf8")).toBe(original);
    expect(await readdir(configDir)).toEqual(["config.json"]);
  });
});

describe("Claude Code's sign-in (4.4)", () => {
  test.each(["claude.ai", "third_party"] as const)("signed in as %s: no login", async (state) => {
    expect(await init(state, [TESTED_MODEL])).toBe(0);
    expect(reported).toEqual([]);
    expect(await logins()).toEqual([]);
    expect(existsSync(configFile)).toBe(true);
  });

  test.each(["subscription", "console"] as const)("signed out: the %s login", async (method) => {
    expect(await init("signed_out", [method, TESTED_MODEL])).toBe(0);
    expect(reported).toEqual([]);
    expect(await logins()).toEqual([loginArgs(method)]);
    expect(existsSync(configFile)).toBe(true);
  });
});

describe("an existing config file (3.5)", () => {
  const ORIGINAL = '{ "kept": true }\n';

  beforeEach(async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configFile, ORIGINAL);
  });

  test("no (the suggested answer) keeps it untouched and still runs the sign-in", async () => {
    expect(await init("signed_out", [false, "subscription"])).toBe(0);
    expect(reported).toEqual([]);
    expect(await readFile(configFile, "utf8")).toBe(ORIGINAL);
    expect(await backups()).toEqual([]);
    expect(await logins()).toEqual([loginArgs("subscription")]);
    expect(await readdir(configDir)).toEqual(["config.json"]);
  });

  test("yes keeps a timestamped backup and writes a new file; a second replace keeps the first", async () => {
    expect(await init("claude.ai", [true, TESTED_MODEL])).toBe(0);
    const [first] = await backups();
    if (first === undefined) throw new Error("no backup after the first replace");
    expect(await readFile(join(configDir, first), "utf8")).toBe(ORIGINAL);
    const written = await readFile(configFile, "utf8");
    expect((await loadWritten()).agent.wayfindingModel).toBe(TESTED_MODEL);

    expect(await init("claude.ai", [true, OTHER_MODEL, UNTESTED_MODEL])).toBe(0);
    expect(reported).toEqual([]);
    const both = await backups();
    expect(both).toHaveLength(2);
    expect(await readFile(join(configDir, first), "utf8")).toBe(ORIGINAL);
    const [second] = both.filter((name) => name !== first);
    if (second === undefined) throw new Error("no second backup");
    expect(await readFile(join(configDir, second), "utf8")).toBe(written);
    expect((await loadWritten()).agent.wayfindingModel).toBe(UNTESTED_MODEL);
  });

  test("no terminal is init_not_interactive and the file stays as it was", async () => {
    const { terminal } = scriptedTerminal([true, TESTED_MODEL], false);
    expect(await zenorm(["init"], terminal, binDir)).toBe(1);
    expect(codes()).toEqual(["init_not_interactive"]);
    expect(await readFile(configFile, "utf8")).toBe(ORIGINAL);
    expect(await readdir(configDir)).toEqual(["config.json"]);
  });
});

describe("the data folder (3.6)", () => {
  test("an existing one keeps its files, and run migrates its database there", async () => {
    const dataDir = join(configDir, DATA_DIR_NAME);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "keep.txt"), "mine");
    expect(await init("claude.ai", [TESTED_MODEL])).toBe(0);
    expect(await readFile(join(dataDir, "keep.txt"), "utf8")).toBe("mine");
    await runStarts();
    expect(await readdir(dataDir)).toContain("keep.txt");
  });
});
