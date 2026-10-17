import type { Project, SendHatchMessageInput } from "@zenorm/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sendHatchMessage } from "./hatch.ts";
import { readHatchMessages } from "./hatch-messages.ts";
import { getMapOverview } from "./map-overview.ts";
import {
  UNKNOWN_ID,
  addProject,
  closeTestContext,
  draftedSpec,
  insertHatchRun,
  insertMessage,
  insertSpec,
  newMap,
  openTestContext,
  runsOf,
} from "./test-support.ts";
import type { TestContext } from "./test-support.ts";

const RUNNERS = { deliveryHeld: () => false };

let context: TestContext;
let project: Project;

beforeEach(async () => {
  context = await openTestContext("zenorm-hatch-");
  project = await addProject(context, "repo");
});

afterEach(async () => {
  await closeTestContext(context);
});

async function overview(mapId: string) {
  const read = await getMapOverview(context.db, mapId, RUNNERS);
  if (!read.ok) throw new Error(read.error.code);
  return read.value;
}

async function send(input: SendHatchMessageInput) {
  return await sendHatchMessage(context.user, context.db, input, RUNNERS);
}

function message(mapId: string, fields: Partial<SendHatchMessageInput>): SendHatchMessageInput {
  return { mapId, stage: "idea", specNumber: null, text: "Make nesting any depth.", ...fields };
}

describe("hatch.send", () => {
  test("stores the message with its stage and trimmed text, queued, and starts no run", async () => {
    // The chart runs: a message is never refused for what is in flight.
    const mapId = await newMap(context, project, "Export data");
    const before = await overview(mapId);
    const runsBefore = runsOf(context, mapId);

    const sent = await send(message(mapId, { stage: "wayfinding", text: "  Any depth?\n" }));

    if (!sent.ok) throw new Error(sent.error.code);
    expect(
      sent.value.messages.map(({ stage, spec, text, status }) => ({ stage, spec, text, status })),
    ).toEqual([
      { stage: "wayfinding", spec: null, text: "Any depth?", status: { state: "queued" } },
    ]);
    expect(runsOf(context, mapId)).toEqual(runsBefore);
    // A message is not a next action and moves no stage, rail or Inbox status.
    expect(sent.value.status).toEqual(before.status);
    expect(await overview(mapId)).toEqual(sent.value);
  });

  test("a message sent while a spec's review runs is stored and its hatch run starts in the same write", async () => {
    const { mapId } = await draftedSpec(context, project);
    const runsBefore = runsOf(context, mapId);
    const before = await overview(mapId);

    const sent = await send(message(mapId, { stage: "spec", specNumber: 1 }));

    if (!sent.ok) throw new Error(sent.error.code);
    expect(sent.value.messages.map((entry) => entry.status)).toEqual([{ state: "working" }]);
    const added = runsOf(context, mapId).slice(runsBefore.length);
    expect(added.map((run) => [run.purpose, run.state, run.hatchMessageId])).toEqual([
      ["hatch", "running", sent.value.messages[0]?.id],
    ]);
    // A hatch run is not a next action and moves no stage status.
    expect(sent.value.status).toEqual(before.status);
  });

  test("blank text is refused hatch_message_empty and nothing is stored", async () => {
    const mapId = await newMap(context, project, "Export data");

    const sent = await send(message(mapId, { text: " \n\t " }));

    expect(sent.ok ? null : sent.error.code).toBe("hatch_message_empty");
    expect((await overview(mapId)).messages).toEqual([]);
  });

  test("an unknown map is refused map_not_found", async () => {
    const sent = await send(message(UNKNOWN_ID, {}));

    expect(sent.ok ? null : sent.error.code).toBe("map_not_found");
  });

  test("a spec the map wrote no revision of is refused spec_not_found", async () => {
    const { mapId } = await draftedSpec(context, project);
    // Spec 2 exists in the project, but this map wrote none of it.
    insertSpec(context, project.id, 2);

    for (const specNumber of [2, 3]) {
      for (const stage of ["spec", "tickets"] as const) {
        const sent = await send(message(mapId, { stage, specNumber }));
        expect(sent.ok ? null : sent.error.code, `${stage} ${String(specNumber)}`).toBe(
          "spec_not_found",
        );
      }
    }
    expect((await overview(mapId)).messages).toEqual([]);
  });

  test("Spec and Tickets store the number sent, null when sent null; Idea and Wayfinding none", async () => {
    const { mapId } = await draftedSpec(context, project);

    for (const fields of [
      { stage: "idea", specNumber: null },
      { stage: "wayfinding", specNumber: null },
      { stage: "spec", specNumber: null },
      { stage: "spec", specNumber: 1 },
      { stage: "tickets", specNumber: null },
      { stage: "tickets", specNumber: 1 },
    ] as const) {
      const sent = await send(message(mapId, fields));
      if (!sent.ok) throw new Error(sent.error.code);
    }

    expect((await overview(mapId)).messages.map(({ stage, spec }) => [stage, spec])).toEqual([
      ["idea", null],
      ["wayfinding", null],
      ["spec", null],
      ["spec", 1],
      ["tickets", null],
      ["tickets", 1],
    ]);
  });

  test("on a map with no spec yet, a Spec message names none", async () => {
    const mapId = await newMap(context, project, "Export data");

    const sent = await send(message(mapId, { stage: "spec" }));

    if (!sent.ok) throw new Error(sent.error.code);
    expect(sent.value.messages.map((entry) => entry.spec)).toEqual([null]);
  });
});

