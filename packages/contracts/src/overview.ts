import { z } from "zod";

import { SpecRun } from "./delivery.ts";
import { HatchMessageView } from "./hatch.ts";
import { EntityId, MapRecord, MapTitle } from "./map.ts";
import { RejectionReason } from "./planning.ts";
import { Project } from "./project.ts";
import { CriterionReading, SpecHold, TextDelta } from "./revisions.ts";
import {
  Clause,
  ClauseId,
  Criterion,
  CriterionId,
  SpecReviewFinding,
  SpecRevisionContent,
  TicketSetContent,
  TicketId,
  TicketSetState,
  TicketsReviewFinding,
} from "./spec-content.ts";
import { StoppedRun, WaitingRun, Wayfinding, WaypointKind } from "./wayfinding.ts";

/** The five stages of a map, in order; the router parses a stage segment with this. */
export const Stage = z.enum(["idea", "wayfinding", "spec", "tickets", "delivery"]);
export type Stage = z.infer<typeof Stage>;

/** How a stage stands: done, waiting on you, the agent working, nothing to do yet, or not reached. */
export const StageTone = z.enum(["done", "needs-you", "working", "idle", "later"]);
export type StageTone = z.infer<typeof StageTone>;

/** One stage's tone and its one line in plain words (spec D4). */
export const StageStatus = z.strictObject({
  stage: Stage,
  tone: StageTone,
  line: z.string().min(1),
});
export type StageStatus = z.infer<typeof StageStatus>;

function stageStatusOf<TStage extends Stage>(stage: TStage) {
  return z.strictObject({ stage: z.literal(stage), tone: StageTone, line: z.string().min(1) });
}

/** Who a next action waits on: `another-map` is a wait on a spec another map holds (slice 8b S8b-16). */
export const NextActionWho = z.enum(["you", "agent", "another-map", "nobody"]);
export type NextActionWho = z.infer<typeof NextActionWho>;

/** The round a next action opens: the destination round, or a waypoint's by its number. */
export const NextActionRound = z.union([z.literal("destination"), z.int().min(1)]);
export type NextActionRound = z.infer<typeof NextActionRound>;

/**
 * The waiting run a next action's **Try again** acts on (slice 6b D7, L116 (3)), with the number of
 * the waypoint its **Open the waypoint** opens.
 */
export const NextActionWaiting = z.strictObject({
  ...WaitingRun.shape,
  waypoint: z.int().min(1),
});
export type NextActionWaiting = z.infer<typeof NextActionWaiting>;

/**
 * The button of an action that is the person's (S7b-16), named for the action as the demo's are
 * (`prototypes/web-workspace-demo/src/demo/derive.ts`): Answer a round, Try again a stopped or
 * waiting run, approve a spec ("Approve the revision" past its first revision) or its tickets, start
 * delivery, start again from clean after a run ended without passing, or mark a passed run merged
 * (slice 8 S8-5). `Merge PR` is a passed run's that opened a pull request (C5): it opens Delivery,
 * which links the pull request to merge on GitHub. `Open Delivery` is an
 * interrupted delivery run's, which the demo has no state for: it is cancelled on the Delivery page
 * before starting again. `Tell the agent how to fix it` is a held ticket set's (slice 7c D6, issue
 * 21 item 4), which the demo never reaches: it opens the hatch.
 */
export const NextActionLabel = z.enum([
  "Answer",
  "Try again",
  "Approve the spec",
  "Approve the revision",
  "Approve the tickets",
  "Start delivery",
  "Start again from clean",
  "Mark merged",
  "Merge PR",
  "Open Delivery",
  "Tell the agent how to fix it",
  "Confirm",
]);
export type NextActionLabel = z.infer<typeof NextActionLabel>;

export const NextAction = z
  .strictObject({
    who: NextActionWho,
    /** The action's button; null exactly when the action is not the person's (`who` is not `you`). */
    label: NextActionLabel.nullable(),
    stage: Stage,
    headline: z.string().min(1),
    detail: z.string().min(1).nullable(),
    /** The round the action's **Answer** opens; null when it opens none. */
    round: NextActionRound.nullable(),
    /** The stopped run the action's **Try again** acts on; null when it acts on none. */
    stopped: StoppedRun.nullable(),
    /** The waiting run the action's **Try again** acts on, as for a stopped run; null when none. */
    waiting: NextActionWaiting.nullable(),
    /** The number of the spec the action is about (slice 7 D7); null when it is about none. */
    spec: z.int().min(1).nullable(),
    /**
     * The map a wait's action is carried out on (slice 8b S8b-16), which may be this map, for its own
     * delivery run; null exactly when `who` is not `another-map`.
     */
    onMap: EntityId.nullable(),
  })
  .refine((action) => (action.onMap === null) === (action.who !== "another-map"), {
    message: "An action names the map it waits on exactly when it waits on another map",
    path: ["onMap"],
  });
