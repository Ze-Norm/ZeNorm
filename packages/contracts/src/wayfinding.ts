import { z } from "zod";

import { PlanningRunFailureCode } from "./codes.ts";
import { EntityId, MapIdea, MapTitle, QuestionRound } from "./map.ts";

export const WAYPOINT_TITLE_MAX_LENGTH = 120;
export const WAYPOINT_QUESTION_MAX_LENGTH = 1000;
export const WAYPOINT_RESOLUTION_MAX_LENGTH = 4000;
/** A resolved waypoint's one-line gist, as the map's Decisions so far shows it (S6a-5). */
export const WAYPOINT_GIST_MAX_LENGTH = 200;
/** The longest call a resolution lists as the agent's own (`agentDecided`). */
export const WAYPOINT_AGENT_DECIDED_MAX_LENGTH = 200;
/** The most calls a resolution lists as the agent's own (`agentDecided`). */
export const WAYPOINT_AGENT_DECIDED_MAX_COUNT = 3;

export const WaypointTitle = z.string().min(1).max(WAYPOINT_TITLE_MAX_LENGTH);
export const WaypointQuestion = z.string().min(1).max(WAYPOINT_QUESTION_MAX_LENGTH);
export const WaypointResolutionText = z.string().min(1).max(WAYPOINT_RESOLUTION_MAX_LENGTH);
export const WaypointGist = z.string().min(1).max(WAYPOINT_GIST_MAX_LENGTH);
/**
 * The calls a resolution's run made itself without asking the person, one short line each; empty
 * when the person decided everything. The waypoint page flags them, and the person can reopen it.
 */
export const WaypointAgentDecided = z
  .array(z.string().min(1).max(WAYPOINT_AGENT_DECIDED_MAX_LENGTH))
  .max(WAYPOINT_AGENT_DECIDED_MAX_COUNT);
export type WaypointAgentDecided = z.infer<typeof WaypointAgentDecided>;

/** A waypoint's kind (spec D1). */
export const WaypointKind = z.enum(["grilling", "research", "task"]);
export type WaypointKind = z.infer<typeof WaypointKind>;

export const WaypointStatus = z.enum(["open", "claimed", "resolved", "out_of_scope"]);
export type WaypointStatus = z.infer<typeof WaypointStatus>;

/** How a resolved waypoint was settled: by an agent run, or by ZeNorm from plain choices (D6). */
export const WaypointResolvedHow = z.enum(["run", "plain_choice"]);
export type WaypointResolvedHow = z.infer<typeof WaypointResolvedHow>;

/** A fog item's and an Out of scope line's longest text (spec D1). */
export const MAP_LINE_MAX_LENGTH = 500;

/** A research report's longest summary (spec D1). */
export const RESEARCH_SUMMARY_MAX_LENGTH = 4000;
/** A research source's longest title and excerpt, and a finding's longest detail (spec D1). */
export const RESEARCH_SOURCE_TITLE_MAX_LENGTH = 200;
export const RESEARCH_EXCERPT_MAX_LENGTH = 2000;
export const RESEARCH_FINDING_DETAIL_MAX_LENGTH = 2000;
/** A research report's longest gap, limitation or uncertainty (spec D1). */
export const RESEARCH_NOTE_MAX_LENGTH = 1000;

/** A fog item's or an Out of scope line's text. */
export const MapLine = z.string().min(1).max(MAP_LINE_MAX_LENGTH);

/** One fog item as a waypoint run reads it: its stable position and its text (spec D1). */
export const FogItem = z.strictObject({ position: z.int().min(1), text: MapLine });
export type FogItem = z.infer<typeof FogItem>;

/** Where a research source comes from (spec D1); only `external` carries a URL. */
export const ResearchSourceKind = z.enum([
  "map",
  "waypoint",
  "specification",
  "repository_file",
  "external",
]);
export type ResearchSourceKind = z.infer<typeof ResearchSourceKind>;

