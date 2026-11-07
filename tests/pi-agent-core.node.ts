import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { PiCallPlan } from "@niaro/server-agent/pi";
import { agentCoreModelHost } from "../apps/server-identity/agent-core";
import { IdentityError } from "../apps/server-identity/error";
import {
  IntegrationError,
  RequestNotSent,
  type IntegrationTransport,
} from "../apps/server-integrations/transport";
import {
  ask,
  attempts,
  enforce,
  entries,
  fakeTransport,
  piCatalog,
  piScope,
  serialQueue,
  type PiCatalog,
  loadPi,
  loadPiAi,
  loadPiDurable,
  type Reply,
} from "./helpers/pi-agent";

type Pi = typeof import("@niaro/server-agent/pi");
type PiAi = typeof import("@earendil-works/pi-ai");
type PiDurable = typeof import("@earendil-works/pi-durable");
let ctx: Pi["ctx"];
let failureText: Pi["failureText"];
let niaroPiProvider: Pi["niaroPiProvider"];
let PiAgentCore: Pi["PiAgentCore"];
let RECOVERY_POLICY_A: Pi["RECOVERY_POLICY_A"];
let createModels: PiAi["createModels"];
let isRetryableAssistantError: PiAi["isRetryableAssistantError"];
let normalizeContext: PiAi["normalizeContext"];
let defineExtension: PiDurable["defineExtension"];
let GenerationTask: PiDurable["GenerationTask"];
let hook: PiDurable["hook"];
before(async () => {
  ({ ctx, failureText, niaroPiProvider, PiAgentCore, RECOVERY_POLICY_A } =
    await loadPi());
  ({ createModels, isRetryableAssistantError, normalizeContext } =
    await loadPiAi());
  ({ defineExtension, GenerationTask, hook } = await loadPiDurable());
});

const policy = (catalog: PiCatalog, roles: object) =>
  catalog.command({
    type: "saveOrganizationModelPolicy",
    revision: catalog.store.modelPolicies(
      piScope.organizationId,
      piScope.workspaceId,
    ).organization.revision,
    policy: { roles },
  });

