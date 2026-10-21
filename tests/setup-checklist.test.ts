import { setupChecklist } from "../apps/server-admin/web/lib/setup-checklist";
import type { InferenceBudgetSettings } from "../packages/protocol/inference-budget";

type Input = Parameters<typeof setupChecklist>[0];
type Catalog = Input["catalog"];

const provider = {
  id: "TEST-provider",
  revision: 3,
  name: "TEST provider",
  url: "https://provider.example.test",
  enabled: true,
  dailyRequestLimit: 100,
  hasCredential: true,
  requestsToday: 0,
};
const model = {
  id: "TEST-model",
  revision: 2,
  providerId: provider.id,
  name: "TEST chat",
  model: "test/chat",
  enabled: true,
  tools: true,
  audioInput: false,
  audioOutput: false,
  kind: "chat" as const,
};
const action = {
  id: "TEST-action",
  revision: 1,
  enabled: true,
  policy: { roles: ["member"], users: [] },
};
const service = { id: "TEST-service", enabled: true, actions: [action] };
const price = {
  modelId: model.id,
  modelRevision: model.revision,
  providerRevision: provider.revision,
  maxInputTokens: 4096,
  maxOutputTokens: 1000,
  inputMicrosPerMillion: 1,
  outputMicrosPerMillion: 1,
};
const budget: InferenceBudgetSettings = {
  mode: "enforce",
  maxTokens: 100_000,
  maxCostMicros: 1_000_000,
  prices: [price],
};
const catalog = (patch: Partial<Catalog> = {}) =>
  ({
    organizationId: "TEST-org",
    workspaceId: "TEST-workspace",
    canManage: true,
    providers: [provider],
    models: [model],
    services: [service],
    routing: { modelId: model.id },
    ...patch,
  }) as unknown as Catalog;
const open = (input: Partial<Input> = {}) =>
  setupChecklist({
    catalog: catalog(),
    budget,
    members: 2,
    invitations: 0,
    ...input,
  })
    .filter((step) => !step.done)
    .map((step) => step.key);

describe("admin first-run checklist", () => {
  test("a fully set up workspace has nothing left, in the agreed order", () => {
    const steps = setupChecklist({
      catalog: catalog(),
      budget,
      members: 2,
      invitations: 0,
    });
    expect(steps.map((s) => s.key)).toEqual([
      "provider",
      "model",
      "routing",
      "budget",
      "service",
      "people",
    ]);
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.map((s) => s.to)).toEqual([
      "/providers",
      "/providers",
      "/routing",
      "/usage",
      "/services",
      "/people",
    ]);
  });

  test("an empty workspace has every step open", () => {
    expect(
      open({
        catalog: catalog({
          providers: [],
          models: [],
          services: [],
          routing: { modelId: null } as Catalog["routing"],
        }),
        budget: null,
        members: 1,
      }),
    ).toEqual(["provider", "model", "routing", "budget", "service", "people"]);
  });

  test("a provider without a key or turned off does not count", () => {
    for (const p of [
      { ...provider, hasCredential: false },
      { ...provider, enabled: false },
    ])
      expect(open({ catalog: catalog({ providers: [p] }) })).toEqual([
        "provider",
        "model",
        "routing",
        "budget",
      ]);
  });

  test("the chat model must be routed and enabled", () => {
    expect(
      open({
        catalog: catalog({
          routing: { modelId: null } as Catalog["routing"],
        }),
      }),
    ).toEqual(["routing", "budget"]);
    expect(
      open({ catalog: catalog({ models: [{ ...model, enabled: false }] }) }),
    ).toEqual(["model", "routing", "budget"]);
  });

  test("limits must enforce with a current price for the chat model", () => {
    expect(open({ budget: { ...budget, mode: "observe" } })).toEqual([
      "budget",
    ]);
    expect(open({ budget: { ...budget, prices: [] } })).toEqual(["budget"]);
    // A price pinned to an older model or provider revision is stale.
    expect(
      open({
        budget: { ...budget, prices: [{ ...price, modelRevision: 1 }] },
      }),
    ).toEqual(["budget"]);
    expect(
      open({
        budget: { ...budget, prices: [{ ...price, providerRevision: 1 }] },
      }),
    ).toEqual(["budget"]);
    expect(open({ budget: null })).toEqual(["budget"]);
  });

  test("a service needs an enabled action that someone may use", () => {
    const services = [
      { ...service, enabled: false },
      { ...service, actions: [{ ...action, enabled: false }] },
      {
        ...service,
        actions: [{ ...action, policy: { roles: [], users: [] } }],
      },
    ];
    for (const s of services)
      expect(
        open({
          catalog: catalog({ services: [s] as unknown as Catalog["services"] }),
        }),
      ).toEqual(["service"]);
    expect(
      open({
        catalog: catalog({
          services: [
            {
              ...service,
              actions: [
                {
                  ...action,
                  policy: {
                    roles: [],
                    users: [{ userId: "TEST-user", access: "allow" }],
                  },
                },
              ],
            },
          ] as unknown as Catalog["services"],
        }),
      }),
    ).toEqual([]);
  });

  test("people: another member or a pending invitation", () => {
    expect(open({ members: 1 })).toEqual(["people"]);
    expect(open({ members: 1, invitations: 1 })).toEqual([]);
  });
});
