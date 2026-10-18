import { execFileSync } from "node:child_process";

import { expect } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { DeliveryRun, MapOverviewDetail, Project, ProjectDetail } from "@zenorm/contracts";
import type { SpecRun } from "@zenorm/contracts";

/**
 * Steps the flows share, through the app's navigation: roles, accessible names and
 * `/maps/<id>/<stage>` URLs. Each returns once the page shows the step's result.
 */

export type StageSegment = "idea" | "wayfinding" | "spec" | "tickets" | "delivery";

/** Map creation opens Idea. */
export const MAP_URL = /\/maps\/([0-9a-f-]+)\/idea$/;
export const PROJECT_URL = /\/projects\/([0-9a-f-]+)$/;

export function addProjectDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Add project" });
}

export async function openAddProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Project switcher" }).click();
  await page.getByRole("menuitem", { name: "Add project…" }).click();
  await expect(addProjectDialog(page)).toBeVisible();
}

export async function checkFolder(page: Page, folderPath: string): Promise<void> {
  const dialog = addProjectDialog(page);
  await dialog.getByLabel("Folder").fill(folderPath);
  await dialog.getByRole("button", { name: "Check" }).click();
}

/** Adds the repository at `folderPath` with its detected branch; returns the project's id. */
export async function addProject(page: Page, folderPath: string): Promise<string> {
  await page.goto("/");
  await openAddProject(page);
  await checkFolder(page, folderPath);
  const dialog = addProjectDialog(page);
  await expect(dialog.getByLabel("Base branch · detected, confirm it")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(PROJECT_URL);
  return idFrom(PROJECT_URL, page.url());
}

/** The folders `addProjectInNewPage` added in this worker process, to its one server. */
const addedInWorker = new Set<string>();

/**
 * Adds the repository at `folderPath` as a project from a page of its own, for a file's
 * `beforeAll` whose scenarios each start a map in that one project. Once per worker: in a file
 * that runs in parallel, Playwright runs `beforeAll` again for each batch of tests a worker takes,
 * on the same server, which has the project already.
 */
export async function addProjectInNewPage(browser: Browser, folderPath: string): Promise<void> {
  if (addedInWorker.has(folderPath)) return;
  const page = await browser.newPage();
  await addProject(page, folderPath);
  await page.close();
  addedInWorker.add(folderPath);
}

export function idFrom(pattern: RegExp, url: string): string {
  const id = pattern.exec(url)?.[1];
  if (id === undefined) {
    throw new Error(`No id in ${url}`);
  }
  return id;
}

/** The Inbox composer. */
export function composer(page: Page): Locator {
  return page.getByRole("region", { name: "New map" });
}

/** Starts a map from the Inbox composer in the project at `folderPath`; returns the map's id. */
export async function startMap(page: Page, folderPath: string, idea: string): Promise<string> {
  await page.goto("/");
  const newMap = composer(page);
  await newMap.getByLabel("Idea").fill(idea);
  await newMap.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option").filter({ hasText: folderPath }).click();
  await newMap.getByRole("button", { name: "Start map" }).click();
  await expect(page).toHaveURL(MAP_URL);
  return idFrom(MAP_URL, page.url());
}

/** The stage rail; its links are found by `href`, the viewed one by `aria-current="page"`. */
export function rail(page: Page): Locator {
  return page.getByRole("navigation", { name: "Stages" });
}

export async function openStage(page: Page, mapId: string, stage: StageSegment): Promise<void> {
  await rail(page).locator(`a[href="/maps/${mapId}/${stage}"]`).click();
  await expect(page).toHaveURL(`/maps/${mapId}/${stage}`);
}

/** The open round on a Wayfinding page. */
export function questionRound(page: Page): Locator {
  return page.getByRole("form", { name: "Question round" });
}

/** Wayfinding's index of waypoints. */
export function waypointIndex(page: Page): Locator {
  return page.getByRole("navigation", { name: "Waypoints" });
}

/** The eyebrow of round `round` on waypoint `waypoint`, or on the destination. */
export function roundEyebrow(page: Page, round: number, waypoint: number | "destination"): Locator {
  const of = waypoint === "destination" ? "destination" : `waypoint ${String(waypoint)}`;
  return page.getByText(`Question round ${String(round)} · ${of}`, { exact: true });
}

/** Fills every unanswered question with its recommendation and sends the open round. */
export async function acceptAndSend(page: Page): Promise<void> {
  const round = questionRound(page);
  await round.getByRole("button", { name: "Accept the recommendations for the rest" }).click();
  await round.getByRole("button", { name: "Send answers" }).click();
}

/**
 * Opens the destination round from Wayfinding's next-action card once the agent has asked it, and
 * answers it with the recommendations, confirming the destination.
 */
export async function confirmDestination(page: Page, mapId: string): Promise<void> {
  await page.goto(`/maps/${mapId}/wayfinding`);
  await nextCard(page).getByRole("link", { name: "Answer" }).click();
  await expect(page).toHaveURL(`/maps/${mapId}/wayfinding/destination`);
  await expect(roundEyebrow(page, 1, "destination")).toBeVisible();
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 1, "destination")).toHaveCount(0);
}

