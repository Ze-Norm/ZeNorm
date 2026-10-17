import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "agent-live",
    environment: "node",
    pool: "forks",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 300_000,
  },
});
