import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChangeEvent } from "@zenorm/contracts";
import type { CheckAccess } from "@zenorm/contracts";
import { coreSeams, createChangeBus } from "@zenorm/core";
import type { ChangeBus } from "@zenorm/core";
import { changeFeedEnds, MIGRATIONS_FOLDER, migrateDatabase, openDatabase } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import type { Log } from "./app.ts";

import { createEventStreams, HEARTBEAT_MS, REPLAY_PAGE_SIZE } from "./events.ts";
import type { EventStreams } from "./events.ts";

const PROJECT = "01920000-0000-7000-8000-00000000000a";
const OTHER_PROJECT = "01920000-0000-7000-8000-00000000000b";
const MAP = "01920000-0000-7000-8000-0000000000a1";

let root: string;
let db: ZeNormDatabase;
let bus: ChangeBus;
let log: Mock<Log>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zenorm-events-"));
  const opened = openDatabase(join(root, "zenorm.sqlite"));
  if (!opened.ok) throw new Error(opened.error.message);
  db = opened.value;
  const migrated = migrateDatabase(db, MIGRATIONS_FOLDER);
  if (!migrated.ok) throw new Error(migrated.error.message);
  log = vi.fn<Log>();
  bus = createChangeBus(log);
});

afterEach(async () => {
  vi.useRealTimers();
  db.$client.close();
  await rm(root, { recursive: true, force: true });
});

/** Appends one feed row (as a write's trigger would) and returns it as the wire event. */
function storeChange(projectId: string): ChangeEvent {
  const row: unknown = db.$client
    .prepare(
      `INSERT INTO change_feed
         (project_id, map_id, entity_type, entity_id, op, actor_kind, actor_user_id, actor_run_id, at)
       VALUES (?, ?, 'maps', ?, 'update', 'system', NULL, NULL, '2026-10-11T10:00:00.000Z')
       RETURNING seq`,
    )
    .get(projectId, MAP, MAP);
  if (typeof row !== "object" || row === null || !("seq" in row) || typeof row.seq !== "number") {
    throw new Error(`No seq in ${JSON.stringify(row)}`);
  }
  return ChangeEvent.parse({
    seq: row.seq,
    projectId,
    mapId: MAP,
    entityType: "maps",
    entityId: MAP,
    op: "update",
    actor: { kind: "system" },
  });
}

/** One committed write: its feed row, then the after-commit bus, as core's `write` does. */
function commit(projectId: string = PROJECT): ChangeEvent {
  const event = storeChange(projectId);
  bus.publish([event]);
  return event;
}

function streams(checkAccess: CheckAccess = coreSeams(db).checkAccess): EventStreams {
  return createEventStreams({ db, bus, identify: coreSeams(db).identify, checkAccess, log });
}

function connect(events: EventStreams, lastEventId: string | null): Response {
  const headers = new Headers();
  if (lastEventId !== null) headers.set("last-event-id", lastEventId);
  return events.handle(new Request("http://zenorm.test/events", { headers }));
}

interface Frame {
  readonly comment: string | null;
  readonly id: number | null;
  readonly event: string | null;
  /** A `change` frame's event. */
  readonly data: ChangeEvent | null;
  /** Any other named event's `data`, as sent. */
  readonly payload: string | null;
}

function parseFrame(text: string): Frame {
  let comment: string | null = null;
  let id: number | null = null;
  let event: string | null = null;
  let raw: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(": ")) comment = line.slice(2);
    else if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) raw = line.slice(6);
    else throw new Error(`Unexpected line ${JSON.stringify(line)}`);
  }
  if (event === "change") {
    if (raw === null) throw new Error("A change frame without data");
    return { comment, id, event, data: ChangeEvent.parse(JSON.parse(raw)), payload: null };
  }
  return { comment, id, event, data: null, payload: raw };
}

