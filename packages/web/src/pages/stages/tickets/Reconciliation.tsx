import { Link } from "@tanstack/react-router";
import type {
  Disposition,
  MapSpec,
  SpecRevisionContent,
  SpecRevisionView,
  TextDelta,
  TicketSetView,
} from "@zenorm/contracts";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";

import { AgentText } from "@/components/AgentText";
import { SectionHead } from "@/components/parts";
import { SpecStageLink } from "@/components/SpecStageLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  earlierTicketDelivery,
  onTicketCard,
  reconciliationGroups,
  reconciliationRows,
  tallyParts,
  type ReconciliationRow,
} from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { ChangeBadge } from "@/pages/stages/spec/Changes";

/** "1 criterion", "4 criteria". */
function criteriaCount(n: number): string {
  return `${String(n)} ${n === 1 ? "criterion" : "criteria"}`;
}

/** What the agent says the code needs for a criterion (the demo's `DispositionBadge`). */
export function DispositionBadge({ disposition }: { disposition: Disposition }) {
  switch (disposition.kind) {
    case "work":
      return <Badge>needs work · {disposition.ticket}</Badge>;
    case "delivered":
      return <Badge variant="ok">carries over · {disposition.ticket}</Badge>;
    case "retained":
      return <Badge variant="secondary">retained · {disposition.ticket}</Badge>;
    case "satisfied":
      return <Badge variant="ok">already done</Badge>;
    case "removed":
      return disposition.ticket === null ? (
        <Badge variant="secondary">removed · nothing to take out</Badge>
      ) : (
        <Badge variant="bad">taken out · {disposition.ticket}</Badge>
      );
  }
}

/** The tally's badge tone per kind, as the rows' badges. */
const TALLY_TONE: Record<Disposition["kind"], "default" | "ok" | "secondary" | "bad"> = {
  work: "default",
  delivered: "ok",
  retained: "secondary",
  satisfied: "ok",
  removed: "bad",
};

/** The set's dispositions tallied as badges (UX audit B1), and how many rows the review questioned. */
function Tally({
  dispositions,
  departures,
}: {
  dispositions: readonly Disposition[];
  departures: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {tallyParts(dispositions).map(([n, label, kind]) => (
        <Badge key={kind} variant={TALLY_TONE[kind]} data-kind={kind}>
          {n} {label}
        </Badge>
      ))}
      {departures > 0 && (
        <Badge variant="work" data-kind="departure">
          {departures} where text and code disagree
        </Badge>
      )}
    </div>
  );
}

/**
 * Where a carried-over criterion was delivered (the demo's `deliveryLine`), from the run records:
 * the earlier ticket, opened on the Tickets page of the map that wrote its revision.
 */
function DeliveredLine({
  spec,
  revision,
  ticket,
}: {
  spec: MapSpec;
  revision: number;
  ticket: string;
}) {
  const delivery = earlierTicketDelivery(spec, revision, ticket);
  if (delivery === null) {
    throw new Error(`Ticket ${ticket} is marked delivered, which no merged run delivered`);
  }
  return (
    <p className="mt-1 text-[12.5px] text-muted-foreground">
      Delivered by{" "}
      <Link
        to="/maps/$mapId/$stage/$specNumber"
        params={{ mapId: delivery.mapId, stage: "tickets", specNumber: spec.number }}
        hash={`ticket-${delivery.ticket.id}`}
        className="font-mono text-[11.5px] text-foreground hover:text-primary hover:underline"
        title={delivery.ticket.title}
      >
        {delivery.ticket.id}
      </Link>{" "}
      under r{delivery.revision} in run {delivery.run}, commit{" "}
      <span className="font-mono text-[11.5px]">{delivery.commit.slice(0, 7)}</span>; its tests stay
      in the suite, so the run's checks show it still holds.
    </p>
  );
}

/**
 * The line that opens the section: how many of the revision's criteria the ticket cards above carry
 * (their text, and past a first revision how it changed, is there, so the section does not repeat
 * it), whether any are left for the table, and how many of those on a card the review questioned
 * (listed too, pointing at the card).
 */
