import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { gitIdentityEnv, LOCAL_EXECUTOR, ok, ticketBranchName } from "@zenorm/contracts";
import type { CheckResult, DeliveryFailure, Verdict } from "@zenorm/contracts";
import { deliveryRunTickets, deliveryRuns } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, eq } from "drizzle-orm";
import { validate, version } from "uuid";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  acceptVerdict,
  cancelDelivery,
  CHECK_KILL_GRACE_MS,
  checkLogPath,
  deliveryBranchName,
  deliveryIdentities,
  deliveryIdentity,
  deliveryOutcome,
  endDelivery,
  getDeliveryRun,
  prepareDelivery,
  prepareReview,
  checkVerdictCriteria,
  countRepairAttempt,
  resumeDelivery,
  runChecks,
  runChecksReporting,
  startDelivery,
  storeCheckResults,
  toDeliveryRun,
  verifyDelivery,
} from "./delivery.ts";
import type { DeliveryEnd, StoredDeliveryRun } from "./delivery.ts";
import { approveTicketSet, rejectTicketSet } from "./planning.ts";
import { saveProjectSettings } from "./project.ts";
import { recordTicketMerged } from "./run-progress.ts";
import { addProject, openTestContext, reviewedTicketSet, runFolder, SPEC } from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let root: string;
let runsDir: string;
let db: ZeNormDatabase;
let context: TestContext;

const UNKNOWN_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CHECKS = ["git status --short"];

function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    {
      cwd,
      encoding: "utf8",
      env: env === undefined ? process.env : { ...process.env, ...env },
    },
  ).replace(/\n$/, "");
}

/** A new commit in `cwd` adding `file`, by `email` as author and committer. */
function commitFile(cwd: string, file: string, email: string): string {
  execFileSync("git", ["add", file], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Someone", "-c", `user.email=${email}`, "commit", "-q", "-m", `Add ${file}`],
    { cwd },
  );
  return git(cwd, ["rev-parse", "HEAD"]);
}

interface Seeded {
  readonly repo: string;
  readonly projectId: string;
  readonly mapId: string;
  readonly specificationId: string;
  readonly ticketSetId: string;
}

/** A project over a fresh repository on `main` and a map whose ticket set is drafted and, unless told otherwise, approved. */
async function seed(options: { approve: boolean }): Promise<Seeded> {
  const repo = join(root, "repo");
  const created = await addProject(context, "repo");
  const project = await saveProjectSettings(context.user, db, {
    projectId: created.id,
    baseBranch: "main",
    requiredChecks: CHECKS,
    repairLimit: 0,
    fixCommands: [],
  });
  if (!project.ok) throw new Error(project.error.code);
  const { mapId, specificationId, ticketSetId } = await reviewedTicketSet(context, project.value);
  if (options.approve) {
    const approvedSet = approveTicketSet(context.user, db, { ticketSetId });
    if (!approvedSet.ok) throw new Error(approvedSet.error.code);
  }
  return { repo, projectId: project.value.id, mapId, specificationId, ticketSetId };
}

async function started(seeded: Seeded): Promise<StoredDeliveryRun> {
  const run = await startDelivery(context.user, db, {
    ticketSetId: seeded.ticketSetId,
    runsDir,
    executor: LOCAL_EXECUTOR,
  });
  if (!run.ok) throw new Error(run.error.code);
  return run.value.run;
}

/** A started and prepared run whose worktree has one commit by the run identity. */
async function delivered(seeded: Seeded): Promise<{ run: StoredDeliveryRun; finalCommit: string }> {
  const run = await started(seeded);
  const prepared = await prepareDelivery(db, run.id, runFolder(db, run));
  if (!prepared.ok) throw new Error(prepared.error.code);
  await writeFile(join(run.worktreePath, "feature.txt"), "done\n");
  const finalCommit = commitFile(run.worktreePath, "feature.txt", deliveryIdentity(run.id).email);
  return { run, finalCommit };
}

function verdict(reviewedCommit: string, severity: "blocking" | "note" | null): Verdict {
  return {
    reviewedCommit,
    summary: "Reviewed.",
    findings:
      severity === null
        ? []
        : [
            {
              axis: "spec",
              severity,
              file: "feature.txt",
              title: "A finding",
              detail: "Detail.",
              criterion: "1.1",
            },
          ],
  };
}

const PASSED_CHECK: CheckResult = {
  command: "git status --short",
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  outputTail: "",
};

/** A final commit a verdict names, where the test does not read it from git. */
const REVIEWED_COMMIT = "a".repeat(40);

const FAILURE: DeliveryFailure = {
  code: "delivery_no_commits",
  message: "No commits",
};

function runRows(): unknown[] {
  return db.$client.prepare("select * from delivery_runs order by number").all();
}

beforeEach(async () => {
  context = await openTestContext("zenorm-core-delivery-");
  root = await realpath(context.root);
  runsDir = join(root, "data", "runs");
  db = context.db;
});

afterEach(async () => {
  db.$client.close();
  killLeftovers(root);
  await rm(root, { recursive: true, force: true });
});

/**
 * SIGKILLs every process whose command line names `path`, the test's temp folder, and their
 * children: a stand-in that ignores SIGTERM, or one a failed or timed-out test never
 * stopped, must not outlive the test. pgrep exits 1 when nothing matches.
 */