/** Reads a response body frame by frame. */
function frames(response: Response) {
  if (response.body === null) throw new Error("The response has no body");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    /** The next frame, or null once the stream has ended. */
    async next(): Promise<Frame | null> {
      for (;;) {
        const end = pending.indexOf("\n\n");
        if (end !== -1) {
          const text = pending.slice(0, end);
          pending = pending.slice(end + 2);
          return parseFrame(text);
        }
        const { done, value } = await reader.read();
        if (done) return null;
        pending += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

type Frames = ReturnType<typeof frames>;

async function nextFrame(reader: Frames): Promise<Frame> {
  const frame = await reader.next();
  if (frame === null) throw new Error("The stream ended");
  return frame;
}

/** The ids of the next `count` change frames. */
async function changeIds(reader: Frames, count: number): Promise<number[]> {
  const ids: number[] = [];
  while (ids.length < count) {
    const frame = await nextFrame(reader);
    if (frame.comment !== null || frame.event === "heartbeat") continue;
    expect(frame.event).toBe("change");
    if (frame.id === null || frame.data === null) throw new Error("A change frame without id");
    expect(frame.data.seq).toBe(frame.id);
    ids.push(frame.id);
  }
  return ids;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

describe("GET /events (S9-15)", () => {
  test("is an uncached, unkept event stream that opens with a comment and sends each change once, in order", async () => {
    storeChange(PROJECT);
    const response = connect(streams(), null);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("close");
    const reader = frames(response);
    expect(await nextFrame(reader)).toMatchObject({ comment: "open", id: null });

    const sent = [commit(), commit(), commit()];

    // No Last-Event-ID: live only, so the stored row before the connect is not replayed.
    const received: ChangeEvent[] = [];
    for (let index = 0; index < 3; index++) {
      const frame = await nextFrame(reader);
      if (frame.data === null) throw new Error("Expected a change");
      received.push(frame.data);
    }
    expect(received).toEqual(sent);
    expect(sent.map((event) => event.seq)).toEqual([2, 3, 4]);
    await reader.cancel();
  });

  test("replays from Last-Event-ID in pages, with a write racing the replay: no gap, no duplicate", async () => {
    const stored = REPLAY_PAGE_SIZE * 2 + 100;
    for (let index = 0; index < stored; index++) storeChange(PROJECT);

    const reader = frames(connect(streams(), "5"));
    // The first page is read at once; the next waits a turn, so this write lands mid-replay: its
    // row is in the table for a later page, and its event reaches the stream's buffer.
    const firstPage = await changeIds(reader, REPLAY_PAGE_SIZE);
    expect(firstPage).toEqual(range(6, REPLAY_PAGE_SIZE + 5));
    const raced = commit();
    expect(raced.seq).toBe(stored + 1);

    const rest = await changeIds(reader, stored + 1 - 5 - REPLAY_PAGE_SIZE);
    expect(rest).toEqual(range(REPLAY_PAGE_SIZE + 6, stored + 1));
    // Live from here on, with nothing repeated.
    const live = commit();
    expect(await changeIds(reader, 1)).toEqual([live.seq]);
    await reader.cancel();
  });

  test("Last-Event-ID 0 replays the whole feed, and the last id replays nothing", async () => {
    storeChange(PROJECT);
    storeChange(PROJECT);
    const all = frames(connect(streams(), "0"));
    expect(await changeIds(all, 2)).toEqual([1, 2]);
    await all.cancel();

    const none = frames(connect(streams(), "2"));
    const live = commit();
    expect(await changeIds(none, 1)).toEqual([live.seq]);
    await none.cancel();
  });

  test("refuses a Last-Event-ID past the feed's end with last_event_id_ahead, never clamps it", async () => {
    const empty = connect(streams(), "1");
    expect(empty.status).toBe(409);
    expect(await empty.text()).toBe("last_event_id_ahead");

    storeChange(PROJECT);
    storeChange(PROJECT);
    const ahead = connect(streams(), "3");
    expect(ahead.status).toBe(409);
    expect(await ahead.text()).toBe("last_event_id_ahead");
    // At the end is not ahead: the stream opens and goes live.
    const atEnd = frames(connect(streams(), "2"));
    const live = commit();
    expect(await changeIds(atEnd, 1)).toEqual([live.seq]);
    await atEnd.cancel();
  });

  test.each(["", "-1", "1.5", "abc", "01", "99999999999999999999"])(
    "refuses Last-Event-ID %j with last_event_id_invalid",
    async (header) => {
      const response = connect(streams(), header);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("last_event_id_invalid");
    },
  );

  test("sends a named heartbeat event, which the browser dispatches, every 15 s (CR9b-8)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reader = frames(connect(streams(), null));
    expect(await nextFrame(reader)).toMatchObject({ comment: "open" });

    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    const event = commit();
    // Nothing but the change before the 15 s mark.
    expect(await nextFrame(reader)).toMatchObject({ id: event.seq });
    vi.advanceTimersByTime(1);
    // No id, so the client's Last-Event-ID stays the last change's; a data line, so it is dispatched.
    expect(await nextFrame(reader)).toEqual({
      comment: null,
      id: null,
      event: "heartbeat",
      data: null,
      payload: "",
    });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(await nextFrame(reader)).toMatchObject({ event: "heartbeat" });
    await reader.cancel();
  });

  test("sends no change of a project the access check refuses, live or replayed", async () => {
    const checks: string[] = [];
    const onlyProject: CheckAccess = (userId, projectId, access) => {
      checks.push(`${userId}:${access}`);
      return projectId === PROJECT;
    };
    storeChange(OTHER_PROJECT);
    storeChange(PROJECT);
    const reader = frames(connect(streams(onlyProject), "0"));
    expect(await changeIds(reader, 1)).toEqual([2]);

    commit(OTHER_PROJECT);
    const allowed = commit(PROJECT);
    expect(await changeIds(reader, 1)).toEqual([allowed.seq]);
    // Each check names the instance's one user and a read.
    expect(new Set(checks).size).toBe(1);
    expect(checks[0]).toMatch(/^[0-9a-f]{32}:read$/);
    await reader.cancel();
  });

  test("closeStreams ends every open stream and refuses new ones with streams_closed", async () => {
    const subscribe = vi.spyOn(bus, "subscribe");
    const events = streams();
    const first = frames(connect(events, null));
    const second = frames(connect(events, "0"));
    expect(await nextFrame(first)).toMatchObject({ comment: "open" });
    expect(await nextFrame(second)).toMatchObject({ comment: "open" });

    events.closeStreams();

    expect(await first.next()).toBeNull();
    expect(await second.next()).toBeNull();
    const refused = connect(events, null);
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("streams_closed");
    // The instance's prune, then one subscription per stream.
    expect(subscribe.mock.calls.map(([name]) => name)).toEqual([
      "events_prune",
      "events",
      "events",
    ]);
    // Both streams unsubscribed: a later write reaches no stream and logs nothing.
    commit();
    expect(log).not.toHaveBeenCalled();
  });

  test("a client that goes away (abort or cancel) unsubscribes its stream", async () => {
    const unsubscribed = vi.fn();
    const subscribe = bus.subscribe;
    vi.spyOn(bus, "subscribe").mockImplementation((name, subscriber) => {
      const unsubscribe = subscribe(name, subscriber);
      return () => {
        unsubscribed(name);
        unsubscribe();
      };
    });
    const events = streams();
    const controller = new AbortController();
    const aborted = events.handle(
      new Request("http://zenorm.test/events", { signal: controller.signal }),
    );
    const cancelled = frames(connect(events, null));
    expect(await nextFrame(cancelled)).toMatchObject({ comment: "open" });

    controller.abort();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(await frames(aborted).next()).toMatchObject({ comment: "open" });
    await cancelled.cancel();
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(unsubscribed.mock.calls).toEqual([["events"], ["events"]]);
    commit();
    expect(log).not.toHaveBeenCalled();
  });

  test("an access check that throws refuses that event, live or replayed, and is logged once per stream (CR9b-16)", async () => {
    const throwsOnOther: CheckAccess = (_userId, projectId) => {
      if (projectId === OTHER_PROJECT) throw new Error("the plugin's directory is unreachable");
      return true;
    };
    storeChange(OTHER_PROJECT);
    storeChange(PROJECT);
    storeChange(OTHER_PROJECT);
    const reader = frames(connect(streams(throwsOnOther), "0"));
    // The replay goes on past the throws.
    expect(await changeIds(reader, 1)).toEqual([2]);

    commit(OTHER_PROJECT);
    const allowed = commit(PROJECT);
    expect(await changeIds(reader, 1)).toEqual([allowed.seq]);
    expect(log).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  test("a replay that throws ends its stream with a coded stream_error frame (CR9b-16)", async () => {
    storeChange(PROJECT);
    // A row no ChangeEvent parses: the replay fails on it.
    db.$client
      .prepare(
        `INSERT INTO change_feed
           (project_id, map_id, entity_type, entity_id, op, actor_kind, actor_user_id, actor_run_id, at)
         VALUES (?, ?, 'not_an_entity', ?, 'update', 'system', NULL, NULL, '2026-10-11T10:00:00.000Z')`,
      )
      .run(PROJECT, MAP, MAP);
    const reader = frames(connect(streams(), "0"));
    expect(await nextFrame(reader)).toMatchObject({ comment: "open" });
    expect(await changeIds(reader, 1)).toEqual([1]);
    const ended = await nextFrame(reader);
    expect(ended).toMatchObject({ event: "stream_error", id: null });
    if (ended.payload === null) throw new Error("A stream_error frame without data");
    expect(JSON.parse(ended.payload)).toEqual({ code: "replay_failed" });
    expect(await reader.next()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    // The stream unsubscribed: a later write reaches no stream.
    commit();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("the change feed keeps only what an open stream needs (CR9b-17)", () => {
  function kept(): unknown[] {
    return db.$client.prepare("SELECT seq FROM change_feed ORDER BY seq").pluck().all();
  }

  test("with no stream replaying, a committed change leaves no row, and ids go on past the pruned ones", async () => {
    storeChange(PROJECT);
    storeChange(PROJECT);
    const events = streams();
    const first = commit();
    expect(first.seq).toBe(3);
    expect(kept()).toEqual([]);
    expect(changeFeedEnds(db)).toEqual({ newest: 3, prunedThrough: 3 });
    // The newest id still opens a stream, which replays nothing and goes live.
    const atEnd = frames(connect(events, "3"));
    const live = commit();
    expect(live.seq).toBe(4);
    expect(await changeIds(atEnd, 1)).toEqual([4]);
    expect(kept()).toEqual([]);
    await atEnd.cancel();
    expect(log).not.toHaveBeenCalled();
  });

  test("refuses a Last-Event-ID whose following rows were pruned with last_event_id_pruned", async () => {
    const events = streams();
    commit();
    commit();
    commit();
    expect(kept()).toEqual([]);
    for (const header of ["0", "2"]) {
      const refused = connect(events, header);
      expect(refused.status).toBe(409);
      expect(await refused.text()).toBe("last_event_id_pruned");
    }
    // Past the newest id is still ahead, not pruned.
    const ahead = connect(events, "4");
    expect(ahead.status).toBe(409);
    expect(await ahead.text()).toBe("last_event_id_ahead");
  });

  test("a stream still replaying keeps the rows after what it has handled; its end releases them", async () => {
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    const stored = REPLAY_PAGE_SIZE * 2;
    for (let index = 0; index < stored; index++) storeChange(PROJECT);
    const events = streams();
    const live = frames(connect(events, null));
    expect(await nextFrame(live)).toMatchObject({ comment: "open" });

    // The slow stream has read its first page and waits a turn before the next.
    const slow = frames(connect(events, "0"));
    expect(await changeIds(slow, REPLAY_PAGE_SIZE)).toEqual(range(1, REPLAY_PAGE_SIZE));
    const raced = commit();
    expect(await changeIds(live, 1)).toEqual([raced.seq]);
    expect(kept()).toEqual(range(REPLAY_PAGE_SIZE + 1, stored + 1));
    // An id at what the slow stream has handled still replays; one below it was pruned.
    const below = connect(events, String(REPLAY_PAGE_SIZE - 1));
    expect(await below.text()).toBe("last_event_id_pruned");

    // The replay ends: the slow stream has every row, then nothing is kept.
    await vi.runAllTimersAsync();
    expect(await changeIds(slow, stored + 1 - REPLAY_PAGE_SIZE)).toEqual(
      range(REPLAY_PAGE_SIZE + 1, stored + 1),
    );
    expect(kept()).toEqual([]);
    await slow.cancel();
    await live.cancel();
  });

  test("a replaying stream that goes away releases its rows", async () => {
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    const stored = REPLAY_PAGE_SIZE + 10;
    for (let index = 0; index < stored; index++) storeChange(PROJECT);
    const slow = frames(connect(streams(), "0"));
    expect(await changeIds(slow, REPLAY_PAGE_SIZE)).toEqual(range(1, REPLAY_PAGE_SIZE));
    expect(kept()).toEqual(range(1, stored));
    await slow.cancel();
    expect(kept()).toEqual([]);
  });
});
