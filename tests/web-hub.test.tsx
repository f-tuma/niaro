import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  commandTarget,
  type ClientSession,
  type SessionCommand,
  type SessionState,
} from "../packages/client-core/session";
import type { Store } from "../packages/client-core/store";
import {
  HUB_PROFILE_V3,
  type HubCard,
  type HubDashboardV3,
  type HubDashboardV3Command,
} from "../packages/protocol/hub";
import { hubOverlaps } from "../packages/protocol/hub-dashboard";
import { ChatNextConversation } from "../apps/server-admin/web/app/chat-next/chat-next-page";
import {
  HubDashboardView,
  hubGreeting,
} from "../apps/server-admin/web/app/hub-page";
import {
  hubCopy,
  hubErrorText,
  hubWidgetProblem,
} from "../apps/server-admin/web/app/hub-copy";
import {
  UNSAVED_DRAFT,
  draftKey,
  readDraft,
  saveDraft,
} from "../apps/server-admin/web/app/chat-store";
import { translate } from "../packages/i18n";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
// assistant-ui's thread root listens on the document for Escape and the
// generated UI's renderer adds a style; the test renderer has no DOM, so
// they get a page that hears nothing and keeps nothing.
if (typeof document === "undefined")
  Object.defineProperty(globalThis, "document", {
    value: {
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({}),
      head: { appendChild() {} },
    },
    configurable: true,
  });

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
// Generated charts draw with recharts, which Jest cannot parse.
jest.mock("../apps/server-admin/web/app/generative-ui/charts", () => ({}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
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
jest.mock("@admin/components/ui/popover", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dialog", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
// Charts are recharts in the browser; here the widget's points are enough.
jest.mock("../apps/server-admin/web/app/hub-chart", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    __esModule: true,
    default: ({ kind, points }: { kind: string; points: unknown[] }) =>
      React.createElement("div", {
        "data-testid": "hub-chart",
        "data-kind": kind,
        "data-points": JSON.stringify(points),
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
const store: Store = {
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
const tasksItem: HubCard = {
  id: "item-tasks",
  kind: "tasks",
  title: "Úkoly",
  refresh: "on_open",
  position: 0,
  createdAt: "2026-10-16T07:00:00.000Z",
  result: null,
  stale: false,
  layout: { x: 0, y: 0, w: 4, h: 4 },
  view: { type: "tasks" },
  data: null,
  fields: [],
  widget: null,
};
const succeeded = {
  status: "succeeded" as const,
  startedAt: "2026-10-16T06:00:00.000Z",
  producedAt: "2026-10-16T06:00:05.000Z",
};
const processItem = (id: string, patch: Partial<HubCard> = {}): HubCard => ({
  id,
  kind: "process",
  processId: `process-${id}`,
  title: `Proces ${id}`,
  refresh: "daily",
  position: 1,
  createdAt: "2026-10-16T07:00:00.000Z",
  result: null,
  stale: false,
  layout: { x: 4, y: 0, w: 6, h: 4 },
  view: { type: "summary" },
  data: null,
  fields: null,
  widget: null,
  ...patch,
});
const stageFields: HubCard["fields"] = [
  {
    key: "stages",
    label: "Stages",
    type: "array",
    fields: [
      { key: "label", label: "Label", type: "string" },
      { key: "value", label: "Value", type: "number" },
    ],
  },
  { key: "count", label: "Count", type: "number" },
];
const dashboard = (items: HubCard[], open = 0): HubDashboardV3 => ({
  profile: HUB_PROFILE_V3,
  scope,
  revision: 1,
  items,
  tasks: {
    open,
    top: open ? [{ id: "task-1", title: "Zavolat klientovi" }] : [],
  },
});

function fakeSession(initial: HubDashboardV3) {
  let state: SessionState = {
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
  const sent: SessionCommand[] = [];
  const listeners = new Set<() => void>();
  const patch = (id: string, change: Partial<HubCard>) => {
    current = {
      ...current,
      items: current.items.map((item) =>
        item.id === id ? { ...item, ...change } : item,
      ),
    };
  };
  const session = {
    identityKey: "identity-1",
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    start: jest.fn(async () => {}),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    readConversation: jest.fn(),
    readHub: jest.fn(async () => current),
    sendHubCommand: jest.fn(
      async (_language: string, command: HubDashboardV3Command) => {
        commands.push(command);
        if (command.type === "remove")
          current = {
            ...current,
            items: current.items.filter((item) => item.id !== command.itemId),
          };
        if (command.type === "layout")
          for (const entry of command.items)
            patch(entry.itemId, { layout: entry.layout });
        if (command.type === "rename")
          patch(command.itemId, { title: command.title });
        if (command.type === "setView")
          patch(command.itemId, { view: command.view, data: null });
        return current;
      },
    ),
    loadProcessInventory: jest.fn(async () => ({ processes: [] })),
    send: jest.fn(async (command: SessionCommand) => {
      sent.push(command);
      state = {
        ...state,
        commandStates: {
          ...state.commandStates,
          [commandTarget(command)]: "accepted",
        },
      };
      listeners.forEach((listener) => listener());
    }),
  };
  return {
    session: session as unknown as ClientSession,
    fake: session,
    commands,
    sent,
    current: () => current,
  };
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
const cell = (root: ReactTestInstance, id: string) =>
  root.find(
    (node) =>
      typeof node.type === "string" &&
      node.props["data-testid"] === "hub-cell" &&
      node.props["data-id"] === id,
  );
/** React Query publishes on a zero timeout, after the request's microtasks. */
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
const copy = hubCopy.cs;

test("each view shows its data: number, chart, list, table, text, summary and tasks", async () => {
  const { session, commands } = fakeSession(
    dashboard(
      [
        tasksItem,
        processItem("count", {
          stale: true,
          result: succeeded,
          layout: { x: 4, y: 0, w: 3, h: 2 },
          view: {
            type: "number",
            field: "count",
            unit: "firem",
            compare: "previous",
          },
          data: { type: "number", value: 1381, compare: { value: 1300 } },
          fields: stageFields,
        }),
        processItem("stages", {
          result: succeeded,
          layout: { x: 0, y: 4, w: 6, h: 4 },
          view: {
            type: "chart",
            chart: "pie",
            field: "stages",
            x: "label",
            y: "value",
          },
          data: {
            type: "chart",
            points: [
              { label: "Lead", value: 4 },
              { label: "Won", value: 2 },
            ],
            more: 0,
          },
          fields: stageFields,
        }),
        processItem("list", {
          result: succeeded,
          layout: { x: 6, y: 4, w: 6, h: 4 },
          view: { type: "list", field: "stages", title: "label" },
          data: {
            type: "list",
            rows: [{ title: "Porada", subtitle: "9:00" }],
            more: 3,
          },
          fields: stageFields,
        }),
        processItem("table", {
          result: succeeded,
          layout: { x: 0, y: 8, w: 6, h: 4 },
          view: { type: "table", field: "stages", columns: [{ key: "label" }] },
          data: {
            type: "table",
            columns: [
              { key: "label", label: "Fáze" },
              { key: "value", label: "Počet" },
            ],
            rows: [["Nabídka", 12]],
            more: 0,
          },
          fields: stageFields,
        }),
        processItem("text", {
          result: succeeded,
          layout: { x: 6, y: 8, w: 6, h: 3 },
          view: { type: "text", field: "summary" },
          data: { type: "text", text: "Dnes **tři** schůzky" },
          fields: [{ key: "summary", label: "Summary", type: "string" }],
        }),
        processItem("summary", {
          result: {
            ...succeeded,
            output: {
              fields: [{ label: "Schůzky", items: ["Porada"], more: 2 }],
              truncated: false,
              redacted: false,
            },
          },
          layout: { x: 0, y: 12, w: 6, h: 4 },
        }),
      ],
      3,
    ),
  );
  const root = await render(<HubDashboardView session={session} />);
  const page = text(root);
  expect(page).toContain("3 otevřené úkoly");
  expect(page).toContain("Zavolat klientovi");
  // A number with its unit and the change since the previous refresh.
  expect(text(byTestId(root, "hub-number")[0]!)).toMatch(/1\s381firem/);
  expect(page).toContain(`+81 ${copy.sincePrevious}`);
  const chart = byTestId(root, "hub-chart")[0]!;
  expect(chart.props["data-kind"]).toBe("pie");
  expect(JSON.parse(chart.props["data-points"])).toEqual([
    { label: "Lead", value: 4 },
    { label: "Won", value: 2 },
  ]);
  expect(page).toContain("Porada9:00");
  expect(page).toContain("+3 další");
  expect(page).toContain("Fáze");
  expect(page).toContain("Nabídka");
  expect(page).toContain("Dnes **tři** schůzky");
  expect(page).toContain("+2 další");
  // Cells sit where their layout says; the DOM follows the reading order.
  expect(cell(root, "count").props.style).toMatchObject({
    "--hub-col": "5 / span 3",
    "--hub-rows": "1 / span 2",
  });
  expect(
    byTestId(root, "hub-cell").map((node) => node.props["data-id"]),
  ).toEqual([
    "item-tasks",
    "count",
    "stages",
    "list",
    "table",
    "text",
    "summary",
  ]);
  // Opening the page refreshes the stale widget once, through one command.
  expect(commands).toEqual([
    { profile: HUB_PROFILE_V3, type: "refresh", stale: true },
  ]);
  await act(async () => button(root, copy.refresh).props.onClick());
  expect(commands.at(-1)).toEqual({
    profile: HUB_PROFILE_V3,
    type: "refresh",
    itemIds: ["count"],
  });
});

test("editing moves and resizes widgets by pointer and keys, and saves the whole grid", async () => {
  const { session, commands, current } = fakeSession(
    dashboard([
      tasksItem,
      processItem("day", { layout: { x: 4, y: 0, w: 6, h: 4 } }),
      processItem("crm", { layout: { x: 0, y: 4, w: 4, h: 3 } }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  expect(byTestId(root, "hub-move")).toHaveLength(0);
  await act(async () => button(root, copy.edit).props.onClick());
  await settle();
  // Arrow keys move the focused grip by one cell.
  const grip = (id: string) =>
    cell(root, id).find(
      (node) =>
        node.type === "button" && node.props["data-testid"] === "hub-move",
    );
  await act(async () =>
    grip("day").props.onKeyDown({ key: "ArrowRight", preventDefault() {} }),
  );
  await settle();
  expect(commands.at(-1)).toMatchObject({
    profile: HUB_PROFILE_V3,
    type: "layout",
  });
  expect(current().items.find((item) => item.id === "day")!.layout).toEqual({
    x: 5,
    y: 0,
    w: 6,
    h: 4,
  });
  // Dragging the grip two cells left and four rows down drops it below.
  const pointer = (x: number, y: number) => ({
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    preventDefault() {},
    currentTarget: { setPointerCapture() {} },
  });
  // A touch grip never lets the page scroll, and a cancelled drag (the
  // browser took the pointer) puts the widget back without saving.
  expect(grip("day").props.className).toContain("touch-none");
  const kept = commands.length;
  await act(async () => grip("day").props.onPointerDown(pointer(100, 100)));
  await act(async () => grip("day").props.onPointerMove(pointer(-60, 500)));
  expect(cell(root, "day").props["data-layout"]).toBe("3,4,6,4");
  await act(async () => grip("day").props.onPointerCancel(pointer(-60, 500)));
  await settle();
  expect(commands).toHaveLength(kept);
  expect(cell(root, "day").props["data-layout"]).toBe("5,0,6,4");
  await act(async () => grip("day").props.onPointerDown(pointer(100, 100)));
  await act(async () => grip("day").props.onPointerMove(pointer(-60, 500)));
  // The grid shows where it lands before anything is saved.
  expect(cell(root, "day").props["data-layout"]).toBe("3,4,6,4");
  const before = commands.length;
  await act(async () => grip("day").props.onPointerUp(pointer(-60, 500)));
  await settle();
  expect(commands).toHaveLength(before + 1);
  const saved = commands.at(-1);
  if (saved?.type !== "layout") throw new Error("no layout");
  const layouts = Object.fromEntries(
    saved.items.map((item) => [item.itemId, item.layout]),
  );
  expect(layouts.day).toEqual({ x: 3, y: 4, w: 6, h: 4 });
  // Others made room, and nothing overlaps.
  for (const [index, item] of saved.items.entries())
    for (const other of saved.items.slice(index + 1))
      expect(hubOverlaps(item.layout, other.layout)).toBe(false);
  // The corner resizes; a widget never gets smaller than its view allows.
  const corner = cell(root, "crm").find(
    (node) =>
      node.props["data-testid"] === "hub-resize" && node.type === "button",
  );
  await act(async () =>
    corner.props.onKeyDown({ key: "ArrowRight", preventDefault() {} }),
  );
  await settle();
  expect(current().items.find((item) => item.id === "crm")!.layout.w).toBe(5);
  await act(async () => corner.props.onPointerDown(pointer(0, 0)));
  await act(async () => corner.props.onPointerMove(pointer(-900, -900)));
  await act(async () => corner.props.onPointerUp(pointer(-900, -900)));
  await settle();
  const crm = current().items.find((item) => item.id === "crm")!.layout;
  expect([crm.w, crm.h]).toEqual([3, 2]);
  // Phones only reorder.
  await act(async () => button(root, copy.moveDown).props.onClick());
  expect(commands.at(-1)).toMatchObject({ type: "reorder" });
  // Removing goes through the widget's menu.
  const removes = root.findAll(
    (node) =>
      node.props["data-host"] === "DropdownMenuItem" &&
      text(node).includes(copy.remove),
  );
  const beforeRemove = commands.length;
  await act(async () => removes.at(-1)!.props.onSelect());
  await settle();
  // Nothing is removed until the person confirms it.
  expect(commands).toHaveLength(beforeRemove);
  const confirm = root.find(
    (node) => node.props["data-host"] === "ConfirmAction",
  );
  expect(text(confirm)).toContain(copy.removeConfirm);
  expect(text(confirm)).toContain("Proces day");
  await act(async () => button(confirm, copy.removeAction).props.onClick());
  await settle();
  expect(commands.at(-1)).toMatchObject({ type: "remove", itemId: "day" });
  expect(text(root)).toContain(copy.done);
});

test("the view sheet offers only views the output allows and saves only what changed", async () => {
  const { session, commands } = fakeSession(
    dashboard([
      tasksItem,
      processItem("deals", {
        result: succeeded,
        fields: stageFields,
        view: { type: "summary" },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const configure = root.find(
    (node) =>
      node.props["data-host"] === "DropdownMenuItem" &&
      text(node).includes(copy.configure),
  );
  await act(async () => configure.props.onSelect());
  await settle();
  const sheet = root.find(
    (node) => node.props["data-host"] === "Sheet" && node.props.open === true,
  );
  const types = sheet.find(
    (node) =>
      node.props["data-host"] === "ToggleGroup" && node.props.type === "single",
  );
  // Text needs a text field; this output has none.
  expect(
    types
      .findAll((node) => node.props["data-host"] === "ToggleGroupItem")
      .map((node) => node.props.value),
  ).toEqual(["number", "chart", "list", "table", "summary"]);
  await act(async () => types.props.onValueChange("chart"));
  // A line instead of bars.
  const kinds = sheet.find(
    (node) =>
      node.props["data-host"] === "ToggleGroup" && node.props.value === "bar",
  );
  await act(async () => kinds.props.onValueChange("line"));
  const name = sheet.find(
    (node) =>
      node.props["data-host"] === "Input" &&
      node.props.value === "Proces deals",
  );
  await act(async () =>
    name.props.onChange({ target: { value: "Příležitosti podle fáze" } }),
  );
  const form = sheet.find((node) => node.type === "form");
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  await settle();
  expect(commands.slice(-2)).toEqual([
    {
      profile: HUB_PROFILE_V3,
      type: "rename",
      itemId: "deals",
      title: "Příležitosti podle fáze",
    },
    {
      profile: HUB_PROFILE_V3,
      type: "setView",
      itemId: "deals",
      view: {
        type: "chart",
        chart: "line",
        field: "stages",
        x: "label",
        y: "value",
      },
    },
  ]);
  expect(
    root.findAll(
      (node) => node.props["data-host"] === "Sheet" && node.props.open === true,
    ),
  ).toHaveLength(0);
});

test("a refused save keeps the sheet open with the edits and says why inside", async () => {
  const { session, fake, commands } = fakeSession(
    dashboard([
      tasksItem,
      processItem("deals", { result: succeeded, fields: stageFields }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const configure = cell(root, "deals").find(
    (node) =>
      node.props["data-host"] === "DropdownMenuItem" &&
      text(node).includes(copy.rename),
  );
  await act(async () => configure.props.onSelect());
  await settle();
  const openSheet = () =>
    root.find(
      (node) => node.props["data-host"] === "Sheet" && node.props.open === true,
    );
  const name = () =>
    openSheet().findAll((node) => node.props["data-host"] === "Input")[0]!;
  await act(async () =>
    name().props.onChange({ target: { value: "Obchody" } }),
  );
  fake.sendHubCommand.mockImplementationOnce(async () => {
    throw new Error("hub_full");
  });
  await act(async () =>
    openSheet()
      .find((node) => node.type === "form")
      .props.onSubmit({ preventDefault() {} }),
  );
  await settle();
  expect(commands).toEqual([]);
  // Still open, with what the person typed and the reason in it, not above the grid.
  expect(name().props.value).toBe("Obchody");
  expect(text(openSheet())).toContain(copy.errors.hub_full);
  expect(byTestId(root, "hub-error")).toHaveLength(1);
  // Saving again works and closes it.
  await act(async () =>
    openSheet()
      .find((node) => node.type === "form")
      .props.onSubmit({ preventDefault() {} }),
  );
  await settle();
  expect(commands.at(-1)).toMatchObject({ type: "rename", title: "Obchody" });
  expect(
    root.findAll(
      (node) => node.props["data-host"] === "Sheet" && node.props.open === true,
    ),
  ).toHaveLength(0);
  expect(byTestId(root, "hub-error")).toHaveLength(0);
});

test("a widget whose process now returns other data asks to set its view again", async () => {
  const { session } = fakeSession(
    dashboard([
      processItem("old", {
        result: succeeded,
        view: { type: "number", field: "gone" },
        fields: stageFields,
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  expect(text(root)).toContain(copy.mismatch);
});

test("a widget the assistant added waits until the person refreshes it", async () => {
  const { session, commands } = fakeSession(
    dashboard([tasksItem, processItem("agent", { refresh: "manual" })]),
  );
  const root = await render(<HubDashboardView session={session} />);
  expect(text(root)).toContain(copy.confirm);
  expect(commands).toEqual([]);
  await act(async () => button(root, copy.refresh).props.onClick());
  expect(commands).toEqual([
    { profile: HUB_PROFILE_V3, type: "refresh", itemIds: ["agent"] },
  ]);
  expect(hubErrorText(copy, "hub_process_writes")).toBe(
    copy.errors.hub_process_writes,
  );
});

test("asking from the dashboard keeps what the person already wrote in the new chat", async () => {
  const { session } = fakeSession(dashboard([tasksItem]));
  const key = draftKey("identity-1", UNSAVED_DRAFT);
  saveDraft(key, { text: "Rozepsaná zpráva\n", revision: 3 });
  const root = await render(<HubDashboardView session={session} />);
  const ask = root.find(
    (node) =>
      node.props["data-host"] === "InputGroupInput" &&
      node.props["aria-label"] === copy.ask,
  );
  await act(async () => ask.props.onChange({ target: { value: "A dnes?" } }));
  await act(async () =>
    root
      .find((node) => node.type === "form")
      .props.onSubmit({ preventDefault() {} }),
  );
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/chat" });
  expect(readDraft(key)).toEqual({
    text: "Rozepsaná zpráva\n\nA dnes?",
    revision: 3,
  });
  saveDraft(key, { text: "", revision: 0 });
});

test("asking from the dashboard opens a new chat with the question ready", async () => {
  const { session, sent } = fakeSession(dashboard([tasksItem]));
  const root = await render(<HubDashboardView session={session} />);
  // No strip of hints and suggestions under the grid any more.
  expect(text(root)).not.toContain("Dej si sem");
  expect(text(root)).not.toContain("Přidej shrnutí dne");
  const ask = root.find(
    (node) =>
      node.props["data-host"] === "InputGroupInput" &&
      node.props["aria-label"] === copy.ask,
  );
  await act(async () =>
    ask.props.onChange({ target: { value: "Kolik mám firem v CRM?" } }),
  );
  const form = root.find((node) => node.type === "form");
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/chat" });
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toBe(
    "Kolik mám firem v CRM?",
  );
  // The new chat starts with it in the composer; sending starts the chat.
  const chat = await render(
    <ChatNextConversation session={session} onSaved={jest.fn()} />,
  );
  expect(chat.findByType("textarea").props.value).toBe(
    "Kolik mám firem v CRM?",
  );
  await act(async () =>
    chat.findByType("textarea").props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  await settle();
  expect(sent.map((command) => command.type)).toEqual([
    "conversation.create",
    "message.send",
  ]);
});

test("greeting and failure reasons are short and specific", () => {
  expect(hubGreeting(copy, 8)).toBe("Dobré ráno");
  expect(hubGreeting(copy, 14)).toBe("Dobré odpoledne");
  expect(hubGreeting(copy, 20)).toBe("Dobrý večer");
  expect(hubErrorText(copy, "catalog_budget_exhausted")).toBe(
    copy.errors.budget,
  );
  expect(hubErrorText(copy, "process_qualification_stale")).toBe(
    copy.errors.access,
  );
  expect(hubErrorText(copy, "catalog_busy")).toBe(copy.errors.busy);
  expect(hubErrorText(copy, "hub_view_invalid")).toBe(
    copy.errors.hub_view_invalid,
  );
  expect(hubErrorText(copy, "something_new")).toBe(copy.errors.other);
});

test("a failed refresh says so once, with the short reason and the run's chat", async () => {
  const { session, commands } = fakeSession(
    dashboard([
      tasksItem,
      processItem("count", {
        result: {
          status: "failed",
          startedAt: "2026-10-16T07:00:00.000Z",
          producedAt: null,
          conversationId: "chat-hub-count",
          error: "process_step_limit",
        },
      }),
      processItem("other", {
        layout: { x: 0, y: 4, w: 6, h: 4 },
        result: {
          status: "failed",
          startedAt: "2026-10-16T07:00:00.000Z",
          producedAt: null,
          error: "something_new",
        },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const page = text(root);
  expect(page).toContain("Proces narazil na limit kroků.");
  // The badge alone for an unknown reason; never the same line twice.
  expect(page.split(copy.failed).length - 1).toBe(2);
  expect(page).not.toContain(copy.errors.other);
  const chat = root.find(
    (node) => node.type === "a" && node.props.href === "/chat/chat-hub-count",
  );
  expect(text(chat)).toContain(copy.openChat);
  // An unknown reason offers another try.
  expect(() => button(cell(root, "count"), copy.retry)).toThrow();
  await act(async () =>
    button(cell(root, "other"), copy.retry).props.onClick(),
  );
  expect(commands.at(-1)).toEqual({
    profile: HUB_PROFILE_V3,
    type: "refresh",
    itemIds: ["other"],
  });
});

test("a process widget says why its process can't run as the Processes page does, with the fix", async () => {
  const tr = translate("cs");
  const failed = (error: string) => ({
    result: {
      status: "failed" as const,
      startedAt: "2026-10-16T07:00:00.000Z",
      producedAt: null,
      error,
    },
  });
  const { session } = fakeSession(
    dashboard([
      processItem("changed", failed("source_changed")),
      processItem("sources", {
        ...failed("process_sources_changed"),
        layout: { x: 0, y: 4, w: 6, h: 4 },
      }),
      processItem("connect", {
        ...failed("connection_required"),
        layout: { x: 0, y: 8, w: 6, h: 4 },
      }),
      processItem("inactive", {
        ...failed("process_not_active"),
        layout: { x: 0, y: 12, w: 6, h: 4 },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const links = (id: string) =>
    cell(root, id)
      .findAll((node) => node.type === "a")
      .map((node) => node.props.href);
  for (const id of ["changed", "sources"]) {
    expect(text(cell(root, id))).toContain(tr("process_source_changed"));
    expect(text(cell(root, id))).toContain(copy.openProcesses);
    expect(links(id)).toContain("/processes");
  }
  expect(tr("process_source_changed")).toBe(
    "Jeho služby se změnily. Admin ho musí znovu otestovat.",
  );
  expect(text(cell(root, "connect"))).toContain(
    tr("process_connection_required"),
  );
  expect(links("connect")).toContain("/connections");
  expect(text(cell(root, "inactive"))).toContain(tr("process_not_active"));
  expect(text(root)).not.toContain("Ozvi se správci");
});

test("an admin's process widget that needs a new test leads to that test in the administration", () => {
  const problem = (isAdmin: boolean) =>
    hubWidgetProblem(copy, "source_changed", {
      sources: [],
      isAdmin,
      process: { language: "cs", processId: "proc-1" },
    });
  expect(problem(true).fix).toEqual({
    kind: "admin",
    href: "/admin/processes/proc-1",
    label: "processAction",
  });
  expect(copy.fix.processAction).toBe("Otestovat znovu");
  expect(problem(false).fix).toEqual({ kind: "processes" });
});

test("a failed refresh dims the earlier data and says when it is from", async () => {
  const { session } = fakeSession(
    dashboard([
      processItem("count", {
        view: { type: "number", field: "count" },
        fields: stageFields,
        data: { type: "number", value: 7 },
        result: {
          status: "failed",
          startedAt: "2026-10-16T07:00:00.000Z",
          producedAt: "2026-10-16T06:00:05.000Z",
          error: "process_step_limit",
        },
      }),
      processItem("fresh", {
        view: { type: "number", field: "count" },
        fields: stageFields,
        data: { type: "number", value: 3 },
        result: succeeded,
        layout: { x: 0, y: 4, w: 6, h: 4 },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const stale = byTestId(cell(root, "count"), "widget-stale");
  expect(stale).toHaveLength(1);
  expect(text(stale[0]!)).toContain(copy.staleData);
  expect(
    cell(root, "count").findAll(
      (node) => node.type === "div" && node.props["data-stale"] === true,
    ),
  ).toHaveLength(1);
  expect(byTestId(cell(root, "fresh"), "widget-stale")).toHaveLength(0);
  expect(
    cell(root, "fresh").findAll(
      (node) => node.type === "div" && node.props["data-stale"] === true,
    ),
  ).toHaveLength(0);
});
