import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * The colour scheme the person chose: light, dark, or the system's (the `prefers-color-scheme`
 * media query, followed as it changes). Stored under `THEME_STORAGE_KEY` in `localStorage`; no
 * stored choice is `system`.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

export const THEME_STORAGE_KEY = "zenorm.theme";

/** The class on `<html>` that selects the dark scheme (`@custom-variant dark` in `index.css`). */
export const DARK_CLASS = "dark";

/** What `startTheme` reads and writes the choice through: `localStorage`'s shape. */
export interface ThemeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The system's scheme: `matchMedia("(prefers-color-scheme: dark)")`'s shape. */
export interface SystemScheme {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface Theme {
  /** The person's choice. */
  readonly preference: () => ThemePreference;
  /** Whether the dark scheme is on: the choice, or the system's under `system`. */
  readonly dark: () => boolean;
  /** Records the choice and applies it. */
  readonly choose: (preference: ThemePreference) => void;
  /** Calls `onChange` after each change of the choice or of the applied scheme. */
  readonly subscribe: (onChange: () => void) => () => void;
  /** Stops following the system; the applied scheme stays as it is. */
  readonly close: () => void;
}

export interface ThemeOptions {
  readonly store: ThemeStore;
  readonly system: SystemScheme;
  /** Puts the dark scheme on or off: toggles `DARK_CLASS` on `<html>` in the browser. */
  readonly apply: (dark: boolean) => void;
}

/**
 * Reads a stored choice. No stored value is `system`. A value this ZeNorm does not know (another
 * version's, or an edit) is no choice either, so the app follows the system rather than refusing
 * to open; `startTheme` clears it.
 */
export function parseThemePreference(stored: string | null): ThemePreference {
  if (stored === null) return "system";
  for (const preference of THEME_PREFERENCES) {
    if (stored === preference) return preference;
  }
  return "system";
}

/**
 * The app's one theme (`app.tsx` starts it before rendering, after `index.html`'s head script has
 * applied the stored choice to the first paint): it reads the choice, applies it, follows the
 * system while the choice is `system`, and tells its subscribers of each change.
 */
export function startTheme({ store, system, apply }: ThemeOptions): Theme {
  const stored = store.getItem(THEME_STORAGE_KEY);
  let preference = parseThemePreference(stored);
  if (stored !== null && preference === "system") store.removeItem(THEME_STORAGE_KEY);
  const listeners = new Set<() => void>();

  const dark = (): boolean => (preference === "system" ? system.matches : preference === "dark");

  const applyAndNotify = (): void => {
    apply(dark());
    for (const listener of listeners) listener();
  };

  const onSystemChange = (): void => {
    if (preference === "system") applyAndNotify();
  };
  system.addEventListener("change", onSystemChange);
  apply(dark());

  return {
    preference: () => preference,
    dark,
    choose: (next) => {
      preference = next;
      if (next === "system") store.removeItem(THEME_STORAGE_KEY);
      else store.setItem(THEME_STORAGE_KEY, next);
      applyAndNotify();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    close: () => {
      system.removeEventListener("change", onSystemChange);
    },
  };
}

/** The browser's theme: `localStorage`, the system's media query, and the class on `<html>`. */
export function startBrowserTheme(): Theme {
  return startTheme({
    store: window.localStorage,
    system: window.matchMedia("(prefers-color-scheme: dark)"),
    apply: (dark) => {
      document.documentElement.classList.toggle(DARK_CLASS, dark);
    },
  });
}

export const ThemeContext = createContext<Theme | null>(null);

/** The theme and its current choice, kept current; only under `ThemeContext`. */
export function useTheme(): { preference: ThemePreference; dark: boolean; theme: Theme } {
  const theme = useContext(ThemeContext);
  if (theme === null) {
    throw new Error("useTheme needs the ThemeContext provider (app.tsx)");
  }
  const preference = useSyncExternalStore(theme.subscribe, theme.preference);
  const dark = useSyncExternalStore(theme.subscribe, theme.dark);
  return { preference, dark, theme };
}
