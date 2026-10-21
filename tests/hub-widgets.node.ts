import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HubStore } from "../apps/server-identity/hub-store";
import { createHub, hubItemStale } from "../apps/server-identity/hub";
import { IdentityError } from "../apps/server-identity/error";
import {
  HUB_PROFILE_V2,
  HUB_PROFILE_V3,
  HubCardSchema,
  HubDashboardSchema,
  HubDashboardV3Schema,
  type HubDashboardV3,
} from "../packages/protocol/hub";
import {
  hubItemSize,
  hubLayoutIssue,
} from "../packages/protocol/hub-dashboard";
import {
  HUB_WIDGET_PRESETS,
  HUB_WIDGET_TYPES,
  hubWidgetConfig,
  hubWidgetData,
  hubWidgetDefinition,
  hubWidgetJsonSchema,
} from "../packages/protocol/widgets";

const org = "TEST-org";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const anna = {
  actor: {
    organizationId: org,
    workspaceId,
    userId: "TEST-anna",
    role: "member" as const,
  },
  scope: {
    connectionId: `account-${workspaceId}`,
    serverId: "TEST-server",
    workspaceId,
    userId: "TEST-anna",
  },
};
const owner = { organizationId: org, workspaceId, userId: "TEST-anna" };
const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT REFERENCES organization(id) ON DELETE CASCADE, "userId" TEXT REFERENCES user(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE, PRIMARY KEY(workspace_id, member_id)) STRICT;
    INSERT INTO organization VALUES ('${org}');
    INSERT INTO user VALUES ('TEST-anna');
    INSERT INTO member VALUES ('TEST-m-anna','${org}','TEST-anna');
    INSERT INTO agent_workspace VALUES ('${workspaceId}','${org}');
    INSERT INTO agent_workspace_member VALUES ('${workspaceId}','TEST-m-anna');`);
  let now = Date.parse("2026-10-16T08:00:00.000Z");
  const store = new HubStore(db, () => now);
  let services = [
    { id: "TEST-crm", name: "TEST CRM" },
    { id: "TEST-mail", name: "TEST Mail" },
  ];
  const meetings = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      title: "TEST sales sync",
      recordedAt: "2026-10-15T09:00:00.000Z",
      status: "ready" as const,
      summary: "TEST agreed on prices",
      tasks: 2,
    },
  ];
  const hub = createHub({
    store,
    processes: {
      unattendedEffect: () => "read",
      activeOutputSchema: () => undefined,
      executionInventory: (_actor, scope) => ({
        profile: "agent-process-execution/1",
        scope,
        fingerprint: "f".repeat(64),
        processes: [],
        nextAfter: null,
      }),
    },
    starts: () => undefined,
    journal: () => undefined,
    humanTasks: { open: () => [], openCount: () => 0 },
    timeZone: () => "Europe/Prague",
    meetings: (_scope, limit) => meetings.slice(0, limit),
    services: () => services,
    now: () => now,
  });
  const v3 = (command: Record<string, unknown>) =>
    hub.command(anna.actor, anna.scope, "cs", {
      profile: HUB_PROFILE_V3,
      ...command,
    }) as { view: HubDashboardV3; refresh: string[] };
  return {
    db,
    store,
    hub,
    v3,
    cards: () => hub.cards(anna.actor, anna.scope, "cs"),
    advance: (ms: number) => {
      now += ms;
    },
    setServices: (next: typeof services) => {
      services = next;
    },
  };
}

test("the widget registry: unique types, bounded schemas, valid defaults, samples and sizes", () => {
  const types = HUB_WIDGET_TYPES.map((definition) => definition.type);
  assert.equal(new Set(types).size, types.length);
  for (const definition of HUB_WIDGET_TYPES) {
    assert.match(definition.type, /^[a-z][a-z0-9_]{1,31}$/);
    assert.ok(definition.name.cs && definition.name.en, definition.type);
    assert.ok(definition.description.cs && definition.description.en);
    // Every default config and both samples fit the type's own schemas.
    definition.config.parse(definition.defaultConfig);
    for (const language of ["cs", "en"] as const)
      definition.data.parse(definition.sample(language));
    const { w, h, minW, minH } = definition.size;
    assert.ok(minW <= w && w <= 12 && minH <= h && h <= 10, definition.type);
    // An AI widget starts from a request and tells its agent what matters.
    if (definition.fill === "ai") {
      assert.ok(definition.brief?.cs && definition.brief.en, definition.type);
      assert.ok(definition.guide, definition.type);
      assert.ok(definition.describeConfig, definition.type);
      const schema = hubWidgetJsonSchema(definition.type)!;
      assert.equal(schema.type, "object");
      // Every list is bounded: the structured output can't grow without end.
      const unbounded: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (!node || typeof node !== "object") return;
        const value = node as Record<string, unknown>;
        if (value.type === "array" && typeof value.maxItems !== "number")
          unbounded.push(path);
        if (
          value.type === "string" &&
          !value.maxLength &&
          !value.pattern &&
          !value.enum
        )
          unbounded.push(path);
        for (const [key, child] of Object.entries(value))
          walk(child, `${path}.${key}`);
      };
      walk(schema, definition.type);
      assert.deepEqual(unbounded, [], definition.type);
    }
  }
  for (const preset of HUB_WIDGET_PRESETS)
    assert.ok(hubWidgetConfig(preset.type, preset.config), preset.id);
  assert.equal(hubWidgetDefinition("TEST-nope"), undefined);
});

test("the tool fields are optional: unread flags, targets, row links and several series", () => {
  const inbox = hubWidgetDefinition("inbox")!.sample("cs") as {
    emails: { unreadFlag?: boolean; threadCount?: number }[];
  };
  assert.equal(inbox.emails[0]!.unreadFlag, true);
  assert.equal(inbox.emails[1]!.threadCount, 3);
  const kpi = hubWidgetDefinition("kpi")!.sample("en") as { target?: number };
  assert.equal(kpi.target, 50);
  assert.ok(
    hubWidgetData("kpi", { value: 1, label: "TEST", asOf: "2026-10-17" }),
  );
  assert.equal(
    hubWidgetData("kpi", { value: 1, label: "TEST", asOf: "today" }),
    null,
  );
  const table = hubWidgetDefinition("table")!.sample("cs") as {
    rowLinks?: (string | null)[];
  };
  assert.deepEqual(table.rowLinks, ["https://crm.example/deals/1", null]);
  assert.equal(
    hubWidgetData("table", {
      columns: ["A"],
      rows: [[1]],
      rowLinks: ["javascript:alert(1)"],
    }),
    null,
  );
  const series = [
    { name: "2025", points: [{ label: "Q1", value: 1 }] },
    { name: "2026", points: [{ label: "Q1", value: 2 }] },
  ];
  assert.ok(hubWidgetData("chart", { points: [], series }));
  assert.equal(
    hubWidgetData("chart", {
      points: [],
      series: Array.from({ length: 5 }, () => series[0]),
    }),
    null,
  );
  assert.deepEqual(hubWidgetConfig("chart", { kind: "bar" }), {
    kind: "bar",
    stacked: false,
  });
});

test("widget data and config are checked: links are web links, tables stay rectangular", () => {
  const calendar = hubWidgetDefinition("calendar")!;
  const event = { title: "TEST", start: "2026-10-17T09:00:00+02:00" };
  assert.ok(calendar.data.safeParse({ events: [event], tasks: [] }).success);
  for (const link of [
    "javascript:alert(1)",
    "data:text/html,x",
    "niaro://x",
    "https://ok.example/a b",
  ])
    assert.equal(
      calendar.data.safeParse({ events: [{ ...event, link }], tasks: [] })
        .success,
      false,
      link,
    );
  assert.equal(
    calendar.data.safeParse({
      events: [{ ...event, start: "tomorrow" }],
      tasks: [],
    }).success,
    false,
  );
  assert.equal(
    calendar.data.safeParse({
      events: Array.from({ length: 61 }, () => event),
      tasks: [],
    }).success,
    false,
  );
  assert.equal(
    hubWidgetData("table", { columns: ["A"], rows: [["x", "y"]] }),
    null,
  );
  assert.deepEqual(hubWidgetData("table", { columns: ["A"], rows: [[1]] }), {
    columns: ["A"],
    rows: [[1]],
  });
  // Config: unknown keys dropped, missing ones defaulted, wrong ones refused.
  assert.deepEqual(hubWidgetConfig("calendar", { range: "week", junk: 1 }), {
    range: "week",
    tasks: true,
    dayStart: 7,
    dayEnd: 19,
  });
  assert.equal(hubWidgetConfig("calendar", { range: "year" }), null);
  assert.equal(hubWidgetConfig("TEST-nope", {}), null);
});

test("agent-hub/3: typed widgets are added with defaults, sources are checked, fills start for AI widgets only", () => {
  const f = fixture();
  const added = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "calendar", config: { range: "week" } },
  });
  const calendar = added.view.items.find((item) => item.kind === "widget")!;
  assert.equal(calendar.title, "Kalendář");
  assert.equal(calendar.refresh, "hourly");
  assert.deepEqual(calendar.view, { type: "widget" });
  assert.deepEqual(calendar.widget, {
    type: "calendar",
    version: 2,
    fill: "ai",
    brief: "Moje schůzky z kalendáře a úkoly s termínem.",
    config: { range: "week", tasks: true, dayStart: 7, dayEnd: 19 },
    sources: [],
    data: null,
    recipe: null,
    requested: false,
  });
  // The registry's size, at the first free place.
  assert.deepEqual(
    { w: calendar.layout.w, h: calendar.layout.h },
    { w: 6, h: 5 },
  );
  // The person added it: it fills right away.
  assert.deepEqual(added.refresh, [calendar.id]);
  assert.equal(calendar.result?.status, "running");
  assert.equal(calendar.result?.conversationId, undefined);

  // Sources are services the person can read from now; names come from the server.
  const sourced = f.v3({
    type: "add",
    kind: "widget",
    widget: {
      type: "inbox",
      brief: "TEST mail from customers",
      sources: ["TEST-mail"],
    },
  });
  const inbox = sourced.view.items.find(
    (item) => item.widget?.type === "inbox",
  )!;
  assert.deepEqual(inbox.widget?.sources, [
    { id: "TEST-mail", name: "TEST Mail" },
  ]);
  assert.throws(
    () =>
      f.v3({
        type: "add",
        kind: "widget",
        widget: { type: "inbox", sources: ["TEST-gone"] },
      }),
    code("hub_source_unavailable"),
  );
  assert.throws(
    () =>
      f.v3({ type: "add", kind: "widget", widget: { type: "test_unknown" } }),
    code("hub_widget_invalid"),
  );
  assert.throws(
    () =>
      f.v3({
        type: "add",
        kind: "widget",
        widget: { type: "chart", config: { kind: "radar" } },
      }),
    code("hub_widget_invalid"),
  );
  // A built-in widget needs no AI: nothing starts, it is never stale.
  const meetings = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "meetings" },
  });
  assert.deepEqual(meetings.refresh, []);
  const card = meetings.view.items.find(
    (item) => item.widget?.type === "meetings",
  )!;
  assert.equal(card.stale, false);
  assert.equal(card.result, null);
  assert.deepEqual(card.widget?.data, {
    meetings: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        title: "TEST sales sync",
        recordedAt: "2026-10-15T09:00:00.000Z",
        status: "ready",
        summary: "TEST agreed on prices",
        tasks: 2,
      },
    ],
  });
  const approvals = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "approvals", brief: "ignored" },
  });
  const waiting = approvals.view.items.find(
    (item) => item.widget?.type === "approvals",
  )!;
  // The app fills it from its own chat session.
  assert.equal(waiting.widget?.fill, "client");
  assert.equal(waiting.widget?.brief, "");
  assert.equal(waiting.widget?.data, null);
  HubDashboardV3Schema.parse(f.cards());
});

test("a fill stores validated data and its recipe; a changed request starts over and failures keep the last data", () => {
  const f = fixture();
  const { view } = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "list", brief: "TEST new companies" },
  });
  const id = view.items.find((item) => item.kind === "widget")!.id;
  const request = f.hub.fillRequest(anna.actor, id);
  assert.deepEqual(request, {
    type: "list",
    brief: "TEST new companies",
    config: { count: 8 },
    sources: [],
    recipe: null,
    timeZone: "Europe/Prague",
  });
  const recipe = {
    calls: [
      {
        serviceId: "TEST-crm",
        serviceRevision: 1,
        actionId: "TEST-companies",
        actionRevision: 1,
        input: { limit: 5 },
      },
    ],
    services: ["TEST CRM"],
  };
  // Data that doesn't fit the type is refused, nothing is stored.
  assert.throws(
    () =>
      f.hub.fillDone(anna.actor, id, request, {
        data: { items: [{ detail: "no title" }] },
        recipe,
      }),
    code("hub_fill_invalid"),
  );
  assert.equal(
    f.cards().items.find((item) => item.id === id)!.widget!.data,
    null,
  );
  f.advance(1000);
  f.hub.fillDone(anna.actor, id, request, {
    data: { items: [{ title: "TEST Acme" }] },
    recipe,
  });
  let card = f.cards().items.find((item) => item.id === id)!;
  assert.deepEqual(card.widget?.data, { items: [{ title: "TEST Acme" }] });
  assert.deepEqual(card.widget?.recipe, { services: ["TEST CRM"], reads: 1 });
  assert.equal(card.result?.status, "succeeded");
  assert.equal(card.result?.producedAt, "2026-10-16T08:00:01.000Z");
  // The recipe stays on the server: the next fill gets it as a hint.
  assert.deepEqual(f.hub.fillRequest(anna.actor, id).recipe, recipe);
  // A failed refresh keeps the last good data.
  f.hub.record(anna.actor, anna.scope, id, {
    type: "failed",
    error: "catalog_budget_exhausted",
  });
  card = f.cards().items.find((item) => item.id === id)!;
  assert.equal(card.result?.status, "failed");
  assert.equal(card.result?.error, "catalog_budget_exhausted");
  assert.equal(card.result?.producedAt, "2026-10-16T08:00:01.000Z");
  assert.deepEqual(card.widget?.data, { items: [{ title: "TEST Acme" }] });
  // The person changes the request: the recipe goes, a new fill starts.
  const changed = f.v3({
    type: "setWidget",
    itemId: id,
    brief: "TEST companies from this week",
    config: { count: 3 },
  });
  assert.deepEqual(changed.refresh, [id]);
  card = changed.view.items.find((item) => item.id === id)!;
  assert.equal(card.widget?.brief, "TEST companies from this week");
  assert.deepEqual(card.widget?.config, { count: 3 });
  assert.equal(card.widget?.recipe, null);
  assert.deepEqual(card.widget?.data, { items: [{ title: "TEST Acme" }] });
  // A fill that answered the old request keeps its data but not its recipe.
  f.hub.fillDone(anna.actor, id, request, {
    data: { items: [{ title: "TEST Beta" }] },
    recipe,
  });
  assert.equal(f.hub.fillRequest(anna.actor, id).recipe, null);
  assert.throws(
    () => f.v3({ type: "setView", itemId: id, view: { type: "summary" } }),
    code("hub_view_invalid"),
  );
});

test("older profiles never see typed widgets, and their grid changes keep them in place", () => {
  const f = fixture();
  f.v3({ type: "add", kind: "widget", widget: { type: "kpi" } });
  const all = f.cards().items;
  const tasks = all.find((item) => item.kind === "tasks")!;
  const kpi = all.find((item) => item.kind === "widget")!;
  const v2 = f.hub.dashboard(anna.actor, anna.scope, "cs");
  HubDashboardSchema.parse(v2);
  assert.equal(v2.profile, HUB_PROFILE_V2);
  assert.deepEqual(
    v2.items.map((item) => item.id),
    [tasks.id],
  );
  assert.deepEqual(
    f.hub.view(anna.actor, anna.scope, "cs").items.map((item) => item.id),
    [tasks.id],
  );
  // An agent-hub/2 layout names only what it sees; the KPI keeps its place.
  const moved = f.hub.command(anna.actor, anna.scope, "cs", {
    profile: HUB_PROFILE_V2,
    type: "layout",
    items: [{ itemId: tasks.id, layout: { x: 7, y: 0, w: 4, h: 3 } }],
  });
  assert.equal(moved.view.profile, HUB_PROFILE_V2);
  const after = f.cards().items;
  assert.deepEqual(
    after.find((item) => item.id === kpi.id)!.layout,
    kpi.layout,
  );
  assert.deepEqual(after.find((item) => item.id === tasks.id)!.layout, {
    x: 7,
    y: 0,
    w: 4,
    h: 3,
  });
  // Overlapping a widget it can't see is still refused.
  assert.throws(
    () =>
      f.hub.command(anna.actor, anna.scope, "cs", {
        profile: HUB_PROFILE_V2,
        type: "layout",
        items: [{ itemId: tasks.id, layout: kpi.layout }],
      }),
    code("hub_layout_invalid"),
  );
  // Reordering in agent-hub/2 keeps the typed widgets after the rest.
  f.hub.command(anna.actor, anna.scope, "cs", {
    profile: HUB_PROFILE_V2,
    type: "reorder",
    itemIds: [tasks.id],
  });
  assert.equal(f.cards().items.length, 2);
  // Typed widgets follow their own minimum size in agent-hub/3 layouts.
  assert.deepEqual(hubItemSize(kpi), { w: 3, h: 2, minW: 2, minH: 2 });
  assert.equal(
    hubLayoutIssue([
      { layout: { x: 0, y: 0, w: 1, h: 2 }, type: hubItemSize(kpi) },
    ]),
    "hub_layout_invalid",
  );
});

test("AI widgets are due like processes, and a requested refresh runs on the next open", () => {
  const f = fixture();
  const { view } = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "briefing" },
  });
  const id = view.items.find((item) => item.kind === "widget")!.id;
  const request = f.hub.fillRequest(anna.actor, id);
  f.hub.fillDone(anna.actor, id, request, {
    data: { summary: "TEST", highlights: [] },
    recipe: null,
  });
  f.hub.release(anna.scope, id);
  assert.equal(f.cards().items.find((item) => item.id === id)!.stale, false);
  f.advance(25 * 3_600_000);
  assert.equal(f.cards().items.find((item) => item.id === id)!.stale, true);
  // Opening the overview starts what is due.
  const opened = f.v3({ type: "refresh", stale: true });
  assert.deepEqual(opened.refresh, [id]);
  f.hub.fillDone(anna.actor, id, request, {
    data: { summary: "TEST 2", highlights: [] },
    recipe: null,
  });
  f.hub.release(anna.scope, id);
  assert.equal(
    hubItemStale(
      { kind: "widget", refresh: "daily", result: null, widget: null },
      0,
    ),
    false,
  );
});

test("the agent adds typed widgets that wait for the person, and refreshes only confirmed ones", () => {
  const f = fixture();
  const agent = f.hub.agent(anna.actor, anna.scope, "cs");
  const listed = agent.list();
  assert.deepEqual(
    listed.widgetTypes.map((type) => type.type),
    HUB_WIDGET_TYPES.map((definition) => definition.type),
  );
  const added = agent.addWidget({
    id: "TEST-agent-calendar",
    type: "calendar",
    brief: "TEST my meetings and tasks with a due date",
    config: { range: "next3" },
  });
  assert.equal(added.refresh, "manual");
  assert.deepEqual(added.config, {
    range: "next3",
    tasks: true,
    dayStart: 7,
    dayEnd: 19,
  });
  // A replayed call adds the same widget.
  assert.equal(
    agent.addWidget({ id: "TEST-agent-calendar", type: "calendar" }).itemId,
    added.itemId,
  );
  let card = f.cards().items.find((item) => item.id === added.itemId)!;
  // Never refreshed and manual: not due, nothing runs on open.
  assert.equal(card.result, null);
  assert.equal(card.stale, false);
  assert.deepEqual(f.v3({ type: "refresh", stale: true }).refresh, []);
  assert.throws(
    () => agent.refresh(added.itemId),
    code("hub_confirm_required"),
  );
  const listedWidget = agent
    .list()
    .items.find((item) => item.itemId === added.itemId)!;
  assert.equal(
    (listedWidget as { waitsForPerson?: boolean }).waitsForPerson,
    true,
  );
  // The agent changes what it shows and its size; nothing runs.
  const changed = agent.setWidget({
    itemId: added.itemId,
    brief: "TEST only customer meetings",
    title: "TEST Zákazníci",
    size: { w: 8, h: 6 },
  });
  assert.equal(changed.brief, "TEST only customer meetings");
  assert.equal(changed.title, "TEST Zákazníci");
  assert.deepEqual(changed.size, { w: 8, h: 6 });
  // The person refreshes it on the page; from then on the agent may ask again.
  const confirmed = f.v3({ type: "refresh", itemIds: [added.itemId] });
  assert.deepEqual(confirmed.refresh, [added.itemId]);
  f.hub.record(anna.actor, anna.scope, added.itemId, {
    type: "failed",
    error: "service_unavailable",
  });
  assert.deepEqual(agent.refresh(added.itemId), {
    itemId: added.itemId,
    status: "requested",
  });
  card = f.cards().items.find((item) => item.id === added.itemId)!;
  assert.equal(card.widget?.requested, true);
  assert.equal(card.stale, true);
  // The next open starts it and clears the request.
  assert.deepEqual(f.v3({ type: "refresh", stale: true }).refresh, [
    added.itemId,
  ]);
  assert.equal(
    f.cards().items.find((item) => item.id === added.itemId)!.widget?.requested,
    false,
  );
  // Built-ins have nothing to refresh.
  const meetings = agent.addWidget({
    id: "TEST-agent-meetings",
    type: "meetings",
  });
  assert.throws(
    () => agent.refresh(meetings.itemId),
    code("hub_refresh_unavailable"),
  );
  assert.throws(
    () => agent.setView({ itemId: added.itemId, view: { type: "number" } }),
    code("hub_view_invalid"),
  );
});

test("a card is only valid with its kind's parts and its type's data", () => {
  const base = {
    id: "TEST-card",
    title: "TEST",
    refresh: "daily" as const,
    position: 0,
    createdAt: "2026-10-16T08:00:00.000Z",
    result: null,
    stale: false,
    layout: { x: 0, y: 0, w: 3, h: 2 },
    data: null,
    fields: null,
  };
  const widget = {
    type: "kpi",
    version: 1,
    fill: "ai" as const,
    brief: "TEST",
    config: { unit: "", goal: "up" },
    sources: [],
    data: { value: 3, label: "TEST" },
    recipe: null,
    requested: false,
  };
  HubCardSchema.parse({
    ...base,
    kind: "widget",
    view: { type: "widget" },
    widget,
  });
  assert.equal(
    HubCardSchema.safeParse({
      ...base,
      kind: "widget",
      view: { type: "widget" },
      widget: { ...widget, data: { value: "three" } },
    }).success,
    false,
  );
  assert.equal(
    HubCardSchema.safeParse({
      ...base,
      kind: "widget",
      view: { type: "summary" },
      widget,
    }).success,
    false,
  );
  assert.equal(
    HubCardSchema.safeParse({
      ...base,
      kind: "tasks",
      view: { type: "tasks" },
      widget,
    }).success,
    false,
  );
  // A type this build doesn't know is passed through, never parsed.
  HubCardSchema.parse({
    ...base,
    kind: "widget",
    view: { type: "widget" },
    widget: { ...widget, type: "future_type", data: { anything: true } },
  });
});

test("a hub database from before typed widgets is rebuilt once to allow them, keeping every item", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE agent_workspace_member(workspace_id TEXT, member_id TEXT);
    INSERT INTO organization VALUES ('${org}');
    INSERT INTO member VALUES ('TEST-m-anna','${org}','TEST-anna');
    INSERT INTO agent_workspace VALUES ('${workspaceId}','${org}');
    CREATE TABLE agent_hub (workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE, user_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, member_id)) STRICT;
    CREATE TABLE agent_hub_item (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('tasks','process')), process_id TEXT, title TEXT NOT NULL, refresh TEXT NOT NULL CHECK(refresh IN ('manual','hourly','daily','on_open')), position INTEGER NOT NULL, created_at TEXT NOT NULL, result TEXT CHECK(result IS NULL OR json_valid(result)), layout TEXT, view TEXT, shape TEXT, snapshot TEXT, CHECK((kind = 'process') = (process_id IS NOT NULL)), FOREIGN KEY(workspace_id, member_id) REFERENCES agent_hub(workspace_id, member_id) ON DELETE CASCADE) STRICT;
    INSERT INTO agent_hub VALUES ('${workspaceId}','TEST-m-anna','TEST-anna',5,'2026-10-01T00:00:00.000Z');
    INSERT INTO agent_hub_item VALUES
      ('TEST-t','${workspaceId}','TEST-m-anna','tasks',NULL,'Úkoly','on_open',0,'2026-10-01T00:00:00.000Z',NULL,'{"x":0,"y":0,"w":4,"h":3}','{"type":"tasks"}',NULL,NULL),
      ('TEST-a','${workspaceId}','TEST-m-anna','process','TEST-day','TEST day','daily',1,'2026-10-01T00:00:00.000Z',NULL,'{"x":4,"y":0,"w":6,"h":4}','{"type":"summary"}',NULL,NULL);`);
  const store = new HubStore(db);
  const before = store.read(owner, "Úkoly");
  assert.equal(before.revision, 5);
  assert.deepEqual(
    before.items.map((item) => [item.id, item.kind, item.layout.x]),
    [
      ["TEST-t", "tasks", 0],
      ["TEST-a", "process", 4],
    ],
  );
  const added = store.add(owner, "Úkoly", {
    kind: "widget",
    title: "TEST KPI",
    refresh: "daily",
    widget: {
      type: "kpi",
      version: 1,
      brief: "TEST",
      config: { unit: "", goal: "up" },
      sources: [],
    },
  });
  assert.equal(added.kind, "widget");
  // The unique Tasks and process indexes survived the rebuild.
  assert.throws(
    () =>
      store.add(owner, "Úkoly", {
        kind: "tasks",
        title: "Úkoly",
        refresh: "on_open",
      }),
    code("hub_item_exists"),
  );
  // Opening it again changes nothing; removing the member still cascades.
  new HubStore(db);
  assert.equal(store.read(owner, "Úkoly").items.length, 3);
  db.exec("DELETE FROM agent_hub");
  assert.equal(
    Number(db.prepare("SELECT COUNT(*) AS n FROM agent_hub_item").get()!.n),
    0,
  );
});

