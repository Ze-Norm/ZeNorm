import type {
  CheckResult,
  DeliveryRun,
  RunTicket,
  SpecRun,
  TicketContent,
} from "@zenorm/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PullRequestActions } from "./PullRequestStatus.tsx";
import { RunSteps } from "./RunSteps.tsx";
import {
  closingMark,
  mergeMark,
  repairAttempt,
  repairedVerifyLine,
  repairLine,
  RUN_STEPS,
  stepMark,
} from "./steps.ts";
import { ClosingRow } from "./RunTickets.tsx";

const COMMIT = "c".repeat(40);
const PULL_REQUEST = {
  number: 12,
  url: "https://github.com/acme/numbers/pull/12",
  state: "open",
} as const;
const VERDICT = { reviewedCommit: COMMIT, summary: "The change matches.", findings: [] };
const CHECK = {
  command: "pnpm test",
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  outputTail: "",
};
const TICKET: TicketContent = {
  id: "T1",
  title: "Write the exporter",
  build: "Write it.",
  blockedBy: [],
  criteria: ["1.1"],
  testing: ["It writes."],
  followUp: null,
  outOfScope: [],
  pointers: [],
};

const FAILED: CheckResult = {
  command: "pnpm lint",
  exitCode: 1,
  timedOut: false,
  durationMs: 10,
  outputTail: "1 error",
};
const PASSED: CheckResult = { ...FAILED, command: "pnpm test", exitCode: 0, outputTail: "" };
const TIMED_OUT: CheckResult = { ...FAILED, command: "pnpm e2e", exitCode: null, timedOut: true };

/** A run that reached publishing: every check passed and the review passed. */
function run(fields: Partial<SpecRun>): SpecRun {
  return {
    id: "0190a000-0000-7000-8000-000000000001",
    specificationId: "0190a000-0000-7000-8000-000000000100",
    ticketSetId: "0190a000-0000-7000-8000-000000000200",
    number: 1,
    branch: "zenorm/export-run-1",
    baseBranch: "main",
    baseCommit: "b".repeat(40),
    checks: ["pnpm test"],
    repairLimit: 2,
    repairAttempts: 0,
    state: "running",
    phase: "publishing",
    startedAt: "2026-10-14T10:00:00.000Z",
    endedAt: null,
    finalCommit: COMMIT,
    checkResults: [CHECK],
    verdict: null,
    failure: null,
    mergedAt: null,
    executor: "local",
    pullRequest: null,
    tickets: null,
    ...fields,
  };
}

/** Each step's name and mark as `RunSteps` renders them, in order. */
function renderedMarks(shown: SpecRun): [string, string][] {
  const markup = renderToStaticMarkup(
    createElement(RunSteps, {
      run: shown,
      tickets: [TICKET],
      revision: 1,
      links: { mapId: "0190a000-0000-7000-8000-000000000300", specNumber: 1, run: 1 },
    }),
  );
  return [...markup.matchAll(/<section aria-label="([^"]+)" data-mark="([^"]+)"/g)].map(
    ([, name, mark]) => [String(name), String(mark)],
  );
}

describe("the steps while a run publishes its pull request", () => {
  it("reads Review done and Merge working, still five steps", () => {
    const publishing = run({});
    expect(RUN_STEPS.map((step) => stepMark(publishing, step))).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(mergeMark(publishing)).toBe("working");
    expect(renderedMarks(publishing)).toEqual([
      ["Prepare", "done"],
      ["Implement", "done"],
      ["Verify", "done"],
      ["Review", "done"],
      ["Merge", "working"],
    ]);
  });

  it("says ZeNorm is opening the pull request", () => {
    const markup = renderToStaticMarkup(
      createElement(RunSteps, {
        run: run({}),
        tickets: [TICKET],
        revision: 1,
        links: { mapId: "0190a000-0000-7000-8000-000000000300", specNumber: 1, run: 1 },
      }),
    );
    expect(markup).toContain("opening its pull request on GitHub");
    expect(markup).toContain("The review passed with no blocking finding.");
  });

  it.each([
    {
      state: "failed",
      failure: { code: "delivery_push_failed", message: "git push of the branch failed." },
    },
    { state: "cancelled", failure: null },
    { state: "interrupted", failure: null },
  ] as const)("a $state publishing run reads Review done and Merge stopped", (fields) => {
    const stopped = run({
      ...fields,
      endedAt: fields.state === "interrupted" ? null : "2026-10-14T10:30:00.000Z",
    });
    expect(stepMark(stopped, "review")).toBe("done");
    expect(mergeMark(stopped)).toBe("stopped");
    expect(renderedMarks(stopped)).toEqual([
      ["Prepare", "done"],
      ["Implement", "done"],
      ["Verify", "done"],
      ["Review", "done"],
      ["Merge", "stopped"],
    ]);
  });
});

