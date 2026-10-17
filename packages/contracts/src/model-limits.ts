import { z } from "zod";

import { SURVEY_NAME_MAX_LENGTH, SURVEY_TEXT_MAX_LENGTH } from "./code-survey.ts";
import { HATCH_MESSAGE_MAX_LENGTH, HATCH_REPLY_MAX_LENGTH } from "./hatch.ts";
import {
  MAP_DESTINATION_MAX_LENGTH,
  MAP_SUMMARY_MAX_LENGTH,
  MAP_TITLE_MAX_LENGTH,
  OPTION_DETAIL_MAX_LENGTH,
  OPTION_LABEL_MAX_LENGTH,
  QUESTION_TEXT_MAX_LENGTH,
  QUESTION_TOPIC_MAX_LENGTH,
  ROUND_INTRO_MAX_LENGTH,
} from "./map.ts";
import {
  CLAUSE_NAME_MAX_LENGTH,
  CLAUSE_TEXT_MAX_LENGTH,
  CLAUSE_TITLE_MAX_LENGTH,
  CONTENT_LINE_MAX_LENGTH,
  CRITERION_TEXT_MAX_LENGTH,
  DISPOSITION_TEXT_MAX_LENGTH,
  SPEC_REMOVAL_REASON_MAX_LENGTH,
  SPEC_REVIEW_SUMMARY_MAX_LENGTH,
  SPEC_REVISION_PROSE_MAX_LENGTH,
  SPEC_REVISION_TITLE_MAX_LENGTH,
  TICKET_BUILD_MAX_LENGTH,
  TICKET_CONTENT_TITLE_MAX_LENGTH,
  TICKET_SET_EXECUTION_MAX_LENGTH,
  TICKET_SET_SLICING_MAX_LENGTH,
  TICKETS_REVIEW_FINDING_EXPLANATION_MAX_LENGTH,
  TICKETS_REVIEW_FINDING_QUESTION_MAX_LENGTH,
  TICKETS_REVIEW_FINDING_TITLE_MAX_LENGTH,
  TICKETS_REVIEW_SUMMARY_MAX_LENGTH,
} from "./spec-content.ts";
import {
  MAP_LINE_MAX_LENGTH,
  RESEARCH_EXCERPT_MAX_LENGTH,
  RESEARCH_FINDING_DETAIL_MAX_LENGTH,
  RESEARCH_NOTE_MAX_LENGTH,
  RESEARCH_SOURCE_TITLE_MAX_LENGTH,
  RESEARCH_SUMMARY_MAX_LENGTH,
  WAYPOINT_AGENT_DECIDED_MAX_LENGTH,
  WAYPOINT_GIST_MAX_LENGTH,
  WAYPOINT_QUESTION_MAX_LENGTH,
  WAYPOINT_RESOLUTION_MAX_LENGTH,
  WAYPOINT_TITLE_MAX_LENGTH,
} from "./wayfinding.ts";

/**
 * One drafting length: the run's prompt asks for about `aim` characters and its `--json-schema`
 * refuses more than `max`. `aim` equal to `max` asks for at most `max`.
 */
export const LengthLimit = z.strictObject({
  aim: z.int().min(1),
  max: z.int().min(1),
});
export type LengthLimit = z.infer<typeof LengthLimit>;

/**
 * The drafting lengths of the free-text fields a planning run writes, for one model
 * (`agent.models`): every model-written text its `--json-schema` bounds, paths, ids and enums
 * aside. Strict, every key required, nothing defaulted.
 */
