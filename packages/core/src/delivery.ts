import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CHECK_OUTPUT_TAIL_MAX_LENGTH, err, ok } from "@zenorm/contracts";
import type {
  ActiveRun,
  Actor,
  UserActor,
  CancelDeliveryError,
  CheckResult,
  ClauseSource,
  CodedError,
  DeliveryChecks,
  DeliveryFailure,
  DeliveryPhase,
  DeliveryRun,
  GitIdentity,
  PullRequest,
  Result,
  ResumeDeliveryError,
  ResumedFrom,
  SpecRevisionContent,
  StartDeliveryError,
  TicketSetContent,
  Verdict,
} from "@zenorm/contracts";
import {
  deliveryRunTickets,
  deliveryRuns,
  isUniqueConstraintViolation,
  maps,
  projects,
  specRevisions,
  ticketSets,
  ticketSetVersions,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { branchCommit, gitOutput, repositoryTopLevel, runGit } from "./git.ts";
import { isDirectory, readActiveRun, startDeliveryBlockers } from "./project.ts";
import type { Reader } from "./planning-runs.ts";
import { deliveredTicket, readSpecRecord } from "./reconciliation.ts";
import { seamsOf } from "./seams.ts";
import { planAndRelease } from "./spec-holds.ts";
import { write } from "./writes.ts";

/**
 * A stored delivery run: every `DeliveryRun` field but the derived `state`, plus the project and
 * the run worktree, which core and the runner use and no page shows.
 */
export type StoredDeliveryRun = typeof deliveryRuns.$inferSelect;

/** A run's stored outcome: `active` until it ends, then how it ended. */
export type DeliveryOutcome = "active" | "passed" | "blocked" | "failed" | "cancelled";

/**
 * The outcome derived from a stored run, the one definition every read shares: no
 * `ended_at` is active; a verdict is `blocked` with a blocking finding, else `passed`; a failure
 * is `failed`; ended with neither is `cancelled`.
 */
export function deliveryOutcome(
  run: Pick<StoredDeliveryRun, "endedAt" | "verdict" | "failure">,
): DeliveryOutcome {
  if (run.endedAt === null) {
    return "active";
  }
  if (run.verdict !== null) {
    return run.verdict.findings.some((finding) => finding.severity === "blocking")
      ? "blocked"
      : "passed";
  }
  if (run.failure !== null) {
    return "failed";
  }
  return "cancelled";
}

/**
 * The pull request a stored run records: its three columns, all set or all null (the table's
 * check); null for a run that opened none.
 */
export function storedPullRequest(
  run: Pick<StoredDeliveryRun, "id" | "prNumber" | "prUrl" | "prState">,
): PullRequest | null {
  const { prNumber, prUrl, prState } = run;
  if (prNumber === null && prUrl === null && prState === null) {
    return null;
  }
  if (prNumber === null || prUrl === null || prState === null) {
    throw new Error(`Delivery run ${run.id} records part of a pull request`);
  }
  return { number: prNumber, url: prUrl, state: prState };
}

/**
 * A stored run with its derived state: an ended run's outcome; an active run the delivery runner
 * holds is `running`, one it does not hold (after a restart) is `interrupted`. `phase` is the
 * stored phase on every state.
 */
export function toDeliveryRun(run: StoredDeliveryRun, held: boolean): DeliveryRun {
  const fields = {
    id: run.id,
    specificationId: run.specificationId,
    ticketSetId: run.ticketSetId,
    number: run.number,
    branch: run.branch,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit,
    checks: run.checks,
    repairLimit: run.repairLimit,
    repairAttempts: run.repairAttempts,
    phase: run.phase,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    finalCommit: run.finalCommit,
    checkResults: run.checkResults,
    verdict: run.verdict,
    failure: run.failure,
    mergedAt: run.mergedAt,
    executor: run.executor,
    pullRequest: storedPullRequest(run),
  };
  const outcome = deliveryOutcome(run);
  switch (outcome) {
    case "active":
      return { ...fields, state: held ? "running" : "interrupted" };
    case "passed":
    case "blocked":
    case "failed":
    case "cancelled":
      return { ...fields, state: outcome };
  }
}

/**
 * Stores the phase an active run is in, guarded `ended_at IS NULL` so a late write never
 * changes an ended run; true when it was written.
 */
export function setDeliveryPhase(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  phase: DeliveryPhase,
): boolean {
  const updated = write(db, actor, (tx) =>
    tx
      .update(deliveryRuns)
      .set({ phase })
      .where(and(eq(deliveryRuns.id, runId), isNull(deliveryRuns.endedAt)))
      .run(),
  );
  return updated.changes > 0;
}

/**
 * Counts one repair attempt on an active run, guarded `ended_at IS NULL` and on the run having
 * an attempt left under its pinned limit, so a late write never changes an ended run and the count
 * never passes the limit; true when it was counted. A run from before `0033` (no pinned limit) is
 * never counted.
 */
export function countRepairAttempt(actor: Actor, db: ZeNormDatabase, runId: string): boolean {
  const updated = write(db, actor, (tx) =>
    tx
      .update(deliveryRuns)
      .set({ repairAttempts: sql`${deliveryRuns.repairAttempts} + 1` })
      .where(
        and(
          eq(deliveryRuns.id, runId),
          isNull(deliveryRuns.endedAt),
          isNotNull(deliveryRuns.repairLimit),
          isNotNull(deliveryRuns.repairAttempts),
          lt(deliveryRuns.repairAttempts, deliveryRuns.repairLimit),
        ),
      )
      .run(),
  );
  return updated.changes > 0;
}

const BRANCH_SLUG_MAX_LENGTH = 40;
const SPEC_ID_TAIL_LENGTH = 8;

/**
 * The run branch: `zenorm/<slug>-<last 8 chars of the spec id>-run-<number>`, where the slug
 * is the spec title lowercased with each run of non-`[a-z0-9]` characters as one `-`, trimmed of
 * `-`, cut to 40 characters and trimmed of a trailing `-` again, or `spec` when empty.
 */
export function deliveryBranchName(
  specTitle: string,
  specificationId: string,
  number: number,
): string {
  const slug = specTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  const name = slug === "" ? "spec" : slug;
  return `zenorm/${name}-${specificationId.slice(-SPEC_ID_TAIL_LENGTH)}-run-${String(number)}`;
}

/** The git identity every session and check of a run commits as. */
export function deliveryIdentity(runId: string): GitIdentity {
  return { name: "ZeNorm delivery", email: `run-${runId}@zenorm.invalid` };
}

/**
 * The identities a run's commits may carry: its own, then each run it resumes in turn, back to
 * the run started from clean. An unknown run in the chain is a programmer error.
 */
export function deliveryIdentities(db: Reader, runId: string): GitIdentity[] {
  const identities: GitIdentity[] = [];
  let next: string | null = runId;
  while (next !== null) {
    const run = db
      .select({ id: deliveryRuns.id, resumedFromRunId: deliveryRuns.resumedFromRunId })
      .from(deliveryRuns)
      .where(eq(deliveryRuns.id, next))
      .get();
    if (run === undefined) {
      throw new Error(`No delivery run with id ${next}`);
    }
    identities.push(deliveryIdentity(run.id));
    next = run.resumedFromRunId;
  }
  return identities;
}

/** A spec's stored runs, newest first (runs number per spec). */
export function readSpecRuns(
  db: Pick<ZeNormDatabase, "select">,
  specificationId: string,
): StoredDeliveryRun[] {
  return db
    .select()
    .from(deliveryRuns)
    .where(eq(deliveryRuns.specificationId, specificationId))
    .orderBy(desc(deliveryRuns.number))
    .all();
}

/** A ticket set's stored runs, newest first. */
export function readRuns(
  db: Pick<ZeNormDatabase, "select">,
  ticketSetId: string,
): StoredDeliveryRun[] {
  return db
    .select()
    .from(deliveryRuns)
    .where(eq(deliveryRuns.ticketSetId, ticketSetId))
    .orderBy(desc(deliveryRuns.number))
    .all();
}

function alreadyPassed(
  ticketSetId: string,
  runs: readonly StoredDeliveryRun[],
): StartDeliveryError | null {
  if (runs.some((run) => deliveryOutcome(run) === "passed")) {
    return {
      code: "delivery_already_passed",
      message: `Ticket set ${ticketSetId} already has a passed delivery run`,
      data: { ticketSetId },
    };
  }
  return null;
}

function inProgress(activeRun: ActiveRun): StartDeliveryError {
  return {
    code: "delivery_in_progress",
    message: `Spec ${String(activeRun.specNumber)} already has an active delivery run in this project`,
    data: activeRun,
  };
}

/**
 * The ticket set with its current version's content, its approved spec revision, the revision's
 * map and the map's project, all present.
 */
function readTicketSetContext(db: ZeNormDatabase, ticketSetId: string) {
  return db
    .select({
      ticketSet: ticketSets,
      content: ticketSetVersions.content,
      specRevision: specRevisions,
      map: maps,
      project: projects,
    })
    .from(ticketSets)
    .innerJoin(
      ticketSetVersions,
      and(
        eq(ticketSetVersions.ticketSetId, ticketSets.id),
        eq(ticketSetVersions.version, ticketSets.version),
      ),
    )
    .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
    .innerJoin(maps, eq(maps.id, specRevisions.mapId))
    .innerJoin(projects, eq(projects.id, maps.projectId))
    .where(eq(ticketSets.id, ticketSetId))
    .get();
}

/** A started run and the folder its git works in, from the checkout seam. */
export interface StartedDelivery {
  readonly run: StoredDeliveryRun;
  readonly folder: string;
}

/**
 * Starts a delivery run of an approved ticket set: refuses, writing nothing, in order
 * `ticket_set_not_found`, `ticket_set_not_approved`, `delivery_nothing_to_deliver` (a zero-ticket
 * set), `delivery_already_passed`, then the project's first start blocker
 * (`project_folder_missing`, `project_branch_missing`, `project_checks_missing`,
 * `project_repair_limit_missing`, `delivery_in_progress`; the folder comes from the checkout seam),
 * then `delivery_branch_exists`, then the admission seam's `delivery_not_admitted`. Otherwise it
 * resolves the base commit and stores run `latest + 1` with the project's checks, base branch,
 * repair limit and fix commands pinned and no repair attempt, in `preparing`, and one ticket row
 * per pinned ticket in order, re-checking in the same transaction; the run stores `executor`, the
 * executor carrying it. Starts no session and touches no file. Returns the run with the folder the
 * checkout seam gave: the one folder the run's git works in until it ends.
 */
export async function startDelivery(
  actor: UserActor,
  db: ZeNormDatabase,
  input: { ticketSetId: string; runsDir: string; executor: string },
): Promise<Result<StartedDelivery, StartDeliveryError>> {
  return startRun(actor, db, input, async (folder, project) => {
    const baseCommit = await branchCommit(folder, project.baseBranch);
    if (baseCommit === null) {
      return err({
        code: "project_branch_missing",
        message: `Local branch ${project.baseBranch} does not exist or has no commits`,
        data: { baseBranch: project.baseBranch },
      });
    }
    return ok({
      baseBranch: project.baseBranch,
      baseCommit,
      startCommit: baseCommit,
      resumedFromRunId: null,
      merged: [],
    });
  });
}

/** A ticket an earlier run merged, carried into the run that resumes it. */
type CarriedTicket = Pick<
  typeof deliveryRunTickets.$inferSelect,
  "ticket" | "startedAt" | "mergedAt" | "commit" | "summary"
>;

/**
 * Where a new run starts: the base it is measured from, the commit its branch is created at, and
 * for a resume, the run it resumes and the tickets that run merged.
 */
interface StartPoint {
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly startCommit: string;
  readonly resumedFromRunId: string | null;
  readonly merged: readonly CarriedTicket[];
}

/**
 * Resumes a failed, blocked or cancelled run: starts the next run of its ticket set with its branch
 * created at the resumed run's branch head, measured from the resumed run's base commit, and with
 * every ticket the resumed run merged already merged (its row copied). The executor implements the
 * rest. Refuses, writing nothing, `delivery_run_not_found`, then `delivery_run_not_resumable` (the
 * run is active or passed), then every `startDelivery` refusal in its order, with
 * `delivery_run_branch_missing` (the resumed run's branch is gone) in place of the base branch's
 * commit check.
 */
export async function resumeDelivery(
  actor: UserActor,
  db: ZeNormDatabase,
  input: { runId: string; runsDir: string; executor: string },
): Promise<Result<StartedDelivery, ResumeDeliveryError>> {
  const { runId, runsDir, executor } = input;
  const source = db.select().from(deliveryRuns).where(eq(deliveryRuns.id, runId)).get();
  if (source === undefined) {
    return err({
      code: "delivery_run_not_found",
      message: `No delivery run with id ${runId}`,
      data: { runId },
    });
  }
  const outcome = deliveryOutcome(source);
  if (outcome === "active" || outcome === "passed") {
    return err({
      code: "delivery_run_not_resumable",
      message: `Delivery run ${runId} is ${outcome}: only a failed, blocked or cancelled run resumes`,
      data: { runId },
    });
  }
  const merged = db
    .select({
      ticket: deliveryRunTickets.ticket,
      startedAt: deliveryRunTickets.startedAt,
      mergedAt: deliveryRunTickets.mergedAt,
      commit: deliveryRunTickets.commit,
      summary: deliveryRunTickets.summary,
    })
    .from(deliveryRunTickets)
    .where(and(eq(deliveryRunTickets.runId, runId), isNotNull(deliveryRunTickets.mergedAt)))
    .orderBy(asc(deliveryRunTickets.position))
    .all();
  return startRun(
    actor,
    db,
    { ticketSetId: source.ticketSetId, runsDir, executor },
    async (folder) => {
      const head = await branchCommit(folder, source.branch);
      if (head === null) {
        return err({
          code: "delivery_run_branch_missing",
          message: `Delivery run ${String(source.number)}'s branch ${source.branch} is gone from ${folder}`,
          data: { runId, branch: source.branch },
        });
      }
      return ok({
        baseBranch: source.baseBranch,
        baseCommit: source.baseCommit,
        startCommit: head,
        resumedFromRunId: source.id,
        merged,
      });
    },
  );
}

/**
 * The start both `startDelivery` and `resumeDelivery` make, after their own refusals: `startAt`
 * resolves where the run starts, in the folder the checkout seam gave, after the branch-exists
 * check; its refusal is the start's.
 */
async function startRun<E extends CodedError<string>>(
  actor: UserActor,
  db: ZeNormDatabase,
  input: { ticketSetId: string; runsDir: string; executor: string },
  startAt: (
    folder: string,
    project: typeof projects.$inferSelect,
  ) => Promise<Result<StartPoint, E>>,
): Promise<Result<StartedDelivery, StartDeliveryError | E>> {
  const { ticketSetId, runsDir, executor } = input;
  const context = readTicketSetContext(db, ticketSetId);
  if (context === undefined) {
    return err({
      code: "ticket_set_not_found",
      message: `No ticket set with id ${ticketSetId}`,
      data: { ticketSetId },
    });
  }
  const { ticketSet, content, specRevision, project } = context;
  const { specificationId } = specRevision;
  if (ticketSet.state !== "approved") {
    return err({
      code: "ticket_set_not_approved",
      message: `Ticket set ${ticketSetId} is not approved`,
      data: { ticketSetId },
    });
  }
  if (content.tickets.length === 0) {
    return err({
      code: "delivery_nothing_to_deliver",
      message: `Ticket set ${ticketSetId} has no ticket: there is nothing to deliver`,
      data: { ticketSetId },
    });
  }
  const passed = alreadyPassed(ticketSetId, readRuns(db, ticketSetId));
  if (passed !== null) {
    return err(passed);
  }
  const seams = seamsOf(db);
  // The checkout seam gives the folder the start works in; core's is the stored folder.
  const checkedOut = await seams.checkout(project);
  if (!checkedOut.ok) {
    return err(checkedOut.error);
  }
  const folder = checkedOut.value;
  const activeRun = readActiveRun(db, project.id);
  const [blocker] = await startDeliveryBlockers({ ...project, folderPath: folder }, activeRun);
  switch (blocker) {
    case undefined:
      break;
    case "project_folder_missing":
      return err({
        code: "project_folder_missing",
        message: `${project.folderPath} does not exist or is not a directory`,
        data: { folderPath: project.folderPath },
      });
    case "project_branch_missing":
      return err({
        code: "project_branch_missing",
        message: `Local branch ${project.baseBranch} does not exist or has no commits`,
        data: { baseBranch: project.baseBranch },
      });
    case "project_checks_missing":
      return err({
        code: "project_checks_missing",
        message: `Project ${project.id} has no required checks`,
        data: { projectId: project.id },
      });
    case "project_repair_limit_missing":
      return err({
        code: "project_repair_limit_missing",
        message: `Project ${project.id} has no saved repair limit`,
        data: { projectId: project.id },
      });
    case "delivery_in_progress":
      if (activeRun === null) {
        throw new Error(`Project ${project.id} is blocked by an active run it does not have`);
      }
      return err(inProgress(activeRun));
  }
  const [firstCheck, ...otherChecks] = project.requiredChecks;
  if (firstCheck === undefined) {
    throw new Error(`Project ${project.id} passed the checks blocker with no checks`);
  }
  const checks: DeliveryChecks = [firstCheck, ...otherChecks];
  const { repairLimit, fixCommands } = project;
  if (repairLimit === null) {
    throw new Error(`Project ${project.id} passed the repair limit blocker with no limit`);
  }
  const latest = readSpecRuns(db, specificationId)[0]?.number;
  const number = latest === undefined ? 1 : latest + 1;
  const branch = deliveryBranchName(specRevision.content.title, specificationId, number);
  const shown = await runGit(folder, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (shown.exitCode === 0) {
    return err({
      code: "delivery_branch_exists",
      message: `Branch ${branch} already exists in ${folder}`,
      data: { branch },
    });
  }
  const start = await startAt(folder, project);
  if (!start.ok) {
    return err(start.error);
  }
  const { baseBranch, baseCommit, startCommit, resumedFromRunId } = start.value;
  const carried = new Map(start.value.merged.map((row) => [row.ticket, row]));

  // Run admission, last: a wrapper refuses only a start core would make.
  const admitted = await seams.admitRun({
    kind: "delivery",
    projectId: project.id,
    userId: actor.userId,
    ticketSetId,
  });
  if (!admitted.ok) {
    return err(admitted.error);
  }
  const id = uuidv7();
  // The executor environment seam is called at the start; its result reaches no port.
  seams.executorEnv({ id, projectId: project.id });
  const run: StoredDeliveryRun = {
    id,
    projectId: project.id,
    specificationId,
    ticketSetId,
    number,
    branch,
    worktreePath: join(runsDir, id, "worktree"),
    baseBranch,
    baseCommit,
    startCommit,
    resumedFromRunId,
    checks,
    phase: "preparing",
    startedAt: new Date().toISOString(),
    endedAt: null,
    finalCommit: null,
    checkResults: null,
    verdict: null,
    failure: null,
    mergedAt: null,
    // A run started by a person takes that User.
    userId: actor.userId,
    executor,
    // The project's repair rules, pinned: a settings change mid-run leaves the run's own.
    repairLimit,
    repairAttempts: 0,
    fixCommands: [...fixCommands],
    // A run opens its pull request, if any, at its end.
    prNumber: null,
    prUrl: null,
    prState: null,
  };
  const ticketRows = content.tickets.map((ticket, index) => {
    const merged = carried.get(ticket.id);
    return {
      runId: id,
      ticket: ticket.id,
      position: index + 1,
      startedAt: merged === undefined ? null : merged.startedAt,
      mergedAt: merged === undefined ? null : merged.mergedAt,
      commit: merged === undefined ? null : merged.commit,
      summary: merged === undefined ? null : merged.summary,
    };
  });
  let stored: Result<StartedDelivery, StartDeliveryError | E> | "stale";
  try {
    stored = write(db, actor, (tx): Result<StartedDelivery, StartDeliveryError | E> | "stale" => {
      const currentPassed = alreadyPassed(ticketSetId, readRuns(tx, ticketSetId));
      if (currentPassed !== null) {
        return err(currentPassed);
      }
      const currentActive = readActiveRun(tx, project.id);
      if (currentActive !== null) {
        return err(inProgress(currentActive));
      }
      // Another start numbered and ended a run of this spec since the read above: the branch
      // name is stale.
      if (readSpecRuns(tx, specificationId)[0]?.number !== latest) {
        return "stale";
      }
      tx.insert(deliveryRuns).values(run).run();
      tx.insert(deliveryRunTickets).values(ticketRows).run();
      return ok({ run, folder });
    });
  } catch (error: unknown) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    // A start in another connection won the per-project index between the re-check and
    // the insert.
    const winner = readActiveRun(db, project.id);
    if (winner === null) {
      throw error;
    }
    return err(inProgress(winner));
  }
  // Start over from the reads: the next number and its branch are checked again.
  return stored === "stale" ? startRun(actor, db, input, startAt) : stored;
}

export type DeliveryRunNotFoundError = Extract<
  CancelDeliveryError,
  { code: "delivery_run_not_found" }
>;

/** Why an end write was refused: the run is unknown, or it had already ended. */
export type EndDeliveryError = CodedError<"delivery_run_not_found" | "delivery_run_ended">;

/** The stored run with this id, or `delivery_run_not_found`. */
export async function getDeliveryRun(
  db: ZeNormDatabase,
  runId: string,
): Promise<Result<StoredDeliveryRun, DeliveryRunNotFoundError>> {
  const [run] = await db.select().from(deliveryRuns).where(eq(deliveryRuns.id, runId)).limit(1);
  if (run === undefined) {
    return err({
      code: "delivery_run_not_found",
      message: `No delivery run with id ${runId}`,
      data: { runId },
    });
  }
  return ok(run);
}

/** A git or file failure while preparing the run worktree; the message carries git's stderr. */
export type PrepareDeliveryError = CodedError<"delivery_worktree_failed">;

/** What the runner needs after preparing: the run folder and the rendered inputs. */
export interface PreparedDelivery {
  readonly runDir: string;
  readonly specPath: string;
  readonly ticketsPath: string;
  readonly ticketCount: number;
  /** The pinned tickets, in order. */
  readonly tickets: { id: string; title: string }[];
  /** The pinned spec revision's number, for the runner's lines ("spec r<N>"). */
  readonly specRevision: number;
  /** The pinned spec revision's title: the title of the pull request a passing run opens. */
  readonly specTitle: string;
  /** The pinned tickets already merged into the run branch (a resumed run's), in order. */
  readonly merged: string[];
  /** Why the resumed run failed or was blocked; null from clean or resuming a cancelled run. */
  readonly resumedFrom: ResumedFrom | null;
}

/**
 * Why the run `runId` ended, for the run that resumes it: its failure, its checks that did not pass
 * (each with its whole output's log, null for a run from before the logs) and its blocking findings; null when it ended with none of them (cancelled). An unknown run is a
 * programmer error.
 */
function resumedFromOf(db: Reader, runId: string): ResumedFrom | null {
  const source = db.select().from(deliveryRuns).where(eq(deliveryRuns.id, runId)).get();
  if (source === undefined) {
    throw new Error(`No delivery run with id ${runId}`);
  }
  const sourceDir = dirname(source.worktreePath);
  const failedChecks =
    source.checkResults === null
      ? []
      : source.checkResults.flatMap((result, index) => {
          if (checkPassed(result)) return [];
          const logPath = checkLogPath(sourceDir, index);
          return [{ result, logPath: existsSync(logPath) ? logPath : null }];
        });
  const blockingFindings =
    source.verdict === null
      ? []
      : source.verdict.findings.filter((finding) => finding.severity === "blocking");
  if (source.failure === null && failedChecks.length === 0 && blockingFindings.length === 0) {
    return null;
  }
  return { number: source.number, failure: source.failure, failedChecks, blockingFindings };
}

function bullets(lines: readonly string[]): string[] {
  return lines.map((line) => `- ${line}`);
}

/** A clause source in the rendered spec: a waypoint, the destination, or the person's note. */
function sourceWords(source: ClauseSource): string {
  switch (source.kind) {
    case "waypoint":
      return `waypoint ${String(source.number)}`;
    case "destination":
      return "the destination";
    case "note":
      return "a note from the person";
  }
}

/** The pinned approved revision as markdown: its clauses and criteria by id, with sources. */
export function renderSpec(spec: SpecRevisionContent): string {
  const clauses = spec.clauses.flatMap((clause) => [
    `### ${clause.id} ${clause.title}`,
    "",
    clause.text,
    "",
    `Sources: ${clause.sources.map(sourceWords).join(", ")}.`,
    "",
    ...clause.criteria.map(
      (criterion) =>
        `- **${criterion.id}** ${criterion.text}${criterion.was === undefined ? "" : ` (was ${criterion.was})`}`,
    ),
    "",
  ]);
  return [
    `# ${spec.title}`,
    "",
    "## Problem",
    "",
    spec.problem,
    "",
    "## Solution",
    "",
    spec.solution,
    "",
    "## Clauses and acceptance criteria",
    "",
    ...clauses,
    "## Out of scope",
    "",
    ...(spec.outOfScope.length === 0 ? ["None."] : bullets(spec.outOfScope)),
    "",
  ].join("\n");
}

/** Where a followed-up ticket was delivered: its run number and merged commit. */
export interface FollowedDelivery {
  readonly run: number;
  readonly commit: string;
}

/**
 * The pinned approved ticket set as markdown: its tickets by id, each with its pointers. The
 * set's dispositions, slicing and execution are planning records no delivery session reads, so
 * they are left out.
 * A follow-up ticket names the ticket it changes with the run and commit that delivered it
 * (`followUps`, by the followed ticket's id), and a ticket a `removed` disposition names says which
 * criterion it takes out, so `implement-spec` sees what each ticket changes.
 */
export function renderTickets(
  set: TicketSetContent,
  followUps: Readonly<Record<string, FollowedDelivery>>,
): string {
  const followUpLine = (followed: string): string => {
    const delivery = followUps[followed];
    if (delivery === undefined) {
      throw new Error(`Ticket ${followed} is followed up but its delivery was not passed`);
    }
    return `Follow-up to ${followed} (run ${String(delivery.run)}, commit ${delivery.commit}).`;
  };
  const tickets = set.tickets.flatMap((ticket) => [
    `## ${ticket.id} ${ticket.title}`,
    "",
    ticket.build,
    "",
    // Empty only on a ticket stored before pointers existed (migration 0014).
    ...(ticket.pointers.length === 0
      ? ["Pointers: none recorded.", ""]
      : ["Pointers:", "", ...bullets(ticket.pointers), ""]),
    ticket.criteria.length === 0
      ? "Carries no criteria."
      : `Carries criteria ${ticket.criteria.join(", ")}.`,
    "",
    ticket.blockedBy.length === 0
      ? "Blocked by none."
      : `Blocked by ${ticket.blockedBy.map((blocker) => `${blocker.ticket} (${blocker.supplies})`).join(", ")}.`,
    "",
    ...(ticket.followUp === null ? [] : [followUpLine(ticket.followUp), ""]),
    ...set.dispositions.flatMap((disposition) =>
      disposition.kind === "removed" && disposition.ticket === ticket.id
        ? [`Takes out ${disposition.criterion} (${disposition.reason}).`, ""]
        : [],
    ),
    "Testing and completion:",
    "",
    ...bullets(ticket.testing),
    "",
    "Out of scope:",
    "",
    ...(ticket.outOfScope.length === 0 ? ["None."] : bullets(ticket.outOfScope)),
    "",
  ]);
  return ["# Tickets", "", ...tickets].join("\n");
}

/** The delivery each follow-up of a revision's set names; one missing is a programmer error. */
function followUpsOf(
  db: ZeNormDatabase,
  revision: { specificationId: string; revision: number },
  content: TicketSetContent,
): Record<string, FollowedDelivery> {
  const spec = readSpecRecord(db, revision.specificationId);
  const followUps: Record<string, FollowedDelivery> = {};
  for (const ticket of content.tickets) {
    if (ticket.followUp === null) continue;
    const delivery = deliveredTicket(spec, revision.revision, ticket.followUp);
    if (delivery === null) {
      throw new Error(
        `Ticket ${ticket.id} follows up ${ticket.followUp}, which no merged run delivered`,
      );
    }
    followUps[ticket.followUp] = { run: delivery.run, commit: delivery.commit };
  }
  return followUps;
}

function worktreeFailed(message: string): Result<never, PrepareDeliveryError> {
  return err({ code: "delivery_worktree_failed", message });
}

function isFileError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

/**
 * Checks out the submodules of the checkout at `worktree`, recursively, each cloned from the
 * project's own checkout of it under `source`, so a run needs no network and gets the commits the
 * project has locally. A submodule the project has not checked out fails the preparation.
 */
async function checkOutSubmodules(
  worktree: string,
  source: string,
): Promise<Result<null, PrepareDeliveryError>> {
  if (!existsSync(join(worktree, ".gitmodules"))) {
    return ok(null);
  }
  const listed = await runGit(worktree, [
    "config",
    "--file",
    ".gitmodules",
    "--null",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!("stdout" in listed)) {
    // Exit 1: a `.gitmodules` naming no submodule path.
    if (listed.exitCode === 1) {
      return ok(null);
    }
    return worktreeFailed(
      `Reading ${join(worktree, ".gitmodules")} exited ${String(listed.exitCode)}: ${listed.stderr.trim()}`,
    );
  }
  for (const entry of listed.stdout.split("\0").filter((line) => line !== "")) {
    const newline = entry.indexOf("\n");
    const name = entry.slice("submodule.".length, newline - ".path".length);
    const path = entry.slice(newline + 1);
    const sourcePath = join(source, path);
    const topLevel = (await isDirectory(sourcePath)) ? await repositoryTopLevel(sourcePath) : null;
    if (topLevel === null || (await realpath(topLevel)) !== (await realpath(sourcePath))) {
      return worktreeFailed(
        `The submodule ${path} is not checked out in ${source}; run git submodule update --init there`,
      );
    }
    const updated = await runGit(worktree, [
      "-c",
      "protocol.file.allow=always",
      "-c",
      `submodule.${name}.url=${sourcePath}`,
      "submodule",
      "update",
      "--init",
      "--",
      path,
    ]);
    if (!("stdout" in updated)) {
      return worktreeFailed(
        `git submodule update for ${path} exited ${String(updated.exitCode)}: ${updated.stderr.trim()}`,
      );
    }
    const nested = await checkOutSubmodules(join(worktree, path), sourcePath);
    if (!nested.ok) {
      return nested;
    }
  }
  return ok(null);
}

/**
 * Prepares a started run (its `preparing` phase): creates `<runDir>/tickets` and `<runDir>/inputs`
 * (and with them `runsDir`), adds the run worktree on a new run branch at the start commit (the
 * base commit, or a resumed run's branch head) from
 * `folder` (the one `startDelivery` resolved), checks out its submodules from the
 * project's own checkouts of them, and writes `inputs/spec.md` and `inputs/tickets.md` from the pinned rows.
 * A git or file failure is `delivery_worktree_failed`. An unknown `runId` is a programmer error
 * (the runner prepares the run it just started), so it throws.
 */
export async function prepareDelivery(
  db: ZeNormDatabase,
  runId: string,
  folder: string,
): Promise<Result<PreparedDelivery, PrepareDeliveryError>> {
  const run = db.select().from(deliveryRuns).where(eq(deliveryRuns.id, runId)).get();
  if (run === undefined) {
    throw new Error(`No delivery run with id ${runId}`);
  }
  const context = readTicketSetContext(db, run.ticketSetId);
  if (context === undefined) {
    throw new Error(`Delivery run ${runId}'s ticket set ${run.ticketSetId} is missing`);
  }
  const { content, specRevision } = context;
  const runDir = dirname(run.worktreePath);
  const inputsDir = join(runDir, "inputs");
  const specPath = join(inputsDir, "spec.md");
  const ticketsPath = join(inputsDir, "tickets.md");

  try {
    await mkdir(join(runDir, "tickets"), { recursive: true });
    await mkdir(inputsDir, { recursive: true });
  } catch (error: unknown) {
    if (!isFileError(error)) throw error;
    return worktreeFailed(`Could not create the run folder ${runDir}: ${error.message}`);
  }

  const added = await runGit(folder, [
    "worktree",
    "add",
    "-b",
    run.branch,
    run.worktreePath,
    run.startCommit,
  ]);
  if (!("stdout" in added)) {
    return worktreeFailed(
      `git worktree add exited ${String(added.exitCode)}: ${added.stderr.trim()}`,
    );
  }
  const submodules = await checkOutSubmodules(run.worktreePath, folder);
  if (!submodules.ok) {
    return submodules;
  }

  try {
    await writeFile(specPath, renderSpec(specRevision.content));
    await writeFile(ticketsPath, renderTickets(content, followUpsOf(db, specRevision, content)));
  } catch (error: unknown) {
    if (!isFileError(error)) throw error;
    return worktreeFailed(`Could not write the run inputs in ${inputsDir}: ${error.message}`);
  }

  return ok({
    runDir,
    specPath,
    ticketsPath,
    ticketCount: content.tickets.length,
    tickets: content.tickets.map((ticket) => ({ id: ticket.id, title: ticket.title })),
    specRevision: specRevision.revision,
    specTitle: specRevision.content.title,
    merged: db
      .select({ ticket: deliveryRunTickets.ticket })
      .from(deliveryRunTickets)
      .where(and(eq(deliveryRunTickets.runId, runId), isNotNull(deliveryRunTickets.mergedAt)))
      .orderBy(asc(deliveryRunTickets.position))
      .all()
      .map((row) => row.ticket),
    resumedFrom: run.resumedFromRunId === null ? null : resumedFromOf(db, run.resumedFromRunId),
  });
}

/** The porcelain status lines' paths. */
function statusPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));
}

