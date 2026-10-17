import type {
  AgentConfig,
  ChartMap,
  CheckConsistency,
  DraftSpecs,
  DraftTicketSet,
  GrillWaypoint,
  ModelLimits,
  PlanningRunConfig,
  ReplyThroughHatch,
  ResearchWaypoint,
  ReviewSpec,
  ReviewTicketSet,
  ReviseSpec,
  SettleFog,
  SurveyCode,
  WorkTask,
} from "@zenorm/contracts";

import { claudeCodeReplyThroughHatch } from "./hatch.ts";
import {
  claudeCodeDraftSpecs,
  claudeCodeDraftTicketSet,
  claudeCodeReviewSpec,
  claudeCodeReviewTicketSet,
  claudeCodeReviseSpec,
  type SpecRunConfig,
} from "./specs.ts";
import { claudeCodeSettleFog } from "./fog.ts";
import { claudeCodeSurveyCode } from "./survey.ts";
import { claudeCodeChartMap, claudeCodeGrillWaypoint } from "./wayfinding.ts";
import {
  claudeCodeCheckConsistency,
  claudeCodeResearchWaypoint,
  claudeCodeWorkTask,
} from "./waypoint-runs.ts";

/** Every planning port, keyed as `createApp` takes them. */
export interface PlanningAgent {
  readonly chartMap: ChartMap;
  readonly surveyCode: SurveyCode;
  readonly settleFog: SettleFog;
  readonly grillWaypoint: GrillWaypoint;
  readonly researchWaypoint: ResearchWaypoint;
  readonly workTask: WorkTask;
  readonly checkConsistency: CheckConsistency;
  readonly replyThroughHatch: ReplyThroughHatch;
  readonly draftSpecs: DraftSpecs;
  readonly reviseSpec: ReviseSpec;
  readonly reviewSpec: ReviewSpec;
  readonly draftTicketSet: DraftTicketSet;
  readonly reviewTicketSet: ReviewTicketSet;
}

/**
 * A planning model's limits. `AgentConfig` refuses a config whose planning model has no
 * `agent.models` entry, so a missing one is a programmer error.
 */
function limitsOf(models: AgentConfig["models"], model: string): ModelLimits {
  const limits = models[model];
  if (limits === undefined) {
    throw new Error(`agent.models has no entry for the planning model ${model}`);
  }
  return limits;
}

/**
 * The planning agent through the Claude Code CLI: wayfinding runs (chart, survey, grill, research,
 * task, fog, consistency, the escape hatch) use `agent.wayfindingModel`, spec runs (spec and ticket
 * set drafts, revisions and reviews) `agent.specModel`; everything else, `sessionsDir` included, is
 * shared. Spec runs follow the product skills in `skillsDir`, which the entry passes in.
 */
export function claudeCodePlanningAgent(
  config: AgentConfig & { readonly sessionsDir: string; readonly skillsDir: string },
): PlanningAgent {
  const { wayfindingModel, specModel, models, skillsDir, ...shared } = config;
  const wayfinding: PlanningRunConfig = {
    ...shared,
    model: wayfindingModel,
    limits: limitsOf(models, wayfindingModel),
  };
  const spec: SpecRunConfig = {
    ...shared,
    model: specModel,
    limits: limitsOf(models, specModel),
    skillsDir,
  };
  return {
    chartMap: claudeCodeChartMap(wayfinding),
    surveyCode: claudeCodeSurveyCode(wayfinding),
    settleFog: claudeCodeSettleFog(wayfinding),
    grillWaypoint: claudeCodeGrillWaypoint(wayfinding),
    researchWaypoint: claudeCodeResearchWaypoint(wayfinding),
    workTask: claudeCodeWorkTask(wayfinding),
    checkConsistency: claudeCodeCheckConsistency(wayfinding),
    replyThroughHatch: claudeCodeReplyThroughHatch(wayfinding),
    draftSpecs: claudeCodeDraftSpecs(spec),
    reviseSpec: claudeCodeReviseSpec(spec),
    reviewSpec: claudeCodeReviewSpec(spec),
    draftTicketSet: claudeCodeDraftTicketSet(spec),
    reviewTicketSet: claudeCodeReviewTicketSet(spec),
  };
}
