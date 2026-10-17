import { Link } from "@tanstack/react-router";
import { HatchStage } from "@zenorm/contracts";
import type { ActivityLine, MapOverviewDetail, Stage } from "@zenorm/contracts";
import { ArrowRight, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HatchComposer } from "@/components/hatch/HatchComposer";
import { useHatch } from "@/components/hatch/HatchProvider";
import { MessageEntry, ReplyEntry, ReplyingLine } from "@/components/hatch/HatchEntries";
import { ColumnHead } from "@/components/WorkspaceColumns";
import {
  filterStream,
  replyingMessages,
  streamEntries,
  type StreamEntry,
  type StreamFilter,
} from "@/lib/hatch";
import { specLineLink, withoutSpecTitle } from "@/lib/activity";
import { formatMoment, stageName } from "@/lib/map";

function isFilter(value: string): value is StreamFilter {
  return value === "map" || value === "stage";
}

/** Whether the stage has the escape hatch: every stage but Delivery (S7b-17). */
function isHatchStage(stage: Stage): stage is HatchStage {
  return HatchStage.safeParse(stage).success;
}

/**
 * The Activity column (spec D9, slice 7b D7): the map's stream, newest last, filtered to the whole
 * map or the viewed stage. Activity lines link their stage, and a line that carries a waypoint
 * links "Open the waypoint" (slice 6a D11); messages sent through the hatch and the agent's replies
 * sit among them by time. A working stage adds a pulsing line, the agent's next action in plain
 * words, and a message the agent is on adds "The agent is replying.". Nothing here asks you for
 * anything; under the stream sits the escape hatch, on the stages that have one (every stage but
 * Delivery, S7b-17). `specNumber` is the spec on screen a message names (the demo's `aboutSpec`).
 * It fills whatever `WorkspaceColumns` puts it in: the sticky column, or the sheet below the
 * columns breakpoint.
 */
export function ActivityColumn({
  detail,
  stage,
  specNumber,
  aside,
}: {
  detail: MapOverviewDetail;
  stage: Stage;
  specNumber: number | null;
  /** The `map.workspace.aside` slot, first in the column (S9-18, L36). */
  aside: ReactNode;
}) {
  const [filter, setFilter] = useState<StreamFilter>("map");
  const viewport = useRef<HTMLDivElement>(null);
  const entries = filterStream(streamEntries(detail.activity, detail.messages), filter, stage);
  const working = detail.status.next.filter(
    (next) => next.who === "agent" && (filter === "map" || next.stage === stage),
  );
  const replying = replyingMessages(detail.messages, filter, stage);
  const { open } = useHatch();

  // The stream opens at its end. Opening the composer shortens the stream, so it scrolls to its
  // end then too (demo `ActivityLog.tsx` scrolls on `composing`, L162 (2)).
  useEffect(() => {
    const element = viewport.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries.length, working.length, replying.length, open]);

  return (
    <aside aria-label="Activity" className="flex h-full min-h-0 flex-col">
      {aside}
      <ColumnHead title="Activity">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Show activity for"
              className="-mr-1 font-medium"
            >
              {filter === "map" ? "Whole map" : `${stageName(stage)} only`}
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => {
                if (!isFilter(value)) {
                  throw new Error(`Unknown activity filter ${value}`);
                }
                setFilter(value);
              }}
            >
              <DropdownMenuRadioItem value="map">Whole map</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="stage">{stageName(stage)} only</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ColumnHead>

      <div className="relative min-h-0 flex-1">
        <ScrollArea viewportRef={viewport} type="auto" className="h-full">
          <ol className="grid content-start gap-2.5 px-3.5 pt-7 pb-3.5">
            {entries.length === 0 && working.length === 0 && replying.length === 0 && (
              <li className="text-[13px] text-faint">Nothing here yet.</li>
            )}
            {entries.map((entry) => (
              <Entry key={entryKey(entry)} entry={entry} detail={detail} />
            ))}
            {working.map((next) => (
              <li
                key={`working-${next.stage}`}
                className="flex items-center gap-2 text-xs text-work"
              >
                <span className="pulse-soft size-1.5 shrink-0 bg-work-dot" />
                {next.headline}
              </li>
            ))}
            {replying.map((message) => (
              <ReplyingLine key={`replying-${message.id}`} />
            ))}
          </ol>
        </ScrollArea>
        {/*
         * The cue that the stream continues above its opening end: the line at the top dissolves
         * under a fade as tall as the list's top padding, so an unscrolled first line clears it
         * and a scrolled one fades out rather than being sliced (UX review P2-9).
         */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-7 bg-linear-to-b from-card from-15% to-transparent"
        />
      </div>
      {isHatchStage(stage) && (
        <HatchComposer mapId={detail.map.id} stage={stage} specNumber={specNumber} />
      )}
    </aside>
  );
}

