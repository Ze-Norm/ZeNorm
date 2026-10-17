import { z } from "zod";

import { MODEL_LIMIT_STORED_CAPS, type ModelLimitField, ModelLimits } from "./model-limits.ts";
import { AbsolutePath } from "./project.ts";

const MAX_PORT = 65535;
export const AGENT_MAX_TURNS_LIMIT = 50;
export const AGENT_TIMEOUT_SECONDS_LIMIT = 240;

export const AgentEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type AgentEffort = z.infer<typeof AgentEffort>;

/**
 * A planning model key. A missing one names both keys, so a config that still has the old single
 * `agent.model` (refused as unknown) says what replaces it.
 */
const PlanningModel = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? "required: agent.wayfindingModel and agent.specModel (they replace agent.model)"
        : undefined,
  })
  .min(1);

const MODEL_LIMIT_FIELDS: readonly ModelLimitField[] = ModelLimits.keyof().options;

/**
 * Claude Code's fast mode (`--settings '{"fastMode": true}'`): a faster API configuration of the
 * same Opus model, not a model of its own. The one optional config key:
 * absent is off, so configs written before it still load.
 */
const FastMode = z.boolean().optional();

/** Whether Claude Code runs `model` in fast mode: only its Opus models support it. */
export function supportsFastMode(model: string): boolean {
  return model === "opus" || model.startsWith("claude-opus-");
}

/** An issue on `fastMode` for each of `models` that has no fast mode. */
function refineFastMode(
  section: "agent" | "delivery",
  models: readonly string[],
  context: z.RefinementCtx,
): void {
  for (const model of new Set(models)) {
    if (!supportsFastMode(model)) {
      context.addIssue({
        code: "custom",
        path: ["fastMode"],
        message: `${section}.fastMode needs an Opus model; ${model} has no fast mode`,
      });
    }
  }
}

/**
 * How the planning agent runs the Claude Code CLI. Strict, every key but `fastMode` required, nothing defaulted.
 * `wayfindingModel` serves the chart, grill, research, task, consistency and escape hatch runs;
 * `specModel` the spec and ticket set drafts, revisions and reviews. `models` holds each model's
 * drafting lengths, keyed by model id: both planning models need an entry, other entries are
 * allowed. Each length's `aim` is at most its `max`, and its `max` at most the field's stored cap.
 */
export const AgentConfig = z
  .strictObject({
    /** The `claude` binary; never looked up on `PATH`. */
    claudePath: AbsolutePath,
    wayfindingModel: PlanningModel,
    specModel: PlanningModel,
    models: z.record(z.string().min(1), ModelLimits),
    effort: AgentEffort,
    maxTurns: z.int().min(1).max(AGENT_MAX_TURNS_LIMIT),
    timeoutSeconds: z.int().min(1).max(AGENT_TIMEOUT_SECONDS_LIMIT),
    /** Fast mode for every planning run; both planning models must be Opus. */
    fastMode: FastMode,
  })
  .superRefine((agent, context) => {
    if (agent.fastMode === true) {
      refineFastMode("agent", [agent.wayfindingModel, agent.specModel], context);
    }
    const missing = new Set<string>();
    for (const key of ["wayfindingModel", "specModel"] as const) {
      const model = agent[key];
      if (!Object.hasOwn(agent.models, model) && !missing.has(model)) {
        missing.add(model);
        context.addIssue({
          code: "custom",
          path: ["models", model],
          message: `required: an agent.models entry for ${model} (agent.${key})`,
        });
      }
    }
    for (const [model, limits] of Object.entries(agent.models)) {
      for (const field of MODEL_LIMIT_FIELDS) {
        const { aim, max } = limits[field];
        const cap = MODEL_LIMIT_STORED_CAPS[field];
        if (aim > max) {
          context.addIssue({
            code: "custom",
            path: ["models", model, field, "aim"],
            message: `agent.models.${model}.${field}.aim (${String(aim)}) is above its max (${String(max)})`,
          });
        }
        if (max > cap) {
          context.addIssue({
            code: "custom",
            path: ["models", model, field, "max"],
            message: `agent.models.${model}.${field}.max (${String(max)}) is above the stored cap (${String(cap)})`,
          });
        }
      }
    }
  });
