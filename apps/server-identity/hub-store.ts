import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  HUB_ITEM_LIMIT,
  HubFieldSchema,
  HubLayoutSchema,
  HubRefreshSchema,
  HubResultSchema,
  HubTitleSchema,
  HubWidgetViewSchema,
  type HubField,
  type HubLayout,
  type HubRefresh,
  type HubResult,
  type HubWidgetView,
} from "../../packages/protocol/hub";
import {
  HUB_WIDGET_SIZES,
  hubItemSize,
  hubCompact,
  hubFitLayout,
  hubLayoutIssue,
  hubMove,
  hubOverlaps,
  hubPack,
  hubPlace,
  hubReadingOrder,
} from "../../packages/protocol/hub-dashboard";
import type { HubSnapshot } from "./hub-widgets";
import {
  HUB_BRIEF_MAX,
  HUB_SOURCES_MAX,
  HubWidgetSourceSchema,
} from "../../packages/protocol/hub";
import {
  hubWidgetConfig,
  hubWidgetDefinition,
} from "../../packages/protocol/widgets";
import { IdentityId } from "../../packages/protocol/identity";
import { IdentityError } from "./error";

/** The person whose hub this is; resolved to their membership on every call. */
export type HubOwner = {
  organizationId: string;
  workspaceId: string;
  userId: string;
};
/** One read a fill made: replayed or offered to the agent next time. */
export type HubRecipeCall = {
  serviceId: string;
  serviceRevision: number;
  actionId: string;
  actionRevision: number;
  input: Record<string, unknown>;
};
/**
 * The read that opens one of the widget's items in full, learned from the
 * agent's first open: replayed for another item with its ref put in at
 * `refPaths` (JSON paths in `input`, e.g. "id" or "filter.messageId").
 */
export type HubOpenRecipe = HubRecipeCall & { refPaths: string[] };
/** How long an opened item's detail stays in the index. */
export const HUB_DETAIL_TTL_MS = 24 * 60 * 60_000;
/** A typed widget as stored: the person's request and the fill's results. */
export type HubStoredWidget = {
  type: string;
  version: number;
  brief: string;
  config: Record<string, unknown>;
  sources: { id: string; name: string }[];
  /** The latest good data (checked against the type's schema when written). */
  data: unknown;
  /** The reads that produced it, with the service names for the person,
   * and the read that opens one of its items (`open`), once learned. */
  recipe: {
    calls: HubRecipeCall[];
    services: string[];
    open?: HubOpenRecipe;
  } | null;
  /** A refresh was asked for; it runs on the next open. */
  requested: boolean;
};
export type HubItemRow = {
  id: string;
  kind: "tasks" | "process" | "widget";
  processId?: string;
  title: string;
  refresh: HubRefresh;
  position: number;
  createdAt: string;
  result: HubResult | null;
  layout: HubLayout;
  view: HubWidgetView;
  /** The output's fields, read from the version they were read for. */
  shape: HubShape | null;
  /** The latest good output and the one before it, redacted. */
  snapshot: { current: HubSnapshot; previous: HubSnapshot | null } | null;
  /** kind "widget": its type, request and data. */
  widget: HubStoredWidget | null;
};
export type HubShape = {
  version: number;
  artifactDigest: string;
  fields: HubField[];
};
/** A scheduled widget with its owner, as the scheduler lists them. */
export type HubScheduledItem = {
  owner: HubOwner;
  /** When the owner last opened their hub; null before the first open. */
  readAt: string | null;
  item: HubItemRow;
};
const defaultView = (kind: string): HubWidgetView =>
  kind === "tasks"
    ? { type: "tasks" }
    : kind === "widget"
      ? { type: "widget" }
      : { type: "summary" };
/**
 * A stored widget that still parses. A widget of a known type stored with an
 * older version is upgraded on read: its data is dropped and its settings are
 * read against the current type (unknown keys go, missing ones default), so
 * the next fill starts over; its recipe stays as the fill's hint.
 */
