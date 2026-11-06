import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  emptyOrganizationPolicy,
  emptyWorkspacePolicy,
  policyView,
  type StoredModelPolicies,
} from "../packages/protocol/model-policy";
import type { Catalog } from "../packages/protocol/service-catalog";
import {
  ModelPolicyPage,
  modelFits,
} from "../apps/server-admin/web/model-policy-page";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    data: { authentication: { principalId: "TEST-admin" } },
  }),
}));
const mockMutate = jest.fn();
let mockCatalog: Catalog;
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  useCatalog: () => ({
    query: { data: mockCatalog },
    target: { organizationId: "TEST-org", workspaceId: "TEST-ws" },
    busy: false,
    error: null,
    mutate: (...args: unknown[]) => mockMutate(...args),
    setError: () => {},
  }),
  CatalogBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ to, children, ...props }: Record<string, unknown>) =>
      React.createElement(
        "a",
        { ...props, href: to as string },
        children as React.ReactNode,
      ),
  };
});
jest.mock("../apps/server-admin/web/search-backends", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    // The web search section: its title, the choice, and whether the
    // organization's backends are managed here.
    SearchBackendsSection: ({
      title,
      manage,
      children,
    }: {
      title: string;
      manage: boolean;
      children: React.ReactNode;
    }) =>
      React.createElement(
        "section",
        { "data-host": "SearchBackendsSection", "data-manage": manage },
        title,
        children,
      ),
  };
});
jest.mock("../apps/server-admin/web/model-choice-picker", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    // Each offered model is a button that picks it.
    ModelChoicePicker: ({
      label,
      choices,
      onChange,
    }: {
      label: string;
      choices: { value: string; label: string }[];
      onChange: (value: string) => void;
    }) =>
      React.createElement(
        "div",
        { "data-host": "ModelChoicePicker", "aria-label": label },
        choices
          .filter((choice) => choice.value)
          .map((choice) =>
            React.createElement(
              "button",
              {
                key: choice.value,
                "data-pick": choice.value,
                onClick: () => onChange(choice.value),
              },
              choice.label,
            ),
          ),
      ),
  };
});
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/tabs", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), {
  virtual: true,
});
jest.mock(
  "@admin/components/console/setting-row",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return host({
      SettingRow: ({
        label,
        meta,
        children,
      }: Record<string, React.ReactNode>) =>
        React.createElement(
          "div",
          { "data-host": "SettingRow" },
          label,
          meta,
          children,
        ),
    });
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const slots =
      (name: string) =>
      // eslint-disable-next-line react/display-name -- test stand-in
      ({ title, actions, children }: Record<string, React.ReactNode>) =>
        React.createElement(
          "section",
          { "data-host": name },
          title,
          actions,
          children,
        );
    return { PageHeader: slots("PageHeader"), Section: slots("Section") };
  },
  { virtual: true },
);

const provider = {
  id: "TEST-provider",
  revision: 1,
  name: "TEST provider",
  url: "https://llm.example.test/v1",
  enabled: true,
  dailyRequestLimit: 100,
  hasCredential: true,
  requestsToday: 0,
};
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  providerId: provider.id,
  name: "TEST " + id,
  model: "test/" + id,
  enabled: true,
  tools: true,
  audioInput: false,
  audioOutput: false,
  kind: "chat" as const,
  ...extra,
});
const models = [
  model("chat"),
  model("small"),
  model("stt", { kind: "transcription", tools: false }),
];
function catalog(policies: Partial<StoredModelPolicies> = {}): Catalog {
  const stored: StoredModelPolicies = {
    organization: { revision: 0, policy: emptyOrganizationPolicy() },
    workspace: { revision: 0, policy: emptyWorkspacePolicy() },
    ...policies,
  };
  return {
    organizationId: "TEST-org",
    workspaceId: "TEST-ws",
    canManage: true,
    voiceAvailable: true,
    legacyVoiceAvailable: false,
    services: [],
    providers: [provider],
    models,
    policy: policyView(stored, []),
    signIn: [],
    personalServices: "review",
    personalManagement: "owner",
  } as unknown as Catalog;
}
const budget = (mode: "observe" | "enforce", prices: string[] = []) => ({
  organizationId: "TEST-org",
  workspaceId: "TEST-ws",
  revision: 1,
  settings: {
    mode,
    maxTokens: 100_000,
    maxCostMicros: 1_000_000,
    prices: prices.map((modelId) => ({
      modelId,
      modelRevision: 1,
      providerRevision: 1,
      maxInputTokens: 4096,
      maxOutputTokens: 1000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    })),
  },
});
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const flush = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const mounted: (() => void)[] = [];
async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ModelPolicyPage />
      </QueryClientProvider>,
    );
  });
  await flush();
  mounted.push(() => {
    renderer.unmount();
    client.clear();
  });
  return renderer.root;
}
const row = (root: ReactTestInstance, label: string) =>
  root.find(
    (node) =>
      node.props["data-host"] === "SettingRow" &&
      typeof node.children[0] === "string" &&
      node.children[0] === label,
  );
