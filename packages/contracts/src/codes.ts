import { z } from "zod";

import { EntityId } from "./map.ts";
import { ActiveRun } from "./project.ts";
import type { CodedError } from "./result.ts";

/** Codes `project.inspect` returns, in the order they are checked; the first wins. */
export const InspectProjectErrorCode = z.enum([
  "project_folder_missing",
  "project_already_added",
  "project_inside_project",
  "project_not_git",
]);
export type InspectProjectErrorCode = z.infer<typeof InspectProjectErrorCode>;

/** A folder inside a stored project's repository: its repository's top level is that project's folder. */
const ProjectContainmentErrorData = z.strictObject({
  /** The folder's realpath. */
  folderPath: z.string(),
  /** The stored project the folder is inside. */
  projectId: EntityId,
  projectFolderPath: z.string(),
});

/** Typed detail carried by each `project.inspect` refusal. */
export const InspectProjectErrorData = {
  /** `folderPath` as the person entered it. */
  project_folder_missing: z.strictObject({ folderPath: z.string() }),
  /** `folderPath` is the realpath already stored by another project. */
  project_already_added: z.strictObject({ folderPath: z.string() }),
  project_inside_project: ProjectContainmentErrorData,
  /** `folderPath` as entered; `repositoryTopLevel` is the enclosing repository's top level, or null outside any repository. */
  project_not_git: z.strictObject({
    folderPath: z.string(),
    repositoryTopLevel: z.string().nullable(),
  }),
} satisfies Record<InspectProjectErrorCode, z.ZodType>;

export type InspectProjectError = {
  [C in InspectProjectErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof InspectProjectErrorData)[C]>;
  };
}[InspectProjectErrorCode];

/** Codes `project.create` returns: the inspection's, then the branch rule's. */
export const CreateProjectErrorCode = z.enum([
  ...InspectProjectErrorCode.options,
  "project_branch_invalid",
  "project_branch_missing",
]);
export type CreateProjectErrorCode = z.infer<typeof CreateProjectErrorCode>;

/** Typed detail carried by each `project.create` refusal. */
export const CreateProjectErrorData = {
  ...InspectProjectErrorData,
  /** `baseBranch` fails `git check-ref-format --branch`. */
  project_branch_invalid: z.strictObject({ baseBranch: z.string() }),
  /** The repository has a commit and `baseBranch` names no local branch with one. */
  project_branch_missing: z.strictObject({ baseBranch: z.string() }),
} satisfies Record<CreateProjectErrorCode, z.ZodType>;

export type CreateProjectError = {
  [C in CreateProjectErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof CreateProjectErrorData)[C]>;
  };
}[CreateProjectErrorCode];

/** A project id that names no stored project. */
export const ProjectNotFoundErrorData = z.strictObject({ projectId: EntityId });
export type ProjectNotFoundError = CodedError<"project_not_found"> & {
  readonly data: z.infer<typeof ProjectNotFoundErrorData>;
};

/** A map id that names no stored map. */
export const MapNotFoundErrorData = z.strictObject({ mapId: EntityId });
export type MapNotFoundError = CodedError<"map_not_found"> & {
  readonly data: z.infer<typeof MapNotFoundErrorData>;
};

/** Codes the planning agent returns when it cannot produce a question round. */
export const PlanningAgentErrorCode = z.enum([
  "agent_cli_missing",
  "agent_not_logged_in",
  "agent_run_failed",
  "agent_timed_out",
  "agent_output_invalid",
]);
export type PlanningAgentErrorCode = z.infer<typeof PlanningAgentErrorCode>;

/** Typed detail carried by each planning agent failure. */
export const PlanningAgentErrorData = {
  /** The configured `claudePath` could not be spawned. */
  agent_cli_missing: z.strictObject({ claudePath: z.string() }),
  agent_not_logged_in: z.strictObject({}),
  /** `exitCode` is null when the process ended by signal; `subtype` is the result's, or null without one. */
  agent_run_failed: z.strictObject({
    exitCode: z.int().nullable(),
    subtype: z.string().nullable(),
  }),
  agent_timed_out: z.strictObject({ timeoutSeconds: z.int() }),
  agent_output_invalid: z.strictObject({}),
} satisfies Record<PlanningAgentErrorCode, z.ZodType>;

export type PlanningAgentError = {
  [C in PlanningAgentErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof PlanningAgentErrorData)[C]>;
  };
}[PlanningAgentErrorCode];

/** Codes `map.create` returns for expected refusals; it never waits on the agent. */
export const CreateMapErrorCode = z.enum(["project_not_found", "project_folder_missing"]);
export type CreateMapErrorCode = z.infer<typeof CreateMapErrorCode>;

