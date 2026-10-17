import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createORPCClient, isDefinedError, safe } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { ok } from "@zenorm/contracts";
import type { ChangeEvent, Contract, DeliveryExecutor, Seams } from "@zenorm/contracts";
import { createChangeBus } from "@zenorm/core";
import { installChangeFeed, MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { definePlugin, SDK_VERSION } from "@zenorm/plugin-sdk";
import type { ConfigSchema, ServerPlugin } from "@zenorm/plugin-sdk";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createApp } from "./app.ts";
import type { AppOptions, Log, ZeNormApp } from "./app.ts";
import {
  checkPlugins,
  composePlugins,
  PLUGIN_STOP_TIMEOUT_MS,
  sdkSatisfies,
  startPlugins,
  stopPlugins,
} from "./plugins.ts";
import type { CheckedPlugins, PluginSetInput } from "./plugins.ts";

/** The host and port the test app is configured on, and what a request to it carries as Host. */
const SERVER = { host: "127.0.0.1", port: 4310 };
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
/** The headers an app request needs to be served: `Request` sets no Host of its own. */
const SERVED = { host: HOST };
const UNKNOWN_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

let root: string;
let db: ZeNormDatabase;
let log: Mock<Log>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-plugins-"));
  const opened = openDatabase(join(root, "zenorm.sqlite"));
  if (!opened.ok) throw new Error(opened.error.message);
  db = opened.value;
  const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
  if (!migrated.ok) throw new Error(migrated.error.message);
  installChangeFeed(db);
  log = vi.fn<Log>();
});

afterEach(async () => {
  vi.useRealTimers();
  if (db.$client.open) db.$client.close();
  await rm(root, { recursive: true, force: true });
});

function notCalled(): never {
  throw new Error("This port is not called in these tests");
}

const LOCAL: DeliveryExecutor = {
  name: "local",
  implementTicketSet: notCalled,
  reviewDelivery: notCalled,
  writePullRequest: notCalled,
};

function executorNamed(name: string): DeliveryExecutor {
  return {
    name,
    implementTicketSet: notCalled,
    reviewDelivery: notCalled,
    writePullRequest: notCalled,
  };
}

/** A config schema with no Zod: `{ denied: string[] }`, strict. */
const DENIED_SCHEMA: ConfigSchema<{ denied: readonly string[] }> = {
  safeParse: (input) => {
    if (
      typeof input === "object" &&
      input !== null &&
      Object.keys(input).length === 1 &&
      "denied" in input &&
      Array.isArray(input.denied) &&
      input.denied.every((name: unknown) => typeof name === "string")
    ) {
      return { success: true, data: { denied: input.denied.map(String) } };
    }
    return { success: false, error: { message: "expected { denied: string[] }" } };
  },
};

function plugin(id: string, extra: Partial<Parameters<typeof definePlugin>[0]> = {}): ServerPlugin {
  return definePlugin({ id, version: "1.0.0", sdk: `^${SDK_VERSION}`, ...extra });
}

function check(overrides: Partial<PluginSetInput>) {
  return checkPlugins({
    plugins: [],
    pluginConfig: {},
    executors: [LOCAL],
    executor: "local",
    ...overrides,
  });
}

/** The set checked, then composed with the test's database, as `createApp` does. */
function prepare(overrides: Partial<PluginSetInput>) {
  const checked = check(overrides);
  if (!checked.ok) return checked;
  return composePlugins(checked.value, db);
}

function codeOf(result: ReturnType<typeof prepare>): string | null {
  return result.ok ? null : result.error.code;
}

