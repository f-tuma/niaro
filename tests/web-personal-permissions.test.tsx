import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PersonalServicePermissions,
  PersonalSignIn,
} from "../packages/protocol/service-oauth";
import type { Service } from "../packages/protocol/service-catalog";
import type { ServiceResult } from "../packages/protocol/service-result";
import { ConnectionDetailPage } from "../apps/server-admin/web/app/connection-detail";
import { ServiceActionView } from "../apps/server-admin/web/app/chat-cards";
import { ServiceActionList } from "../apps/server-admin/web/service-action-list";
import { ServiceAccess } from "../apps/server-admin/web/service-access";
import {
  useCatalogCopy,
  type CatalogCopy,
} from "../apps/server-admin/web/catalog-copy";
import {
  actionAccess,
  type CatalogState,
} from "../apps/server-admin/web/catalog-shared";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(mockStatus: number, mockCode?: string) {
      super(String(mockStatus));
      this.status = mockStatus;
      this.code = mockCode;
    }
  },
}));
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
    useNavigate: () => jest.fn(),
    useParams: () => ({ serviceId: "svc-mail" }),
    useRouterState: () => "/connections/svc-mail",
  };
});
const mockTarget = { organizationId: "org-1", workspaceId: "ws-1" };
const mockWorkspace = {
  ...mockTarget,
  organizationName: "TEST org",
  name: "TEST",
  role: "member",
};
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs", workspace: mockWorkspace }),
  useAppSession: () => ({ identityKey: "identity-1" }),
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "cs",
    data: { authentication: { principalId: "admin-1" } },
  }),
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
jest.mock("@admin/components/ui/toggle-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
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
// Titles, actions and toolbars are what these tests read.
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      PageHeader: ({
        title,
        meta,
        actions,
      }: {
        title: string;
        meta?: React.ReactNode;
        actions?: React.ReactNode;
      }) => React.createElement("header", null, title, meta, actions),
      Section: ({
        title,
        toolbar,
        children,
      }: {
        title: string;
        toolbar?: React.ReactNode;
        children: React.ReactNode;
      }) => React.createElement("section", null, title, toolbar, children),
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

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const byHost = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
const button = (root: ReactTestInstance, label: string) => {
  const found = root.findAll(
    (node) => node.type === "button" && text(node).includes(label),
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
};
const flush = async () => {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
async function render(element: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    );
  });
  await flush();
  return renderer;
}

const signIn: PersonalSignIn = {
  serviceId: "svc-mail",
  name: "Pošta",
  icon: "mail",
  iconSource: "custom",
  requiredFor: "all",
  ready: true,
  provider: null,
  status: "connected",
  account: "anna@example.test",
  expiresAt: Date.now() + 3600_000,
  configRevision: 1,
  connectionRevision: 1,
};
const permissions = (
  patch: Partial<PersonalServicePermissions> = {},
): PersonalServicePermissions => ({
  ...mockTarget,
  serviceId: "svc-mail",
  name: "Pošta",
  requiredFor: "all",
  revision: 3,
  actions: [
    {
      id: "read-1",
      name: "Najít e-maily",
      description: "Hledá ve schránce",
      effect: "read",
      enabled: true,
      approval: "never",
    },
    {
      id: "read-2",
      name: "Číst kalendář",
      description: "",
      effect: "read",
      enabled: false,
      approval: "never",
    },
    {
      id: "write-1",
      name: "Poslat e-mail",
      description: "Odešle zprávu",
      effect: "write",
      enabled: true,
      approval: "always",
    },
  ],
  ...patch,
});
function serve(view: PersonalServicePermissions, list = [signIn]) {
  mockApi.mockImplementation(async (path: string, body: unknown) => {
    if (path === "identity/catalog/oauth/list")
      return { ...mockTarget, services: list };
    if (path === "identity/catalog/oauth/permissions") return view;
    if (path === "identity/catalog/oauth/permissions/save") {
      const input = body as {
        actions: { actionId: string; enabled: boolean; approval: string }[];
      };
      return {
        ...view,
        revision: view.revision + 1,
        actions: view.actions.map((action) => {
          const change = input.actions.find((c) => c.actionId === action.id);
          return change
            ? { ...action, enabled: change.enabled, approval: change.approval }
            : action;
        }),
      };
    }
    throw new Error(`unexpected ${path}`);
  });
}
const saves = () =>
  mockApi.mock.calls
    .filter(([path]) => path === "identity/catalog/oauth/permissions/save")
    .map(([, body]) => body);

beforeEach(() => mockApi.mockReset());

