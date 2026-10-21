import { useSyncExternalStore } from "react";
import type { Command } from "../../packages/protocol";

/**
 * The main chat starts empty after an app launch and after long inactivity.
 * The server keeps every earlier session; only this device's view and the
 * model's short-term memory start over.
 */
export const CHAT_IDLE_MS = 4 * 60 * 60 * 1000;

let fresh = true;
let generation = 0;
let backgroundAt: number | null = null;
const listeners = new Set<() => void>();

export function chatBackgrounded(now = Date.now()) {
  backgroundAt ??= now;
}

/** Returns true when the pause was long enough to open a new session. */
export function chatResumed(now = Date.now()) {
  const idle = backgroundAt !== null && now - backgroundAt >= CHAT_IDLE_MS;
  backgroundAt = null;
  if (!idle) return false;
  fresh = true;
  generation++;
  listeners.forEach((listener) => listener());
  return true;
}

/** Marks the first new request of a session so the server archives the rest. */
export function withChatSession(
  command: Command,
  continueConversation = false,
): Command {
  if (continueConversation) return command;
  if (command.type !== "message.send" || command.context || !fresh)
    return command;
  fresh = false;
  return { ...command, session: "new" };
}

export function useChatGeneration() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => generation,
  );
}

/** Test helper: behave like a cold start. */
export function resetChatSession() {
  fresh = true;
  generation = 0;
  backgroundAt = null;
}
