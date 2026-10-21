import React from "react";
import { Pressable, Text } from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ProcessDesign } from "../apps/mobile/ProcessDesign";
import type { ClientSession } from "../packages/client-core/session";
import {
  mobileDesignRecoveryKey,
  type MobileDesignPending,
} from "../packages/client-core/process-design-mobile";
import { readProcessDesignPages } from "../packages/client-core/process-design-pages";
import {
  DESIGN_PROFILE,
  WORKSPACE_DESIGN_PROFILE,
  WorkspaceDesignReviewSchema,
} from "../packages/protocol/process-design";
import { translate } from "../packages/i18n";
import {
  designUiCapabilities,
  designUiReview,
  designUiTurn,
} from "./admin-design-fixtures";

jest.mock("expo-crypto", () => ({ randomUUID: () => "mobile-design-request" }));
jest.mock("@react-native-async-storage/async-storage", () => {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(
      async (key: string, value: string) => void values.set(key, value),
    ),
    removeItem: jest.fn(async (key: string) => void values.delete(key)),
  };
});

const target = { organizationId: "test_org", workspaceId: "test_workspace" };
const workspaceReview = (patch: Record<string, unknown> = {}) => {
  const {
    profile: _profile,
    serviceId: _serviceId,
    ...review
  } = designUiReview;
  return WorkspaceDesignReviewSchema.parse({
    ...review,
    profile: WORKSPACE_DESIGN_PROFILE,
    owner: { type: "workspace" },
    ...patch,
  });
};
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

beforeEach(() => jest.clearAllMocks());

test("service history paging preserves order and enforces the exact 1,000-item boundary", async () => {
  const readPages = async (count: number) => {
    const calls: (string | undefined)[] = [];
    const items = Array.from({ length: count }, (_, id) => id);
    const result = await readProcessDesignPages(
      async (after) => {
        calls.push(after);
        const start = Number(after ?? 0);
        const end = Math.min(start + 100, items.length);
        return {
          items: items.slice(start, end),
          nextAfter: end < items.length ? String(end) : null,
        };
      },
      (raw) => raw as { items: number[]; nextAfter: string | null },
    );
    return { calls, result };
  };

  const multiPage = await readPages(205);
  expect(multiPage.calls).toEqual([undefined, "100", "200"]);
  expect(multiPage.result).toEqual(Array.from({ length: 205 }, (_, id) => id));

  const atLimit = await readPages(1000);
  expect(atLimit.calls).toHaveLength(10);
  expect(atLimit.result).toHaveLength(1000);

  await expect(readPages(1001)).rejects.toThrow("process_design_history_limit");
  expect(translate("en")("processDesignHistoryLimit")).toMatch(
    /too much history/i,
  );
  expect(translate("cs")("processDesignHistoryLimit")).toMatch(
    /historie je příliš dlouhá/i,
  );
});

