import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import { checkNeedsShell, err, ok } from "@zenorm/contracts";
import type {
  ActiveRun,
  Actor,
  CreateProjectError,
  CreateProjectInput,
  InspectProjectError,
  Project,
  ProjectInspection,
  ProjectNotFoundError,
  Result,
  SaveProjectSettingsError,
  SaveProjectSettingsInput,
  StartDeliveryBlocker,
} from "@zenorm/contracts";
import {
  deliveryRuns,
  isUniqueConstraintViolation,
  projects,
  specRevisions,
  ticketSets,
} from "@zenorm/db";
import type { ZeNormDatabase } from "@zenorm/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import {
  branchCommit,
  headBranch,
  headHasCommit,
  isBranchName,
  localBranchExists,
  repositoryTopLevel,
} from "./git.ts";
import { latestOf, readSpec, readSpecRevisions } from "./specs.ts";
import { write } from "./writes.ts";

type Reader = Pick<ZeNormDatabase, "select">;

/** A stored project: every `Project` field but the derived `name`, `folder` and blockers. */
export type ProjectRow = typeof projects.$inferSelect;

/** True when `path` is an existing directory; any failure other than absence is thrown. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return false;
      }
    }
    throw error;
  }
}

/** A project's name: its folder's last path segment (spec D3). */
export function projectName(folderPath: string): string {
  const name = basename(folderPath);
  if (name === "") {
    throw new Error(`The folder ${folderPath} has no last path segment to name its project`);
  }
  return name;
}

/**
 * The project's one run with no end (`interrupted` included; slice 8 D2, ruling 5), or null: the
 * map that wrote the revision its ticket set was cut from, and its spec's number and latest title.
 */
export function readActiveRun(db: Reader, projectId: string): ActiveRun | null {
  const active = db
    .select({
      runId: deliveryRuns.id,
      specificationId: deliveryRuns.specificationId,
      mapId: specRevisions.mapId,
    })
    .from(deliveryRuns)
    .innerJoin(ticketSets, eq(ticketSets.id, deliveryRuns.ticketSetId))
    .innerJoin(specRevisions, eq(specRevisions.id, ticketSets.specRevisionId))
    .where(and(eq(deliveryRuns.projectId, projectId), isNull(deliveryRuns.endedAt)))
    .all();
  const [run, ...others] = active;
  if (run === undefined) {
    return null;
  }
  if (others.length > 0) {
    throw new Error(`Project ${projectId} has ${String(active.length)} active delivery runs`);
  }
  return {
    runId: run.runId,
    mapId: run.mapId,
    specNumber: readSpec(db, run.specificationId).number,
    specTitle: latestOf(readSpecRevisions(db, run.specificationId)).content.title,
  };
}

/**
 * What keeps `delivery.start` from starting a run in the project, every one that applies, in its
 * refusal order (S8-3, the demo's `deliveryBlockers`): a folder that is not a directory (alone:
 * nothing else can be read), a base branch with no commit, no required checks, no saved repair
 * limit, an active run. The one check `delivery.start` and every project read share.
 */
export async function startDeliveryBlockers(
  project: Pick<ProjectRow, "folderPath" | "baseBranch" | "requiredChecks" | "repairLimit">,
  activeRun: ActiveRun | null,
): Promise<StartDeliveryBlocker[]> {
  if (!(await isDirectory(project.folderPath))) {
    return ["project_folder_missing"];
  }
  const blockers: StartDeliveryBlocker[] = [];
  // One git call per project per read (every page's live refetch reads every project): the
  // stored base branch is a branch name already, checked by `isBranchName` on every write.
  if ((await branchCommit(project.folderPath, project.baseBranch)) === null) {
    blockers.push("project_branch_missing");
  }
  if (project.requiredChecks.length === 0) {
    blockers.push("project_checks_missing");
  }
  if (project.repairLimit === null) {
    blockers.push("project_repair_limit_missing");
  }
  if (activeRun !== null) {
    blockers.push("delivery_in_progress");
  }
  return blockers;
}

