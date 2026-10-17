import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClauseReliance, CodeSurvey, SpecRevisionContent } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  REFERENCE_EXCERPT_RADIUS,
  clauseReferences,
  referencesProblem,
} from "./spec-references.ts";
import { SPEC } from "./test-support.ts";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "zenorm-spec-references-"));
  mkdirSync(join(folder, "src"));
  writeFileSync(
    join(folder, "src", "runs.ts"),
    Array.from({ length: 30 }, (_, index) =>
      index === 19 ? "export function tryAgain() {}" : `// line ${String(index + 1)}`,
    ).join("\n"),
  );
  writeFileSync(join(folder, "README.md"), "# tryAgain\n");
  mkdirSync(join(folder, "e2e"));
  writeFileSync(join(folder, "e2e", "runs.spec.ts"), "const restartRun = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: folder });
  execFileSync("git", ["add", "."], { cwd: folder });
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const SURVEY: CodeSurvey = {
  entries: [
    { area: "src", role: "Runs.", touched: true, why: "Runs.", surfaceFiles: [], facts: [] },
  ],
  identifiers: [
    { name: "planning_run_not_stopped", meaning: "A refusal.", path: "src/runs.ts", line: 3 },
  ],
  unverifiable: [],
  lifecycles: [
    {
      record: "planning run",
      states: ["running", "failed", "cancelled"],
      transitions: [{ from: "running", to: "failed", by: "failRun", path: "src/runs.ts", line: 5 }],
      terminal: [
        {
          state: "cancelled",
          exits: "nothing: tryAgain refuses it",
          path: "src/runs.ts",
          line: 20,
        },
      ],
    },
  ],
};

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("No item");
  return item;
}

const CLAUSE = first(SPEC.clauses);

function withClause(fields: {
  text?: string;
  reliesOn?: ClauseReliance[];
  adds?: string[];
}): SpecRevisionContent {
  return {
    ...SPEC,
    clauses: [
      {
        ...CLAUSE,
        text: fields.text ?? CLAUSE.text,
        reliesOn: fields.reliesOn ?? CLAUSE.reliesOn,
        adds: fields.adds ?? CLAUSE.adds,
      },
    ],
  };
}

