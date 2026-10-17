import type { Locator, Page } from "@playwright/test";

import { writeFileSync } from "node:fs";

import { mapsDeliveredRepo, mapsFlowsRepo, mapsRepo, surveyReleaseFile } from "./fixture.ts";
import {
  acceptAndSend,
  acceptWaypointRound,
  addProject,
  addProjectInNewPage,
  approvedMap,
  chartAndClearMap,
  confirmDestination,
  deliverAndMarkMerged,
  expectQuietRow,
  inboxGroup,
  mapRowLink,
  nextCard,
  openWaypoint,
  PROJECT_URL,
  questionRound,
  rail,
  roundEyebrow,
  saveChecks,
  startMap,
  waypointIndex,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/** The project's name derives from its folder, `mapsRepo()`. */
const PROJECT_NAME = "maps-repo";
const IDEA = "Let people export their data, from the maps flow";
/** The stand-in's chart title and the resolution gist its grilling writes after a final round (`fake-claude.ts`). */
const CHARTED_TITLE = "Data export";
const AGENT_GIST = "Settled from your answers and words";
/** Its resolution's prose and the one call it lists as its own (`fake-claude.ts`). */
const AGENT_DECISION =
  "The export follows the person's answers, with their own words applied as the final say.";
const AGENT_DECIDED = "Your own words override the chosen options";
const WORDS = "Only when the person asks for it";
/** The stand-in's grilling questions, which name each round's radio groups. */
const COLUMNS = "Which columns should the export write?";
const HEADER = "Should the file start with a header row?";

/**
 * The chart flow's steps run in order in one worker; every other scenario starts its own map in
 * the project `beforeAll` adds (`mapsFlowsRepo()`), so they run at once on other workers, each on
 * its own server. `beforeAll` runs for the chart flow's worker too, which only adds that project.
 */
test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, mapsFlowsRepo());
});

function currentStage(page: Page) {
  return rail(page).locator("a[aria-current=page]");
}

/** A group of Wayfinding's index ("Waiting on you", "Blocked", …): its waypoint links. */
function indexGroup(page: Page, group: string) {
  return waypointIndex(page).getByRole("region", { name: group, exact: true }).getByRole("link");
}

function resolution(page: Page) {
  return page.getByRole("region", { name: "Decided", exact: true });
}

/** A group of the project page's Maps list, under the Inbox's headings or Completed. */
function projectGroup(page: Page, group: "Needs you" | "Agent is working" | "Quiet" | "Completed") {
  return page
    .getByRole("region", { name: "Maps" })
    .getByRole("region", { name: group, exact: true });
}