function CoverageLine({
  dispositions,
  tickets,
  questioned,
}: {
  dispositions: readonly Disposition[];
  tickets: number;
  questioned: number;
}) {
  const total = dispositions.length;
  const onCards = dispositions.filter((disposition) => disposition.kind === "work").length;
  const above = tickets === 1 ? "the ticket above" : "the tickets above";
  let line: string;
  if (onCards === total) {
    line =
      total === 1
        ? `The criterion is delivered by ${above}.`
        : `All ${String(total)} criteria are delivered by ${above}.`;
  } else if (onCards === 0) {
    line =
      total === 1
        ? "No ticket carries the criterion; it is below."
        : `No ticket carries any of the ${String(total)} criteria; they are below.`;
  } else {
    const rest = total - onCards;
    const verb = onCards === 1 ? "is" : "are";
    const others = rest === 1 ? "the other is below" : `the other ${String(rest)} are below`;
    line = `${String(onCards)} of ${criteriaCount(total)} ${verb} delivered by ${above}; ${others}.`;
  }
  if (questioned > 0) {
    line +=
      questioned === 1
        ? " The review questioned one on a card; it is below too."
        : ` The review questioned ${String(questioned)} on cards; they are below too.`;
  }
  return <p className="text-[13px] text-muted-foreground">{line}</p>;
}

/**
 * The reconciliation section's title: Coverage on a first revision, else what the revision's
 * change needs from the code. The Tickets index names the section by it.
 */
export function reconciliationTitle(delta: TextDelta | null): string {
  return delta === null ? "Coverage" : "What this revision needs from the code";
}

/**
 * The reconciliation (slice 8b D12, the demo's `Reconciliation`; slice 7c's Coverage on a first
 * revision), under its clauses (one header row per clause, UX audit B1), with what the agent says
 * the code needs. A criterion that plainly needs work is left to its ticket card, which leads with
 * its text and, past a first revision, how that text changed: a line counts them, and the table
 * lists only the rest (carried over or retained with the earlier ticket, already done with its
 * evidence, taken out with its reason, or questioned by the review, which points at the card), and
 * is left out when there are none. Past a first revision each row also shows how its text changed
 * from the revision before, and the table includes every criterion the revision takes out. A row
 * whose disposition departs from what the text delta and the baseline suggest shows core's
 * reading: the expectation, the review's question and the agent's reason. A clause opens on the
 * Spec page; a work badge opens its ticket's card.
 */
