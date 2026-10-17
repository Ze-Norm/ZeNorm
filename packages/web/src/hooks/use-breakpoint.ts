import { useCallback, useSyncExternalStore } from "react";

/**
 * The breakpoints the workspace lays out by, Tailwind's own in pixels. The one shell convention:
 * a map page is two columns (the page, then the 22rem Activity column) from `xl` up, where the
 * page keeps at least 848px, and one column below it, where the column opens as a sheet from the
 * top bar and the page has the viewport less its padding. A page's own side columns (an index, a
 * panel in the head) stack below `md`.
 */
export const BREAKPOINTS = { md: 768, lg: 1024, xl: 1280 } as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

/** The breakpoint the workspace's columns split at. */
export const COLUMNS_BREAKPOINT: Breakpoint = "xl";

function query(breakpoint: Breakpoint): MediaQueryList {
  return window.matchMedia(`(min-width: ${String(BREAKPOINTS[breakpoint])}px)`);
}

/**
 * Whether the viewport is at least `breakpoint` wide, read from the same media query Tailwind's
 * `md:`/`lg:`/`xl:` variants use and kept current as the window resizes. For rendering one of two
 * layouts, where a CSS `hidden` would mount both.
 */
export function useBreakpoint(breakpoint: Breakpoint): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = query(breakpoint);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [breakpoint],
  );
  const read = useCallback(() => query(breakpoint).matches, [breakpoint]);
  return useSyncExternalStore(subscribe, read);
}
