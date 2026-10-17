import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { createORPCClient, isDefinedError, ORPCError, safe } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type {
  CancelledError,
  ChartConfirmation,
  ChartMap,
  ChartMapRequest,
  CheckConsistencyRequest,
  ChartOutcome,
  CodeSurveyDraft,
  SettleFog,
  SurveyCode,
  SurveyCodeRequest,
  ConsistencyOutcome,
  ChartProposal,
  Contract,
  DeliveryAgentError,
  DeliveryExecutor,
  DeliveryRun,
  DraftSpecsOutcome,
  DraftSpecsRequest,
  DraftTicketSetRequest,
  ReviseSpecOutcome,
  ReviseSpecRequest,
  ImplementEvent,
  ImplementRequest,
  GrillOutcome,
  GrillWaypointRequest,
  HatchOutcome,
  ImplementTicketSet,
  MapOverviewDetail,
  MapSpec,
  PlanningAgentError,
  PlanningCallSession,
  PlanningRunUsage,
  Project,
  PullRequestRequest,
  QuestionRound,
  QuestionRoundDraft,
  ReplyThroughHatchRequest,
  ResearchOutcome,
  ResearchWaypointRequest,
  SpecRun,
  Result,
  ReviewDelivery,
  ReviewRequest,
  ReviewSpecRequest,
  ReviewTicketSetRequest,
  RunEvent,
  SpecReviewOutcome,
  TaskOutcome,
  TicketSetContent,
  TicketsReviewOutcome,
  Verdict,
  WorkTaskRequest,
  WritePullRequest,
} from "@zenorm/contracts";
import { err, gitIdentityEnv, ok, PULL_REQUEST_FOOTER } from "@zenorm/contracts";
import {
  createChangeBus,
  GITHUB_SIGN_IN_TIMEOUT_MS,
  listProjects,
  PULL_REQUEST_CHECK_INTERVAL_MS,
  ticketBranchName,
  readCodeSurvey,
  sweepInterruptedRuns,
  write,
} from "@zenorm/core";
import {
  deliveryRuns,
  installChangeFeed,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
  specWaits,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { definePlugin, SDK_VERSION } from "@zenorm/plugin-sdk";
import type { ServerPlugin } from "@zenorm/plugin-sdk";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { createApp } from "./app.ts";
import type { AppOptions, Log, ZeNormApp } from "./app.ts";
import { EXECUTOR_STOP_BOUND_MS } from "./delivery.ts";
import { checkPlugins } from "./plugins.ts";
import type { CheckedPlugins } from "./plugins.ts";

const INDEX_HTML = "<!doctype html><title>ZeNorm test</title>";
/** The host and port the test app is configured on. */
const SERVER = { host: "127.0.0.1", port: 4310 };
/** What a request to the test app carries as its Host, and its page's Origin. */
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
/** The headers an app request needs to be served: `Request` sets no Host of its own. */
const SERVED = { host: HOST };
/** A UUIDv7 that names nothing stored. */
const UNKNOWN_ID = "01920000-0000-7000-8000-000000000000";

const ROUND: QuestionRoundDraft = {
  intro: "I propose a dark theme with a toggle. Two questions confirm it.",
  questions: [
    {
      topic: "Scope",
      text: "What must the change cover?",
      options: [
        { label: "Narrow", detail: "Only the named screen." },
        { label: "Wide", detail: "Every screen." },
      ],
    },
    {
      topic: "Audience",
      text: "Who is it for?",
      options: [
        { label: "Maintainers", detail: "People who run it." },
        { label: "Users", detail: "People who use it." },
      ],
    },
  ],
};

const PROPOSAL: ChartProposal = {
  title: "Dark mode",
  summary: "People want a darker screen at night.",
  destination: "A dark theme switched by a toggle.",
  round: ROUND,
  split: [],
};

const CONFIRMATION: ChartConfirmation = {
  title: PROPOSAL.title,
  summary: PROPOSAL.summary,
  destination: "A dark theme switched by a toggle, remembered across reloads.",
  waypoints: [
    {
      kind: "grilling",
      title: "Palette",
      question: "Which palette does the dark theme use?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Toggle place",
      question: "Where does the toggle sit?",
      blockedBy: [1],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Default",
      question: "Which theme does a new visitor see?",
      blockedBy: [1],
      touches: [],
    },
  ],
  fog: [],
  outOfScope: [],
  proposals: [],
};

const NO_WAYPOINTS: ChartConfirmation = { ...CONFIRMATION, waypoints: [] };

const SPEC: DraftSpecsOutcome["specs"][number]["content"] = {
  title: "Dark mode",
  problem: "The app is bright.",
  solution: "A dark theme.",
  clauses: [
    {
      id: "C1",
      title: "Theme",
      text: "A dark theme the person can choose.",
      criteria: [
        { id: "1.1", text: "A toggle switches the theme." },
        { id: "1.2", text: "The choice survives a reload." },
      ],
      sources: [{ kind: "destination" }],
      reliesOn: [],
      adds: ["dark theme"],
    },
  ],
  outOfScope: [],
};

const DRAFTED: DraftSpecsOutcome = { specs: [{ specNumber: null, content: SPEC }], waits: [] };

const PASSED: SpecReviewOutcome = {
  summary: "Every clause traces.",
  findings: [],
  verified: [],
};

const TICKETS_PASSED: TicketsReviewOutcome = {
  summary: "Every criterion is covered.",
  findings: [],
};

const TICKETS: TicketSetContent = {
  tickets: [
    {
      id: "T1",
      title: "Theme toggle",
      build: "Add the toggle and keep the choice.",
      blockedBy: [],
      criteria: ["1.1", "1.2"],
      testing: ["The toggle switches and survives a reload."],
      followUp: null,
      outOfScope: [],
      pointers: ["src/index.ts"],
    },
  ],
  dispositions: [
    { criterion: "1.1", kind: "work", ticket: "T1", reason: null },
    { criterion: "1.2", kind: "work", ticket: "T1", reason: null },
  ],
  slicing: "One ticket: the toggle and its storage go together.",
  execution: "The package tests verify it.",
};

const ANSWERS = [
  { optionIndex: 1, note: "", accepted: false },
  { optionIndex: null, note: "Both, really", accepted: false },
];

/** One fake port call the test settles when it chooses, so `running` stays observable. */
interface PendingDraft<TRequest, TValue> {
  readonly request: TRequest;
  readonly session: PlanningCallSession;
  readonly resolve: (result: Result<TValue, PlanningAgentError>) => void;
  readonly reject: (error: unknown) => void;
}

/** A fake port that records each call and leaves its promise pending until the test settles it. */
function deferredPort<TRequest, TValue>(): {
  readonly port: (
    request: TRequest,
    session: PlanningCallSession,
  ) => Promise<Result<TValue, PlanningAgentError>>;
  readonly calls: PendingDraft<TRequest, TValue>[];
} {
  const calls: PendingDraft<TRequest, TValue>[] = [];
  const port = (request: TRequest, session: PlanningCallSession) =>
    new Promise<Result<TValue, PlanningAgentError>>((resolve, reject) => {
      calls.push({ request, session, resolve, reject });
    });
  return { port, calls };
}

/**
 * How long a wait on a delivery run's progress polls. A run spawns git (worktree, checks, the
 * review diff, the push) and gh, which on a loaded machine takes seconds, far past `vi.waitFor`'s
 * 1 s default; the bound stays under the 20 s test timeout so a stuck run fails at its wait.
 */
const DELIVERY_WAIT = { timeout: 15_000, interval: 20 };

/** Waits for the `n`th call (from 0) of a deferred port; core reads the map before calling it. */
async function nthCall<T>(calls: readonly T[], n: number): Promise<T> {
  return await vi.waitFor(() => {
    const call = calls[n];
    if (call === undefined) {
      throw new Error(
        `The port was called ${String(calls.length)} times, expected call ${String(n)}`,
      );
    }
    return call;
  }, DELIVERY_WAIT);
}

/** One delivery port call the test settles when it chooses, so each phase stays observable. */
interface PendingSession<TRequest, TValue> {
  readonly request: TRequest;
  readonly signal: AbortSignal;
  /** The orchestrator's event callback; the reviewer port has none. */
  readonly onEvent: ((event: ImplementEvent) => void) | undefined;
  readonly resolve: (result: Result<TValue, DeliveryAgentError>) => void;
  readonly reject: (error: unknown) => void;
}

/** A fake delivery port that records each call and leaves its promise pending. */
function deferredSession<TRequest, TValue>(): {
  readonly port: (
    request: TRequest,
    signal: AbortSignal,
    onEvent?: (event: ImplementEvent) => void,
  ) => Promise<Result<TValue, DeliveryAgentError>>;
  readonly calls: PendingSession<TRequest, TValue>[];
} {
  const calls: PendingSession<TRequest, TValue>[] = [];
  const port = (
    request: TRequest,
    signal: AbortSignal,
    onEvent?: (event: ImplementEvent) => void,
  ) =>
    new Promise<Result<TValue, DeliveryAgentError>>((resolve, reject) => {
      calls.push({ request, signal, onEvent, resolve, reject });
    });
  return { port, calls };
}

/** A code survey naming the repository root, which every project has. */
const SURVEY: CodeSurveyDraft = {
  entries: [
    {
      area: ".",
      role: "The repository root.",
      touched: true,
      why: "The destination changes it.",
      surfaceFiles: [],
      facts: [],
    },
  ],
  identifiers: [],
  unverifiable: [],
  lifecycles: [],
};

/**
 * The code survey port: it answers at once with `SURVEY`, so the flows these tests drive go on from
 * a confirmed chart to its waypoints (harness change #1). Records each request.
 */
const surveyCode: SurveyCode = (request) => {
  surveyRequests.push(request);
  return Promise.resolve(ok(SURVEY));
};

/** The fog run's port (harness change #4): it moves every fog item out of scope at once. */
const settleFog: SettleFog = (request) =>
  Promise.resolve(
    ok({
      fogSettledBy: [],
      fogDecided: [],
      fogOutOfScope: request.fog.map((item) => ({ position: item.position, line: "Later." })),
      fogForPerson: [],
      fogProposed: [],
    }),
  );

/** The delivery ports and settings, shared by every `createApp` of a test. */
/** Every port of an app over the test's deferred ports. */
function planningPorts() {
  return {
    server: SERVER,
    chartMap: chartPort.port,
    surveyCode,
    settleFog,
    grillWaypoint: grillPort.port,
    researchWaypoint: researchPort.port,
    workTask: taskPort.port,
    checkConsistency: consistencyPort.port,
    draftSpecs: specsPort.port,
    reviseSpec: revisePort.port,
    reviewSpec: specReviewPort.port,
    draftTicketSet: ticketSetPort.port,
    reviewTicketSet: ticketsReviewPort.port,
    replyThroughHatch: hatchPort.port,
    ...deliveryOptions(),
  };
}

/** The test's `"local"` executor, over the deferred delivery sessions. */
function localExecutor(): DeliveryExecutor {
  const implementTicketSet: ImplementTicketSet = implementPort.port;
  const reviewDelivery: ReviewDelivery = reviewPort.port;
  const writePullRequest: WritePullRequest = pullRequestPort.port;
  return { name: "local", implementTicketSet, reviewDelivery, writePullRequest };
}

/** `plugins` checked as the app entry checks them, with `executors` and the one `executor` names. */
function checked(
  plugins: readonly ServerPlugin[],
  executors: readonly DeliveryExecutor[],
  executor: string,
): CheckedPlugins {
  const result = checkPlugins({ plugins, pluginConfig: {}, executors, executor });
  if (!result.ok) {
    throw new Error(`checkPlugins refused: ${result.error.code}`);
  }
  return result.value;
}

function deliveryOptions() {
  return {
    plugins: checked([], [localExecutor()], "local"),
    delivery: { runsDir: join(root, "runs"), checkTimeoutMinutes: 1 },
  };
}

/** The app over `options`, started and launched as the app entry does; a refusal fails the test. */
async function appOf(options: AppOptions): Promise<ZeNormApp> {
  const created = createApp(options);
  if (!created.ok) {
    throw new Error(`createApp refused: ${created.error.code}`);
  }
  const started = await created.value.startPlugins();
  if (!started.ok) {
    throw new Error(`startPlugins refused: ${started.error.code}`);
  }
  created.value.launch();
  return created.value;
}

let root: string;
let db: ZeNormDatabase;
let webDistDir: string;
let log: Mock<Log>;
let chartPort: ReturnType<typeof deferredPort<ChartMapRequest, ChartOutcome>>;
let grillPort: ReturnType<typeof deferredPort<GrillWaypointRequest, GrillOutcome>>;
let researchPort: ReturnType<typeof deferredPort<ResearchWaypointRequest, ResearchOutcome>>;
let taskPort: ReturnType<typeof deferredPort<WorkTaskRequest, TaskOutcome>>;
let surveyRequests: SurveyCodeRequest[];
let consistencyPort: ReturnType<typeof deferredPort<CheckConsistencyRequest, ConsistencyOutcome>>;
let specsPort: ReturnType<typeof deferredPort<DraftSpecsRequest, DraftSpecsOutcome>>;
let revisePort: ReturnType<typeof deferredPort<ReviseSpecRequest, ReviseSpecOutcome>>;
let specReviewPort: ReturnType<typeof deferredPort<ReviewSpecRequest, SpecReviewOutcome>>;
let ticketSetPort: ReturnType<typeof deferredPort<DraftTicketSetRequest, TicketSetContent>>;
let ticketsReviewPort: ReturnType<
  typeof deferredPort<ReviewTicketSetRequest, TicketsReviewOutcome>
>;
let hatchPort: ReturnType<typeof deferredPort<ReplyThroughHatchRequest, HatchOutcome>>;
let implementPort: ReturnType<typeof deferredSession<ImplementRequest, null>>;
let reviewPort: ReturnType<typeof deferredSession<ReviewRequest, Verdict>>;
let pullRequestPort: ReturnType<typeof deferredSession<PullRequestRequest, string>>;
let app: ZeNormApp;
let client: ContractRouterClient<Contract>;

function clientOf(target: ZeNormApp): ContractRouterClient<Contract> {
  const link = new RPCLink({
    url: `${ORIGIN}/rpc`,
    fetch: async (request, init) => {
      const served = new Request(request, init);
      served.headers.set("host", HOST);
      return await target.request(served);
    },
  });
  return createORPCClient(link);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-server-"));
  webDistDir = join(root, "dist");
  await mkdir(webDistDir);
  await writeFile(join(webDistDir, "index.html"), INDEX_HTML);
  await writeFile(join(webDistDir, "asset.js"), "export {};");
  await mkdir(join(root, "runs"));
  const opened = openDatabase(join(root, "zenorm.sqlite"));
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  db = opened.value;
  const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }
  installChangeFeed(db);
  log = vi.fn<Log>();
  chartPort = deferredPort<ChartMapRequest, ChartOutcome>();
  grillPort = deferredPort<GrillWaypointRequest, GrillOutcome>();
  researchPort = deferredPort<ResearchWaypointRequest, ResearchOutcome>();
  taskPort = deferredPort<WorkTaskRequest, TaskOutcome>();
  consistencyPort = deferredPort<CheckConsistencyRequest, ConsistencyOutcome>();
  surveyRequests = [];
  specsPort = deferredPort<DraftSpecsRequest, DraftSpecsOutcome>();
  revisePort = deferredPort<ReviseSpecRequest, ReviseSpecOutcome>();
  specReviewPort = deferredPort<ReviewSpecRequest, SpecReviewOutcome>();
  ticketSetPort = deferredPort<DraftTicketSetRequest, TicketSetContent>();
  ticketsReviewPort = deferredPort<ReviewTicketSetRequest, TicketsReviewOutcome>();
  hatchPort = deferredPort<ReplyThroughHatchRequest, HatchOutcome>();
  implementPort = deferredSession<ImplementRequest, null>();
  reviewPort = deferredSession<ReviewRequest, Verdict>();
  pullRequestPort = deferredSession<PullRequestRequest, string>();
  app = await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() });
  client = clientOf(app);
});

