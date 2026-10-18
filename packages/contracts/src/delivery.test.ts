import { describe, expect, test } from "vitest";

import { z } from "zod";

import {
  checkNeedsShell,
  cutAgentText,
  CHECK_COMMAND_MAX_LENGTH,
  CaptureFailureCode,
  CheckCommand,
  CheckPullRequestErrorCode,
  DELIVERY_CHECKS_MAX_COUNT,
  DELIVERY_SCREENS_MAX_COUNT,
  DeliveryAgentErrorCode,
  DeliveryChecks,
  DeliveryFailureCode,
  DeliveryActivityErrorCode,
  DeliveryRun,
  DomainCode,
  ImplementEvent,
  MarkMergedErrorCode,
  PickedScreens,
  PlanningAgentErrorCode,
  ProjectAppSetupCommands,
  ProjectChecks,
  ProjectFixCommands,
  REPAIR_LIMIT_MAX,
  RunEvent,
  SaveProjectSettingsErrorCode,
  SaveProjectSettingsErrorData,
  SaveProjectSettingsInput,
  SpecRun,
  CancelDeliveryErrorCode,
  StartDeliveryErrorCode,
  Verdict,
  VERDICT_FINDINGS_MAX_COUNT,
} from "./index.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e6f";
const TICKET_SET_ID = "0199b8a0-5c6e-7d2a-9f3b-6f5e4d3c2b1a";

function issues(result: {
  success: boolean;
  error?: { issues: { code: string; path: PropertyKey[] }[] };
}) {
  expect(result.success).toBe(false);
  if (result.error === undefined) {
    throw new Error("expected a validation error");
  }
  return result.error.issues.map((issue) => ({ code: issue.code, path: issue.path }));
}

describe("CheckCommand", () => {
  test("trims", () => {
    expect(CheckCommand.parse("  pnpm test  ")).toBe("pnpm test");
  });

  test("accepts a command of exactly the maximum length", () => {
    expect(CheckCommand.safeParse("a".repeat(CHECK_COMMAND_MAX_LENGTH)).success).toBe(true);
  });

  test.each(["", "   "])("refuses the blank command %j", (command) => {
    expect(issues(CheckCommand.safeParse(command))).toEqual([{ code: "too_small", path: [] }]);
  });

  test("refuses a command of 501 characters", () => {
    expect(issues(CheckCommand.safeParse("a".repeat(CHECK_COMMAND_MAX_LENGTH + 1)))).toEqual([
      { code: "too_big", path: [] },
    ]);
  });

  test.each(["pnpm install\npnpm test", "pnpm install\rpnpm test"])(
    "refuses a command with a line break %j",
    (command) => {
      expect(issues(CheckCommand.safeParse(command))).toEqual([
        { code: "invalid_format", path: [] },
      ]);
    },
  );
});

describe("DeliveryChecks", () => {
  test("accepts one and ten checks", () => {
    expect(DeliveryChecks.safeParse(["pnpm test"]).success).toBe(true);
    const ten = Array.from({ length: DELIVERY_CHECKS_MAX_COUNT }, () => "pnpm test");
    expect(DeliveryChecks.safeParse(ten).success).toBe(true);
  });

  test("refuses no checks", () => {
    expect(issues(DeliveryChecks.safeParse([]))).toEqual([{ code: "too_small", path: [] }]);
  });

  test("refuses eleven checks", () => {
    const eleven = Array.from({ length: DELIVERY_CHECKS_MAX_COUNT + 1 }, () => "pnpm test");
    expect(issues(DeliveryChecks.safeParse(eleven))).toEqual([{ code: "too_big", path: [] }]);
  });

  test("names the refused check by index", () => {
    expect(issues(DeliveryChecks.safeParse(["pnpm test", " "]))).toEqual([
      { code: "too_small", path: [1] },
    ]);
  });
});