describe("the Merge step of a passed run", () => {
  it("with a pull request: the person's, merged on GitHub", () => {
    const passed = run({
      state: "passed",
      endedAt: "2026-10-14T10:30:00.000Z",
      verdict: VERDICT,
      pullRequest: PULL_REQUEST,
    });
    expect(mergeMark(passed)).toBe("yours");
    const markup = renderToStaticMarkup(
      createElement(RunSteps, {
        run: passed,
        tickets: [TICKET],
        revision: 1,
        links: { mapId: "0190a000-0000-7000-8000-000000000300", specNumber: 1, run: 1 },
      }),
    );
    expect(markup).toContain("merge pull request #12 into main on GitHub");
    expect(markup).not.toContain("mark it merged");
  });

  it("without one: Mark merged, as before", () => {
    const passed = run({
      state: "passed",
      phase: "reviewing",
      endedAt: "2026-10-14T10:30:00.000Z",
      verdict: VERDICT,
    });
    expect(mergeMark(passed)).toBe("yours");
    expect(renderedMarks(passed).at(-1)).toEqual(["Merge", "yours"]);
  });

  it("shows the pull request's link and state on the Merge step", () => {
    const markup = renderToStaticMarkup(
      createElement(RunSteps, {
        run: run({
          state: "passed",
          endedAt: "2026-10-14T10:30:00.000Z",
          verdict: VERDICT,
          pullRequest: PULL_REQUEST,
        }),
        tickets: [TICKET],
        revision: 1,
        links: { mapId: "0190a000-0000-7000-8000-000000000300", specNumber: 1, run: 1 },
      }),
    );
    expect(markup).toContain('aria-label="Pull request" data-state="open"');
    expect(markup).toContain(`href="${PULL_REQUEST.url}"`);
  });

  it("a merged pull request reads Merge done, merged on GitHub", () => {
    const merged = run({
      state: "passed",
      endedAt: "2026-10-14T10:30:00.000Z",
      verdict: VERDICT,
      mergedAt: "2026-10-14T11:00:00.000Z",
      pullRequest: { ...PULL_REQUEST, state: "merged" },
    });
    expect(mergeMark(merged)).toBe("done");
    const markup = renderToStaticMarkup(
      createElement(RunSteps, {
        run: merged,
        tickets: [TICKET],
        revision: 1,
        links: { mapId: "0190a000-0000-7000-8000-000000000300", specNumber: 1, run: 1 },
      }),
    );
    expect(renderedMarks(merged).at(-1)).toEqual(["Merge", "done"]);
    expect(markup).toContain("Pull request #12 is merged into main.");
    expect(markup).toContain('data-state="merged"');
  });

  it("a run stopped before publishing never reached Merge", () => {
    const failed = run({
      state: "failed",
      phase: "verifying",
      endedAt: "2026-10-14T10:30:00.000Z",
      checkResults: null,
      failure: { code: "delivery_checks_failed", message: "A check failed." },
    });
    expect(mergeMark(failed)).toBe("not-reached");
    expect(stepMark(failed, "verify")).toBe("stopped");
    expect(stepMark(failed, "review")).toBe("not-reached");
  });
});

/** The labels of the buttons in `markup`, tags stripped, in order. */
function buttonLabels(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, inner]) =>
    String(inner)
      .replace(/<[^>]+>/g, "")
      .trim(),
  );
}

function actionsMarkup(state: "open" | "closed", checking: boolean): string {
  return renderToStaticMarkup(
    createElement(PullRequestActions, {
      pullRequest: { ...PULL_REQUEST, state },
      checking,
      onCheckNow: () => undefined,
      refusal: null,
    }),
  );
}

describe("the pull request card's actions", () => {
  it("an open pull request: its link to merge on GitHub, and Check now", () => {
    const markup = actionsMarkup("open", false);
    expect(markup).toContain("Open pull request #12");
    expect(markup).toContain(`href="${PULL_REQUEST.url}"`);
    expect(buttonLabels(markup)).toEqual(["Check now"]);
  });

  it("a closed pull request shows closed, with Check now as its only action and no Mark merged", () => {
    const markup = actionsMarkup("closed", false);
    expect(buttonLabels(markup)).toEqual(["Check now"]);
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("Mark merged");

    const closed = run({
      state: "passed",
      endedAt: "2026-10-14T10:30:00.000Z",
      verdict: VERDICT,
      pullRequest: { ...PULL_REQUEST, state: "closed" },
    });
    expect(mergeMark(closed)).toBe("yours");
    const steps = renderToStaticMarkup(
      createElement(RunSteps, {
        run: closed,
        tickets: [TICKET],
        revision: 1,
        links: { mapId: "0190a000-0000-7000-8000-000000000300", specNumber: 1, run: 1 },
      }),
    );
    expect(steps).toContain('aria-label="Pull request" data-state="closed"');
    expect(steps).toContain(">closed<");
    expect(steps).toContain("was closed on GitHub without being merged");
    expect(steps).not.toContain("mark it merged");
  });

  it("while the check runs, Check now reads checking and is disabled", () => {
    const markup = actionsMarkup("open", true);
    expect(buttonLabels(markup)).toEqual(["Checking pull request #12…"]);
    expect(markup).toMatch(/<button[^>]*disabled/);
  });
});

