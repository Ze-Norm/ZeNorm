/**
 * The plugin SDK (slice 9 spec S9-18, D16, S9-22): the only ZeNorm API a plugin imports, beside
 * `@zenorm/contracts`. A plugin is one package with a server entry (`definePlugin`) and, when it
 * renders anything, a web entry (`defineWebPlugin`). The app composes both in code:
 * `createApp({ plugins })` and `createWebApp({ plugins })`.
 */
import type {
  ChangeEntityType,
  ChangeEvent,
  CheckAccess,
  DeliveryExecutor,
  Identify,
  Seams,
  SeamWrappers,
  Stage,
} from "@zenorm/contracts";
import type { Hono } from "hono";
import type { ComponentType } from "react";

export { err, gitIdentityEnv, ok, ticketBranchName } from "@zenorm/contracts";
export {
  DeliveryAgentErrorCode,
  ImplementEvent,
  ImplementRequest,
  PullRequestRequest,
  ReviewRequest,
  Verdict,
} from "@zenorm/contracts";
export type {
  AdmitRun,
  DeliveryAgentError,
  GitIdentity,
  Result,
  ChangeEntityType,
  ChangeEvent,
  CheckAccess,
  Checkout,
  CheckoutProject,
  DeliveryExecutor,
  ExecutorEnv,
  ExecutorEnvRun,
  Identify,
  ImplementTicketSet,
  ReviewDelivery,
  RunAdmissionRefusal,
  RunAdmissionRequest,
  SeamRequest,
  Seams,
  SeamWrappers,
  WritePullRequest,
} from "@zenorm/contracts";

/** The SDK's own version; a plugin's `sdk` range must admit it (`plugin_sdk_incompatible`). */
export const SDK_VERSION = "0.1.0";

/**
 * A plugin's config schema: a Zod schema (or anything with Zod's `safeParse`). It parses the
 * plugin's `plugins.<id>` section of the instance config at startup, and may carry no defaults.
 */
export interface ConfigSchema<Config> {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: Config }
    | { readonly success: false; readonly error: { readonly message: string } };
}

/** What both entries declare, and must agree on (the web compares `id` and `version`). */
export interface PluginManifest {
  /** `[a-z][a-z0-9-]*`, unique in the composition. */
  readonly id: string;
  /** The plugin's own semver. */
  readonly version: string;
  /** The range of `SDK_VERSION` it was built against: `^x.y.z` or an exact `x.y.z`. */
  readonly sdk: string;
}

/** A subscriber key: one change-feed table, or `*` for every row (SDK §3.4). */
export type SubscriberKey = ChangeEntityType | "*";

/**
 * Called after the writing transaction commits, with each committed feed row. It gets no
 * transaction and returns nothing; a throw is logged with the plugin id and fails no write.
 * Delivery is at most once.
 */
export type Subscriber = (event: ChangeEvent) => void;

/**
 * What a plugin's `seams` and `subscribers` receive beside its config (CR9b-1): reads of the
 * server's own data, made at call time.
 */
export interface PluginContext {
  /**
   * The name of the project with this id (its folder's last path segment), read from the database
   * at call time; `null` when no project has the id.
   */
  readonly projectName: (projectId: string) => string | null;
}

/** What `routes` receives (CR9b-13): the composed seams, so a raw route can check its request. */
export interface PluginRouteContext extends PluginContext {
  /** The composition's identity seam: the User a request is from. */
  readonly identify: Identify;
  /** The composition's access seam, every plugin's wrapper included. */
  readonly checkAccess: CheckAccess;
}

/** What `start` receives. */
export interface PluginStartContext extends PluginContext {
  /** One line to the app's log, prefixed with the plugin id. */
  readonly log: (line: string) => void;
}

/** A plugin's server contributions, each given the parsed config section. */
export interface ServerPluginContributions<Config> {
  /** Wrappers on the seams; identity may have one provider in the composition. */
  readonly seams?: (config: Config, context: PluginContext) => SeamWrappers;
  /** Subscribers by feed table, or `*`. */
  readonly subscribers?: (
    config: Config,
    context: PluginContext,
  ) => Readonly<Partial<Record<SubscriberKey, Subscriber>>>;
  /**
   * One raw Hono router, mounted under `/plugins/<id>/`; it authenticates itself, through the
   * context's `identify` and `checkAccess`.
   */
  readonly routes?: (config: Config, context: PluginRouteContext) => Hono;
  /**
   * Delivery executors (S9-22), called once at startup; `delivery.executor` picks one by name.
   * They get no context: the registry is checked before the database is opened (QA-1).
   */
  readonly executors?: (config: Config) => readonly DeliveryExecutor[];
  /** Awaited after migrations and before the server listens; a rejection fails startup. */
  readonly start?: (config: Config, context: PluginStartContext) => Promise<void>;
  /** Awaited on shutdown after the runs stop, in reverse plugin order, bounded at 5 s. */
  readonly stop?: () => Promise<void>;
}