function killLeftovers(path: string): void {
  const found = spawnSync("pgrep", ["-f", path], { encoding: "utf8" });
  if (found.status !== 0 && found.status !== 1) {
    throw new Error(`pgrep failed with status ${String(found.status)}`);
  }
  const pids = found.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    spawnSync("pkill", ["-KILL", "-P", String(pid)]);
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

describe("deliveryBranchName", () => {
  const specificationId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

  test.each([
    ["Export data as CSV", 1, "zenorm/export-data-as-csv-2e3f4a5b-run-1"],
    ["  Export: data -- as (CSV)!  ", 3, "zenorm/export-data-as-csv-2e3f4a5b-run-3"],
    ["Ünïcode & Ümlauts", 2, "zenorm/n-code-mlauts-2e3f4a5b-run-2"],
    ["a".repeat(50), 1, `zenorm/${"a".repeat(40)}-2e3f4a5b-run-1`],
    [`${"a".repeat(39)} b`, 1, `zenorm/${"a".repeat(39)}-2e3f4a5b-run-1`],
    [`${"a".repeat(39)} -- b`, 2, `zenorm/${"a".repeat(39)}-2e3f4a5b-run-2`],
    ["!!! ???", 1, "zenorm/spec-2e3f4a5b-run-1"],
  ])("%j, run %i → %s, a valid branch name", (title, number, expected) => {
    const branch = deliveryBranchName(title, specificationId, number);
    expect(branch).toBe(expected);
    expect(git(root, ["check-ref-format", "--branch", branch])).toBe(branch);
  });
});

describe("deliveryOutcome", () => {
  const at = "2026-10-07T12:00:00.000Z";
  const commit = "a".repeat(40);

  test.each([
    ["active", { endedAt: null, verdict: null, failure: null }],
    ["passed", { endedAt: at, verdict: verdict(commit, null), failure: null }],
    ["passed", { endedAt: at, verdict: verdict(commit, "note"), failure: null }],
    ["blocked", { endedAt: at, verdict: verdict(commit, "blocking"), failure: null }],
    ["failed", { endedAt: at, verdict: null, failure: FAILURE }],
    ["cancelled", { endedAt: at, verdict: null, failure: null }],
  ] as const)("%s", (expected, run) => {
    expect(deliveryOutcome(run)).toBe(expected);
  });
});

describe("startDelivery", () => {
  test("inserts run 1 with the branch, base commit, pinned checks and base branch, in preparing, touching no file", async () => {
    const seeded = await seed({ approve: true });
    const base = git(seeded.repo, ["rev-parse", "main"]);

    const result = await startDelivery(context.user, db, {
      ticketSetId: seeded.ticketSetId,
      runsDir,
      executor: LOCAL_EXECUTOR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { run, folder } = result.value;
    // Core's checkout seam gives the stored folder.
    expect(folder).toBe(seeded.repo);
    expect(validate(run.id) && version(run.id)).toBe(7);
    expect(run).toEqual({
      id: run.id,
      projectId: seeded.projectId,
      specificationId: seeded.specificationId,
      ticketSetId: seeded.ticketSetId,
      number: 1,
      branch: deliveryBranchName(SPEC.title, seeded.specificationId, 1),
      worktreePath: join(runsDir, run.id, "worktree"),
      baseBranch: "main",
      baseCommit: base,
      startCommit: base,
      resumedFromRunId: null,
      checks: CHECKS,
      phase: "preparing",
      startedAt: run.startedAt,
      endedAt: null,
      finalCommit: null,
      checkResults: null,
      verdict: null,
      failure: null,
      mergedAt: null,
      // Started by a person, the run takes that User.
      userId: context.user.userId,
      executor: LOCAL_EXECUTOR,
      repairLimit: 0,
      repairAttempts: 0,
      fixCommands: [],
      prNumber: null,
      prUrl: null,
      prState: null,
    });
    expect(await getDeliveryRun(db, run.id)).toEqual(ok(run));
    expect(existsSync(runsDir)).toBe(false);
    expect(git(seeded.repo, ["branch", "--list", "zenorm/*"])).toBe("");
  });

  test("ticket_set_not_found for an unknown id", async () => {
    await seed({ approve: true });
    expect(
      await startDelivery(context.user, db, {
        ticketSetId: UNKNOWN_ID,
        runsDir,
        executor: LOCAL_EXECUTOR,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "ticket_set_not_found" },
    });
    expect(runRows()).toEqual([]);
  });

  test("ticket_set_not_approved for an undecided or rejected set", async () => {
    const seeded = await seed({ approve: false });
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "ticket_set_not_approved", data: { ticketSetId: seeded.ticketSetId } },
    });
    const rejected = rejectTicketSet(context.user, db, {
      ticketSetId: seeded.ticketSetId,
      reason: "No",
    });
    expect(rejected.ok).toBe(true);
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "ticket_set_not_approved" },
    });
    expect(runRows()).toEqual([]);
  });

  test("delivery_in_progress while a run is active, naming it; the folder check comes first", async () => {
    const seeded = await seed({ approve: true });
    const run = await started(seeded);
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "delivery_in_progress",
        data: { runId: run.id, mapId: seeded.mapId, specNumber: 1, specTitle: SPEC.title },
      },
    });
    await rename(seeded.repo, join(root, "moved"));
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "project_folder_missing" },
    });
    expect(runRows()).toHaveLength(1);
  });

  test("delivery_already_passed after a verdict without blocking findings", async () => {
    const seeded = await seed({ approve: true });
    const { run, finalCommit } = await delivered(seeded);
    const ended = await endDelivery(context.user, db, run.id, {
      kind: "verdict",
      verdict: verdict(finalCommit, "note"),
      finalCommit,
      checkResults: [PASSED_CHECK],
      pullRequest: null,
    });
    expect(ended.ok).toBe(true);
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "delivery_already_passed", data: { ticketSetId: seeded.ticketSetId } },
    });
    expect(runRows()).toHaveLength(1);
  });

  test("project_folder_missing when the project folder is gone", async () => {
    const seeded = await seed({ approve: true });
    await rename(seeded.repo, join(root, "moved"));
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "project_folder_missing", data: { folderPath: seeded.repo } },
    });
    expect(runRows()).toEqual([]);
  });

  test("project_branch_missing when the base branch is gone, before the run branch check", async () => {
    const seeded = await seed({ approve: true });
    git(seeded.repo, ["branch", deliveryBranchName(SPEC.title, seeded.specificationId, 1)]);
    git(seeded.repo, ["checkout", "-q", "-b", "other"]);
    git(seeded.repo, ["branch", "-q", "-D", "main"]);
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "project_branch_missing", data: { baseBranch: "main" } },
    });
    expect(runRows()).toEqual([]);
  });

  test("delivery_branch_exists when the run branch is already in the repository", async () => {
    const seeded = await seed({ approve: true });
    const branch = deliveryBranchName(SPEC.title, seeded.specificationId, 1);
    git(seeded.repo, ["branch", branch]);
    expect(
      await startDelivery(context.user, db, { ...seeded, runsDir, executor: LOCAL_EXECUTOR }),
    ).toMatchObject({
      ok: false,
      error: { code: "delivery_branch_exists", data: { branch } },
    });
    expect(runRows()).toEqual([]);
  });

  test("run 2 after run 1 failed, and run 3 after run 2 was blocked", async () => {
    const seeded = await seed({ approve: true });
    const first = await started(seeded);
    expect(
      await endDelivery(context.user, db, first.id, {
        kind: "failure",
        failure: FAILURE,
        finalCommit: null,
        checkResults: null,
      }),
    ).toMatchObject({ ok: true });

    const { run: second, finalCommit } = await delivered(seeded);
    expect(second.number).toBe(2);
    expect(second.branch).toBe(deliveryBranchName(SPEC.title, seeded.specificationId, 2));
    await endDelivery(context.user, db, second.id, {
      kind: "verdict",
      verdict: verdict(finalCommit, "blocking"),
      finalCommit,
      checkResults: [PASSED_CHECK],
      pullRequest: null,
    });

    const third = await started(seeded);
    expect(third.number).toBe(3);
  });
});

