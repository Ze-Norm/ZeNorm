import { spawn } from "node:child_process";

import { err, ok } from "@zenorm/contracts";
import type {
  CodedError,
  PublishFailureCode,
  PullRequest,
  PullRequestState,
  Result,
} from "@zenorm/contracts";

import { runGit } from "./git.ts";

/**
 * How long gh's sign-in check may take before ZeNorm gives up on reaching GitHub
 * (`delivery_github_unreachable`). A fixed constant: no config key names it.
 */
export const GITHUB_SIGN_IN_TIMEOUT_MS = 30_000;

/** The one host ZeNorm opens pull requests on; GitHub Enterprise hosts keep Mark merged. */
const GITHUB_HOST = "github.com";

/** How much of a failed command's output a failure message carries. */
const OUTPUT_TAIL_CHARS = 2000;

/** A repository on github.com, as gh's `--repo` names it. */
export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
}

/** Why the publishing step failed; the message carries the command's output. */
export type PublishError = CodedError<PublishFailureCode>;

/** Why gh's sign-in check failed: gh cannot run, is not signed in, or cannot reach GitHub. */
export type GitHubSignInError = CodedError<
  "delivery_gh_missing" | "delivery_github_not_signed_in" | "delivery_github_unreachable"
>;

/** One path segment of a GitHub owner or repository name. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** `owner/name` from a remote URL's path: two segments, an optional `.git` and slashes trimmed. */
function repositoryOfPath(path: string): GitHubRepository | null {
  const segments = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  const [owner, name] = segments;
  if (segments.length !== 2 || owner === undefined || name === undefined) {
    return null;
  }
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) {
    return null;
  }
  return { owner, name };
}

/** A remote URL with a scheme: `https://github.com/o/r.git`, `ssh://git@github.com/o/r`. */
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** git's scp-like syntax: `git@github.com:o/r.git`. */
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;

/**
 * The repository a remote URL names when it is on github.com itself, or null for any other host
 * (an Enterprise host, GitLab, a local path).
 */
export function githubRepositoryOf(url: string): GitHubRepository | null {
  if (SCHEME_URL.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname.toLowerCase() !== GITHUB_HOST) {
      return null;
    }
    return repositoryOfPath(parsed.pathname);
  }
  const scp = SCP_LIKE.exec(url);
  if (scp === null) {
    return null;
  }
  const [, host, path] = scp;
  if (host === undefined || path === undefined || host.toLowerCase() !== GITHUB_HOST) {
    return null;
  }
  return repositoryOfPath(path);
}

/**
 * The repository the project's `origin` remote names, when it is on github.com; null when the
 * project has no `origin` or it is elsewhere. A remote under another name is never read. The
 * URL is read as configured, before any `insteadOf` rewriting.
 */
export async function githubOrigin(folder: string): Promise<GitHubRepository | null> {
  const outcome = await runGit(folder, ["config", "--get", "remote.origin.url"]);
  if (!("stdout" in outcome)) {
    // `git config --get` exits 1 when the key is not set.
    if (outcome.exitCode === 1) {
      return null;
    }
    throw new Error(
      `git config --get remote.origin.url failed in ${folder} with exit ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`,
    );
  }
  return githubRepositoryOf(outcome.stdout.trim());
}

/** How a command ended: it exited, could not be spawned, ran past its time, or was aborted. */
type CommandOutcome =
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "missing"; readonly cause: string }
  | { readonly kind: "timed_out" }
  | { readonly kind: "aborted" };

/** The spawn failures that mean the binary cannot be run. */
function spawnFailureCause(error: unknown): string | null {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  ) {
    return error.code;
  }
  return null;
}

/**
 * Runs `file` without a shell in `cwd` with `env`, collecting its output. Past `timeoutMs` (null:
 * no bound) or once `signal` aborts it gets SIGTERM, and the outcome says so.
 */
function runCommand(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number | null;
    readonly signal: AbortSignal;
  },
): Promise<CommandOutcome> {
  if (options.signal.aborted) {
    return Promise.resolve({ kind: "aborted" });
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stoppedBy: "timed_out" | "aborted" | null = null;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const stop = (reason: "timed_out" | "aborted"): void => {
      if (stoppedBy !== null) return;
      stoppedBy = reason;
      child.kill("SIGTERM");
    };
    const timer =
      options.timeoutMs === null
        ? undefined
        : setTimeout(() => {
            stop("timed_out");
          }, options.timeoutMs);
    const onAbort = (): void => {
      stop("aborted");
    };
    options.signal.addEventListener("abort", onAbort);
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    child.on("error", (error) => {
      // A spawn failure never starts the process: there is no exit to wait for.
      if (child.pid !== undefined) return;
      const cause = spawnFailureCause(error);
      if (cause === null) {
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        reject(error);
        return;
      }
      finish({ kind: "missing", cause });
    });
    child.on("close", (code) => {
      if (stoppedBy !== null) {
        finish({ kind: stoppedBy });
        return;
      }
      finish({ kind: "exited", exitCode: code, stdout, stderr });
    });
  });
}

