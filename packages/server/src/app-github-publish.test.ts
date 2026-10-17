import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PullRequestRequest } from "@zenorm/contracts";
import { err, ok, PULL_REQUEST_FOOTER } from "@zenorm/contracts";
import { GITHUB_SIGN_IN_TIMEOUT_MS } from "@zenorm/core";
import { describe, expect, test, vi } from "vitest";

import {
  SPEC,
  TICKETS,
  DELIVERY_WAIT,
  nthCall,
  root,
  log,
  pullRequestPort,
  client,
  approvedSet,
  PULL_REQUEST_BODY,
  PASSING_CHECK,
  gitIn,
  verdictFor,
  startRun,
  deliveryRun,
  runIn,
  cleanedUp,
  standInExecutor,
  useExecutor,
  GITHUB_URL,
} from "./app-test-support.ts";
import {
  ghState,
  pushTarget,
  ghCalls,
  addRemote,
  pushedBranches,
  pathWithoutGh,
  writingWith,
  setUpGitHubTests,
} from "./app-github-test-support.ts";

setUpGitHubTests();

describe("a passing run on a GitHub project opens a pull request", () => {
  test("a passed run pushes its branch and records its pull request open; Merge PR is next", async () => {
    const requests: PullRequestRequest[] = [];
    await useExecutor(
      writingWith((request) => {
        requests.push(request);
        return Promise.resolve(ok(PULL_REQUEST_BODY));
      }),
    );
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "publishing");

    expect(passed.pullRequest).toEqual({
      number: 1,
      url: "https://github.com/acme/numbers/pull/1",
      state: "open",
    });
    expect(passed.verdict).not.toBeNull();
    expect(pushedBranches()).toEqual([run.branch]);
    expect(gitIn(pushTarget, ["rev-parse", run.branch])).toBe(passed.finalCommit);
    const bodyFile = join(root, "runs", run.id, "pull-request.md");
    expect(ghCalls()).toEqual([
      "auth status --hostname github.com",
      `pr create --repo acme/numbers --base main --head ${run.branch} --title ${SPEC.title} --body-file ${bodyFile}`,
    ]);
    expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
      `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
    );
    // The writer is given the change, every ticket's report, the checks and the verdict.
    const [request] = requests;
    expect(request).toMatchObject({
      finalCommit: passed.finalCommit,
      verdict: passed.verdict,
      checkResults: passed.checkResults,
    });
    expect(Array.isArray(request?.changedFiles)).toBe(true);
    expect(request?.implementerReports.map((report) => report.ticket)).toEqual(
      TICKETS.tickets.map((ticket) => ticket.id),
    );
    expect(request?.implementerReports.every((report) => report.report !== null)).toBe(true);

    const lines = await cleanedUp(run);
    expect(lines.map((line) => line.text)).toContain(
      "Opened pull request #1 on acme/numbers: merge it on GitHub.",
    );
    const { status } = await client.map.overview({ mapId });
    expect(status.stages[4]).toMatchObject({ stage: "delivery", tone: "needs-you" });
    expect(status.next[0]).toMatchObject({ who: "you", stage: "delivery", label: "Merge PR" });
    expect(log).not.toHaveBeenCalled();
  });

  test("a blocked run pushes nothing and opens no pull request", async () => {
    const written: PullRequestRequest[] = [];
    await useExecutor({
      ...writingWith((request) => {
        written.push(request);
        return Promise.resolve(ok(PULL_REQUEST_BODY));
      }),
      reviewDelivery: (request) => Promise.resolve(ok(verdictFor(request.finalCommit, true))),
    });
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const blocked = await runIn(mapId, run.id, "blocked", "reviewing");
    await cleanedUp(run);

    expect(blocked.pullRequest).toBeNull();
    expect(written).toEqual([]);
    expect(pushedBranches()).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });

  test.each([
    { name: "no origin", remote: null },
    {
      name: "an origin on a GitHub Enterprise host",
      remote: { name: "origin", url: "https://github.acme.example/acme/numbers.git" },
    },
    { name: "a github.com remote not named origin", remote: { name: "upstream", url: GITHUB_URL } },
  ])("$name passes as today, with nothing pushed and no pull request", async ({ remote }) => {
    const calls: string[] = [];
    await useExecutor(standInExecutor(calls));
    const { project, mapId, ticketSetId } = await approvedSet();
    if (remote !== null) {
      addRemote(project.folderPath, remote.name, remote.url, pushTarget);
    }

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);

    expect(passed.pullRequest).toBeNull();
    expect(calls).toEqual(["implement", "review"]);
    expect(pushedBranches()).toEqual([]);
    expect(ghCalls()).toEqual([]);
    const { status } = await client.map.overview({ mapId });
    expect(status.next[0]?.label).toBe("Mark merged");
  });

  test("a fork checkout opens its pull request on origin's repository, the fork", async () => {
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", "git@github.com:me/numbers.git", pushTarget);
    gitIn(project.folderPath, ["remote", "add", "upstream", GITHUB_URL]);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "publishing");
    await cleanedUp(run);

    expect(passed.pullRequest?.url).toBe("https://github.com/me/numbers/pull/1");
    const create = ghCalls().find((call) => call.startsWith("pr create"));
    expect(create).toContain("--repo me/numbers ");
    expect(create).not.toContain("acme/numbers");
    expect(pushedBranches()).toEqual([run.branch]);
  });

  test.each([
    { code: "delivery_github_not_signed_in", setUp: () => "signed-out", pushes: false },
    { code: "delivery_pull_request_failed", setUp: () => "pr-fails", pushes: true },
  ] as const)(
    "a failing gh step ends the run failed $code while publishing",
    async ({ code, setUp, pushes }) => {
      await writeFile(join(ghState, setUp()), "");
      await useExecutor(standInExecutor([]));
      const { project, mapId, ticketSetId } = await approvedSet();
      addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

      const run = await startRun(ticketSetId, [PASSING_CHECK]);
      const failed = await runIn(mapId, run.id, "failed", "publishing");
      await cleanedUp(run);

      expect(failed.failure?.code).toBe(code);
      expect(failed).toMatchObject({ verdict: null, pullRequest: null });
      expect(pushedBranches()).toEqual(pushes ? [run.branch] : []);
      expect(log).not.toHaveBeenCalled();
    },
  );

  test("gh missing from PATH ends the run failed delivery_gh_missing, nothing pushed", async () => {
    const noGh = await pathWithoutGh();
    await useExecutor(
      writingWith(() => {
        // From the publishing step on, `PATH` finds git but no gh; afterEach restores it.
        process.env.PATH = noGh;
        return Promise.resolve(ok(PULL_REQUEST_BODY));
      }),
    );
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const failed = await runIn(mapId, run.id, "failed", "publishing");
    await cleanedUp(run);

    expect(failed.failure?.code).toBe("delivery_gh_missing");
    expect(pushedBranches()).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });

  test("a failed push ends the run failed delivery_push_failed", async () => {
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, join(root, "no-such-remote.git"));

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const failed = await runIn(mapId, run.id, "failed", "publishing");
    await cleanedUp(run);

    expect(failed.failure?.code).toBe("delivery_push_failed");
    expect(ghCalls()).toEqual(["auth status --hostname github.com"]);
  });

  test("a sign-in check past its bound ends the run failed delivery_github_unreachable", async () => {
    await writeFile(join(ghState, "hang"), "");
    await useExecutor(writingWith(pullRequestPort.port));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const writer = await nthCall(pullRequestPort.calls, 0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      writer.resolve(ok(PULL_REQUEST_BODY));
      await vi.waitFor(() => {
        expect(ghCalls()).toEqual(["auth status --hostname github.com"]);
      }, DELIVERY_WAIT);
      await vi.advanceTimersByTimeAsync(GITHUB_SIGN_IN_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }

    const failed = await runIn(mapId, run.id, "failed", "publishing");
    await cleanedUp(run);
    expect(failed.failure?.code).toBe("delivery_github_unreachable");
    expect(pushedBranches()).toEqual([]);
  });

  test("after a failed open nothing is deleted, and a resume pushes a different branch", async () => {
    await writeFile(join(ghState, "pr-fails"), "");
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const first = await startRun(ticketSetId, [PASSING_CHECK]);
    const failed = await runIn(mapId, first.id, "failed", "publishing");
    expect(failed.failure?.code).toBe("delivery_pull_request_failed");
    await cleanedUp(first);
    expect(pushedBranches()).toEqual([first.branch]);

    await rm(join(ghState, "pr-fails"));
    const resumed = await client.delivery.resume({ runId: first.id });
    const passed = await runIn(mapId, resumed.id, "passed", "publishing");
    await cleanedUp(resumed);

    expect(resumed.branch).not.toBe(first.branch);
    expect(pushedBranches().sort()).toEqual([first.branch, resumed.branch].sort());
    expect(passed.pullRequest).toMatchObject({ number: 1, state: "open" });
    const creates = ghCalls().filter((call) => call.startsWith("pr create"));
    expect(creates.map((call) => call.includes(`--head ${resumed.branch} `))).toEqual([
      false,
      true,
    ]);
    expect(ghCalls().every((call) => /^(auth status|pr create) /.test(call))).toBe(true);
  });

  test("a run cancelled after its pull request opened ends cancelled, and gh is never asked to close it", async () => {
    await writeFile(join(ghState, "hold-after-open"), "");
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await vi.waitFor(() => {
      expect(existsSync(join(ghState, "opened"))).toBe(true);
    }, DELIVERY_WAIT);
    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "publishing", pullRequest: null });
    const lines = await cleanedUp(run);

    expect(lines.map((line) => line.text)).toContain(
      "You cancelled the run while ZeNorm was opening its pull request. Anything already pushed or opened stays on GitHub.",
    );
    expect(ghCalls().map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
      "auth status",
      "pr create",
    ]);
    expect(pushedBranches()).toEqual([run.branch]);
    expect(await deliveryRun(mapId, run.id)).toMatchObject({ state: "cancelled" });
  });

  test.each([
    {
      code: "agent_skill_missing",
      error: {
        code: "agent_skill_missing",
        message: "The skill file skills/pr/SKILL.md does not exist.",
        data: { skillPath: "/zenorm/skills/pr/SKILL.md" },
      },
    },
    {
      code: "agent_timed_out",
      error: {
        code: "agent_timed_out",
        message: "The pull request writer did not finish within 1200 seconds and was stopped.",
        data: { timeoutSeconds: 1200 },
      },
    },
  ] as const)(
    "a writer failing $code ends the run failed with it, nothing pushed",
    async ({ code, error }) => {
      await useExecutor(writingWith(() => Promise.resolve(err(error))));
      const { project, mapId, ticketSetId } = await approvedSet();
      addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

      const run = await startRun(ticketSetId, [PASSING_CHECK]);
      const failed = await runIn(mapId, run.id, "failed", "publishing");
      await cleanedUp(run);

      expect(failed.failure?.code).toBe(code);
      expect(pushedBranches()).toEqual([]);
      expect(ghCalls()).toEqual([]);
    },
  );

  test("while the writer works the run reads publishing, its Delivery stage working", async () => {
    await useExecutor(writingWith(pullRequestPort.port));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const writer = await nthCall(pullRequestPort.calls, 0);
    const publishing = await runIn(mapId, run.id, "running", "publishing");
    expect(publishing).toMatchObject({ verdict: null, pullRequest: null });
    const { status } = await client.map.overview({ mapId });
    expect(status.stages[4]).toMatchObject({ stage: "delivery", tone: "working" });

    writer.resolve(ok(PULL_REQUEST_BODY));
    await runIn(mapId, run.id, "passed", "publishing");
    await cleanedUp(run);
  });
});
