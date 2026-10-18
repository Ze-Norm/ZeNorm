import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DELIVERY_SCREENS_MAX_COUNT,
  type DeliveryAgentConfig,
  type DeliveryAgentError,
  err,
  gitIdentityEnv,
  type ImplementRequest,
  type ImplementTicketSet,
  ok,
  PickedScreen,
  type PickScreens,
  type PickScreensRequest,
  PULL_REQUEST_WRITTEN_BODY_MAX_LENGTH,
  type PullRequestRequest,
  type Result,
  type ReviewDelivery,
  type ReviewRequest,
  Verdict,
  type WritePullRequest,
} from "@zenorm/contracts";
import { z } from "zod";

import {
  type CliCall,
  type ExitedRun,
  exitDescription,
  FAST_MODE_SETTINGS,
  fastModeArgs,
  interpretExit,
  outputInvalid,
  parseJson,
  runFailed,
  sessionFailed,
  runSession,
  structuredOutput,
} from "./claude.ts";
import {
  buildOrchestratorPrompt,
  buildOrchestratorSystemPrompt,
  buildPullRequestPrompt,
  buildPullRequestSystemPrompt,
  buildReviewerPrompt,
  buildReviewerSystemPrompt,
  buildScreenPickerPrompt,
  buildScreenPickerSystemPrompt,
} from "./delivery-prompt.ts";
import { createImplementStreamParser } from "./delivery-stream.ts";
import { checkDeliverySkills, checkSkill, deliverySkills, type DeliverySkills } from "./skills.ts";

/** A delivery session's config: the agent's, and the skills folder the entry passes in. */
export type DeliverySessionConfig = DeliveryAgentConfig & { readonly skillsDir: string };

/** The CLI's subagent tool, which both sessions need to run the skills' subagents. */
export const SUBAGENT_TOOL = "Agent";

const ORCHESTRATOR_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", SUBAGENT_TOOL].join(
  ",",
);

/**
 * The orchestrator's allowed tools before the checks and fix commands: file tools and git
 * subcommands.
 */
const ORCHESTRATOR_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  SUBAGENT_TOOL,
  "Bash(cd:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git worktree:*)",
  "Bash(git merge:*)",
  "Bash(git branch:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git rev-parse:*)",
  "Bash(git rm:*)",
  "Bash(git mv:*)",
].join(",");

const ORCHESTRATOR_DISALLOWED_TOOLS = "Bash(git push:*),WebFetch,WebSearch,NotebookEdit";

const REVIEWER_TOOLS = ["Read", "Grep", "Glob", "Bash", SUBAGENT_TOOL].join(",");

const REVIEWER_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  SUBAGENT_TOOL,
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
].join(",");

const REVIEWER_DISALLOWED_TOOLS = "Write,Edit,NotebookEdit,WebFetch,WebSearch";

const VERDICT_OUTPUT = structuredOutput(Verdict);

/** The reviewer's `--json-schema`: the schema that also validates the stored `verdict`. */
export const VERDICT_JSON_SCHEMA = VERDICT_OUTPUT.jsonSchema;

/** The pull request writer reads the change and runs git's read commands; it writes nothing. */
const PULL_REQUEST_TOOLS = ["Read", "Grep", "Glob", "Bash"].join(",");

const PULL_REQUEST_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
].join(",");

const PULL_REQUEST_DISALLOWED_TOOLS = "Write,Edit,NotebookEdit,WebFetch,WebSearch";

/**
 * The writer's `--settings`: Claude Code's own pull request attribution line off (ZeNorm adds its
 * footer when it publishes), and fast mode when `fastMode` is set, since one `--settings` holds both.
 */
function pullRequestSettings(fastMode: boolean | undefined): string {
  const attribution = { attribution: { pr: "" } };
  return JSON.stringify(
    fastMode === true ? { ...attribution, ...FAST_MODE_SETTINGS } : attribution,
  );
}

/**
 * The pull request writer's structured output: the body, whole, and whether the change is visible
 * in the app. Its root key `pullRequestBody` is how the e2e stand-in tells the writer from the
 * other calls.
 */
