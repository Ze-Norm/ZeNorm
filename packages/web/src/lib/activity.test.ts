import type { ActivityLine, SpecLineLabel, Stage } from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import { specLineLink, withoutSpecTitle } from "./activity.ts";

function line(stage: Stage, spec: number | null, specLabel: SpecLineLabel | null): ActivityLine {
  return { stage, text: "Text.", waypoint: null, spec, specLabel, at: "2026-10-09T10:00:00.000Z" };
}

describe("specLineLink", () => {
  it("opens a Tickets line's tickets on that spec's Tickets page", () => {
    expect(specLineLink(line("tickets", 2, "Open the tickets"))).toEqual({
      stage: "tickets",
      specNumber: 2,
      label: "Open the tickets",
    });
  });

  it("keeps a Spec line's link to the revision", () => {
    expect(specLineLink(line("spec", 1, "Open the revision"))).toEqual({
      stage: "spec",
      specNumber: 1,
      label: "Open the revision",
    });
  });

  it("opens a Delivery line's run on that spec's Delivery page", () => {
    expect(specLineLink(line("delivery", 3, "Open the run"))).toEqual({
      stage: "delivery",
      specNumber: 3,
      label: "Open the run",
    });
  });

  it("reads the label from the line, not from its stage", () => {
    expect(specLineLink(line("spec", 2, "See what the revision changes"))).toEqual({
      stage: "spec",
      specNumber: 2,
      label: "See what the revision changes",
    });
    expect(specLineLink(line("tickets", 2, "See what waits"))).toEqual({
      stage: "tickets",
      specNumber: 2,
      label: "See what waits",
    });
  });

  it("refuses a line with a spec and no label", () => {
    expect(() => specLineLink(line("spec", 1, null))).toThrow();
  });

  it("links nothing for a line with no spec", () => {
    expect(specLineLink(line("tickets", null, null))).toBeNull();
  });

  it("refuses a spec on any other stage", () => {
    expect(() => specLineLink(line("wayfinding", 1, "Open the revision"))).toThrow();
    expect(() => specLineLink(line("idea", 1, "Open the revision"))).toThrow();
  });
});

describe("withoutSpecTitle", () => {
  const T = "Export records";

  it("drops the spec after for, in or of", () => {
    expect(withoutSpecTitle("Tickets written for “Export records”: 3 tickets.", T)).toBe(
      "Tickets written: 3 tickets.",
    );
    expect(withoutSpecTitle("Tickets rewritten from your note for “Export records”: 3.", T)).toBe(
      "Tickets rewritten from your note: 3.",
    );
    expect(
      withoutSpecTitle(
        "Planning review found 1 problem in “Export records”. A revision fixes it.",
        T,
      ),
    ).toBe("Planning review found 1 problem. A revision fixes it.");
    expect(withoutSpecTitle("Run 2 of “Export records” started again from clean.", T)).toBe(
      "Run 2 started again from clean.",
    );
    expect(withoutSpecTitle("The delivery run of “Export records” failed.", T)).toBe(
      "The delivery run failed.",
    );
    expect(withoutSpecTitle("Approved: the ticket set for “Export records”.", T)).toBe(
      "Approved: the ticket set.",
    );
    expect(
      withoutSpecTitle("Approved: the reconciliation of “Export records”. Nothing to deliver.", T),
    ).toBe("Approved: the reconciliation. Nothing to deliver.");
    expect(
      withoutSpecTitle(
        "Planning review of “Export records” sent a decision to Wayfinding: “Which columns”.",
        T,
      ),
    ).toBe("Planning review sent a decision to Wayfinding: “Which columns”.");
  });

  it("drops the spec named after a colon, with the colon", () => {
    expect(withoutSpecTitle("Spec written: “Export records”.", T)).toBe("Spec written.");
    expect(withoutSpecTitle("Approved: “Export records”.", T)).toBe("Approved.");
    expect(withoutSpecTitle("Tickets review passed: “Export records”.", T)).toBe(
      "Tickets review passed.",
    );
    expect(withoutSpecTitle("Delivery started: “Export records”.", T)).toBe("Delivery started.");
    expect(
      withoutSpecTitle("Spec revised: “Export records”, which an earlier map delivered.", T),
    ).toBe("Spec revised; an earlier map delivered it.");
  });

  it("reads the spec as the spec anywhere else, capitalised at a sentence's start", () => {
    expect(withoutSpecTitle("“Export records” is no longer held. The change is written.", T)).toBe(
      "The spec is no longer held. The change is written.",
    );
    expect(
      withoutSpecTitle("Merged into main: “Export records” is recorded as delivered.", T),
    ).toBe("Merged into main: the spec is recorded as delivered.");
    expect(withoutSpecTitle("You rejected “Export records”: too broad.", T)).toBe(
      "You rejected the spec: too broad.",
    );
    expect(withoutSpecTitle("Tickets review: “Export records” needs you.", T)).toBe(
      "Tickets review: the spec needs you.",
    );
    expect(
      withoutSpecTitle(
        "Waiting on “Export records”: “Another map” holds its unapproved revision.",
        T,
      ),
    ).toBe("Waiting on the spec: “Another map” holds its unapproved revision.");
  });

  it("leaves a text that does not quote the title word for word", () => {
    expect(withoutSpecTitle("Map started from your idea.", T)).toBe("Map started from your idea.");
    expect(withoutSpecTitle("Spec revised: “An older title”.", T)).toBe(
      "Spec revised: “An older title”.",
    );
  });
});
