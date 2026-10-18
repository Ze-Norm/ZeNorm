import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CAPTURED_IMAGES_MAX_COUNT,
  CapturedImage,
  type CaptureScreens,
  type CaptureScreensRequest,
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
  SkippedScreen,
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
  buildCapturePrompt,
  buildCaptureSystemPrompt,
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
import {
  checkCaptureBrowser,
  type McpServerLaunch,
  PLAYWRIGHT_MCP_SERVER_NAME,
} from "./playwright-mcp.ts";
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

/** The browser tools the capture session may use, by the Playwright MCP server's tool names. */
export const CAPTURE_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_handle_dialog",
  "browser_wait_for",
  "browser_resize",
  "browser_take_screenshot",
  "browser_close",
] as const;

/** The capture session's read tools, to find documented test logins and the screens' routes. */
const CAPTURE_READ_TOOLS = ["Read", "Grep", "Glob"];

/**
 * The capture session's allowed tools: its read tools and the named browser tools, each as the CLI
 * names an MCP tool, `mcp__<server>__<tool>`.
 */
export const CAPTURE_ALLOWED_TOOLS = [
  ...CAPTURE_READ_TOOLS,
  ...CAPTURE_BROWSER_TOOLS.map((tool) => `mcp__${PLAYWRIGHT_MCP_SERVER_NAME}__${tool}`),
].join(",");

/**
 * What the capture session is denied: every command, edit, web and subagent tool, and reading a
 * real env file or a key file (logins come only from docs and example env files).
 */
const CAPTURE_DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  SUBAGENT_TOOL,
  "Read(**/.env)",
  "Read(**/.env.local)",
  "Read(**/.env.*.local)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
].join(",");

/**
 * The capture session's structured output: each screenshot it took, with the picked screen it
 * shows and its caption, and each picked screen it could not reach. Its root key `screenshots` is
 * how the e2e stand-in tells the capture from the other calls.
 */
const CAPTURE_OUTPUT = structuredOutput(
  z.strictObject({
    screenshots: z.array(CapturedImage).max(CAPTURED_IMAGES_MAX_COUNT),
    skippedScreens: z.array(SkippedScreen).max(DELIVERY_SCREENS_MAX_COUNT),
  }),
);

/** The capture session's `--json-schema`. */
export const CAPTURE_JSON_SCHEMA = CAPTURE_OUTPUT.jsonSchema;

/** The origin of the app URL, the one origin the capture's browser may request. */
export function appOrigin(appUrl: string): string {
  return new URL(appUrl).origin;
}

/**
 * The capture session's MCP config: the pinned Playwright MCP server alone (started by `launch`),
 * headless Chromium in an isolated, in-memory profile, its requests limited to the app's origin and
 * its files written to the run's screenshots folder.
 */
export function captureMcpConfig(request: CaptureScreensRequest, launch: McpServerLaunch): string {
  return JSON.stringify({
    mcpServers: {
      [PLAYWRIGHT_MCP_SERVER_NAME]: {
        type: "stdio",
        command: launch.command,
        args: [
          ...launch.args,
          "--headless",
          "--browser",
          "chromium",
          "--isolated",
          "--allowed-origins",
          appOrigin(request.appUrl),
          "--output-dir",
          request.screenshotsDir,
        ],
      },
    },
  });
}

/**
 * The capture session's argv: the reviewer's model, effort and turns; only its MCP config's server
 * (`--strict-mcp-config`, so the project's own MCP servers are kept out); only the read tools and
 * the named browser tools, no command.
 */
export function captureArgs(
  config: DeliveryAgentConfig,
  request: CaptureScreensRequest,
  prompt: string,
  systemPromptFile: string,
  mcpConfigFile: string,
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
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigFile,
    "--tools",
    CAPTURE_READ_TOOLS.join(","),
    "--allowedTools",
    CAPTURE_ALLOWED_TOOLS,
    "--disallowedTools",
    CAPTURE_DISALLOWED_TOOLS,
    "--add-dir",
    request.runDir,
    "--append-system-prompt-file",
    systemPromptFile,
    "--json-schema",
    CAPTURE_JSON_SCHEMA,
  ];
}

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
const CAPTURE_PROMPT_FILE = "capture-prompt.md";
const CAPTURE_OUTPUT_FILE = "capture.json";
const CAPTURE_MCP_CONFIG_FILE = "capture-mcp.json";

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
 * The browser capture session through the Claude Code CLI at `config.claudePath`, under the
 * reviewer's model, effort, turn and timeout settings: no config key of its own. Its one MCP server
 * is the pinned Playwright MCP server, driving headless Chromium that may request only the app's
 * origin; it screenshots the picked screens into the request's screenshots folder and runs no
 * command. Before any session starts, the server and the Chromium build it drives must be
 * installed where the server, run in the worktree with this process's environment, looks for them
 * (`checkCaptureBrowser`): `capture_browser_missing` otherwise. A screenshot its output names that
 * is not a file in that folder is `agent_output_invalid`.
 */
export function claudeCodeCaptureScreens(config: DeliveryAgentConfig): CaptureScreens {
  const call: CliCall = {
    claudePath: config.claudePath,
    timeoutSeconds: config.reviewerTimeoutMinutes * 60,
    who: "The capture session",
    sessionsDir: config.sessionsDir,
    // A read-only session after the review, under the reviewer's settings: recorded as one.
    kind: "reviewer",
  };
  return async (request, signal) => {
    const browser = checkCaptureBrowser(process.env, request.worktreePath);
    if (!browser.ok) return browser;
    const systemPromptFile = join(request.runDir, CAPTURE_PROMPT_FILE);
    writeFileSync(systemPromptFile, buildCaptureSystemPrompt(request));
    const mcpConfigFile = join(request.runDir, CAPTURE_MCP_CONFIG_FILE);
    writeFileSync(mcpConfigFile, captureMcpConfig(request, browser.value.server.launch));
    const stdoutFile = join(request.runDir, CAPTURE_OUTPUT_FILE);
    writeFileSync(stdoutFile, "");
    const run = await runSession(
      call,
      captureArgs(config, request, buildCapturePrompt(request), systemPromptFile, mcpConfigFile),
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
    const captured = interpretExit(call, run.value, CAPTURE_OUTPUT.schema);
    if (!captured.ok) return captured;
    const missing = captured.value.screenshots.find(
      (image) => !existsSync(join(request.screenshotsDir, image.file)),
    );
    if (missing !== undefined) {
      return err(
        outputInvalid(
          `The capture session named the screenshot ${missing.file}, which is not in ${request.screenshotsDir}.`,
          run.value.stderrTail,
        ),
      );
    }
    return ok({ images: captured.value.screenshots, skipped: captured.value.skippedScreens });
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
