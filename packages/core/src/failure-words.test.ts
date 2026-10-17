import { PlanningRunFailureCode, PlanningRunPurpose } from "@zenorm/contracts";
import { describe, expect, test } from "vitest";

import { deliveryFailureWords, stoppedRunWords } from "./failure-words.ts";

describe("stoppedRunWords (UX audit P1-1)", () => {
  const purposes = PlanningRunPurpose.options.filter((purpose) => purpose !== "hatch");

  test("every code on every purpose is a sentence that does not carry the code", () => {
    for (const code of PlanningRunFailureCode.options) {
      for (const purpose of purposes) {
        const words = stoppedRunWords(code, purpose);
        expect(words).toMatch(/\.$/);
        expect(words).not.toContain(code);
      }
    }
  });

  test("an invalid reply names the purpose's output, so two purposes read differently", () => {
    expect(stoppedRunWords("agent_output_invalid", "spec_review")).not.toBe(
      stoppedRunWords("agent_output_invalid", "to_tickets"),
    );
  });

  test("a hatch run has no output to name: its failure shows on its message", () => {
    expect(() => stoppedRunWords("agent_output_invalid", "hatch")).toThrow();
  });
});

describe("deliveryFailureWords", () => {
  test("keeps the first line of the stored message and drops the stderr tail", () => {
    expect(
      deliveryFailureWords(
        "The delivery orchestrator did not finish within 60 seconds and was stopped.\nstderr (last 400 chars):\nboom",
      ),
    ).toBe("The delivery orchestrator did not finish within 60 seconds and was stopped.");
  });

  test("an empty message is a programmer error", () => {
    expect(() => deliveryFailureWords("")).toThrow();
  });
});