export function Reconciliation({
  mapId,
  specs,
  spec,
  content,
  set,
  delta,
  takenOut,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  spec: MapSpec;
  content: SpecRevisionContent;
  set: TicketSetView;
  delta: TextDelta | null;
  takenOut: SpecRevisionView["takenOut"];
}) {
  const { dispositions } = set.content;
  const rows = reconciliationRows(content, delta, takenOut, dispositions);
  const readingOf = (criterion: string) => {
    const reading = set.readings[criterion];
    if (reading === undefined) {
      throw new Error(`Ticket set ${set.id} has no reading of criterion ${criterion}`);
    }
    return reading;
  };
  const departureOf = (row: ReconciliationRow) =>
    row.removed ? null : readingOf(row.criterion.id).departure;
  const departures = rows.filter((row) => departureOf(row) !== null).length;
  // A criterion that plainly needs work is left to its ticket card.
  const listed = rows.filter((row) => !onTicketCard(row, departureOf(row) !== null));
  const questioned = listed.filter((row) => row.disposition.kind === "work").length;
  const groups = reconciliationGroups(listed, delta);
  const title = reconciliationTitle(delta);
  const columns = delta === null ? 2 : 3;

  return (
    <section
      id="impl-reconciliation"
      aria-label={title}
      className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)] gap-2"
    >
      <SectionHead
        title={title}
        right={<Tally dispositions={dispositions} departures={departures} />}
      />
      <CoverageLine
        dispositions={dispositions}
        tickets={set.content.tickets.length}
        questioned={questioned}
      />
      {delta !== null && (
        <Collapsible className="grid justify-items-start gap-1">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group -ml-2.5 h-7 text-[12.5px]">
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
              How this is read
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="max-w-[72ch] text-[12.5px] text-muted-foreground">
              Three records, kept apart: how the <span className="text-foreground">text</span>{" "}
              changed from r{delta.before} (derived from the ids), what the code already does
              (derived from the delivery runs), and what the agent says the code{" "}
              <span className="text-foreground">needs</span>. The tickets review asked for a reason
              wherever the third departs from the first two; those rows are marked.
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
      {groups.length > 0 && (
        <div className="border border-hair-strong bg-card">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="micro h-8">Acceptance criterion</TableHead>
                {delta !== null && <TableHead className="micro h-8 w-[84px]">Text</TableHead>}
                <TableHead className="micro h-8 w-[220px]">Code needs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => {
                const { clause } = group;
                const removedClause = group.change === "removed";
                return (
                  <Fragment key={clause.id}>
                    <TableRow
                      data-clause={clause.id}
                      className="bg-secondary/70 hover:bg-secondary/70"
                    >
                      <TableCell colSpan={columns} className="py-2 whitespace-normal">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <SpecStageLink
                            mapId={mapId}
                            specs={specs}
                            stage="spec"
                            specNumber={spec.number}
                            search={{}}
                            hash={removedClause ? "spec-removed" : `clause-${clause.id}`}
                            className={cn(
                              "text-left font-display text-[13.5px] font-semibold tracking-[-0.01em] hover:text-primary",
                              removedClause && "text-muted-foreground line-through",
                            )}
                          >
                            <span className="mr-2 font-mono text-[11px] font-normal text-muted-foreground">
                              {clause.id}
                            </span>
                            <AgentText text={clause.title} />
                          </SpecStageLink>
                          {group.change !== null && group.change !== "unchanged" && (
                            <ChangeBadge change={group.change} />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {group.rows.map((row) => {
                      const { criterion, removed, disposition, change } = row;
                      const reading = removed ? null : readingOf(criterion.id);
                      const departure = reading === null ? null : reading.departure;
                      // A work criterion is listed only for the review's question; its text,
                      // and how that text changed, are on its ticket's card.
                      const onCard = disposition.kind === "work";
                      return (
                        <TableRow
                          key={criterion.id}
                          data-criterion={criterion.id}
                          className={cn(
                            removed && "text-muted-foreground",
                            departure && "bg-work-soft/40 hover:bg-work-soft/40",
                          )}
                        >
                          <TableCell className="align-top whitespace-normal">
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {criterion.id}
                            </span>{" "}
                            {onCard ? (
                              <a
                                href={`#ticket-${disposition.ticket}`}
                                className="text-muted-foreground hover:text-primary hover:underline"
                              >
                                On {disposition.ticket}'s card above.
                              </a>
                            ) : (
                              <span className={cn(removed && "line-through")}>
                                <AgentText text={criterion.text} />
                              </span>
                            )}
                            {disposition.kind === "delivered" && (
                              <DeliveredLine
                                spec={spec}
                                revision={set.revision}
                                ticket={disposition.ticket}
                              />
                            )}
                            {disposition.kind === "satisfied" && (
                              <p className="mt-1 text-[12.5px] text-muted-foreground">
                                No ticket needed. <AgentText text={disposition.evidence} />
                              </p>
                            )}
                            {disposition.kind === "retained" && (
                              <p className="mt-1 text-[12.5px] text-muted-foreground">
                                An approved ticket of an earlier revision still carries it and
                                hasn't been delivered yet.
                              </p>
                            )}
                            {disposition.kind === "removed" && (
                              <p className="mt-1 text-[12.5px] text-muted-foreground">
                                <AgentText text={disposition.reason} />
                              </p>
                            )}
                            {reading !== null && departure !== null && (
                              <div
                                data-departure={criterion.id}
                                className="mt-1.5 grid gap-1 border-l-2 border-work-dot pl-2.5 text-[12.5px]"
                              >
                                <span className="text-work">
                                  The text says otherwise:{" "}
                                  <AgentText text={reading.expectation.why} />. The review asked:{" "}
                                  <AgentText text={departure.question} />
                                </span>
                                {departure.reason === null ? (
                                  <span className="text-bad">
                                    No reason given. The review failed on this row.
                                  </span>
                                ) : (
                                  <span>
                                    <span className="font-medium">
                                      The agent's reason, accepted:
                                    </span>{" "}
                                    <AgentText text={departure.reason} />
                                  </span>
                                )}
                              </div>
                            )}
                          </TableCell>
                          {delta !== null && (
                            <TableCell className="align-top">
                              {!onCard &&
                                (change === "unchanged" ? (
                                  <span className="text-[12px] text-faint">unchanged</span>
                                ) : (
                                  change !== null && <ChangeBadge change={change} />
                                ))}
                            </TableCell>
                          )}
                          <TableCell className="align-top">
                            {disposition.kind === "work" ? (
                              <a href={`#ticket-${disposition.ticket}`} title="Open the ticket">
                                <DispositionBadge disposition={disposition} />
                              </a>
                            ) : (
                              <DispositionBadge disposition={disposition} />
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
