/**
 * Shared setup for the tests of a run on a GitHub project (`app-github-*.test.ts`): a fake gh
 * whose calls and pull request states live in a folder, and a bare repository origin's pushes land
 * in. A test file calls `setUpGitHubTests()` once, at its top, in place of `setUpAppTests()`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { DeliveryExecutor, WritePullRequest } from "@zenorm/contracts";
import { afterEach, beforeEach } from "vitest";

import { root, gitIn, standInExecutor, fakeGhScript, setUpAppTests } from "./app-test-support.ts";

/** The test process's own `PATH`, restored after each case. */
export let originalPath: string;
/** The fake gh's state folder. */
export let ghState: string;
/** The bare repository origin's pushes land in. */
export let pushTarget: string;

/**
 * Registers the app's setup, then each case's fake gh first on `PATH` and its bare push target,
 * and `PATH`'s restoring after it, in the calling test file.
 */
export function setUpGitHubTests(): void {
  setUpAppTests();

  beforeEach(async () => {
    const path = process.env.PATH;
    if (path === undefined) throw new Error("The test process has no PATH");
    originalPath = path;
    const bin = join(root, "gh-bin");
    ghState = join(root, "gh-state");
    await mkdir(bin);
    await mkdir(ghState);
    await writeFile(join(bin, "gh"), fakeGhScript(ghState), { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
    pushTarget = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", pushTarget]);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });
}

/** The fake gh's calls, one line of arguments each, in order. */
export function ghCalls(): string[] {
  const file = join(ghState, "calls");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** Names `url` as `remote` of `folder`, its pushes redirected to `target` as GitHub would take them. */
export function addRemote(folder: string, remote: string, url: string, target: string): void {
  gitIn(folder, ["remote", "add", remote, url]);
  gitIn(folder, ["config", `url.${target}.insteadOf`, url]);
}

/** The branches the push target holds. */
export function pushedBranches(): string[] {
  return gitIn(pushTarget, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * A `PATH` that finds git but no gh: one folder holding only a link to the git first on the
 * test's original `PATH`.
 */
export async function pathWithoutGh(): Promise<string> {
  const git = originalPath
    .split(delimiter)
    .map((folder) => join(folder, "git"))
    .find((candidate) => existsSync(candidate));
  if (git === undefined) throw new Error("No git on the test process's PATH");
  const folder = join(root, "no-gh");
  await mkdir(folder);
  await symlink(git, join(folder, "git"));
  return folder;
}

/** The stand-in executor with its pull request writer replaced by `write`. */
export function writingWith(write: WritePullRequest): DeliveryExecutor {
  return { ...standInExecutor([]), name: "writes-pull-request", writePullRequest: write };
}
