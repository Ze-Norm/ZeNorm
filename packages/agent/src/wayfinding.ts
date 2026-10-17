import {
  type PlanningRunConfig,
  chartConfirmation,
  chartFollowUp,
  type ChartMap,
  chartProposal,
  chartStep,
  grillOutcome,
  grillResolutionOutcome,
  grillRound,
  type GrillWaypoint,
  mapChanges,
  type ModelLimits,
  ok,
  outOfScopeRuling,
  questionRoundDraft,
  type WaypointResolution,
  waypointResolution,
} from "@zenorm/contracts";
import { z } from "zod";

import {
  READ_ONLY_TOOLS,
  runStructured,
  type StructuredOutput,
  structuredOutput,
} from "./claude.ts";
import { buildChartPrompt, buildGrillPrompt } from "./wayfinding-prompt.ts";

/**
 * A first chart's output as the model writes it: the round's `intro` and `questions` at the root,
 * so no closing brace of a nested round can be dropped; parsed into a `ChartProposal`.
 */
function chartProposalOutput(limits: ModelLimits) {
  const proposal = chartProposal(limits);
  return z
    .strictObject({
      ...proposal.omit({ round: true }).shape,
      ...questionRoundDraft(limits).shape,
    })
    .transform(({ intro, questions, ...reading }) => ({ ...reading, round: { intro, questions } }))
    .pipe(proposal);
}

/**
 * A grilling run's settling fields as the model writes them: the resolution's prose is `decision`
 * at the root (no `resolution.resolution`), next to its `gist`, its `agentDecided` calls and the
 * out-of-scope ruling.
 */
function settlingOutputFields(limits: ModelLimits) {
  const resolution = waypointResolution(limits);
  return {
    decision: resolution.shape.resolution.nullable(),
    gist: resolution.shape.gist.nullable(),
    agentDecided: resolution.shape.agentDecided.nullable(),
    outOfScope: outOfScopeRuling(limits).nullable(),
  };
}

/**
 * `decision`, `gist` and `agentDecided` as the outcome's resolution, null when all three are; any
 * set without the others is an issue.
 */
function resolutionOf(
  output: {
    readonly decision: string | null;
    readonly gist: string | null;
    readonly agentDecided: string[] | null;
  },
  context: z.RefinementCtx,
): WaypointResolution | null {
  const { decision, gist, agentDecided } = output;
  if (decision !== null && gist !== null && agentDecided !== null) {
    return { resolution: decision, gist, agentDecided };
  }
  if (decision !== null || gist !== null || agentDecided !== null) {
    context.addIssue({ code: "custom", message: "Set decision, gist and agentDecided together." });
  }
  return null;
}

/** Adds an issue when the alternative `kind` names is null. */
function requireKind(kind: string, alternative: unknown, context: z.RefinementCtx): void {
  if (alternative === null) {
    context.addIssue({ code: "custom", message: `kind is ${kind}, so set its fields.` });
  }
}

/**
 * A grilling run's output as the model writes it: `kind` names the outcome, the round's fields sit
 * at the root, and the resolution is `decision`, `gist` and `agentDecided`; parsed into a `GrillOutcome`, whose
 * refinements still hold.
 */
function grillOutput(limits: ModelLimits) {
  const round = grillRound(limits);
  return z
    .strictObject({
      kind: z.enum(["round", "resolution", "outOfScope"]),
      intro: round.shape.intro.nullable(),
      final: round.shape.final.nullable(),
      questions: round.shape.questions.nullable(),
      ...settlingOutputFields(limits),
      mapChanges: mapChanges(limits).nullable(),
    })
    .transform((output, context) => {
      const { intro, final, questions } = output;
      const round =
        intro !== null && final !== null && questions !== null ? { intro, final, questions } : null;
      if (round === null && (intro !== null || final !== null || questions !== null)) {
        context.addIssue({ code: "custom", message: "Set intro, final and questions together." });
      }
      const resolution = resolutionOf(output, context);
      requireKind(
        output.kind,
        { round, resolution, outOfScope: output.outOfScope }[output.kind],
        context,
      );
      return { round, resolution, outOfScope: output.outOfScope, mapChanges: output.mapChanges };
    })
    .pipe(grillOutcome(limits));
}

/** A grilling run's output after a `final` round as the model writes it: `grillOutput` with no round. */
function grillResolutionOutput(limits: ModelLimits) {
  return z
    .strictObject({
      kind: z.enum(["resolution", "outOfScope"]),
      ...settlingOutputFields(limits),
      mapChanges: mapChanges(limits),
    })
    .transform((output, context) => {
      const resolution = resolutionOf(output, context);
      requireKind(output.kind, { resolution, outOfScope: output.outOfScope }[output.kind], context);
      return { resolution, outOfScope: output.outOfScope, mapChanges: output.mapChanges };
    })
    .pipe(grillResolutionOutcome(limits));
}

/** The `--json-schema` of a `propose` chart; root properties `title, summary, destination, split, intro, questions`. */
export function chartProposalJsonSchema(limits: ModelLimits): string {
  return structuredOutput(chartProposalOutput(limits)).jsonSchema;
}

/** The `--json-schema` of a `confirm` chart; root properties `title, summary, destination, waypoints, fog, outOfScope, proposals`. */
export function chartConfirmationJsonSchema(limits: ModelLimits): string {
  return structuredOutput(chartConfirmation(limits)).jsonSchema;
}