const PULL_REQUEST_OUTPUT = structuredOutput(
  z.strictObject({
    pullRequestBody: z.string().min(1).max(PULL_REQUEST_WRITTEN_BODY_MAX_LENGTH),
    visibleChange: z.boolean(),
  }),
);

/** The pull request writer's `--json-schema`. */
export const PULL_REQUEST_JSON_SCHEMA = PULL_REQUEST_OUTPUT.jsonSchema;

/** The screen picker reads the diff, the spec and the worktree's files; it runs no command. */
const SCREEN_PICKER_TOOLS = ["Read", "Grep", "Glob"].join(",");

const SCREEN_PICKER_DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  SUBAGENT_TOOL,
].join(",");

/**
 * The screen picker's structured output: the changed screens, none when nothing a person sees
 * changed. Its root key `changedScreens` is how the e2e stand-in tells the picker from the other
 * calls.
 */
const SCREEN_PICKER_OUTPUT = structuredOutput(
  z.strictObject({
    changedScreens: z.array(PickedScreen).max(DELIVERY_SCREENS_MAX_COUNT),
  }),
);

/** The screen picker's `--json-schema`. */
export const SCREEN_PICKER_JSON_SCHEMA = SCREEN_PICKER_OUTPUT.jsonSchema;

/**
 * The CLI's print mode stops background tasks still running this long after the session's last
 * turn (10 minutes by default); "0" waits for them. Delivery sessions run their subagents in the
 * background and idle until each reports, so only ZeNorm's own session timeout bounds them.
 */
const NO_BACKGROUND_WAIT_CEILING = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };

/** The git config the orchestrator's git runs with: no automatic gc, which repacks refs. */
const NO_AUTO_GC = "'gc.auto=0'";

/**
 * `GIT_CONFIG_PARAMETERS` with `gc.auto=0` added to the value this process has, if any. Git reads
 * it as space-separated quoted `key=value` entries; a later entry wins.
 */
export function gitConfigParameters(existing: string | undefined): string {
  if (existing === undefined || existing === "") return NO_AUTO_GC;
  return `${existing} ${NO_AUTO_GC}`;
}

/** The run folder's file names the sessions write. */
const ORCHESTRATOR_PROMPT_FILE = "orchestrator-prompt.md";
const ORCHESTRATOR_STREAM_FILE = "orchestrator.jsonl";
const REVIEWER_PROMPT_FILE = "reviewer-prompt.md";
const REVIEWER_OUTPUT_FILE = "reviewer.json";
const PULL_REQUEST_PROMPT_FILE = "pr-writer-prompt.md";
const PULL_REQUEST_OUTPUT_FILE = "pr-writer.json";
const SCREEN_PICKER_PROMPT_FILE = "screen-picker-prompt.md";
const SCREEN_PICKER_OUTPUT_FILE = "screen-picker.json";

/**
 * One `--allowedTools` flag per command, built from the pinned text exactly: the command alone or
 * with extra arguments. A separate flag per command (repeats accumulate) keeps a comma in one
 * command from splitting the base list. The run's checks and its fix commands both go through it,
 * so the orchestrator may run exactly those beyond its fixed tools.
 */
function commandAllowedTools(commands: readonly string[]): string[] {
  return commands.flatMap((command) => ["--allowedTools", `Bash(${command}),Bash(${command}:*)`]);
}

/**
 * The orchestrator's argv. The prompt comes straight after `-p`: the tool flags are variadic.
 * Exported for the opt-in live test, which checks what a subagent of a session with these
 * permissions may run.
 */
export function orchestratorArgs(
  config: DeliveryAgentConfig,
  request: ImplementRequest,
  prompt: string,
  systemPromptFile: string,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--max-turns",
    String(config.orchestratorMaxTurns),
    ...fastModeArgs(config.fastMode),
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    ORCHESTRATOR_TOOLS,
    "--allowedTools",
    ORCHESTRATOR_ALLOWED_TOOLS,
    ...commandAllowedTools(request.checks),
    ...commandAllowedTools(request.fixCommands),
    "--disallowedTools",
    ORCHESTRATOR_DISALLOWED_TOOLS,
    "--add-dir",
    request.runDir,
    "--append-system-prompt-file",
    systemPromptFile,
  ];
}

