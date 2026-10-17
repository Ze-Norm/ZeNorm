import { z } from "zod";

import {
  SURVEY_TEXT_MAX_LENGTH,
  SURVEY_UNVERIFIABLE_MAX_COUNT,
  SurveyPath,
} from "./code-survey.ts";
import { EntityId } from "./map.ts";
import type { ModelLimits } from "./model-limits.ts";

import {
  WAYPOINT_QUESTION_MAX_LENGTH,
  WAYPOINT_RESOLUTION_MAX_LENGTH,
  WAYPOINT_TITLE_MAX_LENGTH,
} from "./wayfinding.ts";

// The documents To Spec, the spec review and To Tickets write (slice 7 spec D2). The shapes follow the
// demo's records (`prototypes/web-workspace-demo/src/demo/types.ts`: `SpecRevision`, `Clause`,
// `Criterion`, `Ticket`, `TicketSet`). What needs the stored map (a source resolved on the map, ids
// against earlier revisions, ticket references inside a set) is core's, not these schemas'.

export const SPEC_REVISION_TITLE_MAX_LENGTH = 120;
export const SPEC_REVISION_PROSE_MAX_LENGTH = 2000;
export const SPEC_REVISION_CLAUSES_MAX_COUNT = 12;
export const CLAUSE_TITLE_MAX_LENGTH = 120;
export const CLAUSE_TEXT_MAX_LENGTH = 1000;
export const CLAUSE_CRITERIA_MAX_COUNT = 8;
export const CRITERION_TEXT_MAX_LENGTH = 500;
/** The most existing names one clause relies on, and the most new names it adds. */
export const CLAUSE_RELIES_ON_MAX_COUNT = 8;
export const CLAUSE_ADDS_MAX_COUNT = 8;
export const CLAUSE_NAME_MAX_LENGTH = 200;
export const SPEC_OUT_OF_SCOPE_MAX_COUNT = 12;
/** One Out of scope or testing line, as long as a map's Out of scope line. */
export const CONTENT_LINE_MAX_LENGTH = 500;

export const TICKET_SET_TICKETS_MAX_COUNT = 8;
export const TICKET_CONTENT_TITLE_MAX_LENGTH = 120;
export const TICKET_BUILD_MAX_LENGTH = 3000;
export const TICKET_BLOCKERS_MAX_COUNT = 7;
export const TICKET_TESTING_MAX_COUNT = 6;
export const TICKET_OUT_OF_SCOPE_MAX_COUNT = 6;
export const TICKET_POINTERS_MAX_COUNT = 20;
export const TICKET_POINTER_MAX_LENGTH = 300;
export const DISPOSITION_TEXT_MAX_LENGTH = 1000;
export const TICKET_SET_SLICING_MAX_LENGTH = 2000;
export const TICKET_SET_EXECUTION_MAX_LENGTH = 1000;

export const SPEC_REVIEW_SUMMARY_MAX_LENGTH = 2000;
/** The tickets review's summary bound (slice 7c D2). */
export const TICKETS_REVIEW_SUMMARY_MAX_LENGTH = 2000;
export const SPEC_REVIEW_FINDINGS_MAX_COUNT = 8;

/** A clause's id, `C<n>` (the demo's `C1`, `C2`). */
export const ClauseId = z.string().regex(/^C[1-9][0-9]*$/);
export type ClauseId = z.infer<typeof ClauseId>;

/** A criterion's id, `<n>.<k>` (the demo's `1.1`, `3.1`); stable across revisions (B43). */
export const CriterionId = z.string().regex(/^[1-9][0-9]*\.[1-9][0-9]*$/);
export type CriterionId = z.infer<typeof CriterionId>;

/** A ticket's id within its set, `T<n>` (the demo's `T1`). */
export const TicketId = z.string().regex(/^T[1-9][0-9]*$/);
export type TicketId = z.infer<typeof TicketId>;

