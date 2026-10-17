import { ConfirmProposalInput, HATCH_REPLY_MAX_LENGTH, HatchRefusal } from "@zenorm/contracts";
import type {
  ChartConfirmation,
  HatchChange,
  HatchOutcome,
  PlanningRun,
  Project,
  ReplyThroughHatchRequest,
  SendHatchMessageInput,
} from "@zenorm/contracts";
import {
  hatchMessages,
  mapExclusions,
  mapProposals,
  maps,
  planningRuns,
  questionRounds,
} from "@zenorm/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import { recordHatchReply, recordHatchReplyWith, REFUSAL_SENTENCES } from "./hatch-runs.ts";
import type { HatchApplied, HatchAppliers } from "./hatch-runs.ts";
import { getMapOverview } from "./map-overview.ts";
import { confirmProposal, dismissProposal } from "./map-proposals.ts";
import { cancelRun, failRun, recordGrill, tryAgain, withdrawRound } from "./planning-runs.ts";
import { prepareRun } from "./run-work.ts";
import {
  CONFIRMATION,
  NO_MAP_CHANGES,
  addProject,
  ANSWERS,
  answerDestination,
  ask,
  chartedMap,
  cleanPass,
  clearedMap,
  closeTestContext,
  confirm,
  deleteRunningTicketsReview,
  draftedTicketSet,
  grillingRun,
  insertTicketsRepair,
  insertTicketsReview,
  insertTicketsReviewRun,
  newMap,
  openTestContext,
  pendingRoundOn,
  propose,
  resolve,
  ROUND,
  runningMapRun,
  runsOf,
  TICKETS_DECISION_FINDING,
  TICKETS_REVISE_FINDING,
  waypointOf,
  writeTestData,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };
const REPLY = "Yes: any depth.";
const TIMED_OUT = { code: "agent_timed_out", message: "The agent timed out" } as const;

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-hatch-runs-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

async function overview(mapId: string) {
  const read = await getMapOverview(context.db, mapId, RUNNERS);
  if (!read.ok) throw new Error(read.error.code);
  return read.value;
}

/** Sends `text` from Wayfinding; returns the message id. */
async function send(mapId: string, text: string): Promise<string> {
  const input: SendHatchMessageInput = { mapId, stage: "wayfinding", specNumber: null, text };
  const sent = await sendHatchMessage(context.user, context.db, input, RUNNERS);
  if (!sent.ok) throw new Error(sent.error.code);
  const message = sent.value.messages.at(-1);
  if (message === undefined) throw new Error("The message was not stored");
  return message.id;
}

function message(id: string) {
  const row = context.db.select().from(hatchMessages).where(eq(hatchMessages.id, id)).get();
  if (row === undefined) throw new Error(`No message ${id}`);
  return row;
}

function hatchRunsOf(mapId: string): PlanningRun[] {
  return runsOf(context, mapId).filter((run) => run.purpose === "hatch");
}

/** The map's one running hatch run. */
function runningHatch(mapId: string): PlanningRun {
  const running = hatchRunsOf(mapId).filter((run) => run.state === "running");
  const [run] = running;
  if (run === undefined || running.length !== 1) {
    throw new Error(`Map ${mapId} has ${String(running.length)} running hatch runs`);
  }
  return run;
}

function run(id: string): PlanningRun {
  const row = context.db.select().from(planningRuns).where(eq(planningRuns.id, id)).get();
  if (row === undefined) throw new Error(`No run ${id}`);
  return row;
}

async function request(runId: string): Promise<ReplyThroughHatchRequest> {
  const work = await prepareRun(context.db, runId);
  if (!work.ok) throw new Error(work.error.code);
  if (work.value.purpose !== "hatch") throw new Error(`Run ${runId} is ${work.value.purpose}`);
  return work.value.request;
}

function replyOnly(reply: string): HatchOutcome {
  return { reply, change: null };
}

/** Fails the running hatch run's attempt and its retry, so the message stops. */
function stopHatch(mapId: string): PlanningRun {
  failRun(context.user, context.db, runningHatch(mapId).id, TIMED_OUT);
  const retry = runningHatch(mapId);
  failRun(context.user, context.db, retry.id, TIMED_OUT);
  return run(retry.id);
}

/** Appliers that each answer `applied` (a stub for the dispatcher's own behaviour). */
function stubAppliers(applied: HatchApplied): HatchAppliers {
  const stub = () => applied;
  return {
    reopen: stub,
    open_waypoint: stub,
    reword: stub,
    rule_out_of_scope: stub,
    run_waypoint: stub,
    accept_report: stub,
    revise_spec: stub,
    rewrite_tickets: stub,
    propose_map: stub,
  };
}

