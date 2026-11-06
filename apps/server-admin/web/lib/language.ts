/** Where the console and the web app keep a language someone chose. */
export const LANGUAGE_KEY = "agent-admin-language";

/** Czech when the browser prefers it over English, else English. */
export function browserLanguage(): "en" | "cs" {
  if (typeof navigator === "undefined") return "en";
  const preferred = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split("-")[0];
    if (base === "cs" || base === "en") return base;
  }
  return "en";
}

/** The language someone chose, else the browser's. */
export function preferredLanguage(): "en" | "cs" {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored === "cs" || stored === "en") return stored;
  } catch {
    /* Storage can be unavailable; the browser language still applies. */
  }
  return browserLanguage();
}

/** Remembers an explicit choice; the default is never stored. */
export function storeLanguage(language: "en" | "cs") {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    /* The choice still applies to this page. */
  }
}
