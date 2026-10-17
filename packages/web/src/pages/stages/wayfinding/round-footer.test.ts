import { describe, expect, it } from "vitest";

import { roundFooter } from "./round-footer.ts";

const CONFIRMS = "Sending these answers confirms the destination.";
const FOLLOW_UP =
  "The agent confirms the destination from your answers, or asks a short follow-up if they change the scope.";
const WAYPOINT = "0199b8a0-5c6e-7d2a-9f3b-1a2b3c4d5e6f";

describe("roundFooter", () => {
  it.each([
    { number: 1, final: false, footer: FOLLOW_UP },
    { number: 2, final: false, footer: FOLLOW_UP },
    { number: 2, final: true, footer: CONFIRMS },
    { number: 3, final: false, footer: CONFIRMS },
  ])("destination round $number, final $final", ({ number, final, footer }) => {
    expect(roundFooter({ waypointId: null, number, final })).toBe(footer);
  });

  it.each([
    {
      final: true,
      footer: "This is the waypoint's last round: its resolution is written from your answers.",
    },
    {
      final: false,
      footer:
        "Your answers may open further questions: the agent reads them before it asks or resolves.",
    },
  ])("a waypoint round, final $final, keeps its footer", ({ final, footer }) => {
    expect(roundFooter({ waypointId: WAYPOINT, number: 3, final })).toBe(footer);
  });
});
