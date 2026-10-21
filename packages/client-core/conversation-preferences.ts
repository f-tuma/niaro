import { z } from "zod";
import type { KeyValueStorage } from "./preferences";
const Pins = z.strictObject({
  version: z.literal(1),
  ids: z
    .array(
      z
        .string()
        .min(1)
        .max(160)
        .regex(/^[a-zA-Z0-9._:-]+$/),
    )
    .max(1000),
});
/** Presentation IDs only. Credentials, transcripts and pending commands never enter this key. */
export const conversationPinsKey = (identityKey: string) =>
  `agent-client.conversation-pins.v1:${identityKey}`;
const operations = new WeakMap<
  KeyValueStorage,
  Map<string, Promise<unknown>>
>();
/** Reads and writes share ownership across drawer remounts, scoped to the same storage and identity. */
function serialized<T>(
  storage: KeyValueStorage,
  identityKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  let scoped = operations.get(storage);
  if (!scoped) {
    scoped = new Map();
    operations.set(storage, scoped);
  }
  const previous = scoped.get(identityKey) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  scoped.set(identityKey, current);
  const release = () => {
    if (scoped.get(identityKey) === current) scoped.delete(identityKey);
  };
  void current.then(release, release);
  return current;
}
export async function loadConversationPins(
  storage: KeyValueStorage,
  identityKey: string,
) {
  return serialized(storage, identityKey, async () => {
    const raw = await storage.getItem(conversationPinsKey(identityKey));
    if (!raw) return [];
    if (raw.length > 180_000) throw new Error("storage_error");
    const value = Pins.parse(JSON.parse(raw));
    if (new Set(value.ids).size !== value.ids.length)
      throw new Error("storage_error");
    return value.ids;
  });
}
export async function saveConversationPins(
  storage: KeyValueStorage,
  identityKey: string,
  ids: string[],
) {
  const value = Pins.parse({ version: 1, ids });
  if (new Set(value.ids).size !== value.ids.length)
    throw new Error("storage_error");
  await serialized(storage, identityKey, () =>
    storage.setItem(conversationPinsKey(identityKey), JSON.stringify(value)),
  );
}

/** Where this browser once kept its own chat names. The server names chats
 * now (`conversation.rename`); clients only remove this key. */
export const conversationNamesKey = (identityKey: string) =>
  `agent-client.conversation-names.v1:${identityKey}`;
