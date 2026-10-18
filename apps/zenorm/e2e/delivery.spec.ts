import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Page } from "@playwright/test";
import { DeliveryRun, PULL_REQUEST_FOOTER } from "@zenorm/contracts";
import type { SpecRun } from "@zenorm/contracts";

import {
  captureRepo,
  deliveryRunsRepo,
  pullRequestBody,
  repairReleaseFile,
  screenPickerCallsFile,
} from "./fixture.ts";
import type { CaptureFlow } from "./fixture.ts";
import {
  addProject,
  addProjectInNewPage,
  approvedMap,
  deliveryActivityTexts,
  gitIn,
  inboxGroup,
  mapOverview,
  mapRowLink,
  runStep,
  saveChecks,
  saveChecksAndAppSettings,
  saveChecksAndRepairLimit,
  startDeliveryForm,
} from "./flows.ts";
import type { AppSettings } from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * Runs on its own project (`deliveryRunsRepo()`). Each scenario uses a new map and saves
 * the project's required checks and a repair limit of 0 through `project.saveSettings` before it
 * starts.
 * Run states are read from `map.overview`'s `spec.runs`, the one read every page shares.
 */
const SPEC_SLUG = "export-data-as-csv";
const PASSING_CHECK = "git status --short";
/** Prints the stand-in's commit subject. */
const PRINTING_CHECK = "git log -1 --format=%s";
const SLOW_CHECK = "git log -1 --format=[fake:slow]";
/** The files the stand-in's implementers write, one per ticket (`fake-claude.ts`). */
const TICKET_FILES = ["zenorm-fake-t1.txt", "zenorm-fake-t2.txt"];
const FAILING_CHECK = "git rev-parse --verify no-such-ref";
/** Fails until the stand-in's first repair attempt commits its file (`fake-claude.ts`). */
const REPAIRED_CHECK = "git ls-files --error-unmatch zenorm-fake-repair-1.txt";

// Each scenario starts its own map, so they run at once on different workers, each on its own
// server; `beforeAll` adds the project there.
test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, deliveryRunsRepo());
});

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", deliveryRunsRepo(), ...args], { encoding: "utf8" }).trim();
}

/**
 * Clicks the card's start button, labelled as core's action is (Start delivery, or Start again from
 * clean after a run ended without passing); returns the run as `delivery.start` answered.
 */
async function startDelivery(
  page: Page,
  label: "Start delivery" | "Start again from clean",
): Promise<DeliveryRun> {
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/rpc/delivery/start"),
  );
  await startDeliveryForm(page).getByRole("button", { name: label }).click();
  const body: unknown = await (await response).json();
  if (typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`delivery.start answered ${JSON.stringify(body)}`);
  }
  return DeliveryRun.parse(body.json);
}

/** Saves the project's checks, then opens the map's Delivery page so its card reads them. */
async function withChecks(page: Page, mapId: string, checks: readonly string[]): Promise<void> {
  await saveChecks(page, mapId, checks);
  await page.goto(`/maps/${mapId}/delivery`);
}

const STEPS = ["Prepare", "Implement", "Verify", "Review", "Merge"] as const;
type Step = (typeof STEPS)[number];

/** The mark (`data-mark`) of each of the five steps of the shown run. */
async function expectMarks(page: Page, marks: Record<Step, string>): Promise<void> {
  for (const name of STEPS) {
    await expect(runStep(page, name)).toHaveAttribute("data-mark", marks[name]);
  }
}

/** The Verify step's row for `command`. */
function checkResult(page: Page, command: string) {
  return page
    .getByRole("list", { name: "Check results" })
    .getByRole("listitem")
    .filter({ hasText: command });
}

/** The Runs list's link to run `number`; listed from the second run. */
function runLink(page: Page, number: number) {
  return page
    .getByRole("region", { name: "Runs of this spec from this map" })
    .getByRole("link")
    .filter({ hasText: `Run ${String(number)}` });
}

/** Spec 1's run numbered `number`, as `map.overview` reports it. */
async function specRun(page: Page, mapId: string, number: number): Promise<SpecRun> {
  const { specs } = await mapOverview(page, mapId);
  const run = specs[0]?.runs.find((candidate) => candidate.number === number);
  if (run === undefined) {
    throw new Error(`Map ${mapId} has no run ${String(number)}`);
  }
  return run;
}

