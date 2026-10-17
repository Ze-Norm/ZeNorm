import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  MapOverviewDetail,
  MapSpec,
  RunTicket,
  SpecRevisionView,
  SpecRun,
  TicketContent,
} from "@zenorm/contracts";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { PageHead, SectionHead } from "@/components/parts";
import { SpecStageLink } from "@/components/SpecStageLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspaceColumns, WorkspacePage } from "@/components/WorkspaceColumns";
import {
  lineClock,
  midSentence,
  revisionOf,
  runTicketOf,
  runTicketSet,
  shownRun,
  shownTicketStatus,
  type ShownTicketStatus,
  ticketLines,
} from "@/lib/delivery";
import { runsOn, shownSpec } from "@/lib/specs";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc";
import { FindingCard } from "@/pages/stages/delivery/FindingCard";
import { RunActivity } from "@/pages/stages/delivery/RunActivity";
import { MapAside } from "@/components/PluginSlot";
import { actorLabel, StatusBadge, StatusLine } from "@/pages/stages/delivery/ticket-status";
import { plural } from "@/pages/stages/delivery/words";
import { shownQueryError } from "@/lib/query-errors";

/** A ticket of the run's pinned set, by id. */
function pinnedTicket(tickets: readonly TicketContent[], id: string): TicketContent {
  const ticket = tickets.find((entry) => entry.id === id);
  if (ticket === undefined) {
    throw new Error(`The run's ticket set has no ticket ${id}`);
  }
  return ticket;
}

/**
 * The ticket's result (the demo's `execution-result`): its status line from `map.overview`, and a
 * merged ticket's commit on the run branch.
 */
function Result({
  row,
  status,
  executor,
}: {
  row: RunTicket;
  status: ShownTicketStatus;
  executor: string;
}) {
  const live = status.state === "implementing";
  return (
    <section
      aria-label="Result"
      className={cn(
        "border bg-card px-[18px] py-3.5 text-[13.5px]",
        row.failing.length > 0 ? "border-bad-dot" : live ? "border-work-dot" : "border-hair-strong",
      )}
    >
      <StatusLine status={status} executor={executor} />
      {row.status.state === "merged" && (
        <span className="text-muted-foreground">
          {row.status.summary === null ? "" : " "}
          Commit <code className="font-mono text-[11.5px]">{row.status.commit.slice(0, 7)}</code> on
          the run branch.
        </span>
      )}
    </section>
  );
}

/** How many of the implementer's latest lines show before "Show the earlier lines". */
const SHOWN_LINES = 40;

/**
 * "What the implementer did": the run's lines tied to this ticket, from `delivery.activity` (D10,
 * S8-14), oldest first; the latest line reads as live while the ticket is being implemented. A
 * long record shows its last 40 lines, the earlier ones behind one button at the top, so the
 * result and the criteria under it stay within reach (UX review P2-14). When one actor wrote
 * every line, the head names it once and the rows drop the actor column; a code span (a path, a
 * pattern) breaks anywhere rather than run past its cell (UX audit D2, D3).
 */