export const CreateMapErrorData = {
  project_not_found: ProjectNotFoundErrorData,
  /** `folderPath` is the stored project's folder. */
  project_folder_missing: CreateProjectErrorData.project_folder_missing,
} satisfies Record<CreateMapErrorCode, z.ZodType>;

export type CreateMapError = {
  [C in CreateMapErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof CreateMapErrorData)[C]>;
  };
}[CreateMapErrorCode];

/** A proposal id that names no stored map proposal, or one already confirmed or dismissed. */
const ProposalErrorData = z.strictObject({ proposalId: EntityId });

/**
 * Codes `map.confirmProposal` returns, in the order they are checked: an unknown proposal, one
 * already decided, `map.create`'s refusals for the new map, then `exclusion_already_split` when the
 * Out of scope line the proposal links (the one it names, or its waypoint's) is already linked to a
 * map. Each writes nothing, so the proposal stays pending.
 */
export const ConfirmProposalErrorCode = z.enum([
  "proposal_not_found",
  "proposal_already_decided",
  ...CreateMapErrorCode.options,
  "exclusion_already_split",
]);
export type ConfirmProposalErrorCode = z.infer<typeof ConfirmProposalErrorCode>;

export const ConfirmProposalErrorData = {
  proposal_not_found: ProposalErrorData,
  proposal_already_decided: ProposalErrorData,
  ...CreateMapErrorData,
  exclusion_already_split: ProposalErrorData,
} satisfies Record<ConfirmProposalErrorCode, z.ZodType>;

export type ConfirmProposalError = {
  [C in ConfirmProposalErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof ConfirmProposalErrorData)[C]>;
  };
}[ConfirmProposalErrorCode];

/** Codes `map.dismissProposal` returns; each writes nothing. */
export const DismissProposalErrorCode = z.enum(["proposal_not_found", "proposal_already_decided"]);
export type DismissProposalErrorCode = z.infer<typeof DismissProposalErrorCode>;

export const DismissProposalErrorData = {
  proposal_not_found: ProposalErrorData,
  proposal_already_decided: ProposalErrorData,
} satisfies Record<DismissProposalErrorCode, z.ZodType>;

export type DismissProposalError = {
  [C in DismissProposalErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof DismissProposalErrorData)[C]>;
  };
}[DismissProposalErrorCode];

/**
 * Codes `map.delete` returns, in the order they are checked; each writes nothing. A map that wrote
 * a spec revision is refused (`map_wrote_spec`) unless the delete names its specs too: specs are
 * the project's, revised across maps, and their ticket sets and delivery runs hang off them. Deleting
 * the specs too is refused while another map has worked on one (`map_spec_shared`), or one has a
 * delivery run in flight, merged, or with its pull request open (`map_spec_delivered`): a run that
 * ended unmerged with its pull request closed, or none, goes with its spec, and another map's link
 * to the spec's page is left as its text. A map with a planning run in flight is refused
 * (`map_run_in_flight`), as is a map another map was split from or into (`map_split_linked`), and
 * a map another map's wait records as holding a spec (`map_waited_on`).
 */
export const DeleteMapErrorCode = z.enum([
  "map_not_found",
  "map_wrote_spec",
  "map_spec_shared",
  "map_spec_delivered",
  "map_run_in_flight",
  "map_split_linked",
  "map_waited_on",
]);
export type DeleteMapErrorCode = z.infer<typeof DeleteMapErrorCode>;

export const DeleteMapErrorData = {
  map_not_found: MapNotFoundErrorData,
  /** The numbers of the specs the map wrote a revision of. */
  map_wrote_spec: z.strictObject({ mapId: EntityId, specs: z.array(z.int().min(1)).min(1) }),
  /** The spec the map wrote that another map also worked on, and that map. */
  map_spec_shared: z.strictObject({ mapId: EntityId, spec: z.int().min(1), otherMapId: EntityId }),
  /**
   * The spec the map wrote with a delivery run that cannot go with it, the run, and why: it is in
   * flight (`active`), its work was merged (`merged`), or its pull request is open (`pr_open`).
   */
  map_spec_delivered: z.strictObject({
    mapId: EntityId,
    spec: z.int().min(1),
    runId: EntityId,
    reason: z.enum(["active", "merged", "pr_open"]),
  }),
  /** The run in flight on the map. */
  map_run_in_flight: z.strictObject({ mapId: EntityId, runId: EntityId }),
  /** The map split from this one, or the one this one split from. */
  map_split_linked: z.strictObject({ mapId: EntityId, linkedMapId: EntityId }),
  /** The map whose wait (open or released) records this one as holding the spec. */
  map_waited_on: z.strictObject({ mapId: EntityId, waitingMapId: EntityId }),
} satisfies Record<DeleteMapErrorCode, z.ZodType>;

