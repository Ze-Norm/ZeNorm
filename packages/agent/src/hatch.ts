import {
  hatchOutcome,
  type ModelLimits,
  type PlanningRunConfig,
  type ReplyThroughHatch,
} from "@zenorm/contracts";

import { READ_ONLY_TOOLS, runStructured, structuredOutput } from "./claude.ts";
import { buildHatchPrompt } from "./hatch-prompt.ts";

/** The `--json-schema` of a hatch reply; root properties `reply, change` (`reply` is the stand-in key, L107). */
export function hatchJsonSchema(limits: ModelLimits): string {
  return structuredOutput(hatchOutcome(limits)).jsonSchema;
}

/**
 * The planning agent's reply to one message through the escape hatch (spec D2) through the Claude
 * Code CLI at `config.claudePath`: it may read the project folder, like grilling, and change nothing.
 */
export function claudeCodeReplyThroughHatch(config: PlanningRunConfig): ReplyThroughHatch {
  const output = structuredOutput(hatchOutcome(config.limits));
  return (request, session) =>
    runStructured(
      config,
      session,
      request.projectFolder,
      buildHatchPrompt(request, config.limits),
      output,
      READ_ONLY_TOOLS,
    );
}