/** A run implementing its tickets, with a pinned repair limit of 3 and no attempt yet. */
function repairRun(fields: Partial<DeliveryRun>): DeliveryRun {
  return {
    id: "0190a000-0000-7000-8000-000000000001",
    specificationId: "0190a000-0000-7000-8000-000000000100",
    ticketSetId: "0190a000-0000-7000-8000-000000000200",
    number: 1,
    branch: "zenorm/search",
    baseBranch: "main",
    baseCommit: "b".repeat(40),
    checks: ["pnpm lint", "pnpm test", "pnpm e2e"],
    repairLimit: 3,
    repairAttempts: 0,
    state: "running",
    phase: "implementing",
    startedAt: "2026-10-14T10:00:00.000Z",
    endedAt: null,
    finalCommit: null,
    checkResults: null,
    verdict: null,
    failure: null,
    mergedAt: null,
    executor: "local",
    pullRequest: null,
    ...fields,
  };
}

describe("a repair attempt on the run's steps", () => {
  it("is back on Implement, as a repair with its attempt out of the pinned limit", () => {
    const repairing = repairRun({ repairAttempts: 1, checkResults: [FAILED, PASSED, TIMED_OUT] });
    expect(stepMark(repairing, "implement")).toBe("working");
    expect(stepMark(repairing, "verify")).toBe("not-reached");
    const attempt = repairAttempt(repairing);
    expect(attempt).toEqual({ attempt: 1, limit: 3, failing: 2 });
    if (attempt === null) return;
    expect(repairLine(attempt)).toBe("Repairing 2 failing checks, attempt 1 of 3.");
  });

  it("is none on a first pass, in another phase, or on a run from before repairs", () => {
    expect(repairAttempt(repairRun({}))).toBeNull();
    expect(
      repairAttempt(repairRun({ phase: "verifying", repairAttempts: 1, checkResults: [FAILED] })),
    ).toBeNull();
    expect(repairAttempt(repairRun({ repairLimit: null, repairAttempts: null }))).toBeNull();
  });

  it("an ended run's Verify line gives the attempts it used; a first-time pass keeps today's line", () => {
    const ended = { state: "passed", endedAt: "2026-10-14T11:00:00.000Z" } as const;
    expect(repairedVerifyLine(repairRun({ ...ended, repairAttempts: 2 }), true)).toBe(
      "All checks passed after 2 repair attempts.",
    );
    expect(
      repairedVerifyLine(
        repairRun({ state: "failed", phase: "verifying", repairAttempts: 3 }),
        false,
      ),
    ).toBe("Still failing after 3 of 3 repair attempts.");
    expect(repairedVerifyLine(repairRun({ ...ended, repairAttempts: 0 }), true)).toBeNull();
    expect(
      repairedVerifyLine(repairRun({ ...ended, repairLimit: null, repairAttempts: null }), true),
    ).toBeNull();
  });
});

describe("the agent's review and checks, the Implement step's last row", () => {
  const merged: RunTicket = {
    ticket: "T1",
    status: { state: "merged", commit: COMMIT, summary: null },
    failing: [],
  };
  const started: RunTicket = {
    ticket: "T1",
    status: { state: "implementing", latest: null },
    failing: [],
  };
  const implementing = (fields: Partial<SpecRun>) =>
    run({ phase: "implementing", finalCommit: null, checkResults: null, ...fields });

  it("waits while a ticket is being implemented, then runs once every ticket is merged", () => {
    expect(closingMark(implementing({ tickets: [merged, started] }))).toBe("waiting");
    expect(closingMark(implementing({ phase: "preparing", tickets: [started] }))).toBe("waiting");
    expect(closingMark(implementing({ tickets: [merged] }))).toBe("running");
    // A repair attempt reviews and checks again once it has fixed the failures.
    expect(
      closingMark(implementing({ tickets: [merged], repairAttempts: 1, checkResults: [FAILED] })),
    ).toBe("running");
  });

  it("is done past Implement, and stopped when the run ended in it with every ticket merged", () => {
    expect(closingMark(run({ phase: "verifying", tickets: [merged] }))).toBe("done");
    expect(closingMark(run({ state: "passed", tickets: [merged] }))).toBe("done");
    expect(
      closingMark(
        implementing({
          state: "cancelled",
          endedAt: "2026-10-14T10:30:00.000Z",
          tickets: [merged],
        }),
      ),
    ).toBe("stopped");
  });

  it("has no row before every ticket merged on an ended run, without ticket rows, or on another executor", () => {
    expect(
      closingMark(
        implementing({
          state: "cancelled",
          endedAt: "2026-10-14T10:30:00.000Z",
          tickets: [started],
        }),
      ),
    ).toBeNull();
    expect(closingMark(implementing({ tickets: null }))).toBeNull();
    expect(closingMark(implementing({ executor: "example", tickets: [merged] }))).toBeNull();
  });

  it("says what the agent is doing, with the run's required checks", () => {
    const markup = renderToStaticMarkup(createElement(ClosingRow, { mark: "running", checks: 2 }));
    expect(markup).toContain(
      "The agent is reviewing the branch against the spec and running the 2 required checks.",
    );
    expect(markup).toContain("running");
  });
});
