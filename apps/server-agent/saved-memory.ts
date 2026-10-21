import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";

/** Ciphertext only. This Memory is never attached to an Agent. */
export type SavedMemoryDocument = {
  threadId: string;
  resourceId: string;
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
};
export interface NativeSavedMemory {
  put(document: SavedMemoryDocument): Promise<void>;
  read(threadId: string, resourceId: string): Promise<string | null>;
  remove(threadId: string, resourceId: string): Promise<void>;
  list(): Promise<{ threadId: string; resourceId: string }[]>;
  close(): Promise<void>;
}
const marker = "niaro-saved-memory/1";
export function createNativeSavedMemory(storageUrl: string): NativeSavedMemory {
  const storage = new LibSQLStore({
    id: "niaro-saved-memory",
    url: storageUrl,
  });
  const memory = new Memory({
    storage,
    options: {
      lastMessages: false,
      semanticRecall: false,
      generateTitle: false,
      workingMemory: { enabled: true, scope: "thread", agentManaged: false },
      observationalMemory: false,
    },
  });
  const ready = storage.init().then(() => {
    if (storageUrl.startsWith("file:")) {
      const file = fileURLToPath(storageUrl);
      for (const path of [file, file + "-wal", file + "-shm"])
        if (existsSync(path)) chmodSync(path, 0o600);
    }
  });
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  function serial<T>(fn: () => Promise<T>) {
    if (closed) return Promise.reject<T>(Error("memory_native_closed"));
    const result = pending.then(async () => {
      await ready;
      return fn();
    });
    pending = result.catch(() => undefined);
    return result;
  }
  async function scoped(threadId: string, resourceId: string) {
    const thread = await memory.getThreadById({ threadId });
    if (!thread) return null;
    if (
      thread.resourceId !== resourceId ||
      thread.metadata?.niaroSavedMemory !== marker
    )
      throw Error("memory_native_scope_mismatch");
    return thread;
  }
  return {
    put: (document) =>
      serial(async () => {
        const existing = await scoped(document.threadId, document.resourceId);
        if (existing) {
          if (
            existing.metadata?.workingMemory !== document.ciphertext ||
            existing.createdAt.toISOString() !== document.createdAt ||
            existing.updatedAt.toISOString() !== document.updatedAt
          )
            throw Error("memory_native_immutable_conflict");
          return;
        }
        await memory.saveThread({
          thread: {
            id: document.threadId,
            title: "Saved memory payload",
            resourceId: document.resourceId,
            createdAt: new Date(document.createdAt),
            updatedAt: new Date(document.updatedAt),
            metadata: {
              niaroSavedMemory: marker,
              workingMemory: document.ciphertext,
            },
          },
        });
        const saved = await scoped(document.threadId, document.resourceId);
        if (saved?.metadata?.workingMemory !== document.ciphertext)
          throw Error("memory_native_write_unverified");
      }),
    read: (threadId, resourceId) =>
      serial(async () => {
        if (!(await scoped(threadId, resourceId))) return null;
        return memory.getWorkingMemory({ threadId, resourceId });
      }),
    remove: (threadId, resourceId) =>
      serial(async () => {
        if (await scoped(threadId, resourceId))
          await memory.deleteThread(threadId);
        if (await scoped(threadId, resourceId))
          throw Error("memory_native_erasure_unverified");
      }),
    list: () =>
      serial(async () => {
        const refs: { threadId: string; resourceId: string }[] = [];
        for (let page = 0; page < 1000; page++) {
          const result = await memory.listThreads({
            filter: { metadata: { niaroSavedMemory: marker } },
            page,
            perPage: 100,
          });
          refs.push(
            ...result.threads.map((thread) => ({
              threadId: thread.id,
              resourceId: thread.resourceId,
            })),
          );
          if (!result.hasMore) return refs;
        }
        throw Error("memory_native_inventory_limit");
      }),
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await ready;
      await memory.settled();
      await storage.close();
    },
  };
}
