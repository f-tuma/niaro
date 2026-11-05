import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import { budgetedReach } from "../packages/protocol/model-policy";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { IdentityError } from "../apps/server-identity/error";
import {
  IntegrationError,
  RequestNotSent,
  type IntegrationTransport,
} from "../apps/server-integrations/transport";
import { decideChoice } from "../apps/server-integrations/decisions";

const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const second = "22222222-2222-4222-8222-222222222222";
const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;

function harness(legacy?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT);
    INSERT INTO organization VALUES ('TEST-org');
    INSERT INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org'),('${second}','TEST-org');`);
  legacy?.(db);
  const store = new ServiceCatalogStore(db, "TEST-policy-secret", []);
  const command = (body: object, workspaceId = target.workspaceId) =>
    store.command(CatalogCommand.parse({ ...target, workspaceId, ...body }));
  const provider = (name: string, url = "https://models.example.test/v1") =>
    command({
      type: "saveProvider",
      revision: 0,
      settings: { name, url, enabled: true, dailyRequestLimit: 10 },
      apiKey: "TEST-provider-key",
    });
  const model = (
    providerId: string,
    id: string,
    settings: Record<string, unknown> = {},
  ) =>
    command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        model: id,
        name: "TEST " + id,
        enabled: true,
        tools: true,
        ...settings,
      },
    });
  const policies = (workspaceId = target.workspaceId) =>
    store.modelPolicies(target.organizationId, workspaceId);
  const saveOrganization = (policy: object) =>
    command({
      type: "saveOrganizationModelPolicy",
      revision: policies().organization.revision,
      policy,
    });
  const saveWorkspace = (policy: object, workspaceId = target.workspaceId) =>
    command(
      {
        type: "saveWorkspaceModelPolicy",
        revision: policies(workspaceId).workspace.revision,
        policy,
      },
      workspaceId,
    );
  return {
    db,
    store,
    command,
    provider,
    model,
    policies,
    saveOrganization,
    saveWorkspace,
  };
}

test("workspaces inherit the organization default and override single roles", () => {
  const h = harness();
  const p = h.provider("TEST provider");
  const a = h.model(p, "test/a");
  const b = h.model(p, "test/b");
  h.saveOrganization({ roles: { chat: { models: [a] } } });
  // A workspace that never saved anything works with the organization default.
  assert.equal(
    h.store.resolveModel(target.organizationId, second)?.model.id,
    a,
  );
  // Roles nobody set follow chat; the checker follows the selector.
  assert.equal(
    h.store.resolveBackground(target.organizationId, second)?.model.id,
    a,
  );
  assert.equal(
    h.store.resolveDesigner(target.organizationId, second)?.model.id,
    a,
  );
  assert.equal(
    h.store.route(target.organizationId, second, "background").source,
    "inherited",
  );
  assert.equal(
    h.store.resolveChecker(target.organizationId, second),
    undefined,
  );
  h.saveWorkspace({ roles: { background: { models: [b] } } });
  assert.equal(
    h.store.resolveModel(target.organizationId, target.workspaceId)?.model.id,
    a,
  );
  const background = h.store.resolveBackground(
    target.organizationId,
    target.workspaceId,
  )!;
  assert.equal(background.model.id, b);
  assert.deepEqual(background.route, {
    role: "background",
    index: 0,
    fallback: false,
    reason: "primary",
  });
  // The other workspace keeps the default; an empty list turns a role off.
  assert.equal(
    h.store.resolveBackground(target.organizationId, second)?.model.id,
    a,
  );
  h.saveWorkspace({ roles: { chat: { models: [] } } }, second);
  assert.equal(h.store.resolveModel(target.organizationId, second), undefined);
  // Stale revisions are refused like any catalog save.
  assert.throws(
    () =>
      h.command({
        type: "saveOrganizationModelPolicy",
        revision: 0,
        policy: {},
      }),
    code("catalog_conflict"),
  );
});

