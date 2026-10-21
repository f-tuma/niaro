import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESIGN_PROFILE,
  DesignCapabilitiesSchema,
  type DesignCapabilities,
} from "../packages/protocol/process-design";
import { loadDesignCapabilities } from "../apps/server-admin/web/lib/process-design-api";
import { api, ApiError } from "../apps/server-admin/web/lib/api";

const target = { organizationId: "TEST-org", workspaceId: "TEST-workspace" };
const service = {
  id: "TEST-service",
  revision: 1,
  name: "TEST service",
  description: "",
  enabled: true,
  actions: [],
};
const action = (id: string) => ({
  id,
  revision: 1,
  name: id,
  description: "",
  enabled: true,
  status: "configured" as const,
  effect: "read" as const,
  approval: "never" as const,
  inputSchema: { type: "object" },
  schemaUnavailable: null,
});
const model = {
  id: "TEST-model",
  revision: 1,
  name: "TEST designer",
  model: "TEST-tools",
  providerId: "TEST-provider",
  providerRevision: 1,
  tools: true as const,
  status: "configured" as const,
};
const page = (changes: Partial<DesignCapabilities> = {}) =>
  DesignCapabilitiesSchema.parse({
    ...target,
    services: [],
    models: [],
    memoryModes: ["none", "conversation", "saved"],
    limits: {
      maxSteps: 24,
      maxModelCalls: 32,
      maxTokens: 1000000,
      maxCostMicros: 10000000,
      maxDurationMs: 120000,
    },
    grammar: {
      schemaVersion: 1,
      trigger: "manual",
      kinds: ["agent", "workflow"],
    },
    fingerprint: "a".repeat(64),
    nextAfter: null,
    totalItems: 0,
    ...changes,
  });
const response = (capabilities: DesignCapabilities) =>
  Response.json({ profile: DESIGN_PROFILE, capabilities });

test("designer inventory joins split service actions and later models without any POST", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(init.method, undefined);
    assert.equal(init.credentials, "same-origin");
    return response(
      calls.length === 1
        ? page({
            services: [{ ...service, actions: [action("TEST-first")] }],
            totalItems: 4,
            nextAfter: "TEST-next",
          })
        : page({
            services: [{ ...service, actions: [action("TEST-last")] }],
            models: [model],
            totalItems: 4,
          }),
    );
  });
  const loaded = await loadDesignCapabilities(
    target,
    new AbortController().signal,
  );
  assert.equal(calls.length, 2);
  assert(calls[1]!.includes("after=TEST-next"));
  assert.deepEqual(
    loaded.services[0]!.actions.map((a) => a.id),
    ["TEST-first", "TEST-last"],
  );
  assert.deepEqual(loaded.models, [model]);
  assert.equal(loaded.nextAfter, null);
});

test("changed capability snapshots restart from empty and never merge previous permissions", async (t) => {
  for (const conflict of ["http", "fingerprint"] as const) {
    let calls = 0;
    const mock = t.mock.method(
      globalThis,
      "fetch",
      async (_url: string, init: RequestInit) => {
        assert.equal(init.method, undefined);
        if (++calls === 1)
          return response(
            page({
              services: [{ ...service, actions: [action("TEST-stale")] }],
              totalItems: 2,
              nextAfter: "TEST-next",
            }),
          );
        if (calls === 2)
          return conflict === "http"
            ? Response.json(
                { error: "process_design_capabilities_changed" },
                { status: 409 },
              )
            : response(page({ fingerprint: "b".repeat(64) }));
        return response(
          page({
            services: [{ ...service, actions: [action("TEST-current")] }],
            fingerprint: "c".repeat(64),
            totalItems: 2,
          }),
        );
      },
    );
    const loaded = await loadDesignCapabilities(
      target,
      new AbortController().signal,
    );
    assert.equal(calls, 3);
    assert.deepEqual(
      loaded.services[0]!.actions.map((a) => a.id),
      ["TEST-current"],
    );
    mock.mock.restore();
  }
});

test("designer inventory rejects scope drift, incomplete inventory, cursor cycles and repeated conflicts", async (t) => {
  for (const invalid of [
    "scope",
    "incomplete",
    "cursor",
    "conflict",
  ] as const) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (invalid === "conflict")
        return Response.json(
          { error: "process_design_capabilities_changed" },
          { status: 409 },
        );
      if (invalid === "scope")
        return response(page({ workspaceId: "TEST-foreign" }));
      if (invalid === "incomplete") return response(page({ totalItems: 1 }));
      return response(page({ totalItems: 3, nextAfter: "TEST-cycle" }));
    });
    await assert.rejects(
      loadDesignCapabilities(target, new AbortController().signal),
      invalid === "conflict"
        ? (error: unknown) =>
            error instanceof ApiError &&
            error.code === "process_design_capabilities_changed"
        : SyntaxError,
    );
    assert.equal(calls, invalid === "cursor" || invalid === "conflict" ? 2 : 1);
    mock.mock.restore();
  }
});

test("cancelled inventory load cannot make a request or return cached partial capabilities", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response(page());
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadDesignCapabilities(target, controller.signal));
  assert.equal(calls, 0);
});

test("designer turn POST outlasts the server deadline while passive reads keep the catalog timeout", async (t) => {
  const timeouts: number[] = [];
  const bodies: unknown[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      bodies.push(
        init.body === undefined ? undefined : JSON.parse(String(init.body)),
      );
      if (init.body !== undefined)
        assert.equal(
          (init.headers as Record<string, string>)["X-Agent-Admin"],
          "1",
        );
      return Response.json({});
    },
  );
  const text = "  TEST original\n\n**Markdown**  ";
  await api("identity/catalog/processes/design/turns", { text });
  await api("identity/catalog/processes/design/turns?requestId=TEST-poll");
  await api("identity/catalog/processes/design/start", {});
  assert.deepEqual(timeouts, [305000, 50000, 50000]);
  assert.deepEqual(bodies, [{ text }, undefined, {}]);
});
