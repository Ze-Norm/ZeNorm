import type { Page } from "@playwright/test";

import { draftsRepo } from "./fixture.ts";
import {
  acceptWaypointRound,
  addProjectInNewPage,
  approveSpec,
  approveTicketSet,
  chartAndClearMap,
  confirmDestination,
  nextCard,
  openStage,
  rail,
  revisionList,
  startDeliveryForm,
  startMap,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/** Runs on its own project (`draftsRepo()`). Titles are the stand-in's canned drafts. */
const SPEC_TITLE = "Export data as CSV";
const FIRST_TICKET = "Write the CSV exporter";
const SECOND_TICKET = "Add the Export button";
/** The stand-in fails this map's first To Spec call and its retry, so the Spec stage stops. */
const SPEC_STOPS_IDEA = "Let people take their records elsewhere, again [fake:fail-twice:spec]";

// Each scenario starts its own map, so they run at once on different workers, each on its own
// server; `beforeAll` adds the project there.
test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, draftsRepo());
});

function title(page: Page) {
  return page.getByRole("heading", { level: 1 });
}

/** The rail's link to `stage`, which carries the stage's status line (D8). */
function stageLink(page: Page, mapId: string, stage: "spec" | "tickets") {
  return rail(page).locator(`a[href="/maps/${mapId}/${stage}"]`);
}

test("writes, reviews and approves a spec, then writes and approves its tickets", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(
    page,
    draftsRepo(),
    "Let people take their records elsewhere",
  );

  // Spec: revision 1 is written, its planning review passes, and it waits on the person (D8, D9).
  await expect(title(page)).toHaveText(SPEC_TITLE);
  await expect(page.getByText(/^Spec · revision 1 · draft · saved /)).toBeVisible();
  await expect(stageLink(page, mapId, "spec")).toContainText("Awaiting your approval");
  await expect(nextCard(page).getByRole("heading", { name: "Approve the spec." })).toBeVisible();
  await expect(revisionList(page).getByRole("link", { name: "Revision 1" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("navigation", { name: "Spec index" })).toBeVisible();
  // Each clause shows what it declares it adds (RC1), folded behind its details toggle.
  await page.getByRole("button", { name: /^Details of C1: / }).click();
  await expect(page.getByLabel("What C1 adds")).toHaveText("AddsCSV export");

  await approveSpec(page);
  await expect(page.getByText(/^Spec · revision 1 · approved · saved /)).toBeVisible();
  await expect(stageLink(page, mapId, "spec")).toContainText("Approved");

  // Tickets: the tickets are written by themselves and wait on the person (D8, D10).
  await openStage(page, mapId, "tickets");
  await expect(page.getByText(/^Tickets · revision 1 · /)).toBeVisible();
  const tickets = page.getByRole("list", { name: "Tickets" });
  await expect(
    tickets.getByRole("heading", { name: `T1 ${FIRST_TICKET}`, exact: true }),
  ).toBeVisible();
  await expect(
    tickets.getByRole("heading", { name: `T2 ${SECOND_TICKET}`, exact: true }),
  ).toBeVisible();
  await expect(stageLink(page, mapId, "tickets")).toContainText("2 tickets · awaiting approval");
  // Each card leads with the criteria it delivers, as their text; its build is folded away.
  await expect(tickets.getByRole("group", { name: "What T1 delivers" })).toContainText(
    "Exporting writes every record as one CSV row.",
  );
  await expect(tickets.getByRole("group", { name: "What T2 delivers" })).toContainText(
    "The project page offers the export.",
  );
  await expect(tickets.getByText("Turn the stored records into CSV rows.")).toBeHidden();
  await tickets.getByRole("button", { name: "How it's built" }).first().click();
  await expect(tickets.getByText("Turn the stored records into CSV rows.")).toBeVisible();
  await expect(nextCard(page).getByRole("heading", { name: "Approve the tickets." })).toBeVisible();
  await approveTicketSet(page);
  await expect(stageLink(page, mapId, "tickets")).toContainText("2 tickets · approved");

  async function expectApproved(): Promise<void> {
    await page.goto(`/maps/${mapId}/spec`);
    await expect(page.getByText(/^Spec · revision 1 · approved · saved /)).toBeVisible();
    await expect(nextCard(page).getByRole("button", { name: "Approve the spec" })).toHaveCount(0);
    await page.goto(`/maps/${mapId}/tickets`);
    await expect(stageLink(page, mapId, "tickets")).toContainText("2 tickets · approved");
    await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toHaveCount(
      0,
    );
    // The approved set reaches Delivery: the project has no required checks yet, so the quiet
    // card says why and links Project settings; there is no Start delivery form (UX audit D1).
    await page.goto(`/maps/${mapId}/delivery`);
    await expect(nextCard(page)).toHaveAttribute("data-tone", "blocker");
    await expect(nextCard(page).getByRole("link", { name: "Set required checks" })).toBeVisible();
    await expect(startDeliveryForm(page)).toHaveCount(0);
  }
  await expectApproved();
  await page.reload();
  await expectApproved();

  // A revision the map does not have is the route error.
  await page.goto(`/maps/${mapId}/spec?revision=3`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Could not open this page" }),
  ).toBeVisible();
});

test("a To Spec run that fails twice stops with its code and Try again writes revision 1", async ({
  page,
}) => {
  const mapId = await startMap(page, draftsRepo(), SPEC_STOPS_IDEA);
  await confirmDestination(page, mapId);
  await acceptWaypointRound(page, mapId, 1, 1);
  await acceptWaypointRound(page, mapId, 1, 2);
  await acceptWaypointRound(page, mapId, 2, 1);
  await acceptWaypointRound(page, mapId, 3, 1);

  await openStage(page, mapId, "spec");
  const card = nextCard(page);
  // The card says why in a sentence, marked with the code (UX audit P1-1).
  await expect(card.locator("[data-code=agent_run_failed]")).toBeVisible();
  await expect(card).not.toContainText("agent_run_failed");
  await card.getByRole("button", { name: "Try again" }).click();

  await expect(title(page)).toHaveText(SPEC_TITLE);
  await expect(revisionList(page).getByRole("link")).toHaveCount(1);
  await expect(card.locator("[data-code]")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Approve the spec" })).toBeVisible();
});