describe("the plugin set's startup checks", () => {
  test("no plugins and the app's local executor pass", () => {
    const prepared = prepare({});
    expect(prepared.ok && prepared.value.executor).toBe(LOCAL);
    expect(prepared.ok && prepared.value.list).toEqual([]);
  });

  test("plugin_id_invalid", () => {
    expect(codeOf(prepare({ plugins: [plugin("Example")] }))).toBe("plugin_id_invalid");
    expect(codeOf(prepare({ plugins: [plugin("1st")] }))).toBe("plugin_id_invalid");
  });

  test("plugin_id_duplicate", () => {
    expect(codeOf(prepare({ plugins: [plugin("example"), plugin("example")] }))).toBe(
      "plugin_id_duplicate",
    );
  });

  test("plugin_sdk_incompatible", () => {
    expect(codeOf(prepare({ plugins: [plugin("example", { sdk: "^1.0.0" })] }))).toBe(
      "plugin_sdk_incompatible",
    );
    expect(codeOf(prepare({ plugins: [plugin("example", { sdk: "latest" })] }))).toBe(
      "plugin_sdk_incompatible",
    );
  });

  test("plugin_config_missing: a plugin with a schema and no section", () => {
    const configured = definePlugin({
      id: "example",
      version: "1.0.0",
      sdk: `^${SDK_VERSION}`,
      config: DENIED_SCHEMA,
    });
    expect(codeOf(prepare({ plugins: [configured] }))).toBe("plugin_config_missing");
  });

  test("plugin_config_invalid: a section its schema refuses", () => {
    const configured = definePlugin({
      id: "example",
      version: "1.0.0",
      sdk: `^${SDK_VERSION}`,
      config: DENIED_SCHEMA,
    });
    const result = prepare({ plugins: [configured], pluginConfig: { example: { denied: 3 } } });
    expect(codeOf(result)).toBe("plugin_config_invalid");
    expect(!result.ok && result.error.subject).toBe("plugins.example");
  });

  test("plugin_config_unknown_section: a section no plugin owns, or one a schemaless plugin gets", () => {
    expect(codeOf(prepare({ pluginConfig: { typo: {} } }))).toBe("plugin_config_unknown_section");
    expect(codeOf(prepare({ plugins: [plugin("example")], pluginConfig: { example: {} } }))).toBe(
      "plugin_config_unknown_section",
    );
  });

  test("plugin_identity_conflict: two identity providers", () => {
    const provider = (id: string) =>
      plugin(id, { seams: () => ({ identify: (next) => (request) => next(request) }) });
    expect(codeOf(prepare({ plugins: [provider("one"), provider("two")] }))).toBe(
      "plugin_identity_conflict",
    );
  });

  test("plugin_event_kind_unknown: a subscriber key that is neither * nor a feed table", () => {
    const bad = plugin("example", {
      subscribers: () => Object.fromEntries([["not_a_table", () => undefined]]),
    });
    expect(codeOf(prepare({ plugins: [bad] }))).toBe("plugin_event_kind_unknown");
  });

  test("plugin_route_collision: one method and path registered twice", () => {
    const bad = plugin("example", {
      routes: () =>
        new Hono().get("/counts", (c) => c.text("a")).get("/counts", (c) => c.text("b")),
    });
    expect(codeOf(prepare({ plugins: [bad] }))).toBe("plugin_route_collision");
  });

  test("plugin_seam_failed: a wrapper that throws when composed", () => {
    const bad = plugin("example", {
      seams: () => ({
        checkout: () => {
          throw new Error("no clone credentials");
        },
      }),
    });
    expect(codeOf(prepare({ plugins: [bad] }))).toBe("plugin_seam_failed");
  });

  test("plugin_executor_duplicate: a plugin registering local", () => {
    const bad = plugin("example", { executors: () => [executorNamed("local")] });
    const result = prepare({ plugins: [bad] });
    expect(codeOf(result)).toBe("plugin_executor_duplicate");
    expect(!result.ok && result.error.subject).toBe("local");
  });

  test("plugin_executor_duplicate: two plugins registering one name", () => {
    const remote = (id: string) => plugin(id, { executors: () => [executorNamed("remote")] });
    expect(codeOf(prepare({ plugins: [remote("one"), remote("two")], executor: "remote" }))).toBe(
      "plugin_executor_duplicate",
    );
  });

  test("executor_unknown: delivery.executor names nothing registered", () => {
    const result = prepare({ executor: "remote" });
    expect(codeOf(result)).toBe("executor_unknown");
    expect(!result.ok && result.error.subject).toBe("remote");
  });

  test("plugin_start_failed: a start that rejects, after the started ones are stopped", async () => {
    const calls: string[] = [];
    const good = plugin("good", {
      start: () => {
        calls.push("good start");
        return Promise.resolve();
      },
      stop: () => {
        calls.push("good stop");
        return Promise.resolve();
      },
    });
    const bad = plugin("bad", { start: () => Promise.reject(new Error("no token")) });
    const prepared = prepare({ plugins: [good, bad] });
    if (!prepared.ok) throw new Error(prepared.error.code);

    const started = await startPlugins(prepared.value, log);

    expect(!started.ok && started.error).toMatchObject({
      code: "plugin_start_failed",
      subject: "bad",
      data: { pluginId: "bad", phase: "start" },
    });
    expect(calls).toEqual(["good start", "good stop"]);
  });

  const throwing = () => {
    throw new Error("no credentials");
  };

  test("plugin_start_failed: executors() throws, at the check before the database", () => {
    const result = check({ plugins: [plugin("example", { executors: throwing })] });
    expect(!result.ok && result.error).toMatchObject({
      code: "plugin_start_failed",
      data: { pluginId: "example", phase: "executors" },
    });
  });

  test("plugin_start_failed: subscribers() throws", () => {
    const result = prepare({ plugins: [plugin("example", { subscribers: throwing })] });
    expect(!result.ok && result.error).toMatchObject({
      code: "plugin_start_failed",
      data: { pluginId: "example", phase: "subscribers" },
    });
  });

  test("plugin_start_failed: routes() throws", () => {
    const result = prepare({ plugins: [plugin("example", { routes: throwing })] });
    expect(!result.ok && result.error).toMatchObject({
      code: "plugin_start_failed",
      data: { pluginId: "example", phase: "routes" },
    });
  });
});