const REWORD: HatchChange = {
  kind: "reword",
  waypoint: 1,
  title: "Pick the export's columns",
  question: "Which columns does the export carry?",
};

describe("the hatch queue (S7b-3)", () => {
  test("two messages on one map are answered oldest first, one run at a time", async () => {
    const mapId = await clearedMap(context, project);
    const first = await send(mapId, "Does nested mean any depth?");
    const second = await send(mapId, "What does the export skip?");

    const firstRun = runningHatch(mapId);
    expect(firstRun.hatchMessageId).toBe(first);
    expect((await overview(mapId)).messages.map((entry) => entry.status)).toEqual([
      { state: "working" },
      { state: "queued" },
    ]);

    expect(recordHatchReply(context.user, context.db, firstRun.id, replyOnly(REPLY)).ok).toBe(true);

    expect(runningHatch(mapId).hatchMessageId).toBe(second);
    expect(message(first).runId).toBe(firstRun.id);
  });

  test("messages on two maps are answered at once", async () => {
    const one = await clearedMap(context, project);
    const two = await clearedMap(context, project);

    await send(one, "Does nested mean any depth?");
    await send(two, "Does nested mean any depth?");

    expect([runningHatch(one).mapId, runningHatch(two).mapId]).toEqual([one, two]);
  });

  test("no hatch run starts while the map's chart runs or awaits its retry", async () => {
    const mapId = await newMap(context, project, "Export data");
    const sent = await send(mapId, "Does nested mean any depth?");

    expect(hatchRunsOf(mapId)).toEqual([]);
    failRun(context.user, context.db, runningMapRun(context, mapId).id, TIMED_OUT);
    expect(hatchRunsOf(mapId)).toEqual([]);
    expect((await overview(mapId)).messages.map((entry) => entry.status)).toEqual([
      { state: "queued" },
    ]);

    propose(context, mapId);

    expect(runningHatch(mapId).hatchMessageId).toBe(sent);
  });

  test("a failed run retries; failed twice it stops with its run id, holds the queue, and Try again answers it", async () => {
    const mapId = await clearedMap(context, project);
    const first = await send(mapId, "Does nested mean any depth?");
    const second = await send(mapId, "What does the export skip?");
    const activity = (await overview(mapId)).activity;

    const attempt = runningHatch(mapId);
    failRun(context.user, context.db, attempt.id, TIMED_OUT);
    const retry = runningHatch(mapId);
    expect([retry.retryOfRunId, retry.hatchMessageId]).toEqual([attempt.id, first]);
    expect((await overview(mapId)).messages[0]?.status).toEqual({ state: "working" });

    failRun(context.user, context.db, retry.id, TIMED_OUT);

    const stopped = await overview(mapId);
    expect(stopped.messages.map((entry) => entry.status)).toEqual([
      { state: "stopped", stopped: { runId: retry.id, code: "agent_timed_out" } },
      { state: "queued" },
    ]);
    expect(message(first).reply).toBeNull();
    expect(hatchRunsOf(mapId).filter((candidate) => candidate.state === "running")).toEqual([]);
    // A failed hatch run adds no activity line (L148).
    expect(stopped.activity).toEqual(activity);

    const tried = tryAgain(context.user, context.db, retry.id);
    expect(tried).toEqual({ ok: true, value: mapId });
    const fresh = runningHatch(mapId);
    expect([fresh.retryOfRunId, fresh.hatchMessageId]).toEqual([null, first]);

    expect(recordHatchReply(context.user, context.db, fresh.id, replyOnly(REPLY)).ok).toBe(true);
    expect(message(first).reply).toBe(REPLY);
    expect(runningHatch(mapId).hatchMessageId).toBe(second);
  });

  test("L162 (7): Try again on a stopped message starts nothing while the chart runs or awaits its retry", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    const sent = await send(mapId, "Does nested mean any depth?");
    const attempt = runningHatch(mapId);
    failRun(context.user, context.db, attempt.id, TIMED_OUT);
    const retry = runningHatch(mapId);
    failRun(context.user, context.db, retry.id, TIMED_OUT);
    // Answering the destination round starts the chart again.
    answerDestination(context, mapId);
    const chart = runningMapRun(context, mapId);
    expect(chart.purpose).toBe("chart");

    const whileRunning = tryAgain(context.user, context.db, retry.id);
    failRun(context.user, context.db, chart.id, TIMED_OUT);
    const whileAwaitingRetry = tryAgain(context.user, context.db, retry.id);

    for (const refused of [whileRunning, whileAwaitingRetry]) {
      expect(refused.ok ? null : refused.error.code).toBe("planning_run_not_stopped");
    }
    expect(hatchRunsOf(mapId).filter((run) => run.state === "running")).toEqual([]);

    confirm(context, mapId, CONFIRMATION);
    expect(tryAgain(context.user, context.db, retry.id)).toEqual({ ok: true, value: mapId });
    expect(runningHatch(mapId)).toMatchObject({ hatchMessageId: sent, retryOfRunId: null });
  });

  test("the request carries the message, the map and the replied earlier messages only", async () => {
    const mapId = await chartedMap(context, project);
    const first = await send(mapId, "Does nested mean any depth?");
    expect(
      recordHatchReply(context.user, context.db, runningHatch(mapId).id, replyOnly(REPLY)).ok,
    ).toBe(true);
    await send(mapId, "What does the export skip?");
    await send(mapId, "Still queued");

    const sent = await request(runningHatch(mapId).id);

    expect(sent.message).toEqual({
      stage: "wayfinding",
      specNumber: null,
      text: "What does the export skip?",
    });
    expect(sent.earlierMessages).toEqual([
      { stage: "wayfinding", specNumber: null, text: "Does nested mean any depth?", reply: REPLY },
    ]);
    expect(
      sent.waypoints.map((waypoint) => [waypoint.number, waypoint.status, waypoint.blockedBy]),
    ).toEqual([
      [1, "claimed", []],
      [2, "open", [1]],
      [3, "open", [1]],
    ]);
    expect([sent.specs, sent.refusedAttempt]).toEqual([[], null]);
    expect(message(first).repliedAt).not.toBeNull();
  });
});

