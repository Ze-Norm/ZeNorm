import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";
import { DeliveryRun } from "@zenorm/contracts";
import type { SpecRun } from "@zenorm/contracts";

import {
  deliveryClosingReleaseFile,
  deliveryReleaseFile,
  deliveryRepo,
  pullRequestUrl,
  pushTargetRepo,
  reportPullRequestMerged,
} from "./fixture.ts";
import type { DeliveryFlow } from "./fixture.ts";
import {
  addProject,
  approvedMap,
  checkPullRequestNow,
  expectQuietRow,
  inboxGroup,
  mapOverview,
  mapRowLink,
  nextCard,
  projectBlockers,
  pullRequestStatus,
  runStep,
  setChecksInSettings,
  startDeliveryForm,
} from "./flows.ts";
import type { RepairSettings } from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * Slice 8's delivery flows (ticket 10). Each adds its own fixture project and sets its required
 * checks on the Project settings page, so the one-active-run-per-project rule never couples them.
 * The delivery markers ride in the idea to the stand-in (`fake-claude.ts`). Run states and codes
 * are read from `map.overview`, the one read every page shares (S8-14).
 */
const PASSING_CHECK = "git status --short";
/** A fix command as a person saves one; T1 only stores it, no session runs it yet. */
const FIX_COMMAND = "git diff --stat";

// Each scenario adds its own project and map, so they run at once on different workers.
test.describe.configure({ mode: "parallel" });