/** Each step builds on the map the one before it charts, in the project the first step adds. */
test.describe("the chart flow", () => {
  test.describe.configure({ mode: "serial" });

  let mapId: string;

  test("charts a map in the background, confirms its destination and shows one waiting, two blocked", async ({
    page,
  }) => {
    const projectId = await addProject(page, mapsRepo());
    await expect(page.getByRole("heading", { name: PROJECT_NAME, level: 1 })).toBeVisible();

    mapId = await startMap(page, mapsRepo(), IDEA);
    await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();

    // The destination round waits on the person: the map is under Needs you, linking Wayfinding.
    await page.goto("/");
    const needsYou = inboxGroup(page, "Needs you");
    await expect(mapRowLink(needsYou, mapId)).toHaveAttribute("href", `/maps/${mapId}/wayfinding`);
    await mapRowLink(needsYou, mapId).click();
    await expect(page).toHaveURL(`/maps/${mapId}/wayfinding`);

    await nextCard(page).getByRole("link", { name: "Answer" }).click();
    await expect(page).toHaveURL(`/maps/${mapId}/wayfinding/destination`);
    await expect(currentStage(page)).toContainText("Wayfinding");
    await expect(roundEyebrow(page, 1, "destination")).toBeVisible();
    await expect(questionRound(page).getByRole("radiogroup")).toHaveCount(2);
    await acceptAndSend(page);
    await expect(roundEyebrow(page, 1, "destination")).toHaveCount(0);

    // The agent charts three waypoints: 1 is asked at once, 2 and 3 wait on it. Nothing starts one.
    await page.goto(`/maps/${mapId}/wayfinding`);
    await expect(indexGroup(page, "Waiting on you")).toHaveCount(1);
    await expect(indexGroup(page, "Waiting on you")).toContainText("Which columns");
    await expect(indexGroup(page, "Blocked")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /start/i })).toHaveCount(0);
    await expect(nextCard(page)).toHaveCount(1);
    await expect(nextCard(page).getByRole("link", { name: "Answer" })).toHaveAttribute(
      "href",
      `/maps/${mapId}/wayfinding/1`,
    );

    // A blocked waypoint has nothing to do yet; the rail still shows Wayfinding.
    await openWaypoint(page, mapId, 2);
    await expect(currentStage(page)).toContainText("Wayfinding");
    await expect(page.getByText(/^Nothing to do here yet\./)).toBeVisible();
    await expect(questionRound(page)).toHaveCount(0);

    // The project page lists the map, open, under Needs you; with no finished map, no Completed.
    await page.goto(`/projects/${projectId}`);
    const maps = page.getByRole("region", { name: "Maps" });
    await expect(mapRowLink(maps, mapId)).toBeVisible();
    await expect(mapRowLink(projectGroup(page, "Needs you"), mapId)).toBeVisible();
    await expect(projectGroup(page, "Completed")).toHaveCount(0);
  });

  test("answers waypoint 1 by keyboard, then accepts the rest of round 2, which settles it", async ({
    page,
  }) => {
    await openWaypoint(page, mapId, 1);
    await expect(roundEyebrow(page, 1, 1)).toBeVisible();
    const round = questionRound(page);
    const cards = round.getByRole("listitem");
    await expect(page.getByText("↑/↓ question · 1–2 choose · tab notes · ⌘↵ send")).toBeVisible();

    // ↓ and ↑ move the active question; a number chooses and moves on.
    await expect(cards.nth(0)).toHaveAttribute("aria-current", "step");
    await page.keyboard.press("ArrowDown");
    await expect(cards.nth(1)).toHaveAttribute("aria-current", "step");
    await page.keyboard.press("ArrowUp");
    await expect(cards.nth(0)).toHaveAttribute("aria-current", "step");
    await page.keyboard.press("1");
    await expect(
      round.getByRole("radiogroup", { name: COLUMNS }).getByRole("radio").nth(0),
    ).toBeChecked();
    await expect(cards.nth(1)).toHaveAttribute("aria-current", "step");
    await expect(round.getByRole("button", { name: "Send answers" })).toBeDisabled();
    await page.keyboard.press("2");
    await expect(
      round.getByRole("radiogroup", { name: HEADER }).getByRole("radio").nth(1),
    ).toBeChecked();
    await expect(round.getByRole("button", { name: "Send answers" })).toBeEnabled();
    await page.keyboard.press("ControlOrMeta+Enter");

    // The agent reads the answers and asks a final round 2, with round 1 above it.
    await expect(roundEyebrow(page, 2, 1)).toBeVisible();
    await expect(page.getByRole("region", { name: "Round 1" })).toBeVisible();
    const accept = round.getByRole("button", { name: "Accept the recommendations for the rest" });
    await accept.click();
    await expect(accept).toBeDisabled();
    await expect(round.getByText("recommendation accepted")).toHaveCount(2);
    // Round 2 owns its submit, so it sends while round 1's invalidations still refetch.
    // Accept the rest returns focus to the round, so ⌘↵ sends it.
    await page.keyboard.press("ControlOrMeta+Enter");

    // Plain choices on a final round start the agent's turn, which writes the resolution and its
    // gist as a sentence; the page polls until it lands.
    await expect(round).toHaveCount(0);
    await expect(resolution(page)).toContainText(AGENT_GIST);
    await expect(page.getByText(/^resolved /)).toBeVisible();
    // The gist leads; the calls the agent made itself are flagged; the full prose is folded.
    const decided = resolution(page).getByRole("region", { name: "Agent decided" });
    await expect(decided.getByRole("listitem")).toHaveText([AGENT_DECIDED]);
    await expect(decided).toContainText("tell the agent to reopen this waypoint");
    await expect(resolution(page).getByText(AGENT_DECISION)).toHaveCount(0);
    await resolution(page).getByRole("button", { name: "Full resolution" }).click();
    await expect(resolution(page).getByText(AGENT_DECISION)).toBeVisible();
    const record = page.getByRole("region", { name: "Questions and answers" });
    await expect(record.getByRole("region", { name: /^Round \d$/ })).toHaveCount(2);

    // Resolving 1 unblocks 2 and 3, asked at once: the waypoint links the next round.
    const next = page.getByRole("link", { name: /^Next round waiting on you/ });
    await expect(next).toBeVisible();
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/maps/${mapId}/wayfinding/[23]$`));
    await page.goto(`/maps/${mapId}/wayfinding`);
    await expect(indexGroup(page, "Waiting on you")).toHaveCount(2);
    await expect(indexGroup(page, "Blocked")).toHaveCount(0);
    await expect(indexGroup(page, "Decisions so far")).toHaveCount(1);
    await expect(nextCard(page)).toHaveCount(2);
  });

  test("a second submission of a round is refused by its code", async ({ page, context }) => {
    // Two tabs hold waypoint 2's round; the first sends it, then the second tries. The second tab
    // is kept stale by refusing its change stream: a live tab would drop the sent round.
    const stale = await context.newPage();
    await stale.route("**/events", (route) => route.abort());
    await openWaypoint(stale, mapId, 2);
    await expect(roundEyebrow(stale, 1, 2)).toBeVisible();
    await questionRound(stale)
      .getByRole("button", { name: "Accept the recommendations for the rest" })
      .click();

    await openWaypoint(page, mapId, 2);
    await expect(roundEyebrow(page, 1, 2)).toBeVisible();
    await acceptAndSend(page);
    await expect(resolution(page)).toContainText(AGENT_GIST);

    await questionRound(stale).getByRole("button", { name: "Send answers" }).click();
    await expect(
      questionRound(stale).getByRole("alert").getByText("round_already_submitted", { exact: true }),
    ).toBeVisible();
    await stale.close();
  });

  test("words on waypoint 3 get the agent's resolution; the cleared map's spec is drafted; a reload keeps it", async ({
    page,
  }) => {
    await openWaypoint(page, mapId, 3);
    await expect(roundEyebrow(page, 1, 3)).toBeVisible();
    const round = questionRound(page);
    await round.getByRole("radiogroup", { name: COLUMNS }).getByRole("radio").nth(1).check();
    await round.getByRole("button", { name: "Add your own words…" }).nth(1).click();
    await round.getByLabel("Your words: Header").fill(WORDS);
    await round.getByRole("button", { name: "Send answers" }).click();

    // Own words hand the waypoint to the agent, which writes its resolution.
    await expect(round).toHaveCount(0);
    await expect(resolution(page)).toContainText(AGENT_GIST);

    // Every waypoint is resolved: the map clears and the agent drafts the spec.
    async function expectCleared(): Promise<void> {
      await expect(indexGroup(page, "Decisions so far")).toHaveCount(3);
      await expect(indexGroup(page, "Waiting on you")).toHaveCount(0);
    }
    await page.goto(`/maps/${mapId}/wayfinding`);
    await expectCleared();
    await page.goto(`/maps/${mapId}/spec`);
    await expect(nextCard(page).getByRole("button", { name: "Approve the spec" })).toBeVisible();

    await page.goto(`/maps/${mapId}/wayfinding`);
    await page.reload();
    await expectCleared();
    await openWaypoint(page, mapId, 3);
    await page.reload();
    await expect(resolution(page)).toContainText(AGENT_GIST);
    await expect(page.getByText(WORDS)).toBeVisible();
    await openWaypoint(page, mapId, 1);
    await page.reload();
    await expect(page.getByRole("region", { name: /^Round \d$/ })).toHaveCount(2);
  });
});

test("a failed chart is retried by itself", async ({ page }) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export the data once more [fake:fail-once]");
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(nextCard(page).getByRole("link", { name: "Answer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("a chart that fails twice stops on Try again, which charts the map", async ({ page }) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export the data, stubbornly [fake:fail-twice]");
  const tryAgain = nextCard(page).getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeVisible();
  await page.reload();
  await expect(tryAgain).toBeVisible();
  await tryAgain.click();
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(nextCard(page).getByRole("link", { name: "Answer" })).toBeVisible();
});

test("a waypoint whose grilling fails twice stops; its page offers Try again", async ({ page }) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, grilled [fake:fail-twice:grilling]",
  );
  await page.goto(`/maps/${id}/wayfinding`);
  await nextCard(page).getByRole("link", { name: "Answer" }).click();
  await expect(roundEyebrow(page, 1, "destination")).toBeVisible();
  await acceptAndSend(page);

  // Waypoint 1's first grilling and its retry fail: it waits on the person, stopped.
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Waiting on you")).toContainText("stopped");
  await expect(nextCard(page).locator("[data-code=agent_run_failed]")).toBeVisible();
  await expect(nextCard(page)).not.toContainText("agent_run_failed");
  await openWaypoint(page, id, 2);
  await expect(page.getByText(/^Nothing to do here yet\./)).toBeVisible();

  await openWaypoint(page, id, 1);
  const card = nextCard(page);
  await expect(card.locator("[data-code=agent_run_failed]")).toBeVisible();
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(roundEyebrow(page, 1, 1)).toBeVisible();
  await expect(nextCard(page)).toHaveCount(0);
});

/** The stand-in's `[fake:kinds]` chart (`fake-claude.ts`): Research 1, Task 2, Grilling 3. */
const KINDS = { research: "What Excel expects", task: "Count the record fields" } as const;
/** The stand-in's fog item and Out of scope line under `[fake:kinds]` and `[fake:states]`. */
const KINDS_FOG = "Whether exports need a size limit.";
const KINDS_OUT_OF_SCOPE = "Importing CSV files: this effort only exports.";
/** The line the stand-in saves when it moves a fog item out of scope. */
const FOG_MOVED = "Settled outside this export: the stand-in moves it out of scope.";
/** The stand-in's Task round topic, which names its words field. */
const TASK_TOPIC = "Records";
const TASK_WORDS = "Read the Ledger entries in src/ledger.ts";
/** The waypoint `[fake:conflict]`'s first pass opens, and the two it names. */
const CONFLICT_TITLE = "Columns against encoding";
const CONFLICT_NAMED = ["Which columns", "Which encoding"] as const;
const CONFLICT_EXPLANATION =
  "Waypoint 1 says “every column is exported”; waypoint 2 says “ASCII only”, which some columns are not.";
/** `[fake:states]`'s waypoint 5 rules itself out with this reason. */
const OUT_OF_SCOPE_REASON = "The old exporter is being removed; nothing new goes into it.";

function region(page: Page, name: string) {
  return page.getByRole("region", { name, exact: true });
}

/** The waypoint page's own article, so its sections are not confused with Wayfinding's. */
function waypointArticle(page: Page, number: number) {
  return page.getByRole("article", { name: `Waypoint ${String(number)}` });
}

/** The badges in the waypoint page's head, above the index. */
function waypointState(page: Page, number: number) {
  return page.getByRole("group", { name: `Waypoint ${String(number)} state` });
}

/** Answers every round of the default chart's waypoints 1–3 with the recommendations. */
async function answerDefaultWaypoints(page: Page, id: string): Promise<void> {
  await acceptWaypointRound(page, id, 1, 1);
  await acceptWaypointRound(page, id, 1, 2);
  await acceptWaypointRound(page, id, 2, 1);
  await acceptWaypointRound(page, id, 3, 1);
}

/** The Spec page shows the drafted revision's **Approve the spec** once the map clears. */
async function expectSpecDrafted(page: Page, id: string): Promise<void> {
  await page.goto(`/maps/${id}/spec`);
  await expect(nextCard(page).getByRole("button", { name: "Approve the spec" })).toBeVisible();
}

test("[fake:kinds]: research resolves by itself, the task is answered in words, the fog settles, the pass runs and the spec is drafted; a reload keeps it", async ({
  page,
}) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export the data, three kinds [fake:kinds]");
  await confirmDestination(page, id);

  // Research 1 runs and resolves with no button; it unblocks nothing alone (3 waits on 2 too).
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Decisions so far")).toContainText(KINDS.research);
  await expect(page.getByRole("button", { name: /start/i })).toHaveCount(0);
  await expect(indexGroup(page, "Waiting on you")).toContainText(KINDS.task);
  await expect(indexGroup(page, "Blocked")).toHaveCount(1);
  await expect(region(page, "Not yet specified")).toContainText("fog · 1");
  await expect(region(page, "Not yet specified")).toContainText(KINDS_FOG);
  await expect(region(page, "Out of scope")).toContainText(KINDS_OUT_OF_SCOPE);

  await openWaypoint(page, id, 1);
  const research = waypointArticle(page, 1);
  const findings = research.getByRole("region", { name: "Findings" });
  await expect(findings).toBeVisible();
  await expect(findings.getByRole("button", { name: "Full findings" })).toBeVisible();
  await expect(research.getByRole("region", { name: "Report" })).toBeVisible();
  await expect(research.getByRole("region", { name: "Sources" })).toBeVisible();

  // The Task's round asks like every round: options, the recommendation first, words beside them.
  await openWaypoint(page, id, 2);
  await expect(roundEyebrow(page, 1, 2)).toBeVisible();
  const round = questionRound(page);
  await expect(round.getByRole("radiogroup").getByRole("radio")).toHaveCount(2);
  await expect(round.getByText("recommended")).toBeVisible();
  await expect(
    round.getByRole("button", { name: "Accept the recommendations for the rest" }),
  ).toBeEnabled();
  await expect(page.getByText("↑/↓ question · 1–2 choose · tab notes · ⌘↵ send")).toBeVisible();
  await expect(round.getByRole("button", { name: "Send answers" })).toBeDisabled();
  await round.getByRole("radiogroup").getByRole("radio").nth(0).check();
  await round.getByRole("button", { name: "Add your own words…" }).click();
  await round.getByLabel(`Your words: ${TASK_TOPIC}`).fill(TASK_WORDS);
  await round.getByRole("button", { name: "Send answers" }).click();
  await expect(round).toHaveCount(0);
  const task = waypointArticle(page, 2);
  await expect(task.getByRole("region", { name: "What was done" })).toBeVisible();
  await expect(task.getByRole("region", { name: "Decided", exact: true })).toBeVisible();

  // Grilling 3 is last and fog remains: its final round starts the agent's turn, whose
  // resolution moves the fog out of scope.
  await acceptWaypointRound(page, id, 3, 1);
  await expect(resolution(page)).toContainText(AGENT_GIST);
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Decisions so far")).toHaveCount(3);
  await expect(region(page, "Not yet specified")).toContainText("No fog left.");
  await expect(region(page, "Out of scope")).toContainText(FOG_MOVED);

  // Three resolved: the pass is clean, the map clears and the spec is drafted.
  await expectSpecDrafted(page, id);

  await page.goto(`/maps/${id}/wayfinding`);
  await page.reload();
  await expect(indexGroup(page, "Decisions so far")).toHaveCount(3);
  await expect(region(page, "Not yet specified")).toContainText("No fog left.");
  await openWaypoint(page, id, 1);
  await page.reload();
  await expect(waypointArticle(page, 1).getByRole("region", { name: "Findings" })).toBeVisible();
  await openWaypoint(page, id, 2);
  await page.reload();
  await expect(
    waypointArticle(page, 2).getByRole("region", { name: "What was done" }),
  ).toBeVisible();
  await expect(page.getByText(TASK_WORDS)).toBeVisible();
});

test("[fake:research-unanswered]: the report waits on you, and Try again answers it", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, unanswered [fake:research-unanswered]",
  );
  await confirmDestination(page, id);

  await page.goto(`/maps/${id}/wayfinding`);
  await expect(
    indexGroup(page, "Waiting on you").filter({ hasText: KINDS.research }),
  ).toContainText("report waiting");
  await openWaypoint(page, id, 1);
  const article = waypointArticle(page, 1);
  const waiting = article.getByRole("region", { name: "Waiting on you" });
  await expect(waiting.getByRole("alert")).toContainText("Research could not answer.");
  await expect(waypointState(page, 1).getByText("waiting on you", { exact: true })).toBeVisible();
  await expect(article.getByRole("region", { name: "Report" })).toBeVisible();
  await expect(article.getByRole("region", { name: "Findings" })).toHaveCount(0);
  await page.reload();
  await waiting.getByRole("button", { name: "Try again" }).click();

  await expect(article.getByRole("region", { name: "Findings" })).toBeVisible();
  await expect(waiting).toHaveCount(0);
  await expect(article.getByRole("region", { name: "Earlier reports" })).toBeVisible();
});

test("[fake:task-failed]: the failed task waits on you with its facts, and Try again does it", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, failing task [fake:task-failed]",
  );
  await confirmDestination(page, id);

  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Waiting on you").filter({ hasText: KINDS.task })).toContainText(
    "task failed",
  );
  await openWaypoint(page, id, 2);
  const article = waypointArticle(page, 2);
  const waiting = article.getByRole("region", { name: "Waiting on you" });
  await expect(waiting.getByRole("alert")).toContainText("Task failed.");
  await page.reload();
  await waiting.getByRole("button", { name: "Try again" }).click();

  await expect(article.getByRole("region", { name: "What was done" })).toBeVisible();
  // Done with no round asked: the agent settled it alone, and the box says so once.
  const alone = article.getByRole("region", { name: "Decided by the agent" });
  await expect(alone).toContainText("Decided by the agent · without asking you");
  await expect(
    alone.getByText("To change it, tell the agent to reopen this waypoint."),
  ).toHaveCount(1);
  await expect(alone.getByRole("button", { name: "Full resolution" })).toBeVisible();
  await expect(alone.getByRole("list")).toHaveCount(0);
  await expect(waiting).toHaveCount(0);
});

test("[fake:fog-run]: the last resolutions leave the fog, and the map's fog run settles it", async ({
  page,
}) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export the data, foggy [fake:fog-run]");
  await confirmDestination(page, id);
  await answerDefaultWaypoints(page, id);

  // Waypoint 3 resolves leaving the fog; the fog run moves it out of scope.
  await expect(resolution(page)).toContainText(AGENT_GIST);
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Decisions so far")).toHaveCount(3);
  await expect(region(page, "Not yet specified")).toContainText("No fog left.");
  await expect(region(page, "Out of scope")).toContainText(FOG_MOVED);
  await expectSpecDrafted(page, id);
});

test("[fake:conflict]: the pass opens a waypoint; once it is answered a clean pass clears the map", async ({
  page,
}) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export the data, conflicting [fake:conflict]");
  await confirmDestination(page, id);
  await answerDefaultWaypoints(page, id);

  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Waiting on you")).toContainText(CONFLICT_TITLE);
  await openWaypoint(page, id, 4);
  // The round is open, with the finding above it.
  const pass = region(page, "Raised by the consistency pass");
  for (const title of CONFLICT_NAMED) {
    await expect(pass.getByRole("link", { name: title })).toBeVisible();
  }
  // The pass's explanation waits behind Evidence.
  await expect(pass.getByText(CONFLICT_EXPLANATION)).toHaveCount(0);
  await pass.getByRole("button", { name: "Evidence" }).click();
  await expect(pass.getByText(CONFLICT_EXPLANATION)).toBeVisible();
  await expect(roundEyebrow(page, 1, 4)).toBeVisible();
  await acceptAndSend(page);
  await expect(resolution(page)).toContainText(AGENT_GIST);

  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Decisions so far")).toHaveCount(4);
  await expectSpecDrafted(page, id);
  await page.reload();
  await expect(nextCard(page).getByRole("button", { name: "Approve the spec" })).toBeVisible();
});

test("[fake:states]: a waypoint ruled out of scope, and Research and Task waiting on a blocker", async ({
  page,
}) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export the data, every state [fake:states]");
  await confirmDestination(page, id);

  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Decisions so far")).toHaveCount(1);
  await expect(indexGroup(page, "Waiting on you")).toHaveCount(1);
  await expect(indexGroup(page, "Blocked")).toHaveCount(2);
  await expect(region(page, "Not yet specified")).toContainText("fog · 1");
  const ruledOut = region(page, "Out of scope").getByRole("link");
  await expect(ruledOut).toHaveCount(1);
  // An out-of-scope waypoint is in the index's own Out of scope group, in no other,
  // and not counted under Decisions so far.
  await expect(indexGroup(page, "Out of scope waypoints")).toHaveCount(1);
  await expect(
    indexGroup(page, "Out of scope waypoints").and(
      page.locator(`a[href="/maps/${id}/wayfinding/5"]`),
    ),
  ).toHaveCount(1);
  await expect(waypointIndex(page).locator(`a[href="/maps/${id}/wayfinding/5"]`)).toHaveCount(1);
  await expect(page.getByText("1 of 4 waypoints resolved", { exact: true })).toBeVisible();

  await ruledOut.click();
  await expect(page).toHaveURL(`/maps/${id}/wayfinding/5`);
  const article = waypointArticle(page, 5);
  await expect(waypointState(page, 5).getByText("out of scope", { exact: true })).toBeVisible();
  await expect(article.getByRole("region", { name: "Out of scope" })).toContainText(
    OUT_OF_SCOPE_REASON,
  );
  await expect(questionRound(page)).toHaveCount(0);

  await openWaypoint(page, id, 3);
  await expect(
    page.getByText(/^Nothing to do here yet\. The agent starts this task /),
  ).toBeVisible();
  await openWaypoint(page, id, 4);
  await expect(
    page.getByText(/^Nothing to do here yet\. The agent starts this research /),
  ).toBeVisible();
});

/** `[fake:propose]`'s proposals (`fake-claude.ts`): the chart's, the fog run's, the pass's, waypoint 5's. */
const PROPOSED = {
  chart: {
    title: "CSV imports",
    idea: "Import records from a CSV file",
    line: "Importing CSV files is its own effort: proposed as a new map.",
  },
  fog: {
    title: "Background exports",
    idea: "Run large exports in the background",
    line: "Background exports are their own effort: proposed as a new map.",
  },
  pass: {
    title: "Nightly exports",
    idea: "Schedule exports to run every night",
    line: "Scheduled exports are their own effort: proposed as a new map.",
  },
  waypoint: "Retire the old exporter",
} as const;
const EDITED_IDEA = "Import records from a CSV file, matching columns by their header";
const SPLIT_LINK = "Split into its own map →";

/** A suggested map on Wayfinding, by its title. */
function proposal(page: Page, title: string) {
  return region(page, "Suggested new maps").getByRole("article", {
    name: `Suggested map: ${title}`,
  });
}

test("[fake:propose]: the chart, the fog run and the pass each propose a map; one is confirmed into a charting map split from this one, one dismissed", async ({
  page,
  context,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, proposing [fake:propose] [fake:fog-run]",
  );
  await confirmDestination(page, id);

  // The confirming chart proposes a map; its line is not Out of scope until it is decided.
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(proposal(page, PROPOSED.chart.title)).toContainText(PROPOSED.chart.line);
  await expect(region(page, "Out of scope")).toContainText("Nothing ruled out yet.");

  // The fog run proposes the fog item, which leaves the fog with no line; the pass proposes one.
  await answerDefaultWaypoints(page, id);
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(region(page, "Suggested new maps").getByRole("article")).toHaveCount(3);
  await expect(proposal(page, PROPOSED.fog.title)).toContainText(PROPOSED.fog.line);
  await expect(proposal(page, PROPOSED.pass.title)).toContainText(PROPOSED.pass.line);
  await expect(region(page, "Not yet specified")).toContainText("No fog left.");
  await expect(region(page, "Out of scope")).toContainText("Nothing ruled out yet.");

  // A second tab watches the list change live, through the change feed.
  const watcher = await context.newPage();
  await watcher.goto(`/maps/${id}/wayfinding`);
  await expect(proposal(watcher, PROPOSED.chart.title)).toBeVisible();

  // The idea is folded away under the title and the line; opened, it can be edited. An empty or
  // over-long idea cannot be created; the edited one is.
  const chart = proposal(page, PROPOSED.chart.title);
  const idea = chart.getByRole("textbox", { name: "Idea for the new map" });
  await expect(idea).toBeHidden();
  await chart.getByRole("button", { name: "Show and edit the idea" }).click();
  await expect(idea).toHaveValue(PROPOSED.chart.idea);
  const confirm = chart.getByRole("button", { name: "Create map" });
  await expect(confirm).toBeEnabled();
  await idea.fill("   ");
  await expect(confirm).toBeDisabled();
  await idea.fill("x".repeat(4001));
  await expect(confirm).toBeDisabled();
  await idea.fill(EDITED_IDEA);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The person stays on Wayfinding; the line is saved, linked to the new map.
  const confirmed = proposal(page, PROPOSED.chart.title);
  await expect(confirmed.getByText("created", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/maps/${id}/wayfinding`);
  const outOfScope = region(page, "Out of scope");
  await expect(outOfScope).toContainText(PROPOSED.chart.line);
  await expect(outOfScope.getByRole("link", { name: SPLIT_LINK })).toHaveCount(1);
  await expect(
    proposal(watcher, PROPOSED.chart.title).getByText("created", { exact: true }),
  ).toBeVisible();

  // Dismissing keeps the fog proposal's line, plain.
  await proposal(page, PROPOSED.fog.title).getByRole("button", { name: "Dismiss" }).click();
  await expect(
    proposal(page, PROPOSED.fog.title).getByText("dismissed", { exact: true }),
  ).toBeVisible();
  await expect(outOfScope).toContainText(PROPOSED.fog.line);
  await expect(outOfScope.getByRole("link", { name: SPLIT_LINK })).toHaveCount(1);
  await expect(
    proposal(watcher, PROPOSED.fog.title).getByText("dismissed", { exact: true }),
  ).toBeVisible();
  await expect(
    proposal(page, PROPOSED.pass.title).getByText("to decide", { exact: true }),
  ).toBeVisible();
  await watcher.close();

  // The new map charts from the edited idea and shows Split from, linking back.
  await outOfScope.getByRole("link", { name: SPLIT_LINK }).click();
  await expect(page).toHaveURL(/\/maps\/[^/]+\/idea$/);
  await expect(page.locator("blockquote")).toContainText(EDITED_IDEA);
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();
  const splitFrom = page.getByRole("group", { name: "Split from" });
  await expect(splitFrom.getByRole("link", { name: CHARTED_TITLE })).toBeVisible();
  await splitFrom.getByRole("link").click();
  await expect(page).toHaveURL(`/maps/${id}/wayfinding`);
});

