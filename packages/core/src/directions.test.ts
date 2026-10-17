import type {
  ChartConfirmation,
  ConsistencyFinding,
  GrillWaypointRequest,
  HatchChange,
  MapChanges,
  PlanningRun,
  Project,
  ResearchReport,
  ResearchWaypointRequest,
  TaskOutcome,
  WorkTaskRequest,
} from "@zenorm/contracts";
import { hatchMessages, mapExclusions, mapFog, waypointBlockers } from "@zenorm/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import { recordHatchReply } from "./hatch-runs.ts";
import { approveSpecRevision } from "./planning.ts";
import {
  failRun,
  readRounds,
  readWaypoints,
  recordConsistency,
  recordResearch,
  recordTask,
} from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import { recordSpecs } from "./spec-runs.ts";
import { readMapRevisions } from "./specs.ts";
import {
  CONFIRMATION,
  NO_MAP_CHANGES,
  SPEC,
  addProject,
  answerDestination,
  ask,
  chartedMap,
  cleanPass,
  closeTestContext,
  confirm,
  grillingRun,
  newMap,
  openTestContext,
  pendingRoundOn,
  propose,
  resolve,
  resolvedChain,
  runningMapRun,
  runsOf,
  waypointOf,
  PROPOSAL,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-directions-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

/** Research 1 and Task 2, Grilling 3 blocked by both; one fog item (position 1). */
const KINDS: ChartConfirmation = {
  title: PROPOSAL.title,
  summary: PROPOSAL.summary,
  destination: "Move the HTTP client to built-in fetch behind the proxy.",
  waypoints: [
    {
      kind: "research",
      title: "Proxy support",
      question: "Does built-in fetch honour the proxy variables?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "task",
      title: "Count the call sites",
      question: "How many files call the old client?",
      blockedBy: [],
      touches: [],
    },
    {
      kind: "grilling",
      title: "Migration order",
      question: "Which call sites move first?",
      blockedBy: [1, 2],
      touches: [],
    },
  ],
  fog: ["Retries on flaky networks."],
  outOfScope: [],
  proposals: [],
};

const UNANSWERED: ResearchReport = {
  answered: false,
  summary: "The release notes do not say whether Node 22 honours the proxy.",
  gap: "Whether Node 22 honours the proxy variables.",
  gist: null,
  findings: [],
  sources: [],
  limitations: [],
  uncertainties: ["The changelog may be incomplete."],
};

const ANSWERED: ResearchReport = {
  answered: true,
  summary: "Built-in fetch honours the proxy variables from Node 24.",
  gap: null,
  gist: "fetch honours the proxy from Node 24",
  findings: [{ title: "Proxy support", detail: "Node 24 reads HTTP_PROXY.", sources: [1] }],
  sources: [
    {
      kind: "external",
      title: "Node 24 release notes",
      url: "https://nodejs.org/en/blog/release/v24.0.0",
      excerpt: "fetch now honours HTTP_PROXY.",
    },
  ],
  limitations: ["Only the release notes were read."],
  uncertainties: [],
};

const DONE: TaskOutcome = {
  round: null,
  done: {
    action: "Counted the imports.",
    facts: "12 files import the client.",
    gist: "12 files",
    agentDecided: [],
  },
  failed: null,
  outOfScope: null,
  mapChanges: NO_MAP_CHANGES,
};

const FAILED: TaskOutcome = {
  round: null,
  done: null,
  failed: { action: "Tried to count the imports.", facts: "The src folder is unreadable." },
  outOfScope: null,
  mapChanges: NO_MAP_CHANGES,
};

const NEW_QUESTION = {
  title: "Timeouts",
  question: "How long does a request wait before it gives up?",
};

/** A map charted with KINDS: Research 1 and Task 2 claimed and running, 3 blocked by both. */
async function kindsMap(): Promise<string> {
  const mapId = await newMap(context, project, "Move to fetch");
  propose(context, mapId);
  answerDestination(context, mapId);
  confirm(context, mapId, KINDS);
  return mapId;
}

function researchOn(mapId: string, number: number, report: ResearchReport): void {
  const recorded = recordResearch(
    context.user,
    context.db,
    grillingRun(context, mapId, number).id,
    {
      report,
      outOfScope: null,
      mapChanges: NO_MAP_CHANGES,
    },
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function taskOn(mapId: string, number: number, outcome: TaskOutcome): void {
  const recorded = recordTask(
    context.user,
    context.db,
    grillingRun(context, mapId, number).id,
    outcome,
  );
  if (!recorded.ok) throw new Error(recorded.error.code);
}

function runById(mapId: string, id: string): PlanningRun {
  const run = runsOf(context, mapId).find((candidate) => candidate.id === id);
  if (run === undefined) throw new Error(`No run ${id}`);
  return run;
}

/** The running hatch run answering the map's message `messageId`. */
function hatchRunOf(mapId: string, messageId: string): PlanningRun {
  const hatch = runsOf(context, mapId).find(
    (run) => run.purpose === "hatch" && run.state === "running" && run.hatchMessageId === messageId,
  );
  if (hatch === undefined) throw new Error("No hatch run running");
  return hatch;
}

function storedMessage(messageId: string) {
  const message = context.db
    .select()
    .from(hatchMessages)
    .where(eq(hatchMessages.id, messageId))
    .get();
  if (message === undefined) throw new Error("The message is gone");
  return message;
}

/** Sends a message whose hatch run returns `change`; returns the result, the message and the run. */
async function direct(mapId: string, change: HatchChange, text = "Please change this.") {
  const sent = await sendHatchMessage(
    context.user,
    context.db,
    { mapId, stage: "wayfinding", specNumber: null, text },
    RUNNERS,
  );
  if (!sent.ok) throw new Error(sent.error.code);
  const messageId = sent.value.messages.at(-1)?.id;
  if (messageId === undefined) throw new Error("No message stored");
  const hatchRun = hatchRunOf(mapId, messageId);
  const recorded = recordHatchReply(context.user, context.db, hatchRun.id, {
    reply: "Done.",
    change,
  });
  return { recorded, message: storedMessage(messageId), hatchRun };
}

/** Prepares a running run and returns its work. */
async function workOf(runId: string) {
  const prepared = await prepareRun(context.db, runId);
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.value;
}

async function grillRequest(runId: string): Promise<GrillWaypointRequest> {
  const work = await workOf(runId);
  if (work.purpose !== "grilling") throw new Error(work.purpose);
  return work.request;
}

async function researchRequest(runId: string): Promise<ResearchWaypointRequest> {
  const work = await workOf(runId);
  if (work.purpose !== "research") throw new Error(work.purpose);
  return work.request;
}

async function taskRequest(runId: string): Promise<WorkTaskRequest> {
  const work = await workOf(runId);
  if (work.purpose !== "task") throw new Error(work.purpose);
  return work.request;
}

/** The note a request carries for `message`. */
function noteOf(message: { text: string; sentAt: string }) {
  return { text: message.text, sentAt: message.sentAt };
}

function openWaypoint(
  waypointKind: "grilling" | "research" | "task",
  blockedBy: number[],
  fog: MapChanges = NO_MAP_CHANGES,
): HatchChange {
  return { kind: "open_waypoint", waypointKind, ...NEW_QUESTION, blockedBy, fog };
}

describe("open_waypoint", () => {
  test("a Grilling, a Research and a Task waypoint are added, blocked by existing ones; each runs its kind with the note once unblocked", async () => {
    const mapId = await chartedMap(context, project);
    const added: { number: number; messageId: string; hatchRun: string }[] = [];
    for (const kind of ["grilling", "research", "task"] as const) {
      const { recorded, message, hatchRun } = await direct(mapId, openWaypoint(kind, [1]));
      expect(recorded).toEqual({ ok: true, value: null });
      expect(message.refusal).toBeNull();
      expect(message.change).toMatchObject({ kind: "open_waypoint", waypointKind: kind });
      const number = 3 + added.length + 1;
      expect(waypointOf(context, mapId, number)).toMatchObject({
        kind,
        status: "open",
        ...NEW_QUESTION,
        createdByRun: hatchRun.id,
        hatchMessageId: message.id,
      });
      added.push({ number, messageId: message.id, hatchRun: hatchRun.id });
    }
    expect(
      context.db
        .select()
        .from(waypointBlockers)
        .where(eq(waypointBlockers.mapId, mapId))
        .all()
        .filter((blocker) => blocker.waypointNumber > 3),
    ).toEqual([4, 5, 6].map((number) => ({ mapId, waypointNumber: number, blockerNumber: 1 })));

    resolve(context, mapId, 1);

    const [grilling, research, task] = added.map(({ number }) =>
      grillingRun(context, mapId, number),
    );
    if (grilling === undefined || research === undefined || task === undefined) {
      throw new Error("Three runs expected");
    }
    expect([grilling.purpose, research.purpose, task.purpose]).toEqual([
      "grilling",
      "research",
      "task",
    ]);
    const [first, second, third] = added.map(({ messageId }) => storedMessage(messageId));
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Three messages expected");
    }
    expect((await grillRequest(grilling.id)).note).toEqual(noteOf(first));
    expect((await researchRequest(research.id)).note).toEqual(noteOf(second));
    expect((await taskRequest(task.id)).note).toEqual(noteOf(third));
    // A waypoint no message directed carries no note.
    expect((await grillRequest(grillingRun(context, mapId, 2).id)).note).toBeNull();
  });

  test("the named waypoint comes before the fog settlement's waypoints, all created by the hatch run", async () => {
    const mapId = await kindsMap();
    const fog: MapChanges = {
      newWaypoints: [
        {
          kind: "grilling",
          title: "Retries",
          question: "Does a request retry?",
          blockedBy: [],
          fromFog: 1,
        },
        {
          kind: "task",
          title: "Check logs",
          question: "What do the logs show?",
          blockedBy: [2],
          fromFog: null,
        },
      ],
      fogOutOfScope: [],
      fogDecided: [],
      fogSettledHere: [],
      newFog: [],
    };

    const { recorded, message, hatchRun } = await direct(mapId, openWaypoint("research", [], fog));

    expect(recorded.ok).toBe(true);
    expect(readWaypoints(context.db, mapId).slice(3)).toMatchObject([
      { number: 4, kind: "research", title: NEW_QUESTION.title, hatchMessageId: message.id },
      { number: 5, kind: "grilling", title: "Retries", hatchMessageId: null },
      { number: 6, kind: "task", title: "Check logs", hatchMessageId: null },
    ]);
    for (const number of [4, 5, 6]) {
      expect(waypointOf(context, mapId, number).createdByRun).toBe(hatchRun.id);
    }
    expect(context.db.select().from(mapFog).where(eq(mapFog.mapId, mapId)).all()).toEqual([]);
  });

  test("a blocker naming an unknown number, or the new waypoint itself, fails hatch_change_invalid and adds nothing", async () => {
    const mapId = await chartedMap(context, project);
    for (const blockedBy of [[9], [4]]) {
      const before = readWaypoints(context.db, mapId);
      const { recorded, message, hatchRun } = await direct(
        mapId,
        openWaypoint("grilling", blockedBy),
      );
      expect(recorded.ok ? null : recorded.error.code).toBe("hatch_change_invalid");
      expect(readWaypoints(context.db, mapId)).toEqual(before);
      expect(message.reply).toBeNull();
      expect(runById(mapId, hatchRun.id)).toMatchObject({
        state: "failed",
        errorCode: "hatch_change_invalid",
      });
      // The retry carries the problem; it replies with no change so the next message runs.
      const retry = hatchRunOf(mapId, message.id);
      const work = await workOf(retry.id);
      if (work.purpose !== "hatch") throw new Error(work.purpose);
      expect(work.request.refusedAttempt).not.toBeNull();
      expect(
        recordHatchReply(context.user, context.db, retry.id, { reply: "Noted.", change: null }).ok,
      ).toBe(true);
    }
  });

  test("with a map-scope to_spec running nothing is cancelled; its draft refuses approval map_uncleared; the re-clear is due once the waypoint resolves", async () => {
    const mapId = await resolvedChain(context, project);
    const drafting = runningMapRun(context, mapId);
    expect(drafting.purpose).toBe("to_spec");

    const { recorded } = await direct(mapId, openWaypoint("grilling", [1]));

    expect(recorded.ok).toBe(true);
    expect(runById(mapId, drafting.id).state).toBe("running");
    expect(waypointOf(context, mapId, 4).status).toBe("claimed");
    const drafted = recordSpecs(context.user, context.db, drafting.id, {
      specs: [{ specNumber: null, content: SPEC }],
      waits: [],
    });
    expect(drafted.ok).toBe(true);
    const [revision] = readMapRevisions(context.db, mapId);
    if (revision === undefined) throw new Error("No revision");
    const approved = approveSpecRevision(context.user, context.db, { specRevisionId: revision.id });
    expect(approved.ok ? null : approved.error.code).toBe("map_uncleared");

    resolve(context, mapId, 4);
    cleanPass(context, mapId);

    const reclear = runningMapRun(context, mapId);
    expect(reclear.purpose).toBe("to_spec");
    expect(reclear.id).not.toBe(drafting.id);
  });
});

describe("reword", () => {
  test("a claimed waypoint with a running run: new title and question, run cancelled reopened, a fresh run with the note", async () => {
    const mapId = await chartedMap(context, project);
    const working = grillingRun(context, mapId, 1);

    const { recorded, message } = await direct(mapId, {
      kind: "reword",
      waypoint: 1,
      ...NEW_QUESTION,
    });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(runById(mapId, working.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "reopened",
    });
    // Returned to open, the frontier claims it again with a fresh run.
    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "claimed",
      ...NEW_QUESTION,
      hatchMessageId: message.id,
    });
    const fresh = grillingRun(context, mapId, 1);
    expect(fresh.id).not.toBe(working.id);
    const request = await grillRequest(fresh.id);
    expect(request.waypoint).toMatchObject(NEW_QUESTION);
    expect(request.note).toEqual(noteOf(message));
  });

  test("a waypoint with a pending round: the round is withdrawn superseded and the frontier asks again", async () => {
    const mapId = await chartedMap(context, project);
    ask(context, mapId, 1, false);
    const round = pendingRoundOn(context, mapId, 1);

    const { recorded } = await direct(mapId, { kind: "reword", waypoint: 1, ...NEW_QUESTION });

    expect(recorded.ok).toBe(true);
    expect(readRounds(context.db, mapId).find((r) => r.id === round.id)).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "superseded",
    });
    expect(runById(mapId, round.askedByRun).state).toBe("asked");
    const fresh = grillingRun(context, mapId, 1);
    expect(fresh.id).not.toBe(round.askedByRun);
    // The withdrawn round was never answered; the request leaves it out.
    expect((await grillRequest(fresh.id)).waypoint.rounds).toEqual([]);
  });

  test("a resolved waypoint is refused waypoint_state and nothing changes", async () => {
    const mapId = await chartedMap(context, project);
    resolve(context, mapId, 1);
    const before = readWaypoints(context.db, mapId);

    const { recorded, message } = await direct(mapId, {
      kind: "reword",
      waypoint: 1,
      ...NEW_QUESTION,
    });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBe("waypoint_state");
    expect(message.change).toBeNull();
    expect(readWaypoints(context.db, mapId)).toEqual(before);
  });
});