async function openCore(
  catalog: PiCatalog,
  transport: IntegrationTransport,
  extra: Partial<Parameters<Pi["PiAgentCore"]["open"]>[0]> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "niaro-pi-"));
  const core = await PiAgentCore.open({
    file: join(dir, "agent-core.sqlite"),
    host: agentCoreModelHost({
      catalog: catalog.store,
      transport,
      serial: serialQueue(),
    }),
    // Fast backoff for tests; policy A still bounds the attempts.
    settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } },
    ...extra,
  });
  return {
    core,
    dir,
    async close() {
      await core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const assistants = (items: Awaited<ReturnType<typeof entries>>) =>
  items
    .filter((entry) => entry.kind === "pi.assistant")
    .map((entry) => entry.message);

test("roles resolve through the workspace's model policy, never a fixed model, and the next request follows a policy change", async () => {
  const catalog = piCatalog();
  // The checker is not configured: it follows the selector (ROLE_DEFAULTS).
  policy(catalog, {
    chat: { models: [catalog.models.fast] },
    selector: { models: [catalog.models.careful] },
  });
  const { transport, seen } = fakeTransport([{ kind: "text", text: "Hello." }]);
  const h = await openCore(catalog, transport);
  try {
    const chat = await h.core.createConversation(piScope, "chat");
    const checker = await h.core.createConversation(piScope, "checker");
    assert.equal((await ask(h.core, chat.id, "hi")).settled.status, "done");
    assert.equal(
      (await ask(h.core, checker.id, "check")).settled.status,
      "done",
    );
    assert.deepEqual(
      seen.map((request) => [
        request.url,
        request.body.model,
        request.headers.Authorization,
      ]),
      [
        [
          "https://gateway.example.test/v1/chat/completions",
          "vendor/fast",
          "Bearer TEST-key-gateway",
        ],
        [
          "https://gateway.example.test/v1/chat/completions",
          "vendor/careful",
          "Bearer TEST-key-gateway",
        ],
      ],
    );
    // Pi's model is the route; the catalog model is decided per request.
    const answer = assistants(await entries(h.core, chat.id))[0]!;
    assert.equal(answer.model, "chat");
    assert.equal(answer.content?.[0]?.text, "Hello.");

    policy(catalog, { chat: { models: [catalog.models.spare] } });
    await ask(h.core, chat.id, "again");
    assert.equal(
      seen.at(-1)!.url,
      "https://backup.example.test/v1/chat/completions",
    );
    assert.equal(seen.at(-1)!.body.model, "other/spare");
    assert.equal(seen.at(-1)!.headers.Authorization, "Bearer TEST-key-backup");
    // A route with no models refuses before anything is sent.
    policy(catalog, {
      chat: { models: [catalog.models.fast] },
      background: { models: [] },
    });
    const background = await h.core.createConversation(piScope, "background");
    const before = seen.length;
    const refused = await ask(h.core, background.id, "work");
    assert.equal(refused.settled.status, "unanswered");
    assert.equal(seen.length, before);
    assert.equal(
      assistants(await entries(h.core, background.id)).at(-1)!.errorMessage,
      "catalog_model_required",
    );
  } finally {
    await h.close();
  }
});

test("over the budget a request is refused before dispatch, and is not retried", async () => {
  const catalog = piCatalog();
  policy(catalog, { chat: { models: [catalog.models.fast] } });
  // One call reserves at least 2048 input + 200 output tokens; the cap admits none.
  enforce(catalog, [catalog.models.fast], { maxTokens: 2000 });
  const { transport, seen } = fakeTransport([{ kind: "text", text: "never" }]);
  const h = await openCore(catalog, transport);
  try {
    const chat = await h.core.createConversation(piScope);
    const { settled } = await ask(h.core, chat.id, "hi");
    assert.equal(settled.status, "unanswered");
    assert.equal(seen.length, 0, "nothing reached the provider");
    assert.deepEqual(attempts(catalog.db), [], "no attempt was reserved");
    const failure = assistants(await entries(h.core, chat.id)).at(-1)!;
    assert.equal(failure.stopReason, "error");
    assert.equal(failure.errorMessage, "catalog_budget_exhausted");
    assert.equal(isRetryableAssistantError(failure as AssistantMessage), false);
    assert.equal(
      catalog.store.provider(piScope.organizationId, catalog.providers.gateway)
        .provider.requestsToday,
      0,
    );
  } finally {
    await h.close();
  }
});

test("a call reserves before dispatch and settles the provider's usage; Pi's record gets the same counts", async () => {
  const catalog = piCatalog();
  policy(catalog, { chat: { models: [catalog.models.fast] } });
  enforce(catalog, [catalog.models.fast]);
  const { transport, seen } = fakeTransport([
    {
      kind: "text",
      text: "Done.",
      usage: {
        prompt_tokens: 300,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    },
  ]);
  const h = await openCore(catalog, transport);
  try {
    const chat = await h.core.createConversation(piScope);
    const { settled, submission } = await ask(h.core, chat.id, "hi");
    assert.equal(settled.status, "done");
    // Enforced limits clamp the reply to the priced maximum.
    assert.equal(seen[0]!.body.max_tokens, 200);
    const rows = attempts(catalog.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "settled");
    assert.equal(rows[0]!.run_id, `pi:${chat.id}:${submission.id}`);
    assert.equal(rows[0]!.input_tokens, 300);
    assert.equal(rows[0]!.output_tokens, 20);
    // 300 × 1 µ$ + 20 × 2 µ$ per token.
    assert.equal(rows[0]!.cost_micros, 340);
    assert.ok(rows[0]!.reserved_cost! >= 340);
    const usage = assistants(await entries(h.core, chat.id))[0]!.usage!;
    assert.deepEqual(
      {
        input: usage.input,
        cacheRead: usage.cacheRead,
        output: usage.output,
        total: usage.totalTokens,
      },
      { input: 200, cacheRead: 100, output: 20, total: 320 },
    );
    assert.equal(
      catalog.store.provider(piScope.organizationId, catalog.providers.gateway)
        .provider.requestsToday,
      1,
    );
  } finally {
    await h.close();
  }
});

test("a transient failure is retried under policy A: every attempt is reserved once and the failed one keeps its hold", async () => {
  const catalog = piCatalog();
  policy(catalog, { chat: { models: [catalog.models.fast] } });
  enforce(catalog, [catalog.models.fast]);
  const { transport, seen } = fakeTransport([
    { kind: "throw", error: new IntegrationError("integration_timeout", 504) },
    { kind: "text", text: "Second try." },
  ]);
  const h = await openCore(catalog, transport);
  try {
    const chat = await h.core.createConversation(piScope);
    const { settled } = await ask(h.core, chat.id, "hi");
    assert.equal(settled.status, "done");
    assert.equal(seen.length, 2);
    const rows = attempts(catalog.db);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["unknown", "settled"],
    );
    assert.equal(
      rows[0]!.run_id,
      rows[1]!.run_id,
      "both attempts count against one run",
    );
    // Pi records the failed attempt as an error entry (an internal state the
    // member projection must hide) followed by the one answer.
    assert.deepEqual(
      assistants(await entries(h.core, chat.id)).map((m) => [
        m.stopReason,
        m.errorMessage,
      ]),
      [
        ["error", "integration_timeout: model service temporarily unavailable"],
        ["stop", undefined],
      ],
    );
  } finally {
    await h.close();
  }
  // Bounded: a failure that never ends stops after the policy's retries.
  const endless = fakeTransport([
    { kind: "throw", error: new IntegrationError("integration_timeout", 504) },
  ]);
  const again = await openCore(catalog, endless.transport, {
    settings: { retry: { baseDelayMs: 5, maxRetries: 10 } },
  });
  try {
    const chat = await again.core.createConversation(piScope);
    assert.equal(
      (await ask(again.core, chat.id, "hi")).settled.status,
      "unanswered",
    );
    assert.equal(endless.seen.length, 1 + RECOVERY_POLICY_A.retry.maxRetries);
  } finally {
    await again.close();
  }
});

test("with fallback on, a call that provably never left moves to the route's next model", async () => {
  const catalog = piCatalog();
  policy(catalog, {
    chat: {
      models: [catalog.models.fast, catalog.models.spare],
      fallback: true,
    },
  });
  const { transport, seen } = fakeTransport([
    { kind: "throw", error: new RequestNotSent() },
    { kind: "text", text: "From the spare." },
  ]);
  const h = await openCore(catalog, transport);
  try {
    const chat = await h.core.createConversation(piScope);
    assert.equal((await ask(h.core, chat.id, "hi")).settled.status, "done");
    assert.deepEqual(
      seen.map((request) => request.body.model),
      ["vendor/fast", "other/spare"],
    );
  } finally {
    await h.close();
  }
});

test("a conversation without a scope never reaches a model", async () => {
  const catalog = piCatalog();
  policy(catalog, { chat: { models: [catalog.models.fast] } });
  const { transport, seen } = fakeTransport([{ kind: "text", text: "never" }]);
  const h = await openCore(catalog, transport);
  try {
    const bare = await h.core.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: h.core.provider.route("chat") },
      },
      ctx,
    );
    assert.equal(
      (await ask(h.core, bare.id, "hi")).settled.status,
      "unanswered",
    );
    assert.equal(seen.length, 0);
    assert.equal(
      assistants(await entries(h.core, bare.id)).at(-1)!.errorMessage,
      "niaro_scope_missing",
    );
  } finally {
    await h.close();
  }
});

