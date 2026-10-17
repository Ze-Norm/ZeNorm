import { isDefinedError } from "@orpc/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MapOverview, ProjectDetail } from "@zenorm/contracts";
import { ChevronRight, Plus, Settings } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { MapComposer } from "@/components/MapComposer";
import { PluginSlot } from "@/components/PluginSlot";
import { Micro, PageHead, SectionHead } from "@/components/parts";
import { QueryRefusal } from "@/components/RouteError";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { pageTitle, useDocumentTitle } from "@/lib/document-title";
import { groupProjectMaps } from "@/lib/map-groups";
import { useMapOverviews } from "@/lib/queries";
import { shownQueryError } from "@/lib/query-errors";
import { describeQueryRefusal } from "@/lib/route-error";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc";
import { MapRows } from "@/pages/inbox/MapRows";
import { DeliveryUnavailableCard, FolderMissingAlert } from "@/pages/project/ProjectAlerts";
import { SpecRows } from "@/pages/project/SpecRows";

/** Why New map is disabled: the project's folder is gone. */
function newMapDisabledReason(project: ProjectDetail): string | null {
  switch (project.folder) {
    case "present":
      return null;
    case "missing":
      return `New map is unavailable: there is no folder at ${project.folderPath}.`;
  }
}

/** One of the project's open map groups under its Inbox heading and count; empty, nothing. */
function MapGroupSection({
  title,
  titleClassName,
  needsYou,
  overviews,
}: {
  title: string;
  titleClassName: string;
  needsYou: boolean;
  overviews: readonly MapOverview[];
}) {
  if (overviews.length === 0) {
    return null;
  }
  return (
    <section aria-label={title} className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className={cn("micro font-bold", titleClassName)}>{title}</span>
        <span className="micro text-faint">{overviews.length}</span>
      </div>
      <MapRows overviews={overviews} needsYou={needsYou} hideProject={true} />
    </section>
  );
}

/**
 * The project's finished maps (quiet, Delivery done), below the open groups: closed on every page
 * load, its trigger naming the group and its count.
 */
function CompletedMaps({ overviews }: { overviews: readonly MapOverview[] }) {
  if (overviews.length === 0) {
    return null;
  }
  return (
    <section aria-label="Completed">
      <Collapsible className="grid gap-2">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group -ml-2.5 justify-self-start"
          >
            <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
            <span className="micro font-bold text-muted-foreground">Completed</span>
            <span className="micro text-faint">{overviews.length}</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <MapRows overviews={overviews} needsYou={false} hideProject={true} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * This project's maps, from `map.overviews`, under the Inbox's groups with the finished ones
 * folded into Completed, and its specs, from `project.get`. When a map's Spec stage moves, read
 * the project again.
 */
function ProjectMaps({ project }: { project: ProjectDetail }) {
  const overviews = useMapOverviews();
  const queryClient = useQueryClient();
  // Undefined while the overviews load: nothing has moved yet.
  const specStages = overviews.data
    ?.filter((overview) => overview.project.id === project.id)
    .map((overview) => `${overview.map.id}:${overview.status.stages[2].line}`)
    .join("|");
  const seen = useRef(specStages);
  useEffect(() => {
    if (seen.current === specStages) {
      return;
    }
    seen.current = specStages;
    void queryClient.invalidateQueries({ queryKey: orpc.project.get.key() });
  }, [queryClient, specStages]);
  const overviewsError = shownQueryError(overviews.error);
  if (overviewsError !== null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the maps</AlertTitle>
        <AlertDescription>{overviewsError.message}</AlertDescription>
      </Alert>
    );
  }
  if (overviews.data === undefined) {
    return null;
  }
  const maps = overviews.data.filter((overview) => overview.project.id === project.id);
  const groups = groupProjectMaps(maps);
  return (
    <>
      <section aria-label="Maps" className="grid gap-3">
        <SectionHead title="Maps" right={<Micro>{maps.length}</Micro>} />
        {maps.length > 0 ? (
          <div className="grid gap-5">
            <MapGroupSection
              title="Needs you"
              titleClassName="text-primary"
              needsYou={true}
              overviews={groups["needs-you"]}
            />
            <MapGroupSection
              title="Agent is working"
              titleClassName="text-work"
              needsYou={false}
              overviews={groups.working}
            />
            <MapGroupSection
              title="Quiet"
              titleClassName="text-muted-foreground"
              needsYou={false}
              overviews={groups.quiet}
            />
            <CompletedMaps overviews={groups.completed} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No maps yet. New map starts one from an idea.
          </p>
        )}
      </section>
      <SpecRows specs={project.specs} />
    </>
  );
}

/**
 * A project: its name, folder and base branch, **New map** opening the composer with the project
 * fixed, **Settings**, the folder-missing alert, why Start delivery is unavailable, its maps, and
 * one spec row per map with a spec revision.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useQuery(orpc.project.get.queryOptions({ input: { projectId } }));
  const error = shownQueryError(project.error);
  // A refusal (`project_not_found`, `access_denied`) is the error page, with its title.
  const refusal = error !== null && isDefinedError(error) ? error : null;
  useDocumentTitle(
    pageTitle(
      refusal !== null
        ? [describeQueryRefusal(refusal).title]
        : project.data === undefined
          ? ["Project"]
          : [project.data.name],
    ),
  );
  if (refusal !== null) {
    return <QueryRefusal error={refusal} />;
  }

  return (
    <main className="mx-auto grid max-w-[880px] gap-8 px-4 pt-7 pb-32 sm:px-6 sm:pt-10">
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the project</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {project.data !== undefined && <ProjectView project={project.data} />}
    </main>
  );
}

function ProjectView({ project }: { project: ProjectDetail }) {
  const [composing, setComposing] = useState(false);
  const reasonId = useId();
  const disabledReason = newMapDisabledReason(project);
  return (
    <>
      <PageHead
        eyebrow="Project"
        title={project.name}
        lede={
          <span className="font-mono text-[12px] break-all">
            {project.folderPath} · base {project.baseBranch}
          </span>
        }
        right={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
                <Settings /> Settings
              </Link>
            </Button>
            <Button
              variant="ink"
              disabled={disabledReason !== null}
              aria-describedby={disabledReason === null ? undefined : reasonId}
              onClick={() => {
                setComposing(true);
              }}
            >
              <Plus /> New map
            </Button>
          </div>
        }
      />
      {project.folder === "missing" && <FolderMissingAlert project={project} />}
      <DeliveryUnavailableCard project={project} />
      {disabledReason !== null && (
        <p id={reasonId} className="text-[13px] text-muted-foreground">
          {disabledReason}
        </p>
      )}
      {composing && disabledReason === null && (
        <MapComposer
          target={{ kind: "fixed", project }}
          disabledReason={null}
          onCancel={() => {
            setComposing(false);
          }}
        />
      )}
      <ProjectMaps project={project} />
      <PluginSlot name="project.page.sections" props={{ projectId: project.id }} />
    </>
  );
}