export type DeleteMapError = {
  [C in DeleteMapErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof DeleteMapErrorData)[C]>;
  };
}[DeleteMapErrorCode];

/** Codes `questionRound.submit` returns for expected refusals. */
export const SubmitAnswersErrorCode = z.enum([
  "round_not_found",
  "round_answers_invalid",
  "round_already_submitted",
  "round_split_undecided",
]);
export type SubmitAnswersErrorCode = z.infer<typeof SubmitAnswersErrorCode>;

export const SubmitAnswersErrorData = {
  round_not_found: z.strictObject({ roundId: EntityId }),
  /** `questionIndex` is the first invalid answer's question, or null when the answer count is wrong. */
  round_answers_invalid: z.strictObject({
    roundId: EntityId,
    questionIndex: z.int().min(0).nullable(),
  }),
  /** The round is no longer pending. */
  round_already_submitted: z.strictObject({ roundId: EntityId }),
  /** A map-level round sent while a map the first chart offered to split off is undecided. */
  round_split_undecided: z.strictObject({ roundId: EntityId }),
} satisfies Record<SubmitAnswersErrorCode, z.ZodType>;

export type SubmitAnswersError = {
  [C in SubmitAnswersErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof SubmitAnswersErrorData)[C]>;
  };
}[SubmitAnswersErrorCode];

/** Codes a confirming chart's blockers are refused with; nothing is written. */
export const WaypointBlockerErrorCode = z.enum([
  "waypoint_blocker_unknown",
  "waypoint_blocker_cycle",
]);
export type WaypointBlockerErrorCode = z.infer<typeof WaypointBlockerErrorCode>;

/**
 * Codes a waypoint run's map changes, a write's fog, a consistency pass's findings and a confirming
 * chart's touches are refused with; nothing is written.
 */
export const MapChangesErrorCode = z.enum([
  "fog_item_unknown",
  "fog_left_unsettled",
  "fog_settled_without_resolution",
  "consistency_waypoint_unknown",
  "touch_reference_unknown",
]);
export type MapChangesErrorCode = z.infer<typeof MapChangesErrorCode>;

/**
 * Codes a spec, ticket set or review run's output is refused with; nothing is written: a spec
 * revision breaking its document's shape or the id rules, a ticket set breaking its shape, a review
 * naming an element or waypoint the revision or map does not have, and a tickets review missing a
 * `disposition_without_reason` finding for a reasonless departure.
 */
export const SpecOutputErrorCode = z.enum([
  "spec_content_invalid",
  "ticket_set_content_invalid",
  "review_reference_unknown",
  "review_departure_missed",
]);
export type SpecOutputErrorCode = z.infer<typeof SpecOutputErrorCode>;

/**
 * The code a `survey` run's output is refused with; nothing is written: an area, fact or identifier
 * naming a path the project does not have, or a line past its file's end.
 */
export const SurveyOutputErrorCode = z.enum(["survey_source_unknown"]);
export type SurveyOutputErrorCode = z.infer<typeof SurveyOutputErrorCode>;

/**
 * The code a planning run fails with, stored on the run: the planning agent's codes, a missing
 * project folder, a refused output or map change, a run left running at startup,
 * `planning_run_internal_error` for a port that threw, and a hatch change naming an unknown
 * waypoint, fog position or a blocker cycle (`hatch_change_invalid`).
 */
export const PlanningRunFailureCode = z.enum([
  ...PlanningAgentErrorCode.options,
  "project_folder_missing",
  ...WaypointBlockerErrorCode.options,
  ...MapChangesErrorCode.options,
  "agent_skill_missing",
  ...SpecOutputErrorCode.options,
  ...SurveyOutputErrorCode.options,
  "planning_run_interrupted",
  "planning_run_internal_error",
  "hatch_change_invalid",
]);
export type PlanningRunFailureCode = z.infer<typeof PlanningRunFailureCode>;

/** Codes `planningRun.tryAgain` returns for expected refusals. */
export const TryAgainErrorCode = z.enum(["planning_run_not_found", "planning_run_not_stopped"]);
export type TryAgainErrorCode = z.infer<typeof TryAgainErrorCode>;

export const TryAgainErrorData = {
  planning_run_not_found: z.strictObject({ runId: EntityId }),
  /** The run is not a failed retry that is its scope's latest run. */
  planning_run_not_stopped: z.strictObject({ runId: EntityId }),
} satisfies Record<TryAgainErrorCode, z.ZodType>;

