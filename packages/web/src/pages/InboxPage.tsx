import { useQuery } from "@tanstack/react-query";
import type { MapGroup, MapOverview, Project } from "@zenorm/contracts";
import { Plus } from "lucide-react";
import { useState } from "react";

import { AddProjectDialog } from "@/components/AddProjectDialog";
import { MapComposer } from "@/components/MapComposer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pageTitle, useDocumentTitle } from "@/lib/document-title";
import { useMapOverviews } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc";
import { MapRows } from "@/pages/inbox/MapRows";
import { shownQueryError } from "@/lib/query-errors";

/** The greeting's opening, by the local hour; no person's name (L97). */
function greeting(hour: number): string {
  if (hour < 12) {
    return "Good morning.";
  }
  if (hour < 18) {
    return "Good afternoon.";
  }
  return "Good evening.";
}

function waitingSentence(count: number): string {
  if (count === 0) {
    return "Nothing is waiting on you.";
  }
  return count === 1 ? "One map is waiting on you." : `${String(count)} maps are waiting on you.`;
}

function groupMaps(overviews: readonly MapOverview[]): Record<MapGroup, MapOverview[]> {
  const groups: Record<MapGroup, MapOverview[]> = { "needs-you": [], working: [], quiet: [] };
  for (const overview of overviews) {
    groups[overview.status.group].push(overview);
  }
  return groups;
}

/** Why the composer cannot start a map: only when every project's folder is gone. */
function composerDisabledReason(projects: readonly Project[]): string | null {
  return projects.some((project) => project.folder === "present")
    ? null
    : "Every project's folder is missing, so no map can start until one is back.";
}

/** A read that failed without a contract code: what it was and the error's message. */
function LoadFailed({ what, error }: { what: string; error: Error }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not load {what}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

/** With no projects, the Inbox offers Add project in place of the composer (spec S5-9). */
function NoProjects() {
  const [adding, setAdding] = useState(false);
  return (
    <section
      aria-label="No projects"
      className="flex flex-wrap items-center gap-4 border border-ink-line bg-card px-4 py-3.5"
    >
      <p className="min-w-[14rem] flex-1 text-[15px] text-muted-foreground">
        Add a project to start. A project is a git repository on this machine; maps plan changes in
        it.
      </p>
      <Button
        variant="ink"
        onClick={() => {
          setAdding(true);
        }}
      >
        <Plus /> Add project
      </Button>
      <AddProjectDialog open={adding} onOpenChange={setAdding} onAdded={null} />
    </section>
  );
}

function InboxSection({
  title,
  needsYou,
  overviews,
}: {
  title: string;
  needsYou: boolean;
  overviews: readonly MapOverview[];
}) {
  if (overviews.length === 0) {
    return null;
  }
  return (
    <section aria-label={title} className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className={cn("micro font-bold", needsYou ? "text-primary" : "text-work")}>
          {title}
        </span>
        <span className="micro text-faint">{overviews.length}</span>
      </div>
      <MapRows overviews={overviews} needsYou={needsYou} hideProject={false} />
    </section>
  );
}

/** The most quiet maps shown without a fold, and the most rows the inbox holds before folding. */
const QUIET_INLINE = 3;
const ROWS_INLINE = 8;

/**
 * Whether the quiet group is shown in full (UX audit G2, P2-12): when it is small, or when the
 * whole inbox fits a screen without the fold; a long quiet tail behind the active groups folds to
 * one line, as spec C11.3 has it.
 */
export function quietInline(active: number, quiet: number): boolean {
  return quiet <= QUIET_INLINE || active + quiet <= ROWS_INLINE;
}

function QuietMaps({ overviews, active }: { overviews: readonly MapOverview[]; active: number }) {
  const [shown, setShown] = useState(false);
  if (overviews.length === 0) {
    return null;
  }
  if (quietInline(active, overviews.length)) {
    return (
      <section aria-label="Quiet" className="grid gap-2">
        <div className="flex items-center gap-2">
          <span className="micro font-bold text-muted-foreground">Quiet</span>
          <span className="micro text-faint">{overviews.length}</span>
        </div>
        <MapRows overviews={overviews} needsYou={false} hideProject={false} />
      </section>
    );
  }
  return (
    <section aria-label="Quiet" className="grid gap-2">
      <div className="flex items-center border-t border-hair-strong pt-4 text-sm text-muted-foreground">
        <span className="flex-1">
          {overviews.length} more map{overviews.length === 1 ? "" : "s"}, all quiet
        </span>
        <Button
          variant="link"
          onClick={() => {
            setShown((s) => !s);
          }}
        >
          {shown ? "Hide" : "Show all"}
        </Button>
      </div>
      {shown && <MapRows overviews={overviews} needsYou={false} hideProject={false} />}
    </section>
  );
}

/** Where the rows will be while the overviews load (UX audit P2-20): two rows' shapes. */
function LoadingRows() {
  return (
    <div role="status" aria-label="Loading the maps" className="grid gap-2">
      <Skeleton className="h-3 w-24 rounded-sm" />
      <div className="grid border border-hair-strong bg-card">
        {[0, 1].map((row) => (
          <div
            key={row}
            className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[1fr_116px_190px] sm:gap-5"
          >
            <div className="col-span-2 grid gap-2 sm:col-span-1">
              <Skeleton className="h-4 w-56 rounded-sm" />
              <Skeleton className="h-3 w-80 rounded-sm" />
            </div>
            <Skeleton className="h-3 w-full rounded-sm" />
            <Skeleton className="h-8 w-24 justify-self-end rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Home: the greeting, the composer, and every map grouped by who it waits on (spec D4, D6). */
export function InboxPage() {
  useDocumentTitle(pageTitle(["Inbox"]));
  const projects = useQuery(orpc.project.list.queryOptions());
  const overviews = useMapOverviews();
  const groups = overviews.data === undefined ? null : groupMaps(overviews.data);
  // A fetch failure shows nothing beyond the live Alert; the cached reads stay (QA-3).
  const projectsError = shownQueryError(projects.error);
  const overviewsError = shownQueryError(overviews.error);

  return (
    <main className="mx-auto grid max-w-[880px] gap-7 px-4 pt-8 pb-32 sm:gap-9 sm:px-6 sm:pt-12">
      <h1 className="font-display text-[28px] leading-[1.1] font-bold tracking-[-0.035em] sm:text-[32px]">
        {greeting(new Date().getHours())}{" "}
        {groups === null ? null : waitingSentence(groups["needs-you"].length)}
      </h1>

      {projectsError !== null && <LoadFailed what="the projects" error={projectsError} />}
      {projects.data !== undefined &&
        (projects.data.length === 0 ? (
          <NoProjects />
        ) : (
          <MapComposer
            target={{ kind: "choose", projects: projects.data }}
            disabledReason={composerDisabledReason(projects.data)}
            onCancel={null}
          />
        ))}

      {overviewsError !== null && <LoadFailed what="the maps" error={overviewsError} />}
      {groups === null && overviewsError === null && <LoadingRows />}
      {groups !== null && overviews.data !== undefined && (
        <>
          {overviews.data.length === 0 &&
            projects.data !== undefined &&
            projects.data.length > 0 && (
              <p className="text-sm text-muted-foreground">
                No maps yet. Describe a change above to start one.
              </p>
            )}
          <InboxSection title="Needs you" needsYou={true} overviews={groups["needs-you"]} />
          <InboxSection title="Agent is working" needsYou={false} overviews={groups.working} />
          <QuietMaps
            overviews={groups.quiet}
            active={groups["needs-you"].length + groups.working.length}
          />
        </>
      )}
    </main>
  );
}