describe("rule_out_of_scope", () => {
  test("a waypoint with a pending round moves out_of_scope with its line; the round is withdrawn waypoint_out_of_scope", async () => {
    const mapId = await chartedMap(context, project);
    ask(context, mapId, 1, false);
    const round = pendingRoundOn(context, mapId, 1);
    const reason = "Choosing columns is out of scope.";

    const { recorded, message, hatchRun } = await direct(mapId, {
      kind: "rule_out_of_scope",
      waypoint: 1,
      reason,
      fog: NO_MAP_CHANGES,
    });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    const ruled = waypointOf(context, mapId, 1);
    expect(ruled).toMatchObject({ status: "out_of_scope", hatchMessageId: message.id });
    expect(
      context.db.select().from(mapExclusions).where(eq(mapExclusions.mapId, mapId)).all(),
    ).toMatchObject([{ text: reason, waypointId: ruled.id, createdByRun: hatchRun.id }]);
    expect(readRounds(context.db, mapId).find((r) => r.id === round.id)).toMatchObject({
      status: "withdrawn",
      withdrawnReason: "waypoint_out_of_scope",
    });
    // Its dependents are unblocked: an out-of-scope blocker is settled.
    expect(waypointOf(context, mapId, 2).status).toBe("claimed");
  });

  test("a claimed waypoint's running run is cancelled reopened", async () => {
    const mapId = await chartedMap(context, project);
    const working = grillingRun(context, mapId, 1);

    const { recorded } = await direct(mapId, {
      kind: "rule_out_of_scope",
      waypoint: 1,
      reason: "Choosing columns is out of scope.",
      fog: NO_MAP_CHANGES,
    });

    expect(recorded.ok).toBe(true);
    expect(runById(mapId, working.id)).toMatchObject({
      state: "cancelled",
      cancelReason: "reopened",
    });
    expect(waypointOf(context, mapId, 1).status).toBe("out_of_scope");
  });

  test("ruling out the last open or claimed waypoint with fog left applies; the map's fog run settles the fog", async () => {
    const mapId = await kindsMap();
    researchOn(mapId, 1, ANSWERED);
    taskOn(mapId, 2, DONE);
    grillingRun(context, mapId, 3);
    const change: HatchChange = {
      kind: "rule_out_of_scope",
      waypoint: 3,
      reason: "Ordering the migration is out of scope.",
      fog: NO_MAP_CHANGES,
    };

    const { recorded } = await direct(mapId, change);

    expect(recorded.ok).toBe(true);
    expect(waypointOf(context, mapId, 3).status).toBe("out_of_scope");
    expect(context.db.select().from(mapFog).where(eq(mapFog.mapId, mapId)).all()).not.toEqual([]);
    expect(runningMapRun(context, mapId).purpose).toBe("fog");
  });

  test("a resolved or out-of-scope waypoint is refused waypoint_state", async () => {
    const mapId = await chartedMap(context, project);
    resolve(context, mapId, 1);
    const ruled = await direct(mapId, {
      kind: "rule_out_of_scope",
      waypoint: 2,
      reason: "Encodings are out of scope.",
      fog: NO_MAP_CHANGES,
    });
    expect(ruled.message.refusal).toBeNull();
    for (const number of [1, 2]) {
      const { recorded, message } = await direct(mapId, {
        kind: "rule_out_of_scope",
        waypoint: number,
        reason: "Out of scope.",
        fog: NO_MAP_CHANGES,
      });
      expect(recorded.ok).toBe(true);
      expect(message.refusal).toBe("waypoint_state");
    }
    expect(waypointOf(context, mapId, 1).status).toBe("resolved");
    expect(waypointOf(context, mapId, 2).status).toBe("out_of_scope");
  });
});