export type TryAgainError = {
  [C in TryAgainErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof TryAgainErrorData)[C]>;
  };
}[TryAgainErrorCode];

/**
 * Codes `spec.approve` returns, in the order they are checked; `spec.reject` checks the first four.
 * Each writes nothing.
 */
export const SpecDecisionErrorCode = z.enum([
  "spec_revision_not_found",
  "spec_revision_decided",
  "map_uncleared",
  "review_in_flight",
  "spec_review_not_passed",
]);
export type SpecDecisionErrorCode = z.infer<typeof SpecDecisionErrorCode>;

const SpecRevisionErrorData = z.strictObject({ specRevisionId: EntityId });

export const SpecDecisionErrorData = {
  spec_revision_not_found: SpecRevisionErrorData,
  /** Not the spec's latest draft: approved, superseded, or a later revision exists. */
  spec_revision_decided: SpecRevisionErrorData,
  /** The revision's map is un-cleared, or its map-scope `to_spec` runs. */
  map_uncleared: SpecRevisionErrorData,
  /** The revision's review is running or due. */
  review_in_flight: SpecRevisionErrorData,
  /** The revision's review did not pass. */
  spec_review_not_passed: SpecRevisionErrorData,
} satisfies Record<SpecDecisionErrorCode, z.ZodType>;

export type SpecDecisionError = {
  [C in SpecDecisionErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof SpecDecisionErrorData)[C]>;
  };
}[SpecDecisionErrorCode];

/**
 * Codes `ticketSet.approve` and `ticketSet.reject` return, in the order they are checked.
 */
export const TicketSetDecisionErrorCode = z.enum([
  "ticket_set_not_found",
  "ticket_set_decided",
  "revision_not_latest",
  "review_in_flight",
  "ticket_set_review_not_passed",
]);
export type TicketSetDecisionErrorCode = z.infer<typeof TicketSetDecisionErrorCode>;

const TicketSetErrorData = z.strictObject({ ticketSetId: EntityId });

export const TicketSetDecisionErrorData = {
  ticket_set_not_found: TicketSetErrorData,
  /** The set is approved. */
  ticket_set_decided: TicketSetErrorData,
  /** The set's revision is no longer its spec's latest: the set is replaced. */
  revision_not_latest: TicketSetErrorData,
  /**
   * The set's `to_tickets` or `tickets_review` runs or awaits its retry, or a `to_tickets` stopped
   * after a failed retry.
   */
  review_in_flight: TicketSetErrorData,
  /** The current version's review did not pass: none yet, stopped, failed or held. */
  ticket_set_review_not_passed: TicketSetErrorData,
} satisfies Record<TicketSetDecisionErrorCode, z.ZodType>;

export type TicketSetDecisionError = {
  [C in TicketSetDecisionErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof TicketSetDecisionErrorData)[C]>;
  };
}[TicketSetDecisionErrorCode];

/**
 * Codes a delivery session (`ImplementTicketSet`, `ReviewDelivery`) returns: the planning agent's
 * five codes, `agent_skill_missing` and `agent_cancelled`.
 */
export const DeliveryAgentErrorCode = z.enum([
  ...PlanningAgentErrorCode.options,
  "agent_skill_missing",
  "agent_cancelled",
]);
export type DeliveryAgentErrorCode = z.infer<typeof DeliveryAgentErrorCode>;

export const DeliveryAgentErrorData = {
  ...PlanningAgentErrorData,
  /** `skillPath` is the absolute path of the SKILL.md that does not exist. */
  agent_skill_missing: z.strictObject({ skillPath: z.string() }),
  /** The abort signal fired; the session was stopped. */
  agent_cancelled: z.strictObject({}),
} satisfies Record<DeliveryAgentErrorCode, z.ZodType>;

export type DeliveryAgentError = {
  [C in DeliveryAgentErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof DeliveryAgentErrorData)[C]>;
  };
}[DeliveryAgentErrorCode];

/**
 * Codes `delivery.start` returns for expected refusals, in the order they are checked; each writes
 * nothing.
 */
export const StartDeliveryErrorCode = z.enum([
  "ticket_set_not_found",
  "ticket_set_not_approved",
  "delivery_nothing_to_deliver",
  "delivery_already_passed",
  "project_folder_missing",
  "project_branch_missing",
  "project_checks_missing",
  "project_repair_limit_missing",
  "delivery_in_progress",
  "delivery_branch_exists",
  "delivery_not_admitted",
]);
export type StartDeliveryErrorCode = z.infer<typeof StartDeliveryErrorCode>;

