import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "../../packages/protocol";
import { IdentityError } from "./error";
import { processDigest } from "./process-validation";

export const processCommandKey = (scope: Scope, kind: string, id: string) =>
  processDigest(["process-command/1", scope, kind, id]);

/** Optional tables allow old stores/checkpoints to open without changing their ABI. */
export function assertProcessCommandUnused(
  db: DatabaseSync,
  table: "agent_process_resolve_command" | "agent_process_answer_command",
  scope: Scope,
  commandId: string,
  idempotencyKey: string,
) {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
  )
    return;
  if (
    db
      .prepare(
        `SELECT 1 FROM ${table} WHERE command_key=? OR idempotency_key=?`,
      )
      .get(
        processCommandKey(scope, "command", commandId),
        processCommandKey(scope, "idempotency", idempotencyKey),
      )
  )
    throw new IdentityError(409, "idempotency_conflict");
}
