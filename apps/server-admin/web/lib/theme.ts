import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
const storageKey = "agent-admin-theme";
const media =
  typeof window === "undefined"
    ? null
    : window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
let preference = read();

/** Applies the stored preference; called once before the first render. */
export function applyTheme() {
  const dark =
    preference === "dark" || (preference === "system" && !!media?.matches);
  document.documentElement.classList.toggle("dark", dark);
}
media?.addEventListener("change", () => {
  applyTheme();
  listeners.forEach((listener) => listener());
});

export function setTheme(value: ThemePreference) {
  preference = value;
  try {
    if (value === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, value);
  } catch {
    /* The preference still applies for this session. */
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

export function useTheme() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preference,
  );
}
