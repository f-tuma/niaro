import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ActionInvokeRequest,
  ActionSettings,
  CatalogCommand,
} from "../packages/protocol/service-catalog";
import { ActionFailureSchema } from "../packages/protocol/action-failure";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import {
  ServiceCatalogStore,
  type StoredInvocation,
} from "../apps/server-identity/service-catalog";
import type { IntegrationTransport } from "../apps/server-integrations/transport";

const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const userId = "TEST-user";
const signal = () => new AbortController().signal;

function harness(transport: IntegrationTransport) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    CREATE TABLE agent_audit(id INTEGER PRIMARY KEY,outcome TEXT);
    INSERT INTO organization VALUES ('TEST-org');
    INSERT INTO agent_workspace VALUES ('11111111-1111-4111-8111-111111111111','TEST-org');
    INSERT INTO member VALUES ('TEST-member','TEST-org','TEST-user');
  `);
  const store = new ServiceCatalogStore(db, "TEST-only-secret", []);
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let auditCount = 0;
  const outcomes: string[] = [];
  const context: CatalogContext = {
    serial: (run) => {
      const task = queue.then(run);
      queue = task.catch(() => {});
      return task;
    },
    actor: async (scope) => {
      assert.deepEqual(scope, {
        ...scope,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
      });
      return { userId, role: "member" };
    },
    epoch: () => epoch,
    change: () => epoch++,
    audit: () => ++auditCount,
    finish: (_id, outcome) => outcomes.push(outcome),
    transaction: async (run) => run(),
  };
  const controller = new CatalogController(store, transport);
  const command = (payload: object) =>
    store.command(CatalogCommand.parse({ ...target, ...payload }));
  const action = (
    effect: "read" | "write",
    protocol: "openapi" | "mcp" = "openapi",
    approval: "always" | "never" = "never",
  ) => {
    const serviceId = command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST CRM",
        url: "https://crm.example.test/api",
        protocol,
        icon: "users",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const actionId = command({
      type: "saveAction",
      serviceId,
      serviceRevision: store.service(target.workspaceId, serviceId).revision,
      revision: 0,
      settings: {
        name: "TEST create person",
        description: "TEST fixture",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        binding:
          protocol === "mcp"
            ? { type: "mcp", name: "TEST_create_person" }
            : {
                type: "http",
                method: effect === "write" ? "POST" : "GET",
                path: "/people",
                parameters: [],
                body: false,
              },
        effect,
        approval,
        enabled: true,
        policy: { roles: ["member"], users: [] },
      },
    });
    return ActionInvokeRequest.parse({
      ...target,
      serviceId,
      serviceRevision: store.service(target.workspaceId, serviceId).revision,
      actionId,
      revision: 1,
      requestId: `TEST-${effect}-${protocol}`,
      input: { name: "TEST Person" },
    });
  };
  return {
    db,
    store,
    context,
    controller,
    action,
    command,
    outcomes,
    revoke: () => epoch++,
    auditCount: () => auditCount,
  };
}

function assertFailure(record: StoredInvocation) {
  const failure = ActionFailureSchema.parse(record.failure);
  assert(Number.isFinite(record.completedAt));
  assert.equal(record.result, undefined);
  return failure;
}

test("invalid initial arguments create no receipt and cannot dispatch", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw Error("Unexpected dispatch");
  });
  try {
    const input = h.action("write");
    await assert.rejects(
      h.controller.invoke({ ...input, input: {} }, h.context, signal()),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "integration_input_invalid",
    );
    assert.equal(calls, 0);
    assert.equal(
      h.store.invocation(input.requestId, target.workspaceId, userId),
      undefined,
    );
    assert.equal(h.auditCount(), 0);
  } finally {
    h.db.close();
  }
});

test("HTTP write failure keeps a bounded diagnosis and passive replay never retries", async () => {
  let dispatches = 0;
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => dispatches++);
    return {
      status: 400,
      headers: {},
      text: JSON.stringify({
        error: {
          message:
            "Missing required person name; Authorization: Bearer TEST-token",
          details: { password: "TEST-password" },
        },
      }),
    };
  });
  try {
    const input = h.action("write");
    const result = await h.controller.invoke(input, h.context, signal());
    assert.equal(result.status, "unknown");
    const failure = assertFailure(result);
    assert.equal(failure.httpStatus, 400);
    assert.equal(failure.stage, "provider_response");
    assert.equal(failure.retry, "verify_first");
    const encoded = JSON.stringify(result.failure);
    assert(!encoded.includes("TEST-token"));
    assert(!encoded.includes("TEST-password"));
    assert.deepEqual(h.outcomes, ["unknown"]);
    assert.deepEqual(
      await h.controller.invoke(input, h.context, signal()),
      result,
    );
    assert.equal(dispatches, 1);
    assert.equal(h.auditCount(), 1);
  } finally {
    h.db.close();
  }
});

test("read rate limit is a failed receipt with retry guidance and original HTTP status", async () => {
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => {});
    return { status: 429, headers: {}, text: '{"message":"TEST throttled"}' };
  });
  try {
    const result = await h.controller.invoke(
      h.action("read"),
      h.context,
      signal(),
    );
    assert.equal(result.status, "failed");
    const failure = assertFailure(result);
    assert.equal(failure.httpStatus, 429);
    assert.equal(failure.kind, "rate_limit");
    assert.equal(failure.retry, "later");
  } finally {
    h.db.close();
  }
});

test("a malformed provider response keeps the response phase and uncertain write outcome", async () => {
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => {});
    return { status: 200, headers: {}, text: "TEST malformed JSON" };
  });
  try {
    const result = await h.controller.invoke(
      h.action("write"),
      h.context,
      signal(),
    );
    assert.equal(result.status, "unknown");
    const failure = assertFailure(result);
    assert.equal(failure.kind, "response");
    assert.equal(failure.stage, "provider_response");
    assert.equal(failure.retry, "verify_first");
  } finally {
    h.db.close();
  }
});

test("binding validation is diagnosed before any external request dispatch", async () => {
  let dispatches = 0;
  const h = harness(async () => {
    dispatches++;
    throw Error("Unexpected dispatch");
  });
  try {
    const input = h.action("write");
    const service = h.store.service(target.workspaceId, input.serviceId);
    const action = service.actions.find(
      (value) => value.id === input.actionId,
    )!;
    const { id, revision } = action;
    const settings = ActionSettings.parse({
      name: action.name,
      description: action.description,
      inputSchema: action.inputSchema,
      binding: action.binding,
      effect: action.effect,
      approval: action.approval,
      enabled: action.enabled,
      policy: action.policy,
    });
    h.command({
      type: "saveAction",
      serviceId: service.id,
      serviceRevision: service.revision,
      id,
      revision,
      settings: {
        ...settings,
        binding: {
          type: "http",
          method: "POST",
          path: "/people/{externalId}",
          parameters: [{ name: "externalId", in: "path", required: true }],
          body: false,
        },
      },
    });
    const result = await h.controller.invoke(
      {
        ...input,
        serviceRevision: h.store.service(target.workspaceId, service.id)
          .revision,
        revision: revision + 1,
      },
      h.context,
      signal(),
    );
    assert.equal(result.status, "failed");
    const failure = assertFailure(result);
    assert.equal(failure.kind, "validation");
    assert.equal(failure.stage, "validation");
    assert.equal(failure.retry, "correct_input");
    assert.equal(dispatches, 0);
  } finally {
    h.db.close();
  }
});

test("MCP initialization failure does not claim an undispatched write", async () => {
  const methods: string[] = [];
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => {});
    methods.push((request.body as { method: string }).method);
    return { status: 503, headers: {}, text: '{"message":"TEST offline"}' };
  });
  try {
    const result = await h.controller.invoke(
      h.action("write", "mcp"),
      h.context,
      signal(),
    );
    assert.equal(result.status, "failed");
    const failure = assertFailure(result);
    assert.equal(failure.httpStatus, 503);
    assert.equal(failure.stage, "connection");
    assert.notEqual(failure.retry, "verify_first");
    assert.deepEqual(methods, ["initialize"]);
  } finally {
    h.db.close();
  }
});

test("cancellation records its evidence and never turns a dispatched write into a safe retry", async (t) => {
  for (const afterDispatch of [false, true])
    await t.test(
      afterDispatch ? "after dispatch" : "before dispatch",
      async () => {
        const abort = new AbortController();
        let dispatched = 0;
        const h = harness(async (request) => {
          if (afterDispatch) await request.beforeDispatch?.(() => dispatched++);
          abort.abort(Error("TEST-private-cancellation-reason"));
          throw abort.signal.reason;
        });
        try {
          const result = await h.controller.invoke(
            h.action("write"),
            h.context,
            abort.signal,
          );
          assert.equal(result.status, afterDispatch ? "unknown" : "failed");
          const failure = assertFailure(result);
          assert.equal(failure.kind, "cancelled");
          assert.equal(failure.retry, afterDispatch ? "verify_first" : "none");
          assert.equal(dispatched, afterDispatch ? 1 : 0);
          assert(!JSON.stringify(result).includes("TEST-private"));
        } finally {
          h.db.close();
        }
      },
    );
});

test("MCP tool failure after tools/call is unknown and cannot be automatically retried", async () => {
  const methods: string[] = [];
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => {});
    const body = request.body as { id?: number; method: string };
    methods.push(body.method);
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        : body.method === "tools/call"
          ? {
              isError: true,
              content: [
                { type: "text", text: "TEST required email is missing" },
              ],
            }
          : {};
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    };
  });
  try {
    const input = h.action("write", "mcp");
    const result = await h.controller.invoke(input, h.context, signal());
    assert.equal(result.status, "unknown");
    const failure = assertFailure(result);
    assert.equal(failure.stage, "provider_response");
    assert.equal(failure.retry, "verify_first");
    assert(failure.message?.includes("required email"));
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    await h.controller.invoke(input, h.context, signal());
    assert.equal(methods.length, 3);
  } finally {
    h.db.close();
  }
});

test("authorization revocation prevents dispatch and hides both successful and failed provider data", async (t) => {
  for (const boundary of [
    "before_dispatch",
    "after_success",
    "after_failure",
  ] as const)
    await t.test(boundary, async () => {
      let dispatched = 0;
      let h: ReturnType<typeof harness>;
      h = harness(async (request) => {
        if (boundary === "before_dispatch") h.revoke();
        await request.beforeDispatch?.(() => dispatched++);
        if (boundary !== "before_dispatch") h.revoke();
        return {
          status: boundary === "after_failure" ? 400 : 200,
          headers: {},
          text: '{"message":"TEST restricted provider detail","createdPerson":"TEST restricted person"}',
        };
      });
      try {
        const result = await h.controller.invoke(
          h.action("write"),
          h.context,
          signal(),
        );
        assert.equal(
          result.status,
          boundary === "before_dispatch" ? "failed" : "unknown",
        );
        const failure = assertFailure(result);
        assert.equal(failure.kind, "permission");
        assert.equal(
          failure.stage,
          boundary === "before_dispatch" ? "validation" : "result_commit",
        );
        assert.equal(dispatched, boundary === "before_dispatch" ? 0 : 1);
        assert(!JSON.stringify(result).includes("restricted"));
      } finally {
        h.db.close();
      }
    });
});

test("a failed commit of a known write result is diagnosed without exposing unsaved result data", async () => {
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => {});
    return { status: 200, headers: {}, text: '{"id":"TEST-private-person"}' };
  });
  try {
    const save = h.store.saveInvocation.bind(h.store);
    h.store.saveInvocation = (value) => {
      if (value.status === "succeeded") throw Error("TEST-private-store-error");
      save(value);
    };
    const result = await h.controller.invoke(
      h.action("write"),
      h.context,
      signal(),
    );
    assert.equal(result.status, "unknown");
    const failure = assertFailure(result);
    assert.equal(failure.stage, "result_commit");
    assert.equal(failure.retry, "verify_first");
    assert(!JSON.stringify(result).includes("TEST-private"));
  } finally {
    h.db.close();
  }
});

test("known successful approval clears stale diagnostics while preserving approval boundaries", async () => {
  let dispatches = 0;
  const h = harness(async (request) => {
    await request.beforeDispatch?.(() => dispatches++);
    return { status: 200, headers: {}, text: '{"id":"TEST-person"}' };
  });
  try {
    const input = h.action("write", "openapi", "always");
    const pending = await h.controller.invoke(input, h.context, signal());
    assert.equal(pending.status, "awaiting_approval");
    assert.equal(dispatches, 0);
    pending.failure = {
      code: "action_interrupted",
      kind: "unknown",
      stage: "dispatch",
      retry: "verify_first",
      fields: [],
    };
    h.store.saveInvocation(pending);
    const result = await h.controller.invoke(
      { ...input, approve: true },
      h.context,
      signal(),
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.result, { id: "TEST-person" });
    assert.equal(dispatches, 1);
  } finally {
    h.db.close();
  }
});

test("startup recovery records an honest interruption diagnosis and preserves old final receipts", () => {
  const h = harness(async () => {
    throw Error("Unexpected dispatch");
  });
  try {
    const write = h.store.prepare(
      h.action("write"),
      { userId, role: "member" },
      0,
    );
    const read = h.store.prepare(
      h.action("read"),
      { userId, role: "member" },
      0,
    );
    const oldFailure: StoredInvocation = {
      ...write,
      id: "TEST-historical-failure",
      status: "failed",
    };
    h.store.saveInvocation(oldFailure);
    new ServiceCatalogStore(h.db, "TEST-only-secret", []);
    for (const value of [write, read]) {
      const record = h.store.invocation(value.id, target.workspaceId, userId)!;
      assert.equal(
        record.status,
        value.effect === "write" ? "unknown" : "failed",
      );
      const failure = assertFailure(record);
      assert.equal(failure.code, "action_interrupted");
      assert.equal(failure.kind, "unknown");
      assert.equal(
        failure.retry,
        value.effect === "write" ? "verify_first" : "later",
      );
      assert(failure.message?.includes("original cause is unknown"));
    }
    assert.equal(
      h.store.invocation(oldFailure.id, target.workspaceId, userId)!.failure,
      undefined,
    );
    assert.equal(h.auditCount(), 0);
  } finally {
    h.db.close();
  }
});
