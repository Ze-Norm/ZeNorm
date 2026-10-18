import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { err, gitIdentityEnv, ok, ticketBranchName } from "@zenorm/plugin-sdk";
import type {
  DeliveryAgentError,
  DeliveryExecutor,
  ImplementRequest,
  Result,
} from "@zenorm/plugin-sdk";

import { EXAMPLE_EXECUTOR, EXAMPLE_EXECUTOR_LINE } from "./manifest.ts";

/** The calls the executor has answered, which `GET /plugins/example/counts` reports. */
export interface ExecutorCalls {
  implement: number;
  review: number;
}

/** The folder of the worktree each ticket's one file is committed under. */
export const EXECUTOR_FOLDER = "example-executor";

/** The fixed body the example executor writes for every pull request. */
export const EXAMPLE_PULL_REQUEST_BODY = [
  "## Why",
  "",
  "Each ticket needed its file.",
  "",
  "## What",
  "",
  "- The example executor committed one file per ticket and merged its branch.",
  "",
  "## Tests",
  "",
  "The example executor ran no tests.",
  "",
  "## Risks",
  "",
  "None: the change only adds files.",
  "",
].join("\n");

const CANCELLED: DeliveryAgentError = {
  code: "agent_cancelled",
  message: "The example executor was stopped",
  data: {},
};

/** A git step that failed, as the session ports report a session that ended badly. */
function gitFailed(args: readonly string[], exitCode: number | null): DeliveryAgentError {
  return {
    code: "agent_run_failed",
    message: `git ${args.join(" ")} failed`,
    data: { exitCode, subtype: null },
  };
}

type GitResult = Result<null, DeliveryAgentError>;

/** Read afresh at each step: the signal may abort while a step runs. */
function stopped(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Runs one git command in the worktree as the run's identity; a stop between steps is honoured. */
function git(request: ImplementRequest, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: request.worktreePath,
        env: { ...process.env, ...gitIdentityEnv(request.gitIdentity) },
      },
      (error) => {
        if (error === null) {
          resolve(ok(null));
          return;
        }
        resolve(err(gitFailed(args, typeof error.code === "number" ? error.code : null)));
      },
    );
  });
}

/**
 * The file a repair attempt commits on the run branch, relative to the worktree: a test check that
 * looks for it fails before the attempt and passes after it.
 */
export function repairFile(attempt: number): string {
  return join(EXECUTOR_FOLDER, `repair-${String(attempt)}.txt`);
}

/**
 * A repair attempt: merges no ticket, and commits `repairFile(attempt)`, naming the failing checks,
 * on the run branch.
 */
async function repair(
  request: ImplementRequest,
  { attempt, failedChecks }: NonNullable<ImplementRequest["repair"]>,
  signal: AbortSignal,
): Promise<GitResult> {
  const file = repairFile(attempt);
  const steps: readonly (() => Promise<GitResult>)[] = [
    async () => {
      await mkdir(join(request.worktreePath, EXECUTOR_FOLDER), { recursive: true });
      await writeFile(
        join(request.worktreePath, file),
        failedChecks.map(({ result }) => `${result.command}\n`).join(""),
      );
      return ok(null);
    },
    () => git(request, ["add", "--", file]),
    () => git(request, ["commit", "-q", "-m", `Repair attempt ${String(attempt)}`]),
  ];
  for (const step of steps) {
    if (stopped(signal)) return err(CANCELLED);
    const done = await step();
    if (!done.ok) return done;
  }
  return ok(null);
}

/**
 * The `example` executor: a deterministic stand-in that runs no agent and no process of its own
 * beyond `git`. Per pinned ticket not already merged (a resumed run's are) it commits one file on
 * the ticket branch, made at the run branch's head, and merges that branch into the run branch with
 * `--no-ff`, keeping it; the runner then verifies the work from git as it does for `"local"`. Given
 * a repair attempt, it merges nothing and commits one file for the attempt on the run branch
 * (`repairFile`). Its review passes the final commit with no findings, its pull request writer
 * returns a fixed body reporting no visible change, and its screen picker reports no visible
 * change. The first two count their calls into `calls`.
 */
export function exampleExecutor(calls: ExecutorCalls): DeliveryExecutor {
  return {
    name: EXAMPLE_EXECUTOR,
    implementTicketSet: async (request, signal, onEvent) => {
      calls.implement += 1;
      if (stopped(signal)) return err(CANCELLED);
      onEvent({ kind: "line", who: "orchestrator", ticket: null, text: EXAMPLE_EXECUTOR_LINE });
      if (request.repair !== null) {
        const { attempt } = request.repair;
        const repaired = await repair(request, request.repair, signal);
        if (!repaired.ok) return repaired;
        onEvent({
          kind: "line",
          who: "orchestrator",
          ticket: null,
          text: `Repair attempt ${String(attempt)}: committed ${repairFile(attempt)} on the run branch.`,
        });
        return ok(null);
      }
      for (const ticket of request.tickets) {
        if (request.merged.includes(ticket.id)) continue;
        if (stopped(signal)) return err(CANCELLED);
        onEvent({ kind: "ticket_started", ticket: ticket.id });
        const branch = ticketBranchName(request.branch, ticket.id);
        const file = join(EXECUTOR_FOLDER, `${ticket.id}.txt`);
        const steps: readonly (() => Promise<GitResult>)[] = [
          () => git(request, ["checkout", "-q", "-b", branch, request.branch]),
          async () => {
            await mkdir(join(request.worktreePath, EXECUTOR_FOLDER), { recursive: true });
            await writeFile(join(request.worktreePath, file), `${ticket.id}: ${ticket.title}\n`);
            return ok(null);
          },
          () => git(request, ["add", "--", file]),
          () => git(request, ["commit", "-q", "-m", `${ticket.id}: ${ticket.title}`]),
          () => git(request, ["checkout", "-q", request.branch]),
          () => git(request, ["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch]),
        ];
        for (const step of steps) {
          if (stopped(signal)) return err(CANCELLED);
          const done = await step();
          if (!done.ok) return done;
        }
        onEvent({
          kind: "ticket_merged",
          ticket: ticket.id,
          summary: `${ticket.id} committed ${file} and merged ${branch}.`,
        });
      }
      return ok(null);
    },
    reviewDelivery: (request) => {
      calls.review += 1;
      return Promise.resolve(
        ok({
          reviewedCommit: request.finalCommit,
          summary: "The example executor's review passes every run with no findings.",
          findings: [],
        }),
      );
    },
    // A fixed body, and no visible change: its runs open pull requests without screenshots.
    writePullRequest: () =>
      Promise.resolve(ok({ body: EXAMPLE_PULL_REQUEST_BODY, visibleChange: false })),
    pickScreens: () => Promise.resolve(ok({ kind: "no_visible_change" })),
  };
}
