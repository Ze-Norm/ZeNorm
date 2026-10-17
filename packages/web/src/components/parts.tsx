import { Link } from "@tanstack/react-router";
import type { MapStatus, Stage, StageTone } from "@zenorm/contracts";
import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { stageName } from "@/lib/map";
import { cn } from "@/lib/utils";

/**
 * Pieces shared by several screens, with the theme's classes. The next-action card family lives
 * in `NextActionCard.tsx`.
 */

/**
 * The mono micro label. It reads as information (an eyebrow, a count, a time), so it is
 * `text-muted-foreground`; pass `text-faint` for decoration only.
 */
export function Micro({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("micro text-muted-foreground", className)}>{children}</div>;
}

/**
 * A page's head at the top of the page's container (`WorkspacePage`): eyebrow, title and lede,
 * with `right` beside them at the right from `md` up (aligned to the top, so a tall panel never
 * pushes the title down) and under them below. The lede keeps a reading measure.
 * The eyebrow is one line from `sm`; below it wraps, since a cut line of nowrap text still
 * counts its whole width and would push the head past a phone's edge.
 */
export function PageHead({
  eyebrow,
  title,
  lede,
  right,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0 flex-1">
        <Micro className="sm:truncate">{eyebrow}</Micro>
        <h1 className="mt-1.5 font-display text-[30px] leading-[1.1] font-bold tracking-[-0.035em]">
          {title}
        </h1>
        {lede !== undefined && (
          <div className="mt-2 max-w-[80ch] text-[13.5px] text-muted-foreground">{lede}</div>
        )}
      </div>
      {right !== undefined && <div className="min-w-0 shrink-0 md:pt-0.5">{right}</div>}
    </header>
  );
}

export function SectionHead({
  n,
  title,
  right,
}: {
  n?: string;
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-ink-line pb-2">
      {n !== undefined && <span className="w-[22px] font-mono text-[11px] text-faint">{n}</span>}
      <h2 className="flex-1 font-display text-[17px] font-bold tracking-[-0.02em]">{title}</h2>
      {right}
    </div>
  );
}

/** A stage tone's text colour (one map for every status line). */
export const TONE_TEXT: Record<StageTone, string> = {
  done: "text-ok",
  "needs-you": "text-primary",
  working: "text-work",
  idle: "text-muted-foreground",
  later: "text-faint",
};

const toneUnderline: Record<StageTone, string> = {
  done: "border-b-ok-dot",
  "needs-you": "border-b-primary-fill",
  working: "border-b-work-dot",
  idle: "border-b-hair-strong",
  later: "border-b-border",
};

/**
 * The five-stage rail: links that show each stage's status. It adds no gates. It sticks under the
 * top bar (and the live alert while the stream is down) at `--stage-rail` high (the workspace
 * column's height counts on it). Each stage's line is on one line, cut with an ellipsis; below `md`
 * only the number and name show, and below `sm` (a phone) each cell stacks its name under its
 * number, since five names beside their numbers do not fit a phone's width. A phone's cell is flat:
 * the number without its box, no fill, and the tone in the number's colour and the underline; the
 * viewed cell is marked by its underline's thicker bar. From `lg` the Delivery cell is wider, since
 * its lines are the composed ones (a run's name and progress, a blocker's sentence). A cell whose
 * line is cut or hidden carries the whole line in its tooltip; one whose line is whole has none.
 */
export function StageRail({
  mapId,
  stages,
  viewing,
}: {
  mapId: string;
  stages: MapStatus["stages"];
  viewing: Stage | null;
}) {
  return (
    <nav
      aria-label="Stages"
      className="sticky top-[calc(var(--top-bar)+var(--live-alert))] z-20 grid h-(--stage-rail) grid-cols-5 gap-0.5 border-b border-border bg-card px-1 pt-1 sm:gap-1.5 sm:px-2 sm:pt-2.5 md:px-4 lg:grid-cols-[1fr_1fr_1fr_1fr_1.5fr]"
    >
      {stages.map((status, i) => (
        <StageCell
          key={status.stage}
          mapId={mapId}
          status={status}
          number={i + 1}
          active={viewing === status.stage}
        />
      ))}
    </nav>
  );
}

/**
 * Whether the element's text is cut (an ellipsis) or not shown at all (`display: none`), kept
 * current as it resizes with the viewport.
 */