/** One Out of scope line of a spec revision or a ticket, or one testing line of a ticket. */
export const ContentLine = z.string().min(1).max(CONTENT_LINE_MAX_LENGTH);

/** `was` names the id the criterion had in the revision before, when it was moved or split. */
export const Criterion = z.strictObject({
  id: CriterionId,
  text: z.string().min(1).max(CRITERION_TEXT_MAX_LENGTH),
  was: CriterionId.optional(),
});
export type Criterion = z.infer<typeof Criterion>;

/**
 * Where a clause comes from: a waypoint resolved on the map, by number, the confirmed destination, or
 * the person's note behind a note-directed revision (S7b-11; valid on that revision or a later one).
 */
export const ClauseSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("waypoint"), number: z.int().min(1) }),
  z.strictObject({ kind: z.literal("destination") }),
  z.strictObject({ kind: z.literal("note") }),
]);
export type ClauseSource = z.infer<typeof ClauseSource>;

/**
 * Something that exists in the project that a clause's behaviour depends on (RC1): an operation,
 * state, record, procedure, code or file. Core finds `name` among FACTS' names or where the
 * project's source defines it, in the source file at `path` when one is given. Core refuses a name it cannot find, and
 * the review reads the code around each.
 */
export const ClauseReliance = z.strictObject({
  name: z.string().min(1).max(CLAUSE_NAME_MAX_LENGTH),
  path: SurveyPath.nullable(),
});
export type ClauseReliance = z.infer<typeof ClauseReliance>;

/** A name a clause introduces: a new code, state, procedure, field or cancel reason. */
export const ClauseAddition = z.string().min(1).max(CLAUSE_NAME_MAX_LENGTH);

const clauseFields = {
  id: ClauseId,
  title: z.string().min(1).max(CLAUSE_TITLE_MAX_LENGTH),
  text: z.string().min(1).max(CLAUSE_TEXT_MAX_LENGTH),
  criteria: z.array(Criterion).min(1).max(CLAUSE_CRITERIA_MAX_COUNT),
  /** A clause new in the revision names at least one (core, spec D2); a kept one may name none. */
  sources: z.array(ClauseSource),
};
const reliesOn = z.array(ClauseReliance).max(CLAUSE_RELIES_ON_MAX_COUNT);
const adds = z.array(ClauseAddition).max(CLAUSE_ADDS_MAX_COUNT);

/**
 * A clause as stored. `reliesOn` and `adds` (RC1) are absent on a revision written before clauses
 * declared them; To Spec writes both on every clause, and core requires one of them non-empty.
 */
export const Clause = z.strictObject({
  ...clauseFields,
  reliesOn: reliesOn.optional(),
  adds: adds.optional(),
});
export type Clause = z.infer<typeof Clause>;

/** One spec revision's document (spec D2; the demo's `SpecRevision` content plus its spec's title). */
export const SpecRevisionContent = z.strictObject({
  title: z.string().min(1).max(SPEC_REVISION_TITLE_MAX_LENGTH),
  problem: z.string().min(1).max(SPEC_REVISION_PROSE_MAX_LENGTH),
  solution: z.string().min(1).max(SPEC_REVISION_PROSE_MAX_LENGTH),
  clauses: z.array(Clause).min(1).max(SPEC_REVISION_CLAUSES_MAX_COUNT),
  outOfScope: z.array(ContentLine).max(SPEC_OUT_OF_SCOPE_MAX_COUNT),
});
export type SpecRevisionContent = z.infer<typeof SpecRevisionContent>;

/**
 * A spec revision as To Spec writes it: a `SpecRevisionContent` whose texts (title, problem,
 * solution, each clause's title, text, criteria and names, Out of scope lines) are within the run's
 * model's limits (`agent.models`) and whose every clause declares what it relies on and adds. They apply to the agent's output only;
 * stored revisions keep `SpecRevisionContent`'s wider bounds, so revisions written before them still
 * load. Longer output is refused, never cut.
 */