describe("Connections → service detail", () => {
  test("shows the account and what the assistant may do, grouped, with approval for changes", async () => {
    serve(permissions());
    const { root } = await render(<ConnectionDetailPage />);
    const page = text(root);
    expect(page).toContain("Pošta");
    expect(page).toContain("Připojeno");
    expect(page).toContain("anna@example.test");
    expect(page).toContain("Co může asistent dělat");
    expect(page).toContain("Čtení");
    expect(page).toContain("Změny");
    expect(page).not.toContain("Čtení nastavuje správce");
    // Reads have only a switch; the change also has an approval choice.
    const switches = byHost(root, "Switch");
    expect(
      switches.map((s) => [s.props["aria-label"], s.props.checked]),
    ).toEqual([
      ["Najít e-maily", true],
      ["Číst kalendář", false],
      ["Poslat e-mail", true],
    ]);
    const approval = byHost(root, "Select");
    expect(approval).toHaveLength(1);
    expect(approval[0]!.props.value).toBe("always");
    expect(text(root)).toContain("Vždy se zeptat");
    expect(text(root)).toContain("Bez ptaní");
    // Disconnect lives in the "…" menu, behind a confirmation; never a
    // button beside the primary action.
    expect(byHost(root, "ConfirmAction")).toHaveLength(1);
    expect(byHost(root, "MoreActions")).toHaveLength(1);
    expect(
      root.findAll(
        (node) => node.type === "button" && text(node).includes("Odpojit"),
      ),
    ).toHaveLength(0);
  });

  test("each switch, approval and group toggle saves the person's own revision", async () => {
    serve(permissions());
    const { root } = await render(<ConnectionDetailPage />);
    await act(async () => {
      byHost(root, "Select")[0]!.props.onValueChange("never");
    });
    await flush();
    expect(saves()[0]).toEqual({
      ...mockTarget,
      serviceId: "svc-mail",
      revision: 3,
      actions: [{ actionId: "write-1", enabled: true, approval: "never" }],
    });
    // Not every read is on: the group offers turning all of them on.
    await act(async () => {
      button(root, "Vše zapnout").props.onClick();
    });
    await flush();
    expect(saves()[1]).toMatchObject({
      revision: 4,
      actions: [{ actionId: "read-2", enabled: true, approval: "never" }],
    });
    await act(async () => {
      byHost(root, "Switch")
        .find((s) => s.props["aria-label"] === "Poslat e-mail")!
        .props.onCheckedChange(false);
    });
    await flush();
    expect(saves()).toHaveLength(3);
  });

  test("a changed revision reloads the current choices and says so", async () => {
    serve(permissions());
    const { root } = await render(<ConnectionDetailPage />);
    const { ApiError } = jest.requireMock("../apps/server-admin/web/lib/api");
    mockApi.mockImplementation(async (path: string) => {
      if (path === "identity/catalog/oauth/permissions/save")
        throw new ApiError(409, "personal_policy_conflict");
      if (path === "identity/catalog/oauth/list")
        return { ...mockTarget, services: [signIn] };
      return permissions({ revision: 5 });
    });
    await act(async () => {
      byHost(root, "Switch")[0]!.props.onCheckedChange(false);
    });
    await flush();
    expect(text(root)).toContain("Nastavení se mezitím změnilo");
  });

  test("changes-only sign-in lists changes and leaves reading to the administrator", async () => {
    const view = permissions({ requiredFor: "writes" });
    serve(
      { ...view, actions: view.actions.filter((a) => a.effect === "write") },
      [{ ...signIn, requiredFor: "writes" }],
    );
    const { root } = await render(<ConnectionDetailPage />);
    expect(text(root)).toContain("Čtení nastavuje správce.");
    expect(byHost(root, "Switch")).toHaveLength(1);
  });

  test("a service the person may not connect to is not found", async () => {
    serve(permissions(), []);
    const { root } = await render(<ConnectionDetailPage />);
    expect(text(root)).toContain("Tahle služba tu pro tebe není.");
    expect(
      mockApi.mock.calls.some(
        ([path]) => path === "identity/catalog/oauth/permissions",
      ),
    ).toBe(false);
  });
});

