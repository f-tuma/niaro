import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { issueAdminKey } from "../apps/server-admin/auth";
import { authRequest } from "../packages/client-core/auth";
import {
  SPEECH_PROFILE,
  SpeechResultSchema,
} from "../packages/protocol/speech";
import { messageCommand } from "../packages/client-core/commands";
import { CatalogSchema } from "../packages/protocol/service-catalog";
import type { IntegrationTransport } from "../apps/server-integrations/transport";

test("catalog speech routes are isolated, revocable, budgeted and preserve model usage references", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-voice-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Voice",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);

  let calls = 0;
  let zeroDataRetention = true;
  let beforeDispatch: (() => Promise<void>) | undefined;
  let afterDispatch: (() => Promise<void>) | undefined;
  const pcm = Buffer.alloc(480, 1).toString("base64");
  const transport: IntegrationTransport = async (req) => {
    if (!(req.body as { stream?: boolean }).stream) {
      await req.beforeDispatch?.(() => {});
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "TEST odpověď." },
              finish_reason: "stop",
            },
          ],
        }),
      };
    }
    await beforeDispatch?.();
    await req.beforeDispatch?.(() => {
      calls++;
    });
    assert.equal(req.headers?.Authorization, "Bearer TEST-private-voice-key");
    assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepEqual((req.body as { provider: unknown }).provider, {
      require_parameters: true,
      data_collection: "deny",
      zdr: zeroDataRetention,
    });
    await afterDispatch?.();
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      text:
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm } } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    };
  };
  const identity = await openIdentity(config, {
    integrationTransport: transport,
  });
  app = createReferenceServer(config, {}, identity);
  const cookies = new Map<string, string>();
  async function admin(path: string, input?: unknown) {
    const r = await fetch(`${origin}/admin/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "X-Agent-Admin": "1",
        "Content-Type": "application/json",
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(";")[0]!;
      const i = pair.indexOf("=");
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const data = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    return data;
  }
  try {
    await admin("api/login", { key });
    await admin("api/identity/bootstrap", {
      name: "TEST owner",
      email: "owner@example.test",
      password: "TEST-voice-password-2026",
      organizationName: "TEST Org",
    });
    await admin("auth/sign-in/email", {
      email: "owner@example.test",
      password: "TEST-voice-password-2026",
    });
    const org = (await admin("api/identity")).organizations[0].id;
    await admin("api/identity/command", {
      type: "createWorkspace",
      organizationId: org,
      name: "TEST Voice",
    });
    const ws = (await admin(`api/identity/organization?id=${org}`))
      .workspaces[0].id;
    const target = { organizationId: org, workspaceId: ws };
    const command = (input: object) =>
      admin("api/identity/catalog/command", { ...target, ...input });
    const inventory = async () =>
      CatalogSchema.parse(
        await admin(
          `api/identity/catalog?organizationId=${org}&workspaceId=${ws}`,
        ),
      );
    const provider = (
      await command({
        type: "saveProvider",
        revision: 0,
        settings: {
          name: "TEST OR",
          url: "https://openrouter.ai/api/v1",
          enabled: true,
          dailyRequestLimit: 10,
        },
        apiKey: "TEST-private-voice-key",
      })
    ).id;

    const model = (
      await command({
        type: "saveModel",
        revision: 0,
        settings: {
          providerId: provider,
          name: "TEST reader",
          model: "openai/gpt-audio-mini",
          kind: "chat",
          audioOutput: true,
          tools: false,
          enabled: true,
        },
      })
    ).id;
    const agent = (
      await command({
        type: "saveModel",
        revision: 0,
        settings: {
          providerId: provider,
          name: "TEST agent",
          model: "test/chat",
          kind: "chat",
          tools: true,
          enabled: true,
        },
      })
    ).id;
    const configure = async (enabled: boolean) => {
      await command({
        type: "saveRouting",
        routing: {
          ...(await inventory()).routing,
          modelId: agent,
          speech: {
            modelId: enabled ? model : null,
            method: "reader",
            voice: "alloy",
            zeroDataRetention,
          },
        },
      });
    };
    await configure(true);
    const grant = await admin("api/identity/mobile/pairing", target);
    const credential = await authRequest(
      grant.address,
      "pair",
      fetch,
      undefined,
      grant.code,
    );
    assert(credential);
    const bearer = `Bearer ${credential.accessToken}`;
    const post = (path: string, input: unknown) =>
      fetch(`${grant.address}/${path}`, {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    const initial = await post(
      "commands",
      messageCommand("Choose Peter", "en", "start"),
    ).then((r) => r.json());
    const conversation = initial.snapshot.conversations[0];
    const message = conversation.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    const request = {
      profile: SPEECH_PROFILE,
      requestId: "speech-test",
      language: "cs",
      conversationId: conversation.id,
      messageId: message.id,
    };
    const speak = () => post("voice/speech", request);
    const caps = await fetch(`${grant.address}/voice/speech`, {
      headers: { Authorization: bearer },
    }).then((r) => r.json());
    assert.equal(caps.enabled, true);
    assert.equal(caps.model, "openai/gpt-audio-mini");
    const reply = await speak();
    assert.equal(reply.status, 200);
    assert.equal(
      SpeechResultSchema.parse(await reply.json()).audio.mimeType,
      "audio/wav",
    );
    assert.equal(calls, 1);
    assert.equal((await inventory()).providers[0]!.requestsToday, 2);
    beforeDispatch = () => configure(false);
    assert.equal((await speak()).status, 503);
    assert.equal(calls, 1);
    beforeDispatch = undefined;
    zeroDataRetention = false;
    await configure(true);
    afterDispatch = () => configure(false);
    assert.equal((await speak()).status, 503);
    assert.equal(calls, 2);
    afterDispatch = undefined;
    await configure(true);
    const p = (await inventory()).providers[0]!;
    await command({
      type: "saveProvider",
      id: p.id,
      revision: p.revision,
      settings: {
        name: p.name,
        url: p.url,
        enabled: true,
        dailyRequestLimit: 3,
      },
    });
    const limited = await speak();
    assert.equal(limited.status, 503);
    assert.equal((await limited.json()).error, "speech_model_limit");
    assert.equal(calls, 2);
    assert(
      !JSON.stringify(await inventory()).includes("TEST-private-voice-key"),
    );
  } finally {
    await new Promise<void>((r, e) =>
      server.close((err) => (err ? e(err) : r())),
    );
    app.emit("close");
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
});
