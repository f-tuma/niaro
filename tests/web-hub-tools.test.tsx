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
import { hubWidgetDefinition } from "../packages/protocol/widgets";
import { widgetRenderer } from "../apps/server-admin/web/app/widgets";
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
    openHubItem: jest.fn(
      async (_language: string, _itemId: string, ref: string) => ({
        subject: "Cenová nabídka",
        from: "Jana Nováková <jana@example.test>",
        to: ["jan@example.test"],
        at: "2026-10-17T06:30:00.000Z",
        text: `Dobrý den,\n\ntext zprávy ${ref}.`,
        link: `https://mail.example/${ref}`,
        cached: false,
      }),
    ),
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

const hostOf = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
/** The Popover of a row: its host carries open/onOpenChange. */
const popoverOf = (row: ReactTestInstance) => hostOf(row, "Popover")[0]!;
const inbox = () =>
  widgetItem("mail", "inbox", {
    config: { count: 6, importantOnly: false },
    data: {
      emails: [
        {
          id: "msg-1",
          from: "Jana Nováková",
          subject: "Cenová nabídka",
          receivedAt: at(0, 8),
          summary: "Čeká na potvrzení ceny.",
          importance: "high",
          suggestedAction: "Potvrdit cenu",
          unreadFlag: true,
          threadCount: 3,
          link: "https://mail.example/1",
        },
        {
          id: "msg-2",
          from: "Petr Svoboda",
          subject: "Schůzka",
          receivedAt: at(0, 7),
          summary: "Navrhuje úterý.",
          importance: "normal",
          unreadFlag: false,
        },
        {
          from: "Newsletter",
          subject: "Novinky",
          receivedAt: at(-1, 7),
          summary: "Týdenní novinky.",
          importance: "low",
          unreadFlag: true,
        },
      ],
      unread: 2,
    },
  });

test("expanding a widget opens it large in a dialog with the same actions and the expanded body", async () => {
  const { session, commands } = fakeSession(dashboard([inbox()]));
  const root = await render(<HubDashboardView session={session} />);
  expect(byTestId(root, "widget-dialog")).toHaveLength(0);
  // The compact card shows no detail until a row is opened.
  expect(byTestId(grid(root), "inbox-detail")).toHaveLength(0);
  await act(async () => byTestId(root, "widget-expand")[0]!.props.onClick());
  const dialog = byTestId(root, "widget-dialog")[0]!;
  expect(dialog.props["data-type"]).toBe("inbox");
  expect(text(hostOf(dialog, "DialogTitle")[0]!)).toBe("Pošta");
  // Large: a mail reader with the first email open and read from the server.
  expect(byTestId(dialog, "inbox-email")).toHaveLength(3);
  await settle();
  const reader = () => byTestId(dialog, "inbox-reader")[0]!;
  expect(session.openHubItem).toHaveBeenCalledWith(
    "cs",
    "mail",
    "msg-1",
    expect.any(AbortSignal),
  );
  expect(text(byTestId(reader(), "inbox-body")[0]!)).toBe(
    "Dobrý den,\n\ntext zprávy msg-1.",
  );
  expect(text(reader())).toContain("Jana Nováková <jana@example.test>");
  expect(text(reader())).toContain("Komu: jan@example.test");
  // The list pane keeps the count and the chips on one row, without summaries.
  const header = byTestId(dialog, "widget-toolbar")[0]!;
  expect(text(header)).toContain("2 nepřečtených");
  expect(byTestId(header, "inbox-filter")[0]!.props.spacing).toBe(0);
  expect(text(byTestId(dialog, "inbox-email")[0]!)).not.toContain(
    "Čeká na potvrzení ceny.",
  );
  // "Ask" lives in the menu; the dialog header keeps refresh only.
  expect(byTestId(dialog, "widget-ask")).toHaveLength(0);
  await act(async () => button(dialog, copy.refresh).props.onClick());
  expect(commands.at(-1)).toEqual({
    profile: HUB_PROFILE_V3,
    type: "refresh",
    itemIds: ["mail"],
  });
  // Another row is read; one without an id shows only its summary.
  await act(async () =>
    byTestId(dialog, "inbox-email")[1]!
      .findAllByType("button")[0]!
      .props.onClick(),
  );
  await settle();
  expect(text(byTestId(reader(), "inbox-body")[0]!)).toContain(
    "text zprávy msg-2.",
  );
  await act(async () =>
    byTestId(dialog, "inbox-email")[2]!
      .findAllByType("button")[0]!
      .props.onClick(),
  );
  await settle();
  expect(byTestId(reader(), "inbox-body")).toHaveLength(0);
  expect(text(reader())).toContain("Týdenní novinky.");
  expect(session.openHubItem).toHaveBeenCalledTimes(2);
  // Closing the dialog leaves the card as it was.
  await act(async () => hostOf(root, "Dialog")[0]!.props.onOpenChange(false));
  expect(byTestId(root, "widget-dialog")).toHaveLength(0);
  // The menu offers it too.
  const item = root.find(
    (node) =>
      node.props["data-host"] === "DropdownMenuItem" &&
      text(node).includes(copy.expand),
  );
  await act(async () => item.props.onSelect());
  expect(byTestId(root, "widget-dialog")).toHaveLength(1);
});