/** Opens waypoint `number` from Wayfinding's index (its link, under any group, by `href`). */
export async function openWaypoint(page: Page, mapId: string, number: number): Promise<void> {
  const href = `/maps/${mapId}/wayfinding/${String(number)}`;
  await page.goto(`/maps/${mapId}/wayfinding`);
  await waypointIndex(page).locator(`a[href="${href}"]`).first().click();
  await expect(page).toHaveURL(href);
}

/** Answers round `round` of waypoint `number` with the recommendations, once the agent asks it. */
export async function acceptWaypointRound(
  page: Page,
  mapId: string,
  number: number,
  round: number,
): Promise<void> {
  await openWaypoint(page, mapId, number);
  await expect(roundEyebrow(page, round, number)).toBeVisible();
  await acceptAndSend(page);
  await expect(roundEyebrow(page, round, number)).toHaveCount(0);
}

/**
 * Starts a map in the project at `folderPath` and answers every round of the default chart with
 * the recommendations: the destination, waypoint 1's two rounds, then waypoints 2 and 3, so the
 * map clears. Returns the map's id; what the spec stage shows next is the caller's to assert.
 */
export async function answerMap(page: Page, folderPath: string, idea: string): Promise<string> {
  const mapId = await startMap(page, folderPath, idea);
  await confirmDestination(page, mapId);
  await acceptWaypointRound(page, mapId, 1, 1);
  await acceptWaypointRound(page, mapId, 1, 2);
  await acceptWaypointRound(page, mapId, 2, 1);
  await acceptWaypointRound(page, mapId, 3, 1);
  return mapId;
}

/**
 * Starts a map in the project at `folderPath` and answers every round with the recommendations:
 * the destination, waypoint 1's two rounds, then waypoints 2 and 3, until the map clears and the
 * agent drafts the spec. Ends on the Spec page with the draft shown. Returns the map's id.
 */
export async function chartAndClearMap(
  page: Page,
  folderPath: string,
  idea: string,
): Promise<string> {
  const mapId = await answerMap(page, folderPath, idea);
  await page.goto(`/maps/${mapId}/spec`);
  await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toBeVisible();
  return mapId;
}

/** The Spec page's Revisions list beside the page head. */
export function revisionList(page: Page): Locator {
  return page.getByRole("navigation", { name: "Revisions" });
}

/** The spec's approval button: "Approve the revision" past r1. */
export const APPROVE_SPEC = /^Approve the (spec|revision)$/;

/** The stage's next-action card. */
export function nextCard(page: Page): Locator {
  return page.getByRole("region", { name: "Next" });
}

/** Approves the latest spec revision once it is written, on the Spec page (past r1, "the revision"). */
export async function approveSpec(page: Page): Promise<void> {
  const approve = nextCard(page).getByRole("button", { name: APPROVE_SPEC });
  await approve.click();
  await expect(approve).toHaveCount(0);
}

/**
 * Approves the latest ticket set on the Tickets page once its tickets review passed: the
 * button renders only then, and the click waits for it while the page polls.
 */
export async function approveTicketSet(page: Page): Promise<void> {
  const approve = nextCard(page).getByRole("button", { name: "Approve the tickets" });
  await approve.click();
  await expect(approve).toHaveCount(0);
}

/**
 * Charts and clears a map in the project at `folderPath`, then approves its spec and its ticket
 * set; ends on the Delivery page. Returns the map's id.
 */
export async function approvedMap(page: Page, folderPath: string, idea: string): Promise<string> {
  const mapId = await chartAndClearMap(page, folderPath, idea);
  await approveSpec(page);
  await openStage(page, mapId, "tickets");
  await approveTicketSet(page);
  await openStage(page, mapId, "delivery");
  return mapId;
}

/** Calls an oRPC procedure over `/rpc/<path>` and returns its answer's JSON; a refusal fails. */
async function rpc(page: Page, path: string, input: unknown): Promise<unknown> {
  const response = await page.request.post(`/rpc/${path}`, { data: { json: input, meta: [] } });
  const body: unknown = await response.json();
  if (!response.ok() || typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`/rpc/${path} answered ${String(response.status())}: ${JSON.stringify(body)}`);
  }
  return body.json;
}

/** The map's one read, `map.overview`, as the API answers it. */
export async function mapOverview(page: Page, mapId: string): Promise<MapOverviewDetail> {
  return MapOverviewDetail.parse(await rpc(page, "map/overview", { mapId }));
}

