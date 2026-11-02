import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProcessExecutionEntry } from "../packages/protocol/process-execution";
import type { WorkItem } from "../packages/protocol";
import { translate } from "../packages/i18n";
import {
  ProcessList,
  RunSheet,
  runFailure,
  runStatusKey,
} from "../apps/server-admin/web/app/processes-page";
import { AccountPage } from "../apps/server-admin/web/app/account-page";
import { menuCopy } from "../apps/server-admin/web/app/menu-copy";
import { processFailure } from "../packages/protocol/process-failure";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {},
}));
const mockSignOut = jest.fn();
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({
    language: "cs",
    identity: { user: { id: "user-1", name: "Anna", email: "a@example.test" } },
    workspace: { organizationId: "org-1", workspaceId: "workspace-1" },
    session: null,
    signOut: mockSignOut,
  }),
  useAppSession: () => ({ identityKey: "identity-1" }),
}));
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ to, ...props }: React.ComponentProps<"a"> & { to: string }) =>
      React.createElement("a", { ...props, href: to }),
    useNavigate: () => jest.fn(),
  };
});
jest.mock("../apps/server-admin/web/app/archived-chats", () => ({
  ArchivedChats: () => null,
}));
jest.mock("../apps/server-admin/web/app/menu-page", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    MenuPage: ({ children }: { children: React.ReactNode }) =>
      React.createElement("main", null, children),
    When: () => null,
    useSessionState: () => ({}),
  };
});
jest.mock("../apps/server-admin/web/service-process-overview", () => ({
  DesignSessions: () => null,
}));
jest.mock("../apps/server-admin/web/lib/process-design-client", () => ({
  storedDesignSessions: () => [],
}));
jest.mock("../apps/server-admin/web/process-design-copy", () => ({
  designCs: {},
  designEn: {},
}));
jest.mock("../apps/server-admin/web/app/process-form", () => ({
  ProcessInputForm: () => null,
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/time", () => host(), { virtual: true });
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      PageHeader: ({ actions }: { actions?: React.ReactNode }) =>
        React.createElement("header", null, actions),
      Section: ({
        title,
        actions,
        children,
      }: {
        title: string;
        actions?: React.ReactNode;
        children: React.ReactNode;
      }) =>
        React.createElement(
          "section",
          { "data-title": title },
          React.createElement("h2", null, title, actions),
          children,
        ),
    };
  },
  { virtual: true },
);

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const byHost = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
async function flush() {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
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
beforeEach(() => {
  mockApi.mockReset();
  mockSignOut.mockReset();
});

describe("Processes", () => {
  const tr = translate("cs");
  const summary = {
    description: "",
    kind: "workflow" as const,
    version: 1,
    artifactDigest: "a".repeat(64),
  };
  const blocked = (
    processId: string,
    reason: Extract<
      ProcessExecutionEntry,
      { availability: "blocked" }
    >["reason"],
  ): ProcessExecutionEntry => ({
    ...summary,
    processId,
    name: `Proces ${processId}`,
    availability: "blocked",
    reason,
  });

  test("a blocked process says what to do: connect the account, or wait for a retest", async () => {
    const onOpen = jest.fn();
    const { root } = await render(
      <ProcessList
        entries={[
          blocked("connect", "connection_required"),
          blocked("changed", "source_changed"),
        ]}
        copy={menuCopy.cs}
        language="cs"
        disabled={false}
        onOpen={onOpen}
      />,
    );
    const link = root.find((node) => node.type === "a");
    expect(link.props.href).toBe("/connections");
    expect(text(link)).toContain("Proces connect");
    // The shared failure sentence, the same on the phone.
    expect(text(link)).toContain(
      processFailure("connection_required", "cs").sentence,
    );
    const changed = root.find((node) => node.type === "button");
    expect(changed.props.disabled).toBe(true);
    expect(text(changed)).toContain(
      "Služba, kterou používá, se změnila, takže potřebuje nový test.",
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  test("an admin's blocked process that needs a new test opens that test", async () => {
    const { root } = await render(
      <ProcessList
        entries={[blocked("changed", "source_changed")]}
        copy={menuCopy.cs}
        language="cs"
        disabled={false}
        isAdmin
        onOpen={jest.fn()}
      />,
    );
    const link = root.find((node) => node.type === "a");
    expect(link.props.href).toBe("/admin/processes/changed");
    expect(root.findAll((node) => node.type === "button")).toEqual([]);
  });

  test("a finished run reads Completed; a failed one says why in its row", () => {
    expect(tr(runStatusKey("succeeded"))).toBe("Dokončeno");
    expect(translate("en")(runStatusKey("succeeded"))).toBe("Completed");
    expect(tr(runStatusKey("failed"))).toBe(tr("failed"));
    const run = (patch: Partial<WorkItem>) => patch as WorkItem;
    expect(
      runFailure(
        run({ status: "failed", result: "\nCRM odmítlo přístup.\nDetail…" }),
      ),
    ).toBe("CRM odmítlo přístup.");
    expect(runFailure(run({ status: "failed" }))).toBeNull();
    // A run with a safe failure code reads as the shared sentence.
    expect(
      runFailure(
        run({
          status: "failed",
          result: "Proces selhal.",
          native: {
            process: { failureCode: "process_step_limit" },
          } as WorkItem["native"],
        }),
        "cs",
      ),
    ).toBe("Potřeboval víc kroků, než mu limity dovolí.");
    expect(
      runFailure(run({ status: "succeeded", result: "Hotovo" })),
    ).toBeNull();
  });
});

// NIAR-271: a run's sheet says why it stopped, with one next step and Run again.
describe("Run sheet", () => {
  const failed = (failureCode: string, processId = "process-1") =>
    ({
      id: "run-1",
      title: "Nabídka",
      context: "Proces selhal.",
      conversationId: "chat-1",
      status: "failed",
      result: "Proces selhal.",
      native: {
        process: {
          failureCode,
          provenance: { processId },
        },
      },
    }) as unknown as WorkItem;
  const sheet = (work: WorkItem, patch: Record<string, unknown> = {}) =>
    render(
      <RunSheet
        run={work}
        copy={menuCopy.cs}
        language="cs"
        problem={null}
        error={null}
        busy={false}
        disabled={false}
        personal={false}
        isAdmin={false}
        onRunAgain={jest.fn()}
        onClose={jest.fn()}
        {...patch}
      />,
    );

  test("a missing sign-in reads as the shared sentence with Sign in, and Run again starts nothing by itself", async () => {
    const onRunAgain = jest.fn();
    const { root } = await sheet(failed("connection_required"), {
      onRunAgain,
    });
    const notice = root.find(
      (node) => node.props["data-failure-code"] === "connection_required",
    );
    expect(text(notice)).toContain(
      processFailure("connection_required", "cs").sentence,
    );
    const signIn = notice.find((node) => node.type === "a");
    expect(signIn.props.href).toBe("/connections");
    expect(text(signIn)).toBe(menuCopy.cs.processSignIn);
    const again = byHost(root, "Button").find(
      (node) => text(node) === menuCopy.cs.processRunAgain,
    )!;
    expect(onRunAgain).not.toHaveBeenCalled();
    await act(async () => again.props.onClick());
    expect(onRunAgain).toHaveBeenCalledTimes(1);
  });

  test("Retest leads to the person's own process; a member gets no action for a company process", async () => {
    const own = await sheet(failed("source_changed"), { personal: true });
    const link = own.root
      .find((node) => node.props["data-failure-code"] === "source_changed")
      .find((node) => node.type === "a");
    expect(link.props.href).toBe("/processes/$processId");
    expect(text(link)).toBe(menuCopy.cs.processRetest);
    const company = await sheet(failed("source_changed"));
    expect(
      company.root
        .find((node) => node.props["data-failure-code"] === "source_changed")
        .findAll((node) => node.type === "a"),
    ).toEqual([]);
    const admin = await sheet(failed("process_step_limit", "p 2"), {
      isAdmin: true,
    });
    expect(
      admin.root
        .find((node) => node.props["data-failure-code"] === "process_step_limit")
        .find((node) => node.type === "a").props.href,
    ).toBe("/admin/processes/p%202");
  });

  test("a Run again that can't open a form says why in the sheet", async () => {
    const { root } = await sheet(failed("process_cancelled"), {
      problem: "model_unavailable",
    });
    expect(text(root)).toContain(
      processFailure("model_unavailable", "cs").sentence,
    );
  });
});

describe("Account", () => {
  const access = {
    hasPassword: false,
    limit: 8,
    used: 0,
    devices: [],
    sessions: [],
    browsers: [
      {
        id: "b".repeat(32),
        current: false,
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() + 3_600_000,
        userAgent: "Mozilla/5.0 Firefox/130.0",
        chats: [],
      },
      {
        id: "a".repeat(32),
        current: true,
        createdAt: Date.now() - 60_000,
        expiresAt: Date.now() + 3_600_000,
        userAgent: "Mozilla/5.0 Chrome/130.0",
        chats: [],
      },
    ],
    mcp: [],
  };
  const browsers = (root: ReactTestInstance) =>
    root.find((node) => node.props["data-title"] === "Prohlížeče");

  test("this browser comes first; the others sign out together after a confirmation", async () => {
    mockApi.mockResolvedValue(access);
    const { root } = await render(<AccountPage />);
    const rows = byHost(browsers(root), "ItemTitle").map((node) => text(node));
    expect(rows[0]).toContain("Tento prohlížeč");
    expect(rows[1]).not.toContain("Tento prohlížeč");
    const confirm = byHost(browsers(root), "ConfirmAction").find(
      (node) => node.props.title === "Odhlásit ostatní prohlížeče?",
    )!;
    expect(confirm.props.open).toBe(false);
    const item = byHost(browsers(root), "DropdownMenuItem").find((node) =>
      text(node).includes("Odhlásit ostatní prohlížeče"),
    )!;
    await act(async () => item.props.onSelect());
    expect(
      byHost(browsers(root), "ConfirmAction").find(
        (node) => node.props.title === "Odhlásit ostatní prohlížeče?",
      )!.props.open,
    ).toBe(true);
    expect(mockApi).not.toHaveBeenCalledWith("identity/account/access", {
      action: "revokeOthers",
    });
    await act(async () => confirm.props.onConfirm());
    await flush();
    expect(mockApi).toHaveBeenCalledWith("identity/account/access", {
      action: "revokeOthers",
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  test("only this browser: nothing else to sign out", async () => {
    mockApi.mockResolvedValue({
      ...access,
      browsers: access.browsers.filter((browser) => browser.current),
    });
    const { root } = await render(<AccountPage />);
    expect(text(browsers(root))).not.toContain("Odhlásit ostatní prohlížeče");
  });

  test("a failed sign-out everywhere says so and keeps this browser signed in", async () => {
    mockApi.mockImplementation(
      async (_path: string, body: { action: string }) => {
        if (body.action === "revokeAll") throw new Error("network_error");
        return access;
      },
    );
    const { root } = await render(<AccountPage />);
    const everywhere = byHost(root, "ConfirmAction").find(
      (node) => node.props.title === "Odhlásit všude?",
    )!;
    await act(async () => everywhere.props.onConfirm());
    await flush();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(text(root)).toContain("Něco se nepovedlo. Zkus to znovu.");
    mockApi.mockResolvedValue({ ok: true });
    await act(async () => everywhere.props.onConfirm());
    await flush();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
