import { configuredPlugin } from "./configured.ts";
import type { BadServerCase } from "./case.ts";

/** A section its plugin's schema refuses. */
export const pluginConfigInvalid: BadServerCase = {
  kind: "server",
  code: "plugin_config_invalid",
  plugins: [configuredPlugin()],
  pluginConfig: { configured: { limit: "ten" } },
};
