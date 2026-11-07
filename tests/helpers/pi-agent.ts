/**
 * Test kit for the Pi agent core: a real service catalog and budget ledger
 * on node:sqlite, and a fake integration transport that answers like an
 * OpenAI-compatible provider. Nothing here touches the network.
 */
import { DatabaseSync } from "node:sqlite";
import type { InferencePrice } from "../../packages/protocol/inference-budget";
import { CatalogCommand } from "../../packages/protocol/service-catalog";
import { ServiceCatalogStore } from "../../apps/server-identity/service-catalog";
import {
  streamingTransport,
  type IntegrationTransport,
  type TransportRequest,
  type TransportResponse,
} from "../../apps/server-integrations/transport";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PiAgentCore } from "@niaro/server-agent/pi";

/**
 * Pi and the agent core are ESM-only: the repository's CommonJS-scoped code
 * loads them through import(), as the identity server does.
 */
export const loadPi = () => import("@niaro/server-agent/pi");
export const loadPiAi = () => import("@earendil-works/pi-ai");
export const loadPiDurable = () => import("@earendil-works/pi-durable");

export const piScope = {
  organizationId: "org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "TEST-alice",
};

/**
 * A catalog with two keyed providers and three chat models; no policy yet.
 * `seed: false` reopens an existing file (a resumed crash test process).
 */
export function piCatalog(path = ":memory:", seed = true) {
  const db = new DatabaseSync(path);
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);INSERT OR IGNORE INTO organization VALUES ('org');INSERT OR IGNORE INTO agent_workspace VALUES ('${piScope.workspaceId}','org');`,
  );
  const store = new ServiceCatalogStore(db, "test-only-secret", []);
  const command = (body: object) =>
    store.command(
      CatalogCommand.parse({
        organizationId: piScope.organizationId,
        workspaceId: piScope.workspaceId,
        ...body,
      }),
    ) as string;
  const existing = (name: string) =>
    String(
      (
        db
          .prepare(
            "SELECT id FROM agent_catalog WHERE json_extract(data,'$.name')=?",
          )
          .get(name) as { id: string }
      ).id,
    );
  const provider = (name: string, host: string, apiKey: string) =>
    !seed
      ? existing(name)
      : command({
          type: "saveProvider",
          revision: 0,
          settings: {
            name,
            url: `https://${host}/v1`,
            enabled: true,
            dailyRequestLimit: 100,
            dialect: "openai",
          },
          apiKey,
        });
  const model = (providerId: string, name: string, wire: string) =>
    !seed
      ? existing(name)
      : command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId,
            name,
            model: wire,
            enabled: true,
            tools: true,
            kind: "chat",
          },
        });
  const gateway = provider(
    "TEST gateway",
    "gateway.example.test",
    "TEST-key-gateway",
  );
  const backup = provider(
    "TEST backup",
    "backup.example.test",
    "TEST-key-backup",
  );
  const models = {
    fast: model(gateway, "TEST fast", "vendor/fast"),
    careful: model(gateway, "TEST careful", "vendor/careful"),
    spare: model(backup, "TEST spare", "other/spare"),
  };
  return { db, store, command, providers: { gateway, backup }, models };
}
export type PiCatalog = ReturnType<typeof piCatalog>;

/** Enforced limits with a price for each given model. */
export function enforce(
  catalog: PiCatalog,
  modelIds: string[],
  limits: {
    maxTokens?: number;
    maxCostMicros?: number;
    maxOutputTokens?: number;
  } = {},
) {
  const prices: InferencePrice[] = modelIds.map((modelId) => ({
    modelId,
    modelRevision: 1,
    providerRevision: 1,
    maxInputTokens: 100_000,
    maxOutputTokens: limits.maxOutputTokens ?? 200,
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 2_000_000,
  }));
  catalog.store.inferenceBudget.savePolicy(
    piScope.organizationId,
    piScope.workspaceId,
    catalog.store.inferenceBudget.storedPolicy(
      piScope.organizationId,
      piScope.workspaceId,
    ).revision,
    {
      mode: "enforce",
      maxTokens: limits.maxTokens ?? 1_000_000,
      maxCostMicros: limits.maxCostMicros ?? 1_000_000,
      prices,
    },
  );
}

