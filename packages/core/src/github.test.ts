import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  githubOrigin,
  githubRepositoryOf,
  prAssetsBranchName,
  prAssetSource,
  pushScreenshots,
} from "./github.ts";

describe("githubRepositoryOf", () => {
  test.each([
    "https://github.com/acme/numbers.git",
    "https://github.com/acme/numbers",
    "https://github.com/acme/numbers/",
    "https://token@github.com/acme/numbers.git",
    "http://GitHub.com/acme/numbers.git",
    "ssh://git@github.com/acme/numbers.git",
    "ssh://git@github.com:22/acme/numbers.git",
    "git@github.com:acme/numbers.git",
    "git@github.com:acme/numbers",
    "github.com:acme/numbers.git",
  ])("%s is acme/numbers on github.com", (url) => {
    expect(githubRepositoryOf(url)).toEqual({ owner: "acme", name: "numbers" });
  });

  test.each([
    "https://github.example.com/acme/numbers.git",
    "git@github.example.com:acme/numbers.git",
    "https://gitlab.com/acme/numbers.git",
    "https://github.com.evil.example/acme/numbers.git",
    "https://github.com/acme",
    "https://github.com/acme/numbers/tree/main",
    "/srv/git/numbers.git",
    "../numbers.git",
    "file:///srv/git/numbers.git",
  ])("%s names no repository on github.com", (url) => {
    expect(githubRepositoryOf(url)).toBeNull();
  });
});

describe("githubOrigin", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "zenorm-github-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function git(args: readonly string[]): void {
    execFileSync("git", ["-C", repo, ...args]);
  }

  test("a project with no origin has none", async () => {
    expect(await githubOrigin(repo)).toBeNull();
  });

  test("a github.com remote under another name is not read", async () => {
    git(["remote", "add", "upstream", "https://github.com/acme/numbers.git"]);
    expect(await githubOrigin(repo)).toBeNull();
  });

  test("an origin on an Enterprise host is none", async () => {
    git(["remote", "add", "origin", "https://github.acme.example/acme/numbers.git"]);
    expect(await githubOrigin(repo)).toBeNull();
  });

  test("a fork's origin is the fork, whatever upstream says", async () => {
    git(["remote", "add", "origin", "git@github.com:me/numbers.git"]);
    git(["remote", "add", "upstream", "https://github.com/acme/numbers.git"]);
    expect(await githubOrigin(repo)).toEqual({ owner: "me", name: "numbers" });
  });

  test("origin is read as configured, before insteadOf rewrites it", async () => {
    git(["remote", "add", "origin", "https://github.com/acme/numbers.git"]);
    git(["config", "url./srv/git/numbers.git.insteadOf", "https://github.com/acme/numbers.git"]);
    expect(await githubOrigin(repo)).toEqual({ owner: "acme", name: "numbers" });
  });
});

describe("prAssetsBranchName", () => {
  test("is pr-assets- and the run branch's last segment, with no slash", () => {
    expect(prAssetsBranchName("zenorm/dark-mode-2e3f4a5b-run-1")).toBe(
      "pr-assets-dark-mode-2e3f4a5b-run-1",
    );
    expect(prAssetsBranchName("zenorm/spec-2e3f4a5b-run-12")).toBe(
      "pr-assets-spec-2e3f4a5b-run-12",
    );
  });

  test("a screenshot embeds as a raw blob image relative to the pull request's page", () => {
    expect(prAssetSource("pr-assets-dark-mode-2e3f4a5b-run-1", "screen-1.png")).toBe(
      "../blob/pr-assets-dark-mode-2e3f4a5b-run-1/screen-1.png?raw=true",
    );
  });
});

describe("pushScreenshots", () => {
  const RUN_BRANCH = "zenorm/dark-mode-2e3f4a5b-run-1";
  const IDENTITY = {
    GIT_AUTHOR_NAME: "ZeNorm delivery",
    GIT_AUTHOR_EMAIL: "run@zenorm.invalid",
    GIT_COMMITTER_NAME: "ZeNorm delivery",
    GIT_COMMITTER_EMAIL: "run@zenorm.invalid",
  };
  let root: string;
  let repo: string;
  let target: string;
  let shots: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zenorm-pr-assets-"));
    repo = join(root, "repo");
    target = join(root, "origin.git");
    shots = join(root, "screenshots");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["init", "-q", "--bare", target]);
    const env = { ...process.env, ...IDENTITY };
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], { env });
    execFileSync("git", ["-C", repo, "branch", RUN_BRANCH]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", target]);
    await mkdir(shots);
    await writeFile(join(shots, "screen-1.png"), "first");
    await writeFile(join(shots, "screen-2.png"), "second");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function gitOut(cwd: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  async function push(): ReturnType<typeof pushScreenshots> {
    return await pushScreenshots({
      folder: repo,
      runBranch: RUN_BRANCH,
      files: [
        { path: join(shots, "screen-1.png"), name: "screen-1.png" },
        { path: join(shots, "screen-2.png"), name: "screen-2.png" },
      ],
      env: IDENTITY,
      indexFile: join(root, "pr-assets.index"),
      signal: new AbortController().signal,
    });
  }

  test("pushes only the images to the pr-assets branch, leaving the run branch and the folder as they were", async () => {
    const runHead = gitOut(repo, ["rev-parse", RUN_BRANCH]);
    const status = gitOut(repo, ["status", "--porcelain"]);

    const pushed = await push();

    if (!pushed.ok) throw new Error(pushed.error.message);
    const { commit } = pushed.value;
    expect(commit).toEqual(expect.any(String));
    expect(pushed).toEqual({
      ok: true,
      value: { branch: "pr-assets-dark-mode-2e3f4a5b-run-1", commit },
    });
    expect(gitOut(target, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).toBe(
      "pr-assets-dark-mode-2e3f4a5b-run-1",
    );
    expect(
      gitOut(target, ["ls-tree", "--name-only", "pr-assets-dark-mode-2e3f4a5b-run-1"]).split("\n"),
    ).toEqual(["screen-1.png", "screen-2.png"]);
    expect(gitOut(target, ["show", "pr-assets-dark-mode-2e3f4a5b-run-1:screen-2.png"])).toBe(
      "second",
    );
    // No local branch was made, the run branch did not move and the folder's index is untouched.
    expect(gitOut(repo, ["rev-parse", RUN_BRANCH])).toBe(runHead);
    expect(gitOut(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).not.toContain(
      "pr-assets",
    );
    expect(gitOut(repo, ["status", "--porcelain"])).toBe(status);
  });

  test("a push origin refuses is capture_push_failed, and nothing is forced over the branch", async () => {
    expect((await push()).ok).toBe(true);
    await writeFile(join(shots, "screen-1.png"), "changed");

    const again = await push();

    expect(again).toMatchObject({ ok: false, error: { code: "capture_push_failed" } });
    expect(gitOut(target, ["show", "pr-assets-dark-mode-2e3f4a5b-run-1:screen-1.png"])).toBe(
      "first",
    );
  });

  test("an unreachable origin is capture_push_failed", async () => {
    execFileSync("git", ["-C", repo, "remote", "set-url", "origin", join(root, "absent.git")]);

    expect(await push()).toMatchObject({ ok: false, error: { code: "capture_push_failed" } });
  });
});
