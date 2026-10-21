import { hubWidgetDefinition } from "../../packages/protocol/widgets";
import type { HubItemRow, HubScheduledItem } from "./hub-store";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long a scheduled fill waits after a failure, and after two in a row. */
export const HUB_SCHEDULE_BACKOFF_MS = HOUR;
export const HUB_SCHEDULE_REPEATED_BACKOFF_MS = 6 * HOUR;
/** The workspace's budget refused a fill: its widgets wait this long. */
export const HUB_SCHEDULE_BUDGET_PAUSE_MS = HOUR;

export type HubScheduleSettings = {
  /** Seconds between ticks; 0 disables the scheduler. */
  intervalSeconds: number;
  /** Fills started per tick, across everyone. */
  maxPerTick: number;
  /** People who have not opened their hub for this long are left alone. */
  idleDays: number;
};
export const HUB_SCHEDULE_DEFAULTS: HubScheduleSettings = {
  intervalSeconds: 300,
  maxPerTick: 10,
  idleDays: 14,
};

export type HubScheduleSkip =
  | "idle"
  | "running"
  | "backoff"
  | "budget"
  | "person_busy"
  | "limit";
export type HubScheduleTick = {
  /** Scheduled widgets whose data is older than their refresh allows. */
  due: number;
  started: number;
  /** Due widgets not started this tick, by reason. */
  skipped: number;
  reasons: Partial<Record<HubScheduleSkip, number>>;
};
export type HubSchedulerDependencies = {
  /** Every typed widget across all hubs with its owner; nothing starts. */
  scheduled: () => HubScheduledItem[];
  /** Starts one widget's fill under the owner's authority; false when nothing started. */
  launch: (entry: HubScheduledItem) => Promise<boolean> | boolean;
  /** Housekeeping on every tick (expired index rows); its failure stops nothing. */
  sweep?: () => void;
  log?: (
    fields: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  now?: () => number;
};

/** When the widget's data is from, for ordering and due checks. */
function producedAt(item: Pick<HubItemRow, "result" | "createdAt">) {
  const result = item.result;
  return Date.parse(result?.producedAt ?? result?.startedAt ?? item.createdAt);
}
/**
 * Whether the scheduler should fill this widget now by its refresh setting:
 * an AI widget on `hourly` whose data is older than an hour, on `daily`
 * older than a day; `on_open` and `manual` are never scheduled, and a fill
 * in flight or waiting is left alone. Failures are the scheduler's backoff.
 */
export function hubScheduleDue(
  item: Pick<HubItemRow, "kind" | "refresh" | "result" | "widget">,
  now: number,
) {
  if (item.kind !== "widget") return false;
  if (hubWidgetDefinition(item.widget?.type ?? "")?.fill !== "ai") return false;
  if (item.refresh !== "hourly" && item.refresh !== "daily") return false;
  const result = item.result;
  if (!result) return true;
  if (result.status === "running" || result.status === "waiting") return false;
  const at = Date.parse(result.producedAt ?? result.startedAt);
  return now - at >= (item.refresh === "hourly" ? HOUR : DAY);
}

/**
 * Keeps hourly and daily AI widgets fresh between visits: every tick lists
 * every hub's scheduled widgets and starts the fills that are due, through
 * the same path as a refresh on open (`launch`), at most `maxPerTick` per
 * tick and one per person. A widget whose scheduled fill failed waits an
 * hour (six after two failures in a row), a workspace whose budget refused a
 * fill waits an hour, and people who have not opened their hub for
 * `idleDays` are left alone. Nothing here holds a credential: `launch`
 * re-checks the owner's membership and authority.
 */
export class HubScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<HubScheduleTick>;
  private stopped = false;
  /** Scheduled fills that failed, by item: how many in a row and the last one. */
  private failures = new Map<string, { startedAt: string; count: number }>();
  /** Workspaces whose budget refused a scheduled fill, until when. */
  private budget = new Map<string, number>();
  constructor(
    private deps: HubSchedulerDependencies,
    public settings: HubScheduleSettings = HUB_SCHEDULE_DEFAULTS,
  ) {}
  /** New settings from administration; a changed interval restarts the timer. */
  configure(settings: HubScheduleSettings) {
    const restart = settings.intervalSeconds !== this.settings.intervalSeconds;
    this.settings = settings;
    if (!restart || this.stopped) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.start();
  }

  /** Ticks every `intervalSeconds`; a non-positive interval never ticks. */
  start() {
    if (this.timer || this.stopped || !(this.settings.intervalSeconds > 0))
      return false;
    this.timer = setInterval(
      () => void this.tick().catch(() => {}),
      this.settings.intervalSeconds * 1000,
    );
    this.timer.unref();
    return true;
  }
  get active() {
    return !!this.timer;
  }
  /** No further tick starts; the one running (if any) finishes first. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  /** One pass now; a tick already running is shared. */
  tick(): Promise<HubScheduleTick> {
    if (this.running) return this.running;
    const run = this.pass().finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    return run;
  }

  /** Learns from the item's latest result: a streak of scheduled failures ends with any success. */
  private note(entry: HubScheduledItem, now: number) {
    const result = entry.item.result;
    if (!result) return;
    if (result.status === "succeeded") {
      this.failures.delete(entry.item.id);
      return;
    }
    if (result.status !== "failed" || result.source !== "schedule") return;
    const known = this.failures.get(entry.item.id);
    if (!known || known.startedAt !== result.startedAt)
      this.failures.set(entry.item.id, {
        startedAt: result.startedAt,
        count: (known?.count ?? 0) + 1,
      });
    if (result.error?.startsWith("catalog_budget_")) {
      const until = Date.parse(result.startedAt) + HUB_SCHEDULE_BUDGET_PAUSE_MS;
      const current = this.budget.get(entry.owner.workspaceId) ?? 0;
      if (until > current && until > now)
        this.budget.set(entry.owner.workspaceId, until);
    }
  }
  /** Why a due widget is not started now, or null when it may be. */
  private skip(entry: HubScheduledItem, now: number): HubScheduleSkip | null {
    const readAt = entry.readAt === null ? NaN : Date.parse(entry.readAt);
    if (!(now - readAt < this.settings.idleDays * DAY)) return "idle";
    if ((this.budget.get(entry.owner.workspaceId) ?? 0) > now) return "budget";
    const result = entry.item.result;
    if (result?.status === "failed") {
      const count = this.failures.get(entry.item.id)?.count ?? 0;
      const pause =
        count >= 2 ? HUB_SCHEDULE_REPEATED_BACKOFF_MS : HUB_SCHEDULE_BACKOFF_MS;
      if (now - Date.parse(result.startedAt) < pause) return "backoff";
    }
    return null;
  }

  private async pass(): Promise<HubScheduleTick> {
    const now = this.deps.now?.() ?? Date.now();
    const reasons: Partial<Record<HubScheduleSkip, number>> = {};
    const count = (reason: HubScheduleSkip) => {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    const personKey = (entry: HubScheduledItem) =>
      JSON.stringify([entry.owner.workspaceId, entry.owner.userId]);
    if (!this.stopped)
      try {
        this.deps.sweep?.();
      } catch {
        // The next tick tries again.
      }
    const entries = this.stopped ? [] : this.deps.scheduled();
    const busy = new Set<string>();
    for (const entry of entries) {
      this.note(entry, now);
      if (entry.item.result?.status === "running") busy.add(personKey(entry));
    }
    // The oldest due widget per person, oldest people first.
    const perPerson = new Map<string, HubScheduledItem>();
    let due = 0;
    for (const entry of entries) {
      if (!hubScheduleDue(entry.item, now)) continue;
      due++;
      const reason = this.skip(entry, now);
      if (reason) {
        count(reason);
        continue;
      }
      const key = personKey(entry);
      if (busy.has(key)) {
        count("running");
        continue;
      }
      const chosen = perPerson.get(key);
      if (!chosen) perPerson.set(key, entry);
      else if (producedAt(entry.item) < producedAt(chosen.item)) {
        perPerson.set(key, entry);
        count("person_busy");
      } else count("person_busy");
    }
    const picked = [...perPerson.values()].sort(
      (a, b) => producedAt(a.item) - producedAt(b.item),
    );
    let started = 0;
    for (const [index, entry] of picked.entries()) {
      if (this.stopped || index >= this.settings.maxPerTick) {
        count("limit");
        continue;
      }
      let ok = false;
      try {
        ok = await this.deps.launch(entry);
      } catch {
        ok = false;
      }
      if (ok) started++;
      else count("running");
    }
    const skipped = Object.values(reasons).reduce((a, b) => a + b, 0);
    const tick: HubScheduleTick = { due, started, skipped, reasons };
    if (entries.length || due)
      this.deps.log?.({
        due,
        started,
        skipped,
        ...Object.fromEntries(
          Object.entries(reasons).map(([key, value]) => [
            `skipped_${key}`,
            value,
          ]),
        ),
      });
    return tick;
  }
}
