import { isDefinedError } from "@orpc/client";
import { useEffect } from "react";

import { mapName } from "@/lib/map";
import { useMapOverview } from "@/lib/queries";
import { shownQueryError } from "@/lib/query-errors";
import { describeQueryRefusal } from "@/lib/route-error";

const APP_NAME = "ZeNorm";

/**
 * The document title of a page: its parts, most specific first, then the app's name, joined with
 * " · " ("Spec · Ship it · ZeNorm"). The specific part leads because a browser tab cuts the tail.
 */
export function pageTitle(parts: readonly string[]): string {
  return [...parts, APP_NAME].join(" · ");
}

/**
 * Sets `document.title` while the calling page is mounted. Only a leaf (a page, the route error,
 * the not-found page) calls it: React runs a child's effects before its parent's, so a layout
 * setting a title would overwrite the page's.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/**
 * The title of a page on a map: `first` (the stage or the record shown), the map's name from the
 * overview the layout already read (cached, so this costs no request), then the app's name. The
 * overview is absent only while a refetch after a refusal is in flight; `first` alone shows then.
 */
export function useMapPageTitle(mapId: string, first: string): void {
  const overview = useMapOverview(mapId);
  const parts = overview.data === undefined ? [first] : [first, mapName(overview.data.map)];
  useDocumentTitle(pageTitle(parts));
}

/**
 * The map layout's title, set only while its overview read shows a refusal (`map_not_found`,
 * `access_denied`): no stage page mounts then, so no leaf title is overwritten. It is the refusal
 * page's own title (`describeQueryRefusal`), so the two agree whichever effect runs last.
 */
export function useMapRefusalTitle(mapId: string): void {
  const overview = useMapOverview(mapId);
  const error = shownQueryError(overview.error);
  const title = error === null || !isDefinedError(error) ? null : describeQueryRefusal(error).title;
  useEffect(() => {
    if (title !== null) {
      document.title = pageTitle([title]);
    }
  }, [title]);
}
