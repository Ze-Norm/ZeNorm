import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { err, ok } from "@zenorm/contracts";
import type { Result, StartupError } from "@zenorm/contracts";
import type { ServerPlugin } from "@zenorm/server";

import { closeHttpServer, SERVER_CLOSE_BOUND_MS } from "./close-server.ts";
import { shutDown, startZeNorm } from "./startup.ts";
import type { StartedZeNorm, StartupInput, ZeNormAssets } from "./startup.ts";

/**
 * What an entry composes: its arguments, its assets, its config fallback and its server plugins,
 * in order.
 */
export interface ServeOptions extends ZeNormAssets {
  /** The arguments `--config` is read from: the process's, or those after `zenorm run`. */
  readonly args: readonly string[];
  /** See `StartupInput.standardConfigPath`; null for the repository's entries. */
  readonly standardConfigPath: string | null;
  readonly plugins: readonly ServerPlugin[];
}

/** Unexpected errors go to stderr; a plain line (`error` null) to stdout. */
function logError(message: string, error: unknown): void {
  if (error === null) {
    console.log(message);
    return;
  }
  console.error(message, error);
}

/** Prints a startup refusal as one JSON line `{ code, message, subject }` to stderr. */
export function printRefusal(error: StartupError): void {
  const { code, message, subject } = error;
  // `plugin_start_failed` names its plugin and phase too.
  const line =
    "data" in error ? { code, message, subject, data: error.data } : { code, message, subject };
  console.error(JSON.stringify(line));
}

/**
 * Starts ZeNorm from `options` and `env` (where `ZENORM_CONFIG` is read): a refusal is the coded
 * `StartupError`, with nothing listening; otherwise the server listens and shuts down in order on
 * SIGTERM or SIGINT. The app launches (sweeping interrupted runs and relaunching the running ones)
 * only once the port is bound: a refused bind (`server_port_in_use`, `server_listen_failed`) stops
 * the plugins and closes the database, having marked no run interrupted and relaunched none. The
 * startup sweeps have run by then, which is safe: the data folder's lock shows no other ZeNorm owns
 * what they clean up.
 */
export async function startAndListen(
  options: ServeOptions,
  env: StartupInput["env"],
): Promise<Result<null, StartupError>> {
  const started = await startZeNorm({
    ...options,
    env,
    log: (line) => {
      console.log(line);
    },
    logError,
  });
  if (!started.ok) {
    return started;
  }
  const bound = await bind(started.value);
  if (!bound.ok) {
    try {
      await started.value.app.stopPlugins();
    } finally {
      started.value.db.$client.close();
    }
    return bound;
  }
  started.value.app.launch();
  console.log(`ZeNorm listening on ${bound.value.url}`);
  handleShutdown(started.value, bound.value.server);
  return ok(null);
}

/** The listen error `bind` reports as `server_port_in_use`; any other is `server_listen_failed`. */
const PORT_IN_USE = "EADDRINUSE";

interface Bound {
  readonly server: ServerType;
  readonly url: string;
}

/** Binds the config's host and port; a listen error is the coded `StartupError`. */
function bind({ config, app }: StartedZeNorm): Promise<Result<Bound, StartupError>> {
  const { host, port } = config.server;
  const subject = `${host}:${String(port)}`;
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      server.off("error", refused);
      resolve(ok({ server, url: `http://${info.address}:${String(info.port)}` }));
    });
    function refused(error: Error): void {
      const code = "code" in error && typeof error.code === "string" ? error.code : null;
      resolve(
        err(
          code === PORT_IN_USE
            ? {
                code: "server_port_in_use",
                message: `Something is already listening on ${subject}. Stop it, or set another server.port in the config`,
                subject,
              }
            : {
                code: "server_listen_failed",
                message: `ZeNorm could not listen on ${subject}: ${error.message}`,
                subject,
              },
        ),
      );
    }
    server.once("error", refused);
  });
}

/**
 * The process an app entry runs (`apps/zenorm`'s `main.ts`, and `apps/zenorm-example`'s with the
 * example plugin): start ZeNorm, print a refusal's code and exit 1, otherwise listen.
 */
export async function serveZeNorm(options: ServeOptions): Promise<void> {
  const started = await startAndListen(options, process.env);
  if (!started.ok) {
    printRefusal(started.error);
    process.exit(1);
  }
}

/** Shuts the listening `server` and the app down in order on SIGTERM or SIGINT. */
function handleShutdown({ db, app }: StartedZeNorm, server: ServerType): void {
  function shutdown(signal: NodeJS.Signals): void {
    console.log(`Received ${signal}; stopping the planning and delivery runs, then closing`);
    let closeFailed = false;
    void shutDown({
      closeServer: async () => {
        // Open `/events` streams would hold the close; end them first. A keep-alive
        // connection still serving a request is ended at the bound.
        app.closeStreams();
        const closed = await closeHttpServer(server, SERVER_CLOSE_BOUND_MS);
        if (closed.forced) {
          console.log(
            `Ended the connections still open ${String(SERVER_CLOSE_BOUND_MS / 1000)} s after the server's close`,
          );
        }
        if (closed.error !== undefined) {
          console.error("Error while closing the server", closed.error);
          closeFailed = true;
        }
      },
      stopPlanningRuns: () => app.stopPlanningRuns(),
      stopDeliveryRuns: () => app.stopDeliveryRuns(),
      stopPlugins: () => app.stopPlugins(),
      closeDatabase: () => {
        db.$client.close();
      },
    }).then(() => {
      // Exit explicitly: an executor or plugin past its stop bound may still hold open handles
      // (a socket, a timer, a child) that would keep the process alive.
      const code = closeFailed ? 1 : 0;
      console.log(`ZeNorm stopped; exiting with code ${String(code)}`);
      process.exit(code);
    });
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
