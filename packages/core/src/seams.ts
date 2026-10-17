import { err, ok } from "@zenorm/contracts";
import type { Seams, SeamWrappers } from "@zenorm/contracts";
import type { ZeNormDatabase } from "@zenorm/db";

import { isDirectory } from "./project.ts";
import { localUser } from "./writes.ts";

/**
 * Core's behaviour behind each seam: the instance's one local User, an access check
 * that allows, the stored project folder, this process's environment, and an admission that
 * admits. The server wraps these with the plugins' wrappers and sets the result with `setSeams`.
 */
export function coreSeams(db: ZeNormDatabase): Seams {
  return {
    identify: () => localUser(db).id,
    checkAccess: () => true,
    checkout: async (project) => {
      if (await isDirectory(project.folderPath)) {
        return ok(project.folderPath);
      }
      return err({
        code: "project_folder_missing",
        message: `${project.folderPath} does not exist or is not a directory`,
        data: { folderPath: project.folderPath },
      });
    },
    executorEnv: () => ({ ...process.env }),
    admitRun: () => Promise.resolve(ok(null)),
  };
}

/**
 * `seams` with one plugin's wrappers applied: each wrapped seam receives the one before it as
 * `next`. The server applies each plugin's in order over core's, so core is innermost.
 */
export function wrapSeams(seams: Seams, wrappers: SeamWrappers): Seams {
  return {
    identify: wrappers.identify === undefined ? seams.identify : wrappers.identify(seams.identify),
    checkAccess:
      wrappers.checkAccess === undefined
        ? seams.checkAccess
        : wrappers.checkAccess(seams.checkAccess),
    checkout: wrappers.checkout === undefined ? seams.checkout : wrappers.checkout(seams.checkout),
    executorEnv:
      wrappers.executorEnv === undefined
        ? seams.executorEnv
        : wrappers.executorEnv(seams.executorEnv),
    admitRun: wrappers.admitRun === undefined ? seams.admitRun : wrappers.admitRun(seams.admitRun),
  };
}

const installed = new WeakMap<ZeNormDatabase, Seams>();

/** Makes `seams` the ones core calls for `db`: run starts read checkout, admission and env here. */
export function setSeams(db: ZeNormDatabase, seams: Seams): void {
  installed.set(db, seams);
}

/** The seams set for `db`; none set is a programmer error, never core's behaviour by default. */
export function seamsOf(db: ZeNormDatabase): Seams {
  const seams = installed.get(db);
  if (seams === undefined) {
    throw new Error("No seams are set for this database: call setSeams before starting a run");
  }
  return seams;
}
