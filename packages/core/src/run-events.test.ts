import { RunEvent } from "@zenorm/contracts";
import type { Project } from "@zenorm/contracts";
import { deliveryRunEvents } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { appendRunEvent, cutRunEventText, getDeliveryActivity } from "./run-events.ts";
import {
  addProject,
  appendLine,
  closeTestContext,
  deliverableTicketSet,
  markTicketStarted,
  openTestContext,
  startedRun,
  UNKNOWN_ID,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-run-events-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

describe("run lines", () => {
  test("lines append in order with seq = max + 1, any actor, and read oldest first", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const lines = [
      appendLine(context, run.id, { who: "zenorm", ticket: null, text: "Delivery run started." }),
      appendLine(context, run.id, { who: "orchestrator", ticket: null, text: "Reading the set." }),
      appendLine(context, run.id, { who: "implementer", ticket: "T1", text: "Edited `a.ts`" }),
      appendLine(context, run.id, { who: "reviewer", ticket: null, text: "Verdict: pass." }),
    ];
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4]);
    expect(getDeliveryActivity(context.db, run.id)).toEqual({ ok: true, value: lines });
    expect(lines.every((line) => !Number.isNaN(Date.parse(line.at)))).toBe(true);
  });

  test("a 600-character line stores 500, ending …", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const line = appendRunEvent(context.user, context.db, {
      runId: run.id,
      who: "orchestrator",
      ticket: null,
      text: "a".repeat(600),
    });
    expect(line.text).toHaveLength(500);
    expect(line.text).toBe(`${"a".repeat(499)}…`);
    const [stored] = context.db.select().from(deliveryRunEvents).all();
    expect(stored?.text).toBe(line.text);
  });

  test("the cut keeps whole astral characters and the line still validates as a RunEvent", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const line = appendRunEvent(context.user, context.db, {
      runId: run.id,
      who: "zenorm",
      ticket: null,
      text: `a${"🙂".repeat(300)}`,
    });
    expect(line.text.length).toBeLessThanOrEqual(500);
    expect(line.text.endsWith("🙂…")).toBe(true);
    expect(RunEvent.safeParse(line).success).toBe(true);
    expect(cutRunEventText("🙂".repeat(250))).toBe("🙂".repeat(250));
  });

  test("delivery_run_not_found for an unknown run", () => {
    expect(getDeliveryActivity(context.db, UNKNOWN_ID)).toMatchObject({
      ok: false,
      error: { code: "delivery_run_not_found", data: { runId: UNKNOWN_ID } },
    });
  });

  test("lines are display only: deleting a run's lines changes no status, stage or next action", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    markTicketStarted(context, run.id, "T1");
    appendLine(context, run.id, { who: "implementer", ticket: "T1", text: "Edited `a.ts`" });
    appendLine(context, run.id, { who: "implementer", ticket: "T2", text: "Stray line" });
    const read = async () => {
      const result = await getMapOverview(context.db, set.mapId, { deliveryHeld: () => true });
      if (!result.ok) throw new Error(result.error.code);
      const [spec] = result.value.specs;
      return {
        status: result.value.status,
        stages: spec?.stages,
        tickets: spec?.runs[0]?.tickets?.map((ticket) => [ticket.ticket, ticket.status.state]),
      };
    };
    const before = await read();
    expect(before.tickets).toEqual([
      ["T1", "implementing"],
      ["T2", "waiting"],
    ]);
    writeTestData(context, (tx) =>
      tx.delete(deliveryRunEvents).where(eq(deliveryRunEvents.runId, run.id)).run(),
    );
    expect(await read()).toEqual(before);
  });
});
