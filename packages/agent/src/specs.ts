import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type CancelledError,
  type PlanningCallSession,
  type PlanningRunConfig,
  type DraftSpecs,
  draftSpecsOutcome,
  type DraftTicketSet,
  type ModelLimits,
  type PlanningAgentError,
  type Result,
  type ReviewSpec,
  type ReviewTicketSet,
  type ReviseSpec,
  reviseSpecOutcome,
  type SkillMissingError,
  specReviewOutcome,
  ticketSetDraft,
  ticketsReviewOutcome,
} from "@zenorm/contracts";
import type { z } from "zod";

import {
  READ_ONLY_TOOLS,
  runStructuredWith,
  type StructuredOutput,
  structuredOutput,
} from "./claude.ts";
import { checkSkill, planningSkills } from "./skills.ts";
import {
  buildDraftSpecsPrompt,
  buildDraftTicketSetPrompt,
  buildReviewSpecPrompt,
  buildReviewTicketSetPrompt,
  buildReviseSpecPrompt,
  buildSkillSystemPrompt,
  type PlanningSkill,
} from "./spec-prompt.ts";

// Each output is checked against the full content schema here, so content the schema refuses (zero
// tickets, a 13th clause, a bad disposition) fails the run as a retried `agent_output_invalid`, and
// core's `spec_content_invalid` and `ticket_set_content_invalid` are reached only by what the
// schema cannot check (ids across revisions, ticket numbering) and by core's own tests. The outputs
// are built once per port, from the run's model's limits (`agent.models`).

/** The `--json-schema` of a map-scope To Spec run; root property `specs`. */
export function draftSpecsJsonSchema(limits: ModelLimits): string {
  return structuredOutput(draftSpecsOutcome(limits)).jsonSchema;
}

/** The `--json-schema` of a spec repair; root property `revision`. */
export function reviseSpecJsonSchema(limits: ModelLimits): string {
  return structuredOutput(reviseSpecOutcome(limits)).jsonSchema;
}

/** The `--json-schema` of a spec review; root properties `summary, findings` (keyed by `Review of: spec`). */
export function reviewSpecJsonSchema(limits: ModelLimits): string {
  return structuredOutput(specReviewOutcome(limits)).jsonSchema;
}

/** The `--json-schema` of a To Tickets run; root properties `tickets, dispositions, slicing, execution`. */
export function draftTicketSetJsonSchema(limits: ModelLimits): string {
  return structuredOutput(ticketSetDraft(limits)).jsonSchema;
}

/**
 * The `--json-schema` of a tickets review; root properties `summary, findings`, shared with the
 * spec review, so the stand-in tells them apart by the prompt line `Review of: tickets`.
 */
export function reviewTicketSetJsonSchema(limits: ModelLimits): string {
  return structuredOutput(ticketsReviewOutcome(limits)).jsonSchema;
}

export type { PlanningSkill } from "./spec-prompt.ts";

/**
 * One planning call that follows a product skill: a missing SKILL.md refuses `agent_skill_missing`
 * before the CLI starts; otherwise the run gets the skills folder with `--add-dir` and a
 * system-prompt file naming the SKILL.md by absolute path. The file sits in a temporary folder,
 * removed when the call ends, as the project's checkout is read-only.
 */