/** `fields` as the names of those set (`set`) or null (not `set`) that are not. */
function misset(fields: Readonly<Record<string, unknown>>, set: boolean): string[] {
  return Object.entries(fields)
    .filter(([, value]) => (value !== null) !== set)
    .map(([name]) => name);
}

/**
 * A `choose` chart's output as the model writes it (DR-5, L253): flat, `kind` naming a confirmation
 * or a follow-up, `title`, `summary` and `destination` always set; the other kind's fields null. Parsed into a `ChartOutcome`
 * whose confirmation or follow-up is checked in full, so a follow-up of 0 or 4 questions fails.
 */
function chartChoiceOutput(limits: ModelLimits) {
  const confirmation = chartConfirmation(limits);
  const followUp = chartFollowUp(limits);
  const round = followUp.shape.round.shape;
  return z
    .strictObject({
      kind: z.enum(["confirmation", "followUp"]),
      title: followUp.shape.title,
      summary: followUp.shape.summary,
      destination: followUp.shape.destination,
      intro: round.intro.nullable(),
      final: round.final.nullable(),
      questions: round.questions.nullable(),
      waypoints: confirmation.shape.waypoints.nullable(),
      fog: confirmation.shape.fog.nullable(),
      outOfScope: confirmation.shape.outOfScope.nullable(),
      proposals: confirmation.shape.proposals.nullable(),
    })
    .transform((output, context) => {
      const { kind, title, summary, destination, intro, final, questions } = output;
      const { waypoints, fog, outOfScope, proposals } = output;
      const followUpFields = { intro, final, questions };
      const confirmationFields = { waypoints, fog, outOfScope, proposals };
      const confirming = kind === "confirmation";
      const wrong = [
        ...misset(confirmationFields, confirming),
        ...misset(followUpFields, !confirming),
      ];
      if (wrong.length > 0) {
        context.addIssue({
          code: "custom",
          message: `kind is ${kind}: set its fields and null the other kind's (${wrong.join(", ")}).`,
        });
        return z.NEVER;
      }
      return confirming
        ? { kind, confirmation: { title, summary, destination, ...confirmationFields } }
        : {
            kind,
            followUp: { title, summary, destination, round: { intro, final, questions } },
          };
    })
    .pipe(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("confirmation"), confirmation }),
        z.strictObject({ kind: z.literal("followUp"), followUp }),
      ]),
    );
}

/** The `--json-schema` of a `choose` chart; root properties `kind, title, summary, destination, intro, final, questions, waypoints, fog, outOfScope, proposals`. */
export function chartChoiceJsonSchema(limits: ModelLimits): string {
  return structuredOutput(chartChoiceOutput(limits)).jsonSchema;
}

/** The `--json-schema` of a grilling run; root properties `kind, intro, final, questions, decision, gist, agentDecided, outOfScope, mapChanges`. */
export function grillJsonSchema(limits: ModelLimits): string {
  return structuredOutput(grillOutput(limits)).jsonSchema;
}

/** The `--json-schema` of a grilling run after a `final` round; root properties `kind, decision, gist, agentDecided, outOfScope, mapChanges` (no round). */
export function grillResolutionJsonSchema(limits: ModelLimits): string {
  return structuredOutput(grillResolutionOutput(limits)).jsonSchema;
}

/**
 * The planning agent's chart (spec D2) through the Claude Code CLI at `config.claudePath`, with one
 * schema per step (`chartStep`, DR-4): a proposal at `propose`, a confirmation or a follow-up at
 * `choose`, a confirmation at `confirm`. Its structured outputs are built once, from
 * `config.limits`.
 */
export function claudeCodeChartMap(config: PlanningRunConfig): ChartMap {
  const proposalOutput = structuredOutput(chartProposalOutput(config.limits));
  const choiceOutput = structuredOutput(chartChoiceOutput(config.limits));
  const confirmationOutput = structuredOutput(chartConfirmation(config.limits));
  return async (request, session) => {
    const prompt = buildChartPrompt(request, config.limits);
    const run = <S extends z.ZodType>(output: StructuredOutput<S>) =>
      runStructured(config, session, request.projectFolder, prompt, output, READ_ONLY_TOOLS);
    switch (chartStep(request.mapRounds)) {
      case "propose": {
        const result = await run(proposalOutput);
        if (!result.ok) return result;
        return ok({ kind: "proposal", proposal: result.value });
      }
      case "choose":
        return run(choiceOutput);
      case "confirm": {
        const result = await run(confirmationOutput);
        if (!result.ok) return result;
        return ok({ kind: "confirmation", confirmation: result.value });
      }
    }
  };
}

/**
 * The planning agent's grilling of one waypoint (spec D2) through the Claude Code CLI at
 * `config.claudePath`. After a `final` round the call answers through the schema with no round, so
 * it can only resolve (S6a-10). Its structured outputs are built once, from `config.limits`.
 */
export function claudeCodeGrillWaypoint(config: PlanningRunConfig): GrillWaypoint {
  const output = structuredOutput(grillOutput(config.limits));
  const resolutionOutput = structuredOutput(grillResolutionOutput(config.limits));
  return async (request, session) => {
    const prompt = buildGrillPrompt(request, config.limits);
    if (request.afterFinal) {
      const result = await runStructured(
        config,
        session,
        request.projectFolder,
        prompt,
        resolutionOutput,
        READ_ONLY_TOOLS,
      );
      if (!result.ok) return result;
      return ok({ round: null, ...result.value });
    }
    return runStructured(config, session, request.projectFolder, prompt, output, READ_ONLY_TOOLS);
  };
}
