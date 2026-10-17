import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** git ran and exited with this status; any other failure (git missing, not executable) is thrown. */
export type GitOutcome =
  | { readonly exitCode: 0; readonly stdout: string }
  | { readonly exitCode: number; readonly stderr: string };

function isExitFailure(error: unknown): error is Error & { code: number; stderr: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number" &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}

/** git's messages in the C locale, so the not-a-repository message can be recognised. */
const GIT_ENV = { ...process.env, LC_ALL: "C" };

/**
 * Runs git in `cwd` without a shell, in the C locale. Output passes through `execFile`'s 1 MiB
 * buffer, so a command whose output can be large (a diff) writes it to a file instead.
 */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
    return { exitCode: 0, stdout };
  } catch (error: unknown) {
    if (isExitFailure(error)) {
      return { exitCode: error.code, stderr: error.stderr };
    }
    throw error;
  }
}

const NOT_A_REPOSITORY = /^fatal: not a git repository/m;

/**
 * The top level of the repository containing `folder`, or null when `folder` is in no repository.
 * Any other git failure (a refused or broken repository) is thrown.
 */
export async function repositoryTopLevel(folder: string): Promise<string | null> {
  const outcome = await runGit(folder, ["rev-parse", "--show-toplevel"]);
  if ("stdout" in outcome) {
    return outcome.stdout.replace(/\n$/, "");
  }
  if (NOT_A_REPOSITORY.test(outcome.stderr)) {
    return null;
  }
  throw new Error(
    `git rev-parse --show-toplevel failed in ${folder} with exit ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`,
  );
}

/**
 * True when `branch` is a branch name `git check-ref-format --branch` accepts as itself. Revision
 * syntax that expands to another name (`@{-1}`) is not a branch name.
 */
export async function isBranchName(repository: string, branch: string): Promise<boolean> {
  const format = await runGit(repository, ["check-ref-format", "--branch", branch]);
  return "stdout" in format && format.stdout.replace(/\n$/, "") === branch;
}

/**
 * True when `branch` is a local branch name (not revision syntax such as `main~1` or `@{-1}`)
 * and `refs/heads/<branch>` resolves to a commit (an unborn branch does not).
 */
export async function localBranchExists(repository: string, branch: string): Promise<boolean> {
  if (!(await isBranchName(repository, branch))) {
    return false;
  }
  const ref = `refs/heads/${branch}`;
  const shown = await runGit(repository, ["show-ref", "--verify", "--quiet", ref]);
  if (shown.exitCode !== 0) {
    return false;
  }
  const commit = await runGit(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return commit.exitCode === 0;
}

/**
 * The branch `HEAD` names, even an unborn one, or null for a detached `HEAD`. Any other git
 * failure is thrown: callers use this only on a repository's top level.
 */
export async function headBranch(repository: string): Promise<string | null> {
  const outcome = await runGit(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if ("stdout" in outcome) {
    return outcome.stdout.replace(/\n$/, "");
  }
  // `--quiet` exits 1 without a message when HEAD is detached.
  if (outcome.exitCode === 1) {
    return null;
  }
  throw new Error(
    `git symbolic-ref HEAD failed in ${repository} with exit ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`,
  );
}

/**
 * True when `HEAD` resolves to a commit; false on an unborn branch. Any other git failure is
 * thrown: callers use this only on a repository's top level.
 */
export async function headHasCommit(repository: string): Promise<boolean> {
  const outcome = await runGit(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if ("stdout" in outcome) {
    return true;
  }
  // `--verify --quiet` exits 1 without a message when HEAD names no commit.
  if (outcome.exitCode === 1) {
    return false;
  }
  throw new Error(
    `git rev-parse HEAD failed in ${repository} with exit ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`,
  );
}

/**
 * git's stdout without its final newline. A non-zero exit is thrown: callers use this only for
 * commands that cannot fail on a repository they have already checked.
 */
export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await runGit(cwd, args);
  if (!("stdout" in outcome)) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} with exit ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`,
    );
  }
  return outcome.stdout.replace(/\n$/, "");
}

/** The commit `refs/heads/<branch>` points at, or null when it does not resolve to a commit. */
export async function branchCommit(repository: string, branch: string): Promise<string | null> {
  const outcome = await runGit(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}^{commit}`,
  ]);
  if (!("stdout" in outcome)) {
    return null;
  }
  return outcome.stdout.replace(/\n$/, "");
}