/** `definePlugin`'s input with a config schema: every contribution gets the parsed section. */
export type ServerPluginDefinition<Config> = PluginManifest & {
  readonly config: ConfigSchema<Config>;
} & ServerPluginContributions<Config>;

/** `definePlugin`'s input with no config schema: the plugin takes no section. */
export type ServerPluginDefinitionWithoutConfig = PluginManifest &
  ServerPluginContributions<undefined>;

/** A plugin's contributions bound to its parsed config; the server calls each at startup. */
export interface BoundServerContributions {
  readonly seams: ((context: PluginContext) => SeamWrappers) | null;
  readonly subscribers:
    ((context: PluginContext) => Readonly<Partial<Record<string, Subscriber>>>) | null;
  readonly routes: ((context: PluginRouteContext) => Hono) | null;
  readonly executors: (() => readonly DeliveryExecutor[]) | null;
  readonly start: ((context: PluginStartContext) => Promise<void>) | null;
  readonly stop: (() => Promise<void>) | null;
}

/** Parsing a config section: the bound contributions, or the schema's message. */
export type ConfigureResult =
  | { readonly ok: true; readonly value: BoundServerContributions }
  | { readonly ok: false; readonly message: string };

/** A server plugin, as `createApp({ plugins })` takes it. Build it with `definePlugin`. */
export interface ServerPlugin extends PluginManifest {
  readonly kind: "server";
  /** Whether the plugin has a config schema, so it needs a `plugins.<id>` section. */
  readonly configured: boolean;
  /** Parses `section` with the plugin's schema (none: `section` is not read) and binds to it. */
  readonly configure: (section: unknown) => ConfigureResult;
}

function bind<Config>(
  contributions: ServerPluginContributions<Config>,
  config: Config,
): BoundServerContributions {
  const { seams, subscribers, routes, executors, start, stop } = contributions;
  return {
    seams: seams === undefined ? null : (context) => seams(config, context),
    subscribers: subscribers === undefined ? null : (context) => subscribers(config, context),
    routes: routes === undefined ? null : (context) => routes(config, context),
    executors: executors === undefined ? null : () => executors(config),
    start: start === undefined ? null : (context) => start(config, context),
    stop: stop === undefined ? null : () => stop(),
  };
}

/** The server entry of a plugin (SDK §2), with a config schema. */
export function definePlugin<Config>(definition: ServerPluginDefinition<Config>): ServerPlugin;
/** The server entry of a plugin (SDK §2) that takes no config section. */
export function definePlugin(definition: ServerPluginDefinitionWithoutConfig): ServerPlugin;
export function definePlugin<Config>(
  definition: ServerPluginDefinition<Config> | ServerPluginDefinitionWithoutConfig,
): ServerPlugin {
  const { id, version, sdk } = definition;
  if ("config" in definition) {
    const schema = definition.config;
    return {
      kind: "server",
      id,
      version,
      sdk,
      configured: true,
      configure: (section) => {
        const parsed = schema.safeParse(section);
        if (!parsed.success) {
          return { ok: false, message: parsed.error.message };
        }
        return { ok: true, value: bind(definition, parsed.data) };
      },
    };
  }
  return {
    kind: "server",
    id,
    version,
    sdk,
    configured: false,
    configure: () => ({ ok: true, value: bind(definition, undefined) }),
  };
}

/** The slots a web plugin renders into (SDK §3.6; D16 keeps three), with each slot's props. */
export interface SlotProps {
  /** The end of the top bar; `projectId` is the project on screen, if any. */
  readonly "header.end": { readonly projectId: string | null };
  /** A section of the project page, below its maps and specs. */
  readonly "project.page.sections": { readonly projectId: string };
  /** The top of the map workspace's right column, on every stage. */
  readonly "map.workspace.aside": {
    readonly projectId: string;
    readonly mapId: string;
    readonly stage: Stage;
  };
}

export type SlotName = keyof SlotProps;

/** Every slot name, in the order the shell's pages are listed above. */
export const SLOT_NAMES: readonly SlotName[] = [
  "header.end",
  "project.page.sections",
  "map.workspace.aside",
];

/** A web plugin's components, one per slot it renders into. */
export type SlotComponents = {
  readonly [S in SlotName]?: ComponentType<SlotProps[S]>;
};

/** The web entry of a plugin (SDK §2): its manifest and slot components. */
export interface WebPlugin extends PluginManifest {
  readonly kind: "web";
  readonly slots: SlotComponents;
}

/** Builds a web plugin. An unknown slot name is a TypeScript error and `plugin_slot_unknown`. */
export function defineWebPlugin(
  definition: PluginManifest & { readonly slots: SlotComponents },
): WebPlugin {
  return {
    kind: "web",
    id: definition.id,
    version: definition.version,
    sdk: definition.sdk,
    slots: definition.slots,
  };
}

/** Seam names, for wrappers and the startup checks. */
export const SEAM_NAMES: readonly (keyof Seams)[] = [
  "identify",
  "checkAccess",
  "checkout",
  "executorEnv",
  "admitRun",
];