/** A research source with its title and excerpt bounds: the stored caps, or a run's model's limits. */
export function researchSourceSchema(titleMax: number, excerptMax: number) {
  return z
    .strictObject({
      kind: ResearchSourceKind,
      title: z.string().min(1).max(titleMax),
      /** Set exactly for an `external` source. */
      url: z.url().nullable(),
      /** The passage the findings rest on. */
      excerpt: z.string().min(1).max(excerptMax),
    })
    .refine((source) => (source.kind === "external") === (source.url !== null), {
      message: "Set url exactly for an external source.",
    });
}

export const ResearchSource = researchSourceSchema(
  RESEARCH_SOURCE_TITLE_MAX_LENGTH,
  RESEARCH_EXCERPT_MAX_LENGTH,
);
export type ResearchSource = z.infer<typeof ResearchSource>;

/** A research finding with its title and detail bounds: the stored caps, or a run's model's limits. */
export function researchFindingSchema(titleMax: number, detailMax: number) {
  return z.strictObject({
    title: z.string().min(1).max(titleMax),
    detail: z.string().min(1).max(detailMax),
    /** 1-based positions in the report's `sources`. */
    sources: z.array(z.int().min(1)),
  });
}

export const ResearchFinding = researchFindingSchema(
  WAYPOINT_TITLE_MAX_LENGTH,
  RESEARCH_FINDING_DETAIL_MAX_LENGTH,
);
export type ResearchFinding = z.infer<typeof ResearchFinding>;

/** The three problems a consistency pass looks for (`skills/wayfinder`). */
export const ConsistencyFindingKind = z.enum([
  "conflicting_surfaces",
  "undefined_term",
  "deferred_case_assumed",
]);
export type ConsistencyFindingKind = z.infer<typeof ConsistencyFindingKind>;

/** A research report's gap, limitation or uncertainty (spec D1). */
const ResearchNote = z.string().min(1).max(RESEARCH_NOTE_MAX_LENGTH);

/** A stored research report as the snapshot reads it (spec D1, D6): keyed by its run; sources by position. */
export const WaypointReport = z.strictObject({
  runId: EntityId,
  answered: z.boolean(),
  summary: z.string().min(1).max(RESEARCH_SUMMARY_MAX_LENGTH),
  /** Set exactly when unanswered. */
  gap: ResearchNote.nullable(),
  findings: z.array(ResearchFinding),
  sources: z.array(ResearchSource),
  limitations: z.array(ResearchNote),
  uncertainties: z.array(ResearchNote),
});
export type WaypointReport = z.infer<typeof WaypointReport>;

/** How a Task run ended when it asked no round (S6b-8). */
export const TaskOutcomeKind = z.enum(["done", "failed"]);
export type TaskOutcomeKind = z.infer<typeof TaskOutcomeKind>;

/** A stored task outcome as the snapshot reads it (spec D1, D6); `facts` are never empty. */
export const WaypointTaskOutcome = z.strictObject({
  runId: EntityId,
  outcome: TaskOutcomeKind,
  action: ResearchNote,
  facts: WaypointResolutionText,
});
export type WaypointTaskOutcome = z.infer<typeof WaypointTaskOutcome>;

/** The consistency finding that opened a waypoint, as the snapshot reads it (spec D1, D6). */
export const WaypointFinding = z.strictObject({
  kind: ConsistencyFindingKind,
  /** The resolved waypoints it names, by number. */
  waypointNumbers: z.array(z.int().min(1)).min(1),
  explanation: WaypointResolutionText,
});
export type WaypointFinding = z.infer<typeof WaypointFinding>;

/**
 * The planning review finding that sent a waypoint on (slice 7 S7-8, L136 (a)), as the snapshot
 * reads it: the spec's number and title, the explanation, and the clause and criterion ids named.
 */
export const WaypointReviewFinding = z.strictObject({
  spec: z.int().min(1),
  specTitle: z.string().min(1),
  explanation: WaypointResolutionText,
  elementIds: z.array(z.string().min(1)),
});
export type WaypointReviewFinding = z.infer<typeof WaypointReviewFinding>;

