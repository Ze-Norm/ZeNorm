import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeliveryRun, NextAction } from "@zenorm/contracts";
import { ArrowRight, Loader2 } from "lucide-react";

import { NextActionCard } from "@/components/NextActionCard";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { orpc } from "@/orpc";
import { markMergedRefusalMessage, required } from "@/pages/stages/delivery/words";

/**
 * A passed run's card: core's "Mark merged" action, whose button calls
 * `delivery.markMerged`. While git checks the final commit is in the base branch the button reads
 * "Checking <commit> is in <base>…"; a refusal shows beside it.
 */
export function MarkMergedCard({
  mapId,
  run,
  action,
}: {
  mapId: string;
  run: DeliveryRun;
  action: NextAction;
}) {
  const queryClient = useQueryClient();
  const markMerged = useMutation(
    orpc.delivery.markMerged.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.map.overview.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overviews.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.get.key() }),
        ]),
    }),
  );
  if (action.label !== "Mark merged") {
    throw new Error(`The Mark merged card shows a ${String(action.label)} action`);
  }
  const commit = required(run.finalCommit, "final commit", run).slice(0, 7);

  return (
    <NextActionCard mapId={mapId} next={action}>
      <div className="flex flex-wrap items-start gap-3">
        <Button
          type="button"
          disabled={markMerged.isPending}
          onClick={() => {
            markMerged.mutate({ runId: run.id });
          }}
        >
          {markMerged.isPending ? (
            <>
              <Loader2 className="animate-spin" /> Checking {commit} is in {run.baseBranch}…
            </>
          ) : (
            <>
              {action.label} <ArrowRight />
            </>
          )}
        </Button>
        {markMerged.error !== null && (
          <div className="min-w-0 flex-1">
            <RefusalAlert
              error={markMerged.error}
              sentence={markMergedRefusalMessage}
              title="Could not mark the run merged"
              showMessage={false}
            />
          </div>
        )}
      </div>
    </NextActionCard>
  );
}