export type Reply =
  | { kind: "text"; text: string; usage?: object }
  | { kind: "tool"; name: string; args: object; usage?: object }
  | { kind: "status"; status: number; body: string }
  | { kind: "throw"; error: Error };
export type SeenRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

const usage = { prompt_tokens: 120, completion_tokens: 8 };
function completionBody(reply: Exclude<Reply, { kind: "status" | "throw" }>) {
  return {
    id: "TEST-completion",
    model: "provider-side-name",
    choices: [
      reply.kind === "text"
        ? { finish_reason: "stop", message: { content: reply.text } }
        : {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "provider-call-1",
                  type: "function",
                  function: {
                    name: reply.name,
                    arguments: JSON.stringify(reply.args),
                  },
                },
              ],
            },
          },
    ],
    usage: reply.usage ?? usage,
  };
}

/**
 * A provider stand-in. Each request takes the next reply (the last one
 * repeats). `stream: true` makes it a streaming transport that sends the
 * text in server-sent events, `delayMs` between them.
 */
export function fakeTransport(
  replies: Reply[],
  options: { stream?: boolean; delayMs?: number; dispatch?: boolean } = {},
) {
  const seen: SeenRequest[] = [];
  let index = 0;
  const transport: IntegrationTransport = async (
    request: TransportRequest,
  ): Promise<TransportResponse> => {
    // Like the real transport, nothing leaves before the dispatch guard starts it.
    if (request.beforeDispatch && options.dispatch !== false) {
      let started = false;
      await request.beforeDispatch(() => {
        started = true;
      });
      if (!started) throw new Error("dispatch denied");
    }
    seen.push({
      url: request.url,
      headers: { ...request.headers },
      body: request.body as Record<string, unknown>,
    });
    const reply = replies[Math.min(index++, replies.length - 1)]!;
    if (reply.kind === "throw") throw reply.error;
    if (reply.kind === "status")
      return { status: reply.status, headers: {}, text: reply.body };
    const body = completionBody(reply);
    if (!options.stream || !request.onEvent || reply.kind !== "text")
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify(body),
      };
    const words = reply.text.split(/(?<= )/);
    const events: string[] = [];
    for (const word of words) {
      const data = JSON.stringify({
        id: body.id,
        choices: [{ index: 0, delta: { content: word } }],
      });
      events.push(data);
      request.onEvent(data);
      if (options.delayMs)
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      request.signal?.throwIfAborted();
    }
    const last = JSON.stringify({
      id: body.id,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: body.usage,
    });
    events.push(last, "[DONE]");
    request.onEvent(last);
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      text: events.map((data) => `data: ${data}\n\n`).join(""),
    };
  };
  return {
    transport: options.stream ? streamingTransport(transport) : transport,
    seen,
  };
}

/** A serial queue like the identity server's. */
export function serialQueue() {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const task = pending.then(run);
    pending = task.catch(() => undefined);
    return task;
  };
}

type EntryModel = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  content?: { type: string; text?: string; name?: string }[];
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    totalTokens: number;
  };
};
/** The transcript entries of a conversation, oldest first. */
export async function entries(
  core: PiAgentCore,
  conversationId: ConversationId | string,
) {
  const { ctx } = await loadPi();
  const conversation = await core.harness.conversation(
    conversationId as never,
    ctx,
  );
  const page = await conversation!.entries(
    { order: "ascending" },
    500,
    undefined,
    ctx,
  );
  return page.items.map((entry) => ({
    kind: entry.kind,
    message: (entry.model?.[0] ?? {}) as EntryModel,
  }));
}

/** Submit one input and wait until its run settles. */
export async function ask(
  core: PiAgentCore,
  conversationId: ConversationId | string,
  content: string,
  requestId?: string,
) {
  const { ctx } = await loadPi();
  const conversation = (await core.harness.conversation(
    conversationId as never,
    ctx,
  ))!;
  const submission = await conversation.submit(
    { type: "input", content, ...(requestId ? { requestId } : {}) },
    ctx,
  );
  const settled = await submission.wait(ctx);
  return { submission, settled };
}

/** The ledger's attempts, oldest first. */
export function attempts(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT run_id,model_id,status,reserved_cost,input_tokens,output_tokens,cost_micros FROM agent_inference_attempt ORDER BY rowid",
    )
    .all() as {
    run_id: string;
    model_id: string;
    status: string;
    reserved_cost: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_micros: number | null;
  }[];
}
