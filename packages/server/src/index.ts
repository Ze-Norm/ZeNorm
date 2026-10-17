export { createApp } from "./app.ts";
export type { AppOptions, Log, ZeNormApp } from "./app.ts";
// The app entry checks its plugin set before it opens the database.
export { checkPlugins } from "./plugins.ts";
export type { CheckedPlugins } from "./plugins.ts";
// The composing app names its plugins' type through the server, which takes them.
export type { ServerPlugin } from "@zenorm/plugin-sdk";
// `apps/zenorm` may not import core: it creates the bus through the server.
export { createChangeBus } from "@zenorm/core";
export type { ChangeBus } from "@zenorm/core";
