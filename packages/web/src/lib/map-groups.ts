import type { MapGroup, MapOverview } from "@zenorm/contracts";

/** A project's maps by the Inbox group each is in, with the finished quiet maps apart. */
export type ProjectMapGroups = Record<MapGroup | "completed", MapOverview[]>;

/**
 * One project's maps grouped as its page lists them: under the Inbox's groups, in the input's order,
 * except that a quiet map whose Delivery stage is done goes to `completed`. A needs-you or working
 * map stays in its own group whatever its Delivery stage shows.
 */
export function groupProjectMaps(overviews: readonly MapOverview[]): ProjectMapGroups {
  const groups: ProjectMapGroups = { "needs-you": [], working: [], quiet: [], completed: [] };
  for (const overview of overviews) {
    const group = overview.status.group;
    if (group === "quiet" && overview.status.stages[4].tone === "done") {
      groups.completed.push(overview);
    } else {
      groups[group].push(overview);
    }
  }
  return groups;
}
