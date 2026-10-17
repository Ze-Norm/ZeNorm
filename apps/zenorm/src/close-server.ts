import { Server } from "node:http";

/**
 * How long a closing server waits for its open connections before it ends them (S9-14b item 15):
 * a keep-alive connection serving a request, such as a browser's refetch after a reconnect, would
 * otherwise hold `server.close()` open, and the shutdown with it.
 */
export const SERVER_CLOSE_BOUND_MS = 2_000;

/** How a server's close went. */
export interface ServerClose {
  /** The close's own error (the server was not listening), if any. */
  readonly error: Error | undefined;
  /** True when connections were still open at the bound and were ended. */
  readonly forced: boolean;
}

/**
 * Closes `server`: it stops accepting, ends its idle keep-alive connections, and waits for the
 * others; `boundMs` later it ends every connection still open, so the close always resolves. A
 * server that is not Node's HTTP server is a programmer error.
 */
export function closeHttpServer(server: unknown, boundMs: number): Promise<ServerClose> {
  if (!(server instanceof Server)) {
    throw new Error("ZeNorm's server is not a Node HTTP server");
  }
  return new Promise<ServerClose>((resolve) => {
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, boundMs);
    server.close((error) => {
      clearTimeout(timer);
      resolve({ error, forced });
    });
    server.closeIdleConnections();
  });
}
