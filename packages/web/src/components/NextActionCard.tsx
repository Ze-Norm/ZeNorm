import { Link } from "@tanstack/react-router";
import type {
  MapOverviewDetail,
  NextAction,
  Project,
  Stage,
  StageTone,
  StartDeliveryBlocker,
} from "@zenorm/contracts";
import { ArrowRight, Check, CircleAlert, Clock } from "lucide-react";
import type { ReactNode } from "react";

import { SpecStageLink } from "@/components/SpecStageLink";
import { TryAgainButton } from "@/components/TryAgainButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useViewedStage } from "@/hooks/use-viewed-stage";
import { STAGES, stageName } from "@/lib/map";
import { useMapOverview } from "@/lib/queries";
import { actionSpec, isSpecStage, specStageStatus } from "@/lib/specs";
import { cn } from "@/lib/utils";
import { blockerSentence } from "@/pages/stages/delivery/words";

/**
 * The next-action card family (spec D4, S7b-16; UX audit A2, D1): one card for every entry of a
 * map's `status.next`, whatever its `who`. The card's **tone** says who the action waits on and
 * how it is marked:
 *
 * - `your-turn`: a `you` action, the primary band and the action's own button.
 * - `agent-working`: an `agent` action, the work band and a pulsing line.
 * - `waiting`: an `another-map` action, or a `nobody` Delivery action held only by another spec's
 *   active run (`delivery_in_progress`): the quiet band, a clock, and a link to what it waits on.
 * - `blocker`: a `nobody` Delivery action the project's start blockers hold: `BlockerCard`, an
 *   alert mark, every blocker as a line (`ul` "Why Start delivery is unavailable", one
 *   `li[data-code]` each) in place of core's one-blocker detail, and **Set required checks** to
 *   Project settings while `project_checks_missing` is among them (**Set a repair limit** while
 *   only `project_repair_limit_missing` is). The project page shows the same card for the same
 *   blockers (UX audit P2-5).
 * - `done`: a `nobody` action on a done stage (Delivered and merged, Nothing to deliver): the check.
 * - `quiet`: any other `nobody` action (Nothing is in motion): the stage's number, as the rail.
 *
 * A `nobody` card's tone is derived here from the stage that owns the action (the spec's stage
 * when the action names a spec, else the map's) and the project's start blockers, so no page
 * passes one. Every card ends in an actions row: `children` when the page carries the action out
 * in place (a form, Approve and Reject); otherwise the standard row: **Try again** on a stopped run
 * (S6a-12) or, with **Open the waypoint**, on a waiting one (slice 6b D7), **Open that map** on a
 * wait (S8b-16), the action's own label on a `you` card, and on a quiet card **Set required
 * checks** and **Open <stage>** (never the stage the card is already on). A stopped run's card
 * says why it stopped as core's one-sentence detail, marked `data-code` with the failure code,
 * never as a code or a box (UX audit P1-1). The region is `section[aria-label="Next"]` with
 * `data-who` and `data-tone`.
 */

export type NextActionTone =
  "your-turn" | "agent-working" | "waiting" | "blocker" | "done" | "quiet";

/** The band a card with one opens with; a `nobody` card has no band. */
const BAND_LABEL: Record<Exclude<NextActionTone, "blocker" | "done" | "quiet">, string> = {
  "your-turn": "Next · needs you",
  "agent-working": "Next · agent is working",
  waiting: "Next · waits on another map",
};

/** The stage status an action rests on: the named spec's stage, else the map's. */
function owningTone(next: NextAction, detail: MapOverviewDetail): StageTone {
  const spec = next.spec === null ? undefined : detail.specs.find((s) => s.number === next.spec);
  if (spec !== undefined && isSpecStage(next.stage)) {
    return specStageStatus(spec, next.stage).tone;
  }
  const status = detail.status.stages.find((entry) => entry.stage === next.stage);
  if (status === undefined) {
    throw new Error(`Map ${detail.map.id} has no ${next.stage} stage in its status`);
  }
  return status.tone;
}

/** Whether every blocker is the transient one: another spec's run, which ends on its own. */
function onlyInProgress(blockers: readonly StartDeliveryBlocker[]): boolean {
  return blockers.length > 0 && blockers.every((blocker) => blocker === "delivery_in_progress");
}

