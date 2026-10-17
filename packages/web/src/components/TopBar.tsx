import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { Project } from "@zenorm/contracts";
import { ChevronDown, FolderGit2, Plus } from "lucide-react";
import { useState } from "react";

import { AddProjectDialog } from "@/components/AddProjectDialog";
import { PluginSlot } from "@/components/PluginSlot";
import { ThemeMenu } from "@/components/ThemeMenu";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceSheetTrigger } from "@/components/WorkspaceColumns";
import { ZeNormMark } from "@/components/ZeNormMark";
import { mapName } from "@/lib/map";
import { useMapOverview, useMapOverviews } from "@/lib/queries";
import { orpc } from "@/orpc";

/**
 * The top bar (spec D5): the wordmark, the project switcher, the open map's name and the
 * need-you badge. With the switcher it is the breadcrumb: project, then map. No person's name
 * or initials (L97). It sticks to the top (`--top-bar` high), the stage rail under it on a map.
 * The badge counts the inbox, not the open map (UX audit A8): it names the inbox, and it is
 * quiet while the open map is not among the maps that need you. The colour scheme menu comes
 * next; below the columns breakpoint the bar ends with the button that opens the page's column
 * as a sheet. Below `sm` (a phone) the bar keeps to one line: the mark without its word, the
 * switcher's label cut short, no map crumb (the page's h1 names the map), the badge as its count
 * (its sentence stays for assistive technology), and the sheet's button as its icon.
 */
export function TopBar() {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const projects = useQuery(orpc.project.list.queryOptions());
  const overviews = useMapOverviews();

  const needing =
    overviews.data === undefined
      ? []
      : overviews.data.filter((overview) => overview.status.group === "needs-you");
  const waiting = needing.length;
  const hereNeedsYou =
    params.mapId !== undefined && needing.some((overview) => overview.map.id === params.mapId);

  return (
    <header className="sticky top-0 z-30 flex h-(--top-bar) items-center gap-2 border-b border-ink-line bg-card px-3 sm:gap-3 sm:px-4">
      <Link
        to="/"
        aria-label="ZeNorm"
        activeOptions={{ exact: true }}
        className="flex shrink-0 items-center gap-2 font-display text-[17px] leading-none font-bold tracking-[-0.03em]"
      >
        <ZeNormMark className="h-[22px] w-auto text-ink" />
        <span className="hidden sm:inline">ZeNorm</span>
      </Link>
      <span className="h-[18px] w-px shrink-0 bg-hair-strong" />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Project switcher"
          className="flex min-w-0 items-center gap-2 px-1.5 py-1 font-display text-sm font-semibold tracking-[-0.015em] whitespace-nowrap hover:bg-secondary sm:shrink-0"
        >
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {params.mapId === undefined ? (
              <ProjectLabel projectId={params.projectId} projects={projects.data} />
            ) : (
              <MapProjectLabel mapId={params.mapId} />
            )}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(20rem,calc(100vw-1.5rem))]">
          <DropdownMenuLabel className="micro text-faint">Projects</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void navigate({ to: "/" })}>
            <span className="font-medium">All projects</span>
            <span className="ml-auto text-xs text-muted-foreground">inbox</span>
          </DropdownMenuItem>
          {projects.data?.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() =>
                void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })
              }
              className="flex-col items-start gap-0"
            >
              <span className="flex w-full items-center gap-2 font-medium">
                {project.name}
                {project.folder === "missing" && <Badge variant="bad">folder missing</Badge>}
              </span>
              <span className="font-mono text-[11px] break-all text-muted-foreground">
                {project.folderPath}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setAdding(true);
            }}
          >
            <Plus /> Add project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {params.mapId !== undefined && <MapCrumb mapId={params.mapId} />}

      <span className="flex-1" />
      {waiting > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link to="/" className="shrink-0">
              <Badge variant={params.mapId === undefined || hereNeedsYou ? "default" : "soft"}>
                <span className="size-[5px] bg-current" />
                <span className="sr-only sm:not-sr-only">
                  Inbox · {waiting} need{waiting === 1 ? "s" : ""} you
                </span>
                <span aria-hidden className="sm:hidden">
                  {waiting}
                </span>
              </Badge>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            {waiting === 1
              ? "1 map in the inbox needs you"
              : `${String(waiting)} maps in the inbox need you`}
            {params.mapId === undefined
              ? "."
              : hereNeedsYou
                ? ", this one among them."
                : ", not this one."}{" "}
            Open the inbox.
          </TooltipContent>
        </Tooltip>
      )}
      {params.mapId === undefined ? (
        <PluginSlot name="header.end" props={{ projectId: projectOnScreen(params.projectId) }} />
      ) : (
        <MapHeaderEnd mapId={params.mapId} />
      )}
      <ThemeMenu />
      <WorkspaceSheetTrigger />

      <AddProjectDialog open={adding} onOpenChange={setAdding} onAdded={null} />
    </header>
  );
}

/**
 * The switcher's label off a map: All projects, or the viewed project's name once it has
 * loaded (nothing while it loads or when the project page shows a refusal).
 */
function ProjectLabel({
  projectId,
  projects,
}: {
  projectId: string | undefined;
  projects: Project[] | undefined;
}) {
  if (projectId === undefined) {
    return <>All projects</>;
  }
  const project = projects?.find((candidate) => candidate.id === projectId);
  return project === undefined ? null : <>{project.name}</>;
}

/** The switcher's label on a map: the map's project, once the map has loaded. */
function MapProjectLabel({ mapId }: { mapId: string }) {
  const overview = useMapOverview(mapId);
  return overview.data === undefined ? null : <>{overview.data.project.name}</>;
}

/** The project a page off a map shows, for `header.end`: none on the Inbox (S9-18). */
function projectOnScreen(projectId: string | undefined): string | null {
  if (projectId === undefined) {
    return null;
  }
  return projectId;
}

/**
 * The `header.end` slot on a map: the map's project once the map has loaded, no project until
 * then (S9-18).
 */
function MapHeaderEnd({ mapId }: { mapId: string }) {
  const overview = useMapOverview(mapId);
  return (
    <PluginSlot
      name="header.end"
      props={{ projectId: overview.data === undefined ? null : overview.data.project.id }}
    />
  );
}

/**
 * The open map's name, linking its Idea stage: on one line, cut with an ellipsis when it is longer
 * than the bar has room for (an untitled map's idea), while the project switcher keeps its width.
 */
function MapCrumb({ mapId }: { mapId: string }) {
  const overview = useMapOverview(mapId);
  if (overview.data === undefined) {
    return null;
  }
  return (
    <>
      <span className="hidden shrink-0 text-faint sm:inline">/</span>
      <Link
        to="/maps/$mapId/$stage"
        params={{ mapId, stage: "idea" }}
        activeOptions={{ exact: true, includeSearch: false }}
        className="hidden min-w-0 truncate font-display text-sm font-semibold tracking-[-0.015em] sm:inline"
      >
        {mapName(overview.data.map)}
      </Link>
    </>
  );
}
