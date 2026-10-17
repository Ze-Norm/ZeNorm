import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * The run's root, made once by `playwright.config.ts` in the runner: the runner record, the lock
 * server's `config.json` and `data/`, and `servers/`. Workers and the teardown inherit it.
 */
export const E2E_RUN_ROOT_ENV_VAR = "ZENORM_E2E_RUN_ROOT";

export function e2eRunRoot(): string {
  const root = process.env[E2E_RUN_ROOT_ENV_VAR];
  if (root === undefined) {
    throw new Error(`${E2E_RUN_ROOT_ENV_VAR} is not set; playwright.config.ts sets it`);
  }
  return root;
}

/**
 * The worker's root, made by `worker-server.ts` in each worker before its server starts: every
 * fixture repository, `data/` and `config.json`. The worker's server inherits it, and with it the
 * stand-in (`fake-claude.ts`), which keeps its marker files there.
 */
export const E2E_ROOT_ENV_VAR = "ZENORM_E2E_ROOT";

export function e2eRoot(): string {
  const root = process.env[E2E_ROOT_ENV_VAR];
  if (root === undefined) {
    throw new Error(`${E2E_ROOT_ENV_VAR} is not set; worker-server.ts sets it in each worker`);
  }
  return root;
}

/**
 * Where each `node src/main.ts` the e2e spawns is recorded: a file under the run's root
 * named by the pid, holding the folder to remove with it. Whoever stops the server removes the
 * file; one left here means a worker died first, and the global teardown kills that pid.
 */
export const SERVER_RECORDS_DIR = "servers";

export function serverRecordFile(pid: number): string {
  return join(e2eRunRoot(), SERVER_RECORDS_DIR, String(pid));
}

/** Records the server `pid`, whose folder `folder` goes with it. */
export function recordServer(pid: number, folder: string): void {
  mkdirSync(join(e2eRunRoot(), SERVER_RECORDS_DIR), { recursive: true });
  writeFileSync(serverRecordFile(pid), folder);
}

/**
 * A port the system reports free on `host` at call time: a fixed port could collide with another
 * server (4320–4329 is reserved for QA servers that run while gates run). Another process could
 * take it before the caller's server binds; the caller waits for its server's own listening line,
 * which a taken port never prints.
 */
export async function freePort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error(`No port in the probe's address ${JSON.stringify(address)}`));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

/** The fixture git repository: one commit on `main`. */
export function fixtureRepo(): string {
  return join(e2eRoot(), "repo");
}

/** The second fixture repository, for the maps test: one commit on `main`. */
export function mapsRepo(): string {
  return join(e2eRoot(), "maps-repo");
}

/** The fixture repository `drafts.spec.ts` adds as its own project: one commit on `main`. */
export function draftsRepo(): string {
  return join(e2eRoot(), "drafts-repo");
}

/** The fixture repository `delivery.spec.ts` adds as its own project: one commit on `main`. */
export function deliveryRunsRepo(): string {
  return join(e2eRoot(), "delivery-runs-repo");
}

/** The fixture repository `specs.spec.ts` adds as its own project: one commit on `main`. */
export function specsRepo(): string {
  return join(e2eRoot(), "specs-repo");
}

/** The fixture repository `projects.spec.ts` adds as its own project: one commit on `main`. */
export function projectsRepo(): string {
  return join(e2eRoot(), "projects-repo");
}

/** The fixture repository `projects.spec.ts` adds from the Inbox composer: one commit on `main`. */
export function composerRepo(): string {
  return join(e2eRoot(), "composer-repo");
}

/** The project of `maps.spec.ts`'s scenarios beyond its chart flow: one commit on `main`. */
export function mapsFlowsRepo(): string {
  return join(e2eRoot(), "maps-flows-repo");
}

/**
 * The project `maps.spec.ts`'s delivered-map scenario adds as its own, so its map writes spec 1
 * and is the only one under Completed: one commit on `main`.
 */
export function mapsDeliveredRepo(): string {
  return join(e2eRoot(), "maps-delivered-repo");
}

/** The fixture repository the live flow (`live.spec.ts`) adds as its own project: one commit on `main`. */
export function liveRepo(): string {
  return join(e2eRoot(), "live-repo");
}

/** The fixture repository the escape hatch flows add as their own project: one commit on `main`. */
export function hatchRepo(): string {
  return join(e2eRoot(), "hatch-repo");
}

/** The file that releases the stand-in's `[fake:review-held]` review (`fake-claude.ts`). */
export function reviewReleaseFile(): string {
  return join(e2eRoot(), "fake-review-release");
}

/** The file that releases the stand-in's `[fake:survey-held]` code survey. */
export function surveyReleaseFile(): string {
  return join(e2eRoot(), "fake-survey-release");
}

/** The file that releases the stand-in's `[fake:tickets-review-held]` tickets review. */
export function ticketsReviewReleaseFile(): string {
  return join(e2eRoot(), "fake-tickets-review-release");
}

/**
 * The keys of the stand-in's `[fake:tickets-repair-held:<key>]`, one per spec file that holds a
 * tickets repair, so files running at once never release each other's.
 */
export type TicketsRepairKey = "tickets" | "revisions";

/** The idea marker that holds a tickets repair under `key`. */
export function ticketsRepairHeld(key: TicketsRepairKey): string {
  return `[fake:tickets-repair-held:${key}]`;
}

