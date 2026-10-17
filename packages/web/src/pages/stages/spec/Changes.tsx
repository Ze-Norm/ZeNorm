import { Link } from "@tanstack/react-router";
import type {
  ClauseChange,
  CriterionChange,
  MapSpec,
  RevisedLater as RevisedLaterView,
  SpecRevisionContent,
  TextDelta,
  WayfindingWaypoint,
} from "@zenorm/contracts";
import { ArrowRight, Check } from "lucide-react";
import { Fragment } from "react";

import { AgentText } from "@/components/AgentText";
import { Micro, SectionHead } from "@/components/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { changeTally, clauseChange, clauseChangeLine, revisionBefore } from "@/lib/specs";
import { cn } from "@/lib/utils";
import { scrollToSection } from "@/pages/stages/planning/StageParts";

/** A clause's or criterion's change as a badge; none when unchanged. */
export function ChangeBadge({ change }: { change: ClauseChange | CriterionChange | "removed" }) {
  switch (change) {
    case "unchanged":
      return null;
    case "new":
      return <Badge variant="soft">new</Badge>;
    case "changed":
      return <Badge variant="work">changed</Badge>;
    case "moved":
      return <Badge variant="secondary">moved</Badge>;
    case "removed":
      return <Badge variant="bad">removed</Badge>;
  }
}

/** The map's waypoints that name the spec among their touches, with the criteria named. */
export function touchesOf(
  waypoints: readonly WayfindingWaypoint[],
  specNumber: number,
): { waypoint: WayfindingWaypoint; criteria: string[] }[] {
  return waypoints.flatMap((waypoint) =>
    waypoint.touches
      .filter((touch) => touch.specNumber === specNumber)
      .map((touch) => ({ waypoint, criteria: touch.criteria.map((criterion) => criterion.id) })),
  );
}

/**
 * On a spec a later map revised: where that revision is, and how far it has got, from that map's
 * first next action's headline as core derives it.
 */
export function RevisedLater({ spec, later }: { spec: MapSpec; later: RevisedLaterView }) {
  return (
    <Card asChild>
      <section
        aria-label="A later map revises this spec"
        className="flex flex-row items-center gap-3 px-[18px] py-3 text-sm"
      >
        <div className="flex-1">
          <span className="font-semibold">A later map revises this spec.</span>{" "}
          <span className="text-muted-foreground">
            “{later.mapTitle}” wrote r{later.revision}. Next: {later.headline[0]?.toLowerCase()}
            {later.headline.slice(1)}
          </span>
        </div>
        <Link
          to="/maps/$mapId/$stage/$specNumber"
          params={{ mapId: later.mapId, stage: "spec", specNumber: spec.number }}
          className="flex items-center gap-1 text-[13px] text-primary hover:underline"
        >
          Open r{later.revision} <ArrowRight className="size-3.5" />
        </Link>
      </section>
    </Card>
  );
}

/** A delta panel row: a shadcn ghost `Button` laid out as a full-width grid row. */
const rowClass =
  "grid h-auto w-full grid-cols-[36px_minmax(0,1fr)_auto] items-baseline justify-items-start gap-2 border-t border-border px-4 py-2 text-left text-[13.5px] font-normal whitespace-normal text-foreground has-[>svg]:px-4";

/**
 * The text delta: where the revision before came from and whether it was delivered, which decisions
 * on this map touch the spec, then each changed, new or removed behaviour with its criteria in a
 * line, the clauses kept word for word, and Out of scope added and dropped. The code's side is the
 * Tickets page's: it never counts tickets.
 */
