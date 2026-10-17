import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COALESCE_MS, REOPEN_MS, STREAM_SILENCE_MS, startLiveUpdates } from "./live.ts";
import type { ChangeSource, ChangeSourceEvent, LiveTimers, LiveUpdates } from "./live.ts";

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 2;

/** A stand-in `EventSource`: the test fires its events and sets its `readyState`. */
class FakeSource implements ChangeSource {
  readyState = CONNECTING;
  closed = false;
  readonly #listeners = new Map<string, (() => void)[]>();

  addEventListener(type: ChangeSourceEvent, listener: () => void): void {
    const listeners = this.#listeners.get(type);
    if (listeners === undefined) this.#listeners.set(type, [listener]);
    else listeners.push(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }

  fire(type: ChangeSourceEvent): void {
    if (type === "open") this.readyState = OPEN;
    const listeners = this.#listeners.get(type);
    if (listeners !== undefined) for (const listener of listeners) listener();
  }
}

const timers: LiveTimers = {
  setTimeout: (callback, ms) => Number(setTimeout(callback, ms)),
  clearTimeout: (id) => {
    clearTimeout(id);
  },
};

let sources: FakeSource[];
let invalidateQueries: ReturnType<typeof vi.fn<() => Promise<void>>>;
let live: LiveUpdates;

function latest(): FakeSource {
  const source = sources.at(-1);
  if (source === undefined) throw new Error("No source was opened");
  return source;
}

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  invalidateQueries = vi.fn<() => Promise<void>>(() => Promise.resolve());
  live = startLiveUpdates(
    { invalidateQueries },
    () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    timers,
  );
});

afterEach(() => {
  live.close();
  vi.useRealTimers();
});

