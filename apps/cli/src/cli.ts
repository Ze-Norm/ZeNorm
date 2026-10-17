import { join } from "node:path";

import {
  Command as CommanderCommand,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "@commander-js/extra-typings";
import { err, ok } from "@zenorm/contracts";
import type { Result, StartupError } from "@zenorm/contracts";
import { printRefusal, startAndListen } from "@zenorm/zenorm/serve";
import { configPath } from "@zenorm/zenorm/startup";
import type { StartupInput, ZeNormAssets } from "@zenorm/zenorm/startup";

import manifest from "../package.json" with { type: "json" };
import { MINIMUM_NODE_VERSION } from "./packaged.ts";

export type Env = StartupInput["env"];

/** The process facts every command starts from; tests stub the platform and the Node version. */
export interface CliInput {
  /** The arguments after `zenorm`: the command name, then its options. */
  readonly argv: readonly string[];
  readonly env: Env;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  /** The skills, migrations and web build the command passes on. */
  readonly assets: ZeNormAssets;
  /** Where help and the version go: the bin's standard output; tests record it. */
  readonly writeOut: (text: string) => void;
}

/** What a command runs with once the refusals and the parse have passed. */
export interface CommandContext extends CliInput {
  /** The parsed `--config` value; undefined when it was not given. */
  readonly config: string | undefined;
}

/** How a command ended: an exit code, or `"serving"` while the server holds the process open. */
export type CommandEnd = number | "serving";

export type Command = (context: CommandContext) => Promise<Result<CommandEnd, StartupError>>;

/** One option a command takes, as its help shows it; its value is checked by `optionValue`. */
export interface CommandOption {
  /** Commander's flags, as `--config <path>`: a long flag and a required value. */
  readonly flags: string;
  readonly description: string;
}

/** One command `zenorm` takes: everything that registers it, its options and its help. */
export interface CommandEntry {
  readonly name: string;
  readonly description: string;
  readonly options: readonly CommandOption[];
  /** What the command runs. */
  readonly command: Command;
}

/** Every command `zenorm` takes, in the order its help lists them; `commands.ts` has the one. */
export type CommandTable = readonly CommandEntry[];

/** The program's name in its help. */
const PROGRAM_NAME = "zenorm";

/** The help flags commander gives the program and every command. */
const HELP_FLAGS: readonly string[] = ["-h", "--help"];

/** The version flags the program takes. */
const VERSION_FLAGS: readonly string[] = ["-V", "--version"];

/** Native Windows is refused: ZeNorm runs on macOS and Linux, WSL 2 included. */
export function refusePlatform(platform: NodeJS.Platform): Result<null, StartupError> {
  if (platform !== "win32") return ok(null);
  return err({
    code: "platform_unsupported",
    message:
      "ZeNorm does not run on native Windows; install and run it inside WSL 2 (https://learn.microsoft.com/windows/wsl/install)",
    subject: platform,
  });
}

/** `major.minor.patch` of a Node version string, with or without its leading `v`. */
function versionParts(version: string): readonly [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    throw new Error(`${version} is not a Node version`);
  }
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`${version} is not a Node version`);
  }
  return [Number(major), Number(minor), Number(patch)];
}

/** Whether Node `version` is `minimum` or newer. */
export function isNodeAtLeast(version: string, minimum: string): boolean {
  const [haveMajor, haveMinor, havePatch] = versionParts(version);
  const [needMajor, needMinor, needPatch] = versionParts(minimum);
  if (haveMajor !== needMajor) return haveMajor > needMajor;
  if (haveMinor !== needMinor) return haveMinor > needMinor;
  return havePatch >= needPatch;
}

