import { LOCAL_EXECUTOR } from "@zenorm/contracts";
import type { RunActor, TicketBlocker } from "@zenorm/contracts";
import { Loader2 } from "lucide-react";
import { Fragment } from "react";

import { AgentText } from "@/components/AgentText";
import { Badge } from "@/components/ui/badge";
import { midSentence, type ShownTicketStatus } from "@/lib/delivery";

/**
 * Where a ticket stands in a run, in words and as a badge, shared by the run's ticket rows, the
 * ticket execution page and Run activity.
 */

export const ACTOR: Record<RunActor, string> = {
  zenorm: "ZeNorm",
  orchestrator: "Orchestrator",
  implementer: "Implementer",
  reviewer: "Independent reviewer",
};

/**
 * Who a run's line is from, naming the run's executor on its own lines: `"local"`'s
 * orchestrator reads "Orchestrator", as before; another executor's lines read its name.
 */
export function actorLabel(who: RunActor, executor: string): string {
  if (who === "orchestrator" && executor !== LOCAL_EXECUTOR) {
    return executorLabel(executor);
  }
  return ACTOR[who];
}

/** A plugin executor, by name. */
export function executorLabel(executor: string): string {
  return `Executor "${executor}"`;
}

/**
 * "Starts when T1 has supplied …, and …." (the waiting line). A `supplies` line is the
 * agent's sentence: its inline markdown is rendered, its first letter lower-cased mid-sentence,
 * and its own closing period ends the line.
 */
function WaitingLine({ on }: { on: readonly TicketBlocker[] }) {
  const closed = on.at(-1)?.supplies.trimEnd().endsWith(".") === true;
  return (
    <>
      Starts when{" "}
      {on.map((blocker, index) => (
        <Fragment key={blocker.ticket}>
          {index > 0 && ", and "}
          {blocker.ticket} has supplied <AgentText text={midSentence(blocker.supplies)} />
        </Fragment>
      ))}
      {!closed && "."}
    </>
  );
}

/**
 * What a ticket's status says, in a line. The run's `executor` names its own latest line, as Run
 * activity does.
 */
export function StatusLine({ status, executor }: { status: ShownTicketStatus; executor: string }) {
  switch (status.state) {
    case "merged":
      return status.summary === null ? null : (
        <span className="text-muted-foreground">
          <AgentText text={status.summary} />
        </span>
      );
    case "implementing":
      // A started ticket with no line yet reads the starting sentence.
      return status.latest === null ? (
        <span className="text-work">Nothing blocks it. An implementer is being started.</span>
      ) : (
        <span className="text-work">
          {actorLabel(status.latest.who, executor)}: <AgentText text={status.latest.text} />
        </span>
      );
    case "waiting":
      return (
        <span className="text-muted-foreground">
          <WaitingLine on={status.on} />
        </span>
      );
    case "starting":
      return (
        <span className="text-muted-foreground">
          Nothing blocks it. An implementer is being started.
        </span>
      );
    case "not_delivered":
      return (
        <span className="text-muted-foreground">
          {status.started
            ? "It was being implemented when the run ended. Its work is discarded with the worktree."
            : "It hadn't started when the run ended."}
        </span>
      );
    case "interrupted":
      return (
        <span className="text-muted-foreground">
          {status.started
            ? "It was being implemented when ZeNorm restarted. Nothing is running it now."
            : "It hadn't started when ZeNorm restarted."}
        </span>
      );
  }
}

export function StatusBadge({
  status,
  failing,
}: {
  status: ShownTicketStatus;
  failing: readonly string[];
}) {
  if (failing.length > 0) {
    return <Badge variant="bad">fails {failing.join(", ")}</Badge>;
  }
  switch (status.state) {
    case "merged":
      return <Badge variant="ok">implemented</Badge>;
    case "implementing":
      return (
        <Badge variant="work">
          <Loader2 className="animate-spin" aria-hidden /> implementing
        </Badge>
      );
    case "waiting":
      return (
        <Badge variant="secondary">
          waits on {status.on.map((blocker) => blocker.ticket).join(", ")}
        </Badge>
      );
    case "starting":
      return <Badge variant="secondary">starting</Badge>;
    case "not_delivered":
      return <Badge variant="secondary">not delivered</Badge>;
    case "interrupted":
      return <Badge variant="secondary">interrupted</Badge>;
  }
}
