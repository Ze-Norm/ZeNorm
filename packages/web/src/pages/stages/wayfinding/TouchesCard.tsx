import { Link } from "@tanstack/react-router";
import type { WaypointTouchView } from "@zenorm/contracts";
import { ArrowRight } from "lucide-react";

import { AgentText } from "@/components/AgentText";
import { Micro } from "@/components/parts";
import { Card } from "@/components/ui/card";
import { laterRevisionsLine, touchOrigin } from "./touches.ts";

/**
 * A spec this waypoint changes, named when the map was charted: the spec, opened on the map that
 * wrote the touched revision; that map and whether the revision is delivered; each touched
 * criterion's text with its clause's title; and how many revisions came after it.
 */
export function TouchesCard({ touch }: { touch: WaypointTouchView }) {
  const later = laterRevisionsLine(touch.laterRevisions);
  return (
    <Card asChild className="grid gap-2 px-3.5 py-3 text-[13px]">
      <section aria-label="Changes a delivered spec" data-spec={touch.specNumber}>
        <div className="flex flex-wrap items-center gap-2">
          <Micro className="font-bold text-ink">Changes a delivered spec</Micro>
          <span className="flex-1" />
          <Link
            to="/maps/$mapId/$stage/$specNumber"
            params={{ mapId: touch.writerMapId, stage: "spec", specNumber: touch.specNumber }}
            search={{}}
            className="text-primary hover:underline"
          >
            “<AgentText text={touch.specTitle} />” <ArrowRight className="inline size-3.5" />
          </Link>
        </div>
        <p className="text-muted-foreground">
          {touchOrigin(touch)} This waypoint's decision settles what the next revision of that spec
          says, instead of a new spec.
        </p>
        <ul className="grid gap-1">
          {touch.criteria.map((criterion) => (
            <li
              key={criterion.id}
              data-criterion={criterion.id}
              className="grid grid-cols-[36px_1fr] gap-2"
            >
              <span className="font-mono text-[11px] leading-[1.8] text-faint">{criterion.id}</span>
              <span>
                <AgentText text={criterion.text} />{" "}
                <span className="text-muted-foreground">
                  · <AgentText text={criterion.clauseTitle} />
                </span>
              </span>
            </li>
          ))}
        </ul>
        {later !== null && <p className="text-muted-foreground">{later}</p>}
      </section>
    </Card>
  );
}
