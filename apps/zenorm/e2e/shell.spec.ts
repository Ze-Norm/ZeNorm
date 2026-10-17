import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { e2eRoot, fixtureRepo, noCommitRepo } from "./fixture.ts";
import { projectBlockers } from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/** The project's name derives from its folder, `fixtureRepo()`. */
const PROJECT_NAME = "repo";
const IDEA = "Let people export their data";
const STAGE_NAMES = ["Idea", "Wayfinding", "Spec", "Tickets", "Delivery"];
const MAP_URL = /\/maps\/([0-9a-f-]+)\/idea$/;
/** The stand-in's chart title (`fake-claude.ts`), which names the map once charted. */
const CHARTED_TITLE = "Data export";

/** Each test builds on the project and map the one before it adds. */
test.describe.configure({ mode: "serial" });

let mapId: string;

function addProjectDialog(page: Page) {
  return page.getByRole("dialog", { name: "Add project" });
}

async function openAddProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Project switcher" }).click();
  await page.getByRole("menuitem", { name: "Add project…" }).click();
  await expect(addProjectDialog(page)).toBeVisible();
}

async function checkFolder(page: Page, folderPath: string): Promise<void> {
  const dialog = addProjectDialog(page);
  await dialog.getByLabel("Folder").fill(folderPath);
  await dialog.getByRole("button", { name: "Check" }).click();
}

/** The stage rail; its links are found by `href`, the viewed one by `aria-current="page"`. */
function rail(page: Page) {
  return page.getByRole("navigation", { name: "Stages" });
}

function activity(page: Page) {
  return page.getByRole("complementary", { name: "Activity" });
}

function routeError(page: Page) {
  return page.getByRole("heading", { level: 1, name: "Could not open this page" });
}

