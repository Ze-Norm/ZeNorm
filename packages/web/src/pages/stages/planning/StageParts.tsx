import type { MapOverviewDetail, MapSpec } from "@zenorm/contracts";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { ClampedText } from "@/components/ClampedText";
import { NextActionCard } from "@/components/NextActionCard";
import { SpecStageLink } from "@/components/SpecStageLink";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Shown in place of the card while an earlier draft is open: what it is and the way back to the
 * latest, where the card acts.
 */
export function EarlierDraftNotice({
  mapId,
  specs,
  spec,
  label,
  rejectionReason,
}: {
  mapId: string;
  specs: readonly MapSpec[];
  spec: MapSpec;
  label: string;
  /** The person's reason when the draft was rejected, else null. */
  rejectionReason: string | null;
}) {
  return (
    <section
      aria-label="Earlier draft"
      className="flex items-start gap-3 border border-hair-strong bg-card px-[18px] py-3 text-sm"
    >
      <div className="grid flex-1 gap-1">
        <span className="font-semibold">You are reading {label}, an earlier draft.</span>
        {rejectionReason !== null && (
          <ClampedText as="p" lines={3} className="whitespace-pre-wrap text-muted-foreground">
            You rejected it: {rejectionReason}
          </ClampedText>
        )}
      </div>
      <SpecStageLink
        mapId={mapId}
        specs={specs}
        stage="spec"
        specNumber={spec.number}
        search={{}}
        className="flex shrink-0 items-center gap-1 text-[13px] text-primary hover:underline"
      >
        Open the latest <ArrowRight className="size-3.5" />
      </SpecStageLink>
    </section>
  );
}

/**
 * A stage with nothing written yet: its own card when the stage is in motion, otherwise the map's
 * first next action and a line on when the stage starts.
 */
export function NothingWrittenYet({
  detail,
  card,
  when,
}: {
  detail: MapOverviewDetail;
  card: ReactElement | null;
  when: string;
}) {
  if (card !== null) {
    return card;
  }
  const first = detail.status.next[0];
  return (
    <>
      {first !== undefined && <NextActionCard mapId={detail.map.id} next={first} />}
      <p className="text-[12.5px] text-muted-foreground">{when}</p>
    </>
  );
}

/** Scrolls the page's section `target` (an element id) into view. */
export function scrollToSection(target: string): void {
  const element = document.getElementById(target);
  if (element === null) {
    throw new Error(`No section ${target} on this page`);
  }
  element.scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * The line a section scrolls to, under the sticky chrome: the document's `scroll-padding-top`,
 * set in `index.css` beside the chrome's height.
 */
function chromeLine(): number {
  const line = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
  if (Number.isNaN(line)) {
    throw new Error("The document sets no scroll-padding-top for the sticky chrome");
  }
  return line;
}

/**
 * Which of the page's sections (element ids, in document order) the reader is at: the last one
 * whose top has reached the line a section scrolls to, the sticky chrome plus the section's own
 * `scroll-margin-top`, watched as the page scrolls, so the index can mark it (UX audit C4). A
 * section jumped to from the index lands exactly on that line, so it is marked at once; one near
 * the end that the page cannot scroll up to that line is marked once the page is at its end and
 * the section is in view, since the reader can go no further. Null until the first section is
 * reached.
 */
export function useActiveSection(targets: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = targets.join("\n");
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\n");
    const read = () => {
      const line = chromeLine();
      const atEnd =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      let current: string | null = null;
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element === null) {
          continue;
        }
        const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop);
        if (Number.isNaN(margin)) {
          throw new Error(`Section ${id} has no scroll-margin-top to measure its landing line`);
        }
        const top = element.getBoundingClientRect().top;
        if (top <= line + margin + 8 || (atEnd && top < window.innerHeight)) {
          current = id;
        }
      }
      setActive(current);
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => {
      window.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
    };
  }, [key]);
  return active;
}

/**
 * A document's index below the split (`WorkspacePage`'s `folded`): a Jump to menu in a row stuck
 * under the chrome (UX audit C4, review P2-10), its entries (`children`, the Select's items and
 * groups, each valued with a section's id) under `label`, the index's name. Opening it first
 * brings the row there, so the menu opens downward with the document under it, and a jumped-to
 * section lands under the row.
 */
export function JumpMenu({ label, children }: { label: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  function stick(): void {
    const element = row.current;
    if (element === null) {
      return;
    }
    const top = element.getBoundingClientRect().top + window.scrollY - chromeLine();
    if (window.scrollY < top) {
      window.scrollTo({ top, behavior: "instant" });
    }
  }
  function jump(target: string): void {
    const element = row.current;
    if (element === null) {
      scrollToSection(target);
      return;
    }
    const section = document.getElementById(target);
    if (section === null) {
      throw new Error(`No section ${target} on this page`);
    }
    window.scrollTo({
      top:
        section.getBoundingClientRect().top + window.scrollY - chromeLine() - element.offsetHeight,
      behavior: "smooth",
    });
  }
  return (
    <div
      ref={row}
      className="sticky top-(--workspace-chrome) z-10 -mx-1 border-b border-border bg-background px-1 py-2"
    >
      <Select
        value=""
        onOpenChange={(open) => {
          if (open) {
            stick();
          }
        }}
        onValueChange={jump}
      >
        <SelectTrigger size="sm" aria-label={label} className="w-fit max-w-full">
          <SelectValue placeholder="Jump to…" />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" className="max-w-[calc(100vw-2rem)]">
          {children}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * One entry of a document's index: a button that scrolls its section into view, marked when the
 * revision changes it (slice 8b D11, the demo's index marks) and `aria-current` while the reader
 * is in it (UX audit C4).
 */
export function IndexItem({
  target,
  id,
  label,
  marked,
  active,
}: {
  target: string;
  /** A clause's id, shown before its title. */
  id?: string;
  label: ReactNode;
  /** True when the revision changes the clause or adds it. */
  marked?: boolean;
  /** True while the reader is in the section. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active === true ? "location" : undefined}
      onClick={() => {
        scrollToSection(target);
      }}
      className={cn(
        "flex gap-2 border-l-2 px-2.5 py-1.5 text-left text-[13px] leading-snug outline-none hover:border-hair-strong hover:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active === true ? "border-ink-line bg-card font-medium" : "border-transparent",
      )}
    >
      {id !== undefined && (
        <span className="w-6 shrink-0 font-mono text-[11px] leading-[1.6] text-faint">{id}</span>
      )}
      <span className="flex-1">{label}</span>
      {marked === true && (
        <span
          title="Changed in this revision"
          data-mark="changed"
          className="mt-1.5 size-1.5 shrink-0 bg-work-dot"
        />
      )}
    </button>
  );
}
