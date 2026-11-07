/**
 * Niaro policy on top of Pi Durable, for one fake "notes" service:
 *  - read_contact (read) and write_note (write, side effect in our own DB)
 *  - access check: a member may lose access to a service; refused in beforeTool, before intent
 *  - approval: write_note waits in beforeTool for a decision stored in a conversation document;
 *    the request itself is a durable task memo, so a restarted process can list pending approvals
 *  - hard budget: a provider wrapper reserves an estimate against a per-run cap before each model
 *    call, refuses the call when it would exceed the cap, settles actual usage after the response
 *
 * Our own state (ledger, side effects, access) lives in a separate node:sqlite file, the way Niaro
 * keeps it in the identity database.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ProviderDoc,
  ToolTask,
  type HookApi,
  type JsonObject,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT as BG, type Context } from "@earendil-works/chord/context";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------- our own DB

export class NiaroDb {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS attempt (id INTEGER PRIMARY KEY, run_key TEXT NOT NULL, model TEXT NOT NULL,
        status TEXT NOT NULL, reserved_micros INTEGER NOT NULL, cost_micros INTEGER, input_tokens INTEGER, output_tokens INTEGER);
      CREATE TABLE IF NOT EXISTS side_effect (idempotency_key TEXT PRIMARY KEY, text TEXT NOT NULL, executions INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access (user_id TEXT NOT NULL, service TEXT NOT NULL, PRIMARY KEY(user_id, service));
      CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, line TEXT NOT NULL);`);
  }
  log(line: string) {
    this.db.prepare("INSERT INTO log(line) VALUES (?)").run(line);
  }
  // access
  grant(userId: string, service: string) {
    this.db.prepare("INSERT OR IGNORE INTO access VALUES (?,?)").run(userId, service);
  }
  revoke(userId: string, service: string) {
    this.db.prepare("DELETE FROM access WHERE user_id=? AND service=?").run(userId, service);
  }
  mayUse(userId: string, service: string) {
    return !!this.db.prepare("SELECT 1 FROM access WHERE user_id=? AND service=?").get(userId, service);
  }
  // side effects with an idempotency key: the second call with the same key does not execute again
  applyOnce(key: string, text: string): { executed: boolean } {
    const r = this.db.prepare("INSERT INTO side_effect VALUES (?,?,1) ON CONFLICT(idempotency_key) DO NOTHING").run(key, text);
    return { executed: r.changes === 1 };
  }
  sideEffects() {
    return this.db.prepare("SELECT * FROM side_effect").all() as { idempotency_key: string; text: string; executions: number }[];
  }
  // budget ledger (concepts of apps/server-identity/inference-budget.ts: reserve -> dispatch -> settle | unknown)
  accounted(runKey: string): number {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN cost_micros
                                   WHEN status IN ('dispatched','unknown') THEN reserved_micros ELSE 0 END),0) AS n
         FROM attempt WHERE run_key=?`,
      )
      .get(runKey) as { n: number };
    return Number(r.n);
  }
  reserve(runKey: string, model: string, micros: number, capMicros: number): number | { refused: string } {
    const accounted = this.accounted(runKey);
    if (accounted + micros > capMicros) {
      this.db.prepare("INSERT INTO attempt(run_key,model,status,reserved_micros) VALUES (?,?,'refused',?)").run(runKey, model, micros);
      return { refused: `accounted ${accounted} + reservation ${micros} > cap ${capMicros} micro-USD` };
    }
    // Reserved and dispatched in one step here; Niaro keeps them apart to prove "never dispatched".
    return Number(
      this.db.prepare("INSERT INTO attempt(run_key,model,status,reserved_micros) VALUES (?,?,'dispatched',?)").run(runKey, model, micros)
        .lastInsertRowid,
    );
  }
  settle(id: number, usage: { input: number; output: number; costMicros: number } | null) {
    if (usage === null) this.db.prepare("UPDATE attempt SET status='unknown' WHERE id=? AND status='dispatched'").run(id);
    else
      this.db
        .prepare("UPDATE attempt SET status='settled', cost_micros=?, input_tokens=?, output_tokens=? WHERE id=? AND status='dispatched'")
        .run(usage.costMicros, usage.input, usage.output, id);
  }
  attempts() {
    return this.db.prepare("SELECT id,run_key,model,status,reserved_micros,cost_micros,input_tokens,output_tokens FROM attempt ORDER BY id").all();
  }
}

// ---------------------------------------------------------------- conversation documents

/** Who the conversation belongs to; written when it is created. */
export const Member = defineDoc<{ userId: string; workspaceId: string }>({
  kind: "niaro.member",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ userId: "", workspaceId: "" }),
  checkpointWhen: () => true,
});