/** The repair limit `saveChecks` saves: 0, no repair, so a failing check ends the run. */
const SAVED_REPAIR_LIMIT = 0;

/**
 * Saves the required checks of the map's project through `project.saveSettings`, keeping its base
 * branch, with the repair limit `SAVED_REPAIR_LIMIT` and no fix commands: a
 * project needs a saved repair limit before it can start delivery. Returns the saved project.
 */
export async function saveChecks(
  page: Page,
  mapId: string,
  checks: readonly string[],
): Promise<Project> {
  return await saveChecksAndRepairLimit(page, mapId, checks, SAVED_REPAIR_LIMIT);
}

/**
 * `saveChecks` with the repair limit `repairLimit`: a failing check goes back to the executor up to
 * that many times. Returns the saved project.
 */
export async function saveChecksAndRepairLimit(
  page: Page,
  mapId: string,
  checks: readonly string[],
  repairLimit: number,
): Promise<Project> {
  const { project } = await mapOverview(page, mapId);
  return Project.parse(
    await rpc(page, "project/saveSettings", {
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: checks,
      repairLimit,
      fixCommands: [],
      appStartCommand: null,
      appUrl: null,
      appSetupCommands: [],
    }),
  );
}

/** The Delivery page's card form "Start delivery". */
export function startDeliveryForm(page: Page): Locator {
  return page.getByRole("form", { name: "Start delivery" });
}

/** One step of "The run, step by step"; its mark is its `data-mark`. */
export function runStep(
  page: Page,
  name: "Prepare" | "Implement" | "Verify" | "Review" | "Merge",
): Locator {
  return page.getByRole("region", { name, exact: true });
}

/** The Merge step's pull request, its link and state; the state is its `data-state`. */
export function pullRequestStatus(page: Page): Locator {
  return runStep(page, "Merge").getByRole("group", { name: "Pull request" });
}

/**
 * Clicks the Delivery card's **Check now**; returns the run as `delivery.checkPullRequest`
 * answered it.
 */
export async function checkPullRequestNow(page: Page): Promise<DeliveryRun> {
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/rpc/delivery/checkPullRequest"),
  );
  await nextCard(page).getByRole("button", { name: "Check now" }).click();
  const answer = await response;
  const body: unknown = await answer.json();
  if (!answer.ok() || typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`delivery.checkPullRequest answered ${JSON.stringify(body)}`);
  }
  return DeliveryRun.parse(body.json);
}

/** The Inbox group of maps named `group`. */
export function inboxGroup(page: Page, group: "Needs you" | "Agent is working" | "Quiet"): Locator {
  return page.getByRole("region", { name: group, exact: true });
}

/** How long one attempt of `expectQuietRow` waits for the row before checking the fold again. */
const QUIET_ROW_ATTEMPT_MS = 1000;

/**
 * Expects `row` within the Inbox's quiet group to be shown: a small group is inline;
 * a long tail behind the active groups folds to one line, opened with **Show all**.
 * Spec files run at once on one server, so another file's map can fold the group at any moment;
 * each attempt opens the fold if it is there, until the row shows (`expect.toPass` in the config).
 */
export async function expectQuietRow(page: Page, row: (quiet: Locator) => Locator): Promise<void> {
  const quiet = inboxGroup(page, "Quiet");
  await expect(async () => {
    const showAll = quiet.getByRole("button", { name: "Show all" });
    if ((await showAll.count()) > 0) {
      await showAll.click();
    }
    await expect(row(quiet)).toBeVisible({ timeout: QUIET_ROW_ATTEMPT_MS });
  }).toPass();
}

/**
 * The project page's "Start delivery is unavailable" card's blockers, one `li[data-code]` per
 * blocker in core's order, the same card a map's Delivery shows.
 */
export function projectBlockers(page: Page): Locator {
  return page
    .getByRole("region", { name: "Start delivery is unavailable" })
    .getByRole("list", { name: "Why Start delivery is unavailable" })
    .getByRole("listitem");
}

/** A map's row link in a list of map rows: its name links its first next action's stage. */
export function mapRowLink(list: Locator, mapId: string): Locator {
  return list.locator(`a[href^="/maps/${mapId}/"]`).first();
}

/** A project's repair settings as a person enters them on its Project settings page. */
export interface RepairSettings {
  readonly repairLimit: number;
  readonly fixCommands: readonly string[];
}

/**
 * Sets the required checks, the repair limit and the fix commands of a project that has none
 * through its Project settings page: opened from the project page's Settings button,
 * each check and fix command added, the limit typed, then saved. Returns once the page shows the
 * save.
 */
