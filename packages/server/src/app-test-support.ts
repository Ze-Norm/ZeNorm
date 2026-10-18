/**
 * Shared setup for the app's tests (`app-*.test.ts`, split so vitest runs them in parallel): each
 * case's app over a fresh database with deferred ports, its client, and the fixtures and helpers
 * the cases share. A test file calls `setUpAppTests()` once, at its top.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createORPCClient } from "@orpc/client";
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
  PickedScreens,
  PickScreens,
  PickScreensRequest,
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
  SaveProjectSettingsInput,
  SpecReviewOutcome,
  TaskOutcome,
  TicketSetContent,
  TicketsReviewOutcome,
  Verdict,
  WorkTaskRequest,
  WritePullRequest,
  WrittenPullRequest,
} from "@zenorm/contracts";
import { gitIdentityEnv, ok } from "@zenorm/contracts";
import { createChangeBus, ticketBranchName } from "@zenorm/core";
import { installChangeFeed, openDatabase } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { definePlugin, SDK_VERSION } from "@zenorm/plugin-sdk";
import type { ServerPlugin } from "@zenorm/plugin-sdk";
import { afterEach, beforeEach, expect, inject, vi } from "vitest";
import type { Mock } from "vitest";

import { createApp } from "./app.ts";
import type { AppOptions, Log, ZeNormApp } from "./app.ts";
import { checkPlugins } from "./plugins.ts";
import type { CheckedPlugins } from "./plugins.ts";

export const INDEX_HTML = "<!doctype html><title>ZeNorm test</title>";
/** The host and port the test app is configured on. */
export const SERVER = { host: "127.0.0.1", port: 4310 };
/** What a request to the test app carries as its Host, and its page's Origin. */
export const HOST = "127.0.0.1:4310";
export const ORIGIN = `http://${HOST}`;
/** The headers an app request needs to be served: `Request` sets no Host of its own. */
export const SERVED = { host: HOST };
/** A UUIDv7 that names nothing stored. */
export const UNKNOWN_ID = "01920000-0000-7000-8000-000000000000";

