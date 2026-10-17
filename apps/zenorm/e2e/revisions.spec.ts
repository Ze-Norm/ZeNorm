import { rmSync, writeFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";
import type { MapSpec, TicketSetView } from "@zenorm/contracts";

import {
  releaseRunReleaseFile,
  revisionRepo,
  ticketsRepairHeld,
  ticketsRepairReleaseFile,
} from "./fixture.ts";
import type { RevisionFlow } from "./fixture.ts";
import {
  activity,
  addProject,
  answerMap,
  APPROVE_SPEC,
  approvedMap,
  approveSpec,
  approveTicketSet,
  deliverAndMarkMerged,
  expectQuietRow,
  inboxGroup,
  mapOverview,
  mapRowLink,
  nextCard,
  openWaypoint,
  projectDetail,
  revisionLink,
  revisionList,
  saveChecks,
  sendAndAwaitReply,
  startDeliveryForm,
} from "./flows.ts";
import { expect, test } from "./worker-server.ts";

/**
 * The revision flows. Each flow adds its own project, whose first map's spec r1
 * (`[fake:three-criteria]`: 1.1, 1.2, 2.1) is delivered through a real `git merge` and Mark merged;
 * later maps carry `[fake:revise:1]`, so their chart touches spec 1 and To Spec writes its next
 * revision: 1.1 kept, 1.2 changed, 2.1 removed, 2.2 added. States, tones and codes are read from
 * the page's roles, labels and data attributes, and from `map.overview` and `project.get`, the
 * reads every page shares.
 */
const PASSING_CHECK = "git status --short";
const FIRST_IDEA = "Export records [fake:three-criteria]";

/**
 * Each flow is a group of serial steps on its own project; the groups share nothing, so they run
 * at once on different workers, each on its worker's own server.
 */
test.describe.configure({ mode: "parallel" });

/**
 * What each flow's earlier steps made, for its later steps: a flow's steps run in order in one
 * worker, each within Playwright's default test timeout.
 */
interface Made {
  projectId: string;
  /** The first map, whose r1 is delivered. */
  firstMapId: string;
  /** The map that writes r2 ("revise", "wait": map A). */
  laterMapId?: string;
  /** The "wait" flow's map B. */
  waitingMapId?: string;
}
const made = new Map<RevisionFlow, Made>();

function madeFor(flow: RevisionFlow): Made {
  const entry = made.get(flow);
  if (entry === undefined) {
    throw new Error(`The ${flow} flow's first step did not run`);
  }
  return entry;
}

function mapOf(id: string | undefined, what: string): string {
  if (id === undefined) {
    throw new Error(`An earlier step did not record ${what}`);
  }
  return id;
}

// A failed flow releases a held release run at once rather than leaving it up to 20 s.
test.afterEach(() => {
  writeFileSync(releaseRunReleaseFile(), "");
});

/** Adds the flow's project and approves its first map's spec r1 and ticket set. */
async function approveFirstMap(page: Page, flow: RevisionFlow): Promise<void> {
  const projectId = await addProject(page, revisionRepo(flow));
  const firstMapId = await approvedMap(page, revisionRepo(flow), FIRST_IDEA);
  made.set(flow, { projectId, firstMapId });
}

/**
 * Delivers the flow's first map's r1: the required check saved, the run passed, merged into `main`
 * and marked merged.
 */
async function deliverFirstMap(page: Page, flow: RevisionFlow): Promise<void> {
  const { firstMapId } = madeFor(flow);
  await saveChecks(page, firstMapId, [PASSING_CHECK]);
  const run = await deliverAndMarkMerged(page, firstMapId, revisionRepo(flow));
  expect(run.number).toBe(1);
}

/** The map's spec 1, as `map.overview` reports it. */
async function specOne(page: Page, mapId: string): Promise<MapSpec> {
  const spec = (await mapOverview(page, mapId)).specs.find((entry) => entry.number === 1);
  if (spec === undefined) {
    throw new Error(`Map ${mapId} shows no spec 1`);
  }
  return spec;
}

/** The latest version of the map's ticket set for spec 1's revision `revision`. */
async function latestSet(page: Page, mapId: string, revision: number): Promise<TicketSetView> {
  const sets = (await specOne(page, mapId)).ticketSets.filter((set) => set.revision === revision);
  const set = sets.at(-1);
  if (set === undefined) {
    throw new Error(`Map ${mapId} has no ticket set for revision ${String(revision)}`);
  }
  return set;
}

/** The Spec page's Revisions row of a revision another map wrote, by its link to that map. */
function otherMapRevision(page: Page, mapId: string): Locator {
  return revisionList(page)
    .getByRole("listitem")
    .filter({ has: page.locator(`a[href="/maps/${mapId}/spec/1"]`) });
}

/** A shadcn badge by its text, so its tone (`data-variant`) can be asserted. */
function badge(scope: Locator, text: string): Locator {
  return scope.locator('[data-slot="badge"]').getByText(text, { exact: true });
}

/** The Spec page's wait card; its `data-wait` is the hold kind, "released" or "unheld". */
function waitCard(page: Page): Locator {
  return page.getByRole("region", { name: "Waiting on another map" }).getByRole("article");
}

function reconciliation(page: Page): Locator {
  return page.getByRole("region", { name: "What this revision needs from the code" });
}

function reconciliationRow(page: Page, criterion: string): Locator {
  return reconciliation(page).locator(`tr[data-criterion="${criterion}"]`);
}

function ticketCard(page: Page, ticket: string): Locator {
  return page.getByRole("list", { name: "Tickets" }).locator(`li#ticket-${ticket}`);
}

/** A criterion on a ticket's card, where its text and its change badge read. */
function cardCriterion(page: Page, ticket: string, criterion: string): Locator {
  return ticketCard(page, ticket).locator(`li[data-criterion="${criterion}"]`);
}

/** The shown run's ticket row for `ticket`; its `data-state` is the ticket's status. */
function runTicketRow(page: Page, ticket: string): Locator {
  return page.getByRole("list", { name: "Tickets" }).locator(`li[data-ticket="${ticket}"]`);
}

/** Answers a later map's rounds, opens its Spec page and waits for its revision's approval. */
async function laterMapRevision(page: Page, flow: RevisionFlow, idea: string): Promise<string> {
  const mapId = await answerMap(page, revisionRepo(flow), idea);
  await page.goto(`/maps/${mapId}/spec`);
  await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toBeVisible();
  return mapId;
}

/** Approves the shown revision, then opens Tickets once its tickets review passed. */
async function approveAndOpenTickets(page: Page, mapId: string): Promise<void> {
  await approveSpec(page);
  await page.goto(`/maps/${mapId}/tickets`);
}

/**
 * Declares, in the flow's group, its first two steps: the project's first map's r1 and tickets
 * approved, then delivered and marked merged.
 */
function firstMapSteps(flow: RevisionFlow): void {
  test(`${flow}: the project's first map has spec r1 and its tickets approved`, async ({
    page,
  }) => {
    await approveFirstMap(page, flow);
  });
  test(`${flow}: the first map's r1 is delivered and marked merged`, async ({ page }) => {
    await deliverFirstMap(page, flow);
  });
}

test.describe("revise", () => {
  test.describe.configure({ mode: "serial" });

  firstMapSteps("revise");

  test("a later map's chart touches the delivered spec; To Spec writes r2 of it with its text delta", async ({
    page,
  }) => {
    const revise = madeFor("revise");
    const first = revise.firstMapId;
    const laterId = await answerMap(
      page,
      revisionRepo("revise"),
      "Export more records [fake:revise:1]",
    );
    revise.laterMapId = laterId;

    // Wayfinding: waypoint 1 touches the delivered spec 1 on its changed criterion.
    await openWaypoint(page, laterId, 1);
    const touch = page.getByRole("region", { name: "Changes a delivered spec" });
    await expect(touch).toHaveAttribute("data-spec", "1");
    await expect(touch.locator('[data-criterion="1.2"]')).toBeVisible();
    await page.reload();
    await expect(touch.locator('[data-criterion="1.2"]')).toBeVisible();
    const touched = (await mapOverview(page, laterId)).wayfinding.waypoints.filter(
      (waypoint) => waypoint.touches.length > 0,
    );
    expect(touched.map((waypoint) => waypoint.number)).toEqual([1]);
    expect(touched[0]?.touches.map((entry) => [entry.specNumber, entry.revision])).toEqual([
      [1, 1],
    ]);

    // Spec: r2 of the same spec, its text delta, and r1 delivered from the first map.
    async function expectRevisionTwo(): Promise<void> {
      await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toBeVisible();
      await expect(revisionLink(page, 2)).toBeVisible();
      const delivered = badge(otherMapRevision(page, first), "delivered");
      await expect(delivered).toHaveAttribute("data-variant", "ok");
      const changes = page.getByRole("region", { name: "What the revision changes" });
      await expect(changes.locator(`a[href="/maps/${first}/spec/1"]`).first()).toBeVisible();
    }
    await page.goto(`/maps/${laterId}/spec`);
    await expectRevisionTwo();
    await page.reload();
    await expectRevisionTwo();
    const laterSpec = await specOne(page, laterId);
    expect(laterSpec.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(laterSpec.revisions.at(-1)?.delta).toMatchObject({
      before: 1,
      after: 2,
      removedCriteria: [{ criterion: expect.objectContaining({ id: "2.1" }) }],
    });

    // The first map's Spec page: a later map revises this spec.
    async function expectRevisedLater(): Promise<void> {
      const revisedLater = page.getByRole("region", { name: "A later map revises this spec" });
      await expect(revisedLater.getByRole("link", { name: "Open r2" })).toHaveAttribute(
        "href",
        `/maps/${laterId}/spec/1`,
      );
      await expect(badge(revisionLink(page, 1), "delivered")).toHaveAttribute("data-variant", "ok");
    }
    await page.goto(`/maps/${first}/spec`);
    await expectRevisedLater();
    await page.reload();
    await expectRevisedLater();
  });

  test("approving r2 reconciles it: carried over, follow-ups, taken out and the earlier tickets", async ({
    page,
  }) => {
    const laterId = mapOf(madeFor("revise").laterMapId, "the revise flow's later map");
    await page.goto(`/maps/${laterId}/spec`);
    await approveAndOpenTickets(page, laterId);
    async function expectReconciliation(): Promise<void> {
      await expect(
        nextCard(page).getByRole("button", { name: "Approve the tickets" }),
      ).toBeVisible();
      await expect(badge(reconciliationRow(page, "1.1"), "carries over · T1")).toHaveAttribute(
        "data-variant",
        "ok",
      );
      await expect(badge(reconciliationRow(page, "2.1"), "taken out · T4")).toHaveAttribute(
        "data-variant",
        "bad",
      );
      // A criterion that plainly needs work reads once, on its ticket's card, with its text change.
      await expect(reconciliationRow(page, "1.2")).toHaveCount(0);
      await expect(reconciliationRow(page, "2.2")).toHaveCount(0);
      await expect(badge(cardCriterion(page, "T3", "1.2"), "changed")).toBeVisible();
      await expect(badge(cardCriterion(page, "T4", "2.2"), "new")).toBeVisible();
      await expect(cardCriterion(page, "T3", "1.2").locator('[data-was="changed"]')).toBeVisible();
      await expect(ticketCard(page, "T3").locator('a[href$="#ticket-T1"]')).toBeVisible();
      await expect(ticketCard(page, "T4").locator('a[href$="#ticket-T2"]')).toBeVisible();
      await expect(ticketCard(page, "T1")).toHaveCount(0);
      const earlier = page.getByRole("region", { name: "Earlier tickets of this spec" });
      await expect(earlier.locator('[data-revision="1"]')).toBeVisible();
      await expect(badge(earlier, "delivered").first()).toHaveAttribute("data-variant", "ok");
    }
    await expectReconciliation();
    await page.reload();
    await expectReconciliation();
    const set = await latestSet(page, laterId, 2);
    expect(set.content.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterion: "1.1", kind: "delivered", ticket: "T1" }),
        expect.objectContaining({ criterion: "1.2", kind: "work", ticket: "T3" }),
        expect.objectContaining({ criterion: "2.1", kind: "removed", ticket: "T4" }),
        expect.objectContaining({ criterion: "2.2", kind: "work", ticket: "T4" }),
      ]),
    );
    expect(set.content.tickets.map((ticket) => [ticket.id, ticket.followUp])).toEqual([
      ["T3", "T1"],
      ["T4", "T2"],
    ]);
    expect(set.followUps.T3).toMatchObject({ ticket: "T1", revision: 1, run: 1 });
    await approveTicketSet(page);
  });

  test("run 2 pins only the new tickets and passes; the project page shows spec 1's chain with both runs", async ({
    page,
  }) => {
    const revise = madeFor("revise");
    const first = revise.firstMapId;
    const laterId = mapOf(revise.laterMapId, "the revise flow's later map");
    const run = await deliverAndMarkMerged(page, laterId, revisionRepo("revise"));
    expect(run.number).toBe(2);
    expect(run.tickets?.map((ticket) => ticket.ticket)).toEqual(["T3", "T4"]);
    await page.reload();
    await expect(runTicketRow(page, "T3")).toHaveAttribute("data-state", "merged");
    await expect(runTicketRow(page, "T4")).toHaveAttribute("data-state", "merged");
    await expect(runTicketRow(page, "T1")).toHaveCount(0);
    // Each map's Delivery page shows its own run: both runs stand.
    await page.goto(`/maps/${first}/delivery`);
    await expect(runTicketRow(page, "T1")).toHaveAttribute("data-state", "merged");
    await expect(runTicketRow(page, "T3")).toHaveCount(0);

    // The project page: r1 from the first map and r2 from the later one, delivered by run 2.
    async function expectChain(): Promise<void> {
      const row = page.getByRole("region", { name: "Specs" }).locator('[data-spec="1"]');
      await expect(badge(row, "delivered · run 2")).toHaveAttribute("data-variant", "ok");
      const chain = row.getByRole("list", { name: "Revisions of spec 1" }).getByRole("listitem");
      await expect(chain.nth(0).getByRole("link")).toHaveAttribute("href", `/maps/${first}/spec/1`);
      await expect(chain.nth(1).getByRole("link")).toHaveAttribute(
        "href",
        `/maps/${laterId}/spec/1`,
      );
    }
    await page.goto(`/projects/${revise.projectId}`);
    await expectChain();
    await page.reload();
    await expectChain();
    const [projectSpec] = (await projectDetail(page, revise.projectId)).specs;
    expect(projectSpec?.mergedRun).toEqual({ number: 2, revision: 2 });
    expect(projectSpec?.revisions.map((revision) => [revision.revision, revision.mapId])).toEqual([
      [1, first],
      [2, laterId],
    ]);
  });

  test("[fake:nothing-new]: a third revision changing only Out of scope is confirmed and reads Nothing to deliver", async ({
    page,
  }) => {
    // The "revise" project's spec 1 is at r2, which took 2.1 out and was delivered.
    const mapId = await laterMapRevision(
      page,
      "revise",
      "Keep the records as they are [fake:revise:1] [fake:nothing-new]",
    );
    await expect(revisionLink(page, 3)).toBeVisible();
    await approveAndOpenTickets(page, mapId);

    const confirm = nextCard(page).getByRole("button", { name: "Confirm", exact: true });
    await expect(confirm).toBeVisible();
    await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("list", { name: "Tickets" })).toHaveCount(0);
    const set = await latestSet(page, mapId, 3);
    expect(set.content.tickets).toEqual([]);
    expect(new Set(set.content.dispositions.map((disposition) => disposition.kind))).toEqual(
      new Set(["delivered"]),
    );
    await page.reload();
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(confirm).toHaveCount(0);

    async function expectNothingToDeliver(): Promise<void> {
      await expect(nextCard(page)).toHaveAttribute("data-who", "nobody");
      await expect(startDeliveryForm(page)).toHaveCount(0);
    }
    await page.goto(`/maps/${mapId}/delivery`);
    await expectNothingToDeliver();
    await page.reload();
    await expectNothingToDeliver();
    const [, , delivery] = (await specOne(page, mapId)).stages;
    expect(delivery.tone).toBe("done");
  });

  test("[fake:hatch-revise]: a note on a delivered spec writes its next revision", async ({
    page,
  }) => {
    // The "revise" project's first map: spec 1 is at r3 (approved), r2 delivered.
    const firstMapId = madeFor("revise").firstMapId;
    await page.goto(`/maps/${firstMapId}/spec`);
    await sendAndAwaitReply(page, "[fake:hatch-revise] Name which records count.");
    async function expectNoteRevision(): Promise<void> {
      await expect(revisionLink(page, 4)).toBeVisible();
      await expect(nextCard(page).getByRole("button", { name: APPROVE_SPEC })).toBeVisible();
      await expect(
        activity(page).getByRole("link", { name: "Open the revision" }).last(),
      ).toHaveAttribute("href", `/maps/${firstMapId}/spec/1`);
    }
    await expectNoteRevision();
    await page.reload();
    await expectNoteRevision();
    const spec = await specOne(page, firstMapId);
    expect(spec.revisions.at(-1)).toMatchObject({ revision: 4, state: "draft", mapId: firstMapId });
  });
});