/** A ticket set id whose ticket set is not in the state the request needs; `ticketSetId` names it. */
const TicketSetStateErrorData = z.strictObject({ ticketSetId: EntityId });

export const StartDeliveryErrorData = {
  ticket_set_not_found: TicketSetDecisionErrorData.ticket_set_not_found,
  ticket_set_not_approved: TicketSetStateErrorData,
  /** The approved set has no ticket. */
  delivery_nothing_to_deliver: TicketSetStateErrorData,
  /** The ticket set already has a passed run. */
  delivery_already_passed: TicketSetStateErrorData,
  /** `folderPath` is the stored project's folder. */
  project_folder_missing: CreateProjectErrorData.project_folder_missing,
  /** The stored base branch has no commit. */
  project_branch_missing: CreateProjectErrorData.project_branch_missing,
  /** The project has no required checks. */
  project_checks_missing: ProjectNotFoundErrorData,
  /** The project has no saved repair limit. */
  project_repair_limit_missing: ProjectNotFoundErrorData,
  /** The project's active run, `interrupted` included. */
  delivery_in_progress: ActiveRun,
  /** `branch` is the run branch that already exists in the project's repository. */
  delivery_branch_exists: z.strictObject({ branch: z.string() }),
  /**
   * The run admission seam refused the start; `reason` is the refusing wrapper's sentence, shown on
   * the page as the message is. Core always admits.
   */
  delivery_not_admitted: z.strictObject({ reason: z.string().min(1) }),
} satisfies Record<StartDeliveryErrorCode, z.ZodType>;

export type StartDeliveryError = {
  [C in StartDeliveryErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof StartDeliveryErrorData)[C]>;
  };
}[StartDeliveryErrorCode];

/** Codes `project.saveSettings` returns for expected refusals; each writes nothing. */
export const SaveProjectSettingsErrorCode = z.enum([
  "project_not_found",
  "project_branch_invalid",
  "project_check_invalid",
  "project_fix_command_invalid",
  "project_app_settings_incomplete",
  "project_app_url_invalid",
  "project_app_command_invalid",
]);
export type SaveProjectSettingsErrorCode = z.infer<typeof SaveProjectSettingsErrorCode>;

export const SaveProjectSettingsErrorData = {
  project_not_found: ProjectNotFoundErrorData,
  project_branch_invalid: CreateProjectErrorData.project_branch_invalid,
  /** The first check that needs a shell. */
  project_check_invalid: z.strictObject({ command: z.string() }),
  /** The first fix command that needs a shell. */
  project_fix_command_invalid: z.strictObject({ command: z.string() }),
  /** Only one of the app start command and URL was given; `missing` names the other. */
  project_app_settings_incomplete: z.strictObject({
    missing: z.enum(["appStartCommand", "appUrl"]),
  }),
  /** The app URL is not an http(s) URL on localhost or 127.0.0.1. */
  project_app_url_invalid: z.strictObject({ url: z.string() }),
  /** The app start command, or else the first app setup command, that needs a shell. */
  project_app_command_invalid: z.strictObject({ command: z.string() }),
} satisfies Record<SaveProjectSettingsErrorCode, z.ZodType>;

export type SaveProjectSettingsError = {
  [C in SaveProjectSettingsErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof SaveProjectSettingsErrorData)[C]>;
  };
}[SaveProjectSettingsErrorCode];

const DeliveryRunErrorData = z.strictObject({ runId: EntityId });

/** Codes `delivery.markMerged` returns, in the order they are checked; each writes nothing. */
export const MarkMergedErrorCode = z.enum([
  "delivery_run_not_found",
  "delivery_not_passed",
  "delivery_already_merged",
  "project_folder_missing",
  "delivery_not_merged",
  "delivery_branch_missing",
]);
export type MarkMergedErrorCode = z.infer<typeof MarkMergedErrorCode>;

export const MarkMergedErrorData = {
  delivery_run_not_found: DeliveryRunErrorData,
  /** The run did not end `passed`. */
  delivery_not_passed: DeliveryRunErrorData,
  /** The run is already recorded as merged. */
  delivery_already_merged: DeliveryRunErrorData,
  /** `folderPath` is the stored project's folder. */
  project_folder_missing: CreateProjectErrorData.project_folder_missing,
  /** The final commit is not an ancestor of the pinned base branch (a squash or rebase merge too). */
  delivery_not_merged: z.strictObject({
    runId: EntityId,
    finalCommit: z.string(),
    baseBranch: z.string(),
  }),
  /** git could not test the ancestry: the pinned base branch or the final commit is gone. */
  delivery_branch_missing: z.strictObject({
    runId: EntityId,
    finalCommit: z.string(),
    baseBranch: z.string(),
  }),
} satisfies Record<MarkMergedErrorCode, z.ZodType>;