/** The reviewer's argv. */
function reviewerArgs(
  config: DeliveryAgentConfig,
  request: ReviewRequest,
  prompt: string,
  systemPromptFile: string,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--max-turns",
    String(config.reviewerMaxTurns),
    ...fastModeArgs(config.fastMode),
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    REVIEWER_TOOLS,
    "--allowedTools",
    REVIEWER_ALLOWED_TOOLS,
    "--disallowedTools",
    REVIEWER_DISALLOWED_TOOLS,
    "--add-dir",
    request.runDir,
    "--append-system-prompt-file",
    systemPromptFile,
    "--json-schema",
    VERDICT_JSON_SCHEMA,
  ];
}

/**
 * The pull request writer's argv: the reviewer's model, effort and turns, read-only tools, and the
 * body's `--json-schema`.
 */
function pullRequestArgs(
  config: DeliveryAgentConfig,
  request: PullRequestRequest,
  prompt: string,
  systemPromptFile: string,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--max-turns",
    String(config.reviewerMaxTurns),
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    PULL_REQUEST_TOOLS,
    "--allowedTools",
    PULL_REQUEST_ALLOWED_TOOLS,
    "--disallowedTools",
    PULL_REQUEST_DISALLOWED_TOOLS,
    "--settings",
    pullRequestSettings(config.fastMode),
    "--add-dir",
    request.runDir,
    "--append-system-prompt-file",
    systemPromptFile,
    "--json-schema",
    PULL_REQUEST_JSON_SCHEMA,
  ];
}

/**
 * The screen picker's argv: the reviewer's model, effort and turns, and only the read tools Read,
 * Grep and Glob, with no command, subagent or web tool.
 */
function screenPickerArgs(
  config: DeliveryAgentConfig,
  request: PickScreensRequest,
  prompt: string,
  systemPromptFile: string,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--max-turns",
    String(config.reviewerMaxTurns),
    ...fastModeArgs(config.fastMode),
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--tools",
    SCREEN_PICKER_TOOLS,
    "--allowedTools",
    SCREEN_PICKER_TOOLS,
    "--disallowedTools",
    SCREEN_PICKER_DISALLOWED_TOOLS,
    "--add-dir",
    request.runDir,
    "--append-system-prompt-file",
    systemPromptFile,
    "--json-schema",
    SCREEN_PICKER_JSON_SCHEMA,
  ];
}

/**
 * The screen picker session through the Claude Code CLI at `config.claudePath`, under the
 * reviewer's model, effort, turn and timeout settings: no config key of its own. It reads the
 * change and the spec and lists the screens the change makes look different, up to
 * `DELIVERY_SCREENS_MAX_COUNT`; none listed is no visible change.
 */
export function claudeCodePickScreens(config: DeliveryAgentConfig): PickScreens {
  const call: CliCall = {
    claudePath: config.claudePath,
    timeoutSeconds: config.reviewerTimeoutMinutes * 60,
    who: "The screen picker",
    sessionsDir: config.sessionsDir,
    // A read-only session after the review, under the reviewer's settings: recorded as one.
    kind: "reviewer",
  };
  return async (request, signal) => {
    const systemPromptFile = join(request.runDir, SCREEN_PICKER_PROMPT_FILE);
    writeFileSync(systemPromptFile, buildScreenPickerSystemPrompt());
    const stdoutFile = join(request.runDir, SCREEN_PICKER_OUTPUT_FILE);
    writeFileSync(stdoutFile, "");
    const run = await runSession(
      call,
      screenPickerArgs(config, request, buildScreenPickerPrompt(request), systemPromptFile),
      request.worktreePath,
      {
        env: { ...gitIdentityEnv(request.gitIdentity), ...NO_BACKGROUND_WAIT_CEILING },
        signal,
        stdoutFile,
        onStdout: null,
        processGroup: true,
      },
    );
    if (!run.ok) return run;
    const picked = interpretExit(call, run.value, SCREEN_PICKER_OUTPUT.schema);
    if (!picked.ok) return picked;
    const [first, ...rest] = picked.value.changedScreens;
    if (first === undefined) return ok({ kind: "no_visible_change" });
    return ok({ kind: "screens", screens: [first, ...rest] });
  };
}

