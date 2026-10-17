import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Waits are released by construction: starting a run can supersede a stopped spec-scoped run and so
 * end a hold, so every write calls `planAndRelease`, which releases what the hold's end frees. Only
 * `planAndRelease` itself (in `spec-holds.ts`) may call `planNext`; tests are exempt.
 */
describe("planNext callers", () => {
  test("only planAndRelease calls planNext outside the tests", () => {
    const dir = import.meta.dirname;
    const callers = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) =>
        readFileSync(join(dir, name), "utf8")
          .split("\n")
          .some((line) => /\bplanNext\(/.test(line) && !/^\s*(\*|\/\/)/.test(line)),
      );
    // planning-runs.ts declares it (`function planNext(`); spec-holds.ts is planAndRelease.
    expect(callers.sort()).toEqual(["planning-runs.ts", "spec-holds.ts"]);
    const declaring = readFileSync(join(dir, "planning-runs.ts"), "utf8")
      .split("\n")
      .filter((line) => /\bplanNext\(/.test(line) && !/^\s*(\*|\/\/)/.test(line));
    expect(declaring).toEqual([
      "export function planNext(actor: Actor, tx: Tx, mapId: string): void {",
    ]);
  });
});
