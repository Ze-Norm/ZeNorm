import { Link } from "@tanstack/react-router";
import type { RunTicket, SpecRun, TicketContent } from "@zenorm/contracts";
import { Check, ChevronRight, ListChecks, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { Badge } from "@/components/ui/badge";
import { foldsMerged, inStatusOrder, reportFirstLine, shownTicketStatus } from "@/lib/delivery";
import type { ClosingMark } from "@/pages/stages/delivery/steps";
import { StatusBadge, StatusLine } from "@/pages/stages/delivery/ticket-status";
import { plural } from "@/pages/stages/delivery/words";

/** Where a run's ticket rows link: the ticket's execution page in the shown run (D10). */
export interface RunTicketLinks {
  mapId: string;
  specNumber: number;
  run: number;
}

/**
 * A ticket in the run (the demo's `RunTicket`): where it stands, as core derives it, and the line
 * that says why. The row opens the ticket's execution page in the shown run (`?run=`, deviation 9).
 */
function RunTicketRow({
  ticket,
  row,
  runState,
  executor,
  links,
}: {
  ticket: TicketContent;
  row: RunTicket;
  runState: SpecRun["state"];
  /** The run's executor, which names its own latest line (CR9b-6). */
  executor: string;
  links: RunTicketLinks;
}) {
  const status = shownTicketStatus({ state: runState }, row.status);
  // A merged ticket's row shows its report's first line; the ticket's page, which the row opens,
  // shows the whole report.
  const rowStatus =
    status.state === "merged" && status.summary !== null
      ? { ...status, summary: reportFirstLine(status.summary) }
      : status;
  return (
    <li
      data-ticket={ticket.id}
      data-state={status.state}
      className="border-t border-border first:border-t-0"
    >
      <Link
        to="/maps/$mapId/delivery/$specNumber/$ticketId"
        params={{ mapId: links.mapId, specNumber: links.specNumber, ticketId: ticket.id }}
        search={{ run: links.run }}
        className="grid w-full grid-cols-[28px_1fr_auto_14px] items-start gap-x-2 py-2.5 pr-3.5 pl-3.5 text-left hover:bg-secondary sm:pl-[58px]"
      >
        <span className="font-mono text-[11px] leading-[1.8] text-muted-foreground">
          {ticket.id}
        </span>
        <span className="grid gap-0.5">
          <span className="text-[13.5px]">
            <AgentText text={ticket.title} />
          </span>
          <span className="text-[12.5px]">
            <StatusLine status={rowStatus} executor={executor} />
          </span>
        </span>
        <span className="flex items-center gap-2">
          {row.status.state === "merged" && (
            <code className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
              {row.status.commit.slice(0, 7)}
            </code>
          )}
          <StatusBadge status={status} failing={row.failing} />
        </span>
        <ChevronRight className="mt-0.5 size-3.5 text-faint" aria-hidden />
      </Link>
    </li>
  );
}

function ticketOf(tickets: readonly TicketContent[], id: string): TicketContent {
  const ticket = tickets.find((entry) => entry.id === id);
  if (ticket === undefined) {
    throw new Error(`The run's ticket set has no ticket ${id}`);
  }
  return ticket;
}

/**
 * The run's tickets grouped by where they stand (the demo's `RunTickets`): live work first, merged
 * last; merged tickets fold into one line in a wide set while the run works.
 */
export function RunTickets({
  rows,
  tickets,
  runState,
  executor,
  links,
}: {
  rows: readonly RunTicket[];
  tickets: readonly TicketContent[];
  runState: SpecRun["state"];
  executor: string;
  links: RunTicketLinks;
}) {
  const running = runState === "running";
  const [showMerged, setShowMerged] = useState(false);
  const ordered = inStatusOrder(rows);
  const merged = ordered.filter((row) => row.status.state === "merged");
  const fold = foldsMerged({
    running,
    tickets: rows.length,
    merged: merged.length,
    shown: showMerged,
  });
  const shown = fold ? ordered.filter((row) => row.status.state !== "merged") : ordered;
  return (
    <ol aria-label="Tickets">
      {shown.map((row) => (
        <RunTicketRow
          key={row.ticket}
          ticket={ticketOf(tickets, row.ticket)}
          row={row}
          runState={runState}
          executor={executor}
          links={links}
        />
      ))}
      {fold && (
        <li className="border-t border-border">
          <button
            type="button"
            onClick={() => {
              setShowMerged(true);
            }}
            className="flex w-full items-center gap-2 py-2 pr-3.5 pl-3.5 text-left text-[12.5px] text-muted-foreground hover:bg-secondary sm:pl-[44px]"
          >
            <Check className="size-3.5 text-ok" aria-hidden />
            {plural(merged.length, "ticket")} implemented:{" "}
            {merged.map((row) => row.ticket).join(", ")}. Show them.
          </button>
        </li>
      )}
    </ol>
  );
}

/**
 * The agent's own review and checks, the Implement step's last row (`closingMark`): after the last
 * merge the session reviews its branch and runs the checks itself, which can take minutes with no
 * ticket moving. ZeNorm reruns the checks in Verify whatever it reports.
 */
export function ClosingRow({ mark, checks }: { mark: ClosingMark; checks: number }) {
  const required = plural(checks, "required check");
  return (
    <div
      role="group"
      aria-label="Review and checks"
      data-mark={mark}
      className="grid grid-cols-[28px_1fr_auto_14px] items-start gap-x-2 border-t border-border py-2.5 pr-3.5 pl-3.5 sm:pl-[58px]"
    >
      <ListChecks className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
      <span className="grid gap-0.5">
        <span className="text-[13.5px]">Review and checks</span>
        <span className="text-[12.5px]">{closingLine(mark, required)}</span>
      </span>
      <ClosingBadge mark={mark} />
    </div>
  );
}

function closingLine(mark: ClosingMark, required: string): ReactNode {
  switch (mark) {
    case "waiting":
      return (
        <span className="text-muted-foreground">
          Once every ticket is implemented, the agent reviews the branch against the spec and runs
          the {required}.
        </span>
      );
    case "running":
      return (
        <span className="text-work">
          The agent is reviewing the branch against the spec and running the {required}.
        </span>
      );
    case "done":
      return (
        <span className="text-muted-foreground">
          The agent reviewed the branch and ran the {required}.
        </span>
      );
    case "stopped":
      return (
        <span className="text-muted-foreground">
          The run stopped while the agent was reviewing and checking.
        </span>
      );
  }
}

function ClosingBadge({ mark }: { mark: ClosingMark }) {
  switch (mark) {
    case "waiting":
      return <Badge variant="secondary">waiting</Badge>;
    case "running":
      return (
        <Badge variant="work">
          <Loader2 className="animate-spin" aria-hidden /> running
        </Badge>
      );
    case "done":
      return <Badge variant="ok">done</Badge>;
    case "stopped":
      return <Badge variant="secondary">stopped</Badge>;
  }
}

/** A run from before `0010` (D9): its tickets without status, under the note that says why. */
export function UnrecordedTickets({ tickets }: { tickets: readonly TicketContent[] }) {
  return (
    <>
      <p className="py-2.5 pr-3.5 pl-3.5 text-[12.5px] text-muted-foreground sm:pl-[44px]">
        Per-ticket progress was not recorded for this run.
      </p>
      <ol aria-label="Tickets">
        {tickets.map((ticket) => (
          <li
            key={ticket.id}
            className="grid grid-cols-[28px_1fr] items-baseline gap-x-2 border-t border-border py-2.5 pr-3.5 pl-3.5 sm:pl-[58px]"
          >
            <span className="font-mono text-[11px] text-muted-foreground">{ticket.id}</span>
            <span className="text-[13.5px]">
              <AgentText text={ticket.title} />
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
