import * as React from "react";
import { Check, Copy, RotateCcw, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { annotationsToMarkdown } from "./annotations";
import { Highlight } from "./Highlight";
import type { Annotation } from "./types";
import type { AnnotationStore } from "./useAnnotations";

/** Open notes first, newest first inside each group. */
function ordered(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function AnnotationPanel({ store, onClose }: { store: AnnotationStore; onClose: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const [flash, setFlash] = React.useState<{ id: string; rect: DOMRect } | null>(null);
  const [missing, setMissing] = React.useState<string | null>(null);

  const locate = (note: Annotation) => {
    let element: Element | null = null;
    try {
      element = document.querySelector(note.target.selector);
    } catch {
      element = null;
    }

    if (!element) {
      setMissing(note.id);
      window.setTimeout(() => setMissing((id) => (id === note.id ? null : id)), 2500);
      return;
    }

    element.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => {
      setFlash({ id: note.id, rect: element!.getBoundingClientRect() });
      window.setTimeout(() => setFlash((current) => (current?.id === note.id ? null : current)), 1800);
    }, 320);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(annotationsToMarkdown(ordered(store.annotations)));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const notes = ordered(store.annotations);

  return (
    <>
      {flash ? <Highlight rect={flash.rect} tone="flash" /> : null}

      <aside
        data-annotation-ui=""
        className="fixed inset-y-0 right-0 z-[110] flex w-80 flex-col border-l border-border bg-card shadow-xl"
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-medium">Annotations</h2>
          <Badge variant={store.openCount > 0 ? "default" : "secondary"}>{store.openCount} open</Badge>
          <span className="font-mono text-[10px] text-muted-foreground">{notes.length} total</span>
          <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={onClose} aria-label="Close annotations">
            <X />
          </Button>
        </header>

        <p className="border-b border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {store.source === "file" ? (
            <>
              Saved to <code className="font-mono">annotations.json</code> in the demo root.
            </>
          ) : (
            <>Dev server endpoint unavailable — notes are kept in this browser only.</>
          )}
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {notes.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No notes yet. Turn on <span className="font-medium text-foreground">Annotate</span>, click any element, and
              say what should change.
            </p>
          ) : null}

          <ul>
            {notes.map((note, index) => (
              <li
                key={note.id}
                className={cn(
                  "border-b border-border p-3",
                  note.status === "resolved" && "bg-muted/40 opacity-60",
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                      {note.target.component ?? note.target.tag}
                    </p>
                    {note.target.text ? (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">“{note.target.text}”</p>
                    ) : null}
                    <p className="mt-1.5 text-sm whitespace-pre-wrap">{note.note}</p>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={note.target.selector}>
                      {note.target.selector}
                    </p>
                    {missing === note.id ? (
                      <p className="mt-1 text-[11px] text-destructive">
                        Nothing matches this selector any more — the element moved or was renamed.
                      </p>
                    ) : null}

                    <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => locate(note)}
                      >
                        Locate
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() =>
                          void store.update(note.id, {
                            status: note.status === "open" ? "resolved" : "open",
                          })
                        }
                      >
                        {note.status === "open" ? (
                          <>
                            <Check /> Resolve
                          </>
                        ) : (
                          <>
                            <RotateCcw /> Reopen
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                        onClick={() => void store.remove(note.id)}
                      >
                        <Trash2 /> Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <footer className="flex flex-wrap gap-2 border-t border-border p-3">
          <Button variant="outline" size="sm" onClick={() => void copy()} disabled={notes.length === 0}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy as Markdown"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void store.clearResolved()}
            disabled={notes.length === store.openCount}
          >
            Clear resolved
          </Button>
        </footer>
      </aside>
    </>
  );
}
