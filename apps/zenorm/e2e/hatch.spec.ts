import { writeFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { hatchRepo, reviewReleaseFile } from "./fixture.ts";
import {
  APPROVE_SPEC,
  acceptAndSend,
  activity,
  addProjectInNewPage,
  answerMap,
  approveSpec,
  approveTicketSet,
  chartAndClearMap,
  composerField,
  confirmDestination,
  HATCH_ROW,
  messages,
  nextCard,
  openHatch,
  openWaypoint,
  questionRound,
  rail,
  replies,
  revisionLink,
  revisionList,
  send,
  sendAndAwaitReply,
  startMap,
  waypointIndex,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * Slice 7b's escape hatch flows on the stand-in (spec Testing Decisions): a question answered with
 * nothing changed, the clause footer's Ask, a reload, a stopped reply and Try again, a note on a
 * draft and on a ticket set, a note refused while a review runs, a reopen through to the next
 * revision, a waiting report accepted and a waypoint ruled out of scope, a failed task run again
 * and a waypoint added. Each scenario starts a new map in its own project (`hatchRepo()`); the
 * stand-in's change markers ride in the message. Tests assert presence and links (L100), with the
 * demo's fixed labels.
 */

const QUESTION = "Does nested mean any depth?";
const FIRST_TICKET = "Write the CSV exporter";
const REVISED = " (revised)";

// Each scenario starts its own map, so they run at once on different workers, each on its own
// server; `beforeAll` adds the project there.
test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  await addProjectInNewPage(browser, hatchRepo());
});

function eyebrow(page: Page, revision: number, state: "draft" | "approved"): Locator {
  return page.getByText(
    new RegExp(`^Spec(?: \\d+ of \\d+)? · revision ${String(revision)} · ${state} · saved `),
  );
}

function clause(page: Page, id: string): Locator {
  return page.locator(`#clause-${id}`);
}

function ticketHeading(page: Page, name: string): Locator {
  return page.getByRole("list", { name: "Tickets" }).getByRole("heading", { name, exact: true });
}

function indexGroup(page: Page, group: string): Locator {
  return waypointIndex(page).getByRole("region", { name: group, exact: true }).getByRole("link");
}

/** Every stage's rail line, to show a reply moved none. */
async function railText(page: Page): Promise<string> {
  return (await rail(page).innerText()).trim();
}

test("a question gets a reply and changes nothing; Ask prefills and sends nothing; a reload keeps the stream", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, hatchRepo(), "Export records, then ask about them");
  const before = await railText(page);

  // Opening the hatch shortens the stream, which scrolls to its end (demo `ActivityLog.tsx`,
  // L162 (2)); a short window makes the stream overflow.
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.reload();
  const newest = activity(page).getByRole("listitem").last();
  await expect(newest).toBeInViewport();
  await openHatch(page);
  await expect(newest).toBeInViewport();
  await activity(page).getByRole("button", { name: HATCH_ROW }).click();
  await expect(composerField(page)).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Ask prefills "About C1: " and focuses the composer; nothing is sent until Send (D7, L145).
  await clause(page, "C1").getByRole("button", { name: "Ask", exact: true }).click();
  await expect(composerField(page)).toBeFocused();
  await expect(composerField(page)).toHaveValue("About C1: ");
  await expect(messages(page)).toHaveCount(0);
  await clause(page, "C1").getByRole("button", { name: "Propose a change" }).click();
  await expect(composerField(page)).toHaveValue("C1 should ");
  await expect(composerField(page)).toBeFocused();
  await expect(messages(page)).toHaveCount(0);

  await sendAndAwaitReply(page, QUESTION);
  await expect(messages(page)).toContainText(QUESTION);
  await expect(page.getByText("Sent to the activity log →")).toBeVisible();
  // A reply changes no stage (S7b-4, D5): no revision, the same rail, the same decision.
  await expect(revisionLink(page, 2)).toHaveCount(0);
  await expect(nextCard(page).getByRole("button", { name: "Approve the spec" })).toBeVisible();
  expect(await railText(page)).toBe(before);

  await page.reload();
  await expect(messages(page)).toHaveCount(1);
  await expect(replies(page)).toHaveCount(1);
  await page.goto(`/maps/${mapId}/wayfinding`);
  await expect(messages(page)).toContainText(QUESTION);
  await expect(replies(page)).toHaveCount(1);
});

