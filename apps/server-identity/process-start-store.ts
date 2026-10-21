import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ScopeSchema,
  sameScope,
  type Scope,
  type Snapshot,
} from "../../packages/protocol";
import {
  PROCESS_START_PROFILE,
  PROCESS_START_REJECTIONS,
  ProcessStartIntentSchema,
  ProcessStartOriginalCommandSchema,
  ProcessStartReceiptSchema,
  ProcessStartInputSchema,
  type ProcessStartIntent,
  type ProcessStartOriginalCommand,
  type ProcessStartReceipt,
} from "../../packages/protocol/process-start";
import { processValueSchema } from "../../packages/protocol/service-processes";
import { resolveCardSubmission } from "../server-cards/respond";
import { IdentityError } from "./error";
import { assertProcessCommandUnused } from "./process-command-namespace";
import { processDigest } from "./process-validation";
import type { ProcessActor, ServiceProcessStore } from "./service-processes";
import {
  JournalSchema,
  newServiceProcessJournal,
  serviceProcessRunIdentity,
} from "./service-process-journal";

type IntentRequest = Omit<
  ProcessStartIntent,
  "intentId" | "createdAt" | "inputSchema"
>;
type IntentRow = {
  scope: Scope;
  actor: ProcessActor;
  intent: ProcessStartIntent;
};
type ReceiptRow = {
  scope: Scope;
  actor: ProcessActor;
  command: ProcessStartOriginalCommand;
  receipt: ProcessStartReceipt;
};
type Authority = {
  /** Trusted authenticated caller; recheck current membership, never a payload role.
   * The request coordinator must validate its live credential before every call. */
  authorize(actor: ProcessActor, scope: Scope): ProcessActor;
  /** Current private-read policy, including on historical replay. No execution gate. */
  read(actor: ProcessActor, processId: string): void;
};
type StartRejection = (typeof PROCESS_START_REJECTIONS)[number];
/** Deterministic admission refusals become durable receipts so a client never
 * repeats the same start against an unchanged gate. Anything else (busy,
 * authentication, storage) stays an error and reserves nothing. */
function startRejection(error: unknown): StartRejection | undefined {
  if (!(error instanceof IdentityError)) return;
  const code = error.code;
  if (PROCESS_START_REJECTIONS.some((reason) => reason === code))
    return code as StartRejection;
  // The qualification gate resolves the process's own catalog sources; a
  // removed or disabled model/source is a source change for this process.
  if (code === "catalog_model_unavailable" || code === "catalog_not_found")
    return "process_sources_changed";
}

/** Trusted card mapper validates the entire visible form; it never uses an action label. */
export function assertProcessStartCardOrigin(
  snapshot: Snapshot,
  scope: Scope,
  intent: ProcessStartIntent,
  command: ProcessStartOriginalCommand,
) {
  if (
    command.type !== "card.respond" ||
    intent.origin.type !== "card" ||
    !sameScope(snapshot.scope, scope)
  )
    throw new IdentityError(409, "process_origin_changed");
  const submitted = resolveCardSubmission(snapshot, command);
  if (
    !submitted.ok ||
    processDigest(submitted.document) !== intent.formDigest ||
    processDigest([...(submitted.action.fields ?? [])].sort()) !==
      processDigest(Object.keys(intent.fields).sort())
  )
    throw new IdentityError(409, "process_origin_changed");
}

