import { describe, expect, test } from "vitest";

import {
  descendantsOf,
  parseProcessTable,
  parseStartTime,
  processTable,
  serverIdentity,
} from "./process-table.ts";

describe("the process table (CR-2, CR-12)", () => {
  test("parses ps's pid, ppid and pgid columns", () => {
    expect(
      parseProcessTable("    1     0     1\n  412     1   412\n  413   412   412\n\n"),
    ).toEqual([
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 412, ppid: 1, pgid: 412 },
      { pid: 413, ppid: 412, pgid: 412 },
    ]);
  });

  test.each([
    { name: "a missing column", line: "412 1" },
    { name: "an extra column", line: "412 1 412 9" },
    { name: "a non-number", line: "412 x 412" },
  ])("refuses a malformed line as a programmer error: $name", ({ line }) => {
    expect(() => parseProcessTable(`1 0 1\n${line}\n`)).toThrow(Error);
  });

  test("this process is in the real table, under its parent", async () => {
    const table = await processTable();
    expect(table.find((row) => row.pid === process.pid)).toMatchObject({ ppid: process.ppid });
    expect(descendantsOf(process.ppid, table)).toContain(process.pid);
  });

  test("descendants come children first and never include the root", () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 10 },
      { pid: 12, ppid: 11, pgid: 12 },
      { pid: 13, ppid: 10, pgid: 13 },
      { pid: 14, ppid: 1, pgid: 14 },
    ];
    expect(descendantsOf(10, table)).toEqual([11, 13, 12]);
  });
});

describe("process start times (C6)", () => {
  test.each([
    { name: "a two-digit day", lstart: "Wed Oct 14 10:00:05 2026", day: 14 },
    // procps pads a one-digit day with a space; macOS prints it the same way.
    { name: "a space-padded day", lstart: "Sun Oct  4 10:00:05 2026", day: 4 },
  ])("parses ps's lstart in the C locale: $name", ({ lstart, day }) => {
    expect(parseStartTime(412, lstart)).toBe(new Date(2026, 9, day, 10, 0, 5).getTime());
  });

  test("refuses a start time it cannot parse as a programmer error", () => {
    expect(() => parseStartTime(412, "yesterday")).toThrow(Error);
  });

  test("this process's identity is its pid and ps start time, taken once", () => {
    const identity = serverIdentity();
    expect(identity.serverPid).toBe(process.pid);
    const started = Date.parse(identity.serverStartedAt);
    // `ps` truncates to the second; the process started no later than now.
    expect(started).toBeLessThanOrEqual(Date.now());
    expect(started).toBeGreaterThanOrEqual(Date.now() - process.uptime() * 1000 - 3000);
    expect(serverIdentity()).toBe(identity);
  });
});