function storedWidget(raw: unknown): HubStoredWidget | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<HubStoredWidget>;
  if (typeof value.type !== "string" || typeof value.version !== "number")
    return null;
  const definition = hubWidgetDefinition(value.type);
  const current = !!definition && definition.version === value.version;
  const config =
    value.config &&
    typeof value.config === "object" &&
    !Array.isArray(value.config)
      ? value.config
      : {};
  const data =
    current &&
    value.data != null &&
    definition.data.safeParse(value.data).success
      ? value.data
      : null;
  const sources = HubWidgetSourceSchema.array()
    .max(HUB_SOURCES_MAX)
    .safeParse(value.sources);
  return {
    type: value.type,
    version: definition?.version ?? value.version,
    brief:
      typeof value.brief === "string"
        ? value.brief.slice(0, HUB_BRIEF_MAX)
        : "",
    config:
      definition && !current
        ? (hubWidgetConfig(value.type, config) ??
          (definition.defaultConfig as Record<string, unknown>))
        : config,
    sources: sources.success ? sources.data : [],
    data,
    recipe:
      value.recipe &&
      Array.isArray(value.recipe.calls) &&
      value.recipe.calls.every(recipeCall) &&
      Array.isArray(value.recipe.services) &&
      value.recipe.services.every((name) => typeof name === "string")
        ? {
            calls: value.recipe.calls,
            services: value.recipe.services,
            ...(openRecipe(value.recipe.open)
              ? { open: value.recipe.open as HubOpenRecipe }
              : {}),
          }
        : null,
    requested: value.requested === true,
  };
}
/** A stored read that hint() and replay can use; a malformed one drops its recipe. */
const recipeCall = (value: unknown): value is HubRecipeCall =>
  !!value &&
  typeof value === "object" &&
  typeof (value as HubRecipeCall).actionId === "string" &&
  typeof (value as HubRecipeCall).serviceId === "string" &&
  typeof (value as HubRecipeCall).actionRevision === "number" &&
  typeof (value as HubRecipeCall).serviceRevision === "number" &&
  !!(value as HubRecipeCall).input &&
  typeof (value as HubRecipeCall).input === "object" &&
  !Array.isArray((value as HubRecipeCall).input);
const openRecipe = (value: unknown): value is HubOpenRecipe =>
  recipeCall(value) &&
  Array.isArray((value as HubOpenRecipe).refPaths) &&
  (value as HubOpenRecipe).refPaths.every((path) => typeof path === "string");
/** The index of opened items: each detail as the page got it, per ref. */
const DETAIL_TABLE = `CREATE TABLE IF NOT EXISTS agent_hub_item_detail (
      workspace_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES agent_hub_item(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      detail TEXT NOT NULL CHECK(json_valid(detail)),
      fetched_at TEXT NOT NULL,
      recipe_revision INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, member_id, item_id, ref),
      FOREIGN KEY(workspace_id, member_id)
        REFERENCES agent_hub(workspace_id, member_id) ON DELETE CASCADE
    ) STRICT;`;