/** The file that releases the stand-in's `[fake:tickets-repair-held:<key>]` tickets repair. */
export function ticketsRepairReleaseFile(key: TicketsRepairKey): string {
  return join(e2eRoot(), `fake-tickets-repair-release-${key}`);
}

/** The file that releases the stand-in's `[fake:delivery-held]` orchestrator. */
export function deliveryReleaseFile(): string {
  return join(e2eRoot(), "fake-delivery-release");
}

/** The file that releases the stand-in's `[fake:delivery-closing-held]` orchestrator. */
export function deliveryClosingReleaseFile(): string {
  return join(e2eRoot(), "fake-delivery-closing-release");
}

/** The file that releases the stand-in's `[fake:repair-held]` repair attempt. */
export function repairReleaseFile(): string {
  return join(e2eRoot(), "fake-repair-release");
}

/** The fixture repository the tickets review flows add as their own project: one commit on `main`. */
export function ticketsRepo(): string {
  return join(e2eRoot(), "tickets-repo");
}

/** A fixture repository with no commit: its unborn branch is `main`. */
export function noCommitRepo(): string {
  return join(e2eRoot(), "no-commit-repo");
}

/** The outer repository of the nested pair: one commit on `main`, holding `nestedInnerRepo()`. */
export function nestedOuterRepo(): string {
  return join(e2eRoot(), "nested-outer");
}

/** The inner repository of the nested pair, inside `nestedOuterRepo()`: one commit on `main`. */
export function nestedInnerRepo(): string {
  return join(nestedOuterRepo(), "nested-inner");
}

/**
 * The delivery flows of `completion.spec.ts`; each adds its own project.
 * `pull-request`'s repository has an `origin` on github.com (`GITHUB_ORIGIN_URL`), whose pushes
 * land in `pushTargetRepo()`.
 */
export const DELIVERY_FLOWS = [
  "held",
  "cancel",
  "blocked",
  "unmerged",
  "pull-request",
  "closing",
] as const;
export type DeliveryFlow = (typeof DELIVERY_FLOWS)[number];

/** The fixture repository delivery flow `flow` adds as its own project: one commit on `main`. */
export function deliveryRepo(flow: DeliveryFlow): string {
  return join(e2eRoot(), `delivery-${flow}-repo`);
}

/** The github.com repository the `pull-request` flow's project names as its `origin`. */
export const GITHUB_ORIGIN_URL = "https://github.com/acme/numbers.git";

/** The URL the fake gh gives the `number`th pull request it opens on that repository. */
export function pullRequestUrl(number: number): string {
  return `https://github.com/acme/numbers/pull/${String(number)}`;
}

/** The bare repository the `pull-request` flow's pushes to `origin` land in, as GitHub would take them. */
export function pushTargetRepo(): string {
  return join(e2eRoot(), "github-origin.git");
}

/** The folder holding the fake `gh`, first on the worker server's `PATH`. */
export function ghBinDir(): string {
  return join(e2eRoot(), "gh-bin");
}

/** The fake gh's state: its calls, and the state it reports for each pull request. */
export function ghStateDir(): string {
  return join(e2eRoot(), "gh-state");
}

/** Makes the fake gh report pull request `number` merged on GitHub. */
export function reportPullRequestMerged(number: number): void {
  writeFileSync(join(ghStateDir(), `pr-${String(number)}`), "MERGED");
}

/**
 * A stand-in for the GitHub CLI, kept in `ghBinDir()`: every call appends its arguments as
 * one line to `<state>/calls`. `gh auth status` succeeds; `gh pr create` numbers the pull request
 * from 1 and prints its URL on its `--repo`; `gh pr view <url> --json state` prints the state in
 * `<state>/pr-<number>`, `OPEN` when there is none. Any other call exits 2.
 */
export function fakeGhScript(state: string): string {
  return [
    "#!/bin/sh",
    `state='${state}'`,
    'printf \'%s\\n\' "$*" >> "$state/calls"',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    '  echo "github.com: Logged in to github.com account acme"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
    '  repo=""',
    '  prev=""',
    '  for arg in "$@"; do',
    '    if [ "$prev" = "--repo" ]; then repo="$arg"; fi',
    '    prev="$arg"',
    "  done",
    '  echo "$repo" >> "$state/opened"',
    "  number=$(wc -l < \"$state/opened\" | tr -d ' ')",
    '  echo "https://github.com/$repo/pull/$number"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  number="${3##*/}"',
    '  if [ -e "$state/pr-$number" ]; then pr=$(cat "$state/pr-$number"); else pr=OPEN; fi',
    '  printf \'{"state":"%s"}\\n\' "$pr"',
    "  exit 0",
    "fi",
    'echo "fake gh: unexpected call: $*" >&2',
    "exit 2",
    "",
  ].join("\n");
}

/** The file that releases the stand-in's `[fake:release-held]` wait release run. */
export function releaseRunReleaseFile(): string {
  return join(e2eRoot(), "fake-release-run-release");
}

/** The revision flows of `revisions.spec.ts`; each adds its own project. */
export const REVISION_FLOWS = [
  "revise",
  "departure",
  "departure-no-reason",
  "wait",
  "release-stopped",
] as const;
export type RevisionFlow = (typeof REVISION_FLOWS)[number];

/** The fixture repository revision flow `flow` adds as its own project: one commit on `main`. */
export function revisionRepo(flow: RevisionFlow): string {
  return join(e2eRoot(), `revision-${flow}-repo`);
}
