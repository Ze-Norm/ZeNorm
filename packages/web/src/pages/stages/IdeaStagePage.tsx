import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AccessDeniedError,
  MapNotFoundError,
  MapOverviewDetail,
  MapSpec,
  NextAction,
  SpecWaitView,
  StageStatus,
  TextDelta,
  WaitingReason,
  Wayfinding,
  WaypointState,
} from "@zenorm/contracts";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { AgentText, IdeaText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { DeleteMapButton } from "@/components/DeleteMapButton";
import { NextActionCard } from "@/components/NextActionCard";
import { Micro, PageHead, TONE_TEXT } from "@/components/parts";
import { RefusalAlert } from "@/components/RefusalAlert";
import { SpecStageLink } from "@/components/SpecStageLink";
import { WorkspacePage } from "@/components/WorkspaceColumns";
import { accessDeniedSentence } from "@/lib/access";
import { formatMoment, mapHeading, mapName, overviewActions, stageName } from "@/lib/map";
import { shownQueryError } from "@/lib/query-errors";
import {
  actionSpec,
  changeTally,
  isSpecStage,
  ownRevisions,
  ownTicketSets,
  revisionBefore,
  runsOn,
  type SpecStage,
} from "@/lib/specs";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc";
import { failureSentence, plural } from "@/pages/stages/delivery/words";

/** The last element of a list, undefined for an empty one. */
function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/**
 * Idea: the map's overview (spec D8, S5-11; slice 6a S6a-18). The head as every stage's (UX review
 * P2-4): the map's title with the agent's one-line reading as the lede, or "Untitled map" before
 * charting names it; then what the map waits for first, as on every stage (up to two cards, then
 * "Also in motion" with the rest, L143); the idea itself quoted under that (six lines before a
 * title, when it is the page's only statement of the map, three after), then the Destination once confirmed,
 * then one digest per later stage from what it has produced so far, each linking its stage. Everything comes from
 * `map.overview` (D4).
 */
export function IdeaStagePage({ detail }: { detail: MapOverviewDetail }) {
  const { cards, rest } = overviewActions(detail.status.next);
  const [idea] = detail.status.stages;

  return (
    <WorkspacePage
      head={
        <PageHead
          eyebrow={`Idea · ${detail.project.name} · ${idea.line} · ${formatMoment(detail.map.createdAt)}`}
          title={mapHeading(detail.map)}
          lede={summaryLede(detail)}
          right={<DeleteMapButton map={detail.map} />}
        />
      }
    >
      <div className="grid gap-3">
        {cards.map((next, index) => (
          // Several actions can share a stage (rounds and waiting waypoints, slice 6b D7).
          // A stopped run's card carries its own **Try again** (UX audit P1-1).
          <NextActionCard key={index} mapId={detail.map.id} next={next} />
        ))}
        {rest.length > 0 && (
          <AlsoInMotion
            mapId={detail.map.id}
            specs={detail.specs}
            waits={detail.waits}
            rest={rest}
          />
        )}
      </div>

      <ClampedText
        as="blockquote"
        lines={detail.map.title === null ? 6 : 3}
        aria-label="Your idea"
        className="max-w-[80ch] border-l-2 border-ink-line pl-4 font-display text-[17px] leading-relaxed font-medium tracking-[-0.01em] whitespace-pre-wrap"
      >
        “<IdeaText text={detail.map.idea} />”
      </ClampedText>
      {detail.map.splitFromMapId !== null && <SplitFrom mapId={detail.map.splitFromMapId} />}

      <Destination detail={detail} />

      <StageDigests detail={detail} />
    </WorkspacePage>
  );
}

function splitFromNotFoundMessage(error: MapNotFoundError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  return `There is no map ${error.data.mapId}.`;
}

/**
 * Where a map split from (map proposals): the map whose proposal the person confirmed to create
 * it, linking back to that map's Wayfinding under its name (`mapName`). Nothing shows while that
 * map loads; a failed read shows its refusal.
 */
function SplitFrom({ mapId }: { mapId: string }) {
  const source = useQuery(orpc.map.get.queryOptions({ input: { mapId } }));
  const error = shownQueryError(source.error);
  if (error !== null) {
    return (
      <RefusalAlert
        error={error}
        sentence={splitFromNotFoundMessage}
        title="Could not load the map this one split from"
        showMessage={false}
      />
    );
  }
  if (source.data === undefined) {
    return null;
  }
  const { map } = source.data;
  return (
    <p role="group" aria-label="Split from" className="text-[13px] text-muted-foreground">
      Split from{" "}
      <Link
        to="/maps/$mapId/$stage"
        params={{ mapId, stage: "wayfinding" }}
        className="text-foreground hover:text-primary hover:underline"
      >
        {mapName(map)}
      </Link>
    </p>
  );
}

/** The head's lede: the agent's summary once the map has a title. */
function summaryLede(detail: MapOverviewDetail): ReactNode {
  const { map } = detail;
  if (map.title === null) {
    return undefined;
  }
  if (map.summary === null) {
    throw new Error(`Map ${map.id} has a title but no summary`);
  }
  return <AgentText text={map.summary} specLinks />;
}

/** The Destination once confirmed. */
function Destination({ detail }: { detail: MapOverviewDetail }) {
  const { map } = detail;
  if (map.destinationConfirmedAt === null) {
    return null;
  }
  if (map.destination === null) {
    throw new Error(`Map ${map.id} confirmed a destination it does not have`);
  }
  return (
    <Alert variant="note" role="group" aria-label="Destination">
      <AlertTitle>
        <Micro className="font-bold text-ink">Destination</Micro>
      </AlertTitle>
      <AlertDescription className="text-[13.5px]">
        <p>
          <AgentText text={map.destination} specLinks />
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The map's other next actions, a line each, after the cards: each yours with its label (S7b-16); each names its stage and,
 * when about a spec, the spec's title, and opens that spec's page (the demo's lines, L141).
 */
function AlsoInMotion({
  mapId,
  specs,
  waits,
  rest,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  waits: readonly SpecWaitView[];
  rest: readonly NextAction[];
}) {
  const yours = rest.filter((next) => next.who === "you").length;
  const agent = rest.filter((next) => next.who === "agent").length;
  const elsewhere = rest.filter((next) => next.who === "another-map").length;
  const lineClass =
    "grid grid-cols-[8px_1fr_auto] items-baseline gap-x-3 border-t border-border px-4 py-2 text-left text-[13px] hover:bg-secondary";
  return (
    <Card asChild className="grid">
      <section aria-label="Also in motion">
        <Micro className="px-4 pt-3 pb-1.5">
          Also in motion · {yours} more waiting on you
          {agent > 0 ? ` · ${String(agent)} with the agent` : ""}
          {elsewhere > 0 ? ` · ${String(elsewhere)} waiting on another map` : ""}
        </Micro>
        <ul>
          {rest.map((next, index) => {
            // A wait's spec is one the map waits on, not one it wrote (tickets review B6).
            const about = actionSpec(next, specs, waits);
            const content = (
              <>
                <span
                  className={cn(
                    "size-1.5 self-center",
                    next.who === "you"
                      ? "bg-primary"
                      : next.who === "another-map"
                        ? "bg-hair-strong"
                        : "bg-work-dot",
                  )}
                />
                <span className="min-w-0">
                  <span className="font-medium">{next.headline}</span>{" "}
                  <span className="text-muted-foreground">
                    {stageName(next.stage)}
                    {about !== undefined && ` · ${about.title}`}
                  </span>
                </span>
                <span
                  className={
                    next.who === "you" ? "text-xs text-primary" : "text-xs text-muted-foreground"
                  }
                >
                  {next.label !== null
                    ? `${next.label} →`
                    : next.who === "another-map"
                      ? "Open that map →"
                      : "Watch →"}
                </span>
              </>
            );
            return (
              // Several entries can share a stage (rounds and waiting waypoints, slice 6b D7).
              <li key={index}>
                {next.onMap !== null && next.spec !== null && isSpecStage(next.stage) ? (
                  // A wait opens the spec on the map it waits on (S8b-16).
                  <Link
                    to="/maps/$mapId/$stage/$specNumber"
                    params={{ mapId: next.onMap, stage: next.stage, specNumber: next.spec }}
                    className={lineClass}
                  >
                    {content}
                  </Link>
                ) : about?.kind === "spec" && isSpecStage(next.stage) ? (
                  <SpecStageLink
                    mapId={mapId}
                    specs={specs}
                    stage={next.stage}
                    specNumber={about.spec.number}
                    search={{}}
                    className={lineClass}
                  >
                    {content}
                  </SpecStageLink>
                ) : (
                  <Link
                    to="/maps/$mapId/$stage"
                    params={{ mapId, stage: next.stage }}
                    className={lineClass}
                  >
                    {content}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </Card>
  );
}

/** Wayfinding, Spec, Tickets and Delivery, each with its line and what it has so far. */
function StageDigests({ detail }: { detail: MapOverviewDetail }) {
  const mapId = detail.map.id;
  const [, wayfinding, specStatus, ticketsStatus, deliveryStatus] = detail.status.stages;
  return (
    // From `lg` the stage names share one label column, as wide as the longest, and each row's
    // line, link and body line up with it through a subgrid (UX audit F1, review P2-11).
    <Card asChild className="grid lg:grid-cols-[max-content_minmax(0,1fr)_auto]">
      <section aria-label="Stages so far">
        <StageDigest mapId={mapId} status={wayfinding}>
          <WayfindingDigest mapId={mapId} wayfinding={detail.wayfinding} />
        </StageDigest>
        <StageDigest mapId={mapId} status={specStatus}>
          <PerSpec detail={detail} stage="spec">
            {(spec) => <SpecDigest mapId={mapId} spec={spec} />}
          </PerSpec>
        </StageDigest>
        <StageDigest mapId={mapId} status={ticketsStatus}>
          <PerSpec detail={detail} stage="tickets">
            {(spec) => <TicketsDigest mapId={mapId} spec={spec} />}
          </PerSpec>
        </StageDigest>
        <StageDigest mapId={mapId} status={deliveryStatus}>
          <PerSpec detail={detail} stage="delivery">
            {(spec) => <DeliveryDigest mapId={mapId} spec={spec} />}
          </PerSpec>
        </StageDigest>
      </section>
    </Card>
  );
}

/**
 * A later stage's digest, once per spec (the demo's `PerSpec`): a map with several specs names
 * each, opening it in that stage.
 */
function PerSpec({
  detail,
  stage,
  children,
}: {
  detail: MapOverviewDetail;
  stage: SpecStage;
  children: (spec: MapSpec) => ReactNode;
}) {
  const [only] = detail.specs;
  if (detail.specs.length === 1 && only !== undefined) {
    return children(only);
  }
  return (
    <div className="grid gap-3">
      {detail.specs.map((spec) => (
        <div key={spec.number} className="grid gap-1">
          <SpecStageLink
            mapId={detail.map.id}
            specs={detail.specs}
            stage={stage}
            specNumber={spec.number}
            search={{}}
            className="w-fit text-left text-[13px] font-semibold hover:text-primary"
          >
            <AgentText text={spec.title} />
          </SpecStageLink>
          {children(spec)}
        </div>
      ))}
    </div>
  );
}

/**
 * One later stage: its name in its tone, its line, Open →, and its body unless it is later. Below
 * `lg` the name sits above its line with the link at the right; from `lg` the row takes the
 * section's three columns, the body under the line.
 */
function StageDigest({
  mapId,
  status,
  children,
}: {
  mapId: string;
  status: StageStatus;
  children: ReactNode;
}) {
  const name = stageName(status.stage);
  const headingId = `digest-${status.stage}`;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-t border-border px-4 py-3.5 first:border-t-0 lg:col-span-3 lg:grid-cols-subgrid"
    >
      <h2
        id={headingId}
        className={cn("col-start-1 row-start-1 micro font-bold", TONE_TEXT[status.tone])}
      >
        {name}
      </h2>
      <span
        className={cn(
          "col-span-2 row-start-2 min-w-0 text-[13px] lg:col-span-1 lg:col-start-2 lg:row-start-1",
          status.tone === "later" ? "text-faint" : "text-muted-foreground",
        )}
      >
        {status.line}
      </span>
      <Link
        to="/maps/$mapId/$stage"
        params={{ mapId, stage: status.stage }}
        aria-label={`Open ${name}`}
        className="col-start-2 row-start-1 text-xs text-primary hover:underline lg:col-start-3"
      >
        Open →
      </Link>
      {status.tone !== "later" && (
        <div className="col-span-2 row-start-3 mt-1.5 min-w-0 lg:col-start-2 lg:row-start-2">
          {children}
        </div>
      )}
    </div>
  );
}

/** A waiting waypoint's mark (slice 6b D8), as the Wayfinding index marks it. */
const waitingMark: Record<WaitingReason, string> = {
  research_unanswered: "report waiting",
  task_failed: "task failed",
};

/** The one state of a waypoint that is not resolved (S6a-18; slice 6b D12, S6b-17), as core derives it. */
function waypointState(state: WaypointState): string {
  switch (state.kind) {
    case "out_of_scope":
      return "out of scope";
    case "waiting_on_you":
      return "waiting on you";
    case "working":
      return "agent working";
    case "stopped":
      return "stopped · Try again";
    case "waiting":
      return `${waitingMark[state.run.reason]} · Try again`;
    case "blocked":
      return `waits on ${state.waitsOn.join(", ")}`;
    case "waits_on_survey":
      return "waits on the code survey";
    case "resolved":
      throw new Error("A resolved waypoint is a decision, not a state line");
  }
}

/**
 * Wayfinding's digest (S6a-18; slice 6b D12): each resolved waypoint's gist and title, then each
 * other waypoint with its one state, then "Fog: …" while fog remains. Every waypoint line opens its
 * waypoint.
 */
function WayfindingDigest({ mapId, wayfinding }: { mapId: string; wayfinding: Wayfinding }) {
  const resolved = wayfinding.waypoints.filter((waypoint) => waypoint.status === "resolved");
  const others = wayfinding.waypoints.filter((waypoint) => waypoint.status !== "resolved");
  if (resolved.length === 0 && others.length === 0 && wayfinding.fog.length === 0) {
    return null;
  }
  const lineClass = "grid grid-cols-[16px_1fr] gap-2 text-left hover:text-primary";
  return (
    <div className="grid gap-2 text-[13px]">
      <ul className="grid gap-2">
        {resolved.map((waypoint) => {
          if (waypoint.gist === null) {
            throw new Error(`Resolved waypoint ${String(waypoint.number)} has no gist`);
          }
          return (
            <li key={waypoint.id}>
              <Link
                to="/maps/$mapId/wayfinding/$number"
                params={{ mapId, number: waypoint.number }}
                className={lineClass}
              >
                <Check className="mt-0.5 size-3.5 text-ok" aria-hidden />
                <span>
                  <span className="font-medium">
                    <AgentText text={waypoint.gist} />
                  </span>{" "}
                  <span className="text-muted-foreground">{waypoint.title}</span>
                </span>
              </Link>
            </li>
          );
        })}
        {others.map((waypoint) => (
          <li key={waypoint.id}>
            <Link
              to="/maps/$mapId/wayfinding/$number"
              params={{ mapId, number: waypoint.number }}
              className={lineClass}
            >
              <span className="mt-1.5 size-1.5 border border-hair-strong" aria-hidden />
              <span className="text-muted-foreground">
                {waypoint.title}
                <span className="text-faint"> · {waypointState(waypoint.state)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {wayfinding.fog.length > 0 && (
        <p className="text-faint">Fog: {wayfinding.fog.map((item) => item.text).join(" ")}</p>
      )}
    </div>
  );
}

/**
 * A spec in the overview, as the demo's: this map's latest revision's problem, then "r<n> · n
 * behaviours: <titles>", and past r1 the revision it revises with its text delta's tally (D13).
 */
function SpecDigest({ mapId, spec }: { mapId: string; spec: MapSpec }) {
  const revision = last(ownRevisions(spec, mapId));
  if (revision === undefined) {
    return null;
  }
  const { clauses } = revision.content;
  return (
    <div className="grid gap-1.5 text-[13px]">
      <p>
        <AgentText text={revision.content.problem} />
      </p>
      <p className="text-muted-foreground">
        r{revision.revision} · {plural(clauses.length, "behaviour")}:{" "}
        <AgentText text={clauses.map((clause) => clause.title).join(" · ")} />
      </p>
      {revision.delta !== null && <Revises mapId={mapId} spec={spec} delta={revision.delta} />}
      {revision.rejectionReason !== null && (
        <p className="text-muted-foreground">Rejected: {revision.rejectionReason}</p>
      )}
    </div>
  );
}

/**
 * On a revision after the first (the demo's `Revises`): the revision it changes, the map that wrote
 * that one when it is another, and how much of the text moved.
 */
function Revises({ mapId, spec, delta }: { mapId: string; spec: MapSpec; delta: TextDelta }) {
  const before = revisionBefore(spec, delta);
  return (
    <p className="text-muted-foreground">
      Revises r{delta.before}
      {before.mapId !== mapId && (
        <>
          {" "}
          from{" "}
          <Link
            to="/maps/$mapId/$stage/$specNumber"
            params={{ mapId: before.mapId, stage: "spec", specNumber: spec.number }}
            className="text-foreground hover:text-primary hover:underline"
          >
            “{before.mapTitle}”
          </Link>
        </>
      )}
      . Text: {changeTally(delta)}.
    </p>
  );
}

function TicketsDigest({ mapId, spec }: { mapId: string; spec: MapSpec }) {
  // A later map's set on the spec is that map's (slice 8b D9).
  const set = last(ownTicketSets(spec, mapId));
  if (set === undefined) {
    return null;
  }
  return (
    <div className="grid gap-1 text-[13px]">
      {set.content.tickets.map((ticket) => (
        <div key={ticket.id} className="grid grid-cols-[28px_1fr] gap-2">
          <span className="font-mono text-[11px] leading-[1.7] text-faint">{ticket.id}</span>
          <span>
            <AgentText text={ticket.title} />
          </span>
        </div>
      ))}
      <Micro className="mt-1">
        Version {set.version}
        {set.approvedAt === null ? "" : ` · approved ${formatMoment(set.approvedAt)}`}
      </Micro>
    </div>
  );
}

/**
 * The spec's latest delivery run on this map (`runsOn`; slice 8 S8-14, 8b D9), as the demo
 * digests it (`IdeaStage.tsx` 225–248): the verdict summary, a failure's sentence, each blocking
 * finding's title, "k of n tickets implemented · <branch>" (just the branch before `0010`) and **merged**.
 */
function DeliveryDigest({ mapId, spec }: { mapId: string; spec: MapSpec }) {
  // Runs are newest first; another map's runs on the spec are that map's (slice 8b D9).
  const run = runsOn(spec, mapId)[0];
  if (run === undefined) {
    return null;
  }
  const blocking =
    run.verdict === null
      ? []
      : run.verdict.findings.filter((finding) => finding.severity === "blocking");
  return (
    <div className="grid gap-1.5 text-[13px]">
      {run.verdict !== null && (
        <p>
          <AgentText text={run.verdict.summary} />
        </p>
      )}
      {run.failure !== null && (
        <p className="text-bad" data-code={run.failure.code}>
          <AgentText text={failureSentence(run.failure)} />
        </p>
      )}
      {blocking.map((finding, index) => (
        <p key={index} className="flex items-center gap-1.5 text-bad">
          <X className="size-3.5 shrink-0" />{" "}
          <span>
            <AgentText text={finding.title} />
          </span>
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {run.tickets !== null && (
          <Micro>
            {run.tickets.filter((ticket) => ticket.status.state === "merged").length} of{" "}
            {run.tickets.length} tickets implemented ·
          </Micro>
        )}
        {/* The branch is a name, so it keeps its case (the micro label would shout it). */}
        <code className="font-mono text-[11px] break-all text-muted-foreground">{run.branch}</code>
        {run.mergedAt !== null && <Badge variant="ok">merged</Badge>}
      </div>
    </div>
  );
}