test("[fake:propose] with [fake:states]: a ruled-out waypoint's proposal, dismissed, leaves its one plain line", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, every state, proposing [fake:states] [fake:propose]",
  );
  await confirmDestination(page, id);

  await page.goto(`/maps/${id}/wayfinding`);
  const attached = proposal(page, PROPOSED.waypoint);
  await expect(attached).toContainText("waypoint 5");
  await attached.getByRole("button", { name: "Dismiss" }).click();
  await expect(attached.getByText("dismissed", { exact: true })).toBeVisible();
  const outOfScope = region(page, "Out of scope");
  await expect(outOfScope.getByText(OUT_OF_SCOPE_REASON)).toHaveCount(1);
  await expect(outOfScope.getByRole("link", { name: SPLIT_LINK })).toHaveCount(0);
});

test("[fake:propose] with [fake:no-waypoints]: an undecided proposal holds nothing; confirming it charts a map linked both ways", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, beside a proposal [fake:propose] [fake:no-waypoints]",
  );
  await confirmDestination(page, id);

  // Spec starts with the proposal still undecided, and nothing asks the person to decide it.
  await expectSpecDrafted(page, id);
  await page.goto(`/maps/${id}/wayfinding`);
  await expect(
    proposal(page, PROPOSED.chart.title).getByText("to decide", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Decide" })).toHaveCount(0);

  // Confirming it links this map's line to the new map.
  await proposal(page, PROPOSED.chart.title).getByRole("button", { name: "Create map" }).click();
  await expect(
    proposal(page, PROPOSED.chart.title).getByText("created", { exact: true }),
  ).toBeVisible();
  await expect(region(page, "Out of scope")).toContainText(PROPOSED.chart.line);

  // The new map charts from the idea and shows Split from, linking back.
  await region(page, "Out of scope").getByRole("link", { name: SPLIT_LINK }).click();
  await expect(page).toHaveURL(/\/maps\/[^/]+\/idea$/);
  await expect(page.locator("blockquote")).toContainText(PROPOSED.chart.idea);
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();
  const splitFrom = page.getByRole("group", { name: "Split from" });
  await splitFrom.getByRole("link", { name: CHARTED_TITLE }).click();
  await expect(page).toHaveURL(`/maps/${id}/wayfinding`);
});

