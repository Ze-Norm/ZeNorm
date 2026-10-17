import type { HatchMessageView } from "@zenorm/contracts";

import { AgentText } from "@/components/AgentText";
import { TryAgainButton } from "@/components/TryAgainButton";
import { stoppedRun } from "@/lib/hatch";
import { formatMoment, stageName } from "@/lib/map";

/**
 * A message sent through the hatch: right-aligned on ink, "You · <time>"; a stopped run shows
 * under it "The agent couldn't reply." with **Try again**.
 */
export function MessageEntry({ message }: { message: HatchMessageView }) {
  const stopped = stoppedRun(message);
  return (
    <li className="grid justify-items-end gap-1.5" aria-label="Your message">
      <div className="grid max-w-[85%] gap-0.5 bg-ink px-[11px] py-2 text-[13px] whitespace-pre-wrap text-ink-foreground">
        <span className="micro text-ink-foreground/70">
          You · <time dateTime={message.sentAt}>{formatMoment(message.sentAt)}</time>
        </span>
        {message.text}
      </div>
      {stopped !== null && (
        <div className="grid justify-items-end gap-1.5 text-xs text-bad">
          <span>The agent couldn't reply.</span>
          <TryAgainButton runId={stopped.runId} />
        </div>
      )}
    </li>
  );
}

/**
 * The agent's reply to a message: the agent rule, "Agent", "<Stage> · <time>" by the
 * message's stage; a refusal is a reply (core's sentence).
 */
export function ReplyEntry({
  message,
  reply,
  at,
}: {
  message: HatchMessageView;
  reply: string;
  at: string;
}) {
  return (
    <li
      className="grid gap-[3px] border-l-2 border-agent pl-2.5 text-[13px]"
      aria-label="Agent reply"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-agent-fg">Agent</span>
        <span className="micro text-faint">
          {stageName(message.stage)} · <time dateTime={at}>{formatMoment(at)}</time>
        </span>
      </div>
      <div>
        <AgentText text={reply} />
      </div>
    </li>
  );
}

/** The pulsing working line while the agent is on a message. */
export function ReplyingLine() {
  return (
    <li className="flex items-center gap-2 text-xs text-work">
      <span className="pulse-soft size-1.5 shrink-0 bg-work-dot" />
      The agent is replying.
    </li>
  );
}