afterEach(async () => {
  if (db.$client.open) {
    db.$client.close();
  }
  // A git process of a run that just ended can still be writing in a repository's `.git`, which
  // makes one pass of the removal fail ENOTEMPTY; `rm` retries that.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

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

/** Adds a Project over a fresh git repository with one commit on `main`. */
async function addProject(): Promise<Project> {
  const folderPath = join(root, "repo");
  const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
  execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "init"]);
  return await client.project.create({ folderPath, baseBranch: "main" });
}

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

  test("map.create returns before the held chart resolves; the map and its chart run exist (S6a-2)", async () => {
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
    // The confirming chart sees what round 1 was asked about (DR-3).
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
    // The confirmed chart's code survey ran first and is stored on the map (harness change #1).
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
    // Plain choices start the grilling run after the final round (S7b-14); the run resolves it.
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

/** Resolves chart call `n` with the proposal and returns the map's pending destination round. */
async function proposed(mapId: string, n: number): Promise<QuestionRound> {
  (await nthCall(chartPort.calls, n)).resolve({
    ok: true,
    value: { kind: "proposal", proposal: PROPOSAL },
  });
  return await vi.waitFor(async () => {
    const [round] = (await client.map.overview({ mapId })).wayfinding.mapRounds;
    if (round === undefined) throw new Error("No destination round yet");
    return round;
  });
}

/**
 * Adds a project and a map, and charts it with no waypoints: the map clears and its spec draft
 * starts by itself.
 */
async function clearedMap(idea = "Dark mode"): Promise<{ project: Project; mapId: string }> {
  const project = await addProject();
  return { project, mapId: await clearedMapIn(project, idea) };
}

async function clearedMapIn(project: Project, idea: string): Promise<string> {
  const first = chartPort.calls.length;
  const { map } = await client.map.create({ projectId: project.id, idea });
  const round = await proposed(map.id, first);
  await client.questionRound.submit({ roundId: round.id, answers: ANSWERS });
  (await nthCall(chartPort.calls, first + 1)).resolve({
    ok: true,
    value: { kind: "confirmation", confirmation: NO_WAYPOINTS },
  });
  await vi.waitFor(async () => {
    expect(specLine(await client.map.overview({ mapId: map.id }))).toBe(
      "Agent is writing the spec",
    );
  });
  return map.id;
}

/** The map's Spec stage line. */
function specLine(overview: MapOverviewDetail): string {
  return overview.status.stages[2].line;
}

/** Polls `map.overview` until `ready` holds, and returns that overview. */
async function overviewWhen(
  mapId: string,
  ready: (overview: MapOverviewDetail) => boolean,
): Promise<MapOverviewDetail> {
  return await vi.waitFor(async () => {
    const overview = await client.map.overview({ mapId });
    expect(ready(overview)).toBe(true);
    return overview;
  });
}

/** The map's first spec; none is a test failure. */
function firstSpec(overview: MapOverviewDetail): MapSpec {
  const [spec] = overview.specs;
  if (spec === undefined) throw new Error("The map has no spec");
  return spec;
}

/** Writes spec 1 on a cleared map and passes its review; returns its revision id. */
async function reviewedSpec(mapId: string, call: number): Promise<string> {
  (await nthCall(specsPort.calls, call)).resolve({ ok: true, value: DRAFTED });
  (await nthCall(specReviewPort.calls, call)).resolve({ ok: true, value: PASSED });
  const overview = await overviewWhen(
    mapId,
    (read) => read.specs[0]?.revisions[0]?.review.state === "passed",
  );
  const [revision] = firstSpec(overview).revisions;
  if (revision === undefined) throw new Error("No revision");
  return revision.id;
}

const NOT_LOGGED_IN = {
  ok: false,
  error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
} as const;

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

  test("the runner records a passed tickets review; a failing review is retried, then stops with Try again (S7c-2, S7c-10)", async () => {
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

  test("a failure is retried once; a failed retry stops the map, and Try again writes again (S6a-12)", async () => {
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

  test("a new app over the same database interrupts the held run and retries it (S6a-13)", async () => {
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

  test("no plugin seam or subscriber is called before its plugin's start, with a run to retry (CR9b-2)", async () => {
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

  test("a plugin start that fails launches nothing, and launch refuses (CR9b-2)", async () => {
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

/** A git repository at `root/<name>` on `main`, with one commit when `commit` is true. */
function makeRepo(name: string, commit: boolean): string {
  const folderPath = join(root, name);
  const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
  if (commit) {
    execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "i"]);
  }
  return folderPath;
}

/** What a planning port returns for an aborted call (spec D2). */
const PLANNING_CANCELLED: CancelledError = {
  code: "agent_cancelled",
  message: "Cancelled",
  data: {},
};

const STOP_USAGE: PlanningRunUsage = {
  sessionId: "session-stopped",
  resultSubtype: "success",
  numTurns: 2,
  durationMs: 1_000,
  totalCostUsd: 0.5,
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
};

/**
 * A chart port that waits for `session.signal`, like the real CLI under a stop: on the abort it
 * reports a usage through `onUsage` (a CLI printing its usage while being stopped), then returns
 * `agent_cancelled`. Records each call's session.
 */
function stoppableChart(): { readonly port: ChartMap; readonly sessions: PlanningCallSession[] } {
  const sessions: PlanningCallSession[] = [];
  const port: ChartMap = (_request, session) =>
    new Promise((resolve) => {
      sessions.push(session);
      session.signal.addEventListener(
        "abort",
        () => {
          session.onUsage(STOP_USAGE);
          resolve({ ok: false, error: PLANNING_CANCELLED });
        },
        { once: true },
      );
    });
  return { port, sessions };
}

/** The planning runs of a map, oldest first, as stored. */
function storedRuns(mapId: string): unknown[] {
  return db.$client
    .prepare(
      `select id, state, error_code, retry_of_run_id, session_id, total_cost_usd
        from planning_runs where map_id = ? order by started_at, id`,
    )
    .all(mapId);
}

describe("the planning runner's stop (S9-2)", () => {
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
      "spec", // map cleared, spec being written (on Spec, L160)
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
    // A hatch run is not a next action and moves no status (D6).
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

  test("the runner calls the hatch port for a sent message and stores its reply (S7b-3, S7b-4)", async () => {
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

/** Takes a new map to an approved spec and an approved ticket set (two tickets). */
async function approvedSet(): Promise<{
  project: Project;
  mapId: string;
  specificationId: string;
  ticketSetId: string;
}> {
  const specCall = specsPort.calls.length;
  const ticketSetCall = ticketSetPort.calls.length;
  const ticketsReviewCall = ticketsReviewPort.calls.length;
  const { project, mapId } = await clearedMap();
  const specRevisionId = await reviewedSpec(mapId, specCall);
  await client.spec.approve({ specRevisionId });
  (await nthCall(ticketSetPort.calls, ticketSetCall)).resolve({
    ok: true,
    value: TICKETS,
  });
  const written = await overviewWhen(mapId, (read) => firstSpec(read).ticketSets.length === 1);
  const [ticketSet] = firstSpec(written).ticketSets;
  if (ticketSet === undefined) throw new Error("No ticket set");
  (await nthCall(ticketsReviewPort.calls, ticketsReviewCall)).resolve({
    ok: true,
    value: TICKETS_PASSED,
  });
  await overviewWhen(mapId, (read) => firstSpec(read).ticketSets[0]?.state === "review_passed");
  await client.ticketSet.approve({ ticketSetId: ticketSet.id });
  return { project, mapId, specificationId: firstSpec(written).id, ticketSetId: ticketSet.id };
}

const DELIVERED_FILE = "delivered.txt";
/** The body every stand-in pull request writer returns (C3's headings). */
const PULL_REQUEST_BODY = "## Why\n\nDark mode.\n\n## What\n\n## Tests\n\n## Risks\n\nNone.\n";
const PASSING_CHECK = "git status --short";
const FAILING_CHECK = "git rev-parse --verify no-such-ref";

function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * What a successful orchestrator leaves: one commit in the run worktree under the run identity,
 * with each pinned ticket's branch `<run branch>-t<n>` at it, so verifying finds every ticket
 * merged from git (S8-8).
 */
async function commitDelivery(request: ImplementRequest): Promise<string> {
  await writeFile(join(request.worktreePath, DELIVERED_FILE), "delivered\n");
  const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
  execFileSync("git", ["add", DELIVERED_FILE], { cwd: request.worktreePath, env });
  execFileSync("git", ["commit", "-q", "-m", "Deliver"], { cwd: request.worktreePath, env });
  for (const ticket of request.tickets) {
    gitIn(request.worktreePath, ["branch", ticketBranch(request.branch, ticket.id)]);
  }
  return gitIn(request.worktreePath, ["rev-parse", "HEAD"]);
}

/** A pinned ticket's branch (D4). */
function ticketBranch(runBranch: string, ticket: string): string {
  return `${runBranch}-t${ticket.slice(1)}`;
}

function verdictFor(reviewedCommit: string, blocking: boolean): Verdict {
  return {
    reviewedCommit,
    summary: "The change matches the tickets.",
    findings: blocking
      ? [
          {
            axis: "spec",
            severity: "blocking",
            file: DELIVERED_FILE,
            title: "Criterion 2 is not met",
            detail: "Nothing survives a reload.",
            criterion: null,
          },
        ]
      : [],
  };
}

/**
 * Saves the (only) project's required checks and a repair limit of 0 (no repair), then starts a
 * run of the set (S8-3).
 */
async function startRun(ticketSetId: string, checks: readonly string[]): Promise<DeliveryRun> {
  return await startRunWithRepairs(ticketSetId, checks, 0);
}

/** Saves the (only) project's required checks and `repairLimit`, then starts a run of the set. */
async function startRunWithRepairs(
  ticketSetId: string,
  checks: readonly string[],
  repairLimit: number,
): Promise<DeliveryRun> {
  const [project] = await client.project.list();
  if (project === undefined) throw new Error("No project is stored");
  await client.project.saveSettings({
    projectId: project.id,
    baseBranch: project.baseBranch,
    requiredChecks: [...checks],
    repairLimit,
    fixCommands: [],
  });
  return await client.delivery.start({ ticketSetId });
}

/** The run with this id as `map.overview` reports it in spec 1's runs (S8-14). */
async function deliveryRun(mapId: string, runId: string): Promise<SpecRun> {
  const { specs } = await client.map.overview({ mapId });
  const run = firstSpecOf(specs).runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error(`map.overview has no run ${runId}`);
  }
  return run;
}

function firstSpecOf<T>(specs: readonly T[]): T {
  const [spec] = specs;
  if (spec === undefined) throw new Error("The map has no spec");
  return spec;
}

/** Polls `map.overview` until the run is in `state` with the stored `phase`. */
async function runIn(
  mapId: string,
  runId: string,
  state: DeliveryRun["state"],
  phase: DeliveryRun["phase"],
): Promise<SpecRun> {
  return await vi.waitFor(async () => {
    const run = await deliveryRun(mapId, runId);
    expect({ state: run.state, phase: run.phase }).toEqual({ state, phase });
    return run;
  }, DELIVERY_WAIT);
}

/**
 * Waits for the runner's cleanup after a run's end (D8): its worktree is gone and its last line,
 * ZeNorm's cleanup line, names the run branch it keeps. Returns the run's lines.
 */
async function cleanedUp(run: DeliveryRun): Promise<RunEvent[]> {
  return await vi.waitFor(async () => {
    expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
    const lines = await client.delivery.activity({ runId: run.id });
    expect(lines.at(-1)).toMatchObject({ who: "zenorm", ticket: null });
    expect(lines.at(-1)?.text).toContain(run.branch);
    return lines;
  }, DELIVERY_WAIT);
}

describe("delivery over /rpc", () => {
  test("a run goes preparing, implementing, verifying, reviewing, then passed with its evidence", async () => {
    const { project, mapId, specificationId, ticketSetId } = await approvedSet();
    const baseCommit = gitIn(project.folderPath, ["rev-parse", "main"]);
    const checks = [PASSING_CHECK, "sleep 0.5"];

    const started = await startRun(ticketSetId, checks);
    expect(started).toMatchObject({
      ticketSetId,
      number: 1,
      branch: `zenorm/dark-mode-${specificationId.slice(-8)}-run-1`,
      baseBranch: "main",
      baseCommit,
      checks,
      endedAt: null,
      mergedAt: null,
      state: "running",
      phase: "preparing",
    });
    expect(started).not.toHaveProperty("worktreePath");
    const worktreePath = join(root, "runs", started.id, "worktree");

    const implement = await nthCall(implementPort.calls, 0);
    expect((await deliveryRun(mapId, started.id)).phase).toBe("implementing");
    const running = await client.map.overview({ mapId });
    expect(running.status.stages[4]).toMatchObject({ stage: "delivery", tone: "working" });
    expect(running.status.group).toBe("working");
    const runDir = join(root, "runs", started.id);
    expect(implement.request).toEqual({
      runDir,
      worktreePath,
      branch: started.branch,
      baseCommit,
      specPath: join(runDir, "inputs", "spec.md"),
      ticketsPath: join(runDir, "inputs", "tickets.md"),
      ticketCount: TICKETS.tickets.length,
      tickets: TICKETS.tickets.map((ticket) => ({ id: ticket.id, title: ticket.title })),
      merged: [],
      resumedFrom: null,
      repair: null,
      checks,
      fixCommands: [],
      gitIdentity: { name: "ZeNorm delivery", email: `run-${started.id}@zenorm.invalid` },
    });
    expect(implement.signal.aborted).toBe(false);

    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    await runIn(mapId, started.id, "running", "verifying");
    const review = await nthCall(reviewPort.calls, 0);
    expect((await deliveryRun(mapId, started.id)).phase).toBe("reviewing");
    expect(review.request).toMatchObject({
      runDir,
      worktreePath,
      baseCommit,
      finalCommit,
      diffPath: join(runDir, "review.diff"),
      changedFiles: [DELIVERED_FILE],
    });
    expect(review.request.checkResults.map((result) => result.exitCode)).toEqual([0, 0]);

    const verdict = verdictFor(finalCommit, false);
    review.resolve({ ok: true, value: verdict });
    const passed = await runIn(mapId, started.id, "passed", "reviewing");
    await cleanedUp(started);
    const { status } = await client.map.overview({ mapId });
    // A passed, unmerged run awaits Mark merged (slice 8 D7, S8-6, L98).
    expect(status.stages[4]).toMatchObject({ stage: "delivery", tone: "needs-you" });
    expect(status.group).toBe("needs-you");
    expect(status.next[0]?.label).toBe("Mark merged");
    expect(passed).toMatchObject({ finalCommit, verdict, failure: null });
    expect(passed.endedAt).not.toBeNull();
    expect(passed.checkResults?.map((result) => result.command)).toEqual(checks);
    expect(gitIn(project.folderPath, ["rev-parse", started.branch])).toBe(finalCommit);
    expect(log).not.toHaveBeenCalled();
  });

  test("a blocking finding ends blocked; a verdict naming another commit is delivery_verdict_invalid", async () => {
    const { mapId, ticketSetId } = await approvedSet();

    const first = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement1 = await nthCall(implementPort.calls, 0);
    const final1 = await commitDelivery(implement1.request);
    implement1.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({ ok: true, value: verdictFor(final1, true) });
    const blocked = await runIn(mapId, first.id, "blocked", "reviewing");
    expect(blocked).toMatchObject({ finalCommit: final1, verdict: verdictFor(final1, true) });
    expect(blocked.checkResults).toHaveLength(1);
    await cleanedUp(first);

    const second = await startRun(ticketSetId, [PASSING_CHECK]);
    expect(second.number).toBe(2);
    const implement2 = await nthCall(implementPort.calls, 1);
    const final2 = await commitDelivery(implement2.request);
    implement2.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 1)).resolve({
      ok: true,
      value: verdictFor(second.baseCommit, false),
    });
    const failed = await runIn(mapId, second.id, "failed", "reviewing");
    expect(failed.failure).toMatchObject({ code: "delivery_verdict_invalid" });
    expect(failed).toMatchObject({ finalCommit: final2, verdict: null });
    expect(failed.checkResults).toHaveLength(1);
    // After a blocked and a failed end the worktrees and ticket branches are gone (S8-12).
    await cleanedUp(second);
    const [project] = await client.project.list();
    if (project === undefined) throw new Error("No project is stored");
    expect(ticketRefs(project.folderPath, first.branch)).toBe("");
    expect(ticketRefs(project.folderPath, second.branch)).toBe("");
    expect(gitIn(project.folderPath, ["rev-parse", second.branch])).toBe(final2);
    expect(log).not.toHaveBeenCalled();
  });

  test("no commits fails verifying before any check; a failing check is delivery_checks_failed", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const marker = join(root, "check-ran");

    const first = await startRun(ticketSetId, [`touch ${marker}`, PASSING_CHECK]);
    (await nthCall(implementPort.calls, 0)).resolve({ ok: true, value: null });
    const noCommits = await runIn(mapId, first.id, "failed", "verifying");
    expect(noCommits.failure).toMatchObject({ code: "delivery_no_commits" });
    expect(noCommits).toMatchObject({ finalCommit: null, checkResults: null });
    await cleanedUp(first);
    expect(existsSync(marker)).toBe(false);
    expect(reviewPort.calls).toHaveLength(0);

    const checks = [FAILING_CHECK, PASSING_CHECK];
    const second = await startRun(ticketSetId, checks);
    const implement = await nthCall(implementPort.calls, 1);
    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    const checksFailed = await runIn(mapId, second.id, "failed", "verifying");
    expect(checksFailed.failure).toMatchObject({ code: "delivery_checks_failed" });
    expect(checksFailed.failure?.message).toContain(FAILING_CHECK);
    expect(checksFailed.finalCommit).toBe(finalCommit);
    await cleanedUp(second);
    expect(checksFailed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
      [FAILING_CHECK, 128],
      [PASSING_CHECK, 0],
    ]);
    // A repair limit of 0: no repair attempt, so no second implement call (C2).
    expect(checksFailed).toMatchObject({ repairLimit: 0, repairAttempts: 0 });
    expect(implementPort.calls).toHaveLength(2);
    expect(reviewPort.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("an orchestrator code ends the run failed with that code in phase implementing", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    (await nthCall(implementPort.calls, 0)).resolve({
      ok: false,
      error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
    });

    const failed = await runIn(mapId, run.id, "failed", "implementing");
    expect(failed.failure).toEqual({
      code: "agent_not_logged_in",
      message: "Not logged in",
    });
    expect(failed).toMatchObject({ finalCommit: null, checkResults: null, verdict: null });
    await cleanedUp(run);
    expect(log).not.toHaveBeenCalled();
  });

  test("Cancel ends a running run at once and a late result writes nothing", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({
      id: run.id,
      state: "cancelled",
      phase: "implementing",
      failure: null,
      verdict: null,
      executor: "local",
    });
    expect(cancelled.endedAt).not.toBeNull();
    expect(implement.signal.aborted).toBe(true);
    // `"local"`'s wording is as before (CR9b-6).
    const texts = (await client.delivery.activity({ runId: run.id })).map((line) => line.text);
    expect(texts.filter((text) => text.endsWith(" Starting Claude Code."))).toHaveLength(1);
    expect(texts).toContain("You cancelled the run. The executor was sent SIGTERM.");

    implement.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    await vi.waitFor(async () => {
      expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    }, DELIVERY_WAIT);
    // Once the abort settles the runner removes the worktree and keeps the branch (S8-12).
    await vi.waitFor(() => {
      expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
    }, DELIVERY_WAIT);
    expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);

    const [again] = await safe(client.delivery.cancel({ runId: run.id }));
    expect(isDefinedError(again) && again.code).toBe("delivery_run_ended");
    expect(isDefinedError(again) && again.status).toBe(409);
    const [missing] = await safe(client.delivery.cancel({ runId: UNKNOWN_ID }));
    expect(isDefinedError(missing) && missing.code).toBe("delivery_run_not_found");
    expect(isDefinedError(missing) && missing.status).toBe(404);
    expect(reviewPort.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("Cancel returns the driver's stored end when it lands between the read and the cancel write", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const failure = { code: "agent_run_failed", message: "The agent's run failed" } as const;

    // The cancel's guarded end write is the next transaction: the driver waits on the port. Just
    // before it, the driver's own end lands (this database holds this one run).
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((cancelWrite, config) => {
      // Test data standing in for the driver's end, so `system` is acceptable here.
      write(db, { kind: "system" }, (tx) =>
        tx.update(deliveryRuns).set({ endedAt: new Date().toISOString(), failure }).run(),
      );
      return transaction(cancelWrite, config);
    });
    const answer = await client.delivery.cancel({ runId: run.id });

    expect(answer).toMatchObject({ id: run.id, state: "failed", phase: "implementing", failure });
    expect(await deliveryRun(mapId, run.id)).toMatchObject(answer);

    implement.resolve({
      ok: false,
      error: { code: "agent_run_failed", message: "x", data: { exitCode: 1, subtype: null } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await deliveryRun(mapId, run.id)).toMatchObject(answer);
    expect(log).not.toHaveBeenCalled();
  });

  test("delivery.start refuses an active, passed, unknown or unapproved ticket set", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    await startRun(ticketSetId, [PASSING_CHECK]);
    const [inProgress] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(inProgress) && inProgress.code).toBe("delivery_in_progress");
    expect(isDefinedError(inProgress) && inProgress.status).toBe(409);

    const implement = await nthCall(implementPort.calls, 0);
    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    const [first] = firstSpecOf((await client.map.overview({ mapId })).specs).runs;
    if (first === undefined) throw new Error("No run is stored");
    await runIn(mapId, first.id, "passed", "reviewing");
    const [alreadyPassed] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(alreadyPassed) && alreadyPassed.code).toBe("delivery_already_passed");
    expect(isDefinedError(alreadyPassed) && alreadyPassed.status).toBe(409);

    const [unknown] = await safe(client.delivery.start({ ticketSetId: UNKNOWN_ID }));
    expect(isDefinedError(unknown) && unknown.code).toBe("ticket_set_not_found");
    expect(isDefinedError(unknown) && unknown.status).toBe(404);

    // A second map whose ticket set is drafted but not approved.
    const [project] = await client.project.list();
    if (project === undefined) throw new Error("No project is stored");
    const map = { id: await clearedMapIn(project, "Light mode") };
    const specRevisionId = await reviewedSpec(map.id, 1);
    await client.spec.approve({ specRevisionId });
    (await nthCall(ticketSetPort.calls, 1)).resolve({ ok: true, value: TICKETS });
    (await nthCall(ticketsReviewPort.calls, 1)).resolve({ ok: true, value: TICKETS_PASSED });
    const written = await overviewWhen(
      map.id,
      (read) => firstSpec(read).ticketSets[0]?.state === "review_passed",
    );
    const [drafted] = firstSpec(written).ticketSets;
    if (drafted === undefined) throw new Error("No ticket set");
    const [notApproved] = await safe(client.delivery.start({ ticketSetId: drafted.id }));
    expect(isDefinedError(notApproved) && notApproved.code).toBe("ticket_set_not_approved");
    expect(isDefinedError(notApproved) && notApproved.status).toBe(409);
    expect(firstSpecOf((await client.map.overview({ mapId: map.id })).specs).runs).toEqual([]);
    expect(implementPort.calls).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  test("a throwing port is logged and stored as delivery_internal_error", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const thrown = new Error("boom");
    (await nthCall(implementPort.calls, 0)).reject(thrown);

    const failed = await runIn(mapId, run.id, "failed", "implementing");
    expect(failed.failure).toMatchObject({ code: "delivery_internal_error" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toBe(thrown);
  });

  test("a new app over the same database reads an active run as interrupted, and Cancel ends it", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);

    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    const { specs } = await restarted.map.overview({ mapId });
    expect(firstSpecOf(specs).runs).toMatchObject([
      { ...run, state: "interrupted", phase: "implementing" },
    ]);

    const cancelled = await restarted.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "implementing" });
    // The first app's run was never aborted; its late result loses to the guarded cancel.
    expect(implement.signal.aborted).toBe(false);
    implement.resolve({
      ok: false,
      error: {
        code: "agent_run_failed",
        message: "Exited 1",
        data: { exitCode: 1, subtype: null },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("project settings, Mark merged and run activity over /rpc (slice 8)", () => {
  test("project.saveSettings stores the branch, checks, repair limit and fix commands; refusals are coded", async () => {
    const project = await addProject();
    expect(project).toMatchObject({
      requiredChecks: [],
      repairLimit: null,
      fixCommands: [],
      startDeliveryBlockers: ["project_checks_missing", "project_repair_limit_missing"],
      activeRun: null,
    });
    const repair = { repairLimit: 1, fixCommands: ["pnpm format"] };
    const saved = await client.project.saveSettings({
      projectId: project.id,
      baseBranch: "main",
      requiredChecks: [PASSING_CHECK],
      ...repair,
    });
    expect(saved).toMatchObject({
      requiredChecks: [PASSING_CHECK],
      ...repair,
      startDeliveryBlockers: [],
    });
    expect(await client.project.get({ projectId: project.id })).toMatchObject({
      requiredChecks: [PASSING_CHECK],
      ...repair,
    });

    const [invalid] = await safe(
      client.project.saveSettings({
        projectId: project.id,
        baseBranch: "a..b",
        requiredChecks: [],
        ...repair,
      }),
    );
    expect(isDefinedError(invalid) && [invalid.code, invalid.status]).toEqual([
      "project_branch_invalid",
      422,
    ]);
    const [needsShell] = await safe(
      client.project.saveSettings({
        projectId: project.id,
        baseBranch: "main",
        requiredChecks: [PASSING_CHECK, "pnpm lint && pnpm test"],
        ...repair,
      }),
    );
    expect(
      isDefinedError(needsShell) && [needsShell.code, needsShell.status, needsShell.data],
    ).toEqual(["project_check_invalid", 422, { command: "pnpm lint && pnpm test" }]);
    const [fixNeedsShell] = await safe(
      client.project.saveSettings({
        projectId: project.id,
        baseBranch: "main",
        requiredChecks: [PASSING_CHECK],
        repairLimit: 3,
        fixCommands: ["pnpm format | tee log"],
      }),
    );
    expect(
      isDefinedError(fixNeedsShell) && [
        fixNeedsShell.code,
        fixNeedsShell.status,
        fixNeedsShell.data,
      ],
    ).toEqual(["project_fix_command_invalid", 422, { command: "pnpm format | tee log" }]);
    const [unknown] = await safe(
      client.project.saveSettings({
        projectId: UNKNOWN_ID,
        baseBranch: "main",
        requiredChecks: [],
        ...repair,
      }),
    );
    expect(isDefinedError(unknown) && [unknown.code, unknown.status]).toEqual([
      "project_not_found",
      404,
    ]);
    for (const input of [
      { requiredChecks: [PASSING_CHECK, PASSING_CHECK], ...repair },
      {
        requiredChecks: [PASSING_CHECK],
        repairLimit: 1,
        fixCommands: ["pnpm format", "pnpm format"],
      },
      {
        requiredChecks: [PASSING_CHECK],
        repairLimit: 1,
        fixCommands: Array.from({ length: 11 }, (_, index) => `fix ${String(index)}`),
      },
      { requiredChecks: [PASSING_CHECK], repairLimit: 11, fixCommands: [] },
    ]) {
      const [refused] = await safe(
        client.project.saveSettings({ projectId: project.id, baseBranch: "main", ...input }),
      );
      expect(refused instanceof ORPCError && refused.code).toBe("BAD_REQUEST");
    }
    expect(await client.project.get({ projectId: project.id })).toMatchObject({
      baseBranch: "main",
      requiredChecks: [PASSING_CHECK],
      ...repair,
    });
  });

  test("delivery.start refuses project_checks_missing, then project_repair_limit_missing; delivery_in_progress carries the project's active run", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const [noChecks] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(noChecks) && [noChecks.code, noChecks.status]).toEqual([
      "project_checks_missing",
      409,
    ]);
    // A save always carries a limit, so only a stored project (one from before repairs) has checks
    // and no limit. Test data, so `system` is acceptable here.
    write(db, { kind: "system" }, () => {
      db.$client
        .prepare("update projects set required_checks = ? where id = ?")
        .run(JSON.stringify([PASSING_CHECK]), project.id);
    });
    expect((await client.project.get({ projectId: project.id })).startDeliveryBlockers).toEqual([
      "project_repair_limit_missing",
    ]);
    const [noLimit] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(noLimit) && [noLimit.code, noLimit.status, noLimit.data]).toEqual([
      "project_repair_limit_missing",
      409,
      { projectId: project.id },
    ]);
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const active = { runId: run.id, mapId, specNumber: 1, specTitle: SPEC.title };
    expect((await client.project.get({ projectId: project.id })).activeRun).toEqual(active);
    const [inProgress] = await safe(client.delivery.start({ ticketSetId }));
    expect(isDefinedError(inProgress) && inProgress.code).toBe("delivery_in_progress");
    expect(isDefinedError(inProgress) && inProgress.data).toEqual(active);
    (await nthCall(implementPort.calls, 0)).resolve({
      ok: false,
      error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
    });
    await runIn(mapId, run.id, "failed", "implementing");
    expect((await client.project.get({ projectId: project.id })).activeRun).toBeNull();
  });

  test("delivery.markMerged is refused until git shows the final commit in main, then recorded once", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const [notPassed] = await safe(client.delivery.markMerged({ runId: run.id }));
    expect(isDefinedError(notPassed) && [notPassed.code, notPassed.status]).toEqual([
      "delivery_not_passed",
      409,
    ]);
    const implement = await nthCall(implementPort.calls, 0);
    const finalCommit = await commitDelivery(implement.request);
    implement.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);

    const [notMerged] = await safe(client.delivery.markMerged({ runId: run.id }));
    expect(isDefinedError(notMerged) && [notMerged.code, notMerged.status]).toEqual([
      "delivery_not_merged",
      409,
    ]);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Dev",
        "-c",
        "user.email=dev@example.invalid",
        "merge",
        "-q",
        "--no-ff",
      ].concat(["-m", "Merge the run", run.branch]),
      { cwd: project.folderPath },
    );
    const merged = await client.delivery.markMerged({ runId: run.id });
    expect(merged).toMatchObject({ id: run.id, state: "passed", finalCommit });
    expect(merged.mergedAt).not.toBeNull();
    expect((await deliveryRun(mapId, run.id)).mergedAt).toBe(merged.mergedAt);
    expect((await client.delivery.activity({ runId: run.id })).at(-1)).toMatchObject({
      who: "zenorm",
      ticket: null,
      text: `${finalCommit.slice(0, 7)} is in main. The tickets are recorded as delivered.`,
    });

    const [twice] = await safe(client.delivery.markMerged({ runId: run.id }));
    expect(isDefinedError(twice) && [twice.code, twice.status]).toEqual([
      "delivery_already_merged",
      409,
    ]);
    const [missing] = await safe(client.delivery.markMerged({ runId: UNKNOWN_ID }));
    expect(isDefinedError(missing) && [missing.code, missing.status]).toEqual([
      "delivery_run_not_found",
      404,
    ]);
    const [noRun] = await safe(client.delivery.activity({ runId: UNKNOWN_ID }));
    expect(isDefinedError(noRun) && [noRun.code, noRun.status]).toEqual([
      "delivery_run_not_found",
      404,
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("map.overview carries each pinned ticket's status for a run", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await nthCall(implementPort.calls, 0);
    const shown = await deliveryRun(mapId, run.id);
    expect(shown.tickets).toEqual(
      TICKETS.tickets.map((ticket) => ({
        ticket: ticket.id,
        status:
          ticket.blockedBy.length === 0
            ? { state: "starting" }
            : { state: "waiting", on: ticket.blockedBy },
        failing: [],
      })),
    );
    await client.delivery.cancel({ runId: run.id });
  });
});

/** The orchestrator port's event callback of a pending implement call. */
function eventsOf(call: PendingSession<ImplementRequest, null>): (event: ImplementEvent) => void {
  const { onEvent } = call;
  if (onEvent === undefined) throw new Error("The orchestrator port got no onEvent");
  return onEvent;
}

/**
 * What the orchestrator does for one ticket (D4): a commit on `<run branch>-t<n>` in its own
 * worktree `<runDir>/tickets/t<n>`, merged `--no-ff` into the run worktree when `merge` is true.
 * Returns the ticket branch's head.
 */
async function commitTicket(
  request: ImplementRequest,
  ticket: string,
  merge: boolean,
): Promise<string> {
  const branch = ticketBranch(request.branch, ticket);
  const worktree = join(request.runDir, "tickets", ticket.toLowerCase());
  const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, worktree, request.branch], {
    cwd: request.worktreePath,
  });
  await writeFile(join(worktree, `${ticket}.txt`), `${ticket}\n`);
  execFileSync("git", ["add", "."], { cwd: worktree, env });
  execFileSync("git", ["commit", "-q", "-m", ticket], { cwd: worktree, env });
  if (merge) {
    execFileSync("git", ["merge", "-q", "--no-ff", "-m", `Merge ${ticket}`, branch], {
      cwd: request.worktreePath,
      env,
    });
  }
  return gitIn(worktree, ["rev-parse", "HEAD"]);
}

/** The ticket branches of a run left in the project folder. */
function ticketRefs(folderPath: string, runBranch: string): string {
  return gitIn(folderPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${runBranch}-t*`]);
}

describe("the delivery runner's events, lines and cleanup (slice 8)", () => {
  test("events are stored as emitted, the merged commit is the ticket branch's head, checks are stored as they finish, and the passed run is cleaned up", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const checks = [PASSING_CHECK, "sleep 0.5"];
    const run = await startRun(ticketSetId, checks);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    const long = "x".repeat(600);

    emit({ kind: "line", who: "orchestrator", ticket: null, text: "Read the spec." });
    emit({ kind: "ticket_started", ticket: "T1" });
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Edited `src/a.ts`" });
    const head = await commitTicket(implement.request, "T1", true);
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Added the toggle." });
    emit({ kind: "line", who: "orchestrator", ticket: null, text: long });
    await vi.waitFor(async () => {
      expect((await deliveryRun(mapId, run.id)).tickets).toEqual([
        {
          ticket: "T1",
          status: { state: "merged", commit: head, summary: "Added the toggle." },
          failing: [],
        },
      ]);
    }, DELIVERY_WAIT);

    implement.resolve({ ok: true, value: null });
    // D5: the first check's result is stored while the second still runs.
    const verifying = await vi.waitFor(async () => {
      const read = await deliveryRun(mapId, run.id);
      expect(read.checkResults).toHaveLength(1);
      return read;
    }, DELIVERY_WAIT);
    expect(verifying).toMatchObject({ state: "running", phase: "verifying" });
    const finalCommit = gitIn(implement.request.worktreePath, ["rev-parse", "HEAD"]);
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    await runIn(mapId, run.id, "passed", "reviewing");

    const lines = await cleanedUp(run);
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
    expect(lines.map((line) => [line.who, line.ticket])).toEqual([
      ["zenorm", null], // started
      ["zenorm", null], // the pinned inputs
      ["orchestrator", null],
      ["implementer", "T1"],
      ["orchestrator", null],
      ["zenorm", null], // the executor's exit
      ["zenorm", null], // the merges verified
      ["zenorm", null], // check 1
      ["zenorm", null], // check 2
      ["reviewer", null], // its start
      ["reviewer", null], // its verdict
      ["zenorm", null], // cleanup
    ]);
    expect(lines.slice(2, 5).map((line) => line.text)).toEqual([
      "Read the spec.",
      "Edited `src/a.ts`",
      `${"x".repeat(499)}…`,
    ]);
    for (const line of lines) {
      expect(line.text.length).toBeLessThanOrEqual(500);
    }
    expect((await deliveryRun(mapId, run.id)).tickets).toMatchObject([
      { ticket: "T1", status: { state: "merged", commit: head } },
    ]);
    expect(existsSync(join(implement.request.runDir, "tickets", "t1"))).toBe(false);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["rev-parse", run.branch])).toBe(finalCommit);
    expect(existsSync(join(implement.request.runDir, "inputs", "spec.md"))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  test("a ticket left unmerged fails the run delivery_ticket_unmerged before any check (S8-8)", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const marker = join(root, "check-ran");
    const run = await startRun(ticketSetId, [`touch ${marker}`]);
    const implement = await nthCall(implementPort.calls, 0);
    eventsOf(implement)({ kind: "ticket_started", ticket: "T1" });
    await commitTicket(implement.request, "T1", false);
    await writeFile(join(implement.request.worktreePath, DELIVERED_FILE), "delivered\n");
    const env = { ...process.env, ...gitIdentityEnv(implement.request.gitIdentity) };
    execFileSync("git", ["add", DELIVERED_FILE], { cwd: implement.request.worktreePath, env });
    execFileSync("git", ["commit", "-q", "-m", "Deliver"], {
      cwd: implement.request.worktreePath,
      env,
    });
    implement.resolve({ ok: true, value: null });

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_ticket_unmerged" });
    expect(failed.tickets).toMatchObject([
      { ticket: "T1", status: { state: "not_delivered", started: true } },
    ]);
    const lines = await cleanedUp(run);
    expect(lines.at(-2)).toMatchObject({ who: "zenorm", ticket: null });
    expect(existsSync(marker)).toBe(false);
    expect(reviewPort.calls).toHaveLength(0);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);
    expect(log).not.toHaveBeenCalled();
  });

  test("a ticket branch deleted before its merge is recorded fails the run delivery_ticket_unmerged with a ZeNorm line (L197 item 10)", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    emit({ kind: "ticket_started", ticket: "T1" });
    await commitTicket(implement.request, "T1", true);
    const { worktreePath, runDir } = implement.request;
    execFileSync("git", ["worktree", "remove", "--force", join(runDir, "tickets", "t1")], {
      cwd: worktreePath,
    });
    execFileSync("git", ["branch", "-D", ticketBranch(run.branch, "T1")], { cwd: worktreePath });
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Merged and deleted." });
    await vi.waitFor(async () => {
      const lines = await client.delivery.activity({ runId: run.id });
      expect(lines.at(-1)).toMatchObject({ who: "zenorm", ticket: "T1" });
    }, DELIVERY_WAIT);
    implement.resolve({ ok: true, value: null });

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_ticket_unmerged" });
    expect(failed.tickets).toMatchObject([
      { ticket: "T1", status: { state: "not_delivered", started: true } },
    ]);
    await cleanedUp(run);
    expect(reviewPort.calls).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("an event after a cancel writes nothing; the cancelled run keeps its phase and is cleaned up once the abort settles", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    await commitTicket(implement.request, "T1", false);
    const before = await client.delivery.activity({ runId: run.id });

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "implementing" });
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Too late." });
    emit({ kind: "ticket_started", ticket: "T1" });
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Too late." });
    const afterCancel = await client.delivery.activity({ runId: run.id });
    expect(afterCancel.slice(0, before.length)).toEqual(before);
    expect(afterCancel.slice(before.length)).toMatchObject([{ who: "zenorm", ticket: null }]);
    // The abort has not settled: the worktrees stay until the session ends.
    expect(existsSync(implement.request.worktreePath)).toBe(true);

    implement.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    const lines = await cleanedUp(run);
    expect(lines).toHaveLength(afterCancel.length + 1);
    expect(await deliveryRun(mapId, run.id)).toMatchObject({
      state: "cancelled",
      phase: "implementing",
      tickets: [{ ticket: "T1", status: { state: "not_delivered", started: false } }],
    });
    expect(existsSync(join(implement.request.runDir, "tickets", "t1"))).toBe(false);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);
    expect(log).not.toHaveBeenCalled();
  });

  test("a shutdown aborts the active session and settles before the database closes; nothing is written after, and the restarted app reads the run interrupted (L197 item 12)", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    const emit = eventsOf(implement);
    emit({ kind: "ticket_started", ticket: "T1" });
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Edited `a.ts`" });
    await vi.waitFor(async () => {
      expect((await client.delivery.activity({ runId: run.id })).at(-1)?.ticket).toBe("T1");
    }, DELIVERY_WAIT);
    const before = await client.delivery.activity({ runId: run.id });

    let stopped = false;
    const stopping = app.stopDeliveryRuns().then(() => {
      stopped = true;
    });
    expect(implement.signal.aborted).toBe(true);
    // The session has not exited yet, so the database must stay open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    implement.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    await stopping;
    db.$client.close();

    // A late event after the close writes nothing and throws nothing.
    emit({ kind: "line", who: "implementer", ticket: "T1", text: "Too late." });
    emit({ kind: "ticket_merged", ticket: "T1", summary: "Too late." });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log).not.toHaveBeenCalled();

    const reopened = openDatabase(join(root, "zenorm.sqlite"));
    if (!reopened.ok) throw new Error(reopened.error.message);
    db = reopened.value;
    installChangeFeed(db);
    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    expect(await restarted.delivery.activity({ runId: run.id })).toEqual(before);
    const { specs } = await restarted.map.overview({ mapId });
    expect(firstSpecOf(specs).runs).toMatchObject([
      { id: run.id, state: "interrupted", phase: "implementing", endedAt: null },
    ]);
    // No cleanup ran: the worktrees stay for the interrupted run's Cancel.
    expect(existsSync(implement.request.worktreePath)).toBe(true);
    expect(await restarted.delivery.cancel({ runId: run.id })).toMatchObject({
      state: "cancelled",
    });
    await vi.waitFor(() => {
      expect(existsSync(implement.request.worktreePath)).toBe(false);
    }, DELIVERY_WAIT);
    expect(log).not.toHaveBeenCalled();
  });

  test("Cancel of an interrupted run cleans it up; a run from before 0010 gets its end and no line", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const implement = await nthCall(implementPort.calls, 0);
    await commitTicket(implement.request, "T1", true);

    const restarted = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    const cancelled = await restarted.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "implementing" });
    // The cancel handler cleaned up before answering.
    expect(existsSync(implement.request.worktreePath)).toBe(false);
    expect(existsSync(join(implement.request.runDir, "tickets", "t1"))).toBe(false);
    expect(ticketRefs(project.folderPath, run.branch)).toBe("");
    expect(gitIn(project.folderPath, ["branch", "--list", run.branch])).toContain(run.branch);
    const lines = await client.delivery.activity({ runId: run.id });
    expect(lines.slice(-2)).toMatchObject([
      { who: "zenorm", ticket: null }, // the cancel
      { who: "zenorm", ticket: null }, // the cleanup
    ]);

    // A pre-`0010`-shaped run: no ticket rows and no lines.
    const second = await startRun(ticketSetId, [PASSING_CHECK]);
    await nthCall(implementPort.calls, 1);
    // Test data, so `system` is acceptable here.
    write(db, { kind: "system" }, () => {
      db.$client.prepare("DELETE FROM delivery_run_tickets WHERE run_id = ?").run(second.id);
      db.$client.prepare("DELETE FROM delivery_run_events WHERE run_id = ?").run(second.id);
    });
    const again = clientOf(
      await appOf({ db, bus: createChangeBus(log), webDistDir, log, ...planningPorts() }),
    );
    const old = await again.delivery.cancel({ runId: second.id });
    expect(old).toMatchObject({ state: "cancelled", phase: "implementing" });
    expect(await client.delivery.activity({ runId: second.id })).toEqual([]);
    expect(existsSync(join(root, "runs", second.id, "worktree"))).toBe(true);
    expect((await deliveryRun(mapId, second.id)).endedAt).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});

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

describe("waits released across maps over /rpc (slice 8b S8b-6, tickets review B1)", () => {
  const WAIT_NOTE = "Add a CSV option.";
  const WAITS: DraftSpecsOutcome = { specs: [], waits: [{ specNumber: 1, note: WAIT_NOTE }] };

  /** The waiting map's waits, read from the database (a wait-only map's overview is S8b-05's). */
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

/**
 * A stand-in delivery executor that is not `"local"` and runs no agent (S9-22, D18): per pinned
 * ticket it commits on the ticket branch `<run branch>-t<n>`, merges that branch into the run
 * branch in `worktreePath` with `--no-ff`, then emits `ticket_merged`. Its reviewer passes.
 */
function standInExecutor(calls: string[]): DeliveryExecutor {
  return {
    name: "stand-in",
    implementTicketSet: (request, _signal, onEvent) => {
      calls.push("implement");
      const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
      const git = (args: readonly string[]) =>
        execFileSync("git", args, { cwd: request.worktreePath, env, encoding: "utf8" });
      onEvent({ kind: "line", who: "orchestrator", ticket: null, text: "Stand-in executor." });
      for (const ticket of request.tickets) {
        onEvent({ kind: "ticket_started", ticket: ticket.id });
        const branch = ticketBranchName(request.branch, ticket.id);
        git(["checkout", "-q", "-b", branch]);
        git(["commit", "-q", "--allow-empty", "-m", `Ticket ${ticket.id}`]);
        git(["checkout", "-q", request.branch]);
        git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch]);
        onEvent({ kind: "ticket_merged", ticket: ticket.id, summary: `${ticket.id} done.` });
      }
      return Promise.resolve(ok(null));
    },
    reviewDelivery: (request) => {
      calls.push("review");
      return Promise.resolve(ok(verdictFor(request.finalCommit, false)));
    },
    writePullRequest: () => {
      calls.push("pull request");
      return Promise.resolve(ok(PULL_REQUEST_BODY));
    },
  };
}

/** Swaps the test's app for one whose delivery runs through `executor` (registered beside local). */
async function useExecutor(executor: DeliveryExecutor): Promise<void> {
  app = await appOf({
    db,
    bus: createChangeBus(log),
    webDistDir,
    log,
    ...planningPorts(),
    plugins: checked([], [localExecutor(), executor], executor.name),
  });
  client = clientOf(app);
}

describe("delivery executors (S9-22, D18)", () => {
  test("a resumed run starts from the failed run's branch, keeps its merged tickets and passes", async () => {
    // The first run merges every ticket, then its session is cut off: the case resume exists for.
    const requests: ImplementRequest[] = [];
    await useExecutor({
      name: "fails-after-t1",
      implementTicketSet: (request, _signal, onEvent) => {
        requests.push(request);
        const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
        const git = (args: readonly string[]) =>
          execFileSync("git", args, { cwd: request.worktreePath, env, encoding: "utf8" });
        for (const ticket of request.tickets) {
          if (request.merged.includes(ticket.id)) continue;
          onEvent({ kind: "ticket_started", ticket: ticket.id });
          const branch = ticketBranchName(request.branch, ticket.id);
          git(["checkout", "-q", "-b", branch]);
          git(["commit", "-q", "--allow-empty", "-m", `Ticket ${ticket.id}`]);
          git(["checkout", "-q", request.branch]);
          git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch]);
          onEvent({ kind: "ticket_merged", ticket: ticket.id, summary: `${ticket.id} done.` });
          if (requests.length === 1) {
            return Promise.resolve(
              err({
                code: "agent_not_logged_in",
                message: "The Claude Code CLI lost its login during the session.",
                data: {},
              }),
            );
          }
        }
        return Promise.resolve(ok(null));
      },
      reviewDelivery: (request) => Promise.resolve(ok(verdictFor(request.finalCommit, false))),
      writePullRequest: () => Promise.resolve(ok(PULL_REQUEST_BODY)),
    });
    const { project, mapId, ticketSetId } = await approvedSet();
    const [first] = TICKETS.tickets.map((ticket) => ticket.id);
    if (first === undefined) throw new Error("The set has no ticket");

    const failedRun = await startRun(ticketSetId, [PASSING_CHECK]);
    await runIn(mapId, failedRun.id, "failed", "implementing");
    await cleanedUp(failedRun);
    const head = gitIn(project.folderPath, ["rev-parse", failedRun.branch]);

    const resumed = await client.delivery.resume({ runId: failedRun.id });
    expect(resumed).toMatchObject({ number: 2, baseCommit: failedRun.baseCommit });
    const passed = await runIn(mapId, resumed.id, "passed", "reviewing");

    expect(requests[0]?.resumedFrom).toBeNull();
    expect(requests[1]?.merged).toEqual([first]);
    expect(requests[1]?.resumedFrom).toMatchObject({
      number: 1,
      failure: { code: "agent_not_logged_in" },
      failedChecks: [],
      blockingFindings: [],
    });
    expect(passed.tickets?.every((ticket) => ticket.status.state === "merged")).toBe(true);
    // The resumed branch grew from the failed run's head and holds each ticket's commit once.
    expect(gitIn(project.folderPath, ["merge-base", "--is-ancestor", head, resumed.branch])).toBe(
      "",
    );
    const subjects = gitIn(project.folderPath, ["log", "--format=%s", resumed.branch]).split("\n");
    expect(subjects.filter((subject) => subject === `Ticket ${first}`)).toHaveLength(1);

    const [notResumable] = await safe(client.delivery.resume({ runId: resumed.id }));
    expect(isDefinedError(notResumable) && notResumable.code).toBe("delivery_run_not_resumable");
  });

  test("a run through a stand-in executor ends passed, verified from git, with its worktrees removed", async () => {
    const calls: string[] = [];
    await useExecutor(standInExecutor(calls));
    const { project, mapId, ticketSetId } = await approvedSet();

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "reviewing");

    expect(calls).toEqual(["implement", "review"]);
    expect(implementPort.calls).toHaveLength(0);
    const { tickets } = passed;
    if (tickets === null) throw new Error("The passed run lists no tickets");
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((ticket) => ticket.status.state === "merged")).toBe(true);
    // The run branch holds each ticket's commit, merged in (the cleanup then removes the ticket
    // branches, as for "local").
    const subjects = gitIn(project.folderPath, ["log", "--format=%s", run.branch]).split("\n");
    for (const { ticket } of tickets) {
      expect(subjects).toContain(`Ticket ${ticket}`);
      expect(subjects).toContain(`Merge ${ticketBranchName(run.branch, ticket)}`);
    }
    await cleanedUp(run);
    expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
  });

  test("stop awaits an executor that ignores the abort at most 15 s, logs it and leaves the run running", async () => {
    let implementing: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      implementing = resolve;
    });
    await useExecutor({
      name: "deaf",
      implementTicketSet: () => {
        implementing();
        return new Promise(() => undefined);
      },
      reviewDelivery: () => new Promise(() => undefined),
      writePullRequest: () => new Promise(() => undefined),
    });
    const { ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await reached;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopping = app.stopDeliveryRuns();
      await vi.advanceTimersByTimeAsync(EXECUTOR_STOP_BOUND_MS);
      await stopping;
    } finally {
      vi.useRealTimers();
    }

    expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`"deaf".*${run.id}`)), null);
    const [stored] = db.select().from(deliveryRuns).all();
    expect(stored).toMatchObject({ id: run.id, endedAt: null, phase: "implementing" });
  });
});

/** The file a repair commits; `REPAIRED_CHECK` fails until it is in the run branch. */
const REPAIR_FILE = "repaired.txt";
const REPAIRED_CHECK = `git ls-files --error-unmatch ${REPAIR_FILE}`;

/** A commit of `file` in the run worktree under the run identity, as a repair makes; its id. */
async function commitRepair(request: ImplementRequest, file: string): Promise<string> {
  await writeFile(join(request.worktreePath, file), `${file}\n`);
  const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
  execFileSync("git", ["add", file], { cwd: request.worktreePath, env });
  execFileSync("git", ["commit", "-q", "-m", `Repair with ${file}`], {
    cwd: request.worktreePath,
    env,
  });
  return gitIn(request.worktreePath, ["rev-parse", "HEAD"]);
}

/** The run's activity texts. */
async function activityTexts(runId: string): Promise<string[]> {
  return (await client.delivery.activity({ runId })).map((line) => line.text);
}

/**
 * A stand-in for the `example` executor's repair (C2): a first call merges every ticket as
 * `standInExecutor` does; given `repair`, it merges nothing and commits `repair-<attempt>.txt` on
 * the run branch. Records every request.
 */
function repairingExecutor(requests: ImplementRequest[]): DeliveryExecutor {
  const tickets = standInExecutor([]);
  return {
    name: "repairing",
    implementTicketSet: async (request, signal, onEvent) => {
      requests.push(request);
      if (request.repair === null) {
        return await tickets.implementTicketSet(request, signal, onEvent);
      }
      onEvent({ kind: "line", who: "orchestrator", ticket: null, text: "Repairing." });
      await commitRepair(request, `repair-${String(request.repair.attempt)}.txt`);
      return ok(null);
    },
    reviewDelivery: (request) => Promise.resolve(ok(verdictFor(request.finalCommit, false))),
    writePullRequest: () => Promise.resolve(ok(PULL_REQUEST_BODY)),
  };
}

describe("repairs of failing checks (C2, C3)", () => {
  test("a check failing until a repair commit passes after one attempt, the run implementing during it with its pinned limit", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [PASSING_CHECK, REPAIRED_CHECK], 2);
    expect(run).toMatchObject({ repairLimit: 2, repairAttempts: 0 });
    const runDir = join(root, "runs", run.id);

    const first = await nthCall(implementPort.calls, 0);
    expect(first.request.repair).toBeNull();
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });

    const repair = await nthCall(implementPort.calls, 1);
    expect(repair.request).toMatchObject({
      merged: TICKETS.tickets.map((ticket) => ticket.id),
      resumedFrom: null,
      repair: {
        attempt: 1,
        limit: 2,
        failedChecks: [
          {
            result: { command: REPAIRED_CHECK, exitCode: 1, timedOut: false },
            logPath: join(runDir, "checks", "check-2.log"),
          },
        ],
      },
    });
    expect(repair.request.repair?.failedChecks[0]?.result.outputTail).toContain(REPAIR_FILE);
    // During the attempt the run is implementing, its attempt counted against its pinned limit,
    // which a settings change does not move (3.1).
    expect(await deliveryRun(mapId, run.id)).toMatchObject({
      state: "running",
      phase: "implementing",
      repairLimit: 2,
      repairAttempts: 1,
    });
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK],
      repairLimit: 5,
      fixCommands: [],
    });
    expect((await deliveryRun(mapId, run.id)).repairLimit).toBe(2);

    const finalCommit = await commitRepair(repair.request, REPAIR_FILE);
    repair.resolve({ ok: true, value: null });
    const review = await nthCall(reviewPort.calls, 0);
    expect(review.request.finalCommit).toBe(finalCommit);
    expect(review.request.checkResults.map((result) => result.exitCode)).toEqual([0, 0]);
    review.resolve({ ok: true, value: verdictFor(finalCommit, false) });

    const passed = await runIn(mapId, run.id, "passed", "reviewing");
    expect(passed).toMatchObject({ finalCommit, repairLimit: 2, repairAttempts: 1 });
    expect(passed.checkResults?.map((result) => result.exitCode)).toEqual([0, 0]);
    await cleanedUp(run);
    const attempts = (await activityTexts(run.id)).filter((text) =>
      text.startsWith("Repair attempt "),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/^Repair attempt 1 of 2: /);
    expect(attempts[0]).toContain(REPAIRED_CHECK);
    expect(implementPort.calls).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test("a check that keeps failing ends delivery_checks_failed once the limit is spent, each attempt given the output and log paths", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [REPAIRED_CHECK, PASSING_CHECK], 2);
    const runDir = join(root, "runs", run.id);

    const first = await nthCall(implementPort.calls, 0);
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    for (const attempt of [1, 2]) {
      const call = await nthCall(implementPort.calls, attempt);
      expect(call.request.repair).toMatchObject({
        attempt,
        limit: 2,
        failedChecks: [
          {
            result: { command: REPAIRED_CHECK, exitCode: 1 },
            logPath: join(runDir, "checks", "check-1.log"),
          },
        ],
      });
      expect(call.request.repair?.failedChecks[0]?.result.outputTail).toContain(REPAIR_FILE);
      await commitRepair(call.request, `attempt-${String(attempt)}.txt`);
      call.resolve({ ok: true, value: null });
    }

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_checks_failed" });
    expect(failed.checkResults?.map((result) => [result.command, result.exitCode])).toEqual([
      [REPAIRED_CHECK, 1],
      [PASSING_CHECK, 0],
    ]);
    expect(failed).toMatchObject({ repairLimit: 2, repairAttempts: 2 });
    await cleanedUp(run);
    expect(implementPort.calls).toHaveLength(3);
    expect(reviewPort.calls).toHaveLength(0);
    const attempts = (await activityTexts(run.id)).filter((text) =>
      text.startsWith("Repair attempt "),
    );
    expect(attempts.map((text) => text.slice(0, "Repair attempt 1 of 2".length))).toEqual([
      "Repair attempt 1 of 2",
      "Repair attempt 2 of 2",
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  test("a repair that adds no commit ends delivery_no_commits without rerunning the checks", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 3);

    const first = await nthCall(implementPort.calls, 0);
    const firstFinal = await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    (await nthCall(implementPort.calls, 1)).resolve({ ok: true, value: null });

    const failed = await runIn(mapId, run.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_no_commits" });
    expect(failed).toMatchObject({ finalCommit: firstFinal, repairAttempts: 1 });
    await cleanedUp(run);
    const checkLines = (await activityTexts(run.id)).filter((text) =>
      text.startsWith(`\`${FAILING_CHECK}\``),
    );
    expect(checkLines).toHaveLength(1);
    expect(implementPort.calls).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test("a dirty worktree or a failed session during a repair ends the run with that code, not another attempt", async () => {
    const { mapId, ticketSetId } = await approvedSet();

    const dirty = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 3);
    const first = await nthCall(implementPort.calls, 0);
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    const dirtyRepair = await nthCall(implementPort.calls, 1);
    await commitRepair(dirtyRepair.request, "fix.txt");
    await writeFile(join(dirtyRepair.request.worktreePath, "stray.txt"), "stray\n");
    dirtyRepair.resolve({ ok: true, value: null });
    const dirtyEnd = await runIn(mapId, dirty.id, "failed", "verifying");
    expect(dirtyEnd.failure).toMatchObject({ code: "delivery_worktree_dirty" });
    expect(dirtyEnd.repairAttempts).toBe(1);
    await cleanedUp(dirty);

    const session = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 3);
    const second = await nthCall(implementPort.calls, 2);
    await commitDelivery(second.request);
    second.resolve({ ok: true, value: null });
    (await nthCall(implementPort.calls, 3)).resolve({
      ok: false,
      error: {
        code: "agent_run_failed",
        message: "Exited 1",
        data: { exitCode: 1, subtype: null },
      },
    });
    const sessionEnd = await runIn(mapId, session.id, "failed", "implementing");
    expect(sessionEnd.failure).toMatchObject({ code: "agent_run_failed" });
    expect(sessionEnd.repairAttempts).toBe(1);
    await cleanedUp(session);
    expect(implementPort.calls).toHaveLength(4);
    expect(log).not.toHaveBeenCalled();
  });

  test("a cancel during a repair attempt reads as cancelled while implementing", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRunWithRepairs(ticketSetId, [FAILING_CHECK], 1);
    const first = await nthCall(implementPort.calls, 0);
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    const repair = await nthCall(implementPort.calls, 1);
    await runIn(mapId, run.id, "running", "implementing");

    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({
      state: "cancelled",
      phase: "implementing",
      repairAttempts: 1,
    });
    expect(repair.signal.aborted).toBe(true);
    expect(await activityTexts(run.id)).toContain(
      "You cancelled the run. The executor was sent SIGTERM.",
    );
    repair.resolve({
      ok: false,
      error: { code: "agent_cancelled", message: "Cancelled", data: {} },
    });
    await vi.waitFor(() => {
      expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
    }, DELIVERY_WAIT);
    expect(await deliveryRun(mapId, run.id)).toMatchObject(cancelled);
    expect(log).not.toHaveBeenCalled();
  });

  test("through an executor that is not local: a repair commit passes the run, and a spent limit fails it", async () => {
    const requests: ImplementRequest[] = [];
    await useExecutor(repairingExecutor(requests));
    const { mapId, ticketSetId } = await approvedSet();

    const repaired = await startRunWithRepairs(
      ticketSetId,
      [PASSING_CHECK, "git ls-files --error-unmatch repair-1.txt"],
      1,
    );
    const passed = await runIn(mapId, repaired.id, "passed", "reviewing");
    expect(passed).toMatchObject({ repairLimit: 1, repairAttempts: 1 });
    expect(requests.map((request) => request.repair?.attempt)).toEqual([undefined, 1]);
    expect(requests[1]?.merged).toEqual(TICKETS.tickets.map((ticket) => ticket.id));
    await cleanedUp(repaired);

    // A second map's set, whose check looks for a file no attempt within the limit commits.
    const [project] = await client.project.list();
    if (project === undefined) throw new Error("No project is stored");
    const other = await clearedMapIn(project, "Light mode");
    const specRevisionId = await reviewedSpec(other, 1);
    await client.spec.approve({ specRevisionId });
    (await nthCall(ticketSetPort.calls, 1)).resolve({ ok: true, value: TICKETS });
    (await nthCall(ticketsReviewPort.calls, 1)).resolve({ ok: true, value: TICKETS_PASSED });
    const written = await overviewWhen(
      other,
      (read) => firstSpec(read).ticketSets[0]?.state === "review_passed",
    );
    const [set] = firstSpec(written).ticketSets;
    if (set === undefined) throw new Error("No ticket set");
    await client.ticketSet.approve({ ticketSetId: set.id });
    const spent = await startRunWithRepairs(
      set.id,
      ["git ls-files --error-unmatch repair-3.txt"],
      2,
    );
    const failed = await runIn(other, spent.id, "failed", "verifying");
    expect(failed.failure).toMatchObject({ code: "delivery_checks_failed" });
    expect(failed).toMatchObject({ repairLimit: 2, repairAttempts: 2 });
    const spentRequests = requests.slice(2);
    expect(spentRequests.map((request) => request.repair?.attempt)).toEqual([undefined, 1, 2]);
    for (const request of spentRequests.slice(1)) {
      expect(
        request.repair?.failedChecks.map(({ result, logPath }) => [result.exitCode, logPath]),
      ).toEqual([[1, join(root, "runs", spent.id, "checks", "check-1.log")]]);
      expect(request.repair?.failedChecks[0]?.result.outputTail).toContain("repair-3.txt");
    }
    await cleanedUp(spent);
  });
});

describe("fix commands on the implement calls (C4)", () => {
  test("the first call and each repair carry the run's pinned fix commands, unmoved by a settings change mid-run", async () => {
    const { project, mapId, ticketSetId } = await approvedSet();
    const fixCommands = ["pnpm format", "pnpm lint --fix"];
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK, REPAIRED_CHECK],
      repairLimit: 1,
      fixCommands,
    });
    const run = await client.delivery.start({ ticketSetId });

    const first = await nthCall(implementPort.calls, 0);
    expect(first.request.fixCommands).toEqual(fixCommands);
    await client.project.saveSettings({
      projectId: project.id,
      baseBranch: project.baseBranch,
      requiredChecks: [PASSING_CHECK, REPAIRED_CHECK],
      repairLimit: 1,
      fixCommands: ["pnpm prettier --write ."],
    });
    await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });

    const repair = await nthCall(implementPort.calls, 1);
    expect(repair.request.repair).toMatchObject({ attempt: 1, limit: 1 });
    expect(repair.request.fixCommands).toEqual(fixCommands);
    const finalCommit = await commitRepair(repair.request, REPAIR_FILE);
    repair.resolve({ ok: true, value: null });
    const review = await nthCall(reviewPort.calls, 0);
    review.resolve({ ok: true, value: verdictFor(finalCommit, false) });

    await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);
    expect(implementPort.calls).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test("a run of a project with no fix commands gives the executor none", async () => {
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);

    const first = await nthCall(implementPort.calls, 0);
    expect(first.request.fixCommands).toEqual([]);
    const finalCommit = await commitDelivery(first.request);
    first.resolve({ ok: true, value: null });
    (await nthCall(reviewPort.calls, 0)).resolve({
      ok: true,
      value: verdictFor(finalCommit, false),
    });
    await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);
  });
});

