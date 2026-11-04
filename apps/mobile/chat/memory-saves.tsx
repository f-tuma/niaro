import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, View } from "react-native";
import type { ClientSession } from "../../../packages/client-core/session";
import type { Language } from "../../../packages/protocol";
import type { MemoryItem } from "../../../packages/protocol/memory";
import {
  chatMemoryQuery,
  memorySavesByCommand,
} from "../../../packages/client-core/memory-saves";
import { translate } from "../../../packages/i18n";
import { tokens as t } from "../../../packages/design-tokens";
import { Icon, Text } from "../../../packages/ui";

/** What the chat knows of its saves to memory (NIAR-292). */
export type ChatMemorySaves = {
  forCommand: (commandId: string) => readonly MemoryItem[];
  /** Erases the memory; its line goes with the next read. */
  forget: (item: MemoryItem) => Promise<void>;
};

/**
 * This chat's saves to memory, read again whenever the pet changed anywhere
 * (`changes`) and when a new answer arrives (`answers`).
 */
export function useChatMemorySaves(
  session: ClientSession | null,
  conversationId: string,
  changes: number,
  answers: number,
  newId: () => string,
): ChatMemorySaves {
  const [items, setItems] = useState<{
    owner: string;
    items: readonly MemoryItem[];
  }>();
  const ticket = useRef(0);
  const read = useCallback(async () => {
    const own = ++ticket.current;
    if (!session) return;
    try {
      const page = await session.petMemory(chatMemoryQuery(conversationId));
      if (own === ticket.current)
        setItems({ owner: conversationId, items: page?.items ?? [] });
    } catch {
      // No line is better than a wrong one; the next change reads again.
    }
  }, [session, conversationId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize with the server's memory when the pet or the chat changed.
    void read();
  }, [read, changes, answers]);
  const current = items?.owner === conversationId ? items.items : undefined;
  const byCommand = useMemo(
    () => memorySavesByCommand(current ?? []),
    [current],
  );
  return {
    forCommand: (commandId) => byCommand.get(commandId) ?? [],
    forget: async (item) => {
      if (!session) return;
      await session.savePetMemory({
        type: "forget",
        requestId: newId(),
        id: item.id,
        revision: item.revision,
      });
      await read();
    },
  };
}

/**
 * "Saved to memory: …" under the reply that saved it, each with Delete. A
 * quiet line, no card: a failed delete leaves the line as it is.
 */
export function MemorySaveLines({
  saves,
  commandId,
  language,
  disabled,
}: {
  saves?: ChatMemorySaves;
  commandId?: string;
  language: Language;
  /** Archived chat, offline or busy: the line shows, Delete waits. */
  disabled: boolean;
}) {
  const tr = translate(language);
  const [deleting, setDeleting] = useState<string>();
  const items = commandId && saves ? saves.forCommand(commandId) : [];
  if (!items.length) return null;
  return (
    <View testID="memory-saves" style={{ gap: 2 }}>
      {items.map((item) => (
        <View
          key={item.id}
          testID="memory-save"
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Icon name="bookmark" size={14} color={t.color.text.secondary} />
          <Text role="caption" tone="secondary" style={{ flexShrink: 1 }}>
            {`${tr("memorySavedLine")}: ${item.content}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${tr("memorySavedDeleteLabel")}: ${item.content}`}
            accessibilityState={{ disabled: disabled || deleting === item.id }}
            disabled={disabled || deleting === item.id}
            hitSlop={8}
            onPress={() => {
              setDeleting(item.id);
              void saves!
                .forget(item)
                .catch(() => {})
                .finally(() => setDeleting(undefined));
            }}
            style={({ pressed }) => [
              {
                minHeight: 36,
                justifyContent: "center",
                paddingHorizontal: 8,
                borderRadius: 18,
              },
              pressed && { backgroundColor: t.color.pressed },
              (disabled || deleting === item.id) && { opacity: 0.4 },
            ]}
          >
            <Text role="caption" style={{ color: t.color.action.link }}>
              {tr("memorySavedDelete")}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