describe("referencesProblem (RC1)", () => {
  test("FACTS identifiers, lifecycle states and names found in a source file resolve", () => {
    const content = withClause({
      text: "Try again refuses `planning_run_not_stopped` on a `cancelled` run.",
      reliesOn: [
        { name: "planning_run_not_stopped", path: null },
        { name: "cancelled", path: null },
        { name: "planning run", path: null },
        { name: "tryAgain", path: "src/runs.ts" },
      ],
      adds: [],
    });
    expect(referencesProblem(content, SURVEY, folder)).toBeNull();
  });

  test("every problem is named in one message", () => {
    const content = withClause({
      text: "Restore re-checks the map with `recheck` and `restore_refused`.",
      reliesOn: [
        { name: "recheck", path: null },
        { name: "restartRun", path: "README.md" },
        { name: "restartRun", path: "src/runs.ts" },
        { name: "anything", path: "src/missing.ts" },
      ],
      adds: ["cancelled"],
    });
    const problem = referencesProblem(content, SURVEY, folder);
    expect(problem?.split(". ")).toHaveLength(5);
  });

  test("a clause needs a reliance or an addition; a missing list is refused", () => {
    expect(
      referencesProblem(withClause({ reliesOn: [], adds: [] }), SURVEY, folder),
    ).not.toBeNull();
    const stored = {
      id: CLAUSE.id,
      title: CLAUSE.title,
      text: CLAUSE.text,
      criteria: CLAUSE.criteria,
      sources: CLAUSE.sources,
    };
    expect(referencesProblem({ ...SPEC, clauses: [stored] }, SURVEY, folder)).not.toBeNull();
  });

  test("a name FACTS does not list resolves where the source defines it, never in documentation", () => {
    const references = clauseReferences(
      withClause({
        reliesOn: [
          { name: "tryAgain", path: null },
          { name: "restartRun", path: null },
        ],
      }),
      null,
      folder,
    );
    // Product source first; a test file only when nothing else has it; the readme never.
    expect(references.map(({ path, line }) => [path, line])).toEqual([
      ["src/runs.ts", 20],
      ["e2e/runs.spec.ts", 1],
    ]);
    const invented = withClause({ reliesOn: [{ name: "recheckMap", path: null }] });
    expect(referencesProblem(invented, null, folder)).not.toBeNull();
  });

  test("with no survey, a bare name is found in the source and a path still resolves", () => {
    const bare = withClause({ reliesOn: [{ name: "tryAgain", path: null }] });
    expect(referencesProblem(bare, null, folder)).toBeNull();
    const pathed = withClause({ reliesOn: [{ name: "tryAgain", path: "src/runs.ts" }] });
    expect(referencesProblem(pathed, null, folder)).toBeNull();
  });

  test("a tracked file resolves by its path at its first line, Markdown included; a missing file does not", () => {
    const file = withClause({ reliesOn: [{ name: "src/runs.ts", path: null }] });
    expect(referencesProblem(file, SURVEY, folder)).toBeNull();
    const [reference] = clauseReferences(file, SURVEY, folder);
    expect([reference?.path, reference?.line, reference?.meaning]).toEqual([
      "src/runs.ts",
      1,
      null,
    ]);
    expect(reference?.excerpt).toContain("1: // line 1");
    // A Markdown file can be what the product reads, like an agent's skill.
    const skill = withClause({ reliesOn: [{ name: "README.md", path: null }] });
    expect(referencesProblem(skill, SURVEY, folder)).toBeNull();
    expect(clauseReferences(skill, SURVEY, folder)[0]?.excerpt).toContain("1: # tryAgain");
    const pathed = withClause({ reliesOn: [{ name: "tryAgain", path: "README.md" }] });
    expect(referencesProblem(pathed, SURVEY, folder)).toBeNull();
    const missing = withClause({ reliesOn: [{ name: "src/missing.ts", path: null }] });
    expect(referencesProblem(missing, SURVEY, folder)).not.toBeNull();
  });

  test("an addition FACTS defines is refused; the same name given with its kind is not", () => {
    const bare = withClause({ reliesOn: [], adds: ["planning_run_not_stopped"] });
    expect(referencesProblem(bare, SURVEY, folder)).not.toBeNull();
    const kinded = withClause({ reliesOn: [], adds: ["JSON key planning_run_not_stopped"] });
    expect(referencesProblem(kinded, SURVEY, folder)).toBeNull();
  });

  test("a name the text only mentions in passing needs no declaration", () => {
    const content = withClause({ text: "It is offered beside `hatch.send` and `map.list`." });
    expect(referencesProblem(content, SURVEY, folder)).toBeNull();
  });
});

describe("clauseReferences (RC1)", () => {
  test("each reliance with its line, FACTS meaning and the code around it", () => {
    const references = clauseReferences(
      withClause({
        reliesOn: [
          { name: "tryAgain", path: "src/runs.ts" },
          { name: "cancelled", path: null },
          { name: "gone", path: "src/runs.ts" },
        ],
      }),
      SURVEY,
      folder,
    );
    expect(references.map(({ name, path, line }) => [name, path, line])).toEqual([
      ["tryAgain", "src/runs.ts", 20],
      ["cancelled", "src/runs.ts", 20],
      ["gone", "src/runs.ts", null],
    ]);
    const [tryAgain, cancelled, gone] = references;
    expect(tryAgain?.meaning).toBeNull();
    expect(cancelled?.meaning).toContain("tryAgain refuses it");
    expect(tryAgain?.excerpt?.split("\n")).toHaveLength(2 * REFERENCE_EXCERPT_RADIUS + 1);
    expect(tryAgain?.excerpt).toContain("20: export function tryAgain() {}");
    expect(gone?.excerpt).toBeNull();
  });

  test("a clause written before clauses declared reliances has none", () => {
    const stored = {
      id: CLAUSE.id,
      title: CLAUSE.title,
      text: CLAUSE.text,
      criteria: CLAUSE.criteria,
      sources: CLAUSE.sources,
    };
    expect(clauseReferences({ ...SPEC, clauses: [stored] }, SURVEY, folder)).toEqual([]);
  });
});
