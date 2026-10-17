import type { MapOverviewDetail, TicketSetView } from "@zenorm/contracts";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { NextActionCard } from "@/components/NextActionCard";
import { Micro, PageHead, SectionHead } from "@/components/parts";
import { SpecSwitcher } from "@/components/SpecSwitcher";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { WorkspacePage } from "@/components/WorkspaceColumns";
import { formatMoment, mapHeading } from "@/lib/map";
import { shownSpec, waitsOnly } from "@/lib/specs";
import { breakdownLines, criteriaSummary, heldFindings, ticketSetStateLine } from "@/lib/tickets";
import { plural } from "@/pages/stages/delivery/words";
import { EarlierTickets } from "@/pages/stages/tickets/EarlierTickets";
import { Reconciliation } from "@/pages/stages/tickets/Reconciliation";
import { TicketCard } from "@/pages/stages/tickets/TicketCard";
import { TicketsIndex, TicketsJumpMenu } from "@/pages/stages/tickets/TicketsIndex";
import { TicketsReviewPanel } from "@/pages/stages/tickets/TicketsReviewPanel";
import { HeldTickets, PlanningCard, TicketSetDecision } from "@/pages/stages/planning/PlanningCard";
import { NothingWrittenYet } from "@/pages/stages/planning/StageParts";

/**
 * The Tickets stage (spec D10; slice 7c D7; slice 8b D12; UX audit B1–B6): one spec of the
 * map, the route's or core's default, with its latest ticket set's current version. The head names
 * the spec (the map, before it has one), with the set's revision and state in the eyebrow and the
 * tickets and criteria in the lede; then the next-action card, the Tickets review row, the tickets, the reconciliation
 * (Coverage on a first revision), why the agent sliced it so, and the spec's earlier tickets.
 * Tickets are written automatically once the spec is approved, so there is no Write tickets
 * button. `version` from `?version=` must be the current version; any other number is the
 * route's error (D1, L100).
 */
