import { describe, expect, test } from "vitest";

import { SURVEY, SURVEY_FACTS } from "./code-survey.fixture.ts";
import {
  BUSY_READER_RULE,
  DESTINATION_ANSWERS_RULE,
  FACTS_RULE,
  lengthWords,
  mapRoundLines,
  NO_SURVEY_LINES,
  READER_ADDRESS_RULE,
  renderCodeSurvey,
} from "./prompt-parts.ts";
import { MAP_ROUNDS } from "./map-rounds.fixture.ts";

describe("BUSY_READER_RULE", () => {
  test('ends with the reader rule, so every run that writes for the person says "you"', () => {
    expect(BUSY_READER_RULE.slice(-READER_ADDRESS_RULE.length)).toEqual(READER_ADDRESS_RULE);
  });
});

describe("lengthWords (agent.models)", () => {
  test("states at most the max when the aim is the max", () => {
    expect(lengthWords({ aim: 800, max: 800 })).toBe("at most 800 characters");
  });

  test("states about the aim, at most the max, when the aim is below it", () => {
    expect(lengthWords({ aim: 700, max: 1000 })).toBe("about 700 characters (at most 1000)");
  });
});

describe("renderCodeSurvey", () => {
  test("renders the survey as a FACTS block under the nonce, followed by the FACTS rule", () => {
    const text = renderCodeSurvey(SURVEY, "n1").join("\n");
    expect(text).toContain(`<<<FACTS n1\n${SURVEY_FACTS}\nFACTS n1>>>`);
    expect(text).toContain(FACTS_RULE.join("\n"));
    expect(text).not.toContain(NO_SURVEY_LINES.join("\n"));
  });

  test("leaves out the identifiers, lifecycles and unverifiable sections when they are empty", () => {
    const text = renderCodeSurvey(
      { ...SURVEY, identifiers: [], unverifiable: [], lifecycles: [] },
      "n1",
    ).join("\n");
    expect(text).not.toContain("Identifiers:");
    expect(text).not.toContain("Lifecycles:");
    expect(text).not.toContain("Unverifiable:");
    const beforeLifecycles = {
      entries: SURVEY.entries,
      identifiers: SURVEY.identifiers,
      unverifiable: SURVEY.unverifiable,
    };
    expect(renderCodeSurvey(beforeLifecycles, "n1").join("\n")).not.toContain("Lifecycles:");
  });

  test("a map without a survey says so, with no FACTS block and no FACTS rule", () => {
    const text = renderCodeSurvey(null, "n1").join("\n");
    expect(text).toContain(NO_SURVEY_LINES.join("\n"));
    expect(text).not.toContain("<<<FACTS");
    expect(text).not.toContain(FACTS_RULE.join("\n"));
  });
});

describe("mapRoundLines", () => {
  const NONCE = "nonce";

  test("heads the rounds once with DESTINATION_ANSWERS_RULE, each question in its MAP-ROUND block", () => {
    const lines = mapRoundLines(MAP_ROUNDS, NONCE);
    expect(lines.slice(0, DESTINATION_ANSWERS_RULE.length)).toEqual(DESTINATION_ANSWERS_RULE);
    expect(lines).toContain(`<<<MAP-ROUND-1-QUESTION-1 ${NONCE}`);
    expect(lines).toContain(`<<<MAP-ROUND-1-ANSWER-1 ${NONCE}`);
  });

  test("renders a pending round's questions without answers", () => {
    const pending = MAP_ROUNDS.map((round) => ({ ...round, answers: null }));
    const lines = mapRoundLines(pending, NONCE);
    expect(lines).toContain(`<<<MAP-ROUND-1-QUESTION-1 ${NONCE}`);
    expect(lines.some((line) => line.startsWith("<<<MAP-ROUND-1-ANSWER-"))).toBe(false);
  });

  test("writes nothing with no round", () => {
    expect(mapRoundLines([], NONCE)).toEqual([]);
  });
});
