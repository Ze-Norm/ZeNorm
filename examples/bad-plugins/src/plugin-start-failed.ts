import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** A plugin whose `start` rejects. */
export const pluginStartFailed: BadServerCase = {
  kind: "server",
  code: "plugin_start_failed",
  plugins: [
    definePlugin({
      ...manifest("failing-start"),
      start: () => Promise.reject(new Error("The failing-start plugin cannot start")),
    }),
  ],
  pluginConfig: {},
};
