import { Link } from "@tanstack/react-router";
import type { MapSpec, SpecRevisionState, SpecRevisionView } from "@zenorm/contracts";
import type { ReactNode } from "react";

import { Micro } from "@/components/parts";
import { SpecStageLink } from "@/components/SpecStageLink";
import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoment } from "@/lib/map";
import { cn } from "@/lib/utils";

/**
 * A revision's state badge: draft or approved, and rejected. A superseded revision keeps the draft
 * badge.
 */
const stateBadge: Record<
  SpecRevisionState,
  { variant: "secondary" | "ok" | "bad"; label: string }
> = {
  draft: { variant: "secondary", label: "draft" },
  approved: { variant: "ok", label: "approved" },
  rejected: { variant: "bad", label: "rejected" },
  superseded: { variant: "secondary", label: "draft" },
};

/** A revision's planning review, as a badge. */
export function ReviewBadge({ review }: { review: SpecRevisionView["review"] }) {
  switch (review.state) {
    case "pending":
    case "running":
      return <Badge variant="work">review running</Badge>;
    case "stopped":
      return <Badge variant="bad">review stopped</Badge>;
    case "passed":
      return <Badge variant="ok">review passed</Badge>;
    case "findings":
      return (
        <Badge variant="bad">
          {review.findings.length} finding{review.findings.length === 1 ? "" : "s"}
        </Badge>
      );
  }
}

/**
 * **Revisions · planning review**: every revision of the spec, newest first, on whichever map,
 * with its state ("delivered" once a merged run delivered it), its review, the map that wrote it
 * and each finding's title. Each opens by `?revision=`. A full-width row of the page under its
 * head, one line per revision.
 */
export function DraftHistory({
  mapId,
  specs,
  spec,
  viewing,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  spec: MapSpec;
  viewing: number;
}) {
  const rows = [...spec.revisions].reverse();
  return (
    <Card asChild>
      <nav aria-label="Revisions" className="grid grid-cols-[minmax(0,1fr)]">
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
          <Micro>Revisions · {rows.length}</Micro>
          <span className="flex-1" />
          {rows.length > 1 && (
            <span className="hidden text-[11.5px] text-faint sm:block">
              Each revises the one before, on whichever map
            </span>
          )}
        </div>
        <ol className="grid grid-cols-[minmax(0,1fr)]">
          {rows.map((entry) => {
            // An approved revision whose set a merged run delivered reads "delivered".
            const badge =
              entry.state === "approved" && entry.deliveredRun !== null
                ? { variant: "ok" as const, label: "delivered" }
                : stateBadge[entry.state];
            const current = entry.revision === viewing;
            const notes =
              (entry.review.state === "findings" && entry.review.findings.length > 0) ||
              entry.rejectionReason !== null;
            return (
              <li
                key={entry.revision}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)] border-t border-border first:border-t-0",
                  current && rows.length > 1 && "bg-secondary",
                )}
              >
                {entry.mapId === mapId ? (
                  <SpecStageLink
                    mapId={mapId}
                    specs={specs}
                    stage="spec"
                    specNumber={spec.number}
                    search={{ revision: entry.revision }}
                    aria-label={`Revision ${String(entry.revision)}`}
                    aria-current={current ? "page" : undefined}
                    className="px-3.5 py-2 hover:bg-secondary"
                  >
                    <RevisionLine entry={entry} badge={badge}>
                      this map · {formatMoment(entry.savedAt)}
                    </RevisionLine>
                  </SpecStageLink>
                ) : (
                  <div className="px-3.5 py-2">
                    <RevisionLine entry={entry} badge={badge}>
                      <Link
                        to="/maps/$mapId/$stage/$specNumber"
                        params={{ mapId: entry.mapId, stage: "spec", specNumber: spec.number }}
                        className="hover:text-primary hover:underline"
                      >
                        from “{entry.mapTitle}”
                      </Link>{" "}
                      · {formatMoment(entry.savedAt)}
                    </RevisionLine>
                  </div>
                )}
                {notes && (
                  <div className="grid gap-0.5 px-3.5 pb-2 pl-[52px] text-[12.5px] text-muted-foreground">
                    {entry.review.state === "findings" &&
                      entry.review.findings.map((finding, index) => (
                        <p key={index} className="flex gap-1.5">
                          <span aria-hidden className="text-faint">
                            –
                          </span>
                          <span>
                            <AgentText text={finding.title} />
                          </span>
                        </p>
                      ))}
                    {entry.rejectionReason !== null && (
                      <ClampedText as="p" lines={3} className="whitespace-pre-wrap">
                        <span className="text-bad">Rejected: </span>
                        {entry.rejectionReason}
                      </ClampedText>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </Card>
  );
}

/** A revision's line: its number, state and review, then where and when it was saved. */
function RevisionLine({
  entry,
  badge,
  children,
}: {
  entry: SpecRevisionView;
  badge: { variant: "secondary" | "ok" | "bad"; label: string };
  children: ReactNode;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
      <span className="w-6 font-mono text-[11px] font-semibold">r{entry.revision}</span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      <ReviewBadge review={entry.review} />
      <span className="text-[12.5px] text-muted-foreground">{children}</span>
    </span>
  );
}
