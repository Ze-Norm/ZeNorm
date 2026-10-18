import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { isDefinedError, ORPCError, safe } from "@orpc/client";
import type { ChartMap, DraftSpecsOutcome, PlanningCallSession } from "@zenorm/contracts";
import { createChangeBus, sweepInterruptedRuns } from "@zenorm/core";
import { specWaits } from "@zenorm/db";
import { definePlugin, SDK_VERSION } from "@zenorm/plugin-sdk";
import type { ServerPlugin } from "@zenorm/plugin-sdk";
import { describe, expect, test, vi } from "vitest";

import { createApp } from "./app.ts";
import {
  UNKNOWN_ID,
  ROUND,
  PROPOSAL,
  NO_WAYPOINTS,
  SPEC,
  DRAFTED,
  PASSED,
  TICKETS_PASSED,
  TICKETS,
  ANSWERS,
  DELIVERY_WAIT,
  nthCall,
  SURVEY,
  planningPorts,
  localExecutor,
  checked,
  appOf,
  root,
  db,
  webDistDir,
  log,
  specsPort,
  revisePort,
  specReviewPort,
  ticketSetPort,
  ticketsReviewPort,
  hatchPort,
  implementPort,
  client,
  clientOf,
  addProject,
  proposed,
  clearedMap,
  clearedMapIn,
  specLine,
  overviewWhen,
  firstSpec,
  reviewedSpec,
  NOT_LOGGED_IN,
  makeRepo,
  PLANNING_CANCELLED,
  stoppableChart,
  storedRuns,
  approvedSet,
  PASSING_CHECK,
  startRun,
  cleanedUp,
  setUpAppTests,
  NO_APP_SETTINGS,
} from "./app-test-support.ts";

setUpAppTests();

