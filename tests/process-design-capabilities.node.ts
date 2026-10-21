import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import type { ProcessActor } from "../apps/server-identity/service-processes";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { WorkspacePluginStore } from "../apps/server-identity/workspace-plugins";
import {
  designCapabilities,
  designCapabilityIndex,
  type DesignCapabilities,
} from "../apps/server-identity/process-design-capabilities";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import { schemaValidator } from "../apps/server-integrations/schema";
import { IdentityError } from "../apps/server-identity/error";

const target = {
  organizationId: "TEST-design-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const actor: ProcessActor = {
  ...target,
  userId: "TEST-design-owner",
  role: "owner",
};
const admin: ProcessActor = {
  ...target,
  userId: "TEST-design-admin",
  role: "admin",
};
const elsewhere = {
  organizationId: "TEST-design-other",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const SENTINEL = "TEST-configured-credential-do-not-project";
const inputSchema = () => ({
  type: "object",
  properties: { name: { type: "string", minLength: 1, maxLength: 20 } },
  required: ["name"],
  additionalProperties: false,
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT,role TEXT);
    INSERT INTO organization VALUES ('${target.organizationId}'),('${elsewhere.organizationId}');
    INSERT INTO agent_workspace VALUES ('${target.workspaceId}','${target.organizationId}','TEST design'),('${elsewhere.workspaceId}','${elsewhere.organizationId}','TEST other');
    INSERT INTO member VALUES ('TEST-design-owner-member','${target.organizationId}','${actor.userId}','owner'),('TEST-design-admin-member','${target.organizationId}','${admin.userId}','admin');`);
  const catalog = new ServiceCatalogStore(
    db,
    "TEST-only-encryption-secret",
    [],
  );
  const plugins = new WorkspacePluginStore(db, {
    enabled: ["memory"],
    timeZone: "UTC",
  });
  const command = (body: object, scope = target) =>
    catalog.command(CatalogCommand.parse({ ...scope, ...body }));
  const serviceId = command({
    type: "saveService",
    revision: 0,
    apiKey: SENTINEL,
    settings: {
      name: "TEST design service",
      description: "TEST local catalog description",
      url: "https://services.example.test/TEST-private-endpoint",
      protocol: "openapi",
      icon: "database",
      auth: { type: "header", header: "x-private-credential-header" },
      enabled: true,
    },
  });
  const addAction = (settings: object = {}, id?: string) => {
    const current = catalog.service(target.workspaceId, serviceId);
    return command({
      type: "saveAction",
      serviceId,
      serviceRevision: current.revision,
      revision: id
        ? current.actions.find((action) => action.id === id)!.revision
        : 0,
      ...(id ? { id } : {}),
      settings: {
        name: "TEST lookup",
        description: "TEST finds one configured record",
        inputSchema: inputSchema(),
        binding: {
          type: "http",
          method: "GET",
          path: "/TEST-private-binding",
          parameters: [],
          body: false,
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["owner", "admin", "member"], users: [] },
        ...settings,
      },
    });
  };
  const actionId = addAction();
  const providerId = command({
    type: "saveProvider",
    revision: 0,
    apiKey: SENTINEL,
    settings: {
      name: "TEST provider",
      url: "https://models.example.test/TEST-private-provider",
      enabled: true,
      dailyRequestLimit: 10,
    },
  });
  const modelId = command({
    type: "saveModel",
    revision: 0,
    settings: {
      providerId,
      name: "TEST tool model",
      model: "TEST-exact-model-identifier",
      tools: true,
      kind: "chat",
      enabled: true,
    },
  });
  // Tests emulate old/imported catalog records only inside this synthetic memory DB.
  const legacySchema = (id: string, schema: object) => {
    const row = db
      .prepare("SELECT data FROM agent_catalog WHERE id=? AND kind='action'")
      .get(id)!;
    const data = JSON.parse(String(row.data));
    db.prepare(
      "UPDATE agent_catalog SET data=?,revision=revision+1 WHERE id=? AND kind='action'",
    ).run(JSON.stringify({ ...data, inputSchema: schema }), id);
  };
  const capabilities = (options?: Parameters<typeof designCapabilities>[3]) =>
    designCapabilities(catalog, plugins, actor, { pageSize: 50, ...options });
  return {
    db,
    catalog,
    plugins,
    command,
    serviceId,
    actionId,
    providerId,
    modelId,
    addAction,
    legacySchema,
    capabilities,
  };
}
const actionFrom = (value: DesignCapabilities, id: string) =>
  value.services
    .flatMap((service) => service.actions)
    .find((action) => action.id === id)!;
const errorCode = (code: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === code;

test("designer capabilities allowlist local metadata, redact annotations and never dispatch", () => {
  const h = fixture();
  try {
    h.legacySchema(h.actionId, {
      ...inputSchema(),
      title: SENTINEL,
      description: SENTINEL,
      default: { name: SENTINEL },
      examples: [{ name: SENTINEL }],
      $comment: SENTINEL,
      properties: {
        name: {
          ...inputSchema().properties.name,
          title: SENTINEL,
          default: SENTINEL,
          examples: [SENTINEL],
          $comment: SENTINEL,
        },
      },
    });
    // Business authorization retrieves tokens; the passive projector must not call it.
    h.catalog.authorize = () => {
      throw Error("TEST business authorization forbidden");
    };
    h.catalog.credential = () => {
      throw Error("TEST service credential retrieval forbidden");
    };
    const result = h.capabilities();
    const encoded = JSON.stringify(result);
    for (const excluded of [
      SENTINEL,
      "TEST-private-endpoint",
      "TEST-private-provider",
      "TEST-private-binding",
      "x-private-credential-header",
      "hasCredential",
      "binding",
      "sourceKey",
      "dispatchReady",
      "apiKey",
    ])
      assert(!encoded.includes(excluded), excluded);
    assert.deepEqual(actionFrom(result, h.actionId).inputSchema, inputSchema());
    assert.equal(actionFrom(result, h.actionId).schemaUnavailable, null);
    assert.equal(actionFrom(result, h.actionId).status, "configured");
    assert.deepEqual(result.models, [
      {
        id: h.modelId,
        revision: 1,
        name: "TEST tool model",
        model: "TEST-exact-model-identifier",
        providerId: h.providerId,
        providerRevision: 1,
        tools: true,
        status: "configured",
      },
    ]);
    assert.deepEqual(result.memoryModes, ["none", "conversation", "saved"]);
    assert.deepEqual(result.limits, DEFAULT_PROCESS_LIMITS);
    assert.deepEqual(result.grammar, {
      schemaVersion: 1,
      trigger: "manual",
      kinds: ["agent", "workflow"],
    });
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS count FROM agent_service_invocation")
        .get()!.count,
      0,
    );
  } finally {
    h.db.close();
  }
});

test("designer capabilities apply action and service policy to owners and administrators", () => {
  const h = fixture();
  try {
    const adminOnly = h.addAction({ policy: { roles: ["admin"], users: [] } });
    const ownerDenied = h.addAction({
      policy: {
        roles: ["owner", "admin"],
        users: [{ userId: actor.userId, access: "deny" }],
      },
    });
    const explicitOwner = h.addAction({
      policy: { roles: [], users: [{ userId: actor.userId, access: "allow" }] },
    });
    const ownerIds = h
      .capabilities()
      .services.flatMap((service) =>
        service.actions.map((action) => action.id),
      );
    assert(ownerIds.includes(h.actionId));
    assert(ownerIds.includes(explicitOwner));
    assert(!ownerIds.includes(adminOnly));
    assert(!ownerIds.includes(ownerDenied));
    const adminIds = designCapabilities(
      h.catalog,
      h.plugins,
      admin,
    ).services.flatMap((service) => service.actions.map((action) => action.id));
    assert(adminIds.includes(adminOnly));
    assert(adminIds.includes(ownerDenied));
    assert(!adminIds.includes(explicitOwner));
    const service = h.catalog.service(target.workspaceId, h.serviceId);
    const {
      id: _id,
      revision: _revision,
      actions: _actions,
      hasCredential: _credential,
      modelId: _model,
      ...settings
    } = service;
    h.command({
      type: "saveService",
      id: h.serviceId,
      revision: service.revision,
      settings: {
        ...settings,
        access: { roles: ["admin"], workspaceRoles: [] },
      },
    });
    assert.deepEqual(
      h.capabilities().services.flatMap((item) => item.actions),
      [],
    );
    assert(
      designCapabilities(h.catalog, h.plugins, admin).services.flatMap(
        (item) => item.actions,
      ).length > 0,
    );
  } finally {
    h.db.close();
  }
});

test("designer capabilities give members only their own usable actions and reject mismatched workspace organization and isolate scopes", () => {
  const h = fixture();
  try {
    // Personal processes: a member designs with exactly the actions they may
    // use themselves (the same per-actor check the chat runtime uses), plus
    // tool models, which are not role-gated.
    const ownersOnly = h.addAction({
      name: "TEST owners only",
      policy: { roles: ["owner", "admin"], users: [] },
    });
    const disabled = h.addAction({ name: "TEST disabled", enabled: false });
    const member = designCapabilities(h.catalog, h.plugins, {
      ...actor,
      userId: "TEST-design-member",
      role: "member",
    });
    const memberActions = member.services.flatMap((item) =>
      item.actions.map((action) => action.id),
    );
    assert.deepEqual(memberActions, [h.actionId]);
    assert(!memberActions.includes(ownersOnly));
    assert(!memberActions.includes(disabled));
    assert.deepEqual(
      member.models.map((model) => model.id),
      [h.modelId],
    );
    assert(!JSON.stringify(member).includes(SENTINEL));
    assert(
      h
        .capabilities()
        .services.flatMap((item) => item.actions)
        .some((action) => action.id === ownersOnly),
    );
    assert.throws(
      () =>
        designCapabilities(h.catalog, h.plugins, {
          ...actor,
          organizationId: elsewhere.organizationId,
        }),
      errorCode("process_not_found"),
    );
    assert.throws(
      () =>
        designCapabilities(h.catalog, h.plugins, {
          ...actor,
          workspaceId: "TEST-missing-workspace",
        }),
      errorCode("identity_not_found"),
    );
    const otherService = h.command(
      {
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST other service",
          url: "https://other.example.test/v1",
          protocol: "mcp",
          icon: "plug",
          auth: { type: "none" },
          enabled: true,
        },
      },
      elsewhere,
    );
    const result = designCapabilities(h.catalog, h.plugins, {
      ...actor,
      ...elsewhere,
    });
    assert.deepEqual(
      result.services.map((service) => service.id),
      [otherService],
    );
    assert.deepEqual(result.models, []);
    assert(!JSON.stringify(result).includes(h.serviceId));
  } finally {
    h.db.close();
  }
});

test("designer capabilities expose disabled configuration and omit unusable tool models", () => {
  const h = fixture();
  try {
    const disabled = h.addAction({ enabled: false });
    h.command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId: h.providerId,
        name: "TEST no tools",
        model: "TEST-no-tools",
        tools: false,
        kind: "chat",
        enabled: true,
      },
    });
    assert.equal(actionFrom(h.capabilities(), disabled).status, "disabled");
    assert.equal(h.capabilities().models.length, 1);
    const initial = h.capabilities().fingerprint;
    const provider = h.catalog.provider(
      target.organizationId,
      h.providerId,
    ).provider;
    h.command({
      type: "saveProvider",
      id: h.providerId,
      revision: provider.revision,
      settings: {
        name: provider.name,
        url: provider.url,
        enabled: false,
        dailyRequestLimit: provider.dailyRequestLimit,
      },
    });
    const unavailable = h.capabilities();
    assert.deepEqual(unavailable.models, []);
    assert.notEqual(unavailable.fingerprint, initial);
    h.plugins.update(target.workspaceId, 0, { enabled: [], timeZone: "UTC" });
    assert.deepEqual(h.capabilities().memoryModes, ["none", "conversation"]);
    const service = h.catalog.service(target.workspaceId, h.serviceId);
    h.command({
      type: "saveService",
      id: h.serviceId,
      revision: service.revision,
      settings: {
        name: service.name,
        url: service.url,
        protocol: service.protocol,
        icon: service.icon,
        auth: service.auth,
        enabled: false,
      },
    });
    assert(
      h
        .capabilities()
        .services.flatMap((item) => item.actions)
        .every((item) => item.status === "disabled"),
    );
  } finally {
    h.db.close();
  }
});

test("designer schemas retain supported constraints and refs without relaxing validation", () => {
  const h = fixture();
  try {
    const schema = {
      type: "object",
      $defs: { amount: { type: "number", exclusiveMinimum: 0, maximum: 10 } },
      properties: {
        name: {
          type: "string",
          pattern: "^[A-Z]+$",
          minLength: 2,
          maxLength: 4,
          enum: ["AB", "CD"],
        },
        amount: { $ref: "#/$defs/amount" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "integer", minimum: 1, maximum: 3 },
        },
        flag: { oneOf: [{ const: true }, { const: false }] },
      },
      required: ["name", "amount", "items", "flag"],
      additionalProperties: false,
      propertyNames: { pattern: "^[a-z]+$" },
    };
    h.addAction({ inputSchema: schema }, h.actionId);
    const action = actionFrom(h.capabilities(), h.actionId);
    assert.equal(action.schemaUnavailable, null);
    assert.deepEqual(action.inputSchema, schema);
    const source = schemaValidator(schema),
      projected = schemaValidator(action.inputSchema!);
    const values = [
      { name: "AB", amount: 1, items: [1], flag: true },
      { name: "CD", amount: 10, items: [1, 3], flag: false },
      { name: "ab", amount: 1, items: [1], flag: true },
      { name: "AB", amount: 0, items: [1], flag: true },
      { name: "AB", amount: 11, items: [1], flag: true },
      { name: "AB", amount: 1, items: [4], flag: true },
      { name: "AB", amount: 1, items: [1], flag: true, extra: "TEST" },
    ];
    for (const value of values) assert.equal(projected(value), source(value));
    assert(source(values[0]));
    assert(source(values[1]));
    assert(values.slice(2).every((value) => !source(value)));
  } finally {
    h.db.close();
  }
});

test("designer schema uncertainty is explicit and does not publish partial constraints or sensitive fields", () => {
  const h = fixture();
  try {
    for (const [schema, reason] of [
      [
        {
          ...inputSchema(),
          not: { properties: { name: { const: SENTINEL } } },
        },
        "schema_unsupported",
      ],
      [
        {
          ...inputSchema(),
          properties: { password: { type: "string", const: SENTINEL } },
          required: ["password"],
        },
        "sensitive_fields",
      ],
      [
        {
          type: "object",
          properties: {},
          required: ["password"],
          additionalProperties: true,
        },
        "sensitive_fields",
      ],
      [
        {
          ...inputSchema(),
          properties: { name: { $ref: "https://remote.example.test/schema" } },
        },
        "schema_unsupported",
      ],
      [{ ...inputSchema(), default: SENTINEL.repeat(1000) }, "schema_limit"],
      [
        {
          ...inputSchema(),
          properties: { name: { $ref: "#/default/name" } },
          default: { name: { type: "string" } },
        },
        "schema_unsupported",
      ],
    ] as const) {
      h.legacySchema(h.actionId, schema);
      const action = actionFrom(h.capabilities(), h.actionId);
      assert.equal(action.inputSchema, null);
      assert.equal(action.schemaUnavailable, reason);
      assert(!JSON.stringify(action).includes(SENTINEL));
      assert(!JSON.stringify(action).includes("remote.example.test"));
    }
  } finally {
    h.db.close();
  }
});

test("designer pages share a deterministic fingerprint and reject stale cursors on dependency change", () => {
  const h = fixture();
  try {
    for (let index = 0; index < 52; index++)
      h.addAction({ name: "TEST lookup " + index });
    const first = h.capabilities();
    assert(first.nextAfter);
    assert.equal(first.totalItems, 55);
    assert.equal(
      first.services.flatMap((service) => service.actions).length,
      50,
    );
    assert.deepEqual(h.capabilities(), first);
    const second = h.capabilities({ after: first.nextAfter });
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.nextAfter, null);
    const ids = [...first.services, ...second.services].flatMap((service) =>
      service.actions.map((action) => action.id),
    );
    assert.equal(ids.length, 53);
    assert.equal(new Set(ids).size, 53);
    assert.equal([...first.models, ...second.models].length, 1);
    const inventory = h.catalog.inventory.bind(h.catalog);
    let inventoryReads = 0;
    h.catalog.inventory = (...args) => {
      inventoryReads++;
      return inventory(...args);
    };
    const index = designCapabilityIndex(h.catalog, h.plugins, actor);
    assert.equal(inventoryReads, 1);
    assert.equal(index.fingerprint, first.fingerprint);
    assert.equal(index.actions.size, 53);
    assert.deepEqual([...index.models], [h.modelId]);
    for (const service of [...first.services, ...second.services])
      for (const action of service.actions)
        assert.deepEqual(
          index.actions.get(service.id + ":" + action.id),
          action,
        );
    assert.throws(
      () => h.capabilities({ after: "TEST-invalid-cursor" }),
      errorCode("process_design_cursor_invalid"),
    );
    const oldFingerprint = first.fingerprint;
    h.addAction(
      {
        approval: "always",
        effect: "write",
        binding: {
          type: "http",
          method: "POST",
          path: "/TEST-private-binding",
          parameters: [],
          body: true,
        },
      },
      h.actionId,
    );
    assert.notEqual(h.capabilities().fingerprint, oldFingerprint);
    assert.throws(
      () => h.capabilities({ after: first.nextAfter! }),
      errorCode("process_design_capabilities_changed"),
    );
    const beforeLimits = h.capabilities().fingerprint;
    assert.notEqual(
      h.capabilities({ limits: { ...DEFAULT_PROCESS_LIMITS, maxSteps: 10 } })
        .fingerprint,
      beforeLimits,
    );
    const provider = h.catalog.provider(
      target.organizationId,
      h.providerId,
    ).provider;
    h.command({
      type: "saveProvider",
      id: h.providerId,
      revision: provider.revision,
      settings: {
        name: provider.name,
        url: provider.url,
        enabled: true,
        dailyRequestLimit: 11,
      },
    });
    const changed = h.capabilities();
    assert.notEqual(changed.fingerprint, beforeLimits);
    let models = changed.models;
    if (changed.nextAfter)
      models = [
        ...models,
        ...h.capabilities({ after: changed.nextAfter }).models,
      ];
    assert.equal(models[0]!.providerRevision, 2);
  } finally {
    h.db.close();
  }
});

test("designer capabilities tell everyone, members included, whether the AI budget is ready", () => {
  const h = fixture();
  const member: ProcessActor = {
    ...target,
    userId: "TEST-design-member",
    role: "member",
  };
  h.db
    .prepare("INSERT INTO member VALUES (?,?,?,?)")
    .run(
      "TEST-design-member-row",
      target.organizationId,
      member.userId,
      "member",
    );
  const ready = (who: ProcessActor = actor) =>
    designCapabilities(h.catalog, h.plugins, who).budgetReady;
  const price = {
    modelId: h.modelId,
    modelRevision: 1,
    providerRevision: 1,
    maxInputTokens: 4096,
    maxOutputTokens: 1024,
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
  };
  const save = (settings: object) => {
    const policy = h.catalog.inferenceBudget.policy(
      target.organizationId,
      target.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      target.organizationId,
      target.workspaceId,
      policy.revision,
      { maxTokens: 100_000, maxCostMicros: 1_000_000, ...settings } as never,
    );
  };
  try {
    // No policy yet: observe mode without prices.
    assert.equal(ready(), false);
    assert.equal(ready(member), false);
    const before = h.capabilities().fingerprint;
    save({ mode: "observe", prices: [price] });
    assert.equal(ready(member), false);
    save({ mode: "enforce", prices: [] });
    assert.equal(ready(member), false);
    // A price for another model revision does not count.
    save({ mode: "enforce", prices: [{ ...price, modelRevision: 2 }] });
    assert.equal(ready(member), false);
    save({ mode: "enforce", prices: [price] });
    assert.equal(ready(), true);
    assert.equal(ready(member), true);
    // Readiness is information, not a capability dependency.
    assert.equal(h.capabilities().fingerprint, before);
    // A priced model the designer cannot use does not make it ready.
    h.db
      .prepare(
        "UPDATE agent_catalog SET data=json_set(data,'$.enabled',json('false')) WHERE id=? AND kind='model'",
      )
      .run(h.modelId);
    assert.equal(h.capabilities().models.length, 0);
    assert.equal(ready(member), false);
  } finally {
    h.db.close();
  }
});
