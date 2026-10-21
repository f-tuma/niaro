import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdentityId, OrganizationRole } from "../../packages/protocol/identity";
import {
  PROCESS_VERSION_PROFILE,
  ProcessFreezeCommandSchema,
  ProcessFreezeReceiptSchema,
  ProcessVersionListQuerySchema,
  ProcessVersionListSchema,
  type ProcessFreezeCommand,
  type ProcessFreezeReceipt,
  type ProcessVersionListQuery,
} from "../../packages/protocol/process-versions";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";

const actorSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  role: OrganizationRole,
});
type StoredFreeze = {
  actor: ProcessActor;
  command: ProcessFreezeCommand;
  receipt: ProcessFreezeReceipt;
};

/** Durable human freeze commands, sharing the registry transaction and owner queue. */
export class ProcessVersionsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly serverId: string,
    private readonly registry: ServiceProcessStore,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_freeze_command (
      command_key TEXT PRIMARY KEY, process_id TEXT NOT NULL
        REFERENCES agent_service_process(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_process_freeze_immutable
      BEFORE UPDATE ON agent_process_freeze_command
      BEGIN SELECT RAISE(ABORT,'process_freeze_immutable'); END;`);
  }
  private actor(
    raw: ProcessActor,
    target: { organizationId: string; workspaceId: string },
  ) {
    const actor = actorSchema.parse(raw);
    if (
      actor.organizationId !== target.organizationId ||
      actor.workspaceId !== target.workspaceId
    )
      throw new IdentityError(403, "identity_forbidden");
    return actor;
  }
  private key(actor: ProcessActor, requestId: string) {
    return processDigest([
      PROCESS_VERSION_PROFILE,
      this.serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      requestId,
    ]);
  }
  private stored(actor: ProcessActor, requestId: string) {
    IdentityId.parse(requestId);
    const row = this.db
      .prepare(
        "SELECT process_id,data FROM agent_process_freeze_command WHERE command_key=?",
      )
      .get(this.key(actor, requestId));
    if (!row) return;
    const raw = JSON.parse(String(row.data)) as StoredFreeze;
    const original = actorSchema.parse(raw.actor);
    const command = ProcessFreezeCommandSchema.parse(raw.command);
    const receipt = ProcessFreezeReceiptSchema.parse(raw.receipt);
    if (
      original.userId !== actor.userId ||
      original.organizationId !== actor.organizationId ||
      original.workspaceId !== actor.workspaceId ||
      command.organizationId !== actor.organizationId ||
      command.workspaceId !== actor.workspaceId ||
      command.requestId !== requestId ||
      row.process_id !== command.processId ||
      receipt.serverId !== this.serverId ||
      processDigest(command) !==
        processDigest(
          ProcessFreezeCommandSchema.parse(
            Object.fromEntries(
              Object.keys(command).map((key) => [
                key,
                receipt[key as keyof typeof receipt],
              ]),
            ),
          ),
        )
    )
      throw new IdentityError(409, "process_freeze_conflict");
    // Only immutable artifacts and metadata scope are read. Source freshness and
    // current revisions cannot invalidate an already completed human command.
    const artifact = this.registry.version(
      actor,
      command.processId,
      receipt.version,
    );
    if (artifact.digest !== receipt.artifactDigest)
      throw new IdentityError(409, "process_freeze_conflict");
    return { command, receipt };
  }
  read(raw: ProcessActor, requestId: string) {
    const actor = this.actor(raw, raw);
    const previous = this.stored(actor, requestId);
    if (!previous) throw new IdentityError(404, "process_freeze_not_found");
    return structuredClone(previous.receipt);
  }
  freeze(raw: ProcessActor, input: ProcessFreezeCommand) {
    const command = ProcessFreezeCommandSchema.parse(input);
    const actor = this.actor(raw, command);
    const previous = this.stored(actor, command.requestId);
    if (previous) {
      if (processDigest(previous.command) !== processDigest(command))
        throw new IdentityError(409, "process_freeze_conflict");
      return structuredClone(previous.receipt);
    }
    this.db.exec("SAVEPOINT process_freeze_command");
    try {
      const artifact = this.registry.freezeDraft(
        actor,
        command.processId,
        command.revision,
      );
      const receipt = ProcessFreezeReceiptSchema.parse({
        ...command,
        receiptId: randomUUID(),
        serverId: this.serverId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        resultingRevision: this.registry.getOwned(actor, command.processId)
          .revision,
        createdAt: new Date(this.now()).toISOString(),
      });
      this.db
        .prepare("INSERT INTO agent_process_freeze_command VALUES (?,?,?)")
        .run(
          this.key(actor, command.requestId),
          command.processId,
          JSON.stringify({ actor, command, receipt } satisfies StoredFreeze),
        );
      this.db.exec("RELEASE process_freeze_command");
      return structuredClone(receipt);
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_freeze_command; RELEASE process_freeze_command",
      );
      throw error;
    }
  }
  list(raw: ProcessActor, input: ProcessVersionListQuery) {
    const query = ProcessVersionListQuerySchema.parse(input);
    const actor = this.actor(raw, query);
    return ProcessVersionListSchema.parse({
      profile: PROCESS_VERSION_PROFILE,
      organizationId: query.organizationId,
      workspaceId: query.workspaceId,
      processId: query.processId,
      ...this.registry.listVersions(
        actor,
        query.processId,
        query.before,
        query.limit,
      ),
    });
  }
}
