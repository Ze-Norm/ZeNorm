import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AccessDeniedError, ResumeDeliveryError, SpecRun } from "@zenorm/contracts";
import { ArrowRight, Loader2 } from "lucide-react";

import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { orpc } from "@/orpc";
import { startRefusalMessage } from "@/pages/stages/delivery/words";

/**
 * The sentence shown for a `delivery.resume` refusal, chosen by its code: the run's own refusals
 * here, every start refusal as `delivery.start` words it.
 */
function resumeRefusalMessage(error: ResumeDeliveryError | AccessDeniedError): string {
  if (error.code === "delivery_run_not_found") {
    return "This delivery run no longer exists.";
  }
  if (error.code === "delivery_run_not_resumable") {
    return "Only a failed, blocked or cancelled run can be resumed.";
  }
  if (error.code === "delivery_run_branch_missing") {
    return `The branch ${error.data.branch} is gone from the project's repository. Start again from clean instead.`;
  }
  return startRefusalMessage(error);
}

/** What resuming keeps: the tickets the run merged, which the next run does not implement again. */
function keptSentence(run: SpecRun, merged: readonly string[]): string {
  const from = `Continues from run ${String(run.number)}'s branch`;
  if (merged.length === 0) {
    return `${from}. No ticket was implemented in it, so it implements every ticket.`;
  }
  const verb = merged.length === 1 ? "is" : "are";
  return `${from}, where ${merged.join(", ")} ${verb} already implemented; it implements the rest, then the run is reviewed and verified as usual.`;
}

/**
 * Resumes the latest run after it ended blocked, failed or cancelled: `delivery.resume` starts the
 * next run from that run's branch, keeping the tickets it merged, so a run cut off near its end
 * does not start again from clean.
 */
export function ResumeRunCard({ mapId, run }: { mapId: string; run: SpecRun }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const resume = useMutation(
    orpc.delivery.resume.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.map.overview.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overviews.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.get.key() }),
        ]);
        // The new run is the latest; drop any `?run=` so the page opens on it.
        await navigate({
          to: "/maps/$mapId/$stage",
          params: { mapId, stage: "delivery" },
          search: {},
        });
      },
    }),
  );
  const merged =
    run.tickets === null
      ? []
      : run.tickets
          .filter((ticket) => ticket.status.state === "merged")
          .map((ticket) => ticket.ticket);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resume run {run.number}</CardTitle>
        <CardDescription>{keptSentence(run, merged)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div>
          <Button
            type="button"
            disabled={resume.isPending}
            onClick={() => {
              resume.mutate({ runId: run.id });
            }}
          >
            {resume.isPending && <Loader2 className="animate-spin" />}
            Resume run {run.number}
            {!resume.isPending && <ArrowRight />}
          </Button>
        </div>
        {resume.error !== null && (
          <RefusalAlert
            error={resume.error}
            sentence={resumeRefusalMessage}
            title="Could not resume the run"
            showMessage={false}
          />
        )}
      </CardContent>
    </Card>
  );
}
