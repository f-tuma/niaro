/**
 * One Niaro-on-Pi process: a deterministic scripted model (pi-ai faux provider with a
 * response factory that reads the context), the budget gate around it, the fake service,
 * and the policy extensions.
 */
import { contentText, createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type HarnessSettings, type Storage } from "@earendil-works/pi-durable";
import { ctx } from "./kit.ts";
import { budgetedProvider, budgetExtension, Member, NiaroDb, notesService, policyExtension, type ApprovalRequest, type ServiceOptions } from "./policy.ts";

export const LONG_ANSWER = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

export type ScriptOptions = {
  tokensPerSecond?: number;
  /** When a write result says it was interrupted, call the write again (what a real model often does). */
  retryInterruptedWrite?: boolean;
};

let callSeq = 0;
/** The scripted model: decides only from the context, so a resumed process continues where the old one stopped. */
function respond(context: TranscriptContext, o: ScriptOptions) {
  const messages = context.messages;
  const last: any = messages[messages.length - 1];
  const id = `call_${process.pid}_${++callSeq}`;
  if (last?.role === "toolResult") {
    const text = contentText(last.content);
    const interruptedBefore = messages.filter((m: any) => m.role === "toolResult" && m.isError && /interrupted/.test(contentText(m.content))).length;
    if (last.isError && /interrupted/.test(text) && o.retryInterruptedWrite && interruptedBefore === 1) {
      const call = [...messages].reverse().find((m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "toolCall")) as any;
      const tc = call.content.find((c: any) => c.type === "toolCall");
      return fauxAssistantMessage([fauxText("That was interrupted; trying again."), fauxToolCall(tc.name, tc.arguments, { id })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`${last.isError ? "The tool failed" : "Done"}: ${text}`);
  }
  const userText = last?.role === "user" ? contentText(last.content as never) : "";
  const write = /write (.+)/.exec(userText);
  if (write) return fauxAssistantMessage(fauxToolCall("write_note", { text: write[1]! }, { id }), { stopReason: "toolUse" });
  const read = /read (\w+)/.exec(userText);
  if (read) return fauxAssistantMessage(fauxToolCall("read_contact", { name: read[1]! }, { id }), { stopReason: "toolUse" });
  if (/long/.test(userText)) return fauxAssistantMessage(LONG_ANSWER);
  return fauxAssistantMessage(`You said: ${userText}`);
}

export type OpenOptions = {
  storage: Storage;
  niaro: NiaroDb;
  service?: Omit<ServiceOptions, "niaro">;
  capMicros?: number;
  script?: ScriptOptions;
  onApprovalRequested?: (conversationId: string, req: ApprovalRequest) => void;
  settings?: HarnessSettings;
};

export async function openNiaro(o: OpenOptions) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "scripted", cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }, maxTokens: 200, contextWindow: 100_000 }],
    tokensPerSecond: o.script?.tokensPerSecond,
  });
  faux.setResponses(Array.from({ length: 200 }, () => (context: TranscriptContext) => respond(context, o.script ?? {})));
  const runKeys = new Map<string, string>();
  const models = createModels();
  models.setProvider(budgetedProvider(faux.provider, { niaro: o.niaro, capMicros: o.capMicros ?? 1_000_000, runKeys }));
  const service = notesService({ niaro: o.niaro, ...o.service });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "notes", tools: service.tools }));
  registry.install(policyExtension({ niaro: o.niaro, onApprovalRequested: o.onApprovalRequested }));
  registry.install(budgetExtension(runKeys));
  const harness = await Harness.open(
    o.storage,
    { models, registry, settings: { retry: { maxRetries: 2, baseDelayMs: 50 } as never, ...o.settings }, onReport: (r) => console.log(`  [pi report] ${r.kind}${"reason" in r && r.reason ? " " + r.reason : ""}`) },
    ctx,
  );
  const root = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "scripted" } },
    init: async (tx, id) => {
      Object.assign(await tx.doc(Member, id), { userId: "user-ada", workspaceId: "ws-1" });
    },
  });
  return { harness, root, faux, service, runKeys };
}
