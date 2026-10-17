import type { MapOverviewDetail, MapSpec, SpecRun } from "@zenorm/contracts";
import type { ReactNode } from "react";

import { ActivityColumn } from "@/components/ActivityColumn";
import { AgentText } from "@/components/AgentText";
import { NextActionCard } from "@/components/NextActionCard";
import { PageHead } from "@/components/parts";
import { SpecStageLink } from "@/components/SpecStageLink";
import { SpecSwitcher } from "@/components/SpecSwitcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WorkspaceColumns, WorkspacePage } from "@/components/WorkspaceColumns";
import { revisionOf, runTicketSet, shownRun } from "@/lib/delivery";
import { mapHeading } from "@/lib/map";
import { ownTicketSets, runsOn, shownSpec, specNextAction, waitsOnly } from "@/lib/specs";
import { RunHead, runEyebrow } from "@/pages/stages/delivery/RunHead";
import { RunActivity } from "@/pages/stages/delivery/RunActivity";
import { RunList } from "@/pages/stages/delivery/RunList";
import { FindingCard } from "@/pages/stages/delivery/FindingCard";
import { MarkMergedCard } from "@/pages/stages/delivery/MarkMergedCard";
import { PullRequestCard } from "@/pages/stages/delivery/PullRequestCard";
import { RunSteps } from "@/pages/stages/delivery/RunSteps";
import { ResumeRunCard } from "@/pages/stages/delivery/ResumeRunCard";
import { deliveryCardAction, StartDeliveryCard } from "@/pages/stages/delivery/StartDeliveryCard";
import { plural } from "@/pages/stages/delivery/words";

/**
 * A page with no run shown: the map's Activity stream in the column, as on the other stages, so
 * the page is not the one stage without it, read-only: Delivery has no hatch. A plugin's
 * `map.workspace.aside` sits first in the column.
 */
function NarrowPage({
  detail,
  aside,
  head,
  children,
}: {
  detail: MapOverviewDetail;
  aside: ReactNode;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <WorkspaceColumns
      label="Activity"
      column={<ActivityColumn detail={detail} stage="delivery" specNumber={null} aside={aside} />}
    >
      <WorkspacePage head={head}>{children}</WorkspacePage>
    </WorkspaceColumns>
  );
}

/**
 * The Delivery stage: the card "Start delivery" while no run has started; the shown run's head,
 * with Cancel run while it is the latest and active; the card for the latest run; "The run, step
 * by step"; and "Runs of this spec from this map", each opened by `?run=`. `run` is the run's
 * number, undefined for the latest; a number the map has no run for is the route's error. `aside`
 * is the `map.workspace.aside` slot, at the top of the right column.
 */
export function DeliveryStagePage({
  detail,
  specNumber,
  run,
  aside,
}: {
  detail: MapOverviewDetail;
  specNumber: number | undefined;
  run: number | undefined;
  aside: ReactNode;
}) {
  // A spec the map only waits on has not reached Delivery here.
  const waitedOn = specNumber !== undefined && waitsOnly(detail, specNumber);
  const spec = waitedOn ? undefined : shownSpec(detail, "delivery", specNumber);
  if (spec === undefined) {
    return <NotStarted detail={detail} spec={undefined} run={run} aside={aside} />;
  }
  return <SpecDelivery key={spec.number} detail={detail} spec={spec} run={run} aside={aside} />;
}

/**
 * The head of a page with no run: the thing on the page is the spec, or the map before it has
 * one; the state is "not started", with the revision it would deliver when known.
 */
function NotStartedHead({
  detail,
  spec,
  revision,
  lede,
}: {
  detail: MapOverviewDetail;
  spec: MapSpec | undefined;
  revision: number | undefined;
  lede: string;
}) {
  const about = revision === undefined ? "" : ` · revision ${String(revision)}`;
  return (
    <PageHead
      eyebrow={`Delivery${about} · not started`}
      title={spec === undefined ? mapHeading(detail.map) : <AgentText text={spec.title} />}
      lede={lede}
    />
  );
}

/** The spec's switcher, or nothing before the map has a spec. */
function Switcher({ detail, spec }: { detail: MapOverviewDetail; spec: MapSpec | undefined }) {
  if (spec === undefined) {
    return null;
  }
  return (
    <SpecSwitcher
      mapId={detail.map.id}
      specs={detail.specs}
      stage="delivery"
      current={spec.number}
    />
  );
}

