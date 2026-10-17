import { z } from "zod";

import type { DeliveryAgentError } from "./codes.ts";
import {
  CheckResult,
  CommitSha,
  DELIVERY_CHECKS_MAX_COUNT,
  DeliveryChecks,
  DeliveryFailure,
  RUN_TICKET_SUMMARY_MAX_LENGTH,
  Verdict,
  VerdictFinding,
} from "./delivery.ts";
import {
  TICKET_CONTENT_TITLE_MAX_LENGTH,
  TICKET_SET_TICKETS_MAX_COUNT,
  TicketId,
} from "./spec-content.ts";
import { AbsolutePath, ProjectFixCommands, REPAIR_LIMIT_MAX } from "./project.ts";
import type { Result } from "./result.ts";

/** The identity every delivery session and check commits as, through `GIT_AUTHOR_*`/`GIT_COMMITTER_*`. */
export const GitIdentity = z.strictObject({
  name: z.string().min(1),
  email: z.string().min(1),
});
export type GitIdentity = z.infer<typeof GitIdentity>;

/** The four `GIT_*` variables that make git commit as `identity`, added to a child's environment. */
export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * A pinned ticket's branch, `<run branch>-t<n>` for `T<n>` (slice 8 D4): the executor contract's
 * naming rule (D18), which the runner reads when `ticket_merged` arrives. A string that is not a
 * ticket id is a programmer error.
 */
export function ticketBranchName(runBranch: string, ticket: string): string {
  if (!/^T[1-9][0-9]*$/.test(ticket)) {
    throw new Error(`${JSON.stringify(ticket)} is not a ticket id`);
  }
  return `${runBranch}-t${ticket.slice(1)}`;
}

/** What the orchestrator session needs to implement a run's ticket set in the run worktree. */
export const ImplementRequest = z.strictObject({
  /** The run folder, `<runsDir>/<runId>`; the session writes its prompt and stream files here. */
  runDir: AbsolutePath,
  /** The run worktree, on the run branch; the session's working directory. */
  worktreePath: AbsolutePath,
  /** The run branch. */
  branch: z.string().min(1),
  baseCommit: CommitSha,
  /** The pinned approved spec, rendered as markdown. */
  specPath: AbsolutePath,
  /** The pinned approved ticket set, rendered as markdown. */
  ticketsPath: AbsolutePath,
  ticketCount: z.int().min(1).max(TICKET_SET_TICKETS_MAX_COUNT),
  /** The pinned tickets, in order. */
  tickets: z
    .array(
      z.strictObject({
        id: TicketId,
        title: z.string().min(1).max(TICKET_CONTENT_TITLE_MAX_LENGTH),
      }),
    )
    .min(1)
    .max(TICKET_SET_TICKETS_MAX_COUNT),
  /**
   * The pinned tickets already merged into the run branch, in order: those an earlier run merged
   * when this run resumes it, else none. The executor does not implement them again.
   */
  merged: z.array(TicketId).max(TICKET_SET_TICKETS_MAX_COUNT),
  /**
   * Why the run this one resumes ended, when it failed or was blocked: its failure, the checks of
   * its that did not pass and its blocking findings. The executor fixes them before the closing
   * review. Null for a run started from clean or resuming a cancelled run.
   */
  resumedFrom: z
    .strictObject({
      number: z.int().min(1),
      failure: DeliveryFailure.nullable(),
      /**
       * Each check that did not pass, with the file holding its whole output: its result's output
       * is only the tail. The log is null for a run from before ZeNorm kept them.
       */
      failedChecks: z.array(
        z.strictObject({ result: CheckResult, logPath: AbsolutePath.nullable() }),
      ),
      blockingFindings: z.array(VerdictFinding),
    })
    .nullable(),
  /**
   * Null on a run's first call. On a repair attempt, after ZeNorm's check pass found required
   * checks failing: the attempt's number, the run's pinned repair limit, and each failing check
   * with the file holding its whole output. Every ticket merged so far is in `merged`; the
   * executor merges none again, fixes the failures on the run branch and commits the fix.
   */
  repair: z
    .strictObject({
      attempt: z.int().min(1).max(REPAIR_LIMIT_MAX),
      limit: z.int().min(1).max(REPAIR_LIMIT_MAX),
      failedChecks: z
        .array(z.strictObject({ result: CheckResult, logPath: AbsolutePath }))
        .min(1)
        .max(DELIVERY_CHECKS_MAX_COUNT),
    })
    .nullable(),
  checks: DeliveryChecks,
  /**
   * The run's pinned fix commands, such as `pnpm format` (C4): the orchestrator, and the
   * implementers fixing work in the run worktree, may run exactly these, as they may the checks.
   * The same on every call, first and repair; empty when the project names none.
   */
  fixCommands: ProjectFixCommands,
  gitIdentity: GitIdentity,
});
export type ImplementRequest = z.infer<typeof ImplementRequest>;
export type ResumedFrom = NonNullable<ImplementRequest["resumedFrom"]>;
export type RepairRequest = NonNullable<ImplementRequest["repair"]>;