describe("a person's Cancel of a deaf executor (CR9b-12)", () => {
  test("the runner waits 15 s, logs, cleans up and lets go; a later event is ignored with a line", async () => {
    const executor: { onEvent: ((event: ImplementEvent) => void) | null } = { onEvent: null };
    await useExecutor({
      name: "deaf",
      implementTicketSet: (_request, _signal, onEvent) => {
        executor.onEvent = onEvent;
        return new Promise(() => undefined);
      },
      reviewDelivery: () => new Promise(() => undefined),
      writePullRequest: () => new Promise(() => undefined),
    });
    const { mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await vi.waitFor(() => {
      expect(executor.onEvent).not.toBeNull();
    }, DELIVERY_WAIT);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cancelled = await client.delivery.cancel({ runId: run.id });
      expect(cancelled.state).toBe("cancelled");
      await vi.advanceTimersByTimeAsync(EXECUTOR_STOP_BOUND_MS);
    } finally {
      vi.useRealTimers();
    }

    expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`"deaf".*${run.id}`)), null);
    const lines = await cleanedUp(run);
    // Off `"local"` the cancel line names no signal (CR9b-6).
    expect(lines.map((line) => line.text)).toContain(
      "You cancelled the run. The executor was told to stop.",
    );
    expect((await runIn(mapId, run.id, "cancelled", "implementing")).id).toBe(run.id);
    const { onEvent } = executor;
    if (onEvent === null) throw new Error("The deaf executor was not called");
    onEvent({ kind: "line", who: "orchestrator", ticket: null, text: "Still working." });
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining(run.id), null);
    expect(await client.delivery.activity({ runId: run.id })).toEqual(lines);
  });
});

