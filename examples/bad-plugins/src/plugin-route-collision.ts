import { definePlugin } from "@zenorm/plugin-sdk";
import { Hono } from "hono";

import { manifest } from "./case.ts";
import type { BadServerCase } from "./case.ts";

/** One router with two handlers on one method and path. */
export const pluginRouteCollision: BadServerCase = {
  kind: "server",
  code: "plugin_route_collision",
  plugins: [
    definePlugin({
      ...manifest("colliding-routes"),
      routes: () =>
        new Hono()
          .get("/status", (context) => context.text("first"))
          .get("/status", (context) => context.text("second")),
    }),
  ],
  pluginConfig: {},
};