export const ModelLimits = z.strictObject({
  /** A question round: each question's text, topic, option detail and label, the round's intro. */
  questionText: LengthLimit,
  questionTopic: LengthLimit,
  optionDetail: LengthLimit,
  optionLabel: LengthLimit,
  roundIntro: LengthLimit,
  /** A first chart's title and summary; the destination a chart proposes or confirms. */
  mapTitle: LengthLimit,
  mapSummary: LengthLimit,
  destination: LengthLimit,
  /**
   * A waypoint's title and question wherever a run writes one (a chart, map changes, a fog run, a
   * hatch change, a consistency or spec review finding that opens one).
   */
  waypointTitle: LengthLimit,
  waypointQuestion: LengthLimit,
  /** A waypoint's resolution prose (a grilling decision, a decided fog item). */
  resolution: LengthLimit,
  /** A resolution's one line for Decisions so far. */
  gist: LengthLimit,
  /** Each line of a resolution's `agentDecided`: one call the agent made without asking. */
  agentDecided: LengthLimit,
  /** A fog item or Out of scope line, and an out-of-scope ruling's reason. */
  mapLine: LengthLimit,
  /** A consistency or spec review finding's explanation. */
  findingExplanation: LengthLimit,
  /** A research report: its summary, each finding's title and detail, each source's title and excerpt, its gap, limitations and uncertainties. */
  researchSummary: LengthLimit,
  researchFindingTitle: LengthLimit,
  researchFindingDetail: LengthLimit,
  researchSourceTitle: LengthLimit,
  researchExcerpt: LengthLimit,
  researchNote: LengthLimit,
  /** A Task outcome's action and facts. */
  taskAction: LengthLimit,
  taskFacts: LengthLimit,
  /** A code survey's sentences (claims, roles, reasons, meanings, transitions, exits, unverifiable items, and a spec review's answers to them) and its names (identifiers, records, states). */
  surveyText: LengthLimit,
  surveyName: LengthLimit,
  /** An escape hatch reply, and the note a To Spec run writes a wait from. */
  hatchReply: LengthLimit,
  waitNote: LengthLimit,
  /** A spec revision: its title, problem and solution, each clause's title, text, criteria and names, its Out of scope lines, and a repair's removal reasons. */
  specTitle: LengthLimit,
  specProse: LengthLimit,
  clauseTitle: LengthLimit,
  clauseText: LengthLimit,
  criterionText: LengthLimit,
  clauseName: LengthLimit,
  contentLine: LengthLimit,
  removalReason: LengthLimit,
  /** A ticket set: each ticket's title and build, each disposition's reason or evidence, its slicing and execution. */
  ticketTitle: LengthLimit,
  ticketBuild: LengthLimit,
  dispositionText: LengthLimit,
  ticketSetSlicing: LengthLimit,
  ticketSetExecution: LengthLimit,
  /** The planning reviews: each one's summary, and a tickets review finding's title, explanation and question. */
  specReviewSummary: LengthLimit,
  ticketsReviewSummary: LengthLimit,
  ticketsReviewFindingTitle: LengthLimit,
  ticketsReviewFindingExplanation: LengthLimit,
  ticketsReviewFindingQuestion: LengthLimit,
});
export type ModelLimits = z.infer<typeof ModelLimits>;

export type ModelLimitField = keyof ModelLimits;

/**
 * The stored cap of each field: the bound of the schema that stores the value. A model's `max` may
 * not pass it, so whatever a run writes the stored column accepts.
 */
