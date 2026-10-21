// Isolated synthetic crash fixture. Never imported by the application.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyDesignBrief } from "../../packages/protocol/process-design";
import { ProcessDesignConversation } from "../../apps/server-identity/process-design-conversation";
import { ProcessDesignConversationStore } from "../../apps/server-identity/process-design-conversation-store";
import { designConversationFixture } from "./process-design-conversation";

const directory = process.argv[2];
const mode = process.argv[3];
if (
  !directory ||
  !["created", "tool", "usage", "candidate", "retired"].includes(mode ?? "")
)
  throw Error("TEST design crash arguments invalid");
const h = designConversationFixture(join(directory, "identity.sqlite"));
const sessionId = h.store.start(h.actor, {
  ...h.target,
  requestId: "TEST-start",
  serviceId: h.serviceId,
}).sessionId;
const command = {
  ...h.target,
  sessionId,
  requestId: "TEST-crash-turn",
  revision: 1,
  modelId: h.modelId,
  text: "TEST durable original message",
  language: "cs" as const,
};
writeFileSync(join(directory, "command.json"), JSON.stringify(command));
const kill = (site: string): never => {
  writeFileSync(join(directory!, "cut.json"), JSON.stringify({ mode, site }));
  process.kill(process.pid, "SIGKILL");
  throw Error("TEST SIGKILL failed");
};
const atomic = ProcessDesignConversationStore.prototype.atomic;
ProcessDesignConversationStore.prototype.atomic = function <T>(
  run: () => T,
): T {
  const result = atomic.call(this, run) as T;
  if (
    mode === "created" &&
    h.db.prepare("SELECT COUNT(*) AS n FROM agent_process_design_turn").get()!
      .n === 1
  )
    kill("durable-turn-before-native-start");
  if (
    mode === "tool" &&
    h.db.prepare("SELECT COUNT(*) AS n FROM agent_process_design_tool").get()!
      .n === 1
  )
    kill("proposal-and-receipt-committed-before-native-ack");
  return result;
};
const write = ProcessDesignConversationStore.prototype.write;
ProcessDesignConversationStore.prototype.write = function (actor, state) {
  if (mode === "retired" && state.status === "completed")
    kill("native-retired-before-domain-publication");
  write.call(this, actor, state);
  if (
    mode === "candidate" &&
    state.status === "running" &&
    state.candidateReply
  )
    kill("staged-reply-before-native-retirement");
};
if (mode === "usage")
  h.onModelResponse(() => kill("provider-response-before-budget-settlement"));
h.onModel(() => {
  if (
    (mode === "tool" || mode === "candidate" || mode === "retired") &&
    h.modelCount() === 1
  )
    return h.call(
      "design_update_proposal",
      {
        revision: 1,
        brief: { ...emptyDesignBrief(), purpose: "TEST durable proposal" },
        candidate: h.workflow(),
      },
      "TEST-durable-call",
    );
  return { content: "TEST durable assistant reply" };
});
const conversation = new ProcessDesignConversation(
  h.db,
  h.store,
  h.registry,
  h.controller,
  h.plugins,
  { serverId: h.scope.serverId },
);
void conversation
  .message(h.context, command, new AbortController().signal)
  .then(() => {
    throw Error("TEST intended cut was not reached");
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
