import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { ChangeEvent, Project } from "@zenorm/contracts";
import { deliveryRuns } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cancelDelivery, getDeliveryRun } from "./delivery.ts";
import type { StoredDeliveryRun } from "./delivery.ts";
import { checkPullRequest, markMerged, openPullRequestRuns } from "./mark-merged.ts";
import { readRunEvents } from "./run-events.ts";
import { createChangeBus, setChangeBus } from "./writes.ts";
import {
  addProject,
  asPre0010Run,
  closeTestContext,
  commitOnRunBranch,
  deliverableTicketSet,
  endRun,
  openTestContext,
  startedRun,
  UNKNOWN_ID,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-mark-merged-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

function git(args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
    cwd: project.folderPath,
    stdio: "ignore",
  });
}

async function passedRun(): Promise<{ run: StoredDeliveryRun; finalCommit: string }> {
  const set = await deliverableTicketSet(context, project);
  const run = await startedRun(context, set.ticketSetId);
  const finalCommit = await commitOnRunBranch(context, run);
  await endRun(context, run.id, { outcome: "passed", finalCommit });
  return { run, finalCommit };
}

async function mergedAt(runId: string): Promise<string | null> {
  const found = await getDeliveryRun(context.db, runId);
  if (!found.ok) throw new Error(found.error.code);
  return found.value.mergedAt;
}

describe("delivery.markMerged (S8-5, B28)", () => {
  test("delivery_not_merged before the merge; recorded with ZeNorm's line after a real merge", async () => {
    const { run, finalCommit } = await passedRun();
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: {
        code: "delivery_not_merged",
        data: { runId: run.id, finalCommit, baseBranch: "main" },
      },
    });
    expect(await mergedAt(run.id)).toBeNull();

    git(["merge", "-q", "--no-ff", "-m", "Merge the run", run.branch]);
    const merged = await markMerged(context.user, context.db, run.id);
    expect(merged.ok && merged.value.mergedAt).toEqual(expect.any(String));
    expect(readRunEvents(context.db, run.id)).toMatchObject([
      {
        seq: 1,
        who: "zenorm",
        ticket: null,
        text: `${finalCommit.slice(0, 7)} is in main. The tickets are recorded as delivered.`,
      },
    ]);

    // Twice: already merged, nothing more written.
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_already_merged" },
    });
    expect(readRunEvents(context.db, run.id)).toHaveLength(1);
  });

  test("the update and its line are one write: one publish holding both rows (CR9b-14)", async () => {
    const { run } = await passedRun();
    git(["merge", "-q", "--no-ff", "-m", "Merge the run", run.branch]);
    const publishes: (readonly ChangeEvent[])[] = [];
    const bus = createChangeBus(() => undefined);
    setChangeBus(context.db, {
      subscribe: bus.subscribe,
      publish: (events) => {
        publishes.push(events);
      },
    });

    expect((await markMerged(context.user, context.db, run.id)).ok).toBe(true);
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.map((event) => [event.entityType, event.op])).toEqual([
      ["delivery_runs", "update"],
      ["delivery_run_events", "insert"],
    ]);
  });

  test("a squash merge leaves the final commit outside main: delivery_not_merged", async () => {
    const { run } = await passedRun();
    git(["merge", "-q", "--squash", run.branch]);
    git(["commit", "-q", "-m", "Squashed"]);
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_not_merged" },
    });
    expect(await mergedAt(run.id)).toBeNull();
  });

  test("delivery_branch_missing when the pinned base branch is gone", async () => {
    const { run } = await passedRun();
    git(["checkout", "-q", "-b", "other"]);
    git(["branch", "-q", "-D", "main"]);
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_branch_missing", data: { baseBranch: "main" } },
    });
    expect(await mergedAt(run.id)).toBeNull();
  });

  test("project_folder_missing comes before the ancestry check", async () => {
    const { run } = await passedRun();
    git(["merge", "-q", "--no-ff", "-m", "Merge", run.branch]);
    await rename(project.folderPath, join(context.root, "moved"));
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: { code: "project_folder_missing", data: { folderPath: project.folderPath } },
    });
    expect(await mergedAt(run.id)).toBeNull();
  });

  test("delivery_not_passed for an active, blocked, failed or cancelled run", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_not_passed", data: { runId: run.id } },
    });
    const finalCommit = await commitOnRunBranch(context, run);
    await endRun(context, run.id, { outcome: "blocked", finalCommit, criterion: null });
    expect(await markMerged(context.user, context.db, run.id)).toMatchObject({
      ok: false,
      error: { code: "delivery_not_passed" },
    });
    for (const outcome of ["failed", "cancelled"] as const) {
      const next = await startedRun(context, set.ticketSetId);
      await endRun(context, next.id, { outcome });
      expect(await markMerged(context.user, context.db, next.id)).toMatchObject({
        ok: false,
        error: { code: "delivery_not_passed" },
      });
    }
  });

  test("delivery_run_not_found for an unknown run", async () => {
    expect(await markMerged(context.user, context.db, UNKNOWN_ID)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_found", data: { runId: UNKNOWN_ID } },
    });
  });
});

