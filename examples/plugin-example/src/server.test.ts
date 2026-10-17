import { ok } from "@zenorm/contracts";
import type { ChangeEvent, Seams } from "@zenorm/contracts";
import type { BoundServerContributions, PluginContext } from "@zenorm/plugin-sdk";
import { describe, expect, test, vi } from "vitest";

import { EXAMPLE_PLUGIN, ExampleCounts, REFUSED_DELIVERY_REASON } from "./manifest.ts";
import { createExamplePlugin } from "./server.ts";

/** The Host a server configured on 127.0.0.1:4310 accepts; the router sits behind its guard. */
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const USER = "local";
const DENIED = { id: "01890a5d-ac96-774b-bcce-b302099a8001", name: "denied-repo" };
const REFUSED = { id: "01890a5d-ac96-774b-bcce-b302099a8002", name: "refused-repo" };
const OPEN = { id: "01890a5d-ac96-774b-bcce-b302099a8003", name: "open-repo" };

const CONFIG = {
  deniedProjectNames: [DENIED.name],
  refusedDeliveryProjectNames: [REFUSED.name],
};

/**
 * A stand-in for the server's context: `projects` is the database, read at each call, so a test
 * adds a project by pushing to it.
 */
function contextOver(projects: { id: string; name: string }[]): PluginContext {
  return {
    projectName: (projectId) => {
      const found = projects.find((project) => project.id === projectId);
      return found === undefined ? null : found.name;
    },
  };
}

function bound(): BoundServerContributions {
  const configured = createExamplePlugin().configure(CONFIG);
  if (!configured.ok) throw new Error(configured.message);
  return configured.value;
}

/** The core seams the wrappers call as `next`, each a mock. */
function core() {
  return {
    identify: vi.fn<Seams["identify"]>(() => USER),
    checkAccess: vi.fn<Seams["checkAccess"]>(() => true),
    checkout: vi.fn<Seams["checkout"]>((project) => Promise.resolve(ok(project.folderPath))),
    executorEnv: vi.fn<Seams["executorEnv"]>(() => ({ PATH: "/bin" })),
    admitRun: vi.fn<Seams["admitRun"]>(() => Promise.resolve(ok(null))),
  };
}

function wrapped(
  contributions: BoundServerContributions,
  next: ReturnType<typeof core>,
  context: PluginContext,
): Seams {
  if (contributions.seams === null) throw new Error("The example plugin wraps every seam");
  const wrappers = contributions.seams(context);
  const { identify, checkAccess, checkout, executorEnv, admitRun } = wrappers;
  if (
    identify === undefined ||
    checkAccess === undefined ||
    checkout === undefined ||
    executorEnv === undefined ||
    admitRun === undefined
  ) {
    throw new Error("The example plugin wraps every seam");
  }
  return {
    identify: identify(next.identify),
    checkAccess: checkAccess(next.checkAccess),
    checkout: checkout(next.checkout),
    executorEnv: executorEnv(next.executorEnv),
    admitRun: admitRun(next.admitRun),
  };
}

/** The counts route, given `seams` (the composed ones, as the server gives them) for its checks. */
async function counts(
  contributions: BoundServerContributions,
  seams: Pick<Seams, "identify" | "checkAccess">,
  context: PluginContext,
): Promise<ExampleCounts> {
  if (contributions.routes === null) throw new Error("The example plugin has a route");
  const router = contributions.routes({
    ...context,
    identify: seams.identify,
    checkAccess: seams.checkAccess,
  });
  const response = await router.request(`${ORIGIN}/counts`, { headers: { host: HOST } });
  expect(response.status).toBe(200);
  return ExampleCounts.parse(await response.json());
}

function request(path: string) {
  return { method: "POST", url: `${ORIGIN}${path}`, headers: new Headers({ host: HOST }) };
}

function event(projectId: string, overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    seq: 1,
    projectId,
    mapId: null,
    entityType: "maps",
    entityId: projectId,
    op: "update",
    actor: { kind: "user", userId: USER },
    ...overrides,
  };
}

async function started(
  contributions: BoundServerContributions,
  context: PluginContext,
  log = vi.fn(),
): Promise<void> {
  if (contributions.start === null) throw new Error("The example plugin has a start");
  await contributions.start({ ...context, log });
}