describe("run_waypoint", () => {
  test("a waypoint waiting on an unanswered report is claimed with a fresh research run carrying the note", async () => {
    const mapId = await kindsMap();
    researchOn(mapId, 1, UNANSWERED);
    expect(waypointOf(context, mapId, 1).status).toBe("open");

    const { recorded, message } = await direct(mapId, { kind: "run_waypoint", waypoint: 1 });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "claimed",
      hatchMessageId: message.id,
    });
    const fresh = grillingRun(context, mapId, 1);
    expect(fresh).toMatchObject({ purpose: "research", retryOfRunId: null });
    expect((await researchRequest(fresh.id)).note).toEqual(noteOf(message));
  });

  test("a waypoint waiting on a failed task is claimed with a fresh task run carrying the note", async () => {
    const mapId = await kindsMap();
    taskOn(mapId, 2, FAILED);

    const { recorded, message } = await direct(mapId, { kind: "run_waypoint", waypoint: 2 });

    expect(recorded.ok).toBe(true);
    const fresh = grillingRun(context, mapId, 2);
    expect(fresh.purpose).toBe("task");
    expect((await taskRequest(fresh.id)).note).toEqual(noteOf(message));
  });

  test("a waypoint stopped after a failed retry is claimed with a fresh run of its kind carrying the note", async () => {
    const mapId = await chartedMap(context, project);
    const failure = { code: "agent_timed_out", message: "The agent timed out" } as const;
    const first = grillingRun(context, mapId, 1);
    failRun(context.user, context.db, first.id, failure);
    const retry = grillingRun(context, mapId, 1);
    expect(retry.retryOfRunId).toBe(first.id);
    failRun(context.user, context.db, retry.id, failure);
    expect(waypointOf(context, mapId, 1).status).toBe("open");

    const { recorded, message } = await direct(mapId, { kind: "run_waypoint", waypoint: 1 });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    expect(waypointOf(context, mapId, 1)).toMatchObject({
      status: "claimed",
      hatchMessageId: message.id,
    });
    const fresh = grillingRun(context, mapId, 1);
    expect(fresh).toMatchObject({ purpose: "grilling", retryOfRunId: null });
    expect((await grillRequest(fresh.id)).note).toEqual(noteOf(message));
  });

  test("a waypoint not waiting is refused waypoint_not_waiting", async () => {
    const mapId = await kindsMap();
    const working = grillingRun(context, mapId, 1);
    for (const number of [1, 3]) {
      const { recorded, message } = await direct(mapId, { kind: "run_waypoint", waypoint: number });
      expect(recorded.ok).toBe(true);
      expect(message.refusal).toBe("waypoint_not_waiting");
    }
    expect(runById(mapId, working.id).state).toBe("running");
    expect(waypointOf(context, mapId, 3)).toMatchObject({ status: "open", hatchMessageId: null });
  });
});

