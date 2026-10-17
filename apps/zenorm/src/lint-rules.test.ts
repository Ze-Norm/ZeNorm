import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

/** The repository root, where `eslint.config.js` is. */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// `ignore: false` is `eslint --no-ignore`: the fixtures are in the config's global ignores.
const eslint = new ESLint({ cwd: repoRoot, ignore: false });

/** The rule id of every message linting the fixture reports. */
async function ruleIds(fixture: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintFiles([`apps/zenorm/eslint-fixtures/${fixture}`]);
  if (result === undefined) throw new Error(`ESLint returned no result for ${fixture}`);
  return result.messages.map((message) => message.ruleId);
}

describe("the guardrail lint", () => {
  test.each([
    { fixture: "nullish-literal.ts", rule: "no-restricted-syntax", count: 7 },
    { fixture: "or-literal.ts", rule: "no-restricted-syntax", count: 1 },
    { fixture: "assign-literal.ts", rule: "no-restricted-syntax", count: 4 },
    { fixture: "default-call.ts", rule: "no-restricted-syntax", count: 1 },
    // The change feed is imported only by packages/db, core's writes.ts and events.ts.
    { fixture: "change-feed-import.ts", rule: "no-restricted-imports", count: 1 },
    // The fixture's Promise `.catch` is not reported.
    { fixture: "zod-catch.ts", rule: "zenorm/no-zod-catch", count: 1 },
    {
      fixture: "disable-without-reason.ts",
      rule: "@eslint-community/eslint-comments/require-description",
      count: 1,
    },
    {
      fixture: "unlimited-disable.ts",
      rule: "@eslint-community/eslint-comments/no-unlimited-disable",
      count: 1,
    },
  ])("$fixture fails with $rule only", { timeout: 60_000 }, async ({ fixture, rule, count }) => {
    expect(await ruleIds(fixture)).toEqual(Array.from({ length: count }, () => rule));
  });
});
