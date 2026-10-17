import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** Two plugins with one id. */
export const pluginIdDuplicate: BadServerCase = {
  kind: "server",
  code: "plugin_id_duplicate",
  plugins: [definePlugin(manifest("twice")), definePlugin(manifest("twice"))],
  pluginConfig: {},
};
