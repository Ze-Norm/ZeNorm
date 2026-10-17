import { isAbsolute, join, relative, sep } from "node:path";

import {
  cutAgentText,
  type ImplementEvent,
  RUN_EVENT_TEXT_MAX_LENGTH,
  RUN_TICKET_SUMMARY_MAX_LENGTH,
} from "@zenorm/contracts";
import { z } from "zod";

import { parseJson } from "./claude.ts";

/** What the stream parser needs from the run: the branch, the folders and the pinned tickets. */
export interface ImplementStreamContext {
  readonly runDir: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly tickets: readonly { readonly id: string }[];
}

/** Feeds stdout chunks in as they arrive; `end` parses a last line that has no newline. */
export interface ImplementStreamParser {
  push(chunk: string): void;
  end(): void;
}

/** The CLI's subagent tool: both names occur. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

const TextBlock = z.looseObject({ type: z.literal("text"), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.looseObject({}),
});
const ToolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
const MessageLine = z.looseObject({
  type: z.enum(["assistant", "user"]),
  parent_tool_use_id: z.string().min(1).nullable(),
  message: z.looseObject({ content: z.array(z.unknown()) }),
  tool_use_result: z.unknown().optional(),
});
type MessageLine = z.infer<typeof MessageLine>;
/**
 * A foreground subagent's structured hand-back (CLI 2.1.296): its text blocks are the clean
 * report, while the model-facing `tool_result` wraps it in a hand-back frame and an
 * `agentId … <usage>` trailer.
 */
const CompletedHandBack = z.looseObject({
  status: z.literal("completed"),
  content: z.array(z.unknown()),
});
/** A background subagent's end: its report is the `summary`. */
const TaskNotification = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_notification"),
  tool_use_id: z.string().min(1),
  summary: z.string(),
});
const Description = z.looseObject({ description: z.string() });
const Command = z.looseObject({ command: z.string() });
const FilePath = z.looseObject({ file_path: z.string().min(1) });
const Pattern = z.looseObject({ pattern: z.string().min(1) });

/** A line's text as the contract stores it: the shared cut at 500 characters. */
export function cutLineText(text: string): string {
  return cutAgentText(text, RUN_EVENT_TEXT_MAX_LENGTH);
}

/** The text of a `tool_result`'s content: a string, or the text blocks of an array, joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const text = TextBlock.safeParse(item);
      return text.success ? [text.data.text] : [];
    })
    .join("\n");
}

/**
 * A tied subagent's report from its `tool_result` line: the text blocks of a completed structured
 * hand-back, else (no structured result, the stand-in's shape) the `tool_result` text, else
 * nothing; a background launch notice or any other shape is no report.
 */
function handBackReport(toolUseResult: unknown, content: unknown): string | null {
  const text =
    toolUseResult === undefined
      ? resultText(content)
      : (() => {
          const completed = CompletedHandBack.safeParse(toolUseResult);
          return completed.success ? resultText(completed.data.content) : "";
        })();
  const report = text.trim();
  return report === "" ? null : report;
}

/** Absolute paths at or under `root`: the root, then any run of characters a path in prose holds. */
function absolutePathsUnder(root: string): RegExp {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=$|[/\\s\`'".,:;)\\]])[^\\s\`'"()<>\\[\\]]*`, "g");
}

/** Splits a Bash command into words, dropping one level of single or double quotes. */
function commandWords(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
}

/**
 * The orchestrator's stream parser: it turns the stream-json lines into `line`, `ticket_started`
 * and `ticket_merged` events, in stream order. A line that is not JSON, or not a shape it knows, is
 * skipped: one bad line is never a run failure.
 */