/** Member decisions on approvals, keyed by tool call id. */
export const Approvals = defineDoc<{ decisions: Record<string, { approved: boolean; reason?: string; by: string }> }>({
  kind: "niaro.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ decisions: {} }),
  checkpointWhen: () => true,
});

// ---------------------------------------------------------------- the fake service

export type ServiceOptions = {
  niaro: NiaroDb;
  /** "unsafe" (Pi default) or "safe" for the write tool. */
  writeReplay?: "safe" | "unsafe";
  /** Idempotency key strategy for the write: per Pi tool task, or derived from the call content. */
  idempotency?: "task" | "content" | "none";
  /** Test hook: runs after the side effect, before execute() returns (crash window of Q3b). */
  afterSideEffect?: () => Promise<void>;
};

export const SERVICE_OF: Record<string, string> = { read_contact: "notes.read", write_note: "notes.write" };
export const WRITE_TOOLS = new Set(["write_note"]);

export function notesService(o: ServiceOptions) {
  const counters = { read: 0, writeCalls: 0 };
  const readContact = defineTool({
    name: "read_contact",
    description: "Read a contact from the notes service",
    parameters: obj({ name: str() }),
    replay: "safe",
    execute: async (args) => {
      counters.read++;
      return { output: [{ type: "text", text: `${args.name}: ada@example.test` }] };
    },
  });
  const writeNote = defineTool({
    name: "write_note",
    description: "Write a note into the notes service (a write: needs the member's approval)",
    parameters: obj({ text: str() }),
    replay: o.writeReplay ?? "unsafe",
    execute: async (args, api) => {
      counters.writeCalls++;
      const key =
        o.idempotency === "task"
          ? `task:${api.taskId}`
          : o.idempotency === "content"
            ? // Stable across a model retry of the same write in the same conversation.
              `content:${createHash("sha256").update(JSON.stringify([api.conversationId, "write_note", args.text])).digest("hex").slice(0, 16)}`
            : `call:${api.callId}:${Math.random()}`;
      const { executed } = o.niaro.applyOnce(key, args.text);
      o.niaro.log(`write_note execute key=${key} executed=${executed}`);
      await o.afterSideEffect?.();
      return { output: [{ type: "text", text: executed ? `Saved note "${args.text}".` : `Note "${args.text}" was already saved (idempotent replay).` }] };
    },
  });
  return { tools: [readContact, writeNote], counters };
}

// ---------------------------------------------------------------- access + approval hooks

export type ApprovalRequest = { callId: string; tool: string; arguments: { [key: string]: JsonValue }; requestedAt: number };

