import { isDefinedError } from "@orpc/client";
import { getRouteApi, Outlet, useMatch } from "@tanstack/react-router";
import type { Stage } from "@zenorm/contracts";

import { ActivityColumn } from "@/components/ActivityColumn";
import { HatchProvider, useHatch } from "@/components/hatch/HatchProvider";
import { StageRail } from "@/components/parts";
import { MapAside } from "@/components/PluginSlot";
import { RouteError } from "@/components/RouteError";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceColumns, WorkspacePage } from "@/components/WorkspaceColumns";
import { aboutSpec } from "@/lib/hatch";
import { useMapOverview } from "@/lib/queries";
import { shownQueryError } from "@/lib/query-errors";
import { DeliveryStagePage } from "@/pages/stages/DeliveryStagePage";
import { IdeaStagePage } from "@/pages/stages/IdeaStagePage";
import { TicketsStagePage } from "@/pages/stages/TicketsStagePage";
import { SpecStagePage } from "@/pages/stages/SpecStagePage";
import { WayfindingStagePage } from "@/pages/stages/WayfindingStagePage";

const mapRouteApi = getRouteApi("/maps/$mapId");
const stageRouteApi = getRouteApi("/maps/$mapId/$stage");
const specStageRouteApi = getRouteApi("/maps/$mapId/$stage/$specNumber");

/**
 * The workspace's shape while the overview loads: the rail's five cells, then a
 * head and a card where the stage page's will be, in the page's own `WorkspacePage` so the loaded
 * page lands in the same container; the column's frame from the columns breakpoint. One status line
 * for assistive technology; the shapes are decoration.
 */
