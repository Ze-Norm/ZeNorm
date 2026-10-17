import { join } from "node:path";

/** Set by `playwright.config.ts` in the runner (the name `fake-claude.ts` reads); workers inherit it. */
export const E2E_ROOT_ENV_VAR = "ZENORM_E2E_ROOT";

/** What `seed.ts` wrote before the server started: a map in a project the plugin later denies. */
export const SEEDED_FILE = "seeded.json";

export function e2eRoot(): string {
  const root = process.env[E2E_ROOT_ENV_VAR];
  if (root === undefined) {
    throw new Error(`${E2E_ROOT_ENV_VAR} is not set; playwright.config.ts sets it`);
  }
  return root;
}

/**
 * The fixture repositories, one commit on `main` each. Their folder names are the project names
 * the config's `example` section names: `denied-repo` in `deniedProjectNames`, `refused-repo` in
 * `refusedDeliveryProjectNames`; `example-repo` is in neither.
 */
export const REPO_NAMES = ["example-repo", "denied-repo", "refused-repo"] as const;
export type RepoName = (typeof REPO_NAMES)[number];

export function repo(name: RepoName): string {
  return join(e2eRoot(), name);
}