export function TicketsStagePage({
  detail,
  specNumber,
  version,
}: {
  detail: MapOverviewDetail;
  specNumber: number | undefined;
  version: number | undefined;
}) {
  const mapId = detail.map.id;
  // A spec the map only waits on has not reached Tickets here (S8b-16, N-4).
  const waitedOn = specNumber !== undefined && waitsOnly(detail, specNumber);
  const spec = waitedOn ? undefined : shownSpec(detail, "tickets", specNumber);
  // The revision this map wrote last (the demo's `latestRevisionOn`) and its set once approved.
  const own = spec?.revisions.filter((revision) => revision.mapId === mapId).at(-1);
  if (spec !== undefined && own === undefined) {
    throw new Error(`Spec ${String(spec.number)} has no revision this map wrote`);
  }
  const ticketSet =
    spec === undefined || own?.state !== "approved"
      ? undefined
      : spec.ticketSets.find((set) => set.revision === own.revision);
  if (version !== undefined && ticketSet?.version !== version) {
    throw new Error(`This map has no ticket set version ${String(version)}`);
  }
  const next = detail.status.next.find(
    (action) => action.stage === "tickets" && action.spec === spec?.number,
  );
  const switcher =
    spec === undefined ? null : (
      <SpecSwitcher mapId={mapId} specs={detail.specs} stage="tickets" current={spec.number} />
    );
  // Past a first revision (the demo's `before`): the revision's text delta from the one before.
  const delta = own === undefined ? null : own.delta;
  const earlier =
    spec === undefined || own === undefined
      ? []
      : spec.ticketSets.filter((set) => set.revision < own.revision);

  /**
   * The next-action card (slice 7c D7): Approve and Reject (or Confirm, on a set with no ticket) only
   * on an undecided set whose review passed (S7c-6), a held set's escalated findings and hatch
   * button, else the card as core states it. A replaced set has no action (S8b-9); an approved
   * one hands off to Delivery's action, so what holds delivery back shows where the tickets were
   * approved.
   */
  function card(set: TicketSetView | undefined) {
    if (next === undefined) {
      if (set === undefined || spec === undefined || set.state !== "approved" || set.replaced) {
        return null;
      }
      const delivery = detail.status.next.find(
        (entry) => entry.stage === "delivery" && entry.spec === spec.number,
      );
      return delivery === undefined ? null : <NextActionCard mapId={mapId} next={delivery} />;
    }
    const undecided =
      set !== undefined &&
      set.state !== "approved" &&
      !set.replaced &&
      spec?.draftingTickets === null;
    const held = undecided ? heldFindings(set.review) : [];
    let decision: ReactNode = null;
    let shown = next;
    if (undecided && set.review?.state === "passed") {
      decision = <TicketSetDecision key={set.id} ticketSet={set} />;
    } else if (held.length > 0) {
      decision = <HeldTickets findings={held} />;
      // Core's detail line is the first escalated finding's title, which the findings list
      // already shows (L177 (a)): the held card reads headline, findings, button.
      shown = { ...next, detail: null };
    }
    return <PlanningCard mapId={mapId} next={shown} decision={decision} />;
  }

  if (spec === undefined || ticketSet === undefined) {
    const status = spec === undefined ? detail.status.stages[3] : spec.stages[1];
    const revision = own === undefined ? "" : ` · revision ${String(own.revision)}`;
    return (
      <WorkspacePage
        head={
          <>
            {switcher}
            <PageHead
              eyebrow={`Tickets${revision}`}
              title={spec === undefined ? mapHeading(detail.map) : <AgentText text={spec.title} />}
              lede={
                delta === null
                  ? status.line
                  : "When this revision is approved, the agent compares it with what was delivered and writes tickets for the change only."
              }
            />
          </>
        }
      >
        <NothingWrittenYet
          detail={detail}
          card={card(undefined)}
          when="The agent writes the tickets as soon as you approve the spec."
        />
        {spec !== undefined && earlier.length > 0 && (
          <EarlierTickets spec={spec} sets={earlier} mapId={mapId} />
        )}
      </WorkspacePage>
    );
  }

  const revision = spec.revisions.find((r) => r.revision === ticketSet.revision);
  if (revision === undefined) {
    throw new Error(
      `Ticket set ${ticketSet.id} names revision ${String(ticketSet.revision)}, which spec ${String(spec.number)} lacks`,
    );
  }
  const { tickets, dispositions } = ticketSet.content;
  if (ticketSet.review === null && ticketSet.state !== "approved") {
    throw new Error(`Ticket set ${ticketSet.id} is unapproved with no tickets review`);
  }
  const replacing = ticketSet.replaced
    ? spec.revisions.find((r) => r.revision > ticketSet.revision)
    : undefined;
  if (ticketSet.replaced && replacing === undefined) {
    throw new Error(`Ticket set ${ticketSet.id} is replaced, yet no later revision exists`);
  }
  const state = ticketSetStateLine(
    ticketSet,
    replacing === undefined ? null : replacing.revision,
    spec.draftingTickets === null
      ? null
      : spec.draftingTickets === "running"
        ? "running"
        : "stopped",
    formatMoment,
  );
  const count =
    tickets.length === 0
      ? delta === null
        ? "No ticket"
        : `No new ticket for the change from r${String(delta.before)}`
      : `${plural(tickets.length, delta === null ? "ticket" : "new ticket")}${delta === null ? "" : ` for the change from r${String(delta.before)}`}`;
  let ticketsTitle = delta === null ? "Tickets" : "New tickets for this revision";
  if (replacing !== undefined) {
    ticketsTitle = `Replaced by revision ${String(replacing.revision)}.`;
  }
  const approved = ticketSet.state === "approved";
  const nextCard = card(ticketSet);
  // The page's sections, for its index (UX audit C4): the same flags decide both.
  const sections = {
    next: nextCard !== null,
    review: ticketSet.review !== null,
    tickets: tickets.map((ticket) => ({ id: ticket.id, title: ticket.title })),
    delta,
    earlier: earlier.length > 0,
  };

  return (
    <WorkspacePage
      head={
        <>
          {switcher}
          <PageHead
            eyebrow={`Tickets · revision ${String(ticketSet.revision)} · ${state}`}
            title={<AgentText text={spec.title} />}
            lede={`${count} · ${criteriaSummary(dispositions)}`}
          />
        </>
      }
      index={<TicketsIndex sections={sections} />}
      folded={<TicketsJumpMenu sections={sections} />}
    >
      {nextCard !== null && (
        <div id="impl-next" className="grid scroll-mt-4">
          {nextCard}
        </div>
      )}

      {ticketSet.review !== null && <TicketsReviewPanel set={ticketSet} />}

      {tickets.length > 0 && (
        <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <SectionHead title={ticketsTitle} right={<Micro>{tickets.length}</Micro>} />
          <ol aria-label="Tickets" className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {tickets.map((ticket) => (
              <TicketCard
                key={ticket.id}
                detail={detail}
                spec={spec}
                set={ticketSet}
                ticket={ticket}
                revision={revision}
              />
            ))}
          </ol>
        </section>
      )}

      <Reconciliation
        mapId={mapId}
        specs={detail.specs}
        spec={spec}
        content={revision.content}
        set={ticketSet}
        delta={delta}
        takenOut={revision.takenOut}
      />

      <section
        id="impl-why"
        aria-label="Why this breakdown"
        className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)] gap-2"
      >
        <SectionHead title="Why this breakdown" />
        <Card asChild>
          <Accordion
            type="multiple"
            defaultValue={approved ? [] : ["slicing", "execution"]}
            className="px-4"
          >
            <AccordionItem value="slicing">
              <AccordionTrigger className="py-2.5 text-[13px] font-medium hover:no-underline [&>svg]:size-3.5">
                Slicing
              </AccordionTrigger>
              <AccordionContent className="max-w-[78ch] pb-3 text-[13.5px]">
                {breakdownLines(ticketSet.content.slicing).map((line, index) => (
                  <p key={index} className="not-first:mt-1.5">
                    <AgentText text={line} />
                  </p>
                ))}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="execution">
              <AccordionTrigger className="py-2.5 text-[13px] font-medium hover:no-underline [&>svg]:size-3.5">
                Verification
              </AccordionTrigger>
              <AccordionContent className="max-w-[78ch] pb-3 text-[13.5px]">
                {breakdownLines(ticketSet.content.execution).map((line, index) => (
                  <p key={index} className="not-first:mt-1.5">
                    <AgentText text={line} />
                  </p>
                ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </Card>
      </section>

      {earlier.length > 0 && <EarlierTickets spec={spec} sets={earlier} mapId={mapId} />}
    </WorkspacePage>
  );
}
