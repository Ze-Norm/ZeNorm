import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LOCAL_EXECUTOR } from "@zenorm/contracts";
import type { DeliveryRun, SpecRun } from "@zenorm/contracts";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { PageHead } from "@/components/parts";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatMoment } from "@/lib/map";
import { orpc } from "@/orpc";
import {
  cancelRefusalMessage,
  endedHeadline,
  failureDetail,
  failureSentence,
  required,
  runProgress,
} from "@/pages/stages/delivery/words";
import { executorLabel } from "@/pages/stages/delivery/ticket-status";

function CancelRunButton({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const cancel = useMutation(
    orpc.delivery.cancel.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.get.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overview.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overviews.key() }),
        ]),
    }),
  );
  return (
    <div className="grid justify-items-end gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={cancel.isPending}
        onClick={() => {
          cancel.mutate({ runId });
        }}
      >
        {cancel.isPending && <Loader2 className="animate-spin" />}
        Cancel run
      </Button>
      {cancel.error !== null && (
        <RefusalAlert
          error={cancel.error}
          sentence={cancelRefusalMessage}
          title="Could not cancel the run"
          showMessage={false}
        />
      )}
    </div>
  );
}

/** The lede's first words, the run's state, set off from the sentence after them. */
function State({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

/**
 * A run's head (slice 8 D9, the demo's `RunHead` and `endedHeadline`): the spec's title, as every
 * stage's head names the thing on the page (UX review P2-4), with the run's state leading the lede:
 * what a running run is doing and how far it has got, with **Cancel run** while it is the latest
 * and active; an ended run's headline and why it ended, a failure's full message behind **Show the
 * full error**. No worktree path: the worktrees are gone once the run ends.
 */
export function RunHead({
  run,
  eyebrow,
  title,
  canCancel,
}: {
  run: SpecRun;
  eyebrow: string;
  title: ReactNode;
  canCancel: boolean;
}) {
  const cancel = canCancel ? <CancelRunButton runId={run.id} /> : undefined;
  switch (run.state) {
    case "running": {
      const { doing, progress } = runProgress(run);
      return (
        <PageHead
          eyebrow={eyebrow}
          title={title}
          lede={
            <span role="status" className="flex items-start gap-2">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-work-dot" />
              <span>
                <State>{doing}:</State> {progress}. Nothing needs you until the run ends.
              </span>
            </span>
          }
          right={cancel}
        />
      );
    }
    case "interrupted":
      return (
        <PageHead
          eyebrow={eyebrow}
          title={title}
          lede={
            <>
              <State>Interrupted.</State> ZeNorm restarted while this run was active, so nothing is
              running it now. Cancel it, then start again.
            </>
          }
          right={cancel}
        />
      );
    case "passed":
    case "blocked":
      return (
        <PageHead
          eyebrow={eyebrow}
          title={title}
          lede={
            <>
              <State>{endedHeadline(run)}.</State>{" "}
              <AgentText text={required(run.verdict, "verdict", run).summary} />
            </>
          }
        />
      );
    case "failed": {
      // The one sentence the next-action card shows too (UX audit P1-1); the rest of the stored
      // message (the CLI's stderr tail) opens under it.
      const failure = required(run.failure, "failure", run);
      const detail = failureDetail(failure);
      return (
        <div className="grid gap-2">
          <PageHead
            eyebrow={eyebrow}
            title={title}
            lede={
              <>
                <State>{endedHeadline(run)}.</State> <AgentText text={failureSentence(failure)} />
              </>
            }
          />
          {detail !== null && (
            <Collapsible className="grid justify-items-start gap-2">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="group -ml-2">
                  <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                  Show the full error
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent asChild>
                <pre
                  aria-label="Full error"
                  className="max-w-full border-l-2 border-border pl-3 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground"
                >
                  {detail}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      );
    }
    case "cancelled":
      return (
        <PageHead
          eyebrow={eyebrow}
          title={title}
          lede={
            <>
              <State>{endedHeadline(run)}.</State> You cancelled this run.
            </>
          }
        />
      );
  }
}

/** When the run reached its state, for the eyebrow: "running since" its start, else its end. */
function stateMoment(run: DeliveryRun): string {
  switch (run.state) {
    case "running":
      return `running since ${formatMoment(run.startedAt)}`;
    case "interrupted":
      return "interrupted";
    case "passed":
      if (run.mergedAt !== null) {
        return `merged ${formatMoment(run.mergedAt)}`;
      }
      return `passed ${formatMoment(required(run.endedAt, "end time", run))}`;
    case "blocked":
    case "failed":
    case "cancelled":
      return `${run.state} ${formatMoment(required(run.endedAt, "end time", run))}`;
  }
}

/**
 * The run's eyebrow, as every stage's: the stage, the run and the spec revision it delivers, the
 * executor carrying it (Claude Code for `"local"`, CR9b-6), then its state and when it reached it.
 * The spec's title is the head's own.
 */
export function runEyebrow(run: DeliveryRun, revision: number): string {
  const executor = run.executor === LOCAL_EXECUTOR ? "Claude Code" : executorLabel(run.executor);
  return `Delivery · run ${String(run.number)} · revision ${String(revision)} · ${executor} · ${stateMoment(run)}`;
}
