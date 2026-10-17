import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { EntityId, Stage, TicketId } from "@zenorm/contracts";
import { z } from "zod";

import { LiveAlert } from "@/components/LiveAlert";
import { MapLayout, MapSpecStageView, MapStageView } from "@/components/MapWorkspace";
import { NotFound } from "@/components/NotFound";
import { RouteError } from "@/components/RouteError";
import { useMapPageTitle, useMapRefusalTitle } from "@/lib/document-title";
import { stageName } from "@/lib/map";
import { useMapOverview } from "@/lib/queries";
import { TopBar } from "@/components/TopBar";
import { InboxPage } from "@/pages/InboxPage";
import { ProjectPage } from "@/pages/ProjectPage";
import { ProjectSettingsPage } from "@/pages/ProjectSettingsPage";
import { TicketExecutionPage } from "@/pages/stages/TicketExecutionPage";
import { DestinationRoundPage } from "@/pages/stages/wayfinding/DestinationRoundPage";
import { WaypointPage } from "@/pages/stages/wayfinding/WaypointPage";

/**
 * A record's number in a search parameter (a spec revision, a ticket set version or a run, L100)
 * or in a waypoint's path.
 */
const RecordNumber = z.int().positive();

/**
 * A stage's search parameters (spec D1), absent meaning the latest: Spec `revision`,
 * Tickets `version`, Delivery `run`. Unknown keys and a key on another stage are invalid.
 */
const StageSearch = z.strictObject({
  revision: RecordNumber.optional(),
  version: RecordNumber.optional(),
  run: RecordNumber.optional(),
});
type StageSearch = z.infer<typeof StageSearch>;

/** The stages each spec of a map has its own of (slice 7 D11). */
const SpecStageParam = z.enum(["spec", "tickets", "delivery"]);

const SEARCH_KEY_STAGE: Record<keyof StageSearch, Stage> = {
  revision: "spec",
  version: "tickets",
  run: "delivery",
};

const rootRoute = createRootRoute({
  // An address no route matches keeps the top bar and offers the inbox (audit A6); an error the
  // shell itself throws shows the same route error page instead of the router's default.
  notFoundComponent: NotFound,
  errorComponent: RouteError,
  component: function RootLayout() {
    return (
      <div className="min-h-dvh bg-background">
        <TopBar />
        <LiveAlert />
        <Outlet />
      </div>
    );
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: InboxPage,
});

export const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  params: {
    parse: (raw) => ({ projectId: EntityId.parse(raw.projectId) }),
    stringify: (params) => ({ projectId: params.projectId }),
  },
  errorComponent: RouteError,
  component: function ProjectRoute() {
    const { projectId } = projectRoute.useParams();
    return <ProjectPage projectId={projectId} />;
  },
});

/** A project's settings: its base branch and required checks (slice 8 D12). */
export const projectSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/settings",
  params: {
    parse: (raw) => ({ projectId: EntityId.parse(raw.projectId) }),
    stringify: (params) => ({ projectId: params.projectId }),
  },
  errorComponent: RouteError,
  component: function ProjectSettingsRoute() {
    const { projectId } = projectSettingsRoute.useParams();
    return <ProjectSettingsPage projectId={projectId} />;
  },
});

/** The map workspace: a layout route, so the rail renders once above every stage (spec D1). */
export const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/maps/$mapId",
  params: {
    parse: (raw) => ({ mapId: EntityId.parse(raw.mapId) }),
    stringify: (params) => ({ mapId: params.mapId }),
  },
  errorComponent: RouteError,
  component: function MapRouteLayout() {
    const { mapId } = mapRoute.useParams();
    useMapRefusalTitle(mapId);
    return <MapLayout />;
  },
});

const mapIndexRoute = createRoute({
  getParentRoute: () => mapRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router's redirect is thrown
    throw redirect({
      to: "/maps/$mapId/$stage",
      params: { mapId: params.mapId, stage: "idea" },
      replace: true,
    });
  },
});

/** Refuses a search key that belongs to another stage (D1). */
function checkStageSearch(shown: Stage, search: StageSearch): void {
  for (const [key, stage] of Object.entries(SEARCH_KEY_STAGE)) {
    if (key in search && stage !== shown) {
      throw new Error(`?${key}= belongs to the ${stage} stage, not ${shown}`);
    }
  }
}