test("a role can point to a tier, and a tier edit moves every role on it", () => {
  const h = harness();
  const p = h.provider("TEST provider");
  const fast = h.model(p, "test/fast");
  const strong = h.model(p, "test/strong");
  const transcriber = h.model(p, "test/transcriber", {
    kind: "transcription",
    tools: false,
  });
  h.saveOrganization({
    tiers: [{ id: "strong", name: "Strong", models: [fast] }],
    roles: { chat: { tier: "strong" } },
  });
  assert.equal(
    h.store.resolveModel(target.organizationId, target.workspaceId)?.model.id,
    fast,
  );
  h.saveOrganization({
    tiers: [{ id: "strong", name: "Silný", models: [strong] }],
    roles: { chat: { tier: "strong" } },
  });
  assert.equal(
    h.store.route(target.organizationId, target.workspaceId, "chat").tier,
    "strong",
  );
  assert.equal(
    h.store.resolveModel(target.organizationId, target.workspaceId)?.model.id,
    strong,
  );
  // A workspace may point to the organization's tiers, which then stay.
  h.saveWorkspace({ roles: { designer: { tier: "strong" } } });
  assert.throws(
    () => h.saveOrganization({ roles: { chat: { models: [fast] } } }),
    code("catalog_tier_not_found"),
  );
  // A tier used by a role must fit it.
  assert.throws(
    () =>
      h.saveOrganization({
        tiers: [{ id: "strong", name: "Strong", models: [transcriber] }],
        roles: { chat: { tier: "strong" } },
      }),
    code("catalog_model_unavailable"),
  );
  assert.throws(
    () => h.saveWorkspace({ roles: { chat: { tier: "missing" } } }, second),
    code("catalog_tier_not_found"),
  );
});

test("member presets are off by default and reach only their tier while the workspace offers them", () => {
  const h = harness();
  const p = h.provider("TEST provider");
  const chat = h.model(p, "test/chat");
  const fast = h.model(p, "test/fast");
  const strong = h.model(p, "test/strong");
  const spare = h.model(p, "test/spare");
  const transcriber = h.model(p, "test/transcriber", {
    kind: "transcription",
    tools: false,
  });
  const org = target.organizationId,
    ws = target.workspaceId;
  const tiers = [
    { id: "fast", name: "Fast models", models: [fast] },
    { id: "strong", name: "Strong models", models: [strong, spare] },
  ];
  const presets = {
    enabled: true,
    items: [
      { id: "fast", name: "Fast", tier: "fast" },
      { id: "thorough", name: "Thorough", tier: "strong" },
    ],
  };
  // Defined but off: nothing is offered, and a picked preset reaches nothing.
  h.saveOrganization({
    tiers,
    roles: { chat: { models: [chat] } },
    options: { presets: { ...presets, enabled: false } },
  });
  assert.deepEqual(h.store.offeredPresets(org, ws), []);
  assert.equal(h.store.resolvePreset(org, ws, "fast"), undefined);
  assert.equal(h.store.route(org, ws, "preset:fast").models.length, 0);
  // Turned on for one workspace: only there, by the names the admin gave.
  h.saveWorkspace({ options: { presets } });
  assert.deepEqual(h.store.offeredPresets(org, ws), [
    { id: "fast", name: "Fast" },
    { id: "thorough", name: "Thorough" },
  ]);
  assert.deepEqual(h.store.offeredPresets(org, second), []);
  const picked = h.store.resolvePreset(org, ws, "thorough")!;
  assert.equal(picked.model.id, strong);
  assert.deepEqual(picked.route, {
    role: "preset:thorough",
    index: 0,
    fallback: false,
    reason: "primary",
    preset: { id: "thorough", name: "Thorough" },
  });
  // A preset the workspace does not offer never reaches a model.
  assert.equal(h.store.resolvePreset(org, ws, "missing"), undefined);
  assert.equal(h.store.resolvePreset(org, second, "thorough"), undefined);
  // Without fallback on chat, the second model of the tier is never reached.
  assert.equal(
    h.store.fallbackAfter(org, ws, picked, new RequestNotSent()),
    undefined,
  );
  // A preset points to an existing tier whose models fit chat.
  assert.throws(
    () =>
      h.saveWorkspace({
        options: {
          presets: {
            enabled: true,
            items: [{ id: "x", name: "X", tier: "missing" }],
          },
        },
      }),
    code("catalog_tier_not_found"),
  );
  assert.throws(
    () =>
      h.saveOrganization({
        tiers: [
          ...tiers,
          { id: "voice", name: "Voice", models: [transcriber] },
        ],
        roles: { chat: { models: [chat] } },
        options: {
          presets: {
            enabled: true,
            items: [{ id: "voice", name: "Voice", tier: "voice" }],
          },
        },
      }),
    code("catalog_model_unavailable"),
  );
  // The tier stays while a preset uses it.
  assert.throws(
    () =>
      h.saveOrganization({
        tiers: [tiers[0]],
        roles: { chat: { models: [chat] } },
      }),
    code("catalog_tier_not_found"),
  );
  // Enforce mode prices every model a member's preset can reach.
  const price = (modelId: string) => ({
    modelId,
    modelRevision: 1,
    providerRevision: 1,
    maxInputTokens: 4096,
    maxOutputTokens: 1000,
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
  });
  h.store.inferenceBudget.savePolicy(org, ws, 0, {
    mode: "enforce",
    maxTokens: 100_000,
    maxCostMicros: 1_000_000,
    prices: [price(chat)],
  });
  assert.deepEqual(
    h.store
      .unpricedRouteModels(org, ws)
      .map((entry) => [entry.modelId, entry.routes]),
    [
      [fast, ["preset:fast"]],
      [strong, ["preset:thorough"]],
    ],
  );
  // Offering a preset with nothing in it is refused by the protocol.
  assert.throws(() =>
    h.saveWorkspace({ options: { presets: { enabled: true, items: [] } } }),
  );
});

