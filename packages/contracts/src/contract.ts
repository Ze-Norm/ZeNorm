import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  AccessDeniedErrorData,
  CancelDeliveryErrorData,
  CheckPullRequestErrorData,
  ConfirmProposalErrorData,
  CreateMapErrorData,
  DeleteMapErrorData,
  DismissProposalErrorData,
  CreateProjectErrorData,
  InspectProjectErrorData,
  DeliveryActivityErrorData,
  MarkMergedErrorData,
  SaveProjectSettingsErrorData,
  MapNotFoundErrorData,
  ProjectNotFoundErrorData,
  SendHatchMessageErrorData,
  SpecDecisionErrorData,
  ResumeDeliveryErrorData,
  StartDeliveryErrorData,
  SubmitAnswersErrorData,
  TicketSetDecisionErrorData,
  TryAgainErrorData,
} from "./codes.ts";
import {
  CancelDeliveryInput,
  CheckPullRequestInput,
  DeliveryActivityInput,
  DeliveryRun,
  MarkMergedInput,
  RunEvent,
  ResumeDeliveryInput,
  StartDeliveryInput,
} from "./delivery.ts";
import { SendHatchMessageInput } from "./hatch.ts";
import {
  CreateMapInput,
  DeleteMapInput,
  DeletedMap,
  GetMapInput,
  GetProjectInput,
  ListMapsInput,
  MapDetail,
  MapRecord,
  QuestionRound,
  SubmitAnswersInput,
} from "./map.ts";
import {
  ApproveSpecInput,
  ApproveTicketSetInput,
  RejectSpecInput,
  RejectTicketSetInput,
} from "./planning.ts";
import { MapOverview, MapOverviewDetail, MapOverviewInput, ProjectDetail } from "./overview.ts";
import {
  CreateProjectInput,
  InspectProjectInput,
  Project,
  ProjectInspection,
  SaveProjectSettingsInput,
} from "./project.ts";
import { ConfirmProposalInput, DismissProposalInput, TryAgainInput } from "./wayfinding.ts";

const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNPROCESSABLE = 422;
const BAD_GATEWAY = 502;

/** `delivery.start`'s refusals, which `delivery.resume` returns too. */
const startDeliveryErrors = {
  ticket_set_not_found: {
    status: NOT_FOUND,
    data: StartDeliveryErrorData.ticket_set_not_found,
  },
  ticket_set_not_approved: {
    status: CONFLICT,
    data: StartDeliveryErrorData.ticket_set_not_approved,
  },
  delivery_nothing_to_deliver: {
    status: CONFLICT,
    data: StartDeliveryErrorData.delivery_nothing_to_deliver,
  },
  delivery_already_passed: {
    status: CONFLICT,
    data: StartDeliveryErrorData.delivery_already_passed,
  },
  project_folder_missing: {
    status: CONFLICT,
    data: StartDeliveryErrorData.project_folder_missing,
  },
  project_branch_missing: {
    status: CONFLICT,
    data: StartDeliveryErrorData.project_branch_missing,
  },
  project_checks_missing: {
    status: CONFLICT,
    data: StartDeliveryErrorData.project_checks_missing,
  },
  project_repair_limit_missing: {
    status: CONFLICT,
    data: StartDeliveryErrorData.project_repair_limit_missing,
  },
  delivery_in_progress: {
    status: CONFLICT,
    data: StartDeliveryErrorData.delivery_in_progress,
  },
  delivery_branch_exists: {
    status: CONFLICT,
    data: StartDeliveryErrorData.delivery_branch_exists,
  },
  delivery_not_admitted: {
    status: CONFLICT,
    data: StartDeliveryErrorData.delivery_not_admitted,
  },
} as const;

/**
 * The access check's refusal. Every procedure that names a project, or a record rooted in one (a
 * map, round, planning run, spec revision, ticket set or delivery run), declares it. `project.list`
 * and `map.overviews` name no project and filter their lists instead; `project.inspect` and
 * `project.create` name a folder, not a stored project, so they declare none.
 */
const accessDenied = {
  access_denied: { status: FORBIDDEN, data: AccessDeniedErrorData },
};

const projectNotFound = {
  project_not_found: { status: NOT_FOUND, data: ProjectNotFoundErrorData },
};

const mapNotFound = {
  map_not_found: { status: NOT_FOUND, data: MapNotFoundErrorData },
};

const inspectProjectErrors = {
  project_folder_missing: {
    status: UNPROCESSABLE,
    data: InspectProjectErrorData.project_folder_missing,
  },
  project_already_added: { status: CONFLICT, data: InspectProjectErrorData.project_already_added },
  project_inside_project: {
    status: CONFLICT,
    data: InspectProjectErrorData.project_inside_project,
  },
  project_not_git: { status: UNPROCESSABLE, data: InspectProjectErrorData.project_not_git },
};

