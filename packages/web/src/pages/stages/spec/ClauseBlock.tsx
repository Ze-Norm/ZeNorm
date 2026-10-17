import { Link } from "@tanstack/react-router";
import type { Clause, MapSpec, SpecRevisionView, TicketSetView } from "@zenorm/contracts";
import { Check, ChevronRight, MessageCircleQuestion, PenLine } from "lucide-react";
import { Fragment } from "react";

import { AgentText } from "@/components/AgentText";
import { useHatch } from "@/components/hatch/HatchProvider";
import { SpecStageLink } from "@/components/SpecStageLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { clausePrefill, type ClausePrefill } from "@/lib/hatch";
import {
  clauseChange,
  clauseFooter,
  clauseRunMarks,
  criterionChange,
  deliveredUnder,
  type FooterSource,
  wasLine,
} from "@/lib/specs";
import { cn } from "@/lib/utils";
import { ChangeBadge } from "@/pages/stages/spec/Changes";

/**
 * One clause: its id, title, text and criteria, each criterion's change past r1 with its "Was"
 * line, the criteria the revision drops, a folded `ClauseDetails` (what it relies on and adds, and
 * "From …": each waypoint on whichever map wrote it, then the destination, then "your note"), and
 * the footer: "Checked by …" once a ticket set exists, and "Delivered under rN by …" for the
 * criteria the set carries over, with a tick once this map's latest run is merged; a criterion that
 * run's blocking findings name reads failing, with "fails review". At the footer's right, **Ask**
 * and **Propose a change** open the hatch prefilled and send nothing; after a send from either,
 * "Sent to the activity log →".
 */
