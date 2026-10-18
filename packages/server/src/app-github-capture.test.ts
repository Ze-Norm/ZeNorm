import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";

import type {
  CapturedScreens,
  CaptureScreensRequest,
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  activityTexts,
  approvedSet,
  cleanedUp,
  client,
  DELIVERY_WAIT,
  gitIn,
  GITHUB_URL,
  log,
  NO_APP_SETTINGS,
  NO_IMAGES,
  PASSING_CHECK,
  PULL_REQUEST_BODY,
  PULL_REQUEST_WRITTEN,
  root,
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

/**
 * A stand-in app: it writes its pid to `<pidFile>`, then serves HTTP on `<port>` (`serve`) or never
 * listens (`hang`).
 */
const STAND_IN_APP = `
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [mode, port, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
if (mode === "serve") {
  createServer((request, response) => response.end("app")).listen(Number(port), "127.0.0.1");
} else {
  setInterval(() => {}, 1000);
}
`;

/** A stand-in setup command: it writes `<marker>` in its working directory and exits `<code>`. */
const STAND_IN_SETUP = `
import { writeFileSync } from "node:fs";
const [code, marker] = process.argv.slice(2);
writeFileSync(marker, process.cwd());
process.exitCode = Number(code);
`;

let port: number;
let appUrl: string;
let appScript: string;
let setupScript: string;
/** Where the stand-in app writes its pid, and the stand-in setup its working directory. */
let appPidFile: string;
let setupMarker: string;
const servers: Server[] = [];

/** A port nothing listens on, found by binding port 0 and closing it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port was bound");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

beforeEach(async () => {
  port = await freePort();
  appUrl = `http://127.0.0.1:${String(port)}`;
  appScript = join(root, "stand-in-app.mjs");
  setupScript = join(root, "stand-in-setup.mjs");
  appPidFile = join(root, "app.pid");
  setupMarker = join(root, "setup.marker");
  await writeFile(appScript, STAND_IN_APP);
  await writeFile(setupScript, STAND_IN_SETUP);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // A stand-in app a failed case left running must not outlive it.
  if (existsSync(appPidFile)) {
    try {
      process.kill(-Number(readFileSync(appPidFile, "utf8")), "SIGKILL");
    } catch {
      // Already stopped, as every passing case leaves it.
    }
  }
});

/** App settings that turn capture on with the stand-in app, its setup exiting `setupExit`. */
function captureOn(mode: "serve" | "hang" = "serve", setupExit = 0) {
  return {
    appStartCommand: `${process.execPath} ${appScript} ${mode} ${String(port)} ${appPidFile}`,
    appUrl,
    appSetupCommands: [`${process.execPath} ${setupScript} ${String(setupExit)} ${setupMarker}`],
  };
}

type AppSettings = ReturnType<typeof captureOn> | typeof NO_APP_SETTINGS;

const SCREENS: PickedScreens = {
  kind: "screens",
  screens: [
    { where: "/settings", changed: "A new App section.", isNew: false },
    { where: "/settings/app", changed: "The app settings form.", isNew: true },
    { where: "/admin", changed: "An admin notice.", isNew: false },
  ],
};

/** What each executor's ports were asked, in call order. */
interface Calls {
  readonly order: string[];
  readonly picks: PickScreensRequest[];
  readonly captures: CaptureScreensRequest[];
  readonly writes: PullRequestRequest[];
  /** Whether the app answered while the capture port ran. */
  readonly answered: boolean[];
}

/** How a stand-in capture answers: what it returns, given its request. */
type Shoot = (
  request: CaptureScreensRequest,
  signal: AbortSignal,
) => Promise<Result<CapturedScreens, DeliveryAgentError>>;

/** A capture that writes one PNG per picked screen but the last, which it skips. */
const SHOOT_ALL_BUT_LAST: Shoot = async (request) => {
  const images = request.screens.slice(0, 1).map((screen, index) => ({
    screen: screen.where,
    file: `screen-${String(index + 1)}.png`,
    caption: `${screen.where} after the change.`,
  }));
  for (const image of images) {
    await writeFile(join(request.screenshotsDir, image.file), `png of ${image.screen}`);
  }
  const last = request.screens.at(-1);
  if (last === undefined) throw new Error("No screen was picked");
  return ok({ images, skipped: [{ screen: last.where, reason: "It needs an admin login." }] });
};

/**
 * The stand-in executor with its screen picker answering `picked`, its capture answering through
 * `shoot` and its pull request writer answering `written`, each recording its request into `calls`.
 */
function capturing(
  calls: Calls,
  picked: Result<PickedScreens, DeliveryAgentError>,
  shoot: Shoot = SHOOT_ALL_BUT_LAST,
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
    captureScreens: async (request, signal) => {
      calls.order.push("capture");
      calls.captures.push(request);
      const answer = await fetch(request.appUrl).then(
        () => true,
        () => false,
      );
      calls.answered.push(answer);
      return await shoot(request, signal);
    },
    writePullRequest: (request) => {
      calls.order.push("pull request");
      calls.writes.push(request);
      return Promise.resolve(ok(written));
    },
  };
}