function ImplementerLines({
  run,
  ticket,
  status,
}: {
  run: SpecRun;
  ticket: string;
  status: ShownTicketStatus;
}) {
  const activity = useQuery(
    orpc.delivery.activity.queryOptions({
      input: { runId: run.id },
    }),
  );
  const [all, setAll] = useState(false);
  // The button goes when the earlier lines show; focus moves onto the list rather than nowhere.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (all) {
      list.current?.focus();
    }
  }, [all]);
  // A fetch failure keeps the cached lines; the live Alert says why (QA-3).
  const activityError = shownQueryError(activity.error);
  if (activityError !== null) {
    throw activityError;
  }
  const lines = activity.data === undefined ? undefined : ticketLines(activity.data, ticket);
  const live = status.state === "implementing";
  const actors =
    lines === undefined
      ? []
      : [...new Set(lines.map((line) => actorLabel(line.who, run.executor)))];
  const oneActor = actors.length === 1 ? actors[0] : undefined;
  const hidden = lines === undefined || all ? 0 : Math.max(0, lines.length - SHOWN_LINES);
  const shown = lines === undefined ? undefined : lines.slice(hidden);
  return (
    <section aria-label="What the implementer did" className="grid gap-2">
      <SectionHead
        title="What the implementer did"
        right={
          lines !== undefined && (
            <span className="micro text-muted-foreground">
              {oneActor !== undefined && `${oneActor} · `}
              {plural(lines.length, "line")}
            </span>
          )
        }
      />
      {shown === undefined ? null : shown.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {status.state === "merged" ? (
            // The result above already carries the summary; saying it again here read as a copy.
            "No lines were recorded for this ticket."
          ) : (
            <>
              Nothing yet. <StatusLine status={status} executor={run.executor} />
            </>
          )}
        </p>
      ) : (
        <>
          {hidden > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                setAll(true);
              }}
            >
              Show the earlier {plural(hidden, "line")}
            </Button>
          )}
          <ol
            ref={list}
            tabIndex={-1}
            className="grid border border-hair-strong bg-card outline-none"
          >
            {shown.map((line, index) => (
              <li
                key={line.seq}
                className={cn(
                  "grid gap-x-3 border-t border-border px-3.5 py-2 text-[13px] first:border-t-0 [&_code]:wrap-anywhere",
                  oneActor === undefined
                    ? "grid-cols-[72px_120px_minmax(0,1fr)]"
                    : "grid-cols-[72px_minmax(0,1fr)]",
                )}
              >
                <time dateTime={line.at} className="micro self-center text-muted-foreground">
                  {lineClock(line.at)}
                </time>
                {oneActor === undefined && (
                  <span className="text-[11.5px] font-semibold text-executor-fg">
                    {actorLabel(line.who, run.executor)}
                  </span>
                )}
                <span className={cn(live && index === shown.length - 1 && "text-work")}>
                  <AgentText text={line.text} />
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * The ticket's criteria in full under the clause each comes from, in the pinned revision's order
 * (the demo's `CriteriaList`); a criterion a blocking finding names is marked.
 */
function Criteria({
  mapId,
  specs,
  spec,
  revision,
  ticket,
  failing,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  spec: MapSpec;
  revision: SpecRevisionView;
  ticket: TicketContent;
  failing: readonly string[];
}) {
  const latest = spec.revisions.at(-1);
  const clauses = revision.content.clauses.filter((clause) =>
    clause.criteria.some((criterion) => ticket.criteria.includes(criterion.id)),
  );
  return (
    <div className="grid gap-2.5">
      {clauses.map((clause) => (
        <div key={clause.id} className="grid gap-1">
          <SpecStageLink
            mapId={mapId}
            specs={specs}
            stage="spec"
            specNumber={spec.number}
            search={latest?.revision === revision.revision ? {} : { revision: revision.revision }}
            hash={`clause-${clause.id}`}
            className="w-fit text-left text-xs text-muted-foreground hover:text-primary"
          >
            <span className="font-mono text-[11px]">{clause.id}</span> ·{" "}
            <AgentText text={clause.title} />
          </SpecStageLink>
          {clause.criteria
            .filter((criterion) => ticket.criteria.includes(criterion.id))
            .map((criterion) => {
              const bad = failing.includes(criterion.id);
              return (
                <div
                  key={criterion.id}
                  className={cn(
                    "grid grid-cols-[32px_1fr_auto] gap-2 text-[13px]",
                    bad && "text-bad",
                  )}
                >
                  <span
                    className={cn(
                      "font-mono text-[11px] leading-[1.7]",
                      bad ? "text-bad" : "text-faint",
                    )}
                  >
                    {criterion.id}
                  </span>
                  <span>
                    <AgentText text={criterion.text} />
                  </span>
                  {bad && <Badge variant="bad">fails review</Badge>}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

/**
 * A ticket's execution in a run (slice 8 D10, S18; the demo's `TicketExecution`): its status and
 * result, the review findings against it, its implementer's lines, and the contract it was held
 * to; Run activity beside it (D11). `run` is the run's number, undefined for the latest
 * (deviation 9). Statuses come only from `map.overview` and lines only from `delivery.activity`
 * (S8-14). A ticket outside the run's pinned set, or a run from before `0010`, is the route's error
 * (L100).
 */
export function TicketExecutionPage({
  detail,
  specNumber,
  ticketId,
  run,
}: {
  detail: MapOverviewDetail;
  specNumber: number;
  ticketId: string;
  run: number | undefined;
}) {
  const mapId = detail.map.id;
  const spec = shownSpec(detail, "delivery", specNumber);
  if (spec === undefined) {
    throw new Error(`This map wrote no spec ${String(specNumber)}`);
  }
  // Only this map's runs (slice 8b D9, the demo's `runsOn`): another map's run is delivered there.
  const runs = runsOn(spec, mapId);
  const shown = shownRun(runs, run);
  const row = runTicketOf(shown, ticketId);
  const status = shownTicketStatus(shown, row.status);
  const set = runTicketSet(spec, shown);
  const revision = revisionOf(spec, set);
  const ticket = pinnedTicket(set.content.tickets, ticketId);
  const isLatest = runs[0]?.id === shown.id;
  const verdict = shown.verdict;
  const findings =
    verdict === null
      ? []
      : verdict.findings.filter(
          (finding) =>
            finding.severity === "blocking" &&
            finding.criterion !== null &&
            ticket.criteria.includes(finding.criterion),
        );
  const several = detail.specs.length > 1;

  return (
    <WorkspaceColumns
      label={`Run ${String(shown.number)} activity`}
      column={
        <RunActivity
          key={shown.id}
          mapId={mapId}
          specNumber={spec.number}
          run={shown}
          aside={<MapAside projectId={detail.project.id} mapId={mapId} stage="delivery" />}
        />
      }
    >
      <WorkspacePage
        head={
          <>
            <div>
              <Button variant="ghost" size="sm" className="-ml-2.5" asChild>
                <SpecStageLink
                  mapId={mapId}
                  specs={detail.specs}
                  stage="delivery"
                  specNumber={spec.number}
                  search={isLatest ? {} : { run: shown.number }}
                >
                  <ArrowLeft /> Run {shown.number}
                </SpecStageLink>
              </Button>
            </div>
            {/* The status badge sits at the head's right, beside the eyebrow (UX audit D3). */}
            <PageHead
              eyebrow={`Delivery · run ${String(shown.number)} · ${ticket.id}${several ? ` · ${spec.title}` : ""}`}
              title={<AgentText text={ticket.title} />}
              lede={`${String(ticket.criteria.length)} acceptance ${ticket.criteria.length === 1 ? "criterion" : "criteria"} from spec r${String(revision.revision)}${ticket.blockedBy.length > 0 ? ` · built on ${ticket.blockedBy.map((blocker) => blocker.ticket).join(", ")}` : ""}`}
              right={<StatusBadge status={status} failing={row.failing} />}
            />
          </>
        }
      >
        <Result row={row} status={status} executor={shown.executor} />

        {/* The ticket's build runs to paragraphs on a real ticket: six lines, the rest on Show more. */}
        <section aria-label="What to build" className="grid gap-2">
          <SectionHead title="What to build" />
          <ClampedText as="p" lines={6} className="max-w-[78ch] text-[13.5px] leading-relaxed">
            <AgentText text={ticket.build} />
          </ClampedText>
        </section>

        {verdict !== null && findings.length > 0 && (
          <section aria-label="What the independent review found" className="grid gap-2">
            <SectionHead title="What the independent review found" />
            {findings.map((finding, index) => (
              <FindingCard
                key={index}
                mapId={mapId}
                specs={detail.specs}
                spec={spec}
                revision={revision}
                tickets={set.content.tickets}
                verdict={verdict}
                finding={finding}
              />
            ))}
          </section>
        )}

        <ImplementerLines run={shown} ticket={row.ticket} status={status} />

        <section aria-label="Acceptance criteria" className="grid gap-2">
          <SectionHead
            title="Acceptance criteria"
            right={
              <span className="micro text-muted-foreground">from spec r{revision.revision}</span>
            }
          />
          <Criteria
            mapId={mapId}
            specs={detail.specs}
            spec={spec}
            revision={revision}
            ticket={ticket}
            failing={row.failing}
          />
        </section>

        <section aria-label="Testing and completion" className="grid gap-2">
          <SectionHead title="Testing and completion" />
          <ul className="grid gap-1 text-[13px]">
            {ticket.testing.map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-faint">·</span>
                <span>
                  <AgentText text={line} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        {ticket.blockedBy.length > 0 && (
          <section aria-label="Built on" className="grid gap-2">
            <SectionHead title="Built on" />
            <ul className="grid gap-1 text-[13px]">
              {ticket.blockedBy.map((blocker) => (
                <li key={blocker.ticket} className="flex gap-2">
                  <Link
                    to="/maps/$mapId/delivery/$specNumber/$ticketId"
                    params={{ mapId, specNumber: spec.number, ticketId: blocker.ticket }}
                    search={{ run: shown.number }}
                    className="font-mono text-[11.5px] text-primary hover:underline"
                  >
                    {blocker.ticket}
                  </Link>
                  <span className="text-muted-foreground">
                    supplies <AgentText text={midSentence(blocker.supplies)} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Out of this ticket's scope" className="grid gap-2">
          <SectionHead title="Out of this ticket's scope" />
          <ul className="grid gap-1 text-[13px] text-muted-foreground">
            {ticket.outOfScope.map((line) => (
              <li key={line}>
                <AgentText text={line} />
              </li>
            ))}
          </ul>
        </section>
      </WorkspacePage>
    </WorkspaceColumns>
  );
}