describe("specs over /rpc", () => {
  test("a cleared map writes spec 1, reviews it, and approvals write and approve its tickets", async () => {
    const { project, mapId } = await clearedMap();
    expect((await nthCall(specsPort.calls, 0)).request).toEqual({
      projectName: project.name,
      projectFolder: project.folderPath,
      baseBranch: project.baseBranch,
      idea: "Dark mode",
      title: PROPOSAL.title,
      destination: NO_WAYPOINTS.destination,
      mapRounds: [{ questions: ROUND.questions, answers: ANSWERS, final: false }],
      waypoints: [],
      outOfScope: [],
      waits: [],
      survey: SURVEY,
      projectSpecs: [],
      specs: [],
      refusedAttempt: null,
    });
    (await nthCall(specsPort.calls, 0)).resolve({ ok: true, value: DRAFTED });
    const reviewing = await overviewWhen(mapId, (read) => read.specs.length === 1);
    expect(firstSpec(reviewing)).toMatchObject({
      number: 1,
      title: SPEC.title,
      revisions: [{ revision: 1, content: SPEC, review: { state: "running" } }],
    });
    expect((await nthCall(specReviewPort.calls, 0)).request).toMatchObject({
      revision: { specNumber: 1, revision: 1, content: SPEC },
      before: null,
    });
    (await nthCall(specReviewPort.calls, 0)).resolve({ ok: true, value: PASSED });
    const passed = await overviewWhen(mapId, (read) => specLine(read) === "Awaiting your approval");
    const revision = firstSpec(passed).revisions[0];
    if (revision === undefined) throw new Error("No revision");
    expect(passed.status.next[0]).toMatchObject({ headline: "Approve the spec.", spec: 1 });

    const approved = await client.spec.approve({ specRevisionId: revision.id });
    expect(firstSpec(approved).revisions[0]?.state).toBe("approved");
    expect((await nthCall(ticketSetPort.calls, 0)).request).toMatchObject({
      approved: { specNumber: 1, revision: 1 },
      rewrite: null,
    });
    (await nthCall(ticketSetPort.calls, 0)).resolve({ ok: true, value: TICKETS });
    const written = await overviewWhen(mapId, (read) => firstSpec(read).ticketSets.length === 1);
    const [set] = firstSpec(written).ticketSets;
    if (set === undefined) throw new Error("No set");
    expect(set).toMatchObject({ state: "awaiting_review", version: 1, content: TICKETS });
    expect(set.review?.state).toBe("running");
    const [unreviewed] = await safe(client.ticketSet.approve({ ticketSetId: set.id }));
    expect(isDefinedError(unreviewed) && [unreviewed.code, unreviewed.status]).toEqual([
      "review_in_flight",
      409,
    ]);
    expect((await nthCall(ticketsReviewPort.calls, 0)).request).toMatchObject({
      idea: "Dark mode",
      approved: { specNumber: 1, revision: 1, content: SPEC },
      ticketSet: { version: 1, content: TICKETS },
    });
    (await nthCall(ticketsReviewPort.calls, 0)).resolve({ ok: true, value: TICKETS_PASSED });
    await overviewWhen(mapId, (read) => firstSpec(read).ticketSets[0]?.state === "review_passed");

    const decided = await client.ticketSet.approve({ ticketSetId: set.id });
    expect(firstSpec(decided).ticketSets[0]?.state).toBe("approved");
    // A new project has no required checks: Start delivery is unavailable until they are saved.
    expect(decided.status.stages[4]).toMatchObject({
      stage: "delivery",
      tone: "idle",
      line: "No required checks",
    });
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: "main",
      requiredChecks: [PASSING_CHECK],
      repairLimit: 0,
      fixCommands: [],
      ...NO_APP_SETTINGS,
    });
    const ready = await client.map.overview({ mapId });
    expect(ready.status.stages[4]).toMatchObject({ stage: "delivery", tone: "needs-you" });
    expect(firstSpec(ready).runs).toEqual([]);
    expect((await client.project.get({ projectId: project.id })).specs).toMatchObject([
      {
        number: 1,
        title: SPEC.title,
        revisions: [{ revision: 1, state: "approved", mapId }],
        activeRun: null,
        mergedRun: null,
      },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("the runner records a passed tickets review; a failing review is retried, then stops with Try again", async () => {
    const { mapId } = await clearedMap();
    const specRevisionId = await reviewedSpec(mapId, 0);
    await client.spec.approve({ specRevisionId });
    (await nthCall(ticketSetPort.calls, 0)).resolve({ ok: true, value: TICKETS });
    (await nthCall(ticketsReviewPort.calls, 0)).resolve(NOT_LOGGED_IN);
    // The retry runs by itself: the review still reads running.
    const retry = await nthCall(ticketsReviewPort.calls, 1);
    expect(firstSpec(await client.map.overview({ mapId })).ticketSets[0]?.review?.state).toBe(
      "running",
    );
    retry.resolve(NOT_LOGGED_IN);
    const stopped = await overviewWhen(
      mapId,
      (read) => firstSpec(read).ticketSets[0]?.review?.state === "stopped",
    );
    const review = firstSpec(stopped).ticketSets[0]?.review;
    if (review?.state !== "stopped") throw new Error("Not stopped");
    expect(review.stopped.code).toBe("agent_not_logged_in");

    await client.planningRun.tryAgain({ runId: review.stopped.runId });
    (await nthCall(ticketsReviewPort.calls, 2)).resolve({ ok: true, value: TICKETS_PASSED });
    const passed = await overviewWhen(
      mapId,
      (read) => firstSpec(read).ticketSets[0]?.state === "review_passed",
    );
    expect(firstSpec(passed).ticketSets[0]?.review).toMatchObject({
      state: "passed",
      summary: TICKETS_PASSED.summary,
    });
    expect(passed.status.next[0]).toMatchObject({ headline: "Approve the tickets.", spec: 1 });
    expect(log).not.toHaveBeenCalled();
  });

  test("a failure is retried once; a failed retry stops the map, and Try again writes again", async () => {
    const { mapId } = await clearedMap();
    (await nthCall(specsPort.calls, 0)).resolve(NOT_LOGGED_IN);
    // The retry runs by itself: Spec still reads working.
    const retry = await nthCall(specsPort.calls, 1);
    expect(specLine(await client.map.overview({ mapId }))).toBe("Agent is writing the spec");
    retry.resolve(NOT_LOGGED_IN);

    const failed = await overviewWhen(mapId, (read) => read.status.next[0]?.stopped !== null);
    const stopped = failed.status.next[0]?.stopped;
    if (stopped == null) throw new Error("Not stopped");
    expect(failed.status.next[0]).toMatchObject({
      who: "you",
      stage: "spec",
      stopped: { code: "agent_not_logged_in" },
    });

    const again = await client.planningRun.tryAgain({ runId: stopped.runId });
    expect(again.status.stages[2]).toMatchObject({ stage: "spec", tone: "working" });
    (await nthCall(specsPort.calls, 2)).resolve({ ok: true, value: DRAFTED });
    await overviewWhen(mapId, (read) => read.specs.length === 1);

    const [notStopped] = await safe(client.planningRun.tryAgain({ runId: stopped.runId }));
    expect(isDefinedError(notStopped) && [notStopped.code, notStopped.status]).toEqual([
      "planning_run_not_stopped",
      409,
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("deciding an unknown draft is *_not_found (404)", async () => {
    const cases: readonly (readonly [Promise<unknown>, string])[] = [
      [client.spec.approve({ specRevisionId: UNKNOWN_ID }), "spec_revision_not_found"],
      [client.spec.reject({ specRevisionId: UNKNOWN_ID, reason: "No" }), "spec_revision_not_found"],
      [client.ticketSet.approve({ ticketSetId: UNKNOWN_ID }), "ticket_set_not_found"],
      [client.ticketSet.reject({ ticketSetId: UNKNOWN_ID, reason: "No" }), "ticket_set_not_found"],
    ];
    for (const [call, code] of cases) {
      const [error] = await safe(call);
      expect(error instanceof ORPCError && [error.code, error.status]).toEqual([code, 404]);
    }
  });

  test("approving while the review runs is review_in_flight (409); a blank reason is BAD_REQUEST", async () => {
    const { mapId } = await clearedMap();
    (await nthCall(specsPort.calls, 0)).resolve({ ok: true, value: DRAFTED });
    await nthCall(specReviewPort.calls, 0);
    const revision = firstSpec(await overviewWhen(mapId, (read) => read.specs.length === 1))
      .revisions[0];
    if (revision === undefined) throw new Error("No revision");

    const [inFlight] = await safe(client.spec.approve({ specRevisionId: revision.id }));
    expect(isDefinedError(inFlight) && [inFlight.code, inFlight.status]).toEqual([
      "review_in_flight",
      409,
    ]);
    const [blank] = await safe(client.spec.reject({ specRevisionId: revision.id, reason: "  " }));
    expect(blank instanceof ORPCError && blank.code).toBe("BAD_REQUEST");
    const [setBlank] = await safe(client.ticketSet.reject({ ticketSetId: UNKNOWN_ID, reason: "" }));
    expect(setBlank instanceof ORPCError && setBlank.code).toBe("BAD_REQUEST");
    expect(firstSpec(await client.map.overview({ mapId })).revisions[0]?.state).toBe("draft");
  });

  test("a throwing port is logged and its run fails planning_run_internal_error, then is retried", async () => {
    const { mapId } = await clearedMap();
    const thrown = new Error("boom");
    (await nthCall(specsPort.calls, 0)).reject(thrown);

    await nthCall(specsPort.calls, 1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toBe(thrown);
    (await nthCall(specsPort.calls, 1)).reject(thrown);
    const failed = await overviewWhen(mapId, (read) => read.status.next[0]?.stopped !== null);
    expect(failed.status.next[0]?.stopped?.code).toBe("planning_run_internal_error");
  });

  test("a new app over the same database interrupts the held run and retries it", async () => {
    const { mapId } = await clearedMap();
    await nthCall(specsPort.calls, 0);

    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    // The interrupted run's retry is launched by the new app.
    const retry = await nthCall(specsPort.calls, 1);
    retry.resolve({ ok: true, value: DRAFTED });
    await vi.waitFor(async () => {
      expect((await restarted.map.overview({ mapId })).specs).toHaveLength(1);
    });
    // The first app's late answer is for a run that already ended: it is logged, not stored.
    (await nthCall(specsPort.calls, 0)).resolve({ ok: true, value: DRAFTED });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalled();
    });
    expect((await restarted.map.overview({ mapId })).specs).toHaveLength(1);
  });

  /** A plugin that records its checkout calls and committed rows, each marked by its `start`. */
  function recordingPlugin(calls: string[], start: () => Promise<void>): ServerPlugin {
    let started = false;
    return definePlugin({
      id: "recording",
      version: "1.0.0",
      sdk: `^${SDK_VERSION}`,
      seams: () => ({
        checkout: (next) => (project) => {
          calls.push(started ? "checkout" : "checkout before start");
          return next(project);
        },
      }),
      subscribers: () => ({
        "*": () => {
          calls.push(started ? "row" : "row before start");
        },
      }),
      start: async () => {
        await start();
        started = true;
        calls.push("start");
      },
    });
  }

  /** Waits long enough for anything an app launched on its own to have reached its ports. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  test("no plugin seam or subscriber is called before its plugin's start, with a run to retry", async () => {
    await clearedMap();
    await nthCall(specsPort.calls, 0);
    const calls: string[] = [];
    const created = createApp({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked(
        [recordingPlugin(calls, () => Promise.resolve())],
        [localExecutor()],
        "local",
      ),
    });
    if (!created.ok) throw new Error(created.error.code);

    await settle();
    expect(calls).toEqual([]);
    expect(specsPort.calls).toHaveLength(1);
    expect((await created.value.startPlugins()).ok).toBe(true);
    created.value.launch();

    // The sweep's write reaches the subscriber, and the retry checks the folder out.
    await nthCall(specsPort.calls, 1);
    expect(calls[0]).toBe("start");
    expect(calls).toContain("row");
    expect(calls).toContain("checkout");
    expect(calls.filter((call) => call.endsWith("before start"))).toEqual([]);
  });

  test("a plugin start that fails launches nothing, and launch refuses", async () => {
    await clearedMap();
    await nthCall(specsPort.calls, 0);
    const calls: string[] = [];
    const created = createApp({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked(
        [recordingPlugin(calls, () => Promise.reject(new Error("no token")))],
        [localExecutor()],
        "local",
      ),
    });
    if (!created.ok) throw new Error(created.error.code);

    const started = await created.value.startPlugins();

    expect(!started.ok && started.error).toMatchObject({
      code: "plugin_start_failed",
      data: { pluginId: "recording", phase: "start" },
    });
    expect(() => {
      created.value.launch();
    }).toThrow();
    await settle();
    expect(calls).toEqual([]);
    expect(specsPort.calls).toHaveLength(1);
  });
});

describe("the planning runner's stop", () => {
  test("stop aborts a held run, which writes nothing, its late usage included; launch then calls no port", async () => {
    const chart = stoppableChart();
    const stoppable = await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      chartMap: chart.port,
    });
    const stoppableClient = clientOf(stoppable);
    const project = await addProject();
    const { map } = await stoppableClient.map.create({
      projectId: project.id,
      idea: "Add dark mode",
    });
    const session = await nthCall(chart.sessions, 0);
    expect(session.signal.aborted).toBe(false);

    await stoppable.stopPlanningRuns();

    expect(session.signal.aborted).toBe(true);
    // The run stays running: no failure, and the usage reported during the stop is not stored.
    expect(storedRuns(map.id)).toMatchObject([
      { state: "running", error_code: null, session_id: null, total_cost_usd: null },
    ]);
    // A map created after the stop has its chart run stored, but the stopped runner calls no port.
    const later = await stoppableClient.map.create({ projectId: project.id, idea: "Add a toggle" });
    expect(storedRuns(later.map.id)).toMatchObject([{ state: "running" }]);
    expect(chart.sessions).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  test("the startup sweep then ends the stopped run planning_run_interrupted and inserts its retry", async () => {
    const chart = stoppableChart();
    const stoppable = await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      chartMap: chart.port,
    });
    const project = await addProject();
    const { map } = await clientOf(stoppable).map.create({
      projectId: project.id,
      idea: "Add dark mode",
    });
    await nthCall(chart.sessions, 0);
    await stoppable.stopPlanningRuns();

    sweepInterruptedRuns(db);

    const stoppedId: unknown = db.$client
      .prepare("select id from planning_runs where map_id = ? and retry_of_run_id is null")
      .pluck()
      .get(map.id);
    expect(storedRuns(map.id)).toMatchObject([
      { id: stoppedId, state: "failed", error_code: "planning_run_interrupted" },
      { state: "running", retry_of_run_id: stoppedId },
    ]);
    expect(chart.sessions).toHaveLength(1);
  });

  test("a port that succeeds after the stop saves nothing: the run stays running", async () => {
    // On the abort this chart answers with a proposal, as a CLI finishing just as it is stopped.
    const sessions: PlanningCallSession[] = [];
    const lateSuccess: ChartMap = (_request, session) =>
      new Promise((resolve) => {
        sessions.push(session);
        session.signal.addEventListener(
          "abort",
          () => {
            resolve({ ok: true, value: { kind: "proposal", proposal: PROPOSAL } });
          },
          { once: true },
        );
      });
    const stoppable = await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      chartMap: lateSuccess,
    });
    const project = await addProject();
    const { map } = await clientOf(stoppable).map.create({
      projectId: project.id,
      idea: "Add dark mode",
    });
    await nthCall(sessions, 0);

    await stoppable.stopPlanningRuns();

    expect(storedRuns(map.id)).toMatchObject([{ state: "running", error_code: null }]);
    expect((await clientOf(stoppable).map.get({ mapId: map.id })).map.title).toBeNull();
    expect(sessions).toHaveLength(1);
  });

  test("agent_cancelled with no stop is a programmer error: logged, and the run fails planning_run_internal_error", async () => {
    // The first call returns agent_cancelled though nothing stopped the runner; its retry is held.
    const sessions: PlanningCallSession[] = [];
    const cancelling: ChartMap = (_request, session) => {
      sessions.push(session);
      return sessions.length === 1
        ? Promise.resolve({ ok: false, error: PLANNING_CANCELLED })
        : new Promise(() => undefined);
    };
    const project = await addProject();
    const { map } = await clientOf(
      await appOf({
        db,
        bus: createChangeBus(log),
        webDistDir,
        log,
        ...planningPorts(),
        chartMap: cancelling,
      }),
    ).map.create({ projectId: project.id, idea: "Add dark mode" });

    await nthCall(sessions, 1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(storedRuns(map.id)).toMatchObject([
      { state: "failed", error_code: "planning_run_internal_error" },
      { state: "running" },
    ]);
  });
});

describe("the project container over /rpc", () => {
  test("project.inspect returns the realpath, name, detected branch and hasCommit, writing nothing", async () => {
    const folderPath = makeRepo("my-repo", false);

    expect(await client.project.inspect({ folderPath: `${folderPath}/` })).toEqual({
      folderPath: await realpath(folderPath),
      name: "my-repo",
      detectedBaseBranch: "main",
      hasCommit: false,
    });
    expect(await client.project.list()).toEqual([]);
  });

  test("each project.inspect refusal reaches the client as its code and status", async () => {
    const project = await addProject();
    const sub = join(project.folderPath, "sub");
    await mkdir(sub);
    const plain = join(root, "plain");
    await mkdir(plain);

    const cases = [
      [join(root, "nowhere"), "project_folder_missing", 422],
      [project.folderPath, "project_already_added", 409],
      [sub, "project_inside_project", 409],
      [plain, "project_not_git", 422],
    ] as const;
    for (const [folderPath, code, status] of cases) {
      const [error] = await safe(client.project.inspect({ folderPath }));
      expect(isDefinedError(error) && [error.code, error.status]).toEqual([code, status]);
    }
    const [inside] = await safe(client.project.inspect({ folderPath: sub }));
    expect(isDefinedError(inside) && inside.data).toEqual({
      folderPath: await realpath(sub),
      projectId: project.id,
      projectFolderPath: project.folderPath,
    });
    expect(log).not.toHaveBeenCalled();
  });

  test("project.create refuses an invalid or missing branch (422) and a folder inside a project (409), writing nothing", async () => {
    const project = await addProject();
    const nested = join(project.folderPath, "vendor");
    await mkdir(nested);
    const other = makeRepo("other", true);

    const cases = [
      [other, "main~1", "project_branch_invalid", 422],
      [other, "develop", "project_branch_missing", 422],
      [nested, "main", "project_inside_project", 409],
    ] as const;
    for (const [folderPath, baseBranch, code, status] of cases) {
      const [error] = await safe(client.project.create({ folderPath, baseBranch }));
      expect(isDefinedError(error) && [error.code, error.status]).toEqual([code, status]);
    }
    expect(await client.project.list()).toEqual([project]);
  });

  test("a repository with no commit is added, blocked from delivery, and planning works on it", async () => {
    const folderPath = makeRepo("empty", false);

    const project = await client.project.create({ folderPath, baseBranch: "main" });

    expect(project).toMatchObject({
      name: "empty",
      folder: "present",
      startDeliveryBlockers: [
        "project_branch_missing",
        "project_checks_missing",
        "project_repair_limit_missing",
      ],
    });
    const mapId = await clearedMapIn(project, "Start");
    await reviewedSpec(mapId, 0);
    expect((await client.map.overview({ mapId })).project).toEqual(project);
  });

  test("a project whose folder is gone reads folder missing with its blocker", async () => {
    const project = await addProject();
    await rm(project.folderPath, { recursive: true, force: true });

    const missing = {
      ...project,
      folder: "missing",
      startDeliveryBlockers: ["project_folder_missing"],
    };
    expect(await client.project.list()).toEqual([missing]);
    expect(await client.project.get({ projectId: project.id })).toEqual({ ...missing, specs: [] });
  });
});

describe("map overviews over /rpc", () => {
  test("map.overviews lists every map newest first; a held draft reads working", async () => {
    const { project, mapId } = await clearedMap("First map");
    const second = await client.map.create({ projectId: project.id, idea: "Second map" });
    await proposed(second.map.id, 2);

    const overviews = await client.map.overviews();

    expect(overviews.map((overview) => overview.map.id)).toEqual([second.map.id, mapId]);
    const [newest, drafting] = overviews;
    expect(newest?.project).toEqual(project);
    expect(newest?.status.group).toBe("needs-you");
    expect(newest?.status.stages[1]).toMatchObject({ stage: "wayfinding", tone: "needs-you" });
    expect(drafting?.status.group).toBe("working");
    expect(drafting?.status.stages[2]).toMatchObject({ stage: "spec", tone: "working" });
    expect(drafting?.status.next).toEqual([
      expect.objectContaining({ who: "agent", stage: "spec" }),
    ]);

    await reviewedSpec(mapId, 0);
    const settled = (await client.map.overviews()).find((overview) => overview.map.id === mapId);
    expect(settled?.status.stages[2]).toMatchObject({ tone: "needs-you" });
    expect(log).not.toHaveBeenCalled();
  });

  test("map.overview returns the map's status and activity, newest last", async () => {
    const { project, mapId } = await clearedMap();
    await reviewedSpec(mapId, 0);

    const overview = await client.map.overview({ mapId });

    expect(overview.map.id).toBe(mapId);
    expect(overview.project).toEqual(project);
    expect(overview.status.group).toBe("needs-you");
    expect(overview.activity.map((line) => line.stage)).toEqual([
      "idea", // map started
      "idea", // being charted
      "wayfinding", // destination asked
      "wayfinding", // destination answered
      "wayfinding", // destination confirmed
      "spec", // map cleared, spec being written (on Spec)
      "spec", // spec written
      "spec", // planning review passed
    ]);
    expect(overview.activity.every((line) => line.waypoint === null)).toBe(true);
    const times = overview.activity.map((line) => Date.parse(line.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("map.overview returns map_not_found with status 404", async () => {
    const [error] = await safe(client.map.overview({ mapId: UNKNOWN_ID }));

    expect(isDefinedError(error) && error.code).toBe("map_not_found");
    expect(isDefinedError(error) && error.status).toBe(404);
  });
});

describe("the hatch over /rpc", () => {
  test("hatch.send stores a message and starts its run; its refusals carry their codes", async () => {
    // The map's spec is being written: a message is never refused for what is in flight.
    const { mapId } = await clearedMap();
    const before = await client.map.overview({ mapId });

    const sent = await client.hatch.send({
      mapId,
      stage: "wayfinding",
      specNumber: null,
      text: "Does nested mean any depth?",
    });

    expect(
      sent.messages.map(({ stage, spec, text, status }) => [stage, spec, text, status]),
    ).toEqual([["wayfinding", null, "Does nested mean any depth?", { state: "working" }]]);
    // A hatch run is not a next action and moves no status.
    expect(sent.status).toEqual(before.status);
    expect((await client.map.overview({ mapId })).messages).toEqual(sent.messages);

    const refusals = [
      [{ mapId, stage: "idea", specNumber: null, text: " \n " }, "hatch_message_empty", 422],
      [{ mapId, stage: "spec", specNumber: 4, text: "Rename it." }, "spec_not_found", 404],
      [{ mapId: UNKNOWN_ID, stage: "idea", specNumber: null, text: "Hi" }, "map_not_found", 404],
    ] as const;
    for (const [input, code, status] of refusals) {
      const [error] = await safe(client.hatch.send(input));
      expect(isDefinedError(error) && [error.code, error.status]).toEqual([code, status]);
    }
    const [named] = await safe(
      client.hatch.send({ mapId, stage: "idea", specNumber: 1, text: "Rename it." }),
    );
    expect(named instanceof ORPCError && named.code).toBe("BAD_REQUEST");
    expect((await client.map.overview({ mapId })).messages).toHaveLength(1);
  });

  test("the runner calls the hatch port for a sent message and stores its reply", async () => {
    const { mapId } = await clearedMap();

    await client.hatch.send({
      mapId,
      stage: "wayfinding",
      specNumber: null,
      text: "Does nested mean any depth?",
    });
    const call = await nthCall(hatchPort.calls, 0);
    expect(call.request.message).toEqual({
      stage: "wayfinding",
      specNumber: null,
      text: "Does nested mean any depth?",
    });
    expect(call.request.refusedAttempt).toBeNull();
    call.resolve({ ok: true, value: { reply: "Yes: any depth.", change: null } });

    const replied = await vi.waitFor(async () => {
      const [message] = (await client.map.overview({ mapId })).messages;
      if (message?.status.state !== "replied") {
        throw new Error("The message is not replied yet");
      }
      return message.status;
    });
    expect([replied.reply, replied.refusal]).toEqual(["Yes: any depth.", null]);
  });
});

describe("waits released across maps over /rpc", () => {
  const WAIT_NOTE = "Add a CSV option.";
  const WAITS: DraftSpecsOutcome = { specs: [], waits: [{ specNumber: 1, note: WAIT_NOTE }] };

  /** The waiting map's waits, read from the database. */
  function waitsOn(mapId: string) {
    return db
      .select()
      .from(specWaits)
      .all()
      .filter((wait) => wait.mapId === mapId);
  }

  test("a release run started by another map's ticket-set runs ending is driven with no write on the waiting map", async () => {
    const { project, mapId } = await clearedMap();
    const specRevisionId = await reviewedSpec(mapId, 0);
    await client.spec.approve({ specRevisionId });
    const tickets = await nthCall(ticketSetPort.calls, 0);
    const waiter = await clearedMapIn(project, "CSV export");
    (await nthCall(specsPort.calls, 1)).resolve({ ok: true, value: WAITS });
    await vi.waitFor(() => {
      expect(waitsOn(waiter)).toMatchObject([{ holdKind: "tickets", releasedAt: null }]);
    }, DELIVERY_WAIT);

    tickets.resolve({ ok: true, value: TICKETS });
    (await nthCall(ticketsReviewPort.calls, 0)).resolve({ ok: true, value: TICKETS_PASSED });
    const release = await nthCall(revisePort.calls, 0);
    expect(release.request).toMatchObject({
      latest: { specNumber: 1, revision: 1 },
      feedback: { kind: "wait", note: WAIT_NOTE, noteDirected: false },
    });
    expect(waitsOn(waiter)[0]?.releasedByRun).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  test("a release run started by a delivery run's end is driven with no write on the waiting map", async () => {
    const { project, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const waiter = await clearedMapIn(project, "CSV export");
    (await nthCall(specsPort.calls, 1)).resolve({ ok: true, value: WAITS });
    await vi.waitFor(() => {
      expect(waitsOn(waiter)).toMatchObject([{ holdKind: "delivering", releasedAt: null }]);
    }, DELIVERY_WAIT);

    implement.resolve({
      ok: false,
      error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
    });
    const release = await nthCall(revisePort.calls, 0);
    expect(release.request).toMatchObject({
      latest: { specNumber: 1, revision: 1 },
      feedback: { kind: "wait", note: WAIT_NOTE, noteDirected: false },
    });
    await cleanedUp(run);
    expect(log).not.toHaveBeenCalled();
  });
});