/** The command's output for a failure message: its stderr's tail, else its stdout's. */
function outputTail(outcome: { readonly stdout: string; readonly stderr: string }): string {
  const text = outcome.stderr.trim() === "" ? outcome.stdout.trim() : outcome.stderr.trim();
  return text.slice(-OUTPUT_TAIL_CHARS);
}

function exitWords(exitCode: number | null): string {
  return exitCode === null ? "was killed" : `exited ${String(exitCode)}`;
}

/**
 * gh's environment: the server's own, read at each call (gh is the one first on its `PATH`, as git
 * is), with gh's prompts and update notices off.
 */
function ghEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
}

function ghMissing(cause: string): CodedError<"delivery_gh_missing"> {
  return {
    code: "delivery_gh_missing",
    message: `The GitHub CLI gh cannot run (${cause}). Install gh and sign in with \`gh auth login\`.`,
  };
}

/** The abort's outcome: the runner, aborted, stores nothing of it. */
function stopped<C extends PublishFailureCode>(code: C): CodedError<C> {
  return { code, message: "The run was cancelled while ZeNorm was opening its pull request." };
}

/**
 * Checks gh is signed in to github.com (`gh auth status --hostname github.com`):
 * `delivery_gh_missing` when gh cannot run, `delivery_github_not_signed_in` when it reports no
 * sign-in, `delivery_github_unreachable` when the check outlasts `GITHUB_SIGN_IN_TIMEOUT_MS`.
 */
export async function checkGitHubSignIn(input: {
  readonly folder: string;
  readonly signal: AbortSignal;
}): Promise<Result<null, GitHubSignInError>> {
  const outcome = await runCommand("gh", ["auth", "status", "--hostname", GITHUB_HOST], {
    cwd: input.folder,
    env: ghEnv(),
    timeoutMs: GITHUB_SIGN_IN_TIMEOUT_MS,
    signal: input.signal,
  });
  switch (outcome.kind) {
    case "missing":
      return err(ghMissing(outcome.cause));
    case "timed_out":
      return err({
        code: "delivery_github_unreachable",
        message: `gh could not check its sign-in to ${GITHUB_HOST} within ${String(GITHUB_SIGN_IN_TIMEOUT_MS / 1000)} seconds.`,
      });
    case "aborted":
      return err(stopped("delivery_github_unreachable"));
    case "exited":
      if (outcome.exitCode === 0) {
        return ok(null);
      }
      return err({
        code: "delivery_github_not_signed_in",
        message: `gh is not signed in to ${GITHUB_HOST}: \`gh auth status\` ${exitWords(outcome.exitCode)}. Run \`gh auth login\`.\n${outputTail(outcome)}`,
      });
  }
}

/**
 * Pushes the run branch to `origin` under its own name, from the project's folder, with git's
 * prompts off: `delivery_push_failed` with git's output when the push fails. Nothing else is pushed
 * and no remote branch is ever deleted.
 */
export async function pushRunBranch(input: {
  readonly folder: string;
  readonly branch: string;
  readonly signal: AbortSignal;
}): Promise<Result<null, PublishError>> {
  const ref = `refs/heads/${input.branch}`;
  const outcome = await runCommand("git", ["push", "--quiet", "origin", `${ref}:${ref}`], {
    cwd: input.folder,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: null,
    signal: input.signal,
  });
  switch (outcome.kind) {
    case "missing":
      throw new Error(`git cannot run in ${input.folder}: ${outcome.cause}`);
    case "timed_out":
      throw new Error("The push has no time bound, so it cannot time out");
    case "aborted":
      return err(stopped("delivery_push_failed"));
    case "exited":
      if (outcome.exitCode === 0) {
        return ok(null);
      }
      return err({
        code: "delivery_push_failed",
        message: `git push of ${input.branch} to origin ${exitWords(outcome.exitCode)}.\n${outputTail(outcome)}`,
      });
  }
}

/**
 * Opens a ready-for-review pull request of `branch` against `baseBranch` on `repository`, origin's,
 * titled `title` with the body in `bodyFile`: `gh pr create`, whose last output line is the new
 * pull request's URL. `delivery_gh_missing` when gh cannot run; `delivery_pull_request_failed` when
 * gh fails or prints no pull request URL of `repository`.
 */