export function policyExtension(o: {
  niaro: NiaroDb;
  /** Called whenever a write starts waiting (also again after a restart re-runs the hook). */
  onApprovalRequested?: (conversationId: string, req: ApprovalRequest) => void;
  pollMs?: number;
}) {
  const access = async (call: ToolHookCall, api: HookApi) => {
    const member = await api.snapshot(Member, api.conversationId, BG);
    const service = SERVICE_OF[call.name];
    if (!member?.userId || (service && !o.niaro.mayUse(member.userId, service))) {
      o.niaro.log(`access refused ${call.name} for ${member?.userId}`);
      return { block: `access_denied: ${member?.userId ?? "unknown member"} may not use ${service}` };
    }
    return undefined;
  };
  const approval = async (call: ToolHookCall, api: HookApi, context: Context) => {
    if (!WRITE_TOOLS.has(call.name)) return undefined;
    // Durable request: first writer wins, a rerun after a restart gets the same record back.
    const req = await api.memo<ApprovalRequest>(
      "niaro.approval",
      { callId: call.id, tool: call.name, arguments: call.arguments as JsonObject, requestedAt: Date.now() },
      context,
    );
    o.onApprovalRequested?.(String(api.conversationId), req);
    for (;;) {
      const decision = (await api.snapshot(Approvals, api.conversationId, context))?.decisions[call.id];
      if (decision) {
        o.niaro.log(`approval ${call.id} ${decision.approved ? "approved" : "rejected"}`);
        return decision.approved ? undefined : { block: `rejected by ${decision.by}${decision.reason ? ": " + decision.reason : ""}` };
      }
      if (context.abortSignal?.aborted) throw new Error("aborted while waiting for approval");
      await new Promise((r) => setTimeout(r, o.pollMs ?? 50));
    }
  };
  return defineExtension({
    name: "niaro-policy",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => (await access(call, api)) ?? (await approval(call, api, context)),
      }),
    ],
  });
}

// ---------------------------------------------------------------- budget gate

/**
 * Pi gives the provider only `sessionId` (pi.provider, one per conversation). A beforeRequest hook,
 * which runs right before the request in the same task invocation, records the run key for it.
 */
export function budgetExtension(runKeys: Map<string, string>) {
  return defineExtension({
    name: "niaro-budget",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const [live, provider] = await Promise.all([
            api.snapshot(LiveDoc, api.conversationId, context),
            api.snapshot(ProviderDoc, api.conversationId, context),
          ]);
          if (provider) runKeys.set(provider.sessionId, String(live?.run?.inputs[0] ?? api.conversationId));
          return undefined;
        },
      }),
    ],
  });
}

const BYTES_MARGIN = 1024;

/** Wraps a provider: reserve before the call, refuse over the cap, settle after. */
export function budgetedProvider(inner: Provider, o: { niaro: NiaroDb; capMicros: number; runKeys: Map<string, string> }): Provider {
  const gate = (call: "stream" | "streamSimple") =>
    (model: Model<any>, context: TranscriptContext, options?: any): AssistantMessageEventStream => {
      const runKey = o.runKeys.get(options?.sessionId) ?? `session:${options?.sessionId}`;
      // Conservative estimate like Niaro's: serialized bytes (+ margin) as input tokens, full output ceiling.
      const inputTokens = Buffer.byteLength(JSON.stringify(context)) + BYTES_MARGIN;
      const outputTokens = options?.maxTokens ?? model.maxTokens;
      const micros = Math.ceil(inputTokens * model.cost.input + outputTokens * model.cost.output); // $/Mtok == micro-USD/token
      const reserved = o.niaro.reserve(runKey, `${model.provider}/${model.id}`, micros, o.capMicros);
      if (typeof reserved !== "number") {
        o.niaro.log(`budget refused ${runKey}: ${reserved.refused}`);
        const s = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error",
          // Not matched by pi-ai's retryable patterns, so Pi fails the run instead of retrying.
          errorMessage: `budget_exhausted: ${reserved.refused}`,
          timestamp: Date.now(),
        } as AssistantMessage;
        queueMicrotask(() => s.push({ type: "error", reason: "error", error: message } as never));
        return s;
      }
      const stream = (inner as any)[call](model, context, options) as AssistantMessageEventStream;
      stream.result().then(
        (m) => {
          const known = m.usage && m.usage.totalTokens > 0;
          // Provider-reported cost when present (real providers via pi-ai); otherwise our own tariff from the
          // model price (the faux provider reports none). Unknown usage keeps the reservation as a hold.
          const cost = m.usage?.cost.total ? m.usage.cost.total : known ? calculateCost(model, m.usage).total : 0;
          o.niaro.settle(reserved, known ? { input: m.usage.input + m.usage.cacheRead + m.usage.cacheWrite, output: m.usage.output, costMicros: Math.round(cost * 1e6) } : null);
        },
        () => o.niaro.settle(reserved, null),
      );
      return stream;
    };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "stream") return gate("stream");
      if (prop === "streamSimple") return gate("streamSimple");
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