export type AgentConfig = z.infer<typeof AgentConfig>;

/**
 * What one planning run needs: `AgentConfig` with the model its run type uses and its limits, and
 * the folder its session records go in (`<dataDir>/sessions`; composed by the app, not a config
 * key).
 */
export type PlanningRunConfig = Omit<AgentConfig, "wayfindingModel" | "specModel" | "models"> & {
  readonly model: string;
  readonly limits: ModelLimits;
  readonly sessionsDir: string;
};

export const DELIVERY_ORCHESTRATOR_MAX_TURNS_LIMIT = 1000;
export const DELIVERY_ORCHESTRATOR_TIMEOUT_MINUTES_LIMIT = 480;
export const DELIVERY_REVIEWER_MAX_TURNS_LIMIT = 200;
export const DELIVERY_REVIEWER_TIMEOUT_MINUTES_LIMIT = 120;
export const DELIVERY_CHECK_TIMEOUT_MINUTES_LIMIT = 120;

/** How delivery runs its sessions and checks. Strict, every key but `fastMode` required, nothing defaulted. */
export const DeliveryConfig = z
  .strictObject({
    model: z.string().min(1),
    effort: AgentEffort,
    /** Fast mode for the orchestrator, reviewer and pull request writer; `model` must be Opus. */
    fastMode: FastMode,
    orchestratorMaxTurns: z.int().min(1).max(DELIVERY_ORCHESTRATOR_MAX_TURNS_LIMIT),
    /** One deadline for the orchestrator session, its auth step included. */
    orchestratorTimeoutMinutes: z.int().min(1).max(DELIVERY_ORCHESTRATOR_TIMEOUT_MINUTES_LIMIT),
    reviewerMaxTurns: z.int().min(1).max(DELIVERY_REVIEWER_MAX_TURNS_LIMIT),
    /** One deadline for the reviewer session, its auth step included. */
    reviewerTimeoutMinutes: z.int().min(1).max(DELIVERY_REVIEWER_TIMEOUT_MINUTES_LIMIT),
    /** Each check's bound. */
    checkTimeoutMinutes: z.int().min(1).max(DELIVERY_CHECK_TIMEOUT_MINUTES_LIMIT),
    /**
     * The name of the delivery executor every run uses: `"local"` (the Claude Code pair the app
     * registers) or one a plugin registers. Required, no default; a name nothing registers is
     * `executor_unknown` at startup.
     */
    executor: z.string().min(1),
  })
  .superRefine((delivery, context) => {
    if (delivery.fastMode === true) refineFastMode("delivery", [delivery.model], context);
  });
export type DeliveryConfig = z.infer<typeof DeliveryConfig>;

/**
 * What the delivery sessions need: `apps/zenorm` composes it from `agent.claudePath`, `delivery`
 * and the session records' folder (`<dataDir>/sessions`). The Claude Code pair never sees
 * `delivery.executor`, which only selects it.
 */
export type DeliveryAgentConfig = {
  readonly claudePath: z.infer<typeof AbsolutePath>;
  readonly sessionsDir: string;
} & Omit<DeliveryConfig, "executor">;

/** The instance config file. Strict: unknown keys are rejected, every key but `fastMode` is required, nothing is defaulted. */
export const InstanceConfig = z.strictObject({
  server: z.strictObject({
    host: z.string().min(1),
    port: z.int().min(1).max(MAX_PORT),
  }),
  /** An existing directory; the database is `<dataDir>/zenorm.sqlite` and runs live in `<dataDir>/runs`. */
  dataDir: AbsolutePath,
  agent: AgentConfig,
  delivery: DeliveryConfig,
  /**
   * One section per plugin, keyed by its id; `{}` with no plugins. Each section is parsed by its
   * plugin's own schema at startup, never here.
   */
  plugins: z.record(z.string(), z.unknown()),
});
export type InstanceConfig = z.infer<typeof InstanceConfig>;