/** A stage of the map; Spec, Tickets and Delivery open D11's default spec (slice 7). */
export const mapStageRoute = createRoute({
  getParentRoute: () => mapRoute,
  path: "$stage",
  params: {
    parse: (raw) => ({ stage: Stage.parse(raw.stage) }),
    stringify: (params) => ({ stage: params.stage }),
  },
  validateSearch: (search) => StageSearch.parse(search),
  beforeLoad: ({ params, search }) => {
    checkStageSearch(params.stage, search);
  },
  errorComponent: RouteError,
  component: function MapStageRoute() {
    const { mapId, stage } = mapStageRoute.useParams();
    useMapPageTitle(mapId, stageName(stage));
    return <MapStageView />;
  },
});

/** Spec, Tickets or Delivery of one spec of the map, by its number (slice 7 D11). */
export const mapSpecStageRoute = createRoute({
  getParentRoute: () => mapRoute,
  path: "$stage/$specNumber",
  params: {
    parse: (raw) => ({
      stage: SpecStageParam.parse(raw.stage),
      specNumber: RecordNumber.parse(Number(raw.specNumber)),
    }),
    stringify: (params) => ({ stage: params.stage, specNumber: String(params.specNumber) }),
  },
  validateSearch: (search) => StageSearch.parse(search),
  beforeLoad: ({ params, search }) => {
    checkStageSearch(params.stage, search);
  },
  errorComponent: RouteError,
  component: function MapSpecStageRoute() {
    const { mapId, stage, specNumber } = mapSpecStageRoute.useParams();
    useMapPageTitle(
      mapId,
      stage === "spec"
        ? `Spec ${String(specNumber)}`
        : `${stageName(stage)} · spec ${String(specNumber)}`,
    );
    return <MapSpecStageView />;
  },
});

/** The ticket page's search parameter: the run, absent meaning the latest (D10, deviation 9). */
const TicketExecutionSearch = z.strictObject({ run: RecordNumber.optional() });

/** One ticket's execution in a delivery run of one spec (slice 8 D10). */
export const ticketExecutionRoute = createRoute({
  getParentRoute: () => mapRoute,
  path: "delivery/$specNumber/$ticketId",
  params: {
    parse: (raw) => ({
      specNumber: RecordNumber.parse(Number(raw.specNumber)),
      ticketId: TicketId.parse(raw.ticketId),
    }),
    stringify: (params) => ({ specNumber: String(params.specNumber), ticketId: params.ticketId }),
  },
  validateSearch: (search) => TicketExecutionSearch.parse(search),
  errorComponent: RouteError,
  component: function TicketExecutionRoute() {
    const { mapId, specNumber, ticketId } = ticketExecutionRoute.useParams();
    const { run } = ticketExecutionRoute.useSearch();
    useMapPageTitle(mapId, `Ticket ${ticketId}`);
    const overview = useMapOverview(mapId);
    if (overview.data === undefined) {
      // The layout shows the refusal or the loading line until the overview is in.
      return null;
    }
    return (
      <TicketExecutionPage
        detail={overview.data}
        specNumber={specNumber}
        ticketId={ticketId}
        run={run}
      />
    );
  },
});

/** The map-level round on Wayfinding (slice 6a D9). */
export const destinationRoundRoute = createRoute({
  getParentRoute: () => mapRoute,
  path: "wayfinding/destination",
  errorComponent: RouteError,
  component: function DestinationRoundRoute() {
    const { mapId } = destinationRoundRoute.useParams();
    useMapPageTitle(mapId, "Destination");
    return <DestinationRoundPage mapId={mapId} />;
  },
});

/** One waypoint on Wayfinding, by its number (slice 6a D9). */
export const waypointRoute = createRoute({
  getParentRoute: () => mapRoute,
  path: "wayfinding/$number",
  params: {
    parse: (raw) => ({ number: RecordNumber.parse(Number(raw.number)) }),
    stringify: (params) => ({ number: String(params.number) }),
  },
  errorComponent: RouteError,
  component: function WaypointRoute() {
    const { mapId, number } = waypointRoute.useParams();
    useMapPageTitle(mapId, `Waypoint ${String(number)}`);
    return <WaypointPage mapId={mapId} number={number} />;
  },
});

const routeTree = rootRoute.addChildren([
  inboxRoute,
  projectRoute,
  projectSettingsRoute,
  mapRoute.addChildren([
    mapIndexRoute,
    mapStageRoute,
    mapSpecStageRoute,
    ticketExecutionRoute,
    destinationRoundRoute,
    waypointRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
