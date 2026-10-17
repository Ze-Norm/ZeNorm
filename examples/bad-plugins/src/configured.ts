import { definePlugin } from "@zenorm/plugin-sdk";
import type { ServerPlugin } from "@zenorm/plugin-sdk";
import { z } from "zod";

import { manifest } from "./case.ts";

/** A plugin whose `plugins.configured` section must be `{ limit: number }`. */
export function configuredPlugin(): ServerPlugin {
  return definePlugin({
    ...manifest("configured"),
    config: z.strictObject({ limit: z.int().min(1) }),
  });
}