export async function openPullRequest(input: {
  readonly folder: string;
  readonly repository: GitHubRepository;
  readonly baseBranch: string;
  readonly branch: string;
  readonly title: string;
  readonly bodyFile: string;
  readonly signal: AbortSignal;
}): Promise<Result<PullRequest, PublishError>> {
  const { owner, name } = input.repository;
  const outcome = await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      `${owner}/${name}`,
      "--base",
      input.baseBranch,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body-file",
      input.bodyFile,
    ],
    { cwd: input.folder, env: ghEnv(), timeoutMs: null, signal: input.signal },
  );
  switch (outcome.kind) {
    case "missing":
      return err(ghMissing(outcome.cause));
    case "timed_out":
      throw new Error("Opening the pull request has no time bound, so it cannot time out");
    case "aborted":
      return err(stopped("delivery_pull_request_failed"));
    case "exited": {
      if (outcome.exitCode !== 0) {
        return err({
          code: "delivery_pull_request_failed",
          message: `gh pr create on ${owner}/${name} ${exitWords(outcome.exitCode)}.\n${outputTail(outcome)}`,
        });
      }
      const url = outcome.stdout.trim().split("\n").at(-1);
      const opened = url === undefined ? null : pullRequestOf(url.trim(), input.repository);
      if (opened === null) {
        return err({
          code: "delivery_pull_request_failed",
          message: `gh pr create on ${owner}/${name} printed no pull request URL.\n${outputTail(outcome)}`,
        });
      }
      return ok(opened);
    }
  }
}

/** Why reading a recorded pull request's state failed: gh cannot run, or GitHub's answer. */
export type PullRequestReadError = GitHubSignInError;

/** gh's `state` field of a pull request, as ZeNorm records it. */
const GH_PULL_REQUEST_STATES = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
} as const satisfies Record<string, PullRequestState>;

function isGhPullRequestState(value: unknown): value is keyof typeof GH_PULL_REQUEST_STATES {
  return typeof value === "string" && Object.hasOwn(GH_PULL_REQUEST_STATES, value);
}

/**
 * The state GitHub reports for the pull request at `url`: `gh pr view <url> --json state`,
 * merged by any merge method (merge, squash or rebase) reading `merged`. `delivery_gh_missing`
 * when gh cannot run; `delivery_github_unreachable` when gh fails, prints no state, or outlasts
 * `GITHUB_SIGN_IN_TIMEOUT_MS`. The sign-in is checked first, by the caller. gh is given the full
 * URL, so it reads no repository: it runs in `folder`, any folder that exists.
 */
export async function readPullRequestState(input: {
  readonly folder: string;
  readonly url: string;
  readonly signal: AbortSignal;
}): Promise<Result<PullRequestState, PullRequestReadError>> {
  const outcome = await runCommand("gh", ["pr", "view", input.url, "--json", "state"], {
    cwd: input.folder,
    env: ghEnv(),
    timeoutMs: GITHUB_SIGN_IN_TIMEOUT_MS,
    signal: input.signal,
  });
  switch (outcome.kind) {
    case "missing":
      return err(ghMissing(outcome.cause));
    case "timed_out":
      return err({
        code: "delivery_github_unreachable",
        message: `gh could not read ${input.url} within ${String(GITHUB_SIGN_IN_TIMEOUT_MS / 1000)} seconds.`,
      });
    case "aborted":
      return err({
        code: "delivery_github_unreachable",
        message: `ZeNorm stopped while gh was reading ${input.url}.`,
      });
    case "exited": {
      if (outcome.exitCode !== 0) {
        return err({
          code: "delivery_github_unreachable",
          message: `gh pr view ${input.url} ${exitWords(outcome.exitCode)}.\n${outputTail(outcome)}`,
        });
      }
      const state = ghStateOf(outcome.stdout);
      if (state === null) {
        return err({
          code: "delivery_github_unreachable",
          message: `gh pr view ${input.url} printed no pull request state.\n${outputTail(outcome)}`,
        });
      }
      return ok(GH_PULL_REQUEST_STATES[state]);
    }
  }
}

/** The `state` of gh's `--json state` output, or null when it holds none ZeNorm knows. */
function ghStateOf(stdout: string): keyof typeof GH_PULL_REQUEST_STATES | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
    return null;
  }
  return isGhPullRequestState(parsed.state) ? parsed.state : null;
}

/** The open pull request `url` names on `repository`, or null when it names none there. */
function pullRequestOf(url: string, repository: GitHubRepository): PullRequest | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  if (match === null) {
    return null;
  }
  const [, owner, name, number] = match;
  if (
    owner === undefined ||
    name === undefined ||
    number === undefined ||
    owner.toLowerCase() !== repository.owner.toLowerCase() ||
    name.toLowerCase() !== repository.name.toLowerCase()
  ) {
    return null;
  }
  return { number: Number(number), url, state: "open" };
}
