import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ImplementEvent } from "@zenorm/contracts";
import { describe, expect, test } from "vitest";

import { createImplementStreamParser, type ImplementStreamContext } from "./delivery-stream.ts";

/**
 * A stream shaped like a real `orchestrator.jsonl` and the CLI 2.1.295 probe: `Agent` and `Task`
 * subagents, background (`async_launched`, then a `task_notification`) and foreground, a repeat for
 * T2 whose hand-back is CLI 2.1.296's (a framed `tool_result` with an `agentId … <usage>` trailer
 * beside the clean structured `tool_use_result`), an untied review subagent naming the unpinned T9,
 * an erroring then a succeeding merge, a 1240-character report, a ticket merged with no report, a
 * 600-character text and a line that is not JSON.
 */
const FIXTURE = readFileSync(join(import.meta.dirname, "delivery-stream.fixture.jsonl"), "utf8");

const CONTEXT: ImplementStreamContext = {
  runDir: "/zenorm/runs/run-1",
  worktreePath: "/zenorm/runs/run-1/worktree",
  branch: "zenorm/add-numbers-5f3a9c21-run-1",
  tickets: [{ id: "T1" }, { id: "T2" }, { id: "T3" }],
};

function parse(chunks: readonly string[], context: ImplementStreamContext): ImplementEvent[] {
  const events: ImplementEvent[] = [];
  const parser = createImplementStreamParser(context, (event) => {
    events.push(event);
  });
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return events;
}

function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    chunks.push(text.slice(start, start + size));
  }
  return chunks;
}

function implementer(ticket: string, text: string): ImplementEvent {
  return { kind: "line", who: "implementer", ticket, text };
}

function orchestrator(text: string): ImplementEvent {
  return { kind: "line", who: "orchestrator", ticket: null, text };
}

