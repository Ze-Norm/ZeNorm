import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { err, ok, type Result, type SkillMissingError } from "@zenorm/contracts";

/**
 * The repository's skills folder, `<repository>/skills/`, found from this module. Only the entries
 * that run from source (`apps/zenorm`, `apps/zenorm-example`) and tests pass it in; the adapters
 * take the folder they are given, so the built CLI passes its packaged copy.
 */
export const SKILLS_DIR = fileURLToPath(new URL("../../../skills/", import.meta.url));

/** The SKILL.md files a delivery session is told to read, by absolute path. */
export interface DeliverySkills {
  /** The orchestrator follows it. */
  readonly implementSpec: string;
  /** The orchestrator's review step and the reviewer follow it. */
  readonly codeReview: string;
  /** The pull request writer follows it: the vendored PR skill. */
  readonly pullRequest: string;
}

/** The delivery skills inside `skillsDir`. */
export function deliverySkills(skillsDir: string): DeliverySkills {
  return {
    implementSpec: join(skillsDir, "implement-spec", "SKILL.md"),
    codeReview: join(skillsDir, "code-review", "SKILL.md"),
    pullRequest: join(skillsDir, "pr", "SKILL.md"),
  };
}

export type { SkillMissingError } from "@zenorm/contracts";

/** The product skills the planning agent's spec and ticket runs follow, by absolute path. */
export interface PlanningSkills {
  /** DraftSpecs and ReviseSpec follow it. */
  readonly toSpec: string;
  /** ReviewSpec and ReviewTicketSet follow it. */
  readonly planningReview: string;
  /** DraftTicketSet follows it. */
  readonly toTickets: string;
}

/** The planning skills inside `skillsDir`. */
export function planningSkills(skillsDir: string): PlanningSkills {
  return {
    toSpec: join(skillsDir, "product-to-spec", "SKILL.md"),
    planningReview: join(skillsDir, "product-planning-review", "SKILL.md"),
    toTickets: join(skillsDir, "product-to-tickets", "SKILL.md"),
  };
}

/** Refuses with `agent_skill_missing` when the SKILL.md at `skillPath` does not exist. */
export function checkSkill(skillPath: string): Result<null, SkillMissingError> {
  if (existsSync(skillPath)) return ok(null);
  return err({
    code: "agent_skill_missing",
    message: `The skill file ${skillPath} does not exist, so no session can follow it.`,
    data: { skillPath },
  });
}

/**
 * Checks the orchestrator's and the reviewer's skills, the orchestrator's first. The pull request
 * writer checks its own when a run reaches it, so a missing PR skill fails only a run that opens a
 * pull request.
 */
export function checkDeliverySkills(skills: DeliverySkills): Result<null, SkillMissingError> {
  const implementSpec = checkSkill(skills.implementSpec);
  if (!implementSpec.ok) return implementSpec;
  return checkSkill(skills.codeReview);
}
