import { useNavigate } from "@tanstack/react-router";
import type { MapSpec } from "@zenorm/contracts";
import { ArrowRight } from "lucide-react";

import { Micro, TONE_TEXT } from "@/components/parts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  MAX_SPEC_TABS,
  nextWaiting,
  specStageStatus,
  specTally,
  type SpecStage,
} from "@/lib/specs";
import { cn } from "@/lib/utils";

/** A spec's name in the switcher: its title, "· revised" past revision 1 (D11). */
function specLabel(spec: MapSpec): string {
  const latest = spec.revisions.at(-1);
  if (latest === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no revision`);
  }
  return latest.revision > 1 ? `${spec.title} · revised` : spec.title;
}

/**
 * Switches between a map's specs within a stage (D11): none for one spec; tabs for two or three;
 * for more, the tally, a picker of every spec and **Next waiting on you**.
 */
export function SpecSwitcher({
  mapId,
  specs,
  stage,
  current,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  stage: SpecStage;
  /** The number of the spec shown. */
  current: number;
}) {
  const navigate = useNavigate();
  if (specs.length < 2) {
    return null;
  }
  function open(value: string) {
    void navigate({
      to: "/maps/$mapId/$stage/$specNumber",
      params: { mapId, stage, specNumber: Number(value) },
    });
  }

  if (specs.length > MAX_SPEC_TABS) {
    const tally = specTally(specs, stage);
    const waiting = nextWaiting(specs, stage, current);
    return (
      <nav aria-label="Specs" className="grid gap-1.5">
        <div className="micro flex flex-wrap gap-x-2 text-faint">
          <span>This map feeds {specs.length} specs</span>
          {tally.map((entry) => (
            <span key={entry.label} className={TONE_TEXT[entry.tone]}>
              · {entry.count} {entry.label}
            </span>
          ))}
        </div>
        <div className="flex items-stretch gap-2">
          <Select value={String(current)} onValueChange={open}>
            <SelectTrigger
              aria-label="Spec"
              className="h-auto min-w-0 flex-1 rounded-none border-hair-strong bg-card py-2 text-left data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none [&>span]:min-w-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {specs.map((spec, index) => {
                const status = specStageStatus(spec, stage);
                return (
                  <SelectItem key={spec.number} value={String(spec.number)}>
                    <span className="grid grid-cols-[22px_1fr] gap-x-1 text-left">
                      <span className="font-mono text-[11px] leading-[1.7] text-faint">
                        {index + 1}
                      </span>
                      <span className="font-display text-[13.5px] leading-snug font-semibold tracking-[-0.01em]">
                        {specLabel(spec)}
                      </span>
                      <span className={cn("col-start-2 text-[11.5px]", TONE_TEXT[status.tone])}>
                        {status.line}
                      </span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {waiting !== undefined && (
            <Button
              variant="outline"
              className="h-auto"
              onClick={() => {
                open(String(waiting.number));
              }}
            >
              Next waiting on you <ArrowRight />
            </Button>
          )}
        </div>
      </nav>
    );
  }

  return (
    <Tabs value={String(current)} onValueChange={open} className="gap-1.5">
      <Micro>
        This map feeds {specs.length} specs · each has its own revisions, tickets and delivery run
      </Micro>
      <TabsList
        aria-label="Specs"
        className="h-auto w-full justify-start gap-0 rounded-none border border-hair-strong bg-card p-0 group-data-[orientation=horizontal]/tabs:h-auto"
      >
        {specs.map((spec) => {
          const status = specStageStatus(spec, stage);
          return (
            <TabsTrigger
              key={spec.number}
              value={String(spec.number)}
              className="h-auto flex-1 flex-col items-start gap-0.5 rounded-none border-0 border-l border-border px-3.5 py-2 text-left whitespace-normal first:border-l-0 data-[state=active]:bg-secondary data-[state=active]:shadow-[inset_0_3px_0_var(--ink-line)]"
            >
              <span className="font-display text-[13.5px] leading-snug font-semibold tracking-[-0.01em] text-foreground">
                {specLabel(spec)}
              </span>
              <span className={cn("text-[11.5px] font-normal", TONE_TEXT[status.tone])}>
                {status.line}
              </span>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
