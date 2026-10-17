import type { RunActor } from "@zenorm/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusLine } from "./ticket-status.tsx";

function implementingLine(who: RunActor, executor: string): string {
  return renderToStaticMarkup(
    createElement(StatusLine, {
      status: {
        state: "implementing",
        latest: {
          seq: 3,
          at: "2026-10-11T10:00:00.000Z",
          who,
          ticket: "T1",
          text: "Working on T1.",
        },
      },
      executor,
    }),
  );
}

describe("a ticket row's latest line names the run's executor", () => {
  it("reads Orchestrator for a local run", () => {
    expect(implementingLine("orchestrator", "local")).toContain("Orchestrator: ");
  });

  it("reads the executor's name for a plugin executor's run", () => {
    const out = implementingLine("orchestrator", "stand-in");
    expect(out).toContain("Executor &quot;stand-in&quot;: ");
    expect(out).not.toContain("Orchestrator");
  });

  it("keeps the implementer's and the reviewer's labels under a plugin executor", () => {
    expect(implementingLine("implementer", "stand-in")).toContain("Implementer: ");
    expect(implementingLine("reviewer", "stand-in")).toContain("Independent reviewer: ");
  });
});
