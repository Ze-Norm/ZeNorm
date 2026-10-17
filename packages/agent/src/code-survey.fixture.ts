import type { CodeSurvey } from "@zenorm/contracts";

/** A map's code survey for the prompt tests: one touched and one untouched area. */
export const SURVEY: CodeSurvey = {
  entries: [
    {
      area: "packages/db",
      role: "The database schema and migrations.",
      touched: true,
      why: "The destination adds a column to maps.",
      surfaceFiles: ["packages/db/src/schema.ts"],
      facts: [
        { claim: "Maps have no archived column.", path: "packages/db/src/schema.ts", line: 137 },
      ],
    },
    {
      area: "packages/web",
      role: "The browser app.",
      touched: false,
      why: "No screen changes.",
      surfaceFiles: [],
      facts: [],
    },
  ],
  identifiers: [
    {
      name: "map_not_found",
      meaning: "The coded error for an unknown map.",
      path: "packages/contracts/src/errors.ts",
      line: 9,
    },
  ],
  unverifiable: ["Whether archived maps are ever restored."],
  lifecycles: [
    {
      record: "planning run",
      states: ["running", "failed", "cancelled"],
      transitions: [
        {
          from: "running",
          to: "failed",
          by: "failRun records the error",
          path: "packages/core/src/planning-runs.ts",
          line: 40,
        },
      ],
      terminal: [
        {
          state: "cancelled",
          exits: "nothing: tryAgain refuses it",
          path: "packages/core/src/planning-runs.ts",
          line: 90,
        },
      ],
    },
  ],
};

/** The FACTS block's lines `SURVEY` renders, without the nonce lines. */
export const SURVEY_FACTS = [
  "packages/db: touched. The destination adds a column to maps.",
  "  Surface: packages/db/src/schema.ts",
  "  - packages/db/src/schema.ts:137 — Maps have no archived column.",
  "packages/web: not touched. No screen changes.",
  "Identifiers:",
  "- map_not_found (packages/contracts/src/errors.ts:9): The coded error for an unknown map.",
  "Lifecycles:",
  "- planning run: running, failed, cancelled",
  "  - running -> failed (packages/core/src/planning-runs.ts:40): failRun records the error",
  "  - cancelled ends (packages/core/src/planning-runs.ts:90): nothing: tryAgain refuses it",
  "Unverifiable:",
  "U1. Whether archived maps are ever restored.",
].join("\n");
