import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import { seedIdentityFixture } from "./helpers/identity-seed";
import { FixtureAuth } from "../apps/fixture-server/auth";
import type {
  IntegrationTransport,
  TransportRequest,
} from "../apps/server-integrations/transport";
import { reviewedSpeechVoices } from "../apps/server-integrations/speech-voices";
import { authRequest } from "../packages/client-core/auth";
import { messageCommand } from "../packages/client-core/commands";
import {
  CredentialSchema,
  SnapshotSchema,
  type Credential,
} from "../packages/protocol";
import {
  CatalogCommand,
  CatalogSchema,
} from "../packages/protocol/service-catalog";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import {
  OUTPUT_VOICE_PROFILE,
  OutputVoiceSnapshotSchema,
  type OutputVoiceChoice,
} from "../packages/protocol/output-voice";
import {
  SPEECH_PROFILE,
  SpeechCapabilitiesSchema,
  SpeechResultSchema,
} from "../packages/protocol/speech";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const text = "TEST spoken reply stays exactly the same.";

test(
  "personal output dispatch uses the production closure and HTTP guards with held synthetic transport",
  { timeout: 45000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "output-voice-dispatch-"));
    let app: ReturnType<typeof createReferenceServer>;
    const server = createServer((req, res) => app.emit("request", req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const config = ServerConfigSchema.parse({
      version: 1,
      name: "TEST voice dispatch",
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
    let before: ((req: TransportRequest) => Promise<void>) | undefined;
    let after: ((req: TransportRequest) => Promise<void>) | undefined;
    let transcript: string | undefined;
    let refusal = 0,
      paid = 0,
      modelCalls = 0,
      speechRequests = 0;
    const voices: string[] = [];
    const models: string[] = [];
    const releases: (() => void)[] = [];
    const transport: IntegrationTransport = async (req) => {
      const body = req.body as { audio?: { voice: string }; stream?: boolean };
      if (!body.audio) {
        await req.beforeDispatch?.(() => {
          modelCalls++;
        });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
          }),
        };
      }
      speechRequests++;
      await before?.(req);
      let started = false;
      await req.beforeDispatch?.(() => {
        started = true;
        paid++;
        voices.push(body.audio!.voice);
        models.push((req.body as { model: string }).model);
      });
      assert(
        started,
        "every actual attempt must enter the production dispatch guard",
      );
      assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
      await after?.(req);
      if (refusal)
        return {
          status: refusal,
          headers: { "content-type": "application/json" },
          text: "TEST provider refusal",
        };
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        text:
          `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.alloc(480, 1).toString("base64"), ...(transcript === undefined ? {} : { transcript }) } } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      };
    };
    const identity = await openIdentity(config, {
      integrationTransport: transport,
    });
    app = createReferenceServer(config, {}, identity);
    const cookies = new Map<string, string>();
    async function admin(path: string, input?: unknown) {
      const response = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const c of response.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const data: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    }
    const call = (
      credential: Credential,
      path: string,
      input?: unknown,
      signal?: AbortSignal,
    ) =>
      fetch(`${origin}/v1/${credential.scope.workspaceId}/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: signal ?? AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
    const settingsPath = `voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}`;
    const read = async (credential: Credential) => {
      const res = await call(credential, settingsPath);
      assert.equal(res.status, 200);
      return OutputVoiceSnapshotSchema.parse(await res.json());
    };
    const save = async (credential: Credential, choice: OutputVoiceChoice) => {
      const snapshot = await read(credential);
      const res = await call(credential, settingsPath, {
        profile: OUTPUT_VOICE_PROFILE,
        requestId: randomUUID(),
        expectedRevision: snapshot.revision,
        catalogueRevision: snapshot.catalogueRevision,
        choice,
      });
      assert.equal(res.status, 200, await res.clone().text());
      return OutputVoiceSnapshotSchema.parse(await res.json());
    };
    const select = async (credential: Credential, label: string) => {
      const snapshot = await read(credential);
      const option = snapshot.options.find((o) => o.label === label);
      assert(option);
      return save(credential, { kind: "catalogue", optionId: option.optionId });
    };
    type Source = {
      conversationId: string;
      messageId: string;
      requestId: string;
      profile: typeof SPEECH_PROFILE;
      language: "en";
    };
    const source = async (credential: Credential): Promise<Source> => {
      const response = await call(
        credential,
        "commands",
        messageCommand("TEST make a reply", "en", randomUUID()),
      );
      assert(
        [200, 202].includes(response.status),
        await response.clone().text(),
      );
      const result = (await response.json()) as { snapshot: unknown };
      const snapshot = SnapshotSchema.parse(result.snapshot);
      const conversation = snapshot.conversations[0]!;
      const message = conversation.messages
        .filter((m) => m.role === "assistant")
        .at(-1);
      assert(message);
      return {
        profile: SPEECH_PROFILE,
        requestId: randomUUID(),
        language: "en",
        conversationId: conversation.id,
        messageId: message.id,
      };
    };
    const speak = (
      credential: Credential,
      message: Source,
      signal?: AbortSignal,
    ) => call(credential, "voice/speech", message, signal);
    const success = async (response: Response) => {
      assert.equal(response.status, 200, await response.clone().text());
      const result = SpeechResultSchema.parse(await response.json());
      assert.equal(result.audio.mimeType, "audio/wav");
      assert.deepEqual(Object.keys(result).sort(), [
        "audio",
        "conversationId",
        "language",
        "messageId",
        "profile",
        "requestId",
        "scope",
      ]);
      return result;
    };
    try {
      await admin("api/login", { key });
      const password = "TEST-voice-dispatch-password-2026";
      await admin("api/identity/bootstrap", {
        name: "TEST Owner",
        email: "dispatch-owner@example.test",
        password,
        organizationName: "TEST Dispatch",
      });
      await admin("auth/sign-in/email", {
        email: "dispatch-owner@example.test",
        password,
      });
      const state = IdentityStateSchema.parse(await admin("api/identity"));
      const organizationId = state.organizations[0]!.id;
      await admin("api/identity/command", {
        type: "createWorkspace",
        organizationId,
        name: "TEST Speech",
      });
      const workspaceId = OrganizationDetailSchema.parse(
        await admin(`api/identity/organization?id=${organizationId}`),
      ).workspaces[0]!.id;
      const target = { organizationId, workspaceId };
      const inventory = async () =>
        CatalogSchema.parse(
          await admin(`api/identity/catalog?${new URLSearchParams(target)}`),
        );
      const command = (input: object) =>
        admin("api/identity/catalog/command", { ...target, ...input });
      const providerId = (
        (await command({
          type: "saveProvider",
          revision: 0,
          settings: {
            name: "TEST OR",
            url: "https://openrouter.ai/api/v1",
            enabled: true,
            dailyRequestLimit: 1000,
          },
          apiKey: "TEST-not-a-real-provider-key",
        })) as { id: string }
      ).id;
      const modelId = (
        (await command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId,
            name: "TEST Reader",
            model: "openai/gpt-audio-mini",
            kind: "chat",
            audioOutput: true,
            tools: false,
            enabled: true,
          },
        })) as { id: string }
      ).id;
      const agentId = (
        (await command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId,
            name: "TEST Agent",
            model: "test/chat",
            kind: "chat",
            tools: true,
            enabled: true,
          },
        })) as { id: string }
      ).id;
      const configure = async (patch: object = {}, ws = workspaceId) => {
        const inv = CatalogSchema.parse(
          await admin(
            `api/identity/catalog?${new URLSearchParams({ organizationId, workspaceId: ws })}`,
          ),
        );
        await admin("api/identity/catalog/command", {
          type: "saveRouting",
          organizationId,
          workspaceId: ws,
          routing: {
            ...inv.routing,
            modelId: agentId,
            speech: {
              modelId,
              method: "reader",
              voice: "cedar",
              zeroDataRetention: false,
              ...patch,
            },
          },
        });
      };
      await configure();
      const grant = (await admin("api/identity/mobile/pairing", target)) as {
        address: string;
        code: string;
      };
      const mobile = CredentialSchema.parse(
        await authRequest(grant.address, "pair", fetch, undefined, grant.code),
      );
      const issue = async (ws = workspaceId) =>
        CredentialSchema.parse(
          (
            (await admin("api/identity/app/session", {
              organizationId,
              workspaceId: ws,
            })) as { credential: unknown }
          ).credential,
        );
      const web = await issue();
      let message = await source(mobile);
      await t.test(
        "current configured Cedar and exact personal Echo reach actual audio.voice without legacy fields",
        async () => {
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "cedar");
          await select(web, "Echo");
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "echo");
          SpeechCapabilitiesSchema.parse(
            await call(web, "voice/speech").then((r) => r.json()),
          );
        },
      );
      const updateProvider = async (patch: object) => {
        const provider = (await inventory()).providers.find(
          (p) => p.id === providerId,
        )!;
        await command({
          type: "saveProvider",
          id: provider.id,
          revision: provider.revision,
          settings: {
            name: provider.name,
            url: provider.url,
            enabled: provider.enabled,
            dailyRequestLimit: provider.dailyRequestLimit,
            ...patch,
          },
        });
      };
      const updateModel = async (patch: object) => {
        const model = (await inventory()).models.find((m) => m.id === modelId)!;
        await command({
          type: "saveModel",
          id: model.id,
          revision: model.revision,
          settings: {
            providerId: model.providerId,
            name: model.name,
            model: model.model,
            kind: model.kind,
            audioOutput: model.audioOutput,
            tools: model.tools,
            enabled: model.enabled,
            ...patch,
          },
        });
      };
      await t.test(
        "default-only edits preserve explicit voice; reset and stale epoch follow today's Cedar",
        async () => {
          await configure({ voice: "shimmer" });
          assert.equal((await read(web)).effective.reason, "selected");
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "echo");
          await save(web, { kind: "server-default" });
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "shimmer");
          await select(web, "Echo");
          await configure({ modelId: null });
          await configure();
          assert.equal(
            (await read(web)).effective.reason,
            "saved-choice-unavailable",
          );
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "cedar");
          const unavailable = await read(web);
          assert.equal(unavailable.saved!.choice.kind, "catalogue");
          await save(web, { kind: "server-default" });
          assert.equal((await read(web)).saved!.choice.kind, "server-default");
        },
      );
      await t.test(
        "retained runtime resolves the current route at invocation entry; unreviewed routes are default-only",
        async () => {
          const runtime = await identity.mobileAccess(
            `Bearer ${mobile.accessToken}`,
            workspaceId,
            new FixtureAuth(config.dataDirectory).serverId,
          );
          assert(runtime.synthesizer);
          const unknown = (
            (await command({
              type: "saveModel",
              revision: 0,
              settings: {
                providerId,
                name: "TEST unreviewed reader",
                model: "openai/gpt-audio",
                kind: "chat",
                audioOutput: true,
                tools: false,
                enabled: true,
              },
            })) as { id: string }
          ).id;
          await configure({ modelId: unknown, voice: "cedar" });
          const snapshot = await read(web);
          assert.equal(snapshot.availability, "server-default-only");
          assert.deepEqual(snapshot.options, []);
          const controller = new AbortController();
          const currentRuntime = await identity.mobileAccess(
            `Bearer ${mobile.accessToken}`,
            workspaceId,
            new FixtureAuth(config.dataDirectory).serverId,
          );
          await runtime.synthesizer.synthesize(
            text,
            "en",
            controller.signal,
            (start) => currentRuntime.run(start),
          );
          assert.equal(models.at(-1), "openai/gpt-audio");
          assert.equal(voices.at(-1), "cedar");
          await configure();
        },
      );
      const tts = (
        (await command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId,
            name: "TEST method invalidation only",
            model: "x-ai/grok-voice-tts-1.0",
            kind: "speech",
            tools: false,
            enabled: true,
          },
        })) as { id: string }
      ).id;
      const otherProvider = (
        (await command({
          type: "saveProvider",
          revision: 0,
          settings: {
            name: "TEST other OR",
            url: "https://openrouter.ai/api/v1",
            enabled: true,
            dailyRequestLimit: 1000,
          },
          apiKey: "TEST-other-not-real-key",
        })) as { id: string }
      ).id;
      const otherReader = (
        (await command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId: otherProvider,
            name: "TEST other reader",
            model: "openai/gpt-audio-mini",
            kind: "chat",
            audioOutput: true,
            tools: false,
            enabled: true,
          },
        })) as { id: string }
      ).id;
      const mutations: [string, () => Promise<unknown>][] = [
        ["default", () => configure({ voice: "shimmer" })],
        ["privacy", () => configure({ zeroDataRetention: true })],
        ["disabled route", () => configure({ modelId: null })],
        ["method", () => configure({ modelId: tts, method: "speech" })],
        ["provider identity", () => configure({ modelId: otherReader })],
        [
          "provider revision",
          () => updateProvider({ name: "TEST OR revision" }),
        ],
        ["model revision", () => updateModel({ name: "TEST reader revision" })],
        ["disabled provider", () => updateProvider({ enabled: false })],
        ["disabled model", () => updateModel({ enabled: false })],
        [
          "A to B to A epoch",
          async () => {
            await configure({ modelId: otherReader });
            await configure();
          },
        ],
      ];
      for (const stage of ["before", "after"] as const) {
        for (const [name, mutate] of mutations) {
          await t.test(
            `${stage} dispatch: ${name} invalidates the pin without another voice/provider`,
            async () => {
              await configure();
              await select(web, "Echo");
              const initialPaid = paid,
                initialRequests = speechRequests;
              if (stage === "before")
                before = async () => {
                  await mutate();
                };
              else
                after = async () => {
                  await mutate();
                };
              try {
                const res = await speak(mobile, message);
                assert.equal(res.status, 503, await res.clone().text());
                assert.equal((await res.json()).error, "speech_unavailable");
                assert.equal(paid - initialPaid, stage === "before" ? 0 : 1);
                assert.equal(speechRequests - initialRequests, 1);
              } finally {
                before = undefined;
                after = undefined;
                await updateProvider({ enabled: true });
                await updateModel({ enabled: true });
                await configure();
              }
            },
          );
        }
      }
      for (const stage of ["before", "after"] as const) {
        for (const change of ["default", "privacy", "epoch"] as const) {
          await t.test(
            `${stage} dispatch: lower catalogue ${change} mutation independently exercises the voice pin guard`,
            async () => {
              await configure();
              await select(web, "Echo");
              const policy =
                  identity["connections"].policyVersion(organizationId),
                start = paid;
              const mutate = async () => {
                const routing = (await inventory()).routing;
                await identity["serial"](async () => {
                  const write = (speech: typeof routing.speech) =>
                    identity["catalog"].store.command(
                      CatalogCommand.parse({
                        type: "saveRouting",
                        ...target,
                        routing: {
                          ...routing,
                          revision:
                            identity["catalog"].store["routing"](workspaceId)
                              .revision,
                          speech,
                        },
                      }),
                    );
                  if (change === "epoch") {
                    write({ ...routing.speech, modelId: otherReader });
                    write(routing.speech);
                    assert.equal(
                      identity["catalog"].store["routing"](workspaceId).speech
                        .modelId,
                      routing.speech.modelId,
                    );
                  } else
                    write({
                      ...routing.speech,
                      ...(change === "default"
                        ? { voice: "shimmer" }
                        : { zeroDataRetention: true }),
                    });
                });
                assert.equal(
                  identity["connections"].policyVersion(organizationId),
                  policy,
                  "lower store mutation must not trip the independent controller policy guard",
                );
              };
              if (stage === "before") before = mutate;
              else after = mutate;
              try {
                const response = await speak(mobile, message);
                assert.equal(response.status, 503);
                assert.equal(
                  (await response.json()).error,
                  "speech_unavailable",
                );
              } finally {
                before = undefined;
                after = undefined;
                await configure();
              }
              assert.equal(paid - start, stage === "before" ? 0 : 1);
            },
          );
        }
      }
      for (const stage of ["before", "after"] as const) {
        await t.test(
          `${stage} dispatch: removing the pinned allowed voice in isolated registry memory fails closed`,
          async () => {
            await configure();
            await select(web, "Echo");
            const route = await identity["serial"](async () =>
              identity["catalog"].store.speechVoiceRoute(
                organizationId,
                workspaceId,
              ),
            );
            const policy = reviewedSpeechVoices(route);
            assert(policy);
            // Synthetic process-local policy state only; the accepted source file is never edited.
            const options = policy.voices as unknown as {
              voice: string;
              label: string;
            }[];
            const original = [...options],
              start = paid;
            const remove = async () => {
              options.splice(
                options.findIndex((voice) => voice.voice === "echo"),
                1,
              );
            };
            if (stage === "before") before = remove;
            else after = remove;
            try {
              const response = await speak(mobile, message);
              assert.equal(response.status, 503);
            } finally {
              before = undefined;
              after = undefined;
              options.splice(0, options.length, ...original);
            }
            assert.equal(paid - start, stage === "before" ? 0 : 1);
            assert.equal((await read(web)).effective.label, "Echo");
          },
        );
      }
      await t.test(
        "the existing second verbatim attempt revalidates the route before spending again",
        async () => {
          await configure();
          await select(web, "Echo");
          const start = paid,
            attempts = speechRequests;
          after = async () => {
            transcript = "Different words that do not read the source.";
            const routing = (await inventory()).routing;
            await identity["serial"](async () =>
              identity["catalog"].store.command(
                CatalogCommand.parse({
                  type: "saveRouting",
                  ...target,
                  routing: {
                    ...routing,
                    speech: { ...routing.speech, zeroDataRetention: true },
                  },
                }),
              ),
            );
          };
          try {
            const response = await speak(mobile, message);
            assert.equal(response.status, 503);
          } finally {
            after = undefined;
            transcript = undefined;
            await configure();
          }
          assert.equal(paid - start, 1);
          assert.equal(speechRequests - attempts, 2);
          assert.deepEqual(voices.slice(start), ["echo"]);
        },
      );
      await t.test(
        "preference save during the existing verbatim retry retains one voice and charges each attempt once",
        async () => {
          await select(web, "Echo");
          const start = paid,
            usage = (await inventory()).providers.find(
              (p) => p.id === providerId,
            )!.requestsToday;
          let attempt = 0;
          after = async () => {
            if (++attempt === 1) {
              await select(web, "Shimmer");
              transcript = "Different words that do not read the source.";
            } else transcript = text;
          };
          try {
            await success(await speak(mobile, message));
          } finally {
            after = undefined;
            transcript = undefined;
          }
          assert.equal(paid - start, 2);
          assert.deepEqual(voices.slice(start), ["echo", "echo"]);
          assert.equal(
            (await inventory()).providers.find((p) => p.id === providerId)!
              .requestsToday - usage,
            2,
          );
          assert.equal((await read(web)).effective.label, "Shimmer");
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "shimmer");
        },
      );
      await t.test(
        "a preference-only save during a normal invocation changes only the next synthesis",
        async () => {
          await select(web, "Echo");
          const start = paid;
          after = async () => {
            await save(web, { kind: "server-default" });
          };
          try {
            await success(await speak(mobile, message));
          } finally {
            after = undefined;
          }
          assert.equal(paid - start, 1);
          assert.equal(voices.at(-1), "echo");
          await success(await speak(mobile, message));
          assert.equal(voices.at(-1), "cedar");
          assert.equal(paid - start, 2);
        },
      );
      await t.test(
        "nonverbatim audio has at most the existing two attempts; provider refusals get no fallback",
        async () => {
          await select(web, "Echo");
          transcript = "Wrong unrelated spoken words.";
          let start = paid;
          try {
            assert.equal((await speak(mobile, message)).status, 503);
          } finally {
            transcript = undefined;
          }
          assert.equal(paid - start, 2);
          assert.deepEqual(voices.slice(start), ["echo", "echo"]);
          for (const status of [400, 429, 503]) {
            start = paid;
            refusal = status;
            try {
              const res = await speak(mobile, message);
              assert.equal(res.status, 503);
              assert.equal(
                (await res.json()).error,
                status === 429 ? "speech_model_limit" : "speech_unavailable",
              );
            } finally {
              refusal = 0;
            }
            assert.equal(paid - start, 1);
          }
        },
      );
      for (const stage of ["before", "after"] as const) {
        await t.test(
          `${stage} dispatch: revoked credential with current membership withholds audio`,
          async () => {
            const temporary = await issue(),
              start = paid;
            const invalidate = async () => {
              await identity.revokeMobile(`Bearer ${temporary.accessToken}`);
            };
            if (stage === "before") before = invalidate;
            else after = invalidate;
            try {
              assert.equal((await speak(temporary, message)).status, 503);
            } finally {
              before = undefined;
              after = undefined;
            }
            assert.equal(paid - start, stage === "before" ? 0 : 1);
          },
        );
        await t.test(
          `${stage} dispatch: deleting the scoped assistant source fails the production HTTP text guard`,
          async () => {
            const start = paid;
            const invalidate = async () => {
              const id = randomUUID();
              const res = await call(mobile, "commands", {
                type: "conversation.delete",
                commandId: id,
                idempotencyKey: id,
                conversationId: message.conversationId,
                cancelOpenWork: true,
              });
              assert([200, 202].includes(res.status), await res.text());
            };
            if (stage === "before") before = invalidate;
            else after = invalidate;
            try {
              const res = await speak(mobile, message);
              assert.equal(res.status, 409, await res.clone().text());
              assert.equal((await res.json()).error, "speech_context_changed");
            } finally {
              before = undefined;
              after = undefined;
            }
            assert.equal(paid - start, stage === "before" ? 0 : 1);
            message = await source(mobile);
          },
        );
      }
      await t.test(
        "current workspace membership revocation guards both paid dispatch and audio return",
        async () => {
          await seedIdentityFixture(identity, {
            type: "createAccount",
            organizationId,
            name: "TEST Speech Member",
            email: "speech-member@example.test",
            password,
            role: "member",
          });
          const detail = OrganizationDetailSchema.parse(
            await admin(`api/identity/organization?id=${organizationId}`),
          );
          const member = detail.members.find(
            (m) => m.email === "speech-member@example.test",
          )!;
          for (const stage of ["before", "after"] as const) {
            await seedIdentityFixture(identity, {
              type: "setWorkspaceMember",
              ...target,
              memberId: member.id,
              allowed: true,
            });
            // Pair through the actual member's authenticated browser; no owner grant is reused.
            const response = await fetch(`${origin}/admin/auth/sign-in/email`, {
              method: "POST",
              headers: {
                Origin: origin,
                "X-Agent-Admin": "1",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ email: member.email, password }),
            });
            assert.equal(response.status, 200);
            await response.arrayBuffer();
            const memberCookie = response.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; ");
            const issued = await fetch(
              `${origin}/admin/api/identity/app/session`,
              {
                method: "POST",
                headers: {
                  Origin: origin,
                  "X-Agent-Admin": "1",
                  "Content-Type": "application/json",
                  Cookie: memberCookie,
                },
                body: JSON.stringify(target),
              },
            );
            assert.equal(issued.status, 200);
            const credential = CredentialSchema.parse(
              ((await issued.json()) as { credential: unknown }).credential,
            );
            const memberMessage = await source(credential),
              start = paid;
            const revoke = async () => {
              await admin("api/identity/command", {
                type: "setWorkspaceMember",
                ...target,
                memberId: member.id,
                allowed: false,
              });
            };
            if (stage === "before") before = revoke;
            else after = revoke;
            try {
              const result = await speak(credential, memberMessage);
              assert.equal(result.status, 503);
            } finally {
              before = undefined;
              after = undefined;
            }
            assert.equal(paid - start, stage === "before" ? 0 : 1);
            assert(
              [401, 403].includes((await call(credential, "snapshot")).status),
            );
          }
        },
      );
      await t.test(
        "raw client voice/text/provider injection is rejected before transport",
        async () => {
          const start = paid,
            requests = speechRequests;
          for (const extra of [
            { voice: "echo" },
            { providerId },
            { modelId },
            { text: "injected text" },
          ])
            assert.equal(
              (await call(mobile, "voice/speech", { ...message, ...extra }))
                .status,
              400,
            );
          assert.equal(paid, start);
          assert.equal(speechRequests, requests);
        },
      );
      await t.test(
        "daily provider limit applies per actual retry, without a speech ledger or free extra attempt",
        async () => {
          const usage = (await inventory()).providers.find(
            (p) => p.id === providerId,
          )!.requestsToday;
          await updateProvider({ dailyRequestLimit: usage + 1 });
          transcript = "Wrong unrelated spoken words.";
          const start = paid;
          try {
            const res = await speak(mobile, message);
            assert.equal(res.status, 503);
            assert.equal((await res.json()).error, "speech_model_limit");
          } finally {
            transcript = undefined;
            await updateProvider({ dailyRequestLimit: 1000 });
          }
          assert.equal(paid - start, 1);
          assert.equal(
            (await inventory()).providers.find((p) => p.id === providerId)!
              .requestsToday,
            usage + 1,
          );
        },
      );
      await t.test(
        "pre-aborted actual runtime invocation makes no provider attempt",
        async () => {
          const runtime = await identity.mobileAccess(
              `Bearer ${mobile.accessToken}`,
              workspaceId,
              new FixtureAuth(config.dataDirectory).serverId,
            ),
            controller = new AbortController(),
            start = paid;
          controller.abort();
          await assert.rejects(
            runtime.synthesizer!.synthesize(
              text,
              "en",
              controller.signal,
              (start) => runtime.run(start),
            ),
          );
          assert.equal(paid, start);
        },
      );
      const abortWait = (req: TransportRequest) =>
        new Promise<void>((_resolve, reject) => {
          assert(req.signal);
          if (req.signal.aborted) return reject(req.signal.reason);
          req.signal.addEventListener(
            "abort",
            () => reject(req.signal!.reason),
            { once: true },
          );
        });
      await t.test(
        "production HTTP deadline aborts its actual transport and releases concurrency",
        async () => {
          const original = setTimeout;
          const mock = t.mock.method(
            globalThis,
            "setTimeout",
            (...args: Parameters<typeof setTimeout>) => {
              if (args[1] === 65000) args[1] = 10;
              return original(...args);
            },
          );
          const start = paid;
          after = abortWait;
          try {
            const res = await speak(mobile, message);
            assert.equal(res.status, 503);
          } finally {
            after = undefined;
            mock.mock.restore();
          }
          assert.equal(paid - start, 1);
          await success(await speak(mobile, message));
        },
      );
      for (const stage of ["before", "after"] as const) {
        await t.test(
          `client disconnect ${stage} dispatch aborts the production transport and releases the scope`,
          async () => {
            const entered = latch(),
              exited = latch(),
              start = paid;
            const hold = async (req: TransportRequest) => {
              entered.release();
              try {
                await abortWait(req);
              } finally {
                exited.release();
              }
            };
            if (stage === "before") before = hold;
            else after = hold;
            const req = httpRequest(
              `${origin}/v1/${workspaceId}/voice/speech`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${mobile.accessToken}`,
                  "Content-Type": "application/json",
                },
              },
              (res) => res.resume(),
            );
            req.on("error", () => {});
            req.end(JSON.stringify(message));
            await entered.promise;
            req.destroy();
            await exited.promise;
            before = undefined;
            after = undefined;
            await call(mobile, settingsPath);
            await new Promise<void>((r) => setImmediate(r));
            assert.equal(paid - start, stage === "before" ? 0 : 1);
            await success(await speak(mobile, message));
          },
        );
      }
      await t.test(
        "one active synthesis per scope and eight globally; unrelated identity work proceeds while network is held",
        async () => {
          const credentials = [mobile];
          const sources = [message];
          for (let i = 0; i < 8; i++) {
            await admin("api/identity/command", {
              type: "createWorkspace",
              organizationId,
              name: `TEST Concurrent ${i}`,
            });
            const detail = OrganizationDetailSchema.parse(
              await admin(`api/identity/organization?id=${organizationId}`),
            );
            const ws = detail.workspaces.find(
              (w) => w.name === `TEST Concurrent ${i}`,
            )!.id;
            await configure({}, ws);
            const credential = await issue(ws);
            credentials.push(credential);
            sources.push(await source(credential));
          }
          const entered = latch(),
            release = latch();
          releases.push(release.release);
          let count = 0;
          const start = paid;
          after = async () => {
            if (++count === 8) entered.release();
            await release.promise;
          };
          const pending = credentials
            .slice(0, 8)
            .map((c, i) => speak(c, sources[i]!));
          try {
            await entered.promise;
            assert.equal(paid - start, 8);
            assert.equal((await read(web)).profile, OUTPUT_VOICE_PROFILE);
            assert.equal((await speak(mobile, message)).status, 429);
            assert.equal(
              (await speak(credentials[8]!, sources[8]!)).status,
              429,
            );
            assert.equal(paid - start, 8);
          } finally {
            release.release();
            after = undefined;
          }
          await Promise.all(pending.map(async (p) => success(await p)));
          await success(await speak(credentials[8]!, sources[8]!));
        },
      );
      assert(modelCalls > 0);
      assert(speechRequests >= paid);
    } finally {
      before = undefined;
      after = undefined;
      releases.forEach((release) => release());
      app!.emit("close");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await identity.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
