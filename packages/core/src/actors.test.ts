import type { Actor, ChangeEvent, Project } from "@zenorm/contracts";
import { CreateMapInput } from "@zenorm/contracts";
import { deliveryRuns, maps, planningRuns, users } from "@zenorm/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cancelDelivery, setDeliveryPhase } from "./delivery.ts";
import { createMap } from "./map.ts";
import { planningRunActor, recordChart, sweepInterruptedRuns } from "./planning-runs.ts";
import { appendRunEvent } from "./run-events.ts";
import {
  addProject,
  answerDestination,
  closeTestContext,
  CONFIRMATION,
  deliverableTicketSet,
  newMap,
  openTestContext,
  propose,
  runningMapRun,
  startedRun,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { createChangeBus, setChangeBus } from "./writes.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-actors-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** A second User, so a run's attribution can be told apart from the local user. */
const OTHER_USER = "0123456789abcdef0123456789abcdef";

function addOtherUser(): void {
  context.db.insert(users).values({ id: OTHER_USER, createdAt: new Date().toISOString() }).run();
}

/** Records every change the bus hands on from here (the test context installed the feed). */
function recordChanges(): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  const bus = createChangeBus((message, error) => {
    throw new Error(message, { cause: error });
  });
  bus.subscribe("test", (event) => {
    events.push(event);
  });
  setChangeBus(context.db, bus);
  return events;
}

/** The User each of the map's planning runs is attributed to, oldest first. */
function runUsers(mapId: string): string[] {
  return context.db
    .select({ userId: planningRuns.userId })
    .from(planningRuns)
    .where(eq(planningRuns.mapId, mapId))
    .orderBy(asc(planningRuns.startedAt), asc(planningRuns.id))
    .all()
    .map((run) => run.userId);
}

describe("the actor of each write path (S9-13) and run attribution (S9-11)", () => {
  test("a procedure-style write is the user's: the map and its first chart run take that User", async () => {
    const events = recordChanges();

    const created = await createMap(
      context.user,
      context.db,
      CreateMapInput.parse({ projectId: project.id, idea: "An idea" }),
    );
    if (!created.ok) throw new Error(created.error.code);
    const mapId = created.value.map.id;

    expect(events.map((event) => event.entityType)).toEqual(["maps", "planning_runs"]);
    expect(events.map((event) => event.actor)).toEqual([context.user, context.user]);
    const map = context.db.select({ userId: maps.userId }).from(maps).where(eq(maps.id, mapId));
    expect(map.get()).toEqual({ userId: context.user.userId });
    expect(runUsers(mapId)).toEqual([context.user.userId]);
  });

  test("a planning run's record is written as the run with its User, and the run its end starts carries that User", async () => {
    const mapId = await newMap(context, project, "An idea");
    propose(context, mapId);
    answerDestination(context, mapId);
    addOtherUser();
    const chart = runningMapRun(context, mapId);
    // The confirming chart is another User's, so what it starts is told apart from the local user.
    writeTestData(context, (tx) =>
      tx
        .update(planningRuns)
        .set({ userId: OTHER_USER })
        .where(eq(planningRuns.id, chart.id))
        .run(),
    );
    const events = recordChanges();

    const actor = planningRunActor(context.db, chart.id);
    const recorded = recordChart(actor, context.db, chart.id, {
      kind: "confirmation",
      confirmation: CONFIRMATION,
    });

    expect(recorded).toEqual({ ok: true, value: null });
    expect(actor).toEqual({ kind: "planning_run", runId: chart.id, userId: OTHER_USER });
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.actor)).toEqual(events.map(() => actor));
    const survey = runningMapRun(context, mapId);
    expect(survey.purpose).toBe("survey");
    expect(runUsers(mapId).at(-1)).toBe(OTHER_USER);
  });

  test("the startup sweep writes as system, and its retry takes the interrupted run's map's User", async () => {
    const mapId = await newMap(context, project, "An idea");
    addOtherUser();
    writeTestData(context, (tx) =>
      tx.update(maps).set({ userId: OTHER_USER }).where(eq(maps.id, mapId)).run(),
    );
    const events = recordChanges();

    sweepInterruptedRuns(context.db);

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.actor)).toEqual(events.map(() => ({ kind: "system" })));
    const [interrupted, retry] = runUsers(mapId);
    expect(interrupted).toBe(context.user.userId);
    expect(retry).toBe(OTHER_USER);
  });

  test("the delivery runner's phase and lines are written as the run, with its User", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    expect(run.userId).toBe(context.user.userId);
    // What the server's runner builds from the stored run.
    const actor: Actor = { kind: "delivery_run", runId: run.id, userId: run.userId };
    const events = recordChanges();

    expect(setDeliveryPhase(actor, context.db, run.id, "implementing")).toBe(true);
    appendRunEvent(actor, context.db, {
      runId: run.id,
      who: "implementer",
      ticket: "T1",
      text: "Started T1.",
    });

    expect(events.map(({ entityType, op }) => ({ entityType, op }))).toEqual([
      { entityType: "delivery_runs", op: "update" },
      { entityType: "delivery_run_events", op: "insert" },
    ]);
    expect(events.map((event) => event.actor)).toEqual([actor, actor]);
  });

  test("a Cancel is the person's: the end and what it starts are written as the user", async () => {
    const set = await deliverableTicketSet(context, project);
    const run = await startedRun(context, set.ticketSetId);
    const events = recordChanges();

    const cancelled = await cancelDelivery(context.user, context.db, run.id);

    expect(cancelled.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      entityType: "delivery_runs",
      op: "update",
      entityId: run.id,
    });
    expect(events.map((event) => event.actor)).toEqual(events.map(() => context.user));
    const ended = context.db
      .select({ endedAt: deliveryRuns.endedAt })
      .from(deliveryRuns)
      .where(eq(deliveryRuns.id, run.id))
      .get();
    expect(ended?.endedAt).not.toBeNull();
  });
});
