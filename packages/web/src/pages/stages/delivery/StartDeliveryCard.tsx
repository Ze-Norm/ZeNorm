import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { NextAction, Project } from "@zenorm/contracts";
import { ArrowRight, CircleAlert, Loader2 } from "lucide-react";

import { BlockerActions, BlockerList, NextActionCard } from "@/components/NextActionCard";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { orpc } from "@/orpc";
import { startRefusalMessage } from "@/pages/stages/delivery/words";

/**
 * The card's action: the spec's delivery action in the map's `next`, as core writes it (slice 8
 * D7): Start delivery, Start again from clean or Mark merged when the person's, or with a start blocker
 * and no run the quiet `nobody` action "Start delivery is unavailable.". Null while the agent's
 * action is the delivery stage's (a run is working) or the stage has none.
 */
export function deliveryCardAction(
  next: readonly NextAction[],
  specNumber: number,
): NextAction | null {
  const delivery = next.find(
    (action) => action.stage === "delivery" && (action.spec === specNumber || action.spec === null),
  );
  if (delivery === undefined || delivery.who === "agent") {
    return null;
  }
  return delivery;
}

/** The start button's words: core's label on the person's action. */
function startLabel(action: NextAction): string {
  if (action.label !== "Start delivery" && action.label !== "Start again from clean") {
    throw new Error(`The start card shows a ${String(action.label)} action`);
  }
  return action.label;
}

/**
 * The card that starts a run (slice 8 D9): **Start delivery**, or **Start again from clean** after
 * a run ended without passing, both `delivery.start`. The run pins the project's required checks,
 * so the card has no Checks form (L99). The form renders only while the start could succeed (UX
 * audit D1, P2-15): with a start blocker (no required checks, no repair limit, …), the person's
 * card says why, once, and links the way past it (**Set required checks**, **Set a repair limit**,
 * **Open that run**) in the form's place; the quiet `nobody` action is the standard blocker card,
 * which says the same.
 */
export function StartDeliveryCard({
  mapId,
  ticketSetId,
  project,
  action,
}: {
  mapId: string;
  ticketSetId: string;
  project: Project;
  action: NextAction;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const start = useMutation(
    orpc.delivery.start.mutationOptions({
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

  if (action.who === "nobody") {
    return <NextActionCard mapId={mapId} next={action} />;
  }

  const blockers = project.startDeliveryBlockers;
  if (blockers.length > 0) {
    return (
      <NextActionCard mapId={mapId} next={action}>
        <div className="grid gap-3">
          <div className="flex items-start gap-2.5">
            <CircleAlert className="mt-[3px] size-4 shrink-0 text-work-dot" />
            <BlockerList project={project} blockers={blockers} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <BlockerActions project={project} />
          </div>
        </div>
      </NextActionCard>
    );
  }

  return (
    <NextActionCard mapId={mapId} next={action}>
      <form
        noValidate
        aria-label="Start delivery"
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          start.mutate({ ticketSetId });
        }}
      >
        <div>
          <Button type="submit" disabled={start.isPending}>
            {start.isPending && <Loader2 className="animate-spin" />}
            {startLabel(action)}
            {!start.isPending && <ArrowRight />}
          </Button>
        </div>
        {start.error !== null && (
          <RefusalAlert
            error={start.error}
            sentence={startRefusalMessage}
            title="Could not start delivery"
            showMessage={false}
          />
        )}
      </form>
    </NextActionCard>
  );
}