/** Node older than `MINIMUM_NODE_VERSION` is refused, naming both versions. */
export function refuseNodeVersion(nodeVersion: string): Result<null, StartupError> {
  if (isNodeAtLeast(nodeVersion, MINIMUM_NODE_VERSION)) return ok(null);
  return err({
    code: "node_version_unsupported",
    message: `ZeNorm needs Node ${MINIMUM_NODE_VERSION} or newer; this is Node ${nodeVersion}`,
    subject: nodeVersion,
  });
}

/** The refusals every command runs first, before reading its arguments or anything else. */
export function refuseEnvironment(input: CliInput): Result<null, StartupError> {
  const platform = refusePlatform(input.platform);
  if (!platform.ok) return platform;
  return refuseNodeVersion(input.nodeVersion);
}

/** `arguments_invalid` for `argv`, with `reason` and where the usage is. */
function argumentsInvalid(argv: readonly string[], reason: string): StartupError {
  return {
    code: "arguments_invalid",
    message: `${reason}. Run \`${PROGRAM_NAME} --help\` for the commands and their options`,
    subject: argv.join(" "),
  };
}

/**
 * What commander would accept but `zenorm` refuses as `arguments_invalid`: no command at all, and
 * help or version asked with anything else. Commander answers a help flag after an unknown command
 * or with an extra argument, and the version flag wherever it sits, before it checks the rest. So a
 * help or version flag is accepted only alone, or a help flag right after a command the table has.
 */
export function refuseBeforeParse(
  argv: readonly string[],
  table: CommandTable,
): Result<null, StartupError> {
  const names = table.map((entry) => entry.name);
  if (argv.length === 0) {
    return err(argumentsInvalid(argv, `Name a command: ${names.join(", ")}`));
  }
  const asked = argv.some((arg) => HELP_FLAGS.includes(arg) || VERSION_FLAGS.includes(arg));
  if (!asked || argv.length === 1) return ok(null);
  const [name, flag] = argv;
  if (
    argv.length === 2 &&
    name !== undefined &&
    flag !== undefined &&
    names.includes(name) &&
    HELP_FLAGS.includes(flag)
  ) {
    return ok(null);
  }
  const reason = `Ask for help alone or after a command (${names.join(", ")}); the version alone`;
  return err(argumentsInvalid(argv, reason));
}

/**
 * Every option value's check, in place of a choice list: an empty value, one that starts with
 * `-` (another option taken as the value) and a second value for the same option are refused.
 * There is no library default, so the first value arrives with `previous` undefined.
 */
function optionValue(value: string, previous: string | undefined): string {
  if (previous !== undefined) {
    throw new InvalidArgumentError("It is given more than once; give it once");
  }
  if (value === "") {
    throw new InvalidArgumentError("It is empty; give it a value");
  }
  if (value.startsWith("-")) {
    throw new InvalidArgumentError("It starts with -; give it a value, not another option");
  }
  return value;
}

/** The `--config` value commander parsed for a command, from its option values. */
function configValue(values: Readonly<Record<string, unknown>>): string | undefined {
  const config = values.config;
  if (config === undefined || typeof config === "string") return config;
  throw new Error(`--config parsed to a ${typeof config}, not a string`);
}

/** The arguments `configPath` reads the parsed `--config` value from. */
function configArgs(config: string | undefined): readonly string[] {
  if (config === undefined) return [];
  return [`--config=${config}`];
}

/** What a command's action ended with; null until one ran. */
interface Outcome {
  ended: Result<CommandEnd, StartupError> | null;
}

/**
 * The commander program for `table`. The exit and output hooks are set before any command is
 * added, since a command copies them only when it is added; the help command is off; every
 * command refuses excess arguments; and each option value goes through `optionValue`.
 */
