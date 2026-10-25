import { useSyncExternalStore } from "react";

/**
 * Which chat the person uses: the classic one, or the next one built on
 * assistant-ui (NIAR-228) while it is tried next to it. `?chat=next` or
 * `?chat=classic` in the address picks one and is remembered in
 * localStorage (`niaro.chat`); the account menu switches the same way.
 */
const KEY = "niaro.chat";
type Choice = "classic" | "next";
const listeners = new Set<() => void>();

function read(): Choice {
  try {
    const asked = new URLSearchParams(window.location.search).get("chat");
    if (asked === "next" || asked === "classic")
      window.localStorage.setItem(KEY, asked);
    return window.localStorage.getItem(KEY) === "next" ? "next" : "classic";
  } catch {
    return "classic";
  }
}
let current: Choice = typeof window === "undefined" ? "classic" : read();

export const chatNextEnabled = () => current === "next";
export function setChatNext(on: boolean) {
  current = on ? "next" : "classic";
  try {
    window.localStorage.setItem(KEY, current);
  } catch {
    // Remembered for this page only.
  }
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Whether the next chat is on; re-renders when the menu switches it. */
export function useChatNext() {
  return useSyncExternalStore(subscribe, chatNextEnabled, chatNextEnabled);
}
