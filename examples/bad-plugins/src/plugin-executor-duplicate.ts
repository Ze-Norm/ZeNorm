import { err } from "@zenorm/contracts";
import type { DeliveryAgentError } from "@zenorm/contracts";
import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

const NOT_RUN: DeliveryAgentError = {
  code: "agent_run_failed",
  message: "This executor never runs",
  data: { exitCode: null, subtype: null },
};

/** A plugin that registers an executor named `"local"`, the app's own (S9-22). */
export const pluginExecutorDuplicate: BadServerCase = {
  kind: "server",
  code: "plugin_executor_duplicate",
  plugins: [
    definePlugin({
      ...manifest("second-local"),
      executors: () => [
        {
          name: "local",
          implementTicketSet: () => Promise.resolve(err(NOT_RUN)),
          reviewDelivery: () => Promise.resolve(err(NOT_RUN)),
          writePullRequest: () => Promise.resolve(err(NOT_RUN)),
        },
      ],
    }),
  ],
  pluginConfig: {},
};