describe("ProjectChecks and SaveProjectSettingsInput", () => {
  const PROJECT_ID = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e70";

  test("accepts no checks and ten checks", () => {
    expect(ProjectChecks.safeParse([]).success).toBe(true);
    const ten = Array.from({ length: DELIVERY_CHECKS_MAX_COUNT }, (_, i) => `check ${String(i)}`);
    expect(ProjectChecks.safeParse(ten).success).toBe(true);
  });

  test("refuses eleven checks", () => {
    const eleven = Array.from(
      { length: DELIVERY_CHECKS_MAX_COUNT + 1 },
      (_, i) => `c ${String(i)}`,
    );
    expect(issues(ProjectChecks.safeParse(eleven))).toEqual([{ code: "too_big", path: [] }]);
  });

  test("refuses duplicates, after trimming", () => {
    expect(issues(ProjectChecks.safeParse(["pnpm test", " pnpm test "]))).toEqual([
      { code: "custom", path: [] },
    ]);
  });

  const input = {
    projectId: PROJECT_ID,
    baseBranch: "main",
    requiredChecks: [],
    repairLimit: 0,
    fixCommands: [],
    appStartCommand: null,
    appUrl: null,
    appSetupCommands: [],
  };

  test("a save takes the project, the branch, the checks, the repair limit and the fix commands", () => {
    expect(SaveProjectSettingsInput.safeParse(input).success).toBe(true);
    expect(
      issues(SaveProjectSettingsInput.safeParse({ ...input, requiredChecks: ["a", "a"] })),
    ).toEqual([{ code: "custom", path: ["requiredChecks"] }]);
  });

  test("the repair limit is a required whole number from 0 to 10", () => {
    expect(
      SaveProjectSettingsInput.safeParse({ ...input, repairLimit: REPAIR_LIMIT_MAX }).success,
    ).toBe(true);
    expect(issues(SaveProjectSettingsInput.safeParse({ ...input, repairLimit: 11 }))).toEqual([
      { code: "too_big", path: ["repairLimit"] },
    ]);
    expect(issues(SaveProjectSettingsInput.safeParse({ ...input, repairLimit: -1 }))).toEqual([
      { code: "too_small", path: ["repairLimit"] },
    ]);
    expect(issues(SaveProjectSettingsInput.safeParse({ ...input, repairLimit: 1.5 }))).toEqual([
      { code: "invalid_type", path: ["repairLimit"] },
    ]);
    expect(issues(SaveProjectSettingsInput.safeParse({ ...input, repairLimit: null }))).toEqual([
      { code: "invalid_type", path: ["repairLimit"] },
    ]);
    const withoutLimit = {
      projectId: PROJECT_ID,
      baseBranch: "main",
      requiredChecks: [],
      fixCommands: [],
      appStartCommand: null,
      appUrl: null,
      appSetupCommands: [],
    };
    expect(issues(SaveProjectSettingsInput.safeParse(withoutLimit))).toEqual([
      { code: "invalid_type", path: ["repairLimit"] },
    ]);
  });

  test("ten unique fix commands are accepted; eleven or a duplicate are refused", () => {
    const ten = Array.from({ length: DELIVERY_CHECKS_MAX_COUNT }, (_, i) => `fix ${String(i)}`);
    expect(ProjectFixCommands.safeParse(ten).success).toBe(true);
    expect(
      issues(SaveProjectSettingsInput.safeParse({ ...input, fixCommands: [...ten, "fix 10"] })),
    ).toEqual([{ code: "too_big", path: ["fixCommands"] }]);
    expect(
      issues(
        SaveProjectSettingsInput.safeParse({
          ...input,
          fixCommands: ["pnpm format", " pnpm format "],
        }),
      ),
    ).toEqual([{ code: "custom", path: ["fixCommands"] }]);
  });

  test("the app settings are required: the start command and URL may be null, the setup commands empty", () => {
    const withoutCommand = {
      projectId: PROJECT_ID,
      baseBranch: "main",
      requiredChecks: [],
      repairLimit: 0,
      fixCommands: [],
      appUrl: null,
      appSetupCommands: [],
    };
    expect(issues(SaveProjectSettingsInput.safeParse(withoutCommand))).toEqual([
      { code: "invalid_type", path: ["appStartCommand"] },
    ]);
    expect(
      SaveProjectSettingsInput.safeParse({
        ...input,
        appStartCommand: "pnpm dev",
        appUrl: "http://localhost:5173",
        appSetupCommands: ["pnpm install"],
      }).success,
    ).toBe(true);
  });

  test("ten unique app setup commands are accepted; eleven or a duplicate are refused", () => {
    const ten = Array.from({ length: DELIVERY_CHECKS_MAX_COUNT }, (_, i) => `setup ${String(i)}`);
    expect(ProjectAppSetupCommands.safeParse(ten).success).toBe(true);
    expect(
      issues(
        SaveProjectSettingsInput.safeParse({ ...input, appSetupCommands: [...ten, "setup 10"] }),
      ),
    ).toEqual([{ code: "too_big", path: ["appSetupCommands"] }]);
    expect(
      issues(
        SaveProjectSettingsInput.safeParse({
          ...input,
          appSetupCommands: ["pnpm install", " pnpm install "],
        }),
      ),
    ).toEqual([{ code: "custom", path: ["appSetupCommands"] }]);
  });

  test("an app start command or URL on two lines is refused", () => {
    expect(
      issues(SaveProjectSettingsInput.safeParse({ ...input, appStartCommand: "a\nb", appUrl: "x" })),
    ).toEqual([{ code: "invalid_format", path: ["appStartCommand"] }]);
    expect(
      issues(SaveProjectSettingsInput.safeParse({ ...input, appStartCommand: "a", appUrl: "x\ny" })),
    ).toEqual([{ code: "invalid_format", path: ["appUrl"] }]);
  });
});