async function runWithSkill<S extends z.ZodType>(
  config: PlanningRunConfig,
  session: PlanningCallSession,
  skill: PlanningSkill,
  projectFolder: string,
  prompt: string,
  output: StructuredOutput<S>,
): Promise<Result<z.output<S>, PlanningAgentError | CancelledError | SkillMissingError>> {
  const skillCheck = checkSkill(skill.path);
  if (!skillCheck.ok) return skillCheck;
  const promptDir = mkdtempSync(join(tmpdir(), "zenorm-planning-skill-"));
  try {
    const systemPromptFile = join(promptDir, "system-prompt.md");
    writeFileSync(systemPromptFile, buildSkillSystemPrompt(skill));
    return await runStructuredWith(
      config,
      session,
      projectFolder,
      prompt,
      output,
      READ_ONLY_TOOLS,
      ["--add-dir", dirname(dirname(skill.path)), "--append-system-prompt-file", systemPromptFile],
    );
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
}

/** `claudeCodeDraftSpecs` with its skill named; tests point it at a temp folder. */
export function draftSpecsWith(config: PlanningRunConfig, skill: PlanningSkill): DraftSpecs {
  const output = structuredOutput(draftSpecsOutcome(config.limits));
  return (request, session) =>
    runWithSkill(
      config,
      session,
      skill,
      request.projectFolder,
      buildDraftSpecsPrompt(request, config.limits),
      output,
    );
}

/** `claudeCodeReviseSpec` with its skill named. */
export function reviseSpecWith(config: PlanningRunConfig, skill: PlanningSkill): ReviseSpec {
  const output = structuredOutput(reviseSpecOutcome(config.limits));
  return (request, session) =>
    runWithSkill(
      config,
      session,
      skill,
      request.projectFolder,
      buildReviseSpecPrompt(request, config.limits),
      output,
    );
}

/** `claudeCodeReviewSpec` with its skill named. */
export function reviewSpecWith(config: PlanningRunConfig, skill: PlanningSkill): ReviewSpec {
  const output = structuredOutput(specReviewOutcome(config.limits));
  return (request, session) =>
    runWithSkill(
      config,
      session,
      skill,
      request.projectFolder,
      buildReviewSpecPrompt(request, config.limits),
      output,
    );
}

/** `claudeCodeDraftTicketSet` with its skill named. */
export function draftTicketSetWith(
  config: PlanningRunConfig,
  skill: PlanningSkill,
): DraftTicketSet {
  const output = structuredOutput(ticketSetDraft(config.limits));
  return (request, session) =>
    runWithSkill(
      config,
      session,
      skill,
      request.projectFolder,
      buildDraftTicketSetPrompt(request, config.maxTurns, config.limits),
      output,
    );
}

/**
 * `claudeCodeReviewTicketSet` with its skill named: read-only tools in the project folder, as the
 * spec review, since `unsupported_evidence` checks a disposition's evidence against the code.
 */
export function reviewTicketSetWith(
  config: PlanningRunConfig,
  skill: PlanningSkill,
): ReviewTicketSet {
  const output = structuredOutput(ticketsReviewOutcome(config.limits));
  return (request, session) =>
    runWithSkill(
      config,
      session,
      skill,
      request.projectFolder,
      buildReviewTicketSetPrompt(request, skill.path, config.limits),
      output,
    );
}

/** A spec or ticket run's config: the planning run's, and the skills folder the entry passes in. */
export type SpecRunConfig = PlanningRunConfig & { readonly skillsDir: string };

function toSpec(skillsDir: string): PlanningSkill {
  return { name: "Product To Spec", path: planningSkills(skillsDir).toSpec };
}

function planningReview(skillsDir: string): PlanningSkill {
  return { name: "Product Planning Review", path: planningSkills(skillsDir).planningReview };
}

function toTickets(skillsDir: string): PlanningSkill {
  return { name: "Product To Tickets", path: planningSkills(skillsDir).toTickets };
}

/** A map-scope To Spec run through the Claude Code CLI at `config.claudePath`. */
export function claudeCodeDraftSpecs(config: SpecRunConfig): DraftSpecs {
  return draftSpecsWith(config, toSpec(config.skillsDir));
}

/** A spec repair (spec-scope To Spec) through the Claude Code CLI; it follows the To Spec skill too. */
export function claudeCodeReviseSpec(config: SpecRunConfig): ReviseSpec {
  return reviseSpecWith(config, toSpec(config.skillsDir));
}

/** A spec review through the Claude Code CLI. */
export function claudeCodeReviewSpec(config: SpecRunConfig): ReviewSpec {
  return reviewSpecWith(config, planningReview(config.skillsDir));
}

/** A To Tickets run through the Claude Code CLI. */
export function claudeCodeDraftTicketSet(config: SpecRunConfig): DraftTicketSet {
  return draftTicketSetWith(config, toTickets(config.skillsDir));
}

/** A tickets review through the Claude Code CLI; it follows the planning review skill. */
export function claudeCodeReviewTicketSet(config: SpecRunConfig): ReviewTicketSet {
  return reviewTicketSetWith(config, planningReview(config.skillsDir));
}
