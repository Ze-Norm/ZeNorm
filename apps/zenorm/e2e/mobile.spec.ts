import type { Locator, Page } from "@playwright/test";

import { fixtureRepo } from "./fixture.ts";
import { addProject, chartAndClearMap, composer, nextCard, rail, startMap } from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * The layout on a phone: every page fits the viewport's width, the Inbox composer's Start map
 * stays reachable once a project is chosen (its folder path is in the option, not the trigger),
 * the stage rail shows every stage's name without a tooltip, the Activity column opens as a sheet
 * from the top bar, and the Spec page's Jump to list stays in the viewport. The tests build on one another in order.
 */
const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, hasTouch: true, isMobile: true });
test.describe.configure({ mode: "serial" });

let mapId: string;

/** Fails when anything runs past the viewport's right edge. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
}

/** Whether the element's box is inside the viewport horizontally. */
async function expectWithinViewport(element: Locator): Promise<void> {
  const box = await element.boundingBox();
  if (box === null) throw new Error("The element has no box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
}

test("the Inbox composer keeps Start map in the viewport once a project is chosen", async ({
  page,
}) => {
  await addProject(page, fixtureRepo());
  await page.goto("/");
  await expectNoHorizontalOverflow(page);
  const newMap = composer(page);
  await newMap.getByLabel("Idea").fill("Let people export their data");
  await newMap.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option").filter({ hasText: fixtureRepo() }).click();
  await expectWithinViewport(newMap.getByRole("button", { name: "Start map" }));
  await expectNoHorizontalOverflow(page);
});

test("the project page and its settings fit", async ({ page }) => {
  mapId = await startMap(page, fixtureRepo(), "Let people export their data");
  await page.getByRole("button", { name: "Project switcher" }).click();
  await page.getByRole("menuitem").filter({ hasText: fixtureRepo() }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  await expectNoHorizontalOverflow(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await page.getByLabel("Required checks").fill("git status --short");
  await expectWithinViewport(page.getByRole("button", { name: "Add check" }));
});

test("a map's pages fit, the rail shows every stage name, and Activity opens as a sheet", async ({
  page,
}) => {
  await page.goto(`/maps/${mapId}/idea`);
  await expect(nextCard(page)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // Every stage's name shows, under its number, and is not cut, down to a 320px phone.
  const stages = rail(page);
  for (const width of [PHONE.width, 320]) {
    await page.setViewportSize({ width, height: PHONE.height });
    for (const name of ["Idea", "Wayfinding", "Spec", "Tickets", "Delivery"]) {
      const text = stages.getByText(name, { exact: true });
      await expect(text).toBeVisible();
      expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  }
  await page.setViewportSize(PHONE);
  // A touch screen has no tooltips: focusing a stage, which opens its tooltip where a pointer can
  // hover, shows none (a tap would show it only for the press).
  await stages.getByRole("link", { name: /Delivery/ }).focus();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  // The top bar shows the inbox count without its sentence, which stays for assistive technology.
  await expect(
    page.getByRole("banner").getByRole("link", { name: /^Inbox · 1 needs you$/ }),
  ).toBeVisible();

  await page.goto(`/maps/${mapId}/wayfinding`);
  await expectNoHorizontalOverflow(page);

  await page.goto(`/maps/${mapId}/wayfinding/destination`);
  await expectNoHorizontalOverflow(page);

  // The column is not in the page; the top bar's button opens it as a sheet.
  await expect(page.getByRole("complementary", { name: "Activity" })).toHaveCount(0);
  await page.getByRole("button", { name: "Activity" }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("complementary", { name: "Activity" })).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
});

test("the Spec page's Jump to list stays in the viewport", async ({ page }) => {
  // The flow's helpers find the waypoint index beside the page, which is there from `md`.
  await page.setViewportSize({ width: 1280, height: PHONE.height });
  const specMap = await chartAndClearMap(page, fixtureRepo(), "Let people import their data");
  await page.setViewportSize(PHONE);
  await page.goto(`/maps/${specMap}/spec`);
  await page.getByRole("combobox", { name: "Spec index" }).click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expectWithinViewport(list);
});