export type MarkMergedError = {
  [C in MarkMergedErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof MarkMergedErrorData)[C]>;
  };
}[MarkMergedErrorCode];

/** Codes `delivery.activity` returns for expected refusals. */
export const DeliveryActivityErrorCode = z.enum(["delivery_run_not_found"]);
export type DeliveryActivityErrorCode = z.infer<typeof DeliveryActivityErrorCode>;

export const DeliveryActivityErrorData = {
  delivery_run_not_found: DeliveryRunErrorData,
} satisfies Record<DeliveryActivityErrorCode, z.ZodType>;

export type DeliveryActivityError = CodedError<"delivery_run_not_found"> & {
  readonly data: z.infer<typeof DeliveryRunErrorData>;
};

/**
 * Codes `delivery.resume` returns for expected refusals, in the order they are checked; each
 * writes nothing. A resume starts the run's ticket set again from the run's branch, so the run's
 * own refusals come first, then every start refusal.
 */
export const ResumeDeliveryErrorCode = z.enum([
  "delivery_run_not_found",
  "delivery_run_not_resumable",
  "delivery_run_branch_missing",
  ...StartDeliveryErrorCode.options,
]);
export type ResumeDeliveryErrorCode = z.infer<typeof ResumeDeliveryErrorCode>;

export const ResumeDeliveryErrorData = {
  delivery_run_not_found: DeliveryRunErrorData,
  /** The run is still active, or it passed: only a failed, blocked or cancelled run resumes. */
  delivery_run_not_resumable: DeliveryRunErrorData,
  /** The run's branch is gone from the project's repository. */
  delivery_run_branch_missing: z.strictObject({ runId: EntityId, branch: z.string() }),
  ...StartDeliveryErrorData,
} satisfies Record<ResumeDeliveryErrorCode, z.ZodType>;

export type ResumeDeliveryError = {
  [C in ResumeDeliveryErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof ResumeDeliveryErrorData)[C]>;
  };
}[ResumeDeliveryErrorCode];

/** Codes `delivery.cancel` returns for expected refusals. */
export const CancelDeliveryErrorCode = z.enum(["delivery_run_not_found", "delivery_run_ended"]);
export type CancelDeliveryErrorCode = z.infer<typeof CancelDeliveryErrorCode>;

export const CancelDeliveryErrorData = {
  delivery_run_not_found: z.strictObject({ runId: EntityId }),
  /** The run had already ended before the request was made. */
  delivery_run_ended: z.strictObject({ runId: EntityId }),
} satisfies Record<CancelDeliveryErrorCode, z.ZodType>;

export type CancelDeliveryError = {
  [C in CancelDeliveryErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof CancelDeliveryErrorData)[C]>;
  };
}[CancelDeliveryErrorCode];

/** A map that wrote no revision of a spec with this number. */
export const SpecNotFoundErrorData = z.strictObject({
  mapId: EntityId,
  specNumber: z.int().min(1),
});

/**
 * Why core refused a hatch reply's change at the write: the message's reply is then core's fixed
 * sentence for the reason, stored with this code, and nothing else is written. `spec_approved` is
 * no longer returned but stays for stored replies; `spec_waiting` refuses a note on a spec the map
 * already waits on. A `propose_map` naming an Out of scope line position the map does not have is
 * `exclusion_not_found`, one naming a line already linked to a map `exclusion_already_split` (map
 * proposals).
 */
export const HatchRefusal = z.enum([
  "spec_in_flight",
  "map_uncleared",
  "spec_approved",
  "ticket_set_approved",
  "no_ticket_set",
  "waypoint_not_waiting",
  "waypoint_state",
  "spec_waiting",
  "exclusion_not_found",
  "exclusion_already_split",
]);
export type HatchRefusal = z.infer<typeof HatchRefusal>;

/**
 * Codes `hatch.send` returns for expected refusals; each writes nothing. `spec_waiting`: the map
 * wrote no revision of the spec but waits on it.
 */
export const SendHatchMessageErrorCode = z.enum([
  "map_not_found",
  "hatch_message_empty",
  "spec_not_found",
  "spec_waiting",
]);
export type SendHatchMessageErrorCode = z.infer<typeof SendHatchMessageErrorCode>;

export const SendHatchMessageErrorData = {
  map_not_found: MapNotFoundErrorData,
  /** The text is blank once trimmed. */
  hatch_message_empty: MapNotFoundErrorData,
  /** The map wrote no revision of a spec with this number. */
  spec_not_found: SpecNotFoundErrorData,
  /** The map wrote no revision of the spec and already waits on it. */
  spec_waiting: SpecNotFoundErrorData,
} satisfies Record<SendHatchMessageErrorCode, z.ZodType>;

