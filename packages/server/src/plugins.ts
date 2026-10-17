import { ChangeEntityType, err, ok } from "@zenorm/contracts";
import type {
  DeliveryExecutor,
  PluginList,
  PluginStartPhase,
  PluginStartupCode,
  Result,
  Seams,
  SeamWrappers,
  StartupError,
} from "@zenorm/contracts";
import { coreSeams, projectName, wrapSeams } from "@zenorm/core";
import type { ChangeBus } from "@zenorm/core";
import { projects } from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { SDK_VERSION } from "@zenorm/plugin-sdk";
import type {
  BoundServerContributions,
  PluginContext,
  ServerPlugin,
  Subscriber,
} from "@zenorm/plugin-sdk";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

/** A plugin id: lowercase, starting with a letter. */
const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

/** A plugin's `stop` is awaited at most this long on shutdown. */
export const PLUGIN_STOP_TIMEOUT_MS = 5000;

/** Where the plugin set writes: a line (`error` null) or an unexpected error. */
export type PluginLog = (message: string, error: unknown) => void;

/** One plugin with its contributions bound to its parsed config section. */
export interface BoundPlugin {
  readonly plugin: ServerPlugin;
  readonly contributions: BoundServerContributions;
}

/**
 * A plugin set checked before the database is opened: manifests, config sections and the executor
 * registry. `createApp` composes it with the database.
 */
export interface CheckedPlugins {
  /** `GET /plugins`: ids and versions in plugin order. */
  readonly list: PluginList;
  /** The executor `delivery.executor` names. */
  readonly executor: DeliveryExecutor;
  readonly bound: readonly BoundPlugin[];
}

/** A checked plugin set, composed with core, ready to start. */
export interface PreparedPlugins extends CheckedPlugins {
  /** What each contribution's context reads: the server's own data, at call time. */
  readonly context: PluginContext;
  /** Core's seams wrapped by each plugin's, in plugin order (core innermost). */
  readonly seams: Seams;
  /** Each plugin's raw router, mounted under `/plugins/<id>/`. */
  readonly routes: readonly { readonly id: string; readonly router: Hono }[];
  readonly subscribers: readonly {
    readonly id: string;
    readonly key: string;
    readonly subscriber: Subscriber;
  }[];
}

export interface PluginSetInput {
  readonly plugins: readonly ServerPlugin[];
  /** The instance config's `plugins` object: one section per plugin id. */
  readonly pluginConfig: Readonly<Record<string, unknown>>;
  /** The app's own executors (`"local"` in `apps/zenorm`), before any plugin's. */
  readonly executors: readonly DeliveryExecutor[];
  /** `delivery.executor`. */
  readonly executor: string;
}

function refuse(
  code: Exclude<PluginStartupCode, "plugin_start_failed">,
  message: string,
  subject: string,
): Result<never, StartupError> {
  return err({ code, message, subject });
}

/** A plugin contribution that threw or rejected: its plugin and phase in `data`. */
function startFailed(
  pluginId: string,
  phase: PluginStartPhase,
  error: unknown,
): Result<never, StartupError> {
  const reason = error instanceof Error ? error.message : String(error);
  return err({
    code: "plugin_start_failed",
    message: `Plugin ${pluginId}'s ${phase} failed: ${reason}`,
    subject: pluginId,
    data: { pluginId, phase },
  });
}

