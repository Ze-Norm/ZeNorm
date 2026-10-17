import { Link } from "@tanstack/react-router";
import type {
  MapOverviewDetail,
  ResearchSourceKind,
  WaitingRun,
  WayfindingWaypoint,
  WaypointReport,
  WaypointTaskOutcome,
} from "@zenorm/contracts";

import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { Micro, SectionHead } from "@/components/parts";
import { SpecStageLink } from "@/components/SpecStageLink";
import { TryAgainButton } from "@/components/TryAgainButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";

import { at, Folded } from "./shared.tsx";
import { waypointByNumber } from "./waits.ts";

/** The last element of a list the caller knows is not empty. */
function latest<T>(items: readonly T[], what: string): T {
  return at(items, items.length - 1, what);
}

const sourceKindNames: Record<ResearchSourceKind, string> = {
  map: "the map",
  waypoint: "a waypoint",
  specification: "a specification",
  repository_file: "a repository file",
  external: "the web",
};

/**
 * A waiting waypoint's box: "Research could not answer." with the gap, or "Task failed." with
 * what was done and what stopped it, in the needs-you tone (a saved outcome waiting on the person,
 * not a failure); then the line saying the agent waits, and **Try again** on the waiting run.
 */
export function WaitingBox({
  waypoint,
  waiting,
}: {
  waypoint: WayfindingWaypoint;
  waiting: WaitingRun;
}) {
  return (
    <section aria-label="Waiting on you" className="grid gap-3">
      {waiting.reason === "research_unanswered" ? (
        <UnansweredAlert report={latestReport(waypoint, waiting)} />
      ) : (
        <FailedTaskAlert outcome={latestOutcome(waypoint, waiting)} />
      )}
      <p className="text-[13px] text-muted-foreground">
        The agent does not take this waypoint again by itself.
      </p>
      <TryAgainButton runId={waiting.runId} />
    </section>
  );
}

function latestReport(waypoint: WayfindingWaypoint, waiting: WaitingRun): WaypointReport {
  const report = latest(waypoint.reports, "research report");
  if (report.runId !== waiting.runId || report.gap === null) {
    throw new Error(`Waypoint ${waypoint.id}'s waiting run has no unanswered report`);
  }
  return report;
}

function latestOutcome(waypoint: WayfindingWaypoint, waiting: WaitingRun): WaypointTaskOutcome {
  const outcome = latest(waypoint.taskOutcomes, "task outcome");
  if (outcome.runId !== waiting.runId || outcome.outcome !== "failed") {
    throw new Error(`Waypoint ${waypoint.id}'s waiting run has no failed task outcome`);
  }
  return outcome;
}

function UnansweredAlert({ report }: { report: WaypointReport }) {
  return (
    <Alert variant="you">
      <AlertTitle>Research could not answer.</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap">{report.gap}</AlertDescription>
    </Alert>
  );
}

