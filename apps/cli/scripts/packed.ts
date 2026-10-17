import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `@ze-norm/cli` package folder. */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where the `pack` task (`scripts/pack.ts`) leaves the package's tarball, the one file the install
 * smoke test installs and the publish workflow publishes.
 */
export const PACK_DIR = join(PACKAGE_DIR, "pack");

/** The one tarball in `PACK_DIR`; none, or more than one, is an error naming the task to run. */
export function packedTarball(): string {
  const tarballs = readdirSync(PACK_DIR).filter((name) => name.endsWith(".tgz"));
  const [tarball] = tarballs;
  if (tarballs.length !== 1 || tarball === undefined) {
    throw new Error(
      `Expected one tarball in ${PACK_DIR}, found ${String(tarballs.length)}; run \`pnpm exec turbo run pack --filter=@ze-norm/cli\``,
    );
  }
  return join(PACK_DIR, tarball);
}
