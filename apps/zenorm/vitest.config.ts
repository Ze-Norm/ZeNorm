import { defineProject } from "vitest/config";

export default defineProject({
  // `e2e/` holds the Playwright test, which Playwright runs.
  test: { name: "zenorm", environment: "node", pool: "forks", include: ["src/**/*.test.ts"] },
});
