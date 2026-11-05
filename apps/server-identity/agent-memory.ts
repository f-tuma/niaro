import type { Language } from "../../packages/protocol";
import type { MemorySource } from "../../packages/protocol/memory";

export type AgentMemoryMetadata = {
  expiresAt?: number;
  sources?: MemorySource[];
  /**
   * Ids of the saved items that reached the model (NIAR-263). Absent means
   * unknown (an older pin, or an overflow), never "none".
   */
  items?: string[];
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
  /**
   * Whether a later turn may continue a thread pinned at `version`: every
   * listed item must still be active, unchanged, unexpired and readable, while
   * additions and changes to anything else do not matter. Resolves to the
   * version the continued thread pins from now on (NIAR-263).
   */
  continuation?(
    version: string | number,
    metadata: AgentMemoryMetadata,
  ): Promise<string | number>;
  /**
   * Whether an earlier answer that drew on these items may stay in the
   * model's history: every listed item still active, unchanged, unexpired
   * and readable, and every verified source still accessible. Unknown items
   * are never readable (NIAR-263).
   */
  readable?(metadata: AgentMemoryMetadata): Promise<boolean>;
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