test("adds a project through Check, with its name derived and its branch detected", async ({
  page,
}) => {
  await page.goto("/");
  await openAddProject(page);
  const dialog = addProjectDialog(page);
  await checkFolder(page, fixtureRepo());

  await expect(dialog.getByText(PROJECT_NAME, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Base branch · detected, confirm it")).toHaveValue("main");
  await expect(
    dialog.getByText(
      /Required checks and a repair limit start unset\. Delivery stays unavailable until you set both\./,
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Add project" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);

  await page.getByRole("button", { name: "Project switcher" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "All projects" })).toBeVisible();
  const item = menu.getByRole("menuitem").filter({ hasText: fixtureRepo() });
  await expect(item).toContainText(PROJECT_NAME);
  await expect(menu.getByRole("menuitem", { name: "Add project…" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Check shows a refusal by its code and a repository with no commit gets the notice", async ({
  page,
}) => {
  await page.goto("/");
  await openAddProject(page);
  const dialog = addProjectDialog(page);

  await checkFolder(page, fixtureRepo());
  await expect(dialog.getByRole("alert")).toContainText("project_already_added");
  await expect(dialog.getByRole("button", { name: "Add project" })).toBeDisabled();

  await checkFolder(page, noCommitRepo());
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByLabel("Base branch · detected, confirm it")).toHaveValue("main");
  await expect(dialog.getByText(/Start delivery waits for a commit on main/)).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("marks a project whose folder is gone as folder missing in the switcher", async ({ page }) => {
  const goneRepo = join(e2eRoot(), "gone-repo");
  execFileSync("git", ["init", "-q", "-b", "main", goneRepo], { stdio: "ignore" });
  await page.goto("/");
  await openAddProject(page);
  await checkFolder(page, goneRepo);
  await addProjectDialog(page).getByRole("button", { name: "Add project" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectUrl = page.url();

  rmSync(goneRepo, { recursive: true, force: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Project switcher" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem").filter({ hasText: goneRepo })).toContainText(
    "folder missing",
  );
  await expect(menu.getByRole("menuitem").filter({ hasText: fixtureRepo() })).not.toContainText(
    "folder missing",
  );
  await page.keyboard.press("Escape");

  // The project page disables New map, with the reason, and lists the folder as a start blocker.
  await page.goto(projectUrl);
  await expect(page.getByRole("button", { name: "New map" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New map" })).toHaveAccessibleDescription(
    new RegExp(goneRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  await expect(projectBlockers(page)).toHaveAttribute("data-code", "project_folder_missing");
});

test("starts a map from the Inbox composer and lands on Idea with the rail and Activity", async ({
  page,
}) => {
  await page.goto("/");
  const composer = page.getByRole("region", { name: "New map" });
  const start = composer.getByRole("button", { name: "Start map" });
  await composer.getByLabel("Idea").fill(IDEA);
  await expect(start).toBeDisabled();
  await composer.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option").filter({ hasText: fixtureRepo() }).click();
  await start.click();

  await expect(page).toHaveURL(MAP_URL);
  const match = MAP_URL.exec(page.url());
  if (match?.[1] === undefined) {
    throw new Error(`No map id in ${page.url()}`);
  }
  mapId = match[1];

  // The agent charts the map in the background; the top bar then names it by its title, and the
  // need-you badge counts the map, whose destination round waits on the person.
  await expect(page.getByRole("banner").getByRole("link", { name: CHARTED_TITLE })).toBeVisible();
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Inbox · 1 needs you" }),
  ).toBeVisible();

  const links = rail(page).getByRole("link");
  await expect(links).toHaveCount(STAGE_NAMES.length);
  for (const [i, name] of STAGE_NAMES.entries()) {
    await expect(links.nth(i)).toContainText(name);
  }
  await expect(rail(page).locator("a[aria-current=page]")).toHaveCount(1);
  await expect(rail(page).locator("a[aria-current=page]")).toContainText("Idea");

  // The map started, the agent charted it and asked about the destination: two Idea lines and
  // one Wayfinding line.
  const lines = activity(page).getByRole("listitem");
  await expect(lines).toHaveCount(3);
  await activity(page).getByRole("button", { name: "Show activity for" }).click();
  await page.getByRole("menuitemradio", { name: "Idea only" }).click();
  await expect(lines).toHaveCount(2);
  for (const link of await lines.getByRole("link", { name: "Idea" }).all()) {
    await expect(link).toHaveAttribute("href", `/maps/${mapId}/idea`);
  }
  await expect(lines.getByRole("link", { name: "Idea" })).toHaveCount(2);

  await page.reload();
  await expect(page).toHaveURL(MAP_URL);
  await expect(rail(page).locator("a[aria-current=page]")).toContainText("Idea");
});

test("redirects a map to Idea, moves through the rail, and keeps the route on reload", async ({
  page,
}) => {
  await page.goto(`/maps/${mapId}`);
  await expect(page).toHaveURL(`/maps/${mapId}/idea`);
  await expect(rail(page).locator("a[aria-current=page]")).toContainText("Idea");
  await expect(activity(page)).toBeVisible();

  for (const [stage, name] of [
    ["spec", "Spec"],
    ["tickets", "Tickets"],
  ] as const) {
    await rail(page).locator(`a[href="/maps/${mapId}/${stage}"]`).click();
    await expect(page).toHaveURL(`/maps/${mapId}/${stage}`);
    await expect(rail(page).locator("a[aria-current=page]")).toContainText(name);
    await expect(activity(page)).toBeVisible();
  }

  // Delivery keeps the Activity stream but has no escape hatch.
  await rail(page).locator(`a[href="/maps/${mapId}/delivery"]`).click();
  await expect(page).toHaveURL(`/maps/${mapId}/delivery`);
  await expect(rail(page).locator("a[aria-current=page]")).toContainText("Delivery");
  await expect(activity(page)).toBeVisible();
  await expect(activity(page).getByRole("button", { name: /Tell the agent/ })).toHaveCount(0);

  await page.reload();
  await expect(page).toHaveURL(`/maps/${mapId}/delivery`);
  await expect(rail(page).locator("a[aria-current=page]")).toContainText("Delivery");

  // The map has no spec revision yet, so revision 1 is an unknown number: the route error, kept
  // on reload. `drafts.spec.ts` opens `?revision=1` on a map that has it.
  await page.goto(`/maps/${mapId}/spec?revision=1`);
  await expect(routeError(page)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(`/maps/${mapId}/spec?revision=1`);
  await expect(routeError(page)).toBeVisible();
});

test("shows the route error for an unknown stage, a non-UUIDv7 id and an invalid search value", async ({
  page,
}) => {
  for (const path of [
    `/maps/${mapId}/nowhere`,
    "/maps/not-a-uuid/idea",
    "/maps/00000000-0000-4000-8000-000000000000",
    "/projects/not-a-uuid",
    `/maps/${mapId}/spec?revision=abc`,
    `/maps/${mapId}/spec?revision=0`,
    `/maps/${mapId}/tickets?version=1.5`,
    `/maps/${mapId}/delivery?run=-1`,
    `/maps/${mapId}/idea?run=1`,
  ]) {
    await page.goto(path);
    await expect(routeError(page), path).toBeVisible();
  }
});

test("the colour scheme menu chooses light, dark or the system's, kept across a reload", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  const menu = page.getByRole("button", { name: "Colour scheme" });

  // No choice follows the system: light here.
  await expect(html).not.toHaveClass(/dark/);
  await menu.click();
  await expect(page.getByRole("menuitemradio", { name: "System" })).toBeChecked();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(html).toHaveClass(/dark/);

  // The choice is stored, so it is on from the first paint of the next load.
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await menu.click();
  await expect(page.getByRole("menuitemradio", { name: "Dark" })).toBeChecked();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(html).not.toHaveClass(/dark/);

  // System follows the media query as it changes; a dark system with the light choice does not.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).not.toHaveClass(/dark/);
  await menu.click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  await expect(html).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  await page.reload();
  await expect(html).not.toHaveClass(/dark/);
});
