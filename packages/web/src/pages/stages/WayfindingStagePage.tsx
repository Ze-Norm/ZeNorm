import { Link } from "@tanstack/react-router";
import type {
  MapOutOfScopeLine,
  MapOverviewDetail,
  NextAction,
  WayfindingWaypoint,
} from "@zenorm/contracts";
import { ArrowRight, Check } from "lucide-react";

import { AgentText } from "@/components/AgentText";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { NextActionCard } from "@/components/NextActionCard";
import { Micro, PageHead, SectionHead } from "@/components/parts";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "@/components/WorkspaceColumns";
import { mapHeading } from "@/lib/map";
import { Proposals } from "@/pages/stages/wayfinding/Proposals";
import {
  formatDay,
  plural,
  StoppedRunCard,
  submittedRounds,
  WayfindingPage,
} from "@/pages/stages/wayfinding/shared";

/**
 * Wayfinding. While the map has no title: only its one next action. Then the index
 * beside the map overview: a card per pending round (**Answer**), per stopped scope and per
 * waiting waypoint (**Try again**), else the one agent card; the destination once confirmed;
 * Decisions so far; Not yet specified; Out of scope; Suggested new maps. Every action comes from
 * `map.overview`; no button starts a waypoint.
 */
export function WayfindingStagePage({ detail }: { detail: MapOverviewDetail }) {
  const mapId = detail.map.id;
  const [first] = detail.status.next;
  if (first === undefined) {
    throw new Error(`Map ${mapId} has no next action`);
  }

  const [, stage] = detail.status.stages;
  if (detail.map.title === null) {
    // Charting has not named the map: its head as Idea's, and the one card.
    return (
      <WorkspacePage
        head={<PageHead eyebrow="Wayfinding" title={mapHeading(detail.map)} lede={stage.line} />}
      >
        <ActionCard mapId={mapId} next={first} />
      </WorkspacePage>
    );
  }

  return (
    <WayfindingPage
      detail={detail}
      selected="overview"
      head={
        <PageHead eyebrow="Wayfinding · map overview" title={detail.map.title} lede={stage.line} />
      }
    >
      <Overview detail={detail} />
    </WayfindingPage>
  );
}

/**
 * The overview's next-action cards: every round and stopped scope waiting on you; else the one
 * thing the agent is doing; once Wayfinding is done, the map's next action wherever it is (a
 * cleared map shows its Next card, e.g. Spec's).
 */
function wayfindingCards(
  detail: MapOverviewDetail,
  yours: readonly NextAction[],
  agent: NextAction | undefined,
): readonly NextAction[] {
  if (yours.length > 0) return yours;
  if (agent !== undefined) return [agent];
  const [, stage] = detail.status.stages;
  if (stage.tone === "done") {
    const [first] = detail.status.next;
    if (first === undefined) throw new Error(`Map ${detail.map.id} has no next action`);
    return [first];
  }
  throw new Error(
    `Map ${detail.map.id} has Wayfinding ${stage.tone} with no Wayfinding next action`,
  );
}

function Overview({ detail }: { detail: MapOverviewDetail }) {
  const mapId = detail.map.id;
  const { waypoints, fog, outOfScope, proposals } = detail.wayfinding;
  const wayfinding = detail.status.next.filter((action) => action.stage === "wayfinding");
  const yours = wayfinding.filter((action) => action.who === "you");
  const agent = wayfinding.find((action) => action.who === "agent");
  const shown = wayfindingCards(detail, yours, agent);
  // Out-of-scope waypoints are neither counted nor waited on.
  const inScope = waypoints.filter((waypoint) => waypoint.status !== "out_of_scope");
  const unresolved = inScope.some((waypoint) => waypoint.status !== "resolved");
  const decided = inScope.filter((waypoint) => waypoint.status === "resolved");

  return (
    <>
      <div className="grid gap-3">
        {shown.map((next) => (
          <ActionCard
            key={`${next.headline}-${next.stopped === null ? "" : next.stopped.runId}-${
              next.waiting === null ? "" : next.waiting.runId
            }`}
            mapId={mapId}
            next={next}
          />
        ))}
        {unresolved && (
          <p className="text-[12.5px] text-muted-foreground">
            The agent takes each waypoint as soon as nothing blocks it: research runs on its own,
            and a decision reaches you as a question round.
          </p>
        )}
      </div>

      {detail.map.destinationConfirmedAt !== null && detail.map.destination !== null && (
        <Alert variant="note" role="region" aria-label="Destination">
          <AlertTitle>
            <Micro className="font-bold text-ink">Destination</Micro>
          </AlertTitle>
          <AlertDescription className="text-[13.5px]">
            <AgentText text={detail.map.destination} specLinks />
          </AlertDescription>
        </Alert>
      )}

      <section aria-label="Decisions so far" className="grid gap-2">
        <SectionHead
          title="Decisions so far"
          right={
            <Micro>
              {decided.length} of {inScope.length} waypoints resolved
            </Micro>
          }
        />
        <p className="text-[12.5px] text-muted-foreground">
          One line per resolved waypoint. Open a line for the full resolution and the questions and
          answers behind it.
        </p>
        {decided.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing is decided yet.</p>
        ) : (
          <Card className="grid">
            {decided.map((waypoint) => (
              <DecisionLine key={waypoint.id} mapId={mapId} waypoint={waypoint} />
            ))}
          </Card>
        )}
      </section>

      <section aria-label="Not yet specified" className="grid gap-2">
        <SectionHead title="Not yet specified" right={<Micro>fog · {fog.length}</Micro>} />
        {fog.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No fog left.</p>
        ) : (
          fog.map((item) => (
            <p key={item.position} className="text-[13.5px]">
              {item.text}
            </p>
          ))
        )}
      </section>

      <section aria-label="Out of scope" className="grid gap-2">
        <SectionHead title="Out of scope" right={<Micro>{outOfScope.length}</Micro>} />
        {outOfScope.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing ruled out yet.</p>
        ) : (
          outOfScope.map((line, index) => <OutOfScopeLine key={index} mapId={mapId} line={line} />)
        )}
      </section>

      <Proposals mapId={mapId} proposals={proposals} kind="outside" />
      <Proposals mapId={mapId} proposals={proposals} kind="split" />
    </>
  );
}