export function specRevisionDraft(limits: ModelLimits) {
  const name = z.string().min(1).max(limits.clauseName.max);
  return SpecRevisionContent.extend({
    title: z.string().min(1).max(limits.specTitle.max),
    problem: z.string().min(1).max(limits.specProse.max),
    solution: z.string().min(1).max(limits.specProse.max),
    clauses: z
      .array(
        z.strictObject({
          ...clauseFields,
          title: z.string().min(1).max(limits.clauseTitle.max),
          text: z.string().min(1).max(limits.clauseText.max),
          criteria: z
            .array(Criterion.extend({ text: z.string().min(1).max(limits.criterionText.max) }))
            .min(1)
            .max(CLAUSE_CRITERIA_MAX_COUNT),
          reliesOn: z.array(ClauseReliance.extend({ name })).max(CLAUSE_RELIES_ON_MAX_COUNT),
          adds: z.array(name).max(CLAUSE_ADDS_MAX_COUNT),
        }),
      )
      .min(1)
      .max(SPEC_REVISION_CLAUSES_MAX_COUNT),
    outOfScope: z.array(contentLine(limits)).max(SPEC_OUT_OF_SCOPE_MAX_COUNT),
  });
}

/** An Out of scope, testing or blocker line as a run writes it, within its model's limits. */
function contentLine(limits: ModelLimits) {
  return z.string().min(1).max(limits.contentLine.max);
}

/**
 * A file or test seam a ticket's work touches, as a path relative to the project's repository root
 * (`packages/core/src/delivery.ts`): one line, never absolute, never climbing out with `..`.
 */
export const TicketPointer = z
  .string()
  .min(1)
  .max(TICKET_POINTER_MAX_LENGTH)
  .regex(/^[^/\s][^\n]*$/, "A pointer is one line, relative to the repository root.")
  .refine((path) => !path.split("/").includes(".."), {
    message: "A pointer never climbs out of the repository with `..`.",
  });

/** A blocking ticket of the same set, with the behaviour or contract it supplies. */
export const TicketBlocker = z.strictObject({ ticket: TicketId, supplies: ContentLine });
export type TicketBlocker = z.infer<typeof TicketBlocker>;

export const TicketContent = z.strictObject({
  id: TicketId,
  title: z.string().min(1).max(TICKET_CONTENT_TITLE_MAX_LENGTH),
  build: z.string().min(1).max(TICKET_BUILD_MAX_LENGTH),
  blockedBy: z.array(TicketBlocker).max(TICKET_BLOCKERS_MAX_COUNT),
  /**
   * The revision's criteria the ticket carries, by id; empty only on a ticket that takes a removed
   * criterion out (core, slice 8b S8b-12).
   */
  criteria: z.array(CriterionId),
  testing: z.array(ContentLine).min(1).max(TICKET_TESTING_MAX_COUNT),
  /** The delivered ticket this one changes (a follow-up, slice 8b S8b-14); null otherwise. */
  followUp: TicketId.nullable(),
  outOfScope: z.array(ContentLine).max(TICKET_OUT_OF_SCOPE_MAX_COUNT),
  /**
   * The files and test seams the work touches, as the writer read them in the code; exempt from
   * tracing. Empty only on a ticket stored before pointers existed (migration 0014): a new set's
   * tickets name at least one (`TicketSetDraft`).
   */
  pointers: z.array(TicketPointer).max(TICKET_POINTERS_MAX_COUNT),
});
export type TicketContent = z.infer<typeof TicketContent>;

/**
 * The writer's judgment on one criterion of the revision, or on one it removes (slice 8b D2; the
 * demo's `Disposition`). What needs stored records (a delivered or deliverable ticket, a removed
 * criterion) is core's.
 */