test("the overview's sizes come from the registry for typed widgets", () => {
  for (const definition of HUB_WIDGET_TYPES)
    assert.deepEqual(
      hubItemSize({
        view: { type: "widget" },
        widget: { type: definition.type },
      }),
      definition.size,
    );
  assert.deepEqual(
    hubItemSize({ view: { type: "widget" }, widget: { type: "TEST-x" } }),
    { w: 4, h: 3, minW: 2, minH: 2 },
  );
  assert.deepEqual(hubItemSize({ view: { type: "chart" } }).minW, 3);
  z.object({}).parse({});
});

test("a fill this server no longer runs is shown as interrupted, keeping its data", () => {
  const f = fixture();
  const { view } = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "kpi" },
  });
  const id = view.items.find((item) => item.kind === "widget")!.id;
  assert.equal(
    f.cards().items.find((item) => item.id === id)!.result?.status,
    "running",
  );
  // The runner's bookkeeping is gone (a restart): the next read settles it.
  f.hub.release(anna.scope, id);
  const card = f.cards().items.find((item) => item.id === id)!;
  assert.equal(card.result?.status, "failed");
  assert.equal(card.result?.error, "hub_refresh_interrupted");
});

test("a widget stored with an older type version is upgraded on read: data dropped, settings re-read, recipe kept", () => {
  const f = fixture();
  const added = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "calendar", config: { range: "week" } },
  });
  const id = added.view.items.find((item) => item.kind === "widget")!.id;
  const recipe = {
    calls: [
      {
        serviceId: "TEST-mail",
        serviceRevision: 1,
        actionId: "TEST-events",
        actionRevision: 1,
        input: { top: 24 },
      },
    ],
    services: ["TEST Mail"],
  };
  // The row as an earlier server left it: calendar v1 with its data and settings.
  f.db.prepare("UPDATE agent_hub_item SET widget = ? WHERE id = ?").run(
    JSON.stringify({
      type: "calendar",
      version: 1,
      brief: "TEST old",
      config: { range: "week", tasks: true, count: 24 },
      sources: [],
      data: { events: [], tasks: [] },
      recipe,
      requested: false,
    }),
    id,
  );
  const card = f.cards().items.find((item) => item.id === id)!;
  assert.equal(card.widget?.version, 2);
  assert.equal(card.widget?.data, null);
  assert.deepEqual(card.widget?.config, {
    range: "week",
    tasks: true,
    dayStart: 7,
    dayEnd: 19,
  });
  // The fill is requested like any other: the old version is no refusal.
  const request = f.hub.fillRequest(anna.actor, id);
  assert.equal(request.type, "calendar");
  assert.deepEqual(request.recipe, recipe);
});

