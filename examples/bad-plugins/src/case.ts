import type { PluginStartupCode } from "@zenorm/contracts";
import { SDK_VERSION } from "@zenorm/plugin-sdk";
import type { ServerPlugin, WebPlugin } from "@zenorm/plugin-sdk";

/**
 * One bad composition per D16 startup code (slice 9 spec S9-19): the plugins and config sections a
 * server starts with, which `apps/zenorm-example`'s `bad-plugins.test.ts` hands `startZeNorm` and
 * expects refused with `code`.
 */
export interface BadServerCase {
  readonly kind: "server";
  readonly code: PluginStartupCode;
  readonly plugins: readonly ServerPlugin[];
  readonly pluginConfig: Readonly<Record<string, unknown>>;
}

/**
 * A bad web composition: the server starts with `serverPlugins`, and `createWebApp` with
 * `webPlugins` shows the blocking page with `code`.
 */
export interface BadWebCase {
  readonly kind: "web";
  readonly code: PluginStartupCode;
  readonly serverPlugins: readonly ServerPlugin[];
  readonly webPlugins: readonly WebPlugin[];
}

export type BadCase = BadServerCase | BadWebCase;

/** The manifest every bad plugin shares unless its case is about the manifest. */
export function manifest(id: string): { id: string; version: string; sdk: string } {
  return { id, version: "1.0.0", sdk: `^${SDK_VERSION}` };
}
