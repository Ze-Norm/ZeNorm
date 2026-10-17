import { z } from "zod";

/**
 * What both entries of the example plugin share: the manifest the web compares with `GET /plugins`,
 * and the body of its raw route. Nothing here touches Node, so the web entry imports it too.
 */
export const EXAMPLE_PLUGIN = {
  id: "example",
  version: "0.1.0",
  sdk: "^0.1.0",
} as const;

/** The executor's name; `delivery.executor: "example"` selects it. */
export const EXAMPLE_EXECUTOR = "example";

/** The raw route's path under `/plugins/example/`. */
export const COUNTS_PATH = `/plugins/${EXAMPLE_PLUGIN.id}/counts`;

/** The orchestrator line the executor emits first. */
export const EXAMPLE_EXECUTOR_LINE = "Example executor: no agent runs; each ticket is one commit.";

/** The admission refusal's reason. */
export const REFUSED_DELIVERY_REASON =
  "The example plugin refuses delivery runs for this project (refusedDeliveryProjectNames).";

/** The plugin's `plugins.example` section; every key is required. */
export const ExampleConfig = z.strictObject({
  deniedProjectNames: z.array(z.string().min(1)),
  refusedDeliveryProjectNames: z.array(z.string().min(1)),
});
export type ExampleConfig = z.infer<typeof ExampleConfig>;

const Count = z.int().min(0);

/** `GET /plugins/example/counts`: the seam and executor call counts and the rows per project. */
export const ExampleCounts = z.strictObject({
  seams: z.strictObject({
    identify: Count,
    checkAccess: Count,
    checkout: Count,
    executorEnv: Count,
    admitRun: Count,
  }),
  executor: z.strictObject({ implement: Count, review: Count }),
  /** Committed change-feed rows per project id, as the `*` subscriber saw them. */
  projects: z.record(z.string(), Count),
});
export type ExampleCounts = z.infer<typeof ExampleCounts>;
