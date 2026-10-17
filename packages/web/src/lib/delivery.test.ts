import type {
  RunEvent,
  RunTicketStatus,
  SpecRun,
  TicketContent,
  Verdict,
  VerdictFinding,
} from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import {
  carriersOf,
  failingCriteria,
  foldsMerged,
  FOLD_MERGED_FROM,
  inStatusOrder,
  midSentence,
  reportFirstLine,
  shownTicketStatus,
  agoWords,
  runName,
  runTicketOf,
  shownRun,
  ticketLines,
} from "./delivery.ts";

function ticket(id: string, criteria: string[]): TicketContent {
  return {
    id,
    title: `Ticket ${id}`,
    build: "Build it.",
    blockedBy: [],
    criteria,
    testing: ["Test it."],
    followUp: null,
    outOfScope: [],
    pointers: ["src/index.ts"],
  };
}

function finding(severity: VerdictFinding["severity"], criterion: string | null): VerdictFinding {
  return { axis: "spec", severity, file: null, title: "A finding", detail: "Why.", criterion };
}

function verdict(findings: VerdictFinding[]): Verdict {
  return { reviewedCommit: "a".repeat(40), summary: "Reviewed.", findings };
}

describe("runName", () => {
  it("names the first run of a spec the delivery run, by sentence position", () => {
    expect(runName({ number: 1 }, false)).toBe("Delivery run");
    expect(runName({ number: 1 }, true)).toBe("The delivery run");
  });

  it("numbers a later run, wherever it stands", () => {
    expect(runName({ number: 2 }, false)).toBe("Run 2");
    expect(runName({ number: 3 }, true)).toBe("Run 3");
  });
});

describe("failingCriteria", () => {
  const t1 = ticket("T1", ["1.1", "1.2"]);

  it("is empty for a run with no verdict", () => {
    expect(failingCriteria(null, t1)).toEqual([]);
  });

  it("lists the criteria the ticket carries that blocking findings name", () => {
    expect(failingCriteria(verdict([finding("blocking", "1.2")]), t1)).toEqual(["1.2"]);
  });

  it("skips a note, a finding not tied to a criterion and a criterion of another ticket", () => {
    const findings = [
      finding("note", "1.1"),
      finding("blocking", null),
      finding("blocking", "2.1"),
    ];
    expect(failingCriteria(verdict(findings), t1)).toEqual([]);
  });

  it("names the tickets carrying a failed criterion", () => {
    const tickets = [t1, ticket("T2", ["2.1"]), ticket("T3", ["1.2", "2.1"])];
    const blocked = verdict([finding("blocking", "1.2")]);
    expect(carriersOf(blocked, tickets, "1.2").map((entry) => entry.id)).toEqual(["T1", "T3"]);
  });
});

describe("the fold rule", () => {
  const wide = { running: true, tickets: FOLD_MERGED_FROM, merged: 1, shown: false };

  it("folds merged tickets of a running run with a wide set", () => {
    expect(foldsMerged(wide)).toBe(true);
  });

  it("never folds a run that has ended", () => {
    expect(foldsMerged({ ...wide, running: false })).toBe(false);
  });

  it("never folds a set below the threshold", () => {
    expect(foldsMerged({ ...wide, tickets: FOLD_MERGED_FROM - 1 })).toBe(false);
  });

  it("has nothing to fold before a ticket is merged", () => {
    expect(foldsMerged({ ...wide, merged: 0 })).toBe(false);
  });

  it("unfolds once the person shows them", () => {
    expect(foldsMerged({ ...wide, shown: true })).toBe(false);
  });

  it("orders rows live work first and merged last, keeping pinned order within a status", () => {
    const rows: { id: string; status: RunTicketStatus }[] = [
      { id: "T1", status: { state: "merged", commit: "b".repeat(40), summary: null } },
      { id: "T2", status: { state: "waiting", on: [{ ticket: "T3", supplies: "the API" }] } },
      { id: "T3", status: { state: "implementing", latest: null } },
      { id: "T4", status: { state: "starting" } },
      { id: "T5", status: { state: "merged", commit: "c".repeat(40), summary: null } },
    ];
    expect(inStatusOrder(rows).map((row) => row.id)).toEqual(["T3", "T4", "T2", "T1", "T5"]);
  });
});

function specRun(number: number, tickets: SpecRun["tickets"]): SpecRun {
  return {
    id: `0190a000-0000-7000-8000-00000000000${String(number)}`,
    specificationId: "0190a000-0000-7000-8000-000000000100",
    ticketSetId: "0190a000-0000-7000-8000-000000000200",
    number,
    branch: "zenorm/search",
    baseBranch: "main",
    baseCommit: "b".repeat(40),
    checks: ["pnpm test"],
    repairLimit: 0,
    repairAttempts: 0,
    state: "running",
    phase: "implementing",
    startedAt: "2026-10-09T10:00:00.000Z",
    endedAt: null,
    finalCommit: null,
    checkResults: null,
    verdict: null,
    failure: null,
    mergedAt: null,
    executor: "local",
    pullRequest: null,
    tickets,
  };
}

