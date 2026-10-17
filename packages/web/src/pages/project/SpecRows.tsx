import { Link } from "@tanstack/react-router";
import type { ProjectSpec } from "@zenorm/contracts";

import { Micro, SectionHead } from "@/components/parts";
import { Badge } from "@/components/ui/badge";
import { formatMoment } from "@/lib/map";
import { specRowBadges } from "@/lib/tickets";

/**
 * The project's specs, from `project.get`: each spec once, with its delivery badge ("delivery run n
 * active", "delivered · run n" or "not delivered"), the latest revision when it is not the
 * delivered one, and its revision chain: each revision with its state, the map that wrote it and
 * when.
 */
export function SpecRows({ specs }: { specs: readonly ProjectSpec[] }) {
  return (
    <section aria-label="Specs" className="grid gap-3">
      <SectionHead title="Specs" right={<Micro>{specs.length}</Micro>} />
      {specs.length > 0 ? (
        <div className="grid border border-hair-strong bg-card">
          {specs.map((spec) => {
            const latest = spec.revisions.at(-1);
            if (latest === undefined) {
              throw new Error(`Spec ${String(spec.number)} has no revision`);
            }
            const badges = specRowBadges(spec);
            return (
              <div
                key={spec.number}
                data-spec={spec.number}
                className="grid gap-2 border-t border-border px-4 py-3 first:border-t-0"
              >
                <div className="flex items-center gap-2">
                  <Link
                    to="/maps/$mapId/$stage/$specNumber"
                    params={{ mapId: latest.mapId, stage: "spec", specNumber: spec.number }}
                    className="font-semibold hover:text-primary hover:underline"
                  >
                    {spec.title}
                  </Link>
                  <Badge variant={badges.delivery.tone}>{badges.delivery.label}</Badge>
                  {badges.latest !== null && <Badge variant="soft">{badges.latest}</Badge>}
                </div>
                <ol
                  aria-label={`Revisions of spec ${String(spec.number)}`}
                  className="grid gap-1 text-[12.5px] text-muted-foreground"
                >
                  {spec.revisions.map((revision) => (
                    <li
                      key={revision.revision}
                      className="grid grid-cols-[28px_72px_minmax(0,1fr)_auto] items-baseline gap-2"
                    >
                      <span className="font-mono text-[11px] font-semibold text-foreground">
                        r{revision.revision}
                      </span>
                      <span>{revision.state}</span>
                      <Link
                        to="/maps/$mapId/$stage/$specNumber"
                        params={{
                          mapId: revision.mapId,
                          stage: "spec",
                          specNumber: spec.number,
                        }}
                        className="truncate text-foreground hover:text-primary hover:underline"
                      >
                        {revision.mapTitle}
                      </Link>
                      <span className="font-mono text-[11px] text-faint">
                        {formatMoment(revision.savedAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No specs yet. The agent writes one when a map's questions are answered.
        </p>
      )}
    </section>
  );
}
