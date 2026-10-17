import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunEvent, SpecRun } from "@zenorm/contracts";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ColumnHead } from "@/components/WorkspaceColumns";
import { agoWords, lineClock } from "@/lib/delivery";
import { formatMoment } from "@/lib/map";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc";
import { actorLabel } from "@/pages/stages/delivery/ticket-status";
import { shownQueryError } from "@/lib/query-errors";

/** The time since `at`, counted up each second while `live`. */
function useAgo(at: string, live: boolean): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) {
      return;
    }
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [live]);
  return agoWords(now - Date.parse(at));
}

/** "last event 12s ago": how you tell a working run from a stuck one. */
function Liveness({ last }: { last: RunEvent }) {
  const ago = useAgo(last.at, true);
  return (
    <span data-testid="run-liveness" className="micro flex items-center gap-1.5 text-work">
      <span className="pulse-soft size-1.5 bg-work-dot" aria-hidden /> last event {ago}
    </span>
  );
}

/**
 * One line: its actor, the ticket it belongs to as a link, its time and its text. A code span in
 * the text (a path, a search pattern) breaks anywhere rather than run past the column.
 */
function Line({
  event,
  mapId,
  specNumber,
  run,
  executor,
}: {
  event: RunEvent;
  mapId: string;
  specNumber: number;
  run: number;
  /** The run's executor, which names its own lines. */
  executor: string;
}) {
  const host = event.who === "zenorm";
  return (
    <li
      data-who={event.who}
      className={cn(
        "grid gap-[3px] border-l-2 pl-2.5 text-[13px] [&_code]:wrap-anywhere",
        host ? "border-hair-strong" : "border-executor",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-[11px] font-semibold",
            host ? "text-muted-foreground" : "text-executor-fg",
          )}
        >
          {actorLabel(event.who, executor)}
          {event.ticket !== null && (
            <>
              {" · "}
              <Link
                to="/maps/$mapId/delivery/$specNumber/$ticketId"
                params={{ mapId, specNumber, ticketId: event.ticket }}
                search={{ run }}
                className="hover:underline"
              >
                {event.ticket}
              </Link>
            </>
          )}
        </span>
        <time dateTime={event.at} className="micro text-muted-foreground">
          {lineClock(event.at)}
        </time>
      </div>
      <div className={cn(host && "text-muted-foreground")}>
        <AgentText text={event.text} />
      </div>
    </li>
  );
}

/**
 * Run activity: the run's major lines, ZeNorm's, the orchestrator's and the reviewer's, oldest
 * first, in the Activity column's place. Implementer lines (each file read, search and edit) stay
 * on their ticket's execution page. Lines come only from `delivery.activity`, refetched by the
 * live layer on each change. While it works, the header counts the time since the last line.
 * There is no hatch: Cancel run is the only control. It fills whatever `WorkspaceColumns` puts
 * it in.
 */
export function RunActivity({
  mapId,
  specNumber,
  run,
  aside,
}: {
  mapId: string;
  specNumber: number;
  run: SpecRun;
  /** The `map.workspace.aside` slot, first in the column. */
  aside: ReactNode;
}) {
  const recorded = run.tickets !== null;
  const active = run.endedAt === null;
  // Nothing runs an interrupted run, so it never reads as live.
  const interrupted = run.state === "interrupted";
  const activity = useQuery(
    orpc.delivery.activity.queryOptions({
      input: { runId: run.id },
      enabled: recorded,
    }),
  );
  const all = activity.data;
  // Liveness counts every line, so a run whose implementers are busy still reads as working.
  const last = all?.at(-1);
  const events = all?.filter((event) => event.who !== "implementer");
  const viewport = useRef<HTMLDivElement>(null);
  const count = events === undefined ? 0 : events.length;

  useEffect(() => {
    const element = viewport.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [run.id, count]);

  // A fetch failure keeps the cached lines; the live Alert says why.
  const activityError = shownQueryError(activity.error);
  if (activityError !== null) {
    // `delivery_run_not_found` for a run the overview just listed is not an expected refusal.
    throw activityError;
  }

  return (
    <aside
      aria-label={`Run ${String(run.number)} activity`}
      className="flex h-full min-h-0 flex-col"
    >
      {aside}
      <ColumnHead title={`Run ${String(run.number)} activity`}>
        {interrupted ? (
          <span className="micro text-muted-foreground">interrupted</span>
        ) : run.endedAt === null ? (
          last !== undefined && <Liveness last={last} />
        ) : (
          <span className="micro text-muted-foreground">ended {formatMoment(run.endedAt)}</span>
        )}
      </ColumnHead>

      {recorded ? (
        <div className="relative min-h-0 flex-1">
          <ScrollArea viewportRef={viewport} type="auto" className="h-full">
            <ol className="grid content-start gap-3 px-3.5 pt-7 pb-3.5" aria-label="Lines">
              {events?.map((event) => (
                <Line
                  key={event.seq}
                  event={event}
                  mapId={mapId}
                  specNumber={specNumber}
                  run={run.number}
                  executor={run.executor}
                />
              ))}
            </ol>
          </ScrollArea>
          {/* The fade the Activity column has: a line at the top dissolves rather than being sliced. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-7 bg-linear-to-b from-card from-15% to-transparent"
          />
        </div>
      ) : (
        <p className="flex-1 p-3.5 text-[13px] text-muted-foreground">
          This run&apos;s activity was not recorded.
        </p>
      )}

      {/* A run from before `0010` that has ended kept its worktree, so it has no record line. */}
      {(active || recorded) && (
        <div className="grid shrink-0 gap-1 border-t border-border p-3 pb-14 text-xs text-muted-foreground">
          <span>
            {interrupted
              ? "ZeNorm restarted while this run was active, so nothing is running it. Cancel run ends it."
              : active
                ? "You can watch a run but not message it. Cancel run stops it."
                : "The record of this run. Its branch is kept; its worktrees are gone."}
          </span>
        </div>
      )}
    </aside>
  );
}
