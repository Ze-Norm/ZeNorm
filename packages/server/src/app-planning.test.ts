import { rm } from "node:fs/promises";
import { join } from "node:path";

import { isDefinedError, ORPCError, safe } from "@orpc/client";
import type {
  ChartConfirmation,
  CodeSurveyDraft,
  SurveyCodeRequest,
  PlanningRunUsage,
} from "@zenorm/contracts";
import { ok } from "@zenorm/contracts";
import { createChangeBus, listProjects, readCodeSurvey } from "@zenorm/core";
import { describe, expect, test, vi } from "vitest";

import {
  ORIGIN,
  SERVED,
  UNKNOWN_ID,
  ROUND,
  PROPOSAL,
  CONFIRMATION,
  ANSWERS,
  deferredPort,
  nthCall,
  SURVEY,
  planningPorts,
  appOf,
  root,
  db,
  webDistDir,
  log,
  chartPort,
  grillPort,
  researchPort,
  taskPort,
  surveyRequests,
  consistencyPort,
  specsPort,
  app,
  client,
  clientOf,
  addProject,
  proposed,
  overviewWhen,
  NOT_LOGGED_IN,
  setUpAppTests,
} from "./app-test-support.ts";

setUpAppTests();

describe("/rpc", () => {
  test("a domain refusal reaches the client as its code with its data", async () => {
    const folderPath = join(root, "nowhere");
    const [error] = await safe(client.project.create({ folderPath, baseBranch: "main" }));

    expect(isDefinedError(error)).toBe(true);
    if (!isDefinedError(error)) return;
    expect(error.code).toBe("project_folder_missing");
    expect(error.status).toBe(422);
    expect(error.data).toEqual({ folderPath });
    expect(log).not.toHaveBeenCalled();
  });

  test.each([
    { name: "X", folderPath: "/repos/x", baseBranch: "main" },
    { folderPath: "repos/x", baseBranch: "main" },
    { folderPath: "/repos/x", baseBranch: "" },
  ])("invalid input %j is BAD_REQUEST and never reaches core", async (input) => {
    const [error] = await safe(client.project.create(input));

    expect(error).toBeInstanceOf(ORPCError);
    expect(error instanceof ORPCError && error.code).toBe("BAD_REQUEST");
    expect(await listProjects(db)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  test("project.list returns the stored projects", async () => {
    expect(await client.project.list()).toEqual([]);
  });

  test("an unexpected error is logged and returns 500", async () => {
    db.$client.close();
    const [error] = await safe(client.project.list());

    expect(error instanceof ORPCError && error.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("an unknown /rpc path is 404, not the web app", async () => {
    const response = await app.request(`${ORIGIN}/rpc/nothing/here`, { headers: SERVED });
    expect(response.status).toBe(404);
  });
});

describe("maps over /rpc", () => {
  test("project.get returns the project, and project_not_found is 404", async () => {
    const project = await addProject();
    expect(await client.project.get({ projectId: project.id })).toEqual({ ...project, specs: [] });

    const [error] = await safe(client.project.get({ projectId: UNKNOWN_ID }));
    expect(isDefinedError(error) && error.code).toBe("project_not_found");
    expect(isDefinedError(error) && error.status).toBe(404);
  });

  test("stores a run's usage, and its retry after error_max_turns resumes the session", async () => {
    const project = await addProject();
    const usage: PlanningRunUsage = {
      sessionId: "session-9",
      resultSubtype: "error_max_turns",
      numTurns: 13,
      durationMs: 90_000,
      totalCostUsd: 1.25,
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
    };

    const detail = await client.map.create({ projectId: project.id, idea: "Add dark mode" });
    const first = await nthCall(chartPort.calls, 0);
    expect(first.session.resumeSessionId).toBeNull();
    first.session.onUsage(usage);
    first.resolve({
      ok: false,
      error: {
        code: "agent_run_failed",
        message: "Out of turns.",
        data: { exitCode: 1, subtype: "error_max_turns" },
      },
    });

    const retry = await nthCall(chartPort.calls, 1);
    expect(retry.session.resumeSessionId).toBe("session-9");
    expect(
      db.$client
        .prepare(
          `select state, error_code, session_id, result_subtype, num_turns, duration_ms,
            total_cost_usd, input_tokens, output_tokens, cache_creation_input_tokens,
            cache_read_input_tokens from planning_runs where map_id = ? and retry_of_run_id is null`,
        )
        .get(detail.map.id),
    ).toEqual({
      state: "failed",
      error_code: "agent_run_failed",
      session_id: "session-9",
      result_subtype: "error_max_turns",
      num_turns: 13,
      duration_ms: 90_000,
      total_cost_usd: 1.25,
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    });
    retry.resolve({ ok: true, value: { kind: "proposal", proposal: PROPOSAL } });
    await vi.waitFor(async () => {
      expect((await client.map.get({ mapId: detail.map.id })).map.title).toBe(PROPOSAL.title);
    });
  });

  test("map.create returns before the held chart resolves; the map and its chart run exist", async () => {
    const project = await addProject();

    const detail = await client.map.create({ projectId: project.id, idea: "  Add dark mode  " });

    // The chart port has been called, and is still held: the request did not wait on it.
    const chart = await nthCall(chartPort.calls, 0);
    expect(chart.request).toEqual({
      projectName: project.name,
      projectFolder: project.folderPath,
      baseBranch: project.baseBranch,
      idea: "Add dark mode",
      projectProposals: [],
      projectMaps: [{ title: null, stage: "idea" }],
      mapRounds: [],
      proposed: null,
      projectSpecs: [],
      split: [],
      refusedAttempt: null,
    });
    expect(detail.project).toEqual(project);
    expect(detail.map).toMatchObject({ idea: "Add dark mode", title: null, destination: null });
    expect(await client.map.get({ mapId: detail.map.id })).toEqual(detail);
    expect(await client.map.list({ projectId: project.id })).toEqual([detail.map]);
    const overview = await client.map.overview({ mapId: detail.map.id });
    expect(overview.status.stages[0]).toMatchObject({ stage: "idea", tone: "working" });
    expect(overview.wayfinding).toEqual({
      mapRounds: [],
      waypoints: [],
      fog: [],
      outOfScope: [],
      proposals: [],
    });

    chart.resolve({ ok: true, value: { kind: "proposal", proposal: PROPOSAL } });
    const charted = await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: detail.map.id });
      expect(read.map.title).toBe(PROPOSAL.title);
      return read;
    });
    expect(charted.wayfinding.mapRounds).toMatchObject([
      { number: 1, waypointId: null, final: false, status: "pending", intro: ROUND.intro },
    ]);
    expect(charted.status.next[0]).toMatchObject({
      who: "you",
      stage: "wayfinding",
      round: "destination",
    });
    expect(log).not.toHaveBeenCalled();
  });

  test("map.create returns project_not_found (404) and project_folder_missing (422), and never charts", async () => {
    const [unknown] = await safe(client.map.create({ projectId: UNKNOWN_ID, idea: "X" }));
    expect(isDefinedError(unknown) && [unknown.code, unknown.status]).toEqual([
      "project_not_found",
      404,
    ]);
    const project = await addProject();
    await rm(project.folderPath, { recursive: true, force: true });
    const [missing] = await safe(client.map.create({ projectId: project.id, idea: "X" }));
    expect(isDefinedError(missing) && [missing.code, missing.status]).toEqual([
      "project_folder_missing",
      422,
    ]);
    expect(await client.map.list({ projectId: project.id })).toEqual([]);
    expect(chartPort.calls).toHaveLength(0);
  });

  test("map.list returns project_not_found with status 404", async () => {
    const [error] = await safe(client.map.list({ projectId: UNKNOWN_ID }));

    expect(isDefinedError(error) && error.code).toBe("project_not_found");
    expect(isDefinedError(error) && error.status).toBe(404);
  });

  test("map.get returns map_not_found with status 404", async () => {
    const [error] = await safe(client.map.get({ mapId: UNKNOWN_ID }));

    expect(isDefinedError(error) && error.code).toBe("map_not_found");
    expect(isDefinedError(error) && error.status).toBe(404);
  });

  test("map.delete refuses a map whose chart runs (409); once it stops, deletes it, and an unknown map is 404", async () => {
    const project = await addProject();
    const kept = await client.map.create({ projectId: project.id, idea: "Keep this" });
    const { map } = await client.map.create({ projectId: project.id, idea: "Delete this" });
    const first = await vi.waitFor(() => {
      const call = chartPort.calls.find((candidate) => candidate.request.idea === "Delete this");
      if (call === undefined) throw new Error("Not charted yet");
      return call;
    });

    const [inFlight] = await safe(client.map.delete({ mapId: map.id, deleteSpecs: [] }));
    expect(isDefinedError(inFlight) && [inFlight.code, inFlight.status]).toEqual([
      "map_run_in_flight",
      409,
    ]);

    first.resolve(NOT_LOGGED_IN);
    const retry = await vi.waitFor(() => {
      const calls = chartPort.calls.filter((call) => call.request.idea === "Delete this");
      const call = calls[1];
      if (call === undefined) throw new Error("Not retried yet");
      return call;
    });
    retry.resolve(NOT_LOGGED_IN);
    await overviewWhen(map.id, (read) => read.status.next[0]?.stopped !== null);

    expect(await client.map.delete({ mapId: map.id, deleteSpecs: [] })).toEqual({
      mapId: map.id,
      projectId: project.id,
    });
    const [gone] = await safe(client.map.overview({ mapId: map.id }));
    expect(isDefinedError(gone) && [gone.code, gone.status]).toEqual(["map_not_found", 404]);
    expect((await client.map.list({ projectId: project.id })).map((row) => row.id)).toEqual([
      kept.map.id,
    ]);
    expect((await client.map.overviews()).map((overview) => overview.map.id)).toEqual([
      kept.map.id,
    ]);
    const [twice] = await safe(client.map.delete({ mapId: map.id, deleteSpecs: [] }));
    expect(isDefinedError(twice) && [twice.code, twice.status]).toEqual(["map_not_found", 404]);
    expect(log).not.toHaveBeenCalled();
  });

  test("a blank idea is BAD_REQUEST and nothing is charted", async () => {
    const project = await addProject();
    const [error] = await safe(client.map.create({ projectId: project.id, idea: "   " }));

    expect(error instanceof ORPCError && error.code).toBe("BAD_REQUEST");
    expect(chartPort.calls).toHaveLength(0);
    expect(await client.map.list({ projectId: project.id })).toEqual([]);
  });

  test("questionRound.submit stores answers once and starts the confirming chart, refusing invalid and repeated submissions", async () => {
    const project = await addProject();
    const { map } = await client.map.create({ projectId: project.id, idea: "Dark mode" });
    const round = await proposed(map.id, 0);

    const [invalid] = await safe(
      client.questionRound.submit({
        roundId: round.id,
        answers: [{ optionIndex: 1, note: "", accepted: true }, ...ANSWERS.slice(1)],
      }),
    );
    expect(isDefinedError(invalid) && [invalid.code, invalid.status]).toEqual([
      "round_answers_invalid",
      422,
    ]);

    const answers = ANSWERS;
    const submitted = await client.questionRound.submit({ roundId: round.id, answers });
    expect(submitted).toMatchObject({ status: "submitted", answers });
    const confirming = (await nthCall(chartPort.calls, 1)).request;
    expect(confirming.mapRounds).toEqual([{ questions: ROUND.questions, answers, final: false }]);
    // The confirming chart sees what round 1 was asked about.
    expect(confirming.proposed).toEqual({
      title: PROPOSAL.title,
      summary: PROPOSAL.summary,
      destination: PROPOSAL.destination,
    });

    const [again] = await safe(client.questionRound.submit({ roundId: round.id, answers }));
    expect(isDefinedError(again) && [again.code, again.status]).toEqual([
      "round_already_submitted",
      409,
    ]);

    const [missing] = await safe(client.questionRound.submit({ roundId: UNKNOWN_ID, answers }));
    expect(isDefinedError(missing) && [missing.code, missing.status]).toEqual([
      "round_not_found",
      404,
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("the confirming chart saves waypoints with blockers; a refused output fails its run and is retried", async () => {
    const project = await addProject();
    const { map } = await client.map.create({ projectId: project.id, idea: "Dark mode" });
    const round = await proposed(map.id, 0);
    await client.questionRound.submit({ roundId: round.id, answers: ANSWERS });

    const cycle: ChartConfirmation = {
      title: PROPOSAL.title,
      summary: PROPOSAL.summary,
      destination: "Somewhere",
      waypoints: [
        { kind: "grilling", title: "One", question: "One?", blockedBy: [2], touches: [] },
        { kind: "grilling", title: "Two", question: "Two?", blockedBy: [1], touches: [] },
      ],
      fog: [],
      outOfScope: [],
      proposals: [],
    };
    (await nthCall(chartPort.calls, 1)).resolve({
      ok: true,
      value: { kind: "confirmation", confirmation: cycle },
    });
    // The refusal fails the run with its code; its retry asks the port again.
    const retry = await nthCall(chartPort.calls, 2);
    expect((await client.map.overview({ mapId: map.id })).wayfinding.waypoints).toEqual([]);
    retry.resolve({ ok: true, value: { kind: "confirmation", confirmation: CONFIRMATION } });

    const confirmed = await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: map.id });
      expect(read.map.destinationConfirmedAt).not.toBeNull();
      return read;
    });
    expect(confirmed.map.destination).toBe(CONFIRMATION.destination);
    expect(
      confirmed.wayfinding.waypoints.map(({ number, kind, status, blockedBy, rounds, state }) => ({
        number,
        kind,
        status,
        blockedBy,
        rounds,
        state,
      })),
    ).toEqual([
      // Waypoint 1 is claimed at once and its grilling run, held by the fake, reads working.
      {
        number: 1,
        kind: "grilling",
        status: "claimed",
        blockedBy: [],
        rounds: [],
        state: { kind: "working" },
      },
      {
        number: 2,
        kind: "grilling",
        status: "open",
        blockedBy: [1],
        rounds: [],
        state: { kind: "blocked", waitsOn: [1] },
      },
      {
        number: 3,
        kind: "grilling",
        status: "open",
        blockedBy: [1],
        rounds: [],
        state: { kind: "blocked", waitsOn: [1] },
      },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("a chart's proposal is confirmed into a charting map split from it, another dismissed; a decided one is refused", async () => {
    const project = await addProject();
    const { map } = await client.map.create({ projectId: project.id, idea: "Dark mode" });
    const round = await proposed(map.id, 0);
    await client.questionRound.submit({ roundId: round.id, answers: ANSWERS });
    (await nthCall(chartPort.calls, 1)).resolve({
      ok: true,
      value: {
        kind: "confirmation",
        confirmation: {
          ...CONFIRMATION,
          proposals: [
            {
              title: "High contrast",
              idea: "A high-contrast theme.",
              line: "High contrast is its own effort.",
            },
            { title: "Theme presets", idea: "Theme presets.", line: "Presets are a later effort." },
          ],
        },
      },
    });
    const charted = await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: map.id });
      expect(read.wayfinding.proposals).toHaveLength(2);
      return read;
    });
    const [first, second] = charted.wayfinding.proposals;
    if (first === undefined || second === undefined) throw new Error("Expected two proposals");
    expect(first).toMatchObject({
      idea: "A high-contrast theme.",
      line: "High contrast is its own effort.",
      waypoint: null,
      state: "pending",
      newMapId: null,
    });
    expect(charted.wayfinding.outOfScope).toEqual([]);

    const confirmed = await client.map.confirmProposal({
      proposalId: first.id,
      idea: "  A high-contrast theme for low vision.  ",
    });
    // The person stays on the map the proposal was made on.
    expect(confirmed.map.id).toBe(map.id);
    const decided = confirmed.wayfinding.proposals[0];
    expect(decided).toMatchObject({
      state: "confirmed",
      idea: "A high-contrast theme for low vision.",
    });
    const newMapId = decided?.newMapId;
    if (newMapId === null || newMapId === undefined) throw new Error("No new map");
    expect(confirmed.wayfinding.outOfScope).toEqual([
      { text: "High contrast is its own effort.", waypoint: null, splitMapId: newMapId },
    ]);
    expect(confirmed.map.destination).toBe(CONFIRMATION.destination);
    expect(confirmed.wayfinding.waypoints).toHaveLength(3);
    // The new map's chart runs in the background, reading only its idea.
    const chart = await nthCall(chartPort.calls, 2);
    expect(chart.request).toMatchObject({
      idea: "A high-contrast theme for low vision.",
      mapRounds: [],
    });
    expect((await client.map.get({ mapId: newMapId })).map).toMatchObject({
      projectId: project.id,
      splitFromMapId: map.id,
      splitFromRunId: first.createdByRun,
    });

    const dismissed = await client.map.dismissProposal({ proposalId: second.id });
    expect(dismissed.wayfinding.proposals[1]).toMatchObject({ state: "dismissed", newMapId: null });
    expect(dismissed.wayfinding.outOfScope).toEqual([
      { text: "High contrast is its own effort.", waypoint: null, splitMapId: newMapId },
      { text: "Presets are a later effort.", waypoint: null, splitMapId: null },
    ]);

    const [again] = await safe(
      client.map.confirmProposal({ proposalId: first.id, idea: "A third theme." }),
    );
    expect(isDefinedError(again) && [again.code, again.status]).toEqual([
      "proposal_already_decided",
      409,
    ]);
    const [twice] = await safe(client.map.dismissProposal({ proposalId: second.id }));
    expect(isDefinedError(twice) && [twice.code, twice.status]).toEqual([
      "proposal_already_decided",
      409,
    ]);
    const [missing] = await safe(client.map.dismissProposal({ proposalId: UNKNOWN_ID }));
    expect(isDefinedError(missing) && [missing.code, missing.status]).toEqual([
      "proposal_not_found",
      404,
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("waypoint states over /rpc", () => {
  test("while the code survey runs every waypoint reads what holds it, and the overview answers; the survey's end starts the ready one", async () => {
    // A survey port that holds until the test answers it.
    const surveyPort = deferredPort<SurveyCodeRequest, CodeSurveyDraft>();
    const surveying = await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      surveyCode: surveyPort.port,
    });
    const reader = clientOf(surveying);
    const project = await addProject();
    const { map } = await reader.map.create({ projectId: project.id, idea: "Dark mode" });
    const round = await proposed(map.id, 0);
    await reader.questionRound.submit({ roundId: round.id, answers: ANSWERS });
    (await nthCall(chartPort.calls, 1)).resolve({
      ok: true,
      value: { kind: "confirmation", confirmation: CONFIRMATION },
    });
    const survey = await nthCall(surveyPort.calls, 0);

    const held = await reader.map.overview({ mapId: map.id });
    expect(held.map.destinationConfirmedAt).not.toBeNull();
    expect(
      held.wayfinding.waypoints.map(({ number, status, state }) => ({ number, status, state })),
    ).toEqual([
      { number: 1, status: "open", state: { kind: "waits_on_survey" } },
      { number: 2, status: "open", state: { kind: "blocked", waitsOn: [1] } },
      { number: 3, status: "open", state: { kind: "blocked", waitsOn: [1] } },
    ]);
    expect(held.status.stages[1]).toMatchObject({ stage: "wayfinding", tone: "working" });
    expect(grillPort.calls).toEqual([]);

    survey.resolve(ok(SURVEY));
    await nthCall(grillPort.calls, 0);
    const started = await reader.map.overview({ mapId: map.id });
    expect(started.wayfinding.waypoints[0]).toMatchObject({
      status: "claimed",
      state: { kind: "working" },
    });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("grilling over /rpc", () => {
  test("a held grilling run reads working; its round, answered with plain choices, starts the run that settles the waypoint", async () => {
    const project = await addProject();
    const { map } = await client.map.create({ projectId: project.id, idea: "Dark mode" });
    const round = await proposed(map.id, 0);
    await client.questionRound.submit({ roundId: round.id, answers: ANSWERS });
    (await nthCall(chartPort.calls, 1)).resolve({
      ok: true,
      value: { kind: "confirmation", confirmation: CONFIRMATION },
    });

    const call = await nthCall(grillPort.calls, 0);
    // The confirmed chart's code survey ran first and is stored on the map.
    expect(surveyRequests.map((request) => request.waypoints.length)).toEqual([
      CONFIRMATION.waypoints.length,
    ]);
    expect(readCodeSurvey(db, map.id)).toEqual(SURVEY);
    expect(call.request.waypoint).toMatchObject({ number: 1, rounds: [] });
    expect(call.request.afterFinal).toBe(false);
    const held = await client.map.overview({ mapId: map.id });
    expect(held.wayfinding.waypoints[0]).toMatchObject({
      status: "claimed",
      state: { kind: "working" },
    });
    expect(held.status.stages[1]).toMatchObject({ stage: "wayfinding", tone: "working" });

    call.resolve({
      ok: true,
      value: {
        round: { intro: "One choice.", final: true, questions: ROUND.questions },
        resolution: null,
        outOfScope: null,
        mapChanges: null,
      },
    });
    const asked = await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: map.id });
      const waypointRound = read.wayfinding.waypoints[0]?.rounds[0];
      if (waypointRound === undefined) throw new Error("No waypoint round yet");
      return { read, waypointRound };
    });
    expect(asked.read.wayfinding.waypoints[0]?.state).toEqual({ kind: "waiting_on_you" });
    expect(asked.read.status.next[0]).toMatchObject({ who: "you", round: 1 });

    const plain = ROUND.questions.map(() => ({ optionIndex: 0, note: "", accepted: true }));
    await client.questionRound.submit({ roundId: asked.waypointRound.id, answers: plain });
    // Plain choices start the grilling run after the final round; the run resolves it.
    const after = await nthCall(grillPort.calls, 1);
    expect(after.request.afterFinal).toBe(true);
    const running = await client.map.overview({ mapId: map.id });
    expect(running.wayfinding.waypoints[0]).toMatchObject({
      status: "claimed",
      state: { kind: "working" },
    });
    after.resolve({
      ok: true,
      value: {
        round: null,
        resolution: {
          resolution: "Every surface follows the system theme.",
          gist: "Follow the system theme",
          agentDecided: [],
        },
        outOfScope: null,
        mapChanges: {
          newWaypoints: [],
          fogOutOfScope: [],
          fogDecided: [],
          fogSettledHere: [],
          newFog: [],
        },
      },
    });
    const settled = await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: map.id });
      if (read.wayfinding.waypoints[0]?.status !== "resolved") throw new Error("Not resolved yet");
      return read;
    });
    expect(settled.wayfinding.waypoints[0]).toMatchObject({
      gist: "Follow the system theme",
      resolvedHow: "run",
    });
    expect(typeof settled.wayfinding.waypoints[0]?.resolvedByRun).toBe("string");
    // Waypoints 2 and 3 are claimed in the same write and their runs launched.
    await nthCall(grillPort.calls, 3);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("research and task runs over /rpc", () => {
  test("a held research run reads working; research and a task round with options settle their waypoints; the pass clears the map", async () => {
    const project = await addProject();
    const { map } = await client.map.create({ projectId: project.id, idea: "Dark mode" });
    const round = await proposed(map.id, 0);
    await client.questionRound.submit({ roundId: round.id, answers: ANSWERS });
    const [palette, toggle] = CONFIRMATION.waypoints;
    if (palette === undefined || toggle === undefined) throw new Error("No waypoints");
    (await nthCall(chartPort.calls, 1)).resolve({
      ok: true,
      value: {
        kind: "confirmation",
        confirmation: {
          ...CONFIRMATION,
          waypoints: [
            { ...palette, kind: "research" },
            { ...toggle, kind: "task", blockedBy: [] },
          ],
        },
      },
    });

    const researchCall = await nthCall(researchPort.calls, 0);
    expect(researchCall.request.waypoint).toMatchObject({ number: 1, kind: "research" });
    const taskCall = await nthCall(taskPort.calls, 0);
    const held = await client.map.overview({ mapId: map.id });
    expect(held.wayfinding.waypoints[0]).toMatchObject({
      status: "claimed",
      state: { kind: "working" },
    });
    expect(held.status.stages[1]).toMatchObject({ stage: "wayfinding", tone: "working" });

    researchCall.resolve({
      ok: true,
      value: {
        report: {
          answered: true,
          summary: "The palette follows the system colours.",
          gap: null,
          gist: "System colours",
          findings: [{ title: "Palette", detail: "The CSS uses system colours.", sources: [1] }],
          sources: [{ kind: "repository_file", title: "theme.css", url: null, excerpt: "Canvas" }],
          limitations: [],
          uncertainties: [],
        },
        outOfScope: null,
        mapChanges: {
          newWaypoints: [],
          fogOutOfScope: [],
          fogDecided: [],
          fogSettledHere: [],
          newFog: [],
        },
      },
    });
    const taskQuestion = {
      topic: "Place",
      text: "Which header?",
      options: [
        { label: "The top bar", detail: "Always visible." },
        { label: "The menu", detail: "One click away." },
      ],
    };
    taskCall.resolve({
      ok: true,
      value: {
        round: { intro: "One thing.", questions: [taskQuestion] },
        done: null,
        failed: null,
        outOfScope: null,
        mapChanges: null,
      },
    });
    const asked = await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: map.id });
      expect(read.wayfinding.waypoints[0]).toMatchObject({
        status: "resolved",
        state: { kind: "resolved" },
      });
      const taskRound = read.wayfinding.waypoints[1]?.rounds[0];
      if (taskRound === undefined) throw new Error("No task round yet");
      return taskRound;
    });
    expect(asked.questions).toEqual([taskQuestion]);
    const taskAnswers = [{ optionIndex: 0, note: "", accepted: true }];
    await client.questionRound.submit({ roundId: asked.id, answers: taskAnswers });
    const again = await nthCall(taskPort.calls, 1);
    expect(again.request.waypoint.rounds).toEqual([
      { questions: [taskQuestion], answers: taskAnswers },
    ]);
    again.resolve({
      ok: true,
      value: {
        round: null,
        done: {
          action: "Read the header.",
          facts: "The top bar has room.",
          gist: "Top bar",
          agentDecided: [],
        },
        failed: null,
        outOfScope: null,
        mapChanges: {
          newWaypoints: [],
          fogOutOfScope: [],
          fogDecided: [],
          fogSettledHere: [],
          newFog: [],
        },
      },
    });
    await vi.waitFor(async () => {
      const read = await client.map.overview({ mapId: map.id });
      expect(read.wayfinding.waypoints[1]).toMatchObject({
        status: "resolved",
        resolution: "The top bar has room.",
      });
    });
    const passCall = await nthCall(consistencyPort.calls, 0);
    expect(passCall.request.waypoints.map((w) => [w.number, w.kind])).toEqual([
      [1, "research"],
      [2, "task"],
    ]);
    expect(specsPort.calls).toEqual([]);
    passCall.resolve({ ok: true, value: { findings: [], proposals: [] } });
    await nthCall(specsPort.calls, 0);
    expect(log).not.toHaveBeenCalled();
  });
});
