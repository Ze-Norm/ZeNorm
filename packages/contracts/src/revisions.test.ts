import { describe, expect, test } from "vitest";

import {
  ActivityLine,
  CriterionReading,
  NextAction,
  NextActionLabel,
  NextActionWho,
  ProjectSpec,
  SpecFeedback,
  SpecHold,
  SpecHoldKind,
  parseSpecPagePath,
  specPagePath,
  SpecLineLabel,
  SpecWaitView,
  TextDelta,
} from "./index.ts";

describe("the revision reads (slice 8b D2)", () => {
  test("a hold is one of four kinds on a map's revision", () => {
    expect(SpecHoldKind.options).toEqual(["revision", "revising", "tickets", "delivering"]);
    const hold = {
      kind: "tickets",
      mapId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01",
      mapTitle: "Slug length",
      revision: 2,
    };
    expect(SpecHold.safeParse(hold).success).toBe(true);
    expect(SpecHold.safeParse({ ...hold, kind: "approved" }).success).toBe(false);
    expect(SpecHold.safeParse({ ...hold, revision: 0 }).success).toBe(false);
  });

  test("a reading carries its change, expectation, baseline and departure", () => {
    const reading = {
      change: "unchanged",
      expectation: { kind: "delivered", why: "Unchanged since revision 1, delivered by T1." },
      baseline: { ticket: "T1", revision: 1, run: 1, commit: "a".repeat(40) },
      departure: { question: "Why does unchanged 2.1 need work?", reason: "The slug path moved." },
    };
    expect(CriterionReading.safeParse(reading).success).toBe(true);
    expect(
      CriterionReading.safeParse({ ...reading, baseline: null, departure: null }).success,
    ).toBe(true);
    expect(
      CriterionReading.safeParse({ ...reading, departure: { question: "Why?", reason: null } })
        .success,
    ).toBe(true);
    expect(CriterionReading.safeParse({ ...reading, change: "removed" }).success).toBe(false);
  });

  test("a text delta compares a revision with the one before", () => {
    const delta = {
      before: 1,
      after: 2,
      clauses: { C1: "changed" },
      criteria: {
        "1.1": { change: "unchanged", before: { id: "1.1", text: "Lowercase." } },
        "1.2": { change: "new", before: null },
      },
      removedClauses: [],
      removedCriteria: [],
      outOfScopeAdded: ["Unicode."],
      outOfScopeDropped: [],
    };
    expect(TextDelta.safeParse(delta).success).toBe(true);
    expect(TextDelta.safeParse({ ...delta, after: 1 }).success).toBe(false);
    expect(TextDelta.safeParse({ ...delta, clauses: { C1: "moved" } }).success).toBe(false);
  });
});

