import type {
  ActivityLine,
  HatchMessageView,
  MapSpec,
  SpecWaitView,
  StageTone,
} from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import {
  aboutSpec,
  canSend,
  clausePrefill,
  composerKeyAction,
  filterStream,
  replyingMessages,
  stoppedRun,
  streamEntries,
} from "./hatch.ts";

const RUN = "00000000000000000000000009";

function line(
  stage: ActivityLine["stage"],
  at: string,
  waypoint: number | null = null,
): ActivityLine {
  return { stage, text: `A line at ${at}`, waypoint, spec: null, specLabel: null, at };
}

function message(
  id: string,
  stage: HatchMessageView["stage"],
  sentAt: string,
  status: HatchMessageView["status"],
): HatchMessageView {
  return { id, stage, spec: null, text: `Message ${id}`, sentAt, status };
}

function replied(repliedAt: string): HatchMessageView["status"] {
  return { state: "replied", reply: "The reply.", refusal: null, repliedAt };
}

const T = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("streamEntries", () => {
  it("interleaves lines, messages and replies by time", () => {
    const entries = streamEntries(
      [line("idea", T(0)), line("wayfinding", T(3)), line("spec", T(6))],
      [
        message("m1", "spec", T(1), replied(T(4))),
        message("m2", "wayfinding", T(5), { state: "working" }),
      ],
    );
    expect(entries.map((entry) => [entry.kind, entry.at])).toEqual([
      ["event", T(0)],
      ["message", T(1)],
      ["event", T(3)],
      ["reply", T(4)],
      ["message", T(5)],
      ["event", T(6)],
    ]);
  });

  it("puts a reply before the lines its change wrote at the same moment", () => {
    const entries = streamEntries(
      [line("wayfinding", T(2), 2)],
      [message("m1", "spec", T(1), replied(T(2)))],
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "reply", "event"]);
  });

  it("gives a reply its message's stage and a refusal a reply", () => {
    const refused = message("m1", "tickets", T(1), {
      state: "replied",
      reply: "The spec stands.",
      refusal: "spec_approved",
      repliedAt: T(2),
    });
    const [, reply] = streamEntries([], [refused]);
    expect(reply).toMatchObject({ kind: "reply", stage: "tickets", message: refused });
  });

  it("shows no reply for a message that is not replied", () => {
    const stopped = message("m1", "idea", T(1), {
      state: "stopped",
      stopped: { runId: RUN, code: "agent_run_failed" },
    });
    expect(streamEntries([], [stopped]).map((entry) => entry.kind)).toEqual(["message"]);
    expect(stoppedRun(stopped)).toEqual({ runId: RUN, code: "agent_run_failed" });
    expect(stoppedRun(message("m2", "idea", T(1), { state: "queued" }))).toBeNull();
  });
});

describe("filterStream", () => {
  const entries = streamEntries(
    [line("idea", T(0)), line("spec", T(3))],
    [message("m1", "spec", T(1), replied(T(2))), message("m2", "idea", T(4), replied(T(5)))],
  );

  it("shows every entry for the whole map", () => {
    expect(filterStream(entries, "map", "spec")).toHaveLength(6);
  });

  it("shows messages and replies under their message's stage", () => {
    expect(filterStream(entries, "stage", "spec").map((entry) => [entry.kind, entry.at])).toEqual([
      ["message", T(1)],
      ["reply", T(2)],
      ["event", T(3)],
    ]);
    expect(filterStream(entries, "stage", "idea").map((entry) => entry.kind)).toEqual([
      "event",
      "message",
      "reply",
    ]);
  });
});

