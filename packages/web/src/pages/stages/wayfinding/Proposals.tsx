import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  MAP_IDEA_MAX_LENGTH,
  MapIdea,
  type AccessDeniedError,
  type ConfirmProposalError,
  type DismissProposalError,
  type MapOverviewDetail,
  type MapProposal,
  type MapProposalKind,
} from "@zenorm/contracts";
import { useState } from "react";

import { createMapRefusalMessage } from "@/components/MapComposer";
import { Micro, SectionHead } from "@/components/parts";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { accessDeniedSentence } from "@/lib/access";
import { orpc } from "@/orpc";

/** The sentence shown for a `map.dismissProposal` refusal, chosen by its code. */
function dismissRefusalMessage(error: DismissProposalError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "proposal_not_found":
      return "This suggestion no longer exists.";
    case "proposal_already_decided":
      return "This suggestion already has its map, or was dismissed.";
  }
}

/** The sentence shown for a `map.confirmProposal` refusal, chosen by its code. */
function confirmRefusalMessage(error: ConfirmProposalError | AccessDeniedError): string {
  switch (error.code) {
    case "proposal_not_found":
    case "proposal_already_decided":
      return dismissRefusalMessage(error);
    case "access_denied":
    case "project_not_found":
    case "project_folder_missing":
      return createMapRefusalMessage(error);
    case "exclusion_already_split":
      return "Its Out of scope line is already split off into another map. Dismiss this suggestion.";
  }
}

/**
 * A decision's success (map proposals): the returned overview replaces the map's cached one, so the
 * person stays on Wayfinding and sees the decision at once; the Inbox's reads refetch, and the
 * live layer brings the new map.
 */
function useDecided() {
  const queryClient = useQueryClient();
  return async (detail: MapOverviewDetail) => {
    queryClient.setQueryData(
      orpc.map.overview.queryKey({ input: { mapId: detail.map.id } }),
      detail,
    );
    await Promise.all(
      [orpc.map.overviews.key(), orpc.project.get.key(), orpc.map.list.key()].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  };
}

/** Each kind's section: its heading and one sentence saying what the cards are. */
const SECTION: Record<MapProposalKind, { readonly title: string; readonly intro: string }> = {
  split: {
    title: "Split this idea into maps",
    intro:
      "The agent thinks this idea is more than one map. Create the ones that should be maps of their own; dismiss one to keep its work in this map.",
  },
  outside: {
    title: "Suggested new maps",
    intro: "Work the agent left out of this map that could be a map of its own.",
  },
};

/**
 * The map's proposals of new maps of one kind (map proposals, idea-phase split): each headed by
 * its title, with one line on why it is not in this map and its draft idea folded away. While
 * pending the person opens and edits the idea, then **Create map** (disabled for an idea that is
 * empty or longer than a map's idea may be) or **Dismiss**; a refusal shows its code and keeps the
 * edited idea. Once decided the idea is fixed: a created one links its map. Nothing shows when the
 * map has none of the kind. The list changes live through the change feed.
 */
export function Proposals({
  mapId,
  proposals,
  kind,
}: {
  mapId: string;
  proposals: readonly MapProposal[];
  kind: MapProposalKind;
}) {
  const shown = proposals.filter((proposal) => proposal.kind === kind);
  if (shown.length === 0) {
    return null;
  }
  const pending = shown.filter((proposal) => proposal.state === "pending").length;
  const { title, intro } = SECTION[kind];
  return (
    <section aria-label={title} className="grid gap-2">
      <SectionHead title={title} right={<Micro>{pending} to decide</Micro>} />
      <p className="text-[12.5px] text-muted-foreground">{intro}</p>
      {shown.map((proposal) => (
        <ProposalCard key={proposal.id} mapId={mapId} proposal={proposal} />
      ))}
    </section>
  );
}

/** Why a proposal was left out of this map: its own line, the line it splits off, or its waypoint. */
function ProposalWhy({ mapId, proposal }: { mapId: string; proposal: MapProposal }) {
  if (proposal.line !== null) {
    return <p className="text-[13px] text-muted-foreground">{proposal.line}</p>;
  }
  if (proposal.splitsLine !== null) {
    return <p className="text-[13px] text-muted-foreground">{proposal.splitsLine.text}</p>;
  }
  if (proposal.waypoint !== null) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Ruled out of scope at{" "}
        <Link
          to="/maps/$mapId/wayfinding/$number"
          params={{ mapId, number: proposal.waypoint }}
          className="text-foreground hover:text-primary hover:underline"
        >
          waypoint {proposal.waypoint}
        </Link>
        .
      </p>
    );
  }
  throw new Error(`Proposal ${proposal.id} has no line of its own, none it splits, no waypoint`);
}