test("switching services clears private history when the next service read fails", async () => {
  const serviceA = "test_service";
  const serviceB = "service_b";
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "service-switch-user",
    workspaceId: target.workspaceId,
  };
  const capabilities = designUiCapabilities;
  const session = {
    identityKey: "service-switch-identity",
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(
      async (action: string, query: Record<string, string>) => {
        if (action === "capabilities")
          return { profile: DESIGN_PROFILE, capabilities };
        if (action === "review")
          throw new Error("unexpected review request without a saved session");
        if (action === "turns/list")
          return { profile: DESIGN_PROFILE, turns: [] };
        if (action === "sessions/list") {
          if (query.serviceId === serviceB)
            throw new Error("TEST second service unavailable");
          return {
            profile: DESIGN_PROFILE,
            ...target,
            serviceId: serviceA,
            sessions: [
              {
                id: "service_a_session",
                serviceId: serviceA,
                revision: 1,
                purpose: "TEST private service A history",
                acceptedProcessId: null,
                updatedAt: new Date(0).toISOString(),
              },
            ],
            nextAfter: null,
          };
        }
        if (action === "drafts/list")
          return {
            profile: DESIGN_PROFILE,
            ...target,
            serviceId: serviceA,
            drafts: [
              {
                id: "service_a_draft",
                serviceId: serviceA,
                revision: 1,
                name: "TEST private service A draft",
                kind: "workflow",
                latestVersion: 0,
                activeVersion: null,
                updatedAt: new Date(0).toISOString(),
              },
            ],
            nextAfter: null,
          };
        throw new Error(`unexpected action ${action}`);
      },
    ),
  } as unknown as ClientSession;
  function Harness() {
    const [serviceId, setServiceId] = React.useState(serviceA);
    return (
      <>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Select service B"
          onPress={() => setServiceId(serviceB)}
        >
          <Text>Select service B</Text>
        </Pressable>
        <ProcessDesign session={session} language="en" serviceId={serviceId} />
      </>
    );
  }

  render(<Harness />);
  expect(
    await screen.findByText("TEST private service A history · service_"),
  ).toBeTruthy();
  expect(screen.getByText("TEST private service A draft")).toBeTruthy();

  fireEvent.press(screen.getByRole("button", { name: "Select service B" }));
  expect(
    await screen.findByText(translate("en")("processDesignRequestFailed")),
  ).toBeTruthy();
  expect(
    screen.queryByText("TEST private service A history · service_"),
  ).toBeNull();
  expect(screen.queryByText("TEST private service A draft")).toBeNull();
});

test.each(["en", "cs"] as const)(
  "%s visibly explains when authenticated service history exceeds the limit",
  async (language) => {
    const tr = translate(language);
    const serviceId = "test_service";
    const scope = {
      connectionId: "connection",
      serverId: "server",
      userId: `history-limit-${language}`,
      workspaceId: target.workspaceId,
    };
    let historyPage = 0;
    const session = {
      identityKey: `history-limit-identity-${language}`,
      getSnapshot: () => ({ store: { scope } }),
      requestProcessDesign: jest.fn(
        async (action: string, query: Record<string, string>) => {
          if (action === "capabilities")
            return {
              profile: DESIGN_PROFILE,
              capabilities: designUiCapabilities,
            };
          if (action === "review")
            throw new Error(
              "unexpected review request without a saved session",
            );
          if (action === "turns/list")
            return { profile: DESIGN_PROFILE, turns: [] };
          if (action === "drafts/list")
            return {
              profile: DESIGN_PROFILE,
              ...target,
              serviceId,
              drafts: [],
              nextAfter: null,
            };
          if (action === "sessions/list") {
            expect(query.after).toBe(
              historyPage ? `session_${historyPage * 100 - 1}` : undefined,
            );
            const start = historyPage * 100;
            const count = Math.min(100, 1001 - start);
            const sessions = Array.from({ length: count }, (_, offset) => {
              const index = start + offset;
              return {
                id: `session_${index}`,
                serviceId,
                revision: 1,
                purpose: `TEST history ${index}`,
                acceptedProcessId: null,
                updatedAt: new Date(0).toISOString(),
              };
            });
            historyPage++;
            return {
              profile: DESIGN_PROFILE,
              ...target,
              serviceId,
              sessions,
              nextAfter: start + count < 1001 ? sessions.at(-1)!.id : null,
            };
          }
          throw new Error(`unexpected action ${action}`);
        },
      ),
    } as unknown as ClientSession;

    render(
      <ProcessDesign
        session={session}
        language={language}
        serviceId={serviceId}
      />,
    );

    expect(
      await screen.findByText(tr("processDesignHistoryLimit")),
    ).toBeTruthy();
    expect(historyPage).toBe(11);
  },
);

