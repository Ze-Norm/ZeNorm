import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { QUERY_RETRIES, isFetchFailure, retryQuery, shownQueryError } from "./query-errors.ts";

const defined = new ORPCError("map_not_found", { defined: true, status: 404 });
const accessDenied = new ORPCError("access_denied", { defined: true, status: 403 });
const undefinedServerError = new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
const fetchFailure = new TypeError("Failed to fetch");

describe("the query client's retry (CR9b-5)", () => {
  it("never retries a contract-defined error, so a route error shows at once", () => {
    expect(retryQuery(0, defined)).toBe(false);
    expect(retryQuery(0, accessDenied)).toBe(false);
  });

  it("retries a fetch failure and an undefined server error up to QUERY_RETRIES times", () => {
    for (const error of [fetchFailure, undefinedServerError]) {
      for (let failures = 0; failures < QUERY_RETRIES; failures++) {
        expect(retryQuery(failures, error)).toBe(true);
      }
      expect(retryQuery(QUERY_RETRIES, error)).toBe(false);
    }
  });
});

describe("the error a page shows for a read (QA-3)", () => {
  it("shows nothing for a fetch failure: the live Alert is the one signal", () => {
    expect(isFetchFailure(fetchFailure)).toBe(true);
    expect(shownQueryError(fetchFailure)).toBeNull();
  });

  it("shows every response the server sent, defined or not", () => {
    for (const error of [defined, accessDenied, undefinedServerError]) {
      expect(isFetchFailure(error)).toBe(false);
      expect(shownQueryError(error)).toBe(error);
    }
    const parse = new Error("Cannot parse response body");
    expect(shownQueryError(parse)).toBe(parse);
    expect(shownQueryError(null)).toBeNull();
  });
});
