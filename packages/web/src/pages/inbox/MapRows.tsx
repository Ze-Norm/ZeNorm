import { Link } from "@tanstack/react-router";
import type { MapOverview, NextAction } from "@zenorm/contracts";
import { ArrowRight } from "lucide-react";

import { MiniRail } from "@/components/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { mapName } from "@/lib/map";
import { cn } from "@/lib/utils";

/** A `you` action's button label as core names it; a missing one is a programmer error. */
function labelOf(next: NextAction): string {
  if (next.label === null) {
    throw new Error(`A ${next.who} action on ${next.stage} has no button label`);
  }
  return next.label;
}

/** The map's first next action: its headline and the stage its row links. */
function firstNext(overview: MapOverview): { first: NextAction; rest: NextAction[] } {
  const [first, ...rest] = overview.status.next;
  if (first === undefined) {
    throw new Error(`Map ${overview.map.id} has no next action`);
  }
  return { first, rest };
}

/**
 * The map a row opens: a wait on another map's spec opens the map that
 * holds it, any other action this map.
 */
function targetMap(overview: MapOverview, first: NextAction): string {
  if (first.who !== "another-map") {
    return overview.map.id;
  }
  if (first.onMap === null) {
    throw new Error(`Map ${overview.map.id} waits on another map with no map named`);
  }
  return first.onMap;
}

/**
 * Map rows: the name with its project label, the first next action as the headline, the mini rail,
 * and an action linking the stage that action is on. Below `sm` the name block takes the row's
 * width and the rail and the action share a second line.
 */
export function MapRows({
  overviews,
  needsYou,
  hideProject,
}: {
  overviews: readonly MapOverview[];
  needsYou: boolean;
  hideProject: boolean;
}) {
  return (
    <div className="grid border border-hair-strong bg-card">
      {overviews.map((overview) => {
        const { first, rest } = firstNext(overview);
        const alsoYours = rest.filter((action) => action.who === "you").length;
        const params = { mapId: targetMap(overview, first), stage: first.stage };
        return (
          <div
            key={overview.map.id}
            className={cn(
              "grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 hover:bg-secondary sm:grid-cols-[1fr_116px_190px] sm:gap-5",
              needsYou && "shadow-[inset_3px_0_0_var(--primary)]",
            )}
          >
            <Link
              to="/maps/$mapId/$stage"
              params={params}
              className="col-span-2 min-w-0 sm:col-span-1"
              title={first.detail === null ? first.headline : `${first.headline} ${first.detail}`}
            >
              {/* A real title runs past one line; two show before it is cut. */}
              <div className="flex items-start gap-2">
                <span className="line-clamp-2 min-w-0 flex-1 font-semibold">
                  {mapName(overview.map)}
                </span>
                {!hideProject && (
                  <Badge variant="secondary" className="mt-0.5 shrink-0">
                    {overview.project.name}
                  </Badge>
                )}
              </div>
              {/* The headline on its own line, the detail under it. */}
              <div className="truncate text-[12.5px] text-muted-foreground">
                {first.headline}
                {alsoYours > 0 && (
                  <span className="text-primary"> +{alsoYours} more waiting on you</span>
                )}
              </div>
              {first.detail !== null && (
                <div className="truncate text-[12px] text-faint">{first.detail}</div>
              )}
            </Link>
            <MiniRail stages={overview.status.stages} />
            {first.who === "you" ? (
              <Button asChild variant="outline" size="sm" className="justify-self-end">
                <Link to="/maps/$mapId/$stage" params={params}>
                  {labelOf(first)} <ArrowRight />
                </Link>
              </Button>
            ) : (
              <Link
                to="/maps/$mapId/$stage"
                params={params}
                className="justify-self-end text-right text-[13px] text-muted-foreground hover:text-foreground"
              >
                {first.who === "agent" ? "Watch" : "Open"} →
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