test.each(["en", "cs"] as const)(
  "%s keeps process design in review and requires explicit inactive-draft save",
  async (language) => {
    const tr = translate(language);
    let currentReview = workspaceReview();
    const calls: {
      action: string;
      query: Record<string, string>;
      payload?: unknown;
    }[] = [];
    const session = {
      identityKey: `mobile-test-identity-${language}`,
      getSnapshot: () => ({
        store: {
          scope: {
            connectionId: "connection",
            serverId: "server",
            userId: "user",
            workspaceId: "test_workspace",
          },
        },
      }),
      requestProcessDesign: jest.fn(
        async (
          action: string,
          query: Record<string, string>,
          payload?: unknown,
        ) => {
          calls.push({ action, query, payload });
          switch (action) {
            case "capabilities":
              return {
                profile: WORKSPACE_DESIGN_PROFILE,
                capabilities: designUiCapabilities,
              };
            case "review":
              return {
                profile: WORKSPACE_DESIGN_PROFILE,
                review: currentReview,
              };
            case "turns/list":
              return { profile: WORKSPACE_DESIGN_PROFILE, turns: [] };
            case "start":
              expect(AsyncStorage.setItem).toHaveBeenCalled();
              return {
                profile: WORKSPACE_DESIGN_PROFILE,
                receipt: {
                  profile: "agent-process-design/1",
                  ...target,
                  sessionId: "test_design",
                  requestId: "mobile-design-request",
                  revision: 1,
                  kind: "started",
                  processId: null,
                },
                review: currentReview,
              };
            case "acknowledge":
              currentReview = workspaceReview({
                revision: 2,
                blockers: [],
                assumptions: [
                  {
                    id: "read_only",
                    digest: "b".repeat(64),
                    acknowledged: true,
                  },
                ],
                reviewDigest: "d".repeat(64),
              });
              return {
                profile: WORKSPACE_DESIGN_PROFILE,
                receipt: {
                  profile: "agent-process-design/1",
                  ...target,
                  sessionId: "test_design",
                  requestId: (payload as { requestId: string }).requestId,
                  revision: 2,
                  kind: "acknowledged",
                  processId: null,
                },
                review: currentReview,
              };
            case "accept":
              expect((payload as { reviewDigest: string }).reviewDigest).toBe(
                currentReview.reviewDigest,
              );
              currentReview = workspaceReview({
                ...currentReview,
                acceptedProcessId: "inactive_draft",
              });
              return {
                profile: WORKSPACE_DESIGN_PROFILE,
                receipt: {
                  profile: "agent-process-design/1",
                  ...target,
                  sessionId: "test_design",
                  requestId: (payload as { requestId: string }).requestId,
                  revision: currentReview.revision,
                  kind: "accepted",
                  processId: "inactive_draft",
                },
                review: currentReview,
              };
            default:
              throw new Error(`unexpected action ${action}`);
          }
        },
      ),
    } as unknown as ClientSession;

    render(<ProcessDesign session={session} language={language} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: tr("processDesignStart") }),
      ).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("processDesignStart") }),
      );
      await flush();
    });
    expect(screen.getByText(tr("processDesignReview"))).toBeTruthy();
    expect(screen.getByText(tr("processDesignFullDefinition"))).toBeTruthy();
    expect(
      screen.getByText(
        /"description": "Find a contact and return its details"/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /activate|run|aktivovat|spustit/i }),
    ).toBeNull();

    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("processDesignAcknowledge") }),
      );
      await flush();
    });
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", {
          name: tr("processDesignReviewBeforeSave"),
        }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: tr("processDesignSaveInactive") }),
      ).toBeTruthy(),
    );
    expect(screen.getByText(tr("processDesignConfirmSave"))).toBeTruthy();
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("processDesignSaveInactive") }),
      );
      await flush();
    });
    await waitFor(() =>
      expect(screen.getByText(tr("processDesignSavedInactive"))).toBeTruthy(),
    );
    const prompt = screen.getByLabelText(tr("processDesignPrompt"));
    expect(prompt.props.editable).toBe(false);
    const send = screen.getByRole("button", {
      name: tr("processDesignSend"),
    });
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(send);
    await flush();
    expect(calls.map(({ action }) => action)).not.toContain("turn");
    expect(calls.map(({ action }) => action)).toContain("accept");
    expect(
      calls.some(({ action }) => action === "activate" || action === "run"),
    ).toBe(false);
  },
);