describe("the orchestrator stream parser", () => {
  test("emits the fixture's lines, starts and merges in stream order", () => {
    const events = parse([FIXTURE], CONTEXT);

    const longText = events[5];
    if (longText?.kind !== "line") throw new Error("the sixth event is not a line");
    expect(longText.text).toHaveLength(500);
    expect(longText.text.endsWith("…")).toBe(true);
    expect(longText.text.startsWith("Merging T1. xxx")).toBe(true);

    const t1Merged = events[6];
    if (t1Merged?.kind !== "ticket_merged") throw new Error("the seventh event is not a merge");
    expect(t1Merged.summary).toHaveLength(1000);
    expect(t1Merged.summary?.endsWith("…")).toBe(true);
    expect(t1Merged.summary?.startsWith("T1 report: Added add(a, b)")).toBe(true);

    expect(events).toEqual([
      orchestrator("I'll read the spec and the tickets first."),
      { kind: "ticket_started", ticket: "T1" },
      implementer("T1", "Read `src/add.ts`"),
      implementer("T1", "Edited `src/add.ts`"),
      implementer("T1", "Implemented `add(a, b)` in `src/add.ts`."),
      orchestrator(longText.text),
      { kind: "ticket_merged", ticket: "T1", summary: t1Merged.summary },
      { kind: "ticket_started", ticket: "T2" },
      implementer("T2", "Wrote `test/sum.test.ts`"),
      implementer("T2", "Listed `src/**/*.ts`"),
      implementer("T2", "Searched for `export function add`"),
      implementer("T2", "Edited `test/sum.test.ts`"),
      {
        kind: "ticket_merged",
        ticket: "T2",
        summary:
          "T2 second report: added a negative case to `test/sum.test.ts`.\n\n- **Kept:** the positive case in `test/sum.test.ts`.",
      },
      { kind: "ticket_started", ticket: "T3" },
      implementer("T3", "Read `README.md`"),
      { kind: "ticket_merged", ticket: "T3", summary: null },
      orchestrator("No blocking findings."),
      orchestrator("Every ticket is merged and the checks pass."),
    ]);
  });

  test("chunks split anywhere give the same events as the whole stream", () => {
    const whole = parse([FIXTURE], CONTEXT);
    for (const size of [1, 7, 333, 4096]) {
      expect(parse(chunked(FIXTURE, size), CONTEXT)).toEqual(whole);
    }
  });

  test("a last line without a newline is parsed at the end", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "Done." }] },
    });
    expect(parse([line], CONTEXT)).toEqual([orchestrator("Done.")]);
  });

  test("a subagent naming an unpinned ticket is untied: no start, and its text is the orchestrator's", () => {
    const events = parse([FIXTURE], { ...CONTEXT, tickets: [{ id: "T1" }] });
    expect(events.filter((event) => event.kind === "ticket_started")).toEqual([
      { kind: "ticket_started", ticket: "T1" },
    ]);
    expect(events.filter((event) => event.kind === "ticket_merged").map((e) => e.ticket)).toEqual([
      "T1",
    ]);
    const t2Lines = events.filter((event) => event.kind === "line" && event.ticket === "T2");
    expect(t2Lines).toEqual([]);
    expect(events.filter((event) => event.kind === "line" && event.who === "implementer")).toEqual([
      implementer("T1", "Read `src/add.ts`"),
      implementer("T1", "Edited `src/add.ts`"),
      implementer("T1", "Implemented `add(a, b)` in `src/add.ts`."),
    ]);
  });

  test("a tied subagent's read of the pinned inputs names them relative to the run folder", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "a1",
              name: "Agent",
              input: { description: "T1: Add numbers" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: "a1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "r1",
              name: "Read",
              input: { file_path: "/zenorm/runs/run-1/inputs/spec.md" },
            },
            { type: "tool_use", id: "r2", name: "Read", input: { file_path: "/elsewhere/a.md" } },
          ],
        },
      }),
      "",
    ].join("\n");
    expect(parse([stream], CONTEXT)).toEqual([
      { kind: "ticket_started", ticket: "T1" },
      implementer("T1", "Read `inputs/spec.md`"),
      implementer("T1", "Read `/elsewhere/a.md`"),
    ]);
  });

  test("a report is the structured hand-back, else the tool_result text, else null; paths are relative", () => {
    const launch = (id: string, ticket: string): string =>
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_use", id, name: "Agent", input: { description: `${ticket}: x` } },
          ],
        },
      });
    const handBack = (id: string, text: string, toolUseResult: unknown): string =>
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
        ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
      });
    const merge = (id: string, ticket: string): string[] => [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id,
              name: "Bash",
              input: { command: `git merge --no-ff ${CONTEXT.branch}-t${ticket.slice(1)}` },
            },
          ],
        },
      }),
      handBack(id, "Merged.", undefined),
    ];
    const stream = [
      launch("a1", "T1"),
      JSON.stringify({
        type: "system",
        subtype: "task_notification",
        tool_use_id: "a1",
        status: "completed",
        summary:
          "Changed `/zenorm/runs/run-1/tickets/t1/src/add.ts`, in /zenorm/runs/run-1/tickets/t1/.",
      }),
      ...merge("m1", "T1"),
      launch("a2", "T2"),
      handBack("a2", "[Subagent hand-back] framed\nagentId: a1\n<usage>x</usage>", {
        status: "completed",
        content: [{ type: "text", text: "  " }],
      }),
      ...merge("m2", "T2"),
      launch("a3", "T3"),
      handBack("a3", "Async agent launched successfully.", { status: "async_launched" }),
      ...merge("m3", "T3"),
      "",
    ].join("\n");
    const summaries = parse([stream], CONTEXT).flatMap((event) =>
      event.kind === "ticket_merged" ? [[event.ticket, event.summary]] : [],
    );
    expect(summaries).toEqual([
      ["T1", "Changed `src/add.ts`, in tickets/t1/."],
      ["T2", null],
      ["T3", null],
    ]);
  });

  test("a merge naming another branch's -t suffix, or by a subagent, emits nothing", () => {
    const toolUse = (id: string, command: string, parent: string | null): string =>
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: parent,
        message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
      });
    const toolResult = (id: string, parent: string | null): string =>
      JSON.stringify({
        type: "user",
        parent_tool_use_id: parent,
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "Merged." }] },
      });
    const stream = [
      toolUse("m1", "git merge --no-ff zenorm/other-run-1-t1", null),
      toolResult("m1", null),
      toolUse("m2", `git merge --no-ff ${CONTEXT.branch}-t12`, null),
      toolResult("m2", null),
      toolUse("m3", `git merge --no-ff ${CONTEXT.branch}-t1`, "toolu_some_subagent"),
      toolResult("m3", "toolu_some_subagent"),
      toolUse("m4", `git log ${CONTEXT.branch}-t1`, null),
      toolResult("m4", null),
      "",
    ].join("\n");
    expect(parse([stream], CONTEXT)).toEqual([]);
  });
});
