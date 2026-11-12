import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * The workspace knowledge index (NIAR-298) in its own SQLite file next to
 * the identity database. Each passage's embedding is a float32 blob; search
 * ranks by cosine distance computed in our own SQL function. Until NIAR-305
 * the file was written by libSQL, whose files and blobs are the same, so an
 * existing index opens as it is. The index is derived: dropping the file
 * loses nothing a rebuild cannot restore.
 *
 * Every passage carries its access labels (workspace, kind, the person who
 * sent the file, the service and action of a source) and every query
 * filters by them. Callers still re-check each hit against the asker's
 * current identity before it reaches a model.
 */
export type KnowledgeKind = "file" | "service";
export type KnowledgeDocument = {
  id: string;
  workspaceId: string;
  /** `file:<content id>` or `service:<service id>/<action id>`. */
  sourceKey: string;
  kind: KnowledgeKind;
  name: string;
  /** The person who sent the file; null for a service source. */
  ownerUserId: string | null;
  serviceId: string | null;
  actionId: string | null;
  contentHash: string;
  /** The embedding model the passages were embedded with. */
  modelKey: string;
  indexedAt: number;
};
export type KnowledgePassage = {
  id: string;
  ordinal: number;
  text: string;
  vector: Float32Array;
};
export type KnowledgeHit = {
  id: string;
  documentId: string;
  workspaceId: string;
  sourceKey: string;
  kind: KnowledgeKind;
  name: string;
  ownerUserId: string | null;
  serviceId: string | null;
  actionId: string | null;
  text: string;
  distance: number | null;
};
export type KnowledgeQuery = {
  workspaceId: string;
  modelKey: string;
  vector: Float32Array;
  /** The asker: their own files only. */
  userId: string;
  /** Whether files are searched at all. */
  files: boolean;
  /** `<service id>/<action id>` of the sources the asker may read now. */
  sources: readonly string[];
  limit: number;
};
export interface KnowledgeIndex {
  documents(workspaceId: string): Promise<KnowledgeDocument[]>;
  /** Replaces a document and all its passages in one transaction. */
  replace(
    document: KnowledgeDocument,
    passages: readonly KnowledgePassage[],
  ): Promise<void>;
  remove(workspaceId: string, documentIds: readonly string[]): Promise<void>;
  /** Drops the workspace's whole index (a rebuild starts from nothing). */
  clear(workspaceId: string): Promise<void>;
  counts(
    workspaceId: string,
    modelKey: string | null,
  ): Promise<{ documents: number; chunks: number; stale: number }>;
  search(query: KnowledgeQuery): Promise<KnowledgeHit[]>;
  /** Passages by id, with their labels, for receipts. */
  passages(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<KnowledgeHit[]>;
  close(): Promise<void>;
}

const blob = (vector: Float32Array) =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
const floats = (value: Uint8Array) =>
  new Float32Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );

/**
 * 1 − cosine similarity of two float32 vectors (0 same direction, 2
 * opposite); null when the widths differ or either vector has no length.
 */
export function cosineDistance(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length || !a.length) return null;
  let dot = 0,
    left = 0,
    right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  if (!left || !right) return null;
  return 1 - dot / Math.sqrt(left * right);
}

const text = (value: unknown) => (value === null ? null : String(value));
const hit = (row: Record<string, unknown>): KnowledgeHit => ({
  id: String(row.id),
  documentId: String(row.document_id),
  workspaceId: String(row.workspace_id),
  sourceKey: String(row.source_key),
  kind: row.kind === "service" ? "service" : "file",
  name: String(row.name),
  ownerUserId: text(row.owner_user_id),
  serviceId: text(row.service_id),
  actionId: text(row.action_id),
  text: String(row.text),
  distance:
    typeof row.distance === "number" && Number.isFinite(row.distance)
      ? row.distance
      : null,
});

