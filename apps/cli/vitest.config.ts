import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cli",
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // init's and doctor's stand-in tests run the stand-in claude and migrate a database.
    testTimeout: 30_000,
  },
});