test.describe("departure", () => {
  test.describe.configure({ mode: "serial" });

  firstMapSteps("departure");

  test("[fake:departure]: a departure with a reason passes the tickets review and shows its reason", async ({
    page,
  }) => {
    const mapId = await laterMapRevision(
      page,
      "departure",
      "Export more records [fake:revise:1] [fake:departure]",
    );
    await approveAndOpenTickets(page, mapId);
    async function expectDeparture(): Promise<void> {
      await expect(
        nextCard(page).getByRole("button", { name: "Approve the tickets" }),
      ).toBeVisible();
      await expect(reconciliationRow(page, "1.1").locator('[data-departure="1.1"]')).toBeVisible();
      await expect(badge(reconciliationRow(page, "1.1"), "needs work · T3")).toBeVisible();
    }
    await expectDeparture();
    await page.reload();
    await expectDeparture();
    const set = await latestSet(page, mapId, 2);
    expect(set.version).toBe(1);
    expect(set.review?.state).toBe("passed");
    expect(set.readings["1.1"]?.departure?.reason).toEqual(expect.any(String));
  });
});

test.describe("departure-no-reason", () => {
  test.describe.configure({ mode: "serial" });

  firstMapSteps("departure-no-reason");

  test("[fake:departure-no-reason]: the review fails disposition_without_reason once and the repair gives the reason", async ({
    page,
  }) => {
    rmSync(ticketsRepairReleaseFile("revisions"), { force: true });
    const mapId = await laterMapRevision(
      page,
      "departure-no-reason",
      `Export more records [fake:revise:1] [fake:departure-no-reason] ${ticketsRepairHeld("revisions")}`,
    );
    await approveAndOpenTickets(page, mapId);

    // Version 1 gave the departure no reason: its review failed with one finding, coded,
    // shown on the Tickets review panel while the stand-in holds the repair.
    const findings = page.getByLabel("Tickets review", { exact: true }).locator("[data-kind]");
    await expect(findings).toHaveCount(1);
    await expect(findings).toHaveAttribute("data-kind", "disposition_without_reason");
    await expect(findings).toHaveAttribute("data-route", "revise");
    writeFileSync(ticketsRepairReleaseFile("revisions"), "");

    await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toBeVisible();
    await expect(reconciliationRow(page, "1.1").locator('[data-departure="1.1"]')).toBeVisible();
    const repaired = await latestSet(page, mapId, 2);
    expect(repaired.version).toBe(2);
    expect(repaired.review?.state).toBe("passed");
    expect(repaired.readings["1.1"]?.departure?.reason).toEqual(expect.any(String));
    await page.reload();
    await expect(reconciliationRow(page, "1.1").locator('[data-departure="1.1"]')).toBeVisible();
  });
});