export function ClauseBlock({
  mapId,
  specs,
  spec,
  revision,
  clause,
  ticketSet,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  spec: MapSpec;
  /** The revision shown. */
  revision: SpecRevisionView;
  clause: Clause;
  ticketSet: TicketSetView | undefined;
}) {
  const sources = revision.clauseSources[clause.id];
  if (sources === undefined) {
    throw new Error(`Revision ${String(revision.revision)} has no sources for ${clause.id}`);
  }
  const { delta } = revision;
  const footer = clauseFooter(clause, sources, ticketSet);
  const marks = clauseRunMarks(
    spec,
    mapId,
    clause.criteria.map((criterion) => criterion.id),
    footer.checkedBy.map((ticket) => ticket.id),
  );
  const carried = delta === null ? [] : deliveredUnder(clause, ticketSet);
  const removed =
    delta === null ? [] : delta.removedCriteria.filter((entry) => entry.clause.id === clause.id);
  const hatch = useHatch();
  const origin = `spec-${String(spec.number)}-${clause.id}`;
  const prefill = (kind: ClausePrefill) => {
    hatch.openHatch({ text: clausePrefill(kind, clause.id), origin });
  };
  const ticketLink = (id: string, title: string | undefined) => (
    <SpecStageLink
      mapId={mapId}
      specs={specs}
      stage="tickets"
      specNumber={spec.number}
      search={{}}
      hash={`ticket-${id}`}
      {...(title === undefined ? {} : { title })}
      className="font-mono text-foreground hover:text-primary hover:underline"
    >
      {id}
    </SpecStageLink>
  );
  return (
    <Card id={`clause-${clause.id}`} className="grid scroll-mt-4 gap-3 p-4">
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-[11px] text-primary">{clause.id}</span>
        <h3 className="flex-1 font-display text-[17px] leading-tight font-bold tracking-[-0.02em]">
          <AgentText text={clause.title} />
        </h3>
        {delta !== null && <ChangeBadge change={clauseChange(delta, clause.id)} />}
      </div>
      <p className="text-[15px] leading-relaxed">
        <AgentText text={clause.text} />
      </p>
      <ol aria-label={`Criteria of ${clause.id}`} className="grid">
        {clause.criteria.map((criterion) => {
          const change = delta === null ? null : criterionChange(delta, criterion.id);
          const was = change === null ? null : wasLine(criterion.id, change);
          const failing = marks.failing.includes(criterion.id);
          return (
            <li
              key={criterion.id}
              data-failing={failing}
              className={cn(
                "grid grid-cols-[36px_minmax(0,1fr)_auto] gap-2 border-t border-border py-2 text-[13.5px]",
                failing && "text-bad",
              )}
            >
              <span
                className={cn(
                  "font-mono text-[11px] leading-[1.8]",
                  failing ? "text-bad" : "text-faint",
                )}
              >
                {criterion.id}
              </span>
              <span>
                <AgentText text={criterion.text} />
                {was?.kind === "changed" && (
                  <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                    {was.label}:{" "}
                    <span className="line-through">
                      <AgentText text={was.text} />
                    </span>
                  </span>
                )}
                {was?.kind === "moved" && (
                  <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                    {was.line}
                  </span>
                )}
              </span>
              <span className="flex items-start gap-1">
                {change !== null && <ChangeBadge change={change.change} />}
                {failing && (
                  <Badge variant="bad" asChild>
                    <SpecStageLink
                      mapId={mapId}
                      specs={specs}
                      stage="delivery"
                      specNumber={spec.number}
                      search={{}}
                    >
                      fails review
                    </SpecStageLink>
                  </Badge>
                )}
              </span>
            </li>
          );
        })}
        {removed.map(({ criterion }) => (
          <li
            key={criterion.id}
            className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-2 border-t border-border py-2 text-[13.5px] text-muted-foreground"
          >
            <span className="font-mono text-[11px] leading-[1.8] text-faint">{criterion.id}</span>
            <span className="line-through">
              <AgentText text={criterion.text} />
            </span>
            <ChangeBadge change="removed" />
          </li>
        ))}
      </ol>
      <ClauseDetails clause={clause} from={footer.from} mapId={mapId} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5 text-xs text-muted-foreground">
        {footer.checkedBy.length > 0 && (
          <span>
            Checked by{" "}
            {footer.checkedBy.map((ticket, index) => (
              <Fragment key={ticket.id}>
                {index > 0 && ", "}
                {ticketLink(ticket.id, ticket.title)}
              </Fragment>
            ))}
            {marks.merged && <Check className="ml-1 inline size-3.5 text-ok" aria-label="merged" />}
          </span>
        )}
        {carried.map((group) => (
          <span key={group.revision}>
            Delivered under r{group.revision} by{" "}
            {group.tickets.map((id, index) => (
              <Fragment key={id}>
                {index > 0 && ", "}
                {ticketLink(id, undefined)}
              </Fragment>
            ))}
            <Check className="ml-1 inline size-3.5 text-ok" aria-label="delivered" />
          </span>
        ))}
        <span className="flex-1" />
        {/* The clause's two ways into the hatch, as buttons that look like buttons. */}
        <span className="flex shrink-0 flex-wrap items-center gap-2 whitespace-nowrap">
          {hatch.sent.has(origin) && <span>Sent to the activity log →</span>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              prefill("ask");
            }}
          >
            <MessageCircleQuestion /> Ask
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              prefill("propose");
            }}
          >
            <PenLine /> Propose a change
          </Button>
        </span>
      </div>
    </Card>
  );
}

/** The map a source chip belongs to, when it is not the map on screen. */
function SourceMap({ title }: { title: string }) {
  return <span className="text-faint">· {title}</span>;
}

/** A declared name as code: the chip `AgentText` gives a code span, in the name's own case. */
function Identifier({ name, path }: { name: string; path: string | null }) {
  return (
    <code
      className="bg-secondary px-1 py-px font-mono text-[11.5px] text-foreground"
      {...(path === null ? {} : { title: path })}
    >
      {name}
    </code>
  );
}

/**
 * What a clause relies on, what it adds and where it came from, folded behind one toggle that
 * counts each so the card stays short: a clause can name a dozen identifiers and sources. Nothing
 * when the clause has none of the three.
 */
