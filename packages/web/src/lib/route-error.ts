import { ORPCError } from "@orpc/client";
import { SearchParamError } from "@tanstack/react-router";
import {
  AccessDeniedErrorData,
  EntityId,
  MapNotFoundErrorData,
  ProjectNotFoundErrorData,
  Stage,
  TicketId,
  type AccessDeniedError,
  type MapNotFoundError,
  type ProjectNotFoundError,
} from "@zenorm/contracts";
import { z, ZodError } from "zod";

import { accessDeniedSentence } from "@/lib/access";
import { stageName } from "@/lib/map";

/**
 * What the route error page says (audit A6): a sentence a person can act on, the thrown message
 * as a detail line, and the places the address was near. The throw sites are the pages' own
 * (`viewedDraft`, `shownRun`, `checkStageSearch`, …) and their messages are free text, so the
 * sentence is read from the address, never from the message: which params parsed, which search
 * key is present, and whether the error is a parse failure at all.
 */

/** A search key of a stage page and the stage it belongs to (router `SEARCH_KEY_STAGE`, D1). */
const SEARCH_KEYS = [
  { key: "revision", stage: "spec", record: "spec revision", short: "revision" },
  { key: "version", stage: "tickets", record: "ticket set version", short: "version" },
  { key: "run", stage: "delivery", record: "delivery run", short: "run" },
] as const;

type SearchKey = (typeof SEARCH_KEYS)[number]["key"];

/** A stage page's search: the record's number under its key (D1). */
export type StageSearch = Partial<Record<SearchKey, number>>;

const RecordNumber = z.int().positive();

/**
 * The address the error page is at: the route's params and search, as `useParams` and `useSearch`
 * hand them over with `strict: false`. A param that failed to parse arrives raw (the router keeps
 * the path's text), so every field is checked again here and an invalid one counts as absent.
 */
export interface RouteErrorPlace {
  readonly mapId: unknown;
  readonly projectId: unknown;
  readonly stage: unknown;
  readonly specNumber: unknown;
  readonly number: unknown;
  readonly ticketId: unknown;
  readonly search: Readonly<Record<string, unknown>>;
}

/** Where a link on the error page goes. */
export type RouteErrorLink =
  | { readonly label: string; readonly to: "inbox" }
  | { readonly label: string; readonly to: "project"; readonly projectId: string }
  | {
      readonly label: string;
      readonly to: "stage";
      readonly mapId: string;
      readonly stage: Stage;
      readonly specNumber: number | null;
      /** The record's number under its key; empty for the stage's latest. */
      readonly search: StageSearch;
    };

export interface RouteErrorView {
  /** The page's heading, which the e2e suite finds the error page by. */
  readonly title: string;
  readonly sentence: string;
  /**
   * The thrown message or the record's id, shown as a detail line in mono; null when the error
   * carried none or the sentence already says it word for word.
   */
  readonly detail: string | null;
  readonly links: readonly RouteErrorLink[];
}

/** The route error page's title. */
export const ROUTE_ERROR_TITLE = "Could not open this page";

const INBOX: RouteErrorLink = { label: "Back to the inbox", to: "inbox" };

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** The one stage search key the address carries with a valid number, if any. */
function searchRecord(
  search: Readonly<Record<string, unknown>>,
): { key: SearchKey; stage: Stage; record: string; short: string; number: number } | null {
  for (const entry of SEARCH_KEYS) {
    const number = parsed(RecordNumber, search[entry.key]);
    if (number !== null) {
      return { ...entry, number };
    }
  }
  return null;
}

/**
 * Whether the error is the address failing to parse: a param that is not what its route expects
 * (the router wraps the Zod error, keeping it as `cause`), or a search the stage's schema refused.
 */
function isParseFailure(error: unknown): boolean {
  if (error instanceof SearchParamError || error instanceof ZodError) {
    return true;
  }
  return error instanceof Error && error.cause instanceof ZodError;
}

/** A parse failure's issues as one line, in place of Zod's JSON (the error's `message`). */
function issuesOf(error: unknown): string | null {
  const zod =
    error instanceof ZodError
      ? error
      : error instanceof Error && error.cause instanceof ZodError
        ? error.cause
        : null;
  if (zod === null) {
    return null;
  }
  return zod.issues.map((issue) => issue.message).join("; ");
}

function detailOf(error: unknown): string | null {
  const issues = issuesOf(error);
  if (issues !== null) {
    return issues;
  }
  if (error instanceof Error) {
    return error.message === "" ? null : error.message;
  }
  const text = String(error);
  return text === "" ? null : text;
}

/** A line with its trailing full stop and case set aside, for telling a repeat from a detail. */
function gist(text: string): string {
  return text
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
}

/**
 * The view with its detail dropped when it only repeats the sentence (UX audit P2-19): the pages'
 * throw sites word their message as the sentence does ("This map has no spec revision 9").
 */
function withoutRepeat(view: Omit<RouteErrorView, "title">): RouteErrorView {
  const detail =
    view.detail !== null && gist(view.detail) === gist(view.sentence) ? null : view.detail;
  return { title: ROUTE_ERROR_TITLE, ...view, detail };
}

