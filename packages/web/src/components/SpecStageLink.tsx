import { Link } from "@tanstack/react-router";
import type { MapSpec } from "@zenorm/contracts";
import type { ComponentProps, ReactNode } from "react";

import type { SpecStage } from "@/lib/specs";

/**
 * A link to one spec stage of a map: with the spec's number when the map wrote several, so the
 * switcher keeps it; the bare stage when it wrote one (D11).
 */
export function SpecStageLink({
  mapId,
  specs,
  stage,
  specNumber,
  search,
  hash,
  ...props
}: {
  mapId: string;
  specs: readonly MapSpec[];
  stage: SpecStage;
  specNumber: number;
  search: { revision?: number; version?: number; run?: number };
  /** The element the page scrolls to, by id. */
  hash?: string;
  children: ReactNode;
} & Pick<ComponentProps<"a">, "className" | "title" | "aria-label" | "aria-current">) {
  if (specs.length > 1) {
    return (
      <Link
        to="/maps/$mapId/$stage/$specNumber"
        params={{ mapId, stage, specNumber }}
        search={search}
        {...(hash === undefined ? {} : { hash })}
        {...props}
      />
    );
  }
  return (
    <Link
      to="/maps/$mapId/$stage"
      params={{ mapId, stage }}
      search={search}
      {...(hash === undefined ? {} : { hash })}
      {...props}
    />
  );
}
