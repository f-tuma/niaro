import type { Scope } from "../../packages/protocol";
import {
  HUB_PROFILE,
  HUB_PROFILE_V2,
  HUB_PROFILE_V3,
  HUB_TITLE_MAX,
  HubCommandAnySchema,
  HubDashboardSchema,
  HubDashboardV3Schema,
  HubItemDetailSchema,
  HubOutputSchema,
  HubViewSchema,
  HubWidgetViewSchema,
  hubConversationId,
  hubEligibleInput,
  type HubCard,
  type HubDashboard,
  type HubDashboardV3,
  type HubField,
  type HubLayout,
  type HubOutput,
  type HubRefresh,
  type HubResult,
  type HubResultSource,
  type HubView,
  type HubWidgetType,
  type HubWidgetView,
} from "../../packages/protocol/hub";
import {
  hubDefaultView,
  hubResolveView,
  hubViewChoices,
  hubViewFor,
} from "../../packages/protocol/hub-dashboard";
import {
  HUB_WIDGET_TYPES,
  hubWidgetConfig,
  hubWidgetDefinition,
} from "../../packages/protocol/widgets";
import type { ProcessExecutionEntry } from "../../packages/protocol/process-execution";
import type { ProcessStartAdmission } from "../../packages/protocol/process-start";
import { IdentityError } from "./error";
import {
  TEXT_KEYS,
  clip,
  humanLabel,
  hubFields,
  hubSnapshot,
  hubText,
  hubWidgetData,
  sensitiveKey,
} from "./hub-widgets";
import type {
  HubItemRow,
  HubOpenRecipe,
  HubShape,
  HubStore,
  HubStoredWidget,
} from "./hub-store";
import { HUB_PREFETCH_LIMIT } from "./hub-fill";
import type { ProcessStartStore } from "./process-start-store";
import type { ProcessActor, ServiceProcessStore } from "./service-processes";
import { JournalSchema, type Journal } from "./service-process-journal";

const MINUTE = 60_000;
/** "On open" still waits this long, so reopening the page does not rerun everything. */
const ON_OPEN_PAUSE = 5 * MINUTE;
const FAILED_PAUSE = 15 * MINUTE;
const tasksTitle = (language: "en" | "cs") =>
  language === "cs" ? "Úkoly" : "Tasks";

/**
 * A compact, redacted reading of a process output for the hub card and the
 * agent: one readable text, then up to twelve labelled values or short lists.
 * Key order is the process's own. Never raw JSON and never a hidden value.
 */
export function hubOutput(raw: unknown): HubOutput {
  let redacted = false,
    truncated = false;
  const safe = (value: string, limit: number) => {
    const clean = hubText(value);
    if (clean !== value) redacted = true;
    if (clean.length > limit) truncated = true;
    return clip(clean, limit);
  };
  const scalar = (value: unknown, limit: number): string | undefined => {
    if (typeof value === "string") return safe(value, limit);
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (typeof value === "boolean") return value ? "✓" : "✗";
    return undefined;
  };
  const entries = (value: object) =>
    Object.entries(value).filter(([key]) => {
      if (sensitiveKey(key)) {
        redacted = true;
        return false;
      }
      return true;
    });
  const line = (value: unknown): string | undefined => {
    const direct = scalar(value, 500);
    if (direct !== undefined) return direct;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const parts = entries(value)
        .map(([, item]) => scalar(item, 200))
        .filter((item): item is string => !!item)
        .slice(0, 3);
      return parts.length ? clip(parts.join(", "), 500) : undefined;
    }
    return undefined;
  };
  const output: HubOutput = { fields: [], truncated: false, redacted: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return HubOutputSchema.parse(output);
  const all = entries(raw);
  const textKey =
    all.length === 1 && typeof all[0]![1] === "string"
      ? all[0]![0]
      : all.find(
          ([key, value]) =>
            typeof value === "string" &&
            value.trim() &&
            TEXT_KEYS.includes(key.toLowerCase()),
        )?.[0];
  for (const [key, value] of all) {
    if (key === textKey) {
      output.text = safe(String(value), 4000);
      continue;
    }
    if (output.fields.length >= 12) {
      truncated = true;
      break;
    }
    const label = safe(humanLabel(key), 160);
    if (Array.isArray(value)) {
      const items = value
        .map(line)
        .filter((item): item is string => item !== undefined);
      if (!items.length) continue;
      output.fields.push({
        label,
        items: items.slice(0, 8),
        ...(items.length > 8 ? { more: items.length - 8 } : {}),
      });
      continue;
    }
    const text =
      value && typeof value === "object"
        ? entries(value)
            .map(([k, item]) => {
              const part = scalar(item, 200);
              return part === undefined
                ? undefined
                : `${humanLabel(k)}: ${part}`;
            })
            .filter(Boolean)
            .slice(0, 6)
            .join(", ")
        : scalar(value, 1000);
    if (text) output.fields.push({ label, value: clip(text, 1000) });
  }
  output.truncated = truncated;
  output.redacted = redacted;
  return HubOutputSchema.parse(output);
}

/** A smaller reading for the model's context: the gist, not every value. */
function agentOutput(output: HubOutput) {
  return {
    ...(output.text ? { text: clip(output.text, 1000) } : {}),
    fields: output.fields.slice(0, 6).map((field) => ({
      label: field.label,
      ...(field.value !== undefined ? { value: clip(field.value, 300) } : {}),
      ...(field.items
        ? {
            items: field.items.slice(0, 5).map((item) => clip(item, 200)),
            ...((field.more ?? 0) + Math.max(0, field.items.length - 5)
              ? {
                  more: (field.more ?? 0) + Math.max(0, field.items.length - 5),
                }
              : {}),
          }
        : {}),
    })),
  };
}

/** The latest result of a hub run, read from its journal; no execution. */
export function hubRunResult(
  admission: ProcessStartAdmission,
  journal: Journal,
  previous: HubResult | null,
  now: number,
): HubResult {
  const kept = {
    producedAt: previous?.producedAt ?? null,
    ...(previous?.output ? { output: previous.output } : {}),
  };
  const base = {
    startedAt: admission.createdAt,
    runId: admission.parentRunId,
    conversationId: admission.origin.conversationId,
    ...(previous?.source ? { source: previous.source } : {}),
  };
  if (journal.status === "succeeded")
    return {
      ...base,
      status: "succeeded",
      producedAt: journal.trace.finishedAt ?? new Date(now).toISOString(),
      output: hubOutput(journal.output ?? {}),
    };
  if (journal.status === "waiting")
    return {
      ...base,
      ...kept,
      status: "waiting",
      waiting:
        journal.pending && "kind" in journal.pending ? "question" : "approval",
    };
  if (journal.status === "running")
    return { ...base, ...kept, status: "running" };
  const code = journal.failure?.code ?? `process_${journal.status}`;
  return {
    ...base,
    ...kept,
    status: "failed",
    error: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "process_failed",
  };
}

