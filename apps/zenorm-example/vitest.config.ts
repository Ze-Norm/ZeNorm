import { defineProject } from "vitest/config";

export default defineProject({
  // `@zenorm/web/app`'s sources import through web's `@/` alias (each file's nearest tsconfig).
  resolve: { tsconfigPaths: true },
  // `e2e/` holds the Playwright test, which Playwright runs.
  test: {
    name: "zenorm-example",
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts"],
    // Each case starts ZeNorm on a fresh database, and the first web case loads the whole web app
    // into JSDOM cold: about 0.7 s on a dev machine, past vitest's 5 s on CI's 3-vCPU macOS runner,
    // where turbo runs every package's tests at once. A hang still fails, at 20 s.
    testTimeout: 20_000,
  },
});
