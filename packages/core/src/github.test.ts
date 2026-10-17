import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { githubOrigin, githubRepositoryOf } from "./github.ts";

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
