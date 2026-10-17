import type { ChangeEvent, CheckAccess, EventsRefusalCode, Identify } from "@zenorm/contracts";
import { toChangeEvent } from "@zenorm/core";
import type { ChangeBus } from "@zenorm/core";
import { changeFeed, changeFeedEnds, pruneChangeFeed } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, gt } from "drizzle-orm";

import type { Log } from "./app.ts";

/**
 * How often an open stream sends a `heartbeat` event, so idle proxies keep it and the client can
 * tell a live stream from a silently dead one (S9-15, CR9b-8).
 */
export const HEARTBEAT_MS = 15_000;

/** How many feed rows one replay read takes (slice 9 ticket 08). */
export const REPLAY_PAGE_SIZE = 500;

const BAD_REQUEST = 400;
const CONFLICT = 409;
const SERVICE_UNAVAILABLE = 503;

export interface EventStreamsOptions {
  readonly db: ZeNormDatabase;
  readonly bus: ChangeBus;
  /** The identity seam: the User the stream's request acts as (S9-17). */
  readonly identify: Identify;
  /** The access check seam: each row is sent only if its project's read is allowed (D12). */
  readonly checkAccess: CheckAccess;
  readonly log: Log;
}

/**
 * The instance's change stream (S9-15, D12): `handle` answers `GET /events`, `closeStreams` ends
 * every open stream (shutdown, before the server closes) and refuses new ones from then on.
 *
 * The feed keeps only the rows an open stream still needs (CR9b-17): a stream replaying from its
 * `Last-Event-ID` needs the rows after the last one it has handled, and no other stream needs any
 * (a live stream is sent each change from the bus). After each committed change and each stream's
 * replay or end, every row no replaying stream needs is deleted; with none replaying, every row.
 */
export interface EventStreams {
  readonly handle: (request: Request) => Response;
  readonly closeStreams: () => void;
}

/** `Last-Event-ID`: `seq` null when absent (live only), else the last `seq` the client has; null when malformed. */
function lastEventId(request: Request): { readonly seq: number | null } | null {
  const header = request.headers.get("last-event-id");
  if (header === null) return { seq: null };
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return null;
  const seq = Number(header);
  return Number.isSafeInteger(seq) ? { seq } : null;
}

/** Lets other tasks run (a write, the bus) between two replay pages. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const encoder = new TextEncoder();

function changeFrame(event: ChangeEvent): string {
  return `id: ${String(event.seq)}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * A named event, so the browser dispatches it (a comment never reaches a listener). It has no `id`,
 * so it leaves the stream's `Last-Event-ID` as it is, and a `data` line, without which the browser
 * dispatches nothing.
 */
const HEARTBEAT_FRAME = "event: heartbeat\ndata: \n\n";

/** The codes a stream can end with in a `stream_error` frame (CR9b-16). */
export type StreamErrorCode = "replay_failed";

/**
 * The frame that ends a stream on a coded failure: the client closes the source and opens a fresh
 * one, with no `Last-Event-ID`, as it does after a refused reconnect (CR9b-16).
 */
function streamErrorFrame(code: StreamErrorCode): string {
  return `event: stream_error\ndata: ${JSON.stringify({ code })}\n\n`;
}

/** The refusal of a connect: the code is the plain-text body. */
function refuse(code: EventsRefusalCode, status: number): Response {
  return new Response(code, { status });
}

/** One open stream: what it has sent, its replay buffer, and how it ends. */
class Stream {
  /** Every live event while the replay runs; drained after it, past the replay's last `seq`. */
  buffer: ChangeEvent[] | null;
  /** The last `seq` handled (sent, or refused by the access check): nothing at or below it again. */
  handled: number;
  ended = false;
  /** Whether an access check has thrown on this stream: logged once, each such event refused. */
  #accessThrew = false;
  readonly #controller: ReadableStreamDefaultController<Uint8Array>;
  readonly #admits: (event: ChangeEvent) => boolean;
  readonly #log: Log;

  constructor(
    controller: ReadableStreamDefaultController<Uint8Array>,
    from: number | null,
    admits: (event: ChangeEvent) => boolean,
    log: Log,
  ) {
    this.#controller = controller;
    this.#admits = admits;
    this.#log = log;
    if (from === null) {
      // Live only: no replay, and every live event is new.
      this.buffer = null;
      this.handled = 0;
    } else {
      this.buffer = [];
      this.handled = from;
    }
  }

  send(text: string): void {
    if (!this.ended) this.#controller.enqueue(encoder.encode(text));
  }

  /** Sends `event` once, in `seq` order, if the access check admits it. */
  deliver(event: ChangeEvent): void {
    if (this.ended || event.seq <= this.handled) return;
    this.handled = event.seq;
    if (this.#admitted(event)) this.send(changeFrame(event));
  }

  /** The access check; one that throws refuses the event, and is logged once per stream (CR9b-16). */
  #admitted(event: ChangeEvent): boolean {
    try {
      return this.#admits(event);
    } catch (error: unknown) {
      if (!this.#accessThrew) {
        this.#accessThrew = true;
        this.#log(
          `The change stream's access check threw at seq ${String(event.seq)}; it refuses every event it throws on`,
          error,
        );
      }
      return false;
    }
  }

  /** Ends the stream; `closeBody` is false once the client has cancelled the body itself. */
  end(closeBody: boolean): void {
    this.ended = true;
    if (closeBody) this.#controller.close();
  }
}