test("fallback moves on only from a model that cannot be used or was never sent", () => {
  const h = harness();
  const p = h.provider("TEST first");
  const q = h.provider("TEST second");
  const first = h.model(p, "test/first");
  const next = h.model(q, "test/next");
  const org = target.organizationId,
    ws = target.workspaceId;
  h.saveWorkspace({
    roles: { chat: { models: [first, next], fallback: true } },
  });
  h.saveOrganization({ roles: { chat: { models: [first, next] } } });
  // Off by default: the first model only, and its own failure stands.
  assert.equal(h.store.resolveModel(org, second)?.model.id, first);
  h.command({
    type: "saveModel",
    id: first,
    revision: 1,
    settings: {
      providerId: p,
      model: "test/first",
      name: "TEST first",
      enabled: false,
      tools: true,
    },
  });
  assert.throws(
    () => h.store.resolveModel(org, second),
    code("catalog_model_unavailable"),
  );
  // The workspace turned fallback on for chat.
  const moved = h.store.resolveModel(org, ws)!;
  assert.equal(moved.model.id, next);
  assert.equal(moved.route?.reason, "fallback: model_unavailable");
  h.command({
    type: "saveModel",
    id: first,
    revision: 2,
    settings: {
      providerId: p,
      model: "test/first",
      name: "TEST first",
      enabled: true,
      tools: true,
    },
  });
  const primary = h.store.resolveModel(org, ws)!;
  assert.equal(primary.route?.reason, "primary");
  // Never after an unknown outcome or a call that was sent.
  for (const error of [
    new IntegrationError("integration_timeout", 504),
    new IntegrationError("integration_unavailable", 502),
    new IntegrationError("integration_provider_failed", 502),
    new IdentityError(409, "catalog_conflict"),
    new IdentityError(429, "catalog_budget_exhausted"),
  ])
    assert.equal(h.store.fallbackAfter(org, ws, primary, error), undefined);
  // Refused by the daily limit before dispatch, or a connection that never sent a byte.
  const limited = h.store.fallbackAfter(
    org,
    ws,
    primary,
    new IdentityError(429, "catalog_provider_limit"),
  );
  assert.equal(limited?.model.id, next);
  assert.equal(limited?.route?.reason, "fallback: provider_limit");
  const unsent = h.store.fallbackAfter(org, ws, primary, new RequestNotSent());
  assert.equal(unsent?.route?.reason, "fallback: connection_failed");
  // The last model has nothing after it.
  assert.equal(
    h.store.fallbackAfter(org, ws, unsent!, new RequestNotSent()),
    undefined,
  );
  // A provider at its daily limit is skipped at selection with fallback on.
  for (let i = 0; i < 10; i++) h.store.useProvider(org, p, 1);
  assert.equal(
    h.store.resolveModel(org, ws)?.route?.reason,
    "fallback: provider_limit",
  );
  // With fallback off the same call is not moved.
  h.store.useProvider(org, q, 1);
  const fixed = h.store.resolveModel(org, second)!;
  assert.equal(
    h.store.fallbackAfter(org, ws, fixed, new RequestNotSent()),
    undefined,
  );
});

