import { definePlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

function identityProvider(id: string) {
  return definePlugin({
    ...manifest(id),
    seams: () => ({ identify: (next) => (request) => next(request) }),
  });
}

/** Two plugins that both provide identity; a composition has one provider. */
export const pluginIdentityConflict: BadServerCase = {
  kind: "server",
  code: "plugin_identity_conflict",
  plugins: [identityProvider("first-identity"), identityProvider("second-identity")],
  pluginConfig: {},
};