describe("the live layer's coalescer (S9-16, D13)", () => {
  it("opens one source, is not stopped, and its first open refetches everything (CR9b-7)", async () => {
    expect(sources).toHaveLength(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
    // A commit between the page's first reads and the subscription is not missed: the first
    // open invalidates every active query, as an open after an error does.
    latest().fire("open");
    expect(live.stopped()).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: "active" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("turns many changes in one 300 ms window into one invalidation of the active queries", async () => {
    const source = latest();
    source.fire("open");
    // The open's own refetch is the first test's; this one counts the windows.
    invalidateQueries.mockClear();
    for (let index = 0; index < 20; index++) {
      source.fire("change");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(invalidateQueries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COALESCE_MS - 200);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: "active" });

    // A change after the window starts the next one.
    source.fire("change");
    await vi.advanceTimersByTimeAsync(COALESCE_MS - 1);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    // Idle, nothing more.
    await vi.advanceTimersByTimeAsync(10 * COALESCE_MS);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("an error stops it; the next open clears that and refetches everything at once", async () => {
    const listener = vi.fn();
    live.subscribe(listener);
    const source = latest();
    source.fire("open");
    // The open's refetches settle before the error.
    await vi.advanceTimersByTimeAsync(0);

    source.fire("error");
    expect(live.stopped()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // The browser retries a connecting source itself: no second source.
    source.fire("error");
    expect(sources).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);

    source.fire("change");
    source.fire("open");
    expect(live.stopped()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({ refetchType: "active" });
    // The open's refetch took the pending change's place.
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("replaces a source the browser gave up on (CLOSED) after REOPEN_MS", async () => {
    const first = latest();
    first.fire("open");
    first.readyState = CLOSED;
    first.fire("error");
    expect(live.stopped()).toBe(true);
    expect(first.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(REOPEN_MS - 1);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);

    latest().fire("open");
    expect(live.stopped()).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  // The browser cannot read a refusal's body: each 409 code reaches the layer as a CLOSED source.
  it.each(["last_event_id_ahead", "last_event_id_pruned"])(
    "a refused reconnect (%s) opens a fresh source, live only, and refetches all",
    async () => {
      const first = latest();
      first.fire("open");
      first.fire("change");
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      expect(invalidateQueries).toHaveBeenCalledTimes(2);
      // The browser's reconnect carried the last id; the route refused it, so the source is CLOSED.
      first.fire("error");
      first.readyState = CLOSED;
      first.fire("error");
      expect(live.stopped()).toBe(true);
      await vi.advanceTimersByTimeAsync(REOPEN_MS);
      // A new EventSource carries no Last-Event-ID: the stream is live only from here.
      expect(sources).toHaveLength(2);
      expect(first.closed).toBe(true);
      latest().fire("open");
      expect(live.stopped()).toBe(false);
      expect(invalidateQueries).toHaveBeenCalledTimes(3);
      expect(invalidateQueries).toHaveBeenLastCalledWith({ refetchType: "active" });
    },
  );

  it("asks for no round while one is in flight; the changes meanwhile get one round once it settles", async () => {
    const rounds: (() => void)[] = [];
    invalidateQueries.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          rounds.push(resolve);
        }),
    );
    const source = latest();
    source.fire("open");
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    // Three windows end while the open's round is in flight: none cancels it with a new one.
    for (let window = 0; window < 3; window++) {
      source.fire("change");
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    }
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    // Once it settles, the changes meanwhile get one round, at once.
    rounds[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenLastCalledWith({ refetchType: "active" });

    // With nothing owed, its settling asks for no more.
    rounds[1]?.();
    await vi.advanceTimersByTimeAsync(10 * COALESCE_MS);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("close drops an owed round", async () => {
    const rounds: (() => void)[] = [];
    invalidateQueries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          rounds.push(resolve);
        }),
    );
    const source = latest();
    source.fire("open");
    source.fire("change");
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    live.close();
    expect(rounds).toHaveLength(1);
    rounds[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("close ends the source and any pending invalidation", async () => {
    const source = latest();
    source.fire("open");
    invalidateQueries.mockClear();
    source.fire("change");
    live.close();
    expect(source.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("the live layer's silence watch (CR9b-8)", () => {
  it("keeps a source that sends heartbeats or changes, however long it stays open", async () => {
    const source = latest();
    source.fire("open");
    for (let beat = 0; beat < 10; beat++) {
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1);
      source.fire(beat % 2 === 0 ? "heartbeat" : "change");
    }
    expect(sources).toHaveLength(1);
    expect(source.closed).toBe(false);
    expect(live.stopped()).toBe(false);
  });

  it("replaces a source silent for 45 s, showing the Alert until the new one opens", async () => {
    const listener = vi.fn();
    live.subscribe(listener);
    const first = latest();
    first.fire("open");
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1);
    expect(live.stopped()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(STREAM_SILENCE_MS).toBe(45_000);
    expect(live.stopped()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);
    expect(sources).toHaveLength(2);

    // Still stopped while the new source connects, however long that takes.
    await vi.advanceTimersByTimeAsync(3 * STREAM_SILENCE_MS);
    expect(live.stopped()).toBe(true);
    expect(sources).toHaveLength(2);
    latest().fire("open");
    expect(live.stopped()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    // Both opens refetched every active query.
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("does not watch a source the browser is reconnecting itself", async () => {
    const source = latest();
    source.fire("open");
    source.fire("error");
    await vi.advanceTimersByTimeAsync(3 * STREAM_SILENCE_MS);
    expect(sources).toHaveLength(1);
    expect(source.closed).toBe(false);
    // The watch resumes once it opens again.
    source.fire("open");
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS);
    expect(sources).toHaveLength(2);
  });
});

describe("a stream the route ends with a coded frame (CR9b-16)", () => {
  it("is closed at once and replaced, live only, after REOPEN_MS, like a refused reconnect", async () => {
    const first = latest();
    first.fire("open");
    first.fire("stream_error");
    expect(first.closed).toBe(true);
    expect(live.stopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(REOPEN_MS - 1);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
    latest().fire("open");
    expect(live.stopped()).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });
});
