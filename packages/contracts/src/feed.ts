import { z } from "zod";

import { Actor } from "./actor.ts";
import { EntityId } from "./map.ts";

/**
 * Every table the change feed records: each core table, i.e. every table but `change_feed`,
 * `users`, `write_actor`, `zenorm_migrations` and `sqlite_%`. `@zenorm/db`'s feed table map is
 * keyed by it, and `installChangeFeed` refuses a database whose tables differ.
 */
export const ChangeEntityType = z.enum([
  "code_surveys",
  "consistency_findings",
  "consistency_passes",
  "delivery_run_events",
  "delivery_run_tickets",
  "delivery_runs",
  "hatch_messages",
  "map_exclusions",
  "map_fog",
  "map_proposals",
  "maps",
  "planning_runs",
  "projects",
  "question_rounds",
  "research_reports",
  "research_sources",
  "spec_review_findings",
  "spec_reviews",
  "spec_revisions",
  "spec_waits",
  "specifications",
  "task_outcomes",
  "ticket_set_rejections",
  "ticket_set_versions",
  "ticket_sets",
  "tickets_review_findings",
  "tickets_reviews",
  "waypoint_blockers",
  "waypoint_touches",
  "waypoints",
]);
export type ChangeEntityType = z.infer<typeof ChangeEntityType>;

export const ChangeOp = z.enum(["insert", "update", "delete"]);
export type ChangeOp = z.infer<typeof ChangeOp>;

/**
 * One committed change feed row on the wire: the SSE event's `data` and what the after-commit bus
 * hands each subscriber. It carries no row content. `entityId` is the row's key, a composite key
 * joined with `:`.
 */
export const ChangeEvent = z.strictObject({
  seq: z.int().min(1),
  projectId: EntityId,
  mapId: EntityId.nullable(),
  entityType: ChangeEntityType,
  entityId: z.string().min(1),
  op: ChangeOp,
  actor: Actor,
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

/**
 * The plain-text codes `GET /events` refuses a connect with; the body is the code.
 * `last_event_id_invalid` (400): a malformed `Last-Event-ID`. `last_event_id_ahead` (409): an id
 * past the newest the feed has issued. `last_event_id_pruned` (409): rows after the id have been
 * pruned, so a replay from it would miss changes. `streams_closed` (503): the server is shutting
 * down. The client answers each 409 the same way: a fresh stream, live only, and a full refetch.
 */
export const EventsRefusalCode = z.enum([
  "last_event_id_invalid",
  "last_event_id_ahead",
  "last_event_id_pruned",
  "streams_closed",
]);
export type EventsRefusalCode = z.infer<typeof EventsRefusalCode>;
