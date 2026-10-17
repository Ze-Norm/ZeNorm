import {
  ActorKind,
  Answers,
  ChangeEntityType,
  ChangeOp,
  CheckResult,
  CodeSurvey,
  ConsistencyFindingKind,
  EntityId,
  HATCH_MESSAGE_MAX_LENGTH,
  HATCH_REPLY_MAX_LENGTH,
  HATCH_STAGES_WITHOUT_SPEC,
  HatchChange,
  HatchRefusal,
  HatchStage,
  MAP_IDEA_MAX_LENGTH,
  MAP_LINE_MAX_LENGTH,
  MAP_TITLE_MAX_LENGTH,
  MapProposalKind,
  MapProposalState,
  RESEARCH_SUMMARY_MAX_LENGTH,
  ResearchFinding,
  ResearchSourceKind,
  TaskOutcomeKind,
  WAYPOINT_QUESTION_MAX_LENGTH,
  WAYPOINT_RESOLUTION_MAX_LENGTH,
  WAYPOINT_TITLE_MAX_LENGTH,
  PlanningRunFailureCode,
  PlanningRunPurpose,
  PlanningRunState,
  RoundStatus,
  RoundWithdrawnReason,
  DeliveryChecks,
  DeliveryFailure,
  DeliveryPhase,
  ProjectChecks,
  ProjectFixCommands,
  PullRequestState,
  RUN_EVENT_TEXT_MAX_LENGTH,
  RUN_TICKET_SUMMARY_MAX_LENGTH,
  RunActor,
  SpecHoldKind,
  TOUCH_CRITERIA_MAX_COUNT,
  CriterionId,
  FindingRoute,
  PlanningRunCancelReason,
  SpecElementId,
  SpecReviewFindingKind,
  SpecReviewSource,
  SurveyItemChecks,
  SpecRemovals,
  SpecRevisionContent,
  RoundQuestions,
  TicketId,
  TicketSetContent,
  TicketSetState,
  TicketsReviewFindingKind,
  Verdict,
  WAYPOINT_AGENT_DECIDED_MAX_COUNT,
  WAYPOINT_GIST_MAX_LENGTH,
  WaypointAgentDecided,
  WaypointKind,
  WaypointResolvedHow,
  WaypointStatus,
} from "@zenorm/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

/**
 * A JSON document column: `JSON.stringify` on write, Zod-parsed on read. A stored value that
 * fails the schema is corrupt data, so the read throws.
 */
function zodJson<TSchema extends z.ZodType>(schema: TSchema) {
  return customType<{ data: z.output<TSchema>; driverData: string }>({
    dataType: () => "text",
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => schema.parse(JSON.parse(value)),
  });
}

const roundQuestionsColumn = zodJson(RoundQuestions);
const answersColumn = zodJson(Answers);
const specRevisionContentColumn = zodJson(SpecRevisionContent);
const specRemovalsColumn = zodJson(SpecRemovals);
const ticketSetContentColumn = zodJson(TicketSetContent);
const specReviewSourcesColumn = zodJson(z.array(SpecReviewSource));
const surveyItemChecksColumn = zodJson(SurveyItemChecks);
const specElementIdsColumn = zodJson(z.array(SpecElementId));
const findingWaypointNumbersColumn = zodJson(z.array(z.int().min(1)));
const ticketIdsColumn = zodJson(z.array(TicketId));
const criterionIdsColumn = zodJson(z.array(CriterionId));
const deliveryChecksColumn = zodJson(DeliveryChecks);
const codeSurveyColumn = zodJson(CodeSurvey);
const projectChecksColumn = zodJson(ProjectChecks);
const projectFixCommandsColumn = zodJson(ProjectFixCommands);
const checkResultsColumn = zodJson(z.array(CheckResult));
const verdictColumn = zodJson(Verdict);
const deliveryFailureColumn = zodJson(DeliveryFailure);
const researchFindingsColumn = zodJson(z.array(ResearchFinding));
/** A research report's limitations or uncertainties (slice 6b spec D1). */
const researchNotesColumn = zodJson(z.array(z.string().min(1).max(WAYPOINT_QUESTION_MAX_LENGTH)));
/** The resolved waypoints a consistency pass compared, each with its `resolved_at` (spec D5). */
const comparedColumn = zodJson(
  z.array(z.strictObject({ waypointId: EntityId, resolvedAt: z.iso.datetime() })),
);
/** The calls a waypoint's resolution names as the agent's own (0035). */
const agentDecidedColumn = zodJson(WaypointAgentDecided);
const waypointNumbersColumn = zodJson(z.array(z.int().min(1)).min(1));
const hatchChangeColumn = zodJson(HatchChange);

/**
 * One row per Project. Column rules live in the slice 1 spec's data shape; the name is not
 * stored but derived from the folder (slice 5 spec D3).
 */
export const projects = sqliteTable("projects", {
  /** UUIDv7, generated in core. */
  id: text("id").primaryKey(),
  /** The repository's top level as `realpath` resolves it. */
  folderPath: text("folder_path").notNull().unique(),
  baseBranch: text("base_branch").notNull(),
  /** ISO 8601 UTC. */
  createdAt: text("created_at").notNull(),
  /** 0–10 unique check commands (slice 8 S8-2); `[]` until saved, which blocks Start delivery. */
  requiredChecks: projectChecksColumn("required_checks").notNull(),
  /** 0–10 repair attempts a run may make; null until saved, which blocks Start delivery. */
  repairLimit: integer("repair_limit"),
  /** 0–10 unique fix commands delivery sessions may run; `[]` until saved. */
  fixCommands: projectFixCommandsColumn("fix_commands").notNull(),
});

/**
 * The one User of the instance (CONTEXT.md User; slice 9 spec D8, S9-10). The 9b migration
 * creates its one row; startup refuses zero rows (`user_missing`) or more (`user_ambiguous`). It
 * has no name, and nothing displays it (L97).
 */
export const users = sqliteTable("users", {
  /** 32 lowercase hex characters, `lower(hex(randomblob(16)))` (contracts `UserId`). */
  id: text("id").primaryKey(),
  /** ISO 8601 UTC. */
  createdAt: text("created_at").notNull(),
});

/** `column IN ('a', 'b', …)` over an enum's options, for a check constraint. */
function oneOf(column: AnySQLiteColumn, options: readonly string[]) {
  return sql`${column} IN (${sql.join(
    options.map((option) => sql.raw(`'${option}'`)),
    sql`, `,
  )})`;
}

/** A check that the named text column is at most `max` characters long. */
function maxLength(name: string, column: string, max: number) {
  return check(name, sql.raw(`length("${column}") <= ${String(max)}`));
}

/** One row per map (slice 2 spec D9; slice 6a spec D1; slice 6b spec D1). */
export const maps = sqliteTable(
  "maps",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** The person's idea, trimmed. */
    idea: text("idea").notNull(),
    /** The first chart's reading; null until charted. */
    title: text("title"),
    summary: text("summary"),
    /** Proposed by the first chart, confirmed by the next; null until charted. */
    destination: text("destination"),
    /** ISO 8601 UTC; null until the destination is confirmed. */
    destinationConfirmedAt: text("destination_confirmed_at"),
    /** ISO 8601 UTC. */
    createdAt: text("created_at").notNull(),
    /**
     * The position the map's next fog item takes (slice 6b D1, L116 (1)): positions are never
     * reused, so a stale one is refused `fog_item_unknown`. 1 on a new map.
     */
    fogNextPosition: integer("fog_next_position").notNull(),
    /**
     * The User who created the map (S9-11). Nullable in SQL (an added column, spec D9): the change
     * feed's `TEMP` trigger refuses a null (`user_id_missing`, D8), and every insert sets it.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * The map whose confirmed proposal created this one, and the run that proposed it (map
     * proposals); both null for a map the person added, and for every map that predates them.
     */
    splitFromMapId: text("split_from_map_id").references((): AnySQLiteColumn => maps.id),
    splitFromRunId: text("split_from_run_id").references((): AnySQLiteColumn => planningRuns.id),
  },
  (t) => [
    check(
      "maps_destination_confirmed_ck",
      sql`${t.destinationConfirmedAt} IS NULL OR ${t.destination} IS NOT NULL`,
    ),
  ],
);

