import { ChangeEvent } from "@zenorm/contracts";
import type { Actor, ActorKind, UserId } from "@zenorm/contracts";
import { changeFeed, users, writeActor } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { asc, gt, max } from "drizzle-orm";

import type { Tx } from "./planning-runs.ts";

/** Receives each committed change, in `seq` order. */
export type ChangeSubscriber = (event: ChangeEvent) => void;

/** Where a subscriber's throw goes; the app passes its own `log`. */
export type ChangeBusLog = (message: string, error: unknown) => void;

/**
 * The in-memory after-commit bus: `write` publishes each committed transaction's change feed rows
 * to it, in order. Delivery is at most once and nothing is retried. The SSE route and plugin
 * subscribers are its only listeners.
 */
export interface ChangeBus {
  /** Adds `subscriber`, named in the log when it throws; returns its unsubscribe. */
  readonly subscribe: (name: string, subscriber: ChangeSubscriber) => () => void;
  /**
   * Hands each event, in order, to every subscriber. A subscriber's throw is logged with its name
   * and stops neither the others nor the write.
   */
  readonly publish: (events: readonly ChangeEvent[]) => void;
}

export function createChangeBus(log: ChangeBusLog): ChangeBus {
  const subscribers = new Set<{ readonly name: string; readonly subscriber: ChangeSubscriber }>();
  return {
    subscribe: (name, subscriber) => {
      const entry = { name, subscriber };
      subscribers.add(entry);
      return () => {
        subscribers.delete(entry);
      };
    },
    publish: (events) => {
      for (const event of events) {
        for (const { name, subscriber } of [...subscribers]) {
          try {
            subscriber(event);
          } catch (error: unknown) {
            log(`Change subscriber ${name} threw on change ${String(event.seq)}`, error);
          }
        }
      }
    },
  };
}

/** Each database's bus; `createApp` sets it, and a restarted app on the same database replaces it. */
const buses = new WeakMap<ZeNormDatabase, ChangeBus>();

/** Makes `bus` the one `write` publishes `db`'s committed changes to. */
export function setChangeBus(db: ZeNormDatabase, bus: ChangeBus): void {
  buses.set(db, bus);
}

function changeBusOf(db: ZeNormDatabase): ChangeBus {
  const bus = buses.get(db);
  if (bus === undefined) {
    throw new Error("No change bus is set for this database: call setChangeBus before writing");
  }
  return bus;
}

/** The `write_actor` (and `change_feed`) columns of `actor`. */
function actorColumns(actor: Actor): {
  readonly actorKind: ActorKind;
  readonly actorUserId: string | null;
  readonly actorRunId: string | null;
} {
  switch (actor.kind) {
    case "user":
      return { actorKind: actor.kind, actorUserId: actor.userId, actorRunId: null };
    case "planning_run":
    case "delivery_run":
      return { actorKind: actor.kind, actorUserId: actor.userId, actorRunId: actor.runId };
    case "system":
      return { actorKind: actor.kind, actorUserId: null, actorRunId: null };
  }
}

export type FeedRow = typeof changeFeed.$inferSelect;

/** A stored feed row as the wire event; a row that breaks `ChangeEvent` is corrupt, and throws. */
export function toChangeEvent(row: FeedRow): ChangeEvent {
  const actor =
    row.actorKind === "user"
      ? { kind: row.actorKind, userId: row.actorUserId }
      : row.actorKind === "system"
        ? { kind: row.actorKind }
        : { kind: row.actorKind, runId: row.actorRunId, userId: row.actorUserId };
  return ChangeEvent.parse({
    seq: row.seq,
    projectId: row.projectId,
    mapId: row.mapId,
    entityType: row.entityType,
    entityId: row.entityId,
    op: row.op,
    actor,
  });
}

/**
 * Runs `fn` as one write by `actor`: an immediate transaction that fills
 * `write_actor`, runs `fn(tx)` and empties `write_actor` again, so every change feed row the
 * triggers append names `actor`. The rows above the `seq` noted at the start are read inside the
 * transaction (exactly this write's rows) and handed to the bus, in order, only once it has
 * committed. A throw in `fn` rolls everything back and publishes nothing. `fn` must not open a
 * second write: nested work uses the `tx` it is given. Returns `fn`'s value.
 */
export function write<T>(db: ZeNormDatabase, actor: Actor, fn: (tx: Tx) => T): T {
  const bus = changeBusOf(db);
  const { value, events } = db.transaction(
    (tx) => {
      const noted = tx
        .select({ seq: max(changeFeed.seq) })
        .from(changeFeed)
        .get();
      if (noted === undefined) throw new Error("max(seq) over change_feed returned no row");
      // Null when the feed is empty: every row read below is then this write's.
      const before = noted.seq;
      tx.insert(writeActor)
        .values({ id: 1, ...actorColumns(actor) })
        .run();
      const result = fn(tx);
      tx.delete(writeActor).run();
      const rows = tx
        .select()
        .from(changeFeed)
        .where(before === null ? undefined : gt(changeFeed.seq, before))
        .orderBy(asc(changeFeed.seq))
        .all();
      return { value: result, events: rows.map(toChangeEvent) };
    },
    { behavior: "immediate" },
  );
  bus.publish(events);
  return value;
}

/** The instance's one User. */
export interface LocalUser {
  readonly id: UserId;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
}

/**
 * The one User row. Startup refuses zero rows (`user_missing`) and more than one
 * (`user_ambiguous`), so either here is a programmer error, and throws.
 */
export function localUser(db: Pick<ZeNormDatabase, "select">): LocalUser {
  const rows = db.select().from(users).all();
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new Error(`Expected exactly one user row, found ${String(rows.length)}`);
  }
  return row;
}
