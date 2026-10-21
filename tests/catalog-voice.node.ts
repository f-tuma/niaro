import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { issueAdminKey } from "../apps/server-admin/auth";
import { authRequest } from "../packages/client-core/auth";
import { VOICE_PROFILE, VoiceRequestSchema } from "../packages/protocol/voice";
import { CatalogSchema } from "../packages/protocol/service-catalog";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import { VoiceError } from "../apps/fixture-server/voice";

for (const method of ["interpreter", "transcription"] as const) {
  const modelId =
    method === "interpreter"
      ? "google/gemini-3.1-flash-lite"
      : "openai/gpt-4o-mini-transcribe";
  test(`Catalog voice ${method} uses workspace provider, is revocable, budgeted and explicitly disabled`, async () => {
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
    let calls = 0,
      silence = false,
      invalid = false;
    let beforeDispatch: (() => Promise<void>) | undefined,
      afterDispatch: (() => Promise<void>) | undefined;
    const transport: IntegrationTransport = async (req) => {
      await beforeDispatch?.();
      await req.beforeDispatch?.(() => {
        calls++;
      });
      const body = req.body as {
        model: string;
        messages?: { content: unknown }[];
        input_audio?: { data: string; format: string };
        language?: string;
        provider?: unknown;
      };
      assert.equal(
        req.url,
        `https://openrouter.ai/api/v1/${method === "interpreter" ? "chat/completions" : "audio/transcriptions"}`,
      );
      assert.equal(req.headers?.Authorization, "Bearer TEST-private-voice-key");
      assert.equal(body.model, modelId);
      if (method === "interpreter") {
        assert.match(String(body.messages![0]!.content), /přepisovač/);
        assert.equal(body.input_audio, undefined);
        assert.deepEqual(body.provider, {
          require_parameters: true,
          data_collection: "deny",
          zdr: true,
        });
      } else {
        assert.equal(body.messages, undefined);
        assert.equal(body.provider, undefined);
        assert.equal(body.language, undefined);
        assert.deepEqual(body.input_audio, {
          data: Buffer.from("TEST audio").toString("base64"),
          format: "wav",
        });
      }
      assert(req.maxRequestBytes! > 262144);
      await afterDispatch?.();
      return {
        status: 200,
        headers: {},
        text: JSON.stringify(
          method === "transcription"
            ? { text: invalid ? 42 : "TEST přepis" }
            : {
                choices: [
                  {
                    finish_reason: invalid ? "length" : "stop",
                    message: { content: "TEST přepis" },
                  },
                ],
              },
        ),
      };
    };
    const identity = await openIdentity(config, {
      integrationTransport: transport,
      speechProcessor: {
        async process(request, signal, client) {
          if (silence) throw new VoiceError("voice_empty");
          return {
            text: await client.transcribe(
              Buffer.from("TEST audio"),
              request.language,
              signal,
            ),
            reviewReasons: [],
          };
        },
      },
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
      assert.equal((await inventory()).voiceAvailable, true);
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
      const voice = (
        await command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId: provider,
            name: "TEST voice",
            model: modelId,
            kind: method === "interpreter" ? "chat" : "transcription",
            audioInput: method === "interpreter",
            tools: false,
            enabled: true,
          },
        })
      ).id;
      const configure = async (mode: "catalog" | "disabled") =>
        command({
          type: "saveRouting",
          routing: {
            ...(await inventory()).routing,
            voiceModelId: mode === "catalog" ? voice : null,
            voiceMode: mode,
            voiceMethod: method,
          },
        });
      await configure("catalog");
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
      const access = () =>
        identity.mobileAccess(bearer, ws, credential.scope.serverId);
      const request = VoiceRequestSchema.parse({
        profile: VOICE_PROFILE,
        requestId: randomUUID(),
        language: "cs",
        context: { conversationId: "TEST" },
        audio: { mimeType: "audio/wav", base64: "AAAA" },
      });
      const transcribe = async () =>
        (await access()).transcriber!.transcribe(
          request,
          new AbortController().signal,
        );
      const caps = await fetch(`${grant.address}/voice`, {
        headers: { Authorization: bearer },
      }).then((r) => r.json());
      assert.equal(caps.profile, VOICE_PROFILE);
      assert.equal(caps.model, modelId);
      assert.equal(caps.enabled, true);
      assert.deepEqual(await transcribe(), {
        text: "TEST přepis",
        reviewReasons: [],
      });
      assert.equal(calls, 1);
      assert.equal((await inventory()).providers[0]!.requestsToday, 1);
      silence = true;
      await assert.rejects(transcribe, /voice_empty/);
      silence = false;
      assert.equal(calls, 1);
      beforeDispatch = () => configure("disabled");
      await assert.rejects(transcribe, /voice_processing_failed/);
      assert.equal(calls, 1);
      beforeDispatch = undefined;
      assert.equal((await access()).transcriber, undefined);
      assert.equal(
        (
          await admin(
            `api/identity/mobile?organizationId=${org}&workspaceId=${ws}`,
          )
        ).voiceEnabled,
        false,
      );
      await configure("catalog");
      afterDispatch = () => configure("disabled");
      await assert.rejects(transcribe, /voice_processing_failed/);
      assert.equal(calls, 2);
      afterDispatch = undefined;
      await configure("catalog");
      invalid = true;
      await assert.rejects(transcribe, /voice_processing_failed/);
      invalid = false;
      assert.equal(calls, 3);
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
      await assert.rejects(transcribe, /voice_model_limit/);
      assert.equal(calls, 3);
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
}