describe("a hatch run's outcome (S7b-4)", () => {
  test("a reply with no change is stored with its run in one transaction; the message reads replied", async () => {
    const mapId = await clearedMap(context, project);
    const sent = await send(mapId, "Does nested mean any depth?");
    const hatch = runningHatch(mapId);

    expect(recordHatchReply(context.user, context.db, hatch.id, replyOnly(REPLY))).toEqual({
      ok: true,
      value: null,
    });

    const row = message(sent);
    expect([row.runId, row.reply, row.refusal, row.change]).toEqual([hatch.id, REPLY, null, null]);
    expect(row.repliedAt).not.toBeNull();
    expect(run(hatch.id).state).toBe("completed");
    const [view] = (await overview(mapId)).messages;
    expect(view?.status).toMatchObject({ state: "replied", reply: REPLY, refusal: null });
  });

  test.each([
    ["empty", ""],
    ["too long", "x".repeat(HATCH_REPLY_MAX_LENGTH + 1)],
  ])("a reply that is %s fails the run agent_output_invalid and retries", async (_name, reply) => {
    const mapId = await clearedMap(context, project);
    const sent = await send(mapId, "Does nested mean any depth?");
    const hatch = runningHatch(mapId);

    const recorded = recordHatchReply(context.user, context.db, hatch.id, replyOnly(reply));

    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(run(hatch.id).errorCode).toBe("agent_output_invalid");
    expect(runningHatch(mapId).retryOfRunId).toBe(hatch.id);
    expect(message(sent).reply).toBeNull();
  });

  test("a change naming an unknown waypoint fails hatch_change_invalid; its retry and Try again carry the problem", async () => {
    const mapId = await chartedMap(context, project);
    const sent = await send(mapId, "Reopen waypoint 9");
    const hatch = runningHatch(mapId);
    const unknown: HatchChange = { kind: "reopen", waypoint: 9 };

    const recorded = recordHatchReply(context.user, context.db, hatch.id, {
      reply: REPLY,
      change: unknown,
    });

    expect(!recorded.ok && recorded.error.code).toBe("hatch_change_invalid");
    expect(message(sent).reply).toBeNull();
    const retry = runningHatch(mapId);
    expect((await request(retry.id)).refusedAttempt).toEqual({
      problem: run(hatch.id).errorMessage,
    });

    const again = recordHatchReply(context.user, context.db, retry.id, {
      reply: REPLY,
      change: unknown,
    });
    expect(!again.ok && again.error.code).toBe("hatch_change_invalid");
    expect(tryAgain(context.user, context.db, retry.id).ok).toBe(true);
    const fresh = runningHatch(mapId);
    expect((await request(fresh.id)).refusedAttempt).toEqual({
      problem: run(retry.id).errorMessage,
    });
  });

  test.each<[string, HatchChange]>([
    [
      "an unknown fog position",
      {
        kind: "rule_out_of_scope",
        waypoint: 2,
        reason: "Not this effort.",
        fog: { ...NO_MAP_CHANGES, fogOutOfScope: [{ position: 4, line: "Not now." }] },
      },
    ],
    [
      "fog settled by a resolution of its own, which a hatch change does not write",
      {
        kind: "rule_out_of_scope",
        waypoint: 2,
        reason: "Not this effort.",
        fog: { ...NO_MAP_CHANGES, fogSettledHere: [1] },
      },
    ],
    [
      "an unknown blocker of a new waypoint",
      {
        kind: "open_waypoint",
        waypointKind: "grilling",
        title: "Decide the file name",
        question: "What is the export's file called?",
        blockedBy: [7],
        fog: NO_MAP_CHANGES,
      },
    ],
  ])("a change naming %s fails hatch_change_invalid before any applier", async (_name, change) => {
    const mapId = await chartedMap(context, project);
    await send(mapId, "Change it");
    const hatch = runningHatch(mapId);
    const reached = recordHatchReplyWith(stubAppliers({ result: "applied" }));

    const recorded = reached(context.user, context.db, hatch.id, { reply: REPLY, change });

    expect(!recorded.ok && recorded.error.code).toBe("hatch_change_invalid");
  });

  test("an applied change is stored with the reply", async () => {
    const mapId = await chartedMap(context, project);
    const sent = await send(mapId, "Rename waypoint 1");
    const hatch = runningHatch(mapId);

    const recorded = recordHatchReplyWith(stubAppliers({ result: "applied" }))(
      context.user,
      context.db,
      hatch.id,
      { reply: REPLY, change: REWORD },
    );

    expect(recorded.ok).toBe(true);
    const row = message(sent);
    expect([row.reply, row.refusal, row.change]).toEqual([REPLY, null, REWORD]);
  });

  test("an applier's invalid change fails the run with its code and the retry carries the problem", async () => {
    const mapId = await chartedMap(context, project);
    await send(mapId, "Rule waypoint 1 out");
    const hatch = runningHatch(mapId);
    const failure = { code: "hatch_change_invalid", message: "The change is invalid" } as const;

    const recorded = recordHatchReplyWith(stubAppliers({ result: "invalid", failure }))(
      context.user,
      context.db,
      hatch.id,
      { reply: REPLY, change: REWORD },
    );

    expect(!recorded.ok && recorded.error.code).toBe("hatch_change_invalid");
    expect((await request(runningHatch(mapId).id)).refusedAttempt).toEqual({
      problem: failure.message,
    });
  });
});

