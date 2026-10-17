import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "agent",
    environment: "node",
    pool: "forks",
    // Sweeps `zenorm-delivery-*` processes and folders a killed worker left behind (CR-10).
    globalSetup: ["./vitest.global-setup.ts"],
    // The live test calls the real Claude Code CLI; it runs only through `test:live`.
    exclude: [...configDefaults.exclude, "src/**/*.live.test.ts"],
  },
});
