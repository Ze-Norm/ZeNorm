import type { MapOverviewDetail, NextAction, SpecRevisionView } from "@zenorm/contracts";
import { X } from "lucide-react";

import { AgentText } from "@/components/AgentText";
import { NextActionCard } from "@/components/NextActionCard";
import { Micro, PageHead, SectionHead } from "@/components/parts";
import { SpecSwitcher } from "@/components/SpecSwitcher";
import { Badge } from "@/components/ui/badge";
import { WorkspacePage } from "@/components/WorkspaceColumns";
import { formatMoment, mapHeading } from "@/lib/map";
import { ownRevisions, shownSpec, ticketSetFor, waitsOnly } from "@/lib/specs";
import { plural } from "@/pages/stages/delivery/words";
import { DraftHistory } from "@/pages/stages/planning/DraftHistory";
import { viewedDraft } from "@/pages/stages/planning/planning";
import { PlanningCard, SpecDecision } from "@/pages/stages/planning/PlanningCard";
import { EarlierDraftNotice } from "@/pages/stages/planning/StageParts";
import {
  ChangeBadge,
  ChangesPanel,
  RemovedClauses,
  RevisedLater,
} from "@/pages/stages/spec/Changes";
import { ClauseBlock } from "@/pages/stages/spec/ClauseBlock";
import { SpecIndex, SpecJumpMenu } from "@/pages/stages/spec/SpecIndex";
import { WaitedSpec } from "@/pages/stages/spec/WaitedSpec";
import { Waits } from "@/pages/stages/spec/Waits";

/**
 * The Spec stage: the map's waits, then one spec of the map, the route's or core's default, as one
 * document with its index and its revisions; past r1, what it changes from the revision before.
 * The map's latest revision of the spec is shown: `revision` is a revision this map wrote, by its
 * number from `?revision=`, undefined for the latest; an unknown number is the route's error. A
 * spec the map only waits on shows its Waits and its latest revision, on whichever map.
 */
