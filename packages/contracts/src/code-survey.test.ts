import { describe, expect, test } from "vitest";

import { CodeSurvey } from "./code-survey.ts";

const FACT = { claim: "Runs are stored per map.", path: "packages/db/src/schema.ts", line: 12 };
const ENTRY = {
  area: "packages/db",
  role: "The database schema and migrations.",
  touched: true,
  why: "The destination adds a table.",
  surfaceFiles: ["packages/db/src/schema.ts"],
  facts: [FACT],
};
const SURVEY = {
  entries: [ENTRY],
  identifiers: [{ name: "planning_runs", meaning: "The runs table.", path: FACT.path, line: 3 }],
  unverifiable: [],
};

describe("CodeSurvey (harness change #1)", () => {
  test("accepts a survey whose facts and identifiers each carry a path and line", () => {
    expect(CodeSurvey.safeParse(SURVEY).success).toBe(true);
    expect(CodeSurvey.safeParse({ ...SURVEY, entries: [{ ...ENTRY, area: "." }] }).success).toBe(
      true,
    );
  });

  test("requires at least one entry", () => {
    expect(CodeSurvey.safeParse({ ...SURVEY, entries: [] }).success).toBe(false);
  });

  test.each([
    ["a fact without its line", { claim: FACT.claim, path: FACT.path }],
    ["a fact without its path", { claim: FACT.claim, line: 1 }],
    ["line 0", { ...FACT, line: 0 }],
    ["an absolute path", { ...FACT, path: "/etc/passwd" }],
    ["a parent segment", { ...FACT, path: "packages/../../secret" }],
    ["a trailing slash", { ...FACT, path: "packages/db/" }],
    ["a path with a space", { ...FACT, path: "packages/a b.ts" }],
  ])("rejects %s", (_rule, fact) => {
    expect(
      CodeSurvey.safeParse({ ...SURVEY, entries: [{ ...ENTRY, facts: [fact] }] }).success,
    ).toBe(false);
  });

  test("rejects a missing field: nothing is defaulted", () => {
    expect(
      CodeSurvey.safeParse({ entries: SURVEY.entries, identifiers: SURVEY.identifiers }).success,
    ).toBe(false);
    const withoutTouched = {
      area: ENTRY.area,
      role: ENTRY.role,
      why: ENTRY.why,
      surfaceFiles: ENTRY.surfaceFiles,
      facts: ENTRY.facts,
    };
    expect(CodeSurvey.safeParse({ ...SURVEY, entries: [withoutTouched] }).success).toBe(false);
    expect(
      CodeSurvey.safeParse({ ...SURVEY, identifiers: [{ name: "x", meaning: "y", path: "a" }] })
        .success,
    ).toBe(false);
  });
});