/**
 * A plugin whose checkout gives a clone of the stored folder, made on its first call (CR9b-3): a
 * fetched mirror, say. `clone` is where it is.
 */
function clonePlugin(clone: string): ServerPlugin {
  return definePlugin({
    id: "clone",
    version: "1.0.0",
    sdk: `^${SDK_VERSION}`,
    seams: () => ({
      checkout: (next) => async (project) => {
        const stored = await next(project);
        if (!stored.ok) return stored;
        if (!existsSync(clone)) {
          execFileSync("git", ["clone", "-q", stored.value, clone]);
        }
        return ok(clone);
      },
    }),
  });
}

/** The worktree paths `git worktree list` gives in `folder`, the main one first. */
function worktreesOf(folder: string): string[] {
  return gitIn(folder, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** True when `ref` names a commit or branch in `folder`. */
function hasRef(folder: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: folder,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("one folder per run, from the checkout seam (CR9b-3)", () => {
  test("a checkout that gives a clone gets a coherent run: worktree, merges, verifying, cleanup and Mark merged in the clone", async () => {
    const clone = join(await realpath(root), "clone");
    const calls: string[] = [];
    app = await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked([clonePlugin(clone)], [localExecutor(), standInExecutor(calls)], "stand-in"),
    });
    client = clientOf(app);
    const { project, mapId, ticketSetId } = await approvedSet();
    // The planning runs worked in the clone too: the survey was asked of it.
    expect(surveyRequests.map((request) => request.projectFolder)).toEqual([clone]);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    expect(run.executor).toBe("stand-in");
    const passed = await runIn(mapId, run.id, "passed", "reviewing");
    const lines = await cleanedUp(run);

    // The run branch and every ticket's merge are the clone's; the stored folder has none.
    expect(hasRef(clone, `refs/heads/${run.branch}`)).toBe(true);
    expect(hasRef(project.folderPath, `refs/heads/${run.branch}`)).toBe(false);
    const { tickets } = passed;
    if (tickets === null) throw new Error("The passed run lists no tickets");
    for (const { status } of tickets) {
      if (status.state !== "merged") throw new Error(`A ticket is ${status.state}`);
      expect(hasRef(clone, status.commit)).toBe(true);
      expect(hasRef(project.folderPath, status.commit)).toBe(false);
    }
    // Cleanup ran in the clone: no worktree or ticket branch is left, and no step failed.
    expect(worktreesOf(clone)).toEqual([clone]);
    expect(worktreesOf(project.folderPath)).toEqual([project.folderPath]);
    expect(gitIn(clone, ["for-each-ref", `refs/heads/${run.branch}-t*`])).toBe("");
    const texts = lines.map((line) => line.text);
    expect(texts.filter((text) => /could not/i.test(text))).toEqual([]);
    // The executor-neutral words (CR9b-6).
    expect(
      texts.filter((text) => text.endsWith(' Starting the executor "stand-in".')),
    ).toHaveLength(1);
    expect(texts.filter((text) => text.includes("Claude Code"))).toEqual([]);

    // Mark merged reads the clone: the final commit is in its main, not the stored folder's.
    gitIn(clone, ["merge", "-q", "--no-ff", "-m", "Merge the run", run.branch]);
    const merged = await client.delivery.markMerged({ runId: run.id });
    expect(merged.mergedAt).not.toBeNull();
    expect(hasRef(project.folderPath, run.branch)).toBe(false);
  });

  test("after a restart, Cancel resolves the folder again through the checkout and cleans up in the clone", async () => {
    const clone = join(await realpath(root), "clone");
    let implementing: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      implementing = resolve;
    });
    const hanging: DeliveryExecutor = {
      name: "hanging",
      implementTicketSet: () => {
        implementing();
        return new Promise(() => undefined);
      },
      reviewDelivery: () => new Promise(() => undefined),
      writePullRequest: () => new Promise(() => undefined),
    };
    const options = (): AppOptions => ({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked([clonePlugin(clone)], [localExecutor(), hanging], "hanging"),
    });
    app = await appOf(options());
    client = clientOf(app);
    const { project, mapId, ticketSetId } = await approvedSet();
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await reached;
    const worktree = join(root, "runs", run.id, "worktree");
    expect(worktreesOf(clone)).toContain(await realpath(worktree));
    expect(worktreesOf(project.folderPath)).toEqual([project.folderPath]);

    // A restarted app holds no run: the run reads interrupted, and its Cancel cleans it up.
    const restarted = clientOf(await appOf(options()));
    await vi.waitFor(async () => {
      const { specs } = await restarted.map.overview({ mapId });
      expect(firstSpecOf(specs).runs[0]?.state).toBe("interrupted");
    }, DELIVERY_WAIT);
    expect((await restarted.delivery.cancel({ runId: run.id })).state).toBe("cancelled");

    expect(existsSync(worktree)).toBe(false);
    expect(worktreesOf(clone)).toEqual([clone]);
    const lines = await restarted.delivery.activity({ runId: run.id });
    expect(lines.at(-1)?.text).toBe(
      `The worktrees were deleted. The branch ${run.branch} is kept.`,
    );
    expect(lines.map((line) => line.text).filter((text) => /could not/i.test(text))).toEqual([]);
  });
});

