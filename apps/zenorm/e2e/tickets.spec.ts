import { writeFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";
import { HatchMessageView } from "@zenorm/contracts";

import { ticketsRepairHeld, ticketsRepairReleaseFile, ticketsRepo } from "./fixture.ts";
import {
  addProjectInNewPage,
  approveSpec,
  approveTicketSet,
  chartAndClearMap,
  nextCard,
  openStage,
  rail,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * The tickets review flows on the stand-in: a review that passes, one that fails once and is
 * repaired, three failing versions held and fixed through the hatch, a decision finding held at
 * once, a stopped review and Try again, and a set with a criterion already done. Each scenario
 * starts a new map in its own project (`ticketsRepo()`), clears it and approves its spec; the
 * stand-in's tickets markers ride in the idea. Tests assert status, tone and presence, with fixed
 * labels and the stand-in's fixed titles.
 */

const FIRST_TICKET = "Write the CSV exporter";
const SECOND_TICKET = "Add the Export button";
const REVISED = " (revised)";
const HATCH_ROW = "Need something the stages don't offer? Tell the agent";
const OPEN_TICKETS = "Open the tickets";
const TELL_AGENT = "Tell the agent how to fix it";
const TICKETS_STAGE_URL = /\/maps\/[0-9a-f-]+\/tickets\/(\d+)$/;

// Each scenario starts its own map, so they run at once on different workers, each on its own
// server; `beforeAll` adds the project there.
test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, ticketsRepo());
});

function activity(page: Page): Locator {
  return page.getByRole("complementary", { name: "Activity" });
}

function composerField(page: Page): Locator {
  return activity(page).getByLabel("Message to the agent");
}

function messages(page: Page): Locator {
  return activity(page).getByRole("listitem", { name: "Your message" });
}

/** The stream's "Open the tickets" links: one per recorded tickets review. */
function ticketsLinks(page: Page): Locator {
  return activity(page).getByRole("link", { name: OPEN_TICKETS, exact: true });
}

function ticketsStageLink(page: Page, mapId: string): Locator {
  return rail(page).locator(`a[href="/maps/${mapId}/tickets"]`);
}

/** The Tickets review panel right of the page head. */
function panel(page: Page): Locator {
  return page.getByLabel("Tickets review", { exact: true });
}

function badge(page: Page): Locator {
  return panel(page).locator('[data-slot="badge"]');
}

async function expectBadge(page: Page, label: string, tone: "work" | "ok" | "bad"): Promise<void> {
  await expect(badge(page)).toHaveText(label);
  await expect(badge(page)).toHaveAttribute("data-variant", tone);
}

function coverage(page: Page): Locator {
  return page.getByRole("region", { name: "Coverage", exact: true });
}

function coverageRow(page: Page, criterion: string): Locator {
  return coverage(page).locator(`tr[data-criterion="${criterion}"]`);
}

/** Criterion 1.1's text, as the canned spec writes it. */
const FIRST_CRITERION = "Exporting writes every record as one CSV row.";

/**
 * Criterion 1.1, plainly worked by T1, shows its text once, on T1's card: Coverage counts it and lists
 * no row of it.
 */
async function expectFirstOnCardOnly(page: Page): Promise<void> {
  await expect(coverageRow(page, "1.1")).toHaveCount(0);
  await expect(coverage(page).getByText(FIRST_CRITERION)).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "What T1 delivers" }).getByText(FIRST_CRITERION),
  ).toHaveCount(1);
}

function ticketHeading(page: Page, name: string): Locator {
  return page.getByRole("list", { name: "Tickets" }).getByRole("heading", { name, exact: true });
}

function cardHeading(page: Page, name: string): Locator {
  return nextCard(page).getByRole("heading", { name, exact: true });
}

/** Charts and clears a map with `idea`, approves its spec and opens Tickets. */
async function specApproved(page: Page, idea: string): Promise<string> {
  const mapId = await chartAndClearMap(page, ticketsRepo(), idea);
  await approveSpec(page);
  await openStage(page, mapId, "tickets");
  return mapId;
}

/** The spec number an "Open the tickets" link opens, after clicking it. */
async function openTickets(page: Page): Promise<number> {
  await ticketsLinks(page).last().click();
  await expect(page).toHaveURL(TICKETS_STAGE_URL);
  const number = TICKETS_STAGE_URL.exec(page.url())?.[1];
  if (number === undefined) {
    throw new Error(`No spec number in ${page.url()}`);
  }
  return Number(number);
}

