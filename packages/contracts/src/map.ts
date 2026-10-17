import { z } from "zod";

import type { ModelLimits } from "./model-limits.ts";
import { Project } from "./project.ts";

/** Every stored entity id is a UUIDv7. */
export const EntityId = z.uuid({ version: "v7" });

export const MAP_IDEA_MAX_LENGTH = 4000;
/** The stored bounds on a question's text, an option's detail and a round's intro. */
export const QUESTION_TEXT_MAX_LENGTH = 1000;
export const OPTION_DETAIL_MAX_LENGTH = 500;
export const ROUND_INTRO_MAX_LENGTH = 1000;
/** The stored bounds on a question's topic and an option's label. */
export const QUESTION_TOPIC_MAX_LENGTH = 80;
export const OPTION_LABEL_MAX_LENGTH = 80;
export const ANSWER_NOTE_MAX_LENGTH = 4000;

/** The person's idea a map starts from. Trimmed; the length keeps the prompt well under `ARG_MAX`. */
export const MapIdea = z.string().trim().min(1).max(MAP_IDEA_MAX_LENGTH);

/** One option of a question; the first option of a question is the recommendation. */
export const QuestionOption = z.strictObject({
  label: z.string().min(1).max(OPTION_LABEL_MAX_LENGTH),
  /** What choosing this option gives and costs. */
  detail: z.string().min(1).max(OPTION_DETAIL_MAX_LENGTH),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/**
 * A question as stored and read back: rounds asked before the drafting bounds below still load.
 * Every question has 2 to 4 options, the first the recommendation; none is answered in words alone.
 */
export const Question = z.strictObject({
  topic: z.string().min(1).max(QUESTION_TOPIC_MAX_LENGTH),
  text: z.string().min(1).max(QUESTION_TEXT_MAX_LENGTH),
  options: z.array(QuestionOption).min(2).max(4),
});
export type Question = z.infer<typeof Question>;

/** The round intro's stored bound. */
const RoundIntro = z.string().min(1).max(ROUND_INTRO_MAX_LENGTH);

/** The `questions` of a round: every question has 2 to 4 options, the first the recommendation. */
export const RoundQuestions = z.array(Question).min(1).max(5);
export type RoundQuestions = z.infer<typeof RoundQuestions>;

/**
 * What the planning agent writes for a busy reader: a question's text, an option's detail and a
 * round's intro, within the run's model's limits (`agent.models`). They apply to the agent's output
 * only; stored rounds keep the wider bounds above, so rounds asked before them still load.
 * Over-length output is refused, never cut.
 */

/** A round intro as the planning agent writes it. */
export function draftRoundIntro(limits: ModelLimits) {
  return z.string().min(1).max(limits.roundIntro.max);
}

/** A question as the planning agent writes it: a `Question` within the drafting bounds. */
export function draftQuestion(limits: ModelLimits) {
  return z.strictObject({
    topic: z.string().min(1).max(limits.questionTopic.max),
    text: z.string().min(1).max(limits.questionText.max),
    options: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(limits.optionLabel.max),
          detail: z.string().min(1).max(limits.optionDetail.max),
        }),
      )
      .min(2)
      .max(4),
  });
}

/** The `questions` of a round as the planning agent writes them. */
export function draftRoundQuestions(limits: ModelLimits) {
  return z.array(draftQuestion(limits)).min(1).max(5);
}

/**
 * The planning agent's question round, as the model returns it. Its JSON Schema is the CLI's
 * `--json-schema`; it is stricter than the stored round (`QuestionRound`), so whatever it accepts
 * the stored column accepts.
 */
export function questionRoundDraft(limits: ModelLimits) {
  return z.strictObject({
    intro: draftRoundIntro(limits),
    questions: draftRoundQuestions(limits),
  });
}
export type QuestionRoundDraft = z.infer<ReturnType<typeof questionRoundDraft>>;

/**
 * One answer, positional to its question: an option index, the person's words, or both. `accepted`
 * marks option 0 taken through Accept the rest, with no words.
 */
export const Answer = z.strictObject({
  optionIndex: z.int().min(0).nullable(),
  note: z.string().trim().max(ANSWER_NOTE_MAX_LENGTH),
  accepted: z.boolean(),
});
export type Answer = z.infer<typeof Answer>;

/** The stored `answers` of a round: one per question, in order. */
export const Answers = z.array(Answer);
export type Answers = z.infer<typeof Answers>;

/** A round is pending until submitted or withdrawn. */
export const RoundStatus = z.enum(["pending", "submitted", "withdrawn"]);
export type RoundStatus = z.infer<typeof RoundStatus>;

/**
 * Why a pending round was withdrawn: its waypoint was reopened, reworded or claimed afresh
 * (`superseded`), or ruled out of scope.
 */