test("a truncated diff warns and prevents saving an incomplete review", async () => {
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "truncated-review-user",
    workspaceId: "test_workspace",
  };
  const session = {
    identityKey: "truncated-review-identity",
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(async (action: string) => {
      switch (action) {
        case "capabilities":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            capabilities: designUiCapabilities,
          };
        case "review":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            review: workspaceReview({
              capabilityFingerprint: designUiCapabilities.fingerprint,
              blockers: [],
              assumptions: [],
              changesTruncated: true,
            }),
          };
        case "turns/list":
          return { profile: WORKSPACE_DESIGN_PROFILE, turns: [] };
        default:
          throw new Error(`unexpected action ${action}`);
      }
    }),
  } as unknown as ClientSession;
  const key = mobileDesignRecoveryKey(session.identityKey, scope);
  await AsyncStorage.setItem(`${key}:session`, "test_design");

  render(<ProcessDesign session={session} language="en" />);
  expect(
    await screen.findByText(translate("en")("processDesignChangesTruncated")),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: translate("en")("processDesignReviewBeforeSave"),
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: translate("en")("processDesignSaveInactive"),
    }),
  ).toBeNull();
  expect(
    screen.getByText(/"description": "Find a contact and return its details"/),
  ).toBeTruthy();
});

test("keeps the exact turn outbox when an immediate response omits its admitted revision", async () => {
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "missing-request-revision-user",
    workspaceId: "test_workspace",
  };
  const identityKey = "missing-request-revision-identity";
  const key = mobileDesignRecoveryKey(identityKey, scope);
  const pending: MobileDesignPending = {
    version: 1,
    workspaceId: scope.workspaceId,
    sessionId: "test_design",
    command: {
      action: "turn",
      query: { sessionId: "test_design" },
      payload: {
        requestId: "missing-revision-request",
        sessionId: "test_design",
        revision: 1,
        modelId: "test_model",
        text: "Keep this exact request",
        language: "en",
      },
    },
  };
  await AsyncStorage.setItem(key, JSON.stringify(pending));
  await AsyncStorage.setItem(`${key}:session`, "test_design");
  const { requestRevision: _oldRevision, ...legacyTurn } = designUiTurn;
  let retryCount = 0;
  const session = {
    identityKey,
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(async (action: string) => {
      switch (action) {
        case "capabilities":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            capabilities: designUiCapabilities,
          };
        case "review":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            review: workspaceReview(),
          };
        case "turns/list":
          retryCount += 1;
          return retryCount <= 3
            ? { profile: WORKSPACE_DESIGN_PROFILE, turns: [] }
            : {
                profile: WORKSPACE_DESIGN_PROFILE,
                turns: [
                  {
                    ...legacyTurn,
                    sessionId: "test_design",
                    requestId: "missing-revision-request",
                    userText: "Keep this exact request",
                    language: "en",
                  },
                ],
              };
        case "turn":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            turn: {
              ...legacyTurn,
              sessionId: "test_design",
              requestId: "missing-revision-request",
              userText: "Keep this exact request",
              language: "en",
            },
          };
        default:
          throw new Error(`unexpected action ${action}`);
      }
    }),
  } as unknown as ClientSession;

  render(<ProcessDesign session={session} language="en" />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: translate("en")("processDesignRetry"),
      }),
    ).toBeTruthy(),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: translate("en")("processDesignRetry"),
      }),
    );
    await flush();
  });
  await waitFor(async () =>
    expect(await AsyncStorage.getItem(key)).toEqual(JSON.stringify(pending)),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: translate("en")("processDesignRetry"),
      }),
    );
    await flush();
  });
  await waitFor(async () => expect(await AsyncStorage.getItem(key)).toBeNull());
  expect(session.requestProcessDesign).toHaveBeenCalledWith(
    "turn",
    pending.command.query,
    pending.command.payload,
  );
  expect(
    screen.getByLabelText(translate("en")("processDesignPrompt")).props
      .editable,
  ).toBe(true);
});

