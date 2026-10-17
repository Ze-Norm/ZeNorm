import type { Locator, Page } from "@playwright/test";

import { specsRepo } from "./fixture.ts";
import {
  APPROVE_SPEC,
  acceptWaypointRound,
  addProjectInNewPage,
  answerMap,
  approveSpec,
  approveTicketSet,
  chartAndClearMap,
  idFrom,
  mapOverview,
  nextCard,
  openWaypoint,
  rail,
  revisionList,
  waypointIndex,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * Slice 7's flows: several specs from one map, planning reviews that fail, escalate or ask for a
 * decision, rejections with a reason, and Try again on a stopped review. Each scenario starts a new
 * map in the file's own project (`specsRepo()`), so spec numbers continue across the file (they are per
 * project); a flow finds its specs' numbers from the switcher's URLs. Titles are the stand-in's.
 */

const SPEC_TITLE = "Export data as CSV";
const SECOND_SPEC_TITLE = "Import data from CSV";
const REVISED = " (revised)";
const FIRST_TICKET = "Write the CSV exporter";
const SECOND_TICKET = "Add the Export button";
/** The waypoint a review finding opens on the default three-waypoint chart (L136 (c)). */
const ESCALATED_WAYPOINT = 4;
/** The explanation of the `revise` finding the stand-in's review escalates (`fake-claude.ts`). */
const REVIEW_EXPLANATION = "C1 says “every record”, which no resolution settles.";
const SPEC_URL = /\/maps\/[0-9a-f-]+\/spec\/(\d+)/;

// Each scenario starts its own map, so they run at once on different workers, each on its own
// server; `beforeAll` adds the project there.
test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, specsRepo());
});

function title(page: Page): Locator {
  return page.getByRole("heading", { level: 1 });
}

function stageLink(page: Page, mapId: string, stage: "spec" | "tickets"): Locator {
  return rail(page).locator(`a[href="/maps/${mapId}/${stage}"]`);
}

function revisionLink(page: Page, revision: number): Locator {
  return revisionList(page).getByRole("link", {
    name: `Revision ${String(revision)}`,
    exact: true,
  });
}

function eyebrow(page: Page, revision: number, state: "draft" | "approved"): Locator {
  return page.getByText(
    new RegExp(`^Spec(?: \\d+ of \\d+)? · revision ${String(revision)} · ${state} · saved `),
  );
}

function ticketHeading(page: Page, name: string): Locator {
  return page.getByRole("list", { name: "Tickets" }).getByRole("heading", { name, exact: true });
}

function specTabs(page: Page): Locator {
  return page.getByRole("tablist", { name: "Specs" }).getByRole("tab");
}

/** Opens the spec tab or picker entry whose label starts with `name`; returns its spec number. */
async function openTab(page: Page, name: string): Promise<number> {
  await specTabs(page)
    .filter({ hasText: new RegExp(`^${name}`) })
    .click();
  await expect(page).toHaveURL(SPEC_URL);
  return Number(idFrom(SPEC_URL, page.url()));
}

/** Rejects the undecided draft on the page's next-action card with `reason`. */
async function reject(page: Page, subject: "the spec" | "the tickets", reason: string) {
  const card = nextCard(page);
  await card.getByRole("button", { name: "Reject with a reason" }).click();
  await card.getByLabel("Reason").fill(reason);
  await card.getByRole("button", { name: `Reject ${subject}`, exact: true }).click();
  await expect(card.getByRole("button", { name: `Reject ${subject}`, exact: true })).toHaveCount(0);
}

test("[fake:two-specs]: two specs show tabs; each is approved and ticketed on its own", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(
    page,
    specsRepo(),
    "Move records in and out [fake:two-specs]",
  );

  // Bare /spec opens the first spec, whose tab is selected; a tab opens its spec by number.
  await expect(specTabs(page)).toHaveCount(2);
  await expect(title(page)).toHaveText(SPEC_TITLE);
  const second = await openTab(page, SECOND_SPEC_TITLE);
  await expect(title(page)).toHaveText(SECOND_SPEC_TITLE);
  await expect(eyebrow(page, 1, "draft")).toBeVisible();
  const first = await openTab(page, SPEC_TITLE);
  expect(second).toBe(first + 1);
  await expect(title(page)).toHaveText(SPEC_TITLE);
  await approveSpec(page);
  await expect(stageLink(page, mapId, "spec")).toContainText(
    "1 of 2 specs done · Awaiting your approval",
  );

  // The first spec's tickets are written while the second still waits on its approval.
  await page.goto(`/maps/${mapId}/tickets/${String(first)}`);
  await expect(specTabs(page)).toHaveCount(2);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  await approveTicketSet(page);
  await expect(stageLink(page, mapId, "tickets")).toContainText("1 of 2 specs done");

  await page.goto(`/maps/${mapId}/spec/${String(second)}`);
  await approveSpec(page);
  await expect(stageLink(page, mapId, "spec")).toContainText("2 of 2 specs done");
  await page.goto(`/maps/${mapId}/tickets/${String(second)}`);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  await approveTicketSet(page);
  await expect(stageLink(page, mapId, "tickets")).toContainText("2 of 2 specs done");

  await page.reload();
  await expect(specTabs(page)).toHaveCount(2);
  await expect(stageLink(page, mapId, "spec")).toContainText("2 of 2 specs done");
  await expect(stageLink(page, mapId, "tickets")).toContainText("2 of 2 specs done");
});