export const RoundWithdrawnReason = z.enum(["superseded", "waypoint_out_of_scope"]);
export type RoundWithdrawnReason = z.infer<typeof RoundWithdrawnReason>;

/**
 * A stored question round: on a waypoint, or map-level (`waypointId` null) during charting. Rounds
 * on a waypoint are numbered from 1; map-level rounds are numbered from 1 per map.
 */
export const QuestionRound = z.strictObject({
  id: EntityId,
  mapId: EntityId,
  /** Null for a map-level round. */
  waypointId: EntityId.nullable(),
  number: z.int().min(1),
  /**
   * The waypoint's last round, or the destination's last follow-up; the first map-level round is
   * never final.
   */
  final: z.boolean(),
  status: RoundStatus,
  /** The planning run that asked it. */
  askedByRun: EntityId,
  intro: RoundIntro,
  questions: RoundQuestions,
  /** Null until submitted. */
  answers: Answers.nullable(),
  /** ISO 8601 UTC. */
  askedAt: z.iso.datetime(),
  /** ISO 8601 UTC; null until submitted. */
  submittedAt: z.iso.datetime().nullable(),
  /** ISO 8601 UTC; set exactly when withdrawn. */
  withdrawnAt: z.iso.datetime().nullable(),
  /** Set exactly when withdrawn. */
  withdrawnReason: RoundWithdrawnReason.nullable(),
});
export type QuestionRound = z.infer<typeof QuestionRound>;

export const MAP_TITLE_MAX_LENGTH = 120;
export const MAP_SUMMARY_MAX_LENGTH = 1000;
export const MAP_DESTINATION_MAX_LENGTH = 1000;

export const MapTitle = z.string().min(1).max(MAP_TITLE_MAX_LENGTH);
export const MapSummary = z.string().min(1).max(MAP_SUMMARY_MAX_LENGTH);
export const MapDestination = z.string().min(1).max(MAP_DESTINATION_MAX_LENGTH);

/** A map. Not called `Map`, which would shadow the JS global in every importer. */
export const MapRecord = z.strictObject({
  id: EntityId,
  projectId: EntityId,
  idea: MapIdea,
  /** The first chart's reading of the idea; null until charted. */
  title: MapTitle.nullable(),
  summary: MapSummary.nullable(),
  /** Proposed by the first chart, confirmed by the next; null until charted. */
  destination: MapDestination.nullable(),
  /** ISO 8601 UTC; null until the destination is confirmed. */
  destinationConfirmedAt: z.iso.datetime().nullable(),
  /** ISO 8601 UTC. */
  createdAt: z.iso.datetime(),
  /**
   * The map whose proposal the person confirmed to create this one, and the run that proposed it;
   * both null for a map the person added, and for every map that predates proposals.
   */
  splitFromMapId: EntityId.nullable(),
  splitFromRunId: EntityId.nullable(),
});
export type MapRecord = z.infer<typeof MapRecord>;

export const MapDetail = z.strictObject({
  map: MapRecord,
  project: Project,
});
export type MapDetail = z.infer<typeof MapDetail>;

export const GetProjectInput = z.strictObject({ projectId: EntityId });
export type GetProjectInput = z.infer<typeof GetProjectInput>;

export const ListMapsInput = z.strictObject({ projectId: EntityId });
export type ListMapsInput = z.infer<typeof ListMapsInput>;

export const GetMapInput = z.strictObject({ mapId: EntityId });
export type GetMapInput = z.infer<typeof GetMapInput>;

/**
 * `map.delete`'s input. `deleteSpecs` are the numbers of the specs the map wrote, in ascending
 * order, that the person agreed to delete with it, with their ticket sets; `[]` for none. Unless
 * they are exactly the specs the map wrote when the delete runs, the map is refused, naming them, so
 * a spec written after the person was asked is never deleted unseen.
 */
export const DeleteMapInput = z.strictObject({
  mapId: EntityId,
  deleteSpecs: z.array(z.int().min(1)),
});
export type DeleteMapInput = z.infer<typeof DeleteMapInput>;

/** `map.delete`'s output: the project the deleted map was in. */
export const DeletedMap = z.strictObject({ mapId: EntityId, projectId: EntityId });
export type DeletedMap = z.infer<typeof DeletedMap>;

export const CreateMapInput = z.strictObject({
  projectId: EntityId,
  idea: MapIdea,
});
export type CreateMapInput = z.infer<typeof CreateMapInput>;

export const SubmitAnswersInput = z.strictObject({
  roundId: EntityId,
  answers: Answers,
});
export type SubmitAnswersInput = z.infer<typeof SubmitAnswersInput>;
