import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { readAuthStatus } from "./claude.ts";

let dir: string;

/** A `claude` stand-in that prints `stdout` and exits with `exitCode`. */
async function standIn(stdout: string, exitCode: number): Promise<string> {
  const path = join(dir, "claude");
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${String(exitCode)}\n`);
  await chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zenorm-auth-status-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a signed-in CLI reads with its method", async () => {
  const claude = await standIn(JSON.stringify({ loggedIn: true, authMethod: "third_party" }), 0);
  expect(await readAuthStatus(claude, {}, 10_000)).toEqual({
    ok: true,
    value: { loggedIn: true, authMethod: "third_party" },
  });
});

test("loggedIn false, or a non-zero exit, reads as signed out", async () => {
  const signedOut = await standIn(JSON.stringify({ loggedIn: false, authMethod: "none" }), 1);
  expect(await readAuthStatus(signedOut, {}, 10_000)).toEqual({
    ok: true,
    value: { loggedIn: false },
  });
  const failed = await standIn(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), 1);
  expect(await readAuthStatus(failed, {}, 10_000)).toEqual({
    ok: true,
    value: { loggedIn: false },
  });
});

test("signed in without a method, or no JSON, is agent_output_invalid", async () => {
  for (const stdout of [JSON.stringify({ loggedIn: true }), "not json"]) {
    const result = await readAuthStatus(await standIn(stdout, 0), {}, 10_000);
    expect(result.ok ? null : result.error.code).toBe("agent_output_invalid");
  }
});

test("a missing binary is agent_cli_missing", async () => {
  const result = await readAuthStatus(join(dir, "missing"), {}, 10_000);
  expect(result.ok ? null : result.error.code).toBe("agent_cli_missing");
});
