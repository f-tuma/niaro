import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type InValue } from "@libsql/client";

/**
 * The workspace knowledge index (NIAR-298) in its own libSQL file next to
 * the identity database. The identity database runs on `node:sqlite`, which
 * has no vector functions; libSQL stores each passage's embedding as a
 * float32 blob and ranks with its native `vector_distance_cos`. The index
 * is derived: dropping the file loses nothing a rebuild cannot restore.
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

class LibsqlKnowledgeIndex implements KnowledgeIndex {
  constructor(private readonly client: Client) {}
  async documents(workspaceId: string) {
    const result = await this.client.execute({
      sql: "SELECT * FROM knowledge_documents WHERE workspace_id=? ORDER BY indexed_at",
      args: [workspaceId],
    });
    return result.rows.map(
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
    const labels: InValue[] = [
      document.workspaceId,
      document.sourceKey,
      document.kind,
      document.name,
      document.ownerUserId,
      document.serviceId,
      document.actionId,
      document.modelKey,
    ];
    await this.client.batch(
      [
        {
          sql: "DELETE FROM knowledge_chunks WHERE document_id=?",
          args: [document.id],
        },
        {
          sql: "DELETE FROM knowledge_documents WHERE id=?",
          args: [document.id],
        },
        {
          sql: "INSERT INTO knowledge_documents(id,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,content_hash,model_key,indexed_at,chunk_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          args: [
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
          ],
        },
        ...passages.map((passage) => ({
          sql: "INSERT INTO knowledge_chunks(id,document_id,ordinal,text,embedding,dimensions,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,model_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          args: [
            passage.id,
            document.id,
            passage.ordinal,
            passage.text,
            blob(passage.vector),
            passage.vector.length,
            ...labels,
          ],
        })),
      ],
      "write",
    );
  }
  async remove(workspaceId: string, documentIds: readonly string[]) {
    if (!documentIds.length) return;
    await this.client.batch(
      documentIds.flatMap((id) => [
        {
          sql: "DELETE FROM knowledge_chunks WHERE document_id=? AND workspace_id=?",
          args: [id, workspaceId],
        },
        {
          sql: "DELETE FROM knowledge_documents WHERE id=? AND workspace_id=?",
          args: [id, workspaceId],
        },
      ]),
      "write",
    );
  }
  async clear(workspaceId: string) {
    await this.client.batch(
      [
        {
          sql: "DELETE FROM knowledge_chunks WHERE workspace_id=?",
          args: [workspaceId],
        },
        {
          sql: "DELETE FROM knowledge_documents WHERE workspace_id=?",
          args: [workspaceId],
        },
      ],
      "write",
    );
  }
  async counts(workspaceId: string, modelKey: string | null) {
    const row = (
      await this.client.execute({
        sql: `SELECT
          (SELECT count(*) FROM knowledge_documents WHERE workspace_id=?1) AS documents,
          (SELECT count(*) FROM knowledge_chunks WHERE workspace_id=?1 AND model_key IS ?2) AS chunks,
          (SELECT count(*) FROM knowledge_chunks WHERE workspace_id=?1 AND model_key IS NOT ?2) AS stale`,
        args: [workspaceId, modelKey],
      })
    ).rows[0]!;
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
    const result = await this.client.execute({
      sql: `SELECT id,document_id,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,text,
          vector_distance_cos(embedding, ?) AS distance
        FROM knowledge_chunks
        WHERE workspace_id=? AND model_key=? AND dimensions=? AND (${visible})
        ORDER BY distance ASC LIMIT ?`,
      args: [
        blob(query.vector),
        query.workspaceId,
        query.modelKey,
        query.vector.length,
        ...(query.files ? [query.userId] : []),
        ...sources,
        Math.max(1, Math.min(50, query.limit)),
      ],
    });
    return result.rows.map((row) => hit(row as Record<string, unknown>));
  }
  async passages(workspaceId: string, ids: readonly string[]) {
    const wanted = [...new Set(ids)].slice(0, 100);
    if (!wanted.length) return [];
    const result = await this.client.execute({
      sql: `SELECT id,document_id,workspace_id,source_key,kind,name,owner_user_id,service_id,action_id,text,NULL AS distance
        FROM knowledge_chunks WHERE workspace_id=? AND id IN (${wanted.map(() => "?").join(",")})`,
      args: [workspaceId, ...wanted],
    });
    return result.rows.map((row) => hit(row as Record<string, unknown>));
  }
  async close() {
    this.client.close();
  }
}

/**
 * Opens (and creates) the index at a libSQL URL: `file:` next to the
 * identity database, `:memory:` in tests. The file is private to this user.
 */
export async function openKnowledgeIndex(url: string): Promise<KnowledgeIndex> {
  const client = createClient({ url });
  await client.batch(
    [
      "CREATE TABLE IF NOT EXISTS knowledge_documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','service')),name TEXT NOT NULL,owner_user_id TEXT,service_id TEXT,action_id TEXT,content_hash TEXT NOT NULL,model_key TEXT NOT NULL,indexed_at INTEGER NOT NULL,chunk_count INTEGER NOT NULL,UNIQUE(workspace_id,source_key))",
      "CREATE TABLE IF NOT EXISTS knowledge_chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,ordinal INTEGER NOT NULL,text TEXT NOT NULL,embedding BLOB NOT NULL,dimensions INTEGER NOT NULL,workspace_id TEXT NOT NULL,source_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','service')),name TEXT NOT NULL,owner_user_id TEXT,service_id TEXT,action_id TEXT,model_key TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS knowledge_chunks_scope ON knowledge_chunks(workspace_id,model_key,kind)",
      "CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id)",
    ],
    "write",
  );
  if (url.startsWith("file:")) chmodSync(fileURLToPath(url), 0o600);
  return new LibsqlKnowledgeIndex(client);
}
