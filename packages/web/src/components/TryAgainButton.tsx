import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TryAgainError } from "@zenorm/contracts";

import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { orpc } from "@/orpc";
import type { AccessDeniedError } from "@zenorm/contracts";
import { accessDeniedSentence } from "@/lib/access";

/** The sentence shown for a `planningRun.tryAgain` refusal, chosen by its code. */
function tryAgainRefusalMessage(error: TryAgainError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "planning_run_not_found":
      return "This run no longer exists.";
    case "planning_run_not_stopped":
      return "The agent is already on it: nothing is stopped here now.";
  }
}

/**
 * **Try again** on a stopped scope (slice 6a S6a-12) or a waiting waypoint (slice 6b S6b-12,
 * L115): starts a fresh run in place of the failed retry or waiting run `runId`, then refetches
 * the map's reads.
 */
export function TryAgainButton({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const tryAgain = useMutation(
    orpc.planningRun.tryAgain.mutationOptions({
      onSuccess: () =>
        Promise.all(
          [orpc.map.overview.key(), orpc.map.overviews.key(), orpc.project.get.key()].map(
            (queryKey) => queryClient.invalidateQueries({ queryKey }),
          ),
        ),
    }),
  );
  return (
    <div className="grid justify-items-start gap-3">
      <Button
        type="button"
        disabled={tryAgain.isPending}
        onClick={() => {
          tryAgain.mutate({ runId });
        }}
      >
        Try again
      </Button>
      {tryAgain.error !== null && (
        <RefusalAlert
          error={tryAgain.error}
          sentence={tryAgainRefusalMessage}
          title="Could not try again"
          showMessage={false}
        />
      )}
    </div>
  );
}
