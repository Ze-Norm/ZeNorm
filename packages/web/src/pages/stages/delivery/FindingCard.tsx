import type {
  MapSpec,
  SpecRevisionView,
  TicketContent,
  Verdict,
  VerdictFinding,
} from "@zenorm/contracts";
import { X } from "lucide-react";

import { AgentText } from "@/components/AgentText";
import { SpecStageLink } from "@/components/SpecStageLink";
import { carriersOf } from "@/lib/delivery";

/** The clause and criterion of the pinned revision a finding names; core rejected any other id. */
function failedCriterion(revision: SpecRevisionView, criterion: string) {
  for (const clause of revision.content.clauses) {
    const found = clause.criteria.find((entry) => entry.id === criterion);
    if (found !== undefined) {
      return { clause, criterion: found };
    }
  }
  throw new Error(`Revision ${String(revision.revision)} has no criterion ${criterion}`);
}

/**
 * A blocking finding (slice 8 S8-11, D9; the demo's `FindingCard`): the criterion it fails, linked
 * to its clause on the Spec stage, and the tickets that carry it, or "Not tied to a criterion"; the
 * file it is about when it names one (deviation 4). Agent text renders through `AgentText` (L141).
 */
export function FindingCard({
  mapId,
  specs,
  spec,
  revision,
  tickets,
  verdict,
  finding,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  spec: MapSpec;
  /** The revision the run's ticket set was cut from. */
  revision: SpecRevisionView;
  tickets: readonly TicketContent[];
  verdict: Verdict;
  finding: VerdictFinding;
}) {
  const failed = finding.criterion === null ? null : failedCriterion(revision, finding.criterion);
  const carriers =
    finding.criterion === null ? [] : carriersOf(verdict, tickets, finding.criterion);
  const latest = spec.revisions.at(-1);
  return (
    <article aria-label={finding.title} className="border border-hair-strong">
      <h3 className="flex items-center gap-2 border-b border-hair-strong bg-bad-soft px-3 py-2 text-[13px] font-medium text-bad">
        <X className="size-4 shrink-0" aria-hidden /> <AgentText text={finding.title} />
      </h3>
      <div className="grid gap-2 bg-card px-3 py-2.5 text-[13px]">
        <p>
          <AgentText text={finding.detail} />
        </p>
        {finding.file !== null && (
          <code className="font-mono text-[11.5px] text-muted-foreground">{finding.file}</code>
        )}
        {failed === null ? (
          <span className="text-[12.5px] text-muted-foreground">
            Not tied to a criterion: the diff goes beyond the spec.
          </span>
        ) : (
          <div className="grid gap-0.5 border-l-2 border-bad-dot pl-2.5 text-[12.5px]">
            <span>
              Fails <span className="font-mono text-[11px]">{failed.criterion.id}</span>:{" "}
              <AgentText text={failed.criterion.text} />
            </span>
            <span className="text-muted-foreground">
              <SpecStageLink
                mapId={mapId}
                specs={specs}
                stage="spec"
                specNumber={spec.number}
                search={
                  latest?.revision === revision.revision ? {} : { revision: revision.revision }
                }
                hash={`clause-${failed.clause.id}`}
                className="hover:text-primary hover:underline"
              >
                {failed.clause.id} <AgentText text={failed.clause.title} />
              </SpecStageLink>
              {carriers.length > 0 &&
                ` · carried by ${carriers.map((ticket) => ticket.id).join(", ")}`}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