test("the checker is a role: a chat model on any provider checks without OpenRouter", async () => {
  const h = harness();
  const p = h.provider("TEST local", "https://llm.example.test/v1");
  const chat = h.model(p, "test/chat");
  const checker = h.model(p, "test/checker");
  // A decision model only works through OpenRouter's decisions API.
  const decision = h.model(p, "test/decision", {
    kind: "decision",
    tools: false,
  });
  assert.throws(
    () =>
      h.saveOrganization({
        roles: { chat: { models: [chat] }, checker: { models: [decision] } },
      }),
    code("catalog_model_unavailable"),
  );
  h.saveOrganization({
    roles: { chat: { models: [chat] }, checker: { models: [checker] } },
  });
  const selected = h.store.resolveChecker(
    target.organizationId,
    target.workspaceId,
  )!;
  assert.equal(selected.model.id, checker);
  assert.equal(
    h.store.resolveDecision(target.organizationId, target.workspaceId),
    undefined,
  );
  const bodies: Record<string, unknown>[] = [];
  const transport: IntegrationTransport = async (request) => {
    await request.beforeDispatch?.(() => {});
    bodies.push(request.body as Record<string, unknown>);
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "TEST-call",
                  type: "function",
                  function: {
                    name: "choose",
                    arguments: JSON.stringify({
                      choice: "mismatch",
                      confidence: 0.9,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };
  const answer = await decideChoice(
    transport,
    selected,
    { request: "TEST send it to Ann", action: "TEST send to Bob" },
    { matches: "It fits.", mismatch: "It does not fit." },
    new AbortController().signal,
    async (start) => start(),
    "Does the action fit the request?",
  );
  assert.equal(answer.choice, "mismatch");
  assert.equal(answer.confidence, 0.9);
  assert.equal(answer.probabilities.matches!.toFixed(2), "0.10");
  const body = bodies[0]!;
  assert.equal(body.model, "test/checker");
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "choose" },
  });
  // A choice outside the criteria is refused, never guessed.
  await assert.rejects(
    decideChoice(
      async (request) => {
        await request.beforeDispatch?.(() => {});
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "TEST-call",
                      type: "function",
                      function: {
                        name: "choose",
                        arguments: '{"choice":"approve","confidence":1}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      },
      selected,
      {},
      { matches: "It fits.", mismatch: "It does not fit." },
      new AbortController().signal,
      async (start) => start(),
    ),
    (error) =>
      error instanceof IntegrationError &&
      error.code === "integration_model_response_invalid",
  );
});

test("enforce mode lists every model a budgeted role can reach without a price", () => {
  const h = harness();
  const p = h.provider("TEST provider");
  const chat = h.model(p, "test/chat");
  const spare = h.model(p, "test/spare");
  const strong = h.model(p, "test/strong");
  h.saveOrganization({ roles: { chat: { models: [chat, spare] } } });
  const price = (modelId: string) => ({
    modelId,
    modelRevision: 1,
    providerRevision: 1,
    maxInputTokens: 4096,
    maxOutputTokens: 1000,
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
  });
  h.store.inferenceBudget.savePolicy(
    target.organizationId,
    target.workspaceId,
    0,
    {
      mode: "enforce",
      maxTokens: 100_000,
      maxCostMicros: 1_000_000,
      prices: [price(chat)],
    },
  );
  // The spare model is unreachable while fallback is off.
  assert.deepEqual(
    h.store.unpricedRouteModels(target.organizationId, target.workspaceId),
    [],
  );
  // The same reach the console computes from the policy view.
  const view = h.store.readModelPolicy(
    target.organizationId,
    target.workspaceId,
  );
  assert.deepEqual([...budgetedReach(view.effective).keys()], [chat]);
  assert.deepEqual(
    budgetedReach(view.effective).get(chat)?.includes("background"),
    true,
  );
  // Fallback and escalation make more models reachable.
  h.saveWorkspace({
    roles: { chat: { models: [chat, spare], fallback: true } },
    options: { escalation: { mode: "escalate", models: [strong] } },
  });
  assert.deepEqual(
    h.store
      .unpricedRouteModels(target.organizationId, target.workspaceId)
      .map((entry) => [entry.modelId, entry.routes.includes("escalation")]),
    [
      [spare, false],
      [strong, true],
    ],
  );
  // Observe mode refuses nothing for a missing price.
  h.store.inferenceBudget.savePolicy(
    target.organizationId,
    target.workspaceId,
    1,
    {
      mode: "observe",
      maxTokens: 100_000,
      maxCostMicros: 1_000_000,
      prices: [],
    },
  );
  assert.deepEqual(
    h.store.unpricedRouteModels(target.organizationId, target.workspaceId),
    [],
  );
});

test("the configuration bundle reads and writes the policy with the console's checks and audit", async () => {
  const h = harness();
  const p = h.provider("TEST provider");
  const chat = h.model(p, "test/chat");
  const background = h.model(p, "test/background");
  h.saveOrganization({
    roles: { chat: { models: [chat] }, background: { models: [background] } },
  });
  let queue: Promise<unknown> = Promise.resolve();
  const audits: unknown[] = [];
  const context: CatalogContext = {
    serial: (run) => {
      const task = queue.then(run);
      queue = task.catch(() => {});
      return task;
    },
    actor: async () => ({ userId: "TEST-user", role: "owner" }),
    epoch: () => 0,
    change: () => {},
    audit: (entry) => {
      audits.push(entry);
      return audits.length;
    },
    finish: () => {},
    transaction: async (run) => run(),
  };
  const controller = new CatalogController(h.store, async () => {
    throw Error("TEST no network");
  });
  // The typed read and write the configuration bundle uses, audited as routing.
  const view = await controller.readModelPolicy(target, context);
  assert.deepEqual(view.effective.roles.background?.models, [background]);
  await controller.writeModelPolicy(
    {
      ...target,
      type: "saveWorkspaceModelPolicy",
      revision: view.workspace.revision,
      policy: {
        roles: { background: { models: [chat], tier: null, fallback: false } },
        services: [],
        options: {},
      },
    },
    context,
  );
  assert.equal(
    h.store.resolveBackground(target.organizationId, target.workspaceId)?.model
      .id,
    chat,
  );
  assert.deepEqual(
    (audits.at(-1) as { action: string; details: unknown }).action,
    "catalog.routing_changed",
  );
  assert.deepEqual((audits.at(-1) as { details: unknown }).details, {
    policyScope: "workspace",
    previousRevision: 0,
    revision: 1,
  });
  // A stale revision and an unfit model are refused as on the console.
  await assert.rejects(
    controller.writeModelPolicy(
      {
        ...target,
        type: "saveWorkspaceModelPolicy",
        revision: 0,
        policy: { roles: {}, services: [], options: {} },
      },
      context,
    ),
    code("catalog_conflict"),
  );
  // Members cannot read it.
  await assert.rejects(
    controller.readModelPolicy(target, {
      ...context,
      actor: async () => ({ userId: "TEST-member", role: "member" }),
    }),
    code("identity_forbidden"),
  );
});

test("a model named by any role list, tier or escalation cannot be removed", () => {
  const h = harness();
  const p = h.provider("TEST provider");
  const chat = h.model(p, "test/chat");
  const tiered = h.model(p, "test/tiered");
  const escalated = h.model(p, "test/escalated");
  const serviced = h.model(p, "test/serviced");
  const free = h.model(p, "test/free");
  const service = h.command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST CRM",
      url: "https://crm.example.test/v1",
      protocol: "openapi",
      icon: "database",
      auth: { type: "none" },
      enabled: true,
    },
  });
  h.saveOrganization({
    tiers: [{ id: "spare", name: "Spare", models: [tiered] }],
    roles: { chat: { models: [chat] } },
    options: { escalation: { mode: "escalate", models: [escalated] } },
  });
  h.saveWorkspace(
    { services: [{ serviceId: service, route: { models: [serviced] } }] },
    target.workspaceId,
  );
  assert.equal(
    h.store.resolveModel(target.organizationId, target.workspaceId, service)
      ?.route?.role,
    `service:${service}`,
  );
  for (const id of [chat, tiered, escalated, serviced])
    assert.throws(
      () => h.command({ type: "removeModel", id, revision: 1 }),
      code("catalog_model_in_use"),
    );
  h.command({ type: "removeModel", id: free, revision: 1 });
  // Removing the service drops only its own models.
  h.command({
    type: "removeService",
    id: service,
    revision: h.store.service(target.workspaceId, service).revision,
  });
  assert.deepEqual(h.policies().workspace.policy.services, []);
  h.command({ type: "removeModel", id: serviced, revision: 1 });
});