/**
 * One Out of scope line: a waypoint's opens that waypoint; a line whose work a confirmed proposal
 * split into a new map links that map (map proposals).
 */
function OutOfScopeLine({ mapId, line }: { mapId: string; line: MapOutOfScopeLine }) {
  const { splitMapId } = line;
  return (
    <p className="text-[13.5px] text-muted-foreground">
      {line.waypoint === null ? (
        line.text
      ) : (
        <Link
          to="/maps/$mapId/wayfinding/$number"
          params={{ mapId, number: line.waypoint }}
          className="hover:text-foreground hover:underline"
        >
          {line.text}
        </Link>
      )}
      {splitMapId !== null && (
        <>
          {" "}
          <Link
            to="/maps/$mapId/$stage"
            params={{ mapId: splitMapId, stage: "idea" }}
            className="text-xs text-primary hover:underline"
          >
            Split into its own map →
          </Link>
        </>
      )}
    </p>
  );
}

/**
 * Where a decision line came from: research findings, a task done, or the rounds; a
 * Grilling waypoint resolved without asking (the consistency pass or the hatch closed it) says so
 * rather than counting no questions.
 */
function decisionSource(waypoint: WayfindingWaypoint): string {
  switch (waypoint.kind) {
    case "research":
      return "research findings";
    case "task":
      return "task done";
    case "grilling": {
      const rounds = submittedRounds(waypoint.rounds);
      if (rounds.length === 0) {
        return "resolved without a question round";
      }
      const questions = rounds.reduce((count, round) => count + round.questions.length, 0);
      return `${plural(questions, "question")} answered${
        rounds.length > 1 ? ` over ${String(rounds.length)} rounds` : ""
      }`;
    }
  }
}

/** A resolved waypoint as the map shows it: its gist, and where that line came from. */
function DecisionLine({ mapId, waypoint }: { mapId: string; waypoint: WayfindingWaypoint }) {
  if (waypoint.gist === null || waypoint.resolvedAt === null) {
    throw new Error(`Resolved waypoint ${waypoint.id} has no gist or resolvedAt`);
  }
  const source = decisionSource(waypoint);
  return (
    <Link
      to="/maps/$mapId/wayfinding/$number"
      params={{ mapId, number: waypoint.number }}
      className="grid grid-cols-[16px_1fr] gap-x-2.5 gap-y-0.5 border-t border-border px-3.5 py-2.5 text-left first:border-t-0 hover:bg-secondary"
    >
      <Check className="mt-1 size-3.5 text-ok" aria-hidden />
      <span className="text-[14px] leading-snug">
        <AgentText text={waypoint.gist} />
      </span>
      <span className="col-start-2 text-[12px] text-muted-foreground">
        {waypoint.title} · {source} · {formatDay(waypoint.resolvedAt)}
      </span>
    </Link>
  );
}

/**
 * A next action's card: its label (**Answer**) opening its round, or the stopped run's code with
 * **Try again**; an agent card carries no button.
 */
function ActionCard({ mapId, next }: { mapId: string; next: NextAction }) {
  if (next.stopped !== null) {
    return <StoppedRunCard mapId={mapId} next={next} />;
  }
  if (next.round === null) {
    return <NextActionCard mapId={mapId} next={next} />;
  }
  // The round's button, as core labels it.
  const { label } = next;
  if (label === null) {
    throw new Error(`Map ${mapId}'s round on ${next.stage} has no button label`);
  }
  return (
    <NextActionCard mapId={mapId} next={next}>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          {next.round === "destination" ? (
            <Link to="/maps/$mapId/wayfinding/destination" params={{ mapId }}>
              {label} <ArrowRight />
            </Link>
          ) : (
            <Link to="/maps/$mapId/wayfinding/$number" params={{ mapId, number: next.round }}>
              {label} <ArrowRight />
            </Link>
          )}
        </Button>
      </div>
    </NextActionCard>
  );
}