describe("repair rules pinned on a run", () => {
  async function savedRepairRules(
    seeded: Seeded,
    repairLimit: number,
    fixCommands: string[],
  ): Promise<void> {
    const saved = await saveProjectSettings(context.user, db, {
      projectId: seeded.projectId,
      baseBranch: "main",
      requiredChecks: CHECKS,
      repairLimit,
      fixCommands,
    });
    if (!saved.ok) throw new Error(saved.error.code);
  }

  test("a run pins the project's repair limit and fix commands, kept when the settings change", async () => {
    const seeded = await seed({ approve: true });
    await savedRepairRules(seeded, 3, ["pnpm format"]);
    const run = await started(seeded);
    expect(run).toMatchObject({ repairLimit: 3, repairAttempts: 0, fixCommands: ["pnpm format"] });

    await savedRepairRules(seeded, 1, []);
    const found = await getDeliveryRun(db, run.id);
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value).toMatchObject({
      repairLimit: 3,
      repairAttempts: 0,
      fixCommands: ["pnpm format"],
    });
    expect(toDeliveryRun(found.value, true)).toMatchObject({ repairLimit: 3, repairAttempts: 0 });
  });

  test("countRepairAttempt counts up to the pinned limit on an active run, and never on an ended one", async () => {
    const seeded = await seed({ approve: true });
    await savedRepairRules(seeded, 2, []);
    const run = await started(seeded);

    expect(countRepairAttempt(context.user, db, run.id)).toBe(true);
    expect(countRepairAttempt(context.user, db, run.id)).toBe(true);
    expect(countRepairAttempt(context.user, db, run.id)).toBe(false);
    const counted = await getDeliveryRun(db, run.id);
    expect(counted).toMatchObject({ ok: true, value: { repairAttempts: 2 } });
  });

  test("countRepairAttempt counts nothing on an ended run or with a limit of 0", async () => {
    const seeded = await seed({ approve: true });
    await savedRepairRules(seeded, 0, []);
    const noRepair = await started(seeded);
    expect(countRepairAttempt(context.user, db, noRepair.id)).toBe(false);
    expect(await cancelDelivery(context.user, db, noRepair.id)).toMatchObject({ ok: true });

    await savedRepairRules(seeded, 2, []);
    const ended = await started(seeded);
    expect(await cancelDelivery(context.user, db, ended.id)).toMatchObject({ ok: true });
    expect(countRepairAttempt(context.user, db, ended.id)).toBe(false);
    expect(await getDeliveryRun(db, ended.id)).toMatchObject({
      ok: true,
      value: { repairAttempts: 0 },
    });
  });
});

