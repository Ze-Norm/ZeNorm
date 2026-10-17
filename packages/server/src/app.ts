import { serveStatic } from "@hono/node-server/serve-static";
import { implement, onError, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@zenorm/contracts";
import type {
  AccessAction,
  ChartMap,
  CheckConsistency,
  InstanceConfig,
  SurveyCode,
  SettleFog,
  DeliveryRun,
  DraftSpecs,
  DraftTicketSet,
  GrillWaypoint,
  ReplyThroughHatch,
  ResearchWaypoint,
  Result,
  ReviewSpec,
  ReviewTicketSet,
  ReviseSpec,
  Seams,
  StartupError,
  UserId,
  WorkTask,
} from "@zenorm/contracts";
import { err, ok } from "@zenorm/contracts";
import {
  approveSpecRevision,
  approveTicketSet,
  cancelDelivery,
  checkPullRequest,
  cleanUpDeletedRuns,
  confirmProposal,
  createMap,
  createProject,
  deleteMap,
  dismissProposal,
  getDeliveryRun,
  getDeliveryActivity,
  getMap,
  getMapOverview,
  getProjectDetail,
  inspectProject,
  listMapOverviews,
  listMaps,
  listProjects,
  markMerged,
  openPullRequestRuns,
  PULL_REQUEST_CHECK_INTERVAL_MS,
  rejectSpecRevision,
  rejectTicketSet,
  resumeDelivery,
  saveProjectSettings,
  sendHatchMessage,
  startDelivery,
  submitAnswers,
  sweepInterruptedRuns,
  toDeliveryRun,
  tryAgain,
} from "@zenorm/core";
import { setChangeBus, setSeams } from "@zenorm/core";
import type { ChangeBus, RunnerStates, StoredDeliveryRun } from "@zenorm/core";
import { changeFeedInstalled } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { Hono } from "hono";

import { accessRefusal } from "./access.ts";
import type { ProjectRef } from "./access.ts";
import { createDeliveryRunner } from "./delivery.ts";
import { createEventStreams } from "./events.ts";
import type { DeliveryRunner } from "./delivery.ts";
import { createPlanningRunner } from "./planning.ts";
import type { PlanningRunner } from "./planning.ts";
import { requestGuard } from "./request-guard.ts";
import { composePlugins, startPlugins, stopPlugins, subscribePlugins } from "./plugins.ts";
import type { BoundPlugin, CheckedPlugins } from "./plugins.ts";

const INTERNAL_SERVER_ERROR = 500;

/**
 * Receives every unexpected error, and plain lines with `error` null (a plugin's start line, a
 * plugin executor that outlived the stop bound); the app entry decides where they go.
 */
export type Log = (message: string, error: unknown) => void;

export interface AppOptions {
  readonly db: ZeNormDatabase;
  /**
   * The after-commit bus every `write` on `db` publishes to; `apps/zenorm` creates it with
   * `createChangeBus`. The SSE route and plugin subscribers subscribe to it.
   */
  readonly bus: ChangeBus;
  /** Absolute path of the built web app; must hold `index.html`. */
  readonly webDistDir: string;
  readonly log: Log;
  /**
   * The host and port the server listens on (the instance config's `server`): the guard serves
   * only a Host (and, on `/rpc`, an Origin) that is this `host:port`, or `localhost`, `127.0.0.1`
   * or `[::1]` on this port. `apps/zenorm` passes `config.server`.
   */
  readonly server: InstanceConfig["server"];
  /** The planning agent's chart; `apps/zenorm` builds it from the instance config. */
  readonly chartMap: ChartMap;
  /** The planning agent's grilling of a waypoint; `apps/zenorm` builds it from the instance config. */
  readonly grillWaypoint: GrillWaypoint;
  /** The planning agent's research of a waypoint; `apps/zenorm` builds it from the instance config. */
  readonly researchWaypoint: ResearchWaypoint;
  /** The planning agent's work on a Task waypoint; `apps/zenorm` builds it from the instance config. */
  readonly workTask: WorkTask;
  /** The planning agent's consistency pass; `apps/zenorm` builds it from the instance config. */
  readonly checkConsistency: CheckConsistency;
  /** The planning agent's code survey of a map; `apps/zenorm` builds it from the instance config. */
  readonly surveyCode: SurveyCode;
  /** The planning agent's fog run of a map; `apps/zenorm` builds it from the instance config. */
  readonly settleFog: SettleFog;
  /** The planning agent's To Spec of a cleared map; `apps/zenorm` builds it from the instance config. */
  readonly draftSpecs: DraftSpecs;
  /** The planning agent's repair of one spec; `apps/zenorm` builds it from the instance config. */
  readonly reviseSpec: ReviseSpec;
  /** The planning agent's spec review; `apps/zenorm` builds it from the instance config. */
  readonly reviewSpec: ReviewSpec;
  /** The planning agent's To Tickets; `apps/zenorm` builds it from the instance config. */
  readonly draftTicketSet: DraftTicketSet;
  /** The planning agent's tickets review; `apps/zenorm` builds it from the instance config. */
  readonly reviewTicketSet: ReviewTicketSet;
  /** The planning agent's reply to a hatch message; `apps/zenorm` builds it from the instance config. */
  readonly replyThroughHatch: ReplyThroughHatch;
  /**
   * The composition's server plugins, checked by `checkPlugins` before the database was opened,
   * with the executor `delivery.executor` chose from the app's (`"local"` in `apps/zenorm`) and the
   * plugins'.
   */
  readonly plugins: CheckedPlugins;
  readonly delivery: {
    /** Absolute path of the folder that holds every run folder, `<dataDir>/runs`. */
    readonly runsDir: string;
    /** Each check's bound. */
    readonly checkTimeoutMinutes: number;
  };
}

/** A core error: a stable code with its message and the code's data. */
interface CodedFailure {
  readonly code: string;
  readonly message: string;
  readonly data: unknown;
}

/** A procedure's oRPC error constructors for each code of `E`, each taking that code's data. */
type ErrorConstructors<E extends CodedFailure> = {
  readonly [C in E["code"]]: (options: {
    message: string;
    data: Extract<E, { code: C }>["data"];
  }) => Error;
};

/**
 * The oRPC error for a core error. The mapped type pairs each code with its own constructor, so a
 * procedure that does not declare one of `E`'s codes fails to typecheck.
 */
function refusal<E extends CodedFailure>(errors: ErrorConstructors<E>, error: E): Error {
  const code: E["code"] = error.code;
  const make = errors[code];
  return make({ message: error.message, data: error.data });
}

/** A stored run with its derived state: `running` while the delivery runner holds it. */
function deliveryRunOf(run: StoredDeliveryRun, deliveryRunner: DeliveryRunner): DeliveryRun {
  return toDeliveryRun(run, deliveryRunner.held(run.id));
}

/** What every RPC call carries: the incoming request, for the identity seam. */
interface RpcContext {
  readonly request: Request;
}

/** A procedure's `access_denied` constructor. */
interface AccessErrors {
  readonly access_denied: (options: {
    message: string;
    data: { projectId: string; action: AccessAction };
  }) => Error;
}

function createRouter(
  db: ZeNormDatabase,
  seams: Seams,
  runner: PlanningRunner,
  deliveryRunner: DeliveryRunner,
  delivery: { runsDir: string; executor: string },
  /** Aborted on shutdown: stops a Check now's gh call. */
  pullRequestSignal: AbortSignal,
  log: Log,
) {
  const { runsDir, executor } = delivery;
  const os = implement(contract).$context<RpcContext>();

  /** What `mapStatus` reads of the delivery runner: a held run is `running`. */
  const runnerStates: RunnerStates = {
    deliveryHeld: (runId) => deliveryRunner.held(runId),
  };

  /**
   * The RPC boundary: `identify` names the User; the input's record resolves to its project;
   * `checkAccess` admits the action or the procedure answers `access_denied`. Returns the User the
   * procedure acts as.
   */
  function guard(
    context: RpcContext,
    errors: AccessErrors,
    ref: ProjectRef,
    action: AccessAction,
  ): UserId {
    const userId = seams.identify(context.request);
    const refused = accessRefusal(db, seams.checkAccess, userId, ref, action);
    if (refused !== null) {
      throw errors.access_denied({ message: refused.message, data: refused.data });
    }
    return userId;
  }

  /** A list with no project filter keeps the projects the User may read. */
  function readable(context: RpcContext): (projectId: string) => boolean {
    const userId = seams.identify(context.request);
    return (projectId) => seams.checkAccess(userId, projectId, "read");
  }

  /**
   * Launches what a write on the map made due, on any map (a write may end a hold another map waits
   * on), and returns the map's overview.
   */
  async function overviewAfter(mapId: string) {
    runner.launch(null);
    const overview = await getMapOverview(db, mapId, runnerStates);
    if (!overview.ok) {
      throw new Error(`Map ${mapId} vanished after a write on it`);
    }
    return overview.value;
  }

  return os.router({
    project: {
      list: os.project.list.handler(async ({ context }) => {
        const allowed = readable(context);
        return (await listProjects(db)).filter((project) => allowed(project.id));
      }),
      get: os.project.get.handler(async ({ input, errors, context }) => {
        guard(context, errors, { projectId: input.projectId }, "read");
        const result = await getProjectDetail(db, input.projectId);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      inspect: os.project.inspect.handler(async ({ input, errors }) => {
        const result = await inspectProject(db, input.folderPath);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      // A new project names no stored project yet: identity only, no access check.
      create: os.project.create.handler(async ({ input, errors, context }) => {
        const userId = seams.identify(context.request);
        const result = await createProject({ kind: "user", userId }, db, input);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      saveSettings: os.project.saveSettings.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { projectId: input.projectId }, "write");
        const result = await saveProjectSettings({ kind: "user", userId }, db, input);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
    map: {
      list: os.map.list.handler(async ({ input, errors, context }) => {
        guard(context, errors, { projectId: input.projectId }, "read");
        const result = await listMaps(db, input.projectId);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      create: os.map.create.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { projectId: input.projectId }, "write");
        const result = await createMap({ kind: "user", userId }, db, input);
        if (result.ok) {
          // The first chart runs in the background; the request does not wait on it.
          runner.launch(null);
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      get: os.map.get.handler(async ({ input, errors, context }) => {
        guard(context, errors, { mapId: input.mapId }, "read");
        const result = await getMap(db, input.mapId);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      overviews: os.map.overviews.handler(async ({ context }) => {
        const allowed = readable(context);
        return (await listMapOverviews(db, runnerStates)).filter((overview) =>
          allowed(overview.project.id),
        );
      }),
      overview: os.map.overview.handler(async ({ input, errors, context }) => {
        guard(context, errors, { mapId: input.mapId }, "read");
        const result = await getMapOverview(db, input.mapId, runnerStates);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      confirmProposal: os.map.confirmProposal.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { proposalId: input.proposalId }, "write");
        const result = await confirmProposal({ kind: "user", userId }, db, input);
        if (!result.ok) {
          const { error } = result;
          throw refusal(errors, error);
        }
        // The new map's first chart runs in the background, as `map.create`'s does.
        return await overviewAfter(result.value.mapId);
      }),
      dismissProposal: os.map.dismissProposal.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { proposalId: input.proposalId }, "write");
        const result = dismissProposal({ kind: "user", userId }, db, input);
        if (!result.ok) {
          const { error } = result;
          throw refusal(errors, error);
        }
        return await overviewAfter(result.value);
      }),
      delete: os.map.delete.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { mapId: input.mapId }, "write");
        const result = deleteMap({ kind: "user", userId }, db, input);
        if (result.ok) {
          // What the map's holds held back on other maps may have started.
          runner.launch(null);
          const { map, runs, project } = result.value;
          // The deleted delivery runs' branches are outside the database: a failure leaves them,
          // and is logged rather than answered, since the delete has committed.
          try {
            const failures = await cleanUpDeletedRuns(runs, await seams.checkout(project));
            for (const failure of failures) {
              log(`Could not remove ${failure.target} of a deleted map's run`, failure.message);
            }
          } catch (error: unknown) {
            log(`Cleaning up the delivery runs of deleted map ${map.mapId} failed`, error);
          }
          return map;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
    questionRound: {
      submit: os.questionRound.submit.handler(({ input, errors, context }) => {
        const userId = guard(context, errors, { roundId: input.roundId }, "write");
        const result = submitAnswers({ kind: "user", userId }, db, input);
        if (result.ok) {
          runner.launch(null);
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
    planningRun: {
      tryAgain: os.planningRun.tryAgain.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { planningRunId: input.runId }, "write");
        const result = tryAgain({ kind: "user", userId }, db, input.runId);
        if (!result.ok) {
          const { error } = result;
          throw refusal(errors, error);
        }
        return await overviewAfter(result.value);
      }),
    },
    spec: {
      approve: os.spec.approve.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { specRevisionId: input.specRevisionId }, "write");
        const result = approveSpecRevision({ kind: "user", userId }, db, input);
        if (result.ok) {
          return await overviewAfter(result.value);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      reject: os.spec.reject.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { specRevisionId: input.specRevisionId }, "write");
        const result = rejectSpecRevision({ kind: "user", userId }, db, input);
        if (result.ok) {
          return await overviewAfter(result.value);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
    ticketSet: {
      approve: os.ticketSet.approve.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { ticketSetId: input.ticketSetId }, "write");
        const result = approveTicketSet({ kind: "user", userId }, db, input);
        if (result.ok) {
          return await overviewAfter(result.value);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      reject: os.ticketSet.reject.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { ticketSetId: input.ticketSetId }, "write");
        const result = rejectTicketSet({ kind: "user", userId }, db, input);
        if (result.ok) {
          return await overviewAfter(result.value);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
    hatch: {
      /** Stores the message; launches what the map has running, as every write does. */
      send: os.hatch.send.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { mapId: input.mapId }, "write");
        const result = await sendHatchMessage({ kind: "user", userId }, db, input, runnerStates);
        if (result.ok) {
          runner.launch(null);
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
    delivery: {
      start: os.delivery.start.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { ticketSetId: input.ticketSetId }, "write");
        const result = await startDelivery({ kind: "user", userId }, db, {
          ...input,
          runsDir,
          executor,
        });
        if (result.ok) {
          // The run works in the folder its start resolved, until it ends.
          deliveryRunner.launch(result.value.run, result.value.folder);
          return deliveryRunOf(result.value.run, deliveryRunner);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      /** Starts the next run of a failed, blocked or cancelled run's set from that run's branch. */
      resume: os.delivery.resume.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { deliveryRunId: input.runId }, "write");
        const result = await resumeDelivery({ kind: "user", userId }, db, {
          ...input,
          runsDir,
          executor,
        });
        if (result.ok) {
          deliveryRunner.launch(result.value.run, result.value.folder);
          return deliveryRunOf(result.value.run, deliveryRunner);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      /**
       * Refuse a run that had ended before the request; write the cancelled end (guarded); then
       * abort the held run, or clean up a run the runner does not hold. If the driver's own end
       * landed between the read and the write, that stored end is the answer, not a refusal, and
       * the driver cleans up.
       */
      cancel: os.delivery.cancel.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { deliveryRunId: input.runId }, "write");
        const { runId } = input;
        const found = await getDeliveryRun(db, runId);
        if (!found.ok) {
          const { error } = found;
          throw refusal(errors, error);
        }
        if (found.value.endedAt !== null) {
          throw errors.delivery_run_ended({
            message: `Delivery run ${runId} has already ended`,
            data: { runId },
          });
        }
        const cancelled = await cancelDelivery({ kind: "user", userId }, db, runId);
        if (cancelled.ok) {
          // The cancel ends the run's `delivering` hold: what it started on any map runs.
          runner.launch(null);
          // Aborts a held run (cleaned up once the abort settles), or cleans up an interrupted one.
          await deliveryRunner.cancelled(runId);
          return deliveryRunOf(cancelled.value, deliveryRunner);
        }
        const { error } = cancelled;
        switch (error.code) {
          case "delivery_run_not_found":
            throw errors.delivery_run_not_found({ message: error.message, data: error.data });
          case "delivery_run_ended": {
            const stored = await getDeliveryRun(db, runId);
            if (!stored.ok) {
              throw new Error(`Delivery run ${runId} vanished after it ended`);
            }
            return deliveryRunOf(stored.value, deliveryRunner);
          }
        }
      }),
      markMerged: os.delivery.markMerged.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { deliveryRunId: input.runId }, "write");
        const result = await markMerged({ kind: "user", userId }, db, input.runId);
        if (result.ok) {
          return deliveryRunOf(result.value, deliveryRunner);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      /** Check now: reads the run's pull request's state on GitHub and records it. */
      checkPullRequest: os.delivery.checkPullRequest.handler(async ({ input, errors, context }) => {
        const userId = guard(context, errors, { deliveryRunId: input.runId }, "write");
        const result = await checkPullRequest(
          { kind: "user", userId },
          db,
          input.runId,
          pullRequestSignal,
        );
        if (result.ok) {
          return deliveryRunOf(result.value, deliveryRunner);
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
      activity: os.delivery.activity.handler(({ input, errors, context }) => {
        guard(context, errors, { deliveryRunId: input.runId }, "read");
        const result = getDeliveryActivity(db, input.runId);
        if (result.ok) {
          return result.value;
        }
        const { error } = result;
        throw refusal(errors, error);
      }),
    },
  });
}

/** The pull request checks' timer: started by `launch`, stopped on shutdown. */
interface PullRequestChecks {
  /** Aborted by `stop`: ends a check in flight, the timer's or a Check now's. */
  readonly signal: AbortSignal;
  readonly start: () => void;
  /** Clears the timer, aborts a check in flight and resolves once it has settled. */
  readonly stop: () => Promise<void>;
}

/**
 * Every `PULL_REQUEST_CHECK_INTERVAL_MS` (a fixed constant), checks the pull request of each passed
 * run whose pull request is recorded open, one run after another; a round still running when the
 * next is due is not overlapped. A failed check is logged and changes nothing.
 */
function createPullRequestChecks(db: ZeNormDatabase, log: Log): PullRequestChecks {
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | null = null;
  let round: Promise<void> | null = null;

  // A function, not the property read inline, so the check after an await is not narrowed away.
  const stopped = (): boolean => controller.signal.aborted;

  async function checkAll(): Promise<void> {
    for (const runId of openPullRequestRuns(db)) {
      if (stopped()) {
        return;
      }
      try {
        const checked = await checkPullRequest({ kind: "system" }, db, runId, controller.signal);
        if (!checked.ok && !stopped()) {
          log(
            `Checking the pull request of delivery run ${runId} failed (${checked.error.code}): ${checked.error.message}`,
            null,
          );
        }
      } catch (error) {
        log(`Checking the pull request of delivery run ${runId} failed`, error);
      }
    }
  }

  return {
    signal: controller.signal,
    start: () => {
      if (timer !== null) {
        throw new Error("The pull request checks were started twice");
      }
      timer = setInterval(() => {
        if (round !== null) return;
        round = checkAll()
          .catch((error: unknown) => {
            log("Listing the pull requests to check failed", error);
          })
          .finally(() => {
            round = null;
          });
      }, PULL_REQUEST_CHECK_INTERVAL_MS);
      // The timer alone never keeps the process alive.
      timer.unref();
    },
    stop: async () => {
      if (timer !== null) {
        clearInterval(timer);
      }
      controller.abort();
      if (round !== null) {
        await round;
      }
    },
  };
}

/**
 * The Hono app, with the lifecycle steps the app entry calls: `startPlugins`, then `launch`, before
 * it listens; on shutdown, the two run stops (each aborts its active sessions and resolves once
 * their drivers have settled), then `stopPlugins`.
 */
export type ZeNormApp = Hono & {
  /** Starts each plugin in order; a rejection is `plugin_start_failed`. */
  readonly startPlugins: () => Promise<Result<null, StartupError>>;
  /**
   * After `startPlugins` succeeded: subscribes the plugins' subscribers, runs the startup sweep of
   * the planning runs and launches what is due, so no plugin seam or subscriber is called before
   * its plugin's `start`. Called before then, or twice, it throws.
   */
  readonly launch: () => void;
  readonly stopPlanningRuns: () => Promise<void>;
  /** Stops the delivery runs and the pull request checks' timer, aborting a check in flight. */
  readonly stopDeliveryRuns: () => Promise<void>;
  /** Stops the started plugins in reverse order, each bounded at 5 s. */
  readonly stopPlugins: () => Promise<void>;
  /** Ends every open `/events` stream, so the server's close never waits on one. */
  readonly closeStreams: () => void;
};

/**
 * The Hono app, behind the request guard (Host on every route; Origin and JSON on `/rpc`):
 * `/rpc/*` (oRPC), `/healthz`, `/events`, `GET /plugins`, each plugin's raw routes
 * under `/plugins/<id>/`, and the web build with an `index.html` fallback. The checked plugin set
 * is composed with the database first: a refusal is the coded `StartupError`, before anything is
 * set. Nothing is swept, subscribed or launched until `launch`: then every planning run left
 * running ends `planning_run_interrupted` and is retried once, and the runner launches what is
 * running.
 */
export function createApp({
  db,
  bus,
  webDistDir,
  log,
  server,
  chartMap,
  grillWaypoint,
  researchWaypoint,
  workTask,
  checkConsistency,
  surveyCode,
  settleFog,
  draftSpecs,
  reviseSpec,
  reviewSpec,
  draftTicketSet,
  reviewTicketSet,
  replyThroughHatch,
  plugins,
  delivery,
}: AppOptions): Result<ZeNormApp, StartupError> {
  // Writes on a database without the feed's triggers would publish nothing: refuse it.
  if (!changeFeedInstalled(db)) {
    return err({
      code: "change_feed_missing",
      message:
        "The database's connection has no change-feed triggers; call installChangeFeed first",
      subject: db.$client.name,
    });
  }
  const prepared = composePlugins(plugins, db);
  if (!prepared.ok) {
    return err(prepared.error);
  }
  const { seams } = prepared.value;
  setChangeBus(db, bus);
  setSeams(db, seams);
  const runner = createPlanningRunner({
    db,
    chartMap,
    grillWaypoint,
    researchWaypoint,
    workTask,
    checkConsistency,
    surveyCode,
    settleFog,
    draftSpecs,
    reviseSpec,
    reviewSpec,
    draftTicketSet,
    reviewTicketSet,
    replyThroughHatch,
    log,
  });
  const chosen = prepared.value.executor;
  const deliveryRunner = createDeliveryRunner({
    db,
    executorName: chosen.name,
    implementTicketSet: chosen.implementTicketSet,
    reviewDelivery: chosen.reviewDelivery,
    writePullRequest: chosen.writePullRequest,
    checkTimeoutMinutes: delivery.checkTimeoutMinutes,
    // A run's end may start planning work on any map: a release run, or a run the spec's hold kept
    // back.
    onEnd: () => {
      runner.launch(null);
    },
    log,
  });
  const pullRequestChecks = createPullRequestChecks(db, log);
  const router = createRouter(
    db,
    seams,
    runner,
    deliveryRunner,
    { runsDir: delivery.runsDir, executor: chosen.name },
    pullRequestChecks.signal,
    log,
  );
  const handler = new RPCHandler(router, {
    clientInterceptors: [
      onError((error) => {
        if (!(error instanceof ORPCError)) {
          log("Unexpected error in an RPC procedure", error);
        }
      }),
    ],
  });

  const app = new Hono();

  // Before every route: only ZeNorm's own Host, and on /rpc only its own Origin and JSON posts.
  app.use("*", requestGuard(server, log));

  app.use("/rpc/*", async (c) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/rpc",
      context: { request: c.req.raw },
    });
    if (matched) {
      return c.newResponse(response.body, response);
    }
    return c.notFound();
  });

  app.get("/healthz", (c) => c.text("ok"));

  // The instance's change stream, filtered per row by the access check.
  const events = createEventStreams({
    db,
    bus,
    identify: seams.identify,
    checkAccess: seams.checkAccess,
    log,
  });
  app.get("/events", (c) => events.handle(c.req.raw));

  // The server's plugin set, which the web compares with its own.
  const list = prepared.value.list;
  app.get("/plugins", (c) => c.json(list));
  for (const { id, router: pluginRouter } of prepared.value.routes) {
    app.route(`/plugins/${id}`, pluginRouter);
  }

  app.get("*", serveStatic({ root: webDistDir }));
  app.get("*", serveStatic({ root: webDistDir, path: "index.html" }));

  app.onError((error, c) => {
    log(`Unexpected error serving ${c.req.method} ${c.req.path}`, error);
    return c.text("Internal Server Error", INTERNAL_SERVER_ERROR);
  });

  let started: readonly BoundPlugin[] = [];
  let pluginsStarted = false;
  let launched = false;
  return ok(
    Object.assign(app, {
      startPlugins: async (): Promise<Result<null, StartupError>> => {
        const result = await startPlugins(prepared.value, log);
        if (!result.ok) {
          return err(result.error);
        }
        started = result.value;
        pluginsStarted = true;
        return ok(null);
      },
      launch: () => {
        if (!pluginsStarted) {
          throw new Error("launch() before startPlugins() succeeded");
        }
        if (launched) {
          throw new Error("launch() called twice");
        }
        launched = true;
        // In this order: the sweep's writes reach the plugins' subscribers.
        subscribePlugins(prepared.value, bus);
        sweepInterruptedRuns(db);
        runner.launch(null);
        pullRequestChecks.start();
      },
      stopPlanningRuns: () => runner.stop(),
      stopDeliveryRuns: async () => {
        await Promise.all([pullRequestChecks.stop(), deliveryRunner.stop()]);
      },
      stopPlugins: async () => {
        const stopping = started;
        started = [];
        await stopPlugins(stopping, log);
      },
      closeStreams: () => {
        events.closeStreams();
      },
    }),
  );
}
