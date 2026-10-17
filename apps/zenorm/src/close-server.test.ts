import { createServer, request } from "node:http";
import type { IncomingMessage, Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { closeHttpServer, SERVER_CLOSE_BOUND_MS } from "./close-server.ts";

let server: Server | null = null;

afterEach(() => {
  server?.closeAllConnections();
  server = null;
});

/** A server whose `/hang` never answers and whose other paths answer at once, keeping alive. */
async function listening(): Promise<{ server: Server; port: number }> {
  const created = createServer((req, res) => {
    if (req.url === "/hang") return;
    res.end("ok");
  });
  created.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => {
    created.listen(0, "127.0.0.1", resolve);
  });
  server = created;
  const address = created.address();
  if (address === null || typeof address === "string") throw new Error("Not listening on TCP");
  return { server: created, port: address.port };
}

/** A keep-alive GET; resolves with the response, or with the error that ended it. */
function get(port: number, path: string): Promise<IncomingMessage | Error> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { connection: "keep-alive" } });
    req.on("response", (response) => {
      response.resume();
      resolve(response);
    });
    req.on("error", resolve);
    req.end();
  });
}

describe("closing the server (S9-14b item 15)", () => {
  test("the bound is 2 s", () => {
    expect(SERVER_CLOSE_BOUND_MS).toBe(2_000);
  });

  test("an in-flight keep-alive request does not hold the close past the bound: it is ended", async () => {
    const { server: open, port } = await listening();
    const arrived = new Promise((resolve) => open.once("request", resolve));
    const hanging = get(port, "/hang");
    await arrived;

    const started = Date.now();
    const closed = await closeHttpServer(open, 200);

    expect(closed).toEqual({ error: undefined, forced: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await hanging).toBeInstanceOf(Error);
  });

  test("an idle keep-alive connection is closed at once, without forcing", async () => {
    const { server: open, port } = await listening();
    const answered = await get(port, "/");
    expect(answered).not.toBeInstanceOf(Error);

    const closed = await closeHttpServer(open, 60_000);

    expect(closed).toEqual({ error: undefined, forced: false });
  });
});
