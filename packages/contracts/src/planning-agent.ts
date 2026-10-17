import { z } from "zod";

import type { DeliveryAgentError, PlanningAgentError } from "./codes.ts";
import { CodeSurvey, type CodeSurveyDraft } from "./code-survey.ts";
import { HATCH_MESSAGE_MAX_LENGTH, HatchMessageText, HatchReply, HatchStage } from "./hatch.ts";
import {
  Answers,
  draftQuestion,
  draftRoundIntro,
  draftRoundQuestions,
  EntityId,
  MAP_IDEA_MAX_LENGTH,
  MapDestination,
  MapIdea,
  MapSummary,
  MapTitle,
  Question,
  questionRoundDraft,
  RoundQuestions,
} from "./map.ts";
import { SpecRevisionState, Stage } from "./overview.ts";
import { MapProposalState } from "./wayfinding.ts";
import { CriterionReading, SpecHold, TextDelta } from "./revisions.ts";
import { RejectionReason } from "./planning.ts";
import { AbsolutePath, BaseBranch, ProjectName } from "./project.ts";
import type { Result } from "./result.ts";
import { type ModelLimits, STORED_LIMITS } from "./model-limits.ts";
import {
  Clause,
  ClauseId,
  ClauseReliance,
  Criterion,
  CriterionId,
  SpecReviewFinding,
  SpecElementId,
  SpecReviewSummary,
  SpecRevisionContent,
  SpecRemovals,
  specRemovalsSchema,
  specRevisionDraft,
  TICKETS_REVIEW_FINDINGS_MAX_COUNT,
  type SpecReviewOutcome,
  TicketId,
  TicketSetContent,
  TicketSetState,
  TicketsReviewFinding,
  ticketsReviewFindingDraft,
} from "./spec-content.ts";
import {
  ConsistencyFindingKind,
  FogItem,
  MapLine,
  RESEARCH_SUMMARY_MAX_LENGTH,
  ResearchFinding,
  researchFindingSchema,
  ResearchSource,
  researchSourceSchema,
  TaskOutcomeKind,
  WaitingReason,
  WAYPOINT_AGENT_DECIDED_MAX_COUNT,
  WAYPOINT_QUESTION_MAX_LENGTH,
  WaypointAgentDecided,
  WaypointGist,
  WaypointKind,
  WaypointQuestion,
  WaypointResolutionText,
  WaypointStatus,
  WaypointTitle,
} from "./wayfinding.ts";

/**
 * What one planning call's Claude Code CLI `result` reported: its session, how it ended and what it
 * cost. Every field is the CLI's own; a result object without one of them is no result.
 */
export const PlanningRunUsage = z.strictObject({
  /** The CLI's `session_id`: a retry after `error_max_turns` resumes it. */
  sessionId: z.string().min(1),
  /** The result's `subtype`: `success`, `error_max_turns`, ... */
  resultSubtype: z.string().min(1),
  numTurns: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative(),
});
export type PlanningRunUsage = z.infer<typeof PlanningRunUsage>;

/** Per planning run, what every planning port is given beside its request. */
export interface PlanningCallSession {
  /**
   * The CLI session to resume (`--resume`) with the agent's resume prompt instead of the request's prompt:
   * set only on the retry of a run that ended `error_max_turns`; null starts the session cold.
   */
  readonly resumeSessionId: string | null;
  /** Called once with the CLI result's usage, before the port returns, when the CLI printed one. */
  readonly onUsage: (usage: PlanningRunUsage) => void;
  /**
   * Aborted only by the planning runner's stop: the port then stops its CLI and returns
   * `agent_cancelled`.
   */
  readonly signal: AbortSignal;
}

/** The most new waypoints one waypoint run may chart through its map changes. */
export const MAP_CHANGES_NEW_WAYPOINTS_MAX_COUNT = 6;
/** The most fog items one waypoint run may add. */
export const MAP_CHANGES_NEW_FOG_MAX_COUNT = 4;
/** The most findings one consistency pass may return. */
export const CONSISTENCY_FINDINGS_MAX_COUNT = 3;
/** A waypoint's title as a run writes it, within its model's limits (`agent.models`). */
function draftWaypointTitle(limits: ModelLimits) {
  return z.string().min(1).max(limits.waypointTitle.max);
}

/** A waypoint's question as a run writes it, within its model's limits (`agent.models`). */
function draftWaypointQuestion(limits: ModelLimits) {
  return z.string().min(1).max(limits.waypointQuestion.max);
}

/** A gist as a run writes it, within its model's limits (`agent.models`). */
function draftGist(limits: ModelLimits) {
  return z.string().min(1).max(limits.gist.max);
}

/**
 * The calls a resolving run made itself without asking the person, as it writes them: 0 to 3 short
 * lines, each within its model's limits (`agent.models`); empty when the person decided everything.
 */
function draftAgentDecided(limits: ModelLimits) {
  return z
    .array(z.string().min(1).max(limits.agentDecided.max))
    .max(WAYPOINT_AGENT_DECIDED_MAX_COUNT);
}

/** A fog item, Out of scope line or out-of-scope reason as a run writes it (`agent.models`). */
function draftMapLine(limits: ModelLimits) {
  return z.string().min(1).max(limits.mapLine.max);
}

/** One new waypoint a run charts: numbered on from the map's highest by core. */
export function newWaypoint(limits: ModelLimits) {
  return z.strictObject({
    kind: WaypointKind,
    title: draftWaypointTitle(limits),
    question: draftWaypointQuestion(limits),
    /** Numbers of existing waypoints that block this one; core refuses an unknown one. */
    blockedBy: z.array(z.int().min(1)),
    /** The fog item this question graduates from (deleted with it), or null. */
    fromFog: z.int().min(1).nullable(),
  });
}
export const NewWaypoint = newWaypoint(STORED_LIMITS);
export type NewWaypoint = z.infer<typeof NewWaypoint>;

/**
 * A waypoint's resolution: the settled decision in prose, its one-line gist for the map, and the
 * calls in it the agent made without asking the person (`agentDecided`, empty when the person
 * decided everything). The prose is within the run's model's limits (`agent.models`), at most the
 * stored `WaypointResolutionText`; longer output is refused.
 */
export function waypointResolution(limits: ModelLimits) {
  return z.strictObject({
    resolution: z.string().min(1).max(limits.resolution.max),
    gist: draftGist(limits),
    agentDecided: draftAgentDecided(limits),
  });
}
export type WaypointResolution = z.infer<ReturnType<typeof waypointResolution>>;

/**
 * A fog item the agent settles itself because no answer to it needs the person (implementation
 * mechanics): core deletes the item and saves it as a waypoint resolved by the run, its question the
 * item's text, so To Spec, the consistency pass and Decisions so far read the decision, and the
 * person can reopen it. The whole decision is the agent's, which the waypoint page says, so it
 * carries no `agentDecided`: core saves it empty.
 */
export function decidedFog(limits: ModelLimits) {
  const { resolution, gist } = waypointResolution(limits).shape;
  return z.strictObject({
    position: z.int().min(1),
    title: draftWaypointTitle(limits),
    resolution,
    gist,
  });
}
export type DecidedFog = z.infer<ReturnType<typeof decidedFog>>;

/** What a waypoint run that asks no round changes on its map. */
export function mapChanges(limits: ModelLimits) {
  return z.strictObject({
    newWaypoints: z.array(newWaypoint(limits)).max(MAP_CHANGES_NEW_WAYPOINTS_MAX_COUNT),
    /** Fog items moved out of scope: each is deleted and its line saved with no waypoint. */
    fogOutOfScope: z.array(
      z.strictObject({ position: z.int().min(1), line: draftMapLine(limits) }),
    ),
    /** Fog items the agent decided itself, each saved as a resolved waypoint. */
    fogDecided: z.array(decidedFog(limits)),
    /**
     * Fog items, by position, that the run's own resolution (a grilling resolution, an answered
     * report's summary, a done task's facts) settles: each is deleted with no new waypoint, the
     * decision living in that resolution. Core refuses it on an outcome that resolves nothing.
     */
    fogSettledHere: z.array(z.int().min(1)),
    newFog: z.array(draftMapLine(limits)).max(MAP_CHANGES_NEW_FOG_MAX_COUNT),
  });
}
export type MapChanges = z.infer<ReturnType<typeof mapChanges>>;

/** The most proposals of new maps one chart, fog run or consistency pass may make. */
export const MAP_PROPOSALS_MAX_COUNT = 4;

/**
 * A proposal's draft idea as a run writes it: a `MapIdea`, 1 to 4000 characters once trimmed; core
 * stores it trimmed. Its bound is the stored idea's, not a model's drafting length, so it is a
 * refinement: the `--json-schema` bounds model-drafted lengths only, and the prompt states it.
 */
function draftIdea() {
  return z
    .string()
    .min(1)
    .refine((idea) => MapIdea.safeParse(idea).success, {
      message: `The idea is blank or longer than ${String(MAP_IDEA_MAX_LENGTH)} characters.`,
    });
}

/** A proposed map's short name, as Wayfinding heads its card, within its model's limits. */
function draftProposalTitle(limits: ModelLimits) {
  return z.string().min(1).max(limits.mapTitle.max);
}