/** Synchronous identity-owner admission only. No HTTP, native start or business I/O. */
export class ProcessStartStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly serverId: string,
    private readonly registry: Pick<
      ServiceProcessStore,
      "activeRunVersion" | "pinRun" | "pinnedVersion"
    >,
    private readonly authority: Authority,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_start_intent (
      id TEXT PRIMARY KEY, origin_key TEXT UNIQUE NOT NULL,
      process_id TEXT NOT NULL REFERENCES agent_service_process(id) ON DELETE CASCADE,
      data TEXT NOT NULL CHECK(json_valid(data))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_process_start_command (
      command_key TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
      intent_id TEXT NOT NULL REFERENCES agent_process_start_intent(id) ON DELETE CASCADE,
      run_id TEXT UNIQUE REFERENCES agent_service_process_run(run_id),
      data TEXT NOT NULL CHECK(json_valid(data))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_process_start_redemption
      ON agent_process_start_command(intent_id) WHERE run_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS agent_process_start_intent_immutable
      BEFORE UPDATE ON agent_process_start_intent BEGIN SELECT RAISE(ABORT,'process_start_intent_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_process_start_command_immutable
      BEFORE UPDATE ON agent_process_start_command BEGIN SELECT RAISE(ABORT,'process_start_command_immutable'); END;`);
  }
  private actor(raw: ProcessActor, scope: Scope) {
    ScopeSchema.parse(scope);
    if (
      scope.serverId !== this.serverId ||
      scope.workspaceId !== raw.workspaceId ||
      scope.userId !== raw.userId
    )
      throw new IdentityError(403, "identity_forbidden");
    const actor = this.authority.authorize(raw, scope);
    if (
      actor.organizationId !== raw.organizationId ||
      actor.workspaceId !== raw.workspaceId ||
      actor.userId !== raw.userId
    )
      throw new IdentityError(403, "identity_forbidden");
    return actor;
  }
  private key(actor: ProcessActor, kind: string, value: unknown) {
    return processDigest([
      PROCESS_START_PROFILE,
      this.serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      kind,
      value,
    ]);
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT process_start");
    try {
      const result = fn();
      this.db.exec("RELEASE process_start");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO process_start; RELEASE process_start");
      throw error;
    }
  }
  private intent(
    actor: ProcessActor,
    scope: Scope,
    id: string,
    privateProof = false,
  ): ProcessStartIntent {
    const row = this.db
      .prepare("SELECT data FROM agent_process_start_intent WHERE id=?")
      .get(id);
    if (!row) throw new IdentityError(404, "process_start_not_found");
    const value = JSON.parse(String(row.data)) as IntentRow;
    if (
      !sameScope(value.scope, scope) ||
      this.key(value.actor, "actor", "") !== this.key(actor, "actor", "")
    )
      throw new IdentityError(404, "process_start_not_found");
    const intent = ProcessStartIntentSchema.parse(value.intent);
    if (intent.intentId !== id)
      throw new IdentityError(409, "process_start_conflict");
    if (!privateProof) this.authority.read(actor, intent.processId);
    return intent;
  }
  /** Caller proves the real visible origin under the same identity queue, not model output. */
  issue(
    raw: ProcessActor,
    scope: Scope,
    request: IntentRequest,
    validateOrigin: (intent: ProcessStartIntent) => void,
  ): ProcessStartIntent {
    const actor = this.actor(raw, scope);
    this.authority.read(actor, request.processId);
    return this.atomic(() => {
      const originKey = this.key(actor, "origin", [
        scope.connectionId,
        request.origin,
      ]);
      const prior = this.db
        .prepare("SELECT id FROM agent_process_start_intent WHERE origin_key=?")
        .get(originKey);
      if (prior) {
        const intent = this.intent(actor, scope, String(prior.id));
        const {
          intentId: _id,
          createdAt: _time,
          inputSchema: _schema,
          ...saved
        } = intent;
        if (processDigest(saved) !== processDigest(request))
          throw new IdentityError(409, "process_start_conflict");
        return intent;
      }
      const artifact = this.registry.activeRunVersion(
        actor,
        request.processId,
        request,
      );
      const intent = ProcessStartIntentSchema.parse({
        ...request,
        intentId: randomUUID(),
        inputSchema: artifact.definition.inputSchema,
        createdAt: new Date(this.now()).toISOString(),
      });
      if (intent.origin.type !== "card" && Object.keys(intent.fields).length)
        throw new IdentityError(400, "process_input_invalid");
      validateOrigin(intent);
      this.db
        .prepare("INSERT INTO agent_process_start_intent VALUES (?,?,?,?)")
        .run(
          intent.intentId,
          originKey,
          intent.processId,
          JSON.stringify({ scope, actor, intent }),
        );
      return structuredClone(intent);
    });
  }
  private stored(
    actor: ProcessActor,
    scope: Scope,
    commandId: string,
    idempotencyKey: string,
    privateProof = false,
  ) {
    const rows = this.db
      .prepare(
        "SELECT data FROM agent_process_start_command WHERE command_key=? OR idempotency_key=?",
      )
      .all(
        this.key(actor, "command", commandId),
        this.key(actor, "idempotency", idempotencyKey),
      );
    if (!rows.length) return;
    if (rows.length !== 1) throw new IdentityError(409, "idempotency_conflict");
    const value = JSON.parse(String(rows[0]!.data)) as ReceiptRow;
    const command = ProcessStartOriginalCommandSchema.parse(value.command);
    const receipt = ProcessStartReceiptSchema.parse(value.receipt);
    if (
      !sameScope(value.scope, scope) ||
      this.key(value.actor, "actor", "") !== this.key(actor, "actor", "") ||
      command.commandId !== commandId ||
      command.idempotencyKey !== idempotencyKey ||
      receipt.commandId !== commandId ||
      receipt.idempotencyKey !== idempotencyKey ||
      receipt.commandDigest !== processDigest(command)
    )
      throw new IdentityError(409, "idempotency_conflict");
    const intent = this.intent(actor, scope, receipt.intentId, privateProof);
    if (
      receipt.processId !== intent.processId ||
      receipt.version !== intent.version ||
      receipt.artifactDigest !== intent.artifactDigest ||
      receipt.formDigest !== intent.formDigest ||
      processDigest(receipt.origin) !== processDigest(intent.origin)
    )
      throw new IdentityError(409, "process_start_conflict");
    if (receipt.status === "admitted") {
      const identity = serviceProcessRunIdentity(
        scope,
        actor.organizationId,
        receipt.runId,
      );
      const pin = this.registry.pinnedVersion(actor, receipt.parentRunId);
      const saved = this.db
        .prepare(
          "SELECT data FROM agent_service_turn WHERE id=? AND workspace_id=? AND user_id=?",
        )
        .get(receipt.parentRunId, scope.workspaceId, scope.userId);
      if (!saved) throw new IdentityError(409, "process_start_conflict");
      const journal = JournalSchema.parse(JSON.parse(String(saved.data)));
      if (
        identity.parentRunId !== receipt.parentRunId ||
        pin.processId !== receipt.processId ||
        pin.version !== receipt.version ||
        pin.digest !== receipt.artifactDigest ||
        journal.runId !== receipt.runId ||
        journal.processId !== receipt.processId ||
        journal.version !== receipt.version ||
        journal.artifactDigest !== receipt.artifactDigest ||
        journal.scopeDigest !== identity.scopeDigest ||
        journal.compilerVersion !== receipt.compilerVersion ||
        journal.inputDigest !== receipt.inputDigest ||
        processDigest(journal.input) !== receipt.inputDigest ||
        processDigest(receipt.input) !== receipt.inputDigest ||
        journal.startedAt !== Date.parse(receipt.createdAt)
      )
        throw new IdentityError(409, "process_start_conflict");
    }
    return { command, receipt };
  }
  read(
    raw: ProcessActor,
    scope: Scope,
    commandId: string,
    idempotencyKey: string,
  ): ProcessStartReceipt {
    const actor = this.actor(raw, scope);
    const saved = this.stored(actor, scope, commandId, idempotencyKey);
    if (!saved) throw new IdentityError(404, "process_start_not_found");
    return structuredClone(saved.receipt);
  }
  /** Resolve an already admitted native parent; never infer an alias from an active version. */
  forParent(raw: ProcessActor, scope: Scope, parentRunId: string) {
    const actor = this.actor(raw, scope);
    const row = this.db
      .prepare("SELECT data FROM agent_process_start_command WHERE run_id=?")
      .get(parentRunId);
    if (!row) throw new IdentityError(404, "process_start_not_found");
    const candidate = JSON.parse(String(row.data)) as ReceiptRow;
    if (!sameScope(candidate.scope, scope))
      throw new IdentityError(404, "process_start_not_found");
    const command = ProcessStartOriginalCommandSchema.parse(candidate.command);
    const saved = this.stored(
      actor,
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    if (
      saved?.receipt.status !== "admitted" ||
      saved.receipt.parentRunId !== parentRunId
    )
      throw new IdentityError(409, "process_start_conflict");
    return structuredClone(saved);
  }
  /** Identity-owner retirement proof only. Never expose this payload as history or authorize execution. */
  retirementProof(scope: Scope, parentRunId: string) {
    ScopeSchema.parse(scope);
    if (scope.serverId !== this.serverId)
      throw new IdentityError(403, "identity_forbidden");
    const row = this.db
      .prepare("SELECT data FROM agent_process_start_command WHERE run_id=?")
      .get(parentRunId);
    if (!row) throw new IdentityError(404, "process_start_not_found");
    const candidate = JSON.parse(String(row.data)) as ReceiptRow;
    if (
      !sameScope(candidate.scope, scope) ||
      candidate.actor.workspaceId !== scope.workspaceId ||
      candidate.actor.userId !== scope.userId
    )
      throw new IdentityError(404, "process_start_not_found");
    const command = ProcessStartOriginalCommandSchema.parse(candidate.command);
    const saved = this.stored(
      candidate.actor,
      scope,
      command.commandId,
      command.idempotencyKey,
      true,
    );
    if (
      saved?.receipt.status !== "admitted" ||
      saved.receipt.parentRunId !== parentRunId
    )
      throw new IdentityError(409, "process_start_conflict");
    const artifact = this.registry.pinnedVersion(candidate.actor, parentRunId);
    return { admission: structuredClone(saved.receipt), artifact };
  }
  /** Private namespace reservation check for the shared command coordinator. */
  hasCommand(
    raw: ProcessActor,
    scope: Scope,
    commandId: string,
    idempotencyKey: string,
  ) {
    const actor = this.actor(raw, scope);
    return Boolean(this.stored(actor, scope, commandId, idempotencyKey));
  }
  /** Exact replay comes before the original form/active pointer/current source gate. */
  admit(
    raw: ProcessActor,
    scope: Scope,
    intentId: string,
    payload: unknown,
    validateOrigin: (
      intent: ProcessStartIntent,
      command: ProcessStartOriginalCommand,
    ) => void,
    acceptCompiler?: (compilerVersion: string) => void,
  ): ProcessStartReceipt {
    const actor = this.actor(raw, scope);
    const command = ProcessStartOriginalCommandSchema.parse(payload);
    assertProcessCommandUnused(
      this.db,
      "agent_process_resolve_command",
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    assertProcessCommandUnused(
      this.db,
      "agent_process_answer_command",
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    const previous = this.stored(
      actor,
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    if (previous) {
      if (
        previous.receipt.intentId !== intentId ||
        processDigest(command) !== processDigest(previous.command)
      )
        throw new IdentityError(409, "idempotency_conflict");
      if (previous.receipt.status === "admitted")
        acceptCompiler?.(previous.receipt.compilerVersion);
      return structuredClone(previous.receipt);
    }
    const intent = this.intent(actor, scope, intentId);
    return this.atomic(() => {
      let receipt: ProcessStartReceipt;
      const common = {
        profile: PROCESS_START_PROFILE,
        receiptId: randomUUID(),
        intentId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandDigest: processDigest(command),
        origin: intent.origin,
        processId: intent.processId,
        version: intent.version,
        artifactDigest: intent.artifactDigest,
        formDigest: intent.formDigest,
        createdAt: new Date(this.now()).toISOString(),
      };
      try {
        // This inner savepoint retires a rejected attempt without keeping a partial pin/seed.
        receipt = this.atomicAdmission(() => {
          if (
            command.conversationId !== intent.origin.conversationId ||
            (command.type === "process.start" &&
              (command.intentId !== intentId ||
                (intent.origin.type !== "command" &&
                  intent.origin.type !== "meeting"))) ||
            (command.type === "card.respond" &&
              (intent.origin.type !== "card" ||
                command.messageId !== intent.origin.messageId ||
                command.cardId !== intent.origin.cardId ||
                command.expectedCardRevision !== intent.origin.cardRevision ||
                command.actionId !== intent.origin.actionId))
          )
            throw new IdentityError(409, "process_origin_changed");
          if (
            this.db
              .prepare(
                "SELECT 1 FROM agent_process_start_command WHERE intent_id=? AND run_id IS NOT NULL",
              )
              .get(intentId)
          )
            throw new IdentityError(409, "process_start_conflict");
          validateOrigin(intent, command);
          const input: Record<string, unknown> =
            command.type === "process.start" ? command.input : {};
          if (command.type === "card.respond") {
            if (
              Object.keys(command.values).some(
                (id) => !Object.hasOwn(intent.fields, id),
              )
            )
              throw new IdentityError(400, "process_input_invalid");
            for (const [field, path] of Object.entries(intent.fields)) {
              if (!Object.hasOwn(command.values, field)) continue;
              let object = input;
              for (const key of path.slice(0, -1)) {
                if (!Object.hasOwn(object, key)) object[key] = {};
                object = object[key] as Record<string, unknown>;
              }
              object[path.at(-1)!] = command.values[field];
            }
          }
          const bounded = ProcessStartInputSchema.safeParse(input);
          const parsed = bounded.success
            ? processValueSchema(intent.inputSchema).safeParse(bounded.data)
            : bounded;
          if (!parsed.success)
            throw new IdentityError(400, "process_input_invalid");
          const canonical = ProcessStartInputSchema.parse(parsed.data);
          const runId = this.key(actor, "run", command.idempotencyKey);
          const { parentRunId } = serviceProcessRunIdentity(
            scope,
            actor.organizationId,
            runId,
          );
          if (
            this.db
              .prepare("SELECT 1 FROM agent_service_process_run WHERE run_id=?")
              .get(parentRunId) ||
            this.db
              .prepare("SELECT 1 FROM agent_service_turn WHERE id=?")
              .get(parentRunId)
          )
            throw new IdentityError(409, "process_start_conflict");
          const artifact = this.registry.pinRun(
            actor,
            intent.processId,
            parentRunId,
            intent,
          );
          const journal = newServiceProcessJournal(
            artifact,
            runId,
            scope,
            actor.organizationId,
            canonical,
            Date.parse(common.createdAt),
          );
          acceptCompiler?.(journal.compilerVersion);
          this.db
            .prepare("INSERT INTO agent_service_turn VALUES (?,?,?,?)")
            .run(
              parentRunId,
              scope.workspaceId,
              scope.userId,
              JSON.stringify(journal),
            );
          return {
            ...common,
            status: "admitted" as const,
            input: canonical,
            inputDigest: processDigest(canonical),
            compilerVersion: journal.compilerVersion,
            runId,
            parentRunId,
          };
        });
      } catch (error) {
        const reason = startRejection(error);
        if (!reason) throw error;
        receipt = { ...common, status: "rejected", reason };
      }
      receipt = ProcessStartReceiptSchema.parse(receipt);
      this.db
        .prepare("INSERT INTO agent_process_start_command VALUES (?,?,?,?,?)")
        .run(
          this.key(actor, "command", command.commandId),
          this.key(actor, "idempotency", command.idempotencyKey),
          intentId,
          receipt.status === "admitted" ? receipt.parentRunId : null,
          JSON.stringify({ scope, actor, command, receipt }),
        );
      return structuredClone(receipt);
    });
  }
  private atomicAdmission<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT process_start_admission");
    try {
      const result = fn();
      this.db.exec("RELEASE process_start_admission");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_start_admission; RELEASE process_start_admission",
      );
      throw error;
    }
  }
}