export async function setChecksInSettings(
  page: Page,
  projectId: string,
  checks: readonly string[],
  repair: RepairSettings,
): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(`/projects/${projectId}/settings`);
  for (const check of checks) {
    await page.getByLabel("Required checks").fill(check);
    await page.getByRole("button", { name: "Add check" }).click();
    await expect(page.getByRole("button", { name: `Remove ${check}` })).toBeVisible();
  }
  await page.getByLabel("Repair limit").fill(String(repair.repairLimit));
  for (const command of repair.fixCommands) {
    await page.getByLabel("Fix commands").fill(command);
    await page.getByRole("button", { name: "Add fix command" }).click();
    await expect(page.getByRole("button", { name: `Remove fix command ${command}` })).toBeVisible();
  }
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
}

/** The project's one read, `project.get`, as the API answers it. */
export async function projectDetail(page: Page, projectId: string): Promise<ProjectDetail> {
  return ProjectDetail.parse(await rpc(page, "project/get", { projectId }));
}

/** Runs git in `repo` under the e2e identity; returns its trimmed output. */
export function gitIn(repo: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-C", repo, ...args],
    { encoding: "utf8" },
  ).trim();
}

/** Spec `specNumber`'s run numbered `number` on the map, as `map.overview` reports it. */
export async function specRun(
  page: Page,
  mapId: string,
  number: number,
  specNumber: number,
): Promise<SpecRun> {
  const { specs } = await mapOverview(page, mapId);
  const spec = specs.find((candidate) => candidate.number === specNumber);
  const run = spec?.runs.find((candidate) => candidate.number === number);
  if (run === undefined) {
    throw new Error(`Map ${mapId} has no run ${String(number)} of spec ${String(specNumber)}`);
  }
  return run;
}

/** Clicks the Delivery card's Start delivery; returns the run as `delivery.start` answered. */
export async function startDelivery(page: Page): Promise<DeliveryRun> {
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/rpc/delivery/start"),
  );
  await startDeliveryForm(page).getByRole("button", { name: "Start delivery" }).click();
  const body: unknown = await (await response).json();
  if (typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`delivery.start answered ${JSON.stringify(body)}`);
  }
  return DeliveryRun.parse(body.json);
}

/**
 * From the map's Delivery page with an approved set: starts delivery, waits for the run to pass,
 * merges its branch into `main` of `repo` with a real `git merge` and clicks **Mark merged**
 * (as `completion.spec.ts`'s held flow does). Returns the merged run.
 */
export async function deliverAndMarkMerged(
  page: Page,
  mapId: string,
  repo: string,
): Promise<SpecRun> {
  await page.goto(`/maps/${mapId}/delivery`);
  const run = await startDelivery(page);
  await expect.poll(async () => (await specRun(page, mapId, run.number, 1)).state).toBe("passed");
  gitIn(repo, ["merge", "--no-ff", "-q", "-m", `Merge ${run.branch}`, run.branch]);
  const markMerged = nextCard(page).getByRole("button", { name: "Mark merged" });
  await markMerged.click();
  await expect
    .poll(async () => (await specRun(page, mapId, run.number, 1)).mergedAt)
    .not.toBeNull();
  await expect(markMerged).toHaveCount(0);
  return await specRun(page, mapId, run.number, 1);
}

/** The hatch row's label under the Activity stream. */
export const HATCH_ROW = "Need something the stages don't offer? Tell the agent";

/** The Activity column. */
export function activity(page: Page): Locator {
  return page.getByRole("complementary", { name: "Activity" });
}

export function composerField(page: Page): Locator {
  return activity(page).getByLabel("Message to the agent");
}

export function messages(page: Page): Locator {
  return activity(page).getByRole("listitem", { name: "Your message" });
}

export function replies(page: Page): Locator {
  return activity(page).getByRole("listitem", { name: "Agent reply" });
}

/** Opens the hatch row under the stream, unless it is open. */
export async function openHatch(page: Page): Promise<void> {
  const row = activity(page).getByRole("button", { name: HATCH_ROW });
  if ((await row.getAttribute("aria-expanded")) !== "true") {
    await row.click();
  }
  await expect(composerField(page)).toBeVisible();
}

/** Sends `text` through the hatch and waits for its message in the stream. */
export async function send(page: Page, text: string): Promise<void> {
  const sent = await messages(page).count();
  await openHatch(page);
  await composerField(page).fill(text);
  await activity(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages(page)).toHaveCount(sent + 1);
}

/** Sends `text` and waits for the agent's reply to it. */
export async function sendAndAwaitReply(page: Page, text: string): Promise<void> {
  const replied = await replies(page).count();
  await send(page, text);
  await expect(replies(page)).toHaveCount(replied + 1);
}

export function revisionLink(page: Page, revision: number): Locator {
  return revisionList(page).getByRole("link", {
    name: `Revision ${String(revision)}`,
    exact: true,
  });
}