test("the inbox filters by importance and unread, and a row's detail asks what the sender wants", async () => {
  const { session } = fakeSession(dashboard([inbox()]));
  const root = await render(<HubDashboardView session={session} />);
  const rows = () => byTestId(grid(root), "inbox-email");
  expect(rows()).toHaveLength(3);
  expect(byTestId(rows()[0]!, "inbox-unread")[0]!.props["data-unread"]).toBe(
    true,
  );
  expect(byTestId(rows()[1]!, "inbox-unread")[0]!.props["data-unread"]).toBe(
    false,
  );
  expect(text(rows()[0]!)).toContain("3");
  // The card's rows carry the gist as one muted line.
  expect(text(rows()[0]!)).toContain("Čeká na potvrzení ceny.");
  // The chips sit on the count's row, small and on the right.
  const header = byTestId(grid(root), "widget-toolbar")[0]!;
  expect(text(header)).toContain("2 nepřečtených");
  const filter = byTestId(header, "inbox-filter")[0]!;
  expect(filter.props.spacing).toBe(0);
  expect(
    filter
      .findAll((node) => node.props["data-host"] === "ToggleGroupItem")
      .map((node) => node.props.value),
  ).toEqual(["all", "important", "unread"]);
  await act(async () => filter.props.onValueChange("important"));
  expect(rows().map((row) => row.props["data-importance"])).toEqual(["high"]);
  await act(async () => filter.props.onValueChange("unread"));
  expect(rows().map((row) => row.props["data-importance"])).toEqual([
    "high",
    "low",
  ]);
  await act(async () => filter.props.onValueChange("all"));
  // Opening a row shows its detail with the prepared questions and the link.
  await act(async () => popoverOf(rows()[0]!).props.onOpenChange(true));
  const detail = byTestId(rows()[0]!, "inbox-detail")[0]!;
  expect(text(detail)).toContain("Potvrdit cenu");
  // The thread size is part of the popover's meta line.
  expect(text(byTestId(rows()[0]!, "widget-detail")[0]!)).toContain(
    "3 ve vlákně",
  );
  expect(
    detail.find((node) => node.type === "a" && node.props.target === "_blank")
      .props.href,
  ).toBe("https://mail.example/1");
  const wants = byTestId(detail, "widget-ask-item").find((node) =>
    text(node).includes("Co po mně chce?"),
  )!;
  await act(async () => wants.props.onClick());
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/chat" });
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toMatch(
    /^Co po mně chce Jana Nováková v e-mailu „Cenová nabídka“ \(.*\)\? Shrň vlákno/,
  );
});

