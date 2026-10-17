import { join } from "node:path";

import { isDefinedError, safe } from "@orpc/client";
import { createChangeBus } from "@zenorm/core";
import { MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import { definePlugin, SDK_VERSION } from "@zenorm/plugin-sdk";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createApp } from "./app.ts";
import type { AppOptions, ZeNormApp } from "./app.ts";
import {
  INDEX_HTML,
  SERVER,
  HOST,
  ORIGIN,
  SERVED,
  UNKNOWN_ID,
  planningPorts,
  localExecutor,
  checked,
  appOf,
  root,
  db,
  webDistDir,
  log,
  app,
  client,
  setUpAppTests,
} from "./app-test-support.ts";

setUpAppTests();

describe("HTTP", () => {
  test("/healthz is 200", async () => {
    const response = await app.request(`${ORIGIN}/healthz`, { headers: SERVED });
    expect(response.status).toBe(200);
  });

  test("serves files from the web build", async () => {
    const response = await app.request(`${ORIGIN}/asset.js`, { headers: SERVED });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {};");
  });

  test.each(["/", "/projects/some/route"])("GET %s serves index.html", async (path) => {
    const response = await app.request(`${ORIGIN}${path}`, { headers: SERVED });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toBe(INDEX_HTML);
  });
});

describe("the request guard (Host on every route; Origin and JSON on /rpc)", () => {
  /** Every route family: /rpc, /healthz, /events, /plugins, a plugin's route and the web app. */
  const ROUTES = [
    "/rpc/project/list",
    "/healthz",
    "/events",
    "/plugins",
    "/plugins/example/counts",
    "/asset.js",
    "/",
  ];
  /** A body oRPC accepts for a procedure with no input. */
  const RPC_BODY = JSON.stringify({ json: null, meta: [] });
  const JSON_TYPE = { "content-type": "application/json" };

  let identifyCalls: number;
  let guarded: ZeNormApp;

  /** An app with a plugin that has a route and counts each procedure's identity read. */
  async function guardedApp(server: AppOptions["server"]): Promise<ZeNormApp> {
    const example = definePlugin({
      id: "example",
      version: "1.0.0",
      sdk: `^${SDK_VERSION}`,
      seams: () => ({
        identify: (next) => (request) => {
          identifyCalls += 1;
          return next(request);
        },
      }),
      routes: () => new Hono().get("/counts", (c) => c.json({ n: 1 })),
    });
    return await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      server,
      plugins: checked([example], [localExecutor()], "local"),
    });
  }

  beforeEach(async () => {
    identifyCalls = 0;
    guarded = await guardedApp(SERVER);
  });

  afterEach(() => {
    guarded.closeStreams();
  });

  /** One request to `route` on `target`: a POST of JSON to a procedure, a GET anywhere else. */
  async function visitOn(
    target: ZeNormApp,
    route: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const url = `${ORIGIN}${route}`;
    if (route.startsWith("/rpc/")) {
      return await target.request(url, {
        method: "POST",
        headers: { ...JSON_TYPE, ...headers },
        body: RPC_BODY,
      });
    }
    return await target.request(url, { headers });
  }

  async function visit(route: string, headers: Record<string, string>): Promise<Response> {
    return await visitOn(guarded, route, headers);
  }

  /** Each host with each route. */
  function everyRoute(hosts: readonly string[]): [string, string][] {
    return hosts.flatMap((host) => ROUTES.map((route): [string, string] => [host, route]));
  }

  /** The one line the guard logged, which names the route and the header value it refused. */
  function logged(): string {
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]?.[0];
    if (message === undefined) throw new Error("The guard logged nothing");
    return message;
  }

  /** Ends a served response, which on /events is a stream that never ends by itself. */
  async function served(response: Response): Promise<void> {
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }

  const ALLOWED_HOSTS = [
    "127.0.0.1:4310",
    "localhost:4310",
    "[::1]:4310",
    "LocalHost:4310",
    "LOCALHOST:4310",
  ];

  test.each(everyRoute(ALLOWED_HOSTS))("Host %s is served on %s", async (host, route) => {
    await served(await visit(route, { host }));
    expect(log).not.toHaveBeenCalled();
  });

  test("the configured host is served on its port, with its name compared case-insensitively", async () => {
    const configured = await guardedApp({ host: "ZeNorm.Example", port: 4311 });

    for (const host of ["zenorm.example:4311", "ZENORM.EXAMPLE:4311", "127.0.0.1:4311"]) {
      for (const route of ROUTES) {
        await served(await visitOn(configured, route, { host }));
      }
    }
    const wrongPort = await visitOn(configured, "/healthz", { host: "zenorm.example:4310" });
    expect(wrongPort.status).toBe(403);
    expect(await wrongPort.text()).toBe("host_not_allowed");
  });

  test("an IPv6 host is bracketed as a Host header spells it", async () => {
    const configured = await guardedApp({ host: "::1", port: 4311 });

    await served(await visitOn(configured, "/healthz", { host: "[::1]:4311" }));
    const unbracketed = await visitOn(configured, "/healthz", { host: "::1:4311" });
    expect(unbracketed.status).toBe(403);
  });

  const REFUSED_HOSTS = [
    "127.0.0.1:4311",
    "localhost:80",
    "127.0.0.1",
    "localhost",
    "[::1]",
    "127.0.0.1.evil.com:4310",
    "localhost.evil.com:4310",
    "evil.com:4310",
    "evil.com",
    "zenorm.test:4310",
    "0.0.0.0:4310",
  ];

  test.each(everyRoute(REFUSED_HOSTS))(
    "Host %s is refused on %s with host_not_allowed, and logged with both",
    async (host, route) => {
      const response = await visit(route, { host });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("host_not_allowed");
      expect(identifyCalls).toBe(0);
      const line = logged();
      expect(line).toContain(route);
      expect(line).toContain(host);
    },
  );

  test("a request with no Host is refused with host_not_allowed", async () => {
    const response = await visit("/healthz", {});

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("host_not_allowed");
    expect(logged()).toContain("/healthz");
  });

  test("an unknown path with a foreign Host is refused, not answered as the web app or a 404", async () => {
    const response = await visit("/projects/some/route", { host: "evil.com:4310" });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("host_not_allowed");
  });

  test("a foreign Host is refused before its Origin or Content-Type are read", async () => {
    const response = await guarded.request(`${ORIGIN}/rpc/project/list`, {
      method: "POST",
      headers: { host: "evil.com:4310", origin: "https://evil.com", "content-type": "text/plain" },
      body: RPC_BODY,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("host_not_allowed");
    expect(identifyCalls).toBe(0);
  });

  const FOREIGN_ORIGINS = [
    "https://evil.com",
    "http://evil.com",
    "null",
    "https://127.0.0.1:4310",
    "https://localhost:4310",
    "http://127.0.0.1:4311",
    "http://127.0.0.1",
    "http://localhost",
    "http://127.0.0.1.evil.com:4310",
    "http://localhost:4310.evil.com",
    "http://evil.com:4310",
    "ftp://127.0.0.1:4310",
    "127.0.0.1:4310",
  ];

  test.each(FOREIGN_ORIGINS)(
    "Origin %s is refused on /rpc with origin_not_allowed, runs no procedure and is logged",
    async (origin) => {
      const response = await visit("/rpc/project/list", { host: HOST, origin });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("origin_not_allowed");
      expect(identifyCalls).toBe(0);
      const line = logged();
      expect(line).toContain("/rpc/project/list");
      expect(line).toContain(origin);
    },
  );

  test("a foreign Origin is refused on a GET of /rpc too", async () => {
    const response = await guarded.request(`${ORIGIN}/rpc/project/list`, {
      headers: { host: HOST, origin: "https://evil.com" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("origin_not_allowed");
    expect(identifyCalls).toBe(0);
  });

  /** The server is configured on 127.0.0.1, so a page at localhost is served too. */
  const OWN_ORIGINS = [
    "http://127.0.0.1:4310",
    "http://localhost:4310",
    "http://LocalHost:4310",
    "http://[::1]:4310",
  ];

  test.each(OWN_ORIGINS)("Origin %s is served on /rpc", async (origin) => {
    await served(await visit("/rpc/project/list", { host: HOST, origin }));

    expect(identifyCalls).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  test("a page at localhost calling a server configured on 127.0.0.1 is served", async () => {
    const headers = { host: "localhost:4310", origin: "http://localhost:4310" };

    await served(await visit("/rpc/project/list", headers));

    expect(identifyCalls).toBe(1);
  });

  test("the configured host's own Origin is served", async () => {
    const configured = await guardedApp({ host: "zenorm.example", port: 4311 });
    const own = { host: "zenorm.example:4311", origin: "http://ZeNorm.Example:4311" };
    const wrongPort = { host: "zenorm.example:4311", origin: "http://zenorm.example:4310" };

    await served(await visitOn(configured, "/rpc/project/list", own));
    const refused = await visitOn(configured, "/rpc/project/list", wrongPort);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("origin_not_allowed");
  });

  test("a request with no Origin is served on /rpc", async () => {
    await served(await visit("/rpc/project/list", { host: HOST }));

    expect(identifyCalls).toBe(1);
  });

  test("a foreign Origin is not read outside /rpc", async () => {
    await served(await visit("/healthz", { host: HOST, origin: "https://evil.com" }));
    await served(await visit("/plugins", { host: HOST, origin: "null" }));

    expect(log).not.toHaveBeenCalled();
  });

  /** A POST to the procedure with `contentType` (none when null) and `body` (none when null). */
  async function post(
    contentType: string | null,
    body: Uint8Array<ArrayBuffer> | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { host: HOST };
    if (contentType !== null) headers["content-type"] = contentType;
    return await guarded.request(`${ORIGIN}/rpc/project/list`, { method: "POST", headers, body });
  }

  const BODY = new TextEncoder().encode(RPC_BODY);
  /** Not declared as JSON, in each way a page's request can be (a Uint8Array sets no type). */
  const NOT_JSON: (string | null)[] = [
    "text/plain",
    "text/plain;charset=UTF-8",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "application/jsonp",
    "text/json",
    "application/",
    "",
    null,
  ];

  /** Each content type with a body and without one. */
  const NOT_JSON_CASES = NOT_JSON.flatMap((type): [string | null, boolean][] => [
    [type, true],
    [type, false],
  ]);

  test.each(NOT_JSON_CASES)(
    "a POST to /rpc with Content-Type %s (body: %s) is 415 content_type_not_json, runs no procedure and is logged",
    async (type, withBody) => {
      const response = await post(type, withBody ? BODY : null);

      expect(response.status).toBe(415);
      expect(await response.text()).toBe("content_type_not_json");
      expect(identifyCalls).toBe(0);
      const line = logged();
      expect(line).toContain("/rpc/project/list");
      if (type !== null) expect(line).toContain(type);
    },
  );

  const JSON_TYPES = [
    "application/json",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    "Application/JSON",
  ];

  test.each(JSON_TYPES)("a POST to /rpc with Content-Type %s is served", async (type) => {
    const response = await post(type, BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: [] });
    expect(identifyCalls).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  test("the client's calls are served: a procedure with no input and one with input", async () => {
    expect(await client.project.list()).toEqual([]);
    const [error] = await safe(client.project.get({ projectId: UNKNOWN_ID }));
    expect(isDefinedError(error) && error.code).toBe("project_not_found");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("createApp's database", () => {
  test("a database whose connection has no change-feed triggers is change_feed_missing", () => {
    const opened = openDatabase(join(root, "bare.sqlite"));
    if (!opened.ok) throw new Error(opened.error.code);
    const bare = opened.value;
    try {
      const migrated = migrateDatabase(bare, MIGRATIONS_FOLDER);
      if (!migrated.ok) throw new Error(migrated.error.code);
      const created = createApp({
        db: bare,
        bus: createChangeBus(log),
        webDistDir,
        log,
        ...planningPorts(),
      });
      expect(created).toMatchObject({ ok: false, error: { code: "change_feed_missing" } });
    } finally {
      bare.$client.close();
    }
  });
});