const buttonNamed = (root: ReactTestInstance, name: string) =>
  root.find(
    (node) => node.type === "button" && node.props["aria-label"] === name,
  );
afterEach(() => {
  for (const unmount of mounted.splice(0)) act(unmount);
  mockApi.mockReset();
  mockMutate.mockReset();
});

test("only models that fit a role are offered for it", () => {
  const plain = { dialect: "openai" as const };
  const openRouter = { dialect: "openrouter" as const };
  expect(modelFits("chat", models[0]!, plain)).toBe(true);
  expect(modelFits("chat", models[2]!, plain)).toBe(false);
  // A checker or selector may be any tool model, on any provider.
  expect(modelFits("checker", models[1]!, plain)).toBe(true);
  // Audio goes through the standard endpoints of any provider.
  expect(modelFits("meeting_transcription", models[2]!, plain)).toBe(true);
  expect(modelFits("meeting_transcription", models[2]!, openRouter)).toBe(true);
  // The provider's own web search is OpenRouter's web plugin.
  expect(modelFits("web_search", models[0]!, plain)).toBe(false);
  expect(modelFits("web_search", models[0]!, openRouter)).toBe(true);
});

test("an administrator builds the organization default with ordered models and fallback", async () => {
  mockCatalog = catalog();
  mockApi.mockResolvedValue(budget("observe"));
  mockMutate.mockResolvedValue({ id: "TEST-org" });
  const root = await render();
  const chat = row(root, "Chat");
  // Chat is off until a model is added; the transcription model is not offered.
  expect(text(chat)).toContain("Off");
  await act(async () => {
    buttonNamed(chat, "Override: Chat").props.onClick();
  });
  const editor = row(root, "Chat");
  expect(
    editor.findAll((node) => node.props["data-pick"] === "stt"),
  ).toHaveLength(0);
  await act(async () => {
    editor.find((node) => node.props["data-pick"] === "chat").props.onClick();
  });
  await act(async () => {
    row(root, "Chat")
      .find((node) => node.props["data-pick"] === "small")
      .props.onClick();
  });
  // The second model moves up to become the primary.
  await act(async () => {
    buttonNamed(row(root, "Chat"), "Move TEST small up").props.onClick();
  });
  await act(async () => {
    row(root, "Chat")
      .find((node) => node.props.id === "role-chat-fallback")
      .props.onCheckedChange(true);
  });
  expect(text(row(root, "Chat"))).toContain("TEST small · Primary");
  await act(async () => {
    root
      .find((node) => node.type === "button" && text(node) === "Save changes")
      .props.onClick();
  });
  expect(mockMutate).toHaveBeenCalledWith("command", {
    type: "saveOrganizationModelPolicy",
    revision: 0,
    policy: expect.objectContaining({
      roles: {
        chat: { models: ["small", "chat"], tier: null, fallback: true },
      },
    }),
  });
});

test("a workspace shows what it inherits and overrides one role", async () => {
  mockCatalog = catalog({
    organization: {
      revision: 3,
      policy: {
        ...emptyOrganizationPolicy(),
        roles: { chat: { models: ["chat"], tier: null, fallback: false } },
      },
    },
  });
  mockApi.mockResolvedValue(budget("observe"));
  mockMutate.mockResolvedValue({ id: "TEST-ws" });
  const root = await render();
  await act(async () => {
    root
      .find((node) => node.props["data-host"] === "Tabs")
      .props.onValueChange("workspace");
  });
  expect(text(row(root, "Background work"))).toContain("Same as Chat");
  expect(text(row(root, "Chat"))).toContain("Inherited: TEST chat");
  await act(async () => {
    buttonNamed(
      row(root, "Background work"),
      "Override: Background work",
    ).props.onClick();
  });
  const background = row(root, "Background work");
  await act(async () => {
    buttonNamed(background, "Remove TEST chat").props.onClick();
  });
  await act(async () => {
    row(root, "Background work")
      .find((node) => node.props["data-pick"] === "small")
      .props.onClick();
  });
  await act(async () => {
    root
      .find((node) => node.type === "button" && text(node) === "Save changes")
      .props.onClick();
  });
  expect(mockMutate).toHaveBeenCalledTimes(1);
  expect(mockMutate).toHaveBeenCalledWith("command", {
    type: "saveWorkspaceModelPolicy",
    revision: 0,
    policy: expect.objectContaining({
      roles: {
        background: { models: ["small"], tier: null, fallback: false },
      },
    }),
  });
});

