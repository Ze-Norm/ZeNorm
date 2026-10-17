import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** An id outside `[a-z][a-z0-9-]*`. */
export const pluginIdInvalid: BadServerCase = {
  kind: "server",
  code: "plugin_id_invalid",
  plugins: [definePlugin(manifest("Bad_Id"))],
  pluginConfig: {},
};
