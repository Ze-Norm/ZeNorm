import { randomUUID } from "node:crypto";

import {
  codeSurveyDraft,
  type ModelLimits,
  LIFECYCLE_STATES_MAX_COUNT,
  LIFECYCLE_TRANSITIONS_MAX_COUNT,
  type PlanningRunConfig,
  SURVEY_LIFECYCLES_MAX_COUNT,
  SURVEY_AREA_FACTS_MAX_COUNT,
  SURVEY_AREAS_MAX_COUNT,
  SURVEY_IDENTIFIERS_MAX_COUNT,
  SURVEY_SURFACE_FILES_MAX_COUNT,
  SURVEY_UNVERIFIABLE_MAX_COUNT,
  type SurveyCode,
  type SurveyCodeRequest,
} from "@zenorm/contracts";

import { READ_ONLY_TOOLS, runStructured, structuredOutput } from "./claude.ts";
import { block, lengthWords, preamble } from "./prompt-parts.ts";

/**
 * The `--json-schema` of a code survey; root properties `entries, identifiers, unverifiable,
 * lifecycles`.
 */
export function surveyJsonSchema(limits: ModelLimits): string {
  return structuredOutput(codeSurveyDraft(limits)).jsonSchema;
}

/**
 * How many times the configured turns and timeout a survey run gets: it reads the rules files, the
 * workspace layout and every area of the project, more than a task run reads (a live survey of a seven-package repository took 31 to 35 turns).
 */
export const SURVEY_RUN_BUDGET_MULTIPLIER = 4;

/** The config a survey run runs under: the configured turns and timeout, each multiplied. */
export function surveyRunConfig(config: PlanningRunConfig): PlanningRunConfig {
  return {
    ...config,
    maxTurns: config.maxTurns * SURVEY_RUN_BUDGET_MULTIPLIER,
    timeoutSeconds: config.timeoutSeconds * SURVEY_RUN_BUDGET_MULTIPLIER,
  };
}

/**
 * The prompt of a map's code survey: the map as its confirming chart left it and the survey's
 * rules: rules files and workspace layout first, one entry per area, every fact cited at a line it
 * opened, code facts only. Every text the person or an earlier run wrote sits in a block under one
 * fresh nonce per call; one line states the run's turn budget, `maxTurns`.
 */