test("pins the selected model for a design conversation with saved turns", async () => {
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "pinned-model-user",
    workspaceId: "test_workspace",
  };
  const capabilities = {
    ...designUiCapabilities,
    models: [
      ...designUiCapabilities.models,
      {
        ...designUiCapabilities.models[0]!,
        id: "test_other_model",
        name: "TEST other designer",
        model: "TEST-other-model",
      },
    ],
    totalItems: designUiCapabilities.totalItems + 1,
    fingerprint: "f".repeat(64),
  };
  const session = {
    identityKey: "pinned-model-identity",
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(async (action: string) => {
      switch (action) {
        case "capabilities":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            capabilities,
          };
        case "review":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            review: workspaceReview({
              capabilityFingerprint: capabilities.fingerprint,
            }),
          };
        case "turns/list":
          return { profile: WORKSPACE_DESIGN_PROFILE, turns: [designUiTurn] };
        default:
          throw new Error(`unexpected action ${action}`);
      }
    }),
  } as unknown as ClientSession;
  const label = `${translate("en")("processDesignModel")}: TEST designer`;
  const key = mobileDesignRecoveryKey("pinned-model-identity", scope);
  await AsyncStorage.setItem(`${key}:session`, "test_design");

  render(<ProcessDesign session={session} language="en" />);
  const selector = await screen.findByRole("button", { name: label });
  expect(selector.props.accessibilityState).toMatchObject({ disabled: true });
  expect(
    screen.getByText(translate("en")("processDesignModelPinned")),
  ).toBeTruthy();
  fireEvent.press(selector);
  expect(screen.queryByText(/TEST other designer/)).toBeNull();
});

test("does not relabel a pinned model when it disappears from current capabilities", async () => {
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "missing-pinned-model-user",
    workspaceId: "test_workspace",
  };
  const capabilities = {
    ...designUiCapabilities,
    models: [
      {
        ...designUiCapabilities.models[0]!,
        id: "test_other_model",
        name: "TEST other designer",
        model: "TEST-other-model",
      },
    ],
    fingerprint: "e".repeat(64),
  };
  const actions: string[] = [];
  const session = {
    identityKey: "missing-pinned-model-identity",
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(async (action: string) => {
      actions.push(action);
      switch (action) {
        case "capabilities":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            capabilities,
          };
        case "review":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            review: workspaceReview({
              capabilityFingerprint: capabilities.fingerprint,
            }),
          };
        case "turns/list":
          return { profile: WORKSPACE_DESIGN_PROFILE, turns: [designUiTurn] };
        default:
          throw new Error(`unexpected action ${action}`);
      }
    }),
  } as unknown as ClientSession;
  const key = mobileDesignRecoveryKey(session.identityKey, scope);
  await AsyncStorage.setItem(`${key}:session`, "test_design");

  render(<ProcessDesign session={session} language="en" />);
  const selector = await screen.findByRole("button", {
    name: `${translate("en")("processDesignModel")}: test_model`,
  });
  expect(selector.props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByText(/model is no longer available/)).toBeTruthy();
  expect(screen.queryByText(/TEST other designer/)).toBeNull();
  expect(
    screen.getByLabelText(translate("en")("processDesignPrompt")).props
      .editable,
  ).toBe(false);
  const sendButton = screen.getByRole("button", {
    name: translate("en")("processDesignSend"),
  });
  expect(sendButton.props.accessibilityState).toMatchObject({ disabled: true });
  fireEvent.press(sendButton);
  await flush();
  expect(actions).not.toContain("turn");
});