/**
 * One row per planning run (slice 6a spec D1, D3). Its scope is its waypoint, else its map (L27):
 * at most one running run per scope (S6a-13), and one running `hatch` run per map beside it (slice 7b
 * S7b-3). Every purpose and state of `CONTEXT.md` is allowed (B43).
 */
export const planningRuns = sqliteTable(
  "planning_runs",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    /** Set for a `grilling`, `research` or `task` run. */
    waypointId: text("waypoint_id"),
    /**
     * Set exactly for a `spec_review`, `tickets_review`, `to_tickets` or spec-scoped `to_spec` run
     * (slice 7 D1); such a run's scope is its spec.
     */
    specificationId: text("specification_id").references((): AnySQLiteColumn => specifications.id),
    purpose: text("purpose").$type<PlanningRunPurpose>().notNull(),
    state: text("state").$type<PlanningRunState>().notNull(),
    /** The failed run this one retries; each run is retried at most once (S6a-12). */
    retryOfRunId: text("retry_of_run_id")
      .unique()
      .references((): AnySQLiteColumn => planningRuns.id),
    /** Set exactly when the run failed. */
    errorCode: text("error_code").$type<PlanningRunFailureCode>(),
    errorMessage: text("error_message"),
    /** Set exactly when the run was cancelled (S7-25). */
    cancelReason: text("cancel_reason").$type<PlanningRunCancelReason>(),
    /**
     * The message a `hatch` run answers (required), or whose note started a `to_spec` or
     * `to_tickets` run (S7b-13); null for every other purpose (slice 7b D1).
     */
    hatchMessageId: text("hatch_message_id").references((): AnySQLiteColumn => hatchMessages.id),
    /** ISO 8601 UTC. */
    startedAt: text("started_at").notNull(),
    /** ISO 8601 UTC; null while running. */
    endedAt: text("ended_at"),
    /**
     * The usage the Claude Code CLI's `result` reported for the run's call (`PlanningRunUsage`).
     * All null while the run runs, and for a run whose CLI printed no result: one that failed
     * before the call (spawn, auth, deadline, a missing project folder or skill) or died without a
     * result. A retry of an `error_max_turns` run resumes `session_id`.
     */
    sessionId: text("session_id"),
    resultSubtype: text("result_subtype"),
    numTurns: integer("num_turns"),
    durationMs: integer("duration_ms"),
    totalCostUsd: real("total_cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    /**
     * The User the run is attributed to (S9-11). Nullable in SQL (an added column, spec D9): the
     * change feed's `TEMP` trigger refuses a null (`user_id_missing`, D8), and every insert sets it.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    unique("planning_runs_map_id_uq").on(t.mapId, t.id),
    foreignKey({
      name: "planning_runs_waypoint_fk",
      columns: [t.mapId, t.waypointId],
      foreignColumns: [waypoints.mapId, waypoints.id],
    }),
    check("planning_runs_purpose_ck", oneOf(t.purpose, PlanningRunPurpose.options)),
    check("planning_runs_state_ck", oneOf(t.state, PlanningRunState.options)),
    check(
      "planning_runs_waypoint_purpose_ck",
      sql`(${t.waypointId} IS NOT NULL) = (${t.purpose} IN ('grilling', 'research', 'task'))`,
    ),
    check("planning_runs_ended_ck", sql`(${t.state} = 'running') = (${t.endedAt} IS NULL)`),
    check(
      "planning_runs_error_ck",
      sql`(${t.state} = 'failed') = (${t.errorCode} IS NOT NULL) AND (${t.errorCode} IS NULL) = (${t.errorMessage} IS NULL)`,
    ),
    check(
      "planning_runs_specification_purpose_ck",
      sql`${t.purpose} = 'to_spec' OR (${t.specificationId} IS NOT NULL) = (${t.purpose} IN ('spec_review', 'tickets_review', 'to_tickets'))`,
    ),
    check(
      "planning_runs_cancel_reason_ck",
      sql`(${t.state} = 'cancelled') = (${t.cancelReason} IS NOT NULL) AND (${t.cancelReason} IS NULL OR ${oneOf(t.cancelReason, PlanningRunCancelReason.options)})`,
    ),
    check(
      "planning_runs_hatch_message_ck",
      sql`CASE ${t.purpose} WHEN 'hatch' THEN ${t.hatchMessageId} IS NOT NULL WHEN 'to_spec' THEN 1 WHEN 'to_tickets' THEN 1 ELSE ${t.hatchMessageId} IS NULL END`,
    ),
    uniqueIndex("planning_runs_one_running_per_map")
      .on(t.mapId)
      .where(
        sql`${t.state} = 'running' AND ${t.waypointId} IS NULL AND ${t.specificationId} IS NULL AND ${t.purpose} <> 'hatch'`,
      ),
    // Each map's messages are answered one at a time (S7b-3), beside the map's own scope.
    uniqueIndex("planning_runs_one_running_hatch_per_map")
      .on(t.mapId)
      .where(sql`${t.state} = 'running' AND ${t.purpose} = 'hatch'`),
    uniqueIndex("planning_runs_one_running_per_specification")
      .on(t.specificationId)
      .where(sql`${t.state} = 'running' AND ${t.specificationId} IS NOT NULL`),
    uniqueIndex("planning_runs_one_running_per_waypoint")
      .on(t.waypointId)
      .where(sql`${t.state} = 'running' AND ${t.waypointId} IS NOT NULL`),
  ],
);

/**
 * One row per waypoint of a map (slice 6a spec D1). Numbered per map; the resolution columns are
 * set exactly when it is resolved, `resolved_by_run` exactly when it was resolved by a run (S6a-5).
 * No user column (B40).
 */