/**
 * A run's proposal of a new map (map proposals): a short title, the draft idea for salient work
 * outside the destination that is worth doing on its own and that no earlier suggestion or map of
 * the project covers (the prompts' rule; core does not check it), and its own Out of scope line,
 * which core saves when the person decides the proposal.
 */
export function proposedMap(limits: ModelLimits) {
  return z.strictObject({
    title: draftProposalTitle(limits),
    idea: draftIdea(),
    line: draftMapLine(limits),
  });
}
export type ProposedMap = z.infer<ReturnType<typeof proposedMap>>;

/** A run's proposals of new maps: required, an empty list when it proposes none. */
function mapProposals(limits: ModelLimits) {
  return z.array(proposedMap(limits)).max(MAP_PROPOSALS_MAX_COUNT);
}

/**
 * A run's ruling that its own waypoint is out of scope; the reason becomes its Out of scope line.
 * The run may attach a proposal of a new map for the ruled-out work: a title and a draft idea only,
 * since the reason is its line.
 */
export function outOfScopeRuling(limits: ModelLimits) {
  return z.strictObject({
    reason: draftMapLine(limits),
    proposal: z.strictObject({ title: draftProposalTitle(limits), idea: draftIdea() }).optional(),
  });
}
export const OutOfScopeRuling = outOfScopeRuling(STORED_LIMITS);
export type OutOfScopeRuling = z.infer<typeof OutOfScopeRuling>;

/**
 * One other waypoint of the map as a waypoint run reads it; `gist`, `agentDecided` and `resolution`
 * are null until resolved. The resolution lets a run keep its premises and options consistent with what the map's
 * research and decisions found.
 */
const MapWaypointContext = z.strictObject({
  number: z.int().min(1),
  kind: WaypointKind,
  title: WaypointTitle,
  status: WaypointStatus,
  gist: WaypointGist.nullable(),
  agentDecided: WaypointAgentDecided.nullable(),
  resolution: WaypointResolutionText.nullable(),
});

/** One spec revision as a run reads it: the spec's number, the revision's number and its document. */
export const SpecRevisionRef = z.strictObject({
  specNumber: z.int().min(1),
  revision: z.int().min(1),
  content: SpecRevisionContent,
});
export type SpecRevisionRef = z.infer<typeof SpecRevisionRef>;

/**
 * A spec a waypoint touches as a run reads it: the touched revision and each named criterion with
 * its text there and its baseline, the delivered ticket, run and commit that last built it, or
 * null, so research reads the delivered code; and the touched revision's text, since specs live in
 * ZeNorm, not the repository.
 */
export const RunTouch = z.strictObject({
  specNumber: z.int().min(1),
  specTitle: SpecRevisionContent.shape.title,
  revision: z.int().min(1),
  content: SpecRevisionContent,
  criteria: z
    .array(
      z.strictObject({
        id: CriterionId,
        text: z.string().min(1),
        baseline: z
          .strictObject({ ticket: TicketId, run: z.int().min(1), commit: z.string().min(1) })
          .nullable(),
      }),
    )
    .min(1),
});
export type RunTouch = z.infer<typeof RunTouch>;

/**
 * Another spec of the project as a planning run reads it: its latest revision, whether it was
 * delivered (a merged run), and what holds it against this map, null when unheld.
 */
/**
 * The clause and criterion ids an earlier revision of a spec used and its latest revision drops:
 * retired, so the next revision may not use them again; ascending by clause, then criterion.
 */
export const RetiredIds = z.array(SpecElementId);
export type RetiredIds = z.infer<typeof RetiredIds>;

export const ProjectSpecContext = z.strictObject({
  latest: SpecRevisionRef,
  /** Its retired ids: a revision a run writes of it avoids them. */
  retiredIds: RetiredIds,
  /**
   * Its latest approved revision, the one a touch names: `latest` when that is approved, an earlier
   * one while another map's draft is latest; null when none is approved.
   */
  approved: SpecRevisionRef.nullable(),
  delivered: z.boolean(),
  hold: SpecHold.nullable(),
  /** The map that wrote its latest revision, whose Spec page shows it: a run links the spec there. */
  writerMapId: EntityId,
});
export type ProjectSpecContext = z.infer<typeof ProjectSpecContext>;

const ResolvedWaypointFields = {
  number: z.int().min(1),
  title: WaypointTitle,
  question: WaypointQuestion,
  resolution: WaypointResolutionText,
  gist: WaypointGist,
  /** The calls in its resolution the agent made without asking the person; empty when none. */
  agentDecided: WaypointAgentDecided,
  /** The specs it touches, by spec number. */
  touches: z.array(RunTouch),
};

/** The facts behind a research waypoint's resolution: its report's findings and sources' titles and URLs. */
const ResearchBasis = z.strictObject({
  findings: z.array(ResearchFinding.pick({ title: true, detail: true })),
  sources: z.array(
    z.strictObject({ title: ResearchSource.shape.title, url: ResearchSource.shape.url }),
  ),
});

/**
 * One resolved waypoint as a spec run reads it; a research one carries the facts of the report its
 * resolution summarises.
 */
const ResolvedWaypoint = z.discriminatedUnion("kind", [
  z.strictObject({
    ...ResolvedWaypointFields,
    kind: z.literal("research"),
    research: ResearchBasis,
  }),
  z.strictObject({
    ...ResolvedWaypointFields,
    kind: WaypointKind.exclude(["research"]),
  }),
]);

/** The most waypoints one chart may save: later waypoints come from resolving runs. */
export const CHART_WAYPOINTS_MAX_COUNT = 12;
/** The most fog items, and the most Out of scope lines, one confirming chart may save. */
export const CHART_MAP_LINES_MAX_COUNT = 8;

/**
 * One map-level round so far: its questions, once submitted its answers (one per question), and
 * whether it was asked as the destination's final round.
 */
export const MapRound = z.strictObject({
  questions: RoundQuestions,
  /** Null while the round is pending. */
  answers: Answers.nullable(),
  final: z.boolean(),
});
export type MapRound = z.infer<typeof MapRound>;

/**
 * One map a first chart offered to split off this map's idea (idea-phase split), and the person's
 * decision: `confirmed` became its own map, `dismissed` stays in this map, `pending` is undecided.
 */
const ChartSplit = z.strictObject({
  title: MapTitle,
  idea: MapIdea,
  state: MapProposalState,
});

/**
 * One map suggestion of the project, from any of its maps, as a run that can suggest maps reads it:
 * its title, its own Out of scope line as stored (a split offer's, or an outside suggestion's with a
 * line of its own; null for one attached to a waypoint or one splitting an existing line), and the
 * person's decision (`confirmed` is a map now).
 */
export const ProjectProposalContext = z.strictObject({
  title: MapTitle,
  line: MapLine.nullable(),
  state: MapProposalState,
});
export type ProjectProposalContext = z.infer<typeof ProjectProposalContext>;

/**
 * One map of the project, this map included, as a run that can suggest maps reads it: its title
 * (null until its first chart) and the latest stage its stage rail shows as reached. Nothing else
 * about other maps is given.
 */
export const ProjectMapContext = z.strictObject({
  title: MapTitle.nullable(),
  stage: Stage,
});
export type ProjectMapContext = z.infer<typeof ProjectMapContext>;

/** What every run that can suggest maps reads of its project, so it suggests nothing twice. */
const ProjectSuggestionContext = {
  /** Every map suggestion of the project, from every map, oldest first. */
  projectProposals: z.array(ProjectProposalContext),
  /** Every map of the project, oldest first. */
  projectMaps: z.array(ProjectMapContext),
};

/** What the planning agent needs to chart a map. */
export const ChartMapRequest = z
  .strictObject({
    projectName: ProjectName,
    /** The project's repository; the agent runs with it as its working directory. */
    projectFolder: AbsolutePath,
    baseBranch: BaseBranch,
    idea: MapIdea,
    ...ProjectSuggestionContext,
    /** The map-level rounds so far, oldest first, every one submitted; `chartStep` reads them. */
    mapRounds: z.array(MapRound),
    /**
     * The map's stored title, summary and proposed destination: what the last round was asked
     * about. Null exactly when `mapRounds` is empty (the first chart proposes them).
     */
    proposed: z
      .strictObject({ title: MapTitle, summary: MapSummary, destination: MapDestination })
      .nullable(),
    /** The project's specs, by number, each with its latest revision and hold. */
    projectSpecs: z.array(ProjectSpecContext),
    /** The maps the first chart offered to split off, oldest first, with the person's decisions. */
    split: z.array(ChartSplit),
    /**
     * The problem core refused this chart's previous attempt with (`agent_output_invalid`), so this
     * attempt can correct it; null otherwise.
     */
    refusedAttempt: z.strictObject({ problem: z.string().min(1) }).nullable(),
  })
  .refine((request) => (request.proposed === null) === (request.mapRounds.length === 0), {
    message: "Set proposed exactly when the map has a map-level round.",
  });
export type ChartMapRequest = z.infer<typeof ChartMapRequest>;

/** A destination as a chart writes it, within its model's limits (`agent.models`). */
function draftDestination(limits: ModelLimits) {
  return z.string().min(1).max(limits.destination.max);
}