export type SendHatchMessageError = {
  [C in SendHatchMessageErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof SendHatchMessageErrorData)[C]>;
  };
}[SendHatchMessageErrorCode];

/**
 * Why the publishing step failed: gh cannot run, gh is not signed in to github.com, the sign-in
 * check timed out, the push of the run branch failed, or opening the pull request failed.
 */
export const PublishFailureCode = z.enum([
  "delivery_gh_missing",
  "delivery_github_not_signed_in",
  "delivery_github_unreachable",
  "delivery_push_failed",
  "delivery_pull_request_failed",
]);
export type PublishFailureCode = z.infer<typeof PublishFailureCode>;

/**
 * Codes `delivery.checkPullRequest` (Check now) returns, in the order they are checked; each writes
 * nothing: no such run, a run that opened no pull request, then gh's sign-in check (gh cannot run,
 * gh is not signed in to github.com, or GitHub could not be reached, which reading the pull
 * request's state failing is too).
 */
export const CheckPullRequestErrorCode = z.enum([
  "delivery_run_not_found",
  "delivery_no_pull_request",
  "delivery_gh_missing",
  "delivery_github_not_signed_in",
  "delivery_github_unreachable",
]);
export type CheckPullRequestErrorCode = z.infer<typeof CheckPullRequestErrorCode>;

export const CheckPullRequestErrorData = {
  delivery_run_not_found: DeliveryRunErrorData,
  /** The run recorded no pull request: it did not pass on a project whose origin is on github.com. */
  delivery_no_pull_request: DeliveryRunErrorData,
  delivery_gh_missing: DeliveryRunErrorData,
  delivery_github_not_signed_in: DeliveryRunErrorData,
  delivery_github_unreachable: DeliveryRunErrorData,
} satisfies Record<CheckPullRequestErrorCode, z.ZodType>;

export type CheckPullRequestError = {
  [C in CheckPullRequestErrorCode]: CodedError<C> & {
    readonly data: z.infer<(typeof CheckPullRequestErrorData)[C]>;
  };
}[CheckPullRequestErrorCode];

/**
 * The code of a delivery run's failure, stored in `DeliveryRun.failure` (the run's `phase` says
 * where), never a procedure error: every `DeliveryAgentErrorCode` and the runner's `delivery_*`
 * codes, the publishing step's among them.
 */
export const DeliveryFailureCode = z.enum([
  ...DeliveryAgentErrorCode.options,
  "delivery_worktree_failed",
  "delivery_worktree_dirty",
  "delivery_no_commits",
  "delivery_foreign_commit",
  "delivery_checks_failed",
  "delivery_verdict_invalid",
  "delivery_review_changed_worktree",
  "delivery_ticket_unmerged",
  "delivery_internal_error",
  ...PublishFailureCode.options,
]);
export type DeliveryFailureCode = z.infer<typeof DeliveryFailureCode>;

/**
 * The refusal of a procedure that names a project or a map the access check denies.
 */
export const AccessErrorCode = z.enum(["access_denied"]);
export type AccessErrorCode = z.infer<typeof AccessErrorCode>;

/** What the access check is asked: a read (a query) or a write (a mutation) on a project. */
export const AccessAction = z.enum(["read", "write"]);
export type AccessAction = z.infer<typeof AccessAction>;

/** `access_denied`'s data: the project the procedure named and the action refused. */
export const AccessDeniedErrorData = z.strictObject({
  projectId: EntityId,
  action: AccessAction,
});
export type AccessDeniedError = CodedError<"access_denied"> & {
  readonly data: z.infer<typeof AccessDeniedErrorData>;
};

/**
 * The refusals of a request the server will not serve, answered before any route runs:
 * `host_not_allowed` (403, any route: the Host is not ZeNorm's own), `origin_not_allowed` (403,
 * `/rpc`: a foreign or `null` Origin) and `content_type_not_json` (415, a `/rpc` POST not declared
 * as `application/json`).
 */
export const RequestRefusalCode = z.enum([
  "host_not_allowed",
  "origin_not_allowed",
  "content_type_not_json",
]);
export type RequestRefusalCode = z.infer<typeof RequestRefusalCode>;

