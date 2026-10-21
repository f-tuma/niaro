import type { Conversation } from "../protocol";
import type { ClientSession } from "./session";

/** Speak a correlated server reply, including a recorded rejection explanation. */
export function followSpokenReply(
  session: Pick<ClientSession, "getSnapshot" | "subscribe">,
  commandId: string,
  target: string,
  speak: (conversation?: Conversation) => Promise<void>,
  release: () => void,
  conversationId = "conversation-1",
) {
  let finished = false;
  let speaking = false;
  let unsubscribe = () => {};
  const finish = () => {
    if (finished) return;
    finished = true;
    unsubscribe();
    release();
  };
  const update = () => {
    if (finished || speaking) return;
    const state = session.getSnapshot();
    if (
      state.status !== "online" ||
      (state.pending && state.pending.commandId !== commandId) ||
      state.commandStates[target] === "network_error"
    ) {
      finish();
      return;
    }
    if (state.pending?.commandId === commandId) return;
    const conversation = state.store?.conversations[conversationId];
    const recordedRejection =
      ["rejected", "conflict"].includes(state.commandStates[target] ?? "") &&
      conversation?.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.replyToCommandId === commandId &&
          !!message.text.trim(),
      );
    if (state.commandStates[target] !== "accepted" && !recordedRejection) {
      finish();
      return;
    }
    speaking = true;
    unsubscribe();
    void speak(conversation)
      .catch(() => {})
      .finally(finish);
  };
  unsubscribe = session.subscribe(update);
  update();
  return finish;
}