/**
 * The delivery orchestrator session through the Claude Code CLI at `config.claudePath`, following
 * the skills in `config.skillsDir`.
 */
export function claudeCodeImplementTicketSet(config: DeliverySessionConfig): ImplementTicketSet {
  return implementTicketSetWith(config, deliverySkills(config.skillsDir));
}

/**
 * The delivery reviewer session through the Claude Code CLI at `config.claudePath`, following the
 * skills in `config.skillsDir`.
 */
export function claudeCodeReviewDelivery(config: DeliverySessionConfig): ReviewDelivery {
  return reviewDeliveryWith(config, deliverySkills(config.skillsDir));
}

/**
 * The pull request writer session through the Claude Code CLI at `config.claudePath`, under the
 * reviewer's model, effort, turn and timeout settings: no config key of its own. It follows the PR
 * skill in `config.skillsDir`.
 */
export function claudeCodeWritePullRequest(config: DeliverySessionConfig): WritePullRequest {
  return writePullRequestWith(config, deliverySkills(config.skillsDir));
}

/**
 * `claudeCodeWritePullRequest` with the skill files named; tests point it at a temp folder. Refuses
 * with `agent_skill_missing`, spawning nothing, when the PR skill is absent.
 */
export function writePullRequestWith(
  config: DeliveryAgentConfig,
  skills: DeliverySkills,
): WritePullRequest {
  const call: CliCall = {
    claudePath: config.claudePath,
    timeoutSeconds: config.reviewerTimeoutMinutes * 60,
    who: "The pull request writer",
    sessionsDir: config.sessionsDir,
    // A read-only session after the review, under the reviewer's settings: recorded as one.
    kind: "reviewer",
  };
  return async (request, signal) => {
    const skillCheck = checkSkill(skills.pullRequest);
    if (!skillCheck.ok) return skillCheck;
    const systemPromptFile = join(request.runDir, PULL_REQUEST_PROMPT_FILE);
    writeFileSync(systemPromptFile, buildPullRequestSystemPrompt(skills));
    const stdoutFile = join(request.runDir, PULL_REQUEST_OUTPUT_FILE);
    writeFileSync(stdoutFile, "");
    const run = await runSession(
      call,
      pullRequestArgs(config, request, buildPullRequestPrompt(request), systemPromptFile),
      request.worktreePath,
      {
        env: { ...gitIdentityEnv(request.gitIdentity), ...NO_BACKGROUND_WAIT_CEILING },
        signal,
        stdoutFile,
        onStdout: null,
        processGroup: true,
      },
    );
    if (!run.ok) return run;
    const written = interpretExit(call, run.value, PULL_REQUEST_OUTPUT.schema);
    if (!written.ok) return written;
    return ok({ body: written.value.pullRequestBody, visibleChange: written.value.visibleChange });
  };
}

/** `claudeCodeImplementTicketSet` with the skill files named; tests point it at a temp folder. */
export function implementTicketSetWith(
  config: DeliveryAgentConfig,
  skills: DeliverySkills,
): ImplementTicketSet {
  return async (request, signal, onEvent) => {
    const skillCheck = checkDeliverySkills(skills);
    if (!skillCheck.ok) return skillCheck;
    const call: CliCall = {
      claudePath: config.claudePath,
      timeoutSeconds: config.orchestratorTimeoutMinutes * 60,
      who: "The delivery orchestrator",
      sessionsDir: config.sessionsDir,
      kind: "orchestrator",
    };
    const systemPromptFile = join(request.runDir, ORCHESTRATOR_PROMPT_FILE);
    writeFileSync(systemPromptFile, buildOrchestratorSystemPrompt(request, skills));
    const stdoutFile = join(request.runDir, ORCHESTRATOR_STREAM_FILE);
    writeFileSync(stdoutFile, "");
    const parser = createImplementStreamParser(request, onEvent);
    const run = await runSession(
      call,
      orchestratorArgs(config, request, buildOrchestratorPrompt(request), systemPromptFile),
      request.worktreePath,
      {
        env: {
          ...gitIdentityEnv(request.gitIdentity),
          ...NO_BACKGROUND_WAIT_CEILING,
          GIT_CONFIG_PARAMETERS: gitConfigParameters(process.env.GIT_CONFIG_PARAMETERS),
        },
        signal,
        stdoutFile,
        onStdout: (chunk) => {
          parser.push(chunk);
        },
        processGroup: true,
      },
    );
    if (!run.ok) return run;
    parser.end();
    return interpretStream(run.value);
  };
}

