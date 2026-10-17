import { useSyncExternalStore } from "react";

function query(): MediaQueryList {
  return window.matchMedia("(hover: hover)");
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list.addEventListener("change", onChange);
  return () => {
    list.removeEventListener("change", onChange);
  };
}

function read(): boolean {
  return query().matches;
}

/**
 * Whether the primary pointer can hover (a mouse or trackpad, not a touch screen), kept current.
 * A tooltip shows only where it can (`TooltipContent`): a tap opens it just for the press.
 */
export function useCanHover(): boolean {
  return useSyncExternalStore(subscribe, read);
}