/**
 * One of the map's Out of scope lines (spec D6): `waypoint` is its waypoint's number, or null;
 * `splitMapId` the map a confirmed proposal split its work into, or null.
 */
export const MapOutOfScopeLine = z.strictObject({
  text: MapLine,
  waypoint: z.int().min(1).nullable(),
  splitMapId: EntityId.nullable(),
});
export type MapOutOfScopeLine = z.infer<typeof MapOutOfScopeLine>;

/**
 * Where a map proposal came from: `split` is a first chart's split of an idea too big for one map,
 * offered before the destination is confirmed; dismissing one keeps its work in this map. `outside`
 * is work a run found outside the confirmed destination; dismissing one keeps it Out of scope.
 */
export const MapProposalKind = z.enum(["split", "outside"]);
export type MapProposalKind = z.infer<typeof MapProposalKind>;

/** A map proposal is pending until the person confirms or dismisses it. */
export const MapProposalState = z.enum(["pending", "confirmed", "dismissed"]);
export type MapProposalState = z.infer<typeof MapProposalState>;

/**
 * A run's proposal of a new map for work outside its map's destination, as Wayfinding shows it: its
 * short title, the draft idea (the person's edited idea once confirmed), and exactly one of its own Out of scope line,
 * the number of the waypoint it was attached to when the run ruled that waypoint out (whose line
 * already exists), and the existing Out of scope line an escape hatch reply split off; and, once
 * confirmed, the map it created.
 */
export const MapProposal = z.strictObject({
  id: EntityId,
  kind: MapProposalKind,
  title: MapTitle,
  idea: MapIdea,
  line: MapLine.nullable(),
  waypoint: z.int().min(1).nullable(),
  /** The map's existing Out of scope line it splits off, by position, with its text; else null. */
  splitsLine: z.strictObject({ position: z.int().min(1), text: MapLine }).nullable(),
  state: MapProposalState,
  /** Set exactly when confirmed. */
  newMapId: EntityId.nullable(),
  /** The planning run that proposed it. */
  createdByRun: EntityId,
  /** ISO 8601 UTC. */
  createdAt: z.iso.datetime(),
});
export type MapProposal = z.infer<typeof MapProposal>;

/** `map.confirmProposal`'s input: the pending proposal and the person's edited idea. */
export const ConfirmProposalInput = z.strictObject({ proposalId: EntityId, idea: MapIdea });
export type ConfirmProposalInput = z.infer<typeof ConfirmProposalInput>;

/** `map.dismissProposal`'s input. */
export const DismissProposalInput = z.strictObject({ proposalId: EntityId });
export type DismissProposalInput = z.infer<typeof DismissProposalInput>;

/** A stored waypoint (spec D1). The resolution fields are set exactly when it is resolved. */
export const Waypoint = z.strictObject({
  id: EntityId,
  mapId: EntityId,
  /** One plus the map's highest when created (S6a-5). */
  number: z.int().min(1),
  kind: WaypointKind,
  status: WaypointStatus,
  title: WaypointTitle,
  question: WaypointQuestion,
  /** ISO 8601 UTC; null until first claimed. */
  claimedAt: z.iso.datetime().nullable(),
  resolution: WaypointResolutionText.nullable(),
  gist: WaypointGist.nullable(),
  agentDecided: WaypointAgentDecided.nullable(),
  /** ISO 8601 UTC. */
  resolvedAt: z.iso.datetime().nullable(),
  resolvedHow: WaypointResolvedHow.nullable(),
  /** Set exactly when `resolvedHow` is `run`. */
  resolvedByRun: EntityId.nullable(),
  /** The planning run that charted it. */
  createdByRun: EntityId,
  /** The latest hatch message that opened, reopened, reworded or directed it (S7b-10); else null. */
  hatchMessageId: EntityId.nullable(),
  /**
   * True when a planning review finding routed `decision` opened or linked it: only the person
   * settles it, so its grilling resolves or rules it out only after an answered round.
   */
  personDecides: z.boolean(),
});
export type Waypoint = z.infer<typeof Waypoint>;