export const waypoints = sqliteTable(
  "waypoints",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    /** One plus the map's highest. */
    number: integer("number").notNull(),
    kind: text("kind").$type<WaypointKind>().notNull(),
    status: text("status").$type<WaypointStatus>().notNull(),
    title: text("title").notNull(),
    question: text("question").notNull(),
    /** ISO 8601 UTC; null until first claimed. */
    claimedAt: text("claimed_at"),
    resolution: text("resolution"),
    gist: text("gist"),
    /** The calls its resolution's run made without asking the person; `[]` when none (0035). */
    agentDecided: agentDecidedColumn("agent_decided"),
    /** ISO 8601 UTC. */
    resolvedAt: text("resolved_at"),
    resolvedHow: text("resolved_how").$type<WaypointResolvedHow>(),
    resolvedByRun: text("resolved_by_run").references((): AnySQLiteColumn => planningRuns.id),
    /** The planning run that charted it. */
    createdByRun: text("created_by_run")
      .notNull()
      .references((): AnySQLiteColumn => planningRuns.id),
    /** The latest hatch message that opened, reopened, reworded or directed it (S7b-10). */
    hatchMessageId: text("hatch_message_id").references((): AnySQLiteColumn => hatchMessages.id),
    /**
     * True when a planning review finding routed `decision` opened or linked it: only the person
     * can settle it, so its grilling resolves only after a round is asked (0012).
     */
    personDecides: integer("person_decides", { mode: "boolean" }).notNull(),
  },
  (t) => [
    unique("waypoints_map_number_uq").on(t.mapId, t.number),
    unique("waypoints_map_id_uq").on(t.mapId, t.id),
    check("waypoints_kind_ck", oneOf(t.kind, WaypointKind.options)),
    check("waypoints_status_ck", oneOf(t.status, WaypointStatus.options)),
    check(
      "waypoints_resolved_how_ck",
      sql`${t.resolvedHow} IS NULL OR ${oneOf(t.resolvedHow, WaypointResolvedHow.options)}`,
    ),
    check(
      "waypoints_resolution_ck",
      sql`(${t.status} = 'resolved') = (${t.resolution} IS NOT NULL) AND (${t.status} = 'resolved') = (${t.gist} IS NOT NULL) AND (${t.status} = 'resolved') = (${t.agentDecided} IS NOT NULL) AND (${t.status} = 'resolved') = (${t.resolvedAt} IS NOT NULL) AND (${t.status} = 'resolved') = (${t.resolvedHow} IS NOT NULL)`,
    ),
    check(
      "waypoints_gist_length_ck",
      sql.raw(`"gist" IS NULL OR length("gist") <= ${String(WAYPOINT_GIST_MAX_LENGTH)}`),
    ),
    check(
      "waypoints_agent_decided_count_ck",
      sql.raw(
        `"agent_decided" IS NULL OR json_array_length("agent_decided") <= ${String(WAYPOINT_AGENT_DECIDED_MAX_COUNT)}`,
      ),
    ),
    check(
      "waypoints_resolved_by_run_ck",
      sql`(${t.resolvedByRun} IS NOT NULL) = (${t.resolvedHow} IS NOT NULL AND ${t.resolvedHow} = 'run')`,
    ),
  ],
);

/**
 * One row per blocker of a waypoint (slice 6a spec D1, S6a-6): both numbers name waypoints of the
 * same map, so a cross-map blocker is impossible; a waypoint never blocks itself. Cycles are
 * refused in core.
 */
export const waypointBlockers = sqliteTable(
  "waypoint_blockers",
  {
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    /** The blocked waypoint. */
    waypointNumber: integer("waypoint_number").notNull(),
    /** The waypoint it waits on. */
    blockerNumber: integer("blocker_number").notNull(),
  },
  (t) => [
    primaryKey({
      name: "waypoint_blockers_pk",
      columns: [t.mapId, t.waypointNumber, t.blockerNumber],
    }),
    foreignKey({
      name: "waypoint_blockers_waypoint_fk",
      columns: [t.mapId, t.waypointNumber],
      foreignColumns: [waypoints.mapId, waypoints.number],
    }),
    foreignKey({
      name: "waypoint_blockers_blocker_fk",
      columns: [t.mapId, t.blockerNumber],
      foreignColumns: [waypoints.mapId, waypoints.number],
    }),
    check("waypoint_blockers_not_self_ck", sql`${t.waypointNumber} <> ${t.blockerNumber}`),
  ],
);

/**
 * One row per question round (slice 6a spec D1): on a waypoint, or map-level (`waypoint_id` null).
 * Rounds are numbered per waypoint, and map-level rounds per map; at most one pending round per
 * waypoint and one pending map-level round per map (S6a-8). The first map-level round is never
 * `final`; a follow-up may be (destination rounds, DR-9). Submitted exactly when `answers` is set.
 */
