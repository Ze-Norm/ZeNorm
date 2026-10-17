import * as React from "react";
import { MessageSquarePlus, MousePointerClick, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { describeTarget, elementAt } from "./annotations";
import { AnnotationPanel } from "./AnnotationPanel";
import { Highlight } from "./Highlight";
import type { AnnotationTarget } from "./types";
import { useAnnotations } from "./useAnnotations";

type Picked = { target: AnnotationTarget; rect: DOMRect };

const COMPOSER_WIDTH = 320;
const COMPOSER_HEIGHT = 200;
const MARGIN = 12;

function composerPosition(rect: DOMRect): React.CSSProperties {
  const left = Math.min(Math.max(MARGIN, rect.left), window.innerWidth - COMPOSER_WIDTH - MARGIN);
  const below = rect.bottom + 8;
  const top =
    below + COMPOSER_HEIGHT > window.innerHeight
      ? Math.max(MARGIN, rect.top - COMPOSER_HEIGHT - 8)
      : below;
  return { left, top, width: COMPOSER_WIDTH };
}

/**
 * The annotation widget: a picker that pins a note to the element the user
 * clicked, a panel over the notes, and a fixed button in the corner. Notes are
 * written to `annotations.json` by the Vite plugin in `vite.config.ts`.
 */
export function AnnotationWidget() {
  const store = useAnnotations();
  const [picking, setPicking] = React.useState(false);
  const [hovered, setHovered] = React.useState<Picked | null>(null);
  const [draft, setDraft] = React.useState<Picked | null>(null);
  const [note, setNote] = React.useState("");
  const [panelOpen, setPanelOpen] = React.useState(false);
  const areaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (draft) areaRef.current?.focus();
  }, [draft]);

  React.useEffect(() => {
    if (!draft && !panelOpen && !picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (draft) setDraft(null);
      else if (picking) setPicking(false);
      else setPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, panelOpen, picking]);

  const pick = (element: Element | null): Picked | null =>
    element ? { target: describeTarget(element), rect: element.getBoundingClientRect() } : null;

  const save = async () => {
    if (!draft || !note.trim()) return;
    await store.add(note, draft.target);
    setDraft(null);
    setNote("");
    setPanelOpen(true);
  };

  return (
    <>
      {/* In picking mode this overlay sits above everything and swallows every
          click, so neither the demo's controls nor the widget's own chrome
          react. Escape leaves picking mode. */}
      {picking ? (
        <div
          data-annotation-ui=""
          className="fixed inset-0 z-[140] cursor-crosshair"
          onMouseMove={(event) => setHovered(pick(elementAt(event.clientX, event.clientY)))}
          onMouseLeave={() => setHovered(null)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const picked = pick(elementAt(event.clientX, event.clientY));
            setHovered(null);
            setPicking(false);
            if (picked) setDraft(picked);
          }}
        >
          {hovered ? (
            <Highlight rect={hovered.rect} label={hovered.target.component ?? hovered.target.tag} />
          ) : null}
          <p className="pointer-events-none fixed right-4 bottom-4 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground shadow-md">
            Click any element to annotate it · Esc to stop
          </p>
        </div>
      ) : null}

      {draft ? <Highlight rect={draft.rect} /> : null}

      {draft ? (
        <div
          data-annotation-ui=""
          className="fixed z-[120] rounded-lg border border-border bg-card p-3 shadow-xl"
          style={composerPosition(draft.rect)}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                {draft.target.component ?? draft.target.tag}
              </p>
              {draft.target.text ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">“{draft.target.text}”</p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={() => setDraft(null)}
              aria-label="Cancel note"
            >
              <X />
            </Button>
          </div>

          <Textarea
            ref={areaRef}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
            }}
            placeholder="What should change here?"
            className="mt-2 min-h-20 text-sm"
          />

          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto font-mono text-[10px] text-muted-foreground">⌘↵ saves</span>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!note.trim()}>
              Save note
            </Button>
          </div>
        </div>
      ) : null}

      {panelOpen ? <AnnotationPanel store={store} onClose={() => setPanelOpen(false)} /> : null}

      {/* Nothing to click while picking: the overlay is on top, so a button here
          would be unreachable and would cover a strip of the page. */}
      {picking ? null : (
        <div
          data-annotation-ui=""
          className={cn(
            "fixed right-4 bottom-4 z-[130] flex items-center gap-1.5 transition-[right] duration-200",
            panelOpen && "right-[21rem]",
          )}
        >
          <Button
            variant="outline"
            size="sm"
            className="shadow-md"
            onClick={() => setPanelOpen((open) => !open)}
          >
            <MessageSquarePlus />
            {store.openCount > 0 ? `${store.openCount} open` : "Notes"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="shadow-md"
            onClick={() => {
              setDraft(null);
              setPanelOpen(false);
              setPicking(true);
            }}
          >
            <MousePointerClick />
            Annotate
          </Button>
        </div>
      )}
    </>
  );
}