function MapShellSkeleton() {
  return (
    <div role="status" aria-label="Loading the map">
      <span className="sr-only">Loading the map…</span>
      <div
        aria-hidden
        className="grid h-(--stage-rail) grid-cols-5 gap-0.5 border-b border-border bg-card px-1 pt-1 sm:gap-1.5 sm:px-2 sm:pt-2.5 md:px-4 lg:grid-cols-[1fr_1fr_1fr_1fr_1.5fr]"
      >
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className="grid grid-cols-1 content-center items-center justify-items-center gap-y-1 border-b-2 border-border sm:grid-cols-[auto_1fr] sm:content-normal sm:justify-items-start sm:gap-x-2.5 sm:gap-y-0 sm:px-2.5 sm:pt-[7px] sm:pb-[9px]"
          >
            <Skeleton className="h-3 w-2.5 sm:row-span-2 sm:size-[18px]" />
            <Skeleton className="h-3 w-12 sm:w-24" />
            <Skeleton className="hidden h-2.5 w-32 md:block" />
          </div>
        ))}
      </div>
      <div aria-hidden className="grid xl:grid-cols-[minmax(0,1fr)_22rem]">
        <WorkspacePage
          head={
            <div>
              <Skeleton className="h-2.5 w-56" />
              <Skeleton className="mt-4 h-7 w-[22rem] max-w-full" />
              <Skeleton className="mt-3.5 h-3 w-[26rem] max-w-full" />
            </div>
          }
        >
          <div className="grid gap-3 border border-border bg-card p-[18px]">
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-3 w-44" />
            <Skeleton className="mt-1 h-9 w-40" />
          </div>
        </WorkspacePage>
        <div className="hidden h-[calc(100dvh-var(--workspace-chrome))] border-l border-ink-line bg-card xl:block">
          <div className="flex h-[42px] items-center border-b border-border px-3.5">
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="grid gap-5 px-3.5 py-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="grid gap-2">
                <Skeleton className="h-2.5 w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The map workspace layout route: the stage rail renders once, above whichever
 * stage page is open. The top bar above it is the breadcrumb (project, then the map's name). The
 * escape hatch's composer state spans the map's pages, keyed by the map.
 */
export function MapLayout() {
  const { mapId } = mapRouteApi.useParams();
  const overview = useMapOverview(mapId);
  const stageMatch = useMatch({ from: "/maps/$mapId/$stage", shouldThrow: false });
  const specStageMatch = useMatch({
    from: "/maps/$mapId/$stage/$specNumber",
    shouldThrow: false,
  });
  // The destination round and a waypoint are Wayfinding's own pages.
  const destinationMatch = useMatch({
    from: "/maps/$mapId/wayfinding/destination",
    shouldThrow: false,
  });
  const waypointMatch = useMatch({ from: "/maps/$mapId/wayfinding/$number", shouldThrow: false });
  // A ticket's execution page is Delivery's own page.
  const ticketMatch = useMatch({
    from: "/maps/$mapId/delivery/$specNumber/$ticketId",
    shouldThrow: false,
  });
  const viewing =
    stageMatch !== undefined
      ? stageMatch.params.stage
      : specStageMatch !== undefined
        ? specStageMatch.params.stage
        : destinationMatch !== undefined || waypointMatch !== undefined
          ? "wayfinding"
          : ticketMatch !== undefined
            ? "delivery"
            : null;

  const overviewError = shownQueryError(overview.error);
  if (overviewError !== null) {
    // A refusal (`map_not_found`, `access_denied`) is the error page, as the route errors are;
    // any other failure shows as it is.
    if (isDefinedError(overviewError)) {
      return (
        <RouteError
          error={overviewError}
          reset={() => {
            void overview.refetch();
          }}
        />
      );
    }
    return (
      <main className="mx-auto max-w-[880px] px-6 pt-12">
        <Alert variant="destructive">
          <AlertTitle>Could not load the map</AlertTitle>
          <AlertDescription>{overviewError.message}</AlertDescription>
        </Alert>
      </main>
    );
  }
  if (overview.data === undefined) {
    return <MapShellSkeleton />;
  }
  return (
    <HatchProvider key={mapId}>
      <StageRail mapId={mapId} stages={overview.data.status.stages} viewing={viewing} />
      <Outlet />
    </HatchProvider>
  );
}

/** A stage of the map; a spec stage opens the default spec `map.overview` decides. */
export function MapStageView() {
  const { mapId, stage } = stageRouteApi.useParams();
  const search = stageRouteApi.useSearch();
  return <StageView mapId={mapId} stage={stage} specNumber={undefined} search={search} />;
}

/** Spec, Tickets or Delivery of the spec the route numbers. */
export function MapSpecStageView() {
  const { mapId, stage, specNumber } = specStageRouteApi.useParams();
  const search = specStageRouteApi.useSearch();
  return <StageView mapId={mapId} stage={stage} specNumber={specNumber} search={search} />;
}

/**
 * One stage of the map: Idea, Wayfinding, Spec and Tickets sit in the workspace shell
 * (`WorkspaceColumns`), the page then the 22rem Activity column with the escape hatch, a sheet
 * below the columns breakpoint that a page's Ask opens too; Delivery lays out its own page, with
 * Run activity in the column's place and no hatch.
 */
function StageView({
  mapId,
  stage,
  specNumber,
  search,
}: {
  mapId: string;
  stage: Stage;
  specNumber: number | undefined;
  search: { revision?: number | undefined; version?: number | undefined; run?: number | undefined };
}) {
  const overview = useMapOverview(mapId);
  const { focusRequest } = useHatch();
  const detail = overview.data;
  if (detail === undefined) {
    // The layout shows the refusal or the loading line until the overview is in.
    return null;
  }

  const aside = <MapAside projectId={detail.project.id} mapId={mapId} stage={stage} />;
  if (stage === "delivery") {
    return (
      <DeliveryStagePage detail={detail} specNumber={specNumber} run={search.run} aside={aside} />
    );
  }
  return (
    <WorkspaceColumns
      label="Activity"
      openOn={focusRequest}
      column={
        <ActivityColumn
          detail={detail}
          stage={stage}
          specNumber={aboutSpec(detail, stage, specNumber)}
          aside={aside}
        />
      }
    >
      {stage === "idea" && <IdeaStagePage detail={detail} />}
      {stage === "wayfinding" && <WayfindingStagePage detail={detail} />}
      {stage === "spec" && (
        <SpecStagePage detail={detail} specNumber={specNumber} revision={search.revision} />
      )}
      {stage === "tickets" && (
        <TicketsStagePage detail={detail} specNumber={specNumber} version={search.version} />
      )}
    </WorkspaceColumns>
  );
}
