import type { BadCase } from "./case.ts";
import { pluginConfigInvalid } from "./plugin-config-invalid.ts";
import { pluginConfigMissing } from "./plugin-config-missing.ts";
import { pluginConfigUnknownSection } from "./plugin-config-unknown-section.ts";
import { pluginEventKindUnknown } from "./plugin-event-kind-unknown.ts";
import { pluginExecutorDuplicate } from "./plugin-executor-duplicate.ts";
import { pluginIdDuplicate } from "./plugin-id-duplicate.ts";
import { pluginIdInvalid } from "./plugin-id-invalid.ts";
import { pluginIdentityConflict } from "./plugin-identity-conflict.ts";
import { pluginRouteCollision } from "./plugin-route-collision.ts";
import { pluginSdkIncompatible } from "./plugin-sdk-incompatible.ts";
import { pluginSeamFailed } from "./plugin-seam-failed.ts";
import { pluginSetMismatch } from "./plugin-set-mismatch.ts";
import { pluginSlotUnknown } from "./plugin-slot-unknown.ts";
import { pluginStartFailed } from "./plugin-start-failed.ts";

export type { BadCase, BadServerCase, BadWebCase } from "./case.ts";

/**
 * One bad composition per plugin startup code, in `PluginStartupCode`'s order. `executor_unknown`
 * is a config failure, not a plugin: `bad-plugins.test.ts` covers it with the example plugin.
 */
export const BAD_CASES: readonly BadCase[] = [
  pluginIdInvalid,
  pluginIdDuplicate,
  pluginSdkIncompatible,
  pluginConfigMissing,
  pluginConfigInvalid,
  pluginConfigUnknownSection,
  pluginIdentityConflict,
  pluginEventKindUnknown,
  pluginRouteCollision,
  pluginSeamFailed,
  pluginExecutorDuplicate,
  pluginStartFailed,
  pluginSlotUnknown,
  pluginSetMismatch,
];
