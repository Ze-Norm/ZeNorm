import { z } from "zod";

import type { ModelLimits } from "./model-limits.ts";

/**
 * The code survey (harness change #1): what a map's `survey` run read of the project's code once
 * its destination was confirmed, stored on the map so every later planning run reads the same code
 * facts instead of rediscovering them. Every fact and identifier carries the file and line it was
 * read from; core refuses a survey naming a path or line the project does not have.
 */

/** The most areas one survey names. */
export const SURVEY_AREAS_MAX_COUNT = 40;
/** The most facts one area carries. */
export const SURVEY_AREA_FACTS_MAX_COUNT = 20;
/** The most surface files one area names. */
export const SURVEY_SURFACE_FILES_MAX_COUNT = 12;
/** The most identifiers one survey names. */
export const SURVEY_IDENTIFIERS_MAX_COUNT = 80;
/** The most things one survey says it could not verify. */
export const SURVEY_UNVERIFIABLE_MAX_COUNT = 12;

/** The most lifecycles one survey describes. */
export const SURVEY_LIFECYCLES_MAX_COUNT = 10;
/** The most states one lifecycle names. */
export const LIFECYCLE_STATES_MAX_COUNT = 12;
/** The most transitions one lifecycle names. */
export const LIFECYCLE_TRANSITIONS_MAX_COUNT = 24;

/** The longest claim, role, reason, meaning or unverifiable line a survey carries. */
export const SURVEY_TEXT_MAX_LENGTH = 400;

/**
 * A path relative to the project's repository root: one line, not absolute, no `..` segment and no
 * trailing slash.
 */
export const SurveyPath = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))\S*[^\s/]$/,
    "A path relative to the repository root, without `..` or a trailing slash.",
  );
export type SurveyPath = z.infer<typeof SurveyPath>;

/** The file and 1-based line a fact or identifier was read from. */
const SurveySourceFields = {
  path: SurveyPath,
  line: z.int().min(1),
};

/** The longest identifier name, record name or state name a survey carries. */
export const SURVEY_NAME_MAX_LENGTH = 200;

/**
 * The survey's records, with each sentence (`text`) and each name (`name`) bounded: by the stored
 * caps (`CodeSurvey`) or by a survey run's model's limits (`codeSurveyDraft`).
 */
function surveySchemas(text: z.ZodString, name: z.ZodString) {
  /** One fact about the code, with the file and line that show it. */
  const fact = z.strictObject({
    claim: text,
    ...SurveySourceFields,
  });

  /**
   * One area of the project (a top-level package, app or directory): its role, whether the map's
   * destination touches it, the files where it would be touched and the facts read from it.
   */
  const area = z.strictObject({
    /** The area's directory (or file), relative to the repository root. */
    area: SurveyPath,
    /** What the area is for, in one sentence. */
    role: text,
    /** Whether the map's destination changes or depends on the area. */
    touched: z.boolean(),
    /** Why it is touched or not, in one sentence. */
    why: text,
    /** The files a change for the destination would touch; empty when untouched. */
    surfaceFiles: z.array(SurveyPath).max(SURVEY_SURFACE_FILES_MAX_COUNT),
    facts: z.array(fact).max(SURVEY_AREA_FACTS_MAX_COUNT),
  });

  /** A name the code defines that specs must use exactly: an error code, config key, state, record. */
  const identifier = z.strictObject({
    name,
    meaning: text,
    ...SurveySourceFields,
  });

  /** One way a record moves between two states: the function or procedure that moves it, cited. */
  const transition = z.strictObject({
    /** A record's state, as the code names it (`running`, `failed`, `resolved`). */
    from: name,
    to: name,
    /** The function, procedure or event that performs it, in one sentence. */
    by: text,
    ...SurveySourceFields,
  });

  /**
   * A state no transition of the lifecycle leaves, or only some do: what, if anything, moves a
   * record out of it ("nothing: `tryAgain` refuses it"), cited where that is decided.
   */
  const terminal = z.strictObject({
    state: name,
    exits: text,
    ...SurveySourceFields,
  });

  /**
   * A stateful record the destination touches (a run, a revision, a ticket set): its states, what
   * moves it between them and what leaves its dead ends, each cited at the code that decides it.
   */
  const lifecycle = z.strictObject({
    record: name,
    states: z.array(name).min(1).max(LIFECYCLE_STATES_MAX_COUNT),
    transitions: z.array(transition).max(LIFECYCLE_TRANSITIONS_MAX_COUNT),
    terminal: z.array(terminal).max(LIFECYCLE_STATES_MAX_COUNT),
  });

  return {
    fact,
    area,
    identifier,
    transition,
    terminal,
    lifecycle,
    fields: {
      entries: z.array(area).min(1).max(SURVEY_AREAS_MAX_COUNT),
      identifiers: z.array(identifier).max(SURVEY_IDENTIFIERS_MAX_COUNT),
      /** What the survey looked for and could not establish from the code. */
      unverifiable: z.array(text).max(SURVEY_UNVERIFIABLE_MAX_COUNT),
    },
    lifecycles: z.array(lifecycle).max(SURVEY_LIFECYCLES_MAX_COUNT),
  };
}

const stored = surveySchemas(
  z.string().min(1).max(SURVEY_TEXT_MAX_LENGTH),
  z.string().min(1).max(SURVEY_NAME_MAX_LENGTH),
);

export const SurveyFact = stored.fact;
export type SurveyFact = z.infer<typeof SurveyFact>;
export const SurveyArea = stored.area;
export type SurveyArea = z.infer<typeof SurveyArea>;
export const SurveyIdentifier = stored.identifier;
export type SurveyIdentifier = z.infer<typeof SurveyIdentifier>;
export const LifecycleTransition = stored.transition;
export type LifecycleTransition = z.infer<typeof LifecycleTransition>;
export const LifecycleTerminal = stored.terminal;
export type LifecycleTerminal = z.infer<typeof LifecycleTerminal>;
export const SurveyLifecycle = stored.lifecycle;
export type SurveyLifecycle = z.infer<typeof SurveyLifecycle>;

/**
 * A map's stored code survey: at least one area; every fact, identifier, transition and terminal
 * state has a path and line. `lifecycles` is absent on a survey written before surveys had them.
 */
export const CodeSurvey = z.strictObject({
  ...stored.fields,
  lifecycles: stored.lifecycles.optional(),
});
export type CodeSurvey = z.infer<typeof CodeSurvey>;

/**
 * A survey run's output: a `CodeSurvey` with its lifecycles (none when no record is touched), its
 * sentences and names within the run's model's limits (`agent.models`). Longer output is refused.
 */
export function codeSurveyDraft(limits: ModelLimits) {
  const draft = surveySchemas(
    z.string().min(1).max(limits.surveyText.max),
    z.string().min(1).max(limits.surveyName.max),
  );
  return z.strictObject({ ...draft.fields, lifecycles: draft.lifecycles });
}
export type CodeSurveyDraft = z.infer<ReturnType<typeof codeSurveyDraft>>;