test("[fake:split]: the first chart offers to split the idea; the answers wait until each offer is created or dismissed", async ({
  page,
}) => {
  const id = await startMap(page, mapsFlowsRepo(), "Export, import and schedule data [fake:split]");
  await page.goto(`/maps/${id}/wayfinding`);
  await nextCard(page).getByRole("link", { name: "Answer" }).click();
  await expect(page).toHaveURL(`/maps/${id}/wayfinding/destination`);

  // The offers sit above the round, each a title, its line and its idea folded away.
  const split = region(page, "Split this idea into maps");
  const offer = (title: string) => split.getByRole("article", { name: `Suggested map: ${title}` });
  await expect(split.getByRole("article")).toHaveCount(2);
  await expect(offer("CSV imports")).toContainText(
    "Importing records is its own map, split off this idea.",
  );
  await expect(
    offer("CSV imports").getByRole("textbox", { name: "Idea for the new map" }),
  ).toBeHidden();

  // The answers wait on the offers.
  const round = questionRound(page);
  await round.getByRole("button", { name: "Accept the recommendations for the rest" }).click();
  await expect(round.getByRole("button", { name: "Send answers" })).toBeDisabled();
  await expect(round).toContainText("Create or dismiss each suggested map above");

  // Creating one makes its map; dismissing the other keeps its work here.
  await offer("CSV imports").getByRole("button", { name: "Create map" }).click();
  await expect(offer("CSV imports").getByText("created", { exact: true })).toBeVisible();
  await expect(round.getByRole("button", { name: "Send answers" })).toBeDisabled();
  await offer("Nightly exports").getByRole("button", { name: "Dismiss" }).click();
  await expect(
    offer("Nightly exports").getByText("kept in this map", { exact: true }),
  ).toBeVisible();

  await round.getByRole("button", { name: "Send answers" }).click();
  await expect(roundEyebrow(page, 1, "destination")).toHaveCount(0);

  // Out of scope names the created map's line, linked to it; the kept one has no line.
  await page.goto(`/maps/${id}/wayfinding`);
  const outOfScope = region(page, "Out of scope");
  await expect(outOfScope).toContainText("Importing records is its own map, split off this idea.");
  await expect(outOfScope).not.toContainText("Scheduled exports");
  await outOfScope.getByRole("link", { name: SPLIT_LINK }).click();
  await expect(page).toHaveURL(/\/maps\/[^/]+\/idea$/);
  await expect(page.locator("blockquote")).toContainText(
    "Import records from a CSV file, matching columns by their header.",
  );
});