export type NextAction = z.infer<typeof NextAction>;

/** The Inbox group a map is in. */
export const MapGroup = z.enum(["needs-you", "working", "quiet"]);
export type MapGroup = z.infer<typeof MapGroup>;

/**
 * A map's status, derived on every read and never stored (spec D4; interim until slice 6a):
 * one entry per stage in stage order, every needs-you and working stage as a next action in
 * stage order (one `nobody` entry for a quiet map), and the map's Inbox group.
 */
export const MapStatus = z.strictObject({
  stages: z.tuple([
    stageStatusOf("idea"),
    stageStatusOf("wayfinding"),
    stageStatusOf("spec"),
    stageStatusOf("tickets"),
    stageStatusOf("delivery"),
  ]),
  next: z.array(NextAction).min(1),
  group: MapGroup,
});
export type MapStatus = z.infer<typeof MapStatus>;

/**
 * The words of an activity line's spec link (slice 8b D2, tickets review Q1; the demo's `link.label`):
 * core sets them with the line, the web shows them.
 */
export const SpecLineLabel = z.enum([
  "Open the revision",
  "Open the tickets",
  "Open the run",
  "See what waits",
  "See what the revision changes",
]);
export type SpecLineLabel = z.infer<typeof SpecLineLabel>;

/** One line of a map's activity, derived from a stored timestamp (spec D9). */
export const ActivityLine = z
  .strictObject({
    stage: Stage,
    text: z.string().min(1),
    /** The number of the waypoint the line opens; null when it opens none. */
    waypoint: z.int().min(1).nullable(),
    /**
     * The number of the spec the line opens; null when it opens none. A `spec`-stage line opens the
     * spec's latest revision ("Open the revision", the demo's `store.tsx` note revision line, L159
     * (a)); a `tickets`-stage line opens the spec's tickets ("Open the tickets", slice 7c D10);
     * a `delivery`-stage line opens the spec's Delivery page ("Open the run", slice 8 D13).
     */
    spec: z.int().min(1).nullable(),
    /** The spec link's words; null exactly when `spec` is null. */
    specLabel: SpecLineLabel.nullable(),
    /** ISO 8601 UTC. */
    at: z.iso.datetime(),
  })
  .refine((line) => (line.spec === null) === (line.specLabel === null), {
    message: "A line has a spec link's words exactly when it carries a spec",
    path: ["specLabel"],
  });
export type ActivityLine = z.infer<typeof ActivityLine>;

/**
 * A spec revision's state, derived from its timestamps (spec D1): `draft` while undecided,
 * `approved`, `rejected` (superseded with the person's reason) or `superseded` (by a later revision).
 */
export const SpecRevisionState = z.enum(["draft", "approved", "rejected", "superseded"]);
export type SpecRevisionState = z.infer<typeof SpecRevisionState>;

/** A stored review finding as a page reads it: the agent's finding and whether it escalated. */
export const SpecReviewFindingRecord = z.strictObject({
  ...SpecReviewFinding.shape,
  escalated: z.boolean(),
  /** The number of the waypoint the escalation opened; null unless escalated. */
  waypoint: z.int().min(1).nullable(),
});
export type SpecReviewFindingRecord = z.infer<typeof SpecReviewFindingRecord>;

/**
 * A revision's planning review, after the demo's `Review`: `pending` before its run starts,
 * `running` (or awaiting its retry), `stopped` on a failed retry, `passed` with no finding, or
 * `findings`.
 */
export const SpecRevisionReview = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({ state: z.literal("running") }),
  z.strictObject({ state: z.literal("stopped"), stopped: StoppedRun }),
  z.strictObject({
    state: z.literal("passed"),
    summary: z.string().min(1),
    /** ISO 8601 UTC: when the review run ended. */
    reviewedAt: z.iso.datetime(),
  }),
  z.strictObject({
    state: z.literal("findings"),
    summary: z.string().min(1),
    findings: z.array(SpecReviewFindingRecord).min(1),
    /** ISO 8601 UTC: when the review run ended. */
    reviewedAt: z.iso.datetime(),
  }),
]);
export type SpecRevisionReview = z.infer<typeof SpecRevisionReview>;