/** Whether `version` (`x.y.z`) satisfies `range`: an exact `x.y.z`, or a caret `^x.y.z`. */
export function sdkSatisfies(range: string, version: string): boolean {
  const parse = (text: string): readonly [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (match === null) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const actual = parse(version);
  if (actual === null) throw new Error(`The SDK version ${version} is not x.y.z`);
  const caret = range.startsWith("^");
  const wanted = parse(caret ? range.slice(1) : range);
  if (wanted === null) return false;
  const [major, minor, patch] = wanted;
  const [actualMajor, actualMinor, actualPatch] = actual;
  if (!caret) return major === actualMajor && minor === actualMinor && patch === actualPatch;
  // The caret's npm meaning: the leftmost non-zero part is fixed, the rest may be higher.
  if (major > 0) {
    return (
      actualMajor === major &&
      (actualMinor > minor || (actualMinor === minor && actualPatch >= patch))
    );
  }
  if (minor > 0) return actualMajor === 0 && actualMinor === minor && actualPatch >= patch;
  return actualMajor === 0 && actualMinor === 0 && actualPatch === patch;
}

/** The manifest checks: ids, their uniqueness, and the SDK range. */
function checkManifests(plugins: readonly ServerPlugin[]): Result<null, StartupError> {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!PLUGIN_ID.test(plugin.id)) {
      return refuse(
        "plugin_id_invalid",
        `Plugin id "${plugin.id}" is not [a-z][a-z0-9-]*`,
        plugin.id,
      );
    }
    if (seen.has(plugin.id)) {
      return refuse("plugin_id_duplicate", `Two plugins have the id ${plugin.id}`, plugin.id);
    }
    seen.add(plugin.id);
    if (!sdkSatisfies(plugin.sdk, SDK_VERSION)) {
      return refuse(
        "plugin_sdk_incompatible",
        `Plugin ${plugin.id} needs plugin-sdk ${plugin.sdk}; this is ${SDK_VERSION}`,
        plugin.id,
      );
    }
  }
  return ok(null);
}

/** Parses each plugin's section: none missing, none invalid, none unknown. */
function configure(
  plugins: readonly ServerPlugin[],
  pluginConfig: Readonly<Record<string, unknown>>,
): Result<readonly BoundPlugin[], StartupError> {
  const ids = new Set(plugins.map((plugin) => plugin.id));
  for (const key of Object.keys(pluginConfig)) {
    if (!ids.has(key)) {
      return refuse(
        "plugin_config_unknown_section",
        `plugins.${key} names no plugin in the composition`,
        `plugins.${key}`,
      );
    }
  }
  const bound: BoundPlugin[] = [];
  for (const plugin of plugins) {
    const present = Object.hasOwn(pluginConfig, plugin.id);
    if (plugin.configured && !present) {
      return refuse(
        "plugin_config_missing",
        `Plugin ${plugin.id} has a config schema and the config has no plugins.${plugin.id}`,
        `plugins.${plugin.id}`,
      );
    }
    if (!plugin.configured && present) {
      return refuse(
        "plugin_config_unknown_section",
        `Plugin ${plugin.id} takes no config, but the config has plugins.${plugin.id}`,
        `plugins.${plugin.id}`,
      );
    }
    const configured = plugin.configure(pluginConfig[plugin.id]);
    if (!configured.ok) {
      return refuse(
        "plugin_config_invalid",
        `plugins.${plugin.id}: ${configured.message}`,
        `plugins.${plugin.id}`,
      );
    }
    bound.push({ plugin, contributions: configured.value });
  }
  return ok(bound);
}

/** Core's seams wrapped by each plugin's in order; one identity provider at most. */
function composeSeams(
  bound: readonly BoundPlugin[],
  core: Seams,
  context: PluginContext,
): Result<Seams, StartupError> {
  const wrappers: { readonly id: string; readonly seams: SeamWrappers }[] = [];
  for (const { plugin, contributions } of bound) {
    if (contributions.seams === null) continue;
    try {
      wrappers.push({ id: plugin.id, seams: contributions.seams(context) });
    } catch (error: unknown) {
      return seamFailed(plugin.id, error);
    }
  }
  const providers = wrappers.filter((wrapper) => wrapper.seams.identify !== undefined);
  const [first, second] = providers;
  if (first !== undefined && second !== undefined) {
    return refuse(
      "plugin_identity_conflict",
      `Plugins ${first.id} and ${second.id} both provide identity; a composition has one provider`,
      second.id,
    );
  }
  let seams = core;
  for (const wrapper of wrappers) {
    try {
      seams = wrapSeams(seams, wrapper.seams);
    } catch (error: unknown) {
      return seamFailed(wrapper.id, error);
    }
  }
  return ok(seams);
}

function seamFailed(id: string, error: unknown): Result<never, StartupError> {
  const reason = error instanceof Error ? error.message : String(error);
  return refuse(
    "plugin_seam_failed",
    `Plugin ${id}'s seam wrapper threw at startup: ${reason}`,
    id,
  );
}

