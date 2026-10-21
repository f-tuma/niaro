import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import type { Decision, ModelInput } from "../apps/fixture-server/decision";
import { authRequest } from "../packages/client-core/auth";
import { messageCommand } from "../packages/client-core/commands";
import {
  CredentialSchema,
  type Credential,
  type Command,
} from "../packages/protocol";
import { VOICE_PROFILE } from "../packages/protocol/voice";

const password = "TEST-mobile-password-123";
const reply: Decision = {
  kind: "reply",
  reply: "TEST reply",
  contactId: null,
  title: null,
  localStart: null,
  durationMinutes: null,
};
const crmDecision: Decision = { ...reply, kind: "crm_contacts", reply: null };
type Gate = { entered: () => void; wait: Promise<void> };
const hold = () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate: { entered, wait }, started, release };
};

test("Account mobile bridge: scope, dispatch, revocation and durable receipts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-mobile-test-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Mobile",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: {
        directory: join(root, "identity"),
        baseURL: origin,
        connectionOrigins: ["https://crm.example.test"],
      },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  let modelCalls = 0,
    crmCalls = 0,
    globalCrmCalls = 0,
    voiceCalls = 0;
  let decision = reply;
  let modelInput: ModelInput | undefined;
  let modelGate: Gate | undefined,
    crmGate: Gate | undefined,
    voiceGate: Gate | undefined;
  const transport: typeof fetch = async (url, init) => {
    crmCalls++;
    assert.equal(new URL(String(url)).origin, "https://crm.example.test");
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer TEST-mobile-crm-synthetic-key-only",
    );
    const gate = crmGate;
    if (gate) {
      gate.entered();
      await gate.wait;
    }
    init?.signal?.throwIfAborted();
    return Response.json({
      data: {
        people: [
          {
            id: "5a77bcbd-b43d-46ac-bd05-c9f211e61615",
            name: { firstName: "TEST Jana", lastName: "Nováková" },
            emails: { primaryEmail: "jana@example.test" },
          },
        ],
      },
    });
  };
  let identity = await openIdentity(config, { connectionTransport: transport });
  const adapters = {
    model: {
      timeZone: "Europe/Prague",
      decide: async (input: ModelInput) => {
        modelCalls++;
        modelInput = input;
        const gate = modelGate;
        if (gate) {
          gate.entered();
          await gate.wait;
        }
        return decision;
      },
    },
    crm: {
      list: async () => {
        globalCrmCalls++;
        throw Error("Instance CRM must never be inherited");
      },
    },
    transcriber: {
      transcribe: async () => {
        voiceCalls++;
        const gate = voiceGate;
        if (gate) {
          gate.entered();
          await gate.wait;
        }
        return { text: "TEST transcript", reviewReasons: [] };
      },
    },
  };
  app = createReferenceServer(config, adapters, identity);
  const db = new DatabaseSync(join(root, "identity", "identity.sqlite"));
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const response = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: response.status, data: await response.json() };
    };
  }
  const owner = client(),
    member = client(),
    operator = client();
  const mobile = async (
    credential: Credential,
    path: string,
    input?: unknown,
    workspaceId = credential.scope.workspaceId,
    method = input === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${origin}/v1/${workspaceId}/${path}`, {
      method,
      signal: AbortSignal.timeout(6000),
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
    };
  };
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { connectionTransport: transport });
    app = createReferenceServer(config, adapters, identity);
  };
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Alpha",
        })
      ).status,
      200,
    );
    // Setup signed this browser in as the owner: back to the recovery key.
    await operator("api/login", { key });
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const organizationId = (await owner("api/identity")).data.organizations[0]
      .id as string;
    const command = (type: string, rest: object) =>
      owner("api/identity/command", { type, organizationId, ...rest });
    await command("createWorkspace", { name: "TEST Sales" });
    await command("createWorkspace", { name: "TEST Other" });
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      ...{
        name: "TEST Member",
        email: "member@example.test",
        password,
        role: "member",
      },
    });
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const workspaceId = detail.workspaces.find(
      (w: { name: string }) => w.name === "TEST Sales",
    ).id as string;
    const otherWorkspaceId = detail.workspaces.find(
      (w: { name: string }) => w.name === "TEST Other",
    ).id as string;
    const memberRow = detail.members.find(
      (m: { email: string }) => m.email === "member@example.test",
    );
    const target = { organizationId, workspaceId };
    await member("auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    const issue = (who = member, override = {}) =>
      who("api/identity/mobile/pairing", { ...target, ...override });
    const pair = async (who = member) => {
      const issued = await issue(who);
      assert.equal(issued.status, 200);
      return CredentialSchema.parse(
        await authRequest(
          issued.data.address,
          "pair",
          fetch,
          undefined,
          issued.data.code,
        ),
      );
    };
    let credential!: Credential;
    let other!: Credential;
    const send = (value?: Command) =>
      mobile(
        credential,
        "commands",
        value ?? messageCommand("TEST message", "cs", randomUUID()),
      );
    await t.test(
      "one-use codes, account scope and disabled-by-default services",
      async () => {
        assert.equal((await issue(operator)).status, 403);
        assert.equal((await issue()).status, 403);
        await seedIdentityFixture(identity, {
          type: "setWorkspaceMember",
          organizationId,
          ...{
            memberId: memberRow.id,
            workspaceId,
            allowed: true,
          },
        });
        assert.equal(
          (await issue(member, { workspaceId: otherWorkspaceId })).status,
          403,
        );
        const first = (await issue()).data;
        const grant = (await issue()).data;
        await assert.rejects(
          authRequest(first.address, "pair", fetch, undefined, first.code),
        );
        await assert.rejects(
          identity.pairMobile(
            grant.code,
            otherWorkspaceId,
            new FixtureAuth(config.dataDirectory).serverId,
          ),
        );
        await assert.rejects(
          identity.pairMobile(grant.code, workspaceId, "different-server"),
        );
        const raced = await Promise.allSettled([
          authRequest(grant.address, "pair", fetch, undefined, grant.code),
          authRequest(grant.address, "pair", fetch, undefined, grant.code),
        ]);
        assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
        credential = CredentialSchema.parse(
          raced.find((r) => r.status === "fulfilled")!.value,
        );
        assert.equal(credential.scope.userId, memberRow.userId);
        assert.equal(credential.scope.connectionId, `account-${workspaceId}`);
        assert.equal((await mobile(credential, "auth/session")).status, 200);
        assert.equal(
          (await mobile(credential, "snapshot", undefined, otherWorkspaceId))
            .status,
          403,
        );
        assert.equal(
          (await mobile(credential, "snapshot", undefined, "a")).status,
          401,
        );
        assert.equal((await mobile(credential, "snapshot")).data.cursor, 0);
        assert.equal(
          (await mobile(credential, "server")).data.configuredServices
            .interpretation,
          "disabled",
        );
        assert.equal((await mobile(credential, "voice")).data.enabled, false);
        assert.equal((await send()).status, 503);
        assert.equal(modelCalls + crmCalls + voiceCalls + globalCrmCalls, 0);
        const serialized = JSON.stringify(
          db.prepare("SELECT * FROM agent_mobile_session").all(),
        );
        assert(!serialized.includes(credential.accessToken));
        assert(
          serialized.includes(
            createHash("sha256").update(credential.accessToken).digest("hex"),
          ),
        );
        other = await pair(owner);
        const code = issuePairingCode(config.dataDirectory, "test-legacy", "a");
        const legacy = CredentialSchema.parse(
          await authRequest(`${origin}/v1/a`, "pair", fetch, undefined, code),
        );
        assert.equal((await mobile(legacy, "snapshot")).status, 200);
        assert.equal(
          (await mobile(legacy, "snapshot", undefined, workspaceId)).status,
          401,
        );
      },
    );
    config.administration!.identity!.mobile.model = "instance";
    await restart();
    const aiPath = `api/identity/ai?${new URLSearchParams(target)}`;
    const ai = (await owner(aiPath)).data;
    assert.equal(
      (
        await owner("api/identity/ai", {
          ...target,
          revision: ai.revision,
          selection: { modelId: "instance", voiceId: null },
        })
      ).status,
      200,
    );
    const connectionsPath = `api/identity/connections?${new URLSearchParams(target)}`;
    const configure = (input: object) =>
      owner("api/identity/connections/command", { ...target, ...input });
    const inventory = async () => (await owner(connectionsPath)).data;
    let connectionId!: string;
    let receiptCommand!: Command;
    await t.test(
      "explicit CRM binding, independent grants, cards and idempotency",
      async () => {
        assert.equal((await mobile(credential, "auth/session")).status, 200);
        decision = crmDecision;
        assert.equal((await send()).status, 503);
        assert.equal(modelInput?.testCrmRead, false);
        assert.equal(crmCalls + globalCrmCalls, 0);
        const created = await configure({
          type: "create",
          provider: "twenty-test",
          name: "TEST CRM",
          origin: "https://crm.example.test",
          apiKey: "TEST-mobile-crm-synthetic-key-only",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        });
        assert.equal(created.status, 200, JSON.stringify(created.data));
        let list = await inventory();
        connectionId = list.connections[0].id;
        await configure({
          type: "configure",
          connectionId,
          revision: list.connections[0].revision,
          enabled: true,
          grants: [
            { toolId: "crm.contacts.list", roles: ["member"] },
            { toolId: "crm.contacts.search", roles: [] },
          ],
        });
        assert.equal((await send()).status, 503);
        assert.equal(crmCalls, 0);
        list = await inventory();
        assert.equal(
          (
            await configure({
              type: "selectAgentConnection",
              connectionId,
              bindingRevision: list.bindingRevision,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await configure({
              type: "selectAgentConnection",
              connectionId: null,
              bindingRevision: list.bindingRevision,
            })
          ).status,
          409,
        );
        receiptCommand = messageCommand("TEST list", "cs", randomUUID());
        const result = await send(receiptCommand);
        assert.equal(result.status, 202);
        assert.equal(modelInput?.testCrmRead, true);
        assert.equal(modelInput?.testCrmSearch, false);
        const messages = result.data.snapshot.conversations[0].messages;
        assert.equal(messages.at(-1).result.type, "crm.contacts");
        assert.equal(
          messages.at(-1).result.contacts[0].name,
          "TEST Jana Nováková",
        );
        const calls = modelCalls + crmCalls;
        const auditPath = `api/identity/audit?${new URLSearchParams({ organizationId, workspaceId, category: "tools" })}`;
        const auditBefore = (await owner(auditPath)).data;
        assert.equal(auditBefore.entries[0].source, "chat");
        assert.equal(auditBefore.entries[0].outcome, "succeeded");
        assert.equal(auditBefore.entries[0].actorId, memberRow.userId);

        assert.deepEqual((await send(receiptCommand)).data, result.data);
        assert.equal(modelCalls + crmCalls, calls);
        assert.deepEqual((await owner(auditPath)).data, auditBefore);

        assert.equal((await mobile(other, "snapshot")).data.cursor, 0);
        assert.equal(globalCrmCalls, 0);
        list = await inventory();
        await configure({
          type: "configure",
          connectionId,
          revision: list.connections[0].revision,
          enabled: true,
          grants: [
            { toolId: "crm.contacts.list", roles: [] },
            { toolId: "crm.contacts.search", roles: ["member"] },
          ],
        });
        decision = reply;
        assert.equal((await send()).status, 202);
        assert.equal(modelInput?.testCrmRead, false);
        assert.equal(modelInput?.testCrmSearch, true);
        list = await inventory();
        await configure({
          type: "configure",
          connectionId,
          revision: list.connections[0].revision,
          enabled: true,
          grants: [
            { toolId: "crm.contacts.list", roles: ["member"] },
            { toolId: "crm.contacts.search", roles: ["member"] },
          ],
        });
      },
    );
    await t.test(
      "receipt replay remains available after model sharing is disabled",
      async () => {
        config.administration!.identity!.mobile.model = "disabled";
        await restart();
        const before = modelCalls;
        assert.equal((await send(receiptCommand)).status, 202);
        assert.equal((await send()).status, 503);
        assert.equal(modelCalls, before);
        // Non-model commands reach workflow validation instead of the model gate.
        const invalidProposal = {
          type: "proposal.decide",
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          conversationId: "conversation-main",
          workItemId: "missing",
          proposalId: "missing",
          expectedProposalRevision: 1,
          decision: "reject",
        };
        assert.notEqual(
          (await mobile(credential, "commands", invalidProposal)).status,
          503,
        );
        config.administration!.identity!.mobile.model = "instance";
        await restart();
      },
    );
    async function revokedDuring(
      kind: "model" | "crm",
      change: () => Promise<unknown>,
    ) {
      const held = hold();
      if (kind === "model") modelGate = held.gate;
      else crmGate = held.gate;
      decision = kind === "crm" ? crmDecision : reply;
      const before = (await mobile(credential, "snapshot")).data.cursor;
      const pending = send();
      await Promise.race([
        held.started,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(Error("No provider call")),
            4000,
          );
          timer.unref();
        }),
      ]);
      try {
        assert.equal((await owner(connectionsPath)).status, 200);
        await change();
      } finally {
        held.release();
        modelGate = undefined;
        crmGate = undefined;
      }
      assert.notEqual((await pending).status, 202);
      const snapshot = await mobile(credential, "snapshot");
      if (snapshot.status === 200) assert.equal(snapshot.data.cursor, before);
    }
    await t.test(
      "in-flight model and tool results cannot survive policy or session revocation",
      async () => {
        await revokedDuring("model", async () => {
          const list = await inventory();
          await configure({
            type: "selectAgentConnection",
            connectionId: null,
            bindingRevision: list.bindingRevision,
          });
        });
        let list = await inventory();
        await configure({
          type: "selectAgentConnection",
          connectionId,
          bindingRevision: list.bindingRevision,
        });
        await revokedDuring("crm", async () => {
          await command("setWorkspaceMember", {
            memberId: memberRow.id,
            workspaceId,
            allowed: false,
          });
          await seedIdentityFixture(identity, {
            type: "setWorkspaceMember",
            organizationId,
            ...{
              memberId: memberRow.id,
              workspaceId,
              allowed: true,
            },
          });
        });
        assert.equal((await mobile(credential, "auth/session")).status, 401);
        credential = await pair();
        await revokedDuring("model", () => member("api/logout", {}));
        assert.equal((await mobile(credential, "auth/session")).status, 401);
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        });
        credential = await pair();
        await revokedDuring("crm", () =>
          command("changeRole", { memberId: memberRow.id, role: "admin" }),
        );
        assert.equal((await mobile(credential, "auth/session")).status, 401);
        await command("changeRole", { memberId: memberRow.id, role: "member" });
        credential = await pair();
      },
    );
    await t.test(
      "voice sharing is opt-in and revocation during transcription discards the text",
      async () => {
        const request = {
          profile: VOICE_PROFILE,
          requestId: randomUUID(),
          language: "cs",
          context: {
            conversationId: (await mobile(credential, "snapshot")).data
              .conversations[0].id,
          },
          audio: { mimeType: "audio/wav", base64: "AAAA" },
        };
        assert.equal(
          (await mobile(credential, "voice/transcriptions", request)).status,
          503,
        );
        assert.equal(voiceCalls, 0);
        config.administration!.identity!.mobile.voice = "instance";
        await restart();
        const aiVoice = (await owner(aiPath)).data;
        assert.equal(
          (
            await owner("api/identity/ai", {
              ...target,
              revision: aiVoice.revision,
              selection: { modelId: "instance", voiceId: "instance" },
            })
          ).status,
          200,
        );
        const held = hold();
        voiceGate = held.gate;
        const pending = mobile(credential, "voice/transcriptions", request);
        await held.started;
        try {
          await member("api/identity/mobile/revoke", target);
        } finally {
          held.release();
          voiceGate = undefined;
        }
        const response = await pending;
        assert.equal(response.status, 401);
        assert.equal("text" in response.data, false);
        assert.equal((await mobile(other, "auth/session")).status, 200);
        credential = await pair();
        assert.equal(
          (
            await mobile(credential, "voice/transcriptions", {
              ...request,
              requestId: randomUUID(),
            })
          ).status,
          200,
        );
        const catalogPath = `api/identity/catalog?organizationId=${organizationId}&workspaceId=${workspaceId}`;
        const routing = (await owner(catalogPath)).data.routing;
        assert.equal(
          (
            await owner(
              `api/identity/mobile?organizationId=${organizationId}&workspaceId=${workspaceId}`,
            )
          ).data.voiceEnabled,
          true,
        );
        assert.equal(
          (
            await owner("api/identity/catalog/command", {
              ...target,
              type: "saveRouting",
              routing: {
                ...routing,
                voiceMode: "disabled",
                voiceModelId: null,
              },
            })
          ).status,
          200,
        );
        assert.equal((await mobile(credential, "voice")).data.enabled, false);
        assert.equal(
          (
            await owner(
              `api/identity/mobile?organizationId=${organizationId}&workspaceId=${workspaceId}`,
            )
          ).data.voiceEnabled,
          false,
        );
        assert.equal(
          (
            await mobile(
              credential,
              "auth/session",
              undefined,
              workspaceId,
              "DELETE",
            )
          ).status,
          204,
        );
        assert.equal((await mobile(credential, "auth/session")).status, 401);
        credential = await pair();
        db.prepare(
          "UPDATE agent_mobile_session SET expires_at=0 WHERE user_id=?",
        ).run(memberRow.userId);
        assert.equal((await mobile(credential, "auth/session")).status, 401);
        assert.equal(globalCrmCalls, 0);
      },
    );
    await t.test(
      "pending codes can be revoked and device capacity spans workspaces",
      async () => {
        await restart();
        const pending = (await issue()).data;
        await member("api/identity/mobile/revoke", target);
        await assert.rejects(
          authRequest(pending.address, "pair", fetch, undefined, pending.code),
        );
        for (let i = 0; i < 8; i++) await pair();
        await seedIdentityFixture(identity, {
          type: "setWorkspaceMember",
          organizationId,
          ...{
            memberId: memberRow.id,
            workspaceId: otherWorkspaceId,
            allowed: true,
          },
        });
        const status = await member(
          `api/identity/mobile?${new URLSearchParams({ organizationId, workspaceId: otherWorkspaceId })}`,
        );
        assert.equal(status.data.activeDevices, 0);
        assert.equal(status.data.availableDeviceSlots, 0);
        const denied = await issue(member, { workspaceId: otherWorkspaceId });
        assert.equal(denied.status, 409);
        assert.equal(denied.data.error, "mobile_device_limit");
        await member("api/identity/mobile/revoke", target);
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.emit("close");
    await identity.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
