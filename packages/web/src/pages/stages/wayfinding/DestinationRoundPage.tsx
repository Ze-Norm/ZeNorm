import { AgentText } from "@/components/AgentText";
import { useMapOverview } from "@/lib/queries";

import { PageHead } from "@/components/parts";
import { Proposals } from "./Proposals.tsx";
import { QuestionRound } from "./QuestionRound.tsx";
import { pendingRound, RoundsRecord, submittedRounds, WayfindingFrame } from "./shared.tsx";

/**
 * `wayfinding/destination`: the map-level round: open, it is answered here; once
 * answered, the record of the map's rounds. While open, the maps the first chart offered to split
 * off the idea sit above it (idea-phase split), and the answers wait until each is created or
 * dismissed.
 */
export function DestinationRoundPage({ mapId }: { mapId: string }) {
  const overview = useMapOverview(mapId);
  const detail = overview.data;
  if (detail === undefined) {
    // The layout shows the refusal or the loading line until the overview is in.
    return null;
  }
  const { map } = detail;
  if (map.title === null || map.destination === null) {
    throw new Error(`Map ${map.id} has no destination round yet`);
  }
  const open = pendingRound(detail.wayfinding.mapRounds);
  const answered = submittedRounds(detail.wayfinding.mapRounds);
  const split = detail.wayfinding.proposals.filter((proposal) => proposal.kind === "split");

  // The head as every stage's: the round's eyebrow while it is open.
  const head = (
    <PageHead
      eyebrow={
        open === null ? (
          "Wayfinding · destination"
        ) : (
          <>
            Wayfinding ·{" "}
            <span className="text-primary">Question round {open.number} · destination</span>
          </>
        )
      }
      title={map.title}
      lede={<AgentText text={map.destination} specLinks />}
    />
  );

  return (
    <WayfindingFrame detail={detail} selected="destination" head={head}>
      {open === null ? (
        <article className="grid grid-cols-[minmax(0,1fr)] gap-5">
          {answered.length > 0 && <RoundsRecord rounds={answered} resolved={false} />}
        </article>
      ) : (
        <div className="grid gap-7">
          <Proposals mapId={map.id} proposals={split} kind="split" />
          <QuestionRound
            key={open.id}
            round={open}
            earlier={answered}
            heldBy={
              split.some((offer) => offer.state === "pending")
                ? "Create or dismiss each suggested map above, then send the answers."
                : null
            }
          />
        </div>
      )}
    </WayfindingFrame>
  );
}
