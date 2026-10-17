import { Link } from "@tanstack/react-router";
import type { MapSpec, TicketSetView } from "@zenorm/contracts";

import { AgentText } from "@/components/AgentText";
import { Micro, SectionHead } from "@/components/parts";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { setTicketDelivery } from "@/lib/tickets";
import { plural } from "@/pages/stages/delivery/words";

/**
 * The tickets of the spec's earlier revisions, folded (slice 8b D12, the demo's `EarlierTickets`),
 * newest first: each set with its revision, its tickets, the map that wrote it and its delivery;
 * opened, each ticket with the criteria it carried and the run and commit that delivered it.
 */
export function EarlierTickets({
  spec,
  sets,
  mapId,
}: {
  spec: MapSpec;
  sets: readonly TicketSetView[];
  mapId: string;
}) {
  return (
    <section
      id="impl-earlier"
      aria-label="Earlier tickets of this spec"
      className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)] gap-2"
    >
      <SectionHead
        title="Earlier tickets of this spec"
        right={
          <Micro>
            {plural(
              sets.reduce((n, set) => n + set.content.tickets.length, 0),
              "ticket",
            )}
          </Micro>
        }
      />
      <Card asChild>
        <Accordion type="multiple" className="grid grid-cols-[minmax(0,1fr)]">
          {[...sets].reverse().map((set) => {
            const wrote = spec.revisions.find((revision) => revision.revision === set.revision);
            if (wrote === undefined) {
              throw new Error(
                `Spec ${String(spec.number)} has no revision ${String(set.revision)}`,
              );
            }
            const { tickets } = set.content;
            const deliveries = tickets.map((ticket) => setTicketDelivery(spec, set, ticket.id));
            const delivered = deliveries.every((delivery) => delivery !== null);
            let badge = <Badge variant="outline">not approved</Badge>;
            if (delivered) {
              badge = <Badge variant="ok">delivered</Badge>;
            } else if (set.state === "approved") {
              badge = <Badge variant="secondary">approved</Badge>;
            }
            return (
              <AccordionItem key={set.id} value={set.id} data-revision={set.revision}>
                <AccordionTrigger className="px-4 py-2.5 text-[13px] hover:no-underline [&>svg]:size-3.5">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[11px] font-semibold">r{set.revision}</span>
                    <span className="font-normal text-muted-foreground">
                      {plural(tickets.length, "ticket")}
                      {tickets.length > 0 &&
                        ` · ${tickets.map((ticket) => ticket.id).join(", ")}`}{" "}
                      · from {wrote.mapId === mapId ? "this map" : `“${wrote.mapTitle}”`}
                    </span>
                    {badge}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-0">
                  {tickets.map((ticket, index) => {
                    const delivery = deliveries[index];
                    return (
                      <Link
                        key={ticket.id}
                        to="/maps/$mapId/$stage/$specNumber"
                        params={{
                          mapId: wrote.mapId,
                          stage: "tickets",
                          specNumber: spec.number,
                        }}
                        hash={`ticket-${ticket.id}`}
                        className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-baseline gap-x-2 border-t border-border py-2 pr-4 pl-10 text-left text-[13px] hover:bg-secondary"
                      >
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {ticket.id}
                        </span>
                        <span>
                          <AgentText text={ticket.title} />
                          <span className="block text-[12px] text-muted-foreground">
                            {ticket.criteria.length === 0
                              ? "Carried no criteria."
                              : `Carried ${ticket.criteria.join(", ")}.`}
                          </span>
                        </span>
                        {delivery === undefined || delivery === null ? (
                          <span className="text-[11px] text-muted-foreground">not delivered</span>
                        ) : (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            run {delivery.run} · {delivery.commit.slice(0, 7)}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </Card>
    </section>
  );
}
