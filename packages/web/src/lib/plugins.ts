import { err, ok, PluginList } from "@zenorm/contracts";
import type { CodedError, PluginSummary, Result } from "@zenorm/contracts";
import { SLOT_NAMES } from "@zenorm/plugin-sdk";
import type { PluginManifest, SlotName, WebPlugin } from "@zenorm/plugin-sdk";

/** A web plugin's slot key that is not one of the SDK's slots (D16). */
export type PluginSlotUnknownError = CodedError<"plugin_slot_unknown"> & {
  readonly data: { readonly pluginId: string; readonly slot: string };
};

/** The web's plugins and the server's differ, by id, version or order (S9-18, D16). */
export type PluginSetMismatchError = CodedError<"plugin_set_mismatch"> & {
  readonly data: { readonly web: PluginSummary[]; readonly server: PluginSummary[] };
};

/** `GET /plugins` failed or answered something that is not a plugin list. */
export type PluginListUnreadableError = CodedError<"plugin_list_unreadable">;

/** Why the web refuses to render its plugins: a blocking page names the code. */
export type WebPluginError =
  PluginSlotUnknownError | PluginSetMismatchError | PluginListUnreadableError;

function isSlotName(key: string): key is SlotName {
  return SLOT_NAMES.some((name) => name === key);
}

/**
 * The first slot key, in plugin order, that names no SDK slot. TypeScript refuses one at
 * `defineWebPlugin`; this catches a plugin built outside the type check (D16).
 */
export function checkSlotNames(
  plugins: readonly WebPlugin[],
): Result<null, PluginSlotUnknownError> {
  for (const plugin of plugins) {
    for (const slot of Object.keys(plugin.slots)) {
      if (!isSlotName(slot)) {
        return err({
          code: "plugin_slot_unknown",
          message: `Plugin ${plugin.id} renders into ${slot}, which is not a slot. The slots are ${SLOT_NAMES.join(", ")}.`,
          data: { pluginId: plugin.id, slot },
        });
      }
    }
  }
  return ok(null);
}

function summaryOf(plugin: PluginManifest): PluginSummary {
  return { id: plugin.id, version: plugin.version };
}

function describe(list: readonly PluginSummary[]): string {
  return list.length === 0
    ? "no plugins"
    : list.map((plugin) => `${plugin.id}@${plugin.version}`).join(", ");
}

/**
 * Compares the server's plugin list (`GET /plugins`, composition order) with the web's own: the
 * same ids with the same versions in the same order, since both sides apply plugins in that order
 * (S9-18). Anything else is `plugin_set_mismatch`.
 */
export function comparePluginSets(
  server: PluginList,
  web: readonly PluginManifest[],
): Result<null, PluginSetMismatchError> {
  const own = web.map(summaryOf);
  const same =
    own.length === server.length &&
    own.every((plugin, index) => {
      const served = server[index];
      return plugin.id === served?.id && plugin.version === served.version;
    });
  if (same) {
    return ok(null);
  }
  return err({
    code: "plugin_set_mismatch",
    message: `The server runs ${describe(server)}; this page was built with ${describe(own)}.`,
    data: { web: own, server },
  });
}

/** Parses a `GET /plugins` body with the contract's `PluginList`. */
export function parsePluginList(body: unknown): Result<PluginList, PluginListUnreadableError> {
  const parsed = PluginList.safeParse(body);
  if (!parsed.success) {
    return err({
      code: "plugin_list_unreadable",
      message: `GET /plugins answered a body that is not a plugin list: ${parsed.error.message}`,
    });
  }
  return ok(parsed.data);
}

/** Fetches `GET /plugins`; a failed request or a non-2xx status is `plugin_list_unreadable`. */
export async function fetchPluginList(
  fetchList: () => Promise<Response>,
): Promise<Result<PluginList, PluginListUnreadableError>> {
  let response: Response;
  try {
    response = await fetchList();
  } catch (error) {
    return err({
      code: "plugin_list_unreadable",
      message: `GET /plugins failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!response.ok) {
    return err({
      code: "plugin_list_unreadable",
      message: `GET /plugins answered ${String(response.status)}.`,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return err({
      code: "plugin_list_unreadable",
      message: `GET /plugins answered a body that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return parsePluginList(body);
}

/**
 * The web's plugin gate, run before anything renders: the slot keys, then the server's list
 * against the web's own (D16).
 */
export async function checkWebPlugins(
  plugins: readonly WebPlugin[],
  fetchList: () => Promise<Response>,
): Promise<Result<null, WebPluginError>> {
  const slots = checkSlotNames(plugins);
  if (!slots.ok) {
    return slots;
  }
  const list = await fetchPluginList(fetchList);
  if (!list.ok) {
    return list;
  }
  return comparePluginSets(list.value, plugins);
}