test("[fake:fail-twice:hatch]: a stopped reply offers Try again, which answers it", async ({
  page,
}) => {
  await startMap(page, hatchRepo(), "Export the data, then ask [fake:fail-twice:hatch]");
  await send(page, "What does this map cover?");
  const message = messages(page);
  await expect(message).toContainText("The agent couldn't reply.");
  await expect(replies(page)).toHaveCount(0);
  await page.reload();
  await message.getByRole("button", { name: "Try again" }).click();
  await expect(replies(page)).toHaveCount(1);
  await expect(message).not.toContainText("The agent couldn't reply.");
});

test("[fake:hatch-revise]: a note on a draft lands as the next revision, which links from the stream", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, hatchRepo(), "Export records, then note them");

  await sendAndAwaitReply(page, "[fake:hatch-revise] Name which records count.");
  await expect(eyebrow(page, 2, "draft")).toBeVisible();
  await expect(nextCard(page).getByRole("button", { name: "Approve the revision" })).toBeVisible();
  // The note is C1's source ("your note", S7b-11) and the stream links the revision (L159 (a)).
  await clause(page, "C1")
    .getByRole("button", { name: /^Details of C1: / })
    .click();
  await expect(clause(page, "C1")).toContainText("your note");
  const open = activity(page).getByRole("link", { name: "Open the revision" });
  await expect(open).toHaveCount(1);
  await expect(open).toHaveAttribute("href", new RegExp(`^/maps/${mapId}/spec/\\d+$`));
  await approveSpec(page);
  await expect(eyebrow(page, 2, "approved")).toBeVisible();
});

test("[fake:review-held]: a note while the review runs is refused; after it ends the same note is applied", async ({
  page,
}) => {
  const mapId = await answerMap(
    page,
    hatchRepo(),
    "Export records, held review [fake:review-held]",
  );
  await page.goto(`/maps/${mapId}/spec`);
  await expect(revisionLink(page, 1)).toContainText("review running");

  const note = "[fake:hatch-revise] Name which records count.";
  await sendAndAwaitReply(page, note);
  // Refused spec_in_flight (S7b-5): the refusal is the reply and the draft is unchanged.
  await expect(revisionLink(page, 2)).toHaveCount(0);
  await expect(revisionLink(page, 1)).toContainText("review running");

  writeFileSync(reviewReleaseFile(), "");
  await expect(revisionLink(page, 1)).toContainText("review passed");
  // Had the note been applied, its revision would be written by now.
  await expect(revisionLink(page, 2)).toHaveCount(0);
  await sendAndAwaitReply(page, note);
  await expect(eyebrow(page, 2, "draft")).toBeVisible();
  await expect(nextCard(page).getByRole("button", { name: "Approve the revision" })).toBeVisible();
});

