import { z } from "zod";

import type { UserId } from "./actor.ts";
import type { AccessAction, CreateProjectError, StartDeliveryError } from "./codes.ts";
import type { Result } from "./result.ts";

/**
 * The seams (CONTEXT Seam): the five named functions core calls and a plugin may wrap. Core's
 * implementations live in `packages/core/src/seams.ts`; the server composes them with the plugins'
 * wrappers (core innermost, then each plugin in order).
 */

/** What identity reads of an incoming request; a fetch `Request` is one. */
export interface SeamRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
}

/** Identity: the User a request acts as. Core: the instance's one local User. */
export type Identify = (request: SeamRequest) => UserId;

/** The access check: whether `userId` may `action` the project. Core: always allows. */
export type CheckAccess = (userId: UserId, projectId: string, action: AccessAction) => boolean;

/** The project a checkout is asked for: its id and the stored folder. */
export interface CheckoutProject {
  readonly id: string;
  readonly folderPath: string;
}

/** A checkout's coded failure: the folder to work in is not on disk. */
export type CheckoutError = Extract<CreateProjectError, { code: "project_folder_missing" }>;

/**
 * Project checkout: the folder to work in, present on disk. Core: the stored folder, or
 * `project_folder_missing` (detected, never repaired). Called where a run starts.
 */
export type Checkout = (project: CheckoutProject) => Promise<Result<string, CheckoutError>>;

/** The delivery run an executor environment is asked for. */
export interface ExecutorEnvRun {
  readonly id: string;
  readonly projectId: string;
}

/**
 * Executor credentials: the environment a delivery run's executor starts with. Core: this process's
 * environment, as today. Its result reaches no port in this slice.
 */
export type ExecutorEnv = (run: ExecutorEnvRun) => Readonly<Record<string, string | undefined>>;

/** A run start asked of admission: only delivery starts are admitted through the seam. */
export interface RunAdmissionRequest {
  readonly kind: "delivery";
  readonly projectId: string;
  readonly userId: UserId;
  readonly ticketSetId: string;
}

/** Admission's refusal: `delivery_not_admitted` with the sentence the page shows. */
export type RunAdmissionRefusal = Extract<StartDeliveryError, { code: "delivery_not_admitted" }>;

/** Run admission: admit, or refuse with a reason. Core: admits. */
export type AdmitRun = (request: RunAdmissionRequest) => Promise<Result<null, RunAdmissionRefusal>>;

/** The five seams, as core calls them. */
export interface Seams {
  readonly identify: Identify;
  readonly checkAccess: CheckAccess;
  readonly checkout: Checkout;
  readonly executorEnv: ExecutorEnv;
  readonly admitRun: AdmitRun;
}

/**
 * A plugin's wrappers: each receives the seam before it as `next` (core's, or the previous plugin's
 * wrapper) and returns the seam to call instead.
 */
export type SeamWrappers = {
  readonly [K in keyof Seams]?: (next: Seams[K]) => Seams[K];
};

/** One plugin as `GET /plugins` lists it, and as the web compares its own set. */
export const PluginSummary = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
});
export type PluginSummary = z.infer<typeof PluginSummary>;

/** `GET /plugins`: the server's plugins in composition order. */
export const PluginList = z.array(PluginSummary);
export type PluginList = z.infer<typeof PluginList>;
