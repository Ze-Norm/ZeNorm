import type { TextDelta } from "@zenorm/contracts";

import { AgentText } from "@/components/AgentText";
import { Micro } from "@/components/parts";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { reconciliationTitle } from "@/pages/stages/tickets/Reconciliation";
import { IndexItem, JumpMenu, useActiveSection } from "@/pages/stages/planning/StageParts";

/** Which of the Tickets page's sections are on it, in the page's order. */
export interface TicketsSections {
  /** The next-action card. */
  next: boolean;
  /** The Tickets review panel. */
  review: boolean;
  /** The ticket set's tickets, each a card with the id `ticket-<id>`. */
  tickets: readonly { id: string; title: string }[];
  /** The revision's delta, which names the reconciliation section. */
  delta: TextDelta | null;
  /** The spec's earlier tickets. */
  earlier: boolean;
}

/** The sections' ids in the page's order: what the index jumps to and marks. */
function sectionIds(sections: TicketsSections): string[] {
  return [
    ...(sections.next ? ["impl-next"] : []),
    ...(sections.review ? ["impl-review"] : []),
    ...sections.tickets.map((ticket) => `ticket-${ticket.id}`),
    "impl-reconciliation",
    "impl-why",
    ...(sections.earlier ? ["impl-earlier"] : []),
  ];
}

/**
 * The Tickets page's index at the left of the page (`WorkspacePage`, UX audit C4): the
 * next action, the Tickets review, each ticket, the reconciliation (Coverage on a first revision),
 * why the agent sliced it so, and the spec's earlier tickets; the section the reader is in is
 * marked.
 */
export function TicketsIndex({ sections }: { sections: TicketsSections }) {
  const active = useActiveSection(sectionIds(sections));
  return (
    <nav aria-label="Tickets index" className="grid content-start gap-0.5">
      {sections.next && (
        <IndexItem target="impl-next" label="Next" active={active === "impl-next"} />
      )}
      {sections.review && (
        <IndexItem target="impl-review" label="Tickets review" active={active === "impl-review"} />
      )}
      {sections.tickets.length > 0 && (
        <Micro className="mt-3 mb-1 px-2.5">Tickets · {sections.tickets.length}</Micro>
      )}
      {sections.tickets.map((ticket) => (
        <IndexItem
          key={ticket.id}
          target={`ticket-${ticket.id}`}
          id={ticket.id}
          label={<AgentText text={ticket.title} />}
          active={active === `ticket-${ticket.id}`}
        />
      ))}
      <Micro className="mt-3 mb-1 px-2.5">Against the spec</Micro>
      <IndexItem
        target="impl-reconciliation"
        label={reconciliationTitle(sections.delta)}
        active={active === "impl-reconciliation"}
      />
      <IndexItem target="impl-why" label="Why this breakdown" active={active === "impl-why"} />
      {sections.earlier && (
        <IndexItem
          target="impl-earlier"
          label="Earlier tickets of this spec"
          active={active === "impl-earlier"}
        />
      )}
    </nav>
  );
}

/** The Tickets index below the split: a Jump to menu over the same sections. */
export function TicketsJumpMenu({ sections }: { sections: TicketsSections }) {
  return (
    <JumpMenu label="Tickets index">
      {sections.next && <SelectItem value="impl-next">Next</SelectItem>}
      {sections.review && <SelectItem value="impl-review">Tickets review</SelectItem>}
      {sections.tickets.length > 0 && (
        <SelectGroup>
          <SelectLabel>Tickets · {sections.tickets.length}</SelectLabel>
          {sections.tickets.map((ticket) => (
            <SelectItem key={ticket.id} value={`ticket-${ticket.id}`}>
              <span className="font-mono text-[11px] text-faint">{ticket.id}</span>{" "}
              <AgentText text={ticket.title} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      <SelectGroup>
        <SelectLabel>Against the spec</SelectLabel>
        <SelectItem value="impl-reconciliation">{reconciliationTitle(sections.delta)}</SelectItem>
        <SelectItem value="impl-why">Why this breakdown</SelectItem>
      </SelectGroup>
      {sections.earlier && (
        <SelectItem value="impl-earlier">Earlier tickets of this spec</SelectItem>
      )}
    </JumpMenu>
  );
}
