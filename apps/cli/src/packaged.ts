import { join } from "node:path";

import type { ZeNormAssets } from "@zenorm/zenorm/startup";

/** The oldest Node the command runs on; `package.json`'s `engines.node` names the same. */
export const MINIMUM_NODE_VERSION = "26.11.1";

/** The folders inside the package's `dist/`, beside the bundle, that the build copies in. */
export const PACKAGED_ASSET_DIRS = {
  webDistDir: "web",
  skillsDir: "skills",
  migrationsFolder: "migrations",
} as const;

/** The assets the built package ships in `distDir`, the bundle's own folder. */
export function packagedAssets(distDir: string): ZeNormAssets {
  return {
    webDistDir: join(distDir, PACKAGED_ASSET_DIRS.webDistDir),
    skillsDir: join(distDir, PACKAGED_ASSET_DIRS.skillsDir),
    migrationsFolder: join(distDir, PACKAGED_ASSET_DIRS.migrationsFolder),
  };
}