/**
 * Where a clause comes from, resolved (slice 8b D2; the demo's `clauseSources`): a waypoint on the
 * map that wrote a revision holding the clause, that map's destination, or a note sent on that map.
 * Each names its map, so a source carried over from another map is credited to it (CR-2).
 */
export const ClauseSourceView = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("waypoint"),
    mapId: EntityId,
    mapTitle: MapTitle,
    waypointNumber: z.int().min(1),
    waypointTitle: z.string().min(1),
    /** The waypoint's kind and gist, for a ticket's references (the demo's `decisionsBehind`). */
    waypointKind: WaypointKind,
    waypointGist: z.string().min(1).nullable(),
  }),
  z.strictObject({ kind: z.literal("destination"), mapId: EntityId, mapTitle: MapTitle }),
  z.strictObject({ kind: z.literal("note"), mapId: EntityId, mapTitle: MapTitle }),
]);
export type ClauseSourceView = z.infer<typeof ClauseSourceView>;

/** The merged run that delivered a revision's set (the demo's `deliveredRun`). */
export const DeliveredRun = z.strictObject({
  number: z.int().min(1),
  commit: z.string().min(1),
});
export type DeliveredRun = z.infer<typeof DeliveredRun>;

/** One revision of a spec, after the demo's `SpecRevision`, from the stored row. */
export const SpecRevisionView = z.strictObject({
  id: EntityId,
  /** Numbered per spec from 1. */
  revision: z.int().min(1),
  /** The map that wrote it. */
  mapId: EntityId,
  mapTitle: MapTitle,
  state: SpecRevisionState,
  content: SpecRevisionContent,
  /** ISO 8601 UTC. */
  savedAt: z.iso.datetime(),
  /** ISO 8601 UTC; null unless approved. */
  approvedAt: z.iso.datetime().nullable(),
  /** ISO 8601 UTC; null unless rejected or superseded. */
  supersededAt: z.iso.datetime().nullable(),
  /** Null unless rejected. */
  rejectionReason: RejectionReason.nullable(),
  review: SpecRevisionReview,
  /** What it changes from the revision before (S8b-10); null for revision 1. */
  delta: TextDelta.nullable(),
  /**
   * Every criterion it takes out (S8b-12, core's `removedCriteria`): the delta's removed ones, and
   * one an earlier revision dropped that still has a baseline or an open carrier and no approved
   * set took out (L213 D-1), each with the clause it sat in. Its ticket set disposes of each (CR-3).
   */
  takenOut: z.array(z.strictObject({ clause: Clause, criterion: Criterion })),
  /**
   * Each clause's sources, walked back through every revision up to this one that holds the clause:
   * a revision keeps the sources of the clause it carries over and adds its own (the demo's
   * `clauseSources`). Keyed by clause id, one entry per clause of the content.
   */
  clauseSources: z.record(ClauseId, z.array(ClauseSourceView)),
  /** The merged run that delivered this revision's set, or null (the demo's `deliveredRun`). */
  deliveredRun: DeliveredRun.nullable(),
});
export type SpecRevisionView = z.infer<typeof SpecRevisionView>;

/** A rejection of one ticket set version. */
export const TicketSetRejection = z.strictObject({
  version: z.int().min(1),
  reason: RejectionReason,
  /** ISO 8601 UTC. */
  rejectedAt: z.iso.datetime(),
});
export type TicketSetRejection = z.infer<typeof TicketSetRejection>;

/** A stored tickets review finding as a page reads it: the agent's finding and whether it escalated. */
export const TicketsReviewFindingRecord = z.strictObject({
  ...TicketsReviewFinding.shape,
  escalated: z.boolean(),
});
export type TicketsReviewFindingRecord = z.infer<typeof TicketsReviewFindingRecord>;

/**
 * The tickets review of a set's current version (slice 7c D11), after the demo's `Review`, read in
 * core from one source: `pending` before its run starts, `running` (or awaiting its retry),
 * `stopped` on a failed retry, `passed` with no finding, or `findings`, `held` exactly when a
 * finding escalated (S7c-5; derived, never stored).
 */