/** The card's tone, from who the action is for and, for nobody's, what the stage rests on. */
export function nextActionTone(next: NextAction, detail: MapOverviewDetail): NextActionTone {
  switch (next.who) {
    case "you":
      return "your-turn";
    case "agent":
      return "agent-working";
    case "another-map":
      return "waiting";
    case "nobody": {
      const tone = owningTone(next, detail);
      if (tone === "done") {
        return "done";
      }
      const blockers = detail.project.startDeliveryBlockers;
      if (next.stage === "delivery" && tone === "idle" && blockers.length > 0) {
        return onlyInProgress(blockers) ? "waiting" : "blocker";
      }
      return "quiet";
    }
  }
}

/**
 * A waiting waypoint's actions (slice 6b D7, L115): **Try again** on its waiting run, as for a
 * stopped run, and **Open the waypoint**.
 */
function WaitingActions({
  mapId,
  waiting,
}: {
  mapId: string;
  waiting: NonNullable<NextAction["waiting"]>;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <TryAgainButton runId={waiting.runId} />
      <Button asChild variant="outline">
        <Link to="/maps/$mapId/wayfinding/$number" params={{ mapId, number: waiting.waypoint }}>
          Open the waypoint <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}

/**
 * A wait's way out (S8b-16; the demo's `next-action-elsewhere`): no action of the person's, only a link
 * to the spec on the map the wait is carried out on (`onMap`, this map for its own delivery run).
 */
export function OpenThatMap({ next }: { next: NextAction }) {
  if (next.onMap === null || next.spec === null || !isSpecStage(next.stage)) {
    throw new Error(`A ${next.who} action names no map, spec or spec stage to wait on`);
  }
  return (
    <Button asChild variant="outline" className="w-fit">
      <Link
        to="/maps/$mapId/$stage/$specNumber"
        params={{ mapId: next.onMap, stage: next.stage, specNumber: next.spec }}
      >
        Open that map <ArrowRight />
      </Link>
    </Button>
  );
}

/** The link that opens the action's stage: the spec's own stage page when it names a spec (D11). */
function OpenStage({
  mapId,
  next,
  detail,
  variant,
  children,
}: {
  mapId: string;
  next: NextAction;
  detail: MapOverviewDetail;
  variant: "default" | "outline";
  children: ReactNode;
}) {
  const about = actionSpec(next, detail.specs, detail.waits);
  return (
    <Button asChild variant={variant}>
      {about?.kind === "spec" && isSpecStage(next.stage) ? (
        <SpecStageLink
          mapId={mapId}
          specs={detail.specs}
          stage={next.stage}
          specNumber={about.spec.number}
          search={{}}
        >
          {children}
        </SpecStageLink>
      ) : (
        // A wait's spec opens this map's stage, where Waits shows it (B6).
        <Link to="/maps/$mapId/$stage" params={{ mapId, stage: next.stage }}>
          {children}
        </Link>
      )}
    </Button>
  );
}

/**
 * The Project settings link's words while a setting blocks delivery: the required checks first,
 * as core orders the blockers, else the repair limit; null when no setting does.
 */
function settingsLinkLabel(blockers: readonly StartDeliveryBlocker[]): string | null {
  if (blockers.includes("project_checks_missing")) {
    return "Set required checks";
  }
  if (blockers.includes("project_repair_limit_missing")) {
    return "Set a repair limit";
  }
  return null;
}

/** Whether `BlockerActions` has anything to offer for the project's blockers. */
export function hasBlockerActions(project: Project): boolean {
  const blockers = project.startDeliveryBlockers;
  return (
    settingsLinkLabel(blockers) !== null || (project.activeRun !== null && onlyInProgress(blockers))
  );
}

/**
 * The way past a start blocker (UX audit A2, D1): **Set required checks** opens Project settings
 * while the project has none, **Set a repair limit** while it has checks but no repair limit; the
 * transient blocker links the run it waits on. Null when the blockers offer nothing to click (a
 * missing folder or branch is fixed outside ZeNorm).
 */
export function BlockerActions({ project }: { project: Project }): ReactNode {
  const blockers = project.startDeliveryBlockers;
  const settings = settingsLinkLabel(blockers);
  const activeRun = project.activeRun;
  if (!hasBlockerActions(project)) {
    return null;
  }
  return (
    <>
      {settings !== null && (
        <Button asChild>
          <Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
            {settings} <ArrowRight />
          </Link>
        </Button>
      )}
      {settings === null && activeRun !== null && (
        <Button asChild variant="outline">
          <Link
            to="/maps/$mapId/$stage/$specNumber"
            params={{ mapId: activeRun.mapId, stage: "delivery", specNumber: activeRun.specNumber }}
          >
            Open that run <ArrowRight />
          </Link>
        </Button>
      )}
    </>
  );
}

/** Every blocker's sentence, in core's order; the region a flow reads the codes from. */
export function BlockerList({
  project,
  blockers,
}: {
  project: Project;
  blockers: readonly StartDeliveryBlocker[];
}) {
  return (
    <ul
      aria-label="Why Start delivery is unavailable"
      className="grid gap-0.5 text-[13.5px] text-muted-foreground"
    >
      {blockers.map((blocker) => (
        <li key={blocker} data-code={blocker}>
          {blockerSentence(blocker, project)}
        </li>
      ))}
    </ul>
  );
}

/**
 * The card a `nobody` action and the project page share: the mark, the headline with its body run
 * in under it, and the actions row. A blocker gets the work-coloured left rule.
 */
function RestingCard({
  label,
  who,
  tone,
  mark,
  headline,
  body,
  actions,
}: {
  label: string;
  who: NextAction["who"] | null;
  tone: NextActionTone;
  mark: ReactNode;
  headline: string;
  body: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Card asChild>
      <section
        aria-label={label}
        data-who={who}
        data-tone={tone}
        className={cn(
          "grid gap-3 px-[18px] py-3.5",
          tone === "blocker" && "border-l-[3px] border-l-work-dot",
        )}
      >
        <div className="flex items-start gap-3">
          <span className="grid h-[21px] place-items-center">{mark}</span>
          <div className="min-w-0 text-sm">
            <h2 className="inline font-semibold">{headline}</h2>
            {body}
          </div>
        </div>
        {actions}
      </section>
    </Card>
  );
}

/**
 * Why Start delivery is unavailable, as one card wherever it is said (UX audit A2, D1, P2-5): the
 * alert mark, the headline, every blocker's sentence, and the way past them. A map's quiet
 * Delivery action renders it through `NextActionCard`; the project page renders it directly with
 * the blockers it lists (never `delivery_in_progress` alone, which ends on its own).
 */
export function BlockerCard({
  project,
  blockers,
  label,
  headline,
  who,
  tone,
  children,
}: {
  project: Project;
  blockers: readonly StartDeliveryBlocker[];
  /** The region's name: "Next" on a map, the headline on the project page. */
  label: string;
  /** The headline: core's for a map's action, the project page's own. */
  headline: string;
  who: NextAction["who"] | null;
  tone: "blocker" | "waiting";
  /** Actions after the blockers' own (a map's **Open Delivery**); null for none. */
  children: ReactNode;
}) {
  if (blockers.length === 0) {
    throw new Error(`Project ${project.id} has no start blocker to show`);
  }
  const own = hasBlockerActions(project);
  const actions =
    own || children !== null ? (
      <div className="flex flex-wrap items-center gap-3">
        {own && <BlockerActions project={project} />}
        {children}
      </div>
    ) : null;
  return (
    <RestingCard
      label={label}
      who={who}
      tone={tone}
      mark={<QuietMark tone={tone} stage="delivery" />}
      headline={headline}
      body={<BlockerList project={project} blockers={blockers} />}
      actions={actions}
    />
  );
}

/** A quiet card's mark: the check, the alert, the clock, or the stage's number as the rail shows it. */
function QuietMark({ tone, stage }: { tone: NextActionTone; stage: Stage }) {
  switch (tone) {
    case "done":
      return <Check data-mark="done" className="size-4 shrink-0 text-ok" strokeWidth={2.5} />;
    case "blocker":
      return <CircleAlert data-mark="blocker" className="size-4 shrink-0 text-work-dot" />;
    case "waiting":
      return <Clock data-mark="waiting" className="size-4 shrink-0 text-muted-foreground" />;
    case "quiet":
    case "your-turn":
    case "agent-working": {
      const number = STAGES.findIndex((entry) => entry.stage === stage) + 1;
      if (number === 0) {
        throw new Error(`No stage named ${stage}`);
      }
      return (
        <span
          data-mark={tone}
          className="grid size-[18px] shrink-0 place-items-center border border-hair-strong font-mono text-[11px] font-semibold text-faint"
        >
          {number}
        </span>
      );
    }
  }
}

/**
 * A `nobody` action: what the map rests on, in a line with its mark, then the way on. It has no
 * band, as nothing here waits on anyone; a blocker lists why and links where to fix it.
 */
function QuietCard({
  mapId,
  next,
  detail,
  tone,
  children,
}: {
  mapId: string;
  next: NextAction;
  detail: MapOverviewDetail;
  tone: NextActionTone;
  children: ReactNode | undefined;
}) {
  const viewing = useViewedStage();
  const here = viewing === next.stage;
  const open = here ? null : (
    <OpenStage mapId={mapId} next={next} detail={detail} variant="outline">
      Open {stageName(next.stage)} <ArrowRight />
    </OpenStage>
  );
  if (tone === "blocker" || tone === "waiting") {
    return (
      <BlockerCard
        project={detail.project}
        blockers={detail.project.startDeliveryBlockers}
        label="Next"
        headline={next.headline}
        who={next.who}
        tone={tone}
      >
        {children === undefined ? open : children}
      </BlockerCard>
    );
  }
  return (
    <RestingCard
      label="Next"
      who={next.who}
      tone={tone}
      mark={<QuietMark tone={tone} stage={next.stage} />}
      headline={next.headline}
      body={
        next.detail !== null && (
          <>
            {" "}
            <span className="text-muted-foreground">{next.detail}</span>
          </>
        )
      }
      actions={
        children !== undefined
          ? children
          : open !== null && <div className="flex flex-wrap items-center gap-3">{open}</div>
      }
    />
  );
}

/**
 * One thing the map is waiting for. A stage page passes its own action as `children` to carry it
 * out in place; without one the card offers the standard actions its tone calls for (see the
 * module's comment). A card about one of several specs names it and opens that spec (D11).
 */
export function NextActionCard({
  mapId,
  next,
  children,
}: {
  mapId: string;
  next: NextAction;
  children?: ReactNode;
}) {
  // The map's overview, as its workspace has loaded it: the specs a card names, the stage tones
  // a quiet card is marked by, and the project's start blockers.
  const overview = useMapOverview(mapId);
  if (overview.data === undefined) {
    throw new Error(`A next action card of map ${mapId} renders before the map's overview`);
  }
  const detail = overview.data;
  const tone = nextActionTone(next, detail);
  if (next.who === "nobody") {
    return (
      <QuietCard mapId={mapId} next={next} detail={detail} tone={tone}>
        {children}
      </QuietCard>
    );
  }
  const you = next.who === "you";
  // The button is the action's own, as core labels it (S7b-16); only the person's actions have one.
  const label = next.label;
  if (you !== (label !== null)) {
    throw new Error(`A ${next.who} action of map ${mapId} has the button label ${String(label)}`);
  }
  const specs = detail.specs;
  // A wait's spec (one the map has not written) is resolved against its waits (tickets review B6).
  const about = actionSpec(next, specs, detail.waits);
  const elsewhere = next.who === "another-map";
  const named = about !== undefined && (about.kind === "wait" || specs.length > 1);
  return (
    <Card asChild>
      <section
        aria-label="Next"
        data-who={next.who}
        data-tone={tone}
        className={cn(you ? "border-ink-line" : "border-hair-strong")}
      >
        <div
          className={cn(
            "flex items-center gap-2.5 px-[18px] py-[9px]",
            you
              ? "bg-primary-fill text-primary-fill-foreground"
              : elsewhere
                ? "bg-secondary text-muted-foreground"
                : "bg-work-soft text-work",
          )}
        >
          <span
            className={cn(
              "micro font-bold",
              you
                ? "text-primary-fill-foreground"
                : elsewhere
                  ? "text-muted-foreground"
                  : "text-work",
            )}
          >
            {BAND_LABEL[you ? "your-turn" : elsewhere ? "waiting" : "agent-working"]}
          </span>
          <span className="flex-1" />
          <span className="truncate text-xs opacity-85">
            {stageName(next.stage)}
            {named && ` · ${about.title}`}
          </span>
        </div>
        <div className="grid gap-3 p-[18px]">
          <div>
            <h2 className="font-display text-base leading-snug font-semibold tracking-[-0.015em]">
              {next.headline}
            </h2>
            {next.detail !== null && (
              <p
                className="mt-1 text-[13.5px] text-muted-foreground"
                data-code={next.stopped === null ? undefined : next.stopped.code}
              >
                {next.detail}
              </p>
            )}
          </div>
          {children === undefined ? (
            next.stopped !== null ? (
              <TryAgainButton runId={next.stopped.runId} />
            ) : next.waiting !== null ? (
              <WaitingActions mapId={mapId} waiting={next.waiting} />
            ) : elsewhere ? (
              <OpenThatMap next={next} />
            ) : you ? (
              <div className="flex flex-wrap items-center gap-3">
                <OpenStage mapId={mapId} next={next} detail={detail} variant="default">
                  {label} <ArrowRight />
                </OpenStage>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-work">
                <span className="pulse-soft size-1.5 bg-work-dot" /> Nothing needs you here until it
                finishes.
              </div>
            )
          ) : (
            children
          )}
        </div>
      </section>
    </Card>
  );
}