describe("the composed plugin set", () => {
  test("a plugin's executor is chosen by name, after the app's", () => {
    const remote = executorNamed("remote");
    const prepared = prepare({
      plugins: [plugin("example", { executors: () => [remote] })],
      executor: "remote",
    });
    expect(prepared.ok && prepared.value.executor).toBe(remote);
  });

  test("wrappers chain in plugin order around core, each given its parsed config", async () => {
    const order: string[] = [];
    const wrapping = (id: string) =>
      definePlugin({
        id,
        version: "1.0.0",
        sdk: `^${SDK_VERSION}`,
        config: DENIED_SCHEMA,
        seams: (config) => ({
          admitRun: (next) => async (request) => {
            order.push(`${id} ${config.denied.join(",")}`);
            return await next(request);
          },
        }),
      });
    const prepared = prepare({
      plugins: [wrapping("one"), wrapping("two")],
      pluginConfig: { one: { denied: ["a"] }, two: { denied: ["b"] } },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const seams: Seams = prepared.value.seams;

    const admitted = await seams.admitRun({
      kind: "delivery",
      projectId: "p",
      userId: "0".repeat(32),
      ticketSetId: "t",
    });

    expect(admitted).toEqual(ok(null));
    expect(order).toEqual(["two b", "one a"]);
  });

  test("stop runs in reverse order, each bounded at 5 s", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const first = plugin("first", {
      stop: () => {
        calls.push("first");
        return Promise.resolve();
      },
    });
    const hanging = plugin("hanging", {
      stop: () => {
        calls.push("hanging");
        return new Promise<void>(() => undefined);
      },
    });
    const prepared = prepare({ plugins: [first, hanging] });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const started = await startPlugins(prepared.value, log);
    if (!started.ok) throw new Error(started.error.code);

    const stopped = stopPlugins(started.value, log);
    await vi.advanceTimersByTimeAsync(PLUGIN_STOP_TIMEOUT_MS);
    await stopped;

    expect(calls).toEqual(["hanging", "first"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hanging"), null);
  });

  test("sdk ranges: exact and caret, with 0.x carets fixed at the minor", () => {
    expect(sdkSatisfies("0.1.0", "0.1.0")).toBe(true);
    expect(sdkSatisfies("^0.1.0", "0.1.3")).toBe(true);
    expect(sdkSatisfies("^0.1.0", "0.2.0")).toBe(false);
    expect(sdkSatisfies("^0.1.2", "0.1.1")).toBe(false);
    expect(sdkSatisfies("^1.2.0", "1.3.0")).toBe(true);
    expect(sdkSatisfies("^1.2.0", "2.0.0")).toBe(false);
    expect(sdkSatisfies("^0.0.3", "0.0.4")).toBe(false);
    expect(sdkSatisfies(">=0.1.0", "0.1.0")).toBe(false);
  });
});

describe("plugins in the app", () => {
  let webDistDir: string;

  beforeEach(async () => {
    webDistDir = join(root, "dist");
    await mkdir(webDistDir);
    await writeFile(join(webDistDir, "index.html"), "<!doctype html><title>ZeNorm</title>");
    await mkdir(join(root, "runs"));
  });

  function optionsFor(plugins: CheckedPlugins): AppOptions {
    return {
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      server: SERVER,
      chartMap: notCalled,
      grillWaypoint: notCalled,
      researchWaypoint: notCalled,
      workTask: notCalled,
      checkConsistency: notCalled,
      surveyCode: notCalled,
      settleFog: notCalled,
      draftSpecs: notCalled,
      reviseSpec: notCalled,
      reviewSpec: notCalled,
      draftTicketSet: notCalled,
      reviewTicketSet: notCalled,
      replyThroughHatch: notCalled,
      plugins,
      delivery: { runsDir: join(root, "runs"), checkTimeoutMinutes: 1 },
    };
  }

  /** The app with `plugins`, started and launched as the app entry does. */
  async function appWith(plugins: readonly ServerPlugin[]): Promise<ZeNormApp> {
    const checked = check({ plugins });
    if (!checked.ok) throw new Error(checked.error.code);
    const created = createApp(optionsFor(checked.value));
    if (!created.ok) throw new Error(created.error.code);
    const started = await created.value.startPlugins();
    if (!started.ok) throw new Error(started.error.code);
    created.value.launch();
    return created.value;
  }

  function clientOf(app: ZeNormApp): ContractRouterClient<Contract> {
    const link = new RPCLink({
      url: `${ORIGIN}/rpc`,
      fetch: async (request, init) => {
        const served = new Request(request, init);
        served.headers.set("host", HOST);
        return await app.request(served);
      },
    });
    return createORPCClient(link);
  }

  async function addProject(client: ContractRouterClient<Contract>, name: string) {
    const folderPath = join(root, name);
    const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
    execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
    execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "init"]);
    return await client.project.create({ folderPath, baseBranch: "main" });
  }

  test("a plugin set refused at composition creates no app", () => {
    const checked = check({
      plugins: [plugin("example", { subscribers: () => Object.fromEntries([["nope", () => 1]]) })],
    });
    if (!checked.ok) throw new Error(checked.error.code);
    const created = createApp(optionsFor(checked.value));
    expect(!created.ok && created.error.code).toBe("plugin_event_kind_unknown");
  });

  test("GET /plugins lists ids and versions, and a raw route answers under /plugins/<id>/", async () => {
    const app = await appWith([
      plugin("example", { routes: () => new Hono().get("/counts", (c) => c.json({ n: 1 })) }),
    ]);

    const listed = await app.request(`${ORIGIN}/plugins`, { headers: SERVED });
    expect(await listed.json()).toEqual([{ id: "example", version: "1.0.0" }]);
    const counts = await app.request(`${ORIGIN}/plugins/example/counts`, { headers: SERVED });
    expect(await counts.json()).toEqual({ n: 1 });
  });

  test("a subscriber gets each committed row of its table after the write", async () => {
    const all: ChangeEvent[] = [];
    const projects: ChangeEvent[] = [];
    const client = clientOf(
      await appWith([
        plugin("example", {
          subscribers: () => ({
            "*": (event) => {
              all.push(event);
            },
            projects: (event) => {
              projects.push(event);
            },
          }),
        }),
      ]),
    );

    const project = await addProject(client, "repo");

    expect(projects).toMatchObject([
      { entityType: "projects", entityId: project.id, op: "insert" },
    ]);
    expect(all.length).toBeGreaterThanOrEqual(projects.length);
  });

  test("the context names a project from the database at call time; an unknown id is null", async () => {
    const named: (string | null)[] = [];
    const client = clientOf(
      await appWith([
        plugin("example", {
          seams: (_config, context) => ({
            checkAccess: (next) => (userId, projectId, action) => {
              const name = context.projectName(projectId);
              named.push(name);
              return name !== "refused" && next(userId, projectId, action);
            },
          }),
        }),
      ]),
    );

    // Created while the server runs, and denied on its very first read.
    const refused = await addProject(client, "refused");
    const [first] = await safe(client.project.get({ projectId: refused.id }));
    expect(isDefinedError(first) && first.code).toBe("access_denied");
    expect(await client.project.list()).toEqual([]);
    const [unknown] = await safe(client.project.get({ projectId: UNKNOWN_ID }));
    expect(isDefinedError(unknown) && unknown.code).toBe("project_not_found");
    expect(named).toContain("refused");
  });

  test("a raw route checks its request with the composed identify and checkAccess", async () => {
    let denied: string | null = null;
    const app = await appWith([
      plugin("example", {
        seams: () => ({
          checkAccess: (next) => (userId, projectId, action) =>
            projectId !== denied && next(userId, projectId, action),
        }),
        routes: (_config, context) =>
          new Hono().get("/can/:projectId", (c) =>
            c.json(
              context.checkAccess(context.identify(c.req.raw), c.req.param("projectId"), "read"),
            ),
          ),
      }),
    ]);
    const client = clientOf(app);
    const kept = await addProject(client, "kept");
    const refused = await addProject(client, "refused");
    denied = refused.id;

    const can = async (id: string): Promise<unknown> =>
      await (await app.request(`${ORIGIN}/plugins/example/can/${id}`, { headers: SERVED })).json();
    expect(await can(kept.id)).toBe(true);
    expect(await can(refused.id)).toBe(false);
  });

  test("a denied project answers access_denied on its procedures and leaves the lists", async () => {
    let denied: string | null = null;
    const app = await appWith([
      plugin("example", {
        seams: () => ({
          checkAccess: (next) => (userId, projectId, action) =>
            projectId !== denied && next(userId, projectId, action),
        }),
      }),
    ]);
    const client = clientOf(app);
    const kept = await addProject(client, "kept");
    const refused = await addProject(client, "refused");
    const { map } = await client.map.create({ projectId: refused.id, idea: "An idea" });
    denied = refused.id;

    const [getError] = await safe(client.project.get({ projectId: refused.id }));
    expect(isDefinedError(getError) && getError.code).toBe("access_denied");
    expect(isDefinedError(getError) && getError.status).toBe(403);
    expect(isDefinedError(getError) && getError.data).toEqual({
      projectId: refused.id,
      action: "read",
    });
    const [createError] = await safe(client.map.create({ projectId: refused.id, idea: "An idea" }));
    expect(isDefinedError(createError) && createError.code).toBe("access_denied");
    const [deleteError] = await safe(client.map.delete({ mapId: map.id, deleteSpecs: [] }));
    expect(isDefinedError(deleteError) && [deleteError.code, deleteError.data]).toEqual([
      "access_denied",
      { projectId: refused.id, action: "write" },
    ]);
    expect((await client.project.list()).map((project) => project.id)).toEqual([kept.id]);
    // An unknown id is still the procedure's own not-found.
    const [unknown] = await safe(client.map.overview({ mapId: UNKNOWN_ID }));
    expect(isDefinedError(unknown) && unknown.code).toBe("map_not_found");
  });
});
