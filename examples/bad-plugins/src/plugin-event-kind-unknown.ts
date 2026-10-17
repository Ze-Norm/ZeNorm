import { definePlugin } from "@zenorm/plugin-sdk";
import type { Subscriber } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** A key that is neither `*` nor a change-feed table, as plain JavaScript could pass one. */
const subscribers: Readonly<Record<string, Subscriber>> = { waypoint_resolved: () => undefined };

/** A subscriber on an event kind the feed does not have. */
export const pluginEventKindUnknown: BadServerCase = {
  kind: "server",
  code: "plugin_event_kind_unknown",
  plugins: [definePlugin({ ...manifest("unknown-event"), subscribers: () => subscribers })],
  pluginConfig: {},
};