/** What the reviewer session needs to review a run's `baseCommit..finalCommit`. */
export const ReviewRequest = z.strictObject({
  /** The run folder; the session writes its prompt and output files here. */
  runDir: AbsolutePath,
  /** The run worktree; the session's working directory, which it must not change. */
  worktreePath: AbsolutePath,
  baseCommit: CommitSha,
  finalCommit: CommitSha,
  specPath: AbsolutePath,
  ticketsPath: AbsolutePath,
  /** `git diff <baseCommit> <finalCommit>`, written to a file. */
  diffPath: AbsolutePath,
  /** Paths relative to the worktree. */
  changedFiles: z.array(z.string().min(1)),
  checkResults: z.array(CheckResult),
  gitIdentity: GitIdentity,
});
export type ReviewRequest = z.infer<typeof ReviewRequest>;

/**
 * What the pull request writer session needs to write the body of a passed run's pull request
 * (C3): the change (`baseCommit..finalCommit`, its diff and changed files), the spec and tickets,
 * each ticket's implementer report, the checks and the reviewer's verdict.
 */
export const PullRequestRequest = z.strictObject({
  /** The run folder; the session writes its prompt and output files here. */
  runDir: AbsolutePath,
  /** The run worktree; the session's working directory, which it must not change. */
  worktreePath: AbsolutePath,
  baseCommit: CommitSha,
  finalCommit: CommitSha,
  specPath: AbsolutePath,
  ticketsPath: AbsolutePath,
  /** `git diff <baseCommit> <finalCommit>`, written to a file. */
  diffPath: AbsolutePath,
  /** Paths relative to the worktree. */
  changedFiles: z.array(z.string().min(1)),
  /** Each pinned ticket's implementer report, in pinned order; null for a ticket with none. */
  implementerReports: z
    .array(
      z.strictObject({
        ticket: TicketId,
        report: z.string().min(1).max(RUN_TICKET_SUMMARY_MAX_LENGTH).nullable(),
      }),
    )
    .max(TICKET_SET_TICKETS_MAX_COUNT),
  checkResults: z.array(CheckResult),
  /** The accepted verdict, with no blocking finding. */
  verdict: Verdict,
  gitIdentity: GitIdentity,
});
export type PullRequestRequest = z.infer<typeof PullRequestRequest>;

/**
 * What the orchestrator session reports while it works (D3): a line of the orchestrator or of a
 * ticket's implementer, a ticket's implementer started, and a ticket merged into the run branch.
 */
export const ImplementEvent = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("line"),
    who: z.enum(["orchestrator", "implementer"]),
    ticket: TicketId.nullable(),
    text: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("ticket_started"), ticket: TicketId }),
  z.strictObject({
    kind: z.literal("ticket_merged"),
    ticket: TicketId,
    /** The ticket's implementer's report, cut to 1000 characters; null without one. */
    summary: z.string().min(1).max(RUN_TICKET_SUMMARY_MAX_LENGTH).nullable(),
  }),
]);
export type ImplementEvent = z.infer<typeof ImplementEvent>;

/**
 * The port behind which the orchestrator session sits. Success only means the session ended
 * normally; ZeNorm verifies the work from git. Aborting `signal` stops the session
 * (`agent_cancelled`).
 */
export type ImplementTicketSet = (
  request: ImplementRequest,
  signal: AbortSignal,
  onEvent: (event: ImplementEvent) => void,
) => Promise<Result<null, DeliveryAgentError>>;

/** The port behind which the read-only reviewer session sits. */
export type ReviewDelivery = (
  request: ReviewRequest,
  signal: AbortSignal,
) => Promise<Result<Verdict, DeliveryAgentError>>;

/**
 * The port behind which the read-only pull request writer session sits (C3): it returns the
 * pull request's body, markdown, which ZeNorm opens the pull request with as it is.
 */
export type WritePullRequest = (
  request: PullRequestRequest,
  signal: AbortSignal,
) => Promise<Result<string, DeliveryAgentError>>;

/** The name the app registers its Claude Code sessions under (S9-22, D18). */
export const LOCAL_EXECUTOR = "local";

/**
 * A delivery executor (S9-22, D18): one named set of the three ports, which supplies every role.
 * The app registers the Claude Code sessions as `"local"`; a plugin may register others, and
 * `delivery.executor` names the one every run uses.
 */
export interface DeliveryExecutor {
  readonly name: string;
  readonly implementTicketSet: ImplementTicketSet;
  readonly reviewDelivery: ReviewDelivery;
  readonly writePullRequest: WritePullRequest;
}