/**
 * Each plugin's subscribers; a key that is neither `*` nor a feed table is refused, and a throw
 * from `subscribers()` is `plugin_start_failed`.
 */
function collectSubscribers(
  bound: readonly BoundPlugin[],
  context: PluginContext,
): Result<PreparedPlugins["subscribers"], StartupError> {
  const tables: readonly string[] = ChangeEntityType.options;
  const subscribers: PreparedPlugins["subscribers"][number][] = [];
  for (const { plugin, contributions } of bound) {
    if (contributions.subscribers === null) continue;
    let keyed: Readonly<Partial<Record<string, Subscriber>>>;
    try {
      keyed = contributions.subscribers(context);
    } catch (error: unknown) {
      return startFailed(plugin.id, "subscribers", error);
    }
    for (const [key, subscriber] of Object.entries(keyed)) {
      if (key !== "*" && !tables.includes(key)) {
        return refuse(
          "plugin_event_kind_unknown",
          `Plugin ${plugin.id} subscribes to "${key}", which is neither * nor a change-feed table`,
          `${plugin.id}:${key}`,
        );
      }
      if (subscriber === undefined) continue;
      subscribers.push({ id: plugin.id, key, subscriber });
    }
  }
  return ok(subscribers);
}

/**
 * Each plugin's raw router, given the composed `identify` and `checkAccess`; two routes on one
 * method and path collide, and a throw from `routes()` is `plugin_start_failed`.
 */
function collectRoutes(
  bound: readonly BoundPlugin[],
  context: PluginContext,
  seams: Seams,
): Result<PreparedPlugins["routes"], StartupError> {
  const routes: PreparedPlugins["routes"][number][] = [];
  const routeContext = { ...context, identify: seams.identify, checkAccess: seams.checkAccess };
  for (const { plugin, contributions } of bound) {
    if (contributions.routes === null) continue;
    let router: Hono;
    try {
      router = contributions.routes(routeContext);
    } catch (error: unknown) {
      return startFailed(plugin.id, "routes", error);
    }
    const seen = new Set<string>();
    for (const route of router.routes) {
      // Hono lists middleware (`use`) as method ALL; only handlers can collide.
      if (route.method === "ALL") continue;
      const path = `/plugins/${plugin.id}${route.path === "/" ? "" : route.path}`;
      const key = `${route.method} ${path}`;
      if (seen.has(key)) {
        return refuse(
          "plugin_route_collision",
          `Plugin ${plugin.id} registers ${key} twice`,
          `${plugin.id}:${key}`,
        );
      }
      seen.add(key);
    }
    routes.push({ id: plugin.id, router });
  }
  return ok(routes);
}

/**
 * The executor registry: the app's executors, then each plugin's in plugin order. A repeated name
 * is `plugin_executor_duplicate`; `delivery.executor` must name one.
 */
function chooseExecutor(
  bound: readonly BoundPlugin[],
  executors: readonly DeliveryExecutor[],
  name: string,
): Result<DeliveryExecutor, StartupError> {
  const registry = new Map<string, DeliveryExecutor>();
  const registrations: { readonly by: string; readonly executor: DeliveryExecutor }[] = [
    ...executors.map((executor) => ({ by: "the app", executor })),
  ];
  for (const { plugin, contributions } of bound) {
    if (contributions.executors === null) continue;
    let contributed: readonly DeliveryExecutor[];
    try {
      contributed = contributions.executors();
    } catch (error: unknown) {
      return startFailed(plugin.id, "executors", error);
    }
    for (const executor of contributed) {
      registrations.push({ by: `plugin ${plugin.id}`, executor });
    }
  }
  for (const { by, executor } of registrations) {
    if (registry.has(executor.name)) {
      return refuse(
        "plugin_executor_duplicate",
        `The delivery executor "${executor.name}" is registered twice (again by ${by})`,
        executor.name,
      );
    }
    registry.set(executor.name, executor);
  }
  const chosen = registry.get(name);
  if (chosen === undefined) {
    return refuse(
      "executor_unknown",
      `delivery.executor "${name}" names no registered executor (${[...registry.keys()].join(", ")})`,
      name,
    );
  }
  return ok(chosen);
}