class SqliteKnowledgeIndex implements KnowledgeIndex {
  constructor(private readonly db: DatabaseSync) {}
  private write(run: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async documents(workspaceId: string) {
    const rows = this.db
      .prepare(
        "SELECT * FROM knowledge_documents WHERE workspace_id=? ORDER BY indexed_at",
      )
      .all(workspaceId);
    return rows.map(
      (row): KnowledgeDocument => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        sourceKey: String(row.source_key),
        kind: row.kind === "service" ? "service" : "file",
        name: String(row.name),
        ownerUserId: text(row.owner_user_id),
        serviceId: text(row.service_id),
        actionId: text(row.action_id),
        contentHash: String(row.content_hash),
        modelKey: String(row.model_key),
        indexedAt: Number(row.indexed_at),
      }),
    );
  }
  async replace(
    document: KnowledgeDocument,
    passages: readonly KnowledgePassage[],
  ) {
    const width = passages[0]?.vector.length;
    if (passages.some((passage) => passage.vector.length !== width))
      throw new Error("knowledge_dimensions_mismatch");
    const labels: SQLInputValue[] = [
      document.workspaceId,
      document.sourceKey,
      document.kind,
      document.name,
      document.ownerUserId,
      document.serviceId,
      document.actionId,
      document.modelKey,
    ];
    this.write(() => {
      this.db
        .prepare("DELETE FROM knowledge_chunks WHERE document_id=?")
        .run(document.id);
      this.db
        .prepare("DELETE FROM knowledge_documents WHERE id=?")
        .run(document.id);
      this.db
        .prepare(
          "INSERT INTO knowledge_documents(id,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,content_hash,model_key,indexed_at,chunk_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          document.id,
          document.workspaceId,
          document.sourceKey,
          document.kind,
          document.name,
          document.ownerUserId,
          document.serviceId,
          document.actionId,
          document.contentHash,
          document.modelKey,
          document.indexedAt,
          passages.length,
        );
      const insert = this.db.prepare(
        "INSERT INTO knowledge_chunks(id,document_id,ordinal,text,embedding,dimensions,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,model_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const passage of passages)
        insert.run(
          passage.id,
          document.id,
          passage.ordinal,
          passage.text,
          blob(passage.vector),
          passage.vector.length,
          ...labels,
        );
    });
  }
  async remove(workspaceId: string, documentIds: readonly string[]) {
    if (!documentIds.length) return;
    this.write(() => {
      for (const id of documentIds) {
        this.db
          .prepare(
            "DELETE FROM knowledge_chunks WHERE document_id=? AND workspace_id=?",
          )
          .run(id, workspaceId);
        this.db
          .prepare(
            "DELETE FROM knowledge_documents WHERE id=? AND workspace_id=?",
          )
          .run(id, workspaceId);
      }
    });
  }
  async clear(workspaceId: string) {
    this.write(() => {
      this.db
        .prepare("DELETE FROM knowledge_chunks WHERE workspace_id=?")
        .run(workspaceId);
      this.db
        .prepare("DELETE FROM knowledge_documents WHERE workspace_id=?")
        .run(workspaceId);
    });
  }
  async counts(workspaceId: string, modelKey: string | null) {
    const row = this.db
      .prepare(
        `SELECT
          (SELECT count(*) FROM knowledge_documents WHERE workspace_id=?1) AS documents,
          (SELECT count(*) FROM knowledge_chunks WHERE workspace_id=?1 AND model_key IS ?2) AS chunks,
          (SELECT count(*) FROM knowledge_chunks WHERE workspace_id=?1 AND model_key IS NOT ?2) AS stale`,
      )
      .get(workspaceId, modelKey)!;
    return {
      documents: Number(row.documents),
      chunks: Number(row.chunks),
      stale: Number(row.stale),
    };
  }
  async search(query: KnowledgeQuery) {
    const sources = [...new Set(query.sources)].slice(0, 200);
    if (!query.files && !sources.length) return [];
    // The labels decide what is ranked at all: the asker's own files and
    // the sources they may read, embedded with the current model only.
    const visible = [
      ...(query.files ? ["(kind='file' AND owner_user_id=?)"] : []),
      ...(sources.length
        ? [
            `(kind='service' AND service_id || '/' || action_id IN (${sources.map(() => "?").join(",")}))`,
          ]
        : []),
    ].join(" OR ");
    // A vector without direction has no distance and ranks last.
    const rows = this.db
      .prepare(
        `SELECT id,document_id,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,text,
          niaro_cosine_distance(embedding, ?) AS distance
        FROM knowledge_chunks
        WHERE workspace_id=? AND model_key=? AND dimensions=? AND (${visible})
        ORDER BY distance IS NULL, distance ASC, id LIMIT ?`,
      )
      .all(
        blob(query.vector),
        query.workspaceId,
        query.modelKey,
        query.vector.length,
        ...(query.files ? [query.userId] : []),
        ...sources,
        Math.max(1, Math.min(50, query.limit)),
      );
    return rows.map((row) => hit(row));
  }
  async passages(workspaceId: string, ids: readonly string[]) {
    const wanted = [...new Set(ids)].slice(0, 100);
    if (!wanted.length) return [];
    const rows = this.db
      .prepare(
        `SELECT id,document_id,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,text,NULL AS distance
        FROM knowledge_chunks WHERE workspace_id=? AND id IN (${wanted.map(() => "?").join(",")})`,
      )
      .all(workspaceId, ...wanted);
    return rows.map((row) => hit(row));
  }
  async close() {
    this.db.close();
  }
}

/**
 * Opens (and creates) the index at a `file:` URL next to the identity
 * database, or `:memory:` in tests. The file is private to this user.
 */
export async function openKnowledgeIndex(url: string): Promise<KnowledgeIndex> {
  const file = url.startsWith("file:") ? fileURLToPath(url) : undefined;
  const db = new DatabaseSync(file ?? ":memory:");
  try {
    db.function(
      "niaro_cosine_distance",
      { deterministic: true },
      (stored, asked) =>
        stored instanceof Uint8Array && asked instanceof Uint8Array
          ? cosineDistance(floats(stored), floats(asked))
          : null,
    );
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; " +
        "CREATE TABLE IF NOT EXISTS knowledge_documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','service')),name TEXT NOT NULL,owner_user_id TEXT,service_id TEXT,action_id TEXT,content_hash TEXT NOT NULL,model_key TEXT NOT NULL,indexed_at INTEGER NOT NULL,chunk_count INTEGER NOT NULL,UNIQUE(workspace_id,source_key));" +
        "CREATE TABLE IF NOT EXISTS knowledge_chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,ordinal INTEGER NOT NULL,text TEXT NOT NULL,embedding BLOB NOT NULL,dimensions INTEGER NOT NULL,workspace_id TEXT NOT NULL,source_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','service')),name TEXT NOT NULL,owner_user_id TEXT,service_id TEXT,action_id TEXT,model_key TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS knowledge_chunks_scope ON knowledge_chunks(workspace_id,model_key,kind);" +
        "CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id);",
    );
    if (file)
      for (const path of [file, file + "-wal", file + "-shm"])
        if (existsSync(path)) chmodSync(path, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  return new SqliteKnowledgeIndex(db);
}