export function ChangesPanel({
  mapId,
  spec,
  content,
  delta,
  waypoints,
}: {
  mapId: string;
  spec: MapSpec;
  /** The revision's content. */
  content: SpecRevisionContent;
  delta: TextDelta;
  waypoints: readonly WayfindingWaypoint[];
}) {
  const before = revisionBefore(spec, delta);
  const run = before.deliveredRun;
  const touches = touchesOf(waypoints, spec.number);
  const touched = content.clauses.filter(
    (clause) => clauseChange(delta, clause.id) !== "unchanged",
  );
  const unchanged = content.clauses.filter(
    (clause) => clauseChange(delta, clause.id) === "unchanged",
  );
  const outOfScope = [
    delta.outOfScopeAdded.length > 0 && `${String(delta.outOfScopeAdded.length)} added`,
    delta.outOfScopeDropped.length > 0 &&
      `${String(delta.outOfScopeDropped.length)} no longer excluded`,
  ].filter((part) => part !== false);

  return (
    <section aria-label="What the revision changes" className="grid gap-2">
      <SectionHead
        title={`What revision ${String(delta.after)} changes from revision ${String(delta.before)}`}
        right={<Micro>criteria · {changeTally(delta)}</Micro>}
      />
      <Card className="grid gap-0">
        <p className="px-4 py-3 text-[13.5px] text-muted-foreground">
          r{delta.before} came from{" "}
          {before.mapId === mapId ? (
            "this map"
          ) : (
            <Link
              to="/maps/$mapId/$stage/$specNumber"
              params={{ mapId: before.mapId, stage: "spec", specNumber: spec.number }}
              className="text-foreground hover:text-primary hover:underline"
            >
              “{before.mapTitle}”
            </Link>
          )}
          {run === null ? (
            " and was never delivered."
          ) : (
            <>
              {" "}
              and was delivered in run {run.number}, merged as{" "}
              <span className="font-mono text-[12px]">{run.commit.slice(0, 7)}</span>.
            </>
          )}{" "}
          This is the change in the text. What the code needs is worked out when r{delta.after} is
          approved, criterion by criterion, on the Tickets page: a criterion whose wording didn't
          move can still need work.
        </p>
        {touches.length > 0 && (
          <p className="border-t border-border px-4 py-2 text-[13px] text-muted-foreground">
            From this map's decisions:{" "}
            {touches.map(({ waypoint, criteria }, index) => (
              <Fragment key={waypoint.number}>
                {index > 0 && "; "}
                <Link
                  to="/maps/$mapId/wayfinding/$number"
                  params={{ mapId, number: waypoint.number }}
                  className="text-foreground hover:text-primary hover:underline"
                >
                  <AgentText text={waypoint.title} />
                </Link>{" "}
                (touches {criteria.join(", ")})
              </Fragment>
            ))}
            .
          </p>
        )}
        {touched.map((clause) => {
          const change = clauseChange(delta, clause.id);
          // Empty when only the clause's own wording changed.
          const line = clauseChangeLine(clause, delta);
          return (
            <Button
              key={clause.id}
              type="button"
              variant="ghost"
              onClick={() => {
                scrollToSection(`clause-${clause.id}`);
              }}
              className={rowClass}
            >
              <span className="font-mono text-[11px] text-faint">{clause.id}</span>
              <span>
                <AgentText text={clause.title} />
                {change === "changed" && (
                  <span className="text-muted-foreground"> · {line === "" ? "wording" : line}</span>
                )}
              </span>
              <ChangeBadge change={change} />
            </Button>
          );
        })}
        {delta.removedClauses.map((clause) => (
          <Button
            key={clause.id}
            type="button"
            variant="ghost"
            onClick={() => {
              scrollToSection("spec-removed");
            }}
            className={cn(rowClass, "text-muted-foreground")}
          >
            <span className="font-mono text-[11px] text-faint">{clause.id}</span>
            <span className="line-through">
              <AgentText text={clause.title} />
            </span>
            <ChangeBadge change="removed" />
          </Button>
        ))}
        {unchanged.length > 0 && (
          // The clauses kept as they were, one chip each that opens the clause.
          <div className="grid gap-1.5 border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
            <p className="flex items-center gap-1.5">
              <Check className="size-3.5 text-ok" aria-hidden />
              Word for word as in r{delta.before} · {unchanged.length}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {unchanged.map((clause) => (
                <li key={clause.id}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      scrollToSection(`clause-${clause.id}`);
                    }}
                    className="h-auto max-w-full gap-1.5 px-2 py-1 text-left text-[12.5px] font-normal whitespace-normal text-muted-foreground hover:text-foreground"
                  >
                    <span className="font-mono text-[11px] text-faint">{clause.id}</span>
                    <span className="min-w-0">
                      <AgentText text={clause.title} />
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {outOfScope.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              scrollToSection("spec-out");
            }}
            className="h-auto w-full justify-start border-t border-border px-4 py-2 text-left text-[13px] font-normal whitespace-normal"
          >
            Out of scope: {outOfScope.join(" · ")}
          </Button>
        )}
      </Card>
    </section>
  );
}

/** "Removed in this revision": each clause the revision drops, struck through. */
export function RemovedClauses({ delta }: { delta: TextDelta }) {
  if (delta.removedClauses.length === 0) {
    return null;
  }
  return (
    <section id="spec-removed" className="grid scroll-mt-4 gap-3">
      <SectionHead
        title="Removed in this revision"
        right={<Micro>{delta.removedClauses.length}</Micro>}
      />
      {delta.removedClauses.map((clause) => (
        <div
          key={clause.id}
          className="grid gap-1 border border-dashed border-hair-strong p-4 text-muted-foreground"
        >
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-[11px]">{clause.id}</span>
            <h3 className="flex-1 font-display text-[17px] leading-tight font-bold tracking-[-0.02em] line-through">
              <AgentText text={clause.title} />
            </h3>
            <ChangeBadge change="removed" />
          </div>
          <p className="text-[14px] line-through">
            <AgentText text={clause.text} />
          </p>
        </div>
      ))}
    </section>
  );
}