/**
 * The plugin set's checks that need no database, in order: manifests, config sections, the executor
 * registry. The first failure is the coded `StartupError`.
 */
export function checkPlugins(input: PluginSetInput): Result<CheckedPlugins, StartupError> {
  const manifests = checkManifests(input.plugins);
  if (!manifests.ok) return manifests;
  const bound = configure(input.plugins, input.pluginConfig);
  if (!bound.ok) return bound;
  const executor = chooseExecutor(bound.value, input.executors, input.executor);
  if (!executor.ok) return executor;
  return ok({
    list: input.plugins.map(({ id, version }) => ({ id, version })),
    executor: executor.value,
    bound: bound.value,
  });
}

/** The plugins' context over `db`: each read is made when the plugin calls it. */
function pluginContext(db: ZeNormDatabase): PluginContext {
  return {
    projectName: (projectId) => {
      const row = db
        .select({ folderPath: projects.folderPath })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get();
      return row === undefined ? null : projectName(row.folderPath);
    },
  };
}

/**
 * Composes a checked set with the database, in order: seams (around core's), subscribers, routes.
 * The first failure is the coded `StartupError`; nothing is started or subscribed.
 */
export function composePlugins(
  checked: CheckedPlugins,
  db: ZeNormDatabase,
): Result<PreparedPlugins, StartupError> {
  const context = pluginContext(db);
  const seams = composeSeams(checked.bound, coreSeams(db), context);
  if (!seams.ok) return seams;
  const subscribers = collectSubscribers(checked.bound, context);
  if (!subscribers.ok) return subscribers;
  const routes = collectRoutes(checked.bound, context, seams.value);
  if (!routes.ok) return routes;
  return ok({
    ...checked,
    context,
    seams: seams.value,
    routes: routes.value,
    subscribers: subscribers.value,
  });
}

/** Subscribes each plugin subscriber to the bus, after commit, by its table or `*`. */
export function subscribePlugins(prepared: PreparedPlugins, bus: ChangeBus): void {
  for (const { id, key, subscriber } of prepared.subscribers) {
    bus.subscribe(`plugin ${id} (${key})`, (event) => {
      if (key === "*" || event.entityType === key) subscriber(event);
    });
  }
}

/**
 * Starts each plugin in order, awaiting each, and returns the started set for `stopPlugins`. A
 * rejection is `plugin_start_failed`; the plugins already started are stopped first, in reverse
 * order.
 */
export async function startPlugins(
  prepared: PreparedPlugins,
  log: PluginLog,
): Promise<Result<readonly BoundPlugin[], StartupError>> {
  const started: BoundPlugin[] = [];
  for (const entry of prepared.bound) {
    const { start } = entry.contributions;
    if (start !== null) {
      try {
        await start({
          ...prepared.context,
          log: (line) => {
            log(`[plugin ${entry.plugin.id}] ${line}`, null);
          },
        });
      } catch (error: unknown) {
        await stopBound(started, log);
        return startFailed(entry.plugin.id, "start", error);
      }
    }
    started.push(entry);
  }
  return ok(started);
}

async function stopBound(bound: readonly BoundPlugin[], log: PluginLog): Promise<void> {
  for (const { plugin, contributions } of [...bound].reverse()) {
    const { stop } = contributions;
    if (stop === null) continue;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed out">((resolve) => {
      timer = setTimeout(() => {
        resolve("timed out");
      }, PLUGIN_STOP_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([stop().then(() => "stopped" as const), timedOut]);
      if (outcome === "timed out") {
        log(
          `Plugin ${plugin.id}'s stop did not settle within ${String(PLUGIN_STOP_TIMEOUT_MS)} ms`,
          null,
        );
      }
    } catch (error: unknown) {
      log(`Plugin ${plugin.id}'s stop failed`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Stops each started plugin in reverse order, each bounded at 5 s; a failure is logged. */
export async function stopPlugins(started: readonly BoundPlugin[], log: PluginLog): Promise<void> {
  await stopBound(started, log);
}
