import type { SpecWaitView } from "@zenorm/contracts";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { Micro, PageHead, SectionHead } from "@/components/parts";
import { Card } from "@/components/ui/card";
import { WorkspacePage } from "@/components/WorkspaceColumns";
import { formatMoment } from "@/lib/map";
import { plural } from "@/pages/stages/delivery/words";
import { SpecIndex, SpecJumpMenu } from "@/pages/stages/spec/SpecIndex";

/**
 * A spec the map only waits on (slice 8b E-1): its latest revision, on whichever map wrote it, as
 * one document with its index, under the map's waits and the stage's Next card (`next`). The map
 * has written none of it yet, so the document is read only: no revisions box, delta or clause
 * sources.
 */
export function WaitedSpec({
  wait,
  waits,
  next,
}: {
  wait: SpecWaitView;
  waits: ReactNode;
  next: ReactNode;
}) {
  const { latest } = wait;
  const { content } = latest;
  const criteria = content.clauses.reduce((sum, clause) => sum + clause.criteria.length, 0);
  const state = latest.state === "approved" ? "approved" : "draft";
  return (
    <WorkspacePage
      head={
        <>
          {waits}
          <PageHead
            eyebrow={`Spec · revision ${String(latest.revision)} · ${state} · saved ${formatMoment(latest.savedAt)} · on “${latest.mapTitle}”`}
            title={<AgentText text={content.title} />}
            lede={`${plural(content.clauses.length, "behaviour")} · ${String(criteria)} acceptance ${criteria === 1 ? "criterion" : "criteria"}`}
          />
        </>
      }
      index={<SpecIndex content={content} delta={null} />}
      folded={<SpecJumpMenu content={content} delta={null} />}
    >
      {next}
      <article className="grid min-w-0 content-start gap-8 pt-2">
        <section id="spec-problem" className="grid scroll-mt-4 gap-2">
          <SectionHead title="Problem" />
          <p className="text-[15.5px] leading-relaxed">
            <AgentText text={content.problem} />
          </p>
        </section>
        <section id="spec-solution" className="grid scroll-mt-4 gap-2">
          <SectionHead title="Solution" />
          <p className="text-[15.5px] leading-relaxed">
            <AgentText text={content.solution} />
          </p>
        </section>
        <section className="grid gap-3">
          <SectionHead title="Behaviour" right={<Micro>{content.clauses.length}</Micro>} />
          {content.clauses.map((clause) => (
            <Card key={clause.id} id={`clause-${clause.id}`} className="grid scroll-mt-4 gap-3 p-4">
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono text-[11px] text-primary">{clause.id}</span>
                <h3 className="flex-1 font-display text-[17px] leading-tight font-bold tracking-[-0.02em]">
                  <AgentText text={clause.title} />
                </h3>
              </div>
              <p className="text-[15px] leading-relaxed">
                <AgentText text={clause.text} />
              </p>
              <ol aria-label={`Criteria of ${clause.id}`} className="grid">
                {clause.criteria.map((criterion) => (
                  <li
                    key={criterion.id}
                    className="grid grid-cols-[36px_1fr] gap-2 border-t border-border py-2 text-[13.5px]"
                  >
                    <span className="font-mono text-[11px] leading-[1.8] text-faint">
                      {criterion.id}
                    </span>
                    <span>
                      <AgentText text={criterion.text} />
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </section>
        <section id="spec-out" className="grid scroll-mt-4 gap-2">
          <SectionHead title="Out of scope" right={<Micro>{content.outOfScope.length}</Micro>} />
          {content.outOfScope.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Nothing ruled out.</p>
          ) : (
            <ul className="grid gap-1.5 text-[14px]">
              {content.outOfScope.map((line, index) => (
                <li key={index} className="flex items-start gap-2">
                  <X className="mt-1 size-4 shrink-0 text-faint" aria-hidden />
                  <span className="flex-1">
                    <AgentText text={line} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>
    </WorkspacePage>
  );
}
