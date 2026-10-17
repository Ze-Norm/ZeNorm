import { useQuery } from "@tanstack/react-query";
import { defineWebPlugin } from "@zenorm/plugin-sdk";
import type { SlotProps } from "@zenorm/plugin-sdk";

import { Badge } from "./components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import { COUNTS_PATH, EXAMPLE_PLUGIN, ExampleCounts } from "./manifest.ts";

/** The query key of the counts route; the live layer's invalidation refetches it with core's. */
const COUNTS_KEY = ["plugins", EXAMPLE_PLUGIN.id, "counts"] as const;

async function fetchCounts(): Promise<ExampleCounts> {
  const response = await fetch(COUNTS_PATH);
  if (!response.ok) {
    throw new Error(`${COUNTS_PATH} answered ${String(response.status)}`);
  }
  return ExampleCounts.parse(await response.json());
}

/** "1 row", "<n> rows": a project the subscriber has not seen has none yet. */
function rowsLabel(count: number | undefined): string {
  if (count === undefined) return "0 rows";
  return count === 1 ? "1 row" : `${String(count)} rows`;
}

/** `header.end`: the plugin's name, so the composition shows on every page. */
function HeaderEnd() {
  return <Badge variant="outline">Example plugin</Badge>;
}

/** `project.page.sections`: the committed rows the subscriber counted for this project. */
function ProjectSection({ projectId }: SlotProps["project.page.sections"]) {
  const counts = useQuery({ queryKey: COUNTS_KEY, queryFn: fetchCounts });
  const count = counts.data?.projects[projectId];
  return (
    <Card role="region" aria-label="Example plugin">
      <CardHeader>
        <CardTitle>Example plugin</CardTitle>
        <CardDescription>
          Rows the example plugin's subscriber counted in this project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {counts.isError ? (
          <Badge variant="bad">{counts.error.message}</Badge>
        ) : counts.data === undefined ? (
          <Badge variant="secondary">Loading</Badge>
        ) : (
          <Badge variant="soft" data-testid="example-project-count">
            {rowsLabel(count)}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}

/** `map.workspace.aside`: the map's id, at the top of the right column on every stage. */
function MapAside({ mapId }: SlotProps["map.workspace.aside"]) {
  return (
    <Card role="region" aria-label="Example plugin map">
      <CardHeader className="pb-4">
        <CardTitle>Example plugin</CardTitle>
        <CardDescription>
          Map{" "}
          <Badge variant="outline" className="normal-case">
            {mapId}
          </Badge>
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

/** The example plugin's web entry: one component in each of the three slots. */
export const exampleWebPlugin = defineWebPlugin({
  ...EXAMPLE_PLUGIN,
  slots: {
    "header.end": HeaderEnd,
    "project.page.sections": ProjectSection,
    "map.workspace.aside": MapAside,
  },
});