/** The most maps one first chart may offer to split off an idea too big for one map. */
export const CHART_SPLIT_MAX_COUNT = 3;
/** The most map-level rounds a map asks on its destination: the first and up to 2 follow-ups. */
export const DESTINATION_ROUNDS_MAX_COUNT = 3;
/** The most questions one follow-up round on the destination asks; the first asks up to 5. */
export const DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT = 3;

/**
 * What a chart may return: `propose` before any map-level round; `confirm` after a final round or
 * at `DESTINATION_ROUNDS_MAX_COUNT` rounds; otherwise `choose`, a confirmation or a follow-up
 * round. The agent picks its schema from it and core checks the outcome against it.
 */
export type ChartStep = "propose" | "choose" | "confirm";

/** The chart's step for the map-level rounds so far, oldest first; a pending round throws. */
export function chartStep(mapRounds: readonly MapRound[]): ChartStep {
  if (mapRounds.some((round) => round.answers === null)) {
    throw new Error("A chart never runs while a map-level round is pending");
  }
  const last = mapRounds.at(-1);
  if (last === undefined) {
    return "propose";
  }
  return last.final || mapRounds.length >= DESTINATION_ROUNDS_MAX_COUNT ? "confirm" : "choose";
}

/**
 * Whether a map-level round is the destination's last: `final`, or numbered
 * `DESTINATION_ROUNDS_MAX_COUNT`; after it the chart can only confirm.
 */
export function isLastMapRound(round: {
  readonly final: boolean;
  readonly number: number;
}): boolean {
  return round.final || round.number >= DESTINATION_ROUNDS_MAX_COUNT;
}

/**
 * A first chart's output: the map's reading, the proposed destination and the map-level round, and
 * the maps it offers to split off when the idea is too big for one map (idea-phase split): each a
 * title, a draft idea and the Out of scope line saying what this map leaves to it. The proposed
 * destination covers only what stays in this map.
 */
export function chartProposal(limits: ModelLimits) {
  return z.strictObject({
    title: z.string().min(1).max(limits.mapTitle.max),
    summary: z.string().min(1).max(limits.mapSummary.max),
    /** The proposed destination; the round's intro states it. */
    destination: draftDestination(limits),
    round: questionRoundDraft(limits),
    split: z.array(proposedMap(limits)).max(CHART_SPLIT_MAX_COUNT),
  });
}
export type ChartProposal = z.infer<ReturnType<typeof chartProposal>>;

/** One waypoint a confirming chart saves, of any kind. */
/** The most touches one charted waypoint names. */
export const WAYPOINT_TOUCHES_MAX_COUNT = 3;
/** The most criteria one touch names. */
export const TOUCH_CRITERIA_MAX_COUNT = 12;

/**
 * A spec of the project a charted waypoint changes: its latest approved revision and criteria of
 * that revision. Core checks them against the project.
 */
export const Touch = z.strictObject({
  specNumber: z.int().min(1),
  revision: z.int().min(1),
  criteria: z.array(CriterionId).min(1).max(TOUCH_CRITERIA_MAX_COUNT),
});
export type Touch = z.infer<typeof Touch>;

export function chartedWaypoint(limits: ModelLimits) {
  return z.strictObject({
    kind: WaypointKind,
    title: draftWaypointTitle(limits),
    question: draftWaypointQuestion(limits),
    /** 1-based positions of the waypoints in the same list that block this one. */
    blockedBy: z.array(z.int().min(1)).max(CHART_WAYPOINTS_MAX_COUNT - 1),
    /** The delivered or approved specs the waypoint changes; stored with it. */
    touches: z.array(Touch).max(WAYPOINT_TOUCHES_MAX_COUNT),
  });
}
export const ChartedWaypoint = chartedWaypoint(STORED_LIMITS);
export type ChartedWaypoint = z.infer<typeof ChartedWaypoint>;

/**
 * A confirming chart's output, after the map-level round is submitted: the map's title, summary and
 * destination, which the confirmation may refine, 0 to 12 waypoints, 0 to 8 fog items and 0 to 8
 * Out of scope lines, each line saying why, and 0 to 4 proposals of new maps for outside work, each
 * with its own line; its texts within the run's model's limits (`agent.models`).
 */
export function chartConfirmation(limits: ModelLimits) {
  return z.strictObject({
    title: z.string().min(1).max(limits.mapTitle.max),
    summary: z.string().min(1).max(limits.mapSummary.max),
    destination: draftDestination(limits),
    waypoints: z.array(chartedWaypoint(limits)).max(CHART_WAYPOINTS_MAX_COUNT),
    fog: z.array(draftMapLine(limits)).max(CHART_MAP_LINES_MAX_COUNT),
    outOfScope: z.array(draftMapLine(limits)).max(CHART_MAP_LINES_MAX_COUNT),
    proposals: mapProposals(limits),
  });
}
/** A confirming chart's output within the stored caps. */
export const ChartConfirmation = chartConfirmation(STORED_LIMITS);
export type ChartConfirmation = z.infer<typeof ChartConfirmation>;

/**
 * A follow-up on the destination: the revised title, summary and proposed destination, and the next
 * map-level round of 1 to `DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT` questions, `final` when the
 * agent expects its answers to settle the destination; its intro states the revised destination.
 * Texts within the run's model's limits (`agent.models`).
 */
export function chartFollowUp(limits: ModelLimits) {
  return z.strictObject({
    title: z.string().min(1).max(limits.mapTitle.max),
    summary: z.string().min(1).max(limits.mapSummary.max),
    destination: draftDestination(limits),
    round: z.strictObject({
      intro: draftRoundIntro(limits),
      final: z.boolean(),
      questions: z
        .array(draftQuestion(limits))
        .min(1)
        .max(DESTINATION_FOLLOW_UP_QUESTIONS_MAX_COUNT),
    }),
  });
}
/** A follow-up within the stored caps. */
export const ChartFollowUp = chartFollowUp(STORED_LIMITS);
export type ChartFollowUp = z.infer<typeof ChartFollowUp>;

/**
 * What a chart returns, by its step (`chartStep`): the proposal at `propose`; a confirmation or a
 * follow-up at `choose`; a confirmation at `confirm`.
 */
export type ChartOutcome =
  | { readonly kind: "proposal"; readonly proposal: ChartProposal }
  | { readonly kind: "confirmation"; readonly confirmation: ChartConfirmation }
  | { readonly kind: "followUp"; readonly followUp: ChartFollowUp };

/** The port behind which the chart's model call sits. */
export type ChartMap = (
  request: ChartMapRequest,
  session: PlanningCallSession,
) => Promise<Result<ChartOutcome, PlanningAgentError | CancelledError>>;

/**
 * The person's direction about a waypoint: the hatch message that last opened, reopened, reworded
 * or directed it, with when it was sent.
 */
export const WaypointNote = z.strictObject({ text: HatchMessageText, sentAt: z.iso.datetime() });
export type WaypointNote = z.infer<typeof WaypointNote>;

/** One answered round on the waypoint being grilled. */
const AnsweredRound = z.strictObject({
  questions: RoundQuestions,
  answers: Answers,
  final: z.boolean(),
});

/** What the planning agent needs to grill one waypoint. */
export const GrillWaypointRequest = z.strictObject({
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  ...ProjectSuggestionContext,
  title: MapTitle,
  destination: MapDestination,
  /** The map-level rounds, oldest first, as the chart reads them: the person's answers bind every waypoint. */
  mapRounds: z.array(MapRound),
  waypoint: z.strictObject({
    number: z.int().min(1),
    kind: WaypointKind,
    title: WaypointTitle,
    question: WaypointQuestion,
    /** The waypoint's answered rounds since its latest reopen (all of them when never reopened), oldest first. */
    rounds: z.array(AnsweredRound),
    /**
     * True when the waypoint was resolved and then reopened: its earlier decision no longer stands,
     * and a resolution needs a round asked since the reopen.
     */
    reopened: z.boolean(),
    /**
     * The rounds answered before its latest reopen, oldest first: context the reopen superseded,
     * not live answers; empty when never reopened.
     */
    supersededRounds: z.array(AnsweredRound),
    /**
     * True when a planning review finding routed `decision` opened or linked it: only the person
     * settles it, so a resolution or out-of-scope ruling needs an answered round first.
     */
    personDecides: z.boolean(),
    /** The specs it touches with their criteria's baselines, by spec number. */
    touches: z.array(RunTouch),
  }),
  /** The map's other waypoints, by number; `gist` is null until resolved. */
  otherWaypoints: z.array(MapWaypointContext),
  /** The questions of the rounds pending on other waypoints, which the person answers beside this one's. */
  otherPendingRounds: z.array(
    z.strictObject({ waypointTitle: WaypointTitle, questions: RoundQuestions }),
  ),
  /** The map's fog, by position. */
  fog: z.array(FogItem),
  /** The map's Out of scope lines, by position. */
  outOfScope: z.array(MapLine),
  /** The map's code survey; null for a map whose survey has not run (one that predates surveys, or a hatch reply before the chart). */
  survey: CodeSurvey.nullable(),
  /** The consistency finding that opened this waypoint, or null. */
  finding: z
    .strictObject({
      kind: ConsistencyFindingKind,
      explanation: WaypointResolutionText,
      /** The resolved waypoints it names, by number, with their titles and resolutions. */
      waypoints: z
        .array(
          z.strictObject({
            number: z.int().min(1),
            title: WaypointTitle,
            resolution: WaypointResolutionText,
          }),
        )
        .min(1),
    })
    .nullable(),
  /**
   * The planning review findings that sent this waypoint on, each with the spec it was found in and
   * the clause and criterion ids it names: the one that opened it, then any later review's that
   * raised the same problem. Empty for a waypoint no review sent on.
   */
  reviewFindings: z.array(
    z.strictObject({
      kind: SpecReviewFinding.shape.kind,
      explanation: SpecReviewFinding.shape.explanation,
      spec: z.strictObject({ number: z.int().min(1), title: SpecRevisionContent.shape.title }),
      elementIds: SpecReviewFinding.shape.elementIds,
    }),
  ),
  /** The person's note about this waypoint, or null. */
  note: WaypointNote.nullable(),
  /** True for a run started after a `final` round: it can only resolve. */
  afterFinal: z.boolean(),
  /**
   * The problem core refused this run's previous attempt with (`agent_output_invalid`), so this
   * attempt can correct it; null otherwise.
   */
  refusedAttempt: z.strictObject({ problem: z.string().min(1) }).nullable(),
});
export type GrillWaypointRequest = z.infer<typeof GrillWaypointRequest>;