export function createImplementStreamParser(
  context: ImplementStreamContext,
  onEvent: (event: ImplementEvent) => void,
): ImplementStreamParser {
  const pinned = new Set(context.tickets.map((ticket) => ticket.id));
  /** Each tied subagent's `tool_use` id, to its ticket. */
  const tiedSubagents = new Map<string, string>();
  const started = new Set<string>();
  const merged = new Set<string>();
  /** The latest report of each ticket's implementer. */
  const reports = new Map<string, string>();
  /** Each orchestrator `git merge` call's `tool_use` id, to the pinned tickets its branches name. */
  const pendingMerges = new Map<string, string[]>();
  let buffer = "";

  const ticketOfDescription = (description: string): string | null => {
    for (const match of description.matchAll(/\bT[1-9][0-9]*\b/g)) {
      if (pinned.has(match[0])) return match[0];
    }
    return null;
  };

  /** The ticket of the subagent a line comes from; null for the orchestrator or an untied subagent. */
  const tieOf = (parent: string | null): string | null => {
    if (parent === null) return null;
    const ticket = tiedSubagents.get(parent);
    if (ticket === undefined) return null;
    return ticket;
  };

  const ticketOfBranch = (word: string): string | null => {
    const prefix = `${context.branch}-t`;
    if (!word.startsWith(prefix)) return null;
    const suffix = word.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(suffix)) return null;
    const ticket = `T${suffix}`;
    return pinned.has(ticket) ? ticket : null;
  };

  /**
   * A path relative to the ticket's worktree, else to the run worktree, else to the run folder
   * (the pinned spec and tickets files), else as written.
   */
  const worktreeRelative = (path: string, ticket: string): string => {
    if (!isAbsolute(path)) return path;
    const ticketWorktree = join(context.runDir, "tickets", `t${ticket.slice(1)}`);
    for (const root of [ticketWorktree, context.worktreePath, context.runDir]) {
      if (path.startsWith(`${root}${sep}`)) return relative(root, path);
    }
    return path;
  };

  /**
   * A report with every absolute path under the run folder made relative as `worktreeRelative`
   * does: the paths are gone once cleanup deletes the worktrees. A trailing slash or sentence
   * punctuation stays outside the path.
   */
  const relativeReport = (report: string, ticket: string): string =>
    report.replace(absolutePathsUnder(context.runDir), (token) => {
      const path = token.replace(/[/.,:;]+$/, "");
      const tail = token.slice(path.length);
      const shown = worktreeRelative(path, ticket);
      return shown === path ? token : `${shown}${tail}`;
    });

  const fileActionText = (name: string, input: unknown, ticket: string): string | null => {
    const file = FilePath.safeParse(input);
    const pattern = Pattern.safeParse(input);
    switch (name) {
      case "Read":
        return file.success ? `Read \`${worktreeRelative(file.data.file_path, ticket)}\`` : null;
      case "Edit":
        return file.success ? `Edited \`${worktreeRelative(file.data.file_path, ticket)}\`` : null;
      case "Write":
        return file.success ? `Wrote \`${worktreeRelative(file.data.file_path, ticket)}\`` : null;
      case "Glob":
        return pattern.success ? `Listed \`${pattern.data.pattern}\`` : null;
      case "Grep":
        return pattern.success ? `Searched for \`${pattern.data.pattern}\`` : null;
      default:
        return null;
    }
  };

  const emitLine = (who: "orchestrator" | "implementer", ticket: string | null, raw: string) => {
    const text = raw.trim();
    if (text === "") return;
    onEvent({ kind: "line", who, ticket, text: cutLineText(text) });
  };

  const onAssistant = (line: MessageLine): void => {
    const parent = line.parent_tool_use_id;
    const ticket = tieOf(parent);
    for (const item of line.message.content) {
      const text = TextBlock.safeParse(item);
      if (text.success) {
        emitLine(ticket === null ? "orchestrator" : "implementer", ticket, text.data.text);
        continue;
      }
      const toolUse = ToolUseBlock.safeParse(item);
      if (!toolUse.success) continue;
      const { id, name, input } = toolUse.data;
      if (SUBAGENT_TOOLS.has(name)) {
        const description = Description.safeParse(input);
        if (!description.success) continue;
        const named = ticketOfDescription(description.data.description);
        if (named === null) continue;
        tiedSubagents.set(id, named);
        if (!started.has(named)) {
          started.add(named);
          onEvent({ kind: "ticket_started", ticket: named });
        }
        continue;
      }
      if (ticket !== null) {
        const action = fileActionText(name, input, ticket);
        if (action !== null) emitLine("implementer", ticket, action);
        continue;
      }
      if (parent === null && name === "Bash") {
        const command = Command.safeParse(input);
        if (!command.success) continue;
        const words = commandWords(command.data.command);
        if (words[0] !== "git" || !words.includes("merge")) continue;
        const tickets = words.flatMap((word) => {
          const named = ticketOfBranch(word);
          return named === null ? [] : [named];
        });
        if (tickets.length > 0) pendingMerges.set(id, tickets);
      }
    }
  };

  const onUser = (line: MessageLine): void => {
    for (const item of line.message.content) {
      const result = ToolResultBlock.safeParse(item);
      if (!result.success) continue;
      const { tool_use_id: toolUseId, content, is_error: isError } = result.data;
      const failed = isError === true;
      const mergeTickets = pendingMerges.get(toolUseId);
      if (mergeTickets !== undefined) {
        pendingMerges.delete(toolUseId);
        if (failed) continue;
        for (const ticket of mergeTickets) {
          if (merged.has(ticket)) continue;
          merged.add(ticket);
          const report = reports.get(ticket);
          onEvent({
            kind: "ticket_merged",
            ticket,
            summary:
              report === undefined
                ? null
                : cutAgentText(relativeReport(report, ticket), RUN_TICKET_SUMMARY_MAX_LENGTH),
          });
        }
        continue;
      }
      const ticket = tiedSubagents.get(toolUseId);
      if (ticket === undefined || failed) continue;
      const report = handBackReport(line.tool_use_result, content);
      if (report !== null) reports.set(ticket, report);
    }
  };

  const onLine = (raw: string): void => {
    if (raw.trim() === "") return;
    const json = parseJson(raw);
    if (!json.ok) return;
    const notification = TaskNotification.safeParse(json.value);
    if (notification.success) {
      const ticket = tiedSubagents.get(notification.data.tool_use_id);
      const report = notification.data.summary.trim();
      if (ticket !== undefined && report !== "") reports.set(ticket, report);
      return;
    }
    const message = MessageLine.safeParse(json.value);
    if (!message.success) return;
    if (message.data.type === "assistant") onAssistant(message.data);
    else onUser(message.data);
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(raw);
        newline = buffer.indexOf("\n");
      }
    },
    end() {
      const raw = buffer;
      buffer = "";
      onLine(raw);
    },
  };
}
