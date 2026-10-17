import { definePlugin } from "@zenorm/plugin-sdk";
import type { WebPlugin } from "@zenorm/plugin-sdk";

import { manifest } from "./case.ts";
import type { BadWebCase } from "./case.ts";

/** A slot the shell does not have, as plain JavaScript could pass one (TypeScript refuses it). */
const slots = { "header.end": () => null, "header.start": () => null };

const unknownSlot: WebPlugin = { kind: "web", ...manifest("unknown-slot"), slots };

/** A web plugin filling a slot that does not exist. */
export const pluginSlotUnknown: BadWebCase = {
  kind: "web",
  code: "plugin_slot_unknown",
  serverPlugins: [definePlugin(manifest("unknown-slot"))],
  webPlugins: [unknownSlot],
};