test("a passing review: the panel, the card and Coverage; Open the tickets; approve; a reload keeps them", async ({
  page,
}) => {
  const mapId = await specApproved(page, "Export records, reviewed once");

  await expect(cardHeading(page, "Approve the tickets.")).toBeVisible();
  await expectBadge(page, "review passed", "ok");
  await expect(nextCard(page).getByRole("button", { name: "Reject with a reason" })).toBeVisible();
  await expect(coverage(page)).toContainText("2 need work");
  await expect(coverage(page).getByRole("table")).toHaveCount(0);
  await expectFirstOnCardOnly(page);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  await expect(ticketHeading(page, `T2 ${SECOND_TICKET}`)).toBeVisible();
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · awaiting approval");

  // The review's activity line links the spec's tickets.
  await expect(ticketsLinks(page)).toHaveCount(1);
  await openTickets(page);
  await expectBadge(page, "review passed", "ok");

  await page.reload();
  await expectBadge(page, "review passed", "ok");
  await expect(cardHeading(page, "Approve the tickets.")).toBeVisible();
  await expectFirstOnCardOnly(page);

  await approveTicketSet(page);
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · approved");
  await page.reload();
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · approved");

  // The approved set hands off to Delivery's action: the project has no required checks yet.
  await expect(nextCard(page)).toContainText("Start delivery is unavailable.");
  await expect(coverage(page)).toBeVisible();
  await nextCard(page).getByRole("link", { name: "Set required checks" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/settings$/);
});

test("[fake:tickets-fail-once]: v1 fails, the repair writes v2, which passes and is approved", async ({
  page,
}) => {
  const mapId = await specApproved(
    page,
    `Export records [fake:tickets-fail-once] ${ticketsRepairHeld("tickets")}`,
  );

  // The repair runs (held by the stand-in until released): its own status row.
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · review findings");
  await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toHaveCount(0);
  writeFileSync(ticketsRepairReleaseFile("tickets"), "");

  await expect(cardHeading(page, "Approve the tickets.")).toBeVisible();
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}${REVISED}`)).toBeVisible();
  await expectBadge(page, "review passed", "ok");
  // v1's failed review and v2's passed one each have a line.
  await expect(ticketsLinks(page)).toHaveCount(2);
  await approveTicketSet(page);
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · approved");
});

test("[fake:tickets-held]: three failing versions hold the set; the card opens the hatch; a note's v4 is approved", async ({
  page,
}) => {
  const mapId = await specApproved(page, "Export records [fake:tickets-held]");

  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · review needs you");
  await expect(ticketsLinks(page)).toHaveCount(3);
  const spec = await openTickets(page);
  await expect(cardHeading(page, `${TELL_AGENT}.`)).toBeVisible();
  await expectBadge(page, "1 finding", "bad");

  // The card shows each escalated finding's title and question once (the detail line is
  // omitted), one hatch button, and no Approve or Reject.
  const findings = nextCard(page).getByRole("list", { name: "Escalated findings" });
  await expect(findings.getByRole("listitem")).toHaveCount(1);
  // Each finding shows its title and its question.
  await expect(findings.getByRole("listitem").locator(":scope > span")).toHaveCount(2);
  const findingTitle = (
    await findings.getByRole("listitem").locator("span").first().innerText()
  ).trim();
  await expect(nextCard(page).getByText(findingTitle, { exact: true })).toHaveCount(1);
  await expect(nextCard(page).getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(nextCard(page).getByRole("button", { name: "Reject with a reason" })).toHaveCount(0);
  await page.reload();
  await expect(findings.getByRole("listitem")).toHaveCount(1);

  // The button opens and focuses the composer and sends nothing: no message, and no
  // approve or reject request.
  const sent = await messages(page).count();
  const decisions: string[] = [];
  const recordDecision = (request: { url: () => string }) => {
    if (/\/rpc\/ticketSet\/(approve|reject)/.test(request.url())) {
      decisions.push(request.url());
    }
  };
  page.on("request", recordDecision);
  await nextCard(page).getByRole("button", { name: TELL_AGENT }).click();
  await expect(composerField(page)).toBeFocused();
  await expect(activity(page).getByRole("button", { name: HATCH_ROW })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(messages(page)).toHaveCount(sent);
  page.off("request", recordDecision);
  expect(decisions).toEqual([]);

  // The note is stored with the held spec's number and rewrites the set as v4.
  const note = "Split the exporter from the button. [fake:hatch-tickets]";
  await composerField(page).fill(note);
  const response = page.waitForResponse((r) => r.url().includes("/rpc/hatch/send"));
  await activity(page).getByRole("button", { name: "Send", exact: true }).click();
  const body: unknown = await (await response).json();
  expect(storedSpec(body, note)).toBe(spec);
  await expect(messages(page)).toHaveCount(sent + 1);

  await expect(cardHeading(page, "Approve the tickets.")).toBeVisible();
  await expect(ticketsLinks(page)).toHaveCount(4);
  await expectBadge(page, "review passed", "ok");
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}${REVISED}`)).toBeVisible();
  await approveTicketSet(page);
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · approved");
});

