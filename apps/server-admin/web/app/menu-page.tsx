import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { ClientSession } from "../../../../packages/client-core/session";
import { formatRelative } from "@admin/components/console/time";
import { cn } from "@admin/lib/utils";

/** The scrolling column every personal menu page sits in; `wide` gives
 * tables and process tests more room; `fill` keeps the page at the window's
 * height on a wide screen, so its panes scroll on their own. Panes keep a
 * minimum height; when the window is too short for it, the page scrolls. */
export function MenuPage({
  children,
  wide = false,
  fill = false,
}: {
  children: ReactNode;
  wide?: boolean;
  fill?: boolean;
}) {
  return (
    <div
      data-fill={fill}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div
        data-fill={fill}
        className={cn(
          "mx-auto flex w-full min-w-0 flex-col gap-8 px-4 pt-6 pb-12 md:px-8 md:pt-8 data-[fill=true]:lg:h-full data-[fill=true]:lg:pb-6",
          wide ? "max-w-7xl" : "max-w-5xl",
        )}
      >
        {children}
      </div>
    </div>
  );
}

const started = new WeakSet<ClientSession>();
/**
 * Starts the session's sync once per session. Process starts and recent runs
 * need its live store; starting twice is harmless (one poll timer).
 */
export function ensureSessionStarted(session: ClientSession) {
  if (started.has(session)) return;
  started.add(session);
  void session.start().catch(() => {});
}

/** The session's live state; starts its sync when a page needs it. */
export function useSessionState(session: ClientSession) {
  useEffect(() => ensureSessionStarted(session), [session]);
  return useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
}

/** A relative time with the exact local date and time in the tooltip. */
export function When({
  value,
  language,
}: {
  value: string | number;
  language: string;
}) {
  const date = new Date(value);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(language, {
        dateStyle: "full",
        timeStyle: "short",
      })}
      className="whitespace-nowrap tabular-nums"
    >
      {formatRelative(date, language)}
    </time>
  );
}