/** A grilling round: a question round that may be the waypoint's last (`final`). */
export function grillRound(limits: ModelLimits) {
  return z.strictObject({
    intro: draftRoundIntro(limits),
    final: z.boolean(),
    questions: draftRoundQuestions(limits),
  });
}
export type GrillRound = z.infer<ReturnType<typeof grillRound>>;

/**
 * A grilling run's output: exactly one of a round, a resolution and an out-of-scope ruling;
 * `mapChanges` is set exactly when no round is asked. The rules are refinements, so the CLI's
 * `--json-schema` (which omits them) keeps one object root, and a breach fails the parse.
 */
export function grillOutcome(limits: ModelLimits) {
  return z
    .strictObject({
      round: grillRound(limits).nullable(),
      resolution: waypointResolution(limits).nullable(),
      outOfScope: outOfScopeRuling(limits).nullable(),
      mapChanges: mapChanges(limits).nullable(),
    })
    .refine(
      (outcome) =>
        [outcome.round, outcome.resolution, outcome.outOfScope].filter(
          (alternative) => alternative !== null,
        ).length === 1,
      { message: "Set exactly one of round, resolution and outOfScope." },
    )
    .refine((outcome) => (outcome.round === null) !== (outcome.mapChanges === null), {
      message: "Set mapChanges exactly when no round is asked.",
    });
}
export type GrillOutcome = z.infer<ReturnType<typeof grillOutcome>>;

/**
 * A grilling run's output after a `final` round: no round, so exactly one of a resolution and an
 * out-of-scope ruling, plus its map changes.
 */
export function grillResolutionOutcome(limits: ModelLimits) {
  return z
    .strictObject({
      resolution: waypointResolution(limits).nullable(),
      outOfScope: outOfScopeRuling(limits).nullable(),
      mapChanges: mapChanges(limits),
    })
    .refine((outcome) => (outcome.resolution === null) !== (outcome.outOfScope === null), {
      message: "Set exactly one of resolution and outOfScope.",
    });
}
export type GrillResolutionOutcome = z.infer<ReturnType<typeof grillResolutionOutcome>>;

/** The port behind which a waypoint's grilling call sits. */
export type GrillWaypoint = (
  request: GrillWaypointRequest,
  session: PlanningCallSession,
) => Promise<Result<GrillOutcome, PlanningAgentError | CancelledError>>;

/**
 * A research report. An answered one has at least one finding and a gist and no gap; an unanswered
 * one names its gap and has no gist. Every finding's source positions exist.
 */
export function researchReport(limits: ModelLimits) {
  const note = z.string().min(1).max(limits.researchNote.max);
  return z
    .strictObject({
      answered: z.boolean(),
      summary: z.string().min(1).max(limits.researchSummary.max),
      /** What the research could not establish; null exactly when answered. */
      gap: note.nullable(),
      /** The line for the map's Decisions so far; null exactly when unanswered. */
      gist: draftGist(limits).nullable(),
      findings: z.array(
        researchFindingSchema(limits.researchFindingTitle.max, limits.researchFindingDetail.max),
      ),
      sources: z.array(
        researchSourceSchema(limits.researchSourceTitle.max, limits.researchExcerpt.max),
      ),
      limitations: z.array(note),
      uncertainties: z.array(note),
    })
    .refine(
      (report) =>
        report.answered
          ? report.findings.length > 0 && report.gist !== null && report.gap === null
          : report.gap !== null && report.gist === null,
      {
        message:
          "An answered report has a finding and a gist and no gap; an unanswered one a gap and no gist.",
      },
    )
    .refine(
      (report) =>
        report.findings.every((finding) =>
          finding.sources.every((position) => position <= report.sources.length),
        ),
      { message: "Every finding's source positions exist." },
    );
}
/** A research report within the stored caps, as earlier reports are read back. */
export const ResearchReport = researchReport(STORED_LIMITS);
export type ResearchReport = z.infer<typeof ResearchReport>;

/** The map context every Research and Task run reads. */
const WaypointRunContext = {
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  ...ProjectSuggestionContext,
  title: MapTitle,
  destination: MapDestination,
  /** The map-level rounds, oldest first: the person's answers bind the run as the destination does. */
  mapRounds: z.array(MapRound),
  /** The map's other waypoints, by number. */
  otherWaypoints: z.array(MapWaypointContext),
  /** The map's fog, by position. */
  fog: z.array(FogItem),
  /** The map's Out of scope lines. */
  outOfScope: z.array(MapLine),
  /** The map's code survey; null for a map whose survey has not run (one that predates surveys, or a hatch reply before the chart). */
  survey: CodeSurvey.nullable(),
  /** The person's note about the waypoint the run works, or null. */
  note: WaypointNote.nullable(),
};

/** The waypoint a run works: its number, kind, title and question. */
const RunWaypoint = z.strictObject({
  number: z.int().min(1),
  kind: WaypointKind,
  title: WaypointTitle,
  question: WaypointQuestion,
});

/** What the planning agent needs to research one waypoint. */
export const ResearchWaypointRequest = z.strictObject({
  ...WaypointRunContext,
  waypoint: z.strictObject({
    ...RunWaypoint.shape,
    /** The specs it touches with their criteria's baselines, by spec number. */
    touches: z.array(RunTouch),
  }),
  /** This waypoint's earlier reports, oldest first (each unanswered: an answered one resolves it). */
  earlierReports: z.array(ResearchReport),
});
export type ResearchWaypointRequest = z.infer<typeof ResearchWaypointRequest>;

/**
 * A research run's output: exactly one of a report and an out-of-scope ruling, plus its map
 * changes. The rule is a refinement, so the `--json-schema` keeps one object root.
 */
export function researchOutcome(limits: ModelLimits) {
  return z
    .strictObject({
      report: researchReport(limits).nullable(),
      outOfScope: outOfScopeRuling(limits).nullable(),
      mapChanges: mapChanges(limits),
    })
    .refine((outcome) => (outcome.report === null) !== (outcome.outOfScope === null), {
      message: "Set exactly one of report and outOfScope.",
    });
}
export type ResearchOutcome = z.infer<ReturnType<typeof researchOutcome>>;

/** The port behind which a Research waypoint's call sits. */
export type ResearchWaypoint = (
  request: ResearchWaypointRequest,
  session: PlanningCallSession,
) => Promise<Result<ResearchOutcome, PlanningAgentError | CancelledError>>;

/** The most questions one Task round asks. */
export const TASK_ROUND_QUESTIONS_MAX_COUNT = 3;

/**
 * A Task run's question round, 1 to 3 questions within the drafting bounds: like every round, each
 * question has 2 to 4 options with the recommendation first.
 */
export function taskRound(limits: ModelLimits) {
  return z.strictObject({
    intro: draftRoundIntro(limits),
    questions: z.array(draftQuestion(limits)).min(1).max(TASK_ROUND_QUESTIONS_MAX_COUNT),
  });
}
export type TaskRound = z.infer<ReturnType<typeof taskRound>>;

/** What a Task run did and the facts it found: `facts` resolve the waypoint. */
export function taskDone(limits: ModelLimits) {
  return z.strictObject({
    action: z.string().min(1).max(limits.taskAction.max),
    facts: z.string().min(1).max(limits.taskFacts.max),
    gist: draftGist(limits),
    agentDecided: draftAgentDecided(limits),
  });
}
export const TaskDone = taskDone(STORED_LIMITS);
export type TaskDone = z.infer<typeof TaskDone>;

/** What a Task run tried and what stopped it. */
export function taskFailed(limits: ModelLimits) {
  return z.strictObject({
    action: z.string().min(1).max(limits.taskAction.max),
    facts: z.string().min(1).max(limits.taskFacts.max),
  });
}
export const TaskFailed = taskFailed(STORED_LIMITS);
export type TaskFailed = z.infer<typeof TaskFailed>;

