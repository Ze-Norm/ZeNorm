/**
 * A run's per-ticket progress while it is active: the started and merged records the runner writes
 * from the orchestrator's events, and the merges verifying recovers from git. Every write is
 * guarded on the run being active, so a late event writes nothing.
 */
import { err, ok, RUN_TICKET_SUMMARY_MAX_LENGTH, ticketBranchName } from "@zenorm/contracts";
import type { Actor, CodedError, Result } from "@zenorm/contracts";
import { deliveryRunTickets, deliveryRuns } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { branchCommit, runGit } from "./git.ts";
import type { Reader } from "./planning-runs.ts";
import { write } from "./writes.ts";

/** The ticket-branch rule lives in contracts (the executor contract); core re-exports it. */
export { ticketBranchName };

/** The ids of the runs that have not ended, for a guard on a ticket row's run. */
function activeRunIds(db: Reader) {
  return db.select({ id: deliveryRuns.id }).from(deliveryRuns).where(isNull(deliveryRuns.endedAt));
}

/** True when `runId` has a ticket row `ticket`. */
function hasTicketRow(db: Reader, runId: string, ticket: string): boolean {
  const row = db
    .select({ ticket: deliveryRunTickets.ticket })
    .from(deliveryRunTickets)
    .where(and(eq(deliveryRunTickets.runId, runId), eq(deliveryRunTickets.ticket, ticket)))
    .get();
  return row !== undefined;
}

/** A run's branch and end; an unknown run is a programmer error. */
function readRunBranch(db: ZeNormDatabase, runId: string) {
  const found = db
    .select({ branch: deliveryRuns.branch, endedAt: deliveryRuns.endedAt })
    .from(deliveryRuns)
    .where(eq(deliveryRuns.id, runId))
    .get();
  if (found === undefined) {
    throw new Error(`No delivery run with id ${runId}`);
  }
  return found;
}

/**
 * Records a run's ticket as started now, once: a repeat, or a run that has ended,
 * writes nothing. True when it was written. A ticket the run did not pin is a programmer error.
 */
export function recordTicketStarted(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  ticket: string,
): boolean {
  const updated = write(db, actor, (tx) =>
    tx
      .update(deliveryRunTickets)
      .set({ startedAt: new Date().toISOString() })
      .where(
        and(
          eq(deliveryRunTickets.runId, runId),
          eq(deliveryRunTickets.ticket, ticket),
          isNull(deliveryRunTickets.startedAt),
          inArray(deliveryRunTickets.runId, activeRunIds(tx)),
        ),
      )
      .run(),
  );
  if (updated.changes === 0 && !hasTicketRow(db, runId, ticket)) {
    throw new Error(`Delivery run ${runId} has no ticket ${ticket}`);
  }
  return updated.changes > 0;
}

/** Writes a merged record at `commit`, guarded on the run being active; true when written. */
function writeMerged(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  ticket: string,
  merged: { commit: string; summary: string | null },
): boolean {
  const updated = write(db, actor, (tx) =>
    tx
      .update(deliveryRunTickets)
      .set({ mergedAt: new Date().toISOString(), commit: merged.commit, summary: merged.summary })
      .where(
        and(
          eq(deliveryRunTickets.runId, runId),
          eq(deliveryRunTickets.ticket, ticket),
          inArray(deliveryRunTickets.runId, activeRunIds(tx)),
        ),
      )
      .run(),
  );
  if (updated.changes === 0 && !hasTicketRow(db, runId, ticket)) {
    throw new Error(`Delivery run ${runId} has no ticket ${ticket}`);
  }
  return updated.changes > 0;
}

/** What recording a merge did. */
export type TicketMergedRecord =
  | { readonly recorded: true; readonly commit: string }
  | { readonly recorded: false; readonly reason: "run_ended" | "branch_missing" };

/**
 * Records a run's ticket as merged: the commit is `git rev-parse <run branch>-t<n>` in `folder`
 * (the one the run's start resolved), the summary the runner's (at most 1000 characters; it cuts
 * it), or null. A run that has ended writes nothing, even when cleanup has already deleted the
 * branch (a late event after a cancel). A repeat records the branch's head again. A branch that is
 * missing while the run is active (the orchestrator deleted it after merging) writes nothing
 * either: verifying then fails the run `delivery_ticket_unmerged` naming the ticket. An unpinned
 * ticket, or an over-long or empty summary, is a programmer error.
 */
