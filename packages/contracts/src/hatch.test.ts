import { describe, expect, test } from "vitest";

import {
  DomainCode,
  HatchMessageView,
  HatchRefusal,
  HatchWaypoint,
  NextAction,
  PlanningRunCancelReason,
  PlanningRunFailureCode,
  SendHatchMessageErrorCode,
  SendHatchMessageInput,
} from "./index.ts";

const MAP_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const AT = "2026-10-08T12:00:00.000Z";

describe("SendHatchMessageInput (S7b-2)", () => {
  test("names a spec only from Spec or Tickets; blank text reaches core", () => {
    const input = { mapId: MAP_ID, specNumber: null, text: "  " };
    for (const stage of ["idea", "wayfinding", "spec", "tickets"]) {
      expect(SendHatchMessageInput.safeParse({ ...input, stage }).success, stage).toBe(true);
    }
    for (const stage of ["spec", "tickets"]) {
      expect(
        SendHatchMessageInput.safeParse({ ...input, stage, specNumber: 1 }).success,
        stage,
      ).toBe(true);
    }
    for (const stage of ["idea", "wayfinding"]) {
      expect(
        SendHatchMessageInput.safeParse({ ...input, stage, specNumber: 1 }).success,
        stage,
      ).toBe(false);
    }
    expect(SendHatchMessageInput.safeParse({ ...input, stage: "delivery" }).success).toBe(false);
    expect(
      SendHatchMessageInput.safeParse({ ...input, stage: "idea", text: "x".repeat(4001) }).success,
    ).toBe(false);
  });
});

describe("HatchMessageView (D6)", () => {
  const message = { id: MAP_ID, stage: "spec", spec: 1, text: "Any depth?", sentAt: AT };

  test("reads queued, working, stopped with its run, or replied with an optional refusal", () => {
    for (const status of [
      { state: "queued" },
      { state: "working" },
      { state: "stopped", stopped: { runId: MAP_ID, code: "hatch_change_invalid" } },
      { state: "replied", reply: "Yes.", refusal: null, repliedAt: AT },
      { state: "replied", reply: "No.", refusal: "spec_in_flight", repliedAt: AT },
    ]) {
      expect(HatchMessageView.safeParse({ ...message, status }).success, status.state).toBe(true);
    }
    expect(
      HatchMessageView.safeParse({
        ...message,
        status: { state: "replied", reply: "", refusal: null, repliedAt: AT },
      }).success,
    ).toBe(false);
    expect(
      HatchMessageView.safeParse({
        ...message,
        status: { state: "replied", reply: "No.", refusal: "busy", repliedAt: AT },
      }).success,
    ).toBe(false);
  });
});

describe("the slice 7b codes", () => {
  test("D4's refusals, hatch.send's codes and hatch_change_invalid are domain codes", () => {
    expect(HatchRefusal.options).toEqual([
      "spec_in_flight",
      "map_uncleared",
      "spec_approved",
      "ticket_set_approved",
      "no_ticket_set",
      "waypoint_not_waiting",
      "waypoint_state",
      "spec_waiting",
      "exclusion_not_found",
      "exclusion_already_split",
    ]);
    for (const code of [
      ...HatchRefusal.options,
      ...SendHatchMessageErrorCode.options,
      "hatch_change_invalid",
    ]) {
      expect(DomainCode.options).toContain(code);
    }
    expect(new Set(DomainCode.options).size).toBe(DomainCode.options.length);
    expect(PlanningRunFailureCode.options).toContain("hatch_change_invalid");
    expect(PlanningRunCancelReason.options).toEqual(["replaced", "reopened"]);
  });

  test("a next action's label is one of the demo's buttons, or null", () => {
    const action = {
      who: "you",
      stage: "spec",
      headline: "Approve the revised spec.",
      detail: null,
      round: null,
      stopped: null,
      waiting: null,
      spec: 1,
      onMap: null,
    };
    expect(NextAction.safeParse({ ...action, label: "Approve the revision" }).success).toBe(true);
    expect(NextAction.safeParse({ ...action, who: "agent", label: null }).success).toBe(true);
    expect(NextAction.safeParse({ ...action, label: "Open Spec" }).success).toBe(false);
  });

  test("a hatch waypoint carries its report exactly when it waits on an unanswered one (L162 (4))", () => {
    const waypoint = {
      number: 1,
      kind: "research",
      title: "Proxy",
      question: "Does fetch honour the proxy?",
      status: "open",
      blockedBy: [],
      resolution: null,
      gist: null,
      agentDecided: null,
      stopped: false,
    };
    const report = { summary: "Unclear before Node 24.", gap: "Node 22's behaviour." };
    expect(
      HatchWaypoint.safeParse({ ...waypoint, waiting: "research_unanswered", report }).success,
    ).toBe(true);
    expect(HatchWaypoint.safeParse({ ...waypoint, waiting: null, report: null }).success).toBe(
      true,
    );
    expect(
      HatchWaypoint.safeParse({ ...waypoint, waiting: "research_unanswered", report: null })
        .success,
    ).toBe(false);
    expect(HatchWaypoint.safeParse({ ...waypoint, waiting: "task_failed", report }).success).toBe(
      false,
    );
  });
});
