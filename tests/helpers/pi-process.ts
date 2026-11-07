/**
 * Read a process run's checkpoint straight from an agent core file, for
 * restore and crash tests that inspect stopped copies without opening a core.
 * Run documents store every change as a complete base revision.
 */
import type { DatabaseSync } from "node:sqlite";
import { ProcessRunCheckpointSchema } from "../../apps/server-agent/process-checkpoint";

export function processRunRow(db: DatabaseSync, workflowId: string) {
  const row = db
    .prepare(
      `SELECT d.id AS document_id, r.seq, r.kind, r.content FROM documents d
       JOIN document_revisions r ON r.document_id=d.id
       WHERE d.kind=? AND d.key_value=? AND d.retired_at IS NULL
       ORDER BY r.seq DESC LIMIT 1`,
    )
    .get(JSON.stringify("niaro.process-run"), JSON.stringify(workflowId)) as
    | { document_id: number; seq: number; kind: string; content: string }
    | undefined;
  if (!row) return undefined;
  if (row.kind !== "base") throw new Error("TEST run revision must be a base");
  return {
    row,
    parsed: ProcessRunCheckpointSchema.parse(JSON.parse(row.content)),
  };
}