/** The open destination round's footer lines. */
const LAST_ROUND_FOOTER = "Sending these answers confirms the destination.";
const FOOTER =
  "The agent confirms the destination from your answers, or asks a short follow-up if they change the scope.";

/** The destination a stand-in follow-up after `answered` rounds revises to (`fake-claude.ts`). */
function followUpDestination(answered: number): string {
  return `A CSV export of every record, offered from the project page, as revised after destination round ${String(answered)}.`;
}

/** The open round's footer line, by its fixed copy. */
function footer(page: Page, line: string) {
  return questionRound(page).getByText(line, { exact: true });
}

/** The top edge of a visible element, to check what sits above what. */
async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("The element has no box: it is not visible");
  }
  return box.y;
}

/**
 * Opens the destination page from the next-action card, whose headline names round `round` or,
 * for the last round, the confirmation; the page shows that round open.
 */
async function openDestinationRound(
  page: Page,
  mapId: string,
  round: number,
  last: boolean,
): Promise<void> {
  await page.goto(`/maps/${mapId}/wayfinding`);
  await expect(nextCard(page)).toContainText(
    last ? "Confirm the destination." : `Answer destination round ${String(round)}.`,
  );
  await nextCard(page).getByRole("link", { name: "Answer" }).click();
  await expect(page).toHaveURL(`/maps/${mapId}/wayfinding/destination`);
  await expect(roundEyebrow(page, round, "destination")).toBeVisible();
}