const started = { ticket: "T1", status: { state: "starting" as const }, failing: [] };

describe("shownRun (?run= selects the run, the latest when absent)", () => {
  const runs = [specRun(2, [started]), specRun(1, [started])];

  it("shows the latest run when ?run= is absent", () => {
    expect(shownRun(runs, undefined).number).toBe(2);
  });

  it("shows the run ?run= names", () => {
    expect(shownRun(runs, 1).number).toBe(1);
  });

  it("is the route's error for a run the spec does not have, or a spec with no run", () => {
    expect(() => shownRun(runs, 3)).toThrow();
    expect(() => shownRun([], undefined)).toThrow();
  });
});

describe("runTicketOf (the ticket's state comes from map.overview)", () => {
  it("returns the ticket's row from the run", () => {
    expect(runTicketOf(specRun(1, [started]), "T1")).toBe(started);
  });

  it("is the route's error for a ticket outside the run's pinned set", () => {
    expect(() => runTicketOf(specRun(1, [started]), "T2")).toThrow();
  });

  it("is the route's error for a run from before 0010", () => {
    expect(() => runTicketOf(specRun(1, null), "T1")).toThrow();
  });
});

function line(seq: number, who: RunEvent["who"], ticket: string | null): RunEvent {
  return { seq, at: "2026-10-09T10:00:00.000Z", who, ticket, text: `Line ${String(seq)}` };
}

describe("ticketLines (only that ticket's lines, from delivery.activity)", () => {
  it("keeps the lines tied to the ticket, oldest first", () => {
    const events = [
      line(1, "zenorm", null),
      line(2, "implementer", "T1"),
      line(3, "implementer", "T2"),
      line(4, "implementer", "T1"),
      line(5, "orchestrator", null),
    ];
    expect(ticketLines(events, "T1").map((event) => event.seq)).toEqual([2, 4]);
  });
});

describe("agoWords (the liveness count)", () => {
  it("counts seconds, then minutes and seconds", () => {
    expect(agoWords(0)).toBe("0s ago");
    expect(agoWords(12_400)).toBe("12s ago");
    expect(agoWords(125_000)).toBe("2m 5s ago");
  });
});

describe("shownTicketStatus (an interrupted run never reads as live)", () => {
  const implementing: RunTicketStatus = { state: "implementing", latest: null };
  const merged: RunTicketStatus = { state: "merged", commit: "a".repeat(40), summary: null };

  it("keeps every status of a run that is not interrupted", () => {
    expect(shownTicketStatus({ state: "running" }, implementing)).toEqual(implementing);
  });

  it("reads started and unstarted tickets of an interrupted run as interrupted", () => {
    expect(shownTicketStatus({ state: "interrupted" }, implementing)).toEqual({
      state: "interrupted",
      started: true,
    });
    expect(shownTicketStatus({ state: "interrupted" }, { state: "starting" })).toEqual({
      state: "interrupted",
      started: false,
    });
    expect(
      shownTicketStatus(
        { state: "interrupted" },
        { state: "waiting", on: [{ ticket: "T1", supplies: "the API" }] },
      ),
    ).toEqual({ state: "interrupted", started: false });
    expect(shownTicketStatus({ state: "interrupted" }, merged)).toEqual(merged);
  });
});

describe("midSentence", () => {
  it("lower-cases a capital that starts a word, and keeps an acronym, code or a lower start", () => {
    expect(midSentence("The working `--lines` flag")).toBe("the working `--lines` flag");
    expect(midSentence("API keys")).toBe("API keys");
    expect(midSentence("`--lines` flag")).toBe("`--lines` flag");
    expect(midSentence("the API")).toBe("the API");
    expect(midSentence("X")).toBe("X");
  });
});

describe("reportFirstLine (a passed run's ticket row shows one line)", () => {
  it("is the report's first line with text, without a heading's marks", () => {
    expect(reportFirstLine("Added slugify with tests.\n\nThe second paragraph.")).toBe(
      "Added slugify with tests.",
    );
    expect(reportFirstLine("\n  \n## T1 report: added add(a, b)\n- a test")).toBe(
      "T1 report: added add(a, b)",
    );
    expect(reportFirstLine("One line only")).toBe("One line only");
  });

  it("is null for a report of only blank lines", () => {
    expect(reportFirstLine(" \n\n ")).toBeNull();
  });
});
