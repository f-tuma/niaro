/** Owner-aware routes keep service links and saved scopes intact. */
export const processHomeRoute = (serviceId: string) =>
  serviceId
    ? { to: "/services/$serviceId" as const, params: { serviceId } }
    : { to: "/processes" as const };
export const processDesignRoute = (serviceId: string) =>
  serviceId
    ? {
        to: "/services/$serviceId/processes/design" as const,
        params: { serviceId },
      }
    : { to: "/processes/design" as const };
export const processConsoleRoute = (serviceId: string, processId: string) =>
  serviceId
    ? {
        to: "/services/$serviceId/processes/$processId" as const,
        params: { serviceId, processId },
      }
    : { to: "/processes/$processId" as const, params: { processId } };

declare module "@tanstack/history" {
  interface HistoryState {
    /** The process page opens on this tab after a hand-off, e.g. "tests" after saving. */
    processTab?: "tests" | "versions";
  }
}