/** An earlier outcome of the same Task waypoint. */
const EarlierTaskOutcome = z.strictObject({
  outcome: TaskOutcomeKind,
  action: TaskDone.shape.action,
  facts: WaypointResolutionText,
});

/** One answered Task round: its questions and the person's answers, one per question. */
const AnsweredTaskRound = z.strictObject({
  questions: z.array(Question).min(1).max(TASK_ROUND_QUESTIONS_MAX_COUNT),
  answers: Answers,
});

/** What the planning agent needs to work one Task waypoint. */
export const WorkTaskRequest = z.strictObject({
  ...WaypointRunContext,
  waypoint: RunWaypoint.extend({
    /** The task's answered rounds, oldest first. */
    rounds: z.array(AnsweredTaskRound),
    /** The specs it touches with the touched revision's text, by spec number. */
    touches: z.array(RunTouch),
  }),
  /** The task's earlier outcomes, oldest first. */
  earlierOutcomes: z.array(EarlierTaskOutcome),
});
export type WorkTaskRequest = z.infer<typeof WorkTaskRequest>;

/**
 * A Task run's output: exactly one of a round, `done`, `failed` and an out-of-scope
 * ruling; `mapChanges` is set exactly when no round is asked. Refinements, so the `--json-schema`
 * keeps one object root.
 */
export function taskOutcome(limits: ModelLimits) {
  return z
    .strictObject({
      round: taskRound(limits).nullable(),
      done: taskDone(limits).nullable(),
      failed: taskFailed(limits).nullable(),
      outOfScope: outOfScopeRuling(limits).nullable(),
      mapChanges: mapChanges(limits).nullable(),
    })
    .refine(
      (outcome) =>
        [outcome.round, outcome.done, outcome.failed, outcome.outOfScope].filter(
          (alternative) => alternative !== null,
        ).length === 1,
      { message: "Set exactly one of round, done, failed and outOfScope." },
    )
    .refine((outcome) => (outcome.round === null) !== (outcome.mapChanges === null), {
      message: "Set mapChanges exactly when no round is asked.",
    });
}
export type TaskOutcome = z.infer<ReturnType<typeof taskOutcome>>;

/** The port behind which a Task waypoint's call sits. */
export type WorkTask = (
  request: WorkTaskRequest,
  session: PlanningCallSession,
) => Promise<Result<TaskOutcome, PlanningAgentError | CancelledError>>;

/** What the planning agent needs for a consistency pass over a map's resolved waypoints. */
export const CheckConsistencyRequest = z.strictObject({
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  ...ProjectSuggestionContext,
  title: MapTitle,
  destination: MapDestination,
  /** The map-level rounds, oldest first. */
  mapRounds: z.array(MapRound),
  outOfScope: z.array(MapLine),
  /** The map's code survey; null for a map whose survey has not run (one that predates surveys, or a hatch reply before the chart). */
  survey: CodeSurvey.nullable(),
  /** Every resolved waypoint, by number. */
  waypoints: z.array(
    z.strictObject({
      number: z.int().min(1),
      kind: WaypointKind,
      title: WaypointTitle,
      question: WaypointQuestion,
      resolution: WaypointResolutionText,
      /**
       * True when the person stands behind the resolution: they answered a round on it, it was
       * resolved from their plain choices, or their note through the hatch directed it. False when
       * the agent decided it alone (a self-resolved grilling, research, task or decided fog item).
       */
      decidedByPerson: z.boolean(),
      /** True when the map's latest pass did not compare this resolution; on the first pass, every one. */
      newSinceLastPass: z.boolean(),
      /** The finding of an earlier pass that opened this waypoint, or null. */
      finding: z
        .strictObject({
          kind: ConsistencyFindingKind,
          waypointNumbers: z.array(z.int().min(1)).min(1),
        })
        .nullable(),
    }),
  ),
});
export type CheckConsistencyRequest = z.infer<typeof CheckConsistencyRequest>;

/** One problem a pass found; core saves it as a new Grilling waypoint. */
export function consistencyFinding(limits: ModelLimits) {
  return z.strictObject({
    kind: ConsistencyFindingKind,
    /** The resolved waypoints it names, by number. */
    waypointNumbers: z.array(z.int().min(1)).min(1),
    /** The new Grilling waypoint's title. */
    title: draftWaypointTitle(limits),
    /** Quotes the wording each finding rests on. */
    explanation: z.string().min(1).max(limits.findingExplanation.max),
    /** The new Grilling waypoint's question. */
    question: draftWaypointQuestion(limits),
  });
}
export const ConsistencyFinding = consistencyFinding(STORED_LIMITS);
export type ConsistencyFinding = z.infer<typeof ConsistencyFinding>;

/**
 * A consistency pass's output: 0 to 3 findings and 0 to 4 proposals of new maps for outside work it
 * noticed, within the run's model's limits.
 */
export function consistencyOutcome(limits: ModelLimits) {
  return z.strictObject({
    findings: z.array(consistencyFinding(limits)).max(CONSISTENCY_FINDINGS_MAX_COUNT),
    proposals: mapProposals(limits),
  });
}
/** A consistency pass's output within the stored caps. */
export const ConsistencyOutcome = consistencyOutcome(STORED_LIMITS);
export type ConsistencyOutcome = z.infer<typeof ConsistencyOutcome>;

/** The port behind which a consistency pass's call sits. */
export type CheckConsistency = (
  request: CheckConsistencyRequest,
  session: PlanningCallSession,
) => Promise<Result<ConsistencyOutcome, PlanningAgentError | CancelledError>>;

/**
 * What the planning agent needs to survey a map's project code: the map as its confirming chart
 * left it. The survey runs once, before any waypoint run.
 */
export const SurveyCodeRequest = z.strictObject({
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  title: MapTitle,
  destination: MapDestination,
  /** The map's charted waypoints, by number. */
  waypoints: z.array(RunWaypoint),
  /** The map's fog, by position. */
  fog: z.array(FogItem),
  /** The map's Out of scope lines. */
  outOfScope: z.array(MapLine),
});
export type SurveyCodeRequest = z.infer<typeof SurveyCodeRequest>;

/** The port behind which a map's code survey call sits; its output is stored as the `CodeSurvey`. */
export type SurveyCode = (
  request: SurveyCodeRequest,
  session: PlanningCallSession,
) => Promise<Result<CodeSurveyDraft, PlanningAgentError | CancelledError>>;

/**
 * What the planning agent needs to settle a map's fog: once no waypoint is open or claimed and fog
 * remains, core runs one `fog` run that sees every waypoint, the code survey and the fog, instead
 * of making the last waypoint run settle fog it did not own.
 */
export const SettleFogRequest = z.strictObject({
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  ...ProjectSuggestionContext,
  title: MapTitle,
  destination: MapDestination,
  /** The map-level rounds, oldest first. */
  mapRounds: z.array(MapRound),
  outOfScope: z.array(MapLine),
  /** The map's code survey; null for a map whose survey has not run (one that predates surveys). */
  survey: CodeSurvey.nullable(),
  /** Every resolved waypoint, by number, with who stands behind its resolution. */
  waypoints: z.array(
    z.strictObject({
      ...RunWaypoint.shape,
      resolution: WaypointResolutionText,
      /** As `CheckConsistencyRequest`'s: true when the person stands behind the resolution. */
      decidedByPerson: z.boolean(),
    }),
  ),
  /** The map's fog, by position; every item is settled by the run. */
  fog: z.array(FogItem).min(1),
});
export type SettleFogRequest = z.infer<typeof SettleFogRequest>;

/**
 * A fog item only the person can settle: core opens it as an unblocked Grilling waypoint that only
 * the person settles (`personDecides`), its fog item deleted.
 */
export function fogForPerson(limits: ModelLimits) {
  return z.strictObject({
    position: z.int().min(1),
    title: draftWaypointTitle(limits),
    question: draftWaypointQuestion(limits),
  });
}
export const FogForPerson = fogForPerson(STORED_LIMITS);
export type FogForPerson = z.infer<typeof FogForPerson>;

/**
 * A fog run's output: every fog item settled exactly once, by an existing resolution
 * (`fogSettledBy`, the resolved waypoint's number), decided by the agent (`fogDecided`), moved out
 * of scope (`fogOutOfScope`), opened for the person (`fogForPerson`) or proposed as a new map
 * (`fogProposed`: deleted from the fog, its line saved only when the person decides the proposal).
 * Core refuses an item left out or named twice.
 */
export function fogSettlementOutcome(limits: ModelLimits) {
  return z.strictObject({
    fogSettledBy: z.array(z.strictObject({ position: z.int().min(1), waypoint: z.int().min(1) })),
    fogDecided: z.array(decidedFog(limits)),
    fogOutOfScope: z.array(
      z.strictObject({ position: z.int().min(1), line: draftMapLine(limits) }),
    ),
    fogForPerson: z.array(fogForPerson(limits)),
    fogProposed: z
      .array(z.strictObject({ position: z.int().min(1), ...proposedMap(limits).shape }))
      .max(MAP_PROPOSALS_MAX_COUNT),
  });
}
export type FogSettlementOutcome = z.infer<ReturnType<typeof fogSettlementOutcome>>;