describe("a refused change (S7b-5)", () => {
  // `spec_in_flight` reads the spec's work for its sentence (L180 (1)); notes.test.ts covers it.
  test.each(HatchRefusal.exclude(["spec_in_flight"]).options)(
    "%s stores core's sentence and the code, writes nothing else and starts no retry",
    async (refusal) => {
      const mapId = await chartedMap(context, project);
      const sent = await send(mapId, "Rename waypoint 1");
      const hatch = runningHatch(mapId);
      const before = await overview(mapId);
      const otherRuns = runsOf(context, mapId).filter((other) => other.id !== hatch.id);

      const recorded = recordHatchReplyWith(stubAppliers({ result: "refused", refusal }))(
        context.user,
        context.db,
        hatch.id,
        { reply: REPLY, change: REWORD },
      );

      expect(recorded.ok).toBe(true);
      const row = message(sent);
      expect([row.reply, row.refusal, row.change, row.runId]).toEqual([
        REFUSAL_SENTENCES[refusal],
        refusal,
        null,
        hatch.id,
      ]);
      expect(run(hatch.id).state).toBe("completed");
      expect(runsOf(context, mapId).filter((other) => other.id !== hatch.id)).toEqual(otherRuns);
      const after = await overview(mapId);
      expect([after.status, after.activity, after.wayfinding, after.specs]).toEqual([
        before.status,
        before.activity,
        before.wayfinding,
        before.specs,
      ]);
    },
  );
});