test("stop at limit marks unpriced models and keeps the save off", async () => {
  mockCatalog = catalog({
    organization: {
      revision: 1,
      policy: {
        ...emptyOrganizationPolicy(),
        roles: {
          chat: { models: ["chat"], tier: null, fallback: false },
          background: { models: ["small"], tier: null, fallback: false },
        },
      },
    },
  });
  mockApi.mockResolvedValue(budget("enforce", ["chat"]));
  const root = await render();
  expect(text(root)).toContain(
    "Stop at limit is on: give these models a price before saving: TEST small.",
  );
  expect(text(row(root, "Background work"))).toContain("No price");
  // Any edit keeps the save disabled while a reachable model is unpriced.
  await act(async () => {
    row(root, "Chat")
      .find((node) => node.props.id === "role-chat-fallback")
      .props.onCheckedChange(true);
  });
  const save = root.find(
    (node) => node.type === "button" && text(node) === "Save changes",
  );
  expect(save.props.disabled).toBe(true);
});

test("No price shows only on routes that spend budget and leads to Usage limits", async () => {
  mockCatalog = catalog({
    organization: {
      revision: 1,
      policy: {
        ...emptyOrganizationPolicy(),
        roles: {
          chat: { models: ["chat"], tier: null, fallback: false },
          background: { models: ["small"], tier: null, fallback: false },
          voice_input: { models: ["stt"], tier: null, fallback: false },
        },
      },
    },
  });
  mockApi.mockResolvedValue(budget("enforce", ["chat"]));
  const root = await render();
  const badge = row(root, "Background work").find(
    (node) => node.type === "a" && text(node) === "No price",
  );
  expect(badge.props.href).toBe("/usage");
  expect(badge.props["aria-label"]).toBe(
    "Set a price for TEST small in Usage limits",
  );
  // Voice input is never budgeted, so its transcription model needs no price.
  expect(text(row(root, "Voice input"))).not.toContain("No price");
});

test("each tab names a rendered panel and the open one holds the page", async () => {
  mockCatalog = catalog();
  mockApi.mockResolvedValue(budget("observe"));
  const root = await render();
  const panels = root.findAll(
    (node) => node.props["data-host"] === "TabsContent",
  );
  expect(
    panels.map((panel) => [panel.props.value, panel.props.hidden]),
  ).toEqual([
    ["organization", false],
    ["workspace", true],
  ]);
  expect(panels.every((panel) => panel.props.forceMount)).toBe(true);
  expect(text(panels[1]!)).toBe("");
  // Search backends are managed on the organization tab, beside Search with.
  const search = root.find(
    (node) => node.props["data-host"] === "SearchBackendsSection",
  );
  expect(search.props["data-manage"]).toBe(true);
  expect(text(search)).toContain("Search with");
  expect(text(row(root, "Web search model"))).toContain(
    "Used when searches go through the provider",
  );
  await act(async () => {
    root
      .find((node) => node.props["data-host"] === "Tabs")
      .props.onValueChange("workspace");
  });
  expect(
    root.find((node) => node.props["data-host"] === "SearchBackendsSection")
      .props["data-manage"],
  ).toBe(false);
});

test("the voice offers the speech model's reviewed voices", async () => {
  mockCatalog = {
    ...catalog({
      organization: {
        revision: 1,
        policy: {
          ...emptyOrganizationPolicy(),
          roles: {
            speech: { models: ["tts"], tier: null, fallback: false },
          },
        },
      },
    }),
    models: [
      ...models,
      model("tts", {
        kind: "speech",
        tools: false,
        voices: [{ voice: "test-voice", label: "TEST calm" }],
      }),
    ],
  } as Catalog;
  mockApi.mockResolvedValue(budget("observe"));
  mockMutate.mockResolvedValue({ id: "TEST-org" });
  const root = await render();
  const voice = row(root, "Voice");
  expect(text(voice)).toContain("TEST calm");
  expect(voice.findAll((node) => node.type === "input")).toHaveLength(0);
  await act(async () => {
    voice
      .find((node) => node.props["data-host"] === "Select")
      .props.onValueChange("test-voice");
  });
  await act(async () => {
    root
      .find((node) => node.type === "button" && text(node) === "Save changes")
      .props.onClick();
  });
  expect(mockMutate).toHaveBeenCalledWith("command", {
    type: "saveOrganizationModelPolicy",
    revision: 1,
    policy: expect.objectContaining({
      options: expect.objectContaining({
        speech: expect.objectContaining({ voice: "test-voice" }),
      }),
    }),
  });
});