function entryKey(entry: StreamEntry): string {
  switch (entry.kind) {
    case "event":
      return `${entry.at}-${entry.line.stage}-${entry.line.text}`;
    case "message":
      return `message-${entry.message.id}`;
    case "reply":
      return `reply-${entry.message.id}`;
  }
}

function Entry({ entry, detail }: { entry: StreamEntry; detail: MapOverviewDetail }) {
  switch (entry.kind) {
    case "event":
      return <EventLine line={entry.line} detail={detail} />;
    case "message":
      return <MessageEntry message={entry.message} />;
    case "reply":
      return <ReplyEntry message={entry.message} reply={entry.reply} at={entry.at} />;
  }
}

/**
 * The titles a line of a one-spec map may quote, so the column can leave them out (UX review
 * P2-9): every Spec, Tickets and Delivery line of such a map names the same spec, under
 * the title of whichever revision was latest when it was written, and the top bar already names
 * the map. Nothing for an Idea or Wayfinding line, which quotes waypoints, or on a map with
 * several specs, where the title tells them apart.
 */
function singleSpecTitles(line: ActivityLine, detail: MapOverviewDetail): string[] {
  const [spec] = detail.specs;
  if (spec === undefined || detail.specs.length !== 1) {
    return [];
  }
  if (line.stage === "idea" || line.stage === "wayfinding") {
    return [];
  }
  return [...new Set(spec.revisions.map((revision) => revision.content.title))];
}

/**
 * One activity line: its stage and time, its text, and "Open the waypoint" when it carries one;
 * a line that carries a spec links "Open the revision" (a Spec line, the demo's `writeRevision`,
 * L159 (a)), "Open the tickets" (a Tickets line, slice 7c D10) or "Open the run" (a
 * Delivery line, slice 8 D13).
 */
function EventLine({ line, detail }: { line: ActivityLine; detail: MapOverviewDetail }) {
  const mapId = detail.map.id;
  const link = specLineLink(line);
  const text = singleSpecTitles(line, detail).reduce(
    (words, title) => withoutSpecTitle(words, title),
    line.text,
  );
  return (
    <li className="grid gap-[3px] text-[13px]">
      <span className="micro text-muted-foreground">
        <Link
          to="/maps/$mapId/$stage"
          params={{ mapId, stage: line.stage }}
          className="hover:text-primary"
        >
          {stageName(line.stage)}
        </Link>{" "}
        · <time dateTime={line.at}>{formatMoment(line.at)}</time>
      </span>
      <span className="text-muted-foreground">{text}</span>
      {line.waypoint !== null && (
        <Link
          to="/maps/$mapId/wayfinding/$number"
          params={{ mapId, number: line.waypoint }}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ArrowRight className="size-3" aria-hidden="true" />
          Open the waypoint
        </Link>
      )}
      {link !== null && (
        <Link
          to="/maps/$mapId/$stage/$specNumber"
          params={{ mapId, stage: link.stage, specNumber: link.specNumber }}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ArrowRight className="size-3" aria-hidden="true" />
          {link.label}
        </Link>
      )}
    </li>
  );
}
