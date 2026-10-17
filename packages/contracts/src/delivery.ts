import { z } from "zod";

import { DeliveryFailureCode } from "./codes.ts";
import { EntityId } from "./map.ts";
import {
  BaseBranch,
  CheckCommand,
  DELIVERY_CHECKS_MAX_COUNT,
  REPAIR_LIMIT_MAX,
  RepairLimit,
} from "./project.ts";
import { CriterionId, TicketBlocker, TicketId } from "./spec-content.ts";

export {
  CHECK_COMMAND_MAX_LENGTH,
  CheckCommand,
  DELIVERY_CHECKS_MAX_COUNT,
  ProjectChecks,
} from "./project.ts";

export const CHECK_OUTPUT_TAIL_MAX_LENGTH = 4000;
export const VERDICT_SUMMARY_MAX_LENGTH = 2000;
export const VERDICT_FINDINGS_MAX_COUNT = 50;
export const VERDICT_FINDING_FILE_MAX_LENGTH = 500;
export const VERDICT_FINDING_TITLE_MAX_LENGTH = 200;
export const VERDICT_FINDING_DETAIL_MAX_LENGTH = 4000;

/** A run activity line's longest text; every stored line, of any actor, is cut to it with "…". */
export const RUN_EVENT_TEXT_MAX_LENGTH = 500;
/** A merged ticket's summary's longest text. */
export const RUN_TICKET_SUMMARY_MAX_LENGTH = 1000;

const ELLIPSIS = "…";

/**
 * Agent text cut to `max` UTF-16 units, shared by the stream parser and core: a longer text keeps
 * whole characters up to `max - 1` units, drops back to just before an inline-code or `**` pair the
 * cut left open, and ends "…". A text that fits is kept as is.
 */
export function cutAgentText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > max - ELLIPSIS.length) {
      break;
    }
    kept += character;
  }
  return closeMarkdownPairs(kept) + ELLIPSIS;
}