describe("createApp's database (CR9b-10)", () => {
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

/** The github.com repository a stand-in project's origin names. */
const GITHUB_URL = "https://github.com/acme/numbers.git";
/** The URL the fake gh gives the first pull request it opens on that repository. */
const GITHUB_PR_URL = "https://github.com/acme/numbers/pull/1";

/**
 * A stand-in for the GitHub CLI, written first on the server process's `PATH` (2.4). Every call
 * appends its arguments as one line to `<state>/calls`. `gh auth status` succeeds, fails while
 * `<state>/signed-out` exists, and hangs while `<state>/hang` exists. `gh pr create` fails while
 * `<state>/pr-fails` exists; otherwise it copies its `--body-file` to `<state>/body`, numbers the
 * pull request from 1 and prints its URL on its `--repo`, then hangs while `<state>/hold-after-open`
 * exists. `gh pr view <url> --json state` prints the state in `<state>/pr-<number>` (`OPEN` when
 * there is none) and fails while `<state>/view-fails` exists. Any other call exits 2.
 */
function fakeGhScript(state: string): string {
  return [
    "#!/bin/sh",
    `state='${state}'`,
    'printf \'%s\\n\' "$*" >> "$state/calls"',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    '  if [ -e "$state/hang" ]; then exec sleep 60; fi',
    '  if [ -e "$state/signed-out" ]; then',
    '    echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2',
    "    exit 1",
    "  fi",
    '  echo "github.com: Logged in to github.com account acme"',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
    '  if [ -e "$state/pr-fails" ]; then',
    '    echo "pull request create failed: GraphQL: Head sha can\'t be blank" >&2',
    "    exit 1",
    "  fi",
    '  repo=""',
    '  body=""',
    '  prev=""',
    '  for arg in "$@"; do',
    '    if [ "$prev" = "--repo" ]; then repo="$arg"; fi',
    '    if [ "$prev" = "--body-file" ]; then body="$arg"; fi',
    '    prev="$arg"',
    "  done",
    '  cp "$body" "$state/body"',
    '  echo "$repo" >> "$state/opened"',
    "  number=$(wc -l < \"$state/opened\" | tr -d ' ')",
    '  echo "https://github.com/$repo/pull/$number"',
    '  if [ -e "$state/hold-after-open" ]; then exec sleep 60; fi',
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  if [ -e "$state/view-fails" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi',
    '  number="${3##*/}"',
    '  if [ -e "$state/pr-$number" ]; then pr=$(cat "$state/pr-$number"); else pr=OPEN; fi',
    '  printf \'{"state":"%s"}\\n\' "$pr"',
    "  exit 0",
    "fi",
    'echo "fake gh: unexpected call: $*" >&2',
    "exit 2",
    "",
  ].join("\n");
}

describe("a passing run on a GitHub project opens a pull request (C1, C2, C3)", () => {
  let originalPath: string;
  /** The fake gh's state folder. */
  let ghState: string;
  /** The bare repository origin's pushes land in. */
  let pushTarget: string;

  beforeEach(async () => {
    const path = process.env.PATH;
    if (path === undefined) throw new Error("The test process has no PATH");
    originalPath = path;
    const bin = join(root, "gh-bin");
    ghState = join(root, "gh-state");
    await mkdir(bin);
    await mkdir(ghState);
    await writeFile(join(bin, "gh"), fakeGhScript(ghState), { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
    pushTarget = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", pushTarget]);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** The fake gh's calls, one line of arguments each, in order. */
  function ghCalls(): string[] {
    const file = join(ghState, "calls");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  }

  /** Names `url` as `remote` of `folder`, its pushes redirected to `target` as GitHub would take them. */
  function addRemote(folder: string, remote: string, url: string, target: string): void {
    gitIn(folder, ["remote", "add", remote, url]);
    gitIn(folder, ["config", `url.${target}.insteadOf`, url]);
  }

  /** The branches the push target holds. */
  function pushedBranches(): string[] {
    return gitIn(pushTarget, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter((line) => line !== "");
  }

  /**
   * A `PATH` that finds git but no gh: one folder holding only a link to the git first on the
   * test's original `PATH` (2.4).
   */
  async function pathWithoutGh(): Promise<string> {
    const git = originalPath
      .split(delimiter)
      .map((folder) => join(folder, "git"))
      .find((candidate) => existsSync(candidate));
    if (git === undefined) throw new Error("No git on the test process's PATH");
    const folder = join(root, "no-gh");
    await mkdir(folder);
    await symlink(git, join(folder, "git"));
    return folder;
  }

  /** The stand-in executor with its pull request writer replaced by `write`. */
  function writingWith(write: WritePullRequest): DeliveryExecutor {
    return { ...standInExecutor([]), name: "writes-pull-request", writePullRequest: write };
  }

  test("a passed run pushes its branch and records its pull request open; Merge PR is next (1.3, 5.4)", async () => {
    const requests: PullRequestRequest[] = [];
    await useExecutor(
      writingWith((request) => {
        requests.push(request);
        return Promise.resolve(ok(PULL_REQUEST_BODY));
      }),
    );
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "publishing");

    expect(passed.pullRequest).toEqual({
      number: 1,
      url: "https://github.com/acme/numbers/pull/1",
      state: "open",
    });
    expect(passed.verdict).not.toBeNull();
    expect(pushedBranches()).toEqual([run.branch]);
    expect(gitIn(pushTarget, ["rev-parse", run.branch])).toBe(passed.finalCommit);
    const bodyFile = join(root, "runs", run.id, "pull-request.md");
    expect(ghCalls()).toEqual([
      "auth status --hostname github.com",
      `pr create --repo acme/numbers --base main --head ${run.branch} --title ${SPEC.title} --body-file ${bodyFile}`,
    ]);
    expect(readFileSync(join(ghState, "body"), "utf8")).toBe(
      `${PULL_REQUEST_BODY.trimEnd()}${PULL_REQUEST_FOOTER}`,
    );
    // The writer is given the change, every ticket's report, the checks and the verdict (C3).
    const [request] = requests;
    expect(request).toMatchObject({
      finalCommit: passed.finalCommit,
      verdict: passed.verdict,
      checkResults: passed.checkResults,
    });
    expect(Array.isArray(request?.changedFiles)).toBe(true);
    expect(request?.implementerReports.map((report) => report.ticket)).toEqual(
      TICKETS.tickets.map((ticket) => ticket.id),
    );
    expect(request?.implementerReports.every((report) => report.report !== null)).toBe(true);

    const lines = await cleanedUp(run);
    expect(lines.map((line) => line.text)).toContain(
      "Opened pull request #1 on acme/numbers: merge it on GitHub.",
    );
    const { status } = await client.map.overview({ mapId });
    expect(status.stages[4]).toMatchObject({ stage: "delivery", tone: "needs-you" });
    expect(status.next[0]).toMatchObject({ who: "you", stage: "delivery", label: "Merge PR" });
    expect(log).not.toHaveBeenCalled();
  });

  test("a blocked run pushes nothing and opens no pull request (C1)", async () => {
    const written: PullRequestRequest[] = [];
    await useExecutor({
      ...writingWith((request) => {
        written.push(request);
        return Promise.resolve(ok(PULL_REQUEST_BODY));
      }),
      reviewDelivery: (request) => Promise.resolve(ok(verdictFor(request.finalCommit, true))),
    });
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const blocked = await runIn(mapId, run.id, "blocked", "reviewing");
    await cleanedUp(run);

    expect(blocked.pullRequest).toBeNull();
    expect(written).toEqual([]);
    expect(pushedBranches()).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });

  test.each([
    { name: "no origin", remote: null },
    {
      name: "an origin on a GitHub Enterprise host",
      remote: { name: "origin", url: "https://github.acme.example/acme/numbers.git" },
    },
    { name: "a github.com remote not named origin", remote: { name: "upstream", url: GITHUB_URL } },
  ])("$name passes as today, with nothing pushed and no pull request (1.1)", async ({ remote }) => {
    const calls: string[] = [];
    await useExecutor(standInExecutor(calls));
    const { project, mapId, ticketSetId } = await approvedSet();
    if (remote !== null) {
      addRemote(project.folderPath, remote.name, remote.url, pushTarget);
    }

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "reviewing");
    await cleanedUp(run);

    expect(passed.pullRequest).toBeNull();
    expect(calls).toEqual(["implement", "review"]);
    expect(pushedBranches()).toEqual([]);
    expect(ghCalls()).toEqual([]);
    const { status } = await client.map.overview({ mapId });
    expect(status.next[0]?.label).toBe("Mark merged");
  });

  test("a fork checkout opens its pull request on origin's repository, the fork (1.2)", async () => {
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", "git@github.com:me/numbers.git", pushTarget);
    gitIn(project.folderPath, ["remote", "add", "upstream", GITHUB_URL]);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const passed = await runIn(mapId, run.id, "passed", "publishing");
    await cleanedUp(run);

    expect(passed.pullRequest?.url).toBe("https://github.com/me/numbers/pull/1");
    const create = ghCalls().find((call) => call.startsWith("pr create"));
    expect(create).toContain("--repo me/numbers ");
    expect(create).not.toContain("acme/numbers");
    expect(pushedBranches()).toEqual([run.branch]);
  });

  test.each([
    { code: "delivery_github_not_signed_in", setUp: () => "signed-out", pushes: false },
    { code: "delivery_pull_request_failed", setUp: () => "pr-fails", pushes: true },
  ] as const)(
    "a failing gh step ends the run failed $code while publishing (2.1)",
    async ({ code, setUp, pushes }) => {
      await writeFile(join(ghState, setUp()), "");
      await useExecutor(standInExecutor([]));
      const { project, mapId, ticketSetId } = await approvedSet();
      addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

      const run = await startRun(ticketSetId, [PASSING_CHECK]);
      const failed = await runIn(mapId, run.id, "failed", "publishing");
      await cleanedUp(run);

      expect(failed.failure?.code).toBe(code);
      expect(failed).toMatchObject({ verdict: null, pullRequest: null });
      expect(pushedBranches()).toEqual(pushes ? [run.branch] : []);
      expect(log).not.toHaveBeenCalled();
    },
  );

  test("gh missing from PATH ends the run failed delivery_gh_missing, nothing pushed (2.4)", async () => {
    const noGh = await pathWithoutGh();
    await useExecutor(
      writingWith(() => {
        // From the publishing step on, `PATH` finds git but no gh; afterEach restores it.
        process.env.PATH = noGh;
        return Promise.resolve(ok(PULL_REQUEST_BODY));
      }),
    );
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const failed = await runIn(mapId, run.id, "failed", "publishing");
    await cleanedUp(run);

    expect(failed.failure?.code).toBe("delivery_gh_missing");
    expect(pushedBranches()).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });

  test("a failed push ends the run failed delivery_push_failed (2.1)", async () => {
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, join(root, "no-such-remote.git"));

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const failed = await runIn(mapId, run.id, "failed", "publishing");
    await cleanedUp(run);

    expect(failed.failure?.code).toBe("delivery_push_failed");
    expect(ghCalls()).toEqual(["auth status --hostname github.com"]);
  });

  test("a sign-in check past its bound ends the run failed delivery_github_unreachable (2.1)", async () => {
    await writeFile(join(ghState, "hang"), "");
    await useExecutor(writingWith(pullRequestPort.port));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const writer = await nthCall(pullRequestPort.calls, 0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      writer.resolve(ok(PULL_REQUEST_BODY));
      await vi.waitFor(() => {
        expect(ghCalls()).toEqual(["auth status --hostname github.com"]);
      }, DELIVERY_WAIT);
      await vi.advanceTimersByTimeAsync(GITHUB_SIGN_IN_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }

    const failed = await runIn(mapId, run.id, "failed", "publishing");
    await cleanedUp(run);
    expect(failed.failure?.code).toBe("delivery_github_unreachable");
    expect(pushedBranches()).toEqual([]);
  });

  test("after a failed open nothing is deleted, and a resume pushes a different branch (2.2)", async () => {
    await writeFile(join(ghState, "pr-fails"), "");
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const first = await startRun(ticketSetId, [PASSING_CHECK]);
    const failed = await runIn(mapId, first.id, "failed", "publishing");
    expect(failed.failure?.code).toBe("delivery_pull_request_failed");
    await cleanedUp(first);
    expect(pushedBranches()).toEqual([first.branch]);

    await rm(join(ghState, "pr-fails"));
    const resumed = await client.delivery.resume({ runId: first.id });
    const passed = await runIn(mapId, resumed.id, "passed", "publishing");
    await cleanedUp(resumed);

    expect(resumed.branch).not.toBe(first.branch);
    expect(pushedBranches().sort()).toEqual([first.branch, resumed.branch].sort());
    expect(passed.pullRequest).toMatchObject({ number: 1, state: "open" });
    const creates = ghCalls().filter((call) => call.startsWith("pr create"));
    expect(creates.map((call) => call.includes(`--head ${resumed.branch} `))).toEqual([
      false,
      true,
    ]);
    expect(ghCalls().every((call) => /^(auth status|pr create) /.test(call))).toBe(true);
  });

  test("a run cancelled after its pull request opened ends cancelled, and gh is never asked to close it (2.3)", async () => {
    await writeFile(join(ghState, "hold-after-open"), "");
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    await vi.waitFor(() => {
      expect(existsSync(join(ghState, "opened"))).toBe(true);
    }, DELIVERY_WAIT);
    const cancelled = await client.delivery.cancel({ runId: run.id });
    expect(cancelled).toMatchObject({ state: "cancelled", phase: "publishing", pullRequest: null });
    const lines = await cleanedUp(run);

    expect(lines.map((line) => line.text)).toContain(
      "You cancelled the run while ZeNorm was opening its pull request. Anything already pushed or opened stays on GitHub.",
    );
    expect(ghCalls().map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
      "auth status",
      "pr create",
    ]);
    expect(pushedBranches()).toEqual([run.branch]);
    expect(await deliveryRun(mapId, run.id)).toMatchObject({ state: "cancelled" });
  });

  test.each([
    {
      code: "agent_skill_missing",
      error: {
        code: "agent_skill_missing",
        message: "The skill file skills/pr/SKILL.md does not exist.",
        data: { skillPath: "/zenorm/skills/pr/SKILL.md" },
      },
    },
    {
      code: "agent_timed_out",
      error: {
        code: "agent_timed_out",
        message: "The pull request writer did not finish within 1200 seconds and was stopped.",
        data: { timeoutSeconds: 1200 },
      },
    },
  ] as const)(
    "a writer failing $code ends the run failed with it, nothing pushed (3.1, 3.3)",
    async ({ code, error }) => {
      await useExecutor(writingWith(() => Promise.resolve(err(error))));
      const { project, mapId, ticketSetId } = await approvedSet();
      addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

      const run = await startRun(ticketSetId, [PASSING_CHECK]);
      const failed = await runIn(mapId, run.id, "failed", "publishing");
      await cleanedUp(run);

      expect(failed.failure?.code).toBe(code);
      expect(pushedBranches()).toEqual([]);
      expect(ghCalls()).toEqual([]);
    },
  );

  test("while the writer works the run reads publishing, its Delivery stage working (5.4)", async () => {
    await useExecutor(writingWith(pullRequestPort.port));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);

    const run = await startRun(ticketSetId, [PASSING_CHECK]);
    const writer = await nthCall(pullRequestPort.calls, 0);
    const publishing = await runIn(mapId, run.id, "running", "publishing");
    expect(publishing).toMatchObject({ verdict: null, pullRequest: null });
    const { status } = await client.map.overview({ mapId });
    expect(status.stages[4]).toMatchObject({ stage: "delivery", tone: "working" });

    writer.resolve(ok(PULL_REQUEST_BODY));
    await runIn(mapId, run.id, "passed", "publishing");
    await cleanedUp(run);
  });

  /** The fake gh's `pr view` calls, in order. */
  function prViews(): string[] {
    return ghCalls().filter((call) => call.startsWith("pr view "));
  }

  /** Makes the fake report pull request #1 in `state` (gh's own words). */
  async function reportState(state: "OPEN" | "CLOSED" | "MERGED"): Promise<void> {
    await writeFile(join(ghState, "pr-1"), state);
  }

  /** A passed run on a GitHub project, with its pull request #1 recorded open. */
  async function passedWithPullRequest(): Promise<{ mapId: string; run: SpecRun }> {
    await useExecutor(standInExecutor([]));
    const { project, mapId, ticketSetId } = await approvedSet();
    addRemote(project.folderPath, "origin", GITHUB_URL, pushTarget);
    const started = await startRun(ticketSetId, [PASSING_CHECK]);
    const run = await runIn(mapId, started.id, "passed", "publishing");
    await cleanedUp(started);
    expect(run.pullRequest).toMatchObject({ number: 1, state: "open" });
    return { mapId, run };
  }

  /**
   * A second app over the test's database, started under a fake `setInterval`: its pull request
   * checks' timer is the one the test drives. The caller stops it, then restores the timers.
   */
  async function timedApp(): Promise<ZeNormApp> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    return await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked([], [localExecutor(), standInExecutor([])], "stand-in"),
    });
  }

  test("Check now records a squash-merged pull request merged: Delivery reads done, with the Merged into line (4.1)", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("MERGED");

    const merged = await client.delivery.checkPullRequest({ runId: run.id });

    expect(merged).toMatchObject({ state: "passed", pullRequest: { number: 1, state: "merged" } });
    expect(merged.mergedAt).not.toBeNull();
    const overview = await client.map.overview({ mapId });
    expect(overview.status.stages[4]).toMatchObject({ stage: "delivery", tone: "done" });
    expect(overview.activity.map((line) => line.text)).toContain(
      `Merged into main: “${SPEC.title}” is recorded as delivered.`,
    );
    const lines = await client.delivery.activity({ runId: run.id });
    expect(lines.at(-1)?.text).toBe(
      "Pull request #1 is merged into main on GitHub. The tickets are recorded as delivered.",
    );
    expect(prViews()).toEqual([`pr view ${GITHUB_PR_URL} --json state`]);
  });

  test("Check now's refusals each change nothing (4.2)", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("MERGED");
    const before = await deliveryRun(mapId, run.id);
    async function refusedWith(runId: string): Promise<string | null> {
      const [error] = await safe(client.delivery.checkPullRequest({ runId }));
      return isDefinedError(error) ? error.code : null;
    }

    expect(await refusedWith(UNKNOWN_ID)).toBe("delivery_run_not_found");
    await writeFile(join(ghState, "signed-out"), "");
    expect(await refusedWith(run.id)).toBe("delivery_github_not_signed_in");
    await rm(join(ghState, "signed-out"));
    await writeFile(join(ghState, "view-fails"), "");
    expect(await refusedWith(run.id)).toBe("delivery_github_unreachable");
    await rm(join(ghState, "view-fails"));
    process.env.PATH = await pathWithoutGh();
    const missing = await refusedWith(run.id);
    process.env.PATH = originalPath;
    expect(missing).toBe("delivery_gh_missing");

    expect(await deliveryRun(mapId, run.id)).toEqual(before);
    expect(log).not.toHaveBeenCalled();
  });

  test("a passed run with no pull request is refused delivery_no_pull_request (4.2)", async () => {
    await useExecutor(standInExecutor([]));
    const { mapId, ticketSetId } = await approvedSet();
    const started = await startRun(ticketSetId, [PASSING_CHECK]);
    await runIn(mapId, started.id, "passed", "reviewing");
    await cleanedUp(started);
    const before = await deliveryRun(mapId, started.id);

    const [error] = await safe(client.delivery.checkPullRequest({ runId: started.id }));

    expect(isDefinedError(error) && error.code).toBe("delivery_no_pull_request");
    expect(await deliveryRun(mapId, started.id)).toEqual(before);
    expect(ghCalls()).toEqual([]);
  });

  test("the timer records a closed pull request closed and no longer checks it; Check now records a reopen open (C4)", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("CLOSED");
    const timed = await timedApp();
    try {
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      await vi.waitFor(async () => {
        expect((await deliveryRun(mapId, run.id)).pullRequest?.state).toBe("closed");
      }, DELIVERY_WAIT);
      expect(prViews()).toHaveLength(1);

      // Closed, the next round has nothing to check.
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      expect(prViews()).toHaveLength(1);

      await reportState("OPEN");
      const reopened = await client.delivery.checkPullRequest({ runId: run.id });
      expect(reopened).toMatchObject({ mergedAt: null, pullRequest: { state: "open" } });

      // Open again, the timer checks it again, and records its merge.
      await reportState("MERGED");
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      await vi.waitFor(async () => {
        expect((await deliveryRun(mapId, run.id)).mergedAt).not.toBeNull();
      }, DELIVERY_WAIT);
      expect(prViews()).toHaveLength(3);
      expect(log).not.toHaveBeenCalled();
    } finally {
      await timed.stopDeliveryRuns();
      vi.useRealTimers();
    }
  });

  test("a failed timer check is logged and changes nothing (C4)", async () => {
    const { mapId, run } = await passedWithPullRequest();
    await reportState("MERGED");
    await writeFile(join(ghState, "view-fails"), "");
    const before = await deliveryRun(mapId, run.id);
    const timed = await timedApp();
    try {
      await vi.advanceTimersByTimeAsync(PULL_REQUEST_CHECK_INTERVAL_MS);
      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`${run.id}.*delivery_github_unreachable`)),
          null,
        );
      }, DELIVERY_WAIT);
      expect(await deliveryRun(mapId, run.id)).toEqual(before);
    } finally {
      await timed.stopDeliveryRuns();
      vi.useRealTimers();
    }
  });
});
