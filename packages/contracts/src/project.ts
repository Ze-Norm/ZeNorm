import { z } from "zod";

/**
 * A project's name: its folder's last path segment, derived on read and never stored. No length
 * limit: the file system bounds it, and a limit here would fail every read of a long-named folder.
 */
export const ProjectName = z.string().trim().min(1);

/** An absolute POSIX path. Checked without `node:path` because the browser imports this package. */
export const AbsolutePath = z.string().refine((path) => path.startsWith("/"), {
  message: "Must be an absolute path",
});

export const BaseBranch = z.string().min(1);

export const CHECK_COMMAND_MAX_LENGTH = 500;
export const DELIVERY_CHECKS_MAX_COUNT = 10;

/**
 * One check command as the person typed it on one line of Project settings. It is split on
 * whitespace and run without a shell, so a newline is refused rather than read as two commands.
 */
export const CheckCommand = z
  .string()
  .trim()
  .min(1)
  .max(CHECK_COMMAND_MAX_LENGTH)
  .regex(/^[^\r\n]*$/);
export type CheckCommand = z.infer<typeof CheckCommand>;

/**
 * Whether a check command needs a shell (L197 item 9): a quote, a backtick, `$`, `;`, `&`, `|`,
 * `<`, `>` or `\\`. Checks run without one, so such a command can never pass; Project settings
 * refuses it with `project_check_invalid`. `CheckCommand` stays as it is: stored runs' checks
 * parse through it.
 */
export function checkNeedsShell(command: string): boolean {
  return /['"`$;&|<>\\]/.test(command);
}

/**
 * A project's required checks (slice 8 S8-2), in the order they run: 0–10 unique commands. Empty
 * until saved; Start delivery is blocked while it is empty.
 */
export const ProjectChecks = z
  .array(CheckCommand)
  .max(DELIVERY_CHECKS_MAX_COUNT)
  .refine((checks) => new Set(checks).size === checks.length, { message: "Duplicate check" });
export type ProjectChecks = z.infer<typeof ProjectChecks>;

export const REPAIR_LIMIT_MAX = 10;

/**
 * How many times a run hands failing checks back to its executor to fix: a whole number from 0
 * (no repair) to 10. A project has none (null) until a person saves one; Start delivery is
 * blocked while it is null.
 */
export const RepairLimit = z.int().min(0).max(REPAIR_LIMIT_MAX);
export type RepairLimit = z.infer<typeof RepairLimit>;

/**
 * A project's fix commands, such as `pnpm format`: 0–10 unique commands under the same rules as
 * the required checks (a command needing a shell is refused with `project_fix_command_invalid`).
 * Empty until saved.
 */
export const ProjectFixCommands = z
  .array(CheckCommand)
  .max(DELIVERY_CHECKS_MAX_COUNT)
  .refine((commands) => new Set(commands).size === commands.length, {
    message: "Duplicate fix command",
  });
export type ProjectFixCommands = z.infer<typeof ProjectFixCommands>;

export const InspectProjectInput = z.strictObject({
  folderPath: AbsolutePath,
});
export type InspectProjectInput = z.infer<typeof InspectProjectInput>;

/** What `project.inspect` found in a folder that may be added (spec D3). */
export const ProjectInspection = z.strictObject({
  /** The folder's realpath, its repository's top level. */
  folderPath: AbsolutePath,
  name: ProjectName,
  /** The branch `HEAD` names, even before the first commit; null for a detached `HEAD`. */
  detectedBaseBranch: BaseBranch.nullable(),
  /** Whether `HEAD` resolves to a commit. */
  hasCommit: z.boolean(),
});
export type ProjectInspection = z.infer<typeof ProjectInspection>;

export const CreateProjectInput = z.strictObject({
  folderPath: AbsolutePath,
  baseBranch: BaseBranch,
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** Whether the project's folder is a directory, derived on every read. */
export const ProjectFolder = z.enum(["present", "missing"]);
export type ProjectFolder = z.infer<typeof ProjectFolder>;

/**
 * What keeps `delivery.start` from starting a run in this project, derived on every read, in
 * `delivery.start`'s refusal order (the demo's `deliveryBlockers`).
 */
export const StartDeliveryBlocker = z.enum([
  "project_folder_missing",
  "project_branch_missing",
  "project_checks_missing",
  "project_repair_limit_missing",
  "delivery_in_progress",
]);
export type StartDeliveryBlocker = z.infer<typeof StartDeliveryBlocker>;

/**
 * The project's one run with no end (`interrupted` included; slice 8 D2): `mapId` is the map that
 * wrote the revision the run's ticket set was cut from, `specTitle` the spec's latest revision's
 * title.
 */
export const ActiveRun = z.strictObject({
  runId: z.uuid({ version: "v7" }),
  mapId: z.uuid({ version: "v7" }),
  specNumber: z.int().min(1),
  specTitle: z.string().min(1),
});
export type ActiveRun = z.infer<typeof ActiveRun>;

export const Project = z.strictObject({
  id: z.uuid({ version: "v7" }),
  name: ProjectName,
  /** The repository's top level as `realpath` resolved it when the project was added. */
  folderPath: AbsolutePath,
  baseBranch: BaseBranch,
  /** The checks every run pins at its start, in order; empty until saved (S8-2). */
  requiredChecks: ProjectChecks,
  /** The repair limit every run pins at its start; null until saved, which blocks delivery. */
  repairLimit: RepairLimit.nullable(),
  /** The commands delivery sessions may run to fix work, in order; empty until saved. */
  fixCommands: ProjectFixCommands,
  /** ISO 8601 UTC. */
  createdAt: z.iso.datetime(),
  folder: ProjectFolder,
  /**
   * Every blocker that applies, in `delivery.start`'s refusal order; only `project_folder_missing`
   * when the folder is gone; `delivery_in_progress` exactly when `activeRun` is not null. Empty
   * when a run may start.
   */
  startDeliveryBlockers: z.array(StartDeliveryBlocker),
  /** The project's active run, or null when none (one per project, L98). */
  activeRun: ActiveRun.nullable(),
});
export type Project = z.infer<typeof Project>;

/**
 * `project.saveSettings` (S8-2): the base branch, the required checks (empty allowed), the repair
 * limit (required) and the fix commands (empty allowed).
 */
export const SaveProjectSettingsInput = z.strictObject({
  projectId: z.uuid({ version: "v7" }),
  baseBranch: BaseBranch,
  requiredChecks: ProjectChecks,
  repairLimit: RepairLimit,
  fixCommands: ProjectFixCommands,
});
export type SaveProjectSettingsInput = z.infer<typeof SaveProjectSettingsInput>;
