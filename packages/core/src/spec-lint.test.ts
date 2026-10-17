import type { SpecRevisionContent } from "@zenorm/contracts";
import { describe, expect, test } from "vitest";

import { revisionProblem } from "./spec-runs.ts";

/** A revision of one clause, its text `clauseText`, its criteria `criteria` (id, text). */
function revision(
  clauseText: string,
  criteria: readonly (readonly [string, string])[],
): SpecRevisionContent {
  return {
    title: "Export",
    problem: "Maps cannot be exported.",
    solution: "Export a map as CSV.",
    clauses: [
      {
        id: "C1",
        title: "Export",
        text: clauseText,
        criteria: criteria.map(([id, text]) => ({ id, text })),
        sources: [{ kind: "destination" }],
        reliesOn: [],
        adds: ["new behaviour"],
      },
    ],
    outOfScope: [],
  };
}

function problemOf(content: SpecRevisionContent): ReturnType<typeof revisionProblem> {
  return revisionProblem(content, new Set(), [], false);
}

const refused = { code: "spec_content_invalid" };

describe("the spec lint (harness review change 2)", () => {
  test("criterion ids ascend within a clause; gaps are retired ids and pass", () => {
    expect(
      problemOf(
        revision("A map exports as CSV.", [
          ["1.3", "One."],
          ["1.4", "Two."],
          ["1.2", "Three."],
        ]),
      ),
    ).toMatchObject(refused);
    expect(
      problemOf(
        revision("A map exports as CSV.", [
          ["1.1", "One."],
          ["1.3", "Two."],
          ["1.5", "Three."],
        ]),
      ),
    ).toBeNull();
  });

  test("conditional or two-design phrasing in a clause or criterion is refused", () => {
    for (const text of [
      "Applies only if Codex cannot load rules from a folder ZeNorm owns.",
      "Startup rejects Codex with a coded error until a follow-up closes the gap.",
      "Whether tickets run side by side is settled once by the live test.",
      "The live test runs Codex once; either outcome is accepted and selects the matching behaviour.",
      "Whichever result the spike reports selects the behaviour.",
    ]) {
      expect(problemOf(revision(text, [["1.1", "Exports one file."]]))).toMatchObject(refused);
      expect(problemOf(revision("A map exports as CSV.", [["1.1", text]]))).toMatchObject(refused);
    }
  });

  test("either … or is refused in a criterion, not in a clause", () => {
    const text = "The export runs either in the browser or on the server.";
    expect(problemOf(revision("A map exports as CSV.", [["1.1", text]]))).toMatchObject(refused);
    expect(problemOf(revision(text, [["1.1", "Exports one file."]]))).toBeNull();
    // An either and an or in different sentences are not a two-design criterion.
    expect(
      problemOf(
        revision("A map exports as CSV.", [
          ["1.1", "Either session may be on Codex. The file is CSV or TSV by config."],
        ]),
      ),
    ).toBeNull();
  });

  test("stated defaults and fallbacks pass: whether a project allows them is its own rule", () => {
    for (const text of [
      "The export folder defaults to the project root.",
      "A missing path falls back to the project root.",
      "The project root is the fallback folder.",
      "The project root is used when omitted.",
      "`natural_list` takes a keyword-only `conjunction` that defaults to `and`.",
    ]) {
      expect(problemOf(revision(text, [["1.1", text]]))).toBeNull();
    }
  });

  test("negated defaults and plain conditions pass", () => {
    for (const text of [
      "A config missing the folder fails with `config_invalid`; there is no fallback.",
      "Nothing falls back to Claude Code.",
      "The folder never defaults to the project root.",
      "There is no run-time check or fallback.",
      "The map is absent from the project's map list after archiving.",
      "An archived map is refused only if its delivery is active.",
      "If the folder is missing, startup fails with the coded config error `config_invalid`.",
      "When the run has a rules file it is passed; otherwise the instructions are the only guard.",
      "Codex accepts the schema; if not, the run fails with `codex_output_invalid`.",
    ]) {
      expect(problemOf(revision(text, [["1.1", text]]))).toBeNull();
    }
  });

  test("nested backticks are refused; separate code spans pass", () => {
    for (const text of [
      "Run `pnpm `check` now`.",
      "Run ``pnpm check`` now.",
      "Run `pnpm check now.",
    ]) {
      expect(problemOf(revision(text, [["1.1", "Exports one file."]]))).toMatchObject(refused);
      expect(problemOf(revision("A map exports as CSV.", [["1.1", text]]))).toMatchObject(refused);
    }
    expect(
      problemOf(revision("Set `delivery.agent` to `codex` or `claudeCode`.", [["1.1", "One."]])),
    ).toBeNull();
  });

  test("a coded error, error code or config key without a backticked name in its sentence is refused", () => {
    for (const text of [
      "Archiving a finished map is refused with a coded error.",
      "A missing binary fails startup with the coded missing-CLI error.",
      "Archiving is refused with a stable error code.",
      "Archiving an active map returns a new error code.",
      "The export folder is a new config key in the delivery section.",
      // A name in another sentence of the same text does not name this one.
      "The folder is `delivery.exportDir`. A missing folder fails with a coded error.",
    ]) {
      expect(problemOf(revision(text, [["1.1", "Exports one file."]]))).toMatchObject(refused);
      expect(problemOf(revision("A map exports as CSV.", [["1.1", text]]))).toMatchObject(refused);
    }
  });

  test("a named code or key, plural error codes and negations pass", () => {
    for (const text of [
      "Archiving a finished map is refused with the coded error `map_finished`.",
      "A missing `delivery.exportDir` config key fails startup with a coded error.",
      "The web tests assert error codes, not message text.",
      "An unreadable stream shows a notice and raises no coded error.",
      "No config key allows full access.",
      "The folder is `delivery.exportDir`, e.g. `out/maps`. A missing one fails with `config_invalid`.",
    ]) {
      expect(problemOf(revision(text, [["1.1", text]]))).toBeNull();
    }
  });
});