function useClipped(element: RefObject<HTMLElement | null>, text: string): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const line = element.current;
    if (line === null) {
      throw new Error("The stage line has no element to measure");
    }
    const measure = () => {
      setClipped(line.clientWidth === 0 || line.scrollWidth > line.clientWidth);
    };
    measure();
    // Its width follows the cell's, and drops to nothing below `md`; both change what is cut.
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => {
      observer.disconnect();
    };
  }, [element, text]);
  return clipped;
}

function StageCell({
  mapId,
  status,
  number,
  active,
}: {
  mapId: string;
  status: MapStatus["stages"][number];
  number: number;
  active: boolean;
}) {
  const needs = status.tone === "needs-you";
  const line = useRef<HTMLSpanElement>(null);
  const clipped = useClipped(line, status.line);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/maps/$mapId/$stage"
          params={{ mapId, stage: status.stage }}
          activeOptions={{ includeSearch: false }}
          className={cn(
            "grid min-w-0 items-center border-b-2 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            // A phone's cell: the number centred over the name, flat. From `sm`: the number beside
            // the name and the line, at the left, the stage that needs you filled.
            "grid-cols-1 content-center justify-items-center gap-y-0.5 text-center",
            "sm:grid-cols-[auto_1fr] sm:content-normal sm:justify-items-start sm:gap-x-2.5 sm:gap-y-0 sm:px-2.5 sm:pt-[7px] sm:pb-[9px] sm:text-left",
            toneUnderline[status.tone],
            needs
              ? "text-primary sm:bg-primary-fill sm:text-primary-fill-foreground"
              : "sm:hover:bg-secondary",
            active && !needs && "sm:bg-secondary",
            active &&
              "text-foreground max-sm:border-b-current max-sm:shadow-[inset_0_-1px_0_currentColor] sm:shadow-[inset_0_3px_0_var(--ink-line)]",
            active && needs && "text-primary",
          )}
        >
          <span
            className={cn(
              "grid h-4 place-items-center font-mono text-[11px] font-semibold sm:row-span-2 sm:size-[18px] sm:border",
              status.tone === "done" && "text-ok sm:border-ok-dot sm:bg-ok-dot sm:text-white",
              needs &&
                "text-primary sm:border-primary-fill-foreground/60 sm:text-primary-fill-foreground",
              status.tone === "working" && "text-work sm:border-work-dot",
              (status.tone === "idle" || status.tone === "later") &&
                "text-faint sm:border-hair-strong",
            )}
          >
            {status.tone === "done" ? <Check className="size-3" strokeWidth={3} /> : number}
          </span>
          <span
            className={cn(
              "w-full truncate font-display text-[11px] leading-tight font-semibold tracking-[-0.01em] min-[22.5rem]:text-xs sm:w-auto sm:text-[13px]",
              !active && !needs && status.tone !== "later" && "max-sm:text-muted-foreground",
              status.tone === "later" && "text-faint",
            )}
          >
            {stageName(status.stage)}
          </span>
          <span
            className={cn(
              "hidden min-w-0 items-center gap-1.5 text-[11.5px] md:flex",
              needs
                ? "text-primary-fill-foreground"
                : status.tone === "later"
                  ? "text-faint"
                  : "text-muted-foreground",
            )}
          >
            {status.tone === "working" && (
              <span className="pulse-soft size-1.5 shrink-0 bg-work-dot" />
            )}
            <span ref={line} className="truncate">
              {status.line}
            </span>
          </span>
        </Link>
      </TooltipTrigger>
      {clipped && (
        <TooltipContent side="bottom" align="start" className="max-w-xs">
          <span className="font-semibold">{stageName(status.stage)}</span> · {status.line}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

const miniTone: Record<StageTone, string> = {
  done: "bg-ok-dot",
  "needs-you": "bg-primary",
  working: "bg-work-dot",
  idle: "bg-hair-strong",
  later: "bg-border",
};

/** The stage rail in miniature, for Inbox and project rows. */
export function MiniRail({ stages }: { stages: MapStatus["stages"] }) {
  return (
    <div className="flex gap-1" aria-label="Stages">
      {stages.map((status) => (
        <span
          key={status.stage}
          title={`${stageName(status.stage)}: ${status.line}`}
          className={cn("h-[3px] w-5", miniTone[status.tone])}
        />
      ))}
    </div>
  );
}