describe("chat approval card", () => {
  const waiting: ServiceResult = {
    type: "service.action",
    version: 1,
    operationId: "op-1",
    title: "Poslat e-mail",
    service: "Pošta",
    status: "awaiting_approval",
    effect: "write",
    fields: [{ label: "to", value: "jana@example.test" }],
    inputJson: "{}",
    reviewTruncated: false,
    summary: "",
  };
  test("'Příště se neptat' saves only after the approval is sent", async () => {
    const order: string[] = [];
    mockApi.mockImplementation(async (path: string) => {
      order.push(path);
      return path.endsWith("/approval") ? { available: true } : { ok: true };
    });
    const onDecide = jest.fn(() => order.push("approve"));
    const { root } = await render(
      <ServiceActionView
        result={waiting}
        disabled={false}
        onDecide={onDecide}
        rememberTarget={mockWorkspace}
      />,
    );
    expect(text(root)).toContain("Příště se neptat");
    await act(async () => {
      byHost(root, "Checkbox")[0]!.props.onCheckedChange(true);
    });
    await act(async () => {
      button(root, "Potvrdit").props.onClick();
    });
    expect(onDecide).toHaveBeenCalledWith(true);
    expect(order.slice(1)).toEqual([
      "approve",
      "identity/catalog/oauth/approval/remember",
    ]);
    expect(mockApi.mock.calls.at(-1)![1]).toEqual({
      organizationId: "org-1",
      workspaceId: "ws-1",
      operationId: "op-1",
    });
  });
  test("no option without the person's own account, and none unless ticked", async () => {
    mockApi.mockResolvedValue({ available: false });
    const { root } = await render(
      <ServiceActionView
        result={waiting}
        disabled={false}
        onDecide={() => {}}
        rememberTarget={mockWorkspace}
      />,
    );
    expect(text(root)).not.toContain("Příště se neptat");
    mockApi.mockResolvedValue({ available: true });
    const second = await render(
      <ServiceActionView
        result={{ ...waiting, operationId: "op-2" }}
        disabled={false}
        onDecide={() => {}}
        rememberTarget={mockWorkspace}
      />,
    );
    await act(async () => {
      button(second.root, "Potvrdit").props.onClick();
    });
    expect(
      mockApi.mock.calls.some(([path]) => String(path).endsWith("/remember")),
    ).toBe(false);
  });
});

describe("console: personal-sign-in service", () => {
  const service: Service = {
    id: "svc-mail",
    revision: 4,
    name: "Pošta",
    url: "https://mail.example.test",
    protocol: "mcp",
    icon: "mail",
    iconSource: "custom",
    auth: { type: "bearer" },
    enabled: true,
    hasCredential: false,
    modelId: null,
    actions: [
      {
        id: "write-1",
        revision: 1,
        name: "Poslat e-mail",
        description: "",
        inputSchema: { type: "object" },
        binding: { type: "mcp", name: "send_mail" },
        effect: "write",
        approval: "never",
        enabled: true,
        policy: { roles: [], users: [] },
        sourceKey: null,
      },
    ],
  };
  async function state() {
    let copy!: CatalogCopy;
    const Capture = () => {
      copy = useCatalogCopy();
      return null;
    };
    await render(<Capture />);
    return {
      copy,
      busy: false,
      conflict: false,
      query: { data: { canManage: true }, isError: false },
      scope: { workspace: { roles: [] } },
      mutate: jest.fn(),
      setError: jest.fn(),
      resetDrafts: jest.fn(),
      error: null,
    } as unknown as CatalogState;
  }
  test("actions show only the ceiling; people manage their own permissions", async () => {
    const catalog = await state();
    const { root } = await render(
      <ServiceActionList
        state={catalog}
        service={service}
        personal="all"
        onOpen={() => {}}
      />,
    );
    const page = text(root);
    expect(page).toContain(
      "Lidé si připojí vlastní účet a sami určí, co asistent smí.",
    );
    expect(page).toContain("Každý sám");
    expect(page).not.toContain("Bez přístupu");
    // The switch is the administrator's available/blocked ceiling.
    expect(byHost(root, "Switch")[0]!.props.checked).toBe(true);
  });
  test("shared services keep role access", async () => {
    const catalog = await state();
    const { root } = await render(
      <ServiceActionList state={catalog} service={service} onOpen={() => {}} />,
    );
    expect(text(root)).toContain("Bez přístupu");
    expect(text(root)).not.toContain("Každý sám");
  });
  test("access becomes who may connect", async () => {
    const catalog = await state();
    const personal = await render(
      <ServiceAccess state={catalog} service={service} personal />,
    );
    expect(text(personal.root)).toContain("Kdo se může připojit");
    const shared = await render(
      <ServiceAccess state={catalog} service={service} />,
    );
    expect(text(shared.root)).toContain("Kdo může službu používat");
  });
});

describe("console: action access presentation", () => {
  type Action = Service["actions"][number];
  const action = (policy: Partial<Action["policy"]>) =>
    ({ policy: { roles: [], users: [], ...policy } }) as unknown as Action;
  test("normal access is quiet; only missing access is an exception", async () => {
    let copy!: CatalogCopy;
    const Capture = () => {
      copy = useCatalogCopy();
      return null;
    };
    await render(<Capture />);
    expect(
      actionAccess(action({ roles: ["owner", "admin", "member"] }), copy),
    ).toEqual({ tone: "neutral", label: copy.everyone });
    expect(actionAccess(action({ roles: ["admin"] }), copy).tone).toBe(
      "neutral",
    );
    expect(actionAccess(action({}), copy)).toEqual({
      tone: "warning",
      label: copy.noAccess,
    });
  });
});
