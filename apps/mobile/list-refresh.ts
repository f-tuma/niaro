import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import type {
  ListMarkName,
  ListMarks,
} from "../../packages/protocol/list-marks";

/** The parts of `ClientSession` a list follows; older sessions lack them. */
export type ListMarkSource = {
  subscribe?(listener: () => void): () => void;
  getListMarks?(): ListMarks | undefined;
};

export const LIST_REFRESH = {
  /** Opening a screen reads again when its last read is older. */
  freshMs: 2 * 60_000,
  /** Reads after change marks are at least this far apart (a meeting's
   * upload or transcription moves its mark often). */
  minGapMs: 5_000,
  /** Only for a server that sends no change marks: a quiet read this often
   * while the list is followed and the app is in the foreground. */
  fallbackMs: 2 * 60_000,
  /** The same, while a meeting on screen uploads or processes. */
  processingMs: 15_000,
} as const;

const noSubscription = () => () => {};
function useForeground() {
  const [foreground, setForeground] = useState(
    () => AppState.currentState !== "background",
  );
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => setForeground(state !== "background"),
    );
    return () => subscription?.remove();
  }, []);
  return foreground;
}

/**
 * When a phone list (Tasks, Meetings) reads the server: never on a timer
 * while the server sends change marks (`ClientSession.getListMarks`, carried
 * by the events poll the session runs anyway). It reads when
 *
 * - it starts following the list or `target` (tab, page, open record) changes;
 * - the list's change mark differs from the mark of its last read (at most
 *   every `minGapMs`);
 * - the screen opens (`visible` becomes true) and the last read is older
 *   than `freshMs` or predates a change;
 * - the app comes back from the background or the connection comes back;
 * - `refreshVersion` changes (the screen's Refresh).
 *
 * Nothing runs while the app is in the background. `load` resolves `false`
 * or rejects when the read did not land; a read asked for during another one
 * runs once after it.
 */
export function useListRefresh({
  session,
  list,
  target,
  visible,
  follow,
  online,
  refreshVersion,
  processing = false,
  load,
}: {
  session: ListMarkSource;
  list: ListMarkName;
  /** What the read is for, e.g. the tab and page; a change reads. */
  target: string;
  visible: boolean;
  /** Mark changes read while true (Tasks: always, for the badge). */
  follow: boolean;
  online: boolean;
  refreshVersion: number;
  /** A meeting on screen uploads or processes (fallback timing only). */
  processing?: boolean;
  load(): Promise<boolean | void>;
}) {
  const subscribe = useCallback(
    (listener: () => void) =>
      session.subscribe ? session.subscribe(listener) : noSubscription(),
    [session],
  );
  const getMark = useCallback(
    () => session.getListMarks?.()?.[list],
    [session, list],
  );
  const mark = useSyncExternalStore(subscribe, getMark, getMark);
  const foreground = useForeground();
  const latest = useRef({ target, mark, load });
  useLayoutEffect(() => {
    latest.current = { target, mark, load };
  });
  const last = useRef<{ target: string; mark?: string; at: number }>(undefined);
  const lastMarkRead = useRef(0);
  /** The target of the read under way, `null` when none. */
  const running = useRef<string | null>(null);
  const runs = useRef(0);
  const again = useRef(false);
  const forced = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** `force`: Refresh, foreground and reconnect read even right after a
   * read; other reasons asked for during a read run again only when that
   * read did not land or the target or mark moved meanwhile. */
  const run = useCallback(async (force = false) => {
    // Another tab, page or record does not wait for the read of the old one
    // (the screen drops that answer); the same target waits and coalesces.
    if (running.current === latest.current.target) {
      if (force) forced.current = true;
      else again.current = true;
      return;
    }
    const generation = ++runs.current;
    try {
      let next = true;
      while (next) {
        again.current = false;
        forced.current = false;
        const { target, mark, load } = latest.current;
        running.current = target;
        const at = Date.now();
        let landed = false;
        try {
          landed = (await load()) !== false;
        } catch {
          landed = false;
        }
        if (generation !== runs.current) return;
        if (landed) last.current = { target, mark, at };
        const now = latest.current;
        next =
          alive.current &&
          (forced.current ||
            (again.current &&
              (!landed ||
                now.target !== target ||
                (now.mark !== undefined && now.mark !== mark))));
      }
    } finally {
      if (generation === runs.current) running.current = null;
    }
  }, []);
  const changed = (current: typeof last.current) =>
    mark !== undefined && current?.mark !== mark;

  // Back from the background, or back online. Runs before the mark
  // effect below, so a mark that moved meanwhile joins this read.
  const wasForeground = useRef(foreground);
  const wasOnline = useRef(online);
  useEffect(() => {
    const returned =
      (foreground && !wasForeground.current) || (online && !wasOnline.current);
    wasForeground.current = foreground;
    wasOnline.current = online;
    if (returned && last.current && foreground && online && (visible || follow))
      void run(true);
    // Only the transitions count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreground, online]);

  // Following starts, the target changes, or the change mark moves.
  useEffect(() => {
    if (!follow || !online || !foreground) return;
    const current = last.current;
    if (!current || current.target !== target) {
      void run();
      return;
    }
    if (!changed(current)) return;
    const wait = lastMarkRead.current + LIST_REFRESH.minGapMs - Date.now();
    const read = () => {
      // Another read (Refresh, foreground) may have brought it meanwhile.
      if (last.current?.mark === latest.current.mark) return;
      lastMarkRead.current = Date.now();
      void run();
    };
    if (wait <= 0) {
      read();
      return;
    }
    const timer = setTimeout(read, wait);
    return () => clearTimeout(timer);
    // `changed` reads `mark`, a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, online, foreground, target, mark, run]);

  // The screen opens: a read older than the window, or before a change.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const opened = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opened || !online || !foreground) return;
    const current = last.current;
    if (
      current &&
      current.target === target &&
      (changed(current) || Date.now() - current.at >= LIST_REFRESH.freshMs)
    )
      void run();
    // Only the opening itself counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // The screen's Refresh always reads while online (coming back online reads
  // anyway).
  const shownVersion = useRef(refreshVersion);
  useEffect(() => {
    if (shownVersion.current === refreshVersion) return;
    shownVersion.current = refreshVersion;
    if (online) void run(true);
    // Only a new version counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshVersion, run]);

  // A server without change marks: a sparse read while followed.
  const marked = mark !== undefined;
  useEffect(() => {
    if (marked || !follow || !online || !foreground) return;
    const timer = setInterval(
      () => void run(),
      processing && visible
        ? LIST_REFRESH.processingMs
        : LIST_REFRESH.fallbackMs,
    );
    return () => clearInterval(timer);
  }, [marked, follow, online, foreground, processing, visible, run]);
}