function git(flow: DeliveryFlow, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=e2e",
      "-c",
      "user.email=e2e@example.invalid",
      "-C",
      deliveryRepo(flow),
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

/** The worktrees git lists for the flow's repository: the project folder plus any of a run. */
function worktrees(flow: DeliveryFlow): string[] {
  return git(flow, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
}

/** The branches named `<run branch>-t*`: the tickets' own. */
function ticketBranches(flow: DeliveryFlow, branch: string): string {
  return git(flow, ["branch", "--list", `${branch}-t*`]);
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

/** The shown run's ticket row for `ticket`; its `data-state` is the ticket's status. */
function ticketRow(page: Page, ticket: string): Locator {
  return page.getByRole("list", { name: "Tickets" }).locator(`li[data-ticket="${ticket}"]`);
}

/** Run activity of run `number`, in the Activity column's place. */
function runActivity(page: Page, number: number): Locator {
  return page.getByRole("complementary", { name: `Run ${String(number)} activity` });
}

/** The repair settings a flow saves unless it says otherwise: no repair, no fix commands. */
const NO_REPAIR: RepairSettings = { repairLimit: 0, fixCommands: [] };

/**
 * Adds the flow's project, checks that a project with no required checks and no repair limit
 * cannot start delivery, plans an approved ticket set from `idea`, then saves `checks` and
 * `repair` on the Project settings page and reopens the map's Delivery page. Returns the map's id.
 */
async function readyMap(
  page: Page,
  flow: DeliveryFlow,
  idea: string,
  checks: readonly string[],
  repair: RepairSettings,
): Promise<string> {
  const projectId = await addProject(page, deliveryRepo(flow));
  const blockers = projectBlockers(page);
  await expect(blockers).toHaveCount(2);
  await expect(blockers.nth(0)).toHaveAttribute("data-code", "project_checks_missing");
  await expect(blockers.nth(1)).toHaveAttribute("data-code", "project_repair_limit_missing");
  const mapId = await approvedMap(page, deliveryRepo(flow), idea);
  // The Delivery card: Start delivery is unavailable, with the reasons and the link to Project
  // settings, and no start form until checks and a repair limit are saved (UX audit D1).
  await expect(nextCard(page)).toHaveAttribute("data-who", "nobody");
  await expect(startDeliveryForm(page)).toHaveCount(0);
  const reasons = nextCard(page).getByRole("list", { name: "Why Start delivery is unavailable" });
  await expect(reasons.getByRole("listitem")).toHaveCount(2);
  await expect(reasons.getByRole("listitem").nth(0)).toHaveAttribute(
    "data-code",
    "project_checks_missing",
  );
  await expect(reasons.getByRole("listitem").nth(1)).toHaveAttribute(
    "data-code",
    "project_repair_limit_missing",
  );
  await setChecksInSettings(page, projectId, checks, repair);
  await page.goto(`/maps/${mapId}/delivery`);
  return mapId;
}

/** Clicks the card's start button; returns the run as `delivery.start` answered. */
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

/** Holds the stand-in's `[fake:delivery-held]` orchestrator: the release file must be absent. */
function holdDeliveries(): void {
  rmSync(deliveryReleaseFile(), { force: true });
}

// A failed flow releases its held stand-in at once rather than leaving it up to 60 s (L197 N-Spec-6).
test.afterEach(() => {
  writeFileSync(deliveryReleaseFile(), "");
  writeFileSync(deliveryClosingReleaseFile(), "");
});

test("cancel ends a held run: its worktrees and ticket branches are gone, its branch kept", async ({
  page,
}) => {
  holdDeliveries();
  const mapId = await readyMap(
    page,
    "cancel",
    "Cancel a held delivery [fake:delivery-held]",
    [PASSING_CHECK],
    NO_REPAIR,
  );
  const run = await startDelivery(page, "Start delivery");
  await expect(ticketRow(page, "T1")).toHaveAttribute("data-state", "merged");
  await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "implementing");
  // While it holds, the run and both ticket worktrees and branches exist.
  expect(worktrees("cancel")).toHaveLength(4);
  expect(ticketBranches("cancel", run.branch).split("\n")).toHaveLength(2);

  await page.getByRole("button", { name: "Cancel run" }).click();
  await expectRunState(page, mapId, 1, "cancelled");
  await expect.poll(() => worktrees("cancel")).toHaveLength(1);
  // The cleanup deletes the ticket branches after it removes the worktrees and prunes (D8).
  await expect.poll(() => ticketBranches("cancel", run.branch)).toBe("");
  expect(git("cancel", ["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`])).toMatch(
    /^[0-9a-f]{40}$/,
  );
  await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "not_delivered");
  await expect(runStep(page, "Implement")).toHaveAttribute("data-mark", "stopped");

  await page.reload();
  await expect(ticketRow(page, "T1")).toHaveAttribute("data-state", "merged");
  await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "not_delivered");
  await expect(runStep(page, "Implement")).toHaveAttribute("data-mark", "stopped");
  await expect(
    startDeliveryForm(page).getByRole("button", { name: "Start again from clean" }),
  ).toBeVisible();
});

test("a held run shows its tickets and activity, passes once released, then is marked merged", async ({
  page,
}) => {
  holdDeliveries();
  // The person saves a repair limit and a fix command beside the checks, then starts delivery.
  const mapId = await readyMap(
    page,
    "held",
    "Deliver a held run [fake:delivery-held]",
    [PASSING_CHECK],
    { repairLimit: 2, fixCommands: [FIX_COMMAND] },
  );
  // A reload of the settings page keeps the saved checks, repair limit and fix command.
  const { project } = await mapOverview(page, mapId);
  expect(project).toMatchObject({
    repairLimit: 2,
    fixCommands: [FIX_COMMAND],
    startDeliveryBlockers: [],
  });
  await page.goto(`/projects/${project.id}/settings`);
  await page.reload();
  await expect(page.getByRole("button", { name: `Remove ${PASSING_CHECK}` })).toBeVisible();
  await expect(page.getByLabel("Repair limit")).toHaveValue("2");
  await expect(
    page.getByRole("button", { name: `Remove fix command ${FIX_COMMAND}` }),
  ).toBeVisible();
  // A check that needs a shell is refused by Save settings (L197 item 9).
  await page.getByLabel("Required checks").fill("pnpm lint && pnpm test");
  await page.getByRole("button", { name: "Add check" }).click();
  await expect(
    page.getByText("“pnpm lint && pnpm test” needs a shell.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove pnpm lint && pnpm test" })).toHaveCount(0);
  // So is a fix command that needs one, its refusal under the fix commands field.
  const fixField = page.getByLabel("Fix commands");
  await fixField.fill("pnpm format | tee log");
  await page.getByRole("button", { name: "Add fix command" }).click();
  await expect(fixField).toHaveAccessibleDescription(/“pnpm format \| tee log” needs a shell\./);
  await expect(page.getByLabel("Required checks")).not.toHaveAttribute("aria-describedby");
  await expect(
    page.getByRole("button", { name: "Remove fix command pnpm format | tee log" }),
  ).toHaveCount(0);
  await page.goto(`/maps/${mapId}/delivery`);

  const run = await startDelivery(page, "Start delivery");
  expect(run.checks).toEqual([PASSING_CHECK]);

  // Held after T1 is merged and T2 started: the rows, and Run activity's lines and liveness.
  async function expectHeldRun(): Promise<void> {
    await expect(ticketRow(page, "T1")).toHaveAttribute("data-state", "merged");
    await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "implementing");
    const activity = runActivity(page, 1);
    await expect(activity.getByTestId("run-liveness")).toBeVisible();
    const lines = activity.getByRole("list", { name: "Lines" });
    await expect(lines.locator('li[data-who="orchestrator"]').first()).toBeVisible();
    // Implementer lines stay on their ticket's page, out of the run's activity.
    await expect(lines.locator('li[data-who="implementer"]')).toHaveCount(0);
  }
  await expectHeldRun();
  await expect(runStep(page, "Implement")).toHaveAttribute("data-mark", "working");
  await page.reload();
  await expectHeldRun();

  // T2's execution page, in the run it is shown in.
  await ticketRow(page, "T2").getByRole("link").click();
  await expect(page).toHaveURL(`/maps/${mapId}/delivery/1/T2?run=1`);
  const result = page.getByRole("region", { name: "Result" });
  await expect(result).toBeVisible();
  await expect(page.getByText("implementing", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "What the implementer did" })).toBeVisible();
  await expect(runActivity(page, 1).getByTestId("run-liveness")).toBeVisible();
  await page.reload();
  await expect(page.getByText("implementing", { exact: true })).toBeVisible();

  // Released, the run passes: its ticket worktrees and branches are gone, its branch kept.
  writeFileSync(deliveryReleaseFile(), "");
  const passed = await expectRunState(page, mapId, 1, "passed");
  rmSync(deliveryReleaseFile());
  await expect(page.getByText("implemented", { exact: true })).toBeVisible();
  await expect.poll(() => worktrees("held")).toHaveLength(1);
  await expect.poll(() => ticketBranches("held", run.branch)).toBe("");
  expect(git("held", ["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`])).toBe(
    passed.finalCommit,
  );

  // A passed, unmerged run waits on you: Mark merged.
  await page.goto("/");
  await expect(mapRowLink(inboxGroup(page, "Needs you"), mapId)).toBeVisible();
  await page.goto(`/maps/${mapId}/delivery`);
  await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "merged");
  await expect(runStep(page, "Merge")).toHaveAttribute("data-mark", "yours");
  const markMerged = nextCard(page).getByRole("button", { name: "Mark merged" });

  // Refused until the final commit is in the base branch.
  await markMerged.click();
  const refusal = page.getByRole("alert").getByText("delivery_not_merged", { exact: true });
  await expect(refusal).toBeVisible();
  // It stays until the person acts again, through the refetch any change on the instance causes.
  const { project: held } = await mapOverview(page, mapId);
  const saved = await page.request.post("/rpc/project/saveSettings", {
    data: {
      json: {
        projectId: held.id,
        baseBranch: held.baseBranch,
        requiredChecks: held.requiredChecks,
        repairLimit: held.repairLimit,
        fixCommands: held.fixCommands,
      },
      meta: [],
    },
  });
  expect(saved.ok()).toBe(true);
  await page.waitForTimeout(2000);
  await expect(refusal).toBeVisible();
  expect((await specRun(page, mapId, 1)).mergedAt).toBeNull();

  git("held", ["merge", "--no-ff", "-q", "-m", `Merge ${run.branch}`, run.branch]);
  await markMerged.click();
  await expect.poll(async () => (await specRun(page, mapId, 1)).mergedAt).not.toBeNull();
  await expect(runStep(page, "Merge")).toHaveAttribute("data-mark", "done");
  await expect(markMerged).toHaveCount(0);
  await page.reload();
  await expect(runStep(page, "Merge")).toHaveAttribute("data-mark", "done");
  await expect(markMerged).toHaveCount(0);

  // Merged, the map is quiet and leaves Needs you. The quiet row first, so the Inbox has loaded;
  // the Needs you group may be absent, with no other map on this worker's server needing you.
  await page.goto("/");
  await expectQuietRow(page, (quiet) => mapRowLink(quiet, mapId));
  await expect(mapRowLink(inboxGroup(page, "Needs you"), mapId)).toHaveCount(0);
});