/** A proposal's state badge: to decide, created, or dismissed (a split offer's: kept here). */
function StateBadge({ proposal }: { proposal: MapProposal }) {
  switch (proposal.state) {
    case "pending":
      return <Badge variant="default">to decide</Badge>;
    case "confirmed":
      return <Badge variant="ok">created</Badge>;
    case "dismissed":
      return (
        <Badge variant="secondary">
          {proposal.kind === "split" ? "kept in this map" : "dismissed"}
        </Badge>
      );
  }
}

function ProposalCard({ mapId, proposal }: { mapId: string; proposal: MapProposal }) {
  return (
    <Card asChild className="grid gap-2 px-4 py-3.5">
      <article aria-label={`Suggested map: ${proposal.title}`}>
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-[15px] font-semibold">{proposal.title}</h3>
          <StateBadge proposal={proposal} />
        </div>
        <ProposalWhy mapId={mapId} proposal={proposal} />
        {proposal.state === "pending" ? (
          <PendingProposal proposal={proposal} />
        ) : (
          <DecidedProposal proposal={proposal} />
        )}
      </article>
    </Card>
  );
}

/** The trigger that opens or folds a proposal's idea. */
function IdeaTrigger({ open, label }: { open: boolean; label: string }) {
  return (
    <CollapsibleTrigger asChild>
      <Button variant="link" size="sm" className="h-auto justify-self-start p-0">
        {open ? "Hide the idea" : label}
      </Button>
    </CollapsibleTrigger>
  );
}

/** A decided proposal: its fixed idea, folded, and the map a created one made. */
function DecidedProposal({ proposal }: { proposal: MapProposal }) {
  const [open, setOpen] = useState(false);
  const { newMapId } = proposal;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <IdeaTrigger open={open} label="Show the idea" />
        {newMapId !== null && (
          <Link
            to="/maps/$mapId/$stage"
            params={{ mapId: newMapId, stage: "idea" }}
            className="text-xs text-primary hover:underline"
          >
            Open the new map →
          </Link>
        )}
      </div>
      <CollapsibleContent>
        <p className="text-[14px] whitespace-pre-wrap">{proposal.idea}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A pending proposal: its idea folded away, editable once opened, then **Create map** and
 * **Dismiss**, and a refusal's code.
 */
function PendingProposal({ proposal }: { proposal: MapProposal }) {
  const decided = useDecided();
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState(proposal.idea);
  const confirm = useMutation(orpc.map.confirmProposal.mutationOptions({ onSuccess: decided }));
  const dismiss = useMutation(orpc.map.dismissProposal.mutationOptions({ onSuccess: decided }));
  const parsed = MapIdea.safeParse(idea);
  const busy = confirm.isPending || dismiss.isPending;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2.5">
      <IdeaTrigger open={open} label="Show and edit the idea" />
      <CollapsibleContent className="grid gap-1.5">
        <Textarea
          aria-label="Idea for the new map"
          value={idea}
          disabled={busy}
          aria-invalid={!parsed.success}
          onChange={(event) => {
            setIdea(event.target.value);
          }}
          className="min-h-16 text-[14px]"
        />
        <Micro>
          {idea.trim().length} of {MAP_IDEA_MAX_LENGTH} characters
        </Micro>
      </CollapsibleContent>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!parsed.success || busy}
          onClick={() => {
            if (parsed.success) {
              confirm.mutate({ proposalId: proposal.id, idea: parsed.data });
            }
          }}
        >
          Create map
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            dismiss.mutate({ proposalId: proposal.id });
          }}
        >
          Dismiss
        </Button>
      </div>
      {confirm.error !== null && (
        <RefusalAlert
          error={confirm.error}
          sentence={confirmRefusalMessage}
          title="Could not create the map"
          showMessage={false}
        />
      )}
      {dismiss.error !== null && (
        <RefusalAlert
          error={dismiss.error}
          sentence={dismissRefusalMessage}
          title="Could not dismiss the suggestion"
          showMessage={false}
        />
      )}
    </Collapsible>
  );
}