/**
 * The stored project with its derived name, folder, active run and blockers, read from the
 * database, disk and git now.
 */
export async function toProject(db: Reader, row: ProjectRow): Promise<Project> {
  const activeRun = readActiveRun(db, row.id);
  const blockers = await startDeliveryBlockers(row, activeRun);
  return {
    ...row,
    name: projectName(row.folderPath),
    folder: blockers.includes("project_folder_missing") ? "missing" : "present",
    startDeliveryBlockers: blockers,
    activeRun,
  };
}

/**
 * The refusal for a folder's realpath against the stored projects (spec D3 steps 2–3, first
 * wins): already added, or inside a stored project's repository (its repository's top level is
 * that project's folder); else null. A nested repository, such as a submodule, is its own top
 * level, so it may be added inside a project, and a project may hold one.
 */
function containmentRefusal(
  folder: string,
  topLevel: string | null,
  stored: readonly ProjectRow[],
): InspectProjectError | null {
  if (stored.some((project) => project.folderPath === folder)) {
    return {
      code: "project_already_added",
      message: `A project for ${folder} already exists`,
      data: { folderPath: folder },
    };
  }
  const outer = stored.find((project) => project.folderPath === topLevel);
  if (outer !== undefined) {
    return {
      code: "project_inside_project",
      message: `${folder} is inside the project folder ${outer.folderPath}`,
      data: { folderPath: folder, projectId: outer.id, projectFolderPath: outer.folderPath },
    };
  }
  return null;
}

function readProjectRows(db: Pick<ZeNormDatabase, "select">): ProjectRow[] {
  return db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id)).all();
}

/**
 * Checks a folder before it is added (spec D3). Refuses in order, first wins: not a directory,
 * already a project, inside a project's repository, not its repository's top level.
 * Otherwise returns its realpath, name, the branch `HEAD` names (null when detached) and whether
 * `HEAD` has a commit. Writes nothing.
 */
export async function inspectProject(
  db: ZeNormDatabase,
  folderPath: string,
): Promise<Result<ProjectInspection, InspectProjectError>> {
  if (!(await isDirectory(folderPath))) {
    return err({
      code: "project_folder_missing",
      message: `${folderPath} does not exist or is not a directory`,
      data: { folderPath },
    });
  }

  const folder = await realpath(folderPath);
  const reportedTopLevel = await repositoryTopLevel(folder);
  const topLevel = reportedTopLevel === null ? null : await realpath(reportedTopLevel);
  const contained = containmentRefusal(folder, topLevel, readProjectRows(db));
  if (contained !== null) {
    return err(contained);
  }

  if (topLevel !== folder) {
    return err({
      code: "project_not_git",
      message:
        topLevel === null
          ? `${folderPath} is not in a git repository`
          : `${folderPath} is inside the git repository at ${topLevel}; add that folder instead`,
      data: { folderPath, repositoryTopLevel: topLevel },
    });
  }

  return ok({
    folderPath: folder,
    name: projectName(folder),
    detectedBaseBranch: await headBranch(folder),
    hasCommit: await headHasCommit(folder),
  });
}

/**
 * Adds a Project (spec D3): re-runs the inspection, then the branch rule (a malformed name is
 * `project_branch_invalid`; with a commit, a branch with none is `project_branch_missing`; with
 * no commit, any valid name is accepted), then re-checks containment and inserts in one write
 * transaction. Writes nothing on refusal.
 */