/** A refusal (`QueryRefusal`'s error) the route error boundary caught, or null for any other error. */
function queryRefusalOf(
  error: unknown,
): MapNotFoundError | ProjectNotFoundError | AccessDeniedError | null {
  if (!(error instanceof ORPCError) || !error.defined) {
    return null;
  }
  const code: unknown = error.code;
  const message: unknown = error.message;
  const payload: unknown = error.data;
  if (typeof message !== "string") {
    return null;
  }
  if (code === "map_not_found") {
    const data = parsed(MapNotFoundErrorData, payload);
    return data === null ? null : { code, message, data };
  }
  if (code === "project_not_found") {
    const data = parsed(ProjectNotFoundErrorData, payload);
    return data === null ? null : { code, message, data };
  }
  if (code === "access_denied") {
    const data = parsed(AccessDeniedErrorData, payload);
    return data === null ? null : { code, message, data };
  }
  return null;
}

/**
 * The page for a read the server refused (slice 9 CR9b-5; UX audit P2-19): a map or project that
 * does not exist, or one the access check denied. The same page as a route error, with the
 * record's id as the detail line and the places near it.
 */
export function describeQueryRefusal(
  error: MapNotFoundError | ProjectNotFoundError | AccessDeniedError,
): RouteErrorView {
  switch (error.code) {
    case "map_not_found":
      return {
        title: "Map not found",
        sentence: "There is no map at this address. It may have been deleted.",
        detail: error.data.mapId,
        links: [INBOX],
      };
    case "project_not_found":
      return {
        title: "Project not found",
        sentence: "There is no project at this address. It may have been removed.",
        detail: error.data.projectId,
        links: [INBOX],
      };
    case "access_denied":
      return {
        title: "Access denied",
        sentence: accessDeniedSentence(error),
        detail: null,
        links: [INBOX],
      };
  }
}

function stageLink(
  label: string,
  mapId: string,
  stage: Stage,
  specNumber: number | null,
  search: StageSearch,
): RouteErrorLink {
  return { label, to: "stage", mapId, stage, specNumber, search };
}

export function describeRouteError(error: unknown, place: RouteErrorPlace): RouteErrorView {
  // A layout that hands a refused read to the error boundary gets the refusal's own page.
  const refusal = queryRefusalOf(error);
  if (refusal !== null) {
    return describeQueryRefusal(refusal);
  }
  return withoutRepeat(describe(error, place));
}

function describe(error: unknown, place: RouteErrorPlace): Omit<RouteErrorView, "title"> {
  const detail = detailOf(error);
  const mapId = parsed(EntityId, place.mapId);
  const projectId = parsed(EntityId, place.projectId);
  const stage = parsed(Stage, place.stage);
  const specNumber = parsed(RecordNumber, place.specNumber);
  const waypoint = parsed(RecordNumber, place.number);
  const ticketId = parsed(TicketId, place.ticketId);
  if (isParseFailure(error)) {
    const links: RouteErrorLink[] = [];
    if (mapId !== null) {
      links.push(stageLink("Open the map", mapId, "idea", null, {}));
    }
    if (projectId !== null) {
      links.push({ label: "Open the project", to: "project", projectId });
    }
    links.push(INBOX);
    return { sentence: "This address is not one ZeNorm can open.", detail, links };
  }

  if (mapId === null) {
    if (projectId !== null) {
      return { sentence: "This project's page could not be shown.", detail, links: [INBOX] };
    }
    return { sentence: "This page could not be shown.", detail, links: [INBOX] };
  }

  const record = searchRecord(place.search);

  // A ticket's execution page: `delivery/$specNumber/$ticketId`, with `?run=` or the latest run.
  if (ticketId !== null && specNumber !== null) {
    const where =
      record === null
        ? `No delivery run of spec ${String(specNumber)} on this map carries ticket ${ticketId}.`
        : `Delivery run ${String(record.number)} of spec ${String(specNumber)} on this map has no ticket ${ticketId}, or there is no such run.`;
    return {
      sentence: where,
      detail,
      links: [stageLink("Open Delivery", mapId, "delivery", null, {}), INBOX],
    };
  }

  if (waypoint !== null) {
    return {
      sentence: `This map has no waypoint ${String(waypoint)}.`,
      detail,
      links: [stageLink("Open Wayfinding", mapId, "wayfinding", null, {}), INBOX],
    };
  }

  if (stage !== null && record !== null && record.stage !== stage) {
    return {
      sentence: `?${record.key}= names a ${record.record}, which the ${stageName(record.stage)} stage shows, not ${stageName(stage)}.`,
      detail,
      links: [
        stageLink(
          `Open ${stageName(record.stage)} ${record.short} ${String(record.number)}`,
          mapId,
          record.stage,
          specNumber,
          { [record.key]: record.number },
        ),
        stageLink(`Open ${stageName(stage)}`, mapId, stage, specNumber, {}),
        INBOX,
      ],
    };
  }

  if (stage !== null && record !== null) {
    return {
      sentence: `This map has no ${record.record} ${String(record.number)}.`,
      detail,
      links: [stageLink(`Open the latest ${record.record}`, mapId, stage, specNumber, {}), INBOX],
    };
  }

  if (stage !== null && specNumber !== null) {
    return {
      sentence: `This map wrote no spec ${String(specNumber)}.`,
      detail,
      links: [stageLink(`Open ${stageName(stage)}`, mapId, stage, null, {}), INBOX],
    };
  }

  if (stage !== null) {
    return {
      sentence: `${stageName(stage)} could not be shown.`,
      detail,
      links: [stageLink("Open Idea", mapId, "idea", null, {}), INBOX],
    };
  }

  return { sentence: "This map's page could not be shown.", detail, links: [INBOX] };
}
