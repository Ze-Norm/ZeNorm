import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  composerRepo,
  nestedInnerRepo,
  nestedOuterRepo,
  noCommitRepo,
  projectsRepo,
} from "./fixture.ts";
import {
  addProject,
  addProjectInNewPage,
  addProjectDialog,
  approvedMap,
  checkFolder,
  expectQuietRow,
  idFrom,
  inboxGroup,
  mapRowLink,
  nextCard,
  openAddProject,
  PROJECT_URL,
  projectBlockers,
  projectDetail,
  startDeliveryForm,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/** Adds its own project (`projectsRepo()`) first, so the switcher has one to list. */
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, projectsRepo());
});

test("a project is still listed in the switcher after a reload, under its derived name", async ({
  page,
}) => {
  await page.goto("/");
  await page.reload();
  await page.getByRole("button", { name: "Project switcher" }).click();
  const item = page.getByRole("menu").getByRole("menuitem").filter({ hasText: projectsRepo() });
  await expect(item).toContainText("projects-repo");
  await item.click();
  await expect(
    page.getByRole("heading", { name: "projects-repo", level: 1, exact: true }),
  ).toBeVisible();
});

test("Project settings save an app start command, its URL and a setup command, read back after a reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Project switcher" }).click();
  await page.getByRole("menu").getByRole("menuitem").filter({ hasText: projectsRepo() }).click();
  await expect(page).toHaveURL(PROJECT_URL);
  const projectId = idFrom(PROJECT_URL, page.url());
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(`/projects/${projectId}/settings`);

  const start = page.getByLabel("App start command");
  const url = page.getByLabel("App URL");
  await expect(start).toHaveValue("");
  await expect(url).toHaveValue("");
  await expect(page.getByText("None. The app needs no setup.")).toBeVisible();

  await page.getByLabel("Repair limit").fill("0");
  await start.fill("pnpm dev");
  await url.fill("http://localhost:5173");
  await page.getByLabel("App setup commands").fill("pnpm install");
  await page.getByRole("button", { name: "Add setup command" }).click();
  const setup = page.getByRole("button", { name: "Remove setup command pnpm install" });
  await expect(setup).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  await page.reload();
  await expect(start).toHaveValue("pnpm dev");
  await expect(url).toHaveValue("http://localhost:5173");
  await expect(setup).toBeVisible();
  expect(await projectDetail(page, projectId)).toMatchObject({
    appStartCommand: "pnpm dev",
    appUrl: "http://localhost:5173",
    appSetupCommands: ["pnpm install"],
  });
});

test("refuses a folder inside a project by code, and accepts a repository nested in one", async ({
  page,
}) => {
  await addProject(page, nestedOuterRepo());
  const plain = join(nestedOuterRepo(), "src");
  await mkdir(plain, { recursive: true });

  await page.goto("/");
  await openAddProject(page);
  const dialog = addProjectDialog(page);
  const add = dialog.getByRole("button", { name: "Add project" });

  await checkFolder(page, plain);
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  await expect(dialog.getByRole("alert")).toContainText("project_inside_project");
  await expect(add).toBeDisabled();

  await checkFolder(page, nestedInnerRepo());
  await expect(dialog.getByLabel("Base branch · detected, confirm it")).toHaveValue("main");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(add).toBeEnabled();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("adds a repository with no commit: planning works and Start delivery is disabled with its reason", async ({
  page,
}) => {
  await page.goto("/");
  await openAddProject(page);
  const dialog = addProjectDialog(page);
  await checkFolder(page, noCommitRepo());
  await expect(dialog.getByText("no-commit-repo", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Base branch · detected, confirm it")).toHaveValue("main");
  await expect(dialog.getByText(/Start delivery waits for a commit on main/)).toBeVisible();
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);

  // The project page lists the blockers by their codes: no commit, and no required checks or
  // repair limit yet.
  const blockers = projectBlockers(page);
  await expect(blockers).toHaveCount(3);
  await expect(blockers.nth(0)).toHaveAttribute("data-code", "project_branch_missing");
  await expect(blockers.nth(1)).toHaveAttribute("data-code", "project_checks_missing");
  await expect(blockers.nth(2)).toHaveAttribute("data-code", "project_repair_limit_missing");
  const composer = page.getByRole("region", { name: "New map" });
  await expect(composer).toHaveCount(0);
  await page.getByRole("button", { name: "New map" }).click();
  await expect(composer.getByLabel("Idea")).toBeEnabled();
  await composer.getByRole("button", { name: "Cancel" }).click();
  await expect(composer).toHaveCount(0);

  // Planning runs to an approved ticket set; the Delivery stage then shows the same reason, under
  // core's `nobody` action: the map is quiet, not waiting on the person.
  const mapId = await approvedMap(
    page,
    noCommitRepo(),
    "Plan a change in a repository with no commit",
  );
  // The quiet card lists every blocker and links Project settings; it has no Start delivery form
  // to disable.
  await expect(nextCard(page)).toHaveAttribute("data-who", "nobody");
  await expect(nextCard(page)).toHaveAttribute("data-tone", "blocker");
  await expect(startDeliveryForm(page)).toHaveCount(0);
  const reasons = nextCard(page).getByRole("list", { name: "Why Start delivery is unavailable" });
  await expect(reasons.getByRole("listitem")).toHaveCount(3);
  await expect(reasons.getByRole("listitem").nth(0)).toHaveAttribute(
    "data-code",
    "project_branch_missing",
  );
  await expect(reasons.getByRole("listitem").nth(1)).toHaveAttribute(
    "data-code",
    "project_checks_missing",
  );
  await expect(reasons.getByRole("listitem").nth(2)).toHaveAttribute(
    "data-code",
    "project_repair_limit_missing",
  );
  await expect(nextCard(page).getByRole("link", { name: "Set required checks" })).toBeVisible();
  await page.goto("/");
  await expectQuietRow(page, (quiet) => mapRowLink(quiet, mapId));
  await expect(mapRowLink(inboxGroup(page, "Needs you"), mapId)).toHaveCount(0);
});

test("adds a project from the Inbox composer's project list, which then selects it", async ({
  page,
}) => {
  const idea = "Plan a change in a project added from the composer";
  await page.goto("/");
  const composer = page.getByRole("region", { name: "New map" });
  const project = composer.getByRole("combobox", { name: "Project" });
  await composer.getByLabel("Idea").fill(idea);
  await project.click();
  await page.getByRole("option", { name: "Add project…" }).click();

  const dialog = addProjectDialog(page);
  await expect(dialog).toBeVisible();
  await checkFolder(page, composerRepo());
  await expect(dialog.getByLabel("Base branch · detected, confirm it")).toHaveValue("main");
  await dialog.getByRole("button", { name: "Add project" }).click();
  await expect(dialog).toBeHidden();

  // The Inbox stays open with the idea kept and the new project chosen, ready to start.
  await expect(page).toHaveURL(/\/$/);
  await expect(project).toHaveText("composer-repo");
  await expect(composer.getByLabel("Idea")).toHaveValue(idea);
  await expect(composer.getByRole("button", { name: "Start map" })).toBeEnabled();
});