/** Polls `map.overview` until run `number` is in `state`. */
async function expectRunState(
  page: Page,
  mapId: string,
  number: number,
  state: DeliveryRun["state"],
): Promise<SpecRun> {
  await expect.poll(async () => (await specRun(page, mapId, number)).state).toBe(state);
  return await specRun(page, mapId, number);
}

test("delivers an approved ticket set: cancels run 1, then run 2 passes", async ({ page }) => {
  const idea = "Deliver the CSV export";
  const mapId = await approvedMap(page, deliveryRunsRepo(), idea);
  await withChecks(page, mapId, [PASSING_CHECK, SLOW_CHECK]);

  // Ready to start: the map waits on you.
  await page.goto("/");
  await expect(mapRowLink(inboxGroup(page, "Needs you"), mapId)).toBeVisible();
  await page.goto(`/maps/${mapId}/delivery`);

  // Run 1 waits in a check until it is cancelled; meanwhile the agent is working.
  const started1 = await startDelivery(page, "Start delivery");
  expect(started1).toMatchObject({ number: 1, checks: [PASSING_CHECK, SLOW_CHECK] });
  expect(started1.baseBranch).toBe("main");
  await expectRunState(page, mapId, 1, "running");
  await page.goto("/");
  await expect(mapRowLink(inboxGroup(page, "Agent is working"), mapId)).toBeVisible();
  await page.goto(`/maps/${mapId}/delivery`);

  await expect(runStep(page, "Implement")).toHaveAttribute("data-mark", "working");
  await page.getByRole("button", { name: "Cancel run" }).click();
  const cancelled = await expectRunState(page, mapId, 1, "cancelled");
  expect(cancelled.endedAt).not.toBeNull();
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await expectMarks(page, {
    Prepare: "done",
    Implement: "stopped",
    Verify: "not-reached",
    Review: "not-reached",
    Merge: "not-reached",
  });
  // The run branch is kept.
  expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${started1.branch}`])).toMatch(
    /^[0-9a-f]{40}$/,
  );

  // Run 2 passes: the stand-in commits, both checks pass and the reviewer finds nothing. A save
  // after run 1 started changed nothing it pinned.
  await withChecks(page, mapId, [PASSING_CHECK, PRINTING_CHECK]);
  expect((await specRun(page, mapId, 1)).checks).toEqual([PASSING_CHECK, SLOW_CHECK]);
  const started2 = await startDelivery(page, "Start again from clean");
  // The branch names the spec by the last 8 characters of its id.
  const { branch } = started2;
  expect(branch).toMatch(new RegExp(`^zenorm/${SPEC_SLUG}-[0-9a-f]{8}-run-2$`));

  const passed = await expectRunState(page, mapId, 2, "passed");
  expect(passed.checks).toEqual([PASSING_CHECK, PRINTING_CHECK]);
  expect(passed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
    [PASSING_CHECK, 0],
    [PRINTING_CHECK, 0],
  ]);
  expect(passed.verdict?.findings).toEqual([]);
  expect(passed.mergedAt).toBeNull();
  expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).toBe(
    passed.finalCommit,
  );
  expect(git(["log", "-1", "--format=%ce", branch])).toBe(`run-${started2.id}@zenorm.invalid`);
  // The stand-in merges each ticket's branch with `--no-ff`, in graph order.
  expect(git(["log", "--merges", "--format=%s", branch]).split("\n")).toEqual([
    `Merge branch '${branch}-t2' into ${branch}`,
    `Merge branch '${branch}-t1' into ${branch}`,
  ]);
  expect(git(["diff", "--name-only", passed.baseCommit, branch]).split("\n")).toEqual(TICKET_FILES);

  async function expectPassedPage(): Promise<void> {
    await expect(runLink(page, 2)).toHaveAttribute("aria-current", "page");
    await expectMarks(page, {
      Prepare: "done",
      Implement: "done",
      Verify: "done",
      Review: "done",
      Merge: "yours",
    });
    await expect(checkResult(page, PASSING_CHECK)).toContainText("passed");
    await expect(checkResult(page, PRINTING_CHECK)).toContainText("passed");
    await expect(startDeliveryForm(page)).toHaveCount(0);
  }
  await expectPassedPage();

  // The printing check's output (the last merge's subject) opens in place.
  const printed = `Merge branch '${branch}-t2'`;
  const printing = checkResult(page, PRINTING_CHECK);
  await expect(printing.getByText(printed)).toBeHidden();
  await printing.getByRole("button").click();
  await expect(printing.getByText(printed)).toBeVisible();

  await page.reload();
  expect((await specRun(page, mapId, 2)).state).toBe("passed");
  expect((await specRun(page, mapId, 1)).state).toBe("cancelled");
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await expectPassedPage();

  // An earlier run opens by `?run=`, with the way back to the latest; a reload keeps it.
  await runLink(page, 1).click();
  await expect(page).toHaveURL(`/maps/${mapId}/delivery?run=1`);
  await expect(runLink(page, 1)).toHaveAttribute("aria-current", "page");
  await expect(runStep(page, "Implement")).toHaveAttribute("data-mark", "stopped");
  await page.reload();
  await expect(runLink(page, 1)).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Open run 2" }).click();
  await expect(page).toHaveURL(`/maps/${mapId}/delivery`);
  await expect(runLink(page, 2)).toHaveAttribute("aria-current", "page");
});

test("a check failing after the executor exits is repaired once, and the run passes", async ({
  page,
}) => {
  // The marker holds the stand-in's repair attempt until the release file exists.
  const mapId = await approvedMap(
    page,
    deliveryRunsRepo(),
    "Deliver the CSV export with a repair [fake:repair-held]",
  );
  await saveChecksAndRepairLimit(page, mapId, [PASSING_CHECK, REPAIRED_CHECK], 2);
  await page.goto(`/maps/${mapId}/delivery`);

  await startDelivery(page, "Start delivery");
  // The attempt: the steps go back to Implement, labelled as a repair of the pinned limit.
  await expect.poll(async () => (await specRun(page, mapId, 1)).repairAttempts).toBe(1);
  const repairing = await specRun(page, mapId, 1);
  expect(repairing).toMatchObject({ state: "running", phase: "implementing", repairLimit: 2 });
  await expect(runStep(page, "Implement")).toHaveAttribute("data-mark", "working");
  await expect(runStep(page, "Implement")).toContainText(
    "Repairing 1 failing check, attempt 1 of 2.",
  );
  const lines = page.getByRole("list", { name: "Lines" });
  await expect(lines.getByText(/Repair attempt 1 of 2:/)).toHaveCount(1);
  writeFileSync(repairReleaseFile(), "");

  const passed = await expectRunState(page, mapId, 1, "passed");
  expect(passed).toMatchObject({ repairLimit: 2, repairAttempts: 1 });
  expect(passed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
    [PASSING_CHECK, 0],
    [REPAIRED_CHECK, 0],
  ]);
  // The repair's commit is on the run branch, after the tickets' merges.
  expect(git(["log", "-1", "--format=%s", passed.branch])).toBe("Repair attempt 1");
  await expect(runStep(page, "Verify")).toContainText("All checks passed after 1 repair attempt.");
  await expect(lines.getByText(/Repair attempt 1 of 2:/)).toHaveCount(1);
  await expect(checkResult(page, REPAIRED_CHECK)).toContainText("passed");
});

test("a failing check fails the run; a blocking finding blocks the next one", async ({ page }) => {
  // The idea's marker rides in the spec's problem to the stand-in reviewer (`fake-claude.ts`).
  const mapId = await approvedMap(
    page,
    deliveryRunsRepo(),
    "Deliver the CSV export with a failing check [fake:review-blocked]",
  );
  await withChecks(page, mapId, [FAILING_CHECK]);

  await startDelivery(page, "Start delivery");
  const failed = await expectRunState(page, mapId, 1, "failed");
  expect(failed.failure?.code).toBe("delivery_checks_failed");
  expect(failed.phase).toBe("verifying");
  expect(failed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
    [FAILING_CHECK, 128],
  ]);
  await expectMarks(page, {
    Prepare: "done",
    Implement: "done",
    Verify: "stopped",
    Review: "not-reached",
    Merge: "not-reached",
  });
  await expect(checkResult(page, FAILING_CHECK)).toContainText("failed");

  // Start again from clean after a failed run.
  await withChecks(page, mapId, [PASSING_CHECK]);
  await startDelivery(page, "Start again from clean");
  const blocked = await expectRunState(page, mapId, 2, "blocked");
  expect(blocked.phase).toBe("reviewing");
  expect(blocked.verdict?.findings).toMatchObject([
    { severity: "blocking", title: "The change misses a criterion", criterion: "1.1" },
  ]);
  await expectMarks(page, {
    Prepare: "done",
    Implement: "done",
    Verify: "done",
    Review: "stopped",
    Merge: "not-reached",
  });
  await expect(checkResult(page, PASSING_CHECK)).toContainText("passed");
  await expect(
    startDeliveryForm(page).getByRole("button", { name: "Start again from clean" }),
  ).toBeVisible();
});

/**
 * App settings that turn screenshots on. The setup and start commands would each leave a tag in
 * the repository, so a run that installs or starts nothing leaves none.
 */
const CAPTURE_ON: AppSettings = {
  appStartCommand: "git tag zenorm-app-started",
  appUrl: "http://localhost:5173",
  appSetupCommands: ["git tag zenorm-setup-ran"],
};
const CAPTURE_OFF: AppSettings = { appStartCommand: null, appUrl: null, appSetupCommands: [] };
const NO_VISIBLE_CHANGE_LINE =
  "The screen picker found no visible change, so the pull request has no screenshots and nothing was installed or started.";
const SETUP_HINT_LINE =
  "This change is visible in the app. Save an app start command and its URL in Project settings to show screenshots of the changed screens in pull requests.";

/** The final commits the stand-in's screen picker was called on, in this worker. */
function screenPickerCalls(): string[] {
  const file = screenPickerCallsFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
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

/**
 * Adds the capture flow's project (its origin on github.com), plans an approved set from `idea`,
 * saves a passing check and `app`, delivers it and waits for the run to pass. Returns the passed
 * run and its activity.
 */
async function passedCaptureRun(
  page: Page,
  flow: CaptureFlow,
  idea: string,
  app: AppSettings,
): Promise<{ passed: SpecRun; texts: string[] }> {
  await addProject(page, captureRepo(flow));
  const mapId = await approvedMap(page, captureRepo(flow), idea);
  await saveChecksAndAppSettings(page, mapId, [PASSING_CHECK], app);
  await page.goto(`/maps/${mapId}/delivery`);
  await startDelivery(page, "Start delivery");
  const passed = await expectRunState(page, mapId, 1, "passed");
  expect(passed.phase).toBe("publishing");
  expect(passed.failure).toBeNull();
  expect(passed.pullRequest?.url).toMatch(/^https:\/\/github\.com\/acme\/screens\/pull\/\d+$/);
  return { passed, texts: await deliveryActivityTexts(page, passed.id) };
}

test("capture on: no visible change says so, installs and starts nothing, and the pull request opens", async ({
  page,
}) => {
  const { passed, texts } = await passedCaptureRun(
    page,
    "capture-none",
    "Deliver the CSV export behind the scenes",
    CAPTURE_ON,
  );

  expect(captureLines(texts)).toEqual([NO_VISIBLE_CHANGE_LINE]);
  expect(screenPickerCalls()).toContain(passed.finalCommit);
  expect(gitIn(captureRepo("capture-none"), ["tag", "--list"])).toBe("");
  expect(pullRequestBody(passed.branch)).toContain("## Why");
});

test("capture on: the screens the picker lists are named, and the pull request opens", async ({
  page,
}) => {
  const { passed, texts } = await passedCaptureRun(
    page,
    "capture-screens",
    "Deliver the CSV export page [fake:screens]",
    CAPTURE_ON,
  );

  expect(captureLines(texts)).toEqual([
    "The screen picker picked 2 changed screens: /export (new), /projects.",
  ]);
  expect(screenPickerCalls()).toContain(passed.finalCommit);
});

test("capture off: no picker runs, and a visible change adds the setup hint with the body unchanged", async ({
  page,
}) => {
  const { passed, texts } = await passedCaptureRun(
    page,
    "capture-off",
    "Deliver the CSV export button [fake:visible-change]",
    CAPTURE_OFF,
  );

  expect(captureLines(texts)).toEqual([SETUP_HINT_LINE]);
  expect(screenPickerCalls()).not.toContain(passed.finalCommit);
  // The stand-in writer's body, with ZeNorm's footer and nothing else added.
  const body = pullRequestBody(passed.branch);
  if (passed.finalCommit === null) throw new Error("a passed run has a final commit");
  expect(body.startsWith("## Why\n")).toBe(true);
  expect(body).toContain(`at ${passed.finalCommit.slice(0, 7)}`);
  expect(body.endsWith(PULL_REQUEST_FOOTER)).toBe(true);
  expect(body).not.toContain("Project settings");
});
