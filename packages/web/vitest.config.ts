import { defineProject } from "vitest/config";

export default defineProject({
  // The `@/` paths resolve as in the app's build, so a test can render a component that uses them.
  resolve: { tsconfigPaths: true },
  test: { name: "web", environment: "node", include: ["src/**/*.test.ts"] },
});
