import { MapStatus, NextActionLabel } from "@zenorm/contracts";
import type {
  NextAction,
  PlanningRun,
  SpecHoldKind,
  SpecWaitView,
  StageTone,
  TicketsReviewFindingRecord,
  Verdict,
} from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getMapOverview } from "./map-overview.ts";
import { WAIT_DETAIL, deriveStatus, mapStatus, runName } from "./map-status.ts";
import { rejectTicketSet } from "./planning.ts";
import { failRun, sweepInterruptedRuns } from "./planning-runs.ts";
import {
  FAILED_TICKETS_REVIEW,
  addProject,
  closeTestContext,
  draftedTicketSet,
  heldTicketSet,
  openTestContext,
  recordRunningTicketsReview,
  reviewedTicketSet,
  runningSpecRun,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";
import type {
  MapStatusInput,
  StatusReview,
  StatusRevision,
  StatusSpec,
  StatusTicketSet,
} from "./map-status.ts";

const AT = "2026-10-07T12:00:00.000Z";
const QUESTIONS = [
  {
    topic: "Scope",
    text: "What must the change cover?",
    options: [
      { label: "Narrow", detail: "Only the named screen." },
      { label: "Wide", detail: "Every screen." },
    ],
  },
];
const SPEC_IDS = [1, 2, 3, 4, 5].map((n) => `0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e9${String(n)}`);

function specId(number: number): string {
  const id = SPEC_IDS[number - 1];
  if (id === undefined) throw new Error(`No spec id ${String(number)}`);
  return id;
}

/** A revision on the map with three clauses: a draft, approved, rejected or superseded. */
function revision(
  state: "draft" | "approved" | "rejected" | "superseded",
  review: StatusReview,
  number: number,
): StatusRevision {
  return {
    revision: number,
    clauses: 3,
    approvedAt: state === "approved" ? AT : null,
    supersededAt: state === "rejected" || state === "superseded" ? AT : null,
    review,
  };
}

const APPROVED = revision("approved", "passed", 1);
/** An unapproved set whose current version's tickets review passed: it awaits approval. */
const SET_PENDING: StatusTicketSet = {
  tickets: 2,
  approvedAt: null,
  follows: false,
  replaced: false,
  anyDelivered: false,
  review: { state: "passed", summary: "Every criterion traces.", reviewedAt: AT },
};
const SET_APPROVED: StatusTicketSet = {
  tickets: 2,
  approvedAt: AT,
  review: null,
  follows: false,
  replaced: false,
  anyDelivered: false,
};

/** An unapproved set whose current version's review reads `review`. */
function setReviewing(review: NonNullable<StatusTicketSet["review"]>): StatusTicketSet {
  return {
    tickets: 2,
    approvedAt: null,
    review,
    follows: false,
    replaced: false,
    anyDelivered: false,
  };
}

const ESCALATED_FINDING: TicketsReviewFindingRecord = {
  kind: "contradiction",
  route: "decision",
  title: "Two slicings of the export",
  explanation: "1.1 admits two slicings; the clause picks neither.",
  question: "Should the exporter or the button ship first?",
  ticketNumbers: ["T1"],
  criterionIds: ["1.1"],
  escalated: true,
};
const SET_HELD = setReviewing({
  state: "findings",
  summary: "The tickets need a decision.",
  findings: [
    { ...ESCALATED_FINDING, route: "revise", title: "Adds a CSV format", escalated: false },
    ESCALATED_FINDING,
  ],
  held: true,
  reviewedAt: AT,
});

/** Spec `number`, by default one draft whose review passed, no set and no delivery run. */
function spec(number: number, fields: Partial<StatusSpec>): StatusSpec {
  return {
    id: specId(number),
    number,
    revisions: [revision("draft", "passed", 1)],
    ticketSet: null,
    ticketsDue: fields.ticketSet === undefined || fields.ticketSet === null,
    runs: [],
    ...fields,
  };
}

const VERDICT: Verdict = {
  reviewedCommit: "a".repeat(40),
  summary: "Criterion 1 is not met.",
  findings: [
    {
      axis: "spec",
      severity: "blocking",
      file: null,
      title: "Missing",
      detail: "No toggle.",
      criterion: null,
    },
  ],
};

type Run = StatusSpec["runs"][number];

const FINAL_COMMIT = "b".repeat(40);

/** Run 1, passed and not merged, with two tickets merged unless `fields` say otherwise. */
function run(fields: Partial<Run>): Run {
  return {
    number: 1,
    state: "passed",
    phase: "reviewing",
    branch: "zenorm/dark-mode-run-1",
    baseBranch: "main",
    finalCommit: FINAL_COMMIT,
    checks: ["pnpm test", "pnpm lint"],
    checkResults: null,
    verdict: null,
    failure: null,
    mergedAt: null,
    pullRequest: null,
    tickets: [mergedTicket("T1"), mergedTicket("T2")],
    ...fields,
  };
}

/** The pull request a passed run opened on a GitHub project. */
const PULL_REQUEST = {
  number: 12,
  url: "https://github.com/acme/numbers/pull/12",
  state: "open",
} as const;

type RunTicketRow = NonNullable<Run["tickets"]>[number];

function mergedTicket(ticket: string): RunTicketRow {
  return {
    ticket,
    status: { state: "merged", commit: FINAL_COMMIT, summary: null },
    failing: [],
  };
}

function startedTicket(ticket: string): RunTicketRow {
  return { ticket, status: { state: "implementing", latest: null }, failing: [] };
}

const MAP_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e70";
const RUN_0 = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e71";
const RUN_1 = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e72";
const RUN_2 = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e73";
const RUN_3 = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e74";
const RUN_4 = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e75";
const RUN_5 = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e76";
const RUN_IDS = [
  RUN_0,
  RUN_1,
  RUN_2,
  RUN_3,
  RUN_4,
  RUN_5,
  ...[6, 7, 8, 9].map((n) => `0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e7${String(n)}`),
  ...[0, 1, 2, 3, 4, 5].map((n) => `0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5ea${String(n)}`),
];

const WAYPOINT_IDS = [
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e81",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e82",
  "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e83",
];

type StatusWaypoint = MapStatusInput["waypoints"][number];

/** Waypoint `number` (1-based) with its fixed id. */
function waypoint(number: number, status: StatusWaypoint["status"]): StatusWaypoint {
  const id = WAYPOINT_IDS[number - 1];
  if (id === undefined) throw new Error(`No waypoint id ${String(number)}`);
  return {
    id,
    number,
    kind: "grilling",
    title: `Waypoint ${String(number)}`,
    status,
    resolvedAt: status === "resolved" ? AT : null,
  };
}

function waypointId(number: number): string {
  return waypoint(number, "open").id;
}

/** A map-level planning run; its id is the `index`th of `RUN_IDS`. */
function planningRun(index: number, fields: Partial<PlanningRun>): PlanningRun {
  const id = RUN_IDS[index];
  if (id === undefined) throw new Error(`No run id ${String(index)}`);
  return {
    id,
    mapId: MAP_ID,
    waypointId: null,
    specificationId: null,
    purpose: "chart",
    state: "completed",
    retryOfRunId: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    hatchMessageId: null,
    startedAt: AT,
    endedAt: AT,
    ...fields,
  };
}

function failed(index: number, retryOf: number | null): PlanningRun {
  const retryOfRunId = retryOf === null ? null : RUN_IDS[retryOf];
  if (retryOfRunId === undefined) throw new Error(`No run id ${String(retryOf)}`);
  return planningRun(index, {
    state: "failed",
    retryOfRunId,
    errorCode: "agent_timed_out",
    errorMessage: "Timed out",
  });
}

const running = { state: "running", endedAt: null } as const;
/** The map-scope `to_spec` running. */
const WRITING = { purpose: "to_spec", ...running } as const;

/** A run of `purpose` in spec `number`'s scope. */
function specRun(
  index: number,
  number: number,
  purpose: PlanningRun["purpose"],
  fields: Partial<PlanningRun>,
): PlanningRun {
  return planningRun(index, { purpose, specificationId: specId(number), ...fields });
}

/** Spec `number`'s scope stopped: a failed `purpose` run and its failed retry. */
function stoppedSpecRun(
  index: number,
  number: number,
  purpose: PlanningRun["purpose"],
): PlanningRun[] {
  return [
    { ...failed(index, null), purpose, specificationId: specId(number) },
    { ...failed(index + 1, index), purpose, specificationId: specId(number) },
  ];
}

/** Spec 1 approved with its set approved and these delivery runs, newest first. */
function delivering(runs: readonly Run[]): StatusSpec {
  return spec(1, { revisions: [APPROVED], ticketSet: SET_APPROVED, runs });
}
const CHARTED = { title: "Dark mode", destinationConfirmedAt: null };
const UNCHARTED = { title: null, destinationConfirmedAt: null };
const PENDING_ROUND = {
  waypointId: null,
  number: 1,
  final: false,
  questions: QUESTIONS,
  status: "pending",
} as const;
const SUBMITTED_ROUND = { ...PENDING_ROUND, status: "submitted" } as const;
/**
 * The confirmed chart's completed code survey: its id sorts between run 1 and run 2, so it is the
 * map scope's run after the charts and before any later one.
 */
const SURVEY_RUN: PlanningRun = {
  ...planningRun(1, { purpose: "survey" }),
  id: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e72-survey",
};
/** The destination round answered, the confirming chart and its code survey completed. */
const CONFIRMED_RUNS = [planningRun(0, { state: "asked" }), planningRun(1, {}), SURVEY_RUN];

/** A `grilling` run on waypoint `number`. */
function grilling(index: number, number: number, fields: Partial<PlanningRun>): PlanningRun {
  return planningRun(index, { purpose: "grilling", waypointId: waypointId(number), ...fields });
}

function failedGrilling(index: number, number: number, retryOf: number | null): PlanningRun {
  return { ...failed(index, retryOf), purpose: "grilling", waypointId: waypointId(number) };
}

/** A round pending on waypoint `number`. */
function pendingOn(number: number) {
  return {
    waypointId: waypointId(number),
    number: 1,
    final: false,
    questions: QUESTIONS,
    status: "pending",
  } as const;
}

/**
 * A map charted with no waypoints, so cleared, with nothing drafted and the runners idle; each
 * case overrides it (as given, the spec is due with no run: a programmer error).
 */
function input(overrides: Partial<MapStatusInput>): MapStatusInput {
  return {
    map: { title: "Dark mode", destinationConfirmedAt: AT },
    rounds: [SUBMITTED_ROUND],
    waypoints: [],
    blockers: [],
    planningRuns: CONFIRMED_RUNS,
    specs: [],
    startDeliveryBlockers: [],
    activeRun: null,
    runOutcomes: { reports: [], taskOutcomes: [] },
    fogCount: 0,
    passes: [],
    waits: [],
    ...overrides,
  };
}

/** Waypoint `number` of `kind`. */
function kinded(
  number: number,
  kind: StatusWaypoint["kind"],
  status: StatusWaypoint["status"],
): StatusWaypoint {
  return { ...waypoint(number, status), kind };
}

/** A run of `purpose` on waypoint `number`. */
function onWaypoint(
  index: number,
  number: number,
  purpose: PlanningRun["purpose"],
  fields: Partial<PlanningRun>,
): PlanningRun {
  return planningRun(index, { purpose, waypointId: waypointId(number), ...fields });
}

/** RUN_2 left an unanswered report. */
const UNANSWERED_ON_RUN_2 = {
  reports: [{ runId: RUN_2, answered: false, gap: "Whether Node 22 reads the proxy." }],
  taskOutcomes: [],
};

/** RUN_2 left a failed task outcome. */
const FAILED_ON_RUN_2 = {
  reports: [],
  taskOutcomes: [{ runId: RUN_2, outcome: "failed" as const, facts: "The folder is unreadable." }],
};

interface Case {
  readonly rule: string;
  readonly input: MapStatusInput;
  /** Idea, Wayfinding, Spec, Tickets, Delivery. */
  readonly tones: readonly StageTone[];
  /** Each next action as `who:stage`. */
  readonly next: readonly string[];
  readonly group: "needs-you" | "working" | "quiet";
  /** A failure code the line of this stage index must not show: lines are human. */
  readonly code?: readonly [number, string];
  /** What the first next action opens and acts on. */
  readonly acts?: Pick<NextAction, "round" | "stopped">;
}

const cases: readonly Case[] = [
  {
    rule: "first chart running: Idea working, Wayfinding and the rest wait",
    input: input({
      map: UNCHARTED,
      rounds: [],
      planningRuns: [planningRun(0, running)],
    }),
    tones: ["working", "later", "later", "later", "later"],
    next: ["agent:idea"],
    group: "working",
    acts: { round: null, stopped: null },
  },
  {
    rule: "first chart awaiting its retry: still working",
    input: input({
      map: UNCHARTED,
      rounds: [],
      planningRuns: [failed(0, null), planningRun(1, { ...running, retryOfRunId: RUN_0 })],
    }),
    tones: ["working", "later", "later", "later", "later"],
    next: ["agent:idea"],
    group: "working",
  },
  {
    rule: "first chart stopped: Idea needs you with the stopped run, Wayfinding later",
    input: input({ map: UNCHARTED, rounds: [], planningRuns: [failed(0, null), failed(1, 0)] }),
    tones: ["needs-you", "later", "later", "later", "later"],
    next: ["you:idea"],
    group: "needs-you",
    code: [0, "agent_timed_out"],
    acts: { round: null, stopped: { runId: RUN_1, code: "agent_timed_out" } },
  },
  {
    rule: "destination round pending: Wayfinding needs you and opens the destination round",
    input: input({
      map: CHARTED,
      rounds: [PENDING_ROUND],
      planningRuns: [planningRun(0, { state: "asked" })],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
    acts: { round: "destination", stopped: null },
  },
  {
    rule: "confirming chart running: Wayfinding working",
    input: input({
      map: CHARTED,
      planningRuns: [planningRun(0, { state: "asked" }), planningRun(1, running)],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "confirming chart stopped: Wayfinding needs you with the stopped run",
    input: input({
      map: CHARTED,
      planningRuns: [planningRun(0, { state: "asked" }), failed(1, null), failed(2, 1)],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
    acts: { round: null, stopped: { runId: RUN_2, code: "agent_timed_out" } },
  },
  {
    rule: "a waypoint's round pending: Wayfinding needs you and opens the waypoint's round",
    input: input({
      rounds: [SUBMITTED_ROUND, pendingOn(1)],
      waypoints: [waypoint(1, "claimed"), waypoint(2, "open")],
      blockers: [{ waypointNumber: 2, blockerNumber: 1 }],
      planningRuns: [...CONFIRMED_RUNS, grilling(2, 1, { state: "asked" })],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
    acts: { round: 1, stopped: null },
  },
  {
    rule: "a pending round and a grilling run: needs-you over working, the agent entry after",
    input: input({
      rounds: [SUBMITTED_ROUND, pendingOn(1)],
      waypoints: [waypoint(1, "claimed"), waypoint(2, "claimed")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        grilling(2, 1, { state: "asked" }),
        grilling(3, 2, running),
      ],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding", "agent:wayfinding"],
    group: "needs-you",
    acts: { round: 1, stopped: null },
  },
  {
    rule: "a grilling run running: Wayfinding working, one agent entry per run",
    input: input({
      waypoints: [waypoint(1, "claimed"), waypoint(2, "claimed")],
      planningRuns: [...CONFIRMED_RUNS, grilling(2, 1, running), grilling(3, 2, running)],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding", "agent:wayfinding"],
    group: "working",
    acts: { round: null, stopped: null },
  },
  {
    rule: "a grilling run awaiting its retry: still working",
    input: input({
      waypoints: [waypoint(1, "claimed")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        failedGrilling(2, 1, null),
        grilling(3, 1, { ...running, retryOfRunId: RUN_2 }),
      ],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "a grilling scope stopped: needs you with the stopped run, before the agent entries",
    input: input({
      waypoints: [waypoint(1, "open"), waypoint(2, "claimed")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        failedGrilling(2, 1, null),
        failedGrilling(3, 1, 2),
        grilling(4, 2, running),
      ],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding", "agent:wayfinding"],
    group: "needs-you",
    acts: { round: null, stopped: { runId: RUN_3, code: "agent_timed_out" } },
  },
  {
    rule: "a stopped run on a waypoint since ruled out of scope (or resolved) is no next action",
    input: input({
      waypoints: [waypoint(1, "out_of_scope"), waypoint(2, "claimed"), waypoint(3, "resolved")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        failedGrilling(2, 1, null),
        failedGrilling(3, 1, 2),
        failedGrilling(4, 3, null),
        failedGrilling(5, 3, 4),
        grilling(6, 2, running),
      ],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
    acts: { round: null, stopped: null },
  },
  {
    rule: "pending rounds before stopped scopes before running runs",
    input: input({
      rounds: [SUBMITTED_ROUND, pendingOn(3)],
      waypoints: [waypoint(1, "open"), waypoint(2, "claimed"), waypoint(3, "claimed")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        failedGrilling(2, 1, null),
        failedGrilling(3, 1, 2),
        grilling(4, 2, running),
        grilling(5, 3, { state: "asked" }),
      ],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding", "you:wayfinding", "agent:wayfinding"],
    group: "needs-you",
    acts: { round: 3, stopped: null },
  },
  {
    rule: "every waypoint resolved and nothing grilling: cleared, Wayfinding done",
    input: input({
      waypoints: [waypoint(1, "resolved"), waypoint(2, "resolved")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        grilling(2, 1, {}),
        grilling(3, 2, {}),
        planningRun(4, { purpose: "to_spec", ...running }),
      ],
      passes: [{ compared: [1, 2].map((n) => ({ waypointId: waypointId(n), resolvedAt: AT })) }],
    }),
    tones: ["done", "done", "working", "later", "later"],
    next: ["agent:spec"],
    group: "working",
  },
  {
    rule: "spec drafting: working",
    input: input({ planningRuns: [...CONFIRMED_RUNS, planningRun(2, WRITING)] }),
    tones: ["done", "done", "working", "later", "later"],
    next: ["agent:spec"],
    group: "working",
  },
  {
    rule: "spec drafting failed: needs you with its code",
    input: input({
      planningRuns: [
        ...CONFIRMED_RUNS,
        { ...failed(2, null), purpose: "to_spec" },
        { ...failed(3, 2), purpose: "to_spec" },
      ],
    }),
    tones: ["done", "done", "needs-you", "later", "later"],
    next: ["you:spec"],
    group: "needs-you",
    code: [2, "agent_timed_out"],
    acts: { round: null, stopped: { runId: RUN_3, code: "agent_timed_out" } },
  },
  {
    rule: "undecided spec revision: Awaiting your approval",
    input: input({
      specs: [
        spec(1, { revisions: [revision("rejected", "passed", 1), revision("draft", "passed", 2)] }),
      ],
    }),
    tones: ["done", "done", "needs-you", "later", "later"],
    next: ["you:spec"],
    group: "needs-you",
  },
  {
    rule: "tickets drafting: working",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, specRun(2, 1, "to_tickets", running)],
      specs: [spec(1, { revisions: [APPROVED] })],
    }),
    tones: ["done", "done", "done", "working", "later"],
    next: ["agent:tickets"],
    group: "working",
  },
  {
    rule: "tickets drafting failed: needs you with its code",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, ...stoppedSpecRun(2, 1, "to_tickets")],
      specs: [spec(1, { revisions: [APPROVED] })],
    }),
    tones: ["done", "done", "done", "needs-you", "later"],
    next: ["you:tickets"],
    group: "needs-you",
    code: [3, "agent_timed_out"],
  },
  {
    rule: "undecided ticket set: Awaiting your approval",
    input: input({ specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_PENDING })] }),
    tones: ["done", "done", "done", "needs-you", "later"],
    next: ["you:tickets"],
    group: "needs-you",
  },
  {
    rule: "approved set, no run: Ready to start",
    input: input({ specs: [delivering([])] }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
  },
  {
    rule: "approved set, no run, a start delivery blocker: idle, a quiet map",
    input: input({ specs: [delivering([])], startDeliveryBlockers: ["project_branch_missing"] }),
    tones: ["done", "done", "done", "done", "idle"],
    next: ["nobody:delivery"],
    group: "quiet",
  },
  {
    rule: "running run: working with its phase",
    input: input({ specs: [delivering([run({ state: "running", phase: "implementing" })])] }),
    tones: ["done", "done", "done", "done", "working"],
    next: ["agent:delivery"],
    group: "working",
  },
  {
    rule: "interrupted run: needs you",
    input: input({ specs: [delivering([run({ state: "interrupted" })])] }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
  },
  {
    rule: "blocked run: needs you",
    input: input({ specs: [delivering([run({ state: "blocked", verdict: VERDICT })])] }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
  },
  {
    rule: "failed run: needs you, its code not in the line",
    input: input({
      specs: [
        delivering([
          run({
            state: "failed",
            phase: "verifying",
            failure: { code: "delivery_checks_failed", message: "Failed" },
          }),
        ]),
      ],
    }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
    code: [4, "delivery_checks_failed"],
  },
  {
    rule: "cancelled run, the latest of two: needs you",
    input: input({
      specs: [
        delivering([
          run({ number: 2, state: "cancelled" }),
          run({ state: "blocked", verdict: VERDICT }),
        ]),
      ],
    }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
  },
  {
    rule: "passed run, not merged: needs you with Mark merged, the map under Needs you",
    input: input({
      specs: [delivering([run({ number: 2, state: "passed" }), run({ state: "cancelled" })])],
    }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
  },
  {
    rule: "passed run with a pull request: needs you with Merge PR, the map under Needs you",
    input: input({
      specs: [delivering([run({ phase: "publishing", pullRequest: PULL_REQUEST })])],
    }),
    tones: ["done", "done", "done", "done", "needs-you"],
    next: ["you:delivery"],
    group: "needs-you",
  },
  {
    rule: "merged run: done, a quiet map",
    input: input({ specs: [delivering([run({ mergedAt: AT })])] }),
    tones: ["done", "done", "done", "done", "done"],
    next: ["nobody:delivery"],
    group: "quiet",
  },
  {
    rule: "a waiting Research waypoint: Wayfinding needs you",
    input: input({
      waypoints: [kinded(1, "research", "open")],
      planningRuns: [...CONFIRMED_RUNS, onWaypoint(2, 1, "research", {})],
      runOutcomes: UNANSWERED_ON_RUN_2,
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
  },
  {
    rule: "a failed Task waypoint: Wayfinding needs you",
    input: input({
      waypoints: [kinded(1, "task", "open")],
      planningRuns: [...CONFIRMED_RUNS, onWaypoint(2, 1, "task", {})],
      runOutcomes: FAILED_ON_RUN_2,
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
  },
  {
    rule: "a research run running: working",
    input: input({
      waypoints: [kinded(1, "research", "claimed")],
      planningRuns: [...CONFIRMED_RUNS, onWaypoint(2, 1, "research", running)],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "a task run awaiting its retry: working",
    input: input({
      waypoints: [kinded(1, "task", "claimed")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        { ...failed(2, null), purpose: "task", waypointId: waypointId(1) },
      ],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "the code survey running: working, the spec later",
    input: input({
      waypoints: [waypoint(1, "open")],
      planningRuns: [
        planningRun(0, { state: "asked" }),
        planningRun(1, {}),
        planningRun(2, { purpose: "survey", ...running }),
      ],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "a stopped code survey: needs you with Try again",
    input: input({
      waypoints: [waypoint(1, "open")],
      planningRuns: [
        planningRun(0, { state: "asked" }),
        planningRun(1, {}),
        { ...failed(2, null), purpose: "survey" },
        { ...failed(3, 2), purpose: "survey" },
      ],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
    acts: { round: null, stopped: { runId: RUN_3, code: "agent_timed_out" } },
  },
  {
    rule: "a consistency run running: working, the spec later",
    input: input({
      waypoints: [waypoint(1, "resolved"), waypoint(2, "resolved")],
      planningRuns: [...CONFIRMED_RUNS, planningRun(2, { purpose: "consistency", ...running })],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "a consistency run awaiting its retry: working",
    input: input({
      waypoints: [waypoint(1, "resolved"), waypoint(2, "resolved")],
      planningRuns: [...CONFIRMED_RUNS, { ...failed(2, null), purpose: "consistency" }],
    }),
    tones: ["done", "working", "later", "later", "later"],
    next: ["agent:wayfinding"],
    group: "working",
  },
  {
    rule: "a stopped consistency scope: needs you with Try again",
    input: input({
      waypoints: [waypoint(1, "resolved"), waypoint(2, "resolved")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        { ...failed(2, null), purpose: "consistency" },
        { ...failed(3, 2), purpose: "consistency" },
      ],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
    acts: { round: null, stopped: { runId: RUN_3, code: "agent_timed_out" } },
  },
  {
    rule: "a stopped research scope: needs you with Try again",
    input: input({
      waypoints: [kinded(1, "research", "open")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        { ...failed(2, null), purpose: "research", waypointId: waypointId(1) },
        { ...failed(3, 2), purpose: "research", waypointId: waypointId(1) },
      ],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding"],
    group: "needs-you",
    acts: { round: null, stopped: { runId: RUN_3, code: "agent_timed_out" } },
  },
  {
    rule: "needs you over working: a waiting waypoint beside a research run",
    input: input({
      waypoints: [kinded(1, "research", "open"), kinded(2, "research", "claimed")],
      planningRuns: [
        ...CONFIRMED_RUNS,
        onWaypoint(2, 1, "research", {}),
        onWaypoint(3, 2, "research", running),
      ],
      runOutcomes: UNANSWERED_ON_RUN_2,
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    next: ["you:wayfinding", "agent:wayfinding"],
    group: "needs-you",
  },
];

describe("mapStatus next actions", () => {
  test("a waypoint's round counts only its direct dependents", () => {
    const status = mapStatus(
      input({
        rounds: [SUBMITTED_ROUND, pendingOn(1)],
        waypoints: [waypoint(1, "claimed"), waypoint(2, "open"), waypoint(3, "open")],
        blockers: [
          { waypointNumber: 2, blockerNumber: 1 },
          { waypointNumber: 3, blockerNumber: 2 },
        ],
        planningRuns: [...CONFIRMED_RUNS, grilling(2, 1, { state: "asked" })],
      }),
    );
    expect(status.next[0]?.detail).toContain("unblocks 1 waypoint");
  });
});

describe("mapStatus waiting next actions", () => {
  test("a waiting waypoint's entry carries its run, reason and number, with the gap or facts as detail", () => {
    for (const [kind, outcomes, reason, detail] of [
      ["research", UNANSWERED_ON_RUN_2, "research_unanswered", UNANSWERED_ON_RUN_2.reports[0]?.gap],
      ["task", FAILED_ON_RUN_2, "task_failed", FAILED_ON_RUN_2.taskOutcomes[0]?.facts],
    ] as const) {
      const status = mapStatus(
        input({
          waypoints: [kinded(1, kind, "open")],
          planningRuns: [...CONFIRMED_RUNS, onWaypoint(2, 1, kind, {})],
          runOutcomes: outcomes,
        }),
      );
      expect(status.next).toHaveLength(1);
      expect(status.next[0]).toMatchObject({
        who: "you",
        stage: "wayfinding",
        detail,
        round: null,
        stopped: null,
        waiting: { runId: RUN_2, reason, waypoint: 1 },
      });
    }
  });

  test("after pending rounds and stopped scopes, before the agent's entries", () => {
    const status = mapStatus(
      input({
        rounds: [SUBMITTED_ROUND, pendingOn(3)],
        waypoints: [
          kinded(1, "research", "open"),
          kinded(2, "task", "open"),
          kinded(3, "task", "claimed"),
        ],
        planningRuns: [
          ...CONFIRMED_RUNS,
          onWaypoint(2, 1, "research", {}),
          { ...failed(3, null), purpose: "task", waypointId: waypointId(2) },
          { ...failed(4, 3), purpose: "task", waypointId: waypointId(2) },
          onWaypoint(5, 3, "task", { state: "asked" }),
        ],
        runOutcomes: UNANSWERED_ON_RUN_2,
      }),
    );
    expect(
      status.next.map((action) => [
        action.who,
        action.round,
        action.stopped === null ? null : action.stopped.runId,
        action.waiting === null ? null : action.waiting.runId,
      ]),
    ).toEqual([
      ["you", 3, null, null],
      ["you", null, RUN_4, null],
      ["you", null, null, RUN_2],
    ]);
  });
});

describe("mapStatus programmer errors", () => {
  // A due draft is always running or stopped; none of either is a programmer error.
  test.each([
    ["the spec, cleared", input({})],
    ["the tickets, the spec approved", input({ specs: [spec(1, { revisions: [APPROVED] })] })],
  ])("a due draft with no run throws: %s", (_name, statusInput) => {
    expect(() => mapStatus(statusInput)).toThrow();
  });
});

describe("mapStatus", () => {
  test.each(cases)("$rule", (item) => {
    const status = mapStatus(item.input);
    expect(MapStatus.parse(status)).toEqual(status);

    expect(status.stages.map((stage) => stage.stage)).toEqual([
      "idea",
      "wayfinding",
      "spec",
      "tickets",
      "delivery",
    ]);
    expect(status.stages.map((stage) => stage.tone)).toEqual(item.tones);
    expect(status.next.map((action) => `${action.who}:${action.stage}`)).toEqual(item.next);
    expect(status.group).toBe(item.group);
    if (item.acts !== undefined) {
      expect(status.next[0]).toMatchObject(item.acts);
    }
    if (item.code !== undefined) {
      const [index, code] = item.code;
      expect(status.stages[index]?.line).not.toContain(code);
      // Nor the action's words: a stopped run's detail is a sentence.
      expect(status.next[0]?.headline).not.toContain(code);
      expect(status.next[0]?.detail).not.toContain(code);
      expect(status.next[0]?.detail).not.toBeNull();
    }
    for (const stage of status.stages) {
      expect(stage.line.length).toBeGreaterThan(0);
    }
  });
});

describe("mapStatus the destination round's next action", () => {
  /** Map-level round `number`, pending, `final` as given. */
  function pending(number: number, final: boolean) {
    return { ...PENDING_ROUND, number, final };
  }
  /** Wayfinding's line and its first next action's headline. */
  function wayfindingNext(input: MapStatusInput) {
    const { status } = deriveStatus(input);
    return { line: status.stages[1].line, headline: status.next[0]?.headline };
  }

  test.each([
    { round: pending(1, false), headline: "Answer destination round 1." },
    { round: pending(2, false), headline: "Answer destination round 2." },
    { round: pending(2, true), headline: "Confirm the destination." },
    { round: pending(3, false), headline: "Confirm the destination." },
  ])("pending round $round.number, final $round.final: $headline", ({ round, headline }) => {
    const submitted = [1, 2]
      .filter((number) => number < round.number)
      .map((number) => ({ ...SUBMITTED_ROUND, number }));
    const planningRuns = [0, 1, 2]
      .filter((index) => index < round.number)
      .map((index) => planningRun(index, { state: "asked" }));
    expect(
      wayfindingNext(input({ map: CHARTED, rounds: [...submitted, round], planningRuns })),
    ).toEqual({ line: "Destination waiting on you", headline });
  });

  test("while a chart runs after round 2, the status lines are unchanged", () => {
    expect(
      wayfindingNext(
        input({
          map: CHARTED,
          rounds: [SUBMITTED_ROUND, { ...SUBMITTED_ROUND, number: 2 }],
          planningRuns: [
            planningRun(0, { state: "asked" }),
            planningRun(1, { state: "asked" }),
            planningRun(2, running),
          ],
        }),
      ),
    ).toEqual({
      line: "Agent is charting the waypoints",
      headline: "The agent is charting the waypoints.",
    });
  });
});

describe("mapStatus Wayfinding progress", () => {
  test("k of n counts in-scope waypoints only: an out-of-scope waypoint is not counted", () => {
    const status = mapStatus(
      input({
        waypoints: [waypoint(1, "resolved"), waypoint(2, "open"), waypoint(3, "out_of_scope")],
        planningRuns: [...CONFIRMED_RUNS, grilling(2, 2, running)],
      }),
    );
    const wayfinding = status.stages.find((stage) => stage.stage === "wayfinding");
    if (wayfinding === undefined) throw new Error("No Wayfinding stage");
    // The line's first two numbers are k (resolved) and n (in scope).
    expect(wayfinding.line.match(/\d+/g)?.slice(0, 2)).toEqual(["1", "2"]);
  });
});

/** Two waypoints resolved with no pass of them: the map is un-cleared, its pass running. */
const UNCLEARED_BY_PASS = {
  waypoints: [waypoint(1, "resolved"), waypoint(2, "resolved")],
  passes: [],
} as const;

interface SpecCase {
  readonly rule: string;
  readonly input: MapStatusInput;
  /** Idea, Wayfinding, Spec, Tickets, Delivery. */
  readonly tones: readonly StageTone[];
  /** Each spec's Spec, Tickets and Delivery tones, by spec number. */
  readonly specTones: readonly (readonly StageTone[])[];
  /** Each next action as `who:stage:spec`. */
  readonly next: readonly string[];
  readonly group: "needs-you" | "working" | "quiet";
  /** "k of n" in the line of this stage index, when several specs. */
  readonly through?: readonly [number, number, number];
  /** The first next action's stopped run (its Try again), or null for none. */
  readonly stopped?: string | null;
}

const specCases: readonly SpecCase[] = [
  {
    rule: "one spec, its planning review running: Spec working",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, specRun(2, 1, "spec_review", running)],
      specs: [spec(1, { revisions: [revision("draft", "pending", 1)] })],
    }),
    tones: ["done", "done", "working", "later", "later"],
    specTones: [["working", "later", "later"]],
    next: ["agent:spec:1"],
    group: "working",
  },
  {
    rule: "a repair running after review findings: Spec working (Agent is revising)",
    input: input({
      planningRuns: [
        ...CONFIRMED_RUNS,
        specRun(2, 1, "spec_review", {}),
        specRun(3, 1, "to_spec", running),
      ],
      specs: [spec(1, { revisions: [revision("draft", "findings", 1)] })],
    }),
    tones: ["done", "done", "working", "later", "later"],
    specTones: [["working", "later", "later"]],
    next: ["agent:spec:1"],
    group: "working",
  },
  {
    rule: "findings escalated to Wayfinding: Spec later, the escalated waypoint's round needs you",
    input: input({
      waypoints: [waypoint(1, "resolved"), waypoint(2, "claimed")],
      rounds: [SUBMITTED_ROUND, pendingOn(2)],
      planningRuns: [...CONFIRMED_RUNS, specRun(2, 1, "spec_review", {}), grilling(3, 2, {})],
      specs: [spec(1, { revisions: [revision("draft", "escalated", 1)] })],
    }),
    tones: ["done", "needs-you", "later", "later", "later"],
    specTones: [["later", "later", "later"]],
    next: ["you:wayfinding:null"],
    group: "needs-you",
  },
  {
    rule: "a draft awaiting approval: Approve the spec, with its spec number",
    input: input({ specs: [spec(1, {})] }),
    tones: ["done", "done", "needs-you", "later", "later"],
    specTones: [["needs-you", "later", "later"]],
    next: ["you:spec:1"],
    group: "needs-you",
  },
  {
    rule: "an approved spec writing tickets: Tickets working",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, specRun(2, 1, "to_tickets", running)],
      specs: [spec(1, { revisions: [APPROVED] })],
    }),
    tones: ["done", "done", "done", "working", "later"],
    specTones: [["done", "working", "later"]],
    next: ["agent:tickets:1"],
    group: "working",
  },
  {
    rule: "a set awaiting approval: Approve the tickets, with its spec number",
    input: input({ specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_PENDING })] }),
    tones: ["done", "done", "done", "needs-you", "later"],
    specTones: [["done", "needs-you", "later"]],
    next: ["you:tickets:1"],
    group: "needs-you",
  },
  {
    rule: "an approved set: Tickets done, Delivery ready to start",
    input: input({ specs: [delivering([])] }),
    tones: ["done", "done", "done", "done", "needs-you"],
    specTones: [["done", "done", "needs-you"]],
    next: ["you:delivery:1"],
    group: "needs-you",
  },
  {
    rule: "a stopped spec_review on a cleared map: Try again",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, ...stoppedSpecRun(2, 1, "spec_review")],
      specs: [spec(1, { revisions: [revision("draft", "pending", 1)] })],
    }),
    tones: ["done", "done", "needs-you", "later", "later"],
    specTones: [["needs-you", "later", "later"]],
    next: ["you:spec:1"],
    group: "needs-you",
    stopped: RUN_3,
  },
  {
    rule: "a stopped spec_review superseded on a map un-cleared by its pass: no status, no Try again",
    input: input({
      ...UNCLEARED_BY_PASS,
      planningRuns: [
        ...CONFIRMED_RUNS,
        ...stoppedSpecRun(2, 1, "spec_review"),
        planningRun(4, { purpose: "consistency", ...running }),
      ],
      specs: [spec(1, { revisions: [revision("draft", "pending", 1)] })],
    }),
    tones: ["done", "working", "later", "later", "later"],
    specTones: [["later", "later", "later"]],
    next: ["agent:wayfinding:null"],
    group: "working",
  },
  {
    rule: "a stopped repair superseded by the pass started after it: no status, no Try again",
    input: input({
      ...UNCLEARED_BY_PASS,
      planningRuns: [
        ...CONFIRMED_RUNS,
        specRun(2, 1, "spec_review", {}),
        { ...failed(3, null), purpose: "to_spec", specificationId: specId(1) },
        { ...failed(4, 3), purpose: "to_spec", specificationId: specId(1) },
        planningRun(5, { purpose: "consistency", ...running }),
      ],
      specs: [spec(1, { revisions: [revision("draft", "findings", 1)] })],
    }),
    tones: ["done", "working", "later", "later", "later"],
    specTones: [["later", "later", "later"]],
    next: ["agent:wayfinding:null"],
    group: "working",
  },
  {
    rule: "a stopped to_tickets on an approved spec of an un-cleared map keeps Try again",
    input: input({
      ...UNCLEARED_BY_PASS,
      planningRuns: [
        ...CONFIRMED_RUNS,
        ...stoppedSpecRun(2, 1, "to_tickets"),
        planningRun(4, { purpose: "consistency", ...running }),
      ],
      specs: [spec(1, { revisions: [APPROVED] })],
    }),
    tones: ["done", "working", "done", "needs-you", "later"],
    specTones: [["done", "needs-you", "later"]],
    next: ["you:tickets:1", "agent:wayfinding:null"],
    group: "needs-you",
    stopped: RUN_3,
  },
  {
    rule: "a stopped to_tickets rewrite whose set was approved since: no Try again",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, ...stoppedSpecRun(2, 1, "to_tickets")],
      specs: [delivering([])],
    }),
    tones: ["done", "done", "done", "done", "needs-you"],
    specTones: [["done", "done", "needs-you"]],
    next: ["you:delivery:1"],
    group: "needs-you",
  },
  {
    rule: "a stopped to_tickets rewrite after a rejection keeps Try again",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, ...stoppedSpecRun(2, 1, "to_tickets")],
      specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_PENDING, ticketsDue: true })],
    }),
    tones: ["done", "done", "done", "needs-you", "later"],
    specTones: [["done", "needs-you", "later"]],
    next: ["you:tickets:1"],
    group: "needs-you",
    stopped: RUN_3,
  },
  {
    rule: "a tickets review pending is the agent's, with no Approve the tickets",
    input: input({
      specs: [spec(1, { revisions: [APPROVED], ticketSet: setReviewing({ state: "pending" }) })],
    }),
    tones: ["done", "done", "done", "working", "later"],
    specTones: [["done", "working", "later"]],
    next: ["agent:tickets:1"],
    group: "working",
  },
  {
    rule: "a tickets review running is the agent's, with no Approve the tickets",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, specRun(2, 1, "tickets_review", running)],
      specs: [spec(1, { revisions: [APPROVED], ticketSet: setReviewing({ state: "running" }) })],
    }),
    tones: ["done", "done", "done", "working", "later"],
    specTones: [["done", "working", "later"]],
    next: ["agent:tickets:1"],
    group: "working",
  },
  {
    rule: "a stopped tickets review needs you with Try again",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, ...stoppedSpecRun(2, 1, "tickets_review")],
      specs: [
        spec(1, {
          revisions: [APPROVED],
          ticketSet: setReviewing({
            state: "stopped",
            stopped: { runId: RUN_3, code: "agent_timed_out" },
          }),
        }),
      ],
    }),
    tones: ["done", "done", "done", "needs-you", "later"],
    specTones: [["done", "needs-you", "later"]],
    next: ["you:tickets:1"],
    group: "needs-you",
    stopped: RUN_3,
  },
  {
    rule: "a held set needs you to tell the agent how to fix it",
    input: input({ specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_HELD })] }),
    tones: ["done", "done", "done", "needs-you", "later"],
    specTones: [["done", "needs-you", "later"]],
    next: ["you:tickets:1"],
    group: "needs-you",
  },
  {
    rule: "the map's re-clear writing: every unapproved spec is revised, an approved one stands",
    input: input({
      planningRuns: [...CONFIRMED_RUNS, planningRun(2, WRITING)],
      specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_PENDING }), spec(2, {})],
    }),
    tones: ["done", "done", "working", "needs-you", "later"],
    specTones: [
      ["done", "needs-you", "later"],
      ["working", "later", "later"],
    ],
    next: ["you:tickets:1", "agent:spec:2"],
    group: "needs-you",
    through: [2, 1, 2],
  },
  {
    rule: "two specs: one delivering, one a draft; the rail never reads approved for both",
    input: input({ specs: [delivering([]), spec(2, {})] }),
    tones: ["done", "done", "needs-you", "idle", "needs-you"],
    specTones: [
      ["done", "done", "needs-you"],
      ["needs-you", "later", "later"],
    ],
    next: ["you:spec:2", "you:delivery:1"],
    group: "needs-you",
    through: [2, 1, 2],
  },
  {
    rule: "two specs both merged: done, k of n specs done",
    input: input({
      specs: [
        delivering([run({ mergedAt: AT })]),
        { ...delivering([run({ mergedAt: AT })]), id: specId(2), number: 2 },
      ],
    }),
    tones: ["done", "done", "done", "done", "done"],
    specTones: [
      ["done", "done", "done"],
      ["done", "done", "done"],
    ],
    next: ["nobody:delivery:null"],
    group: "quiet",
    through: [4, 2, 2],
  },
  {
    rule: "five specs: one next action per spec needing the person, yours first, with spec numbers",
    input: input({
      planningRuns: [
        ...CONFIRMED_RUNS,
        specRun(2, 3, "to_tickets", running),
        specRun(3, 4, "spec_review", running),
      ],
      specs: [
        delivering([run({ mergedAt: AT })]),
        spec(2, { revisions: [APPROVED], ticketSet: SET_PENDING }),
        spec(3, { revisions: [APPROVED] }),
        spec(4, { revisions: [revision("draft", "pending", 1)] }),
        spec(5, {}),
      ],
    }),
    tones: ["done", "done", "needs-you", "needs-you", "idle"],
    specTones: [
      ["done", "done", "done"],
      ["done", "needs-you", "later"],
      ["done", "working", "later"],
      ["working", "later", "later"],
      ["needs-you", "later", "later"],
    ],
    next: ["you:spec:5", "you:tickets:2", "agent:spec:4", "agent:tickets:3"],
    group: "needs-you",
    through: [2, 3, 5],
  },
  {
    rule: "a reviewed set with no tickets is confirmed, yours",
    input: input({
      specs: [spec(1, { revisions: [APPROVED], ticketSet: { ...SET_PENDING, tickets: 0 } })],
    }),
    tones: ["done", "done", "done", "needs-you", "later"],
    specTones: [["done", "needs-you", "later"]],
    next: ["you:tickets:1"],
    group: "needs-you",
  },
];

describe("mapStatus per spec", () => {
  test.each(specCases)("$rule", (item) => {
    const { status, specStages } = deriveStatus(item.input);
    expect(MapStatus.parse(status)).toEqual(status);
    expect(status.stages.map((stage) => stage.tone)).toEqual(item.tones);
    expect(
      item.input.specs.map((one) => {
        const stages = specStages.get(one.id);
        if (stages === undefined) throw new Error(`No stages for spec ${String(one.number)}`);
        return stages.map((stage) => stage.tone);
      }),
    ).toEqual(item.specTones);
    expect(
      status.next.map((action) => `${action.who}:${action.stage}:${String(action.spec)}`),
    ).toEqual(item.next);
    expect(status.group).toBe(item.group);
    if (item.through !== undefined) {
      const [index, k, n] = item.through;
      expect(status.stages[index]?.line.match(/\d+/g)?.slice(0, 2)).toEqual([String(k), String(n)]);
    } else {
      // One spec: the map's stages read as its own.
      const [only] = item.input.specs;
      if (only !== undefined) {
        expect(specStages.get(only.id)).toEqual(status.stages.slice(2));
      }
    }
    if (item.stopped !== undefined) {
      const [first] = status.next;
      expect(first?.stopped === null ? null : first?.stopped.runId).toBe(item.stopped);
    }
    // A superseded stop drives no Try again anywhere.
    if (item.stopped === undefined) {
      expect(status.next.every((action) => action.stopped === null)).toBe(true);
    }
  });

  test("the map's re-clear stopped: a passed draft waits on the next revision, not your approval", () => {
    const { status, specStages } = deriveStatus(
      input({
        planningRuns: [
          ...CONFIRMED_RUNS,
          { ...failed(2, null), purpose: "to_spec" },
          { ...failed(3, 2), purpose: "to_spec" },
        ],
        specs: [spec(1, {})],
      }),
    );
    expect(specStages.get(specId(1))?.[0]).toEqual({
      stage: "spec",
      tone: "idle",
      line: "Waits on the next revision",
    });
    // The only next action is the map's Try again, never an approval.
    expect(status.next.map((action) => [action.spec, action.stopped?.runId])).toEqual([
      [null, RUN_3],
    ]);
  });

  test("Approve the spec counts behaviours as clauses", () => {
    const status = mapStatus(input({ specs: [spec(1, {})] }));
    const [first] = status.next;
    // Three clauses (and no criteria count) make the detail's number.
    expect(first?.detail?.match(/\d+/g)).toEqual(["3"]);
  });
});

describe("runName", () => {
  test("Delivery run until the spec has a second run, then Run n", () => {
    expect(runName({ number: 1 }, false)).toBe("Delivery run");
    expect(runName({ number: 1 }, true)).toBe("The delivery run");
    expect(runName({ number: 2 }, false)).toBe("Run 2");
    expect(runName({ number: 2 }, true)).toBe("Run 2");
  });
});

describe("mapStatus Delivery by its latest run", () => {
  const ACTIVE_RUN = {
    runId: RUN_5,
    mapId: MAP_ID,
    specNumber: 7,
    specTitle: "Import contacts",
  };
  const FAILURE = { code: "delivery_checks_failed", message: "Failed" } as const;

  /** The map's Delivery stage tone, and its first next action's who and label. */
  function delivery(status: MapStatus): [StageTone, string | undefined, unknown] {
    const [action] = status.next;
    return [status.stages[4].tone, action?.who, action?.label];
  }

  test.each([
    {
      row: "no run, a blocker",
      input: input({ specs: [delivering([])], startDeliveryBlockers: ["project_checks_missing"] }),
      expected: ["idle", "nobody", null],
    },
    {
      row: "no run",
      input: input({ specs: [delivering([])] }),
      expected: ["needs-you", "you", "Start delivery"],
    },
    {
      row: "running",
      input: input({ specs: [delivering([run({ state: "running", phase: "preparing" })])] }),
      expected: ["working", "agent", null],
    },
    {
      row: "interrupted",
      input: input({ specs: [delivering([run({ state: "interrupted" })])] }),
      expected: ["needs-you", "you", "Open Delivery"],
    },
    {
      row: "passed, not merged",
      input: input({ specs: [delivering([run({})])] }),
      expected: ["needs-you", "you", "Mark merged"],
    },
    {
      row: "passed with a pull request, not merged",
      input: input({
        specs: [delivering([run({ phase: "publishing", pullRequest: PULL_REQUEST })])],
      }),
      expected: ["needs-you", "you", "Merge PR"],
    },
    {
      row: "publishing",
      input: input({ specs: [delivering([run({ state: "running", phase: "publishing" })])] }),
      expected: ["working", "agent", null],
    },
    {
      row: "failed while publishing",
      input: input({
        specs: [
          delivering([
            run({
              state: "failed",
              phase: "publishing",
              failure: { code: "delivery_push_failed", message: "The push failed." },
            }),
          ]),
        ],
      }),
      expected: ["needs-you", "you", "Start again from clean"],
    },
    {
      row: "merged",
      input: input({ specs: [delivering([run({ mergedAt: AT })])] }),
      expected: ["done", "nobody", null],
    },
    {
      row: "blocked",
      input: input({ specs: [delivering([run({ state: "blocked", verdict: VERDICT })])] }),
      expected: ["needs-you", "you", "Start again from clean"],
    },
    {
      row: "failed",
      input: input({ specs: [delivering([run({ state: "failed", failure: FAILURE })])] }),
      expected: ["needs-you", "you", "Start again from clean"],
    },
    {
      row: "cancelled",
      input: input({ specs: [delivering([run({ state: "cancelled" })])] }),
      expected: ["needs-you", "you", "Start again from clean"],
    },
  ] as const)("$row", ({ input: given, expected }) => {
    const status = mapStatus(given);
    expect(MapStatus.parse(status)).toEqual(status);
    expect(delivery(status)).toEqual(expected);
  });

  test("a passed run's Mark merged names its branch, base and final commit", () => {
    const [action] = mapStatus(input({ specs: [delivering([run({})])] })).next;
    expect(action?.detail).toContain("zenorm/dark-mode-run-1");
    expect(action?.detail).toContain("main");
    expect(action?.detail).toContain(FINAL_COMMIT.slice(0, 7));
    expect(action?.detail).not.toContain(FINAL_COMMIT);
  });

  test("a passed run with a pull request asks to merge it on GitHub, naming its number", () => {
    const [action] = mapStatus(
      input({ specs: [delivering([run({ phase: "publishing", pullRequest: PULL_REQUEST })])] }),
    ).next;
    expect(action).toMatchObject({ who: "you", stage: "delivery", label: "Merge PR", spec: 1 });
    expect(action?.detail).toContain("#12");
    expect(action?.detail).toContain("main");
    expect(action?.detail).not.toContain("Mark merged");
  });

  test("a passed run whose pull request was closed says so, still with Merge PR and never Mark merged", () => {
    const closed = { ...PULL_REQUEST, state: "closed" } as const;
    const status = mapStatus(
      input({ specs: [delivering([run({ phase: "publishing", pullRequest: closed })])] }),
    );
    const [action] = status.next;
    expect(action).toMatchObject({ who: "you", stage: "delivery", label: "Merge PR" });
    expect(action?.headline).toContain("closed");
    expect(action?.detail).toContain("#12");
    expect(action?.detail).not.toContain("Mark merged");
    expect(status.stages[4]).toMatchObject({ tone: "needs-you" });
  });

  test("a merged spec's quiet action has no detail; two merged specs count them", () => {
    const merged = [run({ mergedAt: AT })];
    const one = mapStatus(input({ specs: [delivering(merged)] })).next;
    const two = mapStatus(
      input({
        specs: [
          delivering(merged),
          spec(2, { revisions: [APPROVED], ticketSet: SET_APPROVED, runs: merged }),
        ],
      }),
    );
    expect(one).toMatchObject([{ who: "nobody", stage: "delivery", spec: 1, detail: null }]);
    expect(one[0]?.headline).toBe(two.next[0]?.headline);
    expect(two.stages[4].tone).toBe("done");
    expect(two.next).toMatchObject([{ who: "nobody", stage: "delivery", spec: null }]);
    expect(two.next[0]?.detail).toContain("2");
  });

  test("a running run stays the agent's through Implement and Verify as its progress grows", () => {
    const passedCheck = {
      command: "pnpm test",
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      outputTail: "",
    };
    const steps: Partial<Run>[] = [
      { phase: "implementing", tickets: [startedTicket("T1"), startedTicket("T2")] },
      { phase: "implementing", tickets: [mergedTicket("T1"), startedTicket("T2")] },
      { phase: "implementing", tickets: [mergedTicket("T1"), mergedTicket("T2")] },
      { phase: "verifying", checkResults: null },
      { phase: "verifying", checkResults: [passedCheck] },
      { phase: "verifying", checkResults: [passedCheck, { ...passedCheck, command: "pnpm lint" }] },
      { phase: "reviewing" },
      { phase: "publishing" },
    ];
    const lines = steps.map((fields) => {
      const status = mapStatus(
        input({ specs: [delivering([run({ state: "running", ...fields })])] }),
      );
      expect(delivery(status)).toEqual(["working", "agent", null]);
      expect(status.group).toBe("working");
      return status.stages[4].line;
    });
    // Each step's progress reads differently: merged tickets and passed checks grow.
    expect(new Set(lines).size).toBe(steps.length);
  });

  test("the idle blocker line: no checks, or another spec's active run", () => {
    const checks = mapStatus(
      input({ specs: [delivering([])], startDeliveryBlockers: ["project_checks_missing"] }),
    );
    const active = mapStatus(
      input({
        specs: [delivering([])],
        startDeliveryBlockers: ["delivery_in_progress"],
        activeRun: ACTIVE_RUN,
      }),
    );
    for (const status of [checks, active]) {
      expect(delivery(status)).toEqual(["idle", "nobody", null]);
      // The rail's line is a few words; the card's detail is the full sentence.
      expect(status.stages[4].line.length).toBeLessThan(30);
      expect(status.next[0]?.detail).not.toBe(status.stages[4].line);
    }
    expect(checks.stages[4].line).not.toBe(active.stages[4].line);
    expect(checks.next[0]?.detail).not.toBe(active.next[0]?.detail);
    expect(active.next[0]?.detail).toContain(ACTIVE_RUN.specTitle);
  });

  test("a spec whose own run is the active one shows that run, never the blocker", () => {
    const status = mapStatus(
      input({
        specs: [delivering([run({ state: "running", phase: "implementing" })])],
        startDeliveryBlockers: ["delivery_in_progress"],
        activeRun: { ...ACTIVE_RUN, specNumber: 1 },
      }),
    );
    expect(delivery(status)).toEqual(["working", "agent", null]);
  });
});

describe("mapStatus action labels", () => {
  const actions = [...cases, ...specCases].flatMap((item) => mapStatus(item.input).next);

  test("an action has a label exactly when it is yours: Try again on a run, Answer on a round", () => {
    for (const action of actions) {
      const where = `${action.who}:${action.stage}: ${action.headline}`;
      if (action.who !== "you") {
        expect(action.label, where).toBeNull();
      } else if (action.stopped !== null || action.waiting !== null) {
        expect(action.label, where).toBe("Try again");
      } else if (action.round !== null) {
        expect(action.label, where).toBe("Answer");
      } else {
        expect(action.label, where).not.toBeNull();
      }
    }
  });

  test("the table names each action's button", () => {
    const byHeadline = new Map(
      actions
        .filter((action) => action.who === "you" && action.stopped === null)
        .filter((action) => action.waiting === null && action.round === null)
        .map((action) => [action.headline, action.label]),
    );
    expect(Object.fromEntries(byHeadline)).toEqual({
      "Approve the spec.": "Approve the spec",
      "Approve the revised spec.": "Approve the revision",
      "Approve the tickets.": "Approve the tickets",
      "Tell the agent how to fix it.": "Tell the agent how to fix it",
      "Tickets approved. Start delivery.": "Start delivery",
      "Confirm: nothing new to build.": "Confirm",
      "The delivery run was blocked by the review.": "Start again from clean",
      "The delivery run failed.": "Start again from clean",
      "Run 2 was cancelled.": "Start again from clean",
      "The delivery run was interrupted. Cancel it, then start again.": "Open Delivery",
      "Run 2 passed. Merge the branch, then mark it merged.": "Mark merged",
      "The delivery run passed. Merge its pull request on GitHub.": "Merge PR",
    });
    expect(new Set(actions.map((action) => action.label))).toEqual(
      new Set([null, ...NextActionLabel.options]),
    );
  });

  test("the passed run's detail names the merge, the check and the record", () => {
    const passed = actions.find((action) => action.label === "Mark merged");
    expect(passed?.detail).toMatch(
      /^Merge \S+ into main yourself, in the project folder, where the branch is\. Mark merged checks that [0-9a-f]{7} is in the folder's main, then records the tickets as delivered\.$/,
    );
  });

  test("Approve the revision past the spec's first revision, whichever map wrote it", () => {
    const [action] = mapStatus(
      input({ specs: [spec(1, { revisions: [revision("draft", "passed", 3)] })] }),
    ).next;
    expect(action?.label).toBe("Approve the revision");
  });
});

describe("mapStatus Tickets by tickets review", () => {
  function ticketsStage(ticketSet: StatusTicketSet, planningRuns: PlanningRun[] = []) {
    const { status } = deriveStatus(
      input({
        planningRuns: [...CONFIRMED_RUNS, ...planningRuns],
        specs: [spec(1, { revisions: [APPROVED], ticketSet })],
      }),
    );
    const [action] = status.next;
    const stage = status.stages[3];
    return {
      tone: stage.tone,
      line: stage.line,
      who: action?.who,
      headline: action?.headline,
      detail: action?.detail,
      label: action?.label,
    };
  }

  test("pending and running: the review is checking the tickets", () => {
    const expected = {
      tone: "working",
      line: "2 tickets · tickets review running",
      who: "agent",
      headline: "The tickets review is checking the tickets.",
      detail: null,
      label: null,
    };
    expect(ticketsStage(setReviewing({ state: "pending" }))).toEqual(expected);
    expect(
      ticketsStage(setReviewing({ state: "running" }), [specRun(2, 1, "tickets_review", running)]),
    ).toEqual(expected);
  });

  test("stopped: Tickets review stopped, Try again, why it stopped as a sentence", () => {
    const { detail, ...rest } = ticketsStage(
      setReviewing({ state: "stopped", stopped: { runId: RUN_3, code: "agent_timed_out" } }),
      stoppedSpecRun(2, 1, "tickets_review"),
    );
    expect(rest).toEqual({
      tone: "needs-you",
      line: "Tickets review stopped",
      who: "you",
      headline: "The tickets review failed.",
      label: "Try again",
    });
    expect(detail).not.toContain("agent_timed_out");
    expect(detail).toMatch(/\.$/);
  });

  test("passed: Approve the tickets, the review verdict as detail", () => {
    expect(ticketsStage(SET_PENDING)).toEqual({
      tone: "needs-you",
      line: "2 tickets · awaiting approval",
      who: "you",
      headline: "Approve the tickets.",
      detail: "2 tickets · review passed",
      label: "Approve the tickets",
    });
  });

  test("held: the first escalated finding's title, Tell the agent how to fix it", () => {
    expect(ticketsStage(SET_HELD)).toEqual({
      tone: "needs-you",
      line: "2 tickets · review needs you",
      who: "you",
      headline: "Tell the agent how to fix it.",
      detail: "Two slicings of the export",
      label: "Tell the agent how to fix it",
    });
  });

  test("a set approved with no review reads approved", () => {
    expect(ticketsStage(SET_APPROVED).line).toBe("2 tickets · approved");
  });
});

describe("mapStatus a review repair", () => {
  /** A failed, unheld review of the current version: its repair is due. */
  const SET_FAILED = setReviewing({
    state: "findings",
    summary: "One criterion is not traced.",
    findings: [{ ...ESCALATED_FINDING, route: "revise", escalated: false }],
    held: false,
    reviewedAt: AT,
  });
  const MESSAGE = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5eb0";

  function ticketsStage(
    ticketSet: StatusTicketSet | null,
    planningRuns: PlanningRun[],
    ticketsDue: boolean,
  ) {
    const { status } = deriveStatus(
      input({
        planningRuns: [...CONFIRMED_RUNS, ...planningRuns],
        specs: [spec(1, { revisions: [APPROVED], ticketSet, ticketsDue })],
      }),
    );
    const [action] = status.next;
    const stage = status.stages[3];
    return {
      tone: stage.tone,
      line: stage.line,
      who: action?.who,
      headline: action?.headline,
      label: action?.label,
      group: status.group,
    };
  }

  test("a repair working after a failed review: n tickets · review findings, the agent's", () => {
    expect(ticketsStage(SET_FAILED, [specRun(2, 1, "to_tickets", running)], true)).toEqual({
      tone: "working",
      line: "2 tickets · review findings",
      who: "agent",
      headline: "The tickets review is checking the tickets.",
      label: null,
      group: "working",
    });
  });

  test("a stopped repair: Writing tickets stopped, Try again", () => {
    expect(ticketsStage(SET_FAILED, stoppedSpecRun(2, 1, "to_tickets"), true)).toEqual({
      tone: "needs-you",
      line: "Writing tickets stopped",
      who: "you",
      headline: "Writing the tickets failed.",
      label: "Try again",
      group: "needs-you",
    });
  });

  test("a rejection rewrite and a note rewrite on a held set keep Agent is writing tickets", () => {
    const writing = {
      tone: "working",
      line: "Agent is writing tickets",
      who: "agent",
      headline: "The agent is writing the tickets.",
      label: null,
      group: "working",
    };
    expect(ticketsStage(SET_PENDING, [specRun(2, 1, "to_tickets", running)], true)).toEqual(
      writing,
    );
    expect(
      ticketsStage(
        SET_HELD,
        [specRun(2, 1, "to_tickets", { ...running, hatchMessageId: MESSAGE })],
        true,
      ),
    ).toEqual(writing);
  });

  test("a first to_tickets keeps Agent is writing tickets", () => {
    expect(ticketsStage(null, [specRun(2, 1, "to_tickets", running)], true).line).toBe(
      "Agent is writing tickets",
    );
  });
});

describe("map.overview Tickets and Inbox from recorded reviews", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await openTestContext("zenorm-status-");
  });

  afterEach(async () => {
    await closeTestContext(context);
  });

  /** The map's Tickets stage, its spec's next action and its Inbox group. */
  async function ticketsStage(mapId: string) {
    const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!result.ok) throw new Error(result.error.code);
    const { status, specs } = result.value;
    const action = status.next.find((entry) => entry.stage === "tickets");
    return {
      tone: specs[0]?.stages[1]?.tone,
      line: specs[0]?.stages[1]?.line,
      who: action?.who,
      label: action?.label,
      stopped: action?.stopped?.runId,
      group: status.group,
    };
  }

  const FAILURE = { code: "agent_timed_out", message: "The agent timed out" } as const;

  test("a repair working after a failed review reads review findings, the agent's", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    expect(await ticketsStage(mapId)).toEqual({
      tone: "working",
      line: "2 tickets · review findings",
      who: "agent",
      label: null,
      stopped: undefined,
      group: "working",
    });
  });

  test("a stopped repair reads Writing tickets stopped with Try again on its retry", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    failRun(context.user, context.db, runningSpecRun(context, mapId, "to_tickets").id, FAILURE);
    const retry = runningSpecRun(context, mapId, "to_tickets");
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(await ticketsStage(mapId)).toEqual({
      tone: "needs-you",
      line: "Writing tickets stopped",
      who: "you",
      label: "Try again",
      stopped: retry.id,
      group: "needs-you",
    });
  });

  test("a rejection rewrite working reads Agent is writing tickets", async () => {
    const project = await addProject(context, "repo");
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: "Split T2" }).ok).toBe(
      true,
    );
    expect(await ticketsStage(mapId)).toMatchObject({
      tone: "working",
      line: "Agent is writing tickets",
      who: "agent",
    });
  });

  /** The map's one ticket set's review, as `map.overview` gives it. */
  async function reviewOf(mapId: string) {
    const result = await getMapOverview(context.db, mapId, { deliveryHeld: () => false });
    if (!result.ok) throw new Error(result.error.code);
    return result.value.specs[0]?.ticketSets[0]?.review;
  }

  test("a rejection rewrite working, then stopped, reads its review pending, never the rejected version's pass", async () => {
    const project = await addProject(context, "repo");
    const { mapId, ticketSetId } = await reviewedTicketSet(context, project);
    expect((await reviewOf(mapId))?.state).toBe("passed");

    expect(rejectTicketSet(context.user, context.db, { ticketSetId, reason: "Split T2" }).ok).toBe(
      true,
    );
    expect(await reviewOf(mapId)).toEqual({ state: "pending" });

    failRun(context.user, context.db, runningSpecRun(context, mapId, "to_tickets").id, FAILURE);
    const retry = runningSpecRun(context, mapId, "to_tickets");
    expect(await reviewOf(mapId)).toEqual({ state: "pending" });
    failRun(context.user, context.db, retry.id, FAILURE);
    expect(await reviewOf(mapId)).toEqual({ state: "pending" });
    expect(await ticketsStage(mapId)).toMatchObject({
      line: "Writing tickets stopped",
      label: "Try again",
      stopped: retry.id,
    });
  });

  test("N-Spec-4: a repair a restart interrupts reads working after the sweep, then Writing tickets stopped when its retry fails", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await draftedTicketSet(context, project);
    recordRunningTicketsReview(context, mapId, FAILED_TICKETS_REVIEW);
    const repair = runningSpecRun(context, mapId, "to_tickets");

    sweepInterruptedRuns(context.db);

    const retry = runningSpecRun(context, mapId, "to_tickets");
    expect(retry.retryOfRunId).toBe(repair.id);
    expect(await ticketsStage(mapId)).toMatchObject({
      tone: "working",
      line: "2 tickets · review findings",
      who: "agent",
    });
    expect((await reviewOf(mapId))?.state).toBe("findings");

    failRun(context.user, context.db, retry.id, FAILURE);
    expect(await ticketsStage(mapId)).toMatchObject({
      tone: "needs-you",
      line: "Writing tickets stopped",
      label: "Try again",
      stopped: retry.id,
    });
  });

  test("a held set's map is in the Inbox's Needs you group", async () => {
    const project = await addProject(context, "repo");
    const { mapId } = await heldTicketSet(context, project);
    expect(await ticketsStage(mapId)).toMatchObject({
      tone: "needs-you",
      who: "you",
      label: "Tell the agent how to fix it",
      group: "needs-you",
    });
  });
});