test("[fake:four-specs]: four specs show the picker, the tally and Next waiting on you", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, specsRepo(), "Plan the exports [fake:four-specs]");
  const specs = page.getByRole("navigation", { name: "Specs" });
  const picker = specs.getByRole("combobox", { name: "Spec" });
  const nextWaiting = specs.getByRole("button", { name: "Next waiting on you" });

  await expect(specTabs(page)).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect(specs).toContainText("This map feeds 4 specs");
  await expect(specs).toContainText("· 4 need you here");
  await expect(nextWaiting).toBeVisible();

  // The picker lists every spec; choosing one opens it by its number.
  await picker.click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.getByRole("option").filter({ hasText: SECOND_SPEC_TITLE }).click();
  await expect(page).toHaveURL(SPEC_URL);
  const second = Number(idFrom(SPEC_URL, page.url()));
  await expect(title(page)).toHaveText(SECOND_SPEC_TITLE);

  await approveSpec(page);
  await expect(specs).toContainText("· 3 need you here");
  await expect(specs).toContainText("· 1 done");

  // Next waiting on you opens the next spec that needs you, onward from the one shown.
  await nextWaiting.click();
  await expect(page).toHaveURL(`/maps/${mapId}/spec/${String(second + 1)}`);
  await expect(title(page)).toHaveText("Schedule exports");

  await page.reload();
  await expect(title(page)).toHaveText("Schedule exports");
  await expect(specs).toContainText("· 3 need you here");
  await expect(stageLink(page, mapId, "spec")).toContainText("1 of 4 specs done");
});

test("[fake:review-fails-once]: r1's finding is repaired in place, and r1 passes; no new revision (L241)", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(
    page,
    specsRepo(),
    "Export records [fake:review-fails-once]",
  );

  await expect(title(page)).toHaveText(`${SPEC_TITLE}${REVISED}`);
  await expect(eyebrow(page, 1, "draft")).toBeVisible();
  await expect(nextCard(page).getByRole("heading", { name: "Approve the spec." })).toBeVisible();
  async function expectHistory(): Promise<void> {
    await expect(revisionList(page).getByRole("link")).toHaveCount(1);
    await expect(revisionLink(page, 1)).toContainText("review passed");
  }
  await expectHistory();
  await page.reload();
  await expectHistory();

  await approveSpec(page);
  await expect(eyebrow(page, 1, "approved")).toBeVisible();
  // The project page's chain of the spec lists the one revision (the screenshot's noise, L241).
  const overview = await mapOverview(page, mapId);
  const [spec] = overview.specs;
  if (spec === undefined) throw new Error("The map wrote no spec");
  await page.goto(`/projects/${overview.map.projectId}`);
  const chain = page
    .getByRole("region", { name: "Specs" })
    .getByRole("list", { name: `Revisions of spec ${String(spec.number)}` })
    .getByRole("listitem");
  await expect(chain).toHaveCount(1);
  await expect(chain.first()).toContainText("approved");
});

test("[fake:review-escalates]: the third failing review goes to Wayfinding; answered, the map re-clears and the next revision passes", async ({
  page,
}) => {
  const mapId = await answerMap(page, specsRepo(), "Export records [fake:review-escalates]");

  await page.goto(`/maps/${mapId}/spec`);
  await expect(stageLink(page, mapId, "spec")).toContainText("Review findings went to Wayfinding");
  // Each repair rewrote r1 in place (L241): one revision, its third review's finding showing.
  await expect(revisionList(page).getByRole("link")).toHaveCount(1);
  await expect(revisionLink(page, 1)).toContainText("1 finding");
  await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toHaveCount(0);
  await page.reload();
  await expect(stageLink(page, mapId, "spec")).toContainText("Review findings went to Wayfinding");

  // The finding opened waypoint 4, which names the spec it came from.
  await openWaypoint(page, mapId, ESCALATED_WAYPOINT);
  const fromReview = page.getByRole("region", { name: "Raised by the planning review" });
  await expect(fromReview).toBeVisible();
  await expect(fromReview).toContainText("· C1");
  // The finding's explanation waits behind Evidence.
  await expect(fromReview.getByText(REVIEW_EXPLANATION)).toHaveCount(0);
  await fromReview.getByRole("button", { name: "Evidence" }).click();
  await expect(fromReview.getByText(REVIEW_EXPLANATION)).toBeVisible();
  // With one spec on the map, the link opens the Spec stage without a number (D11).
  await fromReview.getByRole("link", { name: /^Spec \d+ · / }).click();
  await expect(page).toHaveURL(`/maps/${mapId}/spec`);
  await acceptWaypointRound(page, mapId, ESCALATED_WAYPOINT, 1);

  // The re-cleared map rewrites r1 in place; its review passes and it can be approved.
  await page.goto(`/maps/${mapId}/spec`);
  await expect(revisionList(page).getByRole("link")).toHaveCount(1);
  await expect(revisionLink(page, 1)).toContainText("review passed");
  await expect(nextCard(page).getByRole("heading", { name: "Approve the spec." })).toBeVisible();
  await approveSpec(page);
  await expect(eyebrow(page, 1, "approved")).toBeVisible();
  await page.reload();
  await expect(eyebrow(page, 1, "approved")).toBeVisible();
});