/**
 * Delivery before the map has a spec, or before the spec's tickets are approved. With a spec, only
 * that spec's own next action shows (its delivery's, else its earliest stage's, else the map's
 * quiet Delivery action about every spec), or its Delivery line when it has none; never another
 * spec's. With none, the map's first next action.
 */
function NotStarted({
  detail,
  spec,
  run,
  aside,
}: {
  detail: MapOverviewDetail;
  spec: MapSpec | undefined;
  run: number | undefined;
  aside: ReactNode;
}) {
  if (run !== undefined) {
    throw new Error(`This map has no delivery run ${String(run)}: its tickets are not approved`);
  }
  const next =
    spec === undefined
      ? detail.status.next[0]
      : (specNextAction(detail.status.next, spec.number) ??
        deliveryCardAction(detail.status.next, spec.number) ??
        undefined);
  if (spec === undefined && next === undefined) {
    throw new Error("The map's status has no next action");
  }
  return (
    <NarrowPage
      detail={detail}
      aside={aside}
      head={
        <>
          <Switcher detail={detail} spec={spec} />
          <NotStartedHead
            detail={detail}
            spec={spec}
            revision={undefined}
            lede={
              next === undefined && spec !== undefined
                ? spec.stages[2].line
                : "Delivery waits on an approved ticket set."
            }
          />
        </>
      }
    >
      {next === undefined ? null : <NextActionCard mapId={detail.map.id} next={next} />}
    </NarrowPage>
  );
}

/**
 * The card for the spec's latest run, from core's action for the spec: Start again from clean after
 * a blocked, failed or cancelled run; on a passed one, its pull request's link when it opened one
 * (Merge PR), else Mark merged. A running, interrupted or merged run has none; an interrupted run
 * is cancelled from its head.
 */
function LatestRunCard({
  detail,
  spec,
  ticketSetId,
  latest,
}: {
  detail: MapOverviewDetail;
  spec: MapSpec;
  ticketSetId: string;
  latest: SpecRun;
}) {
  const action = deliveryCardAction(detail.status.next, spec.number);
  if (action === null || latest.mergedAt !== null) {
    return null;
  }
  switch (latest.state) {
    case "running":
    case "interrupted":
      return null;
    case "passed":
      // A run that opened a pull request is merged on GitHub; one without keeps Mark merged.
      return latest.pullRequest === null ? (
        <MarkMergedCard mapId={detail.map.id} run={latest} action={action} />
      ) : (
        <PullRequestCard mapId={detail.map.id} run={latest} action={action} />
      );
    case "blocked":
    case "failed":
    case "cancelled":
      return (
        <>
          <ResumeRunCard mapId={detail.map.id} run={latest} />
          <StartDeliveryCard
            mapId={detail.map.id}
            ticketSetId={ticketSetId}
            project={detail.project}
            action={action}
          />
        </>
      );
  }
}

/**
 * The delivery of one spec of the map. Its runs, statuses, ticket states and actions come from the
 * one read, `map.overview`, which the live layer refetches on each change. A blocked run leads
 * with its findings, then the card; any other run shows its card under its head. Then the run
 * step by step, and the spec's runs once it has two.
 */