test("[fake:tickets-decision]: a decision finding holds the set after v1", async ({ page }) => {
  const mapId = await specApproved(page, "Export records [fake:tickets-decision]");

  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · review needs you");
  await expect(cardHeading(page, `${TELL_AGENT}.`)).toBeVisible();
  await expectBadge(page, "1 finding", "bad");
  await expect(
    nextCard(page).getByRole("list", { name: "Escalated findings" }).getByRole("listitem"),
  ).toHaveCount(1);
  // No repair: v1's review stays the only one.
  await page.reload();
  await expect(ticketsLinks(page)).toHaveCount(1);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · review needs you");
});

test("[fake:fail-twice:tickets-review]: a stopped tickets review offers Try again, which reviews the set", async ({
  page,
}) => {
  const mapId = await specApproved(page, "Export records [fake:fail-twice:tickets-review]");

  const card = nextCard(page);
  await expect(ticketsStageLink(page, mapId)).toContainText("Tickets review stopped");
  await expect(ticketsStageLink(page, mapId)).not.toContainText("agent_run_failed");
  await expect(card.locator("[data-code=agent_run_failed]")).toBeVisible();
  await expect(card).not.toContainText("agent_run_failed");
  await expectBadge(page, "review stopped", "bad");
  await page.reload();
  await expect(card.locator("[data-code=agent_run_failed]")).toBeVisible();

  await card.getByRole("button", { name: "Try again" }).click();
  await expect(cardHeading(page, "Approve the tickets.")).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expectBadge(page, "review passed", "ok");
  await approveTicketSet(page);
  await expect(ticketsStageLink(page, mapId)).toContainText("2 tickets · approved");
});

test("[fake:tickets-already-done]: Coverage shows the criterion already done with its evidence; a long summary is clamped", async ({
  page,
}) => {
  const mapId = await specApproved(
    page,
    "Export records [fake:tickets-already-done] [fake:tickets-long-summary]",
  );

  await expect(cardHeading(page, "Approve the tickets.")).toBeVisible();
  // A real reviewer's long summary shows clamped, with Show more to expand it.
  const summary = panel(page).getByTestId("tickets-review-summary");
  await expect(summary).toHaveCSS("-webkit-line-clamp", "4");
  await panel(page).getByRole("button", { name: "Show more" }).click();
  await expect(summary).toHaveCSS("-webkit-line-clamp", "none");
  await panel(page).getByRole("button", { name: "Show less" }).click();
  await expect(summary).toHaveCSS("-webkit-line-clamp", "4");
  await expect(coverage(page)).toContainText("1 need work");
  await expect(coverage(page)).toContainText("1 already done");
  const done = coverageRow(page, "2.1");
  await expect(done.locator('[data-slot="badge"]')).toHaveText("already done");
  await expect(done.locator('[data-slot="badge"]')).toHaveAttribute("data-variant", "ok");
  await expect(done).toContainText("No ticket needed.");
  await expect(done).toContainText("src/project-page.tsx");
  await expectFirstOnCardOnly(page);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  await expect(ticketHeading(page, `T2 ${SECOND_TICKET}`)).toHaveCount(0);
  await page.reload();
  await expect(done).toContainText("No ticket needed.");
  await approveTicketSet(page);
  await expect(ticketsStageLink(page, mapId)).toContainText("1 ticket · approved");
});

/** The spec number `hatch.send`'s overview stores on the message `text` (oRPC's `json` body). */
function storedSpec(body: unknown, text: string): number | null {
  const json = typeof body === "object" && body !== null && "json" in body ? body.json : undefined;
  const list =
    typeof json === "object" && json !== null && "messages" in json ? json.messages : undefined;
  const message = HatchMessageView.array()
    .parse(list)
    .find((entry) => entry.text === text);
  if (message === undefined) {
    throw new Error("hatch.send's overview carries no message with the note's text");
  }
  return message.spec;
}
