import type {
  Actor,
  CancelledError,
  ChartMap,
  CheckConsistency,
  DraftSpecs,
  DraftTicketSet,
  GrillWaypoint,
  PlanningAgentError,
  PlanningCallSession,
  ReplyThroughHatch,
  ResearchWaypoint,
  ReviewSpec,
  Result,
  ReviewTicketSet,
  ReviseSpec,
  SkillMissingError,
  SettleFog,
  SurveyCode,
  WorkTask,
} from "@zenorm/contracts";
import {
  failRun,
  planningRunActor,
  prepareRun,
  recordChart,
  recordConsistency,
  recordFogSettlement,
  recordGrill,
  recordHatchReply,
  recordResearch,
  recordRunUsage,
  recordRevision,
  recordSpecReview,
  recordSpecs,
  recordSurvey,
  recordTask,
  recordTicketSet,
  recordTicketsReview,
  runningRuns,
} from "@zenorm/core";
import type { RunWork } from "@zenorm/core";
import type { ZeNormDatabase } from "@zenorm/db";

import type { Log } from "./app.ts";

export interface PlanningRunnerOptions {
  readonly db: ZeNormDatabase;
  readonly chartMap: ChartMap;
  /** The map's code survey, once its destination is confirmed (harness change #1). */
  readonly surveyCode: SurveyCode;
  /** The map's fog run, once every waypoint is settled and fog remains (harness change #4). */
  readonly settleFog: SettleFog;
  readonly grillWaypoint: GrillWaypoint;
  readonly researchWaypoint: ResearchWaypoint;
  readonly workTask: WorkTask;
  /** The consistency pass (S6b-10). */
  readonly checkConsistency: CheckConsistency;
  /** A map-scope To Spec run (slice 7 D3). */
  readonly draftSpecs: DraftSpecs;
  /** A spec-scoped To Spec run: a repair after a failed review or a rejection (S7-7, S7-12). */
  readonly reviseSpec: ReviseSpec;
  /** A spec review (S7-6). */
  readonly reviewSpec: ReviewSpec;
  /** A To Tickets run. */
  readonly draftTicketSet: DraftTicketSet;
  /** A tickets review (slice 7c D2). */
  readonly reviewTicketSet: ReviewTicketSet;
  /** A hatch run's reply to one message (S7b-3, S7b-4). */
  readonly replyThroughHatch: ReplyThroughHatch;
  readonly log: Log;
}

/**
 * Calls the planning agent for every stored `running` planning run, in the background and never
 * inside a request (slice 6a spec D3). Core's writes insert the runs (`planNext`); after each
 * write the server asks the runner to `launch` what is running. The runner holds, in memory only,
 * which runs it is calling, so a run is called once; a core writer saves each outcome and inserts
 * what it makes due, which the runner then launches in turn.
 */
export interface PlanningRunner {
  /** Launches every running run of the map, or of every map when `mapId` is null, not yet held. */
  launch(mapId: string | null): void;
  /**
   * Stops the runner (spec D2, S9-2): `launch` starts nothing from now on, every held run's call is
   * aborted, and the promise resolves once every run's driver has settled. A run the stop aborts
   * writes nothing and stays `running`; the startup sweep ends it `planning_run_interrupted` and
   * retries it (S6a-13).
   */
  stop(): Promise<void>;
}

