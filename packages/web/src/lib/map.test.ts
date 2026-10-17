import type { NextAction } from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import { overviewActions } from "./map.ts";

function you(spec: number): NextAction {
  return {
    who: "you",
    label: "Approve the spec",
    stage: "spec",
    headline: "Approve the spec.",
    detail: null,
    round: null,
    stopped: null,
    waiting: null,
    spec,
    onMap: null,
  };
}

describe("overviewActions", () => {
  it("shows up to two actions as cards and lists the rest under Also in motion", () => {
    const three = [you(1), you(2), you(3)];
    expect(overviewActions(three)).toEqual({ cards: [you(1), you(2)], rest: [you(3)] });
    expect(overviewActions([you(1), you(2)])).toEqual({ cards: [you(1), you(2)], rest: [] });
    expect(overviewActions([you(1)])).toEqual({ cards: [you(1)], rest: [] });
  });

  it("throws on a status without a next action", () => {
    expect(() => overviewActions([])).toThrow();
  });
});