const proposalDecision = {
  proposal_not_found: { status: NOT_FOUND, data: DismissProposalErrorData.proposal_not_found },
  proposal_already_decided: {
    status: CONFLICT,
    data: DismissProposalErrorData.proposal_already_decided,
  },
};

const specDecision = {
  spec_revision_not_found: {
    status: NOT_FOUND,
    data: SpecDecisionErrorData.spec_revision_not_found,
  },
  spec_revision_decided: { status: CONFLICT, data: SpecDecisionErrorData.spec_revision_decided },
  map_uncleared: { status: CONFLICT, data: SpecDecisionErrorData.map_uncleared },
  review_in_flight: { status: CONFLICT, data: SpecDecisionErrorData.review_in_flight },
  spec_review_not_passed: { status: CONFLICT, data: SpecDecisionErrorData.spec_review_not_passed },
};

const ticketSetDecision = {
  ticket_set_not_found: {
    status: NOT_FOUND,
    data: TicketSetDecisionErrorData.ticket_set_not_found,
  },
  ticket_set_decided: { status: CONFLICT, data: TicketSetDecisionErrorData.ticket_set_decided },
  revision_not_latest: { status: CONFLICT, data: TicketSetDecisionErrorData.revision_not_latest },
  review_in_flight: { status: CONFLICT, data: TicketSetDecisionErrorData.review_in_flight },
  ticket_set_review_not_passed: {
    status: CONFLICT,
    data: TicketSetDecisionErrorData.ticket_set_review_not_passed,
  },
};

