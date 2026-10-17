import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACK_DIR, PACKAGE_DIR, packedTarball } from "./packed.ts";

/**
 * Packs the built `@ze-norm/cli` into `pack/` (the `pack` turbo task, after `build`), the tarball
 * the install smoke test installs and the publish workflow publishes (C1, C6).
 *
 * The published manifest is written here rather than by `pnpm pack`: pnpm refuses to rewrite the
 * `workspace:*` development dependencies, whose private packages have no version, and they are
 * bundled into `dist/` anyway. So the tarball's `package.json` carries the package's own fields,
 * no scripts and no development dependencies, and each `catalog:` dependency pinned to the
 * version the workspace installed (the catalog's exact pin). The repository's README and LICENSE
 * go in beside `dist/`.
 */

const repoDir = join(PACKAGE_DIR, "..", "..");

/** The manifest fields the tarball keeps as they are; each must be present. */
const PUBLISHED_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "repository",
  "type",
  "bin",
  "files",
  "engines",
  "publishConfig",
] as const;

/** The root files every published package carries beside `dist/`. */
const ROOT_FILES = ["README.md", "LICENSE"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(path: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(manifest)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return manifest;
}

/** The version of `name` the workspace installed for this package. */
function installedVersion(name: string): string {
  const path = join(PACKAGE_DIR, "node_modules", name, "package.json");
  const { version } = readManifest(path);
  if (typeof version !== "string") {
    throw new Error(`${path} has no version`);
  }
  return version;
}

/** Each runtime dependency pinned to its installed version; only `catalog:` ranges are expected. */
function publishedDependencies(dependencies: unknown): Record<string, string> {
  if (!isRecord(dependencies)) {
    throw new Error("@ze-norm/cli's package.json has no dependencies object");
  }
  const pinned: Record<string, string> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (range !== "catalog:") {
      throw new Error(
        `@ze-norm/cli's dependency ${name} is ${JSON.stringify(range)}; pin it in the pnpm catalog`,
      );
    }
    pinned[name] = installedVersion(name);
  }
  return pinned;
}

function publishedManifest(): Record<string, unknown> {
  const manifest = readManifest(join(PACKAGE_DIR, "package.json"));
  const published: Record<string, unknown> = {};
  for (const field of PUBLISHED_FIELDS) {
    if (!(field in manifest)) {
      throw new Error(`@ze-norm/cli's package.json has no ${field}`);
    }
    published[field] = manifest[field];
  }
  published.dependencies = publishedDependencies(manifest.dependencies);
  return published;
}

const distDir = join(PACKAGE_DIR, "dist");
const bundle = join(distDir, "zenorm.js");
if (!existsSync(bundle)) {
  throw new Error(`No build at ${bundle}; run the @ze-norm/cli build first`);
}

const manifestJson = `${JSON.stringify(publishedManifest(), null, 2)}\n`;
const stagingDir = mkdtempSync(join(tmpdir(), "zenorm-pack-"));
writeFileSync(join(stagingDir, "package.json"), manifestJson);
cpSync(distDir, join(stagingDir, "dist"), { recursive: true });
for (const file of ROOT_FILES) {
  cpSync(join(repoDir, file), join(stagingDir, file));
}

rmSync(PACK_DIR, { recursive: true, force: true });
mkdirSync(PACK_DIR, { recursive: true });
execFileSync("npm", ["pack", "--pack-destination", PACK_DIR], {
  cwd: stagingDir,
  stdio: "inherit",
});
rmSync(stagingDir, { recursive: true, force: true });

console.log(`Packed ${packedTarball()}`);
