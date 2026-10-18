import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The package the capture session's Playwright MCP server comes from, pinned in the workspace
 * catalog and a dependency of this package: `playwright-core`, whose `lib/entry/mcp.js` is the
 * Playwright MCP server (`Playwright MCP`, the same server `@playwright/mcp` starts). Changing the
 * pinned server is this name, its entry and the catalog's version.
 */
export const PLAYWRIGHT_MCP_PACKAGE = "playwright-core";

/** The server's entry, relative to the package's folder. */
const PLAYWRIGHT_MCP_ENTRY = "lib/entry/mcp.js";

/** The MCP server's name in the capture session's MCP config: its tools are `mcp__<name>__*`. */
export const PLAYWRIGHT_MCP_SERVER_NAME = "playwright";

/** How the capture session's MCP config starts a server: a command and its arguments. */
export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How the capture session starts the pinned Playwright MCP server: this Node binary running the
 * pinned package's server entry, resolved from this module, so neither `npx` nor the network is
 * used. The server's own flags are added by the caller.
 */
export function playwrightMcpLaunch(): McpServerLaunch {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(`${PLAYWRIGHT_MCP_PACKAGE}/package.json`);
  return { command: process.execPath, args: [join(dirname(packageJson), PLAYWRIGHT_MCP_ENTRY)] };
}
