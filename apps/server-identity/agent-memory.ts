import type { Language } from "../../packages/protocol";
import type { MemorySource } from "../../packages/protocol/memory";

export type AgentMemoryMetadata = {
  expiresAt?: number;
  sources?: MemorySource[];
};

/** Scoped facts and mutation receipts remain business authority, independent of the execution engine. */
export interface AgentMemory {
  context(input: {
    text: string;
    language: Language;
    conversationId?: string;
  }): Promise<{
    content: string;
    /** True when the current context projects actual facts, rather than only policy text. */
    containsFacts?: boolean;
    version: string | number;
    metadata?: AgentMemoryMetadata;
  } | null>;
  validate(
    version: string | number,
    metadata?: AgentMemoryMetadata,
  ): Promise<void>;
  metadata?(): AgentMemoryMetadata;
  tools?: unknown[];
  has?(name: string): boolean;
  invoke?(
    name: string,
    input: unknown,
    meta: {
      commandId: string;
      text: string;
      conversationId?: string;
      /**
       * The person's own earlier messages in this conversation (never tool,
       * service or assistant text). With `text`, the only words a saved
       * fact may come from.
       */
      personText?: readonly string[];
      /** The chat message's own command id, when it differs from commandId:
       * saved memory names it so the chat can show the save in place. */
      messageCommandId?: string;
      callId: string;
      /** Request lifetime and synchronous request authority, rechecked at publication. */
      signal?: AbortSignal;
      validateRequest?: () => void;
      /** Synchronous checkpoint inside the business mutation transaction. */
      checkpoint?: (
        value: unknown,
        version?: string | number,
        phase?: "revoked" | "committed",
      ) => void;
    },
  ): Promise<unknown>;
}