describe("a hatch run and the map's status (D6)", () => {
  test("a working or stopped hatch run moves no status and adds no line", async () => {
    const mapId = await chartedMap(context, project);
    const before = await overview(mapId);

    await send(mapId, "Does nested mean any depth?");
    const working = await overview(mapId);
    stopHatch(mapId);
    const stopped = await overview(mapId);

    for (const after of [working, stopped]) {
      expect([after.status, after.activity, after.wayfinding]).toEqual([
        before.status,
        before.activity,
        before.wayfinding,
      ]);
    }
  });

  test("a running hatch run neither delays nor blocks the consistency pass or map-scope to_spec", async () => {
    const mapId = await chartedMap(context, project);
    await send(mapId, "Does nested mean any depth?");
    const hatch = runningHatch(mapId);

    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    resolve(context, mapId, 3);
    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
    cleanPass(context, mapId);

    expect(runningMapRun(context, mapId).purpose).toBe("to_spec");
    expect(run(hatch.id).state).toBe("running");
  });

  test("a stopped hatch run does not block the consistency pass", async () => {
    const mapId = await chartedMap(context, project);
    await send(mapId, "Does nested mean any depth?");
    stopHatch(mapId);

    resolve(context, mapId, 1);
    resolve(context, mapId, 2);
    resolve(context, mapId, 3);

    expect(runningMapRun(context, mapId).purpose).toBe("consistency");
  });
});

describe("the primitives a reopen and the directions share (S7b-6)", () => {
  test("a run cancelled reopened that then returns a result saves nothing and is not retried", async () => {
    const mapId = await chartedMap(context, project);
    const sent = await send(mapId, "Does nested mean any depth?");
    const grilling = grillingRun(context, mapId, 1);
    const hatch = runningHatch(mapId);

    const cancelled = writeTestData(context, (tx) => [
      cancelRun(tx, grilling.id, "reopened"),
      cancelRun(tx, hatch.id, "reopened"),
      cancelRun(tx, grilling.id, "reopened"),
    ]);
    expect(cancelled).toEqual([true, true, false]);
    const runsBefore = runsOf(context, mapId);

    const grilled = recordGrill(context.user, context.db, grilling.id, {
      round: null,
      resolution: { resolution: "Resolved 1.", gist: "Gist 1", agentDecided: [] },
      outOfScope: null,
      mapChanges: NO_MAP_CHANGES,
    });
    const replied = recordHatchReply(context.user, context.db, hatch.id, replyOnly(REPLY));
    failRun(context.user, context.db, grilling.id, TIMED_OUT);

    expect([grilled, replied]).toEqual([
      { ok: true, value: null },
      { ok: true, value: null },
    ]);
    expect(runsOf(context, mapId)).toEqual(runsBefore);
    expect([run(grilling.id).state, run(grilling.id).cancelReason]).toEqual([
      "cancelled",
      "reopened",
    ]);
    expect(waypointOf(context, mapId, 1).resolution).toBeNull();
    expect(message(sent).reply).toBeNull();
  });

  test("a withdrawn round carries its reason and time", async () => {
    const mapId = await chartedMap(context, project);
    ask(context, mapId, 1, false);
    const round = pendingRoundOn(context, mapId, 1);

    writeTestData(context, (tx) => {
      withdrawRound(tx, round.id, "superseded");
    });

    const row = context.db
      .select()
      .from(questionRounds)
      .where(eq(questionRounds.id, round.id))
      .get();
    expect([row?.status, row?.withdrawnReason]).toEqual(["withdrawn", "superseded"]);
    expect(row?.withdrawnAt).not.toBeNull();
    expect(() => {
      writeTestData(context, (tx) => {
        withdrawRound(tx, round.id, "waypoint_out_of_scope");
      });
    }).toThrow();
  });
});