/** `claudeCodeReviewDelivery` with the skill files named; tests point it at a temp folder. */
export function reviewDeliveryWith(
  config: DeliveryAgentConfig,
  skills: DeliverySkills,
): ReviewDelivery {
  const call: CliCall = {
    claudePath: config.claudePath,
    timeoutSeconds: config.reviewerTimeoutMinutes * 60,
    who: "The delivery reviewer",
    sessionsDir: config.sessionsDir,
    kind: "reviewer",
  };
  return async (request, signal) => {
    const skillCheck = checkDeliverySkills(skills);
    if (!skillCheck.ok) return skillCheck;
    const systemPromptFile = join(request.runDir, REVIEWER_PROMPT_FILE);
    writeFileSync(systemPromptFile, buildReviewerSystemPrompt(skills));
    const stdoutFile = join(request.runDir, REVIEWER_OUTPUT_FILE);
    writeFileSync(stdoutFile, "");
    const run = await runSession(
      call,
      reviewerArgs(config, request, buildReviewerPrompt(request), systemPromptFile),
      request.worktreePath,
      {
        env: { ...gitIdentityEnv(request.gitIdentity), ...NO_BACKGROUND_WAIT_CEILING },
        signal,
        stdoutFile,
        onStdout: null,
        processGroup: true,
      },
    );
    if (!run.ok) return run;
    return interpretExit(call, run.value, VERDICT_OUTPUT.schema);
  };
}

const StreamResult = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  /** Absent from CLIs older than the subagent counts; `killed.system` counts the CLI's own kills. */
  subagent_stats: z.looseObject({ killed: z.looseObject({ system: z.number() }) }).optional(),
});
type StreamResult = z.infer<typeof StreamResult>;

/** The last `{"type":"result"}` line of a stream-json stdout, or null when it has none. */
function lastResultLine(stdout: string): StreamResult | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const json = parseJson(line);
    if (!json.ok) continue;
    const result = StreamResult.safeParse(json.value);
    if (result.success) return result.data;
  }
  return null;
}

/**
 * The orchestrator's outcome: exit 0 and a last `result` line with subtype `success` and `is_error`
 * false, with no subagent the CLI itself killed (an implementer stopped mid-ticket at a wait
 * ceiling or for memory). Success only means the session ended normally; ZeNorm verifies from git.
 */
function interpretStream(run: ExitedRun): Result<null, DeliveryAgentError> {
  const result = lastResultLine(run.stdout);
  if (run.exitCode !== 0) {
    const subtype = result === null ? null : result.subtype;
    return err(
      sessionFailed(
        `${exitDescription(run)} (result subtype: ${String(subtype)})`,
        run,
        result,
        subtype,
      ),
    );
  }
  if (result === null) {
    return err(
      outputInvalid("The delivery orchestrator's stream has no `result` line.", run.stderrTail),
    );
  }
  if (result.is_error || result.subtype !== "success") {
    return err(
      sessionFailed(
        `reported a failed run (subtype ${result.subtype}, is_error ${String(result.is_error)})`,
        run,
        result,
        result.subtype,
      ),
    );
  }
  if (result.subagent_stats !== undefined && result.subagent_stats.killed.system > 0) {
    return err(
      runFailed(
        `stopped ${String(result.subagent_stats.killed.system)} background subagent(s) before they finished`,
        run.exitCode,
        result.subtype,
        run.stderrTail,
      ),
    );
  }
  return ok(null);
}