function dayIn(time: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(time);
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
}
/** Whether opening the hub should refresh this item now. */
export function hubItemStale(
  item: Pick<HubItemRow, "kind" | "refresh" | "result"> & {
    widget?: Pick<HubStoredWidget, "type" | "requested"> | null;
  },
  now: number,
  timeZone?: string,
) {
  if (item.kind === "tasks") return false;
  // Built-in widgets read their data on every view; only AI widgets refresh.
  if (
    item.kind === "widget" &&
    hubWidgetDefinition(item.widget?.type ?? "")?.fill !== "ai"
  )
    return false;
  const result = item.result;
  // Asked for (by the assistant on a widget the person confirmed): next open.
  if (item.widget?.requested && result && result.status !== "running")
    return true;
  // A manual item never runs on open, not even the first time (the agent adds
  // items this way; the person starts the first refresh).
  if (!result) return item.refresh !== "manual";
  if (result.status === "running" || result.status === "waiting") return false;
  // A failed refresh keeps the last good output and retries on a later open.
  if (result.status === "failed")
    return (
      item.refresh !== "manual" &&
      now - Date.parse(result.startedAt) >= FAILED_PAUSE
    );
  const at = Date.parse(result.producedAt ?? result.startedAt);
  switch (item.refresh) {
    case "manual":
      return false;
    case "on_open":
      return now - at >= ON_OPEN_PAUSE;
    case "hourly":
      return now - at >= 60 * MINUTE;
    case "daily":
      return (
        now - at >= 24 * 60 * MINUTE ||
        dayIn(at, timeZone) !== dayIn(now, timeZone)
      );
  }
}

/** Every page of the person's start inventory, checked again on each call. */
export function hubInventory(
  processes: Pick<ServiceProcessStore, "executionInventory">,
  actor: ProcessActor,
  scope: Scope,
) {
  const entries: ProcessExecutionEntry[] = [];
  let query: { after?: string; fingerprint?: string } = {};
  for (let page = 0; page < 11; page++) {
    const result = processes.executionInventory(actor, scope, query);
    entries.push(...result.processes);
    if (!result.nextAfter) return entries;
    query = { after: result.nextAfter, fingerprint: result.fingerprint };
  }
  throw new IdentityError(409, "process_inventory_limit");
}
/** Ready processes that start without input: the only ones a hub can hold
 * (the hub also requires that they write nothing unattended, see createHub). */
export function hubAddable(entries: ProcessExecutionEntry[]) {
  return entries.flatMap((entry) =>
    entry.availability === "ready" && hubEligibleInput(entry.inputSchema)
      ? [entry]
      : [],
  );
}

export type HubDependencies = {
  store: HubStore;
  processes: Pick<
    ServiceProcessStore,
    "executionInventory" | "unattendedEffect" | "activeOutputSchema"
  >;
  starts: () => Pick<ProcessStartStore, "forParent"> | undefined;
  /** The saved native journal of a parent run, as the coordinator reads it. */
  journal: (
    parentRunId: string,
    workspaceId: string,
    userId: string,
  ) => unknown;
  humanTasks: {
    open: (scope: Scope, limit: number) => { id: string; title: string }[];
    openCount: (scope: Scope) => number;
  };
  timeZone?: (workspaceId: string) => string | undefined;
  /** The person's recent meetings, for the built-in Meetings widget. */
  meetings?: (scope: Scope, limit: number) => unknown[];
  /** Services the person can read from now; a widget's sources must be among them. */
  services?: (actor: ProcessActor) => { id: string; name: string }[];
  now?: () => number;
};
export type HubRunOutcome =
  | { type: "admitted"; parentRunId: string }
  /** An AI widget's fill stored its data (see `fillDone`). */
  | { type: "filled" }
  | { type: "failed"; error: string };

/**
 * The hub's domain: reading (with passive run status), the person's own
 * changes and the run bookkeeping. The caller authenticates the person; this
 * re-reads their current process inventory for every add and never starts,
 * resumes or approves anything itself.
 */