export type VerifyDeliveryError = CodedError<
  "delivery_worktree_dirty" | "delivery_no_commits" | "delivery_foreign_commit"
>;

/**
 * Verifies the orchestrator's work from git in the run worktree, stopping at the first
 * failure: on the run branch with a clean `git status --porcelain` (`delivery_worktree_dirty`,
 * naming the paths); `final` is the branch's commit; `baseCommit` is an ancestor of `final` and
 * `base..final` is not empty (`delivery_no_commits`); after a repair attempt, `repairedFrom` (the
 * previous check pass's final commit) is an ancestor of `final` and `repairedFrom..final` is not
 * empty either (`delivery_no_commits`): the attempt must add a commit. Every commit in
 * `base..final` has the committer email of one of `identities`, the run's and those of the runs it
 * resumes (`delivery_foreign_commit`, naming the commit). Runs no check.
 */
export async function verifyDelivery(input: {
  worktreePath: string;
  branch: string;
  baseCommit: string;
  /** The final commit the previous check pass ran on, on a repair attempt; else null. */
  repairedFrom: string | null;
  identities: readonly GitIdentity[];
}): Promise<Result<{ finalCommit: string }, VerifyDeliveryError>> {
  const { worktreePath, branch, baseCommit, repairedFrom, identities } = input;
  const emails = identities.map((identity) => identity.email);
  const head = await runGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = "stdout" in head ? head.stdout.replace(/\n$/, "") : null;
  if (headRef !== `refs/heads/${branch}`) {
    return err({
      code: "delivery_worktree_dirty",
      message:
        headRef === null
          ? `The run worktree ${worktreePath} has a detached HEAD, not refs/heads/${branch}`
          : `The run worktree ${worktreePath} is on ${headRef}, not refs/heads/${branch}`,
    });
  }
  const status = await gitOutput(worktreePath, ["status", "--porcelain"]);
  if (status !== "") {
    return err({
      code: "delivery_worktree_dirty",
      message: `The run worktree has uncommitted changes: ${statusPaths(status).join(", ")}`,
    });
  }
  const finalCommit = await branchCommit(worktreePath, branch);
  if (finalCommit === null) {
    throw new Error(`Branch ${branch} is checked out in ${worktreePath} but has no commit`);
  }
  const ancestor = await runGit(worktreePath, [
    "merge-base",
    "--is-ancestor",
    baseCommit,
    finalCommit,
  ]);
  const count = await gitOutput(worktreePath, [
    "rev-list",
    "--count",
    `${baseCommit}..${finalCommit}`,
  ]);
  if (ancestor.exitCode !== 0 || count === "0") {
    return err({
      code: "delivery_no_commits",
      message: `Branch ${branch} at ${finalCommit} has no commits on top of the base commit ${baseCommit}`,
    });
  }
  if (repairedFrom !== null) {
    const onTop = await runGit(worktreePath, [
      "merge-base",
      "--is-ancestor",
      repairedFrom,
      finalCommit,
    ]);
    const added = await gitOutput(worktreePath, [
      "rev-list",
      "--count",
      `${repairedFrom}..${finalCommit}`,
    ]);
    if (onTop.exitCode !== 0 || added === "0") {
      return err({
        code: "delivery_no_commits",
        message: `The repair attempt added no commits: branch ${branch} at ${finalCommit} has none on top of ${repairedFrom}, where the checks failed`,
      });
    }
  }
  const log = await gitOutput(worktreePath, [
    "log",
    "--format=%H %ce",
    `${baseCommit}..${finalCommit}`,
  ]);
  for (const line of log.split("\n")) {
    const separator = line.indexOf(" ");
    const commit = line.slice(0, separator);
    const email = line.slice(separator + 1);
    if (separator === -1 || !emails.includes(email)) {
      return err({
        code: "delivery_foreign_commit",
        message: `Commit ${commit} has committer email ${JSON.stringify(email)}, not ${emails.join(" or ")}`,
      });
    }
  }
  return ok({ finalCommit });
}

