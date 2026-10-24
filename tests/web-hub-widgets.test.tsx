import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import type { Store } from "../packages/client-core/store";
import {
  HUB_PROFILE_V3,
  type HubCard,
  type HubDashboardV3,
  type HubDashboardV3Command,
  type HubWidgetState,
} from "../packages/protocol/hub";
import {
  HUB_WIDGET_TYPES,
  hubWidgetDefinition,
} from "../packages/protocol/widgets";
import { HubDashboardView } from "../apps/server-admin/web/app/hub-page";
import { hubCopy } from "../apps/server-admin/web/app/hub-copy";
import {
  UNSAVED_DRAFT,
  draftKey,
  readDraft,
} from "../apps/server-admin/web/app/chat-store";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const mockNavigate = jest.fn();
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({
      to,
      params,
      ...props
    }: React.ComponentProps<"a"> & {
      to: string;
      params?: Record<string, string>;
    }) =>
      React.createElement("a", {
        ...props,
        href: Object.entries(params ?? {}).reduce(
          (path, [key, value]) => path.replace(`$${key}`, value),
          to,
        ),
      }),
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
    useRouterState: () => "/",
  };
});
let mockAdmin = false;
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs", isAdmin: mockAdmin }),
  useAppSession: () => {
    throw new Error("Pass the session directly");
  },
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/label", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/progress", () => host(), { virtual: true });
jest.mock("@admin/components/ui/separator", () => host(), { virtual: true });
jest.mock("@admin/components/ui/radio-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sidebar", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/ui/tooltip", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/kbd", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/ui/table", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/popover", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dialog", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
// Charts are recharts in the browser; here the widget's points are enough.
jest.mock("../apps/server-admin/web/app/hub-chart", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    __esModule: true,
    default: ({
      kind,
      points,
      series,
      stacked,
    }: {
      kind: string;
      points: unknown[];
      series?: unknown[];
      stacked?: boolean;
    }) =>
      React.createElement("div", {
        "data-testid": "hub-chart",
        "data-kind": kind,
        "data-points": JSON.stringify(points),
        "data-series": series ? JSON.stringify(series) : undefined,
        "data-stacked": stacked,
      }),
  };
});
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock(
  "@admin/components/console/forms",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      ConfirmAction: ({
        open,
        title,
        description,
        confirmLabel,
        onConfirm,
      }: {
        open: boolean;
        title: string;
        description?: string;
        confirmLabel: string;
        onConfirm: () => void;
      }) =>
        open
          ? React.createElement(
              "div",
              { "data-host": "ConfirmAction" },
              title,
              description,
              React.createElement(
                "button",
                { "data-testid": "confirm-action", onClick: onConfirm },
                confirmLabel,
              ),
            )
          : null,
      DetailList: ({
        items,
      }: {
        items: { label: string; value: React.ReactNode }[];
      }) =>
        React.createElement(
          "dl",
          null,
          items.map((item) =>
            React.createElement(
              "div",
              { key: item.label },
              React.createElement("dt", null, item.label),
              React.createElement("dd", null, item.value),
            ),
          ),
        ),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/markdown",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Markdown: ({ text }: { text: string }) =>
        React.createElement("div", { "data-host": "Markdown" }, text),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/entity-icon",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule({ initials: (name: string) => name.slice(0, 2) }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/time",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule({ formatRelative: () => "" }),
  { virtual: true },
);

