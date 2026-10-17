import {
  type PlanningRunConfig,
  type CheckConsistency,
  consistencyOutcome,
  type ModelLimits,
  researchOutcome,
  type ResearchWaypoint,
  taskOutcome,
  taskRound,
  type WorkTask,
} from "@zenorm/contracts";
import { z } from "zod";

import { READ_ONLY_TOOLS, RESEARCH_TOOLS, runStructured, structuredOutput } from "./claude.ts";
import {
  buildConsistencyPrompt,
  buildResearchPrompt,
  buildTaskPrompt,
} from "./waypoint-run-prompt.ts";

/**
 * A Task run's output as the model writes it: `kind` names the outcome and the round's `intro` and
 * `questions` sit at the root, so no closing brace of a nested round can be dropped; parsed into a
 * `TaskOutcome`, whose refinements still hold.
 */
function taskOutput(limits: ModelLimits) {
  const round = taskRound(limits);
  const outcome = taskOutcome(limits);
  return z
    .strictObject({
      kind: z.enum(["round", "done", "failed", "outOfScope"]),
      intro: round.shape.intro.nullable(),
      questions: round.shape.questions.nullable(),
      done: outcome.shape.done,
      failed: outcome.shape.failed,
      outOfScope: outcome.shape.outOfScope,
      mapChanges: outcome.shape.mapChanges,
    })
    .transform(({ kind, intro, questions, ...outcome }, context) => {
      const round = intro !== null && questions !== null ? { intro, questions } : null;
      if (round === null && (intro !== null || questions !== null)) {
        context.addIssue({ code: "custom", message: "Set intro and questions together." });
      }
      if ({ ...outcome, round }[kind] === null) {
        context.addIssue({ code: "custom", message: `kind is ${kind}, so set its fields.` });
      }
      return { ...outcome, round };
    })
    .pipe(outcome);
}

/** The `--json-schema` of a research run; root properties `report, outOfScope, mapChanges`. */
export function researchJsonSchema(limits: ModelLimits): string {
  return structuredOutput(researchOutcome(limits)).jsonSchema;
}

/** The `--json-schema` of a task run; root properties `kind, intro, questions, done, failed, outOfScope, mapChanges`. */
export function taskJsonSchema(limits: ModelLimits): string {
  return structuredOutput(taskOutput(limits)).jsonSchema;
}

/** The `--json-schema` of a consistency pass; root properties `findings, proposals`. */
export function consistencyJsonSchema(limits: ModelLimits): string {
  return structuredOutput(consistencyOutcome(limits)).jsonSchema;
}

/**
 * How many times the configured turns and timeout a research or task run gets: research reads the
 * web, and a task reads the repository widely before it answers.
 */
export const WAYPOINT_RUN_BUDGET_MULTIPLIER = 2;

/** The config a research or task run runs under: the configured turns and timeout, each multiplied. */
export function waypointRunConfig(config: PlanningRunConfig): PlanningRunConfig {
  return {
    ...config,
    maxTurns: config.maxTurns * WAYPOINT_RUN_BUDGET_MULTIPLIER,
    timeoutSeconds: config.timeoutSeconds * WAYPOINT_RUN_BUDGET_MULTIPLIER,
  };
}

/**
 * The planning agent's research of one waypoint through the Claude Code CLI at `config.claudePath`:
 * it may read the repository and the web, and change nothing. It runs under `waypointRunConfig`,
 * and its prompt states its turn budget.
 */
export function claudeCodeResearchWaypoint(config: PlanningRunConfig): ResearchWaypoint {
  const research = waypointRunConfig(config);
  const output = structuredOutput(researchOutcome(config.limits));
  return (request, session) =>
    runStructured(
      research,
      session,
      request.projectFolder,
      buildResearchPrompt(request, config.limits, research.maxTurns),
      output,
      RESEARCH_TOOLS,
    );
}

/**
 * The planning agent's work on one Task waypoint through the Claude Code CLI at
 * `config.claudePath`: read-only for the first release. It runs under `waypointRunConfig`, and its
 * prompt states its turn budget.
 */
export function claudeCodeWorkTask(config: PlanningRunConfig): WorkTask {
  const task = waypointRunConfig(config);
  const output = structuredOutput(taskOutput(config.limits));
  return (request, session) =>
    runStructured(
      task,
      session,
      request.projectFolder,
      buildTaskPrompt(request, config.limits, task.maxTurns),
      output,
      READ_ONLY_TOOLS,
    );
}

/**
 * The planning agent's consistency pass through the Claude Code CLI at `config.claudePath`. Its
 * structured output is built once, from `config.limits`.
 */
export function claudeCodeCheckConsistency(config: PlanningRunConfig): CheckConsistency {
  const output = structuredOutput(consistencyOutcome(config.limits));
  return (request, session) =>
    runStructured(
      config,
      session,
      request.projectFolder,
      buildConsistencyPrompt(request, config.limits),
      output,
      READ_ONLY_TOOLS,
    );
}
