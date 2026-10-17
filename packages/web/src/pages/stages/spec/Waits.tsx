import { Link } from "@tanstack/react-router";
import type { NextAction, SpecHold, SpecWaitView, WayfindingWaypoint } from "@zenorm/contracts";
import { ArrowRight } from "lucide-react";
import { Fragment } from "react";

import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { Micro, SectionHead } from "@/components/parts";
import { TryAgainButton } from "@/components/TryAgainButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoment } from "@/lib/map";

/** The card's tail after a hold's first sentence. */
const TAIL =
  "When that ends, this map's change is written as the next revision, with the note below as it stands. Nothing to do here meanwhile.";

/**
 * The wait card's sentence by its hold: page copy keyed on `hold.kind`; tests assert the kind,
 * never the words.
 */
export function holdSentence(hold: SpecHold): string {
  const holder = `“${hold.mapTitle}”`;
  const revision = `r${String(hold.revision)}`;
  switch (hold.kind) {
    case "revision":
      return `${holder} holds its unapproved revision ${revision}. One unapproved revision at a time: when ${revision} is approved there and its tickets are written, this map's change is written as the next revision, with the note below as it stands. Nothing to do here meanwhile.`;
    case "revising":
      return `${holder} is writing the next revision after ${revision}. ${TAIL}`;
    case "tickets":
      return `${holder} is writing or reviewing the tickets of ${revision}. ${TAIL}`;
    case "delivering":
      return `A delivery run of ${revision} is active on ${holder}. ${TAIL}`;
  }
}

/** An open wait nothing holds while the map's own planning comes first. */
const UNHELD =
  "Nothing holds it now. This map's change is written as the next revision once this map's own planning is settled, with the note below as it stands.";

/** A released wait while its run writes the revision. */
const RELEASED = "The agent is writing the next revision.";

/**
 * The changes this map waits with: each names a spec another map holds, the
 * way a waypoint names what blocks it; a released one until the map's revision lands.
 */
export function Waits({
  mapId,
  waits,
  waypoints,
  next,
}: {
  mapId: string;
  waits: readonly SpecWaitView[];
  waypoints: readonly WayfindingWaypoint[];
  /** The map's next actions, which a released wait's stopped run has its **Try again** among. */
  next: readonly NextAction[];
}) {
  if (waits.length === 0) {
    return null;
  }
  return (
    <section aria-label="Waiting on another map" className="grid gap-2">
      <SectionHead title="Waiting on another map" right={<Micro>{waits.length}</Micro>} />
      {waits.map((wait) => (
        <WaitCard
          key={wait.specNumber}
          mapId={mapId}
          wait={wait}
          waypoints={waypoints}
          next={next}
        />
      ))}
    </section>
  );
}

function WaitCard({
  mapId,
  wait,
  waypoints,
  next,
}: {
  mapId: string;
  wait: SpecWaitView;
  waypoints: readonly WayfindingWaypoint[];
  next: readonly NextAction[];
}) {
  const touching = wait.waypoints.map((number) => {
    const waypoint = waypoints.find((entry) => entry.number === number);
    if (waypoint === undefined) {
      throw new Error(
        `The wait on spec ${String(wait.specNumber)} names no waypoint ${String(number)}`,
      );
    }
    return waypoint;
  });
  const state = wait.released ? "released" : wait.hold === null ? "unheld" : wait.hold.kind;
  return (
    <Card asChild>
      <article
        aria-label={`Wait on “${wait.specTitle}”`}
        data-wait={state}
        className="grid gap-2.5 px-[18px] py-3.5 text-sm"
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold">“{wait.specTitle}”</span>
          {wait.released ? (
            <Badge variant="work">released</Badge>
          ) : (
            <Badge variant="soft">blocked</Badge>
          )}
          <span className="flex-1" />
          <Micro>since {formatMoment(wait.since)}</Micro>
        </div>
        <WaitState wait={wait} next={next} />
        <ClampedText
          as="blockquote"
          lines={4}
          className="border-l-2 border-ink-line pl-3 text-[13.5px] whitespace-pre-wrap"
        >
          {wait.note}
        </ClampedText>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          {touching.length > 0 && (
            <span className="text-muted-foreground">
              From{" "}
              {touching.map((waypoint, index) => (
                <Fragment key={waypoint.number}>
                  {index > 0 && ", "}
                  <Link
                    to="/maps/$mapId/wayfinding/$number"
                    params={{ mapId, number: waypoint.number }}
                    className="text-foreground hover:text-primary hover:underline"
                  >
                    <AgentText text={waypoint.title} />
                  </Link>
                </Fragment>
              ))}
            </span>
          )}
          <span className="flex-1" />
          {wait.hold !== null && (
            <Link
              to="/maps/$mapId/$stage/$specNumber"
              params={{ mapId: wait.hold.mapId, stage: "spec", specNumber: wait.specNumber }}
              className="flex items-center gap-1 text-primary hover:underline"
            >
              Open r{wait.hold.revision} on “{wait.hold.mapTitle}”{" "}
              <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      </article>
    </Card>
  );
}

/**
 * The map's next action that tries the released wait's stopped run again: its headline and core's
 * one sentence for why the run stopped. A stopped run with no such action is a status the overview
 * cannot give.
 */
function stoppedAction(wait: SpecWaitView, runId: string, next: readonly NextAction[]): NextAction {
  const action = next.find((entry) => entry.stopped?.runId === runId);
  if (action === undefined) {
    throw new Error(
      `The released wait on spec ${String(wait.specNumber)} stopped but no next action tries it`,
    );
  }
  return action;
}

/**
 * What the wait is on: its hold's sentence, an unheld wait's, or, once released, its run writing
 * the next revision (the working tone) or stopped with **Try again**.
 */
function WaitState({ wait, next }: { wait: SpecWaitView; next: readonly NextAction[] }) {
  if (!wait.released) {
    return (
      <p className="text-muted-foreground">
        {wait.hold === null ? UNHELD : holdSentence(wait.hold)}
      </p>
    );
  }
  if (wait.run === null) {
    throw new Error(`The released wait on spec ${String(wait.specNumber)} has no run`);
  }
  if (wait.run === "working") {
    return (
      <p className="flex items-center gap-2 text-work">
        <span className="pulse-soft size-1.5 bg-work-dot" /> {RELEASED}
      </p>
    );
  }
  const { runId, code } = wait.run.stopped;
  const action = stoppedAction(wait, runId, next);
  return (
    <div className="grid justify-items-start gap-3">
      <Alert variant="bad">
        <AlertTitle>{action.headline}</AlertTitle>
        {action.detail !== null && (
          <AlertDescription>
            <p data-code={code}>{action.detail}</p>
          </AlertDescription>
        )}
      </Alert>
      <TryAgainButton runId={runId} />
    </div>
  );
}