test.describe("wait", () => {
  test.describe.configure({ mode: "serial" });

  firstMapSteps("wait");

  test("a wait: map B, changing spec 1 while map A holds its draft r2, waits and is quiet in the Inbox", async ({
    page,
  }) => {
    const wait = madeFor("wait");
    const mapA = await laterMapRevision(page, "wait", "Export more records [fake:revise:1]");
    wait.laterMapId = mapA;
    await expect(revisionLink(page, 2)).toBeVisible();

    // Map B records a wait on A's hold.
    const mapB = await answerMap(
      page,
      revisionRepo("wait"),
      "Export even more records [fake:revise:1] [fake:release-held]",
    );
    wait.waitingMapId = mapB;
    await page.goto(`/maps/${mapB}/spec`);
    const card = waitCard(page);
    async function expectWaiting(): Promise<void> {
      await expect(card).toHaveAttribute("data-wait", "revision");
      await expect(card.locator(`a[href="/maps/${mapA}/spec/1"]`)).toBeVisible();
      // B's waypoint 1 touches the latest approved r1, so the wait names it.
      await expect(card.locator(`a[href="/maps/${mapB}/wayfinding/1"]`)).toBeVisible();
      await expect(nextCard(page)).toHaveAttribute("data-who", "another-map");
    }
    await expectWaiting();
    await page.reload();
    await expectWaiting();
    const [waitView] = (await mapOverview(page, mapB)).waits;
    expect(waitView?.hold).toMatchObject({ kind: "revision", mapId: mapA, revision: 2 });

    // The wait line's "See what waits" opens B's page of spec 1, which B only waits on: the wait
    // card over the waited spec's latest revision, A's r2, read only.
    await page.getByRole("link", { name: "See what waits" }).click();
    await expect(page).toHaveURL(`/maps/${mapB}/spec/1`);
    async function expectWaitedSpec(): Promise<void> {
      await expect(card).toHaveAttribute("data-wait", "revision");
      await expect(nextCard(page)).toHaveAttribute("data-who", "another-map");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        (await specOne(page, mapA)).title,
      );
      await expect(page.getByRole("heading", { name: "Problem", exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Spec index" })).toBeVisible();
    }
    await expectWaitedSpec();
    await page.reload();
    await expectWaitedSpec();

    // Typed Tickets and Delivery routes of the waited spec render the stage B has not
    // reached, with its wait's Next card, not a route error. With no spec of its own
    // there, the head names the map.
    const mapBTitle = (await mapOverview(page, mapB)).map.title;
    if (mapBTitle === null) throw new Error("Map B has no title");
    await page.goto(`/maps/${mapB}/tickets/1`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(mapBTitle);
    await expect(page.getByRole("main").getByText("Tickets", { exact: true })).toBeVisible();
    await expect(nextCard(page)).toHaveAttribute("data-who", "another-map");
    await page.goto(`/maps/${mapB}/delivery/1`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(mapBTitle);
    await expect(
      page.getByRole("main").getByText("Delivery · not started", { exact: true }),
    ).toBeVisible();
    await expect(nextCard(page)).toHaveAttribute("data-who", "another-map");

    // The Inbox: B is quiet; its row's action opens the holder's revision, on map A.
    const { status } = await mapOverview(page, mapB);
    expect(status.next.map((action) => [action.who, action.onMap])).toEqual([
      ["another-map", mapA],
    ]);
    await page.goto("/");
    await expectQuietRow(page, (quiet) => quiet.locator(`a[href="/maps/${mapA}/spec"]`).first());
    // A's own row needs you (Approve the revision); B's is not among those rows.
    await expect(mapRowLink(inboxGroup(page, "Needs you"), mapA)).toBeVisible();
    await expect(mapRowLink(inboxGroup(page, "Needs you"), mapB)).toHaveCount(0);
  });

  test("a wait is released once A's tickets and their review end: B's r3 is written and A's set is replaced", async ({
    page,
    browser,
  }) => {
    const wait = madeFor("wait");
    const mapA = mapOf(wait.laterMapId, "the wait flow's map A");
    const mapB = mapOf(wait.waitingMapId, "the wait flow's map B");
    rmSync(releaseRunReleaseFile(), { force: true });

    // B's Spec page stays open (no reload) while A's r2 is approved in another tab.
    const pageB = await browser.newPage();
    await pageB.goto(`/maps/${mapB}/spec`);
    await expect(waitCard(pageB)).toHaveAttribute("data-wait", "revision");
    await page.goto(`/maps/${mapA}/spec`);
    await approveSpec(page);
    // A's tickets and their review end; B's release run then writes (held by the stand-in).
    await page.goto(`/maps/${mapA}/tickets`);
    await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toBeVisible();
    await expect(waitCard(pageB)).toHaveAttribute("data-wait", "released");
    // The release run gives B's Spec page a Next card: the agent's, naming the spec.
    await expect(nextCard(pageB)).toHaveAttribute("data-who", "agent");
    // While the release run writes, B's Spec stage is the agent's, in the working tone.
    const { status } = await mapOverview(page, mapB);
    expect(status.stages[2].tone).toBe("working");
    expect(status.next.map((action) => action.who)).toEqual(["agent"]);
    writeFileSync(releaseRunReleaseFile(), "");
    await expect(revisionLink(pageB, 3)).toBeVisible();
    await expect(waitCard(pageB)).toHaveCount(0);
    await pageB.close();
    expect((await specOne(page, mapB)).revisions.at(-1)).toMatchObject({
      revision: 3,
      mapId: mapB,
    });

    // A's set for r2 is replaced by B's r3, with no action on it.
    async function expectReplaced(): Promise<void> {
      await expect(page.getByText("Replaced by revision 3.", { exact: true })).toBeVisible();
      await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toHaveCount(
        0,
      );
    }
    await page.reload();
    await expectReplaced();
    expect((await latestSet(page, mapA, 2)).replaced).toBe(true);
  });

  test("B's r3 tickets take out 2.1, which A's replaced r2 dropped and r3's delta does not name, and load on Tickets", async ({
    page,
  }) => {
    const mapB = mapOf(madeFor("wait").waitingMapId, "the wait flow's map B");
    await page.goto(`/maps/${mapB}/spec`);
    await approveAndOpenTickets(page, mapB);
    async function expectTakenOut(): Promise<void> {
      await expect(
        nextCard(page).getByRole("button", { name: "Approve the tickets" }),
      ).toBeVisible();
      await expect(
        reconciliationRow(page, "2.1").getByText("removed", { exact: true }),
      ).toBeVisible();
    }
    await expectTakenOut();
    await page.reload();
    await expectTakenOut();
    const r3 = (await specOne(page, mapB)).revisions.at(-1);
    expect(r3?.revision).toBe(3);
    expect(r3?.delta?.removedCriteria.map((entry) => entry.criterion.id)).not.toContain("2.1");
    expect(r3?.takenOut.map((entry) => entry.criterion.id)).toContain("2.1");
    expect((await latestSet(page, mapB, 3)).content.dispositions).toContainEqual(
      expect.objectContaining({ criterion: "2.1", kind: "removed" }),
    );
  });
});

test.describe("release-stopped", () => {
  test.describe.configure({ mode: "serial" });

  firstMapSteps("release-stopped");

  test("[fake:fail-twice:release]: map B waits on map A's draft r2, on the release-stopped flow's project", async ({
    page,
  }) => {
    // The wait flow's setup on its own project: map A holds its draft r2, map B waits on it.
    const stopped = madeFor("release-stopped");
    const mapA = await laterMapRevision(
      page,
      "release-stopped",
      "Export more records [fake:revise:1]",
    );
    stopped.laterMapId = mapA;
    await expect(revisionLink(page, 2)).toBeVisible();
    const mapB = await answerMap(
      page,
      revisionRepo("release-stopped"),
      "Export even more records [fake:revise:1] [fake:fail-twice:release]",
    );
    stopped.waitingMapId = mapB;
    await page.goto(`/maps/${mapB}/spec`);
    await expect(waitCard(page)).toHaveAttribute("data-wait", "revision");
    await expect(waitCard(page).locator(`a[href="/maps/${mapA}/spec/1"]`)).toBeVisible();
  });

  test("[fake:fail-twice:release]: a released wait whose run fails twice stops; Try again writes the revision", async ({
    page,
    browser,
  }) => {
    const stopped = madeFor("release-stopped");
    const mapA = mapOf(stopped.laterMapId, "the release-stopped flow's map A");
    const mapB = mapOf(stopped.waitingMapId, "the release-stopped flow's map B");
    const pageB = await browser.newPage();
    await pageB.goto(`/maps/${mapB}/spec`);
    await expect(waitCard(pageB)).toHaveAttribute("data-wait", "revision");

    // A's r2 is approved and its tickets and their review end, which releases B's wait; B's release
    // run and its retry both fail, so the wait stops on Try again.
    await page.goto(`/maps/${mapA}/spec`);
    await approveSpec(page);
    await page.goto(`/maps/${mapA}/tickets`);
    await expect(nextCard(page).getByRole("button", { name: "Approve the tickets" })).toBeVisible();
    const tryAgain = waitCard(pageB).getByRole("button", { name: "Try again" });
    async function expectStopped(): Promise<void> {
      await expect(waitCard(pageB)).toHaveAttribute("data-wait", "released");
      await expect(tryAgain).toBeVisible();
    }
    await expectStopped();
    await pageB.reload();
    await expectStopped();
    const [waitView] = (await mapOverview(page, mapB)).waits;
    expect(waitView?.released).toBe(true);
    // The stand-in's failed run is an `error_max_turns` result on exit 1.
    expect(waitView?.run).toMatchObject({ stopped: { code: "agent_run_failed" } });

    // Try again starts the release run afresh; it writes B's r3 and the wait is gone.
    await tryAgain.click();
    await expect(revisionLink(pageB, 3)).toBeVisible();
    await expect(waitCard(pageB)).toHaveCount(0);
    await pageB.reload();
    await expect(revisionLink(pageB, 3)).toBeVisible();
    await expect(waitCard(pageB)).toHaveCount(0);
    await pageB.close();
    expect((await specOne(page, mapB)).revisions.at(-1)).toMatchObject({
      revision: 3,
      mapId: mapB,
    });
    expect((await mapOverview(page, mapB)).waits).toEqual([]);
  });
});
