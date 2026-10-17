import type { SpecRevisionContent, TextDelta } from "@zenorm/contracts";

import { AgentText } from "@/components/AgentText";
import { Micro } from "@/components/parts";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { clauseChange } from "@/lib/specs";
import { IndexItem, JumpMenu, useActiveSection } from "@/pages/stages/planning/StageParts";

/** The spec document's sections, in order: the ids its index jumps to. */
function sectionIds(content: SpecRevisionContent, delta: TextDelta | null): string[] {
  return [
    "spec-problem",
    "spec-solution",
    ...content.clauses.map((clause) => `clause-${clause.id}`),
    ...(delta !== null && delta.removedClauses.length > 0 ? ["spec-removed"] : []),
    "spec-out",
  ];
}

/**
 * The spec document's index at the left of the document (`WorkspacePage`): Problem, Solution, each
 * behaviour (marked when the revision changes it, slice 8b D11), the removed ones, Out of scope;
 * the section the reader is in is marked (UX audit C4). `delta` is null on revision 1 and on a
 * spec the map only waits on.
 */
export function SpecIndex({
  content,
  delta,
}: {
  content: SpecRevisionContent;
  delta: TextDelta | null;
}) {
  const active = useActiveSection(sectionIds(content, delta));
  return (
    <nav aria-label="Spec index" className="grid content-start gap-0.5">
      <IndexItem target="spec-problem" label="Problem" active={active === "spec-problem"} />
      <IndexItem target="spec-solution" label="Solution" active={active === "spec-solution"} />
      <Micro className="mt-3 mb-1 px-2.5">Behaviour · {content.clauses.length}</Micro>
      {content.clauses.map((clause) => (
        <IndexItem
          key={clause.id}
          target={`clause-${clause.id}`}
          id={clause.id}
          label={<AgentText text={clause.title} />}
          marked={delta !== null && clauseChange(delta, clause.id) !== "unchanged"}
          active={active === `clause-${clause.id}`}
        />
      ))}
      {delta !== null && delta.removedClauses.length > 0 && (
        <IndexItem
          target="spec-removed"
          label={`Removed · ${String(delta.removedClauses.length)}`}
          active={active === "spec-removed"}
        />
      )}
      <Micro className="mt-3 mb-1 px-2.5">Exclusions</Micro>
      <IndexItem
        target="spec-out"
        label={`Out of scope · ${String(content.outOfScope.length)}`}
        active={active === "spec-out"}
      />
    </nav>
  );
}

/** The spec's index below the split: a Jump to menu over the same sections (`JumpMenu`). */
export function SpecJumpMenu({
  content,
  delta,
}: {
  content: SpecRevisionContent;
  delta: TextDelta | null;
}) {
  return (
    <JumpMenu label="Spec index">
      <SelectItem value="spec-problem">Problem</SelectItem>
      <SelectItem value="spec-solution">Solution</SelectItem>
      <SelectGroup>
        <SelectLabel>Behaviour · {content.clauses.length}</SelectLabel>
        {content.clauses.map((clause) => (
          <SelectItem key={clause.id} value={`clause-${clause.id}`}>
            <span className="font-mono text-[11px] text-faint">{clause.id}</span>{" "}
            <AgentText text={clause.title} />
          </SelectItem>
        ))}
      </SelectGroup>
      {delta !== null && delta.removedClauses.length > 0 && (
        <SelectItem value="spec-removed">Removed · {delta.removedClauses.length}</SelectItem>
      )}
      <SelectGroup>
        <SelectLabel>Exclusions</SelectLabel>
        <SelectItem value="spec-out">Out of scope · {content.outOfScope.length}</SelectItem>
      </SelectGroup>
    </JumpMenu>
  );
}
