import type { MemoryItem } from "../protocol/memory";
import type { PetMemoryQuery } from "../protocol/work-pet";

/**
 * Saves to memory made in one chat (NIAR-292). The chat shows each under the
 * reply to the request that made it, as "Saved to memory: …" with Delete; a
 * deleted memory is gone from the next read, and so is its line.
 */
export const chatMemoryQuery = (conversationId: string): PetMemoryQuery => ({
  origin: "explicit",
  conversationId,
  limit: 100,
});

/** Active saves of this chat by the command (request) that made them, oldest first. */
export function memorySavesByCommand(items: readonly MemoryItem[]) {
  const byCommand = new Map<string, MemoryItem[]>();
  for (const item of [...items].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    if (
      item.status !== "active" ||
      !item.content ||
      item.source?.type !== "user_message"
    )
      continue;
    const list = byCommand.get(item.source.commandId) ?? [];
    list.push(item);
    byCommand.set(item.source.commandId, list);
  }
  return byCommand;
}

/**
 * The requests whose saves show under one stored answer: the one that created
 * it (its id `message-<commandId>-<revision>` keeps it, engine.ts) and the one
 * it answers now (an approval moves `replyToCommandId`), creator first.
 */
export const saveCommandIds = (message: {
  id: string;
  replyToCommandId?: string;
}) => [
  ...new Set(
    [
      /^message-(.+)-\d+$/.exec(message.id)?.[1],
      message.replyToCommandId,
    ].filter((id): id is string => id !== undefined),
  ),
];