test("stored routing of the old shape becomes the organization default and workspace overrides", () => {
  let ids: Record<string, string> = {};
  const h = harness((db) => {
    // The catalog tables exist before the first store opens an old database.
    new ServiceCatalogStore(db, "TEST-policy-secret", []);
    const put = (id: string, kind: string, data: object) =>
      db
        .prepare("INSERT INTO agent_catalog VALUES (?,?,?,1,?,NULL)")
        .run(id, "TEST-org", kind, JSON.stringify(data));
    put("TEST-provider", "provider", {
      name: "TEST provider",
      url: "https://openrouter.ai/api/v1",
      enabled: true,
      dailyRequestLimit: 10,
    });
    const model = (id: string, data: object) =>
      put(id, "model", {
        providerId: "TEST-provider",
        name: id,
        enabled: true,
        tools: true,
        audioInput: false,
        audioOutput: false,
        kind: "chat",
        ...data,
      });
    model("TEST-chat", { model: "test/chat" });
    model("TEST-other", { model: "test/other" });
    model("TEST-decision", {
      model: "test/decision",
      kind: "decision",
      tools: false,
    });
    model("TEST-search", { model: "test/search" });
    ids = {
      chat: "TEST-chat",
      other: "TEST-other",
      decision: "TEST-decision",
      search: "TEST-search",
    };
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_workspace_plugins (workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings TEXT) STRICT",
    );
    db.prepare("INSERT INTO agent_workspace_plugins VALUES (?,1,?)").run(
      second,
      JSON.stringify({
        enabled: ["web"],
        settings: { web: { searchModel: "test/search" } },
      }),
    );
    const legacy = (workspaceId: string, data: object) =>
      db
        .prepare("INSERT INTO agent_catalog_routing VALUES (?,4,?)")
        .run(workspaceId, JSON.stringify(data));
    legacy(target.workspaceId, {
      modelId: "TEST-chat",
      voiceMode: "disabled",
      voiceMethod: "interpreter",
      voiceModelId: null,
      meetingTranscriptionModelId: null,
      decision: {
        enabled: true,
        modelId: "TEST-decision",
        minConfidence: 0.9,
      },
      planner: "jev",
      speech: {
        modelId: null,
        method: "reader",
        voice: "alloy",
        zeroDataRetention: true,
      },
      services: [],
    });
    legacy(second, {
      modelId: "TEST-other",
      planner: "model",
      services: [],
    });
  });
  const org = h.policies().organization;
  assert.equal(org.revision, 1);
  assert.deepEqual(org.policy.roles.chat?.models, [ids.chat]);
  assert.deepEqual(org.policy.roles.selector?.models, [ids.decision]);
  assert.equal(org.policy.options.selector.minConfidence, 0.9);
  assert.equal(org.policy.options.serverVoice, false);
  // The first workspace equals the default: it keeps no overrides.
  assert.deepEqual(h.policies().workspace.policy.roles, {});
  assert.equal(h.policies().workspace.revision, 5);
  // The second keeps what differs, and its web search model became a role.
  const other = h.policies(second).workspace.policy;
  assert.deepEqual(other.roles.chat?.models, [ids.other]);
  assert.deepEqual(other.roles.selector?.models, []);
  assert.deepEqual(other.roles.web_search?.models, [ids.search]);
  assert.equal(other.options.serverVoice, true);
  assert.equal(other.options.selector?.minConfidence, 0.8);
  assert.equal(
    h.store.resolveWebSearch(target.organizationId, second).model.id,
    ids.search,
  );
  // The checker follows the selector, as the decision model checked before.
  assert.equal(
    h.store.resolveChecker(target.organizationId, target.workspaceId)?.model.id,
    ids.decision,
  );
  assert.equal(
    h.store.resolveDecision(target.organizationId, second),
    undefined,
  );
  // Opening the store again migrates nothing twice.
  new ServiceCatalogStore(h.db, "TEST-policy-secret", []);
  assert.equal(h.policies().workspace.revision, 5);
  assert.equal(h.policies().organization.revision, 1);
});

