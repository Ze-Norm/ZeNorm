import { err } from "@zenorm/contracts";
import { definePlugin } from "@zenorm/plugin-sdk";
import type { ServerPlugin, Subscriber } from "@zenorm/plugin-sdk";
import { Hono } from "hono";

import { exampleExecutor } from "./executor.ts";
import type { ExecutorCalls } from "./executor.ts";
import { EXAMPLE_PLUGIN, ExampleConfig, REFUSED_DELIVERY_REASON } from "./manifest.ts";
import type { ExampleCounts } from "./manifest.ts";

type SeamCounts = { -readonly [K in keyof ExampleCounts["seams"]]: number };

/**
 * The example plugin's server entry: a wrapper on every seam that counts its calls (access denies
 * the projects `deniedProjectNames` names; admission refuses a delivery start on one
 * `refusedDeliveryProjectNames` names), a `*` subscriber counting committed rows per project, `GET
 * /plugins/example/counts` (the projects the request's User may read), the `example` executor, and
 * `start` and `stop` that log once. Each call builds fresh in-memory counts. A project's name is
 * read through the context when a seam asks, so a denial holds from the first request; an id with
 * no project is left to the procedure's own not-found.
 */
export function createExamplePlugin(): ServerPlugin {
  const seams: SeamCounts = {
    identify: 0,
    checkAccess: 0,
    checkout: 0,
    executorEnv: 0,
    admitRun: 0,
  };
  const executorCalls: ExecutorCalls = { implement: 0, review: 0 };
  const projects = new Map<string, number>();
  let log: ((line: string) => void) | null = null;

  function logLine(line: string): void {
    if (log === null) throw new Error("The example plugin logged before its start");
    log(line);
  }

  /** The counts, with the projects `canRead` admits (its checks counted too). */
  function counts(canRead: (projectId: string) => boolean): ExampleCounts {
    const readable = [...projects].filter(([projectId]) => canRead(projectId));
    return {
      seams: { ...seams },
      executor: { ...executorCalls },
      projects: Object.fromEntries(readable),
    };
  }

  const countRows: Subscriber = (event) => {
    const counted = projects.get(event.projectId);
    projects.set(event.projectId, counted === undefined ? 1 : counted + 1);
  };

  return definePlugin({
    ...EXAMPLE_PLUGIN,
    config: ExampleConfig,
    seams: (config, context) => ({
      identify: (next) => (request) => {
        seams.identify += 1;
        return next(request);
      },
      checkAccess: (next) => (userId, projectId, action) => {
        seams.checkAccess += 1;
        const name = context.projectName(projectId);
        if (name !== null && config.deniedProjectNames.includes(name)) return false;
        return next(userId, projectId, action);
      },
      checkout: (next) => (project) => {
        seams.checkout += 1;
        return next(project);
      },
      executorEnv: (next) => (run) => {
        seams.executorEnv += 1;
        return next(run);
      },
      admitRun: (next) => (request) => {
        seams.admitRun += 1;
        const name = context.projectName(request.projectId);
        if (name !== null && config.refusedDeliveryProjectNames.includes(name)) {
          return Promise.resolve(
            err({
              code: "delivery_not_admitted",
              message: `The example plugin refused a delivery run in project ${name}`,
              data: { reason: REFUSED_DELIVERY_REASON },
            }),
          );
        }
        return next(request);
      },
    }),
    subscribers: () => ({ "*": countRows }),
    // The route checks its own request: a project the User may not read is left out.
    routes: (_config, context) =>
      new Hono().get("/counts", (c) => {
        const userId = context.identify(c.req.raw);
        return c.json(counts((projectId) => context.checkAccess(userId, projectId, "read")));
      }),
    executors: () => [exampleExecutor(executorCalls)],
    start: (config, context) => {
      log = context.log;
      context.log(
        `Example plugin started: denies ${String(config.deniedProjectNames.length)} project names, refuses delivery in ${String(config.refusedDeliveryProjectNames.length)}`,
      );
      return Promise.resolve();
    },
    stop: () => {
      logLine("Example plugin stopped");
      return Promise.resolve();
    },
  });
}