test.each([
  ["model revision", { revision: 2 }],
  ["provider identity", { providerId: "test_other_provider" }],
  ["provider revision", { providerRevision: 2 }],
] as const)(
  "blocks a pinned conversation when its %s changes under the same model ID",
  async (_label, identityPatch) => {
    const scope = {
      connectionId: "connection",
      serverId: "server",
      userId: `changed-${_label}-user`,
      workspaceId: "test_workspace",
    };
    const capabilities = {
      ...designUiCapabilities,
      models: [
        {
          ...designUiCapabilities.models[0]!,
          ...identityPatch,
        },
      ],
      fingerprint: "b".repeat(64),
    };
    const actions: string[] = [];
    const session = {
      identityKey: `changed-${_label}-identity`,
      getSnapshot: () => ({ store: { scope } }),
      requestProcessDesign: jest.fn(async (action: string) => {
        actions.push(action);
        switch (action) {
          case "capabilities":
            return { profile: WORKSPACE_DESIGN_PROFILE, capabilities };
          case "review":
            return {
              profile: WORKSPACE_DESIGN_PROFILE,
              review: workspaceReview({
                capabilityFingerprint: capabilities.fingerprint,
              }),
            };
          case "turns/list":
            return { profile: WORKSPACE_DESIGN_PROFILE, turns: [designUiTurn] };
          default:
            throw new Error(`unexpected action ${action}`);
        }
      }),
    } as unknown as ClientSession;
    const key = mobileDesignRecoveryKey(session.identityKey, scope);
    await AsyncStorage.setItem(`${key}:session`, "test_design");

    render(<ProcessDesign session={session} language="en" />);
    expect(
      await screen.findByRole("button", { name: /Model: test_model/ }),
    ).toBeTruthy();
    expect(screen.getByText(/model is no longer available/)).toBeTruthy();
    expect(
      screen.getByLabelText(translate("en")("processDesignPrompt")).props
        .editable,
    ).toBe(false);
    const sendButton = screen.getByRole("button", {
      name: translate("en")("processDesignSend"),
    });
    expect(sendButton.props.accessibilityState).toMatchObject({
      disabled: true,
    });
    fireEvent.press(sendButton);
    await flush();
    expect(actions).not.toContain("turn");
    expect(
      screen.getByTestId(`process-design-turn-${designUiTurn.turnId}`),
    ).toBeTruthy();
  },
);

test("shows the pinned model ID when no design models are currently available", async () => {
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "empty-models-user",
    workspaceId: "test_workspace",
  };
  const capabilities = {
    ...designUiCapabilities,
    models: [],
    totalItems:
      designUiCapabilities.services.length +
      designUiCapabilities.services.reduce(
        (total, service) => total + service.actions.length,
        0,
      ),
    fingerprint: "f".repeat(64),
  };
  const session = {
    identityKey: "empty-models-identity",
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(async (action: string) => {
      switch (action) {
        case "capabilities":
          return { profile: WORKSPACE_DESIGN_PROFILE, capabilities };
        case "review":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            review: workspaceReview({
              capabilityFingerprint: capabilities.fingerprint,
            }),
          };
        case "turns/list":
          return { profile: WORKSPACE_DESIGN_PROFILE, turns: [designUiTurn] };
        default:
          throw new Error(`unexpected action ${action}`);
      }
    }),
  } as unknown as ClientSession;
  const key = mobileDesignRecoveryKey(session.identityKey, scope);
  await AsyncStorage.setItem(`${key}:session`, "test_design");

  render(<ProcessDesign session={session} language="en" />);
  expect(await screen.findByText(/Model: test_model/)).toBeTruthy();
  expect(
    screen.getByText(translate("en")("processDesignNoModels")),
  ).toBeTruthy();
  expect(
    screen.getByTestId(`process-design-turn-${designUiTurn.turnId}`),
  ).toBeTruthy();
  expect(
    screen.getByLabelText(translate("en")("processDesignPrompt")).props
      .editable,
  ).toBe(false);
  expect(
    screen.getByRole("button", {
      name: translate("en")("processDesignSend"),
    }).props.accessibilityState,
  ).toMatchObject({ disabled: true });
});

