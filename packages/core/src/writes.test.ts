import { join } from "node:path";

import { ChangeEntityType } from "@zenorm/contracts";
import type { Actor, ChangeEvent, Project } from "@zenorm/contracts";
import {
  consistencyFindings,
  consistencyPasses,
  FEED_EXCLUDED_TABLES,
  installChangeFeed,
  mapExclusions,
  mapFog,
  mapProposals,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
  planningRuns,
  projects,
  researchReports,
  researchSources,
  specReviewFindings,
  specReviews,
  taskOutcomes,
  ticketSetRejections,
  ticketsReviewFindings,
  ticketsReviews,
  users,
} from "@zenorm/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  addProject,
  chartedMap,
  closeTestContext,
  deliveredSpec,
  insertMessage,
  insertTouch,
  insertWait,
  openTestContext,
  resolvedChain,
  REVISE_FINDING,
  TICKETS_REVISE_FINDING,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { createChangeBus, localUser, setChangeBus, write } from "./writes.ts";

let context: TestContext;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-writes-");
});

afterEach(async () => {
  await closeTestContext(context);
});

const at = "2026-10-11T12:00:00.000Z";

/** A bus on the context's database that records what it hands its one subscriber. */
function recordingBus(): {
  readonly events: ChangeEvent[];
  readonly log: ReturnType<typeof vi.fn>;
} {
  const log = vi.fn();
  const bus = createChangeBus(log);
  const events: ChangeEvent[] = [];
  bus.subscribe("recorder", (event) => {
    events.push(event);
  });
  setChangeBus(context.db, bus);
  return { events, log };
}

function userActor(): Extract<Actor, { kind: "user" }> {
  return { kind: "user", userId: localUser(context.db).id };
}

function newProjectRow(id: string): typeof projects.$inferInsert {
  return {
    id,
    folderPath: `/repos/${id}`,
    baseBranch: "main",
    createdAt: at,
    requiredChecks: [],
    repairLimit: null,
    fixCommands: [],
  };
}

function feedCount(): unknown {
  return context.db.$client.prepare("select count(*) from change_feed").pluck().get();
}

describe("localUser (S9-10)", () => {
  test("returns the migration's one User", () => {
    const user = localUser(context.db);
    expect(user.id).toMatch(/^[0-9a-f]{32}$/);
    expect(context.db.select().from(users).all()).toEqual([user]);
  });

  test("zero rows or two rows are programmer errors, and throw", () => {
    context.db
      .insert(users)
      .values({ id: "0".repeat(32), createdAt: at })
      .run();
    expect(() => localUser(context.db)).toThrow(Error);
    context.db.delete(users).run();
    expect(() => localUser(context.db)).toThrow(Error);
  });
});