export async function recordTicketMerged(
  actor: Actor,
  db: ZeNormDatabase,
  input: { runId: string; ticket: string; summary: string | null; folder: string },
): Promise<TicketMergedRecord> {
  const { runId, ticket, summary, folder } = input;
  if (summary !== null && (summary === "" || summary.length > RUN_TICKET_SUMMARY_MAX_LENGTH)) {
    throw new Error(`Ticket ${ticket}'s summary has ${String(summary.length)} characters`);
  }
  const run = readRunBranch(db, runId);
  if (run.endedAt !== null) {
    return { recorded: false, reason: "run_ended" };
  }
  if (!hasTicketRow(db, runId, ticket)) {
    throw new Error(`Delivery run ${runId} has no ticket ${ticket}`);
  }
  const branch = ticketBranchName(run.branch, ticket);
  const commit = await branchCommit(folder, branch);
  if (commit === null) {
    return readRunBranch(db, runId).endedAt === null
      ? { recorded: false, reason: "branch_missing" }
      : { recorded: false, reason: "run_ended" };
  }
  return writeMerged(actor, db, runId, ticket, { commit, summary })
    ? { recorded: true, commit }
    : { recorded: false, reason: "run_ended" };
}

/** The tickets not merged into the final commit, in pinned order. */
export type VerifyTicketMergesError = CodedError<"delivery_ticket_unmerged"> & {
  readonly data: { readonly tickets: string[] };
};

/** A ticket verifying recorded as merged from git. */
export interface RecoveredTicket {
  readonly ticket: string;
  readonly commit: string;
}

/**
 * Verifies every pinned ticket was merged, after the commit checks: each ticket row with
 * no merged record whose branch `<run branch>-t<n>` exists and whose head is an ancestor of
 * `finalCommit` is recorded as merged at that head (summary null). Any other is
 * `delivery_ticket_unmerged`, naming the tickets in pinned order; the tickets recovered before
 * are kept. Returns the recovered tickets. git in `folder` (the one the run's start resolved)
 * failing otherwise throws.
 */
export async function verifyTicketMerges(
  actor: Actor,
  db: ZeNormDatabase,
  input: { runId: string; finalCommit: string; folder: string },
): Promise<Result<RecoveredTicket[], VerifyTicketMergesError>> {
  const { runId, finalCommit, folder } = input;
  const run = readRunBranch(db, runId);
  const unmergedRows = db
    .select({ ticket: deliveryRunTickets.ticket })
    .from(deliveryRunTickets)
    .where(and(eq(deliveryRunTickets.runId, runId), isNull(deliveryRunTickets.mergedAt)))
    .orderBy(asc(deliveryRunTickets.position))
    .all();
  const recovered: RecoveredTicket[] = [];
  const unmerged: string[] = [];
  for (const { ticket } of unmergedRows) {
    const branch = ticketBranchName(run.branch, ticket);
    const head = await branchCommit(folder, branch);
    if (head === null) {
      unmerged.push(ticket);
      continue;
    }
    const ancestor = await runGit(folder, ["merge-base", "--is-ancestor", head, finalCommit]);
    if (ancestor.exitCode === 1) {
      unmerged.push(ticket);
      continue;
    }
    if (ancestor.exitCode !== 0) {
      throw new Error(
        `git merge-base --is-ancestor ${head} ${finalCommit} failed in ${folder} with exit ${String(ancestor.exitCode)}`,
      );
    }
    if (writeMerged(actor, db, runId, ticket, { commit: head, summary: null })) {
      recovered.push({ ticket, commit: head });
    }
  }
  if (unmerged.length > 0) {
    return err({
      code: "delivery_ticket_unmerged",
      message: `Not merged into the run branch at ${finalCommit}: ${unmerged.join(", ")}`,
      data: { tickets: unmerged },
    });
  }
  return ok(recovered);
}
