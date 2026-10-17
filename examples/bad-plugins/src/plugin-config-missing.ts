import { configuredPlugin } from "./configured.ts";
import type { BadServerCase } from "./case.ts";

/** A plugin with a config schema and no `plugins.<id>` section. */
export const pluginConfigMissing: BadServerCase = {
  kind: "server",
  code: "plugin_config_missing",
  plugins: [configuredPlugin()],
  pluginConfig: {},
};
