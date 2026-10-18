import { accessSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, homedir, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { err, ok } from "@zenorm/contracts";
import type { CaptureBrowserMissingError, Result } from "@zenorm/contracts";
import { z } from "zod";

/**
 * The package the capture session's Playwright MCP server comes from, pinned in the workspace
 * catalog and a dependency of this package: `playwright-core`, whose `lib/entry/mcp.js` is the
 * Playwright MCP server (`Playwright MCP`, the same server `@playwright/mcp` starts). Changing the
 * pinned server is this name, its entry and the catalog's version.
 */
export const PLAYWRIGHT_MCP_PACKAGE = "playwright-core";

/** The server's entry, relative to the package's folder. */
export const PLAYWRIGHT_MCP_ENTRY = "lib/entry/mcp.js";

/** The MCP server's name in the capture session's MCP config: its tools are `mcp__<name>__*`. */
export const PLAYWRIGHT_MCP_SERVER_NAME = "playwright";

/** How the capture session's MCP config starts a server: a command and its arguments. */
export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** The pinned Playwright MCP server as installed: its package folder, version and launch. */
export interface PlaywrightMcp {
  readonly packageDir: string;
  readonly version: string;
  readonly launch: McpServerLaunch;
}

const PackageJson = z.looseObject({ version: z.string().min(1) });

/**
 * The pinned Playwright MCP server, resolved from this module: this Node binary running the
 * package's server entry, so neither `npx` nor the network is used (the server's own flags are
 * added by the caller). A package that does not resolve, as on an install that lost it, is
 * `capture_browser_missing`, never a throw.
 */
export function resolvePlaywrightMcp(): Result<PlaywrightMcp, CaptureBrowserMissingError> {
  const require = createRequire(import.meta.url);
  let packageJson: string;
  try {
    packageJson = require.resolve(`${PLAYWRIGHT_MCP_PACKAGE}/package.json`);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      return err({
        code: "capture_browser_missing",
        message: `The Playwright MCP server (${PLAYWRIGHT_MCP_PACKAGE}) is not installed beside ZeNorm; reinstall ZeNorm`,
      });
    }
    throw error;
  }
  const packageDir = dirname(packageJson);
  const { version } = PackageJson.parse(JSON.parse(readFileSync(packageJson, "utf8")));
  return ok({
    packageDir,
    version,
    launch: { command: process.execPath, args: [join(packageDir, PLAYWRIGHT_MCP_ENTRY)] },
  });
}

/**
 * The command that installs the Chromium build the pinned server `version` drives, without its
 * headless shell (the capture session runs Chrome for Testing, `--browser chromium`). ZeNorm never
 * runs it: the person does, once.
 */
export function captureBrowserInstallCommand(version: string): string {
  return `npx ${PLAYWRIGHT_MCP_PACKAGE}@${version} install --no-shell chromium`;
}

/** The environment the browser's location is read from, as Playwright reads it. */
export type BrowserEnv = Readonly<Record<string, string | undefined>>;

/**
 * Playwright's own read of a setting: the variable, else npm's `npm_config_<name>`, else
 * `npm_package_config_<name>`.
 */