describe("the hatch request's tickets review and stopped waypoints (slice 7c D8)", () => {
  /**
   * A map whose spec has ticket set v1 and a running hatch run; the review the set's writing
   * started is deleted after the message, so each test inserts the `tickets_review` rows it reads.
   */
  async function setWithHatch() {
    const drafted = await draftedTicketSet(context, project);
    await send(drafted.mapId, "What is the tickets review checking?");
    deleteRunningTicketsReview(context, drafted.mapId);
    return { ...drafted, hatch: runningHatch(drafted.mapId) };
  }

  test("S7c-13: a running tickets_review is listed in flight and reads running", async () => {
    const { mapId, specificationId, hatch } = await setWithHatch();
    insertTicketsReviewRun(context, { mapId, specificationId, state: "running" });

    const [spec] = (await request(hatch.id)).specs;

    expect(spec?.inFlight).toEqual(["tickets_review"]);
    expect(spec?.ticketSet).toEqual({
      version: 1,
      state: "awaiting_review",
      review: "running",
      heldFindings: null,
    });
  });

  test("S7c-13: a stopped tickets_review is listed in flight and reads stopped", async () => {
    const { mapId, specificationId, hatch } = await setWithHatch();
    insertTicketsReviewRun(context, { mapId, specificationId, state: "stopped" });

    const [spec] = (await request(hatch.id)).specs;

    expect(spec?.inFlight).toEqual(["tickets_review"]);
    expect(spec?.ticketSet?.review).toBe("stopped");
    expect(spec?.ticketSet?.heldFindings).toBeNull();
  });

  test("a set with no review run and none recorded reads none", async () => {
    const { hatch } = await setWithHatch();

    const [spec] = (await request(hatch.id)).specs;

    expect(spec?.inFlight).toEqual([]);
    expect(spec?.ticketSet?.review).toBe("none");
  });

  test("a recorded review reads passed, or failed when no finding escalated", async () => {
    const { mapId, specificationId, ticketSetId, hatch } = await setWithHatch();
    insertTicketsReview(context, { mapId, specificationId, ticketSetId, findings: [] });

    expect((await request(hatch.id)).specs[0]?.ticketSet).toEqual({
      version: 1,
      state: "review_passed",
      review: "passed",
      heldFindings: null,
    });

    insertTicketsRepair(context, { mapId, specificationId, ticketSetId, state: "completed" });
    const findings = [{ finding: TICKETS_REVISE_FINDING, escalated: false }];
    insertTicketsReview(context, { mapId, specificationId, ticketSetId, findings });

    expect((await request(hatch.id)).specs[0]?.ticketSet).toEqual({
      version: 2,
      state: "review_failed",
      review: "failed",
      heldFindings: null,
    });
  });

  test("S7c-13: a held set carries held and each escalated finding's title and question", async () => {
    const { mapId, specificationId, ticketSetId, hatch } = await setWithHatch();
    const findings = [
      { finding: TICKETS_REVISE_FINDING, escalated: false },
      { finding: TICKETS_DECISION_FINDING, escalated: true },
    ];
    insertTicketsReview(context, { mapId, specificationId, ticketSetId, findings });

    const [spec] = (await request(hatch.id)).specs;

    expect(spec?.inFlight).toEqual([]);
    expect(spec?.ticketSet).toEqual({
      version: 1,
      state: "review_failed",
      review: "held",
      heldFindings: [
        { title: TICKETS_DECISION_FINDING.title, question: TICKETS_DECISION_FINDING.question },
      ],
    });
  });

  test("S7c-14: a waypoint stopped after a failed retry is marked stopped; the others are not", async () => {
    const mapId = await chartedMap(context, project);
    failRun(context.user, context.db, grillingRun(context, mapId, 1).id, TIMED_OUT);
    failRun(context.user, context.db, grillingRun(context, mapId, 1).id, TIMED_OUT);
    expect(waypointOf(context, mapId, 1).status).toBe("open");
    await send(mapId, "Why did waypoint 1 stop?");

    const sent = await request(runningHatch(mapId).id);

    expect(sent.waypoints.map((waypoint) => [waypoint.number, waypoint.stopped])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(sent.waypoints[0]?.waiting).toBeNull();
  });

  test("S7c-14: a waypoint whose first attempt failed and awaits its retry is not stopped", async () => {
    const mapId = await chartedMap(context, project);
    failRun(context.user, context.db, grillingRun(context, mapId, 1).id, TIMED_OUT);
    await send(mapId, "Is waypoint 1 running?");

    const sent = await request(runningHatch(mapId).id);

    expect(sent.waypoints[0]?.stopped).toBe(false);
  });
});

describe("a hatch reply proposing a map (map proposals, C2)", () => {
  type ProposeMap = Extract<HatchChange, { kind: "propose_map" }>;
  const LINE = "Moving a project between folders is a later effort.";
  const IDEA = "Move a project to another folder.";
  const OWN_LINE = "JSON exports are their own effort.";

  /** A map charted with `waypoints` and one Out of scope line, at position 1. */
  async function mapWithLine(waypoints: ChartConfirmation["waypoints"]): Promise<string> {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    answerDestination(context, mapId);
    confirm(context, mapId, { ...CONFIRMATION, waypoints, outOfScope: [LINE] });
    return mapId;
  }

  /** A `propose_map` splitting off the map's Out of scope line at `position`. */
  function splitOff(position: number): ProposeMap {
    return {
      kind: "propose_map",
      title: "Split off",
      idea: IDEA,
      line: null,
      splitsLine: position,
    };
  }

  /** Sends a message and records its hatch run's reply with `change`; returns the message id. */
  async function replyWith(mapId: string, change: HatchChange): Promise<string> {
    const sent = await send(mapId, "Make that its own map.");
    const hatch = runningHatch(mapId);
    const recorded = recordHatchReply(context.user, context.db, hatch.id, { reply: REPLY, change });
    if (!recorded.ok) throw new Error(recorded.error.code);
    return sent;
  }

  function proposalRows(mapId: string) {
    return context.db
      .select()
      .from(mapProposals)
      .where(eq(mapProposals.mapId, mapId))
      .orderBy(asc(mapProposals.id))
      .all();
  }

  function exclusionRows(mapId: string) {
    return context.db.select().from(mapExclusions).where(eq(mapExclusions.mapId, mapId)).all();
  }

  function mapCount(): number {
    return context.db.select().from(maps).all().length;
  }

  function confirmIt(proposalId: string) {
    const input = ConfirmProposalInput.parse({ proposalId, idea: IDEA });
    return confirmProposal(context.user, context.db, input);
  }

  test("with its own line saves a pending proposal by the hatch run, and no Out of scope line yet", async () => {
    const mapId = await mapWithLine(CONFIRMATION.waypoints);
    const change: ProposeMap = { ...splitOff(1), line: OWN_LINE, splitsLine: null };

    const sent = await replyWith(mapId, change);

    const row = message(sent);
    expect([row.reply, row.refusal, row.change]).toEqual([REPLY, null, change]);
    expect(proposalRows(mapId)).toMatchObject([
      {
        idea: IDEA,
        line: OWN_LINE,
        waypointId: null,
        exclusionPosition: null,
        state: "pending",
        createdByRun: row.runId,
      },
    ]);
    expect(exclusionRows(mapId)).toMatchObject([{ position: 1, text: LINE, splitMapId: null }]);
    expect((await overview(mapId)).wayfinding.proposals).toMatchObject([
      { idea: IDEA, line: OWN_LINE, waypoint: null, splitsLine: null, state: "pending" },
    ]);
  });

  test("splitting off a line saves a pending proposal naming it, with no line of its own", async () => {
    const mapId = await mapWithLine(CONFIRMATION.waypoints);

    await replyWith(mapId, splitOff(1));

    expect(proposalRows(mapId)).toMatchObject([
      { idea: IDEA, line: null, waypointId: null, exclusionPosition: 1, state: "pending" },
    ]);
    expect(exclusionRows(mapId)).toMatchObject([{ position: 1, text: LINE, splitMapId: null }]);
    expect((await overview(mapId)).wayfinding.proposals).toMatchObject([
      { line: null, waypoint: null, splitsLine: { position: 1, text: LINE } },
    ]);
  });

  test("an idea outside its bounds fails the run agent_output_invalid and saves nothing", async () => {
    const mapId = await mapWithLine(CONFIRMATION.waypoints);
    const sent = await send(mapId, "Make that its own map.");
    const hatch = runningHatch(mapId);

    const recorded = recordHatchReply(context.user, context.db, hatch.id, {
      reply: REPLY,
      change: { ...splitOff(1), idea: "i".repeat(4001) },
    });

    expect(!recorded.ok && recorded.error.code).toBe("agent_output_invalid");
    expect(message(sent).reply).toBeNull();
    expect(proposalRows(mapId)).toEqual([]);
  });

  /** Sends a split of `position` and records it with the real appliers; checks the refusal stored. */
  async function expectRefused(
    mapId: string,
    position: number,
    refusal: "exclusion_not_found" | "exclusion_already_split",
  ): Promise<void> {
    const sent = await send(mapId, "Make that line its own map.");
    const hatch = runningHatch(mapId);
    const otherRuns = runsOf(context, mapId).filter((other) => other.id !== hatch.id);
    const proposalsBefore = proposalRows(mapId);
    const exclusionsBefore = exclusionRows(mapId);

    const recorded = recordHatchReply(context.user, context.db, hatch.id, {
      reply: REPLY,
      change: splitOff(position),
    });

    expect(recorded.ok).toBe(true);
    const row = message(sent);
    expect([row.reply, row.refusal, row.change, row.runId]).toEqual([
      REFUSAL_SENTENCES[refusal],
      refusal,
      null,
      hatch.id,
    ]);
    expect(run(hatch.id).state).toBe("completed");
    // No retry: the map's other runs are as they were.
    expect(runsOf(context, mapId).filter((other) => other.id !== hatch.id)).toEqual(otherRuns);
    expect(proposalRows(mapId)).toEqual(proposalsBefore);
    expect(exclusionRows(mapId)).toEqual(exclusionsBefore);
  }

  test("naming a position with no line is refused exclusion_not_found: core's sentence, nothing saved, no retry (2.4)", async () => {
    const mapId = await mapWithLine(CONFIRMATION.waypoints);

    await expectRefused(mapId, 2, "exclusion_not_found");

    expect(proposalRows(mapId)).toEqual([]);
  });

  test("naming a line already linked to a map is refused exclusion_already_split: nothing saved, no retry (2.4)", async () => {
    const mapId = await mapWithLine(CONFIRMATION.waypoints);
    await replyWith(mapId, splitOff(1));
    const [first] = proposalRows(mapId);
    if (first === undefined) throw new Error("No proposal");
    expect((await confirmIt(first.id)).ok).toBe(true);

    await expectRefused(mapId, 1, "exclusion_already_split");

    expect(proposalRows(mapId)).toHaveLength(1);
  });

  test.each(["confirmed", "dismissed"] as const)(
    "a proposal splitting off a line, %s, leaves that line once in Out of scope (2.1)",
    async (decision) => {
      const mapId = await mapWithLine(CONFIRMATION.waypoints);
      await replyWith(mapId, splitOff(1));
      const [proposal] = proposalRows(mapId);
      if (proposal === undefined) throw new Error("No proposal");

      const decided =
        decision === "confirmed"
          ? await confirmIt(proposal.id)
          : dismissProposal(context.user, context.db, { proposalId: proposal.id });

      expect(decided.ok).toBe(true);
      const [after] = proposalRows(mapId);
      expect(after?.state).toBe(decision);
      const splitMapId = decision === "confirmed" ? after?.newMapId : null;
      if (splitMapId === undefined) throw new Error("No decided proposal");
      expect((await overview(mapId)).wayfinding.outOfScope).toEqual([
        { text: LINE, waypoint: null, splitMapId },
      ]);
    },
  );

  test("a proposal made after Spec started is saved and the map's stages are unchanged (2.2)", async () => {
    const mapId = await mapWithLine([]);
    const toSpec = runningMapRun(context, mapId);
    expect(toSpec.purpose).toBe("to_spec");
    const stages = (await overview(mapId)).status.stages;

    await replyWith(mapId, splitOff(1));

    expect(proposalRows(mapId)).toMatchObject([{ state: "pending", exclusionPosition: 1 }]);
    expect((await overview(mapId)).status.stages).toEqual(stages);
    expect(run(toSpec.id).state).toBe("running");
  });

  test("of two proposals naming one line, the first's confirm links it; the second's is refused exclusion_already_split and it can be dismissed (4.4)", async () => {
    const mapId = await mapWithLine(CONFIRMATION.waypoints);
    await replyWith(mapId, splitOff(1));
    await replyWith(mapId, splitOff(1));
    const [first, second] = proposalRows(mapId);
    if (first === undefined || second === undefined) throw new Error("Expected two proposals");

    const confirmed = await confirmIt(first.id);
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    expect(exclusionRows(mapId)).toMatchObject([
      { position: 1, text: LINE, splitMapId: confirmed.value.map.id },
    ]);
    const mapsBefore = mapCount();

    const refused = await confirmIt(second.id);

    expect(refused.ok ? null : refused.error.code).toBe("exclusion_already_split");
    expect(mapCount()).toBe(mapsBefore);
    expect(proposalRows(mapId)[1]).toMatchObject({ state: "pending", newMapId: null });
    expect(dismissProposal(context.user, context.db, { proposalId: second.id }).ok).toBe(true);
    expect(proposalRows(mapId)[1]?.state).toBe("dismissed");
    expect(exclusionRows(mapId)).toMatchObject([
      { position: 1, text: LINE, splitMapId: confirmed.value.map.id },
    ]);
  });
});

describe("the hatch request's destination rounds (DR-14, D7)", () => {
  test("carries the submitted map-level round, as stored", async () => {
    const mapId = await clearedMap(context, project);
    await send(mapId, "Does nested mean any depth?");
    expect((await request(runningHatch(mapId).id)).mapRounds).toEqual([
      { questions: ROUND.questions, answers: ANSWERS, final: false },
    ]);
  });

  test("carries a pending map-level round with null answers", async () => {
    const mapId = await newMap(context, project, "Export data");
    propose(context, mapId);
    await send(mapId, "Does nested mean any depth?");
    expect((await request(runningHatch(mapId).id)).mapRounds).toEqual([
      { questions: ROUND.questions, answers: null, final: false },
    ]);
  });

  test("carries no round before the first chart", async () => {
    const mapId = await newMap(context, project, "Export data");
    await send(mapId, "Does nested mean any depth?");
    const chart = runningMapRun(context, mapId);
    failRun(context.user, context.db, chart.id, TIMED_OUT);
    failRun(context.user, context.db, runningMapRun(context, mapId).id, TIMED_OUT);
    const hatch = await request(runningHatch(mapId).id);
    expect(hatch.destination).toBeNull();
    expect(hatch.mapRounds).toEqual([]);
  });
});