const HOLDER_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e81";

/** An open wait of the map on spec `number`, held by the map HOLDER_ID under `kind`. */
function heldWait(number: number, kind: SpecHoldKind): SpecWaitView {
  return {
    specNumber: number,
    specTitle: "Quote the export",
    latest: {
      revision: 2,
      state: "draft",
      mapId: HOLDER_ID,
      mapTitle: "Holder",
      savedAt: AT,
      content: {
        title: "Quote the export",
        problem: "Rows break the CSV.",
        solution: "Quote every field.",
        clauses: [],
        outOfScope: [],
      },
    },
    note: "Quote every row.",
    since: AT,
    hold: { kind, mapId: HOLDER_ID, mapTitle: "Holder", revision: 2 },
    released: false,
    run: null,
    waypoints: [],
  };
}

/** The status read as each stage's tone, each spec's tones, `who:stage:spec` and the group. */
function readStatus(item: MapStatusInput) {
  const { status, specStages } = deriveStatus(item);
  expect(MapStatus.parse(status)).toEqual(status);
  return {
    tones: status.stages.map((stage) => stage.tone),
    specTones: item.specs.map((one) => specStages.get(one.id)?.map((stage) => stage.tone)),
    next: status.next.map((action) => `${action.who}:${action.stage}:${String(action.spec)}`),
    group: status.group,
    status,
  };
}