/** The open destination round's footer: the last-round line, or the line that a follow-up may come. */
async function expectFooter(page: Page, last: boolean): Promise<void> {
  await expect(footer(page, last ? LAST_ROUND_FOOTER : FOOTER)).toBeVisible();
  await expect(footer(page, last ? FOOTER : LAST_ROUND_FOOTER)).toHaveCount(0);
}

/** After the destination is confirmed: the stand-in's three waypoints, one waiting on you. */
async function expectCharted(page: Page, mapId: string, rounds: number): Promise<void> {
  await page.goto(`/maps/${mapId}/wayfinding`);
  await expect(indexGroup(page, "Waiting on you")).toHaveCount(1);
  await expect(indexGroup(page, "Blocked")).toHaveCount(2);
  await page.goto(`/maps/${mapId}/wayfinding/destination`);
  const record = page.getByRole("region", { name: "Questions and answers" });
  await expect(record.getByRole("region", { name: /^Round \d+$/ })).toHaveCount(rounds);
  await expect(questionRound(page)).toHaveCount(0);
}

test("[fake:destination-follow-up]: two destination rounds, the first above the open second, then waypoints", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, asked twice [fake:split] [fake:destination-follow-up]",
  );
  await openDestinationRound(page, id, 1, false);
  const split = region(page, "Split this idea into maps");
  for (const title of ["CSV imports", "Nightly exports"]) {
    await split
      .getByRole("article", { name: `Suggested map: ${title}` })
      .getByRole("button", { name: "Dismiss" })
      .click();
  }
  // Once no offer holds the answers, round 1's footer says a follow-up may come.
  await expectFooter(page, false);
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 1, "destination")).toHaveCount(0);

  // Round 2: the follow-up's destination is the lede; the offers, then answered round 1, sit above it.
  await openDestinationRound(page, id, 2, false);
  await expectFooter(page, false);
  const lede = page.getByText(followUpDestination(1), { exact: true });
  const answered = page.getByRole("region", { name: "Round 1" });
  await expect(lede).toBeVisible();
  await expect(answered).toBeVisible();
  await expect(page.getByRole("region", { name: /^Round \d+$/ })).toHaveCount(1);
  expect(await top(lede)).toBeLessThan(await top(split));
  expect(await top(split)).toBeLessThan(await top(answered));
  expect(await top(answered)).toBeLessThan(await top(questionRound(page)));
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 2, "destination")).toHaveCount(0);

  await expectCharted(page, id, 2);
});

