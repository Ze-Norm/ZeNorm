import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** A section for a plugin that takes no config. */
export const pluginConfigUnknownSection: BadServerCase = {
  kind: "server",
  code: "plugin_config_unknown_section",
  plugins: [definePlugin(manifest("no-config"))],
  pluginConfig: { "no-config": { enabled: true } },
};