test("no request bypasses the transport: vendor SDKs are not installed, fetch is never called and hooks cannot change the model", async () => {
  for (const sdk of [
    "openai",
    "@anthropic-ai/sdk",
    "@google/genai",
    "@aws-sdk/client-bedrock-runtime",
  ])
    await assert.rejects(
      import(sdk),
      { code: "ERR_MODULE_NOT_FOUND" },
      `${sdk} must not be installed`,
    );
  const catalog = piCatalog();
  policy(catalog, { chat: { models: [catalog.models.fast] } });
  const { transport, seen } = fakeTransport([{ kind: "text", text: "Hello." }]);
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("fetch is not a model path");
  }) as typeof fetch;
  const rewrite = defineExtension({
    name: "test-rewrite",
    hooks: [
      hook(GenerationTask, {
        beforeProviderRequest: async (request) => ({
          payload: {
            ...(request.payload as object),
            model: "attacker/model",
            temperature: 0.5,
          },
        }),
      }),
    ],
  });
  const h = await openCore(catalog, transport, { extensions: [rewrite] });
  try {
    const chat = await h.core.createConversation(piScope);
    assert.equal((await ask(h.core, chat.id, "hi")).settled.status, "done");
    assert.equal(fetched, 0);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0]!.body.model,
      "vendor/fast",
      "the policy's model stays",
    );
    assert.equal(seen[0]!.body.temperature, 0.5, "the hook did run");
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