test("[fake:destination-final]: a final follow-up shows the last-round footer, then its answers confirm", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, settled [fake:destination-final]",
  );
  await openDestinationRound(page, id, 1, false);
  await expectFooter(page, false);
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 1, "destination")).toHaveCount(0);

  await openDestinationRound(page, id, 2, true);
  await expectFooter(page, true);
  await expect(page.getByText(followUpDestination(1), { exact: true })).toBeVisible();
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 2, "destination")).toHaveCount(0);

  await expectCharted(page, id, 2);
});

test("[fake:destination-cap]: three destination rounds, the third with the last-round footer, then waypoints and no fourth", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, at the cap [fake:destination-cap]",
  );
  await openDestinationRound(page, id, 1, false);
  await expectFooter(page, false);
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 1, "destination")).toHaveCount(0);
  await openDestinationRound(page, id, 2, false);
  await expectFooter(page, false);
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 2, "destination")).toHaveCount(0);

  // Round 3 is not final, yet the last: sending it confirms the destination.
  await openDestinationRound(page, id, 3, true);
  await expectFooter(page, true);
  await expect(page.getByText(followUpDestination(2), { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Round \d+$/ })).toHaveCount(2);
  await acceptAndSend(page);
  await expect(roundEyebrow(page, 3, "destination")).toHaveCount(0);

  await expectCharted(page, id, 3);
  await expect(roundEyebrow(page, 4, "destination")).toHaveCount(0);
});