function ClauseDetails({
  clause,
  from,
  mapId,
}: {
  clause: Clause;
  from: readonly FooterSource[];
  mapId: string;
}) {
  const { reliesOn, adds } = clause;
  // A clause written before clauses declared what they rely on and add has neither.
  const declared = reliesOn !== undefined && adds !== undefined;
  const counts = [
    ...(declared && reliesOn.length > 0 ? [`Relies on ${String(reliesOn.length)}`] : []),
    ...(declared && adds.length > 0 ? [`Adds ${String(adds.length)}`] : []),
    ...(from.length > 0 ? [`From ${String(from.length)}`] : []),
  ];
  if (counts.length === 0) {
    return null;
  }
  return (
    <Collapsible className="grid gap-2">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Details of ${clause.id}: ${counts.join(", ")}`}
          className="h-7 justify-self-start px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-90"
        >
          <ChevronRight className="transition-transform" />
          {counts.join(" · ")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2">
        {declared && <ClauseDeclarations clause={clause} reliesOn={reliesOn} adds={adds} />}
        {from.length > 0 && <ClauseSources from={from} mapId={mapId} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Each source as a chip that opens it, as the delta panel's kept clauses are, so a clause drawn
 * from several waypoints reads as a list and not a run-on sentence.
 */
function ClauseSources({ from, mapId }: { from: readonly FooterSource[]; mapId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      From
      {from.map((source) =>
        source.kind === "note" ? (
          <Badge
            key={`${source.mapId}-note`}
            variant="outline"
            className="h-auto px-2 py-1 font-sans text-[12.5px] font-normal tracking-normal normal-case"
          >
            your note
            {source.mapId !== mapId && <SourceMap title={source.mapTitle} />}
          </Badge>
        ) : (
          <Button
            key={
              source.kind === "waypoint"
                ? `${source.mapId}-${String(source.number)}`
                : `${source.mapId}-destination`
            }
            asChild
            variant="outline"
            size="sm"
            className="h-auto max-w-full gap-1.5 px-2 py-1 text-left text-[12.5px] font-normal whitespace-normal text-muted-foreground hover:text-foreground"
          >
            {source.kind === "waypoint" ? (
              <Link
                to="/maps/$mapId/wayfinding/$number"
                params={{ mapId: source.mapId, number: source.number }}
              >
                <span className="min-w-0">
                  <AgentText text={source.title} />
                </span>
                {source.mapId !== mapId && <SourceMap title={source.mapTitle} />}
              </Link>
            ) : (
              <Link to="/maps/$mapId/wayfinding/destination" params={{ mapId: source.mapId }}>
                the destination
                {source.mapId !== mapId && <SourceMap title={source.mapTitle} />}
              </Link>
            )}
          </Button>
        ),
      )}
    </div>
  );
}

/**
 * What a clause relies on and what it adds: each identifier as a code chip in its own case,
 * so `ChartConfirmation` reads as written and can be searched for, and each declaration that is a
 * sentence as plain text.
 */
function ClauseDeclarations({
  clause,
  reliesOn,
  adds,
}: {
  clause: Clause;
  reliesOn: NonNullable<Clause["reliesOn"]>;
  adds: NonNullable<Clause["adds"]>;
}) {
  if (reliesOn.length === 0 && adds.length === 0) {
    return null;
  }
  const isIdentifier = (name: string) => /^\S+$/.test(name);
  return (
    <div className="grid gap-1.5 text-[12.5px] text-muted-foreground">
      {reliesOn.length > 0 && (
        <div
          aria-label={`What ${clause.id} relies on`}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
        >
          <span>Relies on</span>
          {reliesOn.map((reliance) => (
            <Identifier
              key={`${reliance.name}@${String(reliance.path)}`}
              name={reliance.name}
              path={reliance.path}
            />
          ))}
        </div>
      )}
      {adds.length > 0 && (
        <div
          aria-label={`What ${clause.id} adds`}
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1"
        >
          <span>Adds</span>
          <ul className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {adds.map((name) =>
              isIdentifier(name) ? (
                <li key={name}>
                  <Identifier name={name} path={null} />
                </li>
              ) : (
                <li key={name} className="basis-full text-foreground">
                  <AgentText text={name} />
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