test("the agent core file is private and reopens with its conversations", async () => {
  const catalog = piCatalog();
  policy(catalog, { chat: { models: [catalog.models.fast] } });
  const { transport } = fakeTransport([{ kind: "text", text: "Hello." }]);
  const dir = mkdtempSync(join(tmpdir(), "niaro-pi-"));
  const file = join(dir, "agent-core.sqlite");
  const host = agentCoreModelHost({
    catalog: catalog.store,
    transport,
    serial: serialQueue(),
  });
  try {
    const first = await PiAgentCore.open({ file, host });
    const chat = await first.createConversation(piScope);
    await ask(first, chat.id, "hi");
    await first.close();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const second = await PiAgentCore.open({ file, host });
    try {
      assert.equal(assistants(await entries(second, chat.id)).length, 1);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the provider streams the reply text as it arrives and maps failures to codes Pi retries only when transient", async () => {
  const { transport } = fakeTransport(
    [{ kind: "text", text: "one two three" }],
    { stream: true },
  );
  const catalog = piCatalog();
  const selection = catalog.store.model(
    piScope.organizationId,
    catalog.models.fast,
  );
  const plan: PiCallPlan = {
    selection,
    transport,
    beforeDispatch: async (start) => start(),
  };
  const provider = niaroPiProvider({ plan: async () => plan });
  const models = createModels();
  models.setProvider(provider);
  const events: AssistantMessageEvent[] = [];
  const stream = models.streamSimple(
    models.getModel("niaro", "chat")!,
    normalizeContext({
      systemPrompt: "Be brief.",
      messages: [{ role: "user", content: "count", timestamp: 1 }],
    }),
  );
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.deepEqual(
    events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta),
    ["one ", "two ", "three"],
  );
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "one two three" }]);

  const failing = (error: unknown) =>
    ({
      role: "assistant",
      stopReason: "error",
      errorMessage: failureText(error),
    }) as AssistantMessage;
  assert.equal(
    isRetryableAssistantError(
      failing(new IntegrationError("integration_timeout", 504)),
    ),
    true,
  );
  assert.equal(isRetryableAssistantError(failing(new RequestNotSent())), true);
  for (const code of [
    "catalog_budget_exhausted",
    "catalog_budget_price_required",
    "catalog_provider_limit",
    "catalog_model_unavailable",
    "identity_forbidden",
  ])
    assert.equal(
      isRetryableAssistantError(failing(new IdentityError(429, code))),
      false,
      code,
    );
});

test("tool calls get server ids and broken arguments reach Pi's validation", async () => {
  const replies: Reply[] = [
    { kind: "tool", name: "lookup", args: { name: "Ada" } },
  ];
  const { transport } = fakeTransport(replies);
  const catalog = piCatalog();
  const selection = catalog.store.model(
    piScope.organizationId,
    catalog.models.fast,
  );
  const provider = niaroPiProvider({
    plan: async () => ({
      selection,
      transport,
      beforeDispatch: async (start) => start(),
    }),
  });
  const models = createModels();
  models.setProvider(provider);
  const message = await models.completeSimple(
    models.getModel("niaro", "chat")!,
    {
      messages: [{ role: "user", content: "find Ada", timestamp: 1 }],
      tools: [
        { name: "lookup", description: "Find", parameters: { type: "object" } },
      ],
    },
  );
  assert.equal(message.stopReason, "toolUse");
  const call = message.content[0] as {
    type: string;
    id: string;
    name: string;
    arguments: object;
  };
  assert.equal(call.name, "lookup");
  assert.deepEqual(call.arguments, { name: "Ada" });
  assert.notEqual(call.id, "provider-call-1");
});