/** Spec 1 delivered: approved, its set approved, its run merged. */
const DELIVERED = spec(1, {
  revisions: [APPROVED],
  ticketSet: SET_APPROVED,
  runs: [run({ mergedAt: AT })],
});

describe("mapStatus waits", () => {
  test("a wait's action is another map's, with no label, onMap its holder; a wait-first map is quiet", () => {
    const read = readStatus(input({ specs: [DELIVERED], waits: [heldWait(2, "revision")] }));
    expect(read.tones).toEqual(["done", "done", "idle", "done", "done"]);
    expect(read.next).toEqual(["another-map:spec:2"]);
    expect(read.status.next[0]).toMatchObject({ label: null, onMap: HOLDER_ID });
    expect(read.group).toBe("quiet");
  });

  test("a map with an approval and a wait is in Needs you, the approval first (WHO_ORDER)", () => {
    const read = readStatus(
      input({
        specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_PENDING })],
        waits: [heldWait(2, "tickets")],
      }),
    );
    expect(read.next).toEqual(["you:tickets:1", "another-map:spec:2"]);
    expect(read.group).toBe("needs-you");
  });

  test("another-map sorts after the agent's entries, never first (a missing WHO_ORDER entry would)", () => {
    const read = readStatus(
      input({
        planningRuns: [...CONFIRMED_RUNS, specRun(2, 1, "spec_review", running)],
        specs: [spec(1, { revisions: [revision("draft", "pending", 1)] })],
        waits: [heldWait(2, "revising")],
      }),
    );
    expect(read.next).toEqual(["agent:spec:1", "another-map:spec:2"]);
    expect(read.tones[2]).toBe("working");
    expect(read.group).toBe("working");
  });

  test.each(["revision", "revising", "tickets", "delivering"] as const)(
    "a wait held under %s: the action's detail is that kind's",
    (kind) => {
      const [action] = mapStatus(input({ specs: [DELIVERED], waits: [heldWait(2, kind)] })).next;
      expect(action?.detail).toBe(WAIT_DETAIL[kind]("Holder"));
    },
  );

  test("no spec yet: a held wait reads idle on Spec before Waits on wayfinding, its action after yours", () => {
    const read = readStatus(
      input({
        rounds: [SUBMITTED_ROUND, pendingOn(1)],
        waypoints: [waypoint(1, "open")],
        planningRuns: [...CONFIRMED_RUNS],
        waits: [heldWait(2, "delivering")],
      }),
    );
    expect(read.tones.slice(2)).toEqual(["idle", "later", "later"]);
    expect(read.next).toEqual(["you:wayfinding:null", "another-map:spec:2"]);
    expect(read.group).toBe("needs-you");
  });

  test("an unheld open wait gives no action and does not throw", () => {
    const read = readStatus(
      input({ specs: [DELIVERED], waits: [{ ...heldWait(2, "revision"), hold: null }] }),
    );
    expect(read.next).toEqual(["nobody:delivery:1"]);
    expect(read.tones[2]).toBe("done");
  });

  test("a released wait's run working on a spec the map has not written: Spec working, the agent's", () => {
    const released: SpecWaitView = {
      ...heldWait(2, "revision"),
      hold: null,
      released: true,
      run: "working",
    };
    const read = readStatus(input({ specs: [DELIVERED], waits: [released] }));
    expect(read.tones[2]).toBe("working");
    expect(read.next).toEqual(["agent:spec:2"]);
    expect(read.group).toBe("working");
  });

  test("a released wait's run stopped: Try again on it, yours", () => {
    const stopped = { runId: RUN_5, code: "agent_timed_out" } as const;
    const read = readStatus(
      input({
        waits: [{ ...heldWait(2, "revision"), hold: null, released: true, run: { stopped } }],
      }),
    );
    expect(read.tones[2]).toBe("needs-you");
    expect(read.next).toEqual(["you:spec:2"]);
    expect(read.status.next[0]).toMatchObject({ label: "Try again", stopped });
  });

  test("a released wait on a spec the map wrote reads its run on that spec's Spec stage", () => {
    const read = readStatus(
      input({
        specs: [DELIVERED],
        waits: [{ ...heldWait(1, "delivering"), hold: null, released: true, run: "working" }],
      }),
    );
    expect(read.specTones).toEqual([["working", "done", "done"]]);
    expect(read.next).toEqual(["agent:spec:1"]);
  });
});

