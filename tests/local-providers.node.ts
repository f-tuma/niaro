import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CatalogCommand,
  ProviderSettings,
  type CatalogModel,
  type Provider,
} from "../packages/protocol/service-catalog";
import {
  FREE_MODEL_LIMITS,
  PROVIDER_PRESETS,
} from "../packages/protocol/providers";
import { budgetedReach, policyView } from "../packages/protocol/model-policy";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { createTransport } from "../apps/server-integrations/transport";
import { listModels } from "../apps/server-integrations/models";
import {
  transcribeAudio,
  transcribeMeetingChunk,
} from "../apps/server-integrations/transcription";
import { synthesizeSpeech } from "../apps/server-integrations/speech";
import {
  testModelCapabilities,
  testTone,
} from "../apps/server-integrations/model-test";
import { searchBackend } from "../apps/server-identity/web-access";
import { SectionOutcome } from "../apps/server-identity/config-bundle/registry";
import {
  providersSection,
  searchBackendsSection,
} from "../apps/server-identity/config-bundle/sections/organization";
import type { OrganizationContext } from "../apps/server-identity/config-bundle/registry";

const target = {
  organizationId: "org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const signal = () => new AbortController().signal;
const go = async (start: () => void) => start();

type Seen = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
};
type Reply = {
  status?: number;
  type?: string;
  body: string | Buffer;
};
/** A local stand-in for a provider or search service: no real network. */
async function fakeServer(route: (seen: Seen) => Reply) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(request);
      const reply = route(request);
      res.writeHead(reply.status ?? 200, {
        "content-type": reply.type ?? "application/json",
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    transport: createTransport([origin]),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function provider(origin: string, extra: Partial<Provider> = {}): Provider {
  return {
    id: "TEST-provider",
    revision: 1,
    name: "TEST local",
    url: `${origin}/v1`,
    enabled: true,
    dailyRequestLimit: 100,
    hasCredential: false,
    requestsToday: 0,
    auth: { type: "none" },
    dialect: "openai",
    free: true,
    ...extra,
  };
}
function model(extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "TEST-model",
    revision: 1,
    providerId: "TEST-provider",
    name: "TEST model",
    model: "llama3.2",
    enabled: true,
    tools: false,
    audioInput: false,
    audioOutput: false,
    kind: "chat",
    ...extra,
  };
}

function harness(origins: string[] = []) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);INSERT INTO organization VALUES ('org');INSERT INTO agent_workspace VALUES ('${target.workspaceId}','org');`,
  );
  const store = new ServiceCatalogStore(db, "test-only-secret", origins);
  let pending: Promise<unknown> = Promise.resolve();
  const context: CatalogContext = {
    serial: (fn) => {
      const task = pending.then(fn);
      pending = task.catch(() => {});
      return task;
    },
    actor: async () => ({ userId: "user", role: "owner" }),
    epoch: () => 0,
    change: () => {},
    audit: () => 1,
    finish: () => {},
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const command = (body: object) =>
    store.command(CatalogCommand.parse({ ...target, ...body }));
  return { db, store, context, command };
}

test("every preset is a valid starting point and names no model", () => {
  const ids = PROVIDER_PRESETS.map((preset) => preset.id);
  assert.deepEqual([...ids].sort(), [
    "anthropic",
    "azure",
    "custom",
    "gemini",
    "llamacpp",
    "lmstudio",
    "localai",
    "ollama",
    "openai",
    "openrouter",
    "vllm",
  ]);
  for (const preset of PROVIDER_PRESETS) {
    if (preset.id === "custom") continue;
    const parsed = ProviderSettings.safeParse({
      name: preset.label,
      url: preset.url,
      enabled: true,
      dailyRequestLimit: 100,
      preset: preset.id,
      auth: preset.auth,
      dialect: preset.dialect,
      free: preset.free,
    });
    assert.ok(parsed.success, preset.id);
    // Local servers are free and keyless; cloud ones send a key.
    assert.equal(preset.local, preset.auth.type === "none", preset.id);
    assert.equal(preset.free, preset.local, preset.id);
    // A preset is an address and key handling, never a model choice.
    assert.deepEqual(Object.keys(preset).sort(), [
      "auth",
      "dialect",
      "free",
      "id",
      "label",
      "local",
      "url",
    ]);
  }
  assert.equal(
    PROVIDER_PRESETS.find((p) => p.id === "azure")!.auth.type,
    "header",
  );
  assert.equal(
    PROVIDER_PRESETS.find((p) => p.id === "openrouter")!.dialect,
    "openrouter",
  );
});

test("providers keep their dialect, key handling and note; old rows migrate once", () => {
  const h = harness(["http://127.0.0.1:11434"]);
  try {
    // A save without a dialect takes its preset's, else the address default.
    const local = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST Ollama",
        url: "http://127.0.0.1:11434/v1",
        enabled: true,
        dailyRequestLimit: 100,
        preset: "ollama",
        auth: { type: "none" },
        free: true,
        dataHandling: "Runs locally. Nothing leaves the server.",
      },
      apiKey: "TEST-ignored",
    });
    const saved = h.store.provider("org", local);
    assert.equal(saved.provider.dialect, "openai");
    assert.equal(saved.provider.free, true);
    assert.equal(saved.provider.hasCredential, false, "no key without auth");
    assert.equal(saved.key, "");
    assert.equal(
      saved.provider.dataHandling,
      "Runs locally. Nothing leaves the server.",
    );
    assert.equal(h.store.processProviderAvailable("org", local), true);
    const router = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST router",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 100,
      },
    });
    assert.equal(
      h.store.provider("org", router).provider.dialect,
      "openrouter",
    );
    // An edit without a dialect keeps the stored one, even at a new address.
    h.command({
      type: "saveProvider",
      id: router,
      revision: 1,
      settings: {
        name: "TEST router",
        url: "https://proxy.example.test/api/v1",
        enabled: true,
        dailyRequestLimit: 100,
      },
    });
    assert.equal(
      h.store.provider("org", router).provider.dialect,
      "openrouter",
    );
    // A provider stored before dialects gets one on start, revision unchanged.
    h.db
      .prepare(
        "INSERT INTO agent_catalog VALUES ('TEST-old','org','provider',7,?,NULL)",
      )
      .run(
        JSON.stringify({
          name: "TEST old",
          url: "https://openrouter.ai/api/v1",
          enabled: true,
          dailyRequestLimit: 10,
        }),
      );
    new ServiceCatalogStore(h.db, "test-only-secret", []);
    const migrated = h.store.provider("org", "TEST-old").provider;
    assert.equal(migrated.dialect, "openrouter");
    assert.equal(migrated.preset, "openrouter");
    assert.equal(migrated.revision, 7);
  } finally {
    h.db.close();
  }
});

test("discovery reads a plain /v1/models list without OpenRouter fields", async () => {
  const server = await fakeServer(() => ({
    body: JSON.stringify({
      object: "list",
      data: [
        { id: "llama3.2", object: "model", owned_by: "library" },
        { id: "qwen2.5", object: "model", max_model_len: 32768 },
        { id: "claude-test", display_name: "TEST display", type: "model" },
      ],
    }),
  }));
  try {
    const models = await listModels(
      server.transport,
      provider(server.origin),
      "",
      signal(),
      go,
    );
    // One plain request, no OpenRouter audio catalogs, no key sent.
    assert.equal(server.seen.length, 1);
    assert.equal(server.seen[0]!.path, "/v1/models");
    assert.equal(server.seen[0]!.headers.authorization, undefined);
    assert.deepEqual(
      models.map((m) => [m.model, m.name, m.tools, m.kind, m.contextLength]),
      [
        ["llama3.2", "llama3.2", null, "chat", null],
        ["qwen2.5", "qwen2.5", null, "chat", 32768],
        ["claude-test", "TEST display", null, "chat", null],
      ],
    );
    // A free provider's models cost nothing, whatever it publishes.
    assert.deepEqual(models[0]!.pricing, {
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    // Azure-style key header.
    await listModels(
      server.transport,
      provider(server.origin, {
        auth: { type: "header", header: "api-key" },
        free: false,
      }),
      "TEST-key",
      signal(),
      go,
    );
    assert.equal(server.seen[1]!.headers["api-key"], "TEST-key");
    assert.equal(server.seen[1]!.headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test("the capability test asks one small question per capability of the model's kind", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = await fakeServer((seen) => {
    if (seen.path === "/v1/audio/transcriptions") {
      // A multipart upload with the file part.
      assert.match(
        String(seen.headers["content-type"]),
        /^multipart\/form-data; boundary=/,
      );
      assert.ok(
        seen.body.includes(Buffer.from('name="file"; filename="audio.wav"')),
      );
      return { body: JSON.stringify({ text: "beep" }) };
    }
    if (seen.path === "/v1/audio/speech")
      return { type: "audio/mpeg", body: Buffer.from([255, 251, 1, 2, 3]) };
    const body = JSON.parse(seen.body.toString()) as Record<string, any>;
    bodies.push(body);
    if (body.tools)
      return {
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "1",
                    type: "function",
                    function: { name: "record_color", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      };
    const parts = body.messages[0].content;
    if (Array.isArray(parts) && parts[1].type === "image_url")
      return {
        body: JSON.stringify({ choices: [{ message: { content: "Red." } }] }),
      };
    // This server does not take audio.
    return { status: 400, body: '{"error":"unsupported content"}' };
  });
  try {
    const chat = await testModelCapabilities(
      server.transport,
      server.transport,
      { provider: provider(server.origin), key: "", model: model() },
      signal(),
      go,
    );
    assert.deepEqual(chat, [
      { capability: "tools", status: "supported" },
      { capability: "imageInput", status: "supported" },
      { capability: "audioInput", status: "unsupported" },
      // Audio output needs a reviewed voice to ask for.
      { capability: "audioOutput", status: "skipped", error: "voice_required" },
    ]);
    // No OpenRouter routing flags on a plain provider.
    assert.ok(bodies.every((body) => !("provider" in body)));
    const stt = await testModelCapabilities(
      server.transport,
      server.transport,
      {
        provider: provider(server.origin),
        key: "",
        model: model({ kind: "transcription" }),
      },
      signal(),
      go,
    );
    assert.deepEqual(stt, [
      { capability: "transcription", status: "supported" },
    ]);
    const tts = await testModelCapabilities(
      server.transport,
      server.transport,
      {
        provider: provider(server.origin),
        key: "",
        model: model({
          kind: "speech",
          audioOutput: true,
          voices: [{ voice: "TEST-voice", label: "Test" }],
        }),
      },
      signal(),
      go,
    );
    assert.deepEqual(tts, [{ capability: "speech", status: "supported" }]);
  } finally {
    await server.close();
  }
});

test("the capability test runs through the catalog, budgeted and counted against the provider", async () => {
  const server = await fakeServer(() => ({
    body: JSON.stringify({
      choices: [{ message: { content: "Red" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  }));
  const h = harness([server.origin]);
  try {
    const controller = new CatalogController(h.store, server.transport);
    const providerId = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST LM Studio",
        url: `${server.origin}/v1`,
        enabled: true,
        dailyRequestLimit: 100,
        preset: "lmstudio",
        auth: { type: "none" },
        free: true,
      },
    });
    const modelId = h.command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST router model",
        model: "local-router",
        enabled: false,
        tools: false,
        kind: "router",
      },
    });
    // Enforced usage limits: the free provider's zero price admits the calls.
    h.store.inferenceBudget.savePolicy("org", target.workspaceId, 0, {
      mode: "enforce",
      maxTokens: 1_000_000,
      maxCostMicros: 1_000_000,
      prices: [],
    });
    const result = (await controller.handle(
      "POST",
      new URL("https://server.test/admin/api/identity/catalog/models/test"),
      { ...target, modelId, revision: 1 },
      h.context,
      signal(),
    )) as { results: { capability: string; status: string }[] };
    assert.deepEqual(result.results, [
      { capability: "tools", status: "unsupported" },
      { capability: "imageInput", status: "supported" },
    ]);
    assert.equal(server.seen.length, 2);
    assert.equal(h.store.provider("org", providerId).provider.requestsToday, 2);
    const attempts = h.db
      .prepare(
        "SELECT run_id,status,cost_micros FROM agent_inference_attempt ORDER BY rowid",
      )
      .all();
    assert.equal(attempts.length, 2);
    assert.ok(
      attempts.every((a) => String(a.run_id).startsWith("catalog-test/")),
    );
    assert.ok(attempts.every((a) => a.cost_micros === 0));
    // A stale revision is refused before any request.
    await assert.rejects(
      controller.handle(
        "POST",
        new URL("https://server.test/admin/api/identity/catalog/models/test"),
        { ...target, modelId, revision: 0 },
        h.context,
        signal(),
      ),
      /catalog_conflict/,
    );
    assert.equal(server.seen.length, 2);
    // No longer free: stopping at limit refuses the unpriced test before any request.
    h.command({
      type: "saveProvider",
      id: providerId,
      revision: 1,
      settings: {
        name: "TEST LM Studio",
        url: `${server.origin}/v1`,
        enabled: true,
        dailyRequestLimit: 100,
        auth: { type: "none" },
        free: false,
      },
    });
    await assert.rejects(
      controller.handle(
        "POST",
        new URL("https://server.test/admin/api/identity/catalog/models/test"),
        { ...target, modelId, revision: 1 },
        h.context,
        signal(),
      ),
      /catalog_budget_price_required/,
    );
    assert.equal(server.seen.length, 2);
    assert.equal(h.store.provider("org", providerId).provider.requestsToday, 2);
  } finally {
    h.db.close();
    await server.close();
  }
});

test("a free provider's models get a zero price that is never stored", () => {
  const h = harness(["http://127.0.0.1:1234"]);
  try {
    const free = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST free",
        url: "http://127.0.0.1:1234/v1",
        enabled: true,
        dailyRequestLimit: 100,
        auth: { type: "none" },
        free: true,
      },
    });
    const paid = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST paid",
        url: "https://api.example.test/v1",
        enabled: true,
        dailyRequestLimit: 100,
      },
    });
    const local = h.command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId: free,
        name: "TEST local",
        model: "local",
        enabled: true,
        tools: true,
      },
    });
    h.command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId: paid,
        name: "TEST paid",
        model: "paid",
        enabled: true,
        tools: true,
      },
    });
    const budget = h.store.inferenceBudget;
    assert.deepEqual(budget.policy("org", target.workspaceId).settings.prices, [
      {
        modelId: local,
        modelRevision: 1,
        providerRevision: 1,
        ...FREE_MODEL_LIMITS,
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
      },
    ]);
    // Saving the policy as the page shows it stores no implied price.
    const shown = budget.policy("org", target.workspaceId);
    budget.savePolicy("org", target.workspaceId, 0, {
      ...shown.settings,
      mode: "enforce",
    });
    assert.deepEqual(
      budget.storedPolicy("org", target.workspaceId).settings.prices,
      [],
    );
    // In enforce mode the local chat model needs no typed price; the paid one does.
    h.command({
      ...routingCommand([local]),
    });
    assert.deepEqual(
      h.store.unpricedRouteModels("org", target.workspaceId),
      [],
    );
    const reach = budgetedReach(
      policyView(h.store.modelPolicies("org", target.workspaceId), [])
        .effective,
    );
    assert.deepEqual([...reach.keys()], [local]);
    const selected = h.store.model("org", local);
    const reservation = budget.reserve(
      "TEST-run",
      { ...target, userId: "user" },
      selected,
      "model",
    );
    assert.equal(reservation.cost, 0);
    // Unmarking the provider brings the price requirement back.
    h.command({
      type: "saveProvider",
      id: free,
      revision: 1,
      settings: {
        name: "TEST free",
        url: "http://127.0.0.1:1234/v1",
        enabled: true,
        dailyRequestLimit: 100,
        auth: { type: "none" },
        free: false,
      },
    });
    assert.deepEqual(
      h.store
        .unpricedRouteModels("org", target.workspaceId)
        .map((entry) => entry.modelId),
      [local],
    );
  } finally {
    h.db.close();
  }
});

test("voice and meetings use the standard audio endpoints of any provider", async () => {
  const server = await fakeServer((seen) => {
    if (seen.path === "/v1/audio/transcriptions")
      return {
        body: JSON.stringify({
          text: "Ahoj.",
          segments: [{ start: 0, end: 1, text: "Ahoj." }],
        }),
      };
    if (seen.path === "/v1/audio/speech")
      return { type: "audio/mp3", body: Buffer.alloc(256, 255) };
    return {
      body: JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "Ahoj." } }],
      }),
    };
  });
  try {
    const selected = {
      provider: provider(server.origin, {
        auth: { type: "bearer" },
        free: false,
      }),
      key: "TEST-key",
    };
    const wav = testTone();
    assert.equal(
      await transcribeAudio(
        server.transport,
        {
          ...selected,
          model: model({ kind: "transcription" }),
          method: "transcription",
        },
        wav,
        "cs",
        signal(),
        go,
      ),
      "Ahoj.",
    );
    const upload = server.seen[0]!;
    assert.equal(upload.headers.authorization, "Bearer TEST-key");
    assert.ok(
      upload.body.includes(Buffer.from('name="model"\r\n\r\nllama3.2')),
    );
    assert.ok(upload.body.includes(wav.subarray(44, 200)));
    // A chat model with audio input interprets, without OpenRouter's flags.
    await transcribeAudio(
      server.transport,
      { ...selected, model: model({ audioInput: true }) },
      wav,
      "en",
      signal(),
      go,
    );
    const chat = JSON.parse(server.seen[1]!.body.toString());
    assert.equal(server.seen[1]!.path, "/v1/chat/completions");
    assert.equal(chat.messages[1].content[0].type, "input_audio");
    assert.equal(chat.provider, undefined);
    const meeting = await transcribeMeetingChunk(
      server.transport,
      { ...selected, model: model({ kind: "transcription" }) },
      { data: wav, format: "wav" },
      "Niaro",
      signal(),
      go,
    );
    assert.equal(meeting.timed, true);
    const chunk = server.seen[2]!.body.toString("latin1");
    assert.match(chunk, /name="response_format"\r\n\r\nverbose_json/);
    assert.match(chunk, /name="timestamp_granularities\[\]"\r\n\r\nsegment/);
    assert.match(chunk, /name="prompt"\r\n\r\nNiaro/);
    assert.doesNotMatch(chunk, /zdr|data_collection/);
    const audio = await synthesizeSpeech(
      server.transport,
      {
        ...selected,
        model: model({ kind: "speech", audioOutput: true }),
        method: "speech",
        voice: "TEST-voice",
      },
      "Dobrý den.",
      "cs",
      signal(),
      go,
    );
    assert.equal(audio.mimeType, "audio/mpeg");
    assert.equal(server.seen[3]!.path, "/v1/audio/speech");
    assert.deepEqual(JSON.parse(server.seen[3]!.body.toString()), {
      model: "llama3.2",
      input: "Dobrý den.",
      voice: "TEST-voice",
      response_format: "mp3",
    });
  } finally {
    await server.close();
  }
});

test("web searches go to SearXNG, Brave or Tavily through their own APIs", async () => {
  const server = await fakeServer((seen) => {
    if (seen.path.startsWith("/search?"))
      return {
        body: JSON.stringify({
          results: [
            {
              url: "https://example.com/a#top",
              title: "TEST A",
              content: "First",
              publishedDate: "2026-11-01T10:00:00",
            },
            { url: "https://example.com/a", title: "TEST A again" },
            { url: "javascript:alert(1)", title: "TEST bad" },
            {
              url: "https://example.com/old",
              title: "TEST old",
              publishedDate: "2020-01-01",
            },
          ],
        }),
      };
    if (seen.path.startsWith("/res/v1/web/search?"))
      return {
        body: JSON.stringify({
          web: {
            results: [
              {
                url: "https://example.org/b",
                title: "TEST B",
                description: "Brave hit",
                page_age: "2026-10-30T00:00:00",
              },
            ],
          },
        }),
      };
    return {
      body: JSON.stringify({
        results: [
          {
            url: "https://example.net/c",
            title: "TEST C",
            content: "Tavily hit",
          },
        ],
      }),
    };
  });
  const input = {
    query: "TEST plán",
    limit: 5,
    freshness: "month" as const,
    now: Date.parse("2026-11-05T00:00:00Z"),
  };
  try {
    const searx = await searchBackend(
      server.transport,
      { kind: "searxng", url: server.origin, name: "TEST searx" },
      "",
      input,
      signal(),
      go,
    );
    assert.deepEqual(searx.results, [
      {
        title: "TEST A",
        url: "https://example.com/a",
        snippet: "First",
        date: "2026-11-01",
      },
    ]);
    const query = new URL(server.origin + server.seen[0]!.path).searchParams;
    assert.equal(query.get("q"), "TEST plán");
    assert.equal(query.get("format"), "json");
    assert.equal(query.get("time_range"), "month");
    const brave = await searchBackend(
      server.transport,
      { kind: "brave", url: `${server.origin}/res/v1`, name: "TEST brave" },
      "TEST-brave-key",
      input,
      signal(),
      go,
    );
    assert.equal(brave.results[0]!.snippet, "Brave hit");
    assert.equal(
      server.seen[1]!.headers["x-subscription-token"],
      "TEST-brave-key",
    );
    const braveQuery = new URL(server.origin + server.seen[1]!.path)
      .searchParams;
    assert.equal(braveQuery.get("freshness"), "pm");
    assert.equal(braveQuery.get("count"), "5");
    const tavily = await searchBackend(
      server.transport,
      { kind: "tavily", url: server.origin, name: "TEST tavily" },
      "TEST-tavily-key",
      input,
      signal(),
      go,
    );
    assert.equal(tavily.results[0]!.url, "https://example.net/c");
    assert.equal(
      server.seen[2]!.headers.authorization,
      "Bearer TEST-tavily-key",
    );
    assert.deepEqual(JSON.parse(server.seen[2]!.body.toString()), {
      query: "TEST plán",
      max_results: 5,
      search_depth: "basic",
      time_range: "month",
    });
  } finally {
    await server.close();
  }
});

test("search backends keep their key write-only, travel in the bundle without it and cannot be removed while used", () => {
  const h = harness();
  try {
    const brave = h.command({
      type: "saveSearchBackend",
      revision: 0,
      settings: {
        name: "TEST Brave",
        kind: "brave",
        url: "https://api.search.brave.com/res/v1",
        enabled: true,
      },
      apiKey: "TEST-search-key",
    });
    const view = h.store.inventory("org", target.workspaceId, {
      userId: "user",
      role: "owner",
    });
    assert.deepEqual(
      view.searchBackends.map((b) => [b.name, b.hasCredential]),
      [["TEST Brave", true]],
    );
    assert.ok(!JSON.stringify(view).includes("TEST-search-key"));
    // A workspace sends its searches there; the role then needs no model or price.
    h.command({
      type: "saveWorkspaceModelPolicy",
      revision: 0,
      policy: { options: { webSearch: { backendId: brave } } },
    });
    assert.equal(
      h.store.resolveSearchBackend("org", target.workspaceId)?.key,
      "TEST-search-key",
    );
    assert.throws(
      () =>
        h.command({
          type: "removeSearchBackend",
          id: brave,
          revision: 1,
        }),
      /catalog_search_in_use/,
    );
    assert.throws(
      () =>
        h.command({
          type: "saveOrganizationModelPolicy",
          revision: 0,
          policy: {
            options: {
              webSearch: { backendId: "22222222-2222-4222-8222-222222222222" },
            },
          },
        }),
      /catalog_search_unavailable/,
    );
    const ctx = {
      catalog: h.store,
      organizationId: "org",
      db: h.db,
    } as unknown as OrganizationContext;
    const exported = searchBackendsSection.export(ctx)!;
    assert.deepEqual(exported, {
      version: 1,
      items: [
        {
          name: "TEST Brave",
          kind: "brave",
          url: "https://api.search.brave.com/res/v1",
          enabled: true,
          keyRequired: true,
        },
      ],
    });
    assert.ok(!JSON.stringify(exported).includes("TEST-search-key"));
    // Imported elsewhere, the backend is added and waits for its key.
    const other = harness();
    try {
      const outcome = new SectionOutcome(other.db);
      searchBackendsSection.apply(
        {
          catalog: other.store,
          organizationId: "org",
          db: other.db,
        } as unknown as OrganizationContext,
        searchBackendsSection.schema.parse(exported),
        outcome,
      );
      assert.deepEqual(outcome.added, ["TEST Brave"]);
      assert.deepEqual(outcome.needsKey, ["TEST Brave"]);
      // Without its key a Brave backend refuses searches.
      const id = other.store.searchBackends("org")[0]!.id;
      other.command({
        type: "saveWorkspaceModelPolicy",
        revision: 0,
        policy: { options: { webSearch: { backendId: id } } },
      });
      assert.throws(
        () => other.store.resolveSearchBackend("org", target.workspaceId),
        /catalog_search_unavailable/,
      );
    } finally {
      other.db.close();
    }
  } finally {
    h.db.close();
  }
});

test("the bundle carries a provider's preset, key handling, dialect, free choice and note, never its key", () => {
  const h = harness(["http://127.0.0.1:11434"]);
  try {
    h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST Ollama",
        url: "http://127.0.0.1:11434/v1",
        enabled: true,
        dailyRequestLimit: 100,
        preset: "ollama",
        auth: { type: "none" },
        free: true,
        dataHandling: "Runs locally.",
      },
    });
    h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST Azure",
        url: "https://test.openai.azure.com/openai/v1",
        enabled: true,
        dailyRequestLimit: 100,
        preset: "azure",
        auth: { type: "header", header: "api-key" },
      },
      apiKey: "TEST-azure-key",
    });
    const ctx = {
      catalog: h.store,
      organizationId: "org",
      db: h.db,
    } as unknown as OrganizationContext;
    const exported = providersSection.export(ctx)!;
    assert.ok(!JSON.stringify(exported).includes("TEST-azure-key"));
    const byName = Object.fromEntries(
      exported.items.map((item) => [item.name, item]),
    );
    assert.equal(byName["TEST Ollama"]!.keyRequired, false);
    assert.equal(byName["TEST Ollama"]!.free, true);
    assert.equal(byName["TEST Ollama"]!.dataHandling, "Runs locally.");
    assert.equal(byName["TEST Azure"]!.keyRequired, true);
    assert.deepEqual(byName["TEST Azure"]!.auth, {
      type: "header",
      header: "api-key",
    });
    // Re-applying the same bundle changes nothing.
    const outcome = new SectionOutcome(h.db);
    providersSection.apply(
      ctx,
      providersSection.schema.parse(exported),
      outcome,
    );
    assert.deepEqual(outcome.unchanged.sort(), ["TEST Azure", "TEST Ollama"]);
    assert.deepEqual(outcome.needsKey, []);
  } finally {
    h.db.close();
  }
});

/** The chat role on the given models, as the workspace's own override. */
function routingCommand(models: string[]) {
  return {
    type: "saveWorkspaceModelPolicy",
    revision: 0,
    policy: { roles: { chat: { models } } },
  };
}