test("reserved roles and the speech voice follow catalog metadata", () => {
  const h = harness();
  const p = h.provider("TEST OpenRouter", "https://openrouter.ai/api/v1");
  const chat = h.model(p, "test/chat");
  const reader = h.model(p, "test/reader", { audioOutput: true });
  h.saveOrganization({
    roles: {
      chat: { models: [chat] },
      embedding: { models: [chat] },
      vision: { models: [] },
    },
  });
  // A spoken-reply model needs a voice: from the policy or the model's list.
  assert.throws(
    () => h.saveWorkspace({ roles: { speech: { models: [reader] } } }),
    code("catalog_voice_required"),
  );
  h.command({
    type: "saveModel",
    id: reader,
    revision: 1,
    settings: {
      providerId: p,
      model: "test/reader",
      name: "TEST reader",
      enabled: true,
      tools: true,
      audioOutput: true,
      voices: [
        { voice: "test-low", label: "Low" },
        { voice: "test-high", label: "High" },
      ],
    },
  });
  h.saveWorkspace({ roles: { speech: { models: [reader] } } });
  const speech = h.store.resolveSpeech(
    target.organizationId,
    target.workspaceId,
  )!;
  assert.equal(speech.method, "reader");
  assert.equal(speech.voice, "test-low");
  const route = h.store.speechVoiceRoute(
    target.organizationId,
    target.workspaceId,
  )!;
  assert.deepEqual(
    route.model.voices.map((v) => v.voice),
    ["test-low", "test-high"],
  );
  // A text model keeps no voices.
  h.command({
    type: "saveModel",
    id: chat,
    revision: 1,
    settings: {
      providerId: p,
      model: "test/chat",
      name: "TEST chat",
      enabled: true,
      tools: true,
      voices: [{ voice: "test-low", label: "Low" }],
    },
  });
  assert.equal(
    h.store.readModelPolicy(target.organizationId, target.workspaceId).effective
      .roles.embedding?.models.length,
    1,
  );
  const catalog = h.store.inventory(target.organizationId, target.workspaceId, {
    userId: "TEST-user",
    role: "owner",
  });
  assert.deepEqual(catalog.models.find((m) => m.id === chat)?.voices ?? [], []);
});
