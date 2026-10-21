import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authRequest } from "../../packages/client-core/auth";
import { CredentialSchema, type Credential } from "../../packages/protocol";
import { IdentityStateSchema } from "../../packages/protocol/identity";
import {
  ProcessInputCardSchema,
  PROCESS_EXECUTION_PROFILE,
} from "../../packages/protocol/process-execution";
import { PROCESS_START_PROFILE } from "../../packages/protocol/process-start";
import { type ProcessDefinition } from "../../packages/protocol/service-processes";
import type { IntegrationTransport } from "../../apps/server-integrations/transport";
import {
  designHttpFixture,
  type DesignHttpTestOptions,
} from "./process-design-http";
import { seedSyntheticQualification } from "./process-qualified-fixture";

export async function coordinatorHttpFixture(
  options: DesignHttpTestOptions & { allowOrdinaryRuntime?: boolean } = {},
) {
  const h = await designHttpFixture(undefined, options);
  const ownerId = IdentityStateSchema.parse(
    (await h.request("owner", "api/identity")).data,
  ).user!.id;
  const actor = { ...h.target, userId: ownerId, role: "owner" as const };
  const catalog = h.identity["catalog"].store;
  const service = catalog.service(h.target.workspaceId, h.serviceId);
  const action = service.actions.find((a) => a.id === h.actionId)!;
  const { id: _id, revision: _revision, sourceKey: _key, ...settings } = action;
  await h.catalog({
    type: "saveAction",
    id: h.actionId,
    serviceId: h.serviceId,
    serviceRevision: service.revision,
    revision: action.revision,
    settings: {
      ...settings,
      policy: { roles: ["owner", "admin", "member"], users: [] },
    },
  });
  const writeId = await h.catalog({
    type: "saveAction",
    serviceId: h.serviceId,
    serviceRevision: catalog.service(h.target.workspaceId, h.serviceId)
      .revision,
    revision: 0,
    settings: {
      ...settings,
      name: "TEST confirmed write",
      effect: "write",
      approval: "always",
      binding: {
        type: "http",
        method: "POST",
        path: "/items",
        parameters: [],
        body: true,
      },
      policy: { roles: ["owner", "admin", "member"], users: [] },
    },
  });
  const dispatches: string[] = [];
  let before: (() => Promise<void> | void) | undefined;
  let after: (() => Promise<void> | void) | undefined;
  let serviceResponse: IntegrationTransport = async () => ({
    status: 200,
    headers: {},
    text: JSON.stringify({ value: "TEST-mobile-result" }),
  });
  const transport: IntegrationTransport = async (request) => {
    if (new URL(request.url).origin === "https://models.example.test")
      return h.scriptedModelTransport(request);
    assert.equal(new URL(request.url).origin, "https://services.example.test");
    assert(request.beforeDispatch);
    await before?.();
    await request.beforeDispatch(() => {
      dispatches.push(request.method ?? "GET");
    });
    await after?.();
    return serviceResponse(request);
  };
  let ordinaryRuntimeCalls = 0;
  const install = () => {
    Object.defineProperty(h.identity["catalog"], "transport", {
      value: transport,
    });
    const mobileAccess = h.identity.mobileAccess.bind(h.identity);
    h.identity.mobileAccess = async (...args) => {
      ordinaryRuntimeCalls++;
      if (options.allowOrdinaryRuntime) return mobileAccess(...args);
      throw Error("Process commands must not construct ordinary chat runtime");
    };
  };
  install();
  const suffix = "?profile=" + encodeURIComponent(PROCESS_EXECUTION_PROFILE);
  async function mobile(
    credential: Credential | undefined,
    path: string,
    input?: unknown,
    raw?: string,
  ) {
    const response = await fetch(
      h.origin + "/v1/" + h.target.workspaceId + "/" + path,
      {
        method: input === undefined && raw === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(credential
            ? { Authorization: "Bearer " + credential.accessToken }
            : {}),
        },
        body: raw ?? (input === undefined ? undefined : JSON.stringify(input)),
        signal: AbortSignal.timeout(15000),
      },
    );
    return {
      status: response.status,
      data: (await response.json()) as unknown,
    };
  }
  const activate = (definition: ProcessDefinition = h.workflow()) => {
    const registry = h.identity["processes"];
    const draft = registry.saveDraft(actor, {
      serviceId: h.serviceId,
      revision: 0,
      definition,
    });
    const artifact = registry.freezeDraft(actor, draft.id, draft.revision);
    seedSyntheticQualification(h, actor, artifact);
    registry.activate(
      actor,
      draft.id,
      registry.get(actor, draft.id).revision,
      artifact.version,
    );
    return artifact;
  };
  const pair = async (role: "owner" | "admin" | "member" = "member") => {
    const response = await h.request(
      role,
      "api/identity/mobile/pairing",
      h.target,
    );
    assert.equal(response.status, 200);
    const issued = h.record(response.data);
    return CredentialSchema.parse(
      await authRequest(
        String(issued.address),
        "pair",
        fetch,
        undefined,
        String(issued.code),
        false,
        true,
      ),
    );
  };
  const prepare = async (
    credential: Credential,
    artifact: ReturnType<typeof activate>,
    input: Record<string, unknown> = { name: "TEST-input" },
  ) => {
    const requestId = randomUUID();
    const response = await mobile(credential, "processes/input" + suffix, {
      processId: artifact.processId,
      version: artifact.version,
      artifactDigest: artifact.digest,
      language: "en",
      origin: { type: "command", conversationId: "conversation-1", requestId },
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const card = ProcessInputCardSchema.parse(response.data);
    return {
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: requestId,
      idempotencyKey: requestId + "-key",
      conversationId: "conversation-1",
      intentId: card.intent.intentId,
      language: "en",
      input,
    };
  };
  return {
    ...h,
    get identity() {
      return h.identity;
    },
    pair,
    prepare,
    activate,
    mobile,
    suffix,
    dispatches,
    writeId,
    ordinaryRuntimeCalls: () => ordinaryRuntimeCalls,
    beforeDispatch: (fn: typeof before) => {
      before = fn;
    },
    afterDispatch: (fn: typeof after) => {
      after = fn;
    },
    onService: (fn: IntegrationTransport) => {
      serviceResponse = fn;
    },
    restart: async () => {
      await h.restart();
      install();
    },
  };
}