export const contract = {
  project: {
    /** Every project, oldest first. */
    list: oc.output(z.array(Project)),
    /** The project with each of its specs once. */
    get: oc
      .errors({ ...projectNotFound, ...accessDenied })
      .input(GetProjectInput)
      .output(ProjectDetail),
    /** Checks a folder before it is added: its realpath, name, detected branch and whether it has a commit. */
    inspect: oc.errors(inspectProjectErrors).input(InspectProjectInput).output(ProjectInspection),
    /** Re-runs the inspection, applies the branch rule and stores the project. */
    create: oc
      .errors({
        ...inspectProjectErrors,
        project_branch_invalid: {
          status: UNPROCESSABLE,
          data: CreateProjectErrorData.project_branch_invalid,
        },
        project_branch_missing: {
          status: UNPROCESSABLE,
          data: CreateProjectErrorData.project_branch_missing,
        },
      })
      .input(CreateProjectInput)
      .output(Project),
    /**
     * Stores the base branch, the required checks, the repair limit, the fix commands and the app
     * start command, URL and setup commands; a missing folder does not refuse it.
     */
    saveSettings: oc
      .errors({
        ...accessDenied,
        project_not_found: {
          status: NOT_FOUND,
          data: SaveProjectSettingsErrorData.project_not_found,
        },
        project_branch_invalid: {
          status: UNPROCESSABLE,
          data: SaveProjectSettingsErrorData.project_branch_invalid,
        },
        project_check_invalid: {
          status: UNPROCESSABLE,
          data: SaveProjectSettingsErrorData.project_check_invalid,
        },
        project_fix_command_invalid: {
          status: UNPROCESSABLE,
          data: SaveProjectSettingsErrorData.project_fix_command_invalid,
        },
        project_app_settings_incomplete: {
          status: UNPROCESSABLE,
          data: SaveProjectSettingsErrorData.project_app_settings_incomplete,
        },
        project_app_url_invalid: {
          status: UNPROCESSABLE,
          data: SaveProjectSettingsErrorData.project_app_url_invalid,
        },
        project_app_command_invalid: {
          status: UNPROCESSABLE,
          data: SaveProjectSettingsErrorData.project_app_command_invalid,
        },
      })
      .input(SaveProjectSettingsInput)
      .output(Project),
  },
  map: {
    /** The project's maps, oldest first. */
    list: oc
      .errors({ ...projectNotFound, ...accessDenied })
      .input(ListMapsInput)
      .output(z.array(MapRecord)),
    /**
     * Stores the map and its first `chart` run in one transaction and returns without waiting on
     * the agent, which charts it in the background.
     */
    create: oc
      .errors({
        ...projectNotFound,
        ...accessDenied,
        project_folder_missing: {
          status: UNPROCESSABLE,
          data: CreateMapErrorData.project_folder_missing,
        },
      })
      .input(CreateMapInput)
      .output(MapDetail),
    get: oc
      .errors({ map_not_found: { status: NOT_FOUND, data: MapNotFoundErrorData }, ...accessDenied })
      .input(GetMapInput)
      .output(MapDetail),
    /** Every map with its project and status, newest first. */
    overviews: oc.output(z.array(MapOverview)),
    /** The map with its project, status, activity, Wayfinding and specs: every map page's one read. */
    overview: oc
      .errors({ ...mapNotFound, ...accessDenied })
      .input(MapOverviewInput)
      .output(MapOverviewDetail),
    /**
     * Confirms a pending proposal with the person's edited idea: creates the new map, which charts
     * in the background as `map.create`'s does, and links the proposal's line to it. Returns the
     * overview of the map the proposal was made on.
     */
    confirmProposal: oc
      .errors({
        ...accessDenied,
        ...proposalDecision,
        project_not_found: { status: NOT_FOUND, data: ConfirmProposalErrorData.project_not_found },
        project_folder_missing: {
          status: UNPROCESSABLE,
          data: ConfirmProposalErrorData.project_folder_missing,
        },
        exclusion_already_split: {
          status: CONFLICT,
          data: ConfirmProposalErrorData.exclusion_already_split,
        },
      })
      .input(ConfirmProposalInput)
      .output(MapOverviewDetail),
    /** Dismisses a pending proposal, keeping its line plain; returns its map's overview. */
    dismissProposal: oc
      .errors({ ...accessDenied, ...proposalDecision })
      .input(DismissProposalInput)
      .output(MapOverviewDetail),
    /**
     * Deletes a map and everything recorded on it: its runs, rounds, waypoints, messages and lists,
     * and with `deleteSpecs` the specs it wrote and their ticket sets. Refuses a map that wrote a
     * spec revision unless `deleteSpecs` names exactly the specs it wrote, and then a spec another
     * map worked on, or one with a delivery run in flight, merged or with its pull request open;
     * also one with a planning run in flight, one another map was split from or into, and one
     * another map's wait names as holding a spec, writing nothing. A spec's ended, unmerged runs go
     * with it, and another map's link to its page is left as its text. Ends the map's holds: what
     * they held back on other maps starts. Returns the map's project.
     */
    delete: oc
      .errors({
        ...mapNotFound,
        ...accessDenied,
        map_wrote_spec: { status: CONFLICT, data: DeleteMapErrorData.map_wrote_spec },
        map_spec_shared: { status: CONFLICT, data: DeleteMapErrorData.map_spec_shared },
        map_spec_delivered: { status: CONFLICT, data: DeleteMapErrorData.map_spec_delivered },
        map_run_in_flight: { status: CONFLICT, data: DeleteMapErrorData.map_run_in_flight },
        map_split_linked: { status: CONFLICT, data: DeleteMapErrorData.map_split_linked },
        map_waited_on: { status: CONFLICT, data: DeleteMapErrorData.map_waited_on },
      })
      .input(DeleteMapInput)
      .output(DeletedMap),
  },
  questionRound: {
    /** Submits a pending round's answers, one per question, and starts what they make due. */
    submit: oc
      .errors({
        ...accessDenied,
        round_not_found: { status: NOT_FOUND, data: SubmitAnswersErrorData.round_not_found },
        round_answers_invalid: {
          status: UNPROCESSABLE,
          data: SubmitAnswersErrorData.round_answers_invalid,
        },
        round_already_submitted: {
          status: CONFLICT,
          data: SubmitAnswersErrorData.round_already_submitted,
        },
        round_split_undecided: {
          status: CONFLICT,
          data: SubmitAnswersErrorData.round_split_undecided,
        },
      })
      .input(SubmitAnswersInput)
      .output(QuestionRound),
  },
  planningRun: {
    /** Starts a fresh run in a scope stopped on this failed retry; returns the overview. */
    tryAgain: oc
      .errors({
        ...accessDenied,
        planning_run_not_found: {
          status: NOT_FOUND,
          data: TryAgainErrorData.planning_run_not_found,
        },
        planning_run_not_stopped: {
          status: CONFLICT,
          data: TryAgainErrorData.planning_run_not_stopped,
        },
      })
      .input(TryAgainInput)
      .output(MapOverviewDetail),
  },
  spec: {
    /** Approves the spec's latest draft revision and starts its `to_tickets`; returns the overview. */
    approve: oc
      .errors({ ...specDecision, ...accessDenied })
      .input(ApproveSpecInput)
      .output(MapOverviewDetail),
    /** Supersedes the spec's latest draft revision with a reason; returns the overview. */
    reject: oc
      .errors({
        ...accessDenied,
        spec_revision_not_found: specDecision.spec_revision_not_found,
        spec_revision_decided: specDecision.spec_revision_decided,
        map_uncleared: specDecision.map_uncleared,
        review_in_flight: specDecision.review_in_flight,
      })
      .input(RejectSpecInput)
      .output(MapOverviewDetail),
  },
  ticketSet: {
    /** Approves the set's current version; returns the overview. */
    approve: oc
      .errors({ ...ticketSetDecision, ...accessDenied })
      .input(ApproveTicketSetInput)
      .output(MapOverviewDetail),
    /** Records a rejection of the set's current version; returns the overview. */
    reject: oc
      .errors({ ...ticketSetDecision, ...accessDenied })
      .input(RejectTicketSetInput)
      .output(MapOverviewDetail),
  },
  hatch: {
    /**
     * Stores a message sent through the escape hatch and starts nothing itself; returns the
     * overview, whose messages list it queued.
     */
    send: oc
      .errors({
        ...accessDenied,
        ...mapNotFound,
        hatch_message_empty: {
          status: UNPROCESSABLE,
          data: SendHatchMessageErrorData.hatch_message_empty,
        },
        spec_not_found: { status: NOT_FOUND, data: SendHatchMessageErrorData.spec_not_found },
        spec_waiting: { status: CONFLICT, data: SendHatchMessageErrorData.spec_waiting },
      })
      .input(SendHatchMessageInput)
      .output(MapOverviewDetail),
  },
  delivery: {
    /** Inserts the approved ticket set's next run and drives it in the background. */
    start: oc
      .errors({
        ...accessDenied,
        ...startDeliveryErrors,
      })
      .input(StartDeliveryInput)
      .output(DeliveryRun),
    /**
     * Starts the next run of a failed, blocked or cancelled run's ticket set from that run's branch:
     * the tickets it merged stay merged, and the new run implements the rest.
     */
    resume: oc
      .errors({
        ...accessDenied,
        delivery_run_not_found: {
          status: NOT_FOUND,
          data: ResumeDeliveryErrorData.delivery_run_not_found,
        },
        delivery_run_not_resumable: {
          status: CONFLICT,
          data: ResumeDeliveryErrorData.delivery_run_not_resumable,
        },
        delivery_run_branch_missing: {
          status: CONFLICT,
          data: ResumeDeliveryErrorData.delivery_run_branch_missing,
        },
        ...startDeliveryErrors,
      })
      .input(ResumeDeliveryInput)
      .output(DeliveryRun),
    /** Ends an active run as cancelled and stops its process. */
    cancel: oc
      .errors({
        ...accessDenied,
        delivery_run_not_found: {
          status: NOT_FOUND,
          data: CancelDeliveryErrorData.delivery_run_not_found,
        },
        delivery_run_ended: { status: CONFLICT, data: CancelDeliveryErrorData.delivery_run_ended },
      })
      .input(CancelDeliveryInput)
      .output(DeliveryRun),
    /** Records a passed run as merged once git shows its final commit in the base branch. */
    markMerged: oc
      .errors({
        ...accessDenied,
        delivery_run_not_found: {
          status: NOT_FOUND,
          data: MarkMergedErrorData.delivery_run_not_found,
        },
        delivery_not_passed: { status: CONFLICT, data: MarkMergedErrorData.delivery_not_passed },
        delivery_already_merged: {
          status: CONFLICT,
          data: MarkMergedErrorData.delivery_already_merged,
        },
        project_folder_missing: {
          status: CONFLICT,
          data: MarkMergedErrorData.project_folder_missing,
        },
        delivery_not_merged: { status: CONFLICT, data: MarkMergedErrorData.delivery_not_merged },
        delivery_branch_missing: {
          status: CONFLICT,
          data: MarkMergedErrorData.delivery_branch_missing,
        },
      })
      .input(MarkMergedInput)
      .output(DeliveryRun),
    /**
     * Check now: reads the run's pull request's state on GitHub at once and records it: merged
     * records the run merged, closed records it closed, open (a reopen) records it open.
     */
    checkPullRequest: oc
      .errors({
        ...accessDenied,
        delivery_run_not_found: {
          status: NOT_FOUND,
          data: CheckPullRequestErrorData.delivery_run_not_found,
        },
        delivery_no_pull_request: {
          status: CONFLICT,
          data: CheckPullRequestErrorData.delivery_no_pull_request,
        },
        delivery_gh_missing: {
          status: UNPROCESSABLE,
          data: CheckPullRequestErrorData.delivery_gh_missing,
        },
        delivery_github_not_signed_in: {
          status: UNPROCESSABLE,
          data: CheckPullRequestErrorData.delivery_github_not_signed_in,
        },
        delivery_github_unreachable: {
          status: BAD_GATEWAY,
          data: CheckPullRequestErrorData.delivery_github_unreachable,
        },
      })
      .input(CheckPullRequestInput)
      .output(DeliveryRun),
    /** A run's activity lines, oldest first. */
    activity: oc
      .errors({
        ...accessDenied,
        delivery_run_not_found: {
          status: NOT_FOUND,
          data: DeliveryActivityErrorData.delivery_run_not_found,
        },
      })
      .input(DeliveryActivityInput)
      .output(z.array(RunEvent)),
  },
};

export type Contract = typeof contract;
