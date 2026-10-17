import { Link } from "@tanstack/react-router";
import type {
  MapOverviewDetail,
  NextAction,
  NextActionWaiting,
  QuestionRound as QuestionRoundRecord,
  WayfindingWaypoint,
} from "@zenorm/contracts";
import { ArrowRight, Check } from "lucide-react";

import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Micro, PageHead } from "@/components/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMapOverview } from "@/lib/queries";

import {
  ExclusionReason,
  PassFinding,
  ResearchReports,
  WaitingBox,
  WhatWasDone,
} from "./kinds.tsx";
import { QuestionRound } from "./QuestionRound.tsx";
import {
  dependents,
  formatDay,
  pendingRound,
  plural,
  RoundsRecord,
  Folded,
  StoppedRunCard,
  submittedRounds,
  WayfindingFrame,
} from "./shared.tsx";
import { TouchesCard } from "./TouchesCard.tsx";
import { waypointByNumber } from "./waits.ts";

/**
 * `wayfinding/$number`: one waypoint: its open round, or the waypoint with its
 * resolution and the record of its rounds. An unknown number is the route's error.
 */
export function WaypointPage({ mapId, number }: { mapId: string; number: number }) {
  const overview = useMapOverview(mapId);
  const detail = overview.data;
  if (detail === undefined) {
    // The layout shows the refusal or the loading line until the overview is in.
    return null;
  }
  const waypoint = waypointByNumber(detail, number);
  const open = pendingRound(waypoint.rounds);

  return (
    <WayfindingFrame
      detail={detail}
      selected={waypoint.number}
      head={<WaypointHead detail={detail} waypoint={waypoint} open={open} />}
    >
      {open === null ? (
        <WaypointView detail={detail} waypoint={waypoint} />
      ) : (
        <div className="grid gap-5">
          {(waypoint.finding !== null || waypoint.reviewFinding !== null) && (
            <PassFinding detail={detail} waypoint={waypoint} />
          )}
          <QuestionRound
            key={open.id}
            round={open}
            earlier={submittedRounds(waypoint.rounds)}
            heldBy={null}
          />
        </div>
      )}
    </WayfindingFrame>
  );
}

/**
 * The waypoint's head as every stage's, above Wayfinding's index: its
 * number and kind in the eyebrow, with the open round's number while one waits on you; the
 * question as the lede, clamped to 3 lines (the round asks it with its intro and options, the
 * resolution answers it); its state as badges at the right.
 */
function WaypointHead({
  detail,
  waypoint,
  open,
}: {
  detail: MapOverviewDetail;
  waypoint: WayfindingWaypoint;
  open: QuestionRoundRecord | null;
}) {
  const waiting = dependents(detail, waypoint).length;
  const resolved = waypoint.status === "resolved";
  const outOfScope = waypoint.status === "out_of_scope";
  const waitingOnYou = waitingAction(detail, waypoint) !== null;
  return (
    <PageHead
      eyebrow={
        open === null ? (
          `Wayfinding · waypoint ${String(waypoint.number)} · ${waypoint.kind}`
        ) : (
          <>
            Wayfinding ·{" "}
            <span className="text-primary">
              Question round {open.number} · waypoint {waypoint.number}
            </span>{" "}
            · {waypoint.kind}
          </>
        )
      }
      title={waypoint.title}
      lede={
        <ClampedText as="p" lines={3}>
          <AgentText text={waypoint.question} />
        </ClampedText>
      }
      right={
        <div
          role="group"
          aria-label={`Waypoint ${String(waypoint.number)} state`}
          className="flex flex-wrap items-center gap-2"
        >
          {waypoint.state.kind === "working" && <Badge variant="work">agent working</Badge>}
          {(open !== null || waitingOnYou) && <Badge>waiting on you</Badge>}
          {open !== null && waiting > 0 && (
            <Micro>
              {plural(waiting, "waypoint")} {waiting === 1 ? "waits" : "wait"} on it
            </Micro>
          )}
          {outOfScope && <Badge variant="secondary">out of scope</Badge>}
          {resolved && waypoint.resolvedAt !== null && (
            <Badge variant="ok">resolved {formatDay(waypoint.resolvedAt)}</Badge>
          )}
        </div>
      }
    />
  );
}

/**
 * The map's next action that tries the waypoint's stopped run again, or null when its run
 * is not stopped. A stopped run with no such action is a status the overview cannot give.
 */
function stoppedAction(detail: MapOverviewDetail, waypoint: WayfindingWaypoint): NextAction | null {
  const { state } = waypoint;
  if (state.kind !== "stopped") {
    return null;
  }
  const action = detail.status.next.find((next) => next.stopped?.runId === state.run.runId);
  if (action === undefined) {
    throw new Error(`Waypoint ${String(waypoint.number)} is stopped but no next action tries it`);
  }
  return action;
}

