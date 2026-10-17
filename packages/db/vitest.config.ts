import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "db", environment: "node", pool: "forks" },
});