/** The port behind which a map's fog run's call sits. */
export type SettleFog = (
  request: SettleFogRequest,
  session: PlanningCallSession,
) => Promise<Result<FogSettlementOutcome, PlanningAgentError | CancelledError>>;

/** A planning call's refusal when its `session.signal` aborted and its CLI was stopped. */
export type CancelledError = Extract<DeliveryAgentError, { code: "agent_cancelled" }>;

/** A skill-following call's refusal when its SKILL.md is missing; no CLI starts. */
export type SkillMissingError = Extract<DeliveryAgentError, { code: "agent_skill_missing" }>;

/** The map a spec run reads: what core reads from the map's stored rows. */
const SpecMapContext = {
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  title: MapTitle,
  /** The confirmed destination. */
  destination: MapDestination,
  /** Each resolved waypoint, by number. */
  waypoints: z.array(ResolvedWaypoint),
  /** The map's Out of scope lines, by position. */
  outOfScope: z.array(MapLine),
  /** The map's code survey; null for a map whose survey has not run (one that predates surveys, or a hatch reply before the chart). */
  survey: CodeSurvey.nullable(),
  /** The map's open waits, by spec number, each with its note. */
  waits: z.array(
    z.strictObject({
      specNumber: z.int().min(1),
      note: z.string().min(1).max(HATCH_MESSAGE_MAX_LENGTH),
    }),
  ),
};

/** The project's other specs a To Spec run reads. */
const ProjectSpecs = {
  /** Every spec of the project the map has not written, by number. */
  projectSpecs: z.array(ProjectSpecContext),
};

/**
 * Why a revision gets a next one: its failed review's findings, the person's rejection reason, or
 * the person's note through the escape hatch.
 */
export const SpecFeedback = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("review"),
    summary: SpecReviewSummary,
    findings: z.array(SpecReviewFinding).min(1),
  }),
  z.strictObject({ kind: z.literal("rejection"), reason: RejectionReason }),
  z.strictObject({ kind: z.literal("note"), text: HatchMessageText }),
  /**
   * A released wait's note: the change the map waited with. `noteDirected` when the wait came from
   * a note through the escape hatch: the revision may then cite the note; a wait To Spec recorded
   * cites the map's waypoints or its destination.
   */
  z.strictObject({
    kind: z.literal("wait"),
    note: z.string().min(1).max(HATCH_MESSAGE_MAX_LENGTH),
    noteDirected: z.boolean(),
  }),
]);
export type SpecFeedback = z.infer<typeof SpecFeedback>;

/**
 * The findings of a spec's earlier failed reviews, oldest first, each with the revision it
 * reviewed: the repair loop's memory, so a repair closes them and a review does not raise a closed
 * one again. One entry per review: a draft rewritten in place has one per review of its earlier
 * content. Empty when no earlier review failed.
 */
export const EarlierFindings = z.array(
  z.strictObject({
    revision: z.int().min(1),
    findings: z
      .array(SpecReviewFinding.pick({ kind: true, elementIds: true, explanation: true }))
      .min(1),
  }),
);
export type EarlierFindings = z.infer<typeof EarlierFindings>;

/** One of the map's specs on a re-clear: its latest revision and that revision's last feedback. */
const MapSpec = z.strictObject({
  latest: SpecRevisionRef,
  retiredIds: RetiredIds,
  approved: z.boolean(),
  /** Null when the latest revision has no failed review and no rejection. */
  feedback: SpecFeedback.nullable(),
});

/** What the planning agent needs to write a cleared map's specs. */
export const DraftSpecsRequest = z.strictObject({
  ...SpecMapContext,
  /** The map-level rounds, oldest first; apart from `SpecMapContext`, which To Tickets spreads too. */
  mapRounds: z.array(MapRound),
  ...ProjectSpecs,
  /** The map's specs, by number; empty on the map's first clear. */
  specs: z.array(MapSpec),
  /**
   * The problem core refused this run's previous attempt with (`spec_content_invalid`), so this
   * attempt can correct it; null when the previous attempt was not so refused.
   */
  refusedAttempt: z.strictObject({ problem: z.string().min(1) }).nullable(),
});
export type DraftSpecsRequest = z.infer<typeof DraftSpecsRequest>;

/**
 * The most specs one To Spec run writes. A map is one spec by default; this is the backstop, not a
 * target.
 */
export const DRAFT_SPECS_MAX_COUNT = 4;

/** The most waits one To Spec run names, one per held spec the map changes. */
export const DRAFT_SPECS_WAITS_MAX_COUNT = 12;

/**
 * A To Spec run's output: a next revision for an unapproved spec of the map (`specNumber`) or a new
 * spec (`specNumber` null). Core checks the numbers against the map, and accepts zero specs only on
 * a re-clear whose listed specs are all approved.
 */
export function draftSpecsOutcome(limits: ModelLimits) {
  return z.strictObject({
    specs: z
      .array(
        z.strictObject({
          specNumber: z.int().min(1).nullable(),
          content: specRevisionDraft(limits),
        }),
      )
      .max(DRAFT_SPECS_MAX_COUNT),
    /** Each held spec the map changes, with the note its change is written from. */
    waits: z
      .array(
        z.strictObject({
          specNumber: z.int().min(1),
          note: z.string().min(1).max(limits.waitNote.max),
        }),
      )
      .max(DRAFT_SPECS_WAITS_MAX_COUNT),
  });
}
export type DraftSpecsOutcome = z.infer<ReturnType<typeof draftSpecsOutcome>>;

/** The port behind which a map-scope To Spec run's call sits. */
export type DraftSpecs = (
  request: DraftSpecsRequest,
  session: PlanningCallSession,
) => Promise<Result<DraftSpecsOutcome, PlanningAgentError | CancelledError | SkillMissingError>>;

/**
 * One thing a clause relies on, with the code around it: core resolves each `reliesOn` entry of a
 * revision to its file and line and reads the lines either side, so a repair and a review read the
 * code a clause depends on without searching for it. `meaning` is FACTS' meaning when FACTS names
 * it. A reliance that no longer resolves (the code moved) has null `line` and `excerpt`.
 */
export const ClauseReference = z.strictObject({
  clauseId: ClauseId,
  name: ClauseReliance.shape.name,
  path: z.string().min(1).nullable(),
  line: z.int().min(1).nullable(),
  meaning: z.string().min(1).nullable(),
  excerpt: z.string().min(1).nullable(),
});
export type ClauseReference = z.infer<typeof ClauseReference>;

/** What the planning agent needs to repair one spec. */
export const ReviseSpecRequest = z.strictObject({
  ...SpecMapContext,
  /** The map-level rounds, oldest first; apart from `SpecMapContext`, which To Tickets spreads too. */
  mapRounds: z.array(MapRound),
  ...ProjectSpecs,
  latest: SpecRevisionRef,
  /** What `latest`'s clauses rely on, with the code around each. */
  references: z.array(ClauseReference),
  /** The spec's retired ids: every revision run, a release's or a note's too, avoids them. */
  retiredIds: RetiredIds,
  feedback: SpecFeedback,
  /**
   * The failed reviews of the revisions before `latest` and of `latest`'s content a rewrite in
   * place replaced; its current review is `feedback`.
   */
  earlierFindings: EarlierFindings,
  /**
   * The problem core refused this repair's previous attempt with (`spec_content_invalid`), so this
   * attempt can correct it; null when the previous attempt was not so refused.
   */
  refusedAttempt: z.strictObject({ problem: z.string().min(1) }).nullable(),
});
export type ReviseSpecRequest = z.infer<typeof ReviseSpecRequest>;

/** A repair's output: the spec's next revision and the ids it drops from the latest, with why. */
export function reviseSpecOutcome(limits: ModelLimits) {
  return z.strictObject({
    revision: specRevisionDraft(limits),
    removed: specRemovalsSchema(limits.removalReason.max),
  });
}
export type ReviseSpecOutcome = z.infer<ReturnType<typeof reviseSpecOutcome>>;

/** The port behind which a spec-scope To Spec run's call sits. */
export type ReviseSpec = (
  request: ReviseSpecRequest,
  session: PlanningCallSession,
) => Promise<Result<ReviseSpecOutcome, PlanningAgentError | CancelledError | SkillMissingError>>;

