import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** A plugin built against an SDK range that excludes this one. */
export const pluginSdkIncompatible: BadServerCase = {
  kind: "server",
  code: "plugin_sdk_incompatible",
  plugins: [definePlugin({ ...manifest("future-sdk"), sdk: "^9.0.0" })],
  pluginConfig: {},
};
