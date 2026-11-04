import { useMemo, useState } from "react";
import { Bookmark } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import type { MemoryItem } from "../../../../../packages/protocol/memory";
import {
  chatMemoryQuery,
  memorySavesByCommand,
} from "../../../../../packages/client-core/memory-saves";
import { usePetMemory } from "../pet-memory";
import { useChatCopy } from "../chat-copy";
import { useNextChat } from "./parts";

/** What the chat knows of its saves to memory (NIAR-292). */
export type ChatMemorySaves = {
  forCommand: (commandId: string) => readonly MemoryItem[];
  /** Erases the memory; its line goes with the next read. */
  forget: (item: MemoryItem) => Promise<void>;
};

const newRequestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * The saves of this chat, followed live: the pet's event stream says when
 * memory changed, here, in About you or on the phone.
 */
export function useChatMemorySaves(conversationId: string): ChatMemorySaves {
  const memory = usePetMemory(chatMemoryQuery(conversationId));
  const items = memory.page?.items;
  const byCommand = useMemo(() => memorySavesByCommand(items ?? []), [items]);
  return {
    forCommand: (commandId) => byCommand.get(commandId) ?? [],
    forget: async (item) => {
      await memory.save({
        type: "forget",
        requestId: newRequestId(),
        id: item.id,
        revision: item.revision,
      });
      await memory.read();
    },
  };
}

/**
 * "Saved to memory: …" under the reply that saved it, each with Delete. A
 * quiet line, no card: a failed delete leaves the line as it is.
 */
export function MemorySaveLines({ commandId }: { commandId?: string }) {
  const chat = useNextChat();
  const { tr } = useChatCopy();
  const [deleting, setDeleting] = useState<string>();
  const saves = commandId
    ? (chat.memorySaves?.forCommand(commandId) ?? [])
    : [];
  if (!saves.length) return null;
  return (
    <ul data-testid="memory-saves" className="flex flex-col gap-0.5">
      {saves.map((item) => (
        <li
          key={item.id}
          data-testid="memory-save"
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Bookmark aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 break-words">
            {tr("memorySavedLine")}: {item.content}
          </span>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`${tr("memorySavedDeleteLabel")}: ${item.content}`}
            disabled={chat.readOnly || !chat.online || deleting === item.id}
            onClick={() => {
              setDeleting(item.id);
              void chat
                .memorySaves!.forget(item)
                .catch(() => {})
                .finally(() => setDeleting(undefined));
            }}
          >
            {tr("memorySavedDelete")}
          </Button>
        </li>
      ))}
    </ul>
  );
}