/** Every domain code. */
export const DomainCode = z.enum([
  ...CreateProjectErrorCode.options,
  "project_not_found",
  "map_not_found",
  ...DismissProposalErrorCode.options,
  ...PlanningAgentErrorCode.options,
  ...SubmitAnswersErrorCode.options,
  ...PlanningRunFailureCode.exclude([...PlanningAgentErrorCode.options, "project_folder_missing"])
    .options,
  ...TryAgainErrorCode.options,
  ...SpecDecisionErrorCode.options,
  ...TicketSetDecisionErrorCode.exclude(["review_in_flight"]).options,
  "spec_not_found",
  "agent_cancelled",
  "ticket_set_not_approved",
  "delivery_nothing_to_deliver",
  "delivery_already_passed",
  "delivery_in_progress",
  "delivery_branch_exists",
  "delivery_not_admitted",
  "project_checks_missing",
  "project_repair_limit_missing",
  "project_check_invalid",
  "project_fix_command_invalid",
  "project_app_settings_incomplete",
  "project_app_url_invalid",
  "project_app_command_invalid",
  ...CancelDeliveryErrorCode.options,
  "delivery_not_passed",
  "delivery_already_merged",
  "delivery_not_merged",
  "delivery_branch_missing",
  "delivery_no_pull_request",
  ...DeliveryFailureCode.exclude([...DeliveryAgentErrorCode.options]).options,
  "hatch_message_empty",
  ...HatchRefusal.exclude(["map_uncleared"]).options,
  ...AccessErrorCode.options,
  ...RequestRefusalCode.options,
]);
export type DomainCode = z.infer<typeof DomainCode>;

/**
 * The plugin set's startup codes. The server refuses with the first thirteen before it listens; the
 * web shows the last two as a blocking error page.
 */
export const PluginStartupCode = z.enum([
  "plugin_id_invalid",
  "plugin_id_duplicate",
  "plugin_sdk_incompatible",
  "plugin_config_missing",
  "plugin_config_invalid",
  "plugin_config_unknown_section",
  "plugin_identity_conflict",
  "plugin_event_kind_unknown",
  "plugin_route_collision",
  "plugin_seam_failed",
  "plugin_executor_duplicate",
  "executor_unknown",
  "plugin_start_failed",
  "plugin_slot_unknown",
  "plugin_set_mismatch",
]);
export type PluginStartupCode = z.infer<typeof PluginStartupCode>;

/**
 * Codes printed by `apps/zenorm` and the `zenorm` command when startup fails, before the server
 * listens. The command refuses `platform_unsupported` (native Windows) and
 * `node_version_unsupported` before any other check. `zenorm init` refuses
 * `init_not_interactive` without a terminal to ask on, and `agent_not_logged_in` when Claude Code
 * is still not signed in after its login. Startup refuses `agent_not_logged_in` when
 * `claude auth status` fails or says signed out, `data_dir_in_use` while another ZeNorm runs on the
 * same data folder (before anything is migrated or swept), `database_newer_than_build` for a
 * database holding a migration this build does not ship, and `server_port_in_use` or
 * `server_listen_failed` when the server cannot bind its host and port (before any run is marked
 * interrupted or relaunched). `zenorm doctor` reports these codes per check, except the three only
 * `zenorm run` can meet (`data_dir_in_use`, `server_port_in_use`, `server_listen_failed`), and
 * `git_missing` when git cannot run.
 */
export const StartupCode = z.enum([
  "platform_unsupported",
  "node_version_unsupported",
  "arguments_invalid",
  "init_not_interactive",
  "config_path_missing",
  "config_path_ambiguous",
  "config_file_missing",
  "config_file_invalid",
  "data_dir_missing",
  "data_dir_in_use",
  "agent_cli_missing",
  "agent_not_logged_in",
  "git_missing",
  "web_build_missing",
  "database_open_failed",
  "database_newer_than_build",
  "migration_failed",
  "user_missing",
  "user_ambiguous",
  "change_feed_missing",
  "server_port_in_use",
  "server_listen_failed",
  ...PluginStartupCode.options,
]);
export type StartupCode = z.infer<typeof StartupCode>;

/**
 * The plugin contribution whose throw or rejection is `plugin_start_failed`: its `executors()`,
 * `subscribers()` or `routes()` at startup, or its `start`.
 */
export const PluginStartPhase = z.enum(["executors", "subscribers", "routes", "start"]);
export type PluginStartPhase = z.infer<typeof PluginStartPhase>;

/**
 * One startup failure, printed as one JSON line `{ code, message, subject }` to stderr, with
 * `data` too for `plugin_start_failed`: the plugin and the phase that failed.
 */
export type StartupError =
  | (CodedError<Exclude<StartupCode, "plugin_start_failed">> & { readonly subject: string })
  | (CodedError<"plugin_start_failed"> & {
      readonly subject: string;
      readonly data: { readonly pluginId: string; readonly phase: PluginStartPhase };
    });