describe("prepareDelivery", () => {
  test("adds the worktree on the branch at the base commit and writes the inputs, leaving the project folder as it was", async () => {
    const seeded = await seed({ approve: true });
    await writeFile(join(seeded.repo, "local.txt"), "uncommitted\n");
    const before = {
      head: git(seeded.repo, ["rev-parse", "HEAD"]),
      branch: git(seeded.repo, ["symbolic-ref", "HEAD"]),
      status: git(seeded.repo, ["status", "--porcelain"]),
    };
    const run = await started(seeded);

    const result = await prepareDelivery(db, run.id, runFolder(db, run));

    const runDir = join(runsDir, run.id);
    expect(result).toEqual(
      ok({
        runDir,
        specPath: join(runDir, "inputs", "spec.md"),
        ticketsPath: join(runDir, "inputs", "tickets.md"),
        ticketCount: 2,
        tickets: [
          { id: "T1", title: "Write the CSV exporter" },
          { id: "T2", title: "Add the Export button" },
        ],
        specRevision: 1,
        specTitle: SPEC.title,
        merged: [],
        resumedFrom: null,
      }),
    );
    expect(git(run.worktreePath, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${run.branch}`);
    expect(git(run.worktreePath, ["rev-parse", "HEAD"])).toBe(run.baseCommit);
    expect(git(run.worktreePath, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(runDir, "tickets"))).toBe(true);

    const spec = await readFile(join(runDir, "inputs", "spec.md"), "utf8");
    expect(spec).toContain("# Export data as CSV");
    expect(spec).toContain("### C1 CSV export");
    expect(spec).toContain("- **1.1** A CSV file downloads.");
    expect(spec).toContain("- **1.2** Every row is exported.");
    const tickets = await readFile(join(runDir, "inputs", "tickets.md"), "utf8");
    expect(tickets).toContain("## T1 Write the CSV exporter");
    expect(tickets).toContain("## T2 Add the Export button");
    expect(tickets).toContain("Carries criteria 1.1.");
    expect(tickets).toContain("Blocked by T1 (the exporter).");
    expect(tickets).toContain("Pointers:\n\n- src/index.ts\n");
    // Dispositions, slicing and execution are planning records no delivery session reads.
    expect(tickets).not.toContain("## Dispositions");
    expect(tickets).not.toContain("## Slicing");
    expect(tickets).not.toContain("## Execution");

    expect({
      head: git(seeded.repo, ["rev-parse", "HEAD"]),
      branch: git(seeded.repo, ["symbolic-ref", "HEAD"]),
      status: git(seeded.repo, ["status", "--porcelain"]),
    }).toEqual(before);
  });

  /** Adds `sub` to the seeded repository as a submodule whose remote is unreachable, then commits a local-only commit in it and pins that. */
  async function withSubmodule(repo: string): Promise<string> {
    const source = join(root, "sub-source");
    await mkdir(source);
    git(source, ["init", "-q", "-b", "main"]);
    git(source, ["commit", "-q", "--allow-empty", "-m", "sub"]);
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"]);
    git(repo, ["config", "submodule.sub.url", "https://example.invalid/sub.git"]);
    git(join(repo, "sub"), ["commit", "-q", "--allow-empty", "-m", "local only"]);
    git(repo, ["add", ".gitmodules", "sub"]);
    git(repo, ["commit", "-q", "-m", "Add sub"]);
    return git(join(repo, "sub"), ["rev-parse", "HEAD"]);
  }

  test("checks out the submodules at their pinned commits from the project's own checkout", async () => {
    const seeded = await seed({ approve: true });
    const pinned = await withSubmodule(seeded.repo);
    const run = await started(seeded);

    expect(await prepareDelivery(db, run.id, runFolder(db, run))).toMatchObject({ ok: true });

    const sub = join(run.worktreePath, "sub");
    expect(git(sub, ["rev-parse", "HEAD"])).toBe(pinned);
    expect(git(sub, ["rev-parse", "--show-toplevel"])).toBe(await realpath(sub));
    expect(git(run.worktreePath, ["status", "--porcelain"])).toBe("");
    // The project's submodule settings are left as they were.
    expect(git(seeded.repo, ["config", "submodule.sub.url"])).toBe(
      "https://example.invalid/sub.git",
    );
    // Cleanup's `worktree remove --force` removes a worktree holding a submodule.
    git(seeded.repo, ["worktree", "remove", "--force", run.worktreePath]);
    expect(existsSync(run.worktreePath)).toBe(false);
  });

  test("delivery_worktree_failed when the project has not checked out a submodule", async () => {
    const seeded = await seed({ approve: true });
    await withSubmodule(seeded.repo);
    git(seeded.repo, ["submodule", "deinit", "-q", "--force", "sub"]);
    const run = await started(seeded);

    expect(await prepareDelivery(db, run.id, runFolder(db, run))).toMatchObject({
      ok: false,
      error: { code: "delivery_worktree_failed" },
    });
  });

  test("delivery_worktree_failed when the worktree path already holds files", async () => {
    const seeded = await seed({ approve: true });
    const run = await started(seeded);
    await mkdir(run.worktreePath, { recursive: true });
    await writeFile(join(run.worktreePath, "in-the-way.txt"), "x\n");

    expect(await prepareDelivery(db, run.id, runFolder(db, run))).toMatchObject({
      ok: false,
      error: { code: "delivery_worktree_failed" },
    });
  });
});

describe("verifyDelivery", () => {
  async function prepared(): Promise<StoredDeliveryRun> {
    const seeded = await seed({ approve: true });
    const run = await started(seeded);
    const result = await prepareDelivery(db, run.id, runFolder(db, run));
    if (!result.ok) throw new Error(result.error.code);
    return run;
  }

  function verify(run: StoredDeliveryRun, repairedFrom: string | null) {
    return verifyDelivery({
      worktreePath: run.worktreePath,
      branch: run.branch,
      baseCommit: run.baseCommit,
      repairedFrom,
      identities: [deliveryIdentity(run.id)],
    });
  }

  test("after a repair attempt, a commit on top of the previous pass's final commit gives the new final commit", async () => {
    const run = await prepared();
    await writeFile(join(run.worktreePath, "a.txt"), "a\n");
    const previous = commitFile(run.worktreePath, "a.txt", deliveryIdentity(run.id).email);
    await writeFile(join(run.worktreePath, "fix.txt"), "fix\n");
    const final = commitFile(run.worktreePath, "fix.txt", deliveryIdentity(run.id).email);

    expect(await verify(run, previous)).toEqual(ok({ finalCommit: final }));
  });

  test("delivery_no_commits when a repair attempt added no commit since the previous pass", async () => {
    const run = await prepared();
    await writeFile(join(run.worktreePath, "a.txt"), "a\n");
    const previous = commitFile(run.worktreePath, "a.txt", deliveryIdentity(run.id).email);

    expect(await verify(run, previous)).toMatchObject({
      ok: false,
      error: { code: "delivery_no_commits" },
    });
    // The first pass's check over the whole run still accepts the same branch.
    expect(await verify(run, null)).toEqual(ok({ finalCommit: previous }));
  });

  test("the committer check covers the whole run, not only the repair's commits", async () => {
    const run = await prepared();
    await writeFile(join(run.worktreePath, "a.txt"), "a\n");
    commitFile(run.worktreePath, "a.txt", "someone@example.com");
    await writeFile(join(run.worktreePath, "b.txt"), "b\n");
    const previous = commitFile(run.worktreePath, "b.txt", deliveryIdentity(run.id).email);
    await writeFile(join(run.worktreePath, "fix.txt"), "fix\n");
    commitFile(run.worktreePath, "fix.txt", deliveryIdentity(run.id).email);

    expect(await verify(run, previous)).toMatchObject({
      ok: false,
      error: { code: "delivery_foreign_commit" },
    });
  });

  test("a clean commit by the run identity gives the final commit", async () => {
    const run = await prepared();
    await writeFile(join(run.worktreePath, "a.txt"), "a\n");
    commitFile(run.worktreePath, "a.txt", deliveryIdentity(run.id).email);
    await writeFile(join(run.worktreePath, "b.txt"), "b\n");
    const final = commitFile(run.worktreePath, "b.txt", deliveryIdentity(run.id).email);

    expect(await verify(run, null)).toEqual(ok({ finalCommit: final }));
  });

  test("delivery_worktree_dirty for an untracked file", async () => {
    const run = await prepared();
    await writeFile(join(run.worktreePath, "a.txt"), "a\n");
    commitFile(run.worktreePath, "a.txt", deliveryIdentity(run.id).email);
    await writeFile(join(run.worktreePath, "stray.txt"), "x\n");

    expect(await verify(run, null)).toMatchObject({
      ok: false,
      error: { code: "delivery_worktree_dirty" },
    });
  });

  test("delivery_worktree_dirty when the worktree is not on the run branch", async () => {
    const run = await prepared();
    git(run.worktreePath, ["checkout", "-q", "--detach"]);

    expect(await verify(run, null)).toMatchObject({
      ok: false,
      error: { code: "delivery_worktree_dirty" },
    });
  });

  test("delivery_no_commits when the branch is still at the base commit", async () => {
    const run = await prepared();
    expect(await verify(run, null)).toMatchObject({
      ok: false,
      error: { code: "delivery_no_commits" },
    });
  });

  test("delivery_foreign_commit for a commit by another email", async () => {
    const run = await prepared();
    await writeFile(join(run.worktreePath, "a.txt"), "a\n");
    commitFile(run.worktreePath, "a.txt", deliveryIdentity(run.id).email);
    await writeFile(join(run.worktreePath, "b.txt"), "b\n");
    const foreign = commitFile(run.worktreePath, "b.txt", "someone@example.com");

    const result = await verify(run, null);
    expect(result).toMatchObject({ ok: false, error: { code: "delivery_foreign_commit" } });
    if (result.ok) return;
    expect(result.error.message).toContain(foreign);
  });
});

describe("resumeDelivery", () => {
  /** A prepared run that merged T1 from its ticket branch, then ended `end`; its branch is kept. */
  async function endedAfterT1(
    seeded: Seeded,
    end: DeliveryEnd,
  ): Promise<{ run: StoredDeliveryRun; head: string }> {
    const run = await started(seeded);
    const prepared = await prepareDelivery(db, run.id, runFolder(db, run));
    if (!prepared.ok) throw new Error(prepared.error.code);
    const env = gitIdentityEnv(deliveryIdentity(run.id));
    const ticketBranch = ticketBranchName(run.branch, "T1");
    git(run.worktreePath, ["checkout", "-q", "-b", ticketBranch]);
    await writeFile(join(run.worktreePath, "t1.txt"), "T1\n");
    commitFile(run.worktreePath, "t1.txt", deliveryIdentity(run.id).email);
    git(run.worktreePath, ["checkout", "-q", run.branch]);
    git(run.worktreePath, ["merge", "-q", "--no-ff", "-m", "Merge T1", ticketBranch], env);
    const merged = await recordTicketMerged(context.user, db, {
      runId: run.id,
      ticket: "T1",
      summary: "Did T1.",
      folder: runFolder(db, run),
    });
    expect(merged.recorded).toBe(true);
    const ended = await endDelivery(context.user, db, run.id, end);
    expect(ended.ok).toBe(true);
    return { run, head: git(run.worktreePath, ["rev-parse", "HEAD"]) };
  }

  /** A prepared run that merged T1 from its ticket branch, then failed; its branch is kept. */
  function failedAfterT1(seeded: Seeded): Promise<{ run: StoredDeliveryRun; head: string }> {
    return endedAfterT1(seeded, {
      kind: "failure",
      failure: FAILURE,
      finalCommit: null,
      checkResults: null,
    });
  }

  /** The resumed run `second`, prepared. */
  async function preparedResume(firstId: string) {
    const resumed = await resume(firstId);
    if (!resumed.ok) throw new Error(resumed.error.code);
    const second = resumed.value.run;
    const prepared = await prepareDelivery(db, second.id, runFolder(db, second));
    if (!prepared.ok) throw new Error(prepared.error.code);
    return prepared.value;
  }

  function resume(runId: string) {
    return resumeDelivery(context.user, db, { runId, runsDir, executor: LOCAL_EXECUTOR });
  }

  function ticketRows(runId: string) {
    return db
      .select({
        ticket: deliveryRunTickets.ticket,
        mergedAt: deliveryRunTickets.mergedAt,
        commit: deliveryRunTickets.commit,
        summary: deliveryRunTickets.summary,
      })
      .from(deliveryRunTickets)
      .where(eq(deliveryRunTickets.runId, runId))
      .orderBy(asc(deliveryRunTickets.position))
      .all();
  }

  test("starts the next run at the failed run's branch head, from its base, with its merged tickets", async () => {
    const seeded = await seed({ approve: true });
    const { run: first, head } = await failedAfterT1(seeded);

    const resumed = await resume(first.id);
    if (!resumed.ok) throw new Error(resumed.error.code);
    const second = resumed.value.run;
    expect(second).toMatchObject({
      number: 2,
      branch: deliveryBranchName(SPEC.title, seeded.specificationId, 2),
      baseCommit: first.baseCommit,
      startCommit: head,
      resumedFromRunId: first.id,
    });
    const [firstT1] = ticketRows(first.id);
    expect(ticketRows(second.id)).toEqual([
      { ticket: "T1", mergedAt: firstT1?.mergedAt, commit: firstT1?.commit, summary: "Did T1." },
      { ticket: "T2", mergedAt: null, commit: null, summary: null },
    ]);

    const prepared = await prepareDelivery(db, second.id, runFolder(db, second));
    if (!prepared.ok) throw new Error(prepared.error.code);
    expect(prepared.value.merged).toEqual(["T1"]);
    expect(git(second.worktreePath, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("a resumed run is given the resumed run's failure and only its checks that did not pass", async () => {
    const seeded = await seed({ approve: true });
    const failedCheck: CheckResult = { ...PASSED_CHECK, exitCode: 1, outputTail: "lint error" };
    const timedOutCheck: CheckResult = { ...PASSED_CHECK, exitCode: null, timedOut: true };
    const checksFailed: DeliveryFailure = {
      code: "delivery_checks_failed",
      message: "These checks did not pass",
    };
    const { run: first } = await endedAfterT1(seeded, {
      kind: "failure",
      failure: checksFailed,
      finalCommit: null,
      checkResults: [PASSED_CHECK, failedCheck, timedOutCheck],
    });

    // The failed check's whole output was logged; the timed-out one's, as in an older run, was not.
    const logged = checkLogPath(dirname(first.worktreePath), 1);
    await mkdir(dirname(logged), { recursive: true });
    await writeFile(logged, "lint error\n");

    const prepared = await preparedResume(first.id);
    expect(prepared.resumedFrom).toEqual({
      number: 1,
      failure: checksFailed,
      failedChecks: [
        { result: failedCheck, logPath: logged },
        { result: timedOutCheck, logPath: null },
      ],
      blockingFindings: [],
    });
  });

  test("a run resuming a blocked run is given its blocking findings only", async () => {
    const seeded = await seed({ approve: true });
    const blocking = verdict(REVIEWED_COMMIT, "blocking");
    const notes = verdict(REVIEWED_COMMIT, "note");
    const reviewed: Verdict = { ...blocking, findings: [...notes.findings, ...blocking.findings] };
    const { run: first } = await endedAfterT1(seeded, {
      kind: "verdict",
      verdict: reviewed,
      finalCommit: REVIEWED_COMMIT,
      checkResults: [PASSED_CHECK],
      pullRequest: null,
    });

    expect((await preparedResume(first.id)).resumedFrom).toEqual({
      number: 1,
      failure: null,
      failedChecks: [],
      blockingFindings: blocking.findings,
    });
  });

  test("a run resuming a cancelled run, or started from clean, is given nothing to fix", async () => {
    const seeded = await seed({ approve: true });
    const { run: first } = await endedAfterT1(seeded, { kind: "cancelled" });

    expect((await preparedResume(first.id)).resumedFrom).toBeNull();
  });

  test("verifying a resumed run accepts the commits of every run it resumes, and no others", async () => {
    const seeded = await seed({ approve: true });
    const { run: first } = await failedAfterT1(seeded);
    const resumed = await resume(first.id);
    if (!resumed.ok) throw new Error(resumed.error.code);
    const second = resumed.value.run;
    const prepared = await prepareDelivery(db, second.id, runFolder(db, second));
    if (!prepared.ok) throw new Error(prepared.error.code);
    await writeFile(join(second.worktreePath, "t2.txt"), "T2\n");
    const final = commitFile(second.worktreePath, "t2.txt", deliveryIdentity(second.id).email);

    expect(deliveryIdentities(db, second.id)).toEqual([
      deliveryIdentity(second.id),
      deliveryIdentity(first.id),
    ]);
    const input = {
      worktreePath: second.worktreePath,
      branch: second.branch,
      baseCommit: second.baseCommit,
      repairedFrom: null,
    };
    expect(
      await verifyDelivery({ ...input, identities: deliveryIdentities(db, second.id) }),
    ).toEqual(ok({ finalCommit: final }));
    expect(
      await verifyDelivery({ ...input, identities: [deliveryIdentity(second.id)] }),
    ).toMatchObject({ ok: false, error: { code: "delivery_foreign_commit" } });
  });

  test("delivery_run_not_found for an unknown run", async () => {
    await seed({ approve: true });
    expect(await resume(UNKNOWN_ID)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_found", data: { runId: UNKNOWN_ID } },
    });
  });

  test("delivery_run_not_resumable for an active run and for a passed run", async () => {
    const seeded = await seed({ approve: true });
    const { run, finalCommit } = await delivered(seeded);
    expect(await resume(run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_resumable", data: { runId: run.id } },
    });
    await endDelivery(context.user, db, run.id, {
      kind: "verdict",
      verdict: verdict(finalCommit, null),
      finalCommit,
      checkResults: [PASSED_CHECK],
      pullRequest: null,
    });
    expect(await resume(run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_resumable" },
    });
    expect(runRows()).toHaveLength(1);
  });

  test("delivery_run_branch_missing when the failed run's branch is gone", async () => {
    const seeded = await seed({ approve: true });
    const { run } = await failedAfterT1(seeded);
    git(seeded.repo, ["worktree", "remove", "--force", run.worktreePath]);
    git(seeded.repo, ["branch", "-q", "-D", run.branch]);
    expect(await resume(run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_branch_missing", data: { runId: run.id, branch: run.branch } },
    });
    expect(runRows()).toHaveLength(1);
  });

  test("a start refusal applies: delivery_in_progress while another run is active", async () => {
    const seeded = await seed({ approve: true });
    const { run } = await failedAfterT1(seeded);
    await started(seeded);
    expect(await resume(run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_in_progress" },
    });
    expect(runRows()).toHaveLength(2);
  });
});

describe("runChecks", () => {
  const identity = deliveryIdentity(UNKNOWN_ID);
  const env = { ...process.env, ...gitIdentityEnv(identity) };

  async function repo(): Promise<string> {
    const path = join(root, "checks");
    await mkdir(path);
    git(path, ["init", "-q", "-b", "main"]);
    return path;
  }

  test("runs every check in order, after a failing one too, with the identity in the environment", async () => {
    const cwd = await repo();
    const results = await runChecks({
      worktreePath: cwd,
      runDir: join(root, "run"),
      checks: [
        "git status --short",
        "git rev-parse --verify no-such-ref",
        "git var GIT_COMMITTER_IDENT",
      ],
      timeoutMs: 10_000,
      killGraceMs: CHECK_KILL_GRACE_MS,
      env,
      signal: new AbortController().signal,
    });

    expect(results.map((result) => [result.command, result.exitCode, result.timedOut])).toEqual([
      ["git status --short", 0, false],
      ["git rev-parse --verify no-such-ref", 128, false],
      ["git var GIT_COMMITTER_IDENT", 0, false],
    ]);
    expect(results[1]?.outputTail).toContain("fatal:");
    expect(results[2]?.outputTail).toContain(`ZeNorm delivery <${identity.email}>`);
    for (const result of results) {
      expect(Number.isInteger(result.durationMs)).toBe(true);
    }
  });

  test("keeps the last 4000 characters of the output", async () => {
    const cwd = await repo();
    const [result] = await runChecks({
      worktreePath: cwd,
      runDir: join(root, "run"),
      checks: ["seq 1 5000"],
      timeoutMs: 10_000,
      killGraceMs: CHECK_KILL_GRACE_MS,
      env,
      signal: new AbortController().signal,
    });
    expect(result?.outputTail).toHaveLength(4000);
    expect(result?.outputTail.endsWith("4999\n5000\n")).toBe(true);
  });

  test("writes each check's whole output to its log in the run folder", async () => {
    const cwd = await repo();
    const runDir = join(root, "run");
    await runChecks({
      worktreePath: cwd,
      runDir,
      checks: ["git status --short", "seq 1 5000"],
      timeoutMs: 10_000,
      killGraceMs: CHECK_KILL_GRACE_MS,
      env,
      signal: new AbortController().signal,
    });

    expect(checkLogPath(runDir, 1)).toBe(join(runDir, "checks", "check-2.log"));
    const whole = await readFile(checkLogPath(runDir, 1), "utf8");
    expect(whole.startsWith("1\n2\n3\n")).toBe(true);
    expect(whole.endsWith("4999\n5000\n")).toBe(true);
    expect(existsSync(checkLogPath(runDir, 0))).toBe(true);
  });

  test("a check longer than the timeout is killed and marked timed out", async () => {
    const cwd = await repo();
    const results = await runChecks({
      worktreePath: cwd,
      runDir: join(root, "run"),
      checks: ["sleep 5", "git status --short"],
      timeoutMs: 500,
      killGraceMs: CHECK_KILL_GRACE_MS,
      env,
      signal: new AbortController().signal,
    });
    expect(results).toMatchObject([
      { command: "sleep 5", exitCode: null, timedOut: true },
      { command: "git status --short", exitCode: 0, timedOut: false },
    ]);
    expect(results[0]?.durationMs).toBeLessThan(4000);
  });

  test("an abort stops the running check and starts no further one", async () => {
    const cwd = await repo();
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);
    const results = await runChecks({
      worktreePath: cwd,
      runDir: join(root, "run"),
      checks: ["sleep 5", "touch marker.txt"],
      timeoutMs: 10_000,
      killGraceMs: CHECK_KILL_GRACE_MS,
      env,
      signal: controller.signal,
    });
    expect(results).toMatchObject([{ command: "sleep 5", exitCode: null, timedOut: false }]);
    expect(results[0]?.durationMs).toBeLessThan(4000);
    expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
  });

  test("a stopped check's group still gets SIGKILL after its leader has exited", async () => {
    const cwd = await repo();
    const pidFile = join(cwd, "grandchild.pid");
    // The leader exits on SIGTERM; the grandchild ignores it and holds none of the leader's pipes.
    const script = join(cwd, "check.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        // Bounded (about 40 s, past the 3 s grace and the 20 s test timeout) so an orphan left by a killed worker exits by itself.
        `sh -c 'trap "" TERM; echo $$ > ${pidFile}; i=0; while [ $i -lt 40 ]; do sleep 1; i=$((i+1)); done' </dev/null >/dev/null 2>&1 &`,
        "trap 'exit 143' TERM",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let grandchild: number | null = null;
    try {
      const results = await runChecks({
        worktreePath: cwd,
        runDir: join(root, "run"),
        checks: [script],
        timeoutMs: 500,
        // Short, so the test does not wait out a run's 10 s.
        killGraceMs: 3_000,
        env,
        signal: new AbortController().signal,
      });
      expect(results).toMatchObject([{ command: script, exitCode: 143, timedOut: true }]);
      // An empty pid file must never read as pid 0, which would signal the runner's own group.
      const written = (await readFile(pidFile, "utf8")).trim();
      expect(written).toMatch(/^[1-9]\d*$/);
      grandchild = Number(written);
      expect(alive(grandchild)).toBe(true);
      const pid = grandchild;
      await vi.waitFor(
        () => {
          expect(alive(pid)).toBe(false);
        },
        { timeout: 6_000, interval: 100 },
      );
    } finally {
      // Whatever failed above, the grandchild that ignores SIGTERM and this test's folder go.
      let leftover = grandchild;
      if (existsSync(pidFile)) {
        const recorded = (await readFile(pidFile, "utf8")).trim();
        if (/^[1-9]\d*$/.test(recorded)) leftover = Number(recorded);
      }
      if (leftover !== null && alive(leftover)) {
        process.kill(leftover, "SIGKILL");
        const killed = leftover;
        await vi.waitFor(
          () => {
            expect(alive(killed)).toBe(false);
          },
          { timeout: 5000, interval: 50 },
        );
      }
      killLeftovers(root);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("runs nothing when the signal has already aborted", async () => {
    const cwd = await repo();
    const controller = new AbortController();
    controller.abort();
    expect(
      await runChecks({
        worktreePath: cwd,
        runDir: join(root, "run"),
        checks: ["touch marker.txt"],
        timeoutMs: 10_000,
        killGraceMs: CHECK_KILL_GRACE_MS,
        env,
        signal: controller.signal,
      }),
    ).toEqual([]);
    expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
  });

  test("an unknown executable gives a null exit code and the error in the tail", async () => {
    const cwd = await repo();
    const results = await runChecks({
      worktreePath: cwd,
      runDir: join(root, "run"),
      checks: ["zenorm-no-such-executable --flag", "git status --short"],
      timeoutMs: 10_000,
      killGraceMs: CHECK_KILL_GRACE_MS,
      env,
      signal: new AbortController().signal,
    });
    expect(results).toMatchObject([
      { command: "zenorm-no-such-executable --flag", exitCode: null, timedOut: false },
      { command: "git status --short", exitCode: 0 },
    ]);
    expect(results[0]?.outputTail).toContain("ENOENT");
  });
});

describe("prepareReview, acceptVerdict and endDelivery", () => {
  async function reviewed(options: { strayBeforeSnapshot: boolean }) {
    const seeded = await seed({ approve: true });
    const { run, finalCommit } = await delivered(seeded);
    if (options.strayBeforeSnapshot) {
      await writeFile(join(run.worktreePath, "check-output.log"), "written by a check\n");
    }
    const review = await prepareReview({
      runDir: join(runsDir, run.id),
      worktreePath: run.worktreePath,
      baseCommit: run.baseCommit,
      finalCommit,
    });
    return { seeded, run, finalCommit, review };
  }

  function accept(
    run: StoredDeliveryRun,
    finalCommit: string,
    statusSnapshot: string,
    reviewedCommit: string,
  ) {
    return acceptVerdict({
      worktreePath: run.worktreePath,
      branch: run.branch,
      finalCommit,
      statusSnapshot,
      verdict: verdict(reviewedCommit, null),
    });
  }

  test("prepareReview writes the diff to a file and lists the changed files", async () => {
    const { run, review } = await reviewed({ strayBeforeSnapshot: false });
    expect(review).toEqual({
      diffPath: join(runsDir, run.id, "review.diff"),
      changedFiles: ["feature.txt"],
      statusSnapshot: "",
    });
    const diff = await readFile(review.diffPath, "utf8");
    expect(diff).toContain("+++ b/feature.txt");
    expect(diff).toContain("+done");
  });

  test("accepts a verdict on the final commit with the worktree as snapshotted, including a file a check wrote", async () => {
    const { run, finalCommit, review } = await reviewed({ strayBeforeSnapshot: true });
    expect(review.statusSnapshot).toContain("check-output.log");
    expect(await accept(run, finalCommit, review.statusSnapshot, finalCommit)).toEqual(ok(null));
  });

  test("delivery_verdict_invalid for a verdict naming another commit", async () => {
    const { run, finalCommit, review } = await reviewed({ strayBeforeSnapshot: false });
    const result = await accept(run, finalCommit, review.statusSnapshot, run.baseCommit);
    expect(result).toMatchObject({ ok: false, error: { code: "delivery_verdict_invalid" } });
  });

  test("delivery_review_changed_worktree when the branch head moved", async () => {
    const { run, finalCommit, review } = await reviewed({ strayBeforeSnapshot: false });
    await writeFile(join(run.worktreePath, "extra.txt"), "x\n");
    commitFile(run.worktreePath, "extra.txt", deliveryIdentity(run.id).email);
    expect(await accept(run, finalCommit, review.statusSnapshot, finalCommit)).toMatchObject({
      ok: false,
      error: { code: "delivery_review_changed_worktree" },
    });
  });

  test("delivery_review_changed_worktree when a file appeared after the snapshot", async () => {
    const { run, finalCommit, review } = await reviewed({ strayBeforeSnapshot: false });
    await writeFile(join(run.worktreePath, "reviewer-was-here.txt"), "x\n");
    expect(await accept(run, finalCommit, review.statusSnapshot, finalCommit)).toMatchObject({
      ok: false,
      error: { code: "delivery_review_changed_worktree" },
    });
  });

  test.each([
    ["passed", null],
    ["blocked", "blocking"],
  ] as const)(
    "a verdict end stores the verdict, check results and final commit: %s",
    async (outcome, severity) => {
      const { run, finalCommit } = await reviewed({ strayBeforeSnapshot: false });
      const stored = await endDelivery(context.user, db, run.id, {
        kind: "verdict",
        verdict: verdict(finalCommit, severity),
        finalCommit,
        checkResults: [PASSED_CHECK],
        pullRequest: null,
      });
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.value).toMatchObject({
        finalCommit,
        checkResults: [PASSED_CHECK],
        verdict: verdict(finalCommit, severity),
        failure: null,
        prNumber: null,
        prUrl: null,
        prState: null,
      });
      expect(stored.value.endedAt).not.toBeNull();
      expect(deliveryOutcome(stored.value)).toBe(outcome);
      expect(await getDeliveryRun(db, run.id)).toEqual(stored);
      expect(toDeliveryRun(stored.value, false).pullRequest).toBeNull();
    },
  );

  test("a verdict end with a pull request records its number, url and state", async () => {
    const { run, finalCommit } = await reviewed({ strayBeforeSnapshot: false });
    const pullRequest = {
      number: 7,
      url: "https://github.com/acme/numbers/pull/7",
      state: "open",
    } as const;
    const stored = await endDelivery(context.user, db, run.id, {
      kind: "verdict",
      verdict: verdict(finalCommit, null),
      finalCommit,
      checkResults: [PASSED_CHECK],
      pullRequest,
    });
    expect(stored).toMatchObject({
      ok: true,
      value: { prNumber: 7, prUrl: pullRequest.url, prState: "open" },
    });
    if (!stored.ok) return;
    expect(deliveryOutcome(stored.value)).toBe("passed");
    expect(toDeliveryRun(stored.value, false)).toMatchObject({ state: "passed", pullRequest });
  });

  test("a failure end stores the failure; a second end write is delivery_run_ended", async () => {
    const seeded = await seed({ approve: true });
    const run = await started(seeded);
    const stored = await endDelivery(context.user, db, run.id, {
      kind: "failure",
      failure: FAILURE,
      finalCommit: null,
      checkResults: null,
    });
    expect(stored).toMatchObject({ ok: true, value: { failure: FAILURE, verdict: null } });
    if (!stored.ok) return;
    expect(deliveryOutcome(stored.value)).toBe("failed");

    expect(await cancelDelivery(context.user, db, run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_ended", data: { runId: run.id } },
    });
    expect(await getDeliveryRun(db, run.id)).toEqual(stored);
  });

  test("a verdict write after a cancel is delivery_run_ended and the run stays cancelled", async () => {
    const { run, finalCommit } = await reviewed({ strayBeforeSnapshot: false });
    const cancelled = await cancelDelivery(context.user, db, run.id);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(deliveryOutcome(cancelled.value)).toBe("cancelled");

    expect(
      await endDelivery(context.user, db, run.id, {
        kind: "verdict",
        verdict: verdict(finalCommit, null),
        finalCommit,
        checkResults: [PASSED_CHECK],
        pullRequest: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "delivery_run_ended" } });
    const after = await getDeliveryRun(db, run.id);
    expect(after).toEqual(cancelled);
    expect(after).toMatchObject({ ok: true, value: { verdict: null, finalCommit: null } });
  });

  test("delivery_run_not_found for an unknown run", async () => {
    expect(await cancelDelivery(context.user, db, UNKNOWN_ID)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_found", data: { runId: UNKNOWN_ID } },
    });
    expect(await getDeliveryRun(db, UNKNOWN_ID)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_found" },
    });
  });
});

describe("checkVerdictCriteria", () => {
  function naming(reviewedCommit: string, criteria: readonly (string | null)[]): Verdict {
    return {
      reviewedCommit,
      summary: "Reviewed.",
      findings: criteria.map((criterion) => ({
        axis: "spec",
        severity: "blocking",
        file: null,
        title: "A finding",
        detail: "Detail.",
        criterion,
      })),
    };
  }

  test("a finding naming a criterion the pinned revision does not have is delivery_verdict_invalid", async () => {
    const { run, finalCommit } = await delivered(await seed({ approve: true }));

    expect(checkVerdictCriteria(db, run.id, naming(finalCommit, ["1.1", "9.9"]))).toMatchObject({
      ok: false,
      error: { code: "delivery_verdict_invalid" },
    });
  });

  test("a known criterion id and null are accepted, and so is a verdict with no finding", async () => {
    const { run, finalCommit } = await delivered(await seed({ approve: true }));

    expect(checkVerdictCriteria(db, run.id, naming(finalCommit, ["1.1", "1.2", null]))).toEqual(
      ok(null),
    );
    expect(checkVerdictCriteria(db, run.id, naming(finalCommit, []))).toEqual(ok(null));
  });
});

describe("check results stored as they finish", () => {
  test("with three checks, the stored results grow one at a time while the run is active", async () => {
    const { run } = await delivered(await seed({ approve: true }));
    const storedCounts: number[] = [];

    const results = await runChecksReporting(
      {
        worktreePath: run.worktreePath,
        runDir: dirname(run.worktreePath),
        checks: ["git status --short", "git rev-parse --verify no-such-ref", "git status --short"],
        timeoutMs: 10_000,
        killGraceMs: CHECK_KILL_GRACE_MS,
        env: { ...process.env, ...gitIdentityEnv(deliveryIdentity(run.id)) },
        signal: new AbortController().signal,
      },
      (soFar) => {
        expect(storeCheckResults(context.user, db, run.id, soFar)).toBe(true);
        const stored = db
          .select({ checkResults: deliveryRuns.checkResults })
          .from(deliveryRuns)
          .where(eq(deliveryRuns.id, run.id))
          .get();
        const checkResults = stored?.checkResults;
        if (checkResults === undefined || checkResults === null) {
          throw new Error("No check results stored");
        }
        storedCounts.push(checkResults.length);
      },
    );

    expect(storedCounts).toEqual([1, 2, 3]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 128, 0]);
    const ended = await getDeliveryRun(db, run.id);
    expect(ended.ok && ended.value.endedAt).toBe(null);
  });

  test("an ended run's results are not written", async () => {
    const { run } = await delivered(await seed({ approve: true }));
    await cancelDelivery(context.user, db, run.id);
    const result: CheckResult = {
      command: "git status --short",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputTail: "",
    };

    expect(storeCheckResults(context.user, db, run.id, [result])).toBe(false);
    const stored = await getDeliveryRun(db, run.id);
    expect(stored.ok && stored.value.checkResults).toBe(null);
  });
});