/** The dispositions, each reason or evidence within `textMax`: the stored cap, or a run's model's limit. */
function dispositionSchema(textMax: number) {
  return z.discriminatedUnion("kind", [
    z.strictObject({
      criterion: CriterionId,
      kind: z.literal("work"),
      ticket: TicketId,
      /** Null in slice 7, as the demo's first sets. */
      reason: z.string().min(1).max(textMax).nullable(),
    }),
    z.strictObject({
      criterion: CriterionId,
      kind: z.literal("satisfied"),
      evidence: z.string().min(1).max(textMax),
    }),
    /** A ticket of an earlier revision delivered it and it still holds; a reason when its text changed. */
    z.strictObject({
      criterion: CriterionId,
      kind: z.literal("delivered"),
      ticket: TicketId,
      reason: z.string().min(1).max(textMax).nullable(),
    }),
    /**
     * An earlier revision's approved, deliverable and undelivered ticket still carries it; a reason
     * when that departs from the criterion's reading (its text changed since the ticket was written).
     */
    z.strictObject({
      criterion: CriterionId,
      kind: z.literal("retained"),
      ticket: TicketId,
      reason: z.string().min(1).max(textMax).nullable(),
    }),
    /** Removed in this revision: a ticket of this set takes it out, or none does and the reason says why. */
    z.strictObject({
      criterion: CriterionId,
      kind: z.literal("removed"),
      ticket: TicketId.nullable(),
      reason: z.string().min(1).max(textMax),
    }),
  ]);
}

export const Disposition = dispositionSchema(DISPOSITION_TEXT_MAX_LENGTH);
export type Disposition = z.infer<typeof Disposition>;

/**
 * One ticket set version's document (spec D2; the demo's `TicketSet` content). Zero tickets is a
 * revision with nothing to deliver (slice 8b S8b-15).
 */
export const TicketSetContent = z.strictObject({
  tickets: z.array(TicketContent).max(TICKET_SET_TICKETS_MAX_COUNT),
  dispositions: z.array(Disposition).min(1),
  slicing: z.string().min(1).max(TICKET_SET_SLICING_MAX_LENGTH),
  execution: z.string().min(1).max(TICKET_SET_EXECUTION_MAX_LENGTH),
});
export type TicketSetContent = z.infer<typeof TicketSetContent>;

/**
 * The bound on a set as To Tickets writes it: its ticket count. It applies to the agent's output only
 * (`TicketSetDraft`); stored sets keep `TicketSetContent`'s wider bound, so sets written before it
 * still load. Longer output is refused, never cut.
 */
export const DRAFT_TICKET_SET_TICKETS_MAX_COUNT = 5;

/**
 * A ticket set as To Tickets writes it: within the drafting bound, every ticket names at least one
 * pointer, and its texts (each ticket's title, build, blocker, testing and Out of scope lines, each
 * disposition's reason or evidence, the slicing and execution) are within the run's model's limits
 * (`agent.models`). It applies
 * to the agent's output only; stored sets keep `TicketSetContent`, so sets written before pointers
 * or these bounds load.
 */
export function ticketSetDraft(limits: ModelLimits) {
  const line = contentLine(limits);
  return TicketSetContent.extend({
    tickets: z
      .array(
        TicketContent.extend({
          title: z.string().min(1).max(limits.ticketTitle.max),
          build: z.string().min(1).max(limits.ticketBuild.max),
          blockedBy: z
            .array(TicketBlocker.extend({ supplies: line }))
            .max(TICKET_BLOCKERS_MAX_COUNT),
          testing: z.array(line).min(1).max(TICKET_TESTING_MAX_COUNT),
          outOfScope: z.array(line).max(TICKET_OUT_OF_SCOPE_MAX_COUNT),
          pointers: z.array(TicketPointer).min(1).max(TICKET_POINTERS_MAX_COUNT),
        }),
      )
      .max(DRAFT_TICKET_SET_TICKETS_MAX_COUNT),
    dispositions: z.array(dispositionSchema(limits.dispositionText.max)).min(1),
    slicing: z.string().min(1).max(limits.ticketSetSlicing.max),
    execution: z.string().min(1).max(limits.ticketSetExecution.max),
  });
}