export function createPlanningRunner({
  db,
  chartMap,
  surveyCode,
  settleFog,
  grillWaypoint,
  researchWaypoint,
  workTask,
  checkConsistency,
  draftSpecs,
  reviseSpec,
  reviewSpec,
  draftTicketSet,
  reviewTicketSet,
  replyThroughHatch,
  log,
}: PlanningRunnerOptions): PlanningRunner {
  /** Each held run's abort, which only a stop fires (spec D2). */
  const held = new Map<string, AbortController>();
  /** Every run's driver until it settles, which `stop` awaits. */
  const driving = new Set<Promise<void>>();
  /** Set by `stop`; from then on the runner launches nothing and writes nothing (spec D2). */
  let stopped = false;

  /** Ends the run `failed` with the port's code; core inserts its retry or stops the scope. */
  function fail(
    actor: Actor,
    runId: string,
    error: PlanningAgentError | CancelledError | SkillMissingError,
  ): void {
    if (error.code === "agent_cancelled") {
      // Only a stop aborts a planning call, and `settle` writes nothing once the stop has begun, so
      // a cancel seen here had no stop: a programmer error (spec D2). `drive` logs it and ends the
      // run `planning_run_internal_error`.
      throw new Error(`Planning run ${runId} was cancelled, but the runner was not stopped`);
    }
    failRun(actor, db, runId, { code: error.code, message: error.message });
  }

  /** Has core save the port's outcome: its value through `record`, or its error through `fail`. */
  function settle<TValue>(
    actor: Actor,
    runId: string,
    outcome: Result<TValue, PlanningAgentError | CancelledError | SkillMissingError>,
    record: (value: TValue) => void,
  ): void {
    // Once the stop has begun, an outcome is not saved, even a success that resolved after it: the
    // stop happened first, so the run stays `running` and the startup sweep retries it (S9-2).
    if (stopped) return;
    if (outcome.ok) {
      record(outcome.value);
    } else {
      fail(actor, runId, outcome.error);
    }
  }

  /** Calls the work's port and has core save the outcome. */
  async function call(work: RunWork, actor: Actor, signal: AbortSignal): Promise<void> {
    const runId = work.run.id;
    // The call's usage is stored as the CLI reports it, before its outcome, so a retry reads it.
    const session: PlanningCallSession = {
      resumeSessionId: work.resumeSessionId,
      onUsage: (usage) => {
        // A CLI that prints its usage while being stopped writes nothing (S9-2).
        if (stopped) return;
        recordRunUsage(actor, db, runId, usage);
      },
      signal,
    };
    switch (work.purpose) {
      case "chart": {
        const outcome = await chartMap(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A refused output (S6a-6) fails the run inside core, with its code.
          recordChart(actor, db, runId, value);
        });
        return;
      }
      case "survey": {
        const outcome = await surveyCode(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A survey naming a path or line the project does not have fails the run inside core.
          recordSurvey(actor, db, runId, work.request.projectFolder, value);
        });
        return;
      }
      case "fog": {
        const outcome = await settleFog(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A settlement naming an unknown fog item, or leaving one, fails the run inside core.
          recordFogSettlement(actor, db, runId, value);
        });
        return;
      }
      case "grilling": {
        const outcome = await grillWaypoint(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A round after a final round fails the run inside core, with its code.
          recordGrill(actor, db, runId, value);
        });
        return;
      }
      case "research": {
        const outcome = await researchWaypoint(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A rule-breaking report or refused map changes fail the run inside core, with its code.
          recordResearch(actor, db, runId, value);
        });
        return;
      }
      case "task": {
        const outcome = await workTask(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // Refused map changes fail the run inside core, with its code.
          recordTask(actor, db, runId, value);
        });
        return;
      }
      case "consistency": {
        const outcome = await checkConsistency(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A finding naming a waypoint that is not resolved fails the run inside core, with its code;
          // a later pass's finding naming no newly resolved waypoint is dropped.
          recordConsistency(actor, db, runId, value);
        });
        return;
      }
      case "to_spec": {
        if (work.scope === "spec") {
          const outcome = await reviseSpec(work.request, session);
          settle(actor, runId, outcome, (value) => {
            // Output breaking the id rules fails the run inside core; a replaced run saves nothing.
            recordRevision(actor, db, runId, value);
          });
          return;
        }
        const outcome = await draftSpecs(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // Output breaking D2 or the id rules fails the run inside core, with its code.
          recordSpecs(actor, db, runId, value);
        });
        return;
      }
      case "spec_review": {
        const outcome = await reviewSpec(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // An unknown reference fails the run inside core, with its code.
          recordSpecReview(actor, db, runId, value);
        });
        return;
      }
      case "to_tickets": {
        const outcome = await draftTicketSet(work.request, session);
        settle(actor, runId, outcome, (value) => {
          recordTicketSet(actor, db, runId, value);
        });
        return;
      }
      case "tickets_review": {
        const outcome = await reviewTicketSet(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // An unknown ticket or criterion fails the run inside core, with its code (S7c-3).
          recordTicketsReview(actor, db, runId, value);
        });
        return;
      }
      case "hatch": {
        const outcome = await replyThroughHatch(work.request, session);
        settle(actor, runId, outcome, (value) => {
          // A reply out of bounds or an invalid change fails the run inside core, with its code;
          // a refused change is stored as core's sentence (S7b-5).
          recordHatchReply(actor, db, runId, value);
        });
        return;
      }
    }
  }

  async function drive(runId: string, actor: Actor, signal: AbortSignal): Promise<void> {
    try {
      const work = await prepareRun(db, runId);
      // A run the stop reaches while it is prepared writes nothing and calls no port (S9-2).
      if (stopped) return;
      if (!work.ok) {
        failRun(actor, db, runId, work.error);
      } else {
        await call(work.value, actor, signal);
      }
    } catch (error: unknown) {
      log(`Unexpected error in planning run ${runId}`, error);
      // After the stop the run writes nothing, this end included; the startup sweep retries it.
      if (stopped) return;
      failRun(actor, db, runId, {
        code: "planning_run_internal_error",
        message: "The planning run stopped on an unexpected error; the server log has the details.",
      });
    } finally {
      held.delete(runId);
    }
    // A run's end may start work on another map (slice 8b D3): a release run, or a run the spec's
    // cross-map idle gate held back. After a stop, `launch` starts nothing.
    launch(null);
  }

  function launch(mapId: string | null): void {
    if (stopped) return;
    for (const run of runningRuns(db, mapId)) {
      if (held.has(run.id)) continue;
      // The run's writes are made as the run, with its User (S9-13).
      const actor = planningRunActor(db, run.id);
      const controller = new AbortController();
      held.set(run.id, controller);
      const driven = drive(run.id, actor, controller.signal).catch((error: unknown) => {
        log(`Unexpected error ending planning run ${run.id}`, error);
      });
      driving.add(driven);
      void driven.finally(() => {
        driving.delete(driven);
      });
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    for (const controller of held.values()) {
      controller.abort();
    }
    await Promise.all(driving);
  }

  return { launch, stop };
}