export const ROUND: QuestionRoundDraft = {
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

export const PROPOSAL: ChartProposal = {
  title: "Dark mode",
  summary: "People want a darker screen at night.",
  destination: "A dark theme switched by a toggle.",
  round: ROUND,
  split: [],
};

export const CONFIRMATION: ChartConfirmation = {
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

export const NO_WAYPOINTS: ChartConfirmation = { ...CONFIRMATION, waypoints: [] };

export const SPEC: DraftSpecsOutcome["specs"][number]["content"] = {
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

export const DRAFTED: DraftSpecsOutcome = {
  specs: [{ specNumber: null, content: SPEC }],
  waits: [],
};

export const PASSED: SpecReviewOutcome = {
  summary: "Every clause traces.",
  findings: [],
  verified: [],
};

export const TICKETS_PASSED: TicketsReviewOutcome = {
  summary: "Every criterion is covered.",
  findings: [],
};

export const TICKETS: TicketSetContent = {
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

export const ANSWERS = [
  { optionIndex: 1, note: "", accepted: false },
  { optionIndex: null, note: "Both, really", accepted: false },
];

/** One fake port call the test settles when it chooses, so `running` stays observable. */
export interface PendingDraft<TRequest, TValue> {
  readonly request: TRequest;
  readonly session: PlanningCallSession;
  readonly resolve: (result: Result<TValue, PlanningAgentError>) => void;
  readonly reject: (error: unknown) => void;
}

/** A fake port that records each call and leaves its promise pending until the test settles it. */
export function deferredPort<TRequest, TValue>(): {
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
export const DELIVERY_WAIT = { timeout: 15_000, interval: 20 };

/** Waits for the `n`th call (from 0) of a deferred port; core reads the map before calling it. */
export async function nthCall<T>(calls: readonly T[], n: number): Promise<T> {
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
export interface PendingSession<TRequest, TValue> {
  readonly request: TRequest;
  readonly signal: AbortSignal;
  /** The orchestrator's event callback; the reviewer port has none. */
  readonly onEvent: ((event: ImplementEvent) => void) | undefined;
  readonly resolve: (result: Result<TValue, DeliveryAgentError>) => void;
  readonly reject: (error: unknown) => void;
}

/** A fake delivery port that records each call and leaves its promise pending. */
export function deferredSession<TRequest, TValue>(): {
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
export const SURVEY: CodeSurveyDraft = {
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
 * a confirmed chart to its waypoints. Records each request.
 */
export const surveyCode: SurveyCode = (request) => {
  surveyRequests.push(request);
  return Promise.resolve(ok(SURVEY));
};

/** The fog run's port: it moves every fog item out of scope at once. */
export const settleFog: SettleFog = (request) =>
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
export function planningPorts() {
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
export function localExecutor(): DeliveryExecutor {
  const implementTicketSet: ImplementTicketSet = implementPort.port;
  const reviewDelivery: ReviewDelivery = reviewPort.port;
  const writePullRequest: WritePullRequest = pullRequestPort.port;
  const pickScreens: PickScreens = pickScreensPort.port;
  return { name: "local", implementTicketSet, reviewDelivery, writePullRequest, pickScreens };
}

/** `plugins` checked as the app entry checks them, with `executors` and the one `executor` names. */
export function checked(
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

export function deliveryOptions() {
  return {
    plugins: checked([], [localExecutor()], "local"),
    delivery: { runsDir: join(root, "runs"), checkTimeoutMinutes: 1 },
  };
}

/** The app over `options`, started and launched as the app entry does; a refusal fails the test. */
export async function appOf(options: AppOptions): Promise<ZeNormApp> {
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

export let root: string;
export let db: ZeNormDatabase;
export let webDistDir: string;
export let log: Mock<Log>;
export let chartPort: ReturnType<typeof deferredPort<ChartMapRequest, ChartOutcome>>;
export let grillPort: ReturnType<typeof deferredPort<GrillWaypointRequest, GrillOutcome>>;
export let researchPort: ReturnType<typeof deferredPort<ResearchWaypointRequest, ResearchOutcome>>;
export let taskPort: ReturnType<typeof deferredPort<WorkTaskRequest, TaskOutcome>>;
export let surveyRequests: SurveyCodeRequest[];
export let consistencyPort: ReturnType<
  typeof deferredPort<CheckConsistencyRequest, ConsistencyOutcome>
>;
export let specsPort: ReturnType<typeof deferredPort<DraftSpecsRequest, DraftSpecsOutcome>>;
export let revisePort: ReturnType<typeof deferredPort<ReviseSpecRequest, ReviseSpecOutcome>>;
export let specReviewPort: ReturnType<typeof deferredPort<ReviewSpecRequest, SpecReviewOutcome>>;
export let ticketSetPort: ReturnType<typeof deferredPort<DraftTicketSetRequest, TicketSetContent>>;
export let ticketsReviewPort: ReturnType<
  typeof deferredPort<ReviewTicketSetRequest, TicketsReviewOutcome>
>;
export let hatchPort: ReturnType<typeof deferredPort<ReplyThroughHatchRequest, HatchOutcome>>;
export let implementPort: ReturnType<typeof deferredSession<ImplementRequest, null>>;
export let reviewPort: ReturnType<typeof deferredSession<ReviewRequest, Verdict>>;
export let pullRequestPort: ReturnType<
  typeof deferredSession<PullRequestRequest, WrittenPullRequest>
>;
export let pickScreensPort: ReturnType<typeof deferredSession<PickScreensRequest, PickedScreens>>;
export let app: ZeNormApp;
export let client: ContractRouterClient<Contract>;

export function clientOf(target: ZeNormApp): ContractRouterClient<Contract> {
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

/** Swaps the test's app, and its client, for `next`. */
export function useApp(next: ZeNormApp): void {
  app = next;
  client = clientOf(next);
}

/** Swaps the test's database for `next`, as a restarted app's. */
export function useDatabase(next: ZeNormDatabase): void {
  db = next;
}

/**
 * Registers each case's fresh app and database (a copy of the run's migrated template), and their
 * removal after it, in the calling test file.
 */
export function setUpAppTests(): void {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zenorm-server-"));
    webDistDir = join(root, "dist");
    await mkdir(webDistDir);
    await writeFile(join(webDistDir, "index.html"), INDEX_HTML);
    await writeFile(join(webDistDir, "asset.js"), "export {};");
    await mkdir(join(root, "runs"));
    const file = join(root, "zenorm.sqlite");
    await copyFile(inject("migratedDatabase"), file);
    const opened = openDatabase(file);
    if (!opened.ok) {
      throw new Error(opened.error.message);
    }
    db = opened.value;
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
    pullRequestPort = deferredSession<PullRequestRequest, WrittenPullRequest>();
    pickScreensPort = deferredSession<PickScreensRequest, PickedScreens>();
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
}

/** Adds a Project over a fresh git repository with one commit on `main`. */
export async function addProject(): Promise<Project> {
  const folderPath = join(root, "repo");
  const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
  execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "init"]);
  return await client.project.create({ folderPath, baseBranch: "main" });
}

/** Resolves chart call `n` with the proposal and returns the map's pending destination round. */
export async function proposed(mapId: string, n: number): Promise<QuestionRound> {
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
export async function clearedMap(idea = "Dark mode"): Promise<{ project: Project; mapId: string }> {
  const project = await addProject();
  return { project, mapId: await clearedMapIn(project, idea) };
}

export async function clearedMapIn(project: Project, idea: string): Promise<string> {
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
export function specLine(overview: MapOverviewDetail): string {
  return overview.status.stages[2].line;
}

/** Polls `map.overview` until `ready` holds, and returns that overview. */
export async function overviewWhen(
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
export function firstSpec(overview: MapOverviewDetail): MapSpec {
  const [spec] = overview.specs;
  if (spec === undefined) throw new Error("The map has no spec");
  return spec;
}

/** Writes spec 1 on a cleared map and passes its review; returns its revision id. */
export async function reviewedSpec(mapId: string, call: number): Promise<string> {
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

export const NOT_LOGGED_IN = {
  ok: false,
  error: { code: "agent_not_logged_in", message: "Not logged in", data: {} },
} as const;

/** A git repository at `root/<name>` on `main`, with one commit when `commit` is true. */
export function makeRepo(name: string, commit: boolean): string {
  const folderPath = join(root, name);
  const git = ["-c", "user.name=test", "-c", "user.email=test@example.invalid"];
  execFileSync("git", [...git, "init", "-q", "-b", "main", folderPath]);
  if (commit) {
    execFileSync("git", [...git, "-C", folderPath, "commit", "-q", "--allow-empty", "-m", "i"]);
  }
  return folderPath;
}

/** What a planning port returns for an aborted call. */
export const PLANNING_CANCELLED: CancelledError = {
  code: "agent_cancelled",
  message: "Cancelled",
  data: {},
};

export const STOP_USAGE: PlanningRunUsage = {
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
export function stoppableChart(): {
  readonly port: ChartMap;
  readonly sessions: PlanningCallSession[];
} {
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
export function storedRuns(mapId: string): unknown[] {
  return db.$client
    .prepare(
      `select id, state, error_code, retry_of_run_id, session_id, total_cost_usd
        from planning_runs where map_id = ? order by started_at, id`,
    )
    .all(mapId);
}

/** Takes a new map to an approved spec and an approved ticket set (two tickets). */
export async function approvedSet(): Promise<{
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

export const DELIVERED_FILE = "delivered.txt";
/** The body every stand-in pull request writer returns (the PR skill's four headings). */
export const PULL_REQUEST_BODY =
  "## Why\n\nDark mode.\n\n## What\n\n## Tests\n\n## Risks\n\nNone.\n";
/** What every stand-in pull request writer returns: the body, reporting no visible change. */
export const PULL_REQUEST_WRITTEN: WrittenPullRequest = {
  body: PULL_REQUEST_BODY,
  visibleChange: false,
};
export const PASSING_CHECK = "git status --short";
export const FAILING_CHECK = "git rev-parse --verify no-such-ref";

export function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * What a successful orchestrator leaves: one commit in the run worktree under the run identity,
 * with each pinned ticket's branch `<run branch>-t<n>` at it, so verifying finds every ticket
 * merged from git.
 */
export async function commitDelivery(request: ImplementRequest): Promise<string> {
  await writeFile(join(request.worktreePath, DELIVERED_FILE), "delivered\n");
  const env = { ...process.env, ...gitIdentityEnv(request.gitIdentity) };
  execFileSync("git", ["add", DELIVERED_FILE], { cwd: request.worktreePath, env });
  execFileSync("git", ["commit", "-q", "-m", "Deliver"], { cwd: request.worktreePath, env });
  for (const ticket of request.tickets) {
    gitIn(request.worktreePath, ["branch", ticketBranch(request.branch, ticket.id)]);
  }
  return gitIn(request.worktreePath, ["rev-parse", "HEAD"]);
}

/** A pinned ticket's branch. */
export function ticketBranch(runBranch: string, ticket: string): string {
  return `${runBranch}-t${ticket.slice(1)}`;
}

export function verdictFor(reviewedCommit: string, blocking: boolean): Verdict {
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
 * Saves the (only) project's required checks and a repair limit of 0 (no repair), then starts a run
 * of the set.
 */
export async function startRun(
  ticketSetId: string,
  checks: readonly string[],
): Promise<DeliveryRun> {
  return await startRunWithRepairs(ticketSetId, checks, 0);
}

/** Saves the (only) project's required checks and `repairLimit`, then starts a run of the set. */
export async function startRunWithRepairs(
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
    ...NO_APP_SETTINGS,
  });
  return await client.delivery.start({ ticketSetId });
}

/** The app settings of a project that takes no screenshots: no start command, URL or setup. */
export const NO_APP_SETTINGS: Pick<
  SaveProjectSettingsInput,
  "appStartCommand" | "appUrl" | "appSetupCommands"
> = { appStartCommand: null, appUrl: null, appSetupCommands: [] };

/** The run with this id as `map.overview` reports it in spec 1's runs. */
export async function deliveryRun(mapId: string, runId: string): Promise<SpecRun> {
  const { specs } = await client.map.overview({ mapId });
  const run = firstSpecOf(specs).runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error(`map.overview has no run ${runId}`);
  }
  return run;
}

export function firstSpecOf<T>(specs: readonly T[]): T {
  const [spec] = specs;
  if (spec === undefined) throw new Error("The map has no spec");
  return spec;
}

/** Polls `map.overview` until the run is in `state` with the stored `phase`. */
export async function runIn(
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
 * Waits for the runner's cleanup after a run's end: its worktree is gone and its last line,
 * ZeNorm's cleanup line, names the run branch it keeps. Returns the run's lines.
 */
export async function cleanedUp(run: DeliveryRun): Promise<RunEvent[]> {
  return await vi.waitFor(async () => {
    expect(existsSync(join(root, "runs", run.id, "worktree"))).toBe(false);
    const lines = await client.delivery.activity({ runId: run.id });
    expect(lines.at(-1)).toMatchObject({ who: "zenorm", ticket: null });
    expect(lines.at(-1)?.text).toContain(run.branch);
    return lines;
  }, DELIVERY_WAIT);
}

/** The orchestrator port's event callback of a pending implement call. */
export function eventsOf(
  call: PendingSession<ImplementRequest, null>,
): (event: ImplementEvent) => void {
  const { onEvent } = call;
  if (onEvent === undefined) throw new Error("The orchestrator port got no onEvent");
  return onEvent;
}

/**
 * What the orchestrator does for one ticket: a commit on `<run branch>-t<n>` in its own worktree
 * `<runDir>/tickets/t<n>`, merged `--no-ff` into the run worktree when `merge` is true. Returns the
 * ticket branch's head.
 */
export async function commitTicket(
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
export function ticketRefs(folderPath: string, runBranch: string): string {
  return gitIn(folderPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${runBranch}-t*`]);
}

/**
 * A stand-in delivery executor that is not `"local"` and runs no agent: per pinned ticket it
 * commits on the ticket branch `<run branch>-t<n>`, merges that branch into the run branch in
 * `worktreePath` with `--no-ff`, then emits `ticket_merged`. Its reviewer passes.
 */
export function standInExecutor(calls: string[]): DeliveryExecutor {
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
      return Promise.resolve(ok(PULL_REQUEST_WRITTEN));
    },
    pickScreens: () => {
      calls.push("pick screens");
      return Promise.resolve(ok({ kind: "no_visible_change" }));
    },
  };
}

/** Swaps the test's app for one whose delivery runs through `executor` (registered beside local). */
export async function useExecutor(executor: DeliveryExecutor): Promise<void> {
  useApp(
    await appOf({
      db,
      bus: createChangeBus(log),
      webDistDir,
      log,
      ...planningPorts(),
      plugins: checked([], [localExecutor(), executor], executor.name),
    }),
  );
}

/** The file a repair commits; `REPAIRED_CHECK` fails until it is in the run branch. */
export const REPAIR_FILE = "repaired.txt";
export const REPAIRED_CHECK = `git ls-files --error-unmatch ${REPAIR_FILE}`;

/** A commit of `file` in the run worktree under the run identity, as a repair makes; its id. */
export async function commitRepair(request: ImplementRequest, file: string): Promise<string> {
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
export async function activityTexts(runId: string): Promise<string[]> {
  return (await client.delivery.activity({ runId })).map((line) => line.text);
}

/**
 * A stand-in for the `example` executor's repair: a first call merges every ticket as
 * `standInExecutor` does; given `repair`, it merges nothing and commits `repair-<attempt>.txt` on
 * the run branch. Records every request.
 */
export function repairingExecutor(requests: ImplementRequest[]): DeliveryExecutor {
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
    writePullRequest: () => Promise.resolve(ok(PULL_REQUEST_WRITTEN)),
    pickScreens: () => Promise.resolve(ok({ kind: "no_visible_change" })),
  };
}

/**
 * A plugin whose checkout gives a clone of the stored folder, made on its first call: a fetched
 * mirror, say. `clone` is where it is.
 */
export function clonePlugin(clone: string): ServerPlugin {
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
export function worktreesOf(folder: string): string[] {
  return gitIn(folder, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** True when `ref` names a commit or branch in `folder`. */
export function hasRef(folder: string, ref: string): boolean {
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

/** The github.com repository a stand-in project's origin names. */
export const GITHUB_URL = "https://github.com/acme/numbers.git";
/** The URL the fake gh gives the first pull request it opens on that repository. */
export const GITHUB_PR_URL = "https://github.com/acme/numbers/pull/1";

/**
 * A stand-in for the GitHub CLI, written first on the server process's `PATH`. Every call appends
 * its arguments as one line to `<state>/calls`. `gh auth status` succeeds, fails while
 * `<state>/signed-out` exists, and hangs while `<state>/hang` exists. `gh pr create` fails while
 * `<state>/pr-fails` exists; otherwise it copies its `--body-file` to `<state>/body`, numbers the
 * pull request from 1 and prints its URL on its `--repo`, then hangs while
 * `<state>/hold-after-open` exists. `gh pr view <url> --json state` prints the state in
 * `<state>/pr-<number>` (`OPEN` when there is none) and fails while `<state>/view-fails` exists.
 * Any other call exits 2.
 */
export function fakeGhScript(state: string): string {
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
