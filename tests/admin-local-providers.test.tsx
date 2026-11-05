import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import type {
  CatalogModel,
  Provider,
} from "../packages/protocol/service-catalog";
import { ProviderForm } from "../apps/server-admin/web/provider-form";
import {
  ModelCapabilityTest,
  testedCapabilities,
} from "../apps/server-admin/web/model-capability-test";
import { SearchBackendForm } from "../apps/server-admin/web/search-backends";
import { catalogCopy } from "../apps/server-admin/web/catalog-copy";
import type { CatalogState } from "../apps/server-admin/web/catalog-shared";

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
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  catalogIssue: () => "TEST failure",
}));
function mockHost() {
  return jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
}
jest.mock("@admin/components/ui/button", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/input", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => mockHost(), {
  virtual: true,
});
jest.mock("@admin/components/ui/alert", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/select", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/field", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/card", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => mockHost(), { virtual: true });
jest.mock("@admin/components/ui/table", () => mockHost(), { virtual: true });
jest.mock("@admin/components/console/page", () => mockHost(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => mockHost(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => mockHost(), {
  virtual: true,
});

const mutate = jest.fn();
const state = {
  copy: catalogCopy.en,
  busy: false,
  error: null,
  target: { organizationId: "TEST-org", workspaceId: "TEST-ws" },
  mutate: (...args: unknown[]) => mutate(...args),
  setError: () => {},
} as unknown as CatalogState;

const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  mockApi.mockReset();
  mutate.mockReset();
});
function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer.root;
}
const byId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => typeof node.type === "string" && node.props.id === id);
/** The Select whose trigger carries this id. */
const select = (root: ReactTestInstance, id: string) =>
  root.find(
    (node) =>
      node.props["data-host"] === "Select" &&
      node.findAll((child) => child.props.id === id).length > 0,
  );
const input = (root: ReactTestInstance, id: string) => byId(root, id)[0]!;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const submit = async (root: ReactTestInstance) => {
  await act(async () => {
    await root
      .find((node) => node.type === "form")
      .props.onSubmit({ preventDefault() {} });
  });
};

test("a new provider starts from a preset that fills address, key handling and note", async () => {
  mutate.mockResolvedValue({ id: "TEST-new" });
  const saved = jest.fn();
  const root = render(
    <ProviderForm state={state} close={() => {}} saved={saved} />,
  );
  // OpenRouter is the starting preset, with its own request format.
  expect(input(root, "provider-url").props.value).toBe(
    "https://openrouter.ai/api/v1",
  );
  expect(select(root, "provider-dialect").props.value).toBe("openrouter");
  expect(byId(root, "provider-key")).toHaveLength(1);
  // Ollama: local, keyless and free, with its note and the trusted-origin hint.
  act(() => select(root, "provider-preset").props.onValueChange("ollama"));
  expect(input(root, "provider-url").props.value).toBe(
    "http://localhost:11434/v1",
  );
  expect(byId(root, "provider-key")).toHaveLength(0);
  expect(byId(root, "provider-free")[0]!.props.checked).toBe(true);
  expect(input(root, "provider-data").props.value).toBe(
    "Runs locally. Nothing leaves the server.",
  );
  expect(text(root)).toContain("trusted origins");
  // Every field stays editable after the preset.
  act(() =>
    input(root, "provider-url").props.onChange({
      target: { value: "http://127.0.0.1:11434/v1" },
    }),
  );
  await submit(root);
  expect(mutate).toHaveBeenCalledWith("command", {
    type: "saveProvider",
    revision: 0,
    settings: {
      name: "Ollama",
      url: "http://127.0.0.1:11434/v1",
      enabled: true,
      dailyRequestLimit: 1000,
      preset: "ollama",
      auth: { type: "none" },
      dialect: "openai",
      free: true,
      dataHandling: "Runs locally. Nothing leaves the server.",
    },
  });
  expect(saved).toHaveBeenCalledWith("TEST-new");
});