export function SpecStagePage({
  detail,
  specNumber,
  revision,
}: {
  detail: MapOverviewDetail;
  specNumber: number | undefined;
  revision: number | undefined;
}) {
  const mapId = detail.map.id;
  const waits = (
    <Waits
      mapId={mapId}
      waits={detail.waits}
      waypoints={detail.wayfinding.waypoints}
      next={detail.status.next}
    />
  );
  // A spec the map waits on but has not written shows under Waits, its latest revision read only.
  const waitedOn = specNumber !== undefined && waitsOnly(detail, specNumber);
  const spec = waitedOn ? undefined : shownSpec(detail, "spec", specNumber);
  const revisions = spec === undefined ? [] : ownRevisions(spec, mapId);
  const viewed = viewedDraft(revisions, revision, (draft) => draft.revision, "spec revision");
  const latest = revisions.at(-1);
  // The spec's own action, or a map-wide one (the map's To Spec) while it is in motion.
  const next = detail.status.next.find(
    (action) => action.stage === "spec" && (action.spec === null || action.spec === spec?.number),
  );

  function card(shown: SpecRevisionView | undefined) {
    if (next === undefined) {
      return null;
    }
    const decidable = shown?.state === "draft" && shown.review.state === "passed";
    return (
      <PlanningCard
        mapId={mapId}
        next={next}
        decision={decidable ? <SpecDecision key={shown.id} revision={shown} /> : null}
      />
    );
  }

  if (spec === undefined || viewed === undefined || latest === undefined) {
    const status = detail.status.stages[2];
    // The stage's own action: a map-wide one, or one naming a spec the map waits on, the one
    // shown first; a released wait's run is the agent's while it works, Try again when stopped.
    const waited = detail.waits.map((wait) => wait.specNumber);
    const stageActions = detail.status.next.filter(
      (action: NextAction) =>
        action.stage === "spec" && (action.spec === null || waited.includes(action.spec)),
    );
    const own =
      stageActions.find((action) => action.spec !== null && action.spec === specNumber) ??
      stageActions[0];
    const first = detail.status.next[0];
    const nextCard =
      own !== undefined ? (
        <PlanningCard mapId={mapId} next={own} decision={null} />
      ) : (
        first !== undefined && <NextActionCard mapId={mapId} next={first} />
      );
    if (waitedOn) {
      const wait = detail.waits.find((entry) => entry.specNumber === specNumber);
      if (wait === undefined) {
        throw new Error(`Map ${mapId} waits on no spec ${String(specNumber)}`);
      }
      return <WaitedSpec wait={wait} waits={waits} next={nextCard} />;
    }
    return (
      <WorkspacePage
        head={<PageHead eyebrow="Spec" title={mapHeading(detail.map)} lede={status.line} />}
      >
        {waits}
        {nextCard}
        <p className="text-[12.5px] text-muted-foreground">
          The agent writes the spec as soon as the map is cleared. A map feeds one spec, or several
          when its decisions cover outcomes that can be reviewed and delivered separately. When a
          decision changes a spec this project already has, the agent writes the next revision of
          that spec instead of a second one. The agent chooses the split.
        </p>
      </WorkspacePage>
    );
  }

  const content = viewed.content;
  const { delta } = viewed;
  const ticketSet = ticketSetFor(spec, viewed.revision);
  const criteria = content.clauses.reduce((sum, clause) => sum + clause.criteria.length, 0);
  const label = `revision ${String(viewed.revision)}`;
  const state = viewed.state === "approved" ? "approved" : "draft";
  const position =
    detail.specs.length > 1
      ? ` ${String(detail.specs.indexOf(spec) + 1)} of ${String(detail.specs.length)}`
      : "";
  const revises = delta === null ? "" : ` · revises r${String(delta.before)}`;
  const tickets =
    ticketSet === undefined
      ? ""
      : ` · ${plural(ticketSet.content.tickets.length, delta === null ? "ticket" : "new ticket")}`;

  return (
    <WorkspacePage
      head={
        <>
          {waits}
          <SpecSwitcher mapId={mapId} specs={detail.specs} stage="spec" current={spec.number} />
          <PageHead
            eyebrow={`Spec${position} · ${label} · ${state} · saved ${formatMoment(viewed.savedAt)}`}
            title={<AgentText text={content.title} />}
            lede={`${plural(content.clauses.length, "behaviour")} · ${String(criteria)} acceptance ${criteria === 1 ? "criterion" : "criteria"}${tickets}${revises}`}
          />
        </>
      }
      index={<SpecIndex content={content} delta={delta} />}
      folded={<SpecJumpMenu content={content} delta={delta} />}
    >
      {viewed === latest ? (
        card(latest)
      ) : (
        <EarlierDraftNotice
          mapId={mapId}
          specs={detail.specs}
          spec={spec}
          label={label}
          rejectionReason={viewed.rejectionReason}
        />
      )}
      {viewed === latest &&
        spec.revisedLater.map((later) => (
          <RevisedLater key={later.revision} spec={spec} later={later} />
        ))}
      <DraftHistory mapId={mapId} specs={detail.specs} spec={spec} viewing={viewed.revision} />
      {delta !== null && (
        <ChangesPanel
          mapId={mapId}
          spec={spec}
          content={content}
          delta={delta}
          waypoints={detail.wayfinding.waypoints}
        />
      )}

      <article className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-8 pt-2">
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
            <ClauseBlock
              key={clause.id}
              mapId={mapId}
              specs={detail.specs}
              spec={spec}
              revision={viewed}
              clause={clause}
              ticketSet={ticketSet}
            />
          ))}
        </section>
        {delta !== null && <RemovedClauses delta={delta} />}
        <section id="spec-out" className="grid scroll-mt-4 gap-2">
          <SectionHead title="Out of scope" right={<Micro>{content.outOfScope.length}</Micro>} />
          {content.outOfScope.length === 0 &&
          (delta === null || delta.outOfScopeDropped.length === 0) ? (
            <p className="text-[13px] text-muted-foreground">Nothing ruled out.</p>
          ) : (
            <ul className="grid gap-1.5 text-[14px]">
              {content.outOfScope.map((line, index) => (
                <li key={index} className="flex items-start gap-2">
                  <X className="mt-1 size-4 shrink-0 text-faint" aria-hidden />
                  <span className="flex-1">
                    <AgentText text={line} />
                  </span>
                  {delta?.outOfScopeAdded.includes(line) === true && <ChangeBadge change="new" />}
                </li>
              ))}
              {delta?.outOfScopeDropped.map((line, index) => (
                <li
                  key={`dropped-${String(index)}`}
                  className="flex items-start gap-2 text-muted-foreground"
                >
                  <X className="mt-1 size-4 shrink-0 text-faint" aria-hidden />
                  <span className="flex-1 line-through">
                    <AgentText text={line} />
                  </span>
                  <Badge variant="secondary">no longer excluded</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>
    </WorkspacePage>
  );
}
