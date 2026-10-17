import { useMatch } from "@tanstack/react-router";
import type { Stage } from "@zenorm/contracts";

/**
 * The stage the open map page belongs to, as the stage rail marks it (`MapLayout` derives the
 * same): a stage route's own stage, Wayfinding for the destination round and a waypoint, Delivery
 * for a ticket's execution page; null off a map's stage pages. A next-action card reads it so it
 * never links the stage it is already on.
 */
export function useViewedStage(): Stage | null {
  const stageMatch = useMatch({ from: "/maps/$mapId/$stage", shouldThrow: false });
  const specStageMatch = useMatch({
    from: "/maps/$mapId/$stage/$specNumber",
    shouldThrow: false,
  });
  const destinationMatch = useMatch({
    from: "/maps/$mapId/wayfinding/destination",
    shouldThrow: false,
  });
  const waypointMatch = useMatch({ from: "/maps/$mapId/wayfinding/$number", shouldThrow: false });
  const ticketMatch = useMatch({
    from: "/maps/$mapId/delivery/$specNumber/$ticketId",
    shouldThrow: false,
  });
  if (stageMatch !== undefined) {
    return stageMatch.params.stage;
  }
  if (specStageMatch !== undefined) {
    return specStageMatch.params.stage;
  }
  if (destinationMatch !== undefined || waypointMatch !== undefined) {
    return "wayfinding";
  }
  if (ticketMatch !== undefined) {
    return "delivery";
  }
  return null;
}