function SpecDelivery({
  detail,
  spec,
  run,
  aside,
}: {
  detail: MapOverviewDetail;
  spec: MapSpec;
  run: number | undefined;
  aside: ReactNode;
}) {
  const mapId = detail.map.id;
  // Only the runs of sets of revisions this map wrote: another map's revision of the spec is
  // delivered there.
  const own = spec.revisions.filter((revision) => revision.mapId === mapId);
  const ownSets = ownTicketSets(spec, mapId);
  const runs = runsOn(spec, mapId);
  // The set of this map's latest approved revision, as core's status reads it.
  const approvedRevision = own.filter((revision) => revision.state === "approved").at(-1);
  const approved =
    approvedRevision === undefined
      ? undefined
      : ownSets.find(
          (set) => set.revision === approvedRevision.revision && set.state === "approved",
        );
  if (approvedRevision === undefined || approved === undefined) {
    return <NotStarted detail={detail} spec={spec} run={run} aside={aside} />;
  }

  const [latest] = runs;
  if (latest?.ticketSetId !== approved.id) {
    if (run !== undefined && !runs.some((specRun) => specRun.number === run)) {
      throw new Error(`This map has no delivery run ${String(run)}`);
    }
    if (run === undefined) {
      const action = deliveryCardAction(detail.status.next, spec.number);
      const carried = approved.content.dispositions.some(
        (disposition) => disposition.kind === "delivered",
      );
      return (
        <NarrowPage
          detail={detail}
          aside={aside}
          head={
            <>
              <Switcher detail={detail} spec={spec} />
              <NotStartedHead
                detail={detail}
                spec={spec}
                revision={approvedRevision.revision}
                lede={
                  approvedRevision.delta === null
                    ? "One run delivers this spec's whole approved ticket set on one branch."
                    : `One run delivers this revision's new tickets on one branch.${carried ? " What carries over is already merged." : ""}`
                }
              />
            </>
          }
        >
          {action !== null &&
            // A set with no ticket has nothing to deliver: core's done line, no start card.
            (approved.content.tickets.length === 0 ? (
              <NextActionCard mapId={mapId} next={action} />
            ) : (
              <StartDeliveryCard
                mapId={mapId}
                ticketSetId={approved.id}
                project={detail.project}
                action={action}
              />
            ))}
        </NarrowPage>
      );
    }
  }
  if (latest === undefined) {
    throw new Error(`This map has no delivery run ${String(run)}`);
  }

  const shown = shownRun(runs, run);
  const isLatest = shown.id === latest.id;
  const ticketSet = runTicketSet(spec, shown);
  const revision = revisionOf(spec, ticketSet);
  const tickets = ticketSet.content.tickets;
  const verdict = shown.verdict;
  const blocking =
    verdict === null ? [] : verdict.findings.filter((finding) => finding.severity === "blocking");
  // A run of an earlier revision's set, opened by `?run=` while the current set has none, has no card.
  const card =
    isLatest && latest.ticketSetId === approved.id ? (
      <LatestRunCard detail={detail} spec={spec} ticketSetId={approved.id} latest={latest} />
    ) : null;

  return (
    <WorkspaceColumns
      label={`Run ${String(shown.number)} activity`}
      column={
        <RunActivity
          key={shown.id}
          mapId={mapId}
          specNumber={spec.number}
          run={shown}
          aside={aside}
        />
      }
    >
      <WorkspacePage
        head={
          <>
            <Switcher detail={detail} spec={spec} />
            {!isLatest && (
              <Alert className="flex items-center gap-3">
                <AlertDescription className="flex-1">
                  This is run {shown.number}, kept on record. Run {latest.number} is the latest.
                </AlertDescription>
                <Button variant="outline" size="sm" asChild>
                  <SpecStageLink
                    mapId={mapId}
                    specs={detail.specs}
                    stage="delivery"
                    specNumber={spec.number}
                    search={{}}
                  >
                    Open run {latest.number}
                  </SpecStageLink>
                </Button>
              </Alert>
            )}
            <RunHead
              run={shown}
              eyebrow={runEyebrow(shown, revision.revision)}
              title={<AgentText text={spec.title} />}
              canCancel={isLatest}
            />
          </>
        }
      >
        {blocking.length === 0 && card}
        {verdict !== null && blocking.length > 0 && (
          <section aria-labelledby="findings-heading" className="grid gap-2">
            <h2
              id="findings-heading"
              className="font-display text-base font-semibold tracking-[-0.015em]"
            >
              {plural(blocking.length, "blocking finding")}
            </h2>
            {blocking.map((finding, index) => (
              <FindingCard
                key={index}
                mapId={mapId}
                specs={detail.specs}
                spec={spec}
                revision={revision}
                tickets={tickets}
                verdict={verdict}
                finding={finding}
              />
            ))}
          </section>
        )}
        {/* A blocked run shows its verdict before the way out of it. */}
        {blocking.length > 0 && card}
        <RunSteps
          key={shown.id}
          run={shown}
          tickets={tickets}
          revision={revision.revision}
          links={{ mapId, specNumber: spec.number, run: shown.number }}
        />
        {runs.length > 1 && (
          <RunList
            mapId={mapId}
            specs={detail.specs}
            specNumber={spec.number}
            runs={runs}
            shown={shown.number}
          />
        )}
      </WorkspacePage>
    </WorkspaceColumns>
  );
}