test("Read opens the widget large with that email in the reader; a body that cannot be read falls back to the link", async () => {
  const { session } = fakeSession(dashboard([inbox()]));
  (session.openHubItem as jest.Mock).mockRejectedValueOnce(
    new Error("hub_open_failed"),
  );
  const root = await render(<HubDashboardView session={session} />);
  const rows = () => byTestId(grid(root), "inbox-email");
  // The second email's popover: "Read" hands the row to the dialog.
  await act(async () => popoverOf(rows()[1]!).props.onOpenChange(true));
  const read = byTestId(rows()[1]!, "inbox-read")[0]!;
  expect(text(read)).toBe("Přečíst");
  await act(async () => read.props.onClick());
  const dialog = byTestId(root, "widget-dialog")[0]!;
  expect(byTestId(grid(root), "inbox-detail")).toHaveLength(0);
  const reader = () => byTestId(dialog, "inbox-reader")[0]!;
  expect(
    byTestId(dialog, "inbox-email")[1]!.findAllByType("button")[0]!.props[
      "aria-current"
    ],
  ).toBe(true);
  expect(session.openHubItem).toHaveBeenCalledWith(
    "cs",
    "mail",
    "msg-2",
    expect.any(AbortSignal),
  );
  await settle();
  // The server could not read it: a short word and the summary stay.
  expect(reader().props["data-status"]).toBe("failed");
  expect(text(byTestId(reader(), "inbox-status")[0]!)).toContain(
    "Nejde načíst.",
  );
  expect(text(reader())).toContain("Navrhuje úterý.");
  // The first email reads fine and links to the message at its source.
  await act(async () =>
    byTestId(dialog, "inbox-email")[0]!
      .findAllByType("button")[0]!
      .props.onClick(),
  );
  await settle();
  expect(reader().props["data-status"]).toBe("ok");
  expect(byTestId(reader(), "inbox-status")).toHaveLength(0);
  expect(
    reader().find((node) => node.type === "a" && node.props.target === "_blank")
      .props.href,
  ).toBe("https://mail.example/msg-1");
  const reply = byTestId(reader(), "widget-ask-item").find((node) =>
    text(node).includes("Navrhni odpověď"),
  )!;
  await act(async () => reply.props.onClick());
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toContain(
    "Navrhni odpověď na e-mail od Jana Nováková „Cenová nabídka“",
  );
});

