import type { MapRound } from "@zenorm/contracts";
import { expect } from "vitest";

import { DESTINATION_ANSWERS_RULE } from "./prompt-parts.ts";

/** A map's destination rounds for the prompt tests (DR-14): round 1, submitted. */
export const MAP_ROUNDS: MapRound[] = [
  {
    questions: [
      {
        topic: "Units",
        text: "Which units should the export cover?",
        options: [
          { label: "Every record", detail: "All of it, as the idea says." },
          { label: "Active records only", detail: "Smaller; archived ones wait." },
        ],
      },
    ],
    answers: [{ optionIndex: 1, note: "Include archived ones too.", accepted: false }],
    final: false,
  },
];

/**
 * Asserts `prompt` renders the destination's rounds right after its destination block (DR-16):
 * `DESTINATION_ANSWERS_RULE` once, then the `MAP-ROUND-1-QUESTION-1` block.
 */
export function expectRoundsAfterDestination(prompt: string): void {
  const rule = DESTINATION_ANSWERS_RULE.join("\n");
  const destination = /\nDESTINATION \S+>>>\n/.exec(prompt);
  if (destination === null) throw new Error("The prompt has no destination block");
  const ruleAt = prompt.indexOf(rule);
  expect(prompt.split(rule)).toHaveLength(2);
  // Only blank lines between the destination block and the rule.
  expect(prompt.slice(destination.index + destination[0].length, ruleAt).trim()).toBe("");
  expect(prompt.indexOf("<<<MAP-ROUND-1-QUESTION-1 ")).toBeGreaterThan(ruleAt);
}