/** The spec review's finding kinds: the planning-review skill's six (domain model 3.4). */
export const SpecReviewFindingKind = z.enum([
  "contradiction",
  "invented_scope",
  "undefined_term",
  "dropped_resolution",
  "existing_records",
  "unverifiable",
]);
export type SpecReviewFindingKind = z.infer<typeof SpecReviewFindingKind>;

/** `revise` when the sources settle the point; `decision` when the person must decide (spec D5). */
export const FindingRoute = z.enum(["revise", "decision"]);
export type FindingRoute = z.infer<typeof FindingRoute>;

/** A clause or criterion of the reviewed revision, by id; core refuses an unknown one. */
export const SpecElementId = z.union([ClauseId, CriterionId]);
export type SpecElementId = z.infer<typeof SpecElementId>;

export const SPEC_REMOVAL_REASON_MAX_LENGTH = 300;

/**
 * The clause and criterion ids a repair drops from the revision before, each with why (RC4): the
 * id of every clause and every criterion the revision before had and this one does not, a dropped
 * clause's criteria and a moved criterion's old id (`was`) included. Core refuses a repair whose
 * actual drops differ from it, either way; the review reads it.
 */
export const SpecRemovals = specRemovalsSchema(SPEC_REMOVAL_REASON_MAX_LENGTH);

/** `SpecRemovals` with each reason within `reasonMax`: the stored cap, or a run's model's limit. */
export function specRemovalsSchema(reasonMax: number) {
  return z.array(
    z.strictObject({
      id: SpecElementId,
      reason: z.string().min(1).max(reasonMax),
    }),
  );
}
export type SpecRemovals = z.infer<typeof SpecRemovals>;

export const SpecReviewFinding = z.strictObject({
  kind: SpecReviewFindingKind,
  route: FindingRoute,
  title: z.string().min(1).max(WAYPOINT_TITLE_MAX_LENGTH),
  /** Quotes the wording the finding rests on. */
  explanation: z.string().min(1).max(WAYPOINT_RESOLUTION_MAX_LENGTH),
  /** Phrased for the person, even on a revise finding. */
  question: z.string().min(1).max(WAYPOINT_QUESTION_MAX_LENGTH),
  /** The reviewed revision's clauses and criteria it names. */
  elementIds: z.array(SpecElementId),
  /** The resolved waypoints it names (a dropped resolution names its waypoint here). */
  waypointNumbers: z.array(z.int().min(1)),
});
export type SpecReviewFinding = z.infer<typeof SpecReviewFinding>;

/** A spec review finding as a run writes it: its title, explanation and question within its model's limits. */
function specReviewFindingDraft(limits: ModelLimits) {
  return SpecReviewFinding.extend({
    title: z.string().min(1).max(limits.waypointTitle.max),
    explanation: z.string().min(1).max(limits.findingExplanation.max),
    question: z.string().min(1).max(limits.waypointQuestion.max),
  });
}

/** A spec review's summary as stored (and as a repair reads it back). */
export const SpecReviewSummary = z.string().min(1).max(SPEC_REVIEW_SUMMARY_MAX_LENGTH);

/**
 * An item of the map's code survey's `unverifiable` list a spec review settled from the code (RC2):
 * the item by its 1-based position (`U1` is 1), the answer, and the file and line that show it.
 * Core refuses an item the survey does not have or a line its file does not have.
 */
export const SurveyItemCheck = z.strictObject({
  item: z.int().min(1),
  answer: z.string().min(1).max(SURVEY_TEXT_MAX_LENGTH),
  path: SurveyPath,
  line: z.int().min(1),
});
export type SurveyItemCheck = z.infer<typeof SurveyItemCheck>;

/** The survey items a spec review settled; empty when it settled none. */
export const SurveyItemChecks = z.array(SurveyItemCheck).max(SURVEY_UNVERIFIABLE_MAX_COUNT);