test("a table sorts by its columns (numbers numerically, empty cells last), filters, copies and links rows", async () => {
  const written: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async (value: string) => void written.push(value),
      },
    },
    configurable: true,
  });
  const { session } = fakeSession(
    dashboard([
      widgetItem("deals", "table", {
        config: { count: 10 },
        data: {
          columns: ["Obchod", "Hodnota"],
          rows: [
            ["ERP", 480000],
            ["Web", 220000],
            ["Audit", null],
            ["App", 1500000],
            ["CRM", 90000],
            ["Školení", 15000],
          ],
          rowLinks: ["https://crm.example/1", null, null, null, null, null],
        },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const names = () =>
    byTestId(grid(root), "table-row").map((row) =>
      text(hostOf(row, "TableCell")[0]!),
    );
  expect(names()).toEqual(["ERP", "Web", "Audit", "App", "CRM", "Školení"]);
  // Numbers sit right; the first row links out.
  const first = byTestId(grid(root), "table-row")[0]!;
  expect(hostOf(first, "TableCell")[1]!.props.className).toContain(
    "text-right",
  );
  expect(first.find((node) => node.type === "a").props.href).toBe(
    "https://crm.example/1",
  );
  const sorts = () => byTestId(grid(root), "table-sort");
  await act(async () => sorts()[1]!.props.onClick());
  expect(sorts()[1]!.props["data-direction"]).toBe("asc");
  expect(names()).toEqual(["Školení", "CRM", "Web", "ERP", "App", "Audit"]);
  await act(async () => sorts()[1]!.props.onClick());
  expect(sorts()[1]!.props["data-direction"]).toBe("desc");
  expect(names()).toEqual(["App", "ERP", "Web", "CRM", "Školení", "Audit"]);
  await act(async () => sorts()[0]!.props.onClick());
  expect(names()).toEqual(["App", "Audit", "CRM", "ERP", "Školení", "Web"]);
  // More than five rows: a filter, which the copy follows.
  const filter = byTestId(grid(root), "widget-filter")[0]!;
  await act(async () => filter.props.onChange({ target: { value: "ap" } }));
  expect(names()).toEqual(["App"]);
  expect(text(grid(root))).toContain("1 z 6");
  await act(async () => byTestId(grid(root), "table-copy")[0]!.props.onClick());
  await settle();
  expect(written).toEqual(["Obchod\tHodnota\nApp\t1500000"]);
  expect(text(byTestId(grid(root), "table-copy")[0]!)).toContain("Zkopírováno");
});

test("a chart draws several series with a legend and shows the numbers as a table on request", async () => {
  const series = [
    {
      name: "2025",
      points: [
        { label: "Q1", value: 10 },
        { label: "Q2", value: 12 },
      ],
    },
    {
      name: "2026",
      points: [
        { label: "Q1", value: 14 },
        { label: "Q3", value: 9 },
      ],
    },
  ];
  const { session } = fakeSession(
    dashboard([
      widgetItem("sales", "chart", {
        config: { kind: "bar", stacked: true },
        data: { points: [], series, valueLabel: "Kč" },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const chart = byTestId(grid(root), "hub-chart")[0]!;
  expect(chart.props["data-kind"]).toBe("bar");
  expect(JSON.parse(chart.props["data-series"])).toEqual(series);
  expect(chart.props["data-stacked"]).toBe(true);
  expect(byTestId(grid(root), "chart-table-row")).toHaveLength(0);
  const toggle = byTestId(grid(root), "chart-table-toggle")[0]!;
  await act(async () => toggle.props.onClick());
  // One row per label in first-series order, a column per series; a gap stays empty.
  const rows = byTestId(grid(root), "chart-table-row");
  expect(rows.map((row) => text(row))).toEqual(["Q11014", "Q212", "Q39"]);
  expect(byTestId(grid(root), "hub-chart")).toHaveLength(0);
  expect(text(grid(root))).toContain("2025");
  expect(text(grid(root))).toContain("2026");
  // Large: the chart and the table together.
  await act(async () => byTestId(root, "widget-expand")[0]!.props.onClick());
  const dialog = byTestId(root, "widget-dialog")[0]!;
  expect(byTestId(dialog, "hub-chart")).toHaveLength(1);
  expect(byTestId(dialog, "chart-table-row")).toHaveLength(3);
});

test("a KPI shows how far it is from its target and the date it is from; large, its points as a table", async () => {
  const { session } = fakeSession(
    dashboard([
      widgetItem("deals", "kpi", {
        config: { unit: "", goal: "up" },
        data: {
          value: 42,
          label: "Otevřené obchody",
          points: [30, 37, 42],
          target: 50,
          asOf: "2026-10-16",
        },
      }),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const target = byTestId(grid(root), "kpi-target")[0]!;
  expect(target.props["data-percent"]).toBe(84);
  expect(hostOf(target, "Progress")[0]!.props.value).toBe(84);
  expect(text(target)).toContain("84 % z 50");
  expect(text(grid(root))).toContain("k 16. 10.");
  expect(byTestId(grid(root), "kpi-point")).toHaveLength(0);
  await act(async () => byTestId(root, "widget-expand")[0]!.props.onClick());
  const dialog = byTestId(root, "widget-dialog")[0]!;
  expect(byTestId(dialog, "kpi-point").map((row) => text(row))).toEqual([
    "130",
    "237",
    "342",
  ]);
});

test("follow-ups sort the urgent first on request; lists filter when large; a briefing elaborates a highlight", async () => {
  const { session } = fakeSession(
    dashboard([
      widgetItem("fu", "followups", {
        data: {
          items: [
            { who: "Petr", reason: "Slíbil podklady" },
            {
              who: "Jana (Acme)",
              reason: "Nabídka bez odpovědi",
              priority: "high",
            },
          ],
        },
      }),
      widgetItem(
        "list",
        "list",
        {
          data: {
            items: [
              { title: "Acme s.r.o.", detail: "Školení" },
              { title: "Beta a.s.", detail: "Webinář" },
            ],
          },
        },
        { layout: { x: 4, y: 0, w: 4, h: 4 } },
      ),
      widgetItem(
        "brief",
        "briefing",
        {
          data: {
            summary: "Dnes dvě schůzky.",
            highlights: [{ text: "Potvrdit cenu Janě", source: "E-mail" }],
          },
        },
        { layout: { x: 0, y: 4, w: 6, h: 3 } },
      ),
    ]),
  );
  const root = await render(<HubDashboardView session={session} />);
  const who = () =>
    byTestId(grid(root), "followup-item").map(
      (row) => row.props["data-priority"],
    );
  expect(who()).toEqual(["normal", "high"]);
  await act(async () =>
    byTestId(grid(root), "followups-sort")[0]!.props.onClick(),
  );
  expect(who()).toEqual(["high", "normal"]);
  // A row opens its detail with the follow-up action.
  const row = byTestId(grid(root), "followup-item")[0]!;
  await act(async () => popoverOf(row).props.onOpenChange(true));
  const detail = byTestId(row, "widget-detail")[0]!;
  expect(text(detail)).toContain("Nabídka bez odpovědi");
  await act(async () =>
    byTestId(detail, "widget-ask-item")[0]!.props.onClick(),
  );
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toBe(
    "Napiš follow-up pro Jana (Acme). Důvod: Nabídka bez odpovědi",
  );
  // The list filters only when large.
  const listCard = byTestId(grid(root), "hub-widget").find(
    (card) => card.props["data-type"] === "list",
  )!;
  expect(byTestId(listCard, "widget-filter")).toHaveLength(0);
  await act(async () =>
    byTestId(listCard, "widget-expand")[0]!.props.onClick(),
  );
  const dialog = byTestId(root, "widget-dialog")[0]!;
  await act(async () =>
    byTestId(dialog, "widget-filter")[0]!.props.onChange({
      target: { value: "beta" },
    }),
  );
  expect(byTestId(dialog, "list-item").map((item) => text(item))).toEqual([
    "Beta a.s.Webinář",
  ]);
  // A highlight hands "tell me more" to the chat.
  const highlight = byTestId(grid(root), "briefing-highlight")[0]!;
  await act(async () =>
    byTestId(highlight, "widget-ask-item")[0]!.props.onClick(),
  );
  expect(readDraft(draftKey("identity-1", UNSAVED_DRAFT))?.text).toBe(
    "Rozveď to: „Potvrdit cenu Janě“ (E-mail).",
  );
});

test("the reader renders a message's tree itself: links, rules, lists and images only on request", async () => {
  const { session } = fakeSession(dashboard([inbox()]));
  (session.openHubItem as jest.Mock).mockResolvedValueOnce({
    subject: "Cenová nabídka",
    from: "Jana Nováková <jana@example.test>",
    text: "Dobrý den, ceník. Jana",
    doc: [
      { t: "el", tag: "p", children: [{ t: "text", v: "Dobrý den," }] },
      {
        t: "el",
        tag: "p",
        children: [
          {
            t: "el",
            tag: "a",
            href: "https://x.test/cenik",
            children: [{ t: "text", v: "ceník" }],
          },
          { t: "el", tag: "img", src: "https://x.test/logo.png", alt: "Logo" },
        ],
      },
      { t: "el", tag: "hr" },
      {
        t: "el",
        tag: "ul",
        children: [
          { t: "el", tag: "li", children: [{ t: "text", v: "jedna" }] },
          { t: "el", tag: "li", children: [{ t: "text", v: "dvě" }] },
        ],
      },
    ],
    cached: true,
  });
  const root = await render(<HubDashboardView session={session} />);
  await act(async () => byTestId(root, "widget-expand")[0]!.props.onClick());
  await settle();
  const dialog = byTestId(root, "widget-dialog")[0]!;
  const body = byTestId(dialog, "inbox-body")[0]!;
  // Nothing was ever inserted as HTML: the tree is React elements.
  expect(byTestId(body, "email-doc")).toHaveLength(1);
  const link = body.find((node) => node.type === "a");
  expect(link.props.href).toBe("https://x.test/cenik");
  expect(link.props.rel).toBe("noreferrer");
  expect(link.props.target).toBe("_blank");
  expect(text(link)).toBe("ceník");
  expect(body.findAllByType("hr")).toHaveLength(1);
  expect(body.findAllByType("li").map(text)).toEqual(["jedna", "dvě"]);
  // The image waits: a placeholder with its alt, and one button for all.
  expect(body.findAllByType("img")).toHaveLength(0);
  const placeholder = byTestId(body, "email-doc-image")[0]!;
  expect(placeholder.props["data-loaded"]).toBe(false);
  expect(text(placeholder)).toBe("Logo");
  const show = byTestId(body, "email-doc-images")[0]!;
  expect(text(show)).toBe("Zobrazit obrázky");
  await act(async () => show.props.onClick());
  const image = byTestId(dialog, "inbox-body")[0]!.findAllByType("img")[0]!;
  expect(image.props.src).toBe("https://x.test/logo.png");
  expect(image.props.referrerPolicy).toBe("no-referrer");
  expect(image.props.loading).toBe("lazy");
  expect(byTestId(dialog, "email-doc-images")).toHaveLength(0);
  // An indexed body came at once: no loading word was shown.
  expect(byTestId(dialog, "inbox-status")).toHaveLength(0);
});

/** A widget's body as the gallery's preview renders it. */
async function preview(type: string, data: unknown) {
  const Body = widgetRenderer(type)!.Body;
  return render(
    <Body
      preview
      item={null}
      language="cs"
      ask={() => {}}
      data={data}
      config={
        hubWidgetDefinition(type)!.defaultConfig as Record<string, unknown>
      }
    />,
  );
}

test("the gallery's preview shows whole rows only: a few rows, the inbox without badges, the table narrow and without links", async () => {
  const inboxPreview = await preview("inbox", inbox().widget!.data);
  expect(byTestId(inboxPreview, "inbox-email")).toHaveLength(2);
  expect(byTestId(inboxPreview, "widget-toolbar")).toHaveLength(0);
  expect(hostOf(inboxPreview, "StatusBadge")).toHaveLength(0);
  expect(text(inboxPreview)).toContain("Jana Nováková");
  expect(text(inboxPreview)).toContain("Cenová nabídka");
  expect(text(inboxPreview)).not.toContain("Čeká na potvrzení ceny.");

  const items = Array.from({ length: 5 }, (_, index) => ({
    title: `Řádek ${index + 1}`,
    detail: "Detail",
  }));
  const listPreview = await preview("list", { items });
  expect(byTestId(listPreview, "list-item")).toHaveLength(2);

  const briefingPreview = await preview("briefing", {
    summary: "Krátce.",
    highlights: items.map((item) => ({ text: item.title })),
  });
  expect(byTestId(briefingPreview, "briefing-highlight")).toHaveLength(2);

  const meetingsPreview = await preview("meetings", {
    meetings: [1, 2, 3].map((index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      title: `Porada ${index}`,
      recordedAt: "2026-10-17T09:30:00",
      status: "ready",
      summary: "",
      tasks: 0,
    })),
  });
  const meetings = byTestId(meetingsPreview, "meeting-item");
  expect(meetings).toHaveLength(1);
  // The date without the time: the narrow row keeps room for the title.
  expect(text(meetings[0]!)).not.toContain(":");

  const tablePreview = await preview("table", {
    columns: ["A", "B", "C", "D", "E"],
    rows: Array.from({ length: 4 }, (_, row) =>
      ["a", "b", "c", "d", "e"].map((cell) => `${cell}${row}`),
    ),
    rowLinks: Array.from(
      { length: 4 },
      (_, row) => `https://crm.example/${row}`,
    ),
  });
  expect(byTestId(tablePreview, "table-row")).toHaveLength(2);
  expect(hostOf(tablePreview, "TableHead").map(text)).toEqual(["A", "B", "C"]);
  expect(hostOf(tablePreview, "Table")[0]!.props.scroll).toBe(false);
  expect(tablePreview.findAll((node) => node.type === "a")).toHaveLength(0);
  expect(byTestId(tablePreview, "table-copy")).toHaveLength(0);
});