describe("accept_report", () => {
  test("the hatch request carries the unanswered report it waits on, and only for that waypoint", async () => {
    const mapId = await kindsMap();
    researchOn(mapId, 1, UNANSWERED);
    const sent = await sendHatchMessage(
      context.user,
      context.db,
      { mapId, stage: "wayfinding", specNumber: null, text: "Accept the report on 1." },
      RUNNERS,
    );
    if (!sent.ok) throw new Error(sent.error.code);
    const messageId = sent.value.messages.at(-1)?.id;
    if (messageId === undefined) throw new Error("No message stored");

    const work = await workOf(hatchRunOf(mapId, messageId).id);

    if (work.purpose !== "hatch") throw new Error(work.purpose);
    expect(
      work.request.waypoints.map(({ number, waiting, report }) => ({ number, waiting, report })),
    ).toEqual([
      {
        number: 1,
        waiting: "research_unanswered",
        report: { summary: UNANSWERED.summary, gap: UNANSWERED.gap },
      },
      { number: 2, waiting: null, report: null },
      { number: 3, waiting: null, report: null },
    ]);
  });

  test("a waypoint waiting on an unanswered report resolves from its summary with the agent's gist, by the hatch run", async () => {
    const mapId = await kindsMap();
    researchOn(mapId, 1, UNANSWERED);
    const gist = "the proxy is unclear before Node 24";

    const { recorded, message, hatchRun } = await direct(mapId, {
      kind: "accept_report",
      waypoint: 1,
      gist,
      fog: NO_MAP_CHANGES,
    });

    expect(recorded.ok).toBe(true);
    expect(message.refusal).toBeNull();
    const resolved = waypointOf(context, mapId, 1);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: UNANSWERED.summary,
      gist,
      agentDecided: [],
      resolvedHow: "run",
      resolvedByRun: hatchRun.id,
    });
    expect(resolved.claimedAt).not.toBeNull();
    expect(resolved.resolvedAt).not.toBeNull();
  });

  test("a waypoint not waiting on a report (a failed task, a running one) is refused waypoint_not_waiting", async () => {
    const mapId = await kindsMap();
    taskOn(mapId, 2, FAILED);
    for (const number of [2, 1]) {
      const { recorded, message } = await direct(mapId, {
        kind: "accept_report",
        waypoint: number,
        gist: "accepted",
        fog: NO_MAP_CHANGES,
      });
      expect(recorded.ok).toBe(true);
      expect(message.refusal).toBe("waypoint_not_waiting");
    }
    expect(waypointOf(context, mapId, 2).status).toBe("open");
  });
});

