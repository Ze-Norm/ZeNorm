import { Link } from "@tanstack/react-router";
import type {
  Disposition,
  FollowUpView,
  MapOverviewDetail,
  MapSpec,
  SpecRevisionView,
  TicketContent,
  TextDelta,
  TicketSetView,
  WaypointKind,
} from "@zenorm/contracts";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { SpecStageLink } from "@/components/SpecStageLink";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { criterionChange, wasLine } from "@/lib/specs";
import { runInLabels, ticketCriteria, ticketDecisions } from "@/lib/tickets";
import { ChangeBadge } from "@/pages/stages/spec/Changes";

/** A waypoint reference's label, after the demo's "Decision" and "Research". */
const REFERENCE_KIND: Record<WaypointKind, string> = {
  grilling: "Decision",
  research: "Research",
  task: "Task",
};

function ticketTitle(tickets: readonly TicketContent[], id: string): string {
  const ticket = tickets.find((other) => other.id === id);
  if (ticket === undefined) {
    throw new Error(`The ticket set has no ticket ${id}`);
  }
  return ticket.title;
}

/**
 * The earlier delivered ticket a ticket follows up (S8b-14): core's follow-up and the earlier
 * ticket's title, from the set of the revision that delivered it.
 */
function followUpOf(
  spec: MapSpec,
  set: TicketSetView,
  ticket: TicketContent,
): { view: FollowUpView; title: string } {
  const view = set.followUps[ticket.id];
  if (view === undefined) {
    throw new Error(
      `Ticket ${ticket.id} follows up ${String(ticket.followUp)} with no follow-up read`,
    );
  }
  const earlier = spec.ticketSets
    .find((candidate) => candidate.revision === view.revision)
    ?.content.tickets.find((candidate) => candidate.id === view.ticket);
  if (earlier === undefined) {
    throw new Error(`Ticket ${ticket.id} follows up ${view.ticket}, which no earlier set holds`);
  }
  return { view, title: earlier.title };
}

/** One section of a ticket's details: its label and count on the trigger, its content under. */
function Detail({
  value,
  label,
  count,
  children,
}: {
  value: string;
  label: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger className="py-2.5 text-[13px] font-medium hover:no-underline [&>svg]:size-3.5">
        <span>
          {label}
          {count !== undefined && (
            <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
              {count}
            </span>
          )}
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-3 text-[13px]">{children}</AccordionContent>
    </AccordionItem>
  );
}

/** A ticket's id before its title, as a link's or a line's label. */
function TicketRef({ id, title }: { id: string; title: string }) {
  return (
    <>
      <span className="font-mono text-[11px] text-muted-foreground">{id}</span>{" "}
      <AgentText text={title} />
    </>
  );
}

/**
 * How a criterion's text changed from the revision before, under its text as the Spec page's
 * clause shows it: a changed one's earlier wording, a moved one's earlier id; nothing on a first
 * revision or for a new or unchanged criterion.
 */
function WasLine({ delta, criterion }: { delta: TextDelta | null; criterion: string }) {
  const was = delta === null ? null : wasLine(criterion, criterionChange(delta, criterion));
  if (was === null) return null;
  return (
    <span data-was={was.kind} className="mt-0.5 block text-[12.5px] text-muted-foreground">
      {was.kind === "changed" ? (
        <>
          {was.label}:{" "}
          <span className="line-through">
            <AgentText text={was.text} />
          </span>
        </>
      ) : (
        was.line
      )}
    </span>
  );
}

/**
 * One ticket (D10; UX audit B2), led by what the person approves it for: its id and title, a row
 * of its key facts (what it waits on and what waits on it, the delivered ticket it follows up, what
 * it takes out), and the text of the criteria it carries under their clauses, past a first
 * revision each with how its text changed (its change badge, and a changed one's earlier wording). The implementer's
 * brief and the rest sit behind triggers with a count: Blocked by (what each supplies), Follow-up
 * to (the delivery it changes), Takes out, How it's built, Testing and completion, Out of scope,
 * and Decisions behind it (the waypoints its clauses rest on).
 */
