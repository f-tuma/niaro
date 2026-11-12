import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Ciphertext only. Saved memory is storage; no agent reads this table. */
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
/** How saved memory was marked while it lived in Mastra working memory (metadata as JSONB). */
const marker = "niaro-saved-memory/1";
const LIST_LIMIT = 100_000;

type Row = {
  thread_id: string;
  resource_id: string;
  ciphertext: string;
  created_at: string;
  updated_at: string;
};

/**
 * Saved memory payloads in their own table (`niaro_saved_memory`) of the
 * native store file. A file that still holds them as Mastra working-memory
 * threads (before NIAR-304) moves them here once, in one transaction, and
 * those threads are deleted.
 */
export function createNativeSavedMemory(storageUrl: string): NativeSavedMemory {
  const file = storageUrl.startsWith("file:")
    ? fileURLToPath(storageUrl)
    : undefined;
  const db = new DatabaseSync(file ?? ":memory:");
  let closed = false;
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; " +
        "CREATE TABLE IF NOT EXISTS niaro_saved_memory (thread_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT",
    );
    migrateMastraThreads(db);
    if (file)
      for (const path of [file, file + "-wal", file + "-shm"])
        if (existsSync(path)) chmodSync(path, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  const row = (threadId: string, resourceId: string) => {
    const found = db
      .prepare("SELECT * FROM niaro_saved_memory WHERE thread_id=?")
      .get(threadId) as Row | undefined;
    if (found && found.resource_id !== resourceId)
      throw Error("memory_native_scope_mismatch");
    return found;
  };
  const open = <T>(run: () => T) =>
    closed
      ? Promise.reject<T>(Error("memory_native_closed"))
      : Promise.resolve().then(run);
  return {
    put: (document) =>
      open(() => {
        const existing = row(document.threadId, document.resourceId);
        if (existing) {
          if (
            existing.ciphertext !== document.ciphertext ||
            existing.created_at !== document.createdAt ||
            existing.updated_at !== document.updatedAt
          )
            throw Error("memory_native_immutable_conflict");
          return;
        }
        db.prepare("INSERT INTO niaro_saved_memory VALUES (?,?,?,?,?)").run(
          document.threadId,
          document.resourceId,
          document.ciphertext,
          document.createdAt,
          document.updatedAt,
        );
        if (
          row(document.threadId, document.resourceId)?.ciphertext !==
          document.ciphertext
        )
          throw Error("memory_native_write_unverified");
      }),
    read: (threadId, resourceId) =>
      open(() => row(threadId, resourceId)?.ciphertext ?? null),
    remove: (threadId, resourceId) =>
      open(() => {
        if (row(threadId, resourceId))
          db.prepare("DELETE FROM niaro_saved_memory WHERE thread_id=?").run(
            threadId,
          );
        if (row(threadId, resourceId))
          throw Error("memory_native_erasure_unverified");
      }),
    list: () =>
      open(() => {
        const refs = db
          .prepare(
            "SELECT thread_id AS threadId, resource_id AS resourceId FROM niaro_saved_memory ORDER BY thread_id LIMIT ?",
          )
          .all(LIST_LIMIT + 1) as { threadId: string; resourceId: string }[];
        if (refs.length > LIST_LIMIT)
          throw Error("memory_native_inventory_limit");
        return refs.map(({ threadId, resourceId }) => ({
          threadId,
          resourceId,
        }));
      }),
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** One-time move of saved memory out of Mastra working-memory threads. */
function migrateMastraThreads(db: DatabaseSync) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mastra_threads'",
      )
      .get()
  )
    return;
  const where = "json_valid(metadata, 6) AND metadata->>'niaroSavedMemory'=?";
  const threads = db
    .prepare(
      `SELECT id, resourceId, createdAt, updatedAt, metadata->>'workingMemory' AS ciphertext FROM mastra_threads WHERE ${where}`,
    )
    .all(marker);
  if (!threads.length) return;
  const iso = (value: unknown) => new Date(String(value)).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT INTO niaro_saved_memory VALUES (?,?,?,?,?)",
    );
    for (const thread of threads) {
      if (typeof thread.ciphertext !== "string")
        throw Error("memory_native_migration_invalid");
      insert.run(
        String(thread.id),
        String(thread.resourceId),
        thread.ciphertext,
        iso(thread.createdAt),
        iso(thread.updatedAt),
      );
    }
    db.prepare(`DELETE FROM mastra_threads WHERE ${where}`).run(marker);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
