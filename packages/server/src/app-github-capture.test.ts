import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DeliveryAgentError,
  DeliveryExecutor,
  DeliveryRun,
  PickedScreens,
  PickScreensRequest,
  PullRequestRequest,
  Result,
  WrittenPullRequest,
} from "@zenorm/contracts";
import { err, ok, PULL_REQUEST_FOOTER } from "@zenorm/contracts";
import { describe, expect, test } from "vitest";

import {
  activityTexts,
  approvedSet,
  cleanedUp,
  client,
  GITHUB_URL,
  log,
  NO_APP_SETTINGS,
  PASSING_CHECK,
  PULL_REQUEST_BODY,
  PULL_REQUEST_WRITTEN,
  runIn,
  standInExecutor,
  useExecutor,
} from "./app-test-support.ts";
import {
  addRemote,
  ghState,
  pushedBranches,
  pushTarget,
  setUpGitHubTests,
} from "./app-github-test-support.ts";

setUpGitHubTests();

/** App settings that turn capture on: a start command and its local URL, one setup command. */
const CAPTURE_ON = {
  appStartCommand: "pnpm dev",
  appUrl: "http://localhost:5173",
  appSetupCommands: ["pnpm install"],
};

const SCREENS: PickedScreens = {
  kind: "screens",
  screens: [
    { where: "/settings", changed: "A new App section.", isNew: false },
    { where: "/settings/app", changed: "The app settings form.", isNew: true },
  ],
};

/** What each executor's ports were asked, in call order. */
interface Calls {
  readonly order: string[];
  readonly picks: PickScreensRequest[];
  readonly writes: PullRequestRequest[];
}

/**
 * The stand-in executor with its screen picker answering `picked` and its pull request writer
 * answering `written`, both recording their requests into `calls`.
 */
function capturing(
  calls: Calls,
  picked: Result<PickedScreens, DeliveryAgentError>,
  written: WrittenPullRequest = PULL_REQUEST_WRITTEN,
): DeliveryExecutor {
  return {
    ...standInExecutor(calls.order),
    name: "capturing",
    pickScreens: (request) => {
      calls.order.push("pick screens");
      calls.picks.push(request);
      return Promise.resolve(picked);
    },
    writePullRequest: (request) => {
      calls.order.push("pull request");
      calls.writes.push(request);
      return Promise.resolve(ok(written));
    },
  };
}

function newCalls(): Calls {
  return { order: [], picks: [], writes: [] };
}

/** Saves the (only) project's passing check, no repair and `app`, then starts a run of the set. */
async function startWith(
  ticketSetId: string,
  app: typeof CAPTURE_ON | typeof NO_APP_SETTINGS,
): Promise<DeliveryRun> {
  const [project] = await client.project.list();
  if (project === undefined) throw new Error("No project is stored");
  await client.project.saveSettings({
    projectId: project.id,
    baseBranch: project.baseBranch,
    requiredChecks: [PASSING_CHECK],
    repairLimit: 0,
    fixCommands: [],
    ...app,
  });
  return await client.delivery.start({ ticketSetId });
}

/** A passed run on a GitHub project, its pull request open, and its activity once cleaned up. */
async function passedRun(
  app: typeof CAPTURE_ON | typeof NO_APP_SETTINGS,
): Promise<{ run: DeliveryRun; texts: string[] }> {
  const { project, mapId, ticketSetId } = await approvedSet();
  addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
  const run = await startWith(ticketSetId, app);
  const passed = await runIn(mapId, run.id, "passed", "publishing");
  expect(passed.pullRequest).toMatchObject({ number: 1, state: "open" });
  expect(passed.failure).toBeNull();
  expect(pushedBranches()).toEqual([run.branch]);
  await cleanedUp(run);
  return { run, texts: await activityTexts(run.id) };
}

/** The lines naming the capture: the picker's answer, its failure or the setup hint. */
function captureLines(texts: readonly string[]): string[] {
  return texts.filter(
    (text) =>
      text.startsWith("The screen picker") ||
      text.startsWith("Screenshots are missing") ||
      text.includes("Project settings"),
  );
}

