import type { WayfindingWaypoint } from "@zenorm/contracts";

/** What this reads of a waypoint; the map overview's waypoints carry it. */
type Numbered = Pick<WayfindingWaypoint, "number">;

/** What this reads of the map overview (`MapOverviewDetail`). */
interface WaypointsOf<W extends Numbered> {
  readonly map: { readonly id: string };
  readonly wayfinding: { readonly waypoints: readonly W[] };
}

/** The waypoint numbered `number`; an unknown number is the route's error. */
export function waypointByNumber<W extends Numbered>(detail: WaypointsOf<W>, number: number): W {
  const waypoint = detail.wayfinding.waypoints.find((candidate) => candidate.number === number);
  if (waypoint === undefined) {
    throw new Error(`Map ${detail.map.id} has no waypoint ${String(number)}`);
  }
  return waypoint;
}