describe("write and the change bus (S9-14, spec D11)", () => {
  test("an unset bus is a programmer error: write throws and writes nothing", () => {
    // The test context sets a bus, so this database is opened without one.
    const opened = openDatabase(join(context.root, "no-bus.sqlite"));
    if (!opened.ok) throw new Error(opened.error.message);
    const db = opened.value;
    const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
    if (!migrated.ok) throw new Error(migrated.error.message);
    try {
      expect(() => {
        write(db, { kind: "system" }, (tx) => {
          tx.insert(projects).values(newProjectRow(uuidv7())).run();
        });
      }).toThrow(Error);
      expect(db.select().from(projects).all()).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  test("after commit, the bus receives the transaction's rows in seq order, and write returns fn's value", () => {
    installChangeFeed(context.db);
    const { events, log } = recordingBus();
    const actor = userActor();
    const [first, second] = [uuidv7(), uuidv7()];

    const value = write(context.db, actor, (tx) => {
      tx.insert(projects).values(newProjectRow(first)).run();
      tx.insert(projects).values(newProjectRow(second)).run();
      tx.update(projects).set({ baseBranch: "trunk" }).where(eq(projects.id, first)).run();
      // Nothing is published until commit.
      expect(events).toEqual([]);
      return "done";
    });

    expect(value).toBe("done");
    const event = (seq: number, projectId: string, op: ChangeEvent["op"]): ChangeEvent => ({
      seq,
      projectId,
      mapId: null,
      entityType: "projects",
      entityId: projectId,
      op,
      actor,
    });
    expect(events).toEqual([
      event(1, first, "insert"),
      event(2, second, "insert"),
      event(3, first, "update"),
    ]);
    // The next write hands on only its own rows, with a run actor.
    const runActor: Actor = { kind: "delivery_run", runId: uuidv7(), userId: actor.userId };
    write(context.db, runActor, (tx) => {
      tx.delete(projects).where(eq(projects.id, second)).run();
    });
    expect(events.slice(3)).toEqual([{ ...event(4, second, "delete"), actor: runActor }]);
    expect(log).not.toHaveBeenCalled();
    // The actor row is gone after each write.
    expect(context.db.$client.prepare("select count(*) from write_actor").pluck().get()).toBe(0);
  });

  test("a rollback publishes nothing and leaves no feed row and no actor", () => {
    installChangeFeed(context.db);
    const { events } = recordingBus();

    expect(() =>
      write(context.db, { kind: "system" }, (tx) => {
        tx.insert(projects).values(newProjectRow(uuidv7())).run();
        throw new Error("fn failed");
      }),
    ).toThrow("fn failed");

    expect(events).toEqual([]);
    expect(feedCount()).toBe(0);
    expect(context.db.select().from(projects).all()).toEqual([]);
    expect(context.db.$client.prepare("select count(*) from write_actor").pluck().get()).toBe(0);
  });

  test("a subscriber's throw is logged with its name and fails neither the write nor the next subscriber", () => {
    installChangeFeed(context.db);
    const log = vi.fn();
    const bus = createChangeBus(log);
    const failure = new Error("subscriber failed");
    bus.subscribe("broken", () => {
      throw failure;
    });
    const received: number[] = [];
    const unsubscribe = bus.subscribe("counter", (event) => {
      received.push(event.seq);
    });
    setChangeBus(context.db, bus);
    const id = uuidv7();

    write(context.db, { kind: "system" }, (tx) => {
      tx.insert(projects).values(newProjectRow(id)).run();
    });

    expect(context.db.select().from(projects).all()).toHaveLength(1);
    expect(received).toEqual([1]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("broken");
    expect(log.mock.calls[0]?.[1]).toBe(failure);

    unsubscribe();
    write(context.db, { kind: "system" }, (tx) => {
      tx.delete(projects).where(eq(projects.id, id)).run();
    });
    expect(received).toEqual([1]);
  });

  test("a write outside write() aborts with actor_missing once the feed is installed", () => {
    installChangeFeed(context.db);
    expect(() => context.db.insert(projects).values(newProjectRow(uuidv7())).run()).toThrow(
      "actor_missing",
    );
    expect(context.db.select().from(projects).all()).toEqual([]);
  });
});

/**
 * Fills every core table from the test-support fixtures, plus the slice 6b records and a rejection
 * the fixtures do not write. Everything is in `project`; `other` is added first and stays empty, so
 * a project expression that picks the first project names the wrong one.
 */
async function fillEveryTable(): Promise<{ project: Project; mapIds: Set<string> }> {
  await addProject(context, "other");
  const project = await addProject(context, "repo");
  const delivered = await deliveredSpec(context, project);
  await resolvedChain(context, project);
  const charted = await chartedMap(context, project);
  const one = waypointOf(context, charted, 1);
  const two = waypointOf(context, charted, 2);
  const run = (purpose: "research" | "task" | "consistency", waypointId: string | null) => {
    const id = uuidv7();
    writeTestData(context, (tx) =>
      tx
        .insert(planningRuns)
        .values({
          id,
          userId: context.user.userId,
          mapId: charted,
          waypointId,
          purpose,
          state: "completed",
          startedAt: at,
          endedAt: at,
        })
        .run(),
    );
    return id;
  };
  writeTestData(context, (tx) =>
    tx
      .insert(mapFog)
      .values({
        mapId: charted,
        position: 1,
        text: "Who may export.",
        createdByRun: one.createdByRun,
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(mapExclusions)
      .values({
        mapId: charted,
        position: 1,
        text: "Imports.",
        waypointId: null,
        createdByRun: one.createdByRun,
        splitMapId: null,
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(mapProposals)
      .values({
        id: uuidv7(),
        mapId: charted,
        kind: "outside",
        title: "Imports",
        idea: "Import records too.",
        line: "Imports are a later effort.",
        waypointId: null,
        state: "pending",
        newMapId: null,
        createdByRun: one.createdByRun,
        createdAt: at,
        decidedAt: null,
      })
      .run(),
  );
  const researchRun = run("research", two.id);
  writeTestData(context, (tx) =>
    tx
      .insert(researchReports)
      .values({
        runId: researchRun,
        waypointId: two.id,
        answered: true,
        gap: null,
        summary: "What the docs say.",
        findings: [{ title: "UTF-8", detail: "Docs say UTF-8.", sources: [1] }],
        limitations: [],
        uncertainties: [],
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(researchSources)
      .values({
        reportRunId: researchRun,
        position: 1,
        kind: "repository_file",
        title: "README",
        url: null,
        excerpt: "First.",
      })
      .run(),
  );
  const taskRun = run("task", two.id);
  writeTestData(context, (tx) =>
    tx
      .insert(taskOutcomes)
      .values({
        runId: taskRun,
        waypointId: two.id,
        outcome: "done",
        action: "Read the config.",
        facts: "It is there.",
      })
      .run(),
  );
  const passId = uuidv7();
  const passRun = run("consistency", null);
  writeTestData(context, (tx) =>
    tx
      .insert(consistencyPasses)
      .values({
        id: passId,
        mapId: charted,
        runId: passRun,
        compared: [{ waypointId: one.id, resolvedAt: at }],
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(consistencyFindings)
      .values({
        createdWaypointId: two.id,
        passId,
        kind: "undefined_term",
        waypointNumbers: [1],
        title: two.title,
        explanation: "Waypoint 1 says record without defining it.",
        question: two.question,
      })
      .run(),
  );
  insertMessage(context, delivered.mapId, {
    state: "queued",
    stage: "tickets",
    specificationId: delivered.specificationId,
    text: "Rename the export.",
  });
  insertWait(context, {
    mapId: charted,
    specificationId: delivered.specificationId,
    note: "Waits on the delivered spec.",
    hatchMessageId: null,
    hold: { kind: "revision", mapId: delivered.mapId, revision: 1 },
    released: null,
  });
  insertTouch(context, {
    waypointId: one.id,
    specificationId: delivered.specificationId,
    revision: 1,
    criteria: ["1.1"],
  });
  const review = context.db.select().from(specReviews).get();
  if (review === undefined) throw new Error("The delivered spec has no review");
  writeTestData(context, (tx) =>
    tx
      .insert(specReviewFindings)
      .values({
        reviewId: review.id,
        position: 1,
        ...REVISE_FINDING,
        escalated: false,
        waypointId: null,
      })
      .run(),
  );
  const ticketsReview = context.db.select().from(ticketsReviews).get();
  if (ticketsReview === undefined) throw new Error("The delivered ticket set has no review");
  writeTestData(context, (tx) =>
    tx
      .insert(ticketsReviewFindings)
      .values({
        reviewId: ticketsReview.id,
        position: 1,
        ...TICKETS_REVISE_FINDING,
        escalated: false,
      })
      .run(),
  );
  writeTestData(context, (tx) =>
    tx
      .insert(ticketSetRejections)
      .values({
        ticketSetId: delivered.ticketSetId,
        version: 1,
        reason: "Split it.",
        rejectedAt: at,
      })
      .run(),
  );
  const mapIds = new Set(
    context.db.$client
      .prepare("select id from maps where project_id = ?")
      .pluck()
      .all(project.id)
      .map(String),
  );
  return { project, mapIds };
}

function coreTables(): string[] {
  return context.db.$client
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .pluck()
    .all()
    .map(String)
    .filter((name) => !name.startsWith("sqlite_") && !FEED_EXCLUDED_TABLES.includes(name));
}

describe("the change feed covers every core table (S9-12)", () => {
  test("an insert, an update and a delete on each table in sqlite_master append a row naming its project", async () => {
    const { project, mapIds } = await fillEveryTable();
    const client = context.db.$client;
    const tables = coreTables();
    expect(tables).toEqual([...ChangeEntityType.options].sort());
    for (const table of tables) {
      expect(client.prepare(`select count(*) from "${table}"`).pluck().get(), table).not.toBe(0);
    }
    // The fixtures' own rows are in the feed already; this test reads the rows after them.
    const filled = client.prepare("select max(seq) from change_feed").pluck().get();
    const { events } = recordingBus();

    for (const table of tables) {
      const where = table === "projects" ? "where id = ?" : "";
      const args = table === "projects" ? [project.id] : [];
      const before = events.length;
      write(context.db, { kind: "system" }, () => {
        // The row comes back in this transaction, so its children's keys hold at commit.
        client.pragma("defer_foreign_keys = ON");
        const row = client
          .prepare(
            `select rowid as zenorm_rowid, * from "${table}" ${where} order by rowid limit 1`,
          )
          .get(...args);
        if (typeof row !== "object" || row === null) throw new Error(`No row in ${table}`);
        const { zenorm_rowid: rowid, ...columns } = Object.fromEntries(Object.entries(row));
        const names = Object.keys(columns);
        const values: unknown[] = Object.values(columns);
        client.prepare(`delete from "${table}" where rowid = ?`).run(rowid);
        const inserted = client
          .prepare(
            `insert into "${table}" (${names.map((name) => `"${name}"`).join(", ")}) values (${names.map(() => "?").join(", ")})`,
          )
          .run(...values);
        const [first] = names;
        if (first === undefined) throw new Error(`${table} has no column`);
        client
          .prepare(`update "${table}" set "${first}" = "${first}" where rowid = ?`)
          .run(inserted.lastInsertRowid);
      });

      const appended = events.slice(before);
      expect(
        appended.map(({ entityType, op, projectId, actor }) => ({
          entityType,
          op,
          projectId,
          actor,
        })),
        table,
      ).toEqual(
        (["delete", "insert", "update"] as const).map((op) => ({
          entityType: table,
          op,
          projectId: project.id,
          actor: { kind: "system" },
        })),
      );
      const [deleted, ...rest] = appended;
      for (const event of rest) {
        expect(event.entityId, table).toBe(deleted?.entityId);
        expect(event.mapId, table).toBe(deleted?.mapId);
      }
      const mapId = deleted?.mapId;
      if (mapId !== null && mapId !== undefined) {
        expect(mapIds.has(mapId), table).toBe(true);
      }
    }
    // Every row the bus received is in the table, in order.
    expect(
      client.prepare("select seq from change_feed where seq > ? order by seq").pluck().all(filled),
    ).toEqual(events.map((event) => event.seq));
  });
});