export function buildSurveyPrompt(
  request: SurveyCodeRequest,
  limits: ModelLimits,
  maxTurns: number,
): string {
  const nonce = randomUUID();
  const waypoints =
    request.waypoints.length === 0
      ? ["The chart charted no waypoints.", ""]
      : request.waypoints.flatMap((waypoint) => [
          `Waypoint ${String(waypoint.number)} (${waypoint.kind}):`,
          ...block(
            `WAYPOINT-${String(waypoint.number)}`,
            nonce,
            [`Title: ${waypoint.title}`, `Question: ${waypoint.question}`].join("\n"),
          ),
          "",
        ]);
  const fog = request.fog.flatMap((item) => [
    `Fog item at position ${String(item.position)}:`,
    ...block(`FOG-${String(item.position)}`, nonce, item.text),
    "",
  ]);
  const outOfScope = request.outOfScope.flatMap((line, index) => [
    ...block(`OUT-OF-SCOPE-${String(index + 1)}`, nonce, line),
    "",
  ]);
  return [
    ...preamble(request.projectName, request.baseBranch),
    "",
    "The person's idea for the map:",
    ...block("IDEA", nonce, request.idea),
    "",
    "The map's title:",
    ...block("TITLE", nonce, request.title),
    "",
    "The map's confirmed destination:",
    ...block("DESTINATION", nonce, request.destination),
    "",
    "The map's charted waypoints:",
    ...waypoints,
    ...(fog.length === 0 ? [] : ["The map's fog:", ...fog]),
    ...(outOfScope.length === 0 ? [] : ["The map's Out of scope lines:", ...outOfScope]),
    "Your task: survey the project's code once for this map, so every later planning run on it reads",
    "the same code facts instead of rediscovering them. You record what the code is, never what it",
    "should become: no design, no proposal, no opinion.",
    `You have ${String(maxTurns)} turns: batch independent reads into one turn, and answer before they run out.`,
    "",
    "Read in this order:",
    "1. The project's own rules files at the repository root that exist: AGENTS.md, CLAUDE.md and",
    "   CONTEXT.md (a glossary). Open each with Read, even when it is already in your context: a fact",
    "   needs the line Read shows.",
    "2. The workspace layout: the workspace manifest (pnpm-workspace.yaml, the root package.json",
    "   workspaces, Cargo.toml, go.work or the like) and the root directory listing.",
    "3. In each area, the files the destination's wording points at: Grep for its nouns and verbs.",
    "",
    "The output:",
    `- entries: one per area, at most ${String(SURVEY_AREAS_MAX_COUNT)}. An area is a workspace package or app`,
    "  directory (packages/foo, apps/bar, not packages); in a repository without a workspace, a top-level",
    "  source directory. Skip dependencies, build output and VCS directories. Every area gets an entry,",
    "  touched or not:",
    "  - area: its directory; role: what it owns, in one sentence.",
    "  - touched: true when the destination changes or depends on code in it; why: one sentence naming",
    "    the existing code it reaches there, or why none. Not what to build.",
    `  - surfaceFiles: up to ${String(SURVEY_SURFACE_FILES_MAX_COUNT)} existing files a change for the destination would edit; empty`,
    "    when untouched. A file that does not exist yet is never a surface file: state its absence as a",
    "    fact cited at the existing file nearest to where it would go.",
    `  - facts: up to ${String(SURVEY_AREA_FACTS_MAX_COUNT)} code facts that bear on the destination: what exists, what a function,`,
    "    table, state or route does, which file owns what, what is absent. Untouched areas need none.",
    `- identifiers: up to ${String(SURVEY_IDENTIFIERS_MAX_COUNT)} names the code or the glossary defines that the destination's`,
    "  wording maps to and a specification must use exactly: glossary terms, table and column names, state",
    "  and status values, error codes, config keys, procedure and route names. meaning: what it names.",
    `- lifecycles: up to ${String(SURVEY_LIFECYCLES_MAX_COUNT)}, one per stateful record the destination creates, moves, stops or`,
    "  reads the state of (a run, a revision, a waypoint, a ticket set, a delivery): what a spec will",
    "  claim happens to it has to match what the code lets happen. Empty when the destination touches",
    "  no state. Per record:",
    `  - record: its name in the code; states: up to ${String(LIFECYCLE_STATES_MAX_COUNT)} state values as the code spells them.`,
    `  - transitions: up to ${String(LIFECYCLE_TRANSITIONS_MAX_COUNT)}, each from, to, by (the function or procedure that moves it),`,
    "    cited at the line that sets the new state. Open the code that writes the state column; never",
    "    infer a transition from a name.",
    "  - terminal: each state that no transition leaves, or that only some callers may leave: exits says",
    '    what, if anything, moves a record out ("nothing: tryAgain refuses it", "only a new revision"),',
    "    cited at the line that decides it (the guard, the refusal, the filter).",
    `- unverifiable: up to ${String(SURVEY_UNVERIFIABLE_MAX_COUNT)} things you looked for and could not establish from the code. Put`,
    "  a doubt here instead of guessing, as a question about the code (what it does), not about a design.",
    "",
    "Citations:",
    "- Every path is relative to the repository root, with no leading ./ and no trailing slash.",
    "- Every fact, identifier, transition and terminal state names the file and the 1-based line that",
    "  shows it: the line number Read or Grep printed beside that text. Cite only files you opened; never",
    "  estimate a line. A path or line the repository does not have refuses the whole survey.",
    `- Terse: each claim, why, role, meaning, by, exits and unverifiable item is one plain sentence of`,
    `  ${lengthWords(limits.surveyText)}; each identifier name, record and state ${lengthWords(limits.surveyName)}.`,
  ].join("\n");
}

/**
 * The code survey of a map behind the `SurveyCode` port: read-only tools, under `surveyRunConfig`;
 * its prompt states its turn budget.
 */
export function claudeCodeSurveyCode(config: PlanningRunConfig): SurveyCode {
  const survey = surveyRunConfig(config);
  const output = structuredOutput(codeSurveyDraft(config.limits));
  return (request, session) =>
    runStructured(
      survey,
      session,
      request.projectFolder,
      buildSurveyPrompt(request, config.limits, survey.maxTurns),
      output,
      READ_ONLY_TOOLS,
    );
}
