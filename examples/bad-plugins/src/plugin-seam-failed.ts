import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** Seam wrappers whose factory throws when the server composes them. */
export const pluginSeamFailed: BadServerCase = {
  kind: "server",
  code: "plugin_seam_failed",
  plugins: [
    definePlugin({
      ...manifest("failing-seams"),
      seams: () => {
        throw new Error("The failing-seams plugin cannot build its wrappers");
      },
    }),
  ],
  pluginConfig: {},
};
