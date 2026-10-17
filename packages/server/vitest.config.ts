import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "server",
    environment: "node",
    pool: "forks",
    // The delivery cases drive whole runs through git worktrees and stand-in checks: up to about
    // 1.6 s on a dev machine, and several times that on CI's 3-vCPU macOS runner, where turbo runs
    // every package's tests at once, so vitest's 5 s leaves no room. A hang still fails, at 20 s.
    testTimeout: 20_000,
  },
});
