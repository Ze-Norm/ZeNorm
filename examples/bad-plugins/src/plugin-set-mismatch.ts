import { defineWebPlugin, definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadWebCase } from "./case.ts";

/** The server runs version 1.0.0 of a plugin and the web build was composed with 2.0.0. */
export const pluginSetMismatch: BadWebCase = {
  kind: "web",
  code: "plugin_set_mismatch",
  serverPlugins: [definePlugin(manifest("versioned"))],
  webPlugins: [defineWebPlugin({ ...manifest("versioned"), version: "2.0.0", slots: {} })],
};