/** What the planning agent needs to review one spec revision. */
export const ReviewSpecRequest = z.strictObject({
  ...SpecMapContext,
  /** The map-level rounds, oldest first; apart from `SpecMapContext`, which To Tickets spreads too. */
  mapRounds: z.array(MapRound),
  revision: SpecRevisionRef,
  /** What the reviewed revision's clauses rely on, with the code around each. */
  references: z.array(ClauseReference),
  /**
   * The revision before it, on whichever map, with the merged run that delivered its set, or null;
   * null for revision 1.
   */
  before: z
    .strictObject({
      ...SpecRevisionRef.shape,
      delivery: z.strictObject({ run: z.int().min(1), commit: z.string().min(1) }).nullable(),
    })
    .nullable(),
  /**
   * What the reviewed revision changes since the spec's latest approved revision before it: that
   * revision's number, whether this map wrote it (else its map's title), the reviewed revision's
   * clauses new or changed since it, through every revision between, and those unchanged since it,
   * which carry approved decisions and are context. Null when no earlier revision is approved: the
   * whole revision is this map's.
   */
  changes: z
    .strictObject({
      since: z.int().min(1),
      writer: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("this-map") }),
        z.strictObject({ kind: z.literal("another-map"), mapTitle: MapTitle }),
      ]),
      changedClauses: z.array(ClauseId),
      unchangedClauses: z.array(ClauseId),
    })
    .nullable(),
  /**
   * The ids the reviewed revision drops from the revision before, as its repair declared them with
   * why (core checked they are exactly the dropped ids); null when a map-scope To Spec run wrote
   * it, or it is revision 1, so no removal was declared.
   */
  removed: SpecRemovals.nullable(),
  /** The failed reviews of the revisions before the reviewed one. */
  earlierFindings: EarlierFindings,
  /** The latest revisions of the map's other specs: a resolution any spec carries counts as carried. */
  otherSpecs: z.array(SpecRevisionRef),
  /**
   * The person's latest rejection of an earlier revision of the spec, with the revision it
   * rejected: it outranks earlier resolutions. Null when none was rejected.
   */
  rejection: z.strictObject({ revision: z.int().min(1), reason: RejectionReason }).nullable(),
  /**
   * The spec's revisions written from a note through the escape hatch, oldest first, each with its
   * note: a note outranks earlier resolutions as a rejection does.
   */
  noteDirectedRevisions: z.array(
    z.strictObject({ revision: z.int().min(1), note: HatchMessageText }),
  ),
});
export type ReviewSpecRequest = z.infer<typeof ReviewSpecRequest>;

/** The port behind which a spec review's call sits. */
export type ReviewSpec = (
  request: ReviewSpecRequest,
  session: PlanningCallSession,
) => Promise<Result<SpecReviewOutcome, PlanningAgentError | CancelledError | SkillMissingError>>;

/**
 * A tickets review's output: passed exactly when it has no finding; the summary within the run's
 * model's limits (`agent.models`).
 */
export function ticketsReviewOutcome(limits: ModelLimits) {
  return z.strictObject({
    summary: z.string().min(1).max(limits.ticketsReviewSummary.max),
    findings: z.array(ticketsReviewFindingDraft(limits)).max(TICKETS_REVIEW_FINDINGS_MAX_COUNT),
  });
}
export type TicketsReviewOutcome = z.infer<ReturnType<typeof ticketsReviewOutcome>>;

/** One ticket set version as a run reads it: its number and its document. */
export const TicketSetVersionRef = z.strictObject({
  version: z.int().min(1),
  content: TicketSetContent,
});
export type TicketSetVersionRef = z.infer<typeof TicketSetVersionRef>;

/**
 * A ticket set version written from what the person asked for since the set's revision was
 * approved: the reason they rejected the version before it, or the note through the escape hatch it
 * was written from. A version a review repair or the first run wrote has none.
 */
export const DirectedVersion = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("rejection"),
    version: z.int().min(2),
    reason: RejectionReason,
  }),
  z.strictObject({ kind: z.literal("note"), version: z.int().min(2), text: HatchMessageText }),
]);
export type DirectedVersion = z.infer<typeof DirectedVersion>;

/** A resolved waypoint of the map that touches the set's spec, with its resolution. */
export const TouchingWaypoint = z.strictObject({
  number: z.int().min(1),
  title: WaypointTitle,
  resolution: WaypointResolutionText,
});
export type TouchingWaypoint = z.infer<typeof TouchingWaypoint>;

/** One ticket of an earlier set of the spec, with where it was delivered or null. */
export const EarlierTicket = z.strictObject({
  id: TicketId,
  title: z.string().min(1),
  criteria: z.array(CriterionId),
  /** The revision its set was written for. */
  revision: z.int().min(1),
  delivered: z.strictObject({ run: z.int().min(1), commit: z.string().min(1) }).nullable(),
});
export type EarlierTicket = z.infer<typeof EarlierTicket>;

/** What both ticket set runs read against the text delta and the baseline. */
const Reconciliation = {
  /** What the approved revision changes from the revision before; null for revision 1. */
  delta: TextDelta.nullable(),
  /** Each criterion of the revision, and each it takes out, by id. */
  readings: z.record(CriterionId, CriterionReading),
  /**
   * Every criterion the approved revision takes out, with the clause it sat in (core's
   * `removedCriteria`): the delta's, and one dropped in a middle revision that no approved set took
   * out yet. Each needs a `removed` disposition.
   */
  takenOut: z.array(z.strictObject({ clause: Clause, criterion: Criterion })),
  /** The resolved waypoints of the map touching the spec, by number. */
  touchingWaypoints: z.array(TouchingWaypoint),
};

/**
 * The findings of a ticket set's earlier failed tickets reviews, oldest first, each with the version
 * it reviewed: the repair loop's memory, as `EarlierFindings` is a spec's. Only versions after the
 * set's latest version whose review passed count: a passed review closes the findings before it.
 * Empty when no such earlier version failed its review.
 */
export const TicketsEarlierFindings = z.array(
  z.strictObject({
    version: z.int().min(1),
    findings: z
      .array(
        TicketsReviewFinding.pick({
          kind: true,
          ticketNumbers: true,
          criterionIds: true,
          explanation: true,
        }),
      )
      .min(1),
  }),
);
export type TicketsEarlierFindings = z.infer<typeof TicketsEarlierFindings>;

/** What the planning agent needs to review one ticket set version. */
export const ReviewTicketSetRequest = z.strictObject({
  projectName: ProjectName,
  /** The project's repository; the agent reads it, read-only, as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  /** The person's idea for the map, as the spec review reads it. */
  idea: MapIdea,
  /** The approved revision the set is written for: the spec's number, and its title in the content. */
  approved: SpecRevisionRef,
  /** The version under review. */
  ticketSet: TicketSetVersionRef,
  /**
   * The set's directed versions up to the one under review, oldest first: what each asks for is the
   * person's word and counts as traced.
   */
  directedVersions: z.array(DirectedVersion),
  /** The set's failed reviews of versions before the one under review, since its last passed one. */
  earlierFindings: TicketsEarlierFindings,
  /** The map's code survey; null for a map that predates surveys. */
  survey: CodeSurvey.nullable(),
  ...Reconciliation,
});
export type ReviewTicketSetRequest = z.infer<typeof ReviewTicketSetRequest>;

/** The port behind which a tickets review's call sits. */
export type ReviewTicketSet = (
  request: ReviewTicketSetRequest,
  session: PlanningCallSession,
) => Promise<Result<TicketsReviewOutcome, PlanningAgentError | CancelledError | SkillMissingError>>;

/** What the planning agent needs to write the tickets of an approved revision. */
export const DraftTicketSetRequest = z.strictObject({
  /**
   * The map the spec came from, as To Spec reads it: its destination, Out of scope lines and every
   * resolved waypoint with a research one's findings and sources, touching the spec or not, so a
   * new spec's first set reads them too.
   */
  ...SpecMapContext,
  /** The approved revision. */
  approved: SpecRevisionRef,
  /** The id the set's first ticket takes: one past the spec's highest approved ticket. */
  firstTicketNumber: z.int().min(1),
  ...Reconciliation,
  /**
   * Each earlier approved set's tickets, by revision then ticket; a replaced or never-approved
   * set's are never listed.
   */
  earlierTickets: z.array(EarlierTicket),
  /**
   * On a rewrite: the set's current version, the failed review's findings on it (empty when it had
   * no failed review) and the person's reason, a rejection reason or a note, which outranks the
   * findings; `reason` is null on a review repair. Null for the first version.
   */
  rewrite: z
    .strictObject({
      version: z.int().min(1),
      content: TicketSetContent,
      findings: z.array(TicketsReviewFinding).max(TICKETS_REVIEW_FINDINGS_MAX_COUNT),
      reason: RejectionReason.nullable(),
      /**
       * The set's directed versions up to the current one, oldest first: a rewrite keeps what each
       * asks for, so a review repair never undoes it.
       */
      directedVersions: z.array(DirectedVersion),
    })
    .refine((rewrite) => rewrite.reason !== null || rewrite.findings.length > 0, {
      message: "A rewrite carries a reason, review findings, or both",
      path: ["reason"],
    })
    .nullable(),
  /**
   * On a rewrite, the set's failed reviews of versions before the one rewritten, since its last
   * passed one (that version's own findings are the rewrite's); empty for the first version.
   */
  earlierFindings: TicketsEarlierFindings,
  /**
   * The code and problem core refused this run's previous attempt with, so this attempt can
   * correct it; null when the previous attempt was not so refused.
   */
  refusedAttempt: z
    .strictObject({ code: z.literal("ticket_set_content_invalid"), problem: z.string().min(1) })
    .nullable(),
});
export type DraftTicketSetRequest = z.infer<typeof DraftTicketSetRequest>;

/** The port behind which a To Tickets run's call sits. */
export type DraftTicketSet = (
  request: DraftTicketSetRequest,
  session: PlanningCallSession,
) => Promise<Result<TicketSetContent, PlanningAgentError | CancelledError | SkillMissingError>>;