export const questionRounds = sqliteTable(
  "question_rounds",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    /** Null for a map-level round. */
    waypointId: text("waypoint_id"),
    number: integer("number").notNull(),
    final: integer("final", { mode: "boolean" }).notNull(),
    status: text("status").$type<RoundStatus>().notNull(),
    /** The planning run that asked it. */
    askedByRun: text("asked_by_run")
      .notNull()
      .references(() => planningRuns.id),
    intro: text("intro").notNull(),
    questions: roundQuestionsColumn("questions").notNull(),
    /** One answer per question, in order; null until submitted. */
    answers: answersColumn("answers"),
    /** ISO 8601 UTC. */
    askedAt: text("asked_at").notNull(),
    /** ISO 8601 UTC; null until submitted. */
    submittedAt: text("submitted_at"),
    /** ISO 8601 UTC; set exactly when withdrawn (slice 7b D1). */
    withdrawnAt: text("withdrawn_at"),
    /** Set exactly when withdrawn. */
    withdrawnReason: text("withdrawn_reason").$type<RoundWithdrawnReason>(),
  },
  (t) => [
    foreignKey({
      name: "question_rounds_waypoint_fk",
      columns: [t.mapId, t.waypointId],
      foreignColumns: [waypoints.mapId, waypoints.id],
    }),
    check("question_rounds_status_ck", oneOf(t.status, RoundStatus.options)),
    check(
      "question_rounds_answers_submitted_ck",
      sql`(${t.answers} IS NULL) = (${t.submittedAt} IS NULL)`,
    ),
    check(
      "question_rounds_submitted_status_ck",
      sql`(${t.status} = 'submitted') = (${t.submittedAt} IS NOT NULL)`,
    ),
    check(
      "question_rounds_withdrawn_ck",
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL) AND (${t.withdrawnAt} IS NULL) = (${t.withdrawnReason} IS NULL) AND (${t.withdrawnReason} IS NULL OR ${oneOf(t.withdrawnReason, RoundWithdrawnReason.options)})`,
    ),
    check(
      "question_rounds_first_map_round_not_final_ck",
      sql`${t.waypointId} IS NOT NULL OR ${t.number} > 1 OR ${t.final} = 0`,
    ),
    uniqueIndex("question_rounds_waypoint_number_uq")
      .on(t.waypointId, t.number)
      .where(sql`${t.waypointId} IS NOT NULL`),
    uniqueIndex("question_rounds_map_number_uq")
      .on(t.mapId, t.number)
      .where(sql`${t.waypointId} IS NULL`),
    uniqueIndex("question_rounds_one_pending_per_waypoint")
      .on(t.waypointId)
      .where(sql`${t.status} = 'pending' AND ${t.waypointId} IS NOT NULL`),
    uniqueIndex("question_rounds_one_pending_per_map")
      .on(t.mapId)
      .where(sql`${t.status} = 'pending' AND ${t.waypointId} IS NULL`),
  ],
);

/**
 * One row per message sent through the escape hatch (slice 7b D1): the stage and spec on screen when
 * it was sent, its text, and once replied the reply, a refusal code when core refused the change
 * (D4), and the change it applied (L147 Q1). No user column (B40).
 */
export const hatchMessages = sqliteTable(
  "hatch_messages",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    stage: text("stage").$type<HatchStage>().notNull(),
    /** The spec on screen; null on Idea and Wayfinding, or while the map has no spec. */
    specificationId: text("specification_id").references((): AnySQLiteColumn => specifications.id),
    text: text("text").notNull(),
    /** ISO 8601 UTC. */
    sentAt: text("sent_at").notNull(),
    /** The `hatch` run that replied; set exactly when replied. */
    runId: text("run_id").references((): AnySQLiteColumn => planningRuns.id),
    reply: text("reply"),
    /** Set when core refused the reply's change (D4); the reply is then core's sentence for it. */
    refusal: text("refusal").$type<HatchRefusal>(),
    /** The change core applied with the reply (D3), written in its transaction; else null. */
    change: hatchChangeColumn("change"),
    /** ISO 8601 UTC; set exactly when replied. */
    repliedAt: text("replied_at"),
  },
  (t) => [
    check("hatch_messages_stage_ck", oneOf(t.stage, HatchStage.options)),
    check(
      "hatch_messages_specification_stage_ck",
      sql`${t.specificationId} IS NULL OR ${t.stage} NOT IN (${sql.join(
        HATCH_STAGES_WITHOUT_SPEC.map((stage) => sql.raw(`'${stage}'`)),
        sql`, `,
      )})`,
    ),
    check(
      "hatch_messages_text_length_ck",
      sql.raw(`length("text") BETWEEN 1 AND ${String(HATCH_MESSAGE_MAX_LENGTH)}`),
    ),
    check(
      "hatch_messages_reply_length_ck",
      sql.raw(`"reply" IS NULL OR length("reply") BETWEEN 1 AND ${String(HATCH_REPLY_MAX_LENGTH)}`),
    ),
    check(
      "hatch_messages_replied_ck",
      sql`(${t.reply} IS NULL) = (${t.repliedAt} IS NULL) AND (${t.reply} IS NULL) = (${t.runId} IS NULL)`,
    ),
    check(
      "hatch_messages_refusal_ck",
      sql`${t.refusal} IS NULL OR (${t.reply} IS NOT NULL AND ${oneOf(t.refusal, HatchRefusal.options)})`,
    ),
    check(
      "hatch_messages_change_ck",
      sql`${t.change} IS NULL OR (${t.reply} IS NOT NULL AND ${t.refusal} IS NULL)`,
    ),
  ],
);

/** One row per spec of a project (slice 7 D1, S7-2): numbered per project; its title is its latest revision's. */
export const specifications = sqliteTable(
  "specifications",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Numbered per project from 1. */
    number: integer("number").notNull(),
  },
  (t) => [unique("specifications_project_number_uq").on(t.projectId, t.number)],
);

/**
 * One row per revision of a spec (slice 7 D1, S7-2, S7-3): numbered per spec from 1, naming the map
 * and run that wrote it. No state column: approved and superseded are timestamps, a rejection is a
 * supersession with its reason. Only a draft's content is updated: an agent's rewrite of a draft no
 * one has acted on (a review repair, a re-clear) replaces it in place, with `written_by_run` and
 * `removed`; once approved or superseded a revision never changes (L241).
 */
export const specRevisions = sqliteTable(
  "spec_revisions",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    specificationId: text("specification_id")
      .notNull()
      .references(() => specifications.id),
    /** Numbered per spec from 1. */
    revision: integer("revision").notNull(),
    /** The map that wrote it. */
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    /** The `to_spec` run that wrote its content, on `map_id`: a draft's latest rewrite (L241). */
    writtenByRun: text("written_by_run").notNull(),
    content: specRevisionContentColumn("content").notNull(),
    /**
     * The ids it drops from the revision before, with why, as a repair (`ReviseSpec`) declared
     * them; null when a map-scope To Spec run wrote it, or it is revision 1. A draft rewritten in
     * place keeps it against the revision before the draft (L241).
     */
    removed: specRemovalsColumn("removed"),
    /** ISO 8601 UTC: when it was first written; a rewrite in place keeps it (L241). */
    createdAt: text("created_at").notNull(),
    /** ISO 8601 UTC; null until approved. */
    approvedAt: text("approved_at"),
    /** ISO 8601 UTC; null until a next revision or a rejection supersedes it. */
    supersededAt: text("superseded_at"),
    /** Trimmed; set only on a revision the person rejected (which supersedes it). */
    rejectionReason: text("rejection_reason"),
  },
  (t) => [
    unique("spec_revisions_spec_revision_uq").on(t.specificationId, t.revision),
    foreignKey({
      name: "spec_revisions_run_fk",
      columns: [t.mapId, t.writtenByRun],
      foreignColumns: [planningRuns.mapId, planningRuns.id],
    }),
    check(
      "spec_revisions_single_decision_ck",
      sql`${t.approvedAt} IS NULL OR ${t.supersededAt} IS NULL`,
    ),
    check(
      "spec_revisions_rejection_reason_ck",
      sql`${t.rejectionReason} IS NULL OR ${t.supersededAt} IS NOT NULL`,
    ),
    uniqueIndex("spec_revisions_one_draft_per_spec")
      .on(t.specificationId)
      .where(sql`${t.approvedAt} IS NULL AND ${t.supersededAt} IS NULL`),
  ],
);

/**
 * One row per ticket set, written for one approved spec revision (slice 7 D1). `version` is the
 * current version; each version's content is a `ticket_set_versions` row.
 */
export const ticketSets = sqliteTable(
  "ticket_sets",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    specRevisionId: text("spec_revision_id")
      .notNull()
      .unique("ticket_sets_spec_revision_uq")
      .references(() => specRevisions.id),
    state: text("state").$type<TicketSetState>().notNull(),
    /** The current version, from 1. */
    version: integer("version").notNull(),
    /** ISO 8601 UTC. */
    createdAt: text("created_at").notNull(),
    /** ISO 8601 UTC. */
    updatedAt: text("updated_at").notNull(),
    /** ISO 8601 UTC; set exactly when `approved`. */
    approvedAt: text("approved_at"),
  },
  (t) => [
    check("ticket_sets_state_ck", oneOf(t.state, TicketSetState.options)),
    check(
      "ticket_sets_approved_ck",
      sql`(${t.state} = 'approved') = (${t.approvedAt} IS NOT NULL)`,
    ),
  ],
);

/** One row per version of a ticket set (slice 7 D1, S7-3): its content, never updated. */
export const ticketSetVersions = sqliteTable(
  "ticket_set_versions",
  {
    ticketSetId: text("ticket_set_id")
      .notNull()
      .references(() => ticketSets.id),
    version: integer("version").notNull(),
    content: ticketSetContentColumn("content").notNull(),
    /** The `to_tickets` run that wrote it. */
    writtenByRun: text("written_by_run")
      .notNull()
      .references(() => planningRuns.id),
    /** ISO 8601 UTC. */
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticketSetId, t.version] })],
);

/** The person's rejection of one ticket set version, with the reason (slice 7 D1, S7-18). */
export const ticketSetRejections = sqliteTable(
  "ticket_set_rejections",
  {
    ticketSetId: text("ticket_set_id").notNull(),
    version: integer("version").notNull(),
    /** Trimmed. */
    reason: text("reason").notNull(),
    /** ISO 8601 UTC. */
    rejectedAt: text("rejected_at").notNull(),
  },
  (t) => [
    unique("ticket_set_rejections_version_uq").on(t.ticketSetId, t.version),
    foreignKey({
      name: "ticket_set_rejections_version_fk",
      columns: [t.ticketSetId, t.version],
      foreignColumns: [ticketSetVersions.ticketSetId, ticketSetVersions.version],
    }),
  ],
);

/**
 * One row per spec review (slice 7 D1, S7-6), pinned to the revision it reviewed: `passed` exactly
 * when it has no finding; `sources` the map's closed waypoints it read. A draft rewritten in place
 * (L241) gathers one review per rewrite; its current review is the one whose run started after its
 * `written_by_run`.
 */
export const specReviews = sqliteTable(
  "spec_reviews",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    specRevisionId: text("spec_revision_id")
      .notNull()
      .references(() => specRevisions.id),
    runId: text("run_id")
      .notNull()
      .unique("spec_reviews_run_uq")
      .references(() => planningRuns.id),
    passed: integer("passed", { mode: "boolean" }).notNull(),
    summary: text("summary").notNull(),
    sources: specReviewSourcesColumn("sources").notNull(),
    /**
     * The code survey's unverifiable items the review settled from the code (RC2); null on a review
     * recorded before reviews settled them.
     */
    verified: surveyItemChecksColumn("verified"),
  },
  (t) => [index("spec_reviews_spec_revision").on(t.specRevisionId)],
);

/**
 * One row per finding of a spec review (slice 7 D1, S7-8): `waypoint_id` is the Grilling waypoint an
 * escalated finding opened or linked, set exactly when `escalated`.
 */
export const specReviewFindings = sqliteTable(
  "spec_review_findings",
  {
    reviewId: text("review_id")
      .notNull()
      .references(() => specReviews.id),
    /** From 1, in the review's order. */
    position: integer("position").notNull(),
    kind: text("kind").$type<SpecReviewFindingKind>().notNull(),
    route: text("route").$type<FindingRoute>().notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    question: text("question").notNull(),
    elementIds: specElementIdsColumn("element_ids").notNull(),
    waypointNumbers: findingWaypointNumbersColumn("waypoint_numbers").notNull(),
    escalated: integer("escalated", { mode: "boolean" }).notNull(),
    waypointId: text("waypoint_id").references(() => waypoints.id),
  },
  (t) => [
    primaryKey({ columns: [t.reviewId, t.position] }),
    check("spec_review_findings_kind_ck", oneOf(t.kind, SpecReviewFindingKind.options)),
    check("spec_review_findings_route_ck", oneOf(t.route, FindingRoute.options)),
    check("spec_review_findings_escalated_ck", sql`(${t.waypointId} IS NOT NULL) = ${t.escalated}`),
  ],
);

/**
 * One row per tickets review of a ticket set version (slice 7 D1, slice 7c S7c-2): `passed` exactly
 * when it has no finding.
 */
export const ticketsReviews = sqliteTable(
  "tickets_reviews",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    ticketSetId: text("ticket_set_id").notNull(),
    ticketSetVersion: integer("ticket_set_version").notNull(),
    runId: text("run_id")
      .notNull()
      .unique("tickets_reviews_run_uq")
      .references(() => planningRuns.id),
    passed: integer("passed", { mode: "boolean" }).notNull(),
    summary: text("summary").notNull(),
  },
  (t) => [
    unique("tickets_reviews_version_uq").on(t.ticketSetId, t.ticketSetVersion),
    foreignKey({
      name: "tickets_reviews_version_fk",
      columns: [t.ticketSetId, t.ticketSetVersion],
      foreignColumns: [ticketSetVersions.ticketSetId, ticketSetVersions.version],
    }),
  ],
);

/**
 * One row per finding of a tickets review (slice 7 D1, slice 7c D1): `route` and `question` as a
 * spec review finding has them (0009); `escalated` marks a finding that holds the set (S7c-5).
 */
export const ticketsReviewFindings = sqliteTable(
  "tickets_review_findings",
  {
    reviewId: text("review_id")
      .notNull()
      .references(() => ticketsReviews.id),
    /** From 1, in the review's order. */
    position: integer("position").notNull(),
    kind: text("kind").$type<TicketsReviewFindingKind>().notNull(),
    route: text("route").$type<FindingRoute>().notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    question: text("question").notNull(),
    ticketNumbers: ticketIdsColumn("ticket_numbers").notNull(),
    criterionIds: criterionIdsColumn("criterion_ids").notNull(),
    escalated: integer("escalated", { mode: "boolean" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reviewId, t.position] }),
    check("tickets_review_findings_kind_ck", oneOf(t.kind, TicketsReviewFindingKind.options)),
    check("tickets_review_findings_route_ck", oneOf(t.route, FindingRoute.options)),
  ],
);

/**
 * One row per delivery run of an approved ticket set (slice 4 spec D7, slice 7 D1, S7-22, slice 8
 * D1). Numbered per spec. No status column: the outcome is derived (`deliveryOutcome` in core).
 * Active while `ended_at` is null, at most one active run per project (L98); an ended run holds a
 * verdict, a failure, or neither (cancelled). `phase` is the step it is in, or ended in.
 */
export const deliveryRuns = sqliteTable(
  "delivery_runs",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    /** The project the run delivers into; its spec's. */
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    specificationId: text("specification_id")
      .notNull()
      .references(() => specifications.id),
    ticketSetId: text("ticket_set_id")
      .notNull()
      .references(() => ticketSets.id),
    /** Numbered per spec from 1. */
    number: integer("number").notNull(),
    /** The run branch, `zenorm/<spec title slug>-<spec id tail>-run-<number>`. */
    branch: text("branch").notNull(),
    /** `<runsDir>/<id>/worktree`. */
    worktreePath: text("worktree_path").notNull(),
    /** The project's base branch, pinned at the start. */
    baseBranch: text("base_branch").notNull(),
    /** The base branch's commit the run's work is measured from: a resumed run keeps its source's. */
    baseCommit: text("base_commit").notNull(),
    /**
     * The commit the run branch is created at: `baseCommit`, or the resumed run's branch head.
     * Nullable in SQL (an added column, spec D9); `0024` sets `base_commit` on the runs before it,
     * and every insert sets it.
     */
    startCommit: text("start_commit").notNull(),
    /** The failed, blocked or cancelled run this run resumes; null for a run started from clean. */
    resumedFromRunId: text("resumed_from_run_id").references(
      (): AnySQLiteColumn => deliveryRuns.id,
    ),
    /** The project's required checks, pinned at the start. */
    checks: deliveryChecksColumn("checks").notNull(),
    /** The step the run is in; kept at the end (S8-10). */
    phase: text("phase").$type<DeliveryPhase>().notNull(),
    /** ISO 8601 UTC. */
    startedAt: text("started_at").notNull(),
    /** ISO 8601 UTC; null while the run is active. */
    endedAt: text("ended_at"),
    /** Null until verifying has resolved it. */
    finalCommit: text("final_commit"),
    /** Null until the checks have run. */
    checkResults: checkResultsColumn("check_results"),
    /** Null unless the run ended passed or blocked. */
    verdict: verdictColumn("verdict"),
    /** Null unless the run ended failed. */
    failure: deliveryFailureColumn("failure"),
    /** ISO 8601 UTC; set by Mark merged once git shows the final commit in the base branch (S8-5). */
    mergedAt: text("merged_at"),
    /**
     * The User the run is attributed to (S9-11). Nullable in SQL (an added column, spec D9): the
     * change feed's `TEMP` trigger refuses a null (`user_id_missing`, D8), and every insert sets it.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * The name of the delivery executor carrying the run (`delivery.executor` at its start,
     * CR9b-6). Nullable in SQL (an added column, spec D9); `0020` sets `"local"` on the runs before
     * it, and every insert sets it.
     */
    executor: text("executor").notNull(),
    /**
     * The pull request the run opened on its project's origin repository on github.com once its
     * verdict passed (C1): its number, URL and state, all set or all null. Null on every other run,
     * and on every run from before `0030`.
     */
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prState: text("pr_state").$type<PullRequestState>(),
    /**
     * The project's repair limit, pinned at the start (0–10); null on the runs before `0033`,
     * which read as before.
     */
    repairLimit: integer("repair_limit"),
    /** The repair attempts the run made, 0 until its first; null on the runs before `0033`. */
    repairAttempts: integer("repair_attempts"),
    /**
     * The project's fix commands, pinned at the start. `0033` sets `[]` on the runs before it by
     * the column's SQL DEFAULT, which only backfills; every insert sets it.
     */
    fixCommands: projectFixCommandsColumn("fix_commands").notNull(),
  },
  (t) => [
    unique("delivery_runs_spec_number_uq").on(t.specificationId, t.number),
    check("delivery_runs_single_outcome_ck", sql`${t.verdict} IS NULL OR ${t.failure} IS NULL`),
    check(
      "delivery_runs_outcome_ended_ck",
      sql`${t.endedAt} IS NOT NULL OR (${t.verdict} IS NULL AND ${t.failure} IS NULL)`,
    ),
    check("delivery_runs_phase_ck", oneOf(t.phase, DeliveryPhase.options)),
    check(
      "delivery_runs_merged_verdict_ck",
      sql`${t.mergedAt} IS NULL OR ${t.verdict} IS NOT NULL`,
    ),
    check(
      "delivery_runs_pull_request_ck",
      sql`(${t.prNumber} IS NULL) = (${t.prUrl} IS NULL) AND (${t.prNumber} IS NULL) = (${t.prState} IS NULL)`,
    ),
    check(
      "delivery_runs_pull_request_state_ck",
      sql`${t.prState} IS NULL OR ${oneOf(t.prState, PullRequestState.options)}`,
    ),
    check(
      "delivery_runs_pull_request_verdict_ck",
      sql`${t.prNumber} IS NULL OR ${t.verdict} IS NOT NULL`,
    ),
    uniqueIndex("delivery_runs_one_active_per_project")
      .on(t.projectId)
      .where(sql`${t.endedAt} IS NULL`),
  ],
);

/**
 * One row per pinned ticket of a run started after `0010` (slice 8 D1, S8-7), inserted in the
 * start transaction in the set's order. Started and merged are recorded while the run is active.
 */
export const deliveryRunTickets = sqliteTable(
  "delivery_run_tickets",
  {
    runId: text("run_id")
      .notNull()
      .references(() => deliveryRuns.id),
    /** `T<n>`. */
    ticket: text("ticket").notNull(),
    /** The ticket's place in the pinned set, from 1. */
    position: integer("position").notNull(),
    /** ISO 8601 UTC; null until the ticket's implementer starts. */
    startedAt: text("started_at"),
    /** ISO 8601 UTC; set with `commit` when the ticket's branch is merged into the run branch. */
    mergedAt: text("merged_at"),
    /** The merged ticket branch's head. */
    commit: text("commit"),
    /** The implementer's report, cut to 1000 characters; null without one. */
    summary: text("summary"),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.ticket] }),
    check("delivery_run_tickets_ticket_ck", sql`${t.ticket} GLOB 'T[1-9]*'`),
    check(
      "delivery_run_tickets_merged_commit_ck",
      sql`(${t.mergedAt} IS NULL) = (${t.commit} IS NULL)`,
    ),
    maxLength("delivery_run_tickets_summary_length_ck", "summary", RUN_TICKET_SUMMARY_MAX_LENGTH),
  ],
);

/** One line of a run's activity (slice 8 D1, D5, S8-9), numbered per run from 1; display only. */
export const deliveryRunEvents = sqliteTable(
  "delivery_run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => deliveryRuns.id),
    /** Numbered per run from 1, `max + 1`. */
    seq: integer("seq").notNull(),
    /** ISO 8601 UTC. */
    at: text("at").notNull(),
    who: text("who").$type<RunActor>().notNull(),
    /** The ticket the line belongs to; null for a line about the whole run. */
    ticket: text("ticket"),
    /** Cut to 500 characters with "…". */
    text: text("text").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check("delivery_run_events_who_ck", oneOf(t.who, RunActor.options)),
    check(
      "delivery_run_events_text_length_ck",
      sql.raw(`length("text") BETWEEN 1 AND ${String(RUN_EVENT_TEXT_MAX_LENGTH)}`),
    ),
  ],
);

/**
 * One row per fog item of a map (slice 6b spec D1): in-scope uncertainty not yet a waypoint. A
 * graduated or excluded item's row is deleted; positions come from `maps.fog_next_position` and are
 * never reused.
 */
export const mapFog = sqliteTable(
  "map_fog",
  {
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    /** The planning run that added it. */
    createdByRun: text("created_by_run").notNull(),
  },
  (t) => [
    primaryKey({ name: "map_fog_pk", columns: [t.mapId, t.position] }),
    foreignKey({
      name: "map_fog_run_fk",
      columns: [t.mapId, t.createdByRun],
      foreignColumns: [planningRuns.mapId, planningRuns.id],
    }),
    maxLength("map_fog_text_length_ck", "text", MAP_LINE_MAX_LENGTH),
  ],
);

/**
 * One row per Out of scope line of a map (slice 6b spec D1): a waypoint's (S6b-5), at most one per
 * waypoint, or the map's (`waypoint_id` null: a chart's line or a fog item moved out of scope).
 */
export const mapExclusions = sqliteTable(
  "map_exclusions",
  {
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    waypointId: text("waypoint_id").unique("map_exclusions_waypoint_uq"),
    /** The planning run that saved it. */
    createdByRun: text("created_by_run").notNull(),
    /**
     * The map a confirmed proposal split this line's work into (map proposals); null for a plain
     * line, and for every line that predates proposals.
     */
    splitMapId: text("split_map_id").references(() => maps.id),
  },
  (t) => [
    primaryKey({ name: "map_exclusions_pk", columns: [t.mapId, t.position] }),
    foreignKey({
      name: "map_exclusions_waypoint_fk",
      columns: [t.mapId, t.waypointId],
      foreignColumns: [waypoints.mapId, waypoints.id],
    }),
    foreignKey({
      name: "map_exclusions_run_fk",
      columns: [t.mapId, t.createdByRun],
      foreignColumns: [planningRuns.mapId, planningRuns.id],
    }),
    maxLength("map_exclusions_text_length_ck", "text", MAP_LINE_MAX_LENGTH),
  ],
);

/**
 * One row per map proposal (map proposals): a Wayfinding run's or hatch run's draft idea for a new
 * map for work outside its map's destination, with exactly one of its own Out of scope line
 * (`line`), the waypoint the run ruled out (`waypoint_id`, whose line already exists) and the
 * existing line a hatch run split off (`exclusion_position`). Pending until the person confirms it
 * (`new_map_id` names the map it created) or dismisses it; never deleted.
 */
export const mapProposals = sqliteTable(
  "map_proposals",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    /** `split`: a first chart's split of the idea; `outside`: work outside the destination. */
    kind: text("kind").$type<MapProposalKind>().notNull(),
    /** The proposed map's short title, as Wayfinding heads its card. */
    title: text("title").notNull(),
    /** The draft idea, trimmed; the person's edited idea once confirmed. */
    idea: text("idea").notNull(),
    /** The proposal's own Out of scope line, saved as the map's when it is decided; else null. */
    line: text("line"),
    /** The waypoint a run ruled out with this proposal attached; else null. */
    waypointId: text("waypoint_id"),
    /** The position of the map's existing Out of scope line a hatch run split off; else null. */
    exclusionPosition: integer("exclusion_position"),
    state: text("state").$type<MapProposalState>().notNull(),
    /** The map confirming it created; set exactly when confirmed. */
    newMapId: text("new_map_id").references(() => maps.id),
    /** The planning run that proposed it. */
    createdByRun: text("created_by_run").notNull(),
    /** ISO 8601 UTC. */
    createdAt: text("created_at").notNull(),
    /** ISO 8601 UTC; set exactly when confirmed or dismissed. */
    decidedAt: text("decided_at"),
  },
  (t) => [
    foreignKey({
      name: "map_proposals_waypoint_fk",
      columns: [t.mapId, t.waypointId],
      foreignColumns: [waypoints.mapId, waypoints.id],
    }),
    foreignKey({
      name: "map_proposals_run_fk",
      columns: [t.mapId, t.createdByRun],
      foreignColumns: [planningRuns.mapId, planningRuns.id],
    }),
    foreignKey({
      name: "map_proposals_exclusion_fk",
      columns: [t.mapId, t.exclusionPosition],
      foreignColumns: [mapExclusions.mapId, mapExclusions.position],
    }),
    check("map_proposals_kind_ck", oneOf(t.kind, MapProposalKind.options)),
    check("map_proposals_state_ck", oneOf(t.state, MapProposalState.options)),
    check(
      "map_proposals_target_ck",
      sql`(${t.line} IS NOT NULL) + (${t.waypointId} IS NOT NULL) + (${t.exclusionPosition} IS NOT NULL) = 1`,
    ),
    check(
      "map_proposals_title_length_ck",
      sql.raw(`length("title") BETWEEN 1 AND ${String(MAP_TITLE_MAX_LENGTH)}`),
    ),
    check(
      "map_proposals_idea_length_ck",
      sql.raw(`length("idea") BETWEEN 1 AND ${String(MAP_IDEA_MAX_LENGTH)}`),
    ),
    check(
      "map_proposals_line_length_ck",
      sql.raw(`"line" IS NULL OR length("line") BETWEEN 1 AND ${String(MAP_LINE_MAX_LENGTH)}`),
    ),
    check(
      "map_proposals_new_map_ck",
      sql`(${t.state} = 'confirmed') = (${t.newMapId} IS NOT NULL)`,
    ),
    check("map_proposals_decided_ck", sql`(${t.state} = 'pending') = (${t.decidedAt} IS NULL)`),
    index("map_proposals_map").on(t.mapId),
  ],
);

/**
 * One row per research run's report (slice 6b spec D1, S6b-7), keyed by the run. An answered
 * report has no gap; an unanswered one names it.
 */
export const researchReports = sqliteTable(
  "research_reports",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => planningRuns.id),
    waypointId: text("waypoint_id")
      .notNull()
      .references(() => waypoints.id),
    answered: integer("answered", { mode: "boolean" }).notNull(),
    summary: text("summary").notNull(),
    gap: text("gap"),
    findings: researchFindingsColumn("findings").notNull(),
    limitations: researchNotesColumn("limitations").notNull(),
    uncertainties: researchNotesColumn("uncertainties").notNull(),
  },
  (t) => [
    check("research_reports_gap_ck", sql`${t.answered} = (${t.gap} IS NULL)`),
    maxLength("research_reports_summary_length_ck", "summary", RESEARCH_SUMMARY_MAX_LENGTH),
    check(
      "research_reports_gap_length_ck",
      sql.raw(`"gap" IS NULL OR length("gap") <= ${String(WAYPOINT_QUESTION_MAX_LENGTH)}`),
    ),
  ],
);

/** One row per source of a research report, by position (slice 6b spec D1). */
export const researchSources = sqliteTable(
  "research_sources",
  {
    reportRunId: text("report_run_id")
      .notNull()
      .references(() => researchReports.runId),
    position: integer("position").notNull(),
    kind: text("kind").$type<ResearchSourceKind>().notNull(),
    title: text("title").notNull(),
    /** Set exactly for an `external` source. */
    url: text("url"),
    excerpt: text("excerpt").notNull(),
  },
  (t) => [
    primaryKey({ name: "research_sources_pk", columns: [t.reportRunId, t.position] }),
    check("research_sources_kind_ck", oneOf(t.kind, ResearchSourceKind.options)),
    check("research_sources_url_ck", sql`(${t.kind} = 'external') = (${t.url} IS NOT NULL)`),
    maxLength("research_sources_title_length_ck", "title", 200),
    maxLength("research_sources_excerpt_length_ck", "excerpt", 2000),
  ],
);

/**
 * One row per Task run that ended `done` or `failed` (slice 6b spec D1, S6b-8). `facts` are never
 * empty: for `failed`, what stopped it.
 */
export const taskOutcomes = sqliteTable(
  "task_outcomes",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => planningRuns.id),
    waypointId: text("waypoint_id")
      .notNull()
      .references(() => waypoints.id),
    outcome: text("outcome").$type<TaskOutcomeKind>().notNull(),
    action: text("action").notNull(),
    facts: text("facts").notNull(),
  },
  (t) => [
    check("task_outcomes_outcome_ck", oneOf(t.outcome, TaskOutcomeKind.options)),
    maxLength("task_outcomes_action_length_ck", "action", WAYPOINT_QUESTION_MAX_LENGTH),
    check(
      "task_outcomes_facts_length_ck",
      sql.raw(`length("facts") BETWEEN 1 AND ${String(WAYPOINT_RESOLUTION_MAX_LENGTH)}`),
    ),
  ],
);

/**
 * One row per consistency pass of a map (slice 6b spec D1, S6b-10): the resolved waypoints it
 * compared, each with its `resolved_at` (spec D5).
 */
export const consistencyPasses = sqliteTable(
  "consistency_passes",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    runId: text("run_id").notNull().unique("consistency_passes_run_uq"),
    compared: comparedColumn("compared").notNull(),
  },
  (t) => [
    foreignKey({
      name: "consistency_passes_run_fk",
      columns: [t.mapId, t.runId],
      foreignColumns: [planningRuns.mapId, planningRuns.id],
    }),
  ],
);

/**
 * The map's current code survey (harness change #1): one row per map, written by the `survey` run
 * that produced it. `content` is the run's `CodeSurvey`, Zod-parsed on read.
 */
export const codeSurveys = sqliteTable(
  "code_surveys",
  {
    mapId: text("map_id")
      .primaryKey()
      .references(() => maps.id),
    runId: text("run_id").notNull().unique("code_surveys_run_uq"),
    content: codeSurveyColumn("content").notNull(),
    /** ISO 8601 UTC. */
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "code_surveys_run_fk",
      columns: [t.mapId, t.runId],
      foreignColumns: [planningRuns.mapId, planningRuns.id],
    }),
  ],
);

/**
 * One row per finding of a consistency pass (slice 6b spec D1, S6b-10), keyed by the Grilling
 * waypoint it opened.
 */
export const consistencyFindings = sqliteTable(
  "consistency_findings",
  {
    /** The Grilling waypoint the finding opened. */
    createdWaypointId: text("created_waypoint_id")
      .primaryKey()
      .references(() => waypoints.id),
    passId: text("pass_id")
      .notNull()
      .references(() => consistencyPasses.id),
    kind: text("kind").$type<ConsistencyFindingKind>().notNull(),
    /** The resolved waypoints it names, by number. */
    waypointNumbers: waypointNumbersColumn("waypoint_numbers").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    question: text("question").notNull(),
  },
  (t) => [
    check("consistency_findings_kind_ck", oneOf(t.kind, ConsistencyFindingKind.options)),
    maxLength("consistency_findings_title_length_ck", "title", WAYPOINT_TITLE_MAX_LENGTH),
    maxLength(
      "consistency_findings_explanation_length_ck",
      "explanation",
      WAYPOINT_RESOLUTION_MAX_LENGTH,
    ),
    maxLength("consistency_findings_question_length_ck", "question", WAYPOINT_QUESTION_MAX_LENGTH),
  ],
);

/**
 * One row per spec a charted waypoint touches (slice 8b D1, S8b-2): the spec's latest approved
 * revision when the chart named it and criteria of that revision. Only a confirming chart writes
 * one, with its waypoint; a touch never changes.
 */
export const waypointTouches = sqliteTable(
  "waypoint_touches",
  {
    waypointId: text("waypoint_id")
      .notNull()
      .references(() => waypoints.id),
    specificationId: text("specification_id")
      .notNull()
      .references(() => specifications.id),
    revision: integer("revision").notNull(),
    /** 1–12 criterion ids of that revision. */
    criteria: criterionIdsColumn("criteria").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.waypointId, t.specificationId] }),
    // A touch names a stored revision of its spec (CR-6).
    foreignKey({
      name: "waypoint_touches_revision_fk",
      columns: [t.specificationId, t.revision],
      foreignColumns: [specRevisions.specificationId, specRevisions.revision],
    }),
    check("waypoint_touches_revision_ck", sql`${t.revision} >= 1`),
    check(
      "waypoint_touches_criteria_ck",
      sql.raw(`json_array_length("criteria") BETWEEN 1 AND ${String(TOUCH_CRITERIA_MAX_COUNT)}`),
    ),
  ],
);

/**
 * One row per wait of a map on a spec another map holds (slice 8b D1, D3, S8b-5–S8b-7): the change
 * it waits to make (`note`), the hatch message it came from (a note's wait), and the hold when it
 * was recorded, written once and never updated. Released exactly when `released_by_run` names the
 * run that writes the map's revision; at most one open wait per map and spec.
 */
export const specWaits = sqliteTable(
  "spec_waits",
  {
    /** UUIDv7, generated in core. */
    id: text("id").primaryKey(),
    mapId: text("map_id")
      .notNull()
      .references(() => maps.id),
    specificationId: text("specification_id")
      .notNull()
      .references(() => specifications.id),
    note: text("note").notNull(),
    /** Set for a note's wait (S8b-7); null for a wait recorded by To Spec. */
    hatchMessageId: text("hatch_message_id").references(() => hatchMessages.id),
    /** ISO 8601 UTC. */
    since: text("since").notNull(),
    holdKind: text("hold_kind").$type<SpecHoldKind>().notNull(),
    /** The holding map. */
    holdMapId: text("hold_map_id")
      .notNull()
      .references(() => maps.id),
    holdRevision: integer("hold_revision").notNull(),
    /** ISO 8601 UTC; set with `released_by_run`. */
    releasedAt: text("released_at"),
    /** The run started by the release. */
    releasedByRun: text("released_by_run").references(() => planningRuns.id),
  },
  (t) => [
    // The hold's revision is a stored revision of the spec (CR-6).
    foreignKey({
      name: "spec_waits_hold_revision_fk",
      columns: [t.specificationId, t.holdRevision],
      foreignColumns: [specRevisions.specificationId, specRevisions.revision],
    }),
    check(
      "spec_waits_note_length_ck",
      sql.raw(`length("note") BETWEEN 1 AND ${String(HATCH_MESSAGE_MAX_LENGTH)}`),
    ),
    check("spec_waits_hold_kind_ck", oneOf(t.holdKind, SpecHoldKind.options)),
    check("spec_waits_hold_revision_ck", sql`${t.holdRevision} >= 1`),
    check("spec_waits_released_ck", sql`(${t.releasedAt} IS NULL) = (${t.releasedByRun} IS NULL)`),
    uniqueIndex("spec_waits_one_open_per_map_spec")
      .on(t.mapId, t.specificationId)
      .where(sql`${t.releasedAt} IS NULL`),
    // `releaseWaits` reads a spec's open waits; `releasedWaitOf`/`followRelease` by run (CR-5).
    index("spec_waits_open_by_spec")
      .on(t.specificationId)
      .where(sql`${t.releasedAt} IS NULL`),
    index("spec_waits_released_by_run").on(t.releasedByRun),
  ],
);

/**
 * The Actor columns' rule (domain model §3.8): a `user` names its User only, a run actor its run
 * and its User, `system` neither.
 */
function actorColumnsCheck(name: string, table: string) {
  return check(
    name,
    sql.raw(
      `CASE "${table}"."actor_kind" WHEN 'user' THEN "${table}"."actor_user_id" IS NOT NULL AND "${table}"."actor_run_id" IS NULL WHEN 'system' THEN "${table}"."actor_user_id" IS NULL AND "${table}"."actor_run_id" IS NULL ELSE "${table}"."actor_user_id" IS NOT NULL AND "${table}"."actor_run_id" IS NOT NULL END`,
    ),
  );
}

/**
 * The change feed (CONTEXT.md Change feed; slice 9 spec D10, S9-12): one row per insert, update and
 * delete on a core table, appended in the same transaction by the `TEMP` triggers `feed.ts`
 * installs. Never read to decide (S9-14): only `packages/db`, core's `writes.ts` and the server's
 * event route may import it (lint). `project_id` has no foreign key, so a deleted project's rows stay.
 */
export const changeFeed = sqliteTable(
  "change_feed",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull(),
    /** Null for a row that belongs to no map (a project, a spec, …). */
    mapId: text("map_id"),
    /** The table name. */
    entityType: text("entity_type").$type<ChangeEntityType>().notNull(),
    /** The row's key; a composite key joined with `:`. */
    entityId: text("entity_id").notNull(),
    op: text("op").$type<ChangeOp>().notNull(),
    actorKind: text("actor_kind").$type<ActorKind>().notNull(),
    actorUserId: text("actor_user_id"),
    actorRunId: text("actor_run_id"),
    /** ISO 8601 UTC. */
    at: text("at").notNull(),
  },
  (t) => [
    check("change_feed_op_ck", oneOf(t.op, ChangeOp.options)),
    check("change_feed_actor_kind_ck", oneOf(t.actorKind, ActorKind.options)),
    actorColumnsCheck("change_feed_actor_ck", "change_feed"),
  ],
);

/**
 * The Actor of the write in progress (slice 9 spec D10): core's `write(db, actor, fn)` fills its one
 * row at the start of an immediate transaction and empties it before commit; the feed triggers read
 * it, and raise `actor_missing` when it is empty.
 */
export const writeActor = sqliteTable(
  "write_actor",
  {
    /** Always 1: one row at most. */
    id: integer("id").primaryKey(),
    actorKind: text("actor_kind").$type<ActorKind>().notNull(),
    actorUserId: text("actor_user_id"),
    actorRunId: text("actor_run_id"),
  },
  (t) => [
    check("write_actor_one_row_ck", sql`${t.id} = 1`),
    check("write_actor_actor_kind_ck", oneOf(t.actorKind, ActorKind.options)),
    actorColumnsCheck("write_actor_actor_ck", "write_actor"),
  ],
);
