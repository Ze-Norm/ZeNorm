import { join } from "node:path";

import { err, LOCAL_EXECUTOR, ok } from "@zenorm/contracts";
import type { AdmitRun, Project, RunAdmissionRequest } from "@zenorm/contracts";
import { deliveryRuns, openDatabase } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { startDelivery } from "./delivery.ts";
import { coreSeams, seamsOf, setSeams, wrapSeams } from "./seams.ts";
import {
  addProject,
  closeTestContext,
  deliverableTicketSet,
  openTestContext,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import { localUser } from "./writes.ts";

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-core-seams-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

const REQUEST = { method: "GET", url: "http://zenorm.test/rpc", headers: new Headers() };

describe("core's seams behave as core did before them", () => {
  test("identify returns the instance's one local User", () => {
    expect(coreSeams(context.db).identify(REQUEST)).toBe(localUser(context.db).id);
  });

  test("the access check allows every read and write", () => {
    const { checkAccess } = coreSeams(context.db);
    const userId = localUser(context.db).id;
    expect(checkAccess(userId, project.id, "read")).toBe(true);
    expect(checkAccess(userId, project.id, "write")).toBe(true);
  });

  test("checkout returns the stored folder, or project_folder_missing", async () => {
    const { checkout } = coreSeams(context.db);
    expect(await checkout(project)).toEqual(ok(project.folderPath));
    const gone = join(context.root, "gone");
    expect(await checkout({ id: project.id, folderPath: gone })).toMatchObject({
      ok: false,
      error: { code: "project_folder_missing", data: { folderPath: gone } },
    });
  });

  test("the executor environment is this process's environment", () => {
    expect(coreSeams(context.db).executorEnv({ id: "run", projectId: project.id })).toEqual(
      process.env,
    );
  });

  test("admission admits", async () => {
    const request: RunAdmissionRequest = {
      kind: "delivery",
      projectId: project.id,
      userId: localUser(context.db).id,
      ticketSetId: "set",
    };
    expect(await coreSeams(context.db).admitRun(request)).toEqual(ok(null));
  });

  test("a database with no seams set is a programmer error", () => {
    const other = openDatabase(join(context.root, "other.sqlite"));
    if (!other.ok) throw new Error(other.error.message);
    try {
      expect(() => seamsOf(other.value)).toThrow();
    } finally {
      other.value.$client.close();
    }
  });
});

describe("wrapped seams", () => {
  test("two chained admission wrappers both run, the later outermost, core innermost", async () => {
    const calls: string[] = [];
    const recording =
      (name: string) =>
      (next: AdmitRun): AdmitRun =>
      async (request) => {
        calls.push(`${name} before`);
        const admitted = await next(request);
        calls.push(`${name} after`);
        return admitted;
      };
    const seams = wrapSeams(wrapSeams(coreSeams(context.db), { admitRun: recording("first") }), {
      admitRun: recording("second"),
    });
    setSeams(context.db, seams);
    const set = await deliverableTicketSet(context, project);

    const started = await startDelivery(context.user, context.db, {
      ticketSetId: set.ticketSetId,
      runsDir: join(context.root, "runs"),
      executor: LOCAL_EXECUTOR,
    });

    expect(started.ok).toBe(true);
    expect(calls).toEqual(["second before", "first before", "first after", "second after"]);
  });

  test("a refusing wrapper refuses the start with delivery_not_admitted and writes nothing", async () => {
    const reason = "Delivery runs are paused for this project.";
    setSeams(
      context.db,
      wrapSeams(coreSeams(context.db), {
        admitRun: () => () =>
          Promise.resolve(
            err({ code: "delivery_not_admitted", message: reason, data: { reason } }),
          ),
      }),
    );
    const set = await deliverableTicketSet(context, project);

    const started = await startDelivery(context.user, context.db, {
      ticketSetId: set.ticketSetId,
      runsDir: join(context.root, "runs"),
      executor: LOCAL_EXECUTOR,
    });

    expect(started).toMatchObject({
      ok: false,
      error: { code: "delivery_not_admitted", data: { reason } },
    });
    expect(context.db.select().from(deliveryRuns).all()).toEqual([]);
  });

  test("delivery start works in the folder the checkout seam gives", async () => {
    const asked: string[] = [];
    setSeams(
      context.db,
      wrapSeams(coreSeams(context.db), {
        checkout: (next) => (checkedOut) => {
          asked.push(checkedOut.id);
          return next(checkedOut);
        },
      }),
    );
    const set = await deliverableTicketSet(context, project);

    const started = await startDelivery(context.user, context.db, {
      ticketSetId: set.ticketSetId,
      runsDir: join(context.root, "runs"),
      executor: LOCAL_EXECUTOR,
    });

    expect(started.ok).toBe(true);
    expect(asked).toEqual([project.id]);
  });
});