export const TicketSetReview = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({ state: z.literal("running") }),
  z.strictObject({ state: z.literal("stopped"), stopped: StoppedRun }),
  z.strictObject({
    state: z.literal("passed"),
    summary: z.string().min(1),
    /** ISO 8601 UTC: when the review run ended. */
    reviewedAt: z.iso.datetime(),
  }),
  z
    .strictObject({
      state: z.literal("findings"),
      summary: z.string().min(1),
      findings: z.array(TicketsReviewFindingRecord).min(1),
      /** True exactly when a finding escalated: the set is held for the person (S7c-5). */
      held: z.boolean(),
      /** ISO 8601 UTC: when the review run ended. */
      reviewedAt: z.iso.datetime(),
    })
    .refine((review) => review.held === review.findings.some((finding) => finding.escalated), {
      message: "A review is held exactly when one of its findings escalated",
      path: ["held"],
    }),
]);
export type TicketSetReview = z.infer<typeof TicketSetReview>;

/**
 * The earlier delivered ticket a ticket follows up (S8b-14): that ticket, and the revision, run,
 * commit and map that delivered it.
 */
export const FollowUpView = z.strictObject({
  ticket: TicketId,
  revision: z.int().min(1),
  run: z.int().min(1),
  commit: z.string().min(1),
  mapId: EntityId,
  mapTitle: MapTitle,
});
export type FollowUpView = z.infer<typeof FollowUpView>;

/** An approved revision's ticket set, after the demo's `TicketSet`: its current version's content. */
export const TicketSetView = z.strictObject({
  id: EntityId,
  /** The number of the approved revision it was written for. */
  revision: z.int().min(1),
  state: TicketSetState,
  /** The current version, from 1. */
  version: z.int().min(1),
  content: TicketSetContent,
  /** ISO 8601 UTC: when the current version was saved. */
  savedAt: z.iso.datetime(),
  /** ISO 8601 UTC; set exactly when approved. */
  approvedAt: z.iso.datetime().nullable(),
  /** Oldest first. */
  rejections: z.array(TicketSetRejection),
  /**
   * The current version's tickets review (slice 7c D11); null for a set approved with no review
   * (slice 7's plain approval, Existing Records).
   */
  review: TicketSetReview.nullable(),
  /** Unapproved and its revision is no longer its spec's latest (S8b-9; derived). */
  replaced: z.boolean(),
  /**
   * Each criterion of the revision, and each it takes out, read against the text delta and the
   * baseline (S8b-13), by criterion id.
   */
  readings: z.record(CriterionId, CriterionReading),
  /** Each ticket with a follow-up, by ticket id, with the delivery it follows up (S8b-14). */
  followUps: z.record(TicketId, FollowUpView),
});
export type TicketSetView = z.infer<typeof TicketSetView>;

/**
 * A later revision of the spec by another map (the demo's `revisedLater`), with that map's first
 * next action's headline, from that map's status.
 */
export const RevisedLater = z.strictObject({
  revision: z.int().min(1),
  state: SpecRevisionState,
  mapId: EntityId,
  mapTitle: MapTitle,
  /** ISO 8601 UTC. */
  savedAt: z.iso.datetime(),
  headline: z.string().min(1),
});
export type RevisedLater = z.infer<typeof RevisedLater>;

/**
 * One spec the map wrote a revision of (slice 7 D7), after the demo's `Spec`: its revisions, its
 * ticket sets, whether the agent is writing tickets, and its three stages' statuses (D8).
 */
export const MapSpec = z.strictObject({
  id: EntityId,
  /** Numbered per project from 1. */
  number: z.int().min(1),
  /** The latest revision's title. */
  title: z.string().min(1),
  /** Oldest first, on every map. */
  revisions: z.array(SpecRevisionView).min(1),
  /** One per approved revision, oldest first. */
  ticketSets: z.array(TicketSetView),
  /** The spec's `to_tickets`: `running` (or awaiting its retry), `stopped`, or null when neither. */
  draftingTickets: z.union([
    z.literal("running"),
    z.strictObject({ stopped: StoppedRun }),
    z.null(),
  ]),
  stages: z.tuple([stageStatusOf("spec"), stageStatusOf("tickets"), stageStatusOf("delivery")]),
  /** The spec's delivery runs, newest first, with each pinned ticket's status (slice 8 D2). */
  runs: z.array(SpecRun),
  /** The revisions other maps wrote after this map's latest, oldest first. */
  revisedLater: z.array(RevisedLater),
});
export type MapSpec = z.infer<typeof MapSpec>;

/** A released wait's run (tickets review B6): working, or stopped with its failed retry. */
export const SpecWaitRun = z.union([z.literal("working"), z.strictObject({ stopped: StoppedRun })]);
export type SpecWaitRun = z.infer<typeof SpecWaitRun>;

/**
 * The waited spec's latest revision as a wait-only map's Spec page shows it (slice 8b E-1): its
 * number, state, writing map, when it was saved, and its content.
 */
