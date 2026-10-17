import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** A prefill and the button that asked for it (a clause footer's Ask or Propose a change). */
export interface HatchPrefill {
  text: string;
  /** Which button prefilled the text: "Sent to the activity log →" shows beside it after a send. */
  origin: string;
}

interface HatchState {
  open: boolean;
  text: string;
  /** The button whose prefill the text started from; null when typed from the closed row. */
  origin: string | null;
  /** The buttons a sent message started from. */
  sent: ReadonlySet<string>;
  /** Bumped by each open-and-focus, so an already open composer takes focus again. */
  focusRequest: number;
}

interface HatchContextValue extends HatchState {
  setOpen: (open: boolean) => void;
  setText: (text: string) => void;
  /**
   * The one open-and-focus entry point: opens the hatch and focuses the composer,
   * with `prefill` as its text when given. It sends nothing.
   */
  openHatch: (prefill: HatchPrefill | null) => void;
  /** After a send: empties the composer and records the button its text started from. */
  sentMessage: () => void;
}

const HatchContext = createContext<HatchContextValue | null>(null);

/**
 * The escape hatch's composer state for one map's pages: the Activity column renders
 * it, and any button on the page opens and focuses it through `useHatch().openHatch`.
 */
export function HatchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HatchState>({
    open: false,
    text: "",
    origin: null,
    sent: new Set(),
    focusRequest: 0,
  });
  const value = useMemo<HatchContextValue>(
    () => ({
      ...state,
      setOpen: (open) => {
        setState((current) => ({ ...current, open }));
      },
      setText: (text) => {
        setState((current) => ({ ...current, text, origin: text === "" ? null : current.origin }));
      },
      openHatch: (prefill) => {
        setState((current) => ({
          ...current,
          open: true,
          text: prefill === null ? current.text : prefill.text,
          origin: prefill === null ? current.origin : prefill.origin,
          focusRequest: current.focusRequest + 1,
        }));
      },
      sentMessage: () => {
        setState((current) => ({
          ...current,
          text: "",
          origin: null,
          sent: current.origin === null ? current.sent : new Set([...current.sent, current.origin]),
        }));
      },
    }),
    [state],
  );
  return <HatchContext.Provider value={value}>{children}</HatchContext.Provider>;
}

/** The hatch of the map on screen; only inside a `HatchProvider`. */
export function useHatch(): HatchContextValue {
  const hatch = useContext(HatchContext);
  if (hatch === null) {
    throw new Error("useHatch is used outside a HatchProvider");
  }
  return hatch;
}
