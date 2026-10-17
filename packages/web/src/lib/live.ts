import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * The live layer: the app's one transport for server changes. It holds one
 * `EventSource("/events")` and turns its change events into one coalesced invalidation of the
 * active queries; components never touch `EventSource`.
 */

/** How long change events gather before the one invalidation they cause. */
export const COALESCE_MS = 300;

/** How long after the stream has given up (`CLOSED`, e.g. a 503 during shutdown) it is opened again. */
export const REOPEN_MS = 1000;

/**
 * How long an open stream may go without a change or a heartbeat before it counts as dead and is
 * replaced: three of the server's 15 s heartbeats (`HEARTBEAT_MS` in `events.ts`).
 */
export const STREAM_SILENCE_MS = 45_000;

/** `EventSource.CLOSED`: the browser will not reconnect this source itself. */
const CLOSED = 2;

/**
 * The events a source dispatches: the browser's `open` and `error`, and the route's named frames,
 * `change`, `heartbeat` and `stream_error` (a coded end of the stream, such as `replay_failed`).
 */
export type ChangeSourceEvent = "open" | "error" | "change" | "heartbeat" | "stream_error";

/** The part of `EventSource` the live layer uses. */
export interface ChangeSource {
  readonly readyState: number;
  addEventListener(type: ChangeSourceEvent, listener: () => void): void;
  close(): void;
}

/** The part of the timers the live layer uses (the window's, or a test's fake ones). */
export interface LiveTimers {
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
}

export interface LiveUpdates {
  /** Whether the stream has failed and has not opened again: the Alert shows while it is. */
  readonly stopped: () => boolean;
  /** Calls `listener` on each change of `stopped`; returns its unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Closes the stream and cancels any pending invalidation. */
  readonly close: () => void;
}

/**
 * Opens the stream through `openSource` and keeps `queryClient` current from it: each change
 * starts (or joins) a `COALESCE_MS` window that ends in one invalidation of the active queries,
 * or, while the last one's refetches are still in flight, in one more once they settle.
 * Every `open`, the first included, invalidates at once, since any change may have been committed
 * before the stream subscribed. An `error` marks the layer stopped until the next `open`.
 * A source the browser has given up on, or one the route ended with a `stream_error`, is replaced
 * after `REOPEN_MS`; an open source silent for `STREAM_SILENCE_MS` is replaced at once. A replaced
 * source is a new `EventSource`, so it carries no `Last-Event-ID`: its stream is live only. A
 * reconnect the route refuses with 409 (`last_event_id_ahead`, or `last_event_id_pruned` when the
 * feed no longer holds the rows after its id) leaves the source `CLOSED`: it is replaced,
 * and the new source's `open` refetches every active query, the full resync.
 */
export function startLiveUpdates(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  openSource: () => ChangeSource,
  timers: LiveTimers,
): LiveUpdates {
  const listeners = new Set<() => void>();
  let stopped = false;
  let pending: number | null = null;
  let reopening: number | null = null;
  let silence: number | null = null;
  let source: ChangeSource;
  let closed = false;
  /** Whether a refetch round is in flight, and whether another is owed once it settles. */
  let refetching = false;
  let owed = false;

  function setStopped(value: boolean): void {
    if (stopped === value) return;
    stopped = value;
    for (const listener of [...listeners]) listener();
  }

  /**
   * One refetch round at a time. A round asked for while one is in flight is owed and starts when
   * that one settles: cancelling it instead (TanStack's default) left a page whose reads take
   * longer than a window refetching forever and never showing the change, while the server still
   * answered every cancelled read. The owed round starts after the change, so none is missed.
   */
  function invalidate(): void {
    if (pending !== null) {
      timers.clearTimeout(pending);
      pending = null;
    }
    if (refetching) {
      owed = true;
      return;
    }
    refetching = true;
    void queryClient.invalidateQueries({ refetchType: "active" }).finally(() => {
      refetching = false;
      if (owed && !closed) {
        owed = false;
        invalidate();
      }
    });
  }

  function unwatch(): void {
    if (silence !== null) {
      timers.clearTimeout(silence);
      silence = null;
    }
  }

  /** (Re)starts the silence watch on the open source `opened`. */
  function watch(opened: ChangeSource): void {
    unwatch();
    silence = timers.setTimeout(() => {
      silence = null;
      setStopped(true);
      opened.close();
      source = open();
    }, STREAM_SILENCE_MS);
  }

  /** Closes `opened` and opens a fresh source after `REOPEN_MS`. */
  function reopenLater(opened: ChangeSource): void {
    opened.close();
    if (reopening !== null || closed) return;
    reopening = timers.setTimeout(() => {
      reopening = null;
      source = open();
    }, REOPEN_MS);
  }

  function open(): ChangeSource {
    const opened = openSource();
    opened.addEventListener("change", () => {
      watch(opened);
      if (pending !== null) return;
      pending = timers.setTimeout(() => {
        pending = null;
        invalidate();
      }, COALESCE_MS);
    });
    opened.addEventListener("heartbeat", () => {
      watch(opened);
    });
    opened.addEventListener("error", () => {
      // The browser retries a `CONNECTING` source itself; the watch resumes on its `open`.
      unwatch();
      setStopped(true);
      if (opened.readyState === CLOSED) reopenLater(opened);
    });
    opened.addEventListener("stream_error", () => {
      // Closed at once, so the browser's own reconnect never carries the same `Last-Event-ID`
      // back to the replay that failed: handled like a refused reconnect.
      unwatch();
      setStopped(true);
      reopenLater(opened);
    });
    opened.addEventListener("open", () => {
      watch(opened);
      setStopped(false);
      invalidate();
    });
    return opened;
  }

  source = open();

  return {
    stopped: () => stopped,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      source.close();
      for (const id of [pending, reopening, silence]) if (id !== null) timers.clearTimeout(id);
      pending = null;
      reopening = null;
      silence = null;
    },
  };
}

/** The app's live layer, provided once in `main.tsx`. */
export const LiveUpdatesContext = createContext<LiveUpdates | null>(null);

/** Whether live updates have stopped; only under `LiveUpdatesContext`. */
export function useLiveUpdatesStopped(): boolean {
  const live = useContext(LiveUpdatesContext);
  if (live === null) {
    throw new Error("useLiveUpdatesStopped needs the LiveUpdatesContext provider (main.tsx)");
  }
  return useSyncExternalStore(live.subscribe, live.stopped);
}