function playwrightEnv(env: BrowserEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of [name, `npm_config_${lower}`, `npm_package_config_${lower}`]) {
    const value = env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A set, non-empty variable, or undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Playwright's per-user cache folder, by platform; null on a platform it does not support. */
function cacheDirectory(env: BrowserEnv): string | null {
  switch (process.platform) {
    case "linux":
      return nonEmpty(env.XDG_CACHE_HOME) ?? join(homedir(), ".cache");
    case "darwin":
      return join(homedir(), "Library", "Caches");
    case "win32":
      return nonEmpty(env.LOCALAPPDATA) ?? join(homedir(), "AppData", "Local");
    default:
      return null;
  }
}

/**
 * Where Playwright keeps its browsers, as `playwright-core`'s registry computes it:
 * `PLAYWRIGHT_BROWSERS_PATH` (`0` is the package's own `.local-browsers`, a relative path resolves
 * against `INIT_CWD` or `cwd`), else `ms-playwright` in the user's cache folder.
 */
function browsersDirectory(env: BrowserEnv, cwd: string, packageDir: string): string | null {
  const fromEnv = nonEmpty(playwrightEnv(env, "PLAYWRIGHT_BROWSERS_PATH"));
  let dir: string;
  if (fromEnv === "0") {
    dir = join(packageDir, ".local-browsers");
  } else if (fromEnv !== undefined) {
    dir = fromEnv;
  } else {
    const cache = cacheDirectory(env);
    if (cache === null) return null;
    dir = join(cache, "ms-playwright");
  }
  return isAbsolute(dir) ? dir : resolve(nonEmpty(playwrightEnv(env, "INIT_CWD")) ?? cwd, dir);
}

/** Chromium's executable inside its build folder, by Playwright's short platform. */
const CHROMIUM_EXECUTABLE: Readonly<Record<string, readonly string[]>> = {
  "linux-x64": ["chrome-linux64", "chrome"],
  "linux-arm64": ["chrome-linux-arm64", "chrome"],
  "mac-x64": [
    "chrome-mac-x64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  ],
  "mac-arm64": [
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  ],
  "win-x64": ["chrome-win64", "chrome.exe"],
};

/** The first Darwin release of macOS 11, the first macOS with Apple silicon builds. */
const DARWIN_MACOS_11 = 20;

/** Playwright's short platform for this machine, as its host platform computes it. */
function shortPlatform(): string | null {
  switch (process.platform) {
    case "darwin": {
      // The release is `<major>.<minor>.<patch>`; parsing stops at the first dot.
      const darwinMajor = Number.parseInt(release(), 10);
      const appleSilicon =
        darwinMajor >= DARWIN_MACOS_11 && cpus().some((cpu) => cpu.model.includes("Apple"));
      return appleSilicon ? "mac-arm64" : "mac-x64";
    }
    case "linux":
      if (process.arch === "x64") return "linux-x64";
      if (process.arch === "arm64") return "linux-arm64";
      return null;
    case "win32":
      return "win-x64";
    default:
      return null;
  }
}

const BrowsersJson = z.looseObject({
  browsers: z.array(
    z.looseObject({
      name: z.string(),
      revision: z.string().min(1),
      browserVersion: z.string().optional(),
      revisionOverrides: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

/** Where the Chromium build the pinned server drives must be, and how to install it. */
export interface CaptureBrowser {
  readonly server: PlaywrightMcp;
  /** The build's revision in the pinned package's `browsers.json`. */
  readonly revision: string;
  /** The folder Playwright keeps its browser builds in, one `chromium-<revision>` each. */
  readonly browsersDir: string;
  readonly executablePath: string;
  readonly installCommand: string;
}

/**
 * Where the pinned Playwright MCP server looks for the Chromium build it drives, read from its own
 * `browsers.json` so the build always matches the pinned version; `cwd` is the server's working
 * folder, against which a relative `PLAYWRIGHT_BROWSERS_PATH` resolves. Reads only; checks
 * nothing exists but the server. `capture_browser_missing` when the server is not installed or
 * this platform has no Chromium build.
 */
export function locateCaptureBrowser(
  env: BrowserEnv,
  cwd: string,
): Result<CaptureBrowser, CaptureBrowserMissingError> {
  const server = resolvePlaywrightMcp();
  if (!server.ok) return server;
  const { packageDir, version } = server.value;
  const installCommand = captureBrowserInstallCommand(version);
  const browsers = BrowsersJson.parse(
    JSON.parse(readFileSync(join(packageDir, "browsers.json"), "utf8")),
  );
  const chromium = browsers.browsers.find((browser) => browser.name === "chromium");
  if (chromium === undefined) {
    throw new Error(`${PLAYWRIGHT_MCP_PACKAGE}@${version}'s browsers.json names no chromium`);
  }
  // No pinned version overrides Chromium's revision per platform; one that does needs this read.
  if (
    chromium.revisionOverrides !== undefined &&
    Object.keys(chromium.revisionOverrides).length > 0
  ) {
    throw new Error(`${PLAYWRIGHT_MCP_PACKAGE}@${version} overrides chromium's revision`);
  }
  const platform = shortPlatform();
  const tokens = platform === null ? undefined : CHROMIUM_EXECUTABLE[platform];
  const dir = browsersDirectory(env, cwd, packageDir);
  if (tokens === undefined || dir === null) {
    return err({
      code: "capture_browser_missing",
      message: `Playwright has no Chromium build for ${process.platform} ${process.arch}`,
    });
  }
  return ok({
    server: server.value,
    revision: chromium.revision,
    browsersDir: dir,
    executablePath: join(dir, `chromium-${chromium.revision}`, ...tokens),
    installCommand,
  });
}

/**
 * The Chromium build folders other than `revision`'s in `dir`: an install for another Playwright
 * version. None when `dir` does not exist.
 */
function otherChromiumBuilds(dir: string, revision: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return [];
    }
    throw error;
  }
  return names.filter((name) => /^chromium-\d+$/.test(name) && name !== `chromium-${revision}`);
}

/**
 * Whether the Chromium build the pinned Playwright MCP server drives is installed where the server
 * looks for it (`locateCaptureBrowser`), as Playwright decides: its executable can be accessed.
 * Reads only, and never downloads it. `capture_browser_missing` naming the install command when it
 * is missing, or when only a build for another Playwright version is there.
 */
export function checkCaptureBrowser(
  env: BrowserEnv,
  cwd: string,
): Result<CaptureBrowser, CaptureBrowserMissingError> {
  const located = locateCaptureBrowser(env, cwd);
  if (!located.ok) return located;
  const { executablePath, revision, browsersDir, installCommand } = located.value;
  try {
    accessSync(executablePath);
    return located;
  } catch {
    const others = otherChromiumBuilds(browsersDir, revision);
    const found =
      others.length === 0
        ? "is not installed"
        : `is not installed (only ${others.join(", ")}, for another Playwright version)`;
    return err({
      code: "capture_browser_missing",
      message: `The screenshot browser, Chromium build ${revision}, ${found} at ${executablePath}. Install it with \`${installCommand}\``,
    });
  }
}