test("a blocked run shows its findings before Start again from clean, which starts run 2", async ({
  page,
}) => {
  const mapId = await readyMap(
    page,
    "blocked",
    "Deliver a blocked run [fake:review-blocked]",
    [PASSING_CHECK],
    NO_REPAIR,
  );
  await startDelivery(page, "Start delivery");
  const blocked = await expectRunState(page, mapId, 1, "blocked");
  expect(blocked.verdict?.findings.map((finding) => finding.criterion)).toEqual(["1.1"]);

  // The finding names T1's criterion and its carrier, above the card.
  async function expectVerdictFirst(): Promise<void> {
    const finding = page.getByRole("article", { name: "The change misses a criterion" });
    await expect(finding).toContainText("1.1");
    await expect(finding).toContainText("T1");
    const again = startDeliveryForm(page).getByRole("button", { name: "Start again from clean" });
    await expect(again).toBeVisible();
    const findingBox = await finding.boundingBox();
    const cardBox = await again.boundingBox();
    if (findingBox === null || cardBox === null) {
      throw new Error("The finding or the card is not laid out");
    }
    expect(findingBox.y).toBeLessThan(cardBox.y);
    await expect(ticketRow(page, "T1")).toHaveAttribute("data-state", "merged");
  }
  await expectVerdictFirst();
  await page.reload();
  await expectVerdictFirst();

  // T1's page shows it fails the criterion and what the review found.
  await ticketRow(page, "T1").getByRole("link").click();
  await expect(page).toHaveURL(`/maps/${mapId}/delivery/1/T1?run=1`);
  await expect(page.getByText("fails 1.1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "What the independent review found" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("fails 1.1", { exact: true })).toBeVisible();

  // Start again from clean starts run 2 (the marker blocks it too).
  await page.goto(`/maps/${mapId}/delivery`);
  const second = await startDelivery(page, "Start again from clean");
  expect(second.number).toBe(2);
  await expectRunState(page, mapId, 2, "blocked");
});

test("a passing run on a GitHub project shows its pull request on Delivery, then reads merged after Check now (5.2)", async ({
  page,
}) => {
  const mapId = await readyMap(
    page,
    "pull-request",
    "Deliver through a pull request",
    [PASSING_CHECK],
    NO_REPAIR,
  );
  const run = await startDelivery(page, "Start delivery");
  const passed = await expectRunState(page, mapId, 1, "passed");
  expect(passed.pullRequest).toEqual({ number: 1, url: pullRequestUrl(1), state: "open" });
  expect(passed.phase).toBe("publishing");
  // The run branch was pushed to origin.
  expect(
    execFileSync("git", ["-C", pushTargetRepo(), "rev-parse", run.branch], {
      encoding: "utf8",
    }).trim(),
  ).toBe(passed.finalCommit);

  // The card links the pull request in place of Mark merged; the Merge step shows it open.
  async function expectOpen(): Promise<void> {
    await expect(
      nextCard(page).getByRole("link", { name: "Open pull request #1" }),
    ).toHaveAttribute("href", pullRequestUrl(1));
    await expect(nextCard(page).getByRole("button", { name: "Mark merged" })).toHaveCount(0);
    await expect(runStep(page, "Merge")).toHaveAttribute("data-mark", "yours");
    await expect(pullRequestStatus(page)).toHaveAttribute("data-state", "open");
  }
  await expectOpen();

  // Check now while it is still open on GitHub changes nothing.
  const open = await checkPullRequestNow(page);
  expect(open).toMatchObject({ mergedAt: null, pullRequest: { state: "open" } });
  await page.reload();
  await expectOpen();

  // Merged on GitHub (by a squash: main never gets the final commit), Check now records it.
  reportPullRequestMerged(1);
  const merged = await checkPullRequestNow(page);
  expect(merged.mergedAt).not.toBeNull();
  expect(merged.pullRequest).toMatchObject({ number: 1, state: "merged" });
  async function expectMerged(): Promise<void> {
    await expect(runStep(page, "Merge")).toHaveAttribute("data-mark", "done");
    await expect(pullRequestStatus(page)).toHaveAttribute("data-state", "merged");
    await expect(nextCard(page).getByRole("button", { name: "Check now" })).toHaveCount(0);
  }
  await expectMerged();
  await page.reload();
  await expectMerged();
  expect((await specRun(page, mapId, 1)).mergedAt).toBe(merged.mergedAt);
});

test("Implement's last row shows the agent's review and checks running, then done", async ({
  page,
}) => {
  rmSync(deliveryClosingReleaseFile(), { force: true });
  const mapId = await readyMap(
    page,
    "closing",
    "Deliver a run held in its closing [fake:delivery-closing-held]",
    [PASSING_CHECK],
    NO_REPAIR,
  );
  await startDelivery(page, "Start delivery");
  await expect(ticketRow(page, "T1")).toHaveAttribute("data-state", "merged");
  await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "merged");
  const implement = runStep(page, "Implement");
  await expect(implement).toHaveAttribute("data-mark", "working");
  const closing = implement.getByRole("group", { name: "Review and checks" });
  await expect(closing).toHaveAttribute("data-mark", "running");
  await expect(closing).toContainText(
    "The agent is reviewing the branch against the spec and running the 1 required check.",
  );
  await expect(runStep(page, "Verify")).toHaveAttribute("data-mark", "not-reached");

  writeFileSync(deliveryClosingReleaseFile(), "");
  await expectRunState(page, mapId, 1, "passed");
  await expect(closing).toHaveAttribute("data-mark", "done");
  await expect(closing).toContainText(
    "The agent reviewed the branch and ran the 1 required check.",
  );
});

test("a ticket the orchestrator never merged fails the run delivery_ticket_unmerged", async ({
  page,
}) => {
  const mapId = await readyMap(
    page,
    "unmerged",
    "Deliver an unmerged ticket [fake:ticket-unmerged]",
    [PASSING_CHECK],
    NO_REPAIR,
  );
  const run = await startDelivery(page, "Start delivery");
  const failed = await expectRunState(page, mapId, 1, "failed");
  expect(failed.failure?.code).toBe("delivery_ticket_unmerged");
  expect(failed.phase).toBe("verifying");
  expect(failed.checkResults).toBeNull();
  await page.reload();
  await expect(ticketRow(page, "T1")).toHaveAttribute("data-state", "merged");
  await expect(ticketRow(page, "T2")).toHaveAttribute("data-state", "not_delivered");
  await expect(runStep(page, "Verify")).toHaveAttribute("data-mark", "stopped");
  await expect.poll(() => worktrees("unmerged")).toHaveLength(1);
  await expect.poll(() => ticketBranches("unmerged", run.branch)).toBe("");
});