test("[fake:hatch-tickets]: a ticket note rewrites the set to the next version", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, hatchRepo(), "Export records, then note the tickets");
  await approveSpec(page);
  await page.goto(`/maps/${mapId}/tickets`);
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}`)).toBeVisible();
  // A note while the tickets review runs is refused spec_in_flight (S7c-8): wait for its pass.
  await expect(nextCard(page).getByRole("heading", { name: "Approve the tickets." })).toBeVisible();

  await sendAndAwaitReply(page, "[fake:hatch-tickets] Split the exporter from the button.");
  await expect(ticketHeading(page, `T1 ${FIRST_TICKET}${REVISED}`)).toBeVisible();
  await expect(rail(page).locator(`a[href="/maps/${mapId}/tickets"]`)).toContainText(
    "2 tickets · awaiting approval",
  );
  await approveTicketSet(page);
});

test("[fake:hatch-reopen:2]: a reopen un-clears the map; the new round answered, it re-clears the draft in place and it is approved", async ({
  page,
}) => {
  const mapId = await chartAndClearMap(page, hatchRepo(), "Export records, then reopen one");

  const opensTwo = activity(page).locator(`a[href="/maps/${mapId}/wayfinding/2"]`);
  const linked = await opensTwo.count();
  await sendAndAwaitReply(page, "[fake:hatch-reopen:2] The encoding decision was wrong.");
  // Un-cleared (S7b-7): the draft asks no approval; the stream links the reopened waypoint.
  await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toHaveCount(0);
  await expect.poll(() => opensTwo.count()).toBeGreaterThan(linked);

  // The reopened waypoint asks a new round (L155 (d)), answered with the recommendations.
  await openWaypoint(page, mapId, 2);
  await expect(questionRound(page)).toBeVisible();
  await acceptAndSend(page);
  await expect(questionRound(page)).toHaveCount(0);

  // The re-clear rewrites the draft no one acted on in place (S7b-8, L241): still revision 1.
  await page.goto(`/maps/${mapId}/spec`);
  await expect(eyebrow(page, 1, "draft")).toBeVisible();
  await expect(revisionList(page).getByRole("link")).toHaveCount(1);
  await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toBeVisible();
  await approveSpec(page);
  await expect(eyebrow(page, 1, "approved")).toBeVisible();
});

test("[fake:hatch-accept-report:1] and [fake:hatch-out-of-scope:2]: a waiting report accepted, a waypoint ruled out", async ({
  page,
}) => {
  const mapId = await startMap(
    page,
    hatchRepo(),
    "Export the data, accept a report [fake:research-unanswered]",
  );
  await confirmDestination(page, mapId);
  await page.goto(`/maps/${mapId}/wayfinding`);
  await expect(indexGroup(page, "Waiting on you").first()).toContainText("report waiting");

  await sendAndAwaitReply(page, "[fake:hatch-accept-report:1] Take the report as it stands.");
  await expect(
    indexGroup(page, "Decisions so far").and(page.locator(`a[href="/maps/${mapId}/wayfinding/1"]`)),
  ).toHaveCount(1);

  const opensTwo = activity(page).locator(`a[href="/maps/${mapId}/wayfinding/2"]`);
  const linked = await opensTwo.count();
  await sendAndAwaitReply(page, "[fake:hatch-out-of-scope:2] Counting the fields is not needed.");
  const ruledOut = page.getByRole("region", { name: "Out of scope", exact: true });
  await expect(ruledOut.locator(`a[href="/maps/${mapId}/wayfinding/2"]`)).toHaveCount(1);
  await expect.poll(() => opensTwo.count()).toBeGreaterThan(linked);
});

test("[fake:hatch-run:2] and [fake:hatch-open]: a failed task runs again; a new waypoint is added", async ({
  page,
}) => {
  const mapId = await startMap(page, hatchRepo(), "Export the data, run again [fake:task-failed]");
  await confirmDestination(page, mapId);
  await page.goto(`/maps/${mapId}/wayfinding`);
  const taskLink = `a[href="/maps/${mapId}/wayfinding/2"]`;
  await expect(indexGroup(page, "Waiting on you").and(page.locator(taskLink))).toHaveCount(1);

  await sendAndAwaitReply(page, "[fake:hatch-run:2] Count them again.");
  await expect(indexGroup(page, "Decisions so far").and(page.locator(taskLink))).toHaveCount(1);

  await sendAndAwaitReply(page, "[fake:hatch-open] What should the file be called?");
  await expect(
    waypointIndex(page).locator(`a[href="/maps/${mapId}/wayfinding/4"]`),
  ).not.toHaveCount(0);
});