/** Every planning run purpose `CONTEXT.md` names (spec D1, B43); this slice starts four. */
export const PlanningRunPurpose = z.enum([
  "chart",
  "survey",
  "grilling",
  "research",
  "task",
  "fog",
  "consistency",
  "to_spec",
  "spec_review",
  "to_tickets",
  "tickets_review",
  "hatch",
]);
export type PlanningRunPurpose = z.infer<typeof PlanningRunPurpose>;

/** A planning run's state: `asked` ends it with a question round; `cancelled` is for 7b. */
export const PlanningRunState = z.enum(["running", "asked", "completed", "failed", "cancelled"]);
export type PlanningRunState = z.infer<typeof PlanningRunState>;

/**
 * Why a run ended `cancelled`: a re-clear `to_spec` replaced a running repair (slice 7 S7-25), or a
 * hatch change reopened, reworded or ruled out its scope (slice 7b S7b-6, S7b-9).
 */
export const PlanningRunCancelReason = z.enum(["replaced", "reopened"]);
export type PlanningRunCancelReason = z.infer<typeof PlanningRunCancelReason>;

/** A stored planning run (spec D1, D3). Its scope is its waypoint, else its map (L27). */
export const PlanningRun = z.strictObject({
  id: EntityId,
  mapId: EntityId,
  /** Set for a `grilling`, `research` or `task` run, else null. */
  waypointId: EntityId.nullable(),
  /**
   * The spec a `spec_review`, `tickets_review`, `to_tickets` or spec-scoped `to_spec` run works
   * (slice 7 D1), else null.
   */
  specificationId: EntityId.nullable(),
  purpose: PlanningRunPurpose,
  state: PlanningRunState,
  /** The failed run this one retries; null for a first attempt (S6a-12). */
  retryOfRunId: EntityId.nullable(),
  /** Set exactly when the run failed. */
  errorCode: PlanningRunFailureCode.nullable(),
  errorMessage: z.string().nullable(),
  /** Set exactly when the run was cancelled (S7-25). */
  cancelReason: PlanningRunCancelReason.nullable(),
  /**
   * The hatch message the run answers (a `hatch` run, always) or whose note started it (a `to_spec`
   * or `to_tickets` run, S7b-13); else null.
   */
  hatchMessageId: EntityId.nullable(),
  /** ISO 8601 UTC. */
  startedAt: z.iso.datetime(),
  /** ISO 8601 UTC; null while running. */
  endedAt: z.iso.datetime().nullable(),
});
export type PlanningRun = z.infer<typeof PlanningRun>;

/** A scope stopped after its retry failed: the failed retry's id and code, for Try again. */
export const StoppedRun = z.strictObject({
  runId: EntityId,
  code: PlanningRunFailureCode,
});
export type StoppedRun = z.infer<typeof StoppedRun>;

/** Why a waypoint waits on the person after a completed run (slice 6b S6b-6, D6). */
export const WaitingReason = z.enum(["research_unanswered", "task_failed"]);
export type WaitingReason = z.infer<typeof WaitingReason>;

/**
 * A waiting waypoint's latest run (S6b-6): `completed` with an unanswered report or a `failed` task
 * outcome. `runId` is what **Try again** sends (S6b-12, L115).
 */
export const WaitingRun = z.strictObject({ runId: EntityId, reason: WaitingReason });
export type WaitingRun = z.infer<typeof WaitingRun>;

/**
 * A waypoint's one state as Wayfinding shows it, derived by core from the same rules that put a
 * waypoint on the frontier: resolved; ruled out of scope; its pending round waits on you; its run
 * works (or awaits its retry); its scope is stopped, or its completed run waits on you (both offer
 * Try again); it waits on its unsettled blockers (`waitsOn`, ascending); or it waits on the map's
 * code survey. An open waypoint none of these hold back is on the frontier, which the same write
 * claims, so the snapshot never carries one.
 */
