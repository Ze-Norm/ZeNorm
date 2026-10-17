import { SpecStageLink } from "@/components/SpecStageLink";
import type { DeliveryRun, MapSpec } from "@zenorm/contracts";

import { Badge } from "@/components/ui/badge";
import { formatMoment } from "@/lib/map";
import { cn } from "@/lib/utils";
import { stateWord } from "@/pages/stages/delivery/words";

type BadgeVariant = "ok" | "work" | "bad" | "secondary";

function stateBadge(run: DeliveryRun): BadgeVariant {
  switch (run.state) {
    case "passed":
      return "ok";
    case "running":
      return "work";
    case "interrupted":
    case "blocked":
    case "failed":
      return "bad";
    case "cancelled":
      return "secondary";
  }
}

/**
 * "Runs of this spec from this map" (slice 8 D9, the demo's run list): every run of the spec,
 * newest first, each opened by `?run=`; the page shows it once the spec has a second run.
 */
export function RunList({
  mapId,
  specs,
  specNumber,
  runs,
  shown,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  specNumber: number;
  runs: readonly DeliveryRun[];
  shown: number;
}) {
  return (
    <section aria-labelledby="runs-heading" className="grid gap-2">
      <h2 id="runs-heading" className="font-display text-base font-semibold tracking-[-0.015em]">
        Runs of this spec from this map
      </h2>
      <ul className="grid border border-hair-strong bg-card">
        {runs.map((run) => {
          const current = run.number === shown;
          return (
            <li key={run.id} className="border-t border-border first:border-t-0">
              <SpecStageLink
                mapId={mapId}
                specs={specs}
                stage="delivery"
                specNumber={specNumber}
                search={{ run: run.number }}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 px-3.5 py-2 text-[13px] hover:bg-secondary",
                  current && "bg-secondary",
                )}
              >
                <span className="font-medium">Run {run.number}</span>
                <span className="flex-1 text-muted-foreground">
                  started {formatMoment(run.startedAt)}
                  {current && " · shown above"}
                </span>
                <Badge variant={stateBadge(run)}>{stateWord(run)}</Badge>
              </SpecStageLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