/** How long a check killed with SIGTERM has before its process group gets SIGKILL. */
const CHECK_KILL_GRACE_MS = 10_000;

/**
 * Signals a process group, ignoring a group that has exited (ESRCH) or is exiting (EPERM, which
 * macOS returns while the group's members are being reaped).
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (isFileError(error) && (error.code === "ESRCH" || error.code === "EPERM")) {
      return;
    }
    throw error;
  }
}

function tail(output: string): string {
  return output.slice(-CHECK_OUTPUT_TAIL_MAX_LENGTH);
}

/**
 * Runs one check in its own process group, writing its whole output to `logPath`; resolves when it
 * has exited, closed its output and the log is written. A log write failure is said at the end of
 * the output tail.
 */
function runCheck(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal: AbortSignal;
    logPath: string;
  },
): Promise<CheckResult> {
  const [file, ...args] = command.split(/\s+/);
  if (file === undefined || file === "") {
    throw new Error(`Check command ${JSON.stringify(command)} is empty`);
  }
  const started = performance.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let logError: string | null = null;
    const log = createWriteStream(options.logPath);
    log.on("error", (error) => {
      logError = error.message;
    });
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: Buffer): void => {
      log.write(chunk);
      output = tail(output + chunk.toString("utf8"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const stop = (): void => {
      const pid = child.pid;
      if (pid === undefined || killTimer !== undefined) {
        return;
      }
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
      }, CHECK_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal.addEventListener("abort", stop);

    const finish = (exitCode: number | null, extra: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Once stopped, the SIGKILL still fires: the leader closing does not mean the group is gone.
      options.signal.removeEventListener("abort", stop);
      const durationMs = Math.round(performance.now() - started);
      log.end(extra, () => {
        const unlogged =
          logError === null
            ? ""
            : `\nZeNorm could not write the whole output to ${options.logPath}: ${logError}`;
        resolve({
          command,
          exitCode,
          timedOut,
          durationMs,
          outputTail: tail(output + extra + unlogged),
        });
      });
    };
    child.on("error", (error) => {
      // A spawn failure (ENOENT, EACCES) never starts the process; there is no exit to wait for.
      if (child.pid === undefined) {
        finish(null, error.message);
      }
    });
    child.on("close", (code) => {
      finish(code, "");
    });
  });
}