/** `text` up to its last unmatched backtick, then up to its last unmatched `**` outside code. */
function closeMarkdownPairs(text: string): string {
  let openCode: number | null = null;
  const bold: number[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`") {
      openCode = openCode === null ? index : null;
      index += 1;
    } else if (openCode === null && text.startsWith("**", index)) {
      bold.push(index);
      index += 2;
    } else {
      index += 1;
    }
  }
  const kept = openCode === null ? text : text.slice(0, openCode);
  const lastBold = bold.at(-1);
  if (bold.length % 2 === 1 && lastBold !== undefined) {
    return kept.slice(0, lastBold);
  }
  return kept;
}

/** Who a run activity line comes from: ZeNorm or one of the executor's sessions. */
export const RunActor = z.enum(["zenorm", "orchestrator", "implementer", "reviewer"]);
export type RunActor = z.infer<typeof RunActor>;

/** A full, lowercase git commit id. */
export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);

/** A run's checks, in the order they run; pinned on the run. */
export const DeliveryChecks = z.array(CheckCommand).min(1).max(DELIVERY_CHECKS_MAX_COUNT);
export type DeliveryChecks = z.infer<typeof DeliveryChecks>;

/** One check's run in the run worktree. */
export const CheckResult = z.strictObject({
  command: CheckCommand,
  /** Null when the process was killed. */
  exitCode: z.int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.int().min(0),
  /** The last characters of the check's stdout and stderr. */
  outputTail: z.string().max(CHECK_OUTPUT_TAIL_MAX_LENGTH),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const VerdictAxis = z.enum(["standards", "spec"]);
export type VerdictAxis = z.infer<typeof VerdictAxis>;

export const VerdictSeverity = z.enum(["blocking", "note"]);
export type VerdictSeverity = z.infer<typeof VerdictSeverity>;

export const VerdictFinding = z.strictObject({
  axis: VerdictAxis,
  severity: VerdictSeverity,
  /** The file the finding is about; null for a finding about the change as a whole. */
  file: z.string().min(1).max(VERDICT_FINDING_FILE_MAX_LENGTH).nullable(),
  title: z.string().min(1).max(VERDICT_FINDING_TITLE_MAX_LENGTH),
  detail: z.string().min(1).max(VERDICT_FINDING_DETAIL_MAX_LENGTH),
  /**
   * The criterion id of the pinned revision the finding fails, or null when the diff goes beyond
   * the spec.
   */
  criterion: CriterionId.nullable(),
});
export type VerdictFinding = z.infer<typeof VerdictFinding>;

/**
 * The reviewer's verdict. Its JSON Schema is the reviewer's `--json-schema`, and it validates the
 * stored `verdict` column, so the two cannot drift. The root key `reviewedCommit` is how the e2e
 * stand-in tells the reviewer from the planning calls.
 */
export const Verdict = z.strictObject({
  /** Must equal the run's final commit for the verdict to be accepted. */
  reviewedCommit: CommitSha,
  summary: z.string().min(1).max(VERDICT_SUMMARY_MAX_LENGTH),
  findings: z.array(VerdictFinding).max(VERDICT_FINDINGS_MAX_COUNT),
});
export type Verdict = z.infer<typeof Verdict>;

/**
 * The step a delivery run is in; stored on the run at each transition and kept at its end.
 * `publishing` follows a passing review on a project whose origin is on github.com: ZeNorm writes
 * the pull request's body, pushes the run branch and opens the pull request.
 */
export const DeliveryPhase = z.enum([
  "preparing",
  "implementing",
  "verifying",
  "reviewing",
  "publishing",
]);
export type DeliveryPhase = z.infer<typeof DeliveryPhase>;

/** The longest pull request body GitHub accepts. */
export const PULL_REQUEST_BODY_MAX_LENGTH = 65_536;

/** ZeNorm's note at the end of every pull request body it opens, below a rule. */
export const PULL_REQUEST_FOOTER = "\n\n---\n\nDelivered with [ZeNorm](https://zenorm.com)\n";

/** The longest body a pull request writer may return: GitHub's limit less ZeNorm's footer. */
export const PULL_REQUEST_WRITTEN_BODY_MAX_LENGTH =
  PULL_REQUEST_BODY_MAX_LENGTH - PULL_REQUEST_FOOTER.length;

/** A pull request's state on GitHub, as recorded on its run. */
export const PullRequestState = z.enum(["open", "closed", "merged"]);
export type PullRequestState = z.infer<typeof PullRequestState>;

/** The pull request a passed run opened on its project's origin repository on github.com. */
export const PullRequest = z.strictObject({
  number: z.int().min(1),
  url: z.url(),
  state: PullRequestState,
});
export type PullRequest = z.infer<typeof PullRequest>;

/** Why a run failed; the phase it failed in is the run's `phase`. */
export const DeliveryFailure = z.strictObject({
  code: DeliveryFailureCode,
  message: z.string(),
});
export type DeliveryFailure = z.infer<typeof DeliveryFailure>;

/**
 * A delivery run. `state` is derived from the stored row and the runner: `running` (the runner
 * holds it), `interrupted` (active but not held, after a restart), or the ended outcomes `passed`,
 * `blocked`, `failed` and `cancelled`. `phase` is the stored phase on every state: the step it is
 * in, or the step it ended from.
 */
export const DeliveryRun = z.strictObject({
  id: EntityId,
  /** The spec the run delivers. */
  specificationId: EntityId,
  ticketSetId: EntityId,
  /** Numbered per spec from 1. */
  number: z.int().min(1),
  branch: z.string().min(1),
  /** The project's base branch, pinned at the start. */
  baseBranch: BaseBranch,
  baseCommit: CommitSha,
  /** The project's required checks, pinned at the start. */
  checks: DeliveryChecks,
  /**
   * The project's repair limit, pinned at the start: how many times failing checks go back to the
   * executor. Null for a run from before repairs (`0033`).
   */
  repairLimit: RepairLimit.nullable(),
  /**
   * The repair attempts the run has made, 0 until its first; null for a run from before repairs
   * (`0033`).
   */
  repairAttempts: z.int().min(0).max(REPAIR_LIMIT_MAX).nullable(),
  state: z.enum(["running", "interrupted", "passed", "blocked", "failed", "cancelled"]),
  phase: DeliveryPhase,
  /** ISO 8601 UTC. */
  startedAt: z.iso.datetime(),
  /** ISO 8601 UTC; null while the run is active. */
  endedAt: z.iso.datetime().nullable(),
  /** Null until verifying has resolved it. */
  finalCommit: CommitSha.nullable(),
  /** Null until the checks have run. */
  checkResults: z.array(CheckResult).nullable(),
  /** Null unless the run ended `passed` or `blocked`. */
  verdict: Verdict.nullable(),
  /** Null unless the run ended `failed`. */
  failure: DeliveryFailure.nullable(),
  /** ISO 8601 UTC; set by Mark merged once git shows the final commit in the base branch. */
  mergedAt: z.iso.datetime().nullable(),
  /** The name of the delivery executor carrying the run, stored at its start. */
  executor: z.string().min(1),
  /**
   * The pull request the run opened once it passed on a project whose origin is on github.com;
   * null for every other run, and for every run from before ZeNorm opened pull requests.
   */
  pullRequest: PullRequest.nullable(),
});
export type DeliveryRun = z.infer<typeof DeliveryRun>;
export type DeliveryRunState = DeliveryRun["state"];

/** One line of a run's activity: display only, never read to decide a status. */
export const RunEvent = z.strictObject({
  /** Numbered per run from 1. */
  seq: z.int().min(1),
  /** ISO 8601 UTC. */
  at: z.iso.datetime(),
  who: RunActor,
  /** The ticket the line belongs to; null for a line about the whole run. */
  ticket: TicketId.nullable(),
  text: z.string().min(1).max(RUN_EVENT_TEXT_MAX_LENGTH),
});
export type RunEvent = z.infer<typeof RunEvent>;

/** Where one pinned ticket stands in a run. */
export const RunTicketStatus = z.discriminatedUnion("state", [
  /** The ticket has a merged record. */
  z.strictObject({
    state: z.literal("merged"),
    commit: CommitSha,
    summary: z.string().min(1).max(RUN_TICKET_SUMMARY_MAX_LENGTH).nullable(),
  }),
  /** The run is active and the ticket is started; `latest` is its latest line, null before its first. */
  z.strictObject({ state: z.literal("implementing"), latest: RunEvent.nullable() }),
  /** The run is active, the ticket is not started, and these blockers are not merged. */
  z.strictObject({ state: z.literal("waiting"), on: z.array(TicketBlocker).min(1) }),
  /** The run is active, the ticket is not started, and none of its blockers is unmerged. */
  z.strictObject({ state: z.literal("starting") }),
  /** The run has ended and the ticket was not merged. */
  z.strictObject({ state: z.literal("not_delivered"), started: z.boolean() }),
]);
export type RunTicketStatus = z.infer<typeof RunTicketStatus>;

export const RunTicket = z.strictObject({
  ticket: TicketId,
  status: RunTicketStatus,
  /** The criterion ids the run's blocking findings name that this ticket carries. */
  failing: z.array(CriterionId),
});
export type RunTicket = z.infer<typeof RunTicket>;

/**
 * One run of a spec as `map.overview` carries it: the run with each pinned ticket's status, in
 * pinned order; `tickets` is null for a run from before `0010`, which has no ticket rows.
 */
export const SpecRun = DeliveryRun.extend({ tickets: z.array(RunTicket).nullable() });
export type SpecRun = z.infer<typeof SpecRun>;

export const StartDeliveryInput = z.strictObject({ ticketSetId: EntityId });
export type StartDeliveryInput = z.infer<typeof StartDeliveryInput>;

/** `delivery.resume`: the failed, blocked or cancelled run whose branch the new run continues. */
export const ResumeDeliveryInput = z.strictObject({ runId: EntityId });
export type ResumeDeliveryInput = z.infer<typeof ResumeDeliveryInput>;

export const CancelDeliveryInput = z.strictObject({ runId: EntityId });
export type CancelDeliveryInput = z.infer<typeof CancelDeliveryInput>;

/** `delivery.markMerged`. */
export const MarkMergedInput = z.strictObject({ runId: EntityId });
export type MarkMergedInput = z.infer<typeof MarkMergedInput>;

/** `delivery.checkPullRequest` (Check now): reads the run's pull request's state on GitHub. */
export const CheckPullRequestInput = z.strictObject({ runId: EntityId });
export type CheckPullRequestInput = z.infer<typeof CheckPullRequestInput>;

/** `delivery.activity`: a run's lines, oldest first. */
export const DeliveryActivityInput = z.strictObject({ runId: EntityId });
export type DeliveryActivityInput = z.infer<typeof DeliveryActivityInput>;