describe("replyingMessages", () => {
  const queued = message("m1", "spec", T(1), { state: "queued" });
  const working = message("m2", "idea", T(2), { state: "working" });
  const done = message("m3", "spec", T(3), replied(T(4)));
  const stopped = message("m4", "spec", T(5), {
    state: "stopped",
    stopped: { runId: RUN, code: "agent_run_failed" },
  });

  it("lists the working messages, filtered by stage; a queued one is not replied to yet", () => {
    expect(replyingMessages([queued, working, done, stopped], "map", "spec")).toEqual([working]);
    expect(replyingMessages([queued, working, done, stopped], "stage", "spec")).toEqual([]);
    expect(replyingMessages([queued, working, done, stopped], "stage", "idea")).toEqual([working]);
  });
});

describe("the composer", () => {
  it("sends on Enter and keeps Shift+Enter for a new line", () => {
    expect(composerKeyAction({ key: "Enter", shiftKey: false })).toBe("send");
    expect(composerKeyAction({ key: "Enter", shiftKey: true })).toBe("newline");
    expect(composerKeyAction({ key: "a", shiftKey: false })).toBe("none");
  });

  it("cannot send blank text", () => {
    expect(canSend("")).toBe(false);
    expect(canSend("  \n ")).toBe(false);
    expect(canSend(" Why? ")).toBe(true);
  });

  it("prefills Ask and Propose a change with the clause", () => {
    expect(clausePrefill("ask", "C3")).toBe("About C3: ");
    expect(clausePrefill("propose", "C3")).toBe("C3 should ");
  });
});

describe("aboutSpec", () => {
  function spec(number: number, tone: StageTone): MapSpec {
    return {
      id: `0000000000000000000000000${String(number)}`,
      number,
      title: `Spec ${String(number)}`,
      revisions: [],
      ticketSets: [],
      draftingTickets: null,
      runs: [],
      revisedLater: [],
      stages: [
        { stage: "spec", tone, line: "line" },
        { stage: "tickets", tone: "later", line: "line" },
        { stage: "delivery", tone: "later", line: "line" },
      ],
    };
  }
  const specs = [spec(1, "done"), spec(2, "needs-you")];
  // The defaults are core's (D9); the tones above do not decide them here.
  const detail = { specs, defaultSpecs: { spec: 1, tickets: 2, delivery: 2 }, waits: [] };

  it("names the spec the page renders: the route's, else the overview's default", () => {
    expect(aboutSpec(detail, "spec", 2)).toBe(2);
    expect(aboutSpec(detail, "spec", undefined)).toBe(1);
    expect(aboutSpec(detail, "tickets", undefined)).toBe(2);
  });

  it("names none on Idea and Wayfinding, or before any spec", () => {
    expect(aboutSpec(detail, "idea", undefined)).toBeNull();
    expect(aboutSpec(detail, "wayfinding", undefined)).toBeNull();
    const none = {
      specs: [],
      defaultSpecs: { spec: null, tickets: null, delivery: null },
      waits: [],
    };
    expect(aboutSpec(none, "spec", undefined)).toBeNull();
  });

  it("names a spec the map only waits on, on its Spec and Tickets pages (slice 8b E-1)", () => {
    const wait: SpecWaitView = {
      specNumber: 4,
      specTitle: "Slugify",
      latest: {
        revision: 2,
        state: "draft",
        mapId: "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e81",
        mapTitle: "Holder",
        savedAt: "2026-10-08T10:00:00.000Z",
        content: { title: "Slugify", problem: "P.", solution: "S.", clauses: [], outOfScope: [] },
      },
      note: "Trim the ends.",
      since: "2026-10-08T10:00:00.000Z",
      hold: null,
      released: false,
      run: null,
      waypoints: [],
    };
    const waiting = {
      specs: [],
      defaultSpecs: { spec: null, tickets: null, delivery: null },
      waits: [wait],
    };
    expect(aboutSpec(waiting, "spec", 4)).toBe(4);
    // A typed Tickets route of the waited spec names it too (S8b-16, N-4).
    expect(aboutSpec(waiting, "tickets", 4)).toBe(4);
    expect(aboutSpec(waiting, "spec", undefined)).toBeNull();
    expect(() => aboutSpec(waiting, "spec", 5)).toThrow();
  });
});