const ITEM_TABLE = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('tasks','process','widget')),
      process_id TEXT,
      title TEXT NOT NULL,
      refresh TEXT NOT NULL CHECK(refresh IN ('manual','hourly','daily','on_open')),
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      result TEXT CHECK(result IS NULL OR json_valid(result)),
      layout TEXT CHECK(layout IS NULL OR json_valid(layout)),
      view TEXT CHECK(view IS NULL OR json_valid(view)),
      shape TEXT CHECK(shape IS NULL OR json_valid(shape)),
      snapshot TEXT CHECK(snapshot IS NULL OR json_valid(snapshot)),
      widget TEXT CHECK(widget IS NULL OR json_valid(widget)),
      CHECK((kind = 'process') = (process_id IS NOT NULL)),
      CHECK((kind = 'widget') = (widget IS NOT NULL)),
      FOREIGN KEY(workspace_id, member_id)
        REFERENCES agent_hub(workspace_id, member_id) ON DELETE CASCADE
    ) STRICT;`;
const ITEM_INDEXES = `CREATE INDEX IF NOT EXISTS agent_hub_item_owner
      ON agent_hub_item(workspace_id, member_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_hub_item_process
      ON agent_hub_item(workspace_id, member_id, process_id) WHERE process_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_hub_item_tasks
      ON agent_hub_item(workspace_id, member_id) WHERE kind = 'tasks';`;
const ITEM_COLUMNS =
  "id, workspace_id, member_id, kind, process_id, title, refresh, position, created_at, result, layout, view, shape, snapshot, widget";
const json = (value: unknown) => {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return undefined;
  }
};

/** One stored row as the domain reads it: every column parsed, nothing trusted. */
function itemRow(row: Record<string, unknown>): HubItemRow {
  let result: HubResult | null = null;
  if (row.result !== null) {
    // A result written by an older build that no longer parses is dropped.
    const parsed = HubResultSchema.safeParse(JSON.parse(String(row.result)));
    result = parsed.success ? parsed.data : null;
  }
  const kind =
    row.kind === "tasks"
      ? "tasks"
      : row.kind === "widget"
        ? "widget"
        : "process";
  const widget =
    kind === "widget"
      ? (storedWidget(json(row.widget)) ?? {
          type: "unknown",
          version: 1,
          brief: "",
          config: {},
          sources: [],
          data: null,
          recipe: null,
          requested: false,
        })
      : null;
  const view = HubWidgetViewSchema.safeParse(json(row.view));
  const layout = HubLayoutSchema.safeParse(json(row.layout));
  const shape = json(row.shape) as Partial<HubShape> | undefined;
  const fields = HubFieldSchema.array().max(24).safeParse(shape?.fields);
  const snapshot = json(row.snapshot) as HubItemRow["snapshot"];
  return {
    id: String(row.id),
    kind,
    ...(row.process_id ? { processId: String(row.process_id) } : {}),
    title: String(row.title),
    refresh: HubRefreshSchema.parse(row.refresh),
    position: Number(row.position),
    createdAt: String(row.created_at),
    result,
    view:
      kind === "widget"
        ? defaultView(kind)
        : view.success && view.data.type !== "widget"
          ? view.data
          : defaultView(kind),
    layout: layout.success
      ? layout.data
      : {
          x: 0,
          y: 0,
          ...hubItemSize({ view: defaultView(kind), widget }),
        },
    shape:
      fields.success &&
      typeof shape?.version === "number" &&
      typeof shape.artifactDigest === "string"
        ? {
            version: shape.version,
            artifactDigest: shape.artifactDigest,
            fields: fields.data,
          }
        : null,
    snapshot:
      snapshot && typeof snapshot === "object" && snapshot.current
        ? snapshot
        : null,
    widget,
  } satisfies HubItemRow;
}

/**
 * Per person and workspace hub items with the latest result of each. Rows
 * belong to the membership: removing the member, their workspace access or the
 * workspace removes their hub. Nothing here grants a process or runs one.
 */
export class HubStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_hub (
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, member_id)
    ) STRICT;
    ${ITEM_TABLE("agent_hub_item")}
    ${ITEM_INDEXES}
    CREATE TRIGGER IF NOT EXISTS agent_hub_workspace_access
      AFTER DELETE ON agent_workspace_member BEGIN
        DELETE FROM agent_hub WHERE workspace_id = OLD.workspace_id AND member_id = OLD.member_id;
      END;`);
    // agent-hub/2: every item is a widget with a view and a place on the grid.
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(agent_hub_item)")
        .all()
        .map((row) => String(row.name)),
    );
    for (const name of ["layout", "view", "shape", "snapshot", "widget"])
      if (!columns.has(name))
        db.exec(
          `ALTER TABLE agent_hub_item ADD COLUMN ${name} TEXT CHECK(${name} IS NULL OR json_valid(${name}))`,
        );
    // When the person last opened their hub; the scheduler skips idle people.
    if (
      !db
        .prepare("PRAGMA table_info(agent_hub)")
        .all()
        .some((row) => String(row.name) === "read_at")
    )
      db.exec("ALTER TABLE agent_hub ADD COLUMN read_at TEXT");
    this.allowWidgets();
    this.migrate();
    db.exec(DETAIL_TABLE);
  }
  /**
   * agent-hub/3: a database from before typed widgets only allows 'tasks'
   * and 'process' items. SQLite cannot change a CHECK in place, so the item
   * table is rebuilt once with every row, column and index kept.
   */
  private allowWidgets() {
    const table = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_hub_item'",
      )
      .get();
    if (String(table?.sql ?? "").includes("'widget'")) return;
    this.atomic(() => {
      this.db.exec(`DROP TABLE IF EXISTS agent_hub_item_v3;
        ${ITEM_TABLE("agent_hub_item_v3")}
        INSERT INTO agent_hub_item_v3 (${ITEM_COLUMNS})
          SELECT ${ITEM_COLUMNS} FROM agent_hub_item;
        DROP TABLE agent_hub_item;
        ALTER TABLE agent_hub_item_v3 RENAME TO agent_hub_item;
        ${ITEM_INDEXES}`);
    });
  }
  /**
   * Items from before the dashboard keep their reading: the summary view (and
   * Tasks), in their old order, each at its view's default size.
   */
  private migrate() {
    this.db.exec(`UPDATE agent_hub_item SET view = CASE kind
        WHEN 'tasks' THEN '{"type":"tasks"}'
        WHEN 'widget' THEN '{"type":"widget"}'
        ELSE '{"type":"summary"}' END
      WHERE view IS NULL`);
    const owners = this.db
      .prepare(
        "SELECT DISTINCT workspace_id, member_id FROM agent_hub_item WHERE layout IS NULL",
      )
      .all();
    if (!owners.length) return;
    const update = this.db.prepare(
      "UPDATE agent_hub_item SET layout = ? WHERE id = ?",
    );
    this.atomic(() => {
      for (const owner of owners) {
        const rows = this.db
          .prepare(
            "SELECT id, kind, view, layout FROM agent_hub_item WHERE workspace_id = ? AND member_id = ? ORDER BY position, created_at, id",
          )
          .all(String(owner.workspace_id), String(owner.member_id));
        const taken = rows.flatMap((row) => {
          const layout = HubLayoutSchema.safeParse(json(row.layout));
          return layout.success ? [layout.data] : [];
        });
        let after: HubLayout | undefined;
        for (const row of rows) {
          if (row.layout !== null) continue;
          const view = HubWidgetViewSchema.safeParse(json(row.view));
          const size =
            HUB_WIDGET_SIZES[
              view.success ? view.data.type : defaultView(String(row.kind)).type
            ];
          const layout = hubPlace(taken, size, after);
          taken.push(layout);
          after = layout;
          update.run(JSON.stringify(layout), String(row.id));
        }
      }
    });
  }
  private member(owner: HubOwner) {
    const row = this.db
      .prepare(
        `SELECT m.id FROM member m JOIN agent_workspace w ON w.organization_id = m."organizationId"
        WHERE m."userId" = ? AND m."organizationId" = ? AND w.id = ?`,
      )
      .get(owner.userId, owner.organizationId, owner.workspaceId);
    if (!row) throw new IdentityError(403, "identity_forbidden");
    return String(row.id);
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT agent_hub");
    try {
      const value = fn();
      this.db.exec("RELEASE agent_hub");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK TO agent_hub; RELEASE agent_hub");
      throw error;
    }
  }
  /** Several writes that take effect together or not at all. */
  transaction<T>(fn: () => T): T {
    return this.atomic(fn);
  }
  /** Creates the hub on first use with the built-in Tasks item. */
  private ensure(owner: HubOwner, title: string) {
    const memberId = this.member(owner);
    const hub = this.db
      .prepare(
        "SELECT revision, user_id FROM agent_hub WHERE workspace_id = ? AND member_id = ?",
      )
      .get(owner.workspaceId, memberId);
    if (hub) {
      if (hub.user_id !== owner.userId)
        throw new IdentityError(403, "identity_forbidden");
      return { memberId, revision: Number(hub.revision) };
    }
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        "INSERT INTO agent_hub (workspace_id, member_id, user_id, revision, created_at) VALUES (?, ?, ?, 1, ?)",
      )
      .run(owner.workspaceId, memberId, owner.userId, at);
    const size = HUB_WIDGET_SIZES.tasks;
    this.db
      .prepare(
        `INSERT INTO agent_hub_item (id, workspace_id, member_id, kind, process_id, title, refresh, position, created_at, result, layout, view)
        VALUES (?, ?, ?, 'tasks', NULL, ?, 'on_open', 0, ?, NULL, ?, '{"type":"tasks"}')`,
      )
      .run(
        randomUUID(),
        owner.workspaceId,
        memberId,
        title,
        at,
        JSON.stringify({ x: 0, y: 0, w: size.w, h: size.h }),
      );
    return { memberId, revision: 1 };
  }
  private bump(owner: HubOwner, memberId: string) {
    this.db
      .prepare(
        "UPDATE agent_hub SET revision = revision + 1 WHERE workspace_id = ? AND member_id = ?",
      )
      .run(owner.workspaceId, memberId);
  }
  private rows(owner: HubOwner, memberId: string): HubItemRow[] {
    return this.db
      .prepare(
        "SELECT * FROM agent_hub_item WHERE workspace_id = ? AND member_id = ? ORDER BY position, created_at, id",
      )
      .all(owner.workspaceId, memberId)
      .map((row) => itemRow(row as Record<string, unknown>));
  }
  /** Stores every layout and renumbers positions in reading order. */
  private place(
    owner: HubOwner,
    memberId: string,
    placed: { id: string; layout: HubLayout }[],
  ) {
    const update = this.db.prepare(
      "UPDATE agent_hub_item SET layout = ?, position = ? WHERE id = ? AND workspace_id = ? AND member_id = ?",
    );
    hubReadingOrder(placed).forEach((item, index) =>
      update.run(
        JSON.stringify(item.layout),
        index,
        item.id,
        owner.workspaceId,
        memberId,
      ),
    );
  }
  /** The hub as it is now; `tasksTitle` names the built-in item on first use. */
  read(owner: HubOwner, tasksTitle: string) {
    return this.atomic(() => {
      const { memberId } = this.ensure(owner, tasksTitle);
      const revision = Number(
        this.db
          .prepare(
            "SELECT revision FROM agent_hub WHERE workspace_id = ? AND member_id = ?",
          )
          .get(owner.workspaceId, memberId)!.revision,
      );
      return { revision, items: this.rows(owner, memberId) };
    });
  }
  /** The person opened their hub now (creating it on first use). */
  touch(owner: HubOwner, tasksTitle: string) {
    return this.atomic(() => {
      const { memberId } = this.ensure(owner, tasksTitle);
      this.db
        .prepare(
          "UPDATE agent_hub SET read_at = ? WHERE workspace_id = ? AND member_id = ?",
        )
        .run(new Date(this.now()).toISOString(), owner.workspaceId, memberId);
    });
  }
  /**
   * Every AI-fillable widget on a schedule (`hourly` or `daily`) across all
   * hubs, with its owner and when they last opened their hub: what the
   * scheduler chooses from. Reading starts nothing.
   */
  scheduled(): HubScheduledItem[] {
    return this.db
      .prepare(
        `SELECT i.*, h.user_id AS owner_user_id, h.read_at AS owner_read_at, w.organization_id AS owner_organization_id
         FROM agent_hub_item i
         JOIN agent_hub h ON h.workspace_id = i.workspace_id AND h.member_id = i.member_id
         JOIN agent_workspace w ON w.id = h.workspace_id
         WHERE i.kind = 'widget' AND i.refresh IN ('hourly', 'daily')
         ORDER BY i.workspace_id, i.member_id, i.position, i.created_at, i.id`,
      )
      .all()
      .map((row) => ({
        owner: {
          organizationId: String(row.owner_organization_id),
          workspaceId: String(row.workspace_id),
          userId: String(row.owner_user_id),
        },
        readAt: row.owner_read_at === null ? null : String(row.owner_read_at),
        item: itemRow(row as Record<string, unknown>),
      }));
  }
  item(owner: HubOwner, id: string) {
    IdentityId.parse(id);
    const memberId = this.member(owner);
    const found = this.rows(owner, memberId).find((row) => row.id === id);
    if (!found) throw new IdentityError(404, "hub_item_not_found");
    return found;
  }
  /**
   * Adds an item at the first free place (or the given one, when it is free).
   * An existing id returns that item unchanged (an exact replay); the same
   * process twice is refused.
   */
  add(
    owner: HubOwner,
    tasksTitle: string,
    input: {
      id?: string;
      kind: "tasks" | "process" | "widget";
      processId?: string;
      title: string;
      refresh: HubRefresh;
      view?: HubWidgetView;
      layout?: HubLayout;
      shape?: HubShape;
      /** kind "widget": already checked against its type. */
      widget?: Omit<HubStoredWidget, "data" | "recipe" | "requested">;
    },
  ) {
    const title = HubTitleSchema.parse(input.title);
    const refresh = HubRefreshSchema.parse(input.refresh);
    if (
      (input.kind === "process") !== !!input.processId ||
      (input.kind === "widget") !== !!input.widget
    )
      throw new IdentityError(400, "identity_invalid_input");
    if (input.processId) IdentityId.parse(input.processId);
    const id = input.id ? IdentityId.parse(input.id) : randomUUID();
    const view = HubWidgetViewSchema.parse(
      input.kind === "widget"
        ? defaultView("widget")
        : (input.view ?? defaultView(input.kind)),
    );
    const widget: HubStoredWidget | null = input.widget
      ? { ...input.widget, data: null, recipe: null, requested: false }
      : null;
    const size = hubItemSize({ view, widget });
    return this.atomic(() => {
      const { memberId } = this.ensure(owner, tasksTitle);
      const items = this.rows(owner, memberId);
      const replay = items.find((row) => row.id === id);
      if (replay) {
        if (
          replay.kind !== input.kind ||
          replay.processId !== input.processId ||
          replay.widget?.type !== input.widget?.type
        )
          throw new IdentityError(409, "hub_conflict");
        return replay;
      }
      if (this.db.prepare("SELECT 1 FROM agent_hub_item WHERE id = ?").get(id))
        throw new IdentityError(409, "hub_conflict");
      if (
        input.kind !== "widget" &&
        items.some(
          (row) =>
            row.kind === input.kind &&
            (input.kind === "tasks" || row.processId === input.processId),
        )
      )
        throw new IdentityError(409, "hub_item_exists");
      if (items.length >= HUB_ITEM_LIMIT)
        throw new IdentityError(409, "hub_full");
      const taken = items.map((row) => row.layout);
      const wanted = input.layout
        ? hubFitLayout(HubLayoutSchema.parse(input.layout), size)
        : undefined;
      const layout =
        wanted && !taken.some((other) => hubOverlaps(wanted, other))
          ? wanted
          : hubPlace(taken, wanted ?? size);
      this.db
        .prepare(
          `INSERT INTO agent_hub_item (id, workspace_id, member_id, kind, process_id, title, refresh, position, created_at, result, layout, view, shape, widget)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          owner.workspaceId,
          memberId,
          input.kind,
          input.processId ?? null,
          title,
          refresh,
          items.length,
          new Date(this.now()).toISOString(),
          JSON.stringify(layout),
          JSON.stringify(view),
          input.shape ? JSON.stringify(input.shape) : null,
          widget ? JSON.stringify(widget) : null,
        );
      this.place(owner, memberId, [
        ...items.map((row) => ({ id: row.id, layout: row.layout })),
        { id, layout },
      ]);
      this.bump(owner, memberId);
      return this.rows(owner, memberId).find((row) => row.id === id)!;
    });
  }
  /** Removing an item that is already gone is not an error; the rest float up. */
  remove(owner: HubOwner, id: string) {
    IdentityId.parse(id);
    return this.atomic(() => {
      const memberId = this.member(owner);
      const removed = this.db
        .prepare(
          "DELETE FROM agent_hub_item WHERE id = ? AND workspace_id = ? AND member_id = ?",
        )
        .run(id, owner.workspaceId, memberId).changes;
      if (removed) {
        this.place(
          owner,
          memberId,
          hubCompact(
            this.rows(owner, memberId).map((row) => ({
              id: row.id,
              layout: row.layout,
            })),
          ),
        );
        this.bump(owner, memberId);
      }
      return removed > 0;
    });
  }
  update(
    owner: HubOwner,
    id: string,
    change: { title?: string; refresh?: HubRefresh },
  ) {
    const title =
      change.title === undefined
        ? undefined
        : HubTitleSchema.parse(change.title);
    const refresh =
      change.refresh === undefined
        ? undefined
        : HubRefreshSchema.parse(change.refresh);
    return this.atomic(() => {
      const current = this.item(owner, id);
      const memberId = this.member(owner);
      this.db
        .prepare(
          "UPDATE agent_hub_item SET title = ?, refresh = ? WHERE id = ? AND workspace_id = ? AND member_id = ?",
        )
        .run(
          title ?? current.title,
          refresh ?? current.refresh,
          id,
          owner.workspaceId,
          memberId,
        );
      this.bump(owner, memberId);
      return this.item(owner, id);
    });
  }
  /**
   * The new order must name every current item exactly once; the grid is
   * laid out again in that reading order, keeping each widget's size.
   */
  reorder(owner: HubOwner, ids: string[]) {
    return this.atomic(() => {
      const memberId = this.member(owner);
      const rows = this.rows(owner, memberId);
      const current = rows.map((row) => row.id);
      if (
        ids.length !== current.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !current.includes(id))
      )
        throw new IdentityError(409, "hub_changed");
      this.place(
        owner,
        memberId,
        hubPack(
          ids.map((id) => {
            const row = rows.find((value) => value.id === id)!;
            return { id, w: row.layout.w, h: row.layout.h };
          }),
        ),
      );
      this.bump(owner, memberId);
    });
  }
  /**
   * The whole grid: every current item exactly once (else `hub_changed`),
   * inside the grid, at least each view's minimum size and not overlapping.
   */
  setLayout(owner: HubOwner, entries: { itemId: string; layout: HubLayout }[]) {
    const parsed = entries.map((entry) => ({
      id: IdentityId.parse(entry.itemId),
      layout: HubLayoutSchema.parse(entry.layout),
    }));
    return this.atomic(() => {
      const memberId = this.member(owner);
      const rows = this.rows(owner, memberId);
      const ids = parsed.map((entry) => entry.id);
      if (
        ids.length !== rows.length ||
        new Set(ids).size !== ids.length ||
        rows.some((row) => !ids.includes(row.id))
      )
        throw new IdentityError(409, "hub_changed");
      if (
        hubLayoutIssue(
          parsed.map((entry) => ({
            layout: entry.layout,
            type: hubItemSize(rows.find((row) => row.id === entry.id)!),
          })),
        )
      )
        throw new IdentityError(400, "hub_layout_invalid");
      this.place(owner, memberId, parsed);
      this.bump(owner, memberId);
    });
  }
  /**
   * A new view for one widget (already checked against its output). A view
   * that needs more room grows the widget; widgets in the way move down.
   */
  setView(
    owner: HubOwner,
    id: string,
    view: HubWidgetView,
    shape?: HubShape | null,
    size?: { w: number; h: number },
  ) {
    const value = HubWidgetViewSchema.parse(view);
    return this.atomic(() => {
      const current = this.item(owner, id);
      if (current.kind === "widget" || value.type === "widget")
        throw new IdentityError(409, "hub_view_invalid");
      const memberId = this.member(owner);
      this.db
        .prepare(
          "UPDATE agent_hub_item SET view = ?, shape = coalesce(?, shape) WHERE id = ? AND workspace_id = ? AND member_id = ?",
        )
        .run(
          JSON.stringify(value),
          shape ? JSON.stringify(shape) : null,
          id,
          owner.workspaceId,
          memberId,
        );
      const layout = hubFitLayout(
        { ...current.layout, ...(size ?? {}) },
        hubItemSize({ view: value, widget: current.widget }),
      );
      this.place(
        owner,
        memberId,
        hubMove(
          this.rows(owner, memberId).map((row) => ({
            id: row.id,
            layout: row.layout,
          })),
          id,
          layout,
        ),
      );
      this.bump(owner, memberId);
      return this.item(owner, id);
    });
  }
  /** The output's fields for the version a refresh or check just read. */
  setShape(owner: HubOwner, id: string, shape: HubShape) {
    const memberId = this.member(owner);
    this.db
      .prepare(
        "UPDATE agent_hub_item SET shape = ? WHERE id = ? AND workspace_id = ? AND member_id = ? AND kind = 'process'",
      )
      .run(JSON.stringify(shape), id, owner.workspaceId, memberId);
  }
  /** A new good output; the one it replaces is kept for comparisons. */
  setSnapshot(owner: HubOwner, id: string, snapshot: HubSnapshot) {
    const memberId = this.member(owner);
    const row = this.db
      .prepare(
        "SELECT snapshot FROM agent_hub_item WHERE id = ? AND workspace_id = ? AND member_id = ? AND kind = 'process'",
      )
      .get(id, owner.workspaceId, memberId);
    if (!row) return false;
    const previous = json(row.snapshot) as HubItemRow["snapshot"] | undefined;
    this.db
      .prepare(
        "UPDATE agent_hub_item SET snapshot = ? WHERE id = ? AND workspace_id = ? AND member_id = ?",
      )
      .run(
        JSON.stringify({
          current: snapshot,
          previous: previous?.current ?? null,
        }),
        id,
        owner.workspaceId,
        memberId,
      );
    return true;
  }
  /** The latest result of a process item or an AI widget; results do not change the revision. */
  setResult(owner: HubOwner, id: string, result: HubResult | null) {
    const value = result === null ? null : HubResultSchema.parse(result);
    const memberId = this.member(owner);
    const changed = this.db
      .prepare(
        "UPDATE agent_hub_item SET result = ? WHERE id = ? AND workspace_id = ? AND member_id = ? AND kind IN ('process','widget')",
      )
      .run(
        value === null ? null : JSON.stringify(value),
        id,
        owner.workspaceId,
        memberId,
      ).changes;
    return changed > 0;
  }
  /**
   * A typed widget's request, settings, sources or size. A new request starts
   * the next fill over (the recipe is dropped); the data stays until then.
   */
  setWidget(
    owner: HubOwner,
    id: string,
    change: {
      brief?: string;
      config?: Record<string, unknown>;
      sources?: { id: string; name: string }[];
      size?: { w: number; h: number };
    },
  ) {
    return this.atomic(() => {
      const current = this.item(owner, id);
      if (current.kind !== "widget" || !current.widget)
        throw new IdentityError(409, "hub_widget_invalid");
      const memberId = this.member(owner);
      const widget: HubStoredWidget = {
        ...current.widget,
        ...(change.brief !== undefined ? { brief: change.brief } : {}),
        ...(change.config !== undefined ? { config: change.config } : {}),
        ...(change.sources !== undefined ? { sources: change.sources } : {}),
      };
      if (
        change.brief !== undefined ||
        change.config !== undefined ||
        change.sources !== undefined
      )
        widget.recipe = null;
      this.db
        .prepare(
          "UPDATE agent_hub_item SET widget = ? WHERE id = ? AND workspace_id = ? AND member_id = ?",
        )
        .run(JSON.stringify(widget), id, owner.workspaceId, memberId);
      if (change.size)
        this.place(
          owner,
          memberId,
          hubMove(
            this.rows(owner, memberId).map((row) => ({
              id: row.id,
              layout: row.layout,
            })),
            id,
            hubFitLayout(
              { ...current.layout, ...change.size },
              hubItemSize(current),
            ),
          ),
        );
      this.bump(owner, memberId);
      return this.item(owner, id);
    });
  }
  /**
   * A fill's validated data and the reads that produced it, or only the
   * "refresh asked for" mark. Fills do not change the revision.
   */
  setWidgetFill(
    owner: HubOwner,
    id: string,
    fill:
      | {
          data: unknown;
          recipe: HubStoredWidget["recipe"];
          /** The request the fill answered; a changed request keeps its own state. */
          brief: string;
          config: Record<string, unknown>;
        }
      | { requested: boolean },
  ) {
    return this.atomic(() => {
      const current = this.item(owner, id);
      if (current.kind !== "widget" || !current.widget) return false;
      const memberId = this.member(owner);
      let widget: HubStoredWidget;
      if ("requested" in fill)
        widget = { ...current.widget, requested: fill.requested };
      else {
        const same =
          current.widget.brief === fill.brief &&
          JSON.stringify(current.widget.config) === JSON.stringify(fill.config);
        const open = current.widget.recipe?.open;
        widget = {
          ...current.widget,
          data: fill.data,
          // The request changed meanwhile: its next fill starts over. The
          // read that opens an item stays: it is checked again on replay.
          recipe:
            same && fill.recipe
              ? { ...fill.recipe, ...(open ? { open } : {}) }
              : null,
          requested: false,
        };
      }
      this.db
        .prepare(
          "UPDATE agent_hub_item SET widget = ? WHERE id = ? AND workspace_id = ? AND member_id = ?",
        )
        .run(JSON.stringify(widget), id, owner.workspaceId, memberId);
      return true;
    });
  }
  /** The read that opens one of the widget's items, once learned (or forgotten). */
  setWidgetOpen(owner: HubOwner, id: string, open: HubOpenRecipe | null) {
    return this.atomic(() => {
      const current = this.item(owner, id);
      if (current.kind !== "widget" || !current.widget) return false;
      const memberId = this.member(owner);
      const { open: _previous, ...recipe } = current.widget.recipe ?? {
        calls: [],
        services: [],
      };
      const widget: HubStoredWidget = {
        ...current.widget,
        recipe: { ...recipe, ...(open ? { open } : {}) },
      };
      this.db
        .prepare(
          "UPDATE agent_hub_item SET widget = ? WHERE id = ? AND workspace_id = ? AND member_id = ?",
        )
        .run(JSON.stringify(widget), id, owner.workspaceId, memberId);
      return true;
    });
  }

  /** An opened item's detail from the index, while it is fresh. */
  detail(owner: HubOwner, itemId: string, ref: string, now: number) {
    IdentityId.parse(itemId);
    const memberId = this.member(owner);
    const row = this.db
      .prepare(
        "SELECT detail, fetched_at, recipe_revision FROM agent_hub_item_detail WHERE workspace_id = ? AND member_id = ? AND item_id = ? AND ref = ?",
      )
      .get(owner.workspaceId, memberId, itemId, ref);
    if (!row) return null;
    const fetchedAt = String(row.fetched_at);
    if (now - Date.parse(fetchedAt) >= HUB_DETAIL_TTL_MS) return null;
    return {
      detail: JSON.parse(String(row.detail)) as unknown,
      fetchedAt,
      recipeRevision: Number(row.recipe_revision),
    };
  }
  /** The refs of an item whose detail is fresh in the index. */
  details(owner: HubOwner, itemId: string, now: number): string[] {
    IdentityId.parse(itemId);
    const memberId = this.member(owner);
    return this.db
      .prepare(
        "SELECT ref, fetched_at FROM agent_hub_item_detail WHERE workspace_id = ? AND member_id = ? AND item_id = ?",
      )
      .all(owner.workspaceId, memberId, itemId)
      .filter(
        (row) => now - Date.parse(String(row.fetched_at)) < HUB_DETAIL_TTL_MS,
      )
      .map((row) => String(row.ref));
  }
  /** Keeps an opened item's detail (never HTML: the extracted detail only). */
  saveDetail(
    owner: HubOwner,
    itemId: string,
    ref: string,
    detail: unknown,
    recipeRevision: number,
    at: string,
  ) {
    return this.atomic(() => {
      const current = this.item(owner, itemId);
      if (current.kind !== "widget") return false;
      const memberId = this.member(owner);
      this.db
        .prepare(
          `INSERT INTO agent_hub_item_detail (workspace_id, member_id, item_id, ref, detail, fetched_at, recipe_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, member_id, item_id, ref) DO UPDATE SET
             detail = excluded.detail, fetched_at = excluded.fetched_at, recipe_revision = excluded.recipe_revision`,
        )
        .run(
          owner.workspaceId,
          memberId,
          itemId,
          ref,
          JSON.stringify(detail),
          at,
          recipeRevision,
        );
      return true;
    });
  }
  /** Drops the details of refs the widget no longer holds. */
  pruneDetails(owner: HubOwner, itemId: string, keep: string[]) {
    IdentityId.parse(itemId);
    const memberId = this.member(owner);
    const kept = new Set(keep);
    const stale = this.db
      .prepare(
        "SELECT ref FROM agent_hub_item_detail WHERE workspace_id = ? AND member_id = ? AND item_id = ?",
      )
      .all(owner.workspaceId, memberId, itemId)
      .map((row) => String(row.ref))
      .filter((ref) => !kept.has(ref));
    const remove = this.db.prepare(
      "DELETE FROM agent_hub_item_detail WHERE workspace_id = ? AND member_id = ? AND item_id = ? AND ref = ?",
    );
    for (const ref of stale)
      remove.run(owner.workspaceId, memberId, itemId, ref);
    return stale.length;
  }
}