describe("Verdict", () => {
  const finding = {
    axis: "spec",
    severity: "blocking",
    file: "src/index.ts",
    title: "Missing check",
    detail: "The ticket asks for a test.",
    criterion: "1.2",
  };
  const verdict = { reviewedCommit: COMMIT, summary: "Looks right.", findings: [finding] };

  test("accepts a verdict with no findings", () => {
    expect(Verdict.safeParse({ ...verdict, findings: [] }).success).toBe(true);
  });

  test("accepts a finding about no file and no criterion", () => {
    const findings = [
      { ...finding, axis: "standards", severity: "note", file: null, criterion: null },
    ];
    expect(Verdict.safeParse({ ...verdict, findings }).success).toBe(true);
  });

  test("requires a finding's criterion", () => {
    const withoutCriterion: Record<string, unknown> = { ...finding };
    delete withoutCriterion.criterion;
    expect(issues(Verdict.safeParse({ ...verdict, findings: [withoutCriterion] }))).toEqual([
      { code: "invalid_type", path: ["findings", 0, "criterion"] },
    ]);
  });

  test("refuses a criterion that is not a criterion id", () => {
    const findings = [{ ...finding, criterion: "T1" }];
    expect(issues(Verdict.safeParse({ ...verdict, findings }))).toEqual([
      { code: "invalid_format", path: ["findings", 0, "criterion"] },
    ]);
  });

  test.each([COMMIT.slice(1), COMMIT.toUpperCase()])(
    "refuses the reviewedCommit %j",
    (reviewedCommit) => {
      expect(issues(Verdict.safeParse({ ...verdict, reviewedCommit }))).toEqual([
        { code: "invalid_format", path: ["reviewedCommit"] },
      ]);
    },
  );

  test("refuses an unknown severity", () => {
    const findings = [{ ...finding, severity: "major" }];
    expect(issues(Verdict.safeParse({ ...verdict, findings }))).toEqual([
      { code: "invalid_value", path: ["findings", 0, "severity"] },
    ]);
  });

  test("refuses an unknown axis", () => {
    const findings = [{ ...finding, axis: "style" }];
    expect(issues(Verdict.safeParse({ ...verdict, findings }))).toEqual([
      { code: "invalid_value", path: ["findings", 0, "axis"] },
    ]);
  });

  test("refuses 51 findings", () => {
    const findings = Array.from({ length: VERDICT_FINDINGS_MAX_COUNT + 1 }, () => finding);
    expect(issues(Verdict.safeParse({ ...verdict, findings }))).toEqual([
      { code: "too_big", path: ["findings"] },
    ]);
  });

  test("refuses an unknown key", () => {
    expect(issues(Verdict.safeParse({ ...verdict, verdict: "pass" }))).toEqual([
      { code: "unrecognized_keys", path: [] },
    ]);
  });

  test("refuses an unknown key in a finding", () => {
    const findings = [{ ...finding, line: 3 }];
    expect(issues(Verdict.safeParse({ ...verdict, findings }))).toEqual([
      { code: "unrecognized_keys", path: ["findings", 0] },
    ]);
  });

  test("converts to a draft-07 JSON Schema with the root key reviewedCommit", () => {
    const schema = z.toJSONSchema(Verdict, { target: "draft-07" });
    expect(schema.properties).toHaveProperty("reviewedCommit");
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("DeliveryRun", () => {
  const ended = {
    id: RUN_ID,
    specificationId: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e99",
    ticketSetId: TICKET_SET_ID,
    number: 1,
    branch: "zenorm/add-numbers-3c4d5e6f-run-1",
    baseBranch: "main",
    baseCommit: COMMIT,
    checks: ["git status --short"],
    repairLimit: 3,
    repairAttempts: 1,
    startedAt: "2026-10-07T10:00:00.000Z",
    endedAt: "2026-10-07T10:30:00.000Z",
    state: "passed",
    phase: "reviewing",
    finalCommit: COMMIT,
    checkResults: [
      {
        command: "git status --short",
        exitCode: 0,
        timedOut: false,
        durationMs: 12,
        outputTail: "",
      },
    ],
    verdict: { reviewedCommit: COMMIT, summary: "Good.", findings: [] },
    failure: null,
    mergedAt: null,
    executor: "local",
    pullRequest: null,
  };
  const running = {
    ...ended,
    endedAt: null,
    state: "running",
    phase: "implementing",
    finalCommit: null,
    checkResults: null,
    verdict: null,
  };

  test("accepts a passed run, a merged run and a running run", () => {
    expect(DeliveryRun.safeParse(ended).success).toBe(true);
    expect(DeliveryRun.safeParse({ ...ended, mergedAt: "2026-10-07T11:00:00.000Z" }).success).toBe(
      true,
    );
    expect(DeliveryRun.safeParse(running).success).toBe(true);
  });

  test("accepts a failed run with its failure, which carries no phase", () => {
    const failed = {
      ...ended,
      state: "failed",
      phase: "verifying",
      verdict: null,
      failure: { code: "delivery_ticket_unmerged", message: "T2 was not merged." },
    };
    expect(DeliveryRun.safeParse(failed).success).toBe(true);
    expect(
      issues(
        DeliveryRun.safeParse({ ...failed, failure: { ...failed.failure, phase: "verifying" } }),
      ),
    ).toEqual([{ code: "unrecognized_keys", path: ["failure"] }]);
  });

  test("requires the stored phase on every state", () => {
    for (const run of [running, ended, { ...ended, state: "interrupted" }]) {
      expect(issues(DeliveryRun.safeParse({ ...run, phase: null }))).toEqual([
        { code: "invalid_value", path: ["phase"] },
      ]);
    }
  });

  test("names the executor carrying it, never empty", () => {
    expect(issues(DeliveryRun.safeParse({ ...ended, executor: undefined }))).toEqual([
      { code: "invalid_type", path: ["executor"] },
    ]);
    expect(issues(DeliveryRun.safeParse({ ...ended, executor: "" }))).toEqual([
      { code: "too_small", path: ["executor"] },
    ]);
    expect(DeliveryRun.safeParse({ ...ended, executor: "example" }).success).toBe(true);
  });

  test("carries its pinned repair limit and attempts, both null on a run from before repairs", () => {
    expect(
      DeliveryRun.safeParse({ ...ended, repairLimit: null, repairAttempts: null }).success,
    ).toBe(true);
    expect(issues(DeliveryRun.safeParse({ ...ended, repairLimit: undefined }))).toEqual([
      { code: "invalid_type", path: ["repairLimit"] },
    ]);
    expect(issues(DeliveryRun.safeParse({ ...ended, repairLimit: 11 }))).toEqual([
      { code: "too_big", path: ["repairLimit"] },
    ]);
    expect(issues(DeliveryRun.safeParse({ ...ended, repairAttempts: -1 }))).toEqual([
      { code: "too_small", path: ["repairAttempts"] },
    ]);
  });

  test("carries the pull request a passed run opened, or null", () => {
    const pullRequest = {
      number: 12,
      url: "https://github.com/acme/numbers/pull/12",
      state: "open",
    };
    expect(DeliveryRun.safeParse({ ...ended, phase: "publishing", pullRequest }).success).toBe(
      true,
    );
    expect(issues(DeliveryRun.safeParse({ ...ended, pullRequest: undefined }))).toEqual([
      { code: "invalid_type", path: ["pullRequest"] },
    ]);
    expect(
      issues(DeliveryRun.safeParse({ ...ended, pullRequest: { ...pullRequest, state: "draft" } })),
    ).toEqual([{ code: "invalid_value", path: ["pullRequest", "state"] }]);
    expect(
      issues(DeliveryRun.safeParse({ ...ended, pullRequest: { ...pullRequest, number: 0 } })),
    ).toEqual([{ code: "too_small", path: ["pullRequest", "number"] }]);
  });

  test("a run publishing its pull request reads phase publishing", () => {
    expect(DeliveryRun.safeParse({ ...running, phase: "publishing" }).success).toBe(true);
  });

  test("carries no worktree path", () => {
    expect(
      issues(DeliveryRun.safeParse({ ...ended, worktreePath: `/data/runs/${RUN_ID}/worktree` })),
    ).toEqual([{ code: "unrecognized_keys", path: [] }]);
  });

  test("refuses an unknown state", () => {
    expect(issues(DeliveryRun.safeParse({ ...ended, state: "merged" }))).toEqual([
      { code: "invalid_value", path: ["state"] },
    ]);
  });

  test("a spec run carries each ticket's status, or null before 0010", () => {
    const line = {
      seq: 3,
      at: "2026-10-07T10:05:00.000Z",
      who: "implementer",
      ticket: "T2",
      text: "Edited `src/a.ts`",
    };
    expect(RunEvent.safeParse(line).success).toBe(true);
    const tickets = [
      { ticket: "T1", status: { state: "merged", commit: COMMIT, summary: null }, failing: [] },
      { ticket: "T2", status: { state: "implementing", latest: line }, failing: ["1.2"] },
      { ticket: "T3", status: { state: "implementing", latest: null }, failing: [] },
      {
        ticket: "T4",
        status: { state: "waiting", on: [{ ticket: "T2", supplies: "The parser." }] },
        failing: [],
      },
      { ticket: "T5", status: { state: "starting" }, failing: [] },
      { ticket: "T6", status: { state: "not_delivered", started: true }, failing: [] },
    ];
    expect(SpecRun.safeParse({ ...running, tickets }).success).toBe(true);
    expect(SpecRun.safeParse({ ...ended, tickets: null }).success).toBe(true);
    expect(issues(SpecRun.safeParse({ ...ended }))).toEqual([
      { code: "invalid_type", path: ["tickets"] },
    ]);
  });

  test("a run line is 1 to 500 characters from a known actor", () => {
    const line = { seq: 1, at: "2026-10-07T10:05:00.000Z", who: "zenorm", ticket: null };
    expect(RunEvent.safeParse({ ...line, text: "a".repeat(500) }).success).toBe(true);
    expect(issues(RunEvent.safeParse({ ...line, text: "a".repeat(501) }))).toEqual([
      { code: "too_big", path: ["text"] },
    ]);
    expect(issues(RunEvent.safeParse({ ...line, who: "merger", text: "x" }))).toEqual([
      { code: "invalid_value", path: ["who"] },
    ]);
  });
});

describe("ImplementEvent", () => {
  test("accepts a line, a started ticket and a merged ticket", () => {
    for (const event of [
      { kind: "line", who: "orchestrator", ticket: null, text: "Starting." },
      { kind: "line", who: "implementer", ticket: "T1", text: "Edited `src/a.ts`" },
      { kind: "ticket_started", ticket: "T1" },
      { kind: "ticket_merged", ticket: "T1", summary: null },
    ]) {
      expect(ImplementEvent.safeParse(event).success).toBe(true);
    }
  });

  test("refuses a reviewer or ZeNorm line", () => {
    expect(
      issues(ImplementEvent.safeParse({ kind: "line", who: "zenorm", ticket: null, text: "x" })),
    ).toEqual([{ code: "invalid_value", path: ["who"] }]);
  });
});

describe("delivery codes", () => {
  test("DeliveryAgentErrorCode is the planning agent's codes, agent_skill_missing and agent_cancelled", () => {
    expect([...DeliveryAgentErrorCode.options].sort()).toEqual(
      [...PlanningAgentErrorCode.options, "agent_skill_missing", "agent_cancelled"].sort(),
    );
  });

  test("DeliveryFailureCode covers every delivery agent code", () => {
    for (const code of DeliveryAgentErrorCode.options) {
      expect(DeliveryFailureCode.options).toContain(code);
    }
  });

  test("DeliveryFailureCode carries the publishing step's five codes", () => {
    for (const code of [
      "delivery_gh_missing",
      "delivery_github_not_signed_in",
      "delivery_github_unreachable",
      "delivery_push_failed",
      "delivery_pull_request_failed",
    ]) {
      expect(DeliveryFailureCode.options).toContain(code);
      expect(DomainCode.options).toContain(code);
    }
  });

  test("delivery.start refuses in its blocker order", () => {
    expect(StartDeliveryErrorCode.options).toEqual([
      "ticket_set_not_found",
      "ticket_set_not_approved",
      "delivery_nothing_to_deliver",
      "delivery_already_passed",
      "project_folder_missing",
      "project_branch_missing",
      "project_checks_missing",
      "project_repair_limit_missing",
      "delivery_in_progress",
      "delivery_branch_exists",
      "delivery_not_admitted",
    ]);
  });

  test("DomainCode covers every delivery code", () => {
    for (const code of [
      ...StartDeliveryErrorCode.options,
      ...CancelDeliveryErrorCode.options,
      ...DeliveryFailureCode.options,
      ...SaveProjectSettingsErrorCode.options,
      ...MarkMergedErrorCode.options,
      ...CheckPullRequestErrorCode.options,
      ...DeliveryActivityErrorCode.options,
    ]) {
      expect(DomainCode.options).toContain(code);
    }
    expect(new Set(DomainCode.options).size).toBe(DomainCode.options.length);
  });

  test("a capture failure code is a domain code and never a delivery failure code", () => {
    expect(CaptureFailureCode.options).toContain("capture_picker_failed");
    for (const code of CaptureFailureCode.options) {
      expect(DomainCode.options).toContain(code);
      expect(DeliveryFailureCode.options).not.toContain(code);
    }
  });
});

describe("PickedScreens", () => {
  const screen = { where: "/settings", changed: "A new App section.", isNew: false };

  test("no visible change, or one to six screens", () => {
    expect(PickedScreens.safeParse({ kind: "no_visible_change" }).success).toBe(true);
    expect(PickedScreens.safeParse({ kind: "screens", screens: [screen] }).success).toBe(true);
    expect(
      PickedScreens.safeParse({
        kind: "screens",
        screens: Array.from({ length: DELIVERY_SCREENS_MAX_COUNT }, () => screen),
      }).success,
    ).toBe(true);
  });

  test("refuses no screens listed and more than six", () => {
    expect(PickedScreens.safeParse({ kind: "screens", screens: [] }).success).toBe(false);
    expect(
      PickedScreens.safeParse({
        kind: "screens",
        screens: Array.from({ length: DELIVERY_SCREENS_MAX_COUNT + 1 }, () => screen),
      }).success,
    ).toBe(false);
  });
});

describe("checkNeedsShell", () => {
  test.each(["pnpm test", "node --test", "git status --short", "pnpm --filter @zenorm/web test"])(
    "%j runs without a shell",
    (command) => {
      expect(checkNeedsShell(command)).toBe(false);
    },
  );

  test.each([
    "a && b",
    "a | b",
    "a; b",
    "a > f",
    "a < f",
    "echo $X",
    'a "b"',
    "a 'b'",
    "a `b`",
    "a \\ b",
    "a &",
  ])("%j needs a shell", (command) => {
    expect(checkNeedsShell(command)).toBe(true);
  });

  test("project_check_invalid carries the command", () => {
    expect(SaveProjectSettingsErrorCode.options).toContain("project_check_invalid");
    expect(SaveProjectSettingsErrorData.project_check_invalid.parse({ command: "a && b" })).toEqual(
      { command: "a && b" },
    );
  });

  test("project_fix_command_invalid carries the command", () => {
    expect(SaveProjectSettingsErrorCode.options).toContain("project_fix_command_invalid");
    expect(
      SaveProjectSettingsErrorData.project_fix_command_invalid.parse({ command: "a && b" }),
    ).toEqual({ command: "a && b" });
  });
});

describe("cutAgentText", () => {
  test("keeps a text that fits and cuts a longer one to max with an ellipsis", () => {
    expect(cutAgentText("abc", 3)).toBe("abc");
    expect(cutAgentText("abcdef", 4)).toBe("abc…");
    expect(cutAgentText("🙂".repeat(5), 6)).toBe("🙂🙂…");
  });

  test("never ends inside an inline-code pair", () => {
    expect(cutAgentText("Added `--lines` and `--limit` flags", 25)).toBe("Added `--lines` and …");
  });

  test("never ends inside a bold pair, ignoring asterisks inside code", () => {
    expect(cutAgentText("Done. **Unchanged behaviour** stays", 24)).toBe("Done. …");
    expect(cutAgentText("Use `a ** b` then **bold text** here", 26)).toBe("Use `a ** b` then …");
    expect(cutAgentText("**Kept** and `code` and more text", 30)).toBe(
      "**Kept** and `code` and more …",
    );
  });
});
