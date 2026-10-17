import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "@zenorm/contracts";
import type { StartupError } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  cliConfigPath,
  formatRefusal,
  isNodeAtLeast,
  refusalReporter,
  runCli,
  standardConfigPath,
} from "./cli.ts";
import type { CliInput, Command, CommandTable } from "./cli.ts";
import { COMMANDS, withCommands } from "./commands.ts";
import { MINIMUM_NODE_VERSION, packagedAssets } from "./packaged.ts";

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

/** The package's own version, from apps/cli/package.json. */
function manifestVersion(): string {
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error("apps/cli/package.json has no version");
  }
  const { version } = manifest;
  if (typeof version !== "string") throw new Error("apps/cli/package.json has no version");
  return version;
}

let home: string;
let reported: StartupError[];
let written: string[];

function report(error: StartupError): void {
  reported.push(error);
}

/** A supported machine with `HOME` at the test's empty folder; each test changes what it stubs. */
function input(overrides: Partial<CliInput>): CliInput {
  return {
    argv: ["run"],
    env: { HOME: home },
    platform: "linux",
    nodeVersion: MINIMUM_NODE_VERSION,
    assets: packagedAssets(join(home, "dist")),
    writeOut: (text) => {
      written.push(text);
    },
    ...overrides,
  };
}

/** A `run` that records it was reached and does nothing else; no other command may be reached. */
function stubCommands(): { commands: CommandTable; run: Mock<Command> } {
  const run = vi.fn<Command>(() => Promise.resolve(ok(0)));
  const unreached = vi.fn<Command>(() => {
    throw new Error("only run is stubbed in these tests");
  });
  return { commands: withCommands({ init: unreached, run, doctor: unreached }), run };
}

function reportedCodes(): { code: string; subject: string }[] {
  return reported.map(({ code, subject }) => ({ code, subject }));
}

/**
 * The command names the program's help lists under `Commands:`: the first word of each line
 * indented by two spaces, up to the section's end. A wrapped description is indented further.
 */