/**
 * The waiting run that the map's next action for this waypoint tries again, or null when the
 * waypoint does not wait on the person.
 */
function waitingAction(
  detail: MapOverviewDetail,
  waypoint: WayfindingWaypoint,
): NextActionWaiting | null {
  const { state } = waypoint;
  if (state.kind !== "waiting") {
    return null;
  }
  const action = detail.status.next.find((next) => next.waiting?.runId === state.run.runId);
  const waiting = action?.waiting;
  if (waiting === undefined || waiting === null) {
    throw new Error(`Waypoint ${String(waypoint.number)} is waiting but no next action tries it`);
  }
  return waiting;
}

/** The blocked waypoint's line, worded by its kind. */
function blockedText(waypoint: WayfindingWaypoint, waits: readonly WayfindingWaypoint[]): string {
  const names = waits.map((blocker) => `“${blocker.title}”`).join(" and ");
  const are = waits.length === 1 ? "is" : "are";
  const answers = waits.length === 1 ? "its answer" : "their answers";
  switch (waypoint.kind) {
    case "grilling":
      return `Nothing to do here yet. The agent asks you about this as soon as ${names} ${are} resolved.`;
    case "research":
      return `Nothing to do here yet. The agent starts this research as soon as ${names} ${are} resolved, because ${answers} could change what is worth finding out.`;
    case "task":
      return `Nothing to do here yet. The agent starts this task as soon as ${names} ${are} resolved, because ${answers} could change what needs doing.`;
  }
}

/** The line of a waypoint that waits on the map's code survey, worded by its kind. */
function surveyText(waypoint: WayfindingWaypoint): string {
  switch (waypoint.kind) {
    case "grilling":
      return "Nothing to do here yet. The agent is reading the project's code first, and asks you about this once it has.";
    case "research":
      return "Nothing to do here yet. The agent is reading the project's code first, and starts this research once it has.";
    case "task":
      return "Nothing to do here yet. The agent is reading the project's code first, and starts this task once it has.";
  }
}

/** The run's description in the working box, worded by the waypoint's kind. */
function workingText(waypoint: WayfindingWaypoint): string {
  switch (waypoint.kind) {
    case "grilling":
      return "The agent is preparing a question round on this.";
    case "research":
      return "The agent is researching this.";
    case "task":
      return "The agent is working this task.";
  }
}

/** The amber working box under the Question while the waypoint's run works. */
function WorkingBox({ waypoint }: { waypoint: WayfindingWaypoint }) {
  return (
    <Alert variant="work" role="status" aria-label="Agent working">
      <AlertDescription className="flex items-center gap-2">
        <span className="pulse-soft size-1.5 shrink-0 bg-work-dot" />
        {workingText(waypoint)}
      </AlertDescription>
    </Alert>
  );
}

/** How the person changes what the agent decided: no control here reopens a waypoint. */
const REOPEN_HINT = "tell the agent to reopen this waypoint.";

/**
 * The resolved waypoint's box. Its gist leads and its full resolution is folded below. A research
 * waypoint's box is its "Findings". A grilling or task waypoint with an answered round is "Decided",
 * and lists any calls the agent made without asking under "Agent decided". One with no answered
 * round the agent settled alone (a decision with no round, a decided fog item, a task done unasked):
 * the whole box is the agent's, so it says so with the reopen hint and lists no calls apart (their
 * detail is in the full resolution). A resolved waypoint always has a gist and agentDecided
 * (`waypoints_resolution_ck`), so a missing one throws.
 */