export function createHub(deps: HubDependencies) {
  const now = deps.now ?? Date.now;
  /** Items whose refresh this server is running now (lost on restart). */
  const active = new Map<string, number>();
  const owner = (actor: ProcessActor) => ({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
  });
  const activeKey = (actor: ProcessActor, itemId: string) =>
    JSON.stringify([actor.workspaceId, actor.userId, itemId]);
  /**
   * Whether the hub may run this version with nobody watching: each service
   * action it can call only reads, or waits for the person's approval under
   * the current catalog policy. Checked on add and again on every refresh.
   */
  const unattended = (actor: ProcessActor, entry: ProcessExecutionEntry) =>
    deps.processes.unattendedEffect(actor, entry.processId, {
      version: entry.version,
      artifactDigest: entry.artifactDigest,
    }) !== "write";
  /** The output's fields of exactly this version; null when it can't be read. */
  const shapeOf = (
    actor: ProcessActor,
    entry: ProcessExecutionEntry,
  ): HubShape | null => {
    const schema = deps.processes.activeOutputSchema(actor, entry.processId, {
      version: entry.version,
      artifactDigest: entry.artifactDigest,
    });
    const fields = schema ? hubFields(schema) : null;
    return fields
      ? {
          version: entry.version,
          artifactDigest: entry.artifactDigest,
          fields,
        }
      : null;
  };
  /** Items whose fields could not be read on a view; not retried until a refresh. */
  const unreadable = new Set<string>();
  /** A run's result, with its output kept for the widget when it succeeded. */
  function settle(
    actor: ProcessActor,
    itemId: string,
    next: HubResult,
    journal: { output?: unknown },
  ) {
    deps.store.setResult(owner(actor), itemId, next);
    if (next.status === "succeeded") {
      const snapshot = hubSnapshot(journal.output ?? {});
      if (snapshot) deps.store.setSnapshot(owner(actor), itemId, snapshot);
    }
  }

  /** Brings running and waiting results up to date from their journals. */
  function sync(actor: ProcessActor, scope: Scope, item: HubItemRow) {
    const result = item.result;
    // A fill this server no longer runs (e.g. after a restart) is over.
    if (
      item.kind === "widget" &&
      result?.status === "running" &&
      !active.has(activeKey(actor, item.id))
    ) {
      const next: HubResult = {
        ...result,
        status: "failed",
        error: "hub_refresh_interrupted",
      };
      deps.store.setResult(owner(actor), item.id, next);
      return next;
    }
    if (
      item.kind !== "process" ||
      !result ||
      (result.status !== "running" && result.status !== "waiting") ||
      active.has(activeKey(actor, item.id))
    )
      return result;
    let next: HubResult;
    let output: unknown;
    if (!result.runId)
      next = {
        ...result,
        status: "failed",
        error: "hub_refresh_interrupted",
      };
    else {
      try {
        const saved = deps.starts()?.forParent(actor, scope, result.runId);
        if (!saved || saved.receipt.status !== "admitted")
          throw new IdentityError(404, "process_start_not_found");
        const journal = JournalSchema.parse(
          deps.journal(result.runId, scope.workspaceId, scope.userId),
        );
        next = hubRunResult(saved.receipt, journal, result, now());
        output = journal.output;
        // Nothing continues a run this server no longer owns.
        if (next.status === "running")
          next = {
            ...next,
            status: "failed",
            error: "hub_refresh_interrupted",
          };
      } catch {
        next = { ...result, status: "failed", error: "hub_run_unavailable" };
      }
    }
    settle(actor, item.id, next, { output });
    return next;
  }

  /** Fills in the output fields of items that have none yet (older items). */
  function fillShapes(actor: ProcessActor, scope: Scope, items: HubItemRow[]) {
    const missing = items.filter(
      (item) =>
        item.kind === "process" &&
        !item.shape &&
        !unreadable.has(activeKey(actor, item.id)),
    );
    if (!missing.length) return items;
    let inventory: ProcessExecutionEntry[] = [];
    try {
      inventory = hubInventory(deps.processes, actor, scope);
    } catch {
      // Read again on a later view.
    }
    return items.map((item) => {
      if (!missing.includes(item)) return item;
      const entry = inventory.find(
        (value) => value.processId === item.processId,
      );
      const shape = entry ? shapeOf(actor, entry) : null;
      if (!shape) {
        unreadable.add(activeKey(actor, item.id));
        return item;
      }
      deps.store.setShape(owner(actor), item.id, shape);
      return { ...item, shape };
    });
  }

  /** A widget's data as the person sees it: built-ins read the server now. */
  function widgetState(
    scope: Scope,
    item: HubItemRow,
  ): NonNullable<HubCard["widget"]> {
    const widget = item.widget!;
    const definition = hubWidgetDefinition(widget.type);
    let data = widget.data;
    if (definition?.fill === "server" && definition.type === "meetings") {
      const count = Number(
        hubWidgetConfig(widget.type, widget.config)?.count ?? 4,
      );
      const parsed = definition.data.safeParse({
        meetings: deps.meetings?.(scope, count) ?? [],
      });
      data = parsed.success ? parsed.data : null;
    } else if (definition?.fill === "client") data = null;
    return {
      type: widget.type,
      version: widget.version,
      // A type this build doesn't know is never filled.
      fill: definition?.fill ?? "client",
      brief: widget.brief,
      config: widget.config,
      sources: widget.sources,
      data: definition?.version === widget.version ? (data ?? null) : null,
      recipe: widget.recipe
        ? {
            services: widget.recipe.services.slice(0, 6),
            reads: Math.min(12, widget.recipe.calls.length),
          }
        : null,
      requested: widget.requested,
    };
  }
  /** The person's dashboard (agent-hub/3); reading never starts a refresh. */
  function cards(
    actor: ProcessActor,
    scope: Scope,
    language: "en" | "cs",
  ): HubDashboardV3 {
    const hub = deps.store.read(owner(actor), tasksTitle(language));
    const time = now();
    const zone = deps.timeZone?.(actor.workspaceId);
    const items = fillShapes(actor, scope, hub.items).map((item): HubCard => {
      const result = sync(actor, scope, item);
      // A result settled just now brought a new output.
      const snapshot =
        result !== item.result && result?.status === "succeeded"
          ? deps.store.item(owner(actor), item.id).snapshot
          : item.snapshot;
      const fields = item.shape?.fields ?? null;
      return {
        id: item.id,
        kind: item.kind,
        ...(item.processId ? { processId: item.processId } : {}),
        title: item.title,
        refresh: item.refresh,
        position: item.position,
        createdAt: item.createdAt,
        result,
        stale: hubItemStale({ ...item, result }, time, zone),
        layout: item.layout,
        view: item.view,
        data:
          item.kind === "process"
            ? hubWidgetData(
                item.view,
                fields,
                snapshot?.current ?? null,
                snapshot?.previous ?? null,
              )
            : null,
        fields:
          item.kind === "process" ? fields : item.kind === "tasks" ? [] : null,
        widget: item.kind === "widget" ? widgetState(scope, item) : null,
      };
    });
    return HubDashboardV3Schema.parse({
      profile: HUB_PROFILE_V3,
      scope,
      revision: hub.revision,
      items,
      tasks: {
        open: deps.humanTasks.openCount(scope),
        top: deps.humanTasks
          .open(scope, 3)
          .map((task) => ({ id: task.id, title: task.title.slice(0, 1000) })),
      },
    });
  }
  /** agent-hub/2: Tasks and process widgets only (typed widgets are /3). */
  const dashboardV2 = (value: HubDashboardV3): HubDashboard =>
    HubDashboardSchema.parse({
      profile: HUB_PROFILE_V2,
      scope: value.scope,
      revision: value.revision,
      items: value.items
        .filter((item) => item.kind !== "widget")
        .map(({ widget: _widget, ...item }) => item),
      tasks: value.tasks,
    });
  function dashboard(actor: ProcessActor, scope: Scope, language: "en" | "cs") {
    return dashboardV2(cards(actor, scope, language));
  }
  /** agent-hub/1: the same items in order, without widgets. */
  const legacy = (value: HubDashboard): HubView =>
    HubViewSchema.parse({
      profile: HUB_PROFILE,
      scope: value.scope,
      revision: value.revision,
      items: value.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        ...(item.processId ? { processId: item.processId } : {}),
        title: item.title,
        refresh: item.refresh,
        position: item.position,
        createdAt: item.createdAt,
        result: item.result,
        stale: item.stale,
      })),
      tasks: value.tasks,
    });
  function view(actor: ProcessActor, scope: Scope, language: "en" | "cs") {
    return legacy(dashboard(actor, scope, language));
  }

  /** A view checked against the item's output fields, with defaults filled. */
  function checkedView(
    kind: "tasks" | "process",
    view: HubWidgetView,
    fields: HubField[] | null,
  ) {
    const resolved = hubResolveView(view, kind, fields);
    if ("error" in resolved) throw new IdentityError(409, "hub_view_invalid");
    return resolved.view;
  }
  /** The ready, eligible inventory entry of a process, or why it isn't. */
  function eligibleEntry(actor: ProcessActor, scope: Scope, processId: string) {
    const entry = hubInventory(deps.processes, actor, scope).find(
      (value) => value.processId === processId,
    );
    if (!entry) throw new IdentityError(404, "hub_process_unavailable");
    if (entry.availability !== "ready")
      throw new IdentityError(409, "hub_process_unavailable");
    if (!hubEligibleInput(entry.inputSchema))
      throw new IdentityError(409, "hub_process_needs_input");
    if (!unattended(actor, entry))
      throw new IdentityError(409, "hub_process_writes");
    return entry;
  }

  function addProcess(
    actor: ProcessActor,
    scope: Scope,
    language: "en" | "cs",
    input: {
      id?: string;
      processId: string;
      title?: string;
      refresh?: HubRefresh;
      /** Checked against the output; chosen from it when absent. */
      view?: HubWidgetView;
      layout?: HubLayout;
      size?: { w: number; h: number };
    },
  ) {
    const entry = eligibleEntry(actor, scope, input.processId);
    const shape = shapeOf(actor, entry);
    const fields = shape?.fields ?? null;
    const view = input.view
      ? checkedView("process", input.view, fields)
      : hubDefaultView("process", fields);
    return deps.store.add(owner(actor), tasksTitle(language), {
      ...(input.id ? { id: input.id } : {}),
      kind: "process",
      processId: entry.processId,
      title: (input.title ?? entry.name).trim().slice(0, HUB_TITLE_MAX),
      refresh: input.refresh ?? "daily",
      view,
      ...(input.layout
        ? { layout: input.layout }
        : input.size
          ? { layout: { x: 0, y: 0, ...input.size } }
          : {}),
      ...(shape ? { shape } : {}),
    });
  }
  /** A new view for one widget, checked against its output as it is now. */
  function changeView(
    actor: ProcessActor,
    scope: Scope,
    itemId: string,
    view: HubWidgetView,
    size?: { w: number; h: number },
  ) {
    const item = deps.store.item(owner(actor), itemId);
    if (item.kind === "widget")
      throw new IdentityError(409, "hub_view_invalid");
    if (item.kind === "tasks")
      return deps.store.setView(
        owner(actor),
        itemId,
        checkedView("tasks", view, []),
        null,
        size,
      );
    const entry = eligibleEntry(actor, scope, item.processId!);
    const shape = shapeOf(actor, entry);
    unreadable.delete(activeKey(actor, itemId));
    return deps.store.setView(
      owner(actor),
      itemId,
      checkedView("process", view, shape?.fields ?? null),
      shape,
      size,
    );
  }

  /** The services a widget may read from, resolved and checked now. */
  function sourcesOf(actor: ProcessActor, ids: string[] | undefined) {
    if (!ids?.length) return [];
    const usable = deps.services?.(actor) ?? [];
    return [...new Set(ids)].map((id) => {
      const found = usable.find((service) => service.id === id);
      if (!found) throw new IdentityError(409, "hub_source_unavailable");
      return { id: found.id, name: found.name.slice(0, 120) };
    });
  }
  /** A typed widget's request, checked against its type now. */
  function widgetInput(
    actor: ProcessActor,
    language: "en" | "cs",
    input: {
      type: string;
      brief?: string;
      config?: Record<string, unknown>;
      sources?: string[];
    },
  ) {
    const definition = hubWidgetDefinition(input.type);
    if (!definition) throw new IdentityError(409, "hub_widget_invalid");
    const config = hubWidgetConfig(definition.type, input.config ?? {});
    if (!config) throw new IdentityError(409, "hub_widget_invalid");
    const brief =
      definition.fill === "ai"
        ? (input.brief?.trim() || definition.brief?.[language] || "").slice(
            0,
            1000,
          )
        : "";
    if (definition.fill === "ai" && !brief)
      throw new IdentityError(409, "hub_widget_invalid");
    return {
      definition,
      widget: {
        type: definition.type,
        version: definition.version,
        brief,
        config,
        sources:
          definition.fill === "ai" ? sourcesOf(actor, input.sources) : [],
      },
    };
  }
  function addWidget(
    actor: ProcessActor,
    language: "en" | "cs",
    input: {
      id?: string;
      type: string;
      brief?: string;
      config?: Record<string, unknown>;
      sources?: string[];
      title?: string;
      refresh?: HubRefresh;
      layout?: HubLayout;
      size?: { w: number; h: number };
    },
  ) {
    const { definition, widget } = widgetInput(actor, language, input);
    return deps.store.add(owner(actor), tasksTitle(language), {
      ...(input.id ? { id: input.id } : {}),
      kind: "widget",
      title: (input.title?.trim() || definition.name[language]).slice(
        0,
        HUB_TITLE_MAX,
      ),
      refresh:
        definition.fill === "ai"
          ? (input.refresh ?? definition.refresh)
          : "on_open",
      widget,
      ...(input.layout
        ? { layout: input.layout }
        : input.size
          ? { layout: { x: 0, y: 0, ...input.size } }
          : {}),
    });
  }
  /** A typed widget's new request, settings, sources or size. */
  function changeWidget(
    actor: ProcessActor,
    language: "en" | "cs",
    itemId: string,
    change: {
      brief?: string;
      config?: Record<string, unknown>;
      sources?: string[];
      size?: { w: number; h: number };
    },
  ) {
    const item = deps.store.item(owner(actor), itemId);
    if (item.kind !== "widget" || !item.widget)
      throw new IdentityError(409, "hub_widget_invalid");
    const { widget } = widgetInput(actor, language, {
      type: item.widget.type,
      brief: change.brief ?? item.widget.brief,
      config: { ...item.widget.config, ...(change.config ?? {}) },
      sources: change.sources ?? item.widget.sources.map((source) => source.id),
    });
    return deps.store.setWidget(owner(actor), itemId, {
      ...(change.brief !== undefined ? { brief: widget.brief } : {}),
      ...(change.config !== undefined ? { config: widget.config } : {}),
      ...(change.sources !== undefined ? { sources: widget.sources } : {}),
      ...(change.size ? { size: change.size } : {}),
    });
  }

  /**
   * Marks the items as refreshing; the caller starts each returned id. Every
   * id is checked before anything changes, and the marks are written together.
   * A process that would now write unattended is not started.
   */
  function begin(
    actor: ProcessActor,
    scope: Scope,
    ids: string[],
    source: HubResultSource,
  ) {
    const hub = deps.store.read(owner(actor), tasksTitle("en"));
    const items = ids.map((id) => {
      const item = hub.items.find((value) => value.id === id);
      if (!item) throw new IdentityError(404, "hub_item_not_found");
      return item;
    });
    const due = items.filter(
      (item) =>
        (item.kind === "process" ||
          (item.kind === "widget" &&
            hubWidgetDefinition(item.widget?.type ?? "")?.fill === "ai")) &&
        !active.has(activeKey(actor, item.id)),
    );
    if (!due.length) return [];
    const inventory = due.some((item) => item.kind === "process")
      ? hubInventory(deps.processes, actor, scope)
      : [];
    const at = new Date(now()).toISOString();
    const started = deps.store.transaction(() =>
      due.flatMap((item) => {
        // An AI widget is filled by the runner under the live credential.
        if (item.kind === "widget") {
          deps.store.setResult(owner(actor), item.id, {
            status: "running",
            startedAt: at,
            producedAt: item.result?.producedAt ?? null,
            source,
          });
          if (item.widget?.requested)
            deps.store.setWidgetFill(owner(actor), item.id, {
              requested: false,
            });
          return [item.id];
        }
        const previous = item.result;
        const kept = {
          producedAt: previous?.producedAt ?? null,
          conversationId: hubConversationId(item.id),
          ...(previous?.output ? { output: previous.output } : {}),
        };
        const entry = inventory.find(
          (value) => value.processId === item.processId,
        );
        if (
          entry?.availability === "ready" &&
          (item.shape?.version !== entry.version ||
            item.shape.artifactDigest !== entry.artifactDigest)
        ) {
          const shape = shapeOf(actor, entry);
          if (shape) deps.store.setShape(owner(actor), item.id, shape);
          unreadable.delete(activeKey(actor, item.id));
        }
        // Unavailable processes are reported by the runner's own checks.
        if (entry?.availability === "ready" && !unattended(actor, entry)) {
          deps.store.setResult(owner(actor), item.id, {
            status: "failed",
            startedAt: at,
            ...kept,
            error: "hub_process_writes",
            source,
          });
          return [];
        }
        deps.store.setResult(owner(actor), item.id, {
          status: "running",
          startedAt: at,
          ...kept,
          source,
        });
        return [item.id];
      }),
    );
    for (const id of started) active.set(activeKey(actor, id), now());
    return started;
  }

  function command(
    actor: ProcessActor,
    scope: Scope,
    language: "en" | "cs",
    raw: unknown,
  ): { view: HubView | HubDashboard | HubDashboardV3; refresh: string[] } {
    const input = HubCommandAnySchema.parse(raw);
    let refresh: string[] = [];
    const who = owner(actor);
    /** Items an older profile cannot see: typed widgets. */
    const hidden = () =>
      input.profile === HUB_PROFILE_V3
        ? []
        : deps.store
            .read(who, tasksTitle(language))
            .items.filter((item) => item.kind === "widget");
    switch (input.type) {
      case "add": {
        const placement =
          "layout" in input && input.layout ? { layout: input.layout } : {};
        const chosen = "view" in input ? input.view : undefined;
        if (input.kind === "widget") {
          const widget = "widget" in input ? input.widget : undefined;
          if (!widget || input.processId)
            throw new IdentityError(400, "identity_invalid_input");
          const item = addWidget(actor, language, {
            type: widget.type,
            brief: widget.brief,
            config: widget.config,
            sources: widget.sources,
            title: input.title,
            refresh: input.refresh,
            ...placement,
          });
          // The person added it, so it fills right away.
          refresh = begin(actor, scope, [item.id], "manual");
        } else if (input.kind === "tasks")
          deps.store.add(who, tasksTitle(language), {
            kind: "tasks",
            title: input.title ?? tasksTitle(language),
            refresh: "on_open",
            ...(chosen ? { view: checkedView("tasks", chosen, []) } : {}),
            ...placement,
          });
        else {
          if (!input.processId)
            throw new IdentityError(400, "identity_invalid_input");
          const item = addProcess(actor, scope, language, {
            processId: input.processId,
            title: input.title,
            refresh: input.refresh,
            ...(chosen ? { view: chosen } : {}),
            ...placement,
          });
          // The person added it, so it shows its first result right away.
          refresh = begin(actor, scope, [item.id], "manual");
        }
        break;
      }
      case "setView":
        changeView(actor, scope, input.itemId, input.view);
        break;
      case "setWidget": {
        changeWidget(actor, language, input.itemId, input);
        // The person changed what it shows: it fills again now.
        refresh = begin(actor, scope, [input.itemId], "manual");
        break;
      }
      case "layout":
        // An older profile's grid keeps the typed widgets where they are.
        deps.store.setLayout(who, [
          ...input.items,
          ...hidden().map((item) => ({ itemId: item.id, layout: item.layout })),
        ]);
        break;
      case "remove":
        deps.store.remove(who, input.itemId);
        active.delete(activeKey(actor, input.itemId));
        break;
      case "rename":
        deps.store.update(who, input.itemId, { title: input.title });
        break;
      case "setRefresh":
        deps.store.update(who, input.itemId, { refresh: input.refresh });
        break;
      case "reorder":
        deps.store.reorder(who, [
          ...input.itemIds,
          ...hidden().map((item) => item.id),
        ]);
        break;
      case "refresh": {
        const ids = input.stale
          ? cards(actor, scope, language)
              .items.filter((item) => item.stale)
              .map((item) => item.id)
          : (input.itemIds ?? []);
        // What is due on open, or the items the person asked for.
        refresh = begin(actor, scope, ids, input.stale ? "open" : "manual");
        break;
      }
    }
    const next = cards(actor, scope, language);
    return {
      view:
        input.profile === HUB_PROFILE_V3
          ? next
          : input.profile === HUB_PROFILE_V2
            ? dashboardV2(next)
            : legacy(dashboardV2(next)),
      refresh,
    };
  }

  /** The runner's outcome for one refresh; status comes from the run itself. */
  function record(
    actor: ProcessActor,
    scope: Scope,
    itemId: string,
    outcome: HubRunOutcome,
  ) {
    active.delete(activeKey(actor, itemId));
    let item: HubItemRow;
    try {
      item = deps.store.item(owner(actor), itemId);
    } catch {
      return; // Removed meanwhile.
    }
    const previous = item.result;
    // A filled widget's data was stored by the fill itself.
    if (outcome.type === "filled") return;
    if (outcome.type === "failed") {
      deps.store.setResult(owner(actor), itemId, {
        status: "failed",
        startedAt: previous?.startedAt ?? new Date(now()).toISOString(),
        producedAt: previous?.producedAt ?? null,
        // Only a process run has a chat to follow.
        ...(item.kind === "process"
          ? { conversationId: hubConversationId(itemId) }
          : {}),
        error: /^[a-z][a-z0-9_]{0,63}$/.test(outcome.error)
          ? outcome.error
          : "hub_refresh_failed",
        ...(previous?.output ? { output: previous.output } : {}),
        ...(previous?.source ? { source: previous.source } : {}),
      });
      return;
    }
    const saved = deps.starts()?.forParent(actor, scope, outcome.parentRunId);
    if (
      !saved ||
      saved.receipt.status !== "admitted" ||
      saved.receipt.processId !== item.processId ||
      saved.receipt.origin.conversationId !== hubConversationId(itemId)
    )
      throw new IdentityError(409, "hub_run_mismatch");
    const journal = JournalSchema.parse(
      deps.journal(outcome.parentRunId, scope.workspaceId, scope.userId),
    );
    settle(
      actor,
      itemId,
      hubRunResult(saved.receipt, journal, previous, now()),
      journal,
    );
  }

  /** What one AI widget's fill needs, read now under the person's authority. */
  function fillRequest(actor: ProcessActor, itemId: string) {
    const item = deps.store.item(owner(actor), itemId);
    const widget = item.widget;
    const definition = hubWidgetDefinition(widget?.type ?? "");
    if (
      item.kind !== "widget" ||
      !widget ||
      definition?.fill !== "ai" ||
      definition.version !== widget.version
    )
      throw new IdentityError(409, "hub_widget_invalid");
    return {
      type: widget.type,
      brief: widget.brief,
      config: widget.config,
      sources: widget.sources,
      recipe: widget.recipe,
      timeZone: deps.timeZone?.(actor.workspaceId),
    };
  }
  /**
   * What opening one item of an AI widget in full needs: the widget as it
   * is now (an inbox at the current version) and the row the person opened,
   * found by the id the source gave it. Nothing changes.
   */
  /** The widget's rows that can be opened: inbox emails with the source's id. */
  function openable(actor: ProcessActor, itemId: string) {
    const item = deps.store.item(owner(actor), itemId);
    const widget = item.widget;
    const definition = hubWidgetDefinition(widget?.type ?? "");
    if (
      item.kind !== "widget" ||
      !widget ||
      definition?.fill !== "ai" ||
      definition.version !== widget.version ||
      definition.type !== "inbox"
    )
      throw new IdentityError(409, "hub_widget_invalid");
    const data = definition.data.safeParse(widget.data);
    const rows = data.success
      ? (data.data as { emails: Record<string, unknown>[] }).emails.filter(
          (entry) => typeof entry.id === "string" && entry.id,
        )
      : [];
    return {
      widget,
      rows: rows.map((entry) => ({
        ref: String(entry.id),
        hint: {
          from: String(entry.from),
          subject: String(entry.subject),
          receivedAt: String(entry.receivedAt),
        },
      })),
      base: {
        type: widget.type,
        sources: widget.sources,
        recipe: widget.recipe,
        open: widget.recipe?.open ?? null,
        timeZone: deps.timeZone?.(actor.workspaceId),
      },
    };
  }
  function openRequest(actor: ProcessActor, itemId: string, ref: string) {
    const { rows, base } = openable(actor, itemId);
    const row = rows.find((entry) => entry.ref === ref);
    if (!row) throw new IdentityError(409, "hub_item_unknown");
    return { ...base, ref, hint: row.hint };
  }
  /** The item's detail from the index, while fresh; null otherwise. */
  function openCached(actor: ProcessActor, itemId: string, ref: string) {
    const row = deps.store.detail(owner(actor), itemId, ref, now());
    const detail = row && HubItemDetailSchema.safeParse(row.detail);
    return detail?.success ? detail.data : null;
  }
  /**
   * An opened item's detail goes into the index; the read the agent used
   * (`learned`) becomes the widget's open recipe. False when removed meanwhile.
   */
  function openDone(
    actor: ProcessActor,
    itemId: string,
    ref: string,
    detail: unknown,
    learned?: HubOpenRecipe,
  ) {
    const parsed = HubItemDetailSchema.safeParse(detail);
    if (!parsed.success) throw new IdentityError(422, "hub_open_failed");
    let item: HubItemRow;
    try {
      item = deps.store.item(owner(actor), itemId);
    } catch {
      return false;
    }
    const revision =
      learned?.actionRevision ?? item.widget?.recipe?.open?.actionRevision ?? 0;
    deps.store.transaction(() => {
      deps.store.saveDetail(
        owner(actor),
        itemId,
        ref,
        parsed.data,
        revision,
        new Date(now()).toISOString(),
      );
      if (learned) deps.store.setWidgetOpen(owner(actor), itemId, learned);
    });
    return true;
  }
  /**
   * What a background prefetch opens: the widget's rows not fresh in the
   * index, at most `HUB_PREFETCH_LIMIT`; none without a learned open recipe.
   */
  function prefetchRequest(actor: ProcessActor, itemId: string) {
    const { rows, base } = openable(actor, itemId);
    if (!base.open) return { ...base, refs: [] };
    const fresh = new Set(deps.store.details(owner(actor), itemId, now()));
    return {
      ...base,
      refs: rows
        .filter((row) => !fresh.has(row.ref))
        .slice(0, HUB_PREFETCH_LIMIT),
    };
  }
  /**
   * A fill's data, validated again against the type before it is stored. The
   * request it answered is compared with the current one: a request changed
   * meanwhile keeps the data but not its recipe.
   */
  function fillDone(
    actor: ProcessActor,
    itemId: string,
    answered: { brief: string; config: Record<string, unknown> },
    result: { data: unknown; recipe: HubStoredWidget["recipe"] },
  ) {
    let item: HubItemRow;
    try {
      item = deps.store.item(owner(actor), itemId);
    } catch {
      return false; // Removed meanwhile.
    }
    const definition = hubWidgetDefinition(item.widget?.type ?? "");
    const data = definition?.data.safeParse(result.data);
    if (!definition || !data?.success)
      throw new IdentityError(422, "hub_fill_invalid");
    const at = new Date(now()).toISOString();
    // Rows the new data no longer holds leave the index; the rest stay fresh.
    const rows = (data.data as { emails?: { id?: string }[] }).emails;
    const keep = Array.isArray(rows)
      ? rows.flatMap((row) => (row.id ? [row.id] : []))
      : [];
    deps.store.transaction(() => {
      deps.store.setWidgetFill(owner(actor), itemId, {
        data: data.data,
        recipe: result.recipe,
        brief: answered.brief,
        config: answered.config,
      });
      deps.store.pruneDetails(owner(actor), itemId, keep);
      deps.store.setResult(owner(actor), itemId, {
        status: "succeeded",
        startedAt: item.result?.startedAt ?? at,
        producedAt: at,
        ...(item.result?.source ? { source: item.result.source } : {}),
      });
    });
    return true;
  }

  /** The agent's view of the hub: the same data, bounded, plus what it may add. */
  function agent(actor: ProcessActor, scope: Scope, language: "en" | "cs") {
    /** The fields as the model needs them to pick a view: key and type. */
    const compactFields = (fields: HubField[] | null) =>
      (fields ?? []).slice(0, 12).map((field) => ({
        key: field.key,
        type: field.items ? `array of ${field.items}` : field.type,
        ...(field.fields?.length
          ? {
              fields: field.fields
                .slice(0, 12)
                .map((value) => `${value.key}:${value.type}`),
            }
          : {}),
      }));
    /** A view from the model: a type alone gets the first fitting fields. */
    const fromModel = (
      kind: "tasks" | "process",
      raw: Record<string, unknown>,
      fields: HubField[] | null,
    ): HubWidgetView => {
      const type = String(raw.type ?? "") as HubWidgetType;
      // The first fitting view of that type, on the field the model named.
      const pool =
        typeof raw.field === "string"
          ? (fields ?? []).filter((field) => field.key === raw.field)
          : fields;
      const base =
        kind === "tasks" && type === "tasks"
          ? { type }
          : hubViewChoices(kind, pool).includes(type)
            ? hubViewFor(type, pool)
            : null;
      const parsed = HubWidgetViewSchema.safeParse({ ...base, ...raw });
      if (!base || !parsed.success)
        throw new IdentityError(409, "hub_view_invalid");
      return checkedView(kind, parsed.data, fields);
    };
    /** A widget's data for the model: the gist, bounded, as data. */
    const compactData = (data: unknown) => {
      if (data === null || data === undefined) return undefined;
      const text = JSON.stringify(data);
      return text.length <= 1500 ? data : { preview: clip(text, 1500) };
    };
    return {
      list: () => {
        const current = cards(actor, scope, language);
        const addable = hubAddable(hubInventory(deps.processes, actor, scope))
          .filter(
            (entry) =>
              !current.items.some(
                (item) => item.processId === entry.processId,
              ) && unattended(actor, entry),
          )
          .slice(0, 20)
          .map((entry) => {
            const fields = shapeOf(actor, entry)?.fields ?? null;
            return {
              processId: entry.processId,
              name: entry.name,
              description: entry.description.slice(0, 300),
              views: hubViewChoices("process", fields),
              fields: compactFields(fields),
            };
          });
        return {
          items: current.items.map((item) => ({
            itemId: item.id,
            kind: item.kind,
            title: item.title,
            refresh: item.refresh,
            ...(item.kind === "widget" ? {} : { view: item.view }),
            size: { w: item.layout.w, h: item.layout.h },
            ...(item.kind === "tasks"
              ? {
                  openTasks: current.tasks.open,
                  newest: current.tasks.top.map((task) => task.title),
                }
              : item.kind === "widget" && item.widget
                ? {
                    type: item.widget.type,
                    fill: item.widget.fill,
                    ...(item.widget.brief ? { brief: item.widget.brief } : {}),
                    config: item.widget.config,
                    ...(item.widget.fill === "ai"
                      ? {
                          status: item.result?.status ?? "never_refreshed",
                          // Added by the assistant and not yet confirmed.
                          ...(item.refresh === "manual" && !item.result
                            ? { waitsForPerson: true }
                            : {}),
                          ...(item.result?.producedAt
                            ? { producedAt: item.result.producedAt }
                            : {}),
                          ...(item.result?.error
                            ? { error: item.result.error }
                            : {}),
                          ...(item.widget.recipe
                            ? { readFrom: item.widget.recipe.services }
                            : {}),
                        }
                      : {}),
                    ...(item.widget.data != null
                      ? { data: compactData(item.widget.data) }
                      : {}),
                  }
                : {
                    views: hubViewChoices("process", item.fields),
                    fields: compactFields(item.fields),
                    status: item.result?.status ?? "never_refreshed",
                    ...(item.result?.producedAt
                      ? { producedAt: item.result.producedAt }
                      : {}),
                    ...(item.result?.error ? { error: item.result.error } : {}),
                    ...(item.result?.output
                      ? { output: agentOutput(item.result.output) }
                      : {}),
                  }),
          })),
          widgetTypes: HUB_WIDGET_TYPES.map((definition) => ({
            type: definition.type,
            name: definition.name[language],
            description: definition.description.en,
            fill: definition.fill,
            config: definition.defaultConfig,
            ...(definition.brief
              ? { exampleBrief: definition.brief[language] }
              : {}),
          })),
          addable,
        };
      },
      /**
       * The agent's add waits for the person: the item is manual and never
       * refreshed until they refresh it (or choose a schedule) on the page.
       */
      add: (input: {
        id: string;
        processId: string;
        title?: string;
        view?: Record<string, unknown>;
        size?: { w: number; h: number };
      }) => {
        let view: HubWidgetView | undefined;
        if (input.view) {
          const entry = eligibleEntry(actor, scope, input.processId);
          view = fromModel(
            "process",
            input.view,
            shapeOf(actor, entry)?.fields ?? null,
          );
        }
        const item = addProcess(actor, scope, language, {
          id: input.id,
          processId: input.processId,
          title: input.title,
          refresh: "manual",
          ...(view ? { view } : {}),
          ...(input.size ? { size: input.size } : {}),
        });
        return {
          itemId: item.id,
          title: item.title,
          refresh: item.refresh,
          view: item.view,
          size: { w: item.layout.w, h: item.layout.h },
        };
      },
      /**
       * A typed widget from the agent: manual like any agent add, so it reads
       * nothing until the person refreshes it on the page. A replayed id adds
       * nothing new.
       */
      addWidget: (input: {
        id: string;
        type: string;
        brief?: string;
        config?: Record<string, unknown>;
        title?: string;
        size?: { w: number; h: number };
      }) => {
        const item = addWidget(actor, language, {
          ...input,
          refresh: "manual",
        });
        return {
          itemId: item.id,
          type: item.widget?.type,
          title: item.title,
          refresh: item.refresh,
          brief: item.widget?.brief,
          config: item.widget?.config,
          size: { w: item.layout.w, h: item.layout.h },
        };
      },
      /** A typed widget's request, settings, title or size; nothing runs. */
      setWidget: (input: {
        itemId: string;
        brief?: string;
        config?: Record<string, unknown>;
        title?: string;
        size?: { w: number; h: number };
      }) => {
        if (input.title !== undefined)
          deps.store.update(owner(actor), input.itemId, { title: input.title });
        const item = changeWidget(actor, language, input.itemId, input);
        return {
          itemId: item.id,
          title: item.title,
          brief: item.widget?.brief,
          config: item.widget?.config,
          size: { w: item.layout.w, h: item.layout.h },
        };
      },
      /**
       * Asks for a refresh on the person's next visit. A widget the assistant
       * added waits for the person's own first refresh; built-ins need none.
       */
      refresh: (itemId: string) => {
        const item = deps.store.item(owner(actor), itemId);
        if (
          item.kind !== "widget" ||
          hubWidgetDefinition(item.widget?.type ?? "")?.fill !== "ai"
        )
          throw new IdentityError(409, "hub_refresh_unavailable");
        if (!item.result) throw new IdentityError(409, "hub_confirm_required");
        deps.store.setWidgetFill(owner(actor), itemId, { requested: true });
        return { itemId, status: "requested" as const };
      },
      /** A widget's view or size; it changes only how the overview shows it. */
      setView: (input: {
        itemId: string;
        view?: Record<string, unknown>;
        size?: { w: number; h: number };
      }) => {
        const item = deps.store.item(owner(actor), input.itemId);
        if (item.kind === "widget") {
          if (input.view) throw new IdentityError(409, "hub_view_invalid");
          const changed = changeWidget(actor, language, item.id, {
            ...(input.size ? { size: input.size } : {}),
          });
          return {
            itemId: changed.id,
            size: { w: changed.layout.w, h: changed.layout.h },
          };
        }
        let view = item.view;
        if (input.view) {
          const fields =
            item.kind === "tasks"
              ? []
              : (shapeOf(actor, eligibleEntry(actor, scope, item.processId!))
                  ?.fields ?? null);
          view = fromModel(item.kind, input.view, fields);
        }
        const changed = changeView(actor, scope, item.id, view, input.size);
        return {
          itemId: changed.id,
          view: changed.view,
          size: { w: changed.layout.w, h: changed.layout.h },
        };
      },
      remove: (itemId: string) => deps.store.remove(owner(actor), itemId),
    };
  }

  /**
   * The person ticked "Add to overview" when saving a process from chat: the
   * same checks as an add, refreshed daily; nothing starts now, the overview
   * refreshes it the next time it opens. A replayed id adds nothing new.
   */
  function adopt(
    actor: ProcessActor,
    scope: Scope,
    language: "en" | "cs",
    input: { id: string; processId: string },
  ) {
    const item = addProcess(actor, scope, language, {
      id: input.id,
      processId: input.processId,
      refresh: "daily",
    });
    return { itemId: item.id, title: item.title, refresh: item.refresh };
  }

  /** The person opened their hub: remembered so the scheduler serves active people. */
  function opened(actor: ProcessActor, language: "en" | "cs") {
    deps.store.touch(owner(actor), tasksTitle(language));
  }
  /**
   * The scheduler's start of one AI widget's fill: the same marks as an open
   * (`begin`), with the result's source `schedule`. Nothing starts when the
   * item is already filling (a fill the person started meanwhile is reused),
   * is no longer on a schedule or is not an AI widget any more.
   */
  function schedule(actor: ProcessActor, scope: Scope, itemId: string) {
    let item: HubItemRow;
    try {
      item = deps.store.item(owner(actor), itemId);
    } catch {
      return false; // Removed meanwhile.
    }
    if (
      item.kind !== "widget" ||
      (item.refresh !== "hourly" && item.refresh !== "daily") ||
      item.result?.status === "running"
    )
      return false;
    return begin(actor, scope, [itemId], "schedule").length > 0;
  }

  return {
    view,
    dashboard,
    cards,
    command,
    record,
    opened,
    schedule,
    /** Every scheduled AI widget across all hubs with its owner (see HubStore.scheduled). */
    scheduled: () => deps.store.scheduled(),
    fillRequest,
    openRequest,
    openCached,
    openDone,
    prefetchRequest,
    fillDone,
    agent,
    adopt,
    isActive: (actor: ProcessActor, id: string) =>
      active.has(activeKey(actor, id)),
    /** The runner finished with this item (needs no credential). */
    release: (scope: Pick<Scope, "workspaceId" | "userId">, id: string) => {
      active.delete(JSON.stringify([scope.workspaceId, scope.userId, id]));
    },
  };
}
export type Hub = ReturnType<typeof createHub>;
