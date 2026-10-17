import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  COUNTS_PATH,
  EXAMPLE_EXECUTOR_LINE,
  ExampleCounts,
  REFUSED_DELIVERY_REASON,
} from "@zenorm/plugin-example/manifest";
import { webDistDir } from "@zenorm/web";
import {
  addProject,
  approvedMap,
  confirmDestination,
  nextCard,
  saveChecks,
  specRun,
  startDelivery,
  startDeliveryForm,
  startMap,
} from "@zenorm/zenorm/e2e/flows";

import { e2eRoot, repo, SEEDED_FILE } from "./fixture.ts";

/**
 * The example composition's flows (S9-20), on one server and one database, in order: the access
 * denial, first thing after the server starts (CR9b-1); the slots, the raw route and the
 * subscriber's count; the admission refusal; a delivery run through the `example` executor; and
 * the set-mismatch page of a web build composed without the plugin.
 */
test.describe.configure({ mode: "serial" });

const PASSING_CHECK = "git status --short";

async function counts(page: Page): Promise<ExampleCounts> {
  const response = await page.request.get(COUNTS_PATH);
  expect(response.status()).toBe(200);
  return ExampleCounts.parse(await response.json());
}

/** The project section's count, as the page shows it ("<n> rows", "1 row"). */
async function shownCount(page: Page): Promise<number> {
  const text = await page
    .getByRole("region", { name: "Example plugin", exact: true })
    .getByTestId("example-project-count")
    .textContent();
  const match = /^(\d+) rows?$/.exec(text === null ? "" : text.trim());
  if (match?.[1] === undefined) throw new Error(`The project section shows ${String(text)}`);
  return Number(match[1]);
}

test("first thing after start, a project deniedProjectNames names, and its map, show access_denied", async ({
  page,
}) => {
  const seeded: unknown = JSON.parse(readFileSync(join(e2eRoot(), SEEDED_FILE), "utf8"));
  if (
    typeof seeded !== "object" ||
    seeded === null ||
    !("projectId" in seeded) ||
    !("mapId" in seeded)
  ) {
    throw new Error(`${SEEDED_FILE} holds ${JSON.stringify(seeded)}`);
  }
  const { projectId, mapId } = seeded;

  // The Inbox's first project list leaves the denied project out: the seeded project is the only
  // one, so the Inbox offers Add project.
  await page.goto("/");
  await expect(page.getByRole("region", { name: "No projects" })).toBeVisible();
  await expect(page.getByText("denied-repo")).toHaveCount(0);

  // The refusal is the error page (UX review P2-19): its heading, then the access sentence.
  await page.goto(`/projects/${String(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Access denied" })).toBeVisible();
  await expect(
    page.getByText(`You do not have access to project ${String(projectId)}.`),
  ).toBeVisible();

  await page.goto(`/maps/${String(mapId)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Access denied" })).toBeVisible();
  await expect(
    page.getByText(`You do not have access to project ${String(projectId)}.`),
  ).toBeVisible();

  // The plugin's own counts route leaves the denied project out too (CR9b-13).
  expect(Object.keys((await counts(page)).projects)).not.toContain(String(projectId));
});

test("the three slots render, the raw route answers, and the project's count grows live", async ({
  page,
  context,
}) => {
  const projectId = await addProject(page, repo("example-repo"));
  await expect(page.getByRole("banner").getByText("Example plugin", { exact: true })).toBeVisible();
  const section = page.getByRole("region", { name: "Example plugin", exact: true });
  await expect(section.getByTestId("example-project-count")).toHaveText(/^\d+ rows?$/);
  expect((await counts(page)).seams.identify).toBeGreaterThan(0);

  const mapId = await startMap(page, repo("example-repo"), "Add a CSV export to the example");
  const aside = page.getByRole("region", { name: "Example plugin map" });
  await expect(aside).toContainText(mapId);
  await expect(page.getByRole("banner").getByText("Example plugin", { exact: true })).toBeVisible();

  // The project page stays open in a second tab while the destination round is answered in the
  // first; its count refreshes on the live layer's invalidation, with no reload.
  const projectPage = await context.newPage();
  await projectPage.goto(`/projects/${projectId}`);
  await expect(
    projectPage.getByRole("region", { name: "Example plugin", exact: true }),
  ).toBeVisible();
  await expect.poll(() => shownCount(projectPage)).toBeGreaterThan(0);
  const beforeAnswer = await shownCount(projectPage);
  await confirmDestination(page, mapId);
  const afterAnswer = (await counts(page)).projects[projectId];
  if (afterAnswer === undefined) throw new Error("The subscriber counted no row of the project");
  expect(afterAnswer).toBeGreaterThan(beforeAnswer);
  await expect.poll(() => shownCount(projectPage)).toBeGreaterThanOrEqual(afterAnswer);
  await projectPage.close();
});

test("Start delivery on a project refusedDeliveryProjectNames names shows the plugin's reason", async ({
  page,
}) => {
  await addProject(page, repo("refused-repo"));
  const mapId = await approvedMap(page, repo("refused-repo"), "Deliver the CSV export");
  await saveChecks(page, mapId, [PASSING_CHECK]);
  await page.goto(`/maps/${mapId}/delivery`);

  await startDeliveryForm(page).getByRole("button", { name: "Start delivery" }).click();

  await expect(page.getByText("delivery_not_admitted", { exact: true })).toBeVisible();
  await expect(page.getByText(REFUSED_DELIVERY_REASON)).toBeVisible();
});

test("a delivery run through the example executor ends ready to merge", async ({ page }) => {
  const before = await counts(page);
  const mapId = await approvedMap(page, repo("example-repo"), "Deliver the CSV export");
  await saveChecks(page, mapId, [PASSING_CHECK]);
  await page.goto(`/maps/${mapId}/delivery`);

  const run = await startDelivery(page);

  await expect.poll(async () => (await specRun(page, mapId, run.number, 1)).state).toBe("passed");
  await expect(page.getByText(EXAMPLE_EXECUTOR_LINE)).toBeVisible();
  await expect(page.getByText("Passed: a verified branch, ready to merge")).toBeVisible();
  await expect(nextCard(page).getByRole("button", { name: "Mark merged" })).toBeVisible();
  const after = await counts(page);
  expect(after.executor.implement - before.executor.implement).toBe(1);
  expect(after.executor.review - before.executor.review).toBe(1);
});

test("a web build composed with a different plugin list shows plugin_set_mismatch", async ({
  page,
}) => {
  // `@zenorm/web`'s own build, composed with no plugin (`apps/zenorm`'s), stands in for this
  // app's: the page's files come from it, and every API path still reaches the example server.
  await page.route("**/*", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (/^\/(rpc|plugins|events|healthz)(\/|$)/.test(pathname)) {
      await route.fallback();
      return;
    }
    const file = join(webDistDir, pathname);
    const isFile = existsSync(file) && statSync(file).isFile();
    await route.fulfill({ path: isFile ? file : join(webDistDir, "index.html") });
  });

  await page.goto("/");

  await expect(page.getByText("plugin_set_mismatch", { exact: true })).toBeVisible();
});