function ResolutionBox({
  waypoint,
  resolution,
}: {
  waypoint: WayfindingWaypoint;
  resolution: string;
}) {
  const { gist, agentDecided } = waypoint;
  if (gist === null || agentDecided === null) {
    throw new Error(`Resolved waypoint ${String(waypoint.number)} has no gist or agentDecided`);
  }
  const research = waypoint.kind === "research";
  const agentAlone = !research && submittedRounds(waypoint.rounds).length === 0;
  const label = research ? "Findings" : agentAlone ? "Decided by the agent" : "Decided";
  return (
    <Alert variant="ok" role="region" aria-label={label}>
      <AlertTitle>
        <Micro className="font-bold text-ok">
          {label}
          {agentAlone && " · without asking you"}
        </Micro>
      </AlertTitle>
      <AlertDescription className="gap-2">
        <p className="text-[14px]">
          <AgentText text={gist} />
        </p>
        {agentAlone && (
          <p className="text-[12px] text-muted-foreground">To change it, {REOPEN_HINT}</p>
        )}
        {!agentAlone && agentDecided.length > 0 && <AgentDecided calls={agentDecided} />}
        <Folded label={research ? "Full findings" : "Full resolution"}>
          <p className="text-[13px]">
            <AgentText text={resolution} />
          </p>
        </Folded>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The calls the agent made without asking the person, flagged, with the reopen hint. No control
 * reopens a waypoint here: the person asks the agent to, below the activity (the escape hatch).
 */
function AgentDecided({ calls }: { calls: readonly string[] }) {
  return (
    <section
      aria-label="Agent decided"
      className="grid gap-1 justify-self-stretch border-t border-ok-dot/30 pt-2"
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary">Agent decided</Badge>
        <Micro>without asking you</Micro>
      </div>
      <ul className="grid list-disc gap-0.5 pl-5 text-[13px]">
        {calls.map((call, index) => (
          <li key={`${String(index)}-${call}`}>
            <AgentText text={call} />
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted-foreground">To change any of these, {REOPEN_HINT}</p>
    </section>
  );
}

function WaypointView({
  detail,
  waypoint,
}: {
  detail: MapOverviewDetail;
  waypoint: WayfindingWaypoint;
}) {
  const mapId = detail.map.id;
  const resolved = waypoint.status === "resolved";
  const rounds = submittedRounds(waypoint.rounds);
  const blockers = waypoint.blockedBy.map((n) => waypointByNumber(detail, n));
  const blocks = dependents(detail, waypoint);
  const waits =
    waypoint.state.kind === "blocked"
      ? waypoint.state.waitsOn.map((n) => waypointByNumber(detail, n))
      : [];
  const stopped = stoppedAction(detail, waypoint);
  const waiting = waitingAction(detail, waypoint);
  const outOfScope = waypoint.status === "out_of_scope";
  const nextRound = detail.status.next.find(
    (action) =>
      action.who === "you" && typeof action.round === "number" && action.round !== waypoint.number,
  );
  const nextWaypoint =
    nextRound === undefined || typeof nextRound.round !== "number"
      ? null
      : waypointByNumber(detail, nextRound.round);

  return (
    <article
      aria-label={`Waypoint ${String(waypoint.number)}`}
      className="grid grid-cols-[minmax(0,1fr)] gap-5"
    >
      {stopped !== null && <StoppedRunCard mapId={mapId} next={stopped} />}

      <PassFinding detail={detail} waypoint={waypoint} />

      {waypoint.touches.map((touch) => (
        <TouchesCard key={`${String(touch.specNumber)}-${String(touch.revision)}`} touch={touch} />
      ))}

      {waypoint.state.kind === "working" && <WorkingBox waypoint={waypoint} />}

      {outOfScope && <ExclusionReason waypoint={waypoint} />}

      {waiting !== null && <WaitingBox waypoint={waypoint} waiting={waiting} />}

      {waypoint.kind === "task" && resolved && <WhatWasDone waypoint={waypoint} />}

      {waypoint.resolution !== null && (
        <ResolutionBox waypoint={waypoint} resolution={waypoint.resolution} />
      )}

      {waypoint.kind === "research" && <ResearchReports waypoint={waypoint} />}

      {rounds.length > 0 && <RoundsRecord rounds={rounds} resolved={resolved} />}

      {waits.length > 0 && (
        <Card asChild className="px-3.5 py-2.5 text-[13px] text-muted-foreground">
          <p>{blockedText(waypoint, waits)}</p>
        </Card>
      )}

      {waypoint.state.kind === "waits_on_survey" && (
        <Card asChild className="px-3.5 py-2.5 text-[13px] text-muted-foreground">
          <p>{surveyText(waypoint)}</p>
        </Card>
      )}

      {nextWaypoint !== null && (
        <Button asChild variant="outline" className="w-fit">
          <Link
            to="/maps/$mapId/wayfinding/$number"
            params={{ mapId, number: nextWaypoint.number }}
          >
            Next round waiting on you: {nextWaypoint.title} <ArrowRight />
          </Link>
        </Button>
      )}

      {(blockers.length > 0 || blocks.length > 0) && (
        <section aria-label="Dependencies" className="grid gap-2 text-[13px]">
          {blockers.length > 0 && (
            <div>
              <Micro>Blocked by</Micro>
              {blockers.map((blocker) => (
                <Link
                  key={blocker.id}
                  to="/maps/$mapId/wayfinding/$number"
                  params={{ mapId, number: blocker.number }}
                  className="flex items-center gap-1.5 text-primary hover:underline"
                >
                  {blocker.status === "resolved" && (
                    <Check className="size-3.5 text-ok" aria-label="Resolved" />
                  )}{" "}
                  {blocker.title}
                </Link>
              ))}
            </div>
          )}
          {blocks.length > 0 && (
            <div>
              <Micro>Blocks</Micro>
              {blocks.map((dependent) => (
                <Link
                  key={dependent.id}
                  to="/maps/$mapId/wayfinding/$number"
                  params={{ mapId, number: dependent.number }}
                  className="block text-primary hover:underline"
                >
                  {dependent.title}
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
    </article>
  );
}
