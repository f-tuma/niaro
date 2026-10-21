import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import {
  createReferenceServer,
  type ServerAdapters,
} from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { messageCommand } from "../packages/client-core/commands";
import {
  CredentialSchema,
  AUTH_PROFILE,
  PROFILE,
  type Credential,
  type Command,
} from "../packages/protocol";
import { WorkspaceAISchema } from "../packages/protocol/workspace-ai";
import type { Decision } from "../apps/fixture-server/decision";
import { VOICE_PROFILE } from "../packages/protocol/voice";

function hold() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return {
    entered,
    release,
    wait,
    started: () =>
      Promise.race([
        started,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(Error("Provider did not start")),
            3000,
          );
          t.unref();
        }),
      ]),
  };
}
const password = "TEST-ai-password-only-2026";
test("Workspace AI: administrator policy, routing, audit and live changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-ai-test-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST AI",
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
  let modelGate: ReturnType<typeof hold> | undefined,
    voiceGate: ReturnType<typeof hold> | undefined;
  let expireOnCrm = false;
  let wantContacts = false;
  let expiresAt = "2099-01-01T00:00:00Z";
  const calls = { alpha: 0, beta: 0, voiceA: 0, voiceB: 0 };
  const decision = (text: string): Decision => ({
    kind: "reply",
    reply: text,
    contactId: null,
    title: null,
    localStart: null,
    durationMinutes: null,
  });
  const adapters: ServerAdapters = {
    aiProfiles: {
      models: [
        {
          id: "alpha",
          label: "TEST Alpha model",
          provider: "custom",
          adapter: {
            timeZone: "Europe/Prague",
            async decide(): Promise<Decision> {
              calls.alpha++;
              await modelGate?.wait;
              return decision("TEST Alpha reply");
            },
          },
        },
        {
          id: "beta",
          label: "TEST Beta model",
          provider: "custom",
          adapter: Object.assign(
            {
              timeZone: "UTC",
              async decide(): Promise<Decision> {
                calls.beta++;
                const gate = modelGate;
                gate?.entered();
                await gate?.wait;
                return wantContacts
                  ? { ...decision("unused"), kind: "crm_contacts", reply: null }
                  : decision("TEST Beta reply");
              },
            },
            {
              get adminInfo() {
                return { model: "TEST beta", expiresAt };
              },
            },
          ),
        },
      ],
      voices: [
        {
          id: "voice-a",
          label: "TEST Voice A",
          provider: "custom",
          adapter: {
            async transcribe() {
              calls.voiceA++;
              return { text: "TEST Voice A", reviewReasons: [] };
            },
          },
        },
        {
          id: "voice-b",
          label: "TEST Voice B",
          provider: "custom",
          adapter: {
            async transcribe() {
              calls.voiceB++;
              const gate = voiceGate;
              gate?.entered();
              await gate?.wait;
              return { text: "TEST Voice B", reviewReasons: [] };
            },
          },
        },
      ],
    },
  };
  // Keep metadata dynamic so expiry can cross the boundary during provider I/O.
  Object.defineProperty(adapters.aiProfiles!.models[1]!.adapter, "adminInfo", {
    get: () => ({ model: "TEST beta", expiresAt }),
  });
  const connectionTransport: typeof fetch = async () => {
    if (expireOnCrm) expiresAt = "2020-01-01T00:00:00Z";
    return Response.json({ data: { people: [] } });
  };
  let identity = await openIdentity(config, { connectionTransport });
  app = createReferenceServer(config, adapters, identity);
  const db = new DatabaseSync(join(root, "identity", "identity.sqlite"));
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(origin + "/admin/" + path, {
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
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: await res.json() };
    };
  }
  const owner = client(),
    admin = client(),
    member = client(),
    operator = client();
  async function mobile(credential: Credential, path: string, input?: unknown) {
    const res = await fetch(
      `${origin}/v1/${credential.scope.workspaceId}/${path}`,
      {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      },
    );
    return { status: res.status, data: await res.json() };
  }
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { connectionTransport });
    app = createReferenceServer(config, adapters, identity);
  };
  try {
    await operator("api/login", { key });
    await operator("api/identity/bootstrap", {
      name: "TEST Owner",
      email: "owner@example.test",
      password,
      organizationName: "TEST Alpha",
    });
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const organizationId = (await owner("api/identity")).data.organizations[0]
      .id;
    const command = (values: object) =>
      owner("api/identity/command", { organizationId, ...values });
    for (const name of ["TEST One", "TEST Two"])
      await command({ type: "createWorkspace", name });
    for (const role of ["admin", "member"])
      await seedIdentityFixture(identity, {
        organizationId,
        ...{
          type: "createAccount",
          name: `TEST ${role}`,
          email: `${role}@example.test`,
          password,
          role,
        },
      });
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const workspaceId = detail.workspaces[0].id,
      secondId = detail.workspaces[1].id;
    const target = { organizationId, workspaceId };
    await admin("auth/sign-in/email", {
      email: "admin@example.test",
      password,
    });
    await member("auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    await seedIdentityFixture(identity, {
      organizationId,
      ...{
        type: "setWorkspaceMember",
        workspaceId,
        memberId: detail.members.find((m: any) => m.role === "member").id,
        allowed: true,
      },
    });
    const path = `api/identity/ai?${new URLSearchParams(target)}`;
    const inventory = async () =>
      WorkspaceAISchema.parse((await owner(path)).data);
    const set = async (
      modelId: string | null,
      voiceId: string | null = null,
      who = owner,
    ) =>
      who("api/identity/ai", {
        ...target,
        revision: (await inventory()).revision,
        selection: { modelId, voiceId },
      });
    const pair = async (id = workspaceId) => {
      const issued = await owner("api/identity/mobile/pairing", {
        organizationId,
        workspaceId: id,
      });
      assert.equal(issued.status, 200);
      const res = await fetch(`${origin}/v1/${id}/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issued.data.code,
        }),
      });
      assert.equal(res.status, 200);
      return CredentialSchema.parse(await res.json());
    };
    const credential = await pair(),
      second = await pair(secondId);
    const send = async (c = credential, raw?: Command) => {
      const cmd = raw ?? messageCommand("TEST hello", "cs", randomUUID());
      return { command: cmd, ...(await mobile(c, "commands", cmd)) };
    };
    await t.test(
      "only current organization managers can select curated profiles",
      async () => {
        const initial = await inventory();
        assert.deepEqual(initial.selection, { modelId: null, voiceId: null });
        assert.equal(initial.revision, 0);
        assert.equal(
          (await mobile(credential, "server")).data.configuredServices
            .interpretation,
          "disabled",
        );
        // No model is a settled refusal, so the app can send again later.
        assert.equal((await send()).status, 422);
        assert.equal(calls.alpha + calls.beta, 0);
        for (const who of [member, operator]) {
          assert.equal((await who(path)).status, 403);
          assert.equal((await set("alpha", null, who)).status, 403);
        }
        assert.equal(
          (
            await owner("api/identity/ai", {
              ...target,
              organizationId: "test-other-org",
              revision: 0,
              selection: { modelId: "alpha", voiceId: null },
            })
          ).status,
          403,
        );
        assert.equal((await set("unlisted")).status, 400);
        assert.equal(
          (
            await owner("api/identity/ai", {
              ...target,
              revision: 0,
              selection: { modelId: "alpha", voiceId: null },
              apiKey: "TEST never accepted",
            })
          ).status,
          400,
        );
        assert.equal((await set("alpha", null, admin)).status, 200);
        assert.equal(
          (
            await owner("api/identity/ai", {
              ...target,
              revision: 0,
              selection: { modelId: "beta", voiceId: null },
            })
          ).status,
          409,
        );
        const adminId = detail.members.find((m: any) => m.role === "admin").id;
        await command({
          type: "changeRole",
          memberId: adminId,
          role: "member",
        });
        assert.equal((await set("beta", null, admin)).status, 403);
        await command({ type: "changeRole", memberId: adminId, role: "admin" });
        const original = await inventory();
        db.exec(
          "CREATE TRIGGER audit_ai_failure BEFORE INSERT ON agent_audit WHEN NEW.action='workspace.ai_changed' BEGIN SELECT RAISE(ABORT,'TEST failure'); END;",
        );
        try {
          assert.equal((await set("beta")).status, 503);
          assert.deepEqual(await inventory(), original);
        } finally {
          db.exec("DROP TRIGGER audit_ai_failure");
        }
        assert.equal(calls.alpha + calls.beta + calls.voiceA + calls.voiceB, 0);
      },
    );
    let committed!: Awaited<ReturnType<typeof send>>;
    async function replay() {
      const before = (await mobile(credential, "snapshot")).data;
      const result = await send(credential, committed.command);
      assert.equal(result.status, 202);
      assert.equal(result.data.commandId, committed.command.commandId);
      assert.deepEqual(result.data.snapshot, before);
    }
    await t.test(
      "routing is scoped, persists and replay never calls a new model",
      async () => {
        committed = await send();
        assert.equal(committed.status, 202);
        assert.equal(calls.alpha, 1);
        assert.equal((await send(second)).status, 422);
        assert.equal((await set("beta")).status, 200);
        assert.equal((await send()).status, 202);
        assert.equal(calls.beta, 1);
        await restart();
        assert.equal((await inventory()).selection.modelId, "beta");
        await replay();
        assert.equal(calls.alpha + calls.beta, 2);
        await set(null);
        assert.equal((await send()).status, 422);
        await replay();
      },
    );
    await t.test(
      "changing or expiring a model in flight discards its result",
      async () => {
        for (const expire of [false, true]) {
          expiresAt = "2099-01-01T00:00:00Z";
          await set("beta");
          const before = (await mobile(credential, "snapshot")).data.cursor;
          const gate = hold();
          modelGate = gate;
          const pending = send();
          await gate.started();
          try {
            if (expire) expiresAt = "2020-01-01T00:00:00Z";
            else {
              await set(null);
              await set("beta");
            }
          } finally {
            modelGate = undefined;
            gate.release();
          }
          assert.notEqual((await pending).status, 202);
          assert.equal(
            (await mobile(credential, "snapshot")).data.cursor,
            before,
          );
        }
        assert.equal((await set("beta")).status, 400);
        assert.equal(
          (await mobile(credential, "server")).data.configuredServices
            .interpretation,
          "disabled",
        );
        expiresAt = "2099-01-01T00:00:00Z";
      },
    );
    await t.test(
      "model expiry during CRM I/O blocks the final workflow commit",
      async () => {
        const cc = (value: object) =>
          owner("api/identity/connections/command", { ...target, ...value });
        assert.equal(
          (
            await cc({
              type: "create",
              name: "TEST CRM",
              provider: "twenty-test",
              origin: "https://crm.example.test",
              apiKey: "TEST-ai-synthetic-crm-key",
              expiresAt: "2099-01-01T00:00:00Z",
            })
          ).status,
          200,
        );
        const list = (
          await owner(`api/identity/connections?${new URLSearchParams(target)}`)
        ).data;
        const c = list.connections[0];
        await cc({
          type: "configure",
          connectionId: c.id,
          revision: c.revision,
          enabled: true,
          grants: [
            { toolId: "crm.contacts.list", roles: ["owner"] },
            { toolId: "crm.contacts.search", roles: [] },
          ],
        });
        await cc({
          type: "selectAgentConnection",
          connectionId: c.id,
          bindingRevision: list.bindingRevision,
        });
        await set("beta");
        const before = (await mobile(credential, "snapshot")).data.cursor;
        expireOnCrm = true;
        wantContacts = true;
        try {
          assert.notEqual((await send()).status, 202);
          assert.equal(
            (await mobile(credential, "snapshot")).data.cursor,
            before,
          );
          await replay();
        } finally {
          expireOnCrm = false;
          wantContacts = false;
          expiresAt = "2099-01-01T00:00:00Z";
        }
      },
    );
    await t.test(
      "voice policy uses the selected transcriber and rejects stale results",
      async () => {
        const request = () => ({
          profile: VOICE_PROFILE,
          requestId: randomUUID(),
          language: "cs",
          context: { conversationId: "conversation-main" },
          audio: { mimeType: "audio/wav", base64: "AAAA" },
        });
        const snapshot = (await mobile(credential, "snapshot")).data;
        const voice = () =>
          mobile(credential, "voice/transcriptions", {
            ...request(),
            context: { conversationId: snapshot.conversations[0].id },
          });
        assert.equal((await voice()).status, 503);
        await set("beta", "voice-a");
        assert.equal((await voice()).status, 200);
        assert.equal(calls.voiceA, 1);
        await set("beta", "voice-b");
        const gate = hold();
        voiceGate = gate;
        const pending = voice();
        await gate.started();
        try {
          await set("beta", null);
          await set("beta", "voice-b");
        } finally {
          voiceGate = undefined;
          gate.release();
        }
        assert.notEqual((await pending).status, 200);
        assert.equal(calls.voiceB, 1);
        await restart();
        assert.equal((await inventory()).selection.voiceId, "voice-b");
        assert.equal((await voice()).status, 200);
        const audit = (
          await owner(`api/identity/audit?organizationId=${organizationId}`)
        ).data.entries.filter((e: any) => e.action === "workspace.ai_changed");
        assert(audit.length > 0);
        assert(
          audit.every(
            (e: any) =>
              e.actorId &&
              e.targetId === workspaceId &&
              e.details.revision > e.details.previousRevision,
          ),
        );
        assert(!JSON.stringify(audit).includes(password));
        assert(!JSON.stringify(audit).includes("TEST Beta reply"));
      },
    );
  } finally {
    app.emit("close");
    await identity.close();
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