describe("the example plugin's seam wrappers (D17)", () => {
  test("identity passes through and counts", async () => {
    const context = contextOver([OPEN]);
    const contributions = bound();
    await started(contributions, context);
    const next = core();
    const seams = wrapped(contributions, next, context);

    expect(seams.identify(request("/rpc/project/get"))).toBe(USER);
    expect(seams.identify(request("/rpc/map/overview"))).toBe(USER);

    expect(next.identify).toHaveBeenCalledTimes(2);
    expect((await counts(contributions, seams, context)).seams.identify).toBe(3);
  });

  test("access denies a project deniedProjectNames names on the first request after start", async () => {
    const context = contextOver([DENIED, OPEN]);
    const contributions = bound();
    await started(contributions, context);
    const next = core();
    const seams = wrapped(contributions, next, context);

    // The first call, as the Inbox's first `project.list` makes it.
    expect(seams.checkAccess(USER, DENIED.id, "read")).toBe(false);
    expect(seams.checkAccess(USER, DENIED.id, "write")).toBe(false);
    expect(next.checkAccess).not.toHaveBeenCalled();
    expect(seams.checkAccess(USER, OPEN.id, "read")).toBe(true);
    expect(next.checkAccess).toHaveBeenCalledWith(USER, OPEN.id, "read");
  });

  test("a project created while running is denied on its first read", async () => {
    const projects = [OPEN];
    const context = contextOver(projects);
    const contributions = bound();
    await started(contributions, context);
    const seams = wrapped(contributions, core(), context);

    projects.push(DENIED);

    expect(seams.checkAccess(USER, DENIED.id, "read")).toBe(false);
  });

  test("an id with no project is left to core, so the procedure answers its own not-found", async () => {
    const context = contextOver([]);
    const contributions = bound();
    await started(contributions, context);
    const next = core();
    const seams = wrapped(contributions, next, context);

    expect(seams.checkAccess(USER, DENIED.id, "read")).toBe(true);
    expect(next.checkAccess).toHaveBeenCalledWith(USER, DENIED.id, "read");
  });

  test("checkout and credentials pass through and record the call", async () => {
    const context = contextOver([]);
    const contributions = bound();
    const next = core();
    const seams = wrapped(contributions, next, context);

    expect(await seams.checkout({ id: OPEN.id, folderPath: "/repos/open-repo" })).toEqual(
      ok("/repos/open-repo"),
    );
    expect(seams.executorEnv({ id: "run", projectId: OPEN.id })).toEqual({ PATH: "/bin" });

    expect(next.checkout).toHaveBeenCalledTimes(1);
    expect(next.executorEnv).toHaveBeenCalledTimes(1);
    const { seams: seen } = await counts(contributions, seams, context);
    expect(seen.checkout).toBe(1);
    expect(seen.executorEnv).toBe(1);
  });

  test("admission refuses a delivery start on a refused project with the reason, and admits others", async () => {
    const context = contextOver([REFUSED, OPEN]);
    const contributions = bound();
    await started(contributions, context);
    const next = core();
    const seams = wrapped(contributions, next, context);
    const ask = (projectId: string) =>
      seams.admitRun({ kind: "delivery", projectId, userId: USER, ticketSetId: "set" });

    const refused = await ask(REFUSED.id);
    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "delivery_not_admitted",
      data: { reason: REFUSED_DELIVERY_REASON },
    });
    expect(next.admitRun).not.toHaveBeenCalled();

    expect(await ask(OPEN.id)).toEqual(ok(null));
    expect(next.admitRun).toHaveBeenCalledTimes(1);
    expect((await counts(contributions, seams, context)).seams.admitRun).toBe(2);
  });
});

describe("the example plugin's subscriber, route and lifecycle (D17)", () => {
  test("the * subscriber counts committed rows per project, and the route reports the readable ones", async () => {
    const context = contextOver([OPEN, DENIED]);
    const contributions = bound();
    const seams = wrapped(contributions, core(), context);
    if (contributions.subscribers === null) throw new Error("The example plugin subscribes");
    const subscriber = contributions.subscribers(context)["*"];
    if (subscriber === undefined) throw new Error("The example plugin subscribes to *");

    subscriber(event(OPEN.id));
    subscriber(event(OPEN.id, { entityType: "question_rounds", op: "insert" }));
    subscriber(event(DENIED.id));

    // The denied project's totals are absent (CR9b-13); the route's own checks are counted.
    expect(await counts(contributions, seams, context)).toEqual({
      seams: { identify: 1, checkAccess: 2, checkout: 0, executorEnv: 0, admitRun: 0 },
      executor: { implement: 0, review: 0 },
      projects: { [OPEN.id]: 2 },
    });
  });

  test("the plugin registers the example executor, and start and stop log once each", async () => {
    const contributions = bound();
    expect(contributions.executors?.().map((executor) => executor.name)).toEqual(["example"]);
    const log = vi.fn();
    await started(contributions, contextOver([]), log);
    await contributions.stop?.();
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("the config section is required in full", () => {
    const plugin = createExamplePlugin();
    expect(plugin.id).toBe(EXAMPLE_PLUGIN.id);
    expect(plugin.configured).toBe(true);
    expect(plugin.configure({ deniedProjectNames: [] }).ok).toBe(false);
  });
});
