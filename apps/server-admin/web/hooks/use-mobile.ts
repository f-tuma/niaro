import { useSyncExternalStore } from "react";

function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
export function useIsMobile() {
  return useMedia("(max-width: 767px)");
}
/** Desktop layouts that place panels side by side (Tailwind `lg`). */
export function useIsWide() {
  return useMedia("(min-width: 1024px)");
}
