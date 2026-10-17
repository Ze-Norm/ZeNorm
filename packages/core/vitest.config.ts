import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    environment: "node",
    pool: "forks",
    // Many cases run git and stand-in checks in temporary repositories: up to about 0.8 s on a dev
    // machine, and several times that on CI's 3-vCPU macOS runner, where turbo runs every
    // package's tests at once, so vitest's 5 s leaves no room. A hang still fails, at 20 s.
    testTimeout: 20_000,
    // Sweeps `zenorm-core-delivery-*` processes and folders a killed worker left behind.
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