test("a meetings widget stored before `next` reads as version 2 with the server's data", () => {
  const f = fixture();
  const added = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "meetings" },
  });
  const id = added.view.items.find((item) => item.kind === "widget")!.id;
  f.db.prepare("UPDATE agent_hub_item SET widget = ? WHERE id = ?").run(
    JSON.stringify({
      type: "meetings",
      version: 1,
      brief: "",
      config: { count: 4 },
      sources: [],
      data: { meetings: [] },
      recipe: null,
      requested: false,
    }),
    id,
  );
  const card = f.cards().items.find((item) => item.id === id)!;
  assert.equal(card.widget?.version, 2);
  assert.deepEqual(card.widget?.config, { count: 4 });
  assert.equal(
    (card.widget?.data as { meetings: unknown[] } | null)?.meetings.length,
    1,
  );
});

test("a stored recipe with a malformed read is dropped on read, so hints and replays never see it", () => {
  const f = fixture();
  const added = f.v3({
    type: "add",
    kind: "widget",
    widget: { type: "calendar", config: { range: "week" } },
  });
  const id = added.view.items.find((item) => item.kind === "widget")!.id;
  const good = {
    serviceId: "TEST-mail",
    serviceRevision: 1,
    actionId: "TEST-events",
    actionRevision: 1,
    input: { top: 24 },
  };
  for (const calls of [[good, null], [good, { actionId: "TEST-x" }], ["x"]]) {
    f.db.prepare("UPDATE agent_hub_item SET widget = ? WHERE id = ?").run(
      JSON.stringify({
        type: "calendar",
        version: 2,
        brief: "TEST old",
        config: { range: "week" },
        sources: [],
        data: null,
        recipe: { calls, services: ["TEST Mail"] },
        requested: false,
      }),
      id,
    );
    assert.equal(f.hub.fillRequest(anna.actor, id).recipe, null);
  }
});