describe("mapStatus revisions of a delivered spec", () => {
  test.each([
    { rule: "awaiting review", set: { ...SET_PENDING, replaced: true } },
    { rule: "held by its review", set: { ...SET_HELD, replaced: true } },
  ])("a replaced set ($rule) reads idle, nobody's, never yours", ({ set }) => {
    const read = readStatus(input({ specs: [spec(1, { revisions: [APPROVED], ticketSet: set })] }));
    expect(read.specTones).toEqual([["done", "idle", "idle"]]);
    expect(read.next).toEqual(["nobody:tickets:1"]);
    expect(read.status.next[0]?.label).toBeNull();
    expect(read.group).toBe("quiet");
  });

  test("a confirmed set with no tickets: Delivery done, the map quiet", () => {
    const read = readStatus(
      input({
        specs: [spec(1, { revisions: [APPROVED], ticketSet: { ...SET_APPROVED, tickets: 0 } })],
      }),
    );
    expect(read.specTones).toEqual([["done", "done", "done"]]);
    expect(read.next).toEqual(["nobody:delivery:1"]);
    expect(read.group).toBe("quiet");
  });

  test("past r1 the Tickets line counts new tickets; Start delivery says when the rest is in the code", () => {
    const first = { ...SET_APPROVED, follows: false };
    const later = { ...SET_APPROVED, follows: true };
    const lines = [first, later].map(
      (set) =>
        mapStatus(input({ specs: [spec(1, { revisions: [APPROVED], ticketSet: set })] })).stages[3],
    );
    expect(lines.map((stage) => stage.tone)).toEqual(["done", "done"]);
    expect(lines[0]?.line).not.toBe(lines[1]?.line);
    const [plain, carried] = [false, true].map(
      (anyDelivered) =>
        mapStatus(
          input({
            specs: [spec(1, { revisions: [APPROVED], ticketSet: { ...later, anyDelivered } })],
          }),
        ).next[0],
    );
    expect([plain?.label, carried?.label]).toEqual(["Start delivery", "Start delivery"]);
    expect(plain?.detail).not.toBe(carried?.detail);
  });

  test("Waits on another map: the map's Spec stage reads idle while its spec is done", () => {
    const read = readStatus(
      input({
        specs: [spec(1, { revisions: [APPROVED], ticketSet: SET_APPROVED })],
        waits: [heldWait(2, "revision"), heldWait(3, "tickets")],
      }),
    );
    expect(read.tones.slice(2)).toEqual(["idle", "done", "needs-you"]);
    expect(read.next).toEqual(["you:delivery:1", "another-map:spec:2", "another-map:spec:3"]);
  });

  test("with two approved revisions on the map, status reads the later one", () => {
    const read = readStatus(
      input({
        specs: [
          spec(1, {
            revisions: [revision("approved", "passed", 1), revision("approved", "passed", 2)],
            ticketSet: { ...SET_PENDING, follows: true },
          }),
        ],
      }),
    );
    expect(read.specTones).toEqual([["done", "needs-you", "later"]]);
    // A later revision of the map awaiting approval: its tickets wait on it.
    const drafted = readStatus(
      input({
        specs: [
          spec(1, {
            revisions: [APPROVED, revision("draft", "passed", 2)],
            ticketSet: SET_APPROVED,
            runs: [run({ mergedAt: AT })],
          }),
        ],
      }),
    );
    expect(drafted.specTones).toEqual([["needs-you", "later", "done"]]);
    // Nothing offers to start a run of the earlier approved set: with no run, or one to start again.
    for (const runs of [
      [],
      [run({ state: "cancelled" })],
      [run({ state: "failed", failure: { code: "delivery_checks_failed", message: "Failed" } })],
    ]) {
      const waiting = readStatus(
        input({
          specs: [
            spec(1, {
              revisions: [APPROVED, revision("draft", "passed", 2)],
              ticketSet: SET_APPROVED,
              runs,
            }),
          ],
        }),
      );
      expect(waiting.specTones).toEqual([["needs-you", "later", "later"]]);
      expect(waiting.next).toEqual(["you:spec:1"]);
    }
    // A passed run still awaits Mark merged: its branch exists.
    const passed = readStatus(
      input({
        specs: [
          spec(1, {
            revisions: [APPROVED, revision("draft", "passed", 2)],
            ticketSet: SET_APPROVED,
            runs: [run({ state: "passed", finalCommit: "a".repeat(40) })],
          }),
        ],
      }),
    );
    expect(passed.specTones).toEqual([["needs-you", "later", "needs-you"]]);
  });
});