export const WaitedRevision = z.strictObject({
  revision: z.int().min(1),
  state: SpecRevisionState,
  mapId: EntityId,
  mapTitle: MapTitle,
  /** ISO 8601 UTC. */
  savedAt: z.iso.datetime(),
  content: SpecRevisionContent,
});
export type WaitedRevision = z.infer<typeof WaitedRevision>;

/**
 * A wait of the map on a spec (slice 8b D2, D3): open, or released while the map has not yet
 * written the revision. `hold` is the live hold, null when released or when nothing holds the spec
 * while the map's own planning comes first (S8b-6; tickets review B4).
 */
export const SpecWaitView = z
  .strictObject({
    specNumber: z.int().min(1),
    specTitle: z.string().min(1),
    /** The spec's latest revision, on whichever map (E-1). */
    latest: WaitedRevision,
    note: z.string().min(1),
    /** ISO 8601 UTC. */
    since: z.iso.datetime(),
    hold: SpecHold.nullable(),
    released: z.boolean(),
    /** Null while open; the release run's state once released (tickets review B6). */
    run: SpecWaitRun.nullable(),
    /** The numbers of the map's waypoints touching the spec, ascending. */
    waypoints: z.array(z.int().min(1)),
  })
  .refine((wait) => !wait.released || wait.hold === null, {
    message: "A released wait has no hold",
    path: ["hold"],
  })
  .refine((wait) => wait.released === (wait.run !== null), {
    message: "A wait has a run exactly when it is released",
    path: ["run"],
  });
export type SpecWaitView = z.infer<typeof SpecWaitView>;

/** A map with its project and status: one row of `map.overviews`. */
export const MapOverview = z.strictObject({
  map: MapRecord,
  project: Project,
  status: MapStatus,
});
export type MapOverview = z.infer<typeof MapOverview>;

/**
 * `map.overview`, every map page's one read (spec D4): the map's overview, its activity oldest first
 * (newest last), its Wayfinding, its specs and its hatch messages.
 */
export const MapOverviewDetail = z.strictObject({
  ...MapOverview.shape,
  activity: z.array(ActivityLine),
  wayfinding: Wayfinding,
  /** The specs the map wrote a revision of, by number (slice 7 D7). */
  specs: z.array(MapSpec),
  /** The messages sent through the hatch, oldest first, each with its reply or run state (7b D6). */
  messages: z.array(HatchMessageView),
  /**
   * The spec each spec stage shows without a spec number (slice 7c D9, N-Std-2), by number: the
   * first spec that needs you on that stage, else the first being worked, else the first; null
   * while the map has written none.
   */
  defaultSpecs: z.strictObject({
    spec: z.int().min(1).nullable(),
    tickets: z.int().min(1).nullable(),
    delivery: z.int().min(1).nullable(),
  }),
  /** Each open wait of the map, and each released one whose revision it has not yet written. */
  waits: z.array(SpecWaitView),
});
export type MapOverviewDetail = z.infer<typeof MapOverviewDetail>;

/** One revision in a project spec's chain: its number, state, the map that wrote it, when. */
export const ProjectSpecRevision = z.strictObject({
  revision: z.int().min(1),
  state: SpecRevisionState,
  mapId: EntityId,
  mapTitle: MapTitle,
  /** ISO 8601 UTC. */
  savedAt: z.iso.datetime(),
});
export type ProjectSpecRevision = z.infer<typeof ProjectSpecRevision>;

/** One spec of a project as the project page lists it (slice 8b D2; the demo's `SpecRow`). */
export const ProjectSpec = z.strictObject({
  number: z.int().min(1),
  /** The latest revision's title. */
  title: z.string().min(1),
  /** Every revision, oldest first. */
  revisions: z.array(ProjectSpecRevision).min(1),
  /** The number of the spec's active delivery run (`interrupted` included), or null. */
  activeRun: z.int().min(1).nullable(),
  /** The spec's newest merged run and the revision it delivered, or null. */
  mergedRun: z.strictObject({ number: z.int().min(1), revision: z.int().min(1) }).nullable(),
});
export type ProjectSpec = z.infer<typeof ProjectSpec>;

/** `project.get`: the project with each of its specs once, by number (slice 7 D12). */
export const ProjectDetail = z.strictObject({
  ...Project.shape,
  specs: z.array(ProjectSpec),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const MapOverviewInput = z.strictObject({ mapId: EntityId });
export type MapOverviewInput = z.infer<typeof MapOverviewInput>;
