import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BAD_CASES } from "@zenorm/bad-plugins";
import type { BadServerCase, BadWebCase } from "@zenorm/bad-plugins";
import { PluginList } from "@zenorm/contracts";
import { createExamplePlugin } from "@zenorm/plugin-example/server";
import { EXAMPLE_PLUGIN } from "@zenorm/plugin-example/manifest";
import type { ServerPlugin } from "@zenorm/server";
import { SONNET_LIMITS } from "@zenorm/zenorm/e2e/model-limits";
import { SOURCE_ASSETS } from "@zenorm/zenorm/source-assets";
import { startZeNorm } from "@zenorm/zenorm/startup";
import type { StartedZeNorm } from "@zenorm/zenorm/startup";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Each bad plugin of `examples/bad-plugins` fails with its startup code: a server code from
 * `startZeNorm`, which composes `createApp` as `apps/zenorm` does, and a web code from
 * `createWebApp`'s blocking page. `executor_unknown` is a config failure: the example plugin with
 * `delivery.executor: "missing"`.
 */

/** The stand-in `claude` of `apps/zenorm`'s e2e: startup only checks it is executable. */
const FAKE_CLAUDE = createRequire(import.meta.url).resolve("@zenorm/zenorm/e2e/fake-claude");

/** The host and port the started app is configured on, and the Host a request to it carries. */
const SERVER = { host: "127.0.0.1", port: 4397 };
const HOST = `${SERVER.host}:${String(SERVER.port)}`;

let root: string;
let running: StartedZeNorm | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-bad-plugins-"));
  running = null;
});

/** Shuts the running server down as `serve.ts` does, bar the HTTP server. */
async function stopRunning(): Promise<void> {
  if (running === null) return;
  const { app, db } = running;
  running = null;
  await Promise.all([app.stopPlanningRuns(), app.stopDeliveryRuns()]);
  await app.stopPlugins();
  db.$client.close();
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await stopRunning();
  await rm(root, { recursive: true, force: true });
});

/** Starts ZeNorm on the test's data folder (made when absent) with `plugins`, the given sections and executor. */
async function start(
  plugins: readonly ServerPlugin[],
  pluginConfig: Readonly<Record<string, unknown>>,
  executor: string,
) {
  const dataDir = join(root, "data");
  const webDistDir = join(root, "web");
  await mkdir(dataDir, { recursive: true });
  await mkdir(webDistDir, { recursive: true });
  await writeFile(join(webDistDir, "index.html"), "<!doctype html>");
  const config = {
    server: SERVER,
    dataDir,
    agent: {
      claudePath: FAKE_CLAUDE,
      wayfindingModel: "claude-sonnet-5-5",
      specModel: "claude-sonnet-5-5",
      models: { "claude-sonnet-5-5": SONNET_LIMITS },
      effort: "medium",
      maxTurns: 12,
      timeoutSeconds: 30,
    },
    delivery: {
      model: "claude-sonnet-5-5",
      effort: "medium",
      orchestratorMaxTurns: 50,
      orchestratorTimeoutMinutes: 2,
      reviewerMaxTurns: 20,
      reviewerTimeoutMinutes: 2,
      checkTimeoutMinutes: 1,
      executor,
    },
    plugins: pluginConfig,
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const started = await startZeNorm({
    args: ["--config", configPath],
    // The stand-in claude's `#!/usr/bin/env node` finds node on `PATH`; the config is `--config`'s.
    env: { PATH: process.env.PATH },
    webDistDir,
    ...SOURCE_ASSETS,
    standardConfigPath: null,
    log: () => undefined,
    logError: () => undefined,
    plugins,
  });
  if (started.ok) {
    started.value.app.launch();
    running = started.value;
  }
  return started;
}

const SERVER_CASES = BAD_CASES.filter((bad): bad is BadServerCase => bad.kind === "server");
const WEB_CASES = BAD_CASES.filter((bad): bad is BadWebCase => bad.kind === "web");

describe("the bad plugins' server codes", () => {
  test.each(SERVER_CASES.map((bad) => [bad.code, bad] as const))("%s", async (code, bad) => {
    const started = await start(bad.plugins, bad.pluginConfig, "local");
    expect(started.ok ? null : started.error.code).toBe(code);
  });

  test("executor_unknown: the example plugin with delivery.executor naming no registration", async () => {
    const started = await start(
      [createExamplePlugin()],
      { example: { deniedProjectNames: [], refusedDeliveryProjectNames: [] } },
      "missing",
    );
    expect(started.ok ? null : started.error.code).toBe("executor_unknown");
  });

  test("the example plugin itself starts, with its executor chosen, and GET /plugins lists it", async () => {
    const started = await start(
      [createExamplePlugin()],
      { example: { deniedProjectNames: [], refusedDeliveryProjectNames: [] } },
      "example",
    );
    if (!started.ok) throw new Error(started.error.message);
    const response = await started.value.app.fetch(
      new Request(`http://${HOST}/plugins`, { headers: { host: HOST } }),
    );
    expect(PluginList.parse(await response.json())).toEqual([
      { id: EXAMPLE_PLUGIN.id, version: EXAMPLE_PLUGIN.version },
    ]);
  });
});

/** One oRPC call on the started app, in the RPC wire format: the status and the body's `json`. */
async function rpc(
  app: StartedZeNorm["app"],
  path: string,
  input: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await app.fetch(
    new Request(`http://${HOST}/rpc/${path}`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ json: input, meta: [] }),
    }),
  );
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("json" in body)) {
    throw new Error(`/rpc/${path} answered ${JSON.stringify(body)}`);
  }
  return { status: response.status, json: body.json };
}

