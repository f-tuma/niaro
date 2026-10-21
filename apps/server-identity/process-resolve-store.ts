import type { DatabaseSync } from "node:sqlite";
import { ScopeSchema, sameScope, type Scope } from "../../packages/protocol";
import { z } from "zod";
import {
  ProcessResolveCommandSchema,
  ProcessRuntimeCommandSchema,
  type ProcessRuntimeCommand,
  type ProcessResolveCommand,
} from "../../packages/protocol/process-coordinator";
import {
  ProcessStartAdmissionSchema,
  type ProcessStartAdmission,
} from "../../packages/protocol/process-start";
import type { ProcessActor } from "./service-processes";
import { JournalSchema, type Journal } from "./service-process-journal";
import { ProcessStartStore } from "./process-start-store";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";
import { assertProcessCommandUnused } from "./process-command-namespace";

const BindingSchema = z.strictObject({
  scope: ScopeSchema,
  command: ProcessResolveCommandSchema,
  admission: ProcessStartAdmissionSchema,
  nodeId: z.string().min(1).max(80),
});
const InterruptionSchema = z.strictObject({
  scope: ScopeSchema,
  command: ProcessRuntimeCommandSchema,
});
type Binding = z.infer<typeof BindingSchema>;
/** Durable immutable decisions. A retry of A always selects A, even while B is pending. */
export class ProcessResolveStore {
  constructor(
    private db: DatabaseSync,
    private starts: ProcessStartStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_resolve_command (
      command_key TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
      parent_id TEXT NOT NULL REFERENCES agent_service_process_run(run_id),
      operation_id TEXT UNIQUE NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data))
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_process_resolve_command_immutable
      BEFORE UPDATE ON agent_process_resolve_command BEGIN SELECT RAISE(ABORT,'process_resolve_command_immutable'); END;
    CREATE TABLE IF NOT EXISTS agent_process_command_interruption (
      command_key TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data))
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_process_command_interruption_immutable
      BEFORE UPDATE ON agent_process_command_interruption BEGIN SELECT RAISE(ABORT,'process_command_interruption_immutable'); END;`);
  }
  private key(scope: Scope, kind: string, id: string) {
    return processDigest(["process-command/1", scope, kind, id]);
  }
  /** A stop is bound to the original request, never to whichever approval is pending later. */
  interrupted(scope: Scope, command: ProcessRuntimeCommand) {
    const rows = this.db
      .prepare(
        "SELECT data FROM agent_process_command_interruption WHERE command_key=? OR idempotency_key=?",
      )
      .all(
        this.key(scope, "command", command.commandId),
        this.key(scope, "idempotency", command.idempotencyKey),
      );
    if (!rows.length) return false;
    if (rows.length !== 1) throw new IdentityError(409, "idempotency_conflict");
    const saved = InterruptionSchema.parse(JSON.parse(String(rows[0]!.data)));
    if (
      !sameScope(saved.scope, scope) ||
      processDigest(saved.command) !== processDigest(command)
    )
      throw new IdentityError(409, "idempotency_conflict");
    return true;
  }
  /** Coordinator must authenticate and prove an exact tracked or recorded command first. */
  interrupt(scope: Scope, raw: unknown) {
    const command = ProcessRuntimeCommandSchema.parse(raw);
    if (this.interrupted(scope, command)) return;
    this.db
      .prepare("INSERT INTO agent_process_command_interruption VALUES(?,?,?)")
      .run(
        this.key(scope, "command", command.commandId),
        this.key(scope, "idempotency", command.idempotencyKey),
        JSON.stringify(InterruptionSchema.parse({ scope, command })),
      );
  }
  private previous(scope: Scope, command: ProcessResolveCommand) {
    const rows = this.db
      .prepare(
        "SELECT data FROM agent_process_resolve_command WHERE command_key=? OR idempotency_key=?",
      )
      .all(
        this.key(scope, "command", command.commandId),
        this.key(scope, "idempotency", command.idempotencyKey),
      );
    if (!rows.length) return;
    if (rows.length !== 1) throw new IdentityError(409, "idempotency_conflict");
    const saved = BindingSchema.parse(JSON.parse(String(rows[0]!.data)));
    if (
      !sameScope(saved.scope, scope) ||
      processDigest(saved.command) !== processDigest(command)
    )
      throw new IdentityError(409, "idempotency_conflict");
    return saved;
  }
  /** Passive recorded-decision read. It cannot accept a new decision. */
  read(actor: ProcessActor, scope: Scope, raw: unknown) {
    const command = ProcessResolveCommandSchema.parse(raw);
    const original = this.starts.forParent(actor, scope, command.workItemId);
    const saved = this.previous(scope, command);
    if (!saved) return;
    if (processDigest(saved.admission) !== processDigest(original.receipt))
      throw new IdentityError(409, "process_approval_conflict");
    return structuredClone(saved);
  }
  assertUnused(scope: Scope, commandId: string, idempotencyKey: string) {
    assertProcessCommandUnused(
      this.db,
      "agent_process_answer_command",
      scope,
      commandId,
      idempotencyKey,
    );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_process_resolve_command WHERE command_key=? OR idempotency_key=?",
        )
        .get(
          this.key(scope, "command", commandId),
          this.key(scope, "idempotency", idempotencyKey),
        )
    )
      throw new IdentityError(409, "idempotency_conflict");
  }
  bind(
    actor: ProcessActor,
    scope: Scope,
    raw: unknown,
    validate: (journal: Journal) => void,
    validateOrigin?: (admission: ProcessStartAdmission) => void,
  ) {
    const command = ProcessResolveCommandSchema.parse(raw);
    // Both replay and new decisions first prove the original admission with current private authority.
    const original = this.starts.forParent(actor, scope, command.workItemId);
    const admission = original.receipt;
    if (
      admission.status !== "admitted" ||
      admission.origin.conversationId !== command.conversationId
    )
      throw new IdentityError(409, "process_approval_conflict");
    if (
      this.starts.hasCommand(
        actor,
        scope,
        command.commandId,
        command.idempotencyKey,
      )
    )
      throw new IdentityError(409, "idempotency_conflict");
    assertProcessCommandUnused(
      this.db,
      "agent_process_answer_command",
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    const prior = this.previous(scope, command);
    if (prior) {
      if (processDigest(prior.admission) !== processDigest(admission))
        throw new IdentityError(409, "process_approval_conflict");
      return { binding: structuredClone(prior), replay: true };
    }
    const row = this.db
      .prepare(
        "SELECT data FROM agent_service_turn WHERE id=? AND workspace_id=? AND user_id=?",
      )
      .get(admission.parentRunId, scope.workspaceId, scope.userId);
    if (!row) throw new IdentityError(404, "process_start_not_found");
    const journal = JournalSchema.parse(JSON.parse(String(row.data)));
    if (
      journal.status !== "waiting" ||
      journal.revision !== command.expectedWorkRevision ||
      !journal.pending ||
      "kind" in journal.pending ||
      journal.pending.operationId !== command.operationId
    )
      throw new IdentityError(409, "process_approval_conflict");
    if (command.approved) validateOrigin?.(admission);
    validate(journal);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_process_resolve_command WHERE operation_id=?",
        )
        .get(command.operationId)
    )
      throw new IdentityError(409, "process_approval_conflict");
    const binding: Binding = {
      scope,
      command,
      admission,
      nodeId: journal.pending.nodeId,
    };
    this.db
      .prepare("INSERT INTO agent_process_resolve_command VALUES(?,?,?,?,?)")
      .run(
        this.key(scope, "command", command.commandId),
        this.key(scope, "idempotency", command.idempotencyKey),
        admission.parentRunId,
        command.operationId,
        JSON.stringify(binding),
      );
    return { binding: structuredClone(binding), replay: false };
  }
}
