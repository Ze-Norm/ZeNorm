import { useLocation } from "@tanstack/react-router";
import { PanelRight, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { COLUMNS_BREAKPOINT, useBreakpoint } from "@/hooks/use-breakpoint";
import { cn } from "@/lib/utils";

/**
 * The map workspace's shell (UX audit A1): the page beside its column, the Activity column, Run
 * activity or a plugin's aside. From `lg` up the two sit in a grid, the column sticky under the
 * top bar and the stage rail for the viewport's remaining height (`--workspace-chrome`, set in
 * `index.css`). Below `lg` the page takes the whole width and the column opens as a sheet from the
 * top bar's button, which `WorkspaceSheetProvider` connects to the page's shell. The column is
 * mounted in exactly one of the two places, so its effects and landmarks exist once.
 */

interface WorkspaceSheetValue {
  /** The open page's column, by its label; null when the page has none. */
  label: string | null;
  open: boolean;
  /** Opens or closes the sheet; opening remembers the focused element for `restoreFocus`. */
  setOpen: (open: boolean) => void;
  /**
   * Puts focus back where it was when the sheet opened: the top bar's button, or the page button
   * that opened it (a clause's Ask). The sheet's trigger lives outside the sheet's subtree, so
   * Radix cannot do this itself (UX review P1-2).
   */
  restoreFocus: () => void;
  /** The shell's registration of its column; null again when it unmounts. */
  register: (label: string | null) => void;
}

const WorkspaceSheetContext = createContext<WorkspaceSheetValue | null>(null);

/** Holds the sheet's state above the top bar and the pages, so the bar's button can open it. */
export function WorkspaceSheetProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  const [open, setOpenState] = useState(false);
  const opener = useRef<Element | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (next) {
      opener.current = document.activeElement;
    }
    setOpenState(next);
  }, []);
  const restoreFocus = useCallback(() => {
    const element = opener.current;
    opener.current = null;
    // The opener is gone when the sheet closed on a navigation; nothing to return to then.
    if (element instanceof HTMLElement && element.isConnected) {
      element.focus();
    }
  }, []);
  const value = useMemo<WorkspaceSheetValue>(
    () => ({ label, open, setOpen, restoreFocus, register: setLabel }),
    [label, open, setOpen, restoreFocus],
  );
  return <WorkspaceSheetContext value={value}>{children}</WorkspaceSheetContext>;
}

/** The workspace sheet's state; only inside a `WorkspaceSheetProvider`. */
export function useWorkspaceSheet(): WorkspaceSheetValue {
  const value = useContext(WorkspaceSheetContext);
  if (value === null) {
    throw new Error("useWorkspaceSheet is used outside a WorkspaceSheetProvider");
  }
  return value;
}

/** Whether a column renders in the grid or in the sheet, for `ColumnHead`'s close button. */
const ColumnPresentationContext = createContext<"column" | "sheet">("column");

/**
 * The top bar's button that opens the column as a sheet: only below the columns breakpoint, and
 * only while a page has registered a column.
 */
export function WorkspaceSheetTrigger() {
  const sheet = useWorkspaceSheet();
  const wide = useBreakpoint(COLUMNS_BREAKPOINT);
  if (wide || sheet.label === null) {
    return null;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      aria-expanded={sheet.open}
      aria-haspopup="dialog"
      className="shrink-0"
      onClick={() => {
        sheet.setOpen(true);
      }}
    >
      <PanelRight />
      <span className="sr-only sm:not-sr-only">{sheet.label}</span>
    </Button>
  );
}

/**
 * The map page's one measure (UX audit P1-3; real-data review). Every map page is one centred
 * container inside `main`, no wider than `--page-measure`, so its box is the same from stage to
 * stage: the head (eyebrow, h1, lede) at the container's left edge, then the body. A page with an
 * index (Wayfinding's waypoints, a spec's sections) splits the body row from `md` up: the index on
 * a `--page-side` track at the left, sticky under the chrome, and the content beside it; below
 * `md` the side track goes and the index folds above the content (`folded`). A page without an
 * index keeps its head and body at the container's left edge, no wider than `--page-content`,
 * the content's width beside an index, so a card runs no wider there than here and the h1 never
 * moves. `main` fills its grid column (the space left of the Activity column at `xl`, the whole
 * width below), so the container centres in that space. The numbers live in `index.css` beside
 * the chrome's.
 */
export function WorkspacePage({
  head,
  index,
  folded,
  children,
}: {
  head: ReactNode;
  index?: ReactNode;
  folded?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-w-0 px-4 pt-5 pb-24 sm:px-6 sm:pt-6 lg:px-10 lg:pt-8 lg:pb-32">
      <div data-slot="page" className="mx-auto grid w-full max-w-(--page-measure) gap-y-7">
        <div
          className={cn(
            "grid min-w-0 content-start gap-6",
            index === undefined && "max-w-(--page-content)",
          )}
        >
          {head}
        </div>
        <div
          className={cn(
            "grid min-w-0 items-start gap-6",
            index === undefined
              ? "max-w-(--page-content)"
              : "md:grid-cols-[var(--page-side)_minmax(0,1fr)] md:gap-x-(--page-gap)",
          )}
        >
          {index !== undefined && (
            <div
              data-slot="page-index"
              className="sticky top-(--workspace-chrome) hidden max-h-[calc(100dvh-var(--workspace-chrome))] min-w-0 overflow-y-auto py-1 md:block"
            >
              {index}
            </div>
          )}
          <div data-slot="page-body" className="grid min-w-0 content-start gap-6">
            {folded !== undefined && <div className="md:hidden">{folded}</div>}
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The page (`children`, a `WorkspacePage`) beside its `column`. `openOn` is a counter whose change
 * opens the sheet, for a page button that puts something in the column, as a clause's Ask puts the
 * hatch's composer there (`useHatch().focusRequest`). The sheet closes on every navigation.
 */
export function WorkspaceColumns({
  label,
  column,
  openOn,
  children,
}: {
  label: string;
  column: ReactNode;
  openOn?: number;
  children: ReactNode;
}) {
  const wide = useBreakpoint(COLUMNS_BREAKPOINT);
  const sheet = useWorkspaceSheet();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { register, setOpen, restoreFocus } = sheet;

  useEffect(() => {
    register(label);
    return () => {
      register(null);
    };
  }, [label, register]);

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  const seen = useRef(openOn);
  useEffect(() => {
    if (openOn !== seen.current) {
      seen.current = openOn;
      if (!wide) {
        setOpen(true);
      }
    }
  }, [openOn, wide, setOpen]);

  if (wide) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_22rem] items-start">
        {children}
        <div className="sticky top-(--workspace-chrome) h-[calc(100dvh-var(--workspace-chrome))] border-l border-ink-line bg-card">
          {column}
        </div>
      </div>
    );
  }
  return (
    <>
      {children}
      <Sheet open={sheet.open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-[min(22rem,92vw)] gap-0 border-l-ink-line bg-card p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <ColumnPresentationContext value="sheet">{column}</ColumnPresentationContext>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * A column's head row: its title, then its controls (`children`) at the right; in the sheet, the
 * close button last.
 */
export function ColumnHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const presentation = useContext(ColumnPresentationContext);
  return (
    <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border px-3.5">
      <strong className="font-display text-[13px] font-semibold">{title}</strong>
      <span className="flex-1" />
      {children}
      {presentation === "sheet" && (
        <SheetClose asChild>
          <Button variant="ghost" size="icon" className="-mr-2 size-7" aria-label="Close">
            <X />
          </Button>
        </SheetClose>
      )}
    </div>
  );
}
