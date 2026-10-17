import { describe, expect, it } from "vitest";

import { parseThemePreference, startTheme, THEME_STORAGE_KEY } from "./theme.ts";
import type { SystemScheme, ThemeStore } from "./theme.ts";

class FakeStore implements ThemeStore {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    if (!this.items.has(key)) return null;
    const value = this.items.get(key);
    if (value === undefined) throw new Error(`${key} is set but undefined`);
    return value;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

class FakeSystem implements SystemScheme {
  matches = false;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: "change", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "change", listener: () => void): void {
    this.listeners.delete(listener);
  }
  set(dark: boolean): void {
    this.matches = dark;
    for (const listener of this.listeners) listener();
  }
}

function setup(stored: string | null, systemDark: boolean) {
  const store = new FakeStore();
  if (stored !== null) store.setItem(THEME_STORAGE_KEY, stored);
  const system = new FakeSystem();
  system.matches = systemDark;
  const applied: boolean[] = [];
  const theme = startTheme({
    store,
    system,
    apply: (dark) => {
      applied.push(dark);
    },
  });
  return { store, system, applied, theme };
}

describe("parseThemePreference", () => {
  it("reads the three choices, and no value as system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  it("reads a value it does not know as no choice", () => {
    expect(parseThemePreference("sepia")).toBe("system");
  });
});

describe("startTheme", () => {
  it("applies the stored choice at once", () => {
    const { applied, theme } = setup("dark", false);
    expect(applied).toEqual([true]);
    expect(theme.preference()).toBe("dark");
    expect(theme.dark()).toBe(true);
  });

  it("follows the system with no stored choice, and stops once a choice is made", () => {
    const { applied, system, theme } = setup(null, true);
    expect(theme.preference()).toBe("system");
    expect(applied).toEqual([true]);
    system.set(false);
    expect(applied).toEqual([true, false]);
    theme.choose("dark");
    system.set(true);
    system.set(false);
    expect(applied).toEqual([true, false, true]);
  });

  it("stores a light or dark choice and clears it for system", () => {
    const { store, theme } = setup(null, false);
    theme.choose("light");
    expect(store.getItem(THEME_STORAGE_KEY)).toBe("light");
    theme.choose("system");
    expect(store.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("clears a stored value it does not know", () => {
    const { store, theme } = setup("sepia", false);
    expect(theme.preference()).toBe("system");
    expect(store.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("tells subscribers of a choice and of a followed system change, until unsubscribed", () => {
    const { system, theme } = setup(null, false);
    let changes = 0;
    const unsubscribe = theme.subscribe(() => {
      changes += 1;
    });
    theme.choose("system");
    system.set(true);
    expect(changes).toBe(2);
    unsubscribe();
    theme.choose("light");
    expect(changes).toBe(2);
  });

  it("stops following the system once closed", () => {
    const { applied, system, theme } = setup(null, false);
    theme.close();
    system.set(true);
    expect(applied).toEqual([false]);
  });
});
