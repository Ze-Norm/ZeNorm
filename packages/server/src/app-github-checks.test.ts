import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isDefinedError, safe } from "@orpc/client";
import type { SpecRun } from "@zenorm/contracts";
import { createChangeBus, PULL_REQUEST_CHECK_INTERVAL_MS } from "@zenorm/core";
import { describe, expect, test, vi } from "vitest";

import type { ZeNormApp } from "./app.ts";
import {
  UNKNOWN_ID,
  SPEC,
  DELIVERY_WAIT,
  planningPorts,
  localExecutor,
  checked,
  appOf,
  db,
  webDistDir,
  log,
  client,
  approvedSet,
  PASSING_CHECK,
  startRun,
  deliveryRun,
  runIn,
  cleanedUp,
  standInExecutor,
  useExecutor,
  GITHUB_URL,
  GITHUB_PR_URL,
} from "./app-test-support.ts";
import {
  originalPath,
  ghState,
  pushTarget,
  ghCalls,
  addRemote,
  pathWithoutGh,
  setUpGitHubTests,
} from "./app-github-test-support.ts";

setUpGitHubTests();

describe("a GitHub project's pull request, checked after its run passed", () => {
  /** The fake gh's `pr view` calls, in order. */
  function prViews(): string[] {
    return ghCalls().filter((call) => call.startsWith("pr view "));
  }

  /** Makes the fake report pull request #1 in `state` (gh's own words). */
  async function reportState(state: "OPEN" | "CLOSED" | "MERGED"): Promise<void> {
    await writeFile(join(ghState, "pr-1"), state);
  }

  /** A passed run on a GitHub project, with its pull request #1 recorded open. */
  async function passedWithPullRequest(): Promise<{ mapId: string; run: SpecRun }> {
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
    const started = await startRun(ticketSetId, [PASSING_CHECK]);
    const run = await runIn(mapId, started.id, "passed", "publishing");
    await cleanedUp(started);
    expect(run.pullRequest).toMatchObject({ number: 1, state: "open" });
    return { mapId, run };
  }

  /**
   * A second app over the test's database, started under a fake `setInterval`: its pull request
   * checks' timer is the one the test drives. The caller stops it, then restores the timers.
   */
  async function timedApp(): Promise<ZeNormApp> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    return await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked([], [localExecutor(), standInExecutor([])], "stand-in"),
    });
  }

  test("Check now records a squash-merged pull request merged: Delivery reads done, with the Merged into line", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("MERGED");

    const merged = await client.delivery.checkPullRequest({ runId: run.id });

    expect(merged).toMatchObject({ state: "passed", pullRequest: { number: 1, state: "merged" } });
    expect(merged.mergedAt).not.toBeNull();
    const overview = await client.map.overview({ mapId });
    expect(overview.status.stages[4]).toMatchObject({ stage: "delivery", tone: "done" });
    expect(overview.activity.map((line) => line.text)).toContain(
      `Merged into main: “${SPEC.title}” is recorded as delivered.`,
    );
    const lines = await client.delivery.activity({ runId: run.id });
    expect(lines.at(-1)?.text).toBe(
      "Pull request #1 is merged into main on GitHub. The tickets are recorded as delivered.",
    );
    expect(prViews()).toEqual([`pr view ${GITHUB_PR_URL} --json state`]);
  });

  test("Check now's refusals each change nothing", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("MERGED");
    const before = await deliveryRun(mapId, run.id);
    async function refusedWith(runId: string): Promise<string | null> {
      const [error] = await safe(client.delivery.checkPullRequest({ runId }));
      return isDefinedError(error) ? error.code : null;
    }

    expect(await refusedWith(UNKNOWN_ID)).toBe("delivery_run_not_found");
    await writeFile(join(ghState, "signed-out"), "");
    expect(await refusedWith(run.id)).toBe("delivery_github_not_signed_in");
    await rm(join(ghState, "signed-out"));
    await writeFile(join(ghState, "view-fails"), "");
    expect(await refusedWith(run.id)).toBe("delivery_github_unreachable");
    await rm(join(ghState, "view-fails"));
    process.env.PATH = await pathWithoutGh();
    const missing = await refusedWith(run.id);
    process.env.PATH = originalPath;
    expect(missing).toBe("delivery_gh_missing");

    expect(await deliveryRun(mapId, run.id)).toEqual(before);
    expect(log).not.toHaveBeenCalled();
  });

  test("a passed run with no pull request is refused delivery_no_pull_request", async () => {
    await useExecutor(standInExecutor([]));
    const { mapId, ticketSetId } = await approvedSet();
    const started = await startRun(ticketSetId, [PASSING_CHECK]);
    await runIn(mapId, started.id, "passed", "reviewing");
    await cleanedUp(started);
    const before = await deliveryRun(mapId, started.id);

    const [error] = await safe(client.delivery.checkPullRequest({ runId: started.id }));

    expect(isDefinedError(error) && error.code).toBe("delivery_no_pull_request");
    expect(await deliveryRun(mapId, started.id)).toEqual(before);
    expect(ghCalls()).toEqual([]);
  });

  test("the timer records a closed pull request closed and no longer checks it; Check now records a reopen open", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("CLOSED");
    const timed = await timedApp();
    try {
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      await vi.waitFor(async () => {
        expect((await deliveryRun(mapId, run.id)).pullRequest?.state).toBe("closed");
      }, DELIVERY_WAIT);
      expect(prViews()).toHaveLength(1);

      // Closed, the next round has nothing to check.
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      expect(prViews()).toHaveLength(1);

      await reportState("OPEN");
      const reopened = await client.delivery.checkPullRequest({ runId: run.id });
      expect(reopened).toMatchObject({ mergedAt: null, pullRequest: { state: "open" } });

      // Open again, the timer checks it again, and records its merge.
      await reportState("MERGED");
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      await vi.waitFor(async () => {
        expect((await deliveryRun(mapId, run.id)).mergedAt).not.toBeNull();
      }, DELIVERY_WAIT);
      expect(prViews()).toHaveLength(3);
      expect(log).not.toHaveBeenCalled();
    } finally {
      await timed.stopDeliveryRuns();
      vi.useRealTimers();
    }
  });

  test("a failed timer check is logged and changes nothing", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("MERGED");
    await writeFile(join(ghState, "view-fails"), "");
    const before = await deliveryRun(mapId, run.id);
    const timed = await timedApp();
    try {
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`${run.id}.*delivery_github_unreachable`)),
          null,
        );
      }, DELIVERY_WAIT);
      expect(await deliveryRun(mapId, run.id)).toEqual(before);
    } finally {
      await timed.stopDeliveryRuns();
      vi.useRealTimers();
    }
  });
});