function helpCommandNames(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.indexOf("Commands:");
  if (start === -1) throw new Error(`The help has no Commands: section:\n${help}`);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ")) break;
    const name = /^ {2}(\S+)/.exec(line)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

beforeEach(async () => {
  reported = [];
  written = [];
  home = await mkdtemp(join(tmpdir(), "zenorm-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the platform and Node refusals", () => {
  test("native Windows is platform_unsupported, exit 1, before the arguments or any command", async () => {
    const { commands, run } = stubCommands();
    for (const argv of [["run"], ["run", "--config", join(home, "config.json")], ["bogus"]]) {
      expect(await runCli(input({ argv, platform: "win32" }), commands, report)).toBe(1);
    }
    expect(reportedCodes()).toEqual([
      { code: "platform_unsupported", subject: "win32" },
      { code: "platform_unsupported", subject: "win32" },
      { code: "platform_unsupported", subject: "win32" },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  test.each(["26.11.0", "26.10.9", "24.12.0", "v22.0.0"])(
    "Node %s is node_version_unsupported, exit 1, before the arguments or any command",
    async (nodeVersion) => {
      const { commands, run } = stubCommands();
      expect(await runCli(input({ argv: ["bogus"], nodeVersion }), commands, report)).toBe(1);
      expect(reportedCodes()).toEqual([{ code: "node_version_unsupported", subject: nodeVersion }]);
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("the platform is refused before the Node version", async () => {
    const { commands } = stubCommands();
    const old = input({ platform: "win32", nodeVersion: "20.0.0" });
    expect(await runCli(old, commands, report)).toBe(1);
    expect(reportedCodes()).toEqual([{ code: "platform_unsupported", subject: "win32" }]);
  });

  test("no config is read when a refusal ends the command", async () => {
    const configFile = join(home, "config.json");
    await writeFile(configFile, "{ not json");
    const refused = input({ env: { HOME: home, ZENORM_CONFIG: configFile }, platform: "win32" });
    expect(await runCli(refused, COMMANDS, report)).toBe(1);
    // A config read would have refused `config_file_invalid` instead.
    expect(reportedCodes()).toEqual([{ code: "platform_unsupported", subject: "win32" }]);
    expect(await readdir(home)).toEqual(["config.json"]);
  });

  test.each(["26.11.1", "v26.11.1", "26.12.0", "27.0.0"])(
    "Node %s on macOS or Linux reaches the command with its --config",
    async (nodeVersion) => {
      for (const platform of ["darwin", "linux"] as const) {
        const { commands, run } = stubCommands();
        const argv = ["run", "--config", "/somewhere/config.json"];
        expect(await runCli(input({ argv, platform, nodeVersion }), commands, report)).toBe(0);
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0].config).toBe("/somewhere/config.json");
      }
      expect(reported).toEqual([]);
    },
  );

  test("isNodeAtLeast compares major, minor and patch as numbers", () => {
    expect(isNodeAtLeast("26.11.10", "26.11.9")).toBe(true);
    expect(isNodeAtLeast("26.9.0", "26.11.1")).toBe(false);
    expect(isNodeAtLeast("100.0.0", "26.11.1")).toBe(true);
  });
});

describe("help and the version", () => {
  test.each([
    { name: "--help", argv: ["--help"] },
    { name: "-h", argv: ["-h"] },
    ...COMMANDS.map((entry) => ({ name: `${entry.name} --help`, argv: [entry.name, "--help"] })),
    ...COMMANDS.map((entry) => ({ name: `${entry.name} -h`, argv: [entry.name, "-h"] })),
  ])("$name writes help to stdout and ends with exit code 0", async ({ argv }) => {
    const { commands, run } = stubCommands();
    expect(await runCli(input({ argv }), commands, report)).toBe(0);
    expect(written.join("")).toMatch(/^Usage: zenorm /);
    expect(reported).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test.each([["--version"], ["-V"]])(
    "%s writes the package's version and ends with exit code 0",
    async (flag) => {
      const { commands, run } = stubCommands();
      expect(await runCli(input({ argv: [flag] }), commands, report)).toBe(0);
      expect(written.join("")).toBe(`${manifestVersion()}\n`);
      expect(reported).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    },
  );

  test.each([["--help"], ["--version"], ["run", "--help"]])(
    "%s on native Windows or old Node is refused first, with no output",
    async (...argv) => {
      const { commands } = stubCommands();
      expect(await runCli(input({ argv, platform: "win32" }), commands, report)).toBe(1);
      expect(await runCli(input({ argv, nodeVersion: "26.11.0" }), commands, report)).toBe(1);
      expect(reported.map(({ code }) => code)).toEqual([
        "platform_unsupported",
        "node_version_unsupported",
      ]);
      expect(written).toEqual([]);
    },
  );

  test("the program's help lists exactly the COMMANDS table's commands", async () => {
    expect(await runCli(input({ argv: ["--help"] }), COMMANDS, report)).toBe(0);
    expect(helpCommandNames(written.join(""))).toEqual(COMMANDS.map((entry) => entry.name));
  });
});

describe("malformed command lines are arguments_invalid", () => {
  test.each([
    { name: "no command", argv: [] },
    { name: "an unknown command", argv: ["bogus"] },
    { name: "an unknown command named start", argv: ["start"] },
    { name: "the help command, which is off", argv: ["help"] },
    { name: "the help command with a command", argv: ["help", "run"] },
    { name: "an option in place of the command", argv: ["--config", "config.json"] },
    { name: "an unknown option", argv: ["run", "--bogus"] },
    { name: "an unknown option with a value", argv: ["run", "--port", "4310"] },
    { name: "--config without its value", argv: ["run", "--config"] },
    { name: "--config with another option as its value", argv: ["run", "--config", "--bogus"] },
    { name: "--config with an empty value", argv: ["run", "--config="] },
    { name: "--config given empty as its own argument", argv: ["run", "--config", ""] },
    { name: "--config given twice", argv: ["run", "--config", "a.json", "--config", "b.json"] },
    { name: "--config given twice with =", argv: ["run", "--config=a.json", "--config=a.json"] },
    { name: "an unexpected positional", argv: ["run", "extra"] },
    { name: "a positional beside --config", argv: ["run", "--config", "a.json", "extra"] },
    { name: "help with an unknown command", argv: ["bogus", "--help"] },
    { name: "help with an extra argument", argv: ["run", "--help", "extra"] },
    { name: "help before the command", argv: ["--help", "run"] },
    { name: "the version with an extra argument", argv: ["--version", "bogus"] },
    { name: "the version after a command", argv: ["run", "--version"] },
    { name: "help and the version together", argv: ["--help", "--version"] },
  ])("$name: exit 1, one arguments_invalid, no command reached", async ({ argv }) => {
    const { commands, run } = stubCommands();
    expect(await runCli(input({ argv }), commands, report)).toBe(1);
    expect(reportedCodes()).toEqual([{ code: "arguments_invalid", subject: argv.join(" ") }]);
    expect(run).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  test.each(COMMANDS.map((entry) => entry.name))(
    "%s refuses an unknown option before it runs",
    async (name) => {
      const { commands, run } = stubCommands();
      expect(await runCli(input({ argv: [name, "--bogus"] }), commands, report)).toBe(1);
      expect(reported.map(({ code }) => code)).toEqual(["arguments_invalid"]);
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("zenorm run's config path", () => {
  test("with neither --config nor ZENORM_CONFIG, config_file_missing names ~/.config/zenorm/config.json", async () => {
    expect(await runCli(input({ argv: ["run"] }), COMMANDS, report)).toBe(1);
    expect(reportedCodes()).toEqual([
      { code: "config_file_missing", subject: join(home, ".config", "zenorm", "config.json") },
    ]);
  });

  test("--config and ZENORM_CONFIG both set is config_path_ambiguous", async () => {
    const both = input({
      argv: ["run", "--config", join(home, "a.json")],
      env: { HOME: home, ZENORM_CONFIG: join(home, "b.json") },
    });
    expect(await runCli(both, COMMANDS, report)).toBe(1);
    expect(reported.map(({ code }) => code)).toEqual(["config_path_ambiguous"]);
  });

  test("--config names the file run reads, over the standard path", async () => {
    const chosen = join(home, "chosen.json");
    expect(await runCli(input({ argv: ["run", "--config", chosen] }), COMMANDS, report)).toBe(1);
    expect(reportedCodes()).toEqual([{ code: "config_file_missing", subject: chosen }]);
  });

  test("--config=<path> names the same file", async () => {
    const chosen = join(home, "chosen.json");
    const argv = ["run", `--config=${chosen}`];
    expect(await runCli(input({ argv }), COMMANDS, report)).toBe(1);
    expect(reportedCodes()).toEqual([{ code: "config_file_missing", subject: chosen }]);
  });

  test("cliConfigPath: --config, else ZENORM_CONFIG, else the standard path; no HOME, no standard path", () => {
    const standard = join(home, ".config", "zenorm", "config.json");
    expect(standardConfigPath({ HOME: home })).toBe(standard);
    expect(cliConfigPath(undefined, { HOME: home })).toEqual(ok(standard));
    const withEnv = { HOME: home, ZENORM_CONFIG: "/env.json" };
    expect(cliConfigPath(undefined, withEnv)).toEqual(ok("/env.json"));
    expect(cliConfigPath("/flag.json", { HOME: home })).toEqual(ok("/flag.json"));
    const both = cliConfigPath("/flag.json", withEnv);
    expect(both.ok ? null : both.error.code).toBe("config_path_ambiguous");
    expect(standardConfigPath({})).toBeNull();
    const missing = cliConfigPath(undefined, {});
    expect(missing.ok ? null : missing.error.code).toBe("config_path_missing");
  });
});

/** Records what goes to standard error through `console.error`, one entry per call, and hides it. */
function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...data: unknown[]) => {
    const [text] = data;
    if (data.length !== 1 || typeof text !== "string") {
      throw new Error("a refusal is written to stderr as one string");
    }
    lines.push(text);
  });
  return lines;
}

/** Whether `line` parses as JSON. */
function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

describe("refusals piped and at a terminal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const refusals: readonly { code: string; overrides: Partial<CliInput> }[] = [
    { code: "arguments_invalid", overrides: { argv: ["bogus"] } },
    { code: "platform_unsupported", overrides: { platform: "win32" } },
    { code: "config_file_missing", overrides: { argv: ["run"] } },
  ];

  test.each(refusals)(
    "$code with stderr not a terminal is exactly one JSON line with code, message and subject",
    async ({ code, overrides }) => {
      const stderr = captureStderr();
      expect(await runCli(input(overrides), COMMANDS, refusalReporter(false))).toBe(1);
      expect(stderr).toHaveLength(1);
      const [line] = stderr;
      if (line === undefined) throw new Error("no refusal was written");
      expect(line).not.toContain("\n");
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toHaveProperty("code", code);
      expect(parsed).toHaveProperty("message");
      expect(parsed).toHaveProperty("subject");
    },
  );

  test.each(refusals)(
    "$code with stderr a terminal is readable text naming its code, with no JSON line",
    async ({ code, overrides }) => {
      const stderr = captureStderr();
      expect(await runCli(input(overrides), COMMANDS, refusalReporter(true))).toBe(1);
      expect(stderr).toHaveLength(1);
      const text = stderr.join("\n");
      expect(text).toContain(code);
      expect(text.split("\n").filter(isJson)).toEqual([]);
    },
  );

  test("plugin_start_failed at a terminal names its plugin and phase too", () => {
    const text = formatRefusal({
      code: "plugin_start_failed",
      message: "The plugin failed to start",
      subject: "example",
      data: { pluginId: "example", phase: "routes" },
    });
    expect(text).toContain("plugin_start_failed");
    expect(text).toContain("example");
    expect(text).toContain("routes");
    expect(text.split("\n").filter(isJson)).toEqual([]);
  });
});

describe("the package", () => {
  test("ships the zenorm bin and dist, needs Node 26.11.1 or newer, and declares no os field", () => {
    expect(manifest).toMatchObject({
      name: "@ze-norm/cli",
      type: "module",
      bin: { zenorm: "dist/zenorm.js" },
      files: ["dist"],
      engines: { node: `>=${MINIMUM_NODE_VERSION}` },
    });
    expect(manifest).not.toHaveProperty("os");
    expect(manifest).not.toHaveProperty("private");
  });

  test("better-sqlite3 is its only runtime dependency; the workspace and commander are bundled", () => {
    expect(manifest).toHaveProperty("dependencies", { "better-sqlite3": "catalog:" });
  });

  test("the packaged assets sit beside the bundle in dist/", () => {
    expect(packagedAssets("/pkg/dist")).toEqual({
      webDistDir: "/pkg/dist/web",
      skillsDir: "/pkg/dist/skills",
      migrationsFolder: "/pkg/dist/migrations",
    });
  });
});