/**
 * A stand-in for the GitHub CLI, first on the test process's `PATH` (2.4). Every call appends its
 * arguments as one line to `<state>/calls`. `gh auth status` succeeds, and fails while
 * `<state>/signed-out` exists. `gh pr view <url> --json state` prints the state in
 * `<state>/pr-<number>` (`OPEN` when there is none), and fails while `<state>/view-fails` exists.
 */
function fakeGhScript(state: string): string {
  return [
    "#!/bin/sh",
    `state='${state}'`,
    'printf \'%s\\n\' "$*" >> "$state/calls"',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    '  if [ -e "$state/signed-out" ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  if [ -e "$state/view-fails" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi',
    '  number="${3##*/}"',
    '  if [ -e "$state/pr-$number" ]; then pr=$(cat "$state/pr-$number"); else pr=OPEN; fi',
    '  printf \'{"state":"%s"}\\n\' "$pr"',
    "  exit 0",
    "fi",
    'echo "fake gh: unexpected call: $*" >&2',
    "exit 2",
    "",
  ].join("\n");
}

describe("checkPullRequest: Check now and the timer's checks (C4)", () => {
  let originalPath: string;
  let ghState: string;

  beforeEach(async () => {
    const path = process.env.PATH;
    if (path === undefined) throw new Error("The test process has no PATH");
    originalPath = path;
    const bin = join(context.root, "gh-bin");
    ghState = join(context.root, "gh-state");
    await mkdir(bin);
    await mkdir(ghState);
    await writeFile(join(bin, "gh"), fakeGhScript(ghState), { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** The fake gh's `pr view` calls, one line of arguments each, in order. */
  function prViews(): string[] {
    const file = join(ghState, "calls");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("pr view "));
  }

  /** Makes the fake report pull request `number` in `state` (gh's own words). */
  async function reportState(number: number, state: "OPEN" | "CLOSED" | "MERGED"): Promise<void> {
    await writeFile(join(ghState, `pr-${String(number)}`), state);
  }

  function pullRequestUrl(number: number): string {
    return `https://github.com/acme/numbers/pull/${String(number)}`;
  }

  /** Records pull request `number`, open, on a passed run, as the publishing step does. */
  function recordPullRequest(runId: string, number: number): void {
    writeTestData(context, (tx) =>
      tx
        .update(deliveryRuns)
        .set({ prNumber: number, prUrl: pullRequestUrl(number), prState: "open" })
        .where(eq(deliveryRuns.id, runId))
        .run(),
    );
  }

  /** A passed run whose pull request #1 is open. */
  async function passedWithPullRequest(): Promise<StoredDeliveryRun> {
    const { run } = await passedRun();
    recordPullRequest(run.id, 1);
    return await stored(run.id);
  }

  async function stored(runId: string): Promise<StoredDeliveryRun> {
    const found = await getDeliveryRun(context.db, runId);
    if (!found.ok) throw new Error(found.error.code);
    return found.value;
  }

  const signal = (): AbortSignal => new AbortController().signal;

  test("a squash-merged pull request sets merged_at with ZeNorm's line, though git never shows the final commit in main (4.1)", async () => {
    const run = await passedWithPullRequest();
    // GitHub's squash merge: main gets one new commit, never the run's final commit.
    git(["merge", "-q", "--squash", run.branch]);
    git(["commit", "-q", "-m", "Squashed"]);
    await reportState(1, "MERGED");

    const checked = await checkPullRequest(context.user, context.db, run.id, signal());

    expect(checked.ok && checked.value.mergedAt).toEqual(expect.any(String));
    expect(checked.ok && checked.value.prState).toBe("merged");
    expect(prViews()).toEqual([`pr view ${pullRequestUrl(1)} --json state`]);
    expect(readRunEvents(context.db, run.id)).toMatchObject([
      {
        who: "zenorm",
        ticket: null,
        text: "Pull request #1 is merged into main on GitHub. The tickets are recorded as delivered.",
      },
    ]);
    expect(openPullRequestRuns(context.db)).toEqual([]);

    // Checked again, nothing more is written: merged_at is set once.
    const again = await checkPullRequest(context.user, context.db, run.id, signal());
    expect(again.ok && again.value.mergedAt).toBe(checked.ok && checked.value.mergedAt);
    expect(readRunEvents(context.db, run.id)).toHaveLength(1);
  });

  test("a closed pull request is recorded closed and leaves the timer's list; Check now records a reopen open", async () => {
    const run = await passedWithPullRequest();
    expect(openPullRequestRuns(context.db)).toEqual([run.id]);
    await reportState(1, "CLOSED");

    const closed = await checkPullRequest(context.user, context.db, run.id, signal());
    expect(closed.ok && [closed.value.prState, closed.value.mergedAt]).toEqual(["closed", null]);
    expect(openPullRequestRuns(context.db)).toEqual([]);

    await reportState(1, "OPEN");
    const reopened = await checkPullRequest(context.user, context.db, run.id, signal());
    expect(reopened.ok && [reopened.value.prState, reopened.value.mergedAt]).toEqual([
      "open",
      null,
    ]);
    expect(openPullRequestRuns(context.db)).toEqual([run.id]);
    expect(readRunEvents(context.db, run.id).map((line) => line.text)).toEqual([
      "Pull request #1 was closed on GitHub without being merged.",
      "Pull request #1 is open again on GitHub.",
    ]);
  });

  test("a pull request still open writes nothing", async () => {
    const run = await passedWithPullRequest();
    const checked = await checkPullRequest(context.user, context.db, run.id, signal());
    expect(checked).toEqual({ ok: true, value: run });
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });

  test.each([
    { code: "delivery_github_not_signed_in", file: "signed-out" },
    { code: "delivery_github_unreachable", file: "view-fails" },
  ] as const)("$code changes nothing (4.2)", async ({ code, file }) => {
    const run = await passedWithPullRequest();
    await reportState(1, "MERGED");
    await writeFile(join(ghState, file), "");

    expect(await checkPullRequest(context.user, context.db, run.id, signal())).toMatchObject({
      ok: false,
      error: { code, data: { runId: run.id } },
    });
    expect(await stored(run.id)).toEqual(run);
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });

  test("delivery_gh_missing when gh is not on PATH changes nothing (4.2)", async () => {
    const run = await passedWithPullRequest();
    const empty = join(context.root, "no-gh");
    await mkdir(empty);
    process.env.PATH = empty;
    const checked = await checkPullRequest(context.user, context.db, run.id, signal());
    process.env.PATH = originalPath;

    expect(checked).toMatchObject({
      ok: false,
      error: { code: "delivery_gh_missing", data: { runId: run.id } },
    });
    expect(await stored(run.id)).toEqual(run);
  });

  test("delivery_run_not_found and delivery_no_pull_request ask gh nothing (4.2)", async () => {
    expect(await checkPullRequest(context.user, context.db, UNKNOWN_ID, signal())).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_found", data: { runId: UNKNOWN_ID } },
    });
    const passed = await passedRun();
    const run = await stored(passed.run.id);
    expect(await checkPullRequest(context.user, context.db, run.id, signal())).toMatchObject({
      ok: false,
      error: { code: "delivery_no_pull_request", data: { runId: run.id } },
    });
    expect(await stored(run.id)).toEqual(run);
    expect(existsSync(join(ghState, "calls"))).toBe(false);
  });

  test("after a later run of the spec opens its own pull request, the earlier one is still checked and its merge records the earlier run merged (4.3)", async () => {
    const earlier = await passedWithPullRequest();
    // The later run of the same spec, passed with its own pull request #2.
    const laterId = uuidv7();
    writeTestData(context, (tx) =>
      tx
        .insert(deliveryRuns)
        .values({
          ...earlier,
          id: laterId,
          number: 2,
          branch: `${earlier.branch}-later`,
          worktreePath: `${earlier.worktreePath}-later`,
          startedAt: new Date(Date.parse(earlier.startedAt) + 1000).toISOString(),
          prNumber: 2,
          prUrl: pullRequestUrl(2),
          prState: "open",
        })
        .run(),
    );
    expect(openPullRequestRuns(context.db)).toEqual([earlier.id, laterId]);

    await reportState(1, "MERGED");
    // The timer checks each open pull request in turn.
    for (const runId of openPullRequestRuns(context.db)) {
      expect((await checkPullRequest({ kind: "system" }, context.db, runId, signal())).ok).toBe(
        true,
      );
    }

    expect((await stored(earlier.id)).mergedAt).toEqual(expect.any(String));
    expect(await stored(laterId)).toMatchObject({ mergedAt: null, prState: "open" });
    expect(prViews()).toEqual([
      `pr view ${pullRequestUrl(1)} --json state`,
      `pr view ${pullRequestUrl(2)} --json state`,
    ]);
    expect(openPullRequestRuns(context.db)).toEqual([laterId]);
  });
});

describe("a run from before 0010 (S8-12)", () => {
  test("Mark merged records merged_at and writes no line", async () => {
    const { run } = await passedRun();
    asPre0010Run(context, run.id);
    git(["merge", "-q", "--no-ff", "-m", "Merge", run.branch]);
    expect((await markMerged(context.user, context.db, run.id)).ok).toBe(true);
    expect(await mergedAt(run.id)).not.toBeNull();
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });

  test("a cancel writes its end and no line", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    asPre0010Run(context, run.id);
    const cancelled = await cancelDelivery(context.user, context.db, run.id);
    expect(cancelled.ok && cancelled.value.endedAt).toEqual(expect.any(String));
    expect(readRunEvents(context.db, run.id)).toEqual([]);
  });
});
