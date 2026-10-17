import { useQueryClient } from "@tanstack/react-query";
import type {
  MapNotFoundError,
  SpecDecisionError,
  TicketSetDecisionError,
} from "@zenorm/contracts";

import { orpc } from "@/orpc";

/**
 * Refetches what a planning mutation changes: the map's overview (which carries each spec's
 * delivery runs, slice 8 S8-14), the Inbox's overviews and the project.
 */
export function useInvalidatePlanning(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    const keys = [orpc.map.overview.key(), orpc.map.overviews.key(), orpc.project.get.key()];
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
}

export function mapNotFoundMessage(error: MapNotFoundError): string {
  return `There is no map ${error.data.mapId}.`;
}

/** The sentence shown for a `spec.approve` or `spec.reject` refusal, chosen by its code. */
export function specDecisionRefusalMessage(error: SpecDecisionError): string {
  switch (error.code) {
    case "spec_revision_not_found":
      return "This spec revision no longer exists.";
    case "spec_revision_decided":
      return "This spec revision has already been decided or a later one exists.";
    case "map_uncleared":
      return "The map has open waypoints or fog, or the agent is writing the spec.";
    case "review_in_flight":
      return "The planning review of this revision has not finished.";
    case "spec_review_not_passed":
      return "The planning review of this revision did not pass.";
  }
}

/** The sentence shown for a `ticketSet.approve` or `ticketSet.reject` refusal, chosen by its code. */
export function ticketSetDecisionRefusalMessage(error: TicketSetDecisionError): string {
  switch (error.code) {
    case "ticket_set_not_found":
      return "This ticket set no longer exists.";
    case "ticket_set_decided":
      return "This ticket set has already been approved.";
    case "revision_not_latest":
      return "A later revision of this spec replaces these tickets.";
    case "review_in_flight":
      return "The agent is still writing or reviewing these tickets.";
    case "ticket_set_review_not_passed":
      return "The tickets review of these tickets has not passed.";
  }
}

/**
 * The draft a stage shows: the latest when `number` is undefined, else the one with that number.
 * An unknown number throws, so the route shows its error (spec D1; L100).
 */
export function viewedDraft<TDraft>(
  drafts: readonly TDraft[],
  number: number | undefined,
  numberOf: (draft: TDraft) => number,
  what: string,
): TDraft | undefined {
  if (number === undefined) {
    return drafts.at(-1);
  }
  const found = drafts.find((draft) => numberOf(draft) === number);
  if (found === undefined) {
    throw new Error(`This map has no ${what} ${String(number)}`);
  }
  return found;
}