/**
 * Each database's streams whose replay is still reading the feed: only they need rows kept
 * (CR9b-17). Per database, not per `createEventStreams`, so no instance prunes a row another
 * instance's replay on the same database still needs.
 */
const replayingStreams = new WeakMap<ZeNormDatabase, Set<Stream>>();

function replayingOn(db: ZeNormDatabase): Set<Stream> {
  const known = replayingStreams.get(db);
  if (known !== undefined) return known;
  const created = new Set<Stream>();
  replayingStreams.set(db, created);
  return created;
}

export function createEventStreams({
  db,
  bus,
  identify,
  checkAccess,
  log,
}: EventStreamsOptions): EventStreams {
  const open = new Set<(closeBody: boolean) => void>();
  const replaying = replayingOn(db);
  let closed = false;

  /** Deletes every row no replaying stream needs: each needs the rows after its `handled`. */
  function prune(): void {
    // With no stream replaying, no row is needed.
    let through: number | "all" = "all";
    for (const stream of replaying) {
      if (through === "all" || stream.handled < through) through = stream.handled;
    }
    try {
      pruneChangeFeed(db, through);
    } catch (error: unknown) {
      // The rows stay; the next change or stream end prunes them.
      log("The change feed's prune failed", error);
    }
  }

  // Each committed change may leave rows no stream needs; the bus runs after the commit.
  const unsubscribePrune = bus.subscribe("events_prune", () => {
    prune();
  });

  /** Replays the rows after `stream.handled` in pages, then drains what the bus buffered. */
  async function replay(stream: Stream): Promise<void> {
    for (;;) {
      if (stream.ended) return;
      const rows = db
        .select()
        .from(changeFeed)
        .where(gt(changeFeed.seq, stream.handled))
        .orderBy(asc(changeFeed.seq))
        .limit(REPLAY_PAGE_SIZE)
        .all();
      for (const row of rows) {
        let event: ChangeEvent;
        try {
          event = toChangeEvent(row);
        } catch (error: unknown) {
          throw new Error(`The change feed row at seq ${String(row.seq)} is not a change event`, {
            cause: error,
          });
        }
        stream.deliver(event);
      }
      if (rows.length < REPLAY_PAGE_SIZE) break;
      await nextTurn();
    }
    const { buffer } = stream;
    stream.buffer = null;
    replaying.delete(stream);
    if (buffer !== null) for (const event of buffer) stream.deliver(event);
    prune();
  }

  function handle(request: Request): Response {
    if (closed) {
      return refuse("streams_closed", SERVICE_UNAVAILABLE);
    }
    const from = lastEventId(request);
    if (from === null) {
      return refuse("last_event_id_invalid", BAD_REQUEST);
    }
    if (from.seq !== null) {
      const ends = changeFeedEnds(db);
      if (from.seq > ends.newest) {
        // An id this feed never sent (e.g. a tab left open across a database reset): replaying from
        // it would drop every change up to it. The client reconnects afresh, live only (S9-15).
        return refuse("last_event_id_ahead", CONFLICT);
      }
      if (from.seq < ends.prunedThrough) {
        // Rows after the id are gone (CR9b-17): a replay would miss them. The client reconnects
        // afresh, live only, and refetches, as after `last_event_id_ahead`.
        return refuse("last_event_id_pruned", CONFLICT);
      }
    }
    const user = identify(request);
    const admits = (event: ChangeEvent): boolean => checkAccess(user, event.projectId, "read");
    let end: ((closeBody: boolean) => void) | null = null;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const stream = new Stream(controller, from.seq, admits, log);
        // Subscribe first, so no write committed during the replay is missed (S9-15).
        const unsubscribe = bus.subscribe("events", (event) => {
          if (stream.buffer === null) {
            stream.deliver(event);
          } else {
            stream.buffer.push(event);
          }
        });
        const heartbeat = setInterval(() => {
          stream.send(HEARTBEAT_FRAME);
        }, HEARTBEAT_MS);
        const ending = (closeBody: boolean): void => {
          if (stream.ended) return;
          open.delete(ending);
          unsubscribe();
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", aborted);
          stream.end(closeBody);
          // Its replay, if still running, no longer holds rows.
          if (replaying.delete(stream)) prune();
        };
        const aborted = (): void => {
          ending(true);
        };
        end = ending;
        open.add(ending);
        request.signal.addEventListener("abort", aborted);
        // A first line, so the response's headers go out now and the browser's `open` fires.
        stream.send(": open\n\n");
        if (stream.buffer !== null) {
          // Registered in this same turn as the check above, so no prune runs between them.
          replaying.add(stream);
          replay(stream).catch((error: unknown) => {
            // Ended with a code, not just closed: a plain end would bring the browser straight
            // back with the same Last-Event-ID, to fail on the same row (CR9b-16).
            log("The change stream's replay failed", error);
            stream.send(streamErrorFrame("replay_failed"));
            ending(true);
          });
        }
      },
      cancel() {
        // The client went away; `start` has run, so `end` is set.
        if (end !== null) end(false);
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        // The connection ends with the stream: a kept-alive one would hold the server's close for
        // seconds after `closeStreams` (S9-2's timing).
        connection: "close",
      },
    });
  }

  return {
    handle,
    closeStreams: () => {
      closed = true;
      unsubscribePrune();
      for (const end of [...open]) end(true);
    },
  };
}