export async function createProject(
  actor: Actor,
  db: ZeNormDatabase,
  input: CreateProjectInput,
): Promise<Result<Project, CreateProjectError>> {
  const { baseBranch } = input;
  const inspected = await inspectProject(db, input.folderPath);
  if (!inspected.ok) {
    return inspected;
  }
  const { folderPath: folder, hasCommit } = inspected.value;

  if (!(await isBranchName(folder, baseBranch))) {
    return err({
      code: "project_branch_invalid",
      message: `${baseBranch} is not a valid branch name`,
      data: { baseBranch },
    });
  }
  if (hasCommit && !(await localBranchExists(folder, baseBranch))) {
    return err({
      code: "project_branch_missing",
      message: `Local branch ${baseBranch} does not exist or has no commits`,
      data: { baseBranch },
    });
  }

  const row: ProjectRow = {
    id: uuidv7(),
    folderPath: folder,
    baseBranch,
    requiredChecks: [],
    repairLimit: null,
    fixCommands: [],
    createdAt: new Date().toISOString(),
  };
  let refusal: InspectProjectError | null;
  try {
    refusal = write(db, actor, (tx) => {
      // The inspection found the folder to be its repository's top level.
      const contained = containmentRefusal(folder, folder, readProjectRows(tx));
      if (contained !== null) {
        return contained;
      }
      tx.insert(projects).values(row).run();
      return null;
    });
  } catch (error: unknown) {
    if (isUniqueConstraintViolation(error)) {
      return err({
        code: "project_already_added",
        message: `A project for ${folder} already exists`,
        data: { folderPath: folder },
      });
    }
    throw error;
  }
  if (refusal !== null) {
    return err(refusal);
  }
  return ok(await toProject(db, row));
}

/** Every Project, oldest first, with its derived fields. */
export async function listProjects(db: ZeNormDatabase): Promise<Project[]> {
  return await Promise.all(readProjectRows(db).map((row) => toProject(db, row)));
}

/** The Project with this id, with its derived fields, or `project_not_found`. */
export async function getProject(
  db: ZeNormDatabase,
  projectId: string,
): Promise<Result<Project, ProjectNotFoundError>> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (row === undefined) {
    return err({
      code: "project_not_found",
      message: `No project with id ${projectId}`,
      data: { projectId },
    });
  }
  return ok(await toProject(db, row));
}

/**
 * Saves a project's settings (S8-2): the base branch, the required checks, the repair limit and
 * the fix commands, in one write. A branch name `git check-ref-format --branch` refuses is
 * `project_branch_invalid`, a check that needs a shell (quotes, `&&`, pipes, redirects…) is
 * `project_check_invalid` (L197 item 9), and a fix command that needs one is
 * `project_fix_command_invalid`; each writes nothing. A missing folder or a branch without commits
 * does not refuse a save (they are start blockers), and a running run keeps what it pinned at its
 * start.
 */
export async function saveProjectSettings(
  actor: Actor,
  db: ZeNormDatabase,
  input: SaveProjectSettingsInput,
): Promise<Result<Project, SaveProjectSettingsError>> {
  const { projectId, baseBranch, requiredChecks, repairLimit, fixCommands } = input;
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (row === undefined) {
    return err({
      code: "project_not_found",
      message: `No project with id ${projectId}`,
      data: { projectId },
    });
  }
  // The name is checked in the project folder; with the folder gone, from the file system root,
  // where `check-ref-format --branch` still checks a plain name.
  const cwd = (await isDirectory(row.folderPath)) ? row.folderPath : "/";
  if (!(await isBranchName(cwd, baseBranch))) {
    return err({
      code: "project_branch_invalid",
      message: `${baseBranch} is not a valid branch name`,
      data: { baseBranch },
    });
  }
  const needsShell = requiredChecks.find((command) => checkNeedsShell(command));
  if (needsShell !== undefined) {
    return err({
      code: "project_check_invalid",
      message: `${needsShell} needs a shell; checks run without one`,
      data: { command: needsShell },
    });
  }
  const fixNeedsShell = fixCommands.find((command) => checkNeedsShell(command));
  if (fixNeedsShell !== undefined) {
    return err({
      code: "project_fix_command_invalid",
      message: `${fixNeedsShell} needs a shell; fix commands run without one`,
      data: { command: fixNeedsShell },
    });
  }
  write(db, actor, (tx) =>
    tx
      .update(projects)
      .set({ baseBranch, requiredChecks, repairLimit, fixCommands })
      .where(eq(projects.id, projectId))
      .run(),
  );
  return getProject(db, projectId);
}