/**
 * A spec review's output: passed exactly when it has no finding; the summary, each finding's title,
 * explanation and question and each `verified` answer within the run's model's limits
 * (`agent.models`); `verified`, the survey's unverifiable items it settled.
 */
export function specReviewOutcome(limits: ModelLimits) {
  return z.strictObject({
    summary: z.string().min(1).max(limits.specReviewSummary.max),
    findings: z.array(specReviewFindingDraft(limits)).max(SPEC_REVIEW_FINDINGS_MAX_COUNT),
    verified: z
      .array(SurveyItemCheck.extend({ answer: z.string().min(1).max(limits.surveyText.max) }))
      .max(SURVEY_UNVERIFIABLE_MAX_COUNT),
  });
}
export type SpecReviewOutcome = z.infer<ReturnType<typeof specReviewOutcome>>;

/** A ticket set's state (domain model 3.5, L127 (2)); rejection is a row, the hold is derived. */
export const TicketSetState = z.enum([
  "awaiting_review",
  "review_passed",
  "review_failed",
  "approved",
]);
export type TicketSetState = z.infer<typeof TicketSetState>;

/**
 * The tickets review's finding kinds (spec D1); slice 7c writes them. `disposition_without_reason`
 * is a departure with no reason or one the review does not accept (slice 8b S8b-13).
 */
export const TicketsReviewFindingKind = z.enum([
  "untraced_criterion",
  "uncovered_clause",
  "contradiction",
  "unsupported_evidence",
  "disposition_without_reason",
]);
export type TicketsReviewFindingKind = z.infer<typeof TicketsReviewFindingKind>;

export const TICKETS_REVIEW_FINDINGS_MAX_COUNT = 8;
export const TICKETS_REVIEW_FINDING_TITLE_MAX_LENGTH = 120;
export const TICKETS_REVIEW_FINDING_EXPLANATION_MAX_LENGTH = 1000;
export const TICKETS_REVIEW_FINDING_QUESTION_MAX_LENGTH = 500;

/** One finding of a tickets review (slice 7c D2, D3). */
export const TicketsReviewFinding = z.strictObject({
  kind: TicketsReviewFindingKind,
  /** `revise` when the approved revision settles the point; `decision` when only the person can (D3). */
  route: FindingRoute,
  title: z.string().min(1).max(TICKETS_REVIEW_FINDING_TITLE_MAX_LENGTH),
  explanation: z.string().min(1).max(TICKETS_REVIEW_FINDING_EXPLANATION_MAX_LENGTH),
  /** Phrased for the person, even on a revise finding. */
  question: z.string().min(1).max(TICKETS_REVIEW_FINDING_QUESTION_MAX_LENGTH),
  /** The reviewed version's tickets it names, by id (`T1`). */
  ticketNumbers: z.array(TicketId),
  /** The approved revision's criteria it names, by id (`1.1`). */
  criterionIds: z.array(CriterionId),
});
export type TicketsReviewFinding = z.infer<typeof TicketsReviewFinding>;

/** A tickets review finding as a run writes it: its title, explanation and question within its model's limits. */
export function ticketsReviewFindingDraft(limits: ModelLimits) {
  return TicketsReviewFinding.extend({
    title: z.string().min(1).max(limits.ticketsReviewFindingTitle.max),
    explanation: z.string().min(1).max(limits.ticketsReviewFindingExplanation.max),
    question: z.string().min(1).max(limits.ticketsReviewFindingQuestion.max),
  });
}

/**
 * One closed waypoint of the map a spec review read (spec D1): resolved or ruled out of scope, with
 * its closing time (6b D5's form plus the out-of-scope rulings).
 */
export const SpecReviewSource = z.strictObject({
  waypointId: EntityId,
  outcome: z.enum(["resolved", "out_of_scope"]),
  /** ISO 8601 UTC. */
  closedAt: z.iso.datetime(),
});
export type SpecReviewSource = z.infer<typeof SpecReviewSource>;