test("keeps a running turn in recovery instead of replaying it", async () => {
  const language = "en" as const;
  const tr = translate(language);
  const scope = {
    connectionId: "connection",
    serverId: "server",
    userId: "user",
    workspaceId: "test_workspace",
  };
  const key = mobileDesignRecoveryKey("running-turn-identity", scope);
  const pending: MobileDesignPending = {
    version: 1,
    workspaceId: scope.workspaceId,
    sessionId: "test_design",
    command: {
      action: "turn",
      query: { sessionId: "test_design" },
      payload: {
        sessionId: "test_design",
        requestId: "running-request",
        revision: 1,
        modelId: "test_model",
        text: "Add a read-only contact lookup",
        language,
      },
    },
  };
  await AsyncStorage.setItem(key, JSON.stringify(pending));
  await AsyncStorage.setItem(`${key}:session`, "test_design");
  let turnStatus: typeof designUiTurn.status = "running";
  let turnSettled = false;
  let currentReview = workspaceReview();
  let turnListCalls = 0;
  let reviewReads = 0;
  const requests: string[] = [];
  const recordedTurn = () => ({
    ...designUiTurn,
    requestId: "running-request",
    requestRevision: 1,
    nativeSettled: turnSettled,
    userText: "Add a read-only contact lookup",
    status: turnStatus,
    reply: turnStatus === "completed" ? "Updated the proposal." : null,
    failure: null,
    toolReceipts: [],
  });
  const session = {
    identityKey: "running-turn-identity",
    getSnapshot: () => ({ store: { scope } }),
    requestProcessDesign: jest.fn(async (action: string) => {
      requests.push(action);
      switch (action) {
        case "capabilities":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            capabilities: designUiCapabilities,
          };
        case "review":
          reviewReads++;
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            review: currentReview,
          };
        case "turns/list": {
          turnListCalls++;
          // The server finishes between the retry's passive snapshot and its
          // explicit command lookup. The final read must then see revision 2.
          if (turnListCalls === 9) {
            currentReview = workspaceReview({
              revision: 2,
              reviewDigest: "e".repeat(64),
            });
          }
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            turns:
              turnListCalls === 2 || turnListCalls === 3
                ? []
                : [recordedTurn()],
          };
        }
        case "turn":
          return {
            profile: WORKSPACE_DESIGN_PROFILE,
            turn: recordedTurn(),
          };
        default:
          throw new Error(`unexpected action ${action}`);
      }
    }),
  } as unknown as ClientSession;

  render(<ProcessDesign session={session} language={language} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: tr("processDesignRetry") }),
    ).toBeTruthy(),
  );
  expect(
    screen.getAllByText(tr("processDesignTurnRunning")).length,
  ).toBeGreaterThan(0);

  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processDesignRetry") }),
    );
    await flush();
  });

  expect(await AsyncStorage.getItem(key)).toEqual(JSON.stringify(pending));
  expect(requests.filter((action) => action === "turn")).toHaveLength(1);
  expect(session.requestProcessDesign).toHaveBeenCalledWith(
    "turn",
    pending.command.query,
    pending.command.payload,
  );
  expect(
    screen.getAllByText(tr("processDesignTurnRunning")).length,
  ).toBeGreaterThan(0);

  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processDesignRetry") }),
    );
    await flush();
  });
  expect(await AsyncStorage.getItem(key)).toEqual(JSON.stringify(pending));
  expect(requests.filter((action) => action === "turn")).toHaveLength(1);
  expect(reviewReads).toBe(3);

  turnStatus = "interrupted";
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processDesignRetry") }),
    );
    await flush();
  });
  expect(await AsyncStorage.getItem(key)).toEqual(JSON.stringify(pending));
  expect(requests.filter((action) => action === "turn")).toHaveLength(1);
  expect(
    screen.getAllByText(tr("processDesignFailureNativeUnsettled")).length,
  ).toBeGreaterThan(0);

  turnStatus = "completed";
  turnSettled = true;
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processDesignRetry") }),
    );
    await flush();
  });
  expect(await AsyncStorage.getItem(key)).toBeNull();
  expect(screen.queryByText(tr("processDesignRetryHint"))).toBeNull();
  expect(reviewReads).toBe(6);
});