export const MODEL_LIMIT_STORED_CAPS: Readonly<Record<ModelLimitField, number>> = {
  questionText: QUESTION_TEXT_MAX_LENGTH,
  questionTopic: QUESTION_TOPIC_MAX_LENGTH,
  optionDetail: OPTION_DETAIL_MAX_LENGTH,
  optionLabel: OPTION_LABEL_MAX_LENGTH,
  roundIntro: ROUND_INTRO_MAX_LENGTH,
  mapTitle: MAP_TITLE_MAX_LENGTH,
  mapSummary: MAP_SUMMARY_MAX_LENGTH,
  destination: MAP_DESTINATION_MAX_LENGTH,
  waypointTitle: WAYPOINT_TITLE_MAX_LENGTH,
  waypointQuestion: WAYPOINT_QUESTION_MAX_LENGTH,
  resolution: WAYPOINT_RESOLUTION_MAX_LENGTH,
  gist: WAYPOINT_GIST_MAX_LENGTH,
  agentDecided: WAYPOINT_AGENT_DECIDED_MAX_LENGTH,
  mapLine: MAP_LINE_MAX_LENGTH,
  findingExplanation: WAYPOINT_RESOLUTION_MAX_LENGTH,
  researchSummary: RESEARCH_SUMMARY_MAX_LENGTH,
  researchFindingTitle: WAYPOINT_TITLE_MAX_LENGTH,
  researchFindingDetail: RESEARCH_FINDING_DETAIL_MAX_LENGTH,
  researchSourceTitle: RESEARCH_SOURCE_TITLE_MAX_LENGTH,
  researchExcerpt: RESEARCH_EXCERPT_MAX_LENGTH,
  researchNote: RESEARCH_NOTE_MAX_LENGTH,
  taskAction: WAYPOINT_QUESTION_MAX_LENGTH,
  taskFacts: WAYPOINT_RESOLUTION_MAX_LENGTH,
  surveyText: SURVEY_TEXT_MAX_LENGTH,
  surveyName: SURVEY_NAME_MAX_LENGTH,
  hatchReply: HATCH_REPLY_MAX_LENGTH,
  waitNote: HATCH_MESSAGE_MAX_LENGTH,
  specTitle: SPEC_REVISION_TITLE_MAX_LENGTH,
  specProse: SPEC_REVISION_PROSE_MAX_LENGTH,
  clauseTitle: CLAUSE_TITLE_MAX_LENGTH,
  clauseText: CLAUSE_TEXT_MAX_LENGTH,
  criterionText: CRITERION_TEXT_MAX_LENGTH,
  clauseName: CLAUSE_NAME_MAX_LENGTH,
  contentLine: CONTENT_LINE_MAX_LENGTH,
  removalReason: SPEC_REMOVAL_REASON_MAX_LENGTH,
  ticketTitle: TICKET_CONTENT_TITLE_MAX_LENGTH,
  ticketBuild: TICKET_BUILD_MAX_LENGTH,
  dispositionText: DISPOSITION_TEXT_MAX_LENGTH,
  ticketSetSlicing: TICKET_SET_SLICING_MAX_LENGTH,
  ticketSetExecution: TICKET_SET_EXECUTION_MAX_LENGTH,
  specReviewSummary: SPEC_REVIEW_SUMMARY_MAX_LENGTH,
  ticketsReviewSummary: TICKETS_REVIEW_SUMMARY_MAX_LENGTH,
  ticketsReviewFindingTitle: TICKETS_REVIEW_FINDING_TITLE_MAX_LENGTH,
  ticketsReviewFindingExplanation: TICKETS_REVIEW_FINDING_EXPLANATION_MAX_LENGTH,
  ticketsReviewFindingQuestion: TICKETS_REVIEW_FINDING_QUESTION_MAX_LENGTH,
};

/**
 * Sonnet's drafting lengths: the `config.example.json` profile, the entry `zenorm init` writes for
 * a model with no tested table of its own, and the one every e2e config carries.
 */
export const SONNET_LIMITS: ModelLimits = {
  questionText: { aim: 200, max: 200 },
  questionTopic: { aim: 80, max: 80 },
  optionDetail: { aim: 200, max: 200 },
  optionLabel: { aim: 80, max: 80 },
  roundIntro: { aim: 300, max: 300 },
  mapTitle: { aim: 40, max: 80 },
  mapSummary: { aim: 1000, max: 1000 },
  destination: { aim: 1000, max: 1000 },
  waypointTitle: { aim: 120, max: 120 },
  waypointQuestion: { aim: 300, max: 1000 },
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

/**
 * Opus's drafting lengths: the planning eval's round 9 Opus profile (lower aims, more headroom
 * where Opus overran Sonnet's maxes) for its ten fields, Sonnet's for every other.
 */
export const OPUS_LIMITS: ModelLimits = {
  ...SONNET_LIMITS,
  questionText: { aim: 200, max: 200 },
  optionDetail: { aim: 180, max: 200 },
  roundIntro: { aim: 250, max: 300 },
  resolution: { aim: 700, max: 1000 },
  specProse: { aim: 500, max: 600 },
  clauseText: { aim: 350, max: 500 },
  ticketTitle: { aim: 90, max: 120 },
  ticketBuild: { aim: 1000, max: 2500 },
  specReviewSummary: { aim: 800, max: 1500 },
  ticketsReviewSummary: { aim: 800, max: 1500 },
};

/** The models with a tested drafting-length table, by model id: Sonnet and Opus. */
export const TESTED_MODEL_LIMITS: Readonly<Record<string, ModelLimits>> = {
  "claude-sonnet-5-5": SONNET_LIMITS,
  "claude-opus-5-5": OPUS_LIMITS,
};

/**
 * The stored caps as a `ModelLimits` (every aim its max): the bounds of what is stored, for schemas
 * that read it back. Parsed, so a field without a cap fails at load.
 */
export const STORED_LIMITS: ModelLimits = ModelLimits.parse(
  Object.fromEntries(
    Object.entries(MODEL_LIMIT_STORED_CAPS).map(([field, cap]) => [field, { aim: cap, max: cap }]),
  ),
);