test("[fake:review-decision]: the first review opens a waypoint and starts no repair", async ({
  page,
}) => {
  const mapId = await answerMap(page, specsRepo(), "Export records [fake:review-decision]");

  await page.goto(`/maps/${mapId}/spec`);
  await expect(stageLink(page, mapId, "spec")).toContainText("Review findings went to Wayfinding");
  await expect(revisionLink(page, 1)).toContainText("2 findings");
  // No repair: revision 1 stays the only one while the decision waits on Wayfinding.
  await page.reload();
  await expect(revisionList(page).getByRole("link")).toHaveCount(1);
  await expect(stageLink(page, mapId, "spec")).toContainText("Review findings went to Wayfinding");

  await page.goto(`/maps/${mapId}/wayfinding`);
  await expect(
    waypointIndex(page).locator(
      `a[href="/maps/${mapId}/wayfinding/${String(ESCALATED_WAYPOINT)}"]`,
    ),
  ).toHaveCount(1);
  await acceptWaypointRound(page, mapId, ESCALATED_WAYPOINT, 1);

  // The re-clear rewrites r1 in place (L241).
  await page.goto(`/maps/${mapId}/spec`);
  await expect(revisionList(page).getByRole("link")).toHaveCount(1);
  await expect(revisionLink(page, 1)).toContainText("review passed");
  await approveSpec(page);
  await expect(eyebrow(page, 1, "approved")).toBeVisible();
});

test("reject with a reason: the spec gets a new revision, the ticket set a version 2", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, specsRepo(), "Export records, then reject them");

  await reject(page, "the spec", "Name which records count.");
  await expect(eyebrow(page, 2, "draft")).toBeVisible();
  await expect(revisionLink(page, 1)).toContainText("rejected");
  await expect(revisionList(page)).toContainText("Rejected: Name which records count.");
  await expect(
    nextCard(page).getByRole("heading", { name: "Approve the revised spec." }),
  ).toBeVisible();
  await page.reload();
  await expect(revisionLink(page, 1)).toContainText("rejected");
  await approveSpec(page);

  await page.goto(`/maps/${mapId}/tickets`);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  // Reject waits for the passed tickets review, as Approve does (S7c-7).
  await expect(nextCard(page).getByRole("heading", { name: "Approve the tickets." })).toBeVisible();
  await reject(page, "the tickets", "Split the exporter from the button.");
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}${REVISED}`)).toBeVisible();
  await expect(ticketHeading(page, `T2 ${SECOND_TICKET}${REVISED}`)).toBeVisible();
  await expect(stageLink(page, mapId, "tickets")).toContainText("2 tickets · awaiting approval");
  await page.reload();
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}${REVISED}`)).toBeVisible();
  await approveTicketSet(page);
  await expect(stageLink(page, mapId, "tickets")).toContainText("2 tickets · approved");
});

test("[fake:fail-twice:review]: a stopped planning review offers Try again, which reviews the draft", async ({
  page,
}) => {
  const mapId = await answerMap(page, specsRepo(), "Export records [fake:fail-twice:review]");

  await page.goto(`/maps/${mapId}/spec`);
  const card = nextCard(page);
  // The rail's line and the card are human, never a code (L141; UX audit P1-1): the card's
  // detail carries the code as `data-code`.
  await expect(stageLink(page, mapId, "spec")).toContainText("Planning review stopped");
  await expect(stageLink(page, mapId, "spec")).not.toContainText("agent_run_failed");
  await expect(card.locator("[data-code=agent_run_failed]")).toBeVisible();
  await expect(card).not.toContainText("agent_run_failed");
  await expect(revisionLink(page, 1)).toContainText("review stopped");
  await page.reload();
  await expect(card.locator("[data-code=agent_run_failed]")).toBeVisible();

  await card.getByRole("button", { name: "Try again" }).click();
  await expect(revisionLink(page, 1)).toContainText("review passed");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await approveSpec(page);
  await expect(eyebrow(page, 1, "approved")).toBeVisible();
});
