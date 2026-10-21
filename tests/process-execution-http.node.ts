import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { authRequest } from "../packages/client-core/auth";
import {
  CommandSchema,
  CredentialSchema,
  type Credential,
} from "../packages/protocol";
import {
  PROCESS_EXECUTION_PROFILE,
  PROCESS_INPUT_PROFILE,
  ProcessExecutionInventorySchema,
  ProcessInputCardSchema,
  type ProcessInputRequest,
} from "../packages/protocol/process-execution";
import { PROCESS_START_PROFILE } from "../packages/protocol/process-start";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import {
  ActionSettings,
  ServiceSettings,
} from "../packages/protocol/service-catalog";
import { type ProcessDefinition } from "../packages/protocol/service-processes";
import { processDigest } from "../apps/server-identity/process-validation";
import { designHttpFixture } from "./helpers/process-design-http";
import { seedSyntheticQualification } from "./helpers/process-qualified-fixture";

type Role = "owner" | "admin" | "member";
type Response = { status: number; data: unknown };
const profile = "?profile=" + encodeURIComponent(PROCESS_EXECUTION_PROFILE);
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Real account/device HTTP; only activation evidence is seeded by the trusted test boundary. */
async function executionFixture() {
  const h = await designHttpFixture();
  let runtimeCalls = 0;
  function installRuntimeTrap() {
    h.identity.mobileAccess = async () => {
      runtimeCalls++;
      throw Error(
        "TEST process metadata must not construct or unseal a runtime",
      );
    };
  }
  installRuntimeTrap();
  const ownerId = IdentityStateSchema.parse(
    (await h.request("owner", "api/identity")).data,
  ).user!.id;
  const organization = OrganizationDetailSchema.parse(
    (
      await h.request(
        "owner",
        `api/identity/organization?id=${h.target.organizationId}`,
      )
    ).data,
  );
  const member = organization.members.find((m) => m.role === "member")!;
  const actor = { ...h.target, userId: ownerId, role: "owner" as const };
  const readAction = h.identity["catalog"].store
    .service(h.target.workspaceId, h.serviceId)
    .actions.find((a) => a.id === h.actionId)!;
  const {
    id: _id,
    revision: _revision,
    sourceKey: _key,
    ...actionSettings
  } = readAction;
  await h.catalog({
    type: "saveAction",
    id: h.actionId,
    serviceId: h.serviceId,
    serviceRevision: h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    ).revision,
    revision: readAction.revision,
    settings: ActionSettings.parse({
      ...actionSettings,
      policy: { roles: ["owner", "admin", "member"], users: [] },
    }),
  });
  const activate = (
    definition: ProcessDefinition = h.workflow(),
    id?: string,
  ) => {
    const registry = h.identity["processes"];
    const saved = registry.saveDraft(actor, {
      id,
      serviceId: h.serviceId,
      revision: id ? registry.get(actor, id).revision : 0,
      definition,
    });
    const artifact = registry.freezeDraft(actor, saved.id, saved.revision);
    seedSyntheticQualification(h, actor, artifact);
    registry.activate(
      actor,
      saved.id,
      registry.get(actor, saved.id).revision,
      artifact.version,
    );
    return artifact;
  };
  const pair = async (role: Role = "member", persistent = true) => {
    const issued = await h.request(
      role,
      "api/identity/mobile/pairing",
      h.target,
    );
    assert.equal(issued.status, 200, JSON.stringify(issued.data));
    const grant = h.record(issued.data);
    const credential = CredentialSchema.parse(
      await authRequest(
        String(grant.address),
        "pair",
        fetch,
        undefined,
        String(grant.code),
        false,
        persistent,
      ),
    );
    assert.equal(!!credential.refresh, persistent);
    return credential;
  };
  const mobile = async (
    credential: Credential | undefined,
    path = "processes" + profile,
    input?: unknown,
    settings: {
      method?: string;
      raw?: string;
      headers?: Record<string, string>;
      workspaceId?: string;
    } = {},
  ): Promise<Response> => {
    const response = await fetch(
      `${h.origin}/v1/${settings.workspaceId ?? h.target.workspaceId}/${path}`,
      {
        method:
          settings.method ??
          (input === undefined && settings.raw === undefined ? "GET" : "POST"),
        signal: AbortSignal.timeout(10000),
        headers: {
          ...(credential
            ? { Authorization: `Bearer ${credential.accessToken}` }
            : {}),
          "Content-Type": "application/json",
          ...settings.headers,
        },
        body:
          settings.raw ??
          (input === undefined ? undefined : JSON.stringify(input)),
      },
    );
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
    };
  };
  const inventory = async (credential: Credential, query = "") => {
    const response = await mobile(credential, "processes" + profile + query);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return ProcessExecutionInventorySchema.parse(response.data);
  };
  const input = (
    artifact: ReturnType<typeof activate>,
    requestId: string = randomUUID(),
  ): ProcessInputRequest => ({
    processId: artifact.processId,
    version: artifact.version,
    artifactDigest: artifact.digest,
    language: "cs",
    origin: { type: "command", conversationId: "TEST-conversation", requestId },
  });
  const production = () =>
    Object.fromEntries(
      [
        "agent_process_start_command",
        "agent_service_process_run",
        "agent_service_turn",
        "agent_service_turn_operation",
        "agent_service_turn_cursor",
        "agent_service_invocation",
        "agent_inference_run",
        "agent_inference_attempt",
        "agent_provider_usage",
        "agent_process_contract_test",
        "agent_process_native_test_admission",
        "agent_memory",
        "agent_memory_request",
      ].map((table) => [
        table,
        Number(
          h.identity["db"].prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!
            .n,
        ),
      ]),
    );
  const intents = () =>
    Number(
      h.identity["db"]
        .prepare("SELECT COUNT(*) AS n FROM agent_process_start_intent")
        .get()!.n,
    );
  const audit = () =>
    h.identity["db"].prepare("SELECT * FROM agent_audit ORDER BY id").all();
  const nativeFiles = () =>
    readdirSync(join(h.root, "identity"), { recursive: true })
      .map(String)
      .filter((p) => /native|mastra/i.test(p));
  return {
    ...h,
    actor,
    member,
    ownerId,
    activate,
    pair,
    mobile,
    inventory,
    input,
    production,
    intents,
    audit,
    nativeFiles,
    get identity() {
      return h.identity;
    },
    runtimeCalls: () => runtimeCalls,
    restart: async () => {
      await h.restart();
      installRuntimeTrap();
    },
    passive: (before: ReturnType<typeof production>) => {
      assert.deepEqual(production(), before);
      assert.equal(runtimeCalls, 0);
      assert.equal(h.modelCount(), 0);
      assert.equal(h.businessCount(), 0);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof executionFixture>>;
let ready: Promise<Fixture> | undefined;
async function fixture(run: (h: Fixture) => Promise<void>) {
  // Reuse real account sessions so independent cases do not consume BetterAuth's
  // process-wide per-IP sign-in limit. Each case starts with empty process data.
  ready ??= executionFixture();
  const h = await ready;
  await h.restart();
  h.identity["db"].exec("DELETE FROM agent_service_process");
  await run(h);
}
after(async () => {
  if (ready) await (await ready).close();
});
function error(response: Response, status: number, code?: string) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  if (code) assert.deepEqual(response.data, { error: code });
}

test("execution HTTP gives real owner, admin and workspace member a passive active-artifact projection", () =>
  fixture(async (h) => {
    const active = h.activate();
    const draft = h.identity["processes"].saveDraft(h.actor, {
      id: active.processId,
      serviceId: h.serviceId,
      revision: h.identity["processes"].get(h.actor, active.processId).revision,
      definition: { ...h.workflow(), name: "TEST unpublished private draft" },
    });
    h.identity["processes"].saveDraft(h.actor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const privateAction = await h.catalog({
      type: "saveAction",
      serviceId: h.serviceId,
      serviceRevision: h.identity["catalog"].store.service(
        h.target.workspaceId,
        h.serviceId,
      ).revision,
      revision: 0,
      settings: {
        name: "TEST private lookup",
        description: "TEST private source",
        inputSchema: active.definition.inputSchema,
        binding: {
          type: "http",
          method: "GET",
          path: "/private",
          parameters: [],
          body: false,
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["owner", "admin"], users: [] },
      },
    });
    const privateDefinition = {
      ...h.workflow(),
      name: "TEST manager-only process",
    };
    if (privateDefinition.kind !== "workflow")
      throw Error("TEST workflow absent");
    privateDefinition.steps = privateDefinition.steps.map((step) =>
      step.type === "action" ? { ...step, actionId: privateAction } : step,
    );
    const privateArtifact = h.activate(privateDefinition);
    // Saving another action changes the service source revision. Refresh the public
    // process so this check tests permission filtering independently of source drift.
    const current = h.activate(h.workflow(), active.processId);
    const credentials = await Promise.all([
      h.pair("owner"),
      h.pair("admin"),
      h.pair("member"),
    ]);
    const before = h.production(),
      audit = h.audit(),
      files = h.nativeFiles();
    assert(before.agent_process_contract_test! > 0);
    assert.equal(
      before.agent_process_contract_test,
      before.agent_process_native_test_admission,
    );
    assert(
      Object.entries(before).every(
        ([table, n]) =>
          [
            "agent_process_contract_test",
            "agent_process_native_test_admission",
          ].includes(table) || n === 0,
      ),
    );
    for (const credential of credentials) {
      const first = await h.inventory(credential);
      assert.deepEqual(first.scope, credential.scope);
      assert.equal(first.profile, PROCESS_EXECUTION_PROFILE);
      assert.equal(first.nextAfter, null);
      const entry = first.processes.find(
        (p) => p.processId === current.processId,
      )!;
      assert.equal(entry.availability, "ready");
      assert.equal(entry.version, current.version);
      assert.equal(entry.artifactDigest, current.digest);
      assert.equal(entry.name, current.definition.name);
      assert.equal(
        first.processes.some((p) => p.name === draft.draft.name),
        false,
      );
      assert.equal(
        first.processes.some((p) => p.processId === privateArtifact.processId),
        credential.scope.userId !== h.member.userId,
      );
      for (let repeat = 0; repeat < 3; repeat++)
        assert.deepEqual(await h.inventory(credential), first);
      const after = first.processes.at(-1)!.processId;
      assert.deepEqual(
        (
          await h.inventory(
            credential,
            `&after=${after}&fingerprint=${first.fingerprint}`,
          )
        ).processes,
        [],
      );
      const json = JSON.stringify(first);
      for (const secret of [
        "draft",
        "steps",
        "capabilities",
        "instructions",
        "sources",
        "binding",
        "TEST-HTTP-provider-key",
        "models.example.test",
        "services.example.test",
      ])
        assert.equal(json.includes(secret), false, secret);
    }
    const memberCredential = credentials[2]!;
    error(
      await h.mobile(
        memberCredential,
        "processes/input" + profile,
        h.input(privateArtifact),
      ),
      404,
      "process_not_found",
    );
    assert.equal(h.intents(), 0);
    assert.deepEqual(h.audit(), audit);
    assert.deepEqual(h.nativeFiles(), files);
    h.passive(before);
  }));

test("input HTTP persists one scoped form intent, replays it across restart, and rechecks current readiness and seen version", () =>
  fixture(async (h) => {
    const artifact = h.activate(),
      credential = await h.pair();
    const request = h.input(artifact, "TEST-durable-menu-request");
    const before = h.production(),
      audit = h.audit(),
      files = h.nativeFiles();
    const response = await h.mobile(
      credential,
      "processes/input" + profile,
      request,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const card = ProcessInputCardSchema.parse(response.data);
    assert.deepEqual(card.form.scope, credential.scope);
    assert.equal(card.form.profile, PROCESS_INPUT_PROFILE);
    assert.equal(card.formDigest, processDigest(card.form));
    assert.deepEqual(card.form.inputSchema, artifact.definition.inputSchema);
    assert.deepEqual(card.intent.fields, {});
    assert.deepEqual(card.intent.origin, request.origin);
    assert.equal(h.intents(), 1);
    assert.deepEqual(
      (await h.mobile(credential, "processes/input" + profile, request)).data,
      card,
    );
    error(
      await h.mobile(credential, "processes/input" + profile, {
        ...request,
        language: "en",
      }),
      409,
      "process_start_conflict",
    );
    error(
      await h.mobile(credential, "processes/input" + profile, {
        ...request,
        artifactDigest: "0".repeat(64),
      }),
      409,
      "process_active_version_changed",
    );
    error(
      await h.mobile(credential, "processes/input" + profile, {
        ...request,
        processId: randomUUID(),
      }),
      404,
      "process_not_found",
    );
    await h.restart();
    assert.deepEqual(
      (await h.mobile(credential, "processes/input" + profile, request)).data,
      card,
    );
    assert.equal(h.intents(), 1);
    const owner = await h.pair("owner");
    const ownerResponse = await h.mobile(
      owner,
      "processes/input" + profile,
      request,
    );
    assert.equal(ownerResponse.status, 200, JSON.stringify(ownerResponse.data));
    const ownerCard = ProcessInputCardSchema.parse(ownerResponse.data);
    assert.notEqual(ownerCard.intent.intentId, card.intent.intentId);
    assert.deepEqual(ownerCard.form.scope, owner.scope);
    assert.equal(h.intents(), 2);
    assert.deepEqual(
      h.audit(),
      audit,
      "preparation and replay write no audit or execution event",
    );
    const previousInventory = await h.inventory(credential);
    const service = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const {
      id: _id,
      revision: _revision,
      hasCredential: _credential,
      modelId: _model,
      actions: _actions,
      ...settings
    } = service;
    await h.catalog({
      type: "saveService",
      id: service.id,
      revision: service.revision,
      settings: ServiceSettings.parse({ ...settings, enabled: false }),
    });
    const blocked = await h.inventory(credential);
    const entry = blocked.processes[0]!;
    assert.equal(entry.availability, "blocked");
    if (entry.availability !== "blocked")
      throw Error("TEST blocked entry absent");
    assert.equal(entry.reason, "service_unavailable");
    assert.equal("inputSchema" in entry, false);
    assert.notEqual(blocked.fingerprint, previousInventory.fingerprint);
    error(
      await h.mobile(
        credential,
        "processes" + profile + `&fingerprint=${previousInventory.fingerprint}`,
      ),
      409,
      "process_inventory_changed",
    );
    error(
      await h.mobile(credential, "processes/input" + profile, request),
      409,
      "process_execution_unavailable",
    );
    assert.equal(h.intents(), 2);
    const disabled = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    await h.catalog({
      type: "saveService",
      id: service.id,
      revision: disabled.revision,
      settings: ServiceSettings.parse({ ...settings, enabled: true }),
    });
    const next = h.activate(
      { ...h.workflow(), name: "TEST version two" },
      artifact.processId,
    );
    error(
      await h.mobile(credential, "processes/input" + profile, request),
      409,
      "process_active_version_changed",
    );
    const fresh = await h.mobile(
      credential,
      "processes/input" + profile,
      h.input(next),
    );
    assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
    assert.equal(ProcessInputCardSchema.parse(fresh.data).intent.version, 2);
    assert.equal(h.intents(), 3);
    const start = {
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: "TEST-start",
      idempotencyKey: "TEST-start",
      intentId: card.intent.intentId,
      conversationId: request.origin.conversationId,
      language: "cs",
      input: { name: "TEST input" },
    };
    assert.equal(
      CommandSchema.safeParse(start).success,
      false,
      "execution is not a public command until NIAR-92",
    );
    const stored = h.identity["db"]
      .prepare("SELECT data FROM agent_process_start_intent WHERE id=?")
      .get(card.intent.intentId)!;
    assert.deepEqual(
      h.record(JSON.parse(String(stored.data))).intent,
      card.intent,
    );
    assert.equal(
      h.audit().filter((row) => String(row.action).includes("start")).length,
      0,
    );
    assert(
      audit.length < h.audit().length,
      "only explicit catalog mutations add audit entries",
    );
    assert.deepEqual(h.nativeFiles(), files);
    h.passive({
      ...before,
      // The explicit v2 activation above seeds one new private proof tuple.
      agent_process_contract_test: before.agent_process_contract_test! + 1,
      agent_process_native_test_admission:
        before.agent_process_native_test_admission! + 1,
    });
  }));

test("execution HTTP negotiates its profile and rejects spoofed scope, duplicate queries, malformed forms and unsupported methods", () =>
  fixture(async (h) => {
    const artifact = h.activate(),
      credential = await h.pair(),
      request = h.input(artifact);
    const before = h.production(),
      audit = h.audit();
    for (const path of [
      "processes",
      "processes?profile=unknown",
      "processes/input",
      "processes/input?profile=unknown",
    ])
      error(
        await h.mobile(credential, path),
        406,
        "process_profile_unsupported",
      );
    error(await h.mobile(undefined), 401);
    error(
      await h.mobile(credential, "processes" + profile, undefined, {
        headers: { Authorization: "Bearer TEST-forged-token" },
      }),
      401,
    );
    error(
      await h.mobile(credential, "processes" + profile, undefined, {
        workspaceId: randomUUID(),
      }),
      403,
      "auth_scope_mismatch",
    );
    error(
      await h.mobile(credential, "processes" + profile, undefined, {
        workspaceId: "a",
      }),
      404,
      "not_found",
    );
    error(
      await h.mobile(credential, "processes" + profile, {}, { method: "POST" }),
      405,
      "method_not_allowed",
    );
    error(
      await h.mobile(credential, "processes/input" + profile),
      405,
      "method_not_allowed",
    );
    for (const query of [
      "&organizationId=TEST-forged-org",
      "&workspaceId=" + randomUUID(),
      "&userId=" + h.ownerId,
      "&role=owner",
      "&extra=1",
      "&__proto__=x",
      "&profile=" + encodeURIComponent(PROCESS_EXECUTION_PROFILE),
      "&after=" + artifact.processId,
      "&fingerprint=invalid",
      "&fingerprint=" + "0".repeat(64) + "&fingerprint=" + "0".repeat(64),
    ])
      error(
        await h.mobile(credential, "processes" + profile + query),
        400,
        "invalid_payload",
      );
    const inventory = await h.inventory(credential);
    error(
      await h.mobile(
        credential,
        "processes" +
          profile +
          `&after=${artifact.processId}&after=${artifact.processId}&fingerprint=${inventory.fingerprint}`,
      ),
      400,
      "invalid_payload",
    );
    error(
      await h.mobile(
        credential,
        "processes" +
          profile +
          `&after=${randomUUID()}&fingerprint=${inventory.fingerprint}`,
      ),
      409,
      "process_inventory_changed",
    );
    for (const patch of [
      { scope: { ...credential.scope, userId: h.ownerId } },
      { actor: { userId: h.ownerId, role: "owner" } },
      { organizationId: "TEST-forged-org" },
      { input: { name: "TEST submitted input" } },
      { language: "invalid" },
    ])
      error(
        await h.mobile(credential, "processes/input" + profile, {
          ...request,
          ...patch,
        }),
        400,
        "invalid_payload",
      );
    await h.restart();
    for (const patch of [
      { origin: { ...request.origin, extra: true } },
      {
        origin: {
          type: "card",
          conversationId: "TEST-conversation",
          messageId: "TEST-message",
          cardId: "TEST-card",
          cardRevision: 1,
          actionId: "TEST-action",
        },
      },
      { version: 0 },
      { extra: true },
    ])
      error(
        await h.mobile(credential, "processes/input" + profile, {
          ...request,
          ...patch,
        }),
        400,
        "invalid_payload",
      );
    error(
      await h.mobile(
        credential,
        "processes/input" + profile + "&userId=" + h.ownerId,
        request,
      ),
      400,
      "invalid_payload",
    );
    error(
      await h.mobile(credential, "processes/input" + profile, undefined, {
        raw: "{invalid",
      }),
      400,
      "invalid_payload",
    );
    error(
      await h.mobile(credential, "processes/input" + profile, undefined, {
        raw: JSON.stringify({ ...request, extra: "x".repeat(5000) }),
      }),
      413,
      "payload_too_large",
    );
    assert.equal(h.intents(), 0);
    assert.deepEqual(h.audit(), audit);
    h.passive(before);
  }));

test("execution HTTP revalidates live device, account session and membership authority inside the identity queue, including preparation replay", () =>
  fixture(async (h) => {
    const artifact = h.activate(),
      credential = await h.pair(),
      request = h.input(artifact);
    const first = await h.mobile(
      credential,
      "processes/input" + profile,
      request,
    );
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const before = h.production(),
      audit = h.audit();
    const device = h.identity["db"]
      .prepare("SELECT id FROM agent_mobile_device WHERE access_digest=?")
      .get(digest(credential.accessToken))!;
    h.identity["db"]
      .prepare("UPDATE agent_mobile_device SET user_id=? WHERE id=?")
      .run(h.ownerId, device.id!);
    for (const [path, input] of [
      ["processes" + profile, undefined],
      ["processes/input" + profile, request],
    ] as const)
      error(
        await h.mobile(credential, path, input),
        403,
        "auth_scope_mismatch",
      );
    h.identity["db"]
      .prepare("UPDATE agent_mobile_device SET user_id=? WHERE id=?")
      .run(h.member.userId, device.id!);
    for (const method of ["mobileProcesses", "mobileProcessInput"] as const) {
      const current = await h.pair("member", method === "mobileProcesses");
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const called = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const identity = h.identity,
        original = identity[method];
      const queued = identity["serial"](async () => {
        await gate;
        if (current.refresh) {
          identity["db"]
            .prepare(
              "UPDATE agent_mobile_device SET access_expires_at=0 WHERE access_digest=?",
            )
            .run(digest(current.accessToken));
        } else {
          // Revoke the genuine BetterAuth parent while preparation waits. The
          // stored form is still present, but its replay must authenticate anew.
          identity["db"]
            .prepare(
              'UPDATE session SET "expiresAt"=? WHERE id=(SELECT session_id FROM agent_mobile_session WHERE digest=?)',
            )
            .run("2000-01-01T00:00:00.000Z", digest(current.accessToken));
        }
      });
      if (method === "mobileProcesses") {
        const run = identity.mobileProcesses;
        identity.mobileProcesses = (...args) => {
          entered();
          return run.apply(identity, args);
        };
      } else {
        const run = identity.mobileProcessInput;
        identity.mobileProcessInput = (...args) => {
          entered();
          return run.apply(identity, args);
        };
      }
      const pending = h.mobile(
        current,
        method === "mobileProcesses"
          ? "processes" + profile
          : "processes/input" + profile,
        method === "mobileProcesses" ? undefined : request,
      );
      try {
        await Promise.race([
          called,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  Error("TEST HTTP route did not reach the identity queue"),
                ),
              4000,
            );
            timer.unref();
          }),
        ]);
        release();
        await queued;
        error(await pending, 401, "auth_expired");
      } finally {
        release();
        if (method === "mobileProcesses")
          identity.mobileProcesses =
            original as typeof identity.mobileProcesses;
        else
          identity.mobileProcessInput =
            original as typeof identity.mobileProcessInput;
      }
    }
    assert.equal(
      (
        await h.request("owner", "api/identity/command", {
          ...h.target,
          type: "setWorkspaceMember",
          memberId: h.member.id,
          allowed: false,
        })
      ).status,
      200,
    );
    for (const [path, input] of [
      ["processes" + profile, undefined],
      ["processes/input" + profile, request],
    ] as const)
      error(await h.mobile(credential, path, input), 401);
    assert.equal(h.intents(), 1);
    const card = ProcessInputCardSchema.parse(first.data);
    const saved = h.identity["db"]
      .prepare("SELECT data FROM agent_process_start_intent WHERE id=?")
      .get(card.intent.intentId)!;
    assert.deepEqual(
      h.record(JSON.parse(String(saved.data))).intent,
      card.intent,
    );
    assert.equal(
      h.audit().length,
      audit.length + 1,
      "only membership revocation is audited",
    );
    h.passive(before);
  }));