export function TicketCard({
  detail,
  spec,
  set,
  ticket,
  revision,
}: {
  detail: MapOverviewDetail;
  spec: MapSpec;
  set: TicketSetView;
  ticket: TicketContent;
  revision: SpecRevisionView;
}) {
  const mapId = detail.map.id;
  const { tickets } = set.content;
  const followed = ticket.followUp === null ? null : followUpOf(spec, set, ticket);
  const takesOut = set.content.dispositions.filter(
    (disposition): disposition is Extract<Disposition, { kind: "removed" }> =>
      disposition.kind === "removed" && disposition.ticket === ticket.id,
  );
  const carried = ticketCriteria(revision.content, ticket.criteria);
  const clauses = carried.map((entry) => entry.clause);
  const waypoints = ticketDecisions(revision, clauses);
  const blocks = tickets.filter((other) =>
    other.blockedBy.some((blocker) => blocker.ticket === ticket.id),
  );
  const criteriaCount = ticket.criteria.length;
  // Past a first revision each criterion shows how its text changed from the revision before.
  const { delta } = revision;

  return (
    <Card asChild className="scroll-mt-4">
      <li id={`ticket-${ticket.id}`} className="grid grid-cols-[minmax(0,1fr)] px-4 pt-3.5">
        <h3 className="font-display text-[17px] leading-snug font-semibold tracking-[-0.015em]">
          <span className="mr-1 font-mono text-[12px] font-normal tracking-normal text-muted-foreground">
            {ticket.id}
          </span>{" "}
          <span>
            <AgentText text={ticket.title} />
          </span>
        </h3>

        <ul aria-label="Key facts" className="mt-2 flex flex-wrap items-center gap-1.5">
          {ticket.blockedBy.length === 0 ? (
            <li>
              <Badge variant="outline">can start now</Badge>
            </li>
          ) : (
            ticket.blockedBy.map((blocker) => (
              <li key={blocker.ticket}>
                <Badge asChild variant="outline">
                  <SpecStageLink
                    mapId={mapId}
                    specs={detail.specs}
                    stage="tickets"
                    specNumber={spec.number}
                    search={{}}
                    hash={`ticket-${blocker.ticket}`}
                    title={ticketTitle(tickets, blocker.ticket)}
                    className="hover:text-primary"
                  >
                    after {blocker.ticket}
                  </SpecStageLink>
                </Badge>
              </li>
            ))
          )}
          {blocks.length > 0 && (
            <li>
              <Badge variant="secondary">
                {blocks.map((other) => other.id).join(", ")} wait{blocks.length === 1 ? "s" : ""} on
                it
              </Badge>
            </li>
          )}
          {followed !== null && (
            <li>
              <Badge asChild variant="soft">
                <Link
                  to="/maps/$mapId/$stage/$specNumber"
                  params={{
                    mapId: followed.view.mapId,
                    stage: "tickets",
                    specNumber: spec.number,
                  }}
                  hash={`ticket-${followed.view.ticket}`}
                  title={followed.title}
                >
                  follows up {followed.view.ticket}
                </Link>
              </Badge>
            </li>
          )}
          {takesOut.length > 0 && (
            <li>
              <Badge variant="bad">
                takes out {takesOut.map((disposition) => disposition.criterion).join(", ")}
              </Badge>
            </li>
          )}
          {criteriaCount === 0 && (
            <li>
              <Badge variant="outline">no criteria</Badge>
            </li>
          )}
        </ul>

        {/* What the person approves: the criteria the ticket delivers, as their text. */}
        {criteriaCount > 0 && (
          <div
            role="group"
            aria-label={`What ${ticket.id} delivers`}
            className="mt-3 mb-3 grid max-w-[78ch] gap-2.5 text-[14px] leading-relaxed"
          >
            {carried.map(({ clause, criteria }) => (
              <div key={clause.id} className="grid gap-1">
                <SpecStageLink
                  mapId={mapId}
                  specs={detail.specs}
                  stage="spec"
                  specNumber={spec.number}
                  search={{}}
                  hash={`clause-${clause.id}`}
                  className="w-fit text-left text-xs text-muted-foreground hover:text-primary"
                >
                  <span className="font-mono text-[11px]">{clause.id}</span> ·{" "}
                  <AgentText text={clause.title} />
                </SpecStageLink>
                <ul className="grid gap-1">
                  {criteria.map((criterion) => {
                    const change =
                      delta === null ? null : criterionChange(delta, criterion.id).change;
                    return (
                      <li
                        key={criterion.id}
                        data-criterion={criterion.id}
                        className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-2"
                      >
                        <span className="font-mono text-[11px] leading-[1.9] text-faint">
                          {criterion.id}
                        </span>
                        <span>
                          <AgentText text={criterion.text} />
                          <WasLine delta={delta} criterion={criterion.id} />
                        </span>
                        <span className="pt-0.5">
                          {change !== null && <ChangeBadge change={change} />}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        <Accordion type="multiple" className="border-t border-border">
          {ticket.blockedBy.length > 0 && (
            <Detail value="blocked-by" label="Blocked by" count={ticket.blockedBy.length}>
              <ul className="grid gap-1.5">
                {ticket.blockedBy.map((blocker) => (
                  <li key={blocker.ticket}>
                    <SpecStageLink
                      mapId={mapId}
                      specs={detail.specs}
                      stage="tickets"
                      specNumber={spec.number}
                      search={{}}
                      hash={`ticket-${blocker.ticket}`}
                      className="hover:text-primary hover:underline"
                    >
                      <TicketRef id={blocker.ticket} title={ticketTitle(tickets, blocker.ticket)} />
                    </SpecStageLink>
                    <div className="text-muted-foreground">
                      It supplies <AgentText text={blocker.supplies} />
                    </div>
                  </li>
                ))}
              </ul>
            </Detail>
          )}
          {followed !== null && (
            <Detail value="follow-up" label="Follow-up to" count={followed.view.ticket}>
              <Link
                to="/maps/$mapId/$stage/$specNumber"
                params={{
                  mapId: followed.view.mapId,
                  stage: "tickets",
                  specNumber: spec.number,
                }}
                hash={`ticket-${followed.view.ticket}`}
                className="text-left hover:text-primary hover:underline"
              >
                <TicketRef id={followed.view.ticket} title={followed.title} />
              </Link>
              <div className="text-muted-foreground">
                Delivered under r{followed.view.revision} in run {followed.view.run}, commit{" "}
                <span className="font-mono text-[12px]">{followed.view.commit.slice(0, 7)}</span>
                {followed.view.mapId === mapId ? "" : ` on “${followed.view.mapTitle}”`}. This
                ticket changes what it built; its record stays as it was.
              </div>
            </Detail>
          )}
          {takesOut.length > 0 && (
            <Detail value="takes-out" label="Takes out" count={takesOut.length}>
              <ul className="grid gap-1 text-muted-foreground">
                {takesOut.map((disposition) => (
                  <li key={disposition.criterion}>
                    <span className="font-mono text-[11px]">{disposition.criterion}</span>{" "}
                    <AgentText text={disposition.reason} />
                  </li>
                ))}
              </ul>
            </Detail>
          )}
          <Detail value="build" label="How it's built">
            <p className="max-w-[78ch] leading-relaxed">
              <AgentText text={runInLabels(ticket.build)} />
            </p>
          </Detail>
          <Detail value="testing" label="Testing and completion" count={ticket.testing.length}>
            <ul className="grid gap-1">
              {ticket.testing.map((line, index) => (
                <li key={index}>
                  <AgentText text={runInLabels(line)} />
                </li>
              ))}
            </ul>
          </Detail>
          {ticket.outOfScope.length > 0 && (
            <Detail value="out-of-scope" label="Out of scope" count={ticket.outOfScope.length}>
              <ul className="grid gap-1 text-muted-foreground">
                {ticket.outOfScope.map((line, index) => (
                  <li key={index} className="flex gap-2">
                    <X className="mt-[3px] size-3.5 shrink-0 text-faint" aria-hidden />
                    <span>
                      <AgentText text={line} />
                    </span>
                  </li>
                ))}
              </ul>
            </Detail>
          )}
          {waypoints.length > 0 && (
            <Detail value="decisions" label="Decisions behind it" count={waypoints.length}>
              <div className="grid gap-1.5">
                {waypoints.map((waypoint) => (
                  <Link
                    key={`${waypoint.mapId}-${String(waypoint.number)}`}
                    to="/maps/$mapId/wayfinding/$number"
                    params={{ mapId: waypoint.mapId, number: waypoint.number }}
                    className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 text-left hover:text-primary"
                  >
                    <span className="text-muted-foreground">
                      {REFERENCE_KIND[waypoint.kind]}
                      {waypoint.mapId !== mapId && " · earlier map"}
                    </span>
                    <span>
                      <AgentText text={waypoint.title} />.{" "}
                      {waypoint.gist !== null && (
                        <span className="text-muted-foreground">
                          <AgentText text={waypoint.gist} />
                        </span>
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            </Detail>
          )}
        </Accordion>
      </li>
    </Card>
  );
}