/** The most earlier messages a hatch request carries, the latest ones. */
export const HATCH_EARLIER_MESSAGES_MAX_COUNT = 20;

/** What runs on one spec when a hatch run starts (the `spec_in_flight` refusal and the agent's context). */
export const HatchSpecWork = z.enum([
  "spec_review",
  "to_spec",
  "to_tickets",
  "tickets_review",
  "delivery",
]);
export type HatchSpecWork = z.infer<typeof HatchSpecWork>;

/** One waypoint of the map as the hatch reads it. */
export const HatchWaypoint = z
  .strictObject({
    number: z.int().min(1),
    kind: WaypointKind,
    title: WaypointTitle,
    question: WaypointQuestion,
    status: WaypointStatus,
    /** Numbers of the waypoints that block it. */
    blockedBy: z.array(z.int().min(1)),
    /** Null until resolved. */
    resolution: WaypointResolutionText.nullable(),
    /** Null until resolved. */
    gist: WaypointGist.nullable(),
    /** Null until resolved. */
    agentDecided: WaypointAgentDecided.nullable(),
    /** Why it waits on the person after a completed run; null when it does not wait. */
    waiting: WaitingReason.nullable(),
    /**
     * The unanswered report it waits on, so an `accept_report` gist restates it; set exactly when
     * `waiting` is `research_unanswered`.
     */
    report: z
      .strictObject({
        summary: z.string().min(1).max(RESEARCH_SUMMARY_MAX_LENGTH),
        gap: z.string().min(1).max(WAYPOINT_QUESTION_MAX_LENGTH),
      })
      .nullable(),
    /**
     * Its scope stopped after a failed retry: `run_waypoint` or Try again runs it again. `waiting`
     * stays as Try again reads it.
     */
    stopped: z.boolean(),
  })
  .refine(
    (waypoint) => (waypoint.report !== null) === (waypoint.waiting === "research_unanswered"),
    {
      message: "A waypoint carries its report exactly when it waits on an unanswered report",
      path: ["report"],
    },
  );

/**
 * The tickets review of a ticket set's current version as the hatch reads it: `held` when it failed
 * with an escalated finding, `failed` when it failed without one.
 */
export const HatchTicketsReview = z.enum([
  "none",
  "running",
  "stopped",
  "passed",
  "failed",
  "held",
]);
export type HatchTicketsReview = z.infer<typeof HatchTicketsReview>;

/** A spec's current ticket set as the hatch reads it. */
const HatchTicketSet = z
  .strictObject({
    version: z.int().min(1),
    state: TicketSetState,
    review: HatchTicketsReview,
    /** Each escalated finding's title and question; set exactly when `review` is `held`. */
    heldFindings: z
      .array(TicketsReviewFinding.pick({ title: true, question: true }))
      .min(1)
      .nullable(),
  })
  .refine((set) => (set.heldFindings !== null) === (set.review === "held"), {
    message: "A ticket set carries its held findings exactly when its review is held",
    path: ["heldFindings"],
  });

/** One of the map's specs as the hatch reads it. */
const HatchSpec = z.strictObject({
  latest: SpecRevisionRef,
  state: SpecRevisionState,
  /** The current ticket-set version, its state and review; null when the spec has no ticket set. */
  ticketSet: HatchTicketSet.nullable(),
  /** What runs on the spec now; empty when nothing does. */
  inFlight: z.array(HatchSpecWork),
});

/** One message sent through the hatch: the stage and spec on screen when it was sent, and its text. */
const HatchMessage = z.strictObject({
  stage: HatchStage,
  /** The spec on screen, by number; null on Idea and Wayfinding, or when the map has no spec. */
  specNumber: z.int().min(1).nullable(),
  text: HatchMessageText,
});

/** What the planning agent needs to reply to one message through the escape hatch. */
export const ReplyThroughHatchRequest = z.strictObject({
  projectName: ProjectName,
  /** The project's repository; the agent runs with it as its working directory. */
  projectFolder: AbsolutePath,
  baseBranch: BaseBranch,
  idea: MapIdea,
  ...ProjectSuggestionContext,
  /** Null until the first chart. */
  title: MapTitle.nullable(),
  /** The proposed or confirmed destination; null until the first chart. */
  destination: MapDestination.nullable(),
  /**
   * The map-level rounds, oldest first, a pending one with null answers (the hatch reads it, never
   * changes it); empty until the first chart.
   */
  mapRounds: z.array(MapRound),
  /** Every waypoint of the map, by number. */
  waypoints: z.array(HatchWaypoint),
  /** The map's fog, by position. */
  fog: z.array(FogItem),
  /** The map's Out of scope lines, by position. */
  outOfScope: z.array(MapLine),
  /** The map's code survey; null for a map whose survey has not run (one that predates surveys, or a hatch reply before the chart). */
  survey: CodeSurvey.nullable(),
  /** The map's specs, by number. */
  specs: z.array(HatchSpec),
  /**
   * The map's open waits, by spec number, each with its note: a spec the map waits on may be one it
   * wrote no revision of.
   */
  waits: z.array(
    z.strictObject({
      specNumber: z.int().min(1),
      note: z.string().min(1).max(HATCH_MESSAGE_MAX_LENGTH),
    }),
  ),
  /** The map's earlier messages and their replies, oldest first, the latest 20 at most. */
  earlierMessages: z
    .array(HatchMessage.extend({ reply: HatchReply }))
    .max(HATCH_EARLIER_MESSAGES_MAX_COUNT),
  /** The message to reply to, with the stage and spec on screen when it was sent. */
  message: HatchMessage,
  /**
   * The problem core failed this reply's previous attempt with (`hatch_change_invalid`), so this
   * attempt can correct it; null otherwise.
   */
  refusedAttempt: z.strictObject({ problem: z.string().min(1) }).nullable(),
});
export type ReplyThroughHatchRequest = z.infer<typeof ReplyThroughHatchRequest>;

const WaypointNumber = z.int().min(1);

/**
 * The one change a hatch reply makes, told apart by `kind`. A waypoint's kind is `waypointKind`,
 * since `kind` names the change. `fog` is a fog settlement, as in `MapChanges`; fog it leaves goes
 * to the map's fog run once no waypoint is open or claimed. The spec changes carry no content: core
 * starts the spec and ticket runs that write them. `propose_map` proposes a new map (map
 * proposals): a draft idea with exactly one of its own Out of scope line (`line`) and the position
 * of an existing Out of scope line of the map it splits off (`splitsLine`); the rule is a
 * refinement, so the `--json-schema` keeps the member an object.
 */
export function hatchChange(limits: ModelLimits) {
  return z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("reopen"), waypoint: WaypointNumber }),
    z.strictObject({
      kind: z.literal("open_waypoint"),
      waypointKind: WaypointKind,
      title: draftWaypointTitle(limits),
      question: draftWaypointQuestion(limits),
      /** Numbers of existing waypoints that block the new one. */
      blockedBy: z.array(WaypointNumber),
      fog: mapChanges(limits),
    }),
    z.strictObject({
      kind: z.literal("reword"),
      waypoint: WaypointNumber,
      title: draftWaypointTitle(limits),
      question: draftWaypointQuestion(limits),
    }),
    z.strictObject({
      kind: z.literal("rule_out_of_scope"),
      waypoint: WaypointNumber,
      /** The waypoint's Out of scope line. */
      reason: draftMapLine(limits),
      fog: mapChanges(limits),
    }),
    z.strictObject({ kind: z.literal("run_waypoint"), waypoint: WaypointNumber }),
    z.strictObject({
      kind: z.literal("accept_report"),
      waypoint: WaypointNumber,
      gist: draftGist(limits),
      fog: mapChanges(limits),
    }),
    z.strictObject({ kind: z.literal("revise_spec") }),
    z.strictObject({ kind: z.literal("rewrite_tickets") }),
    z
      .strictObject({
        kind: z.literal("propose_map"),
        /** The new map's short title. */
        title: draftProposalTitle(limits),
        /** The new map's draft idea. */
        idea: draftIdea(),
        /** The proposal's own Out of scope line; null when it splits off an existing line. */
        line: draftMapLine(limits).nullable(),
        /** The position of the map's existing Out of scope line it splits off; else null. */
        splitsLine: z.int().min(1).nullable(),
      })
      .refine((change) => (change.line === null) !== (change.splitsLine === null), {
        message: "Set exactly one of line and splitsLine.",
      }),
  ]);
}
export type HatchChange = z.infer<ReturnType<typeof hatchChange>>;

/** A hatch change as stored and read back: within the stored caps, whatever model wrote it. */
export const HatchChange = hatchChange(STORED_LIMITS);

/** A hatch run's output: the reply, and the one change it states or null. */
export function hatchOutcome(limits: ModelLimits) {
  return z.strictObject({
    reply: z.string().min(1).max(limits.hatchReply.max),
    change: hatchChange(limits).nullable(),
  });
}
export type HatchOutcome = z.infer<ReturnType<typeof hatchOutcome>>;

/** The port behind which a hatch reply's call sits. */
export type ReplyThroughHatch = (
  request: ReplyThroughHatchRequest,
  session: PlanningCallSession,
) => Promise<Result<HatchOutcome, PlanningAgentError | CancelledError>>;