describe("the map's messages", () => {
  test("each reads queued, working, stopped with its run id, replied or refused, oldest first", async () => {
    const mapId = await newMap(context, project, "Export data");
    const text = "Does nested mean any depth?";
    const at = (state: Parameters<typeof insertMessage>[2]["state"]) =>
      insertMessage(context, mapId, { state, stage: "idea", specificationId: null, text });
    const queued = at("queued");
    const working = at("queued");
    insertHatchRun(context, mapId, working, "running");
    const stopped = at("queued");
    const retry = insertHatchRun(context, mapId, stopped, "stopped");
    const replied = at("replied");
    const refused = at({ refused: "spec_in_flight" });

    const messages = readHatchMessages(context.db, mapId, runsOf(context, mapId));

    expect(messages.map((entry) => entry.id)).toEqual([queued, working, stopped, replied, refused]);
    const reply = (refusal: string | null) => ({
      state: "replied",
      reply: "Yes: any depth.",
      refusal,
    });
    expect(
      messages.map(({ status }) =>
        status.state === "replied"
          ? { state: status.state, reply: status.reply, refusal: status.refusal }
          : status,
      ),
    ).toEqual([
      { state: "queued" },
      { state: "working" },
      { state: "stopped", stopped: { runId: retry.id, code: "agent_timed_out" } },
      reply(null),
      reply("spec_in_flight"),
    ]);
  });

  test("the overview lists stored messages with their spec number, leaving the status alone", async () => {
    const { mapId, specificationId } = await draftedSpec(context, project);
    const before = await overview(mapId);
    insertMessage(context, mapId, {
      state: "queued",
      stage: "tickets",
      specificationId,
      text: "Split the export ticket.",
    });
    insertMessage(context, mapId, {
      state: "replied",
      stage: "spec",
      specificationId,
      text: "Does nested mean any depth?",
    });

    const after = await overview(mapId);

    expect(
      after.messages.map(({ stage, spec, text, status }) => [stage, spec, text, status.state]),
    ).toEqual([
      ["tickets", 1, "Split the export ticket.", "queued"],
      ["spec", 1, "Does nested mean any depth?", "replied"],
    ]);
    expect(after.status).toEqual(before.status);
  });
});