export const WaypointState = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resolved") }),
  z.strictObject({ kind: z.literal("out_of_scope") }),
  z.strictObject({ kind: z.literal("waiting_on_you") }),
  z.strictObject({ kind: z.literal("working") }),
  z.strictObject({ kind: z.literal("stopped"), run: StoppedRun }),
  z.strictObject({ kind: z.literal("waiting"), run: WaitingRun }),
  z.strictObject({ kind: z.literal("blocked"), waitsOn: z.array(z.int().min(1)).min(1) }),
  z.strictObject({ kind: z.literal("waits_on_survey") }),
]);
export type WaypointState = z.infer<typeof WaypointState>;

/**
 * A spec a waypoint changes, as Wayfinding shows it (slice 8b D2; the demo's `TouchesCard`): the
 * touched revision, and each named criterion with its text in that revision and whether it was
 * delivered (its baseline, S8b-11). Criterion ids are `spec-content.ts`'s `CriterionId`, which
 * imports this module.
 */
export const WaypointTouchView = z.strictObject({
  specNumber: z.int().min(1),
  specTitle: z.string().min(1),
  revision: z.int().min(1),
  /** The map that wrote the touched revision (the demo's "Its current revision came from …"). */
  writerMapId: EntityId,
  writerMapTitle: MapTitle,
  /** Whether a merged run delivered the touched revision's set (the demo's `deliveredRun`). */
  delivered: z.boolean(),
  /** How many revisions of the spec came after the touched one, on any map. */
  laterRevisions: z.int().min(0),
  criteria: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[1-9][0-9]*\.[1-9][0-9]*$/),
        text: z.string().min(1),
        /** The title of the clause holding it in the touched revision. */
        clauseTitle: z.string().min(1),
        delivered: z.boolean(),
      }),
    )
    .min(1),
});
export type WaypointTouchView = z.infer<typeof WaypointTouchView>;

/**
 * A waypoint in the `map.overview` snapshot (slice 6a D4, slice 6b D6): its blockers' numbers, its
 * rounds, its research reports, task outcomes, opening finding, Out of scope line, and its state.
 */
export const WayfindingWaypoint = z.strictObject({
  ...Waypoint.shape,
  /** The numbers of the waypoints blocking it, ascending. */
  blockedBy: z.array(z.int().min(1)),
  /** Oldest first. */
  rounds: z.array(QuestionRound),
  /** Oldest first, each with its sources. */
  reports: z.array(WaypointReport),
  /** Oldest first. */
  taskOutcomes: z.array(WaypointTaskOutcome),
  /** The consistency finding that opened it, or null. */
  finding: WaypointFinding.nullable(),
  /** The planning review finding that sent it on, or null. */
  reviewFinding: WaypointReviewFinding.nullable(),
  /** Its Out of scope line once a run ruled it out of scope (S6b-5), else null. */
  exclusion: MapLine.nullable(),
  state: WaypointState,
  /** The specs it changes (slice 8b S8b-2), stored at charting, by spec number. */
  touches: z.array(WaypointTouchView),
});
export type WayfindingWaypoint = z.infer<typeof WayfindingWaypoint>;

/** The map's Wayfinding in the `map.overview` snapshot (spec D4). */
export const Wayfinding = z.strictObject({
  /** The map-level rounds, oldest first. */
  mapRounds: z.array(QuestionRound),
  /** By number. */
  waypoints: z.array(WayfindingWaypoint),
  /** The map's fog (Not yet specified), by position (slice 6b D6). */
  fog: z.array(FogItem),
  /** The map's Out of scope lines, by position: a waypoint's (its number) or the map's (null). */
  outOfScope: z.array(MapOutOfScopeLine),
  /** The map's proposals of new maps, oldest first, pending and decided. */
  proposals: z.array(MapProposal),
});
export type Wayfinding = z.infer<typeof Wayfinding>;

export const TryAgainInput = z.strictObject({ runId: EntityId });
export type TryAgainInput = z.infer<typeof TryAgainInput>;
