import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeliveryRun, NextAction } from "@zenorm/contracts";

import { NextActionCard } from "@/components/NextActionCard";
import { RefusalAlert } from "@/components/RefusalAlert";
import { orpc } from "@/orpc";
import { PullRequestActions } from "@/pages/stages/delivery/PullRequestStatus";
import { checkPullRequestRefusalMessage, required } from "@/pages/stages/delivery/words";

/**
 * A passed run's card when it opened a pull request (C5), in place of Mark merged: core's
 * "Merge PR" action, with the pull request's actions. Check now calls `delivery.checkPullRequest`;
 * a refusal shows beside it, in words chosen by its code.
 */
export function PullRequestCard({
  mapId,
  run,
  action,
}: {
  mapId: string;
  run: DeliveryRun;
  action: NextAction;
}) {
  const queryClient = useQueryClient();
  const checkNow = useMutation(
    orpc.delivery.checkPullRequest.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.map.overview.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overviews.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.get.key() }),
        ]),
    }),
  );
  if (action.label !== "Merge PR") {
    throw new Error(`The pull request card shows a ${String(action.label)} action`);
  }
  const pullRequest = required(run.pullRequest, "pull request", run);
  return (
    <NextActionCard mapId={mapId} next={action}>
      <PullRequestActions
        pullRequest={pullRequest}
        checking={checkNow.isPending}
        onCheckNow={() => {
          checkNow.mutate({ runId: run.id });
        }}
        refusal={
          checkNow.error === null ? null : (
            <RefusalAlert
              error={checkNow.error}
              sentence={checkPullRequestRefusalMessage}
              title="Could not check the pull request"
              showMessage={false}
            />
          )
        }
      />
    </NextActionCard>
  );
}
