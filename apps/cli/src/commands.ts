import { runCommand } from "./cli.ts";
import type { Command, CommandOption, CommandTable } from "./cli.ts";
import { doctorCommand, printDoctorCheck } from "./doctor.ts";
import { initCommand, processTerminal } from "./init.ts";

/** `--config`, the one option every command takes (C2). */
const CONFIG_OPTION: CommandOption = {
  flags: "--config <path>",
  description: "the config file (else ZENORM_CONFIG, else ~/.config/zenorm/config.json)",
};

/**
 * The one command table (C8): every command `zenorm` takes, with its description, its options and
 * what it runs, in the order its help lists them. Adding a command is adding one entry here; no
 * other list of command names exists. `init` asks on the process's terminal, `doctor` prints to it.
 */
export const COMMANDS: CommandTable = [
  {
    name: "init",
    description: "sign in to Claude Code and write a config",
    options: [CONFIG_OPTION],
    command: initCommand(processTerminal()),
  },
  {
    name: "run",
    description: "serve ZeNorm from the config",
    options: [CONFIG_OPTION],
    command: runCommand,
  },
  {
    name: "doctor",
    description: "check this machine and the config, changing nothing",
    options: [CONFIG_OPTION],
    command: doctorCommand(printDoctorCheck),
  },
];

/**
 * The table with what some commands run replaced, for tests: each key of `replaced` must name a
 * command in `COMMANDS`.
 */
export function withCommands(replaced: Readonly<Record<string, Command>>): CommandTable {
  const names = COMMANDS.map((entry) => entry.name);
  for (const name of Object.keys(replaced)) {
    if (!names.includes(name)) {
      throw new Error(`${name} is not a command in COMMANDS (${names.join(", ")})`);
    }
  }
  return COMMANDS.map((entry) => {
    const command = Object.entries(replaced).find(([name]) => name === entry.name);
    return command === undefined ? entry : { ...entry, command: command[1] };
  });
}