describe("a run that pinned an app start command and URL picks its changed screens first", () => {
  test("no visible change adds one line, and the pull request opens with the writer's body", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok({ kind: "no_visible_change" })));

    const { run, texts } = await passedRun(CAPTURE_ON);

    expect(calls.order).toEqual(["implement", "review", "pick screens", "pull request"]);
    const [pick] = calls.picks;
    const [write] = calls.writes;
    expect(pick).toEqual({
      runDir: write?.runDir,
      worktreePath: write?.worktreePath,
      baseCommit: run.baseCommit,
      finalCommit: write?.finalCommit,
      specPath: write?.specPath,
      diffPath: write?.diffPath,
      changedFiles: write?.changedFiles,
      gitIdentity: write?.gitIdentity,
    });
    expect(captureLines(texts)).toEqual([
      "The screen picker found no visible change, so the pull request has no screenshots and nothing was installed or started.",
    ]);
    // The picker's line comes before the writer's.
    expect(texts.indexOf(captureLines(texts)[0] ?? "")).toBeLessThan(
      texts.indexOf("Writing the pull request for acme/numbers."),
    );
    expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
      `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
    );
    expect(log).not.toHaveBeenCalled();
  });

  test("screens listed add one line naming them, and the pull request opens", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS)));

    const { texts } = await passedRun(CAPTURE_ON);

    expect(calls.order).toEqual(["implement", "review", "pick screens", "pull request"]);
    expect(captureLines(texts)).toEqual([
      "The screen picker picked 2 changed screens: /settings, /settings/app (new).",
    ]);
  });

  test.each([
    {
      code: "agent_run_failed",
      error: {
        code: "agent_run_failed",
        message: "The screen picker exited 1.",
        data: { exitCode: 1, subtype: null },
      },
    },
    {
      code: "agent_timed_out",
      error: {
        code: "agent_timed_out",
        message: "The screen picker did not finish within 1200 seconds and was stopped.",
        data: { timeoutSeconds: 1200 },
      },
    },
  ] as const)(
    "a picker failing $code adds a capture_picker_failed line, and the run ends passed with its pull request",
    async ({ error }) => {
      const calls = newCalls();
      await useExecutor(capturing(calls, err(error)));

      const { texts } = await passedRun(CAPTURE_ON);

      expect(calls.order).toEqual(["implement", "review", "pick screens", "pull request"]);
      const lines = captureLines(texts);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("capture_picker_failed");
      expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
        `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
      );
    },
  );
});

describe("a run without capture runs no picker", () => {
  test("the writer reporting a visible change adds the setup hint, the body the writer's unchanged", async () => {
    const calls = newCalls();
    await useExecutor(
      capturing(calls, ok(SCREENS), { body: PULL_REQUEST_BODY, visibleChange: true }),
    );

    const { texts } = await passedRun(NO_APP_SETTINGS);

    expect(calls.order).toEqual(["implement", "review", "pull request"]);
    expect(calls.picks).toEqual([]);
    expect(captureLines(texts)).toEqual([
      "This change is visible in the app. Save an app start command and its URL in Project settings to show screenshots of the changed screens in pull requests.",
    ]);
    expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
      `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
    );
  });

  test("the writer reporting no visible change adds no capture line", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS)));

    const { texts } = await passedRun(NO_APP_SETTINGS);

    expect(calls.order).toEqual(["implement", "review", "pull request"]);
    expect(captureLines(texts)).toEqual([]);
  });

  test("a project's app settings saved after the start leave the run's pinned capture off", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS)));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
    // A run started with no app settings pins none: the save after its start changes nothing.
    const run = await startWith(ticketSetId, NO_APP_SETTINGS);
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK],
      repairLimit: 0,
      fixCommands: [],
      ...CAPTURE_ON,
    });
    await runIn(mapId, run.id, "passed", "publishing");
    await cleanedUp(run);

    expect(calls.picks).toEqual([]);
  });
});