function FailedTaskAlert({ outcome }: { outcome: WaypointTaskOutcome }) {
  return (
    <Alert variant="you">
      <AlertTitle>Task failed.</AlertTitle>
      <AlertDescription className="grid gap-1.5">
        <p className="whitespace-pre-wrap">{outcome.action}</p>
        <p className="whitespace-pre-wrap">{outcome.facts}</p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A Research waypoint's reports: the latest under **Report**, the summary of an
 * unresolved one first (a resolved one's is the Findings box), then "Earlier reports" oldest first.
 */
export function ResearchReports({ waypoint }: { waypoint: WayfindingWaypoint }) {
  if (waypoint.reports.length === 0) {
    return null;
  }
  const report = latest(waypoint.reports, "research report");
  const earlier = waypoint.reports.slice(0, -1);
  const resolved = waypoint.status === "resolved";
  const sections =
    report.findings.length +
    report.sources.length +
    report.limitations.length +
    report.uncertainties.length;
  return (
    <>
      {(!resolved || sections > 0) && (
        <section aria-label="Report" className="grid gap-3">
          <SectionHead title="Report" />
          {!resolved && <p className="text-[14px] whitespace-pre-wrap">{report.summary}</p>}
          <ReportSections report={report} />
        </section>
      )}
      {earlier.length > 0 && (
        <section aria-label="Earlier reports" className="grid gap-3">
          <SectionHead title="Earlier reports" />
          {earlier.map((previous) => (
            <Card key={previous.runId} className="grid gap-3 px-3.5 py-3">
              <Micro>{previous.answered ? "Answered" : "Could not answer"}</Micro>
              <p className="text-[13.5px] whitespace-pre-wrap">{previous.summary}</p>
              {previous.gap !== null && (
                <p className="text-[13px] whitespace-pre-wrap text-bad">{previous.gap}</p>
              )}
              <ReportSections report={previous} />
            </Card>
          ))}
        </section>
      )}
    </>
  );
}

/** A report's findings with their sources, Sources, Limitations, Uncertainties; each hidden when empty. */
function ReportSections({ report }: { report: WaypointReport }) {
  return (
    <>
      {report.findings.length > 0 && (
        <Card className="grid">
          {report.findings.map((finding, index) => (
            <div
              key={index}
              className="grid gap-1 border-t border-border px-3.5 py-3 first:border-t-0"
            >
              <span className="text-[14px] font-semibold">{finding.title}</span>
              <p className="text-[13.5px] whitespace-pre-wrap">{finding.detail}</p>
              {finding.sources.length > 0 && (
                <p className="text-[12px] text-faint">
                  Sources:{" "}
                  {finding.sources
                    .map((position) => at(report.sources, position - 1, "research source").title)
                    .join(" · ")}
                </p>
              )}
            </div>
          ))}
        </Card>
      )}
      {report.sources.length > 0 && (
        <section aria-label="Sources" className="grid gap-1.5">
          <Micro>Sources</Micro>
          {report.sources.map((source, index) => (
            <div key={index} className="grid gap-0.5 text-[13px]">
              {source.url === null ? (
                <span className="font-semibold">{source.title}</span>
              ) : (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-primary hover:underline"
                >
                  {source.title}
                </a>
              )}
              <span className="text-[12px] text-faint">From {sourceKindNames[source.kind]}</span>
              <ClampedText
                as="p"
                lines={4}
                className="border-l-2 border-hair-strong pl-2.5 whitespace-pre-wrap text-muted-foreground"
              >
                {source.excerpt}
              </ClampedText>
            </div>
          ))}
        </section>
      )}
      <NoteList title="Limitations" notes={report.limitations} />
      <NoteList title="Uncertainties" notes={report.uncertainties} />
    </>
  );
}

function NoteList({ title, notes }: { title: string; notes: readonly string[] }) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <section aria-label={title} className="grid gap-1">
      <Micro>{title}</Micro>
      <ul className="grid list-disc gap-0.5 pl-5 text-[13.5px]">
        {notes.map((note, index) => (
          <li key={index}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

/** A resolved Task waypoint's "What was done": its `done` outcome's action. */
export function WhatWasDone({ waypoint }: { waypoint: WayfindingWaypoint }) {
  const outcome = latest(waypoint.taskOutcomes, "task outcome");
  if (outcome.outcome !== "done") {
    throw new Error(`Resolved task waypoint ${waypoint.id}'s latest outcome is not done`);
  }
  return (
    <section aria-label="What was done" className="grid gap-1">
      <Micro>What was done</Micro>
      <p className="text-[14px] whitespace-pre-wrap">{outcome.action}</p>
    </section>
  );
}

/** A waypoint ruled out of scope: its reason under "Out of scope". */
export function ExclusionReason({ waypoint }: { waypoint: WayfindingWaypoint }) {
  if (waypoint.exclusion === null) {
    throw new Error(`Out-of-scope waypoint ${waypoint.id} has no Out of scope line`);
  }
  return (
    <section aria-label="Out of scope" className="grid gap-1">
      <Micro>Out of scope</Micro>
      <p className="text-[14px] whitespace-pre-wrap text-muted-foreground">{waypoint.exclusion}</p>
    </section>
  );
}

/**
 * A waypoint opened by the consistency pass: the waypoints it names, with the explanation folded
 * under Evidence; or one a planning review sent on, in the same style: the spec with the clauses
 * and criteria named, the explanation folded under Evidence.
 */
export function PassFinding({
  detail,
  waypoint,
}: {
  detail: MapOverviewDetail;
  waypoint: WayfindingWaypoint;
}) {
  const { finding, reviewFinding } = waypoint;
  if (reviewFinding !== null) {
    return (
      <Card asChild className="grid gap-2 px-3.5 py-3">
        <section aria-label="Raised by the planning review">
          <Micro>Raised by the planning review</Micro>
          <p className="text-[13.5px]">
            <SpecStageLink
              mapId={detail.map.id}
              specs={detail.specs}
              stage="spec"
              specNumber={reviewFinding.spec}
              search={{}}
              className="text-foreground hover:text-primary hover:underline"
            >
              Spec {reviewFinding.spec} · <AgentText text={reviewFinding.specTitle} />
            </SpecStageLink>
            {reviewFinding.elementIds.length > 0 && ` · ${reviewFinding.elementIds.join(", ")}`}
          </p>
          <Folded label="Evidence">
            <p className="text-[13px] text-muted-foreground">
              <AgentText text={reviewFinding.explanation} />
            </p>
          </Folded>
        </section>
      </Card>
    );
  }
  if (finding === null) {
    return null;
  }
  const named = finding.waypointNumbers.map((number) => waypointByNumber(detail, number));
  return (
    <Card asChild className="grid gap-2 px-3.5 py-3">
      <section aria-label="Raised by the consistency pass">
        <Micro>Raised by the consistency pass</Micro>
        <div className="grid gap-0.5 text-[13.5px]">
          {named.map((other) => (
            <Link
              key={other.id}
              to="/maps/$mapId/wayfinding/$number"
              params={{ mapId: detail.map.id, number: other.number }}
              className="text-primary hover:underline"
            >
              {other.title}
            </Link>
          ))}
        </div>
        <Folded label="Evidence">
          <p className="text-[13px] whitespace-pre-wrap text-muted-foreground">
            {finding.explanation}
          </p>
        </Folded>
      </section>
    </Card>
  );
}