test("Azure sends its key in a named header, and the key never comes back", async () => {
  mutate.mockResolvedValue({ id: "TEST-azure" });
  const provider: Provider = {
    id: "TEST-azure",
    revision: 3,
    name: "TEST Azure",
    url: "https://test.openai.azure.com/openai/v1",
    enabled: true,
    dailyRequestLimit: 50,
    hasCredential: true,
    requestsToday: 0,
    preset: "azure",
    auth: { type: "header", header: "api-key" },
    dialect: "openai",
  };
  const root = render(
    <ProviderForm
      state={state}
      provider={provider}
      close={() => {}}
      saved={() => {}}
    />,
  );
  expect(input(root, "provider-header").props.value).toBe("api-key");
  // A stored key shows only as a placeholder; saving without typing keeps it.
  expect(input(root, "provider-key").props.value).toBe("");
  expect(input(root, "provider-key").props.placeholder).toBe("••••••••");
  await submit(root);
  const [, command] = mutate.mock.calls[0]!;
  expect(command).toMatchObject({
    type: "saveProvider",
    id: "TEST-azure",
    revision: 3,
    settings: { auth: { type: "header", header: "api-key" }, free: false },
  });
  expect(command).not.toHaveProperty("apiKey");
});

const chatModel: CatalogModel = {
  id: "TEST-model",
  revision: 2,
  providerId: "TEST-provider",
  name: "TEST local",
  model: "llama3.2",
  enabled: true,
  tools: false,
  audioInput: false,
  audioOutput: false,
  kind: "chat",
};

test("the capability test shows what the provider answered and fills the switches", async () => {
  mockApi.mockResolvedValue({
    results: [
      { capability: "tools", status: "supported" },
      { capability: "imageInput", status: "unsupported" },
      {
        capability: "audioInput",
        status: "failed",
        error: "integration_timeout",
      },
      { capability: "audioOutput", status: "skipped", error: "voice_required" },
    ],
  });
  const onApply = jest.fn();
  const root = render(
    <ModelCapabilityTest state={state} model={chatModel} onApply={onApply} />,
  );
  // Nothing is sent until the administrator starts it.
  expect(mockApi).not.toHaveBeenCalled();
  const start = root.find(
    (node) =>
      node.type === "button" && text(node).includes("Test capabilities"),
  );
  await act(async () => {
    await start.props.onClick();
  });
  expect(mockApi).toHaveBeenCalledWith("identity/catalog/models/test", {
    organizationId: "TEST-org",
    workspaceId: "TEST-ws",
    modelId: "TEST-model",
    revision: 2,
  });
  const shown = text(root);
  expect(shown).toContain("Tool callingSupported");
  expect(shown).toContain("Image inputNot supported");
  expect(shown).toContain("Audio inputCould not test");
  expect(shown).toContain("Audio outputNeeds a voice");
  const apply = root.find(
    (node) => node.type === "button" && text(node) === "Use these results",
  );
  act(() => apply.props.onClick());
  // Failed and skipped tests declare nothing.
  expect(onApply).toHaveBeenCalledWith({ tools: true, imageInput: false });
});

test("only answers become declared capabilities", () => {
  expect(
    testedCapabilities([
      { capability: "transcription", status: "supported" },
      { capability: "audioInput", status: "supported" },
      { capability: "audioOutput", status: "failed" },
    ]),
  ).toEqual({ audioInput: true });
});

test("a failed test says so without results", async () => {
  mockApi.mockRejectedValue(new Error("budget"));
  const root = render(
    <ModelCapabilityTest state={state} model={chatModel} onApply={() => {}} />,
  );
  await act(async () => {
    await root
      .find(
        (node) =>
          node.type === "button" && text(node).includes("Test capabilities"),
      )
      .props.onClick();
  });
  expect(
    root.find((node) => node.props.role === "alert").children.join(""),
  ).toBe("TEST failure");
});

test("a search backend form fills the service's address and sends the key once", async () => {
  mutate.mockResolvedValue({ id: "TEST-search" });
  const close = jest.fn();
  const root = render(<SearchBackendForm state={state} close={close} />);
  expect(input(root, "search-url").props.value).toBe("http://localhost:8888");
  act(() => select(root, "search-kind").props.onValueChange("brave"));
  expect(input(root, "search-url").props.value).toBe(
    "https://api.search.brave.com/res/v1",
  );
  expect(input(root, "search-name").props.value).toBe("Brave Search");
  act(() =>
    input(root, "search-key").props.onChange({
      target: { value: "TEST-brave-key" },
    }),
  );
  await submit(root);
  expect(mutate).toHaveBeenCalledWith("command", {
    type: "saveSearchBackend",
    revision: 0,
    settings: {
      name: "Brave Search",
      kind: "brave",
      url: "https://api.search.brave.com/res/v1",
      enabled: true,
    },
    apiKey: "TEST-brave-key",
  });
  expect(close).toHaveBeenCalled();
});