function buildProgram(input: CliInput, table: CommandTable, outcome: Outcome) {
  const program = new CommanderCommand()
    .name(PROGRAM_NAME)
    .description(
      "ZeNorm: plan changes with a planning agent and get them delivered as reviewed branches.",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        input.writeOut(text);
      },
      // A refusal is reported once, through `report`; commander writes none of its own.
      writeErr: () => undefined,
      outputError: () => undefined,
    })
    .helpCommand(false)
    .allowExcessArguments(false)
    .version(manifest.version, "-V, --version", "print zenorm's version");
  for (const entry of table) {
    const command = program.command(entry.name).description(entry.description);
    for (const option of entry.options) {
      command.addOption(new Option(option.flags, option.description).argParser(optionValue));
    }
    command.action(async () => {
      const values: Readonly<Record<string, unknown>> = command.opts();
      outcome.ended = await entry.command({ ...input, config: configValue(values) });
    });
  }
  return program;
}

/**
 * `~/.config/zenorm/config.json`, the config file the command reads when neither `--config` nor
 * `ZENORM_CONFIG` is set; null without a `HOME`, so only those two can name one.
 */
export function standardConfigPath(env: Env): string | null {
  const home = env.HOME;
  if (home === undefined || home === "") return null;
  return join(home, ".config", "zenorm", "config.json");
}

/** The command's config path: `--config`, else `ZENORM_CONFIG`, else the standard path. */
export function cliConfigPath(config: string | undefined, env: Env): Result<string, StartupError> {
  return configPath(configArgs(config), env, standardConfigPath(env));
}

/** `zenorm run`: serves ZeNorm with the package's assets and no plugins, as `pnpm dev` does. */
export const runCommand: Command = async (context) => {
  const started = await startAndListen(
    {
      args: configArgs(context.config),
      ...context.assets,
      standardConfigPath: standardConfigPath(context.env),
      plugins: [],
    },
    context.env,
  );
  if (!started.ok) return started;
  return ok("serving");
};

/**
 * A refusal as readable text for a terminal: its message, then its code and subject, and for
 * `plugin_start_failed` the plugin and phase that failed. No line of it is JSON.
 */
export function formatRefusal(error: StartupError): string {
  const lines = [`zenorm: ${error.message}`, `  code: ${error.code}`];
  if (error.subject !== "") lines.push(`  subject: ${error.subject}`);
  if (error.code === "plugin_start_failed") {
    lines.push(`  plugin: ${error.data.pluginId}`, `  phase: ${error.data.phase}`);
  }
  return lines.join("\n");
}

/**
 * The reporter `runCli` refuses through: readable text when standard error is a terminal,
 * else apps/zenorm's one JSON line `{ code, message, subject }`. The bin passes whether
 * fd 2 is a terminal; tests choose either form.
 */
export function refusalReporter(stderrIsTerminal: boolean): (error: StartupError) => void {
  if (!stderrIsTerminal) return printRefusal;
  return (error) => {
    console.error(formatRefusal(error));
  };
}

/**
 * `zenorm <command>`: the platform and Node refusals, then the arguments, then the command from
 * `table`. Help and the version end with exit code 0; a refusal is reported with `report` and
 * ends with exit code 1.
 */
export async function runCli(
  input: CliInput,
  table: CommandTable,
  report: (error: StartupError) => void,
): Promise<CommandEnd> {
  const refused = refuseEnvironment(input);
  if (!refused.ok) {
    report(refused.error);
    return 1;
  }
  const checked = refuseBeforeParse(input.argv, table);
  if (!checked.ok) {
    report(checked.error);
    return 1;
  }
  const outcome: Outcome = { ended: null };
  try {
    await buildProgram(input, table, outcome).parseAsync([...input.argv], { from: "user" });
  } catch (error: unknown) {
    if (!(error instanceof CommanderError)) throw error;
    // Help and the version end this way too, with exit code 0.
    if (error.exitCode === 0) return 0;
    report(argumentsInvalid(input.argv, error.message));
    return 1;
  }
  const { ended } = outcome;
  if (ended === null) {
    throw new Error(`zenorm ${input.argv.join(" ")} parsed without running a command`);
  }
  if (!ended.ok) {
    report(ended.error);
    return 1;
  }
  return ended.value;
}
