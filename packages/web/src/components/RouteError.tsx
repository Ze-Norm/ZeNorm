import { Link, useParams, useSearch, type ErrorComponentProps } from "@tanstack/react-router";
import type { AccessDeniedError, MapNotFoundError, ProjectNotFoundError } from "@zenorm/contracts";
import { CircleAlert, Home } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { pageTitle, useDocumentTitle } from "@/lib/document-title";
import {
  describeQueryRefusal,
  describeRouteError,
  type RouteErrorLink,
  type RouteErrorView,
} from "@/lib/route-error";

/**
 * The page shown in place of one that could not open: a route error (an unknown
 * stage, a param that is not a UUIDv7, a search value for a record the map does not have), an
 * address no route matches, or a read the server refused (a map or project that does not exist,
 * access denied). One frame for all of them: a card with the title as the page's `h1`, a sentence
 * a person can act on, the address, id or thrown message as a mono detail line when it adds
 * something, and the places the address was near, the inbox always last. Under a map it renders
 * inside the layout, so the stage rail stays above it.
 */
export function RouteErrorPage({ view }: { view: RouteErrorView }) {
  const headingId = useId();
  useDocumentTitle(pageTitle([view.title]));
  return (
    <main
      aria-labelledby={headingId}
      className="mx-auto max-w-[880px] px-4 pt-8 pb-32 sm:px-6 sm:pt-12"
    >
      <Card className="grid max-w-[640px] gap-4 px-6 py-5">
        <div className="flex items-start gap-3">
          <CircleAlert className="mt-[3px] size-4 shrink-0 text-bad" />
          <div className="grid min-w-0 gap-1.5">
            <h1
              id={headingId}
              className="font-display text-[20px] leading-snug font-semibold tracking-[-0.015em]"
            >
              {view.title}
            </h1>
            <p className="text-[14px] text-muted-foreground">{view.sentence}</p>
            {view.detail !== null && (
              <p className="font-mono text-[12px] break-all text-faint">{view.detail}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pl-7">
          {view.links.map((link, index) => (
            <RouteErrorButton key={link.label} link={link} primary={index === 0} />
          ))}
        </div>
      </Card>
    </main>
  );
}

/** The router's error component: what the address was near and where to go instead. */
export function RouteError({ error }: ErrorComponentProps) {
  // Loose, as the failed route's own params and search may not have parsed.
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const view = describeRouteError(error, {
    mapId: params.mapId,
    projectId: params.projectId,
    stage: params.stage,
    specNumber: params.specNumber,
    number: params.number,
    ticketId: params.ticketId,
    search,
  });
  return <RouteErrorPage view={view} />;
}

/**
 * The page for a read the server refused: `map.overview`'s `map_not_found` and
 * `project.get`'s `project_not_found`, or `access_denied` on either. The map layout and the project
 * pages render it in place of their content.
 */
export function QueryRefusal({
  error,
}: {
  error: MapNotFoundError | ProjectNotFoundError | AccessDeniedError;
}) {
  return <RouteErrorPage view={describeQueryRefusal(error)} />;
}

/** One way out: the first as the outline button, the rest ghost; the inbox always last. */
function RouteErrorButton({ link, primary }: { link: RouteErrorLink; primary: boolean }) {
  const variant = primary ? "outline" : "ghost";
  switch (link.to) {
    case "inbox":
      return (
        <Button asChild variant={variant} size="sm">
          <Link to="/">
            <Home /> {link.label}
          </Link>
        </Button>
      );
    case "project":
      return (
        <Button asChild variant={variant} size="sm">
          <Link to="/projects/$projectId" params={{ projectId: link.projectId }}>
            {link.label}
          </Link>
        </Button>
      );
    case "stage":
      if (link.specNumber !== null && link.stage !== "idea" && link.stage !== "wayfinding") {
        return (
          <Button asChild variant={variant} size="sm">
            <Link
              to="/maps/$mapId/$stage/$specNumber"
              params={{ mapId: link.mapId, stage: link.stage, specNumber: link.specNumber }}
              search={link.search}
            >
              {link.label}
            </Link>
          </Button>
        );
      }
      return (
        <Button asChild variant={variant} size="sm">
          <Link
            to="/maps/$mapId/$stage"
            params={{ mapId: link.mapId, stage: link.stage }}
            search={link.search}
          >
            {link.label}
          </Link>
        </Button>
      );
  }
}
