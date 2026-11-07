/**
 * The agent core's owner: one Pi Durable Harness over one node:sqlite file,
 * opened when the server starts and closed when it stops. Every model request
 * goes through Niaro's provider (`provider.ts`), bound to the conversation's
 * scope (`scope.ts`).
 *
 * Recovery policy A (owner decision 2026-11-07): after a restart Pi resumes
 * its work. A model request the process died during counts as a failed
 * attempt and may be retried, each attempt reserved against the budget, at
 * most `retry.maxRetries` times and `restartLimit` crashes in a row. External
 * writes are never re-run blindly (`tools.ts`).
 */
import { chmodSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  ProviderDoc,
  type Conversation,
  type HarnessSettings,
  type Report,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RouteKey } from "../../../packages/protocol/model-policy";
import { IntegrationError } from "../../server-integrations/transport";
import { ctx } from "./context";
import {
  NATIVE_MODEL,
  NATIVE_PROVIDER,
  NativeAgentHost,
  createPiAgentRuntime,
} from "./native-agent";
import { RECOVERY_POLICY_A } from "./policy";
import {
  executeProcessRun,
  processEngineExtension,
  proveProcessRunRetired,
  type NativeWorkflowInput,
} from "./process-engine";
import {
  BASE_ROUTES,
  niaroPiProvider,
  type NiaroPiProvider,
  type PiCallPlan,
} from "./provider";
import {
  bindingExtension,
  CallBindings,
  ScopeDoc,
  type CallBinding,
  type NiaroScope,
} from "./scope";

export { ctx, RECOVERY_POLICY_A };

export type ScopedModelCall = {
  route: string;
  binding: CallBinding & { scope: NiaroScope };
  signal: AbortSignal | undefined;
};
/** Builds the plan of one request for a conversation's bound scope. */
export type ScopedModelHost = {
  plan(call: ScopedModelCall): Promise<PiCallPlan>;
};
type Extension = Parameters<ReturnType<typeof createRegistry>["install"]>[0];

export type PiAgentCoreOptions = {
  /** The node:sqlite file of the agent core, created private (0600); absent: memory only. */
  file?: string;
  host: ScopedModelHost;
  /** Extensions of later waves (processes, chat); the binding one is always installed. */
  extensions?: readonly Extension[];
  settings?: HarnessSettings;
  onReport?: (report: Report) => void;
  /** Start scheduling right after open, resuming interrupted work. Default true. */
  resume?: boolean;
  routes?: Iterable<string>;
};

export class PiAgentCore {
  private constructor(
    readonly harness: Harness,
    readonly provider: NiaroPiProvider,
    readonly bindings: CallBindings,
    readonly native: NativeAgentHost,
  ) {}

  static async open(options: PiAgentCoreOptions) {
    const bindings = new CallBindings();
    const provider = niaroPiProvider(
      {
        plan: async (call) => {
          const binding = bindings.get(call.sessionId);
          // Never dispatch a request nobody's scope accounts for.
          if (!binding?.scope)
            throw new IntegrationError("niaro_scope_missing", 409);
          return options.host.plan({
            route: call.route,
            binding: { ...binding, scope: binding.scope },
            signal: call.signal,
          });
        },
      },
      options.routes ?? BASE_ROUTES,
    );
    const models = createModels();
    models.setProvider(provider);
    // The native agent contract (chat, NIAR-304) through its own provider.
    const native = new NativeAgentHost();
    models.setProvider(native.provider());
    const registry = createRegistry();
    const binding = bindingExtension(bindings);
    const nativeExtension = native.extension();
    const base = [
      binding,
      processEngineExtension,
      nativeExtension,
      ...(options.extensions ?? []),
    ];
    for (const extension of base) registry.install(extension);
    // Run tools live in one extension per native conversation; only that
    // conversation selects it.
    const runTools = new Map<string, Extension>();
    native.installTools = (conversationId, names) => {
      const extension = defineExtension({
        name: `niaro-native-tools-${conversationId}`,
        tools: names.map((name) => native.tool(name)),
      });
      registry.install(extension);
      runTools.set(conversationId, extension);
    };
    native.extensionsFor = (conversationId) => [
      binding,
      nativeExtension,
      ...(runTools.has(conversationId) ? [runTools.get(conversationId)!] : []),
    ];
    const storage = options.file
      ? await openNodeSqliteStorage(options.file)
      : new MemoryStorage();
    if (options.file) chmodSync(options.file, 0o600);
    const settings = options.settings ?? {};
    let harness: Harness;
    try {
      harness = await Harness.open(
        storage,
        {
          models,
          registry,
          // Niaro's requests carry no third-party attribution headers.
          identity: { attribution: null },
          settings: () => ({
            // Conversations select the base extensions unless they choose.
            extensions: base,
            ...settings,
            compaction: {
              ...settings.compaction,
              modelOverrides: {
                ...settings.compaction?.modelOverrides,
                // The domain bounds a native thread's context itself; a
                // summary would need a model call no session is bound to.
                [`${NATIVE_PROVIDER}/${NATIVE_MODEL}`]: { enabled: false },
              },
            },
            retry: {
              ...RECOVERY_POLICY_A.retry,
              ...settings.retry,
              maxRetries: Math.min(
                settings.retry?.maxRetries ?? Infinity,
                RECOVERY_POLICY_A.retry.maxRetries,
              ),
            },
            restartLimit: Math.min(
              settings.restartLimit ?? Infinity,
              RECOVERY_POLICY_A.restartLimit,
            ),
          }),
          // Its provider session exists from the start, so the first request
          // of a conversation is bound like every later one.
          conversationCreated: async (tx, conversation) => {
            await tx.doc(ProviderDoc, conversation.id);
          },
          onReport: options.onReport,
        },
        ctx,
      );
    } catch (error) {
      await storage.close(ctx).catch(() => undefined);
      throw error;
    }
    // Process runs are background tasks of the root conversation.
    await harness.root(ctx);
    // Calls waiting for a person resolve their tools again before resume.
    await native.restore(harness);
    if (options.resume !== false) harness.resume();
    return new PiAgentCore(harness, provider, bindings, native);
  }

  /** A conversation acting for a member in a workspace; its model is a policy route. */
  createConversation(
    scope: NiaroScope,
    route: RouteKey = "chat",
  ): Promise<Conversation> {
    return this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: this.provider.route(route) },
        init: async (tx, id) => {
          Object.assign(await tx.doc(ScopeDoc, id), scope);
        },
      },
      ctx,
    );
  }

  /** Drive a service process run until it waits, succeeds or fails (NIAR-303). */
  executeProcess(input: NativeWorkflowInput) {
    return executeProcessRun(this.harness, input);
  }

  /** Passive proof that a process run ended or waits; nothing runs. */
  proveProcessRetired(input: Parameters<typeof proveProcessRunRetired>[1]) {
    return proveProcessRunRetired(this.harness, input);
  }

  /** The native agent runtime (chat) on this core (NIAR-304). */
  agentRuntime() {
    return (this.runtime ??= createPiAgentRuntime(this));
  }
  private runtime: ReturnType<typeof createPiAgentRuntime> | undefined;

  async close() {
    await this.runtime?.close();
    return this.harness.close(ctx);
  }
}