test("[fake:survey-held]: while the code survey runs, each page says what every waypoint waits on", async ({
  page,
}) => {
  const id = await startMap(
    page,
    mapsFlowsRepo(),
    "Export the data, surveyed slowly [fake:survey-held]",
  );
  await confirmDestination(page, id);

  // The chart confirms three waypoints and the survey holds, so none has started: 1 waits on the
  // survey, 2 and 3 on 1. The Idea page's digest says so rather than failing to open.
  await page.goto(`/maps/${id}/idea`);
  const digest = page.getByRole("group", { name: "Wayfinding", exact: true });
  await expect(digest).toContainText("waits on the code survey");
  await expect(digest).toContainText("waits on 1");
  await expect(page.getByText("Could not open this page")).toHaveCount(0);

  await page.goto(`/maps/${id}/wayfinding`);
  await expect(indexGroup(page, "Blocked")).toHaveCount(3);
  await expect(indexGroup(page, "Blocked").first()).toContainText("waits on the code survey");
  await openWaypoint(page, id, 1);
  await expect(
    page.getByText(/^Nothing to do here yet\. The agent is reading the project's code first/),
  ).toBeVisible();

  // The survey's end starts waypoint 1, whose grilling asks its first round.
  writeFileSync(surveyReleaseFile(), "");
  await expect(roundEyebrow(page, 1, 1)).toBeVisible();
  await page.goto(`/maps/${id}/idea`);
  await expect(digest).toContainText("waiting on you");
  await expect(digest).not.toContainText("code survey");
});

/** The Delete map confirmation. */
function deleteDialog(page: Page) {
  return page.getByRole("alertdialog", { name: "Delete this map?" });
}

test("Delete map: Cancel keeps the map; deleting it opens its project, without it, and its address is not found", async ({
  page,
}) => {
  const mapId = await startMap(page, mapsFlowsRepo(), "Export the data, then delete the map");
  // Charted: the destination round waits on the person, and no run is in flight.
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();

  await page.getByRole("button", { name: "Delete map" }).click();
  await expect(deleteDialog(page)).toContainText(CHARTED_TITLE);
  await deleteDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(deleteDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(`/maps/${mapId}/idea`);

  await page.getByRole("button", { name: "Delete map" }).click();
  await deleteDialog(page).getByRole("button", { name: "Delete map" }).click();
  await expect(page).toHaveURL(PROJECT_URL);
  await expect(deleteDialog(page)).toHaveCount(0);
  const maps = page.getByRole("region", { name: "Maps" });
  await expect(maps).toBeVisible();
  await expect(maps.locator(`a[href^="/maps/${mapId}/"]`)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Once the overviews load the greeting counts what waits on you; the map, which waited on its
  // destination round, would be under Needs you, which never folds.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/waiting on you\.$/);
  await expect(page.locator(`a[href^="/maps/${mapId}/"]`)).toHaveCount(0);

  await page.goto(`/maps/${mapId}/idea`);
  await expect(page.getByRole("heading", { name: "Map not found" })).toBeVisible();
});

test("Delete map is refused for a map that wrote a spec, which Delete map and spec then deletes with it", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, mapsFlowsRepo(), "Export the data, then keep the map");
  await page.goto(`/maps/${mapId}/idea`);

  await page.getByRole("button", { name: "Delete map" }).click();
  await deleteDialog(page).getByRole("button", { name: "Delete map" }).click();
  await expect(deleteDialog(page).getByRole("alert")).toContainText("map_wrote_spec");
  await expect(deleteDialog(page)).toContainText("This map wrote spec");
  await deleteDialog(page).getByRole("button", { name: "Cancel" }).click();

  await page.reload();
  await expect(page).toHaveURL(`/maps/${mapId}/idea`);
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();

  await page.getByRole("button", { name: "Delete map" }).click();
  await deleteDialog(page).getByRole("button", { name: "Delete map" }).click();
  await deleteDialog(page)
    .getByRole("button", { name: /^Delete map and spec \d+$/ })
    .click();
  await expect(page).toHaveURL(PROJECT_URL);
  await expect(deleteDialog(page)).toHaveCount(0);
  await expect(page.locator(`a[href^="/maps/${mapId}/"]`)).toHaveCount(0);

  await page.goto(`/maps/${mapId}/idea`);
  await expect(page.getByRole("heading", { name: "Map not found" })).toBeVisible();
});

/** The check the delivered map's project saves, which passes in any repository. */
const PASSING_CHECK = "git status --short";

test("a delivered and merged map folds into the project page's closed Completed group, and stays under Quiet in the Inbox", async ({
  page,
}) => {
  // Its own project, so the map writes spec 1 and is the only map under Completed.
  const projectId = await addProject(page, mapsDeliveredRepo());
  const mapId = await approvedMap(page, mapsDeliveredRepo(), "Export the data, then deliver it");
  await saveChecks(page, mapId, [PASSING_CHECK]);
  const run = await deliverAndMarkMerged(page, mapId, mapsDeliveredRepo());
  expect(run.number).toBe(1);

  // Merged, the map is counted in Completed, closed: its row is not shown, nor under Quiet.
  await page.goto(`/projects/${projectId}`);
  const maps = page.getByRole("region", { name: "Maps" });
  const completed = projectGroup(page, "Completed");
  const trigger = completed.getByRole("button", { name: /^Completed\s*1$/ });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(mapRowLink(maps, mapId)).toHaveCount(0);

  // Opened, the group shows the map's row.
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(mapRowLink(completed, mapId)).toBeVisible();

  // A reload shows the group closed again.
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(mapRowLink(maps, mapId)).toHaveCount(0);

  // The Inbox keeps it under Quiet.
  await page.goto("/");
  await expectQuietRow(page, (quiet) => mapRowLink(quiet, mapId));
});