const scope = {
  connectionId: "account-workspace-1",
  serverId: "server-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};
const baseStore: Store = {
  connectionKey: "https://aa.example/v1/a",
  scope,
  cursor: 1,
  conversations: {},
  workItems: {},
  inputRequests: {},
  actionProposals: {},
  operations: {},
  seen: [],
  stale: false,
  needsSnapshot: false,
};
const copy = hubCopy.cs;
const succeeded = {
  status: "succeeded" as const,
  startedAt: "2026-10-16T06:00:00.000Z",
  producedAt: "2026-10-16T06:00:05.000Z",
};
/** A local date-time `days` from today, without an offset. */
const at = (days: number, hour: number, minute = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}:00`;
};
const widgetItem = (
  id: string,
  type: string,
  widget: Partial<HubWidgetState> = {},
  patch: Partial<HubCard> = {},
): HubCard => {
  const definition = hubWidgetDefinition(type)!;
  return {
    id,
    kind: "widget",
    title: definition.name.cs,
    refresh: definition.refresh,
    position: 0,
    createdAt: "2026-10-16T07:00:00.000Z",
    result: definition.fill === "ai" ? succeeded : null,
    stale: false,
    layout: { x: 0, y: 0, ...definition.size },
    view: { type: "widget" },
    data: null,
    fields: null,
    widget: {
      type,
      version: definition.version,
      fill: definition.fill,
      brief: definition.brief?.cs ?? "",
      config: definition.defaultConfig as Record<string, unknown>,
      sources: [],
      data: null,
      recipe: null,
      requested: false,
      ...widget,
    },
    ...patch,
  };
};
const dashboard = (items: HubCard[]): HubDashboardV3 => ({
  profile: HUB_PROFILE_V3,
  scope,
  revision: 1,
  items,
  tasks: { open: 0, top: [] },
});

function fakeSession(initial: HubDashboardV3, store: Store = baseStore) {
  const state: SessionState = {
    store,
    status: "online",
    commandStates: {},
    pending: null,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    error: null,
    processNotice: null,
    activity: null,
    activityConnection: "waiting",
  };
  let current = initial;
  const commands: HubDashboardV3Command[] = [];
  const session = {
    identityKey: "identity-1",
    subscribe: () => () => {},
    getSnapshot: () => state,
    start: jest.fn(async () => {}),
    refresh: jest.fn(async () => {}),
    readHub: jest.fn(async () => current),
    readMentions: jest.fn(async () => ({
      profile: "agent-mentions/1",
      items: [
        { kind: "service", id: "svc-crm", name: "CRM" },
        { kind: "service", id: "svc-cal", name: "Kalendář" },
        { kind: "process", id: "proc-1", name: "Proces" },
      ],
    })),
    sendHubCommand: jest.fn(
      async (_language: string, command: HubDashboardV3Command) => {
        commands.push(command);
        if (command.type === "layout")
          current = {
            ...current,
            items: current.items.map((item) => ({
              ...item,
              layout:
                command.items.find((entry) => entry.itemId === item.id)
                  ?.layout ?? item.layout,
            })),
          };
        return current;
      },
    ),
    loadProcessInventory: jest.fn(async () => ({ processes: [] })),
  };
  return { session: session as unknown as ClientSession, commands };
}
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
function button(root: ReactTestInstance, label: string) {
  const found = root.findAll(
    (node) =>
      node.type === "button" &&
      (text(node).includes(label) || node.props["aria-label"] === label),
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
}
const byTestId = (root: ReactTestInstance, id: string) =>
  root.findAll(
    (node) => typeof node.type === "string" && node.props["data-testid"] === id,
  );
/** The grid only: closed sheets render their content in these tests. */
const grid = (root: ReactTestInstance) => byTestId(root, "hub-grid")[0]!;
const openSheet = (root: ReactTestInstance) =>
  root.find(
    (node) => node.props["data-host"] === "Sheet" && node.props.open === true,
  );
async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((unmount) => unmount());
  mockNavigate.mockReset();
  mockAdmin = false;
});
async function render(element: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    );
  });
  mounted.push(() => {
    act(() => renderer.unmount());
    client.clear();
  });
  await settle();
  return renderer.root;
}

test("an empty overview offers one way in; the gallery adds a calendar from its brief", async () => {
  const { session, commands } = fakeSession(dashboard([]));
  const root = await render(<HubDashboardView session={session} />);
  expect(byTestId(root, "hub-empty")).toHaveLength(1);
  expect(byTestId(root, "hub-grid")).toHaveLength(0);
  expect(text(root)).not.toContain("Dej si sem");
  await act(async () => button(root, copy.editOverview).props.onClick());
  await settle();
  // Editing: the grid's free cells, and adding from the header.
  expect(byTestId(root, "hub-slot")).toHaveLength(12);
  await act(async () => button(root, copy.add).props.onClick());
  await settle();
  const gallery = byTestId(openSheet(root), "hub-gallery")[0]!;
  const cards = byTestId(gallery, "gallery-type");
  expect(cards.map((card) => card.props["data-type"])).toEqual(
    HUB_WIDGET_TYPES.map((type) => type.type),
  );
  // Every type shows a preview of its sample data.
  for (const card of cards)
    expect(byTestId(card, "gallery-preview")).toHaveLength(1);
  expect(byTestId(gallery, "gallery-preset").length).toBeGreaterThan(0);
  expect(text(gallery)).toContain(copy.tasks);
  expect(text(gallery)).toContain(copy.fromProcess);
  const calendar = cards.find(
    (card) => card.props["data-type"] === "calendar",
  )!;
  await act(async () => calendar.findAllByType("button")[0]!.props.onClick());
  await settle();
  const form = byTestId(openSheet(root), "hub-widget-form")[0]!;
  expect(form.props["data-type"]).toBe("calendar");
  // Sources are the services the overview can read, not every mention.
  expect(session.readMentions).toHaveBeenCalledWith(expect.anything(), "hub");
  const brief = form.find((node) => node.props["data-host"] === "Textarea");
  expect(brief.props.value).toBe(hubWidgetDefinition("calendar")!.brief!.cs);
  await act(async () =>
    brief.props.onChange({ target: { value: "Schůzky a termíny z CRM" } }),
  );
  const range = form.find(
    (node) =>
      node.props["data-host"] === "ToggleGroup" &&
      node.props["aria-label"] === "Rozsah",
  );
  await act(async () => range.props.onValueChange("week"));
  // Only services can be tagged as sources.
  const sources = form.find(
    (node) =>
      node.props["data-host"] === "ToggleGroup" &&
      node.props["aria-label"] === copy.sourcesLabel,
  );
  expect(
    sources
      .findAll((node) => node.props["data-host"] === "ToggleGroupItem")
      .map((node) => node.props.value),
  ).toEqual(["svc-crm", "svc-cal"]);
  await act(async () => sources.props.onValueChange(["svc-crm"]));
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  await settle();
  expect(commands.at(-1)).toEqual({
    profile: HUB_PROFILE_V3,
    type: "add",
    kind: "widget",
    widget: {
      type: "calendar",
      brief: "Schůzky a termíny z CRM",
      config: { range: "week", tasks: true, dayStart: 7, dayEnd: 19 },
      sources: ["svc-crm"],
    },
  });
});

test("editing a widget's request sends only what changed", async () => {
  const { session, commands } = fakeSession(
    dashboard([
      widgetItem("inbox-1", "inbox", {
        sources: [{ id: "svc-crm", name: "CRM" }],
        data: { emails: [] },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const edit = root.find(
    (node) =>
      node.props["data-host"] === "DropdownMenuItem" &&
      text(node).includes(copy.editBrief),
  );
  await act(async () => edit.props.onSelect());
  await settle();
  const form = byTestId(openSheet(root), "hub-widget-form")[0]!;
  const brief = form.find((node) => node.props["data-host"] === "Textarea");
  await act(async () =>
    brief.props.onChange({ target: { value: "Jen e-maily od klientů" } }),
  );
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  await settle();
  expect(commands).toEqual([
    {
      profile: HUB_PROFILE_V3,
      type: "setWidget",
      itemId: "inbox-1",
      brief: "Jen e-maily od klientů",
    },
  ]);
});

test("the calendar shows the days with timed events and tasks and prepares a meeting in chat", async () => {
  const { session } = fakeSession(
    dashboard([
      widgetItem(
        "cal",
        "calendar",
        {
          config: { range: "next3", tasks: true, dayStart: 7, dayEnd: 19 },
          data: {
            events: [
              {
                title: "Prezentace",
                start: at(1, 14),
                end: at(1, 15),
              },
              {
                title: "Porada týmu",
                start: at(0, 9),
                end: at(0, 9, 30),
                location: "Zasedačka",
                attendees: ["Jana", "Petr"],
              },
            ],
            tasks: [{ title: "Poslat nabídku", due: at(0, 16) }],
          },
        },
        { layout: { x: 0, y: 0, w: 6, h: 5 } },
      ),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const days = byTestId(grid(root), "calendar-day");
  expect(days).toHaveLength(3);
  expect(days[0]!.props["data-today"]).toBe(true);
  const [today, tomorrow] = days.map((day) => day.props["data-date"]);
  // Today: the meeting at 9 and the task due at 16; tomorrow the talk.
  expect(
    byTestId(grid(root), "calendar-event").map(
      (node) => node.props["data-day"],
    ),
  ).toEqual([today, tomorrow]);
  const tasks = byTestId(grid(root), "calendar-task");
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.props["data-day"]).toBe(today);
  // The event's details offer to prepare for the meeting in a new chat.
  const porada = byTestId(grid(root), "calendar-event")[0]!;
  let popover: ReactTestInstance | null = porada;
  while (popover && popover.props["data-host"] !== "Popover")
    popover = popover.parent;
  await act(async () => popover!.props.onOpenChange(true));
  const prepare = byTestId(grid(root), "widget-ask-item")[0]!;
  expect(text(prepare)).toContain("Připrav mě na tuto schůzku");
  await act(async () => prepare.props.onClick());
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/chat" });
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toMatch(
    /^Připrav mě na schůzku „Porada týmu“ \(.*9:00–9:30, Zasedačka\)\.$/,
  );
});

test("the inbox lists senders with an importance badge and drafts a reply in chat", async () => {
  const { session } = fakeSession(
    dashboard([
      widgetItem("mail", "inbox", {
        data: {
          emails: [
            {
              from: "Jana Nováková",
              subject: "Cenová nabídka",
              receivedAt: at(0, 8),
              summary: "Čeká na potvrzení ceny.",
              importance: "high",
              suggestedAction: "Potvrdit cenu",
            },
            {
              from: "Newsletter",
              subject: "Novinky",
              receivedAt: at(0, 7),
              summary: "Týdenní novinky.",
              importance: "low",
            },
          ],
          unread: 4,
        },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const rows = byTestId(grid(root), "inbox-email");
  expect(rows.map((row) => row.props["data-importance"])).toEqual([
    "high",
    "low",
  ]);
  expect(
    rows[0]!.findAll((node) => node.props["data-host"] === "StatusBadge"),
  ).toHaveLength(1);
  expect(
    rows[1]!.findAll((node) => node.props["data-host"] === "StatusBadge"),
  ).toHaveLength(0);
  expect(text(grid(root))).toContain("4 nepřečtených");
  // The summary and the actions open with the row.
  expect(byTestId(rows[0]!, "inbox-detail")).toHaveLength(0);
  await act(async () => rows[0]!.findAllByType("button")[0]!.props.onClick());
  expect(text(byTestId(rows[0]!, "inbox-detail")[0]!)).toContain(
    "Čeká na potvrzení ceny.",
  );
  await act(async () =>
    byTestId(rows[0]!, "widget-ask-item")[0]!.props.onClick(),
  );
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toContain(
    "Navrhni odpověď na e-mail od Jana Nováková „Cenová nabídka“",
  );
});

test("a KPI shows its value, a change colored by the goal and a trend", async () => {
  const kpi = (id: string, goal: "up" | "down", x: number) =>
    widgetItem(
      id,
      "kpi",
      {
        config: { unit: "ks", goal },
        data: {
          value: 1234,
          label: "Otevřené obchody",
          delta: 5,
          deltaLabel: "oproti minulému týdnu",
          points: [1, 3, 2, 5],
        },
      },
      { layout: { x, y: 0, w: 3, h: 2 } },
    );
  const { session } = fakeSession(
    dashboard([kpi("up", "up", 0), kpi("down", "down", 3)]),
  );
  const root = await render(<HubDashboardView session={session} />);
  expect(text(byTestId(grid(root), "kpi-value")[0]!)).toMatch(/1\s?234ks/);
  expect(
    byTestId(grid(root), "kpi-delta").map((node) => node.props["data-good"]),
  ).toEqual(["true", "false"]);
  expect(text(byTestId(grid(root), "kpi-delta")[0]!)).toContain("+5");
  expect(byTestId(grid(root), "kpi-sparkline")).toHaveLength(2);
});

test("edit mode draws the grid's cells and a ghost where a widget lands", async () => {
  const { session } = fakeSession(
    dashboard([
      widgetItem(
        "a",
        "kpi",
        { data: null },
        { layout: { x: 0, y: 0, w: 3, h: 2 } },
      ),
      widgetItem(
        "b",
        "list",
        { data: null },
        { layout: { x: 3, y: 0, w: 4, h: 4 } },
      ),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  expect(byTestId(root, "hub-slot")).toHaveLength(0);
  await act(async () => button(root, copy.edit).props.onClick());
  await settle();
  const slots = byTestId(root, "hub-slot");
  // Four occupied rows and one free row below them.
  expect(slots).toHaveLength(12 * 5);
  const slot = (x: number, y: number) =>
    slots.find(
      (node) => node.props["data-x"] === x && node.props["data-y"] === y,
    )!;
  expect(slot(0, 0).props["data-free"]).toBe(false);
  expect(slot(3, 3).props["data-free"]).toBe(false);
  expect(slot(0, 2).props["data-free"]).toBe(true);
  expect(slot(11, 4).props["data-free"]).toBe(true);
  expect(byTestId(root, "hub-ghost")).toHaveLength(0);
  const cellOf = (id: string) =>
    root.find(
      (node) =>
        node.props["data-testid"] === "hub-cell" &&
        node.props["data-id"] === id,
    );
  const grip = cellOf("a").find(
    (node) =>
      node.type === "button" && node.props["data-testid"] === "hub-move",
  );
  const pointer = (x: number, y: number) => ({
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    preventDefault() {},
    currentTarget: { setPointerCapture() {} },
  });
  await act(async () => grip.props.onPointerDown(pointer(0, 0)));
  // 80 px cells and 96 px rows in tests: one row down, two columns right.
  await act(async () => grip.props.onPointerMove(pointer(160, 96 * 4)));
  const ghost = byTestId(root, "hub-ghost");
  expect(ghost).toHaveLength(1);
  expect(ghost[0]!.props["data-layout"]).toBe("2,4,3,2");
  // The row it moves into is no longer free in the preview.
  expect(
    byTestId(root, "hub-slot").find(
      (node) => node.props["data-x"] === 2 && node.props["data-y"] === 4,
    )!.props["data-free"],
  ).toBe(false);
  await act(async () => grip.props.onPointerUp(pointer(160, 96 * 4)));
  await settle();
  expect(byTestId(root, "hub-ghost")).toHaveLength(0);
  // Resizing shows its target too.
  const corner = cellOf("b").find(
    (node) =>
      node.type === "button" && node.props["data-testid"] === "hub-resize",
  );
  await act(async () => corner.props.onPointerDown(pointer(0, 0)));
  await act(async () => corner.props.onPointerMove(pointer(160, 0)));
  expect(byTestId(root, "hub-ghost")[0]!.props["data-layout"]).toMatch(/,6,4$/);
  await act(async () => corner.props.onPointerUp(pointer(160, 0)));
  await settle();
  // A keyboard user sees the place of the widget whose grip has focus.
  const grip2 = cellOf("a").find(
    (node) =>
      node.type === "button" && node.props["data-testid"] === "hub-move",
  );
  await act(async () => grip2.props.onFocus());
  expect(byTestId(root, "hub-ghost")).toHaveLength(1);
  await act(async () => grip2.props.onBlur());
  expect(byTestId(root, "hub-ghost")).toHaveLength(0);
});

test("asking about a widget opens a new chat with the widget as context", async () => {
  const { session } = fakeSession(
    dashboard([
      widgetItem("cal", "calendar", { data: { events: [], tasks: [] } }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  // "Ask" lives in the widget's menu; the card header keeps refresh and expand.
  expect(byTestId(root, "widget-ask")).toHaveLength(0);
  await act(async () => byTestId(root, "widget-ask-menu")[0]!.props.onSelect());
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/chat" });
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toBe(
    "K widgetu Kalendář (dnes · 7–19): ",
  );
});

test("AI widget states: new from the assistant, failed with the last data, and its sources", async () => {
  const { session, commands } = fakeSession(
    dashboard([
      widgetItem(
        "new",
        "briefing",
        { data: null },
        { result: null, refresh: "manual", layout: { x: 0, y: 0, w: 6, h: 3 } },
      ),
      widgetItem(
        "broken",
        "list",
        {
          data: { items: [{ title: "Acme" }] },
          recipe: { services: ["CRM"], reads: 1 },
        },
        {
          result: {
            status: "failed",
            startedAt: "2026-10-16T07:00:00.000Z",
            producedAt: "2026-10-16T06:00:05.000Z",
            error: "hub_fill_invalid",
          },
          layout: { x: 6, y: 0, w: 4, h: 4 },
        },
      ),
      widgetItem(
        "fine",
        "list",
        {
          data: { items: [{ title: "Beta" }] },
          recipe: { services: ["CRM", "Kalendář"], reads: 2 },
        },
        { layout: { x: 0, y: 4, w: 4, h: 4 } },
      ),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const cards = byTestId(root, "hub-widget");
  expect(cards.map((card) => card.props["data-status"])).toEqual([
    "never",
    "failed",
    "succeeded",
  ]);
  expect(text(cards[0]!)).toContain(copy.confirm);
  expect(text(cards[1]!)).toContain(copy.errors.hub_fill_invalid);
  // The last good data stays.
  expect(text(cards[1]!)).toContain("Acme");
  expect(text(cards[2]!)).toContain("Z: CRM, Kalendář");
  await act(async () =>
    cards[0]!
      .findAll(
        (node) => node.type === "button" && text(node).includes(copy.refresh),
      )[0]!
      .props.onClick(),
  );
  expect(commands.at(-1)).toEqual({
    profile: HUB_PROFILE_V3,
    type: "refresh",
    itemIds: ["new"],
  });
});

test("waiting approvals and questions come from the app's own chats; unknown types say so", async () => {
  const work = (id: string, status: string, title: string) => ({
    id,
    status,
    title,
    conversationId: `conv-${id}`,
  });
  const { session } = fakeSession(
    dashboard([
      widgetItem("approvals", "approvals"),
      widgetItem(
        "future",
        "kpi",
        { type: "future_type", version: 1 },
        { layout: { x: 4, y: 0, w: 3, h: 2 } },
      ),
    ]),
    {
      ...baseStore,
      workItems: {
        a: work("a", "waiting_approval", "Odeslat nabídku"),
        b: work("b", "running", "Běží"),
        c: work("c", "waiting_input", "Který termín?"),
      } as unknown as Store["workItems"],
    },
  );
  const root = await render(<HubDashboardView session={session} />);
  const rows = byTestId(grid(root), "approval-item");
  expect(rows.map((row) => row.props["data-kind"])).toEqual([
    "approval",
    "question",
  ]);
  expect(rows[0]!.findByType("a").props.href).toBe("/chat/conv-a");
  expect(text(root)).toContain(copy.unknownType);
});

const failed = (error: string) => ({
  status: "failed" as const,
  startedAt: "2026-10-16T07:00:00.000Z",
  producedAt: null,
  error,
});
const mail = [{ id: "svc-mail", name: "Mail" }];
const problems = () =>
  dashboard([
    widgetItem(
      "connect",
      "inbox",
      { sources: mail },
      {
        result: failed("connection_required"),
        layout: { x: 0, y: 0, w: 4, h: 4 },
      },
    ),
    widgetItem(
      "model",
      "list",
      {},
      {
        result: failed("model_unavailable"),
        layout: { x: 4, y: 0, w: 4, h: 4 },
      },
    ),
    widgetItem(
      "source",
      "list",
      { sources: mail },
      {
        result: failed("hub_source_unavailable"),
        layout: { x: 8, y: 0, w: 4, h: 4 },
      },
    ),
  ]);
const hrefs = (node: ReactTestInstance) =>
  node.findAllByType("a").map((link) => link.props.href as string);

test("a failed widget says why in one line and offers the fix; administration links only for admins", async () => {
  const { session } = fakeSession(problems());
  let root = await render(<HubDashboardView session={session} />);
  let [connect, model, source] = byTestId(root, "widget-error");
  expect(text(connect!)).toContain(copy.fix.connect);
  expect(text(connect!)).toContain(copy.fix.connectAction);
  expect(hrefs(connect!)).toEqual(["/connections/svc-mail"]);
  expect(text(model!)).toBe(`${copy.fix.noModel} ${copy.fix.askAdmin}`);
  expect(hrefs(model!)).toEqual([]);
  expect(text(source!)).toBe(`${copy.fix.unreadable} ${copy.fix.askAdmin}`);
  expect(hrefs(source!)).toEqual([]);
  mounted.splice(0).forEach((unmount) => unmount());

  mockAdmin = true;
  root = await render(
    <HubDashboardView session={fakeSession(problems()).session} />,
  );
  [connect, model, source] = byTestId(root, "widget-error");
  expect(hrefs(connect!)).toEqual(["/connections/svc-mail"]);
  expect(text(model!)).toContain(copy.fix.noModel);
  expect(text(model!)).not.toContain(copy.fix.askAdmin);
  expect(hrefs(model!)).toEqual(["/admin/routing"]);
  expect(text(source!)).toContain(copy.fix.serviceAction);
  expect(hrefs(source!)).toEqual(["/admin/services/svc-mail"]);
});

test("a change the overview refuses explains the source; a conflict is retried once on its own", async () => {
  mockAdmin = true;
  const { session, commands } = fakeSession(
    dashboard([
      widgetItem("list", "list", {}, { layout: { x: 0, y: 0, w: 4, h: 4 } }),
    ]),
  );
  const send = session.sendHubCommand as jest.Mock;
  const original = send.getMockImplementation()!;
  const root = await render(<HubDashboardView session={session} />);
  const refresh = () =>
    act(async () =>
      byTestId(root, "hub-widget")[0]!
        .findAll(
          (node) =>
            node.type === "button" && node.props["aria-label"] === copy.refresh,
        )[0]!
        .props.onClick(),
    );
  // Someone changed the overview at the same moment: once more, silently.
  send.mockImplementationOnce(async () => {
    throw new Error("hub_conflict");
  });
  await refresh();
  await settle();
  expect(send).toHaveBeenCalledTimes(1 + 1);
  expect(commands.at(-1)).toMatchObject({ type: "refresh", itemIds: ["list"] });
  expect(byTestId(root, "hub-error")).toHaveLength(0);
  // Refused twice: then it says so.
  send.mockImplementation(async () => {
    throw new Error("hub_conflict");
  });
  await refresh();
  await settle();
  expect(byTestId(root, "hub-error")).toHaveLength(1);
  expect(text(byTestId(root, "hub-error")[0]!)).toContain(copy.changeFailed);
  send.mockImplementation(original);

  // Adding a widget with a source the overview can't read.
  send.mockImplementationOnce(async () => {
    throw new Error("hub_source_unavailable");
  });
  await act(async () => button(root, copy.edit).props.onClick());
  await settle();
  await act(async () => button(root, copy.add).props.onClick());
  await settle();
  const inbox = byTestId(
    byTestId(openSheet(root), "hub-gallery")[0]!,
    "gallery-type",
  ).find((card) => card.props["data-type"] === "inbox")!;
  await act(async () => inbox.findAllByType("button")[0]!.props.onClick());
  await settle();
  const form = byTestId(openSheet(root), "hub-widget-form")[0]!;
  const sources = form.find(
    (node) =>
      node.props["data-host"] === "ToggleGroup" &&
      node.props["aria-label"] === copy.sourcesLabel,
  );
  await act(async () => sources.props.onValueChange(["svc-crm"]));
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  await settle();
  const error = byTestId(root, "hub-error")[0]!;
  expect(text(error)).toContain(copy.fix.unreadable);
  expect(hrefs(error)).toEqual(["/admin/services/svc-crm"]);
});

test("without a readable service the widget form says so and points admins to the services", async () => {
  mockAdmin = true;
  const { session } = fakeSession(dashboard([]));
  (session.readMentions as jest.Mock).mockImplementation(async () => ({
    profile: "agent-mentions/1",
    items: [],
  }));
  const root = await render(<HubDashboardView session={session} />);
  await act(async () => button(root, copy.editOverview).props.onClick());
  await settle();
  await act(async () => button(root, copy.add).props.onClick());
  await settle();
  const inbox = byTestId(
    byTestId(openSheet(root), "hub-gallery")[0]!,
    "gallery-type",
  ).find((card) => card.props["data-type"] === "inbox")!;
  await act(async () => inbox.findAllByType("button")[0]!.props.onClick());
  await settle();
  const none = byTestId(openSheet(root), "hub-sources-none")[0]!;
  expect(text(none)).toContain(copy.sourcesNone);
  expect(hrefs(none)).toEqual(["/admin/services"]);
});
