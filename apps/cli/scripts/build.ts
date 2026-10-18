import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { webDistDir } from "@zenorm/web";
import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";
import { build } from "esbuild";

import { MINIMUM_NODE_VERSION, PACKAGED_ASSET_DIRS } from "../src/packaged.ts";

/**
 * Builds `@ze-norm/cli` into `dist/`: the `zenorm` bin bundled to one JavaScript file, with the
 * repository's skills, migrations and web build copied beside it. better-sqlite3 and
 * playwright-core (the screenshot capture's Playwright MCP server, which the capture session starts
 * as its own Node process) stay real dependencies, loaded from the installed package's
 * `node_modules`.
 */

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(packageDir, "dist");

const webIndex = join(webDistDir, "index.html");
if (!existsSync(webIndex)) {
  throw new Error(`No web build at ${webIndex}; build @zenorm/web first`);
}

await rm(distDir, { recursive: true, force: true });

await build({
  entryPoints: [join(packageDir, "src", "zenorm.ts")],
  outfile: join(distDir, "zenorm.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${MINIMUM_NODE_VERSION}`,
  external: ["better-sqlite3", "playwright-core"],
  // The bin's shebang, and a `require` for the bundled CommonJS modules, which ESM has none of.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as zenormCreateRequire } from "node:module";',
      "const require = zenormCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

/** A skill's own dependencies are never shipped; only its files. */
function notNodeModules(source: string): boolean {
  return basename(source) !== "node_modules";
}

await cp(SOURCE_ASSETS.skillsDir, join(distDir, PACKAGED_ASSET_DIRS.skillsDir), {
  recursive: true,
  filter: notNodeModules,
});
await cp(SOURCE_ASSETS.migrationsFolder, join(distDir, PACKAGED_ASSET_DIRS.migrationsFolder), {
  recursive: true,
});
await cp(webDistDir, join(distDir, PACKAGED_ASSET_DIRS.webDistDir), { recursive: true });
