/**
 * Whose a Pi conversation is, and which budget run a model request belongs
 * to. Pi gives a provider only the conversation's provider session id
 * (`pi.provider`), so a `beforeRequest` hook, which runs in the same task
 * invocation right before the request, binds that id to the conversation's
 * scope and run. A request without a bound scope is refused before dispatch.
 */
import type { Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ProviderDoc,
  type HookApi,
} from "@earendil-works/pi-durable";

/** The member and workspace a conversation acts for; written when it is created. */
export type NiaroScope = {
  organizationId: string;
  workspaceId: string;
  userId: string;
};
export const ScopeDoc = defineDoc<NiaroScope>({
  kind: "niaro.scope",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ organizationId: "", workspaceId: "", userId: "" }),
  checkpointWhen: () => true,
});

export type CallBinding = {
  conversationId: string;
  /** Undefined when the conversation was created without a scope. */
  scope: NiaroScope | undefined;
  /**
   * The budget run of the request: stable for one Pi run, so a retry after
   * a restart counts against the same run as the interrupted attempt.
   */
  runKey: string;
};

export class CallBindings {
  private readonly bySession = new Map<string, CallBinding>();
  set(sessionId: string, binding: CallBinding) {
    this.bySession.set(sessionId, binding);
  }
  get(sessionId: string | undefined) {
    return sessionId === undefined ? undefined : this.bySession.get(sessionId);
  }
  forget(conversationId: string) {
    for (const [session, binding] of this.bySession)
      if (binding.conversationId === conversationId)
        this.bySession.delete(session);
  }
}

const complete = (scope: NiaroScope | undefined) =>
  scope && scope.organizationId && scope.workspaceId && scope.userId
    ? { ...scope }
    : undefined;

async function bind(bindings: CallBindings, api: HookApi, context: Context) {
  const [scope, live, provider] = await Promise.all([
    api.snapshot(ScopeDoc, api.conversationId, context),
    api.snapshot(LiveDoc, api.conversationId, context),
    api.snapshot(ProviderDoc, api.conversationId, context),
  ]);
  // The provider session is created with the conversation (see core.ts).
  if (!provider) return;
  const conversationId = String(api.conversationId);
  const run = live?.run;
  bindings.set(provider.sessionId, {
    conversationId,
    scope: complete(scope),
    runKey: `pi:${conversationId}:${String(run?.inputs[0] ?? run?.taskId ?? api.taskId)}`,
  });
}

export function bindingExtension(bindings: CallBindings) {
  return defineExtension({
    name: "niaro-binding",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          await bind(bindings, api, context);
          return undefined;
        },
      }),
    ],
  });
}