describe("reopened research and task waypoints", () => {
  test("a reopened research waypoint's fresh run carries the note and drops its answered report; a reopened task's carries the note", async () => {
    const mapId = await kindsMap();
    researchOn(mapId, 1, ANSWERED);
    taskOn(mapId, 2, DONE);

    const research = await direct(mapId, { kind: "reopen", waypoint: 1 }, "That answer was wrong.");
    expect(research.recorded.ok).toBe(true);
    const researchRun = grillingRun(context, mapId, 1);
    expect(researchRun.purpose).toBe("research");
    const request = await researchRequest(researchRun.id);
    expect(request.note).toEqual(noteOf(research.message));
    expect(request.earlierReports).toEqual([]);

    const task = await direct(mapId, { kind: "reopen", waypoint: 2 }, "Count again.");
    expect(task.recorded.ok).toBe(true);
    const taskRun = grillingRun(context, mapId, 2);
    expect(taskRun.purpose).toBe("task");
    expect((await taskRequest(taskRun.id)).note).toEqual(noteOf(task.message));
  });

  test("a finding naming a reopened waypoint carries only the resolved ones, and none when every one was reopened", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, {
      ...CONFIRMATION,
      waypoints: CONFIRMATION.waypoints.map((w) => ({ ...w, blockedBy: [] })),
    });
    for (const number of [1, 2, 3]) resolve(context, mapId, number);
    const finding: ConsistencyFinding = {
      kind: "conflicting_surfaces",
      waypointNumbers: [1, 2],
      title: "Columns against encoding",
      explanation: "Waypoint 1 says every column; waypoint 2 says ASCII only.",
      question: "Which wins when a column holds non-ASCII text?",
    };
    const pass = recordConsistency(context.user, context.db, runningMapRun(context, mapId).id, {
      findings: [finding],
      proposals: [],
    });
    if (!pass.ok) throw new Error(pass.error.code);
    const findingRun = grillingRun(context, mapId, 4);

    await direct(mapId, { kind: "reopen", waypoint: 1 });
    expect((await grillRequest(findingRun.id)).finding).toMatchObject({
      waypoints: [{ number: 2 }],
    });

    await direct(mapId, { kind: "reopen", waypoint: 2 });
    expect((await grillRequest(findingRun.id)).finding).toBeNull();
  });
});
