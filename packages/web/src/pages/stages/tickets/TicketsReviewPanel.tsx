import type { TicketSetView, TicketsReviewFindingKind } from "@zenorm/contracts";

import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { Micro } from "@/components/parts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoment } from "@/lib/map";
import { ticketsReviewPanel } from "@/lib/tickets";

/** A finding's kind in words, for its label. */
const KIND_LABEL: Record<TicketsReviewFindingKind, string> = {
  untraced_criterion: "untraced criterion",
  uncovered_clause: "uncovered clause",
  contradiction: "contradiction",
  unsupported_evidence: "unsupported evidence",
  disposition_without_reason: "disposition without reason",
};

/**
 * The Tickets review, as a full-width row under the next-action card: its version, its badge, when
 * it ran, then the running sentence or the review's summary (clamped past four lines), each finding
 * as a ruled entry with its kind, explanation and the tickets and criteria it names, and every
 * rejection of an earlier version with its reason, which the rewrite answered.
 */
export function TicketsReviewPanel({
  set,
}: {
  set: Pick<TicketSetView, "version" | "review" | "rejections">;
}) {
  const { review } = set;
  if (review === null) {
    throw new Error("The tickets review row renders for a set with no review");
  }
  const panel = ticketsReviewPanel(review);
  const reviewedAt =
    review.state === "passed" || review.state === "findings" ? review.reviewedAt : null;
  return (
    <Card
      id="impl-review"
      aria-label="Tickets review"
      className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)]"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-3.5 py-2">
        <Micro>Tickets review · version {set.version}</Micro>
        <Badge variant={panel.badge.tone}>{panel.badge.label}</Badge>
        <span className="flex-1" />
        {reviewedAt !== null && (
          <span className="text-[11.5px] text-faint">{formatMoment(reviewedAt)}</span>
        )}
      </div>
      {(panel.text !== null || panel.findings.length > 0 || set.rejections.length > 0) && (
        <div className="grid gap-3 px-3.5 py-3">
          {panel.text !== null && (
            <ClampedText
              as="p"
              lines={4}
              data-testid="tickets-review-summary"
              className="text-[13px] text-muted-foreground"
            >
              <AgentText text={panel.text} />
            </ClampedText>
          )}
          {panel.findings.length > 0 && (
            <ul aria-label="Findings" className="grid gap-2.5">
              {panel.findings.map((finding, index) => (
                <li
                  key={index}
                  data-kind={finding.kind}
                  data-route={finding.route}
                  className="grid gap-0.5 border-l-2 border-bad pl-2.5 text-[13px]"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-bad">
                      <AgentText text={finding.title} />
                    </span>
                    <span className="micro text-faint">
                      {KIND_LABEL[finding.kind]}
                      {finding.escalated && " · escalated"}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    <AgentText text={finding.explanation} />
                  </p>
                  {(finding.ticketNumbers.length > 0 || finding.criterionIds.length > 0) && (
                    <span className="font-mono text-[11px] text-faint">
                      {[...finding.ticketNumbers, ...finding.criterionIds].join(" · ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {set.rejections.length > 0 && (
            <ul aria-label="Rejections" className="grid gap-1.5">
              {[...set.rejections].reverse().map((rejection) => (
                <li key={rejection.version} className="text-[12.5px] text-muted-foreground">
                  <ClampedText as="p" lines={3} className="whitespace-pre-wrap">
                    <span className="text-bad">
                      You rejected version {rejection.version} ·{" "}
                      {formatMoment(rejection.rejectedAt)}:{" "}
                    </span>
                    {rejection.reason}
                  </ClampedText>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
