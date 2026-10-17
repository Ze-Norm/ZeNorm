import { isDefinedError } from "@orpc/client";

/**
 * How the web app treats a failed read (slice 9 S9-14 Part B): a contract-defined error is the
 * answer and shows at once (CR9b-5); a fetch that never reached the server is the live layer's
 * business, so the page keeps what it has and the live Alert is the one signal (QA-3).
 */

/** How many times a read is retried after its first failure, unless its error is contract-defined. */
export const QUERY_RETRIES = 3;

/**
 * Whether `error` is a fetch that never got a response (the server stopped, the network dropped):
 * `fetch` rejects with a `TypeError` then, while every response the server sends arrives as an
 * `ORPCError` (a contract-defined code, or an undefined one such as a 500).
 */
export function isFetchFailure(error: Error): boolean {
  return error instanceof TypeError;
}

/**
 * The query client's `retry` (CR9b-5): a contract-defined error (`access_denied`, `map_not_found`,
 * …) is never retried; any other error is retried up to `QUERY_RETRIES` times.
 */
export function retryQuery(failureCount: number, error: Error): boolean {
  if (isDefinedError(error)) return false;
  return failureCount < QUERY_RETRIES;
}

/**
 * The error a page shows for a read, or null: a fetch failure shows nothing (the page keeps its
 * cached data, and the live Alert says the server is unreachable; reconnecting refetches every
 * active read), any other error shows as it is.
 */
export function shownQueryError<E extends Error>(error: E | null): E | null {
  if (error === null || isFetchFailure(error)) return null;
  return error;
}