function newCalls(): Calls {
  return { order: [], picks: [], captures: [], writes: [], answered: [] };
}

/** Saves the (only) project's passing check, no repair and `app`, then starts a run of the set. */
async function startWith(ticketSetId: string, app: AppSettings): Promise<DeliveryRun> {
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
async function passedRun(app: AppSettings): Promise<{ run: DeliveryRun; texts: string[] }> {
  const { project, mapId, ticketSetId } = await approvedSet();
  addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
  const run = await startWith(ticketSetId, app);
  const passed = await runIn(mapId, run.id, "passed", "publishing");
  expect(passed.pullRequest).toMatchObject({ number: 1, state: "open" });
  expect(passed.failure).toBeNull();
  expect(pushedBranches()).toContain(run.branch);
  await cleanedUp(run);
  return { run, texts: await activityTexts(run.id) };
}

/** The run's pr-assets branch, as core names it. */
function prAssetsOf(run: DeliveryRun): string {
  return `pr-assets-${run.branch.slice(run.branch.lastIndexOf("/") + 1)}`;
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

/** The lines saying the screenshots are missing, each naming its code. */
function missingLines(texts: readonly string[]): string[] {
  return texts.filter((text) => text.startsWith("Screenshots are missing"));
}

/** Whether the stand-in app's process group, as its pid file names it, still runs. */
function appRuns(): boolean {
  try {
    process.kill(-Number(readFileSync(appPidFile, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}

/** The session records left in `<root>/sessions`. */
function sessionRecords(): string[] {
  return readdirSync(join(root, "sessions"));
}

describe("a run that pinned an app start command and URL picks its changed screens first", () => {
  test("no visible change adds one line, and the pull request opens with the writer's body", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok({ kind: "no_visible_change" })));

    const { run, texts } = await passedRun(captureOn());

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
    expect(write?.capture).toEqual({ kind: "no_visible_change" });
    const noVisibleChange =
      "The screen picker found no visible change, so the pull request has no screenshots and nothing was installed or started.";
    expect(captureLines(texts)).toEqual([noVisibleChange]);
    // The picker's line comes before the writer's.
    expect(texts.indexOf(noVisibleChange)).toBeLessThan(
      texts.indexOf("Writing the pull request for acme/numbers."),
    );
    // Nothing was set up or started, and only the run branch was pushed.
    expect(existsSync(setupMarker)).toBe(false);
    expect(existsSync(appPidFile)).toBe(false);
    expect(pushedBranches()).toEqual([run.branch]);
    expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
      `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
    );
    expect(log).not.toHaveBeenCalled();
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

      const { texts } = await passedRun(captureOn());

      expect(calls.order).toEqual(["implement", "review", "pick screens", "pull request"]);
      const lines = captureLines(texts);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("capture_picker_failed");
      expect(calls.writes[0]?.capture).toEqual({ kind: "failed", code: "capture_picker_failed" });
      expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
        `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
      );
    },
  );
});

describe("screens listed are captured from the started app and pushed to the run's pr-assets branch", () => {
  test("the app is set up and started from the worktree, shot, stopped, and its images reach the writer", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS)));

    const { run, texts } = await passedRun(captureOn());

    expect(calls.order).toEqual(["implement", "review", "pick screens", "capture", "pull request"]);
    // Setup ran in the run worktree, and the app answered while the capture ran.
    const [capture] = calls.captures;
    if (capture === undefined) throw new Error("The capture port was not called");
    // The worktree is gone after the cleanup; the setup saw it by its realpath.
    expect(readFileSync(setupMarker, "utf8")).toBe(
      join(realpathSync(root), "runs", run.id, "worktree"),
    );
    expect(capture.worktreePath).toBe(join(root, "runs", run.id, "worktree"));
    expect(calls.answered).toEqual([true]);
    expect(capture).toEqual({
      runDir: calls.writes[0]?.runDir,
      worktreePath: calls.writes[0]?.worktreePath,
      appUrl,
      screens: SCREENS.kind === "screens" ? SCREENS.screens : [],
      screenshotsDir: join(capture.runDir, "screenshots"),
      gitIdentity: calls.writes[0]?.gitIdentity,
    });
    // The app's whole process group was stopped after the capture, its record gone.
    expect(appRuns()).toBe(false);
    expect(sessionRecords()).toEqual([]);

    // The images are on the run's pr-assets branch on origin; the run branch holds none.
    const assets = prAssetsOf(run);
    expect(pushedBranches().sort()).toEqual([assets, run.branch].sort());
    expect(gitIn(pushTarget, ["ls-tree", "--name-only", assets])).toBe("screen-1.png");
    expect(gitIn(pushTarget, ["show", `${assets}:screen-1.png`])).toBe("png of /settings");
    expect(gitIn(pushTarget, ["ls-tree", "-r", "--name-only", run.branch])).not.toContain(
      "screen-1.png",
    );

    // The writer gets each image by its raw blob path, the skipped screen and the one not shown.
    expect(calls.writes[0]?.capture).toEqual({
      kind: "captured",
      images: [
        {
          screen: "/settings",
          caption: "/settings after the change.",
          src: `../blob/${assets}/screen-1.png?raw=true`,
        },
      ],
      skipped: [{ screen: "/admin", reason: "It needs an admin login." }],
      notShown: [{ where: "/settings/app", changed: "The app settings form.", isNew: true }],
    });
    expect(captureLines(texts)).toEqual([
      "The screen picker picked 3 changed screens: /settings, /settings/app (new), /admin.",
    ]);
    expect(texts).toContain(`Pushed 1 screenshot to ${assets} on origin.`);
    expect(log).not.toHaveBeenCalled();
  });

  test("a capture with no image pushes nothing but the run branch", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS), () => Promise.resolve(ok(NO_IMAGES))));

    const { run } = await passedRun(captureOn());

    expect(pushedBranches()).toEqual([run.branch]);
    expect(calls.writes[0]?.capture).toEqual({
      kind: "captured",
      images: [],
      skipped: [],
      notShown: SCREENS.kind === "screens" ? SCREENS.screens : [],
    });
  });
});