function codeOf(json: unknown): unknown {
  return typeof json === "object" && json !== null && "code" in json ? json.code : null;
}

function idsOf(json: unknown): unknown[] {
  if (!Array.isArray(json)) throw new Error(`Not a list: ${JSON.stringify(json)}`);
  return json.map((item: unknown) =>
    typeof item === "object" && item !== null && "id" in item ? item.id : null,
  );
}

/** A git repository at `<root>/<name>` on `main` with one commit. */
function repository(name: string): string {
  const folderPath = join(root, name);
  const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
  execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "init"]);
  return folderPath;
}

describe("the example plugin's denial by name", () => {
  const SECTION = {
    example: { deniedProjectNames: ["denied-repo"], refusedDeliveryProjectNames: [] },
  };

  test("a denied project stored before start is denied on the very first requests", async () => {
    const before = await start([], {}, "local");
    if (!before.ok) throw new Error(before.error.code);
    const created = await rpc(before.value.app, "project/create", {
      folderPath: repository("denied-repo"),
      baseBranch: "main",
    });
    const [projectId] = idsOf([created.json]);
    await stopRunning();

    const started = await start([createExamplePlugin()], SECTION, "local");
    if (!started.ok) throw new Error(started.error.code);
    const { app } = started.value;

    // The Inbox's first read, then the project page's.
    expect(idsOf((await rpc(app, "project/list", undefined)).json)).toEqual([]);
    const got = await rpc(app, "project/get", { projectId });
    expect([got.status, codeOf(got.json)]).toEqual([403, "access_denied"]);
  });

  test("a denied project created while the server runs is denied on its first read", async () => {
    const started = await start([createExamplePlugin()], SECTION, "local");
    if (!started.ok) throw new Error(started.error.code);
    const { app } = started.value;
    const open = await rpc(app, "project/create", {
      folderPath: repository("open-repo"),
      baseBranch: "main",
    });

    const created = await rpc(app, "project/create", {
      folderPath: repository("denied-repo"),
      baseBranch: "main",
    });
    const [projectId] = idsOf([created.json]);

    const got = await rpc(app, "project/get", { projectId });
    expect([got.status, codeOf(got.json)]).toEqual([403, "access_denied"]);
    expect(idsOf((await rpc(app, "project/list", undefined)).json)).toEqual(idsOf([open.json]));
  });
});

describe("the bad plugins' web codes", () => {
  test.each(WEB_CASES.map((bad) => [bad.code, bad] as const))("%s", async (code, bad) => {
    const started = await start(bad.serverPlugins, {}, "local");
    if (!started.ok) throw new Error(started.error.message);
    const { app } = started.value;
    // A browser page on the app's origin for this case only: the server's modules need Node's
    // globals, so the window is not the file's environment.
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: `http://${HOST}/` });
    const { window } = dom;
    // JSDOM has no `matchMedia`; the web reads the system's colour scheme through it
    // (`lib/theme.ts`). A light system that never changes.
    window.matchMedia = (media: string): MediaQueryList =>
      Object.assign(new window.EventTarget(), {
        media,
        matches: false,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
      });
    vi.stubGlobal("window", window);
    vi.stubGlobal("self", window);
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("navigator", window.navigator);
    vi.stubGlobal("location", window.location);
    vi.stubGlobal("history", window.history);
    // The web asks its own origin for `GET /plugins`; here that is the started app.
    vi.stubGlobal("fetch", (input: string) =>
      app.fetch(new Request(input, { headers: { host: HOST } })),
    );
    // Imported once the window exists, as in a browser.
    const { createWebApp } = await import("@zenorm/web/app");

    const unmount = createWebApp({ plugins: bad.webPlugins });

    await vi.waitFor(() => {
      expect(dom.window.document.body.textContent).toContain(code);
    });
    // React's passive-effect callback, already scheduled, reads `window`: unmount, then let it run
    // before the globals are restored.
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