/** Where Verify writes the whole output of a run's check `index` (from 0): `<runDir>/checks/`. */
export function checkLogPath(runDir: string, index: number): string {
  return join(runDir, "checks", `check-${String(index + 1)}.log`);
}

/**
 * Runs every check in order in the run worktree, each split on whitespace and spawned
 * without a shell, detached in its own process group, its whole output written to
 * `checkLogPath(runDir, index)`. `env` is the complete environment each
 * check receives: the server's environment plus the run identity (`gitIdentityEnv`). A check
 * past `timeoutMs`, or running when `signal` aborts, gets SIGTERM to its group and SIGKILL 10 s
 * later. Every check runs even after one fails; none starts after `signal` has aborted. A failing
 * check is data, so this returns results, never a refusal.
 */
export async function runChecks(input: {
  worktreePath: string;
  runDir: string;
  checks: DeliveryChecks;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<CheckResult[]> {
  return runChecksReporting(input, () => undefined);
}

/**
 * `runChecks`, telling `onResult` each check's result as it finishes, with the results so
 * far (this one last), before the next check starts; the runner stores them with
 * `storeCheckResults` so Verify reads "k of n" while it works.
 */
export async function runChecksReporting(
  input: {
    worktreePath: string;
    runDir: string;
    checks: DeliveryChecks;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  },
  onResult: (resultsSoFar: readonly CheckResult[]) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  await mkdir(join(input.runDir, "checks"), { recursive: true });
  for (const [index, command] of input.checks.entries()) {
    if (input.signal.aborted) {
      break;
    }
    results.push(
      await runCheck(command, {
        cwd: input.worktreePath,
        env: input.env,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        logPath: checkLogPath(input.runDir, index),
      }),
    );
    onResult([...results]);
  }
  return results;
}

/**
 * Stores the check results so far on an active run, guarded `ended_at IS NULL` so a late
 * write never changes an ended run; true when it was written.
 */
export function storeCheckResults(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  results: readonly CheckResult[],
): boolean {
  const updated = write(db, actor, (tx) =>
    tx
      .update(deliveryRuns)
      .set({ checkResults: [...results] })
      .where(and(eq(deliveryRuns.id, runId), isNull(deliveryRuns.endedAt)))
      .run(),
  );
  return updated.changes > 0;
}

/** True when a check passed: it exited 0 within its time. */
export function checkPassed(result: CheckResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

/** What the reviewer gets and the snapshot its acceptance compares against. */
export interface PreparedReview {
  readonly diffPath: string;
  /** Paths relative to the worktree. */
  readonly changedFiles: string[];
  /** `git status --porcelain` after the checks and the diff; the reviewer must leave it as is. */
  readonly statusSnapshot: string;
}

/**
 * Writes `git diff <base> <final>` to `<runDir>/review.diff` (to a file, never through stdout,
 * whose buffer is 1 MiB), lists the changed files and snapshots `git status --porcelain`. A git
 * failure here is a programmer error (verifying resolved both commits), so it throws.
 */
export async function prepareReview(input: {
  runDir: string;
  worktreePath: string;
  baseCommit: string;
  finalCommit: string;
}): Promise<PreparedReview> {
  const { runDir, worktreePath, baseCommit, finalCommit } = input;
  const diffPath = join(runDir, "review.diff");
  await gitOutput(worktreePath, ["diff", `--output=${diffPath}`, baseCommit, finalCommit]);
  const names = await gitOutput(worktreePath, ["diff", "--name-only", baseCommit, finalCommit]);
  const statusSnapshot = await gitOutput(worktreePath, ["status", "--porcelain"]);
  return {
    diffPath,
    changedFiles: names.split("\n").filter((name) => name !== ""),
    statusSnapshot,
  };
}

export type AcceptVerdictError = CodedError<
  "delivery_verdict_invalid" | "delivery_review_changed_worktree"
>;

/**
 * Accepts the reviewer's verdict: `delivery_verdict_invalid` when it reviewed another
 * commit; `delivery_review_changed_worktree` when the branch head is no longer `finalCommit` or
 * `git status --porcelain` differs from the snapshot taken before the review.
 */
export async function acceptVerdict(input: {
  worktreePath: string;
  branch: string;
  finalCommit: string;
  statusSnapshot: string;
  verdict: Verdict;
}): Promise<Result<null, AcceptVerdictError>> {
  const { worktreePath, branch, finalCommit, statusSnapshot, verdict } = input;
  if (verdict.reviewedCommit !== finalCommit) {
    return err({
      code: "delivery_verdict_invalid",
      message: `The verdict reviewed ${verdict.reviewedCommit}, not the final commit ${finalCommit}`,
    });
  }
  const head = await branchCommit(worktreePath, branch);
  if (head !== finalCommit) {
    return err({
      code: "delivery_review_changed_worktree",
      message:
        head === null
          ? `Branch ${branch} no longer resolves to a commit after the review`
          : `Branch ${branch} moved from ${finalCommit} to ${head} during the review`,
    });
  }
  const status = await gitOutput(worktreePath, ["status", "--porcelain"]);
  if (status !== statusSnapshot) {
    return err({
      code: "delivery_review_changed_worktree",
      message: `The run worktree's status changed during the review: ${statusPaths(status).join(", ")}`,
    });
  }
  return ok(null);
}

/**
 * How a run ends: with an accepted verdict (and, for a passing run on a GitHub project, the pull
 * request it opened), a failure, or a cancel.
 */
export type DeliveryEnd =
  | {
      readonly kind: "verdict";
      readonly verdict: Verdict;
      readonly finalCommit: string;
      readonly checkResults: CheckResult[];
      /** The pull request the run opened; null when it opened none. */
      readonly pullRequest: PullRequest | null;
    }
  | {
      readonly kind: "failure";
      readonly failure: DeliveryFailure;
      readonly finalCommit: string | null;
      readonly checkResults: CheckResult[] | null;
    }
  | { readonly kind: "cancelled" };

function endValues(end: DeliveryEnd, endedAt: string): Partial<StoredDeliveryRun> {
  switch (end.kind) {
    case "verdict":
      return {
        endedAt,
        verdict: end.verdict,
        finalCommit: end.finalCommit,
        checkResults: end.checkResults,
        prNumber: end.pullRequest === null ? null : end.pullRequest.number,
        prUrl: end.pullRequest === null ? null : end.pullRequest.url,
        prState: end.pullRequest === null ? null : end.pullRequest.state,
      };
    case "failure":
      return {
        endedAt,
        failure: end.failure,
        finalCommit: end.finalCommit,
        checkResults: end.checkResults,
      };
    case "cancelled":
      return { endedAt };
  }
}

/**
 * Ends an active run with one write guarded `WHERE id = ? AND ended_at IS NULL`, so a late
 * result never overwrites a cancel: `delivery_run_not_found` for an unknown id,
 * `delivery_run_ended` when the run had already ended.
 */
export async function endDelivery(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
  end: DeliveryEnd,
): Promise<Result<StoredDeliveryRun, EndDeliveryError>> {
  const found = await getDeliveryRun(db, runId);
  if (!found.ok) {
    return found;
  }
  const ended = err({
    code: "delivery_run_ended",
    message: `Delivery run ${runId} has already ended`,
  } as const);
  if (found.value.endedAt !== null) {
    return ended;
  }
  const landed = write(db, actor, (tx): boolean => {
    const updated = tx
      .update(deliveryRuns)
      .set(endValues(end, new Date().toISOString()))
      .where(and(eq(deliveryRuns.id, runId), isNull(deliveryRuns.endedAt)))
      .run();
    if (updated.changes === 0) {
      return false;
    }
    // The run's end ends its `delivering` hold: its map's due runs and a release run on its spec
    // start in the same transaction.
    planAndRelease(actor, tx, deliveryMapId(tx, found.value.ticketSetId));
    return true;
  });
  if (!landed) {
    return ended;
  }
  const stored = await getDeliveryRun(db, runId);
  if (!stored.ok) {
    throw new Error(`Delivery run ${runId} vanished after its end was stored`);
  }
  return stored;
}

/** The map that wrote the revision a delivered ticket set is of. */
function deliveryMapId(db: Reader, ticketSetId: string): string {
  const row = db
    .select({ mapId: specRevisions.mapId })
    .from(ticketSets)
    .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
    .where(eq(ticketSets.id, ticketSetId))
    .get();
  if (row === undefined) {
    throw new Error(`Ticket set ${ticketSetId} has no revision`);
  }
  return row.mapId;
}

/** Ends an active run as cancelled: `ended_at` only, no verdict, no failure. */
export async function cancelDelivery(
  actor: Actor,
  db: ZeNormDatabase,
  runId: string,
): Promise<Result<StoredDeliveryRun, CancelDeliveryError>> {
  const ended = await endDelivery(actor, db, runId, { kind: "cancelled" });
  if (ended.ok) {
    return ended;
  }
  const { code, message } = ended.error;
  return err({ code, message, data: { runId } });
}

/**
 * Checks the criterion each verdict finding names: `delivery_verdict_invalid` when one is
 * not a criterion id of the run's pinned revision; null is accepted. The runner calls it beside
 * `acceptVerdict`. An unknown run is a programmer error.
 */
export function checkVerdictCriteria(
  db: ZeNormDatabase,
  runId: string,
  verdict: Verdict,
): Result<null, CodedError<"delivery_verdict_invalid">> {
  const pinned = db
    .select({ content: specRevisions.content })
    .from(deliveryRuns)
    .innerJoin(ticketSets, eq(ticketSets.id, deliveryRuns.ticketSetId))
    .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
    .where(eq(deliveryRuns.id, runId))
    .get();
  if (pinned === undefined) {
    throw new Error(`No delivery run with id ${runId}`);
  }
  const known = new Set(
    pinned.content.clauses.flatMap((clause) => clause.criteria.map((criterion) => criterion.id)),
  );
  const unknown = verdict.findings
    .map((finding) => finding.criterion)
    .filter((criterion): criterion is string => criterion !== null && !known.has(criterion));
  if (unknown.length > 0) {
    return err({
      code: "delivery_verdict_invalid",
      message: `The verdict names criteria the pinned revision does not have: ${unknown.join(", ")}`,
    });
  }
  return ok(null);
}