describe("the view and request contract (slice 8b D2, D6)", () => {
  const MAP = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01";
  const AT = "2026-10-09T12:00:00.000Z";

  test("Q1: a line carries its spec link's words exactly when it carries a spec", () => {
    const line = { stage: "spec", text: "Spec written: “Slugs”.", waypoint: null, at: AT };
    expect(
      ActivityLine.safeParse({ ...line, spec: 1, specLabel: "Open the revision" }).success,
    ).toBe(true);
    expect(ActivityLine.safeParse({ ...line, spec: null, specLabel: null }).success).toBe(true);
    expect(ActivityLine.safeParse({ ...line, spec: 1, specLabel: null }).success).toBe(false);
    expect(ActivityLine.safeParse({ ...line, spec: null, specLabel: "Open the run" }).success).toBe(
      false,
    );
    expect(ActivityLine.safeParse({ ...line, spec: 1 }).success).toBe(false);
    expect(SpecLineLabel.options).toEqual([
      "Open the revision",
      "Open the tickets",
      "Open the run",
      "See what waits",
      "See what the revision changes",
    ]);
  });

  test("S8b-16: a wait's action names the map it waits on; every other action names none", () => {
    const action = {
      who: "another-map",
      label: null,
      stage: "spec",
      headline: "Waiting on “Slugs”.",
      detail: null,
      round: null,
      stopped: null,
      waiting: null,
      spec: 1,
    };
    expect(NextActionWho.options).toContain("another-map");
    expect(NextActionLabel.options).toContain("Confirm");
    expect(NextAction.safeParse({ ...action, onMap: MAP }).success).toBe(true);
    expect(NextAction.safeParse({ ...action, onMap: null }).success).toBe(false);
    expect(NextAction.safeParse({ ...action, who: "agent", onMap: MAP }).success).toBe(false);
    expect(NextAction.safeParse({ ...action, who: "agent", onMap: null }).success).toBe(true);
  });

  test("S8b-6 / B4: an open wait may have no hold; a released one has a run and no hold", () => {
    const wait = {
      specNumber: 1,
      specTitle: "Slugs",
      latest: {
        revision: 2,
        state: "draft",
        mapId: MAP,
        mapTitle: "Trim",
        savedAt: AT,
        content: {
          title: "Slugs",
          problem: "Slugs run long.",
          solution: "Cap them.",
          clauses: [
            {
              id: "C1",
              title: "Cap",
              text: "Slugs are capped.",
              criteria: [{ id: "1.1", text: "A long title gives 60 characters." }],
              sources: [],
            },
          ],
          outOfScope: [],
        },
      },
      note: "Cap slugs at 60 characters.",
      since: AT,
      waypoints: [1],
    };
    expect(
      SpecWaitView.safeParse({ ...wait, hold: null, released: false, run: null }).success,
    ).toBe(true);
    expect(
      SpecWaitView.safeParse({ ...wait, hold: null, released: true, run: "working" }).success,
    ).toBe(true);
    expect(SpecWaitView.safeParse({ ...wait, hold: null, released: true, run: null }).success).toBe(
      false,
    );
    const hold = { kind: "revision", mapId: MAP, mapTitle: "Trim", revision: 2 };
    expect(SpecWaitView.safeParse({ ...wait, hold, released: false, run: null }).success).toBe(
      true,
    );
    expect(SpecWaitView.safeParse({ ...wait, hold, released: true, run: "working" }).success).toBe(
      false,
    );
    // E-1: the waited spec's latest revision is required, never left out.
    const bare = Object.fromEntries(Object.entries(wait).filter(([key]) => key !== "latest"));
    expect(SpecWaitView.safeParse({ ...bare, hold, released: false, run: null }).success).toBe(
      false,
    );
  });

  test("SpecFeedback admits a wait's note", () => {
    const wait = { kind: "wait", note: "Cap at 60.", noteDirected: false };
    expect(SpecFeedback.safeParse(wait).success).toBe(true);
    expect(SpecFeedback.safeParse({ ...wait, noteDirected: true }).success).toBe(true);
    expect(SpecFeedback.safeParse({ ...wait, note: "" }).success).toBe(false);
    // Whether the wait came from a note is required (S8b-16, N-1).
    expect(SpecFeedback.safeParse({ kind: "wait", note: "Cap at 60." }).success).toBe(false);
  });

  test("S8b-18: a project spec lists every revision, its active run and its merged run", () => {
    const spec = {
      number: 1,
      title: "Slugs",
      revisions: [
        { revision: 1, state: "approved", mapId: MAP, mapTitle: "Slugs", savedAt: AT },
        { revision: 2, state: "draft", mapId: MAP, mapTitle: "Trim", savedAt: AT },
      ],
      activeRun: null,
      mergedRun: { number: 1, revision: 1 },
    };
    expect(ProjectSpec.safeParse(spec).success).toBe(true);
    expect(ProjectSpec.safeParse({ ...spec, revisions: [] }).success).toBe(false);
    expect(ProjectSpec.safeParse({ ...spec, revision: 2 }).success).toBe(false);
  });
});

describe("a spec page path", () => {
  const mapId = "01a13c3d-5793-7224-8cbe-ebd162ca7eb3";

  test("round-trips a map and spec number", () => {
    expect(specPagePath(mapId, 2)).toBe(`/maps/${mapId}/spec/2`);
    expect(parseSpecPagePath(specPagePath(mapId, 2))).toEqual({ mapId, specNumber: 2 });
  });

  test("is null for any other link", () => {
    for (const href of [
      "https://example.com",
      `/maps/${mapId}/tickets/2`,
      `/maps/${mapId}/spec/0`,
      `/maps/${mapId}/spec/2/x`,
      "/maps/not-an-id/spec/2",
      `https://evil.example/maps/${mapId}/spec/2`,
    ]) {
      expect(parseSpecPagePath(href)).toBeNull();
    }
  });
});