describe("a failed capture adds a line with its code, and the run ends passed with its pull request", () => {
  /** Seven screens' images, one more than a pull request shows. */
  const SHOOT_SEVEN: Shoot = async (request) => {
    const images = Array.from({ length: 7 }, (_, index) => ({
      screen: `/screen-${String(index + 1)}`,
      file: `screen-${String(index + 1)}.png`,
      caption: "A screen.",
    }));
    for (const image of images) {
      await writeFile(join(request.screenshotsDir, image.file), "png");
    }
    return ok({ images, skipped: [] });
  };

  const SESSION_FAILED: Shoot = () =>
    Promise.resolve(
      err({
        code: "agent_run_failed",
        message: "The capture session exited 1.",
        data: { exitCode: 1, subtype: null },
      }),
    );

  test.each([
    {
      code: "capture_setup_failed",
      app: () => captureOn("serve", 1),
      shoot: SHOOT_ALL_BUT_LAST,
      before: () => Promise.resolve(),
    },
    {
      code: "capture_app_not_ready",
      app: () => captureOn("hang"),
      shoot: SHOOT_ALL_BUT_LAST,
      before: () => Promise.resolve(),
    },
    {
      code: "capture_app_url_in_use",
      app: () => captureOn(),
      shoot: SHOOT_ALL_BUT_LAST,
      before: async () => {
        const server = createServer((_request, response) => response.end("someone else"));
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      },
    },
    {
      code: "capture_session_failed",
      app: () => captureOn(),
      shoot: SESSION_FAILED,
      before: () => Promise.resolve(),
    },
    {
      code: "capture_too_many_screens",
      app: () => captureOn(),
      shoot: SHOOT_SEVEN,
      before: () => Promise.resolve(),
    },
    {
      code: "capture_push_failed",
      app: () => captureOn(),
      shoot: SHOOT_ALL_BUT_LAST,
      // Origin refuses every pr-assets branch, and takes the run branch.
      before: () =>
        writeFile(
          join(pushTarget, "hooks", "pre-receive"),
          [
            "#!/bin/sh",
            "while read old new ref; do",
            '  case "$ref" in refs/heads/pr-assets-*) echo "refused" >&2; exit 1 ;; esac',
            "done",
            "exit 0",
            "",
          ].join("\n"),
          { mode: 0o755 },
        ),
    },
  ] as const)("$code", async ({ code, app, shoot, before }) => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS), shoot));
    await before();

    const { run, texts } = await passedRun(app());

    const lines = missingLines(texts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(code);
    expect(calls.writes[0]?.capture).toEqual({ kind: "failed", code });
    expect(pushedBranches()).toEqual([run.branch]);
    // Whatever failed, no app is left running and no record is left behind.
    if (existsSync(appPidFile)) {
      expect(appRuns()).toBe(false);
    }
    expect(sessionRecords()).toEqual([]);
    expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
      `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
    );
  });

  test("the setup failure starts no app, and the capture port is not called", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS)));

    await passedRun(captureOn("serve", 1));

    expect(existsSync(appPidFile)).toBe(false);
    expect(calls.captures).toEqual([]);
  });

  test("an app already answering is never started", async () => {
    const calls = newCalls();
    await useExecutor(capturing(calls, ok(SCREENS)));
    const server = createServer((_request, response) => response.end("someone else"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    await passedRun(captureOn());

    expect(existsSync(appPidFile)).toBe(false);
    expect(calls.captures).toEqual([]);
  });
});

describe("a cancel during the capture", () => {
  test("stops the app's process group and removes its record", async () => {
    const calls = newCalls();
    let shooting = false;
    await useExecutor(
      capturing(
        calls,
        ok(SCREENS),
        (_request, signal) =>
          new Promise((resolve) => {
            shooting = true;
            signal.addEventListener(
              "abort",
              () => {
                resolve(err({ code: "agent_cancelled", message: "Stopped.", data: {} }));
              },
              { once: true },
            );
          }),
      ),
    );
    const { project, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
    const run = await startWith(ticketSetId, captureOn());
    await vi.waitFor(() => {
      expect(shooting).toBe(true);
    }, DELIVERY_WAIT);
    expect(appRuns()).toBe(true);
    expect(sessionRecords()).toHaveLength(1);

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "publishing", pullRequest: null });
    await cleanedUp(run);

    await vi.waitFor(() => {
      expect(appRuns()).toBe(false);
      expect(sessionRecords()).toEqual([]);
    }, DELIVERY_WAIT);
    expect(calls.writes).toEqual([]);
    expect(pushedBranches()).toEqual([]);
  });
});

describe("a run without capture runs no picker", () => {
  test("the writer reporting a visible change adds the setup hint, the body the writer's unchanged", async () => {
    const calls = newCalls();
    await useExecutor(
      capturing(calls, ok(SCREENS), SHOOT_ALL_BUT_LAST, {
        body: PULL_REQUEST_BODY,
        visibleChange: true,
      }),
    );

    const { texts } = await passedRun(NO_APP_SETTINGS);

    expect(calls.order).toEqual(["implement", "review", "pull request"]);
    expect(calls.picks).toEqual([]);
    expect(calls.writes[0]?.capture).toEqual({ kind: "off" });
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
      ...captureOn(),
    });
    await runIn(mapId, run.id, "passed", "publishing");
    await cleanedUp(run);

    expect(calls.picks).toEqual([]);
  });
});
