import { type ModelLimitField, ModelLimits } from "@zenorm/contracts";

import { lengthWords } from "./prompt-parts.ts";

/** A model's limits for the agent tests: the Sonnet profile, every aim its max but the build's. */
export const LIMITS: ModelLimits = {
  questionText: { aim: 200, max: 200 },
  questionTopic: { aim: 80, max: 80 },
  optionDetail: { aim: 200, max: 200 },
  optionLabel: { aim: 80, max: 80 },
  roundIntro: { aim: 300, max: 300 },
  mapTitle: { aim: 120, max: 120 },
  mapSummary: { aim: 1000, max: 1000 },
  destination: { aim: 1000, max: 1000 },
  waypointTitle: { aim: 120, max: 120 },
  waypointQuestion: { aim: 1000, max: 1000 },
  resolution: { aim: 800, max: 800 },
  gist: { aim: 200, max: 200 },
  agentDecided: { aim: 120, max: 200 },
  mapLine: { aim: 500, max: 500 },
  findingExplanation: { aim: 4000, max: 4000 },
  researchSummary: { aim: 4000, max: 4000 },
  researchFindingTitle: { aim: 120, max: 120 },
  researchFindingDetail: { aim: 2000, max: 2000 },
  researchSourceTitle: { aim: 200, max: 200 },
  researchExcerpt: { aim: 2000, max: 2000 },
  researchNote: { aim: 1000, max: 1000 },
  taskAction: { aim: 1000, max: 1000 },
  taskFacts: { aim: 4000, max: 4000 },
  surveyText: { aim: 400, max: 400 },
  surveyName: { aim: 200, max: 200 },
  hatchReply: { aim: 2000, max: 2000 },
  waitNote: { aim: 4000, max: 4000 },
  specTitle: { aim: 120, max: 120 },
  specProse: { aim: 600, max: 600 },
  clauseTitle: { aim: 120, max: 120 },
  clauseText: { aim: 400, max: 400 },
  criterionText: { aim: 500, max: 500 },
  clauseName: { aim: 200, max: 200 },
  contentLine: { aim: 500, max: 500 },
  removalReason: { aim: 300, max: 300 },
  ticketTitle: { aim: 120, max: 120 },
  ticketBuild: { aim: 1200, max: 2000 },
  dispositionText: { aim: 1000, max: 1000 },
  ticketSetSlicing: { aim: 2000, max: 2000 },
  ticketSetExecution: { aim: 1000, max: 1000 },
  specReviewSummary: { aim: 1000, max: 1000 },
  ticketsReviewSummary: { aim: 1000, max: 1000 },
  ticketsReviewFindingTitle: { aim: 120, max: 120 },
  ticketsReviewFindingExplanation: { aim: 1000, max: 1000 },
  ticketsReviewFindingQuestion: { aim: 500, max: 500 },
};

/** Limits whose aims sit below their maxes, as an Opus profile has. */
export const AIMED_LIMITS: ModelLimits = {
  questionText: { aim: 200, max: 200 },
  questionTopic: { aim: 80, max: 80 },
  optionDetail: { aim: 180, max: 200 },
  optionLabel: { aim: 80, max: 80 },
  roundIntro: { aim: 250, max: 300 },
  mapTitle: { aim: 40, max: 80 },
  mapSummary: { aim: 1000, max: 1000 },
  destination: { aim: 1000, max: 1000 },
  waypointTitle: { aim: 120, max: 120 },
  waypointQuestion: { aim: 1000, max: 1000 },
  resolution: { aim: 700, max: 1000 },
  gist: { aim: 200, max: 200 },
  agentDecided: { aim: 120, max: 200 },
  mapLine: { aim: 500, max: 500 },
  findingExplanation: { aim: 4000, max: 4000 },
  researchSummary: { aim: 4000, max: 4000 },
  researchFindingTitle: { aim: 120, max: 120 },
  researchFindingDetail: { aim: 2000, max: 2000 },
  researchSourceTitle: { aim: 200, max: 200 },
  researchExcerpt: { aim: 2000, max: 2000 },
  researchNote: { aim: 1000, max: 1000 },
  taskAction: { aim: 1000, max: 1000 },
  taskFacts: { aim: 4000, max: 4000 },
  surveyText: { aim: 400, max: 400 },
  surveyName: { aim: 200, max: 200 },
  hatchReply: { aim: 2000, max: 2000 },
  waitNote: { aim: 4000, max: 4000 },
  specTitle: { aim: 120, max: 120 },
  specProse: { aim: 500, max: 600 },
  clauseTitle: { aim: 120, max: 120 },
  clauseText: { aim: 350, max: 500 },
  criterionText: { aim: 500, max: 500 },
  clauseName: { aim: 200, max: 200 },
  contentLine: { aim: 500, max: 500 },
  removalReason: { aim: 300, max: 300 },
  ticketTitle: { aim: 90, max: 120 },
  ticketBuild: { aim: 1000, max: 2500 },
  dispositionText: { aim: 1000, max: 1000 },
  ticketSetSlicing: { aim: 2000, max: 2000 },
  ticketSetExecution: { aim: 1000, max: 1000 },
  specReviewSummary: { aim: 800, max: 1500 },
  ticketsReviewSummary: { aim: 800, max: 1500 },
  ticketsReviewFindingTitle: { aim: 120, max: 120 },
  ticketsReviewFindingExplanation: { aim: 1000, max: 1000 },
  ticketsReviewFindingQuestion: { aim: 500, max: 500 },
};

/**
 * Limits whose every aim sits below its max and every max is distinct (from 9001, past every stored
 * cap and every count a prompt states), so each prompt wording and schema bound names one field.
 */
export const DISTINCT_LIMITS: ModelLimits = ModelLimits.parse(
  Object.fromEntries(
    ModelLimits.keyof().options.map((field, index) => [
      field,
      { aim: 9001 + index * 2, max: 9002 + index * 2 },
    ]),
  ),
);

/**
 * What a `--json-schema` built from `DISTINCT_LIMITS` bounds: the fields whose max bounds some string
 * in it, in `ModelLimits` order, and every other string bound (a path's, which no model drafts).
 */
export function boundFields(jsonSchema: string): {
  readonly fields: ModelLimitField[];
  readonly fixed: number[];
} {
  const maxes = new Set<number>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if ("maxLength" in node && typeof node.maxLength === "number") maxes.add(node.maxLength);
    Object.values(node).forEach(walk);
  };
  walk(JSON.parse(jsonSchema));
  const fields = ModelLimits.keyof().options.filter((field) =>
    maxes.has(DISTINCT_LIMITS[field].max),
  );
  const bound = new Set(fields.map((field) => DISTINCT_LIMITS[field].max));
  return { fields, fixed: [...maxes].filter((max) => !bound.has(max)).sort() };
}

/**
 * The fields of `jsonSchema` (built from `DISTINCT_LIMITS`) whose length `prompt` does not state,
 * `exempt` aside: a field reached only through a list the prompt says to leave empty.
 */
export function unstatedLengths(
  prompt: string,
  jsonSchema: string,
  exempt: readonly ModelLimitField[],
): ModelLimitField[] {
  return boundFields(jsonSchema).fields.filter(
    (field) => !exempt.includes(field) && !prompt.includes(lengthWords(DISTINCT_LIMITS[field])),
  );
}
