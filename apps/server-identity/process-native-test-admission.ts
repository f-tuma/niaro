import type { DatabaseSync } from "node:sqlite";
import { sameScope, type Scope } from "../../packages/protocol";
import {
  ProcessVersionSchema,
  type ProcessVersion,
} from "../../packages/protocol/service-processes";
import {
  PROCESS_START_PROFILE,
  ProcessStartCommandSchema,
} from "../../packages/protocol/process-start";
import { ProcessStartStore } from "./process-start-store";
import { IdentityError } from "./error";
import { processDigest } from "./process-validation";
import type { ProcessActor, ServiceProcessStore } from "./service-processes";

/** Closed qualification clone. It cannot select or activate any production artifact. */
export function createNativeTestAdmission(
  db: DatabaseSync,
  artifact: ProcessVersion,
  actor: ProcessActor,
  scope: Scope,
  caseRunId: string,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_service_process (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS test_native_artifact (
      process_id TEXT PRIMARY KEY REFERENCES agent_service_process(id),
      data TEXT NOT NULL CHECK(json_valid(data))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_process_run (
      run_id TEXT PRIMARY KEY,
      process_id TEXT NOT NULL REFERENCES agent_service_process(id),
      version INTEGER NOT NULL,
      organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS test_native_artifact_immutable
      BEFORE UPDATE ON test_native_artifact BEGIN SELECT RAISE(ABORT,'test_native_artifact_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS test_native_pin_immutable
      BEFORE UPDATE ON agent_service_process_run BEGIN SELECT RAISE(ABORT,'test_native_pin_immutable'); END;`);
  db.prepare("INSERT OR IGNORE INTO agent_service_process VALUES(?)").run(
    artifact.processId,
  );
  db.prepare("INSERT OR IGNORE INTO test_native_artifact VALUES(?,?)").run(
    artifact.processId,
    JSON.stringify(artifact),
  );
  const authorize = (current: ProcessActor, value = scope) => {
    if (
      !sameScope(value, scope) ||
      current.organizationId !== actor.organizationId ||
      current.workspaceId !== actor.workspaceId ||
      current.userId !== actor.userId ||
      current.role !== actor.role
    )
      throw new IdentityError(403, "identity_forbidden");
    return { ...actor };
  };
  const fixed = (current: ProcessActor, processId: string) => {
    authorize(current);
    if (processId !== artifact.processId)
      throw new IdentityError(404, "process_not_found");
    const row = db
      .prepare("SELECT data FROM test_native_artifact WHERE process_id=?")
      .get(processId);
    if (!row) throw new IdentityError(404, "process_not_found");
    const stored = ProcessVersionSchema.parse(JSON.parse(String(row.data)));
    if (
      processDigest(stored) !== processDigest(artifact) ||
      processDigest({
        definition: stored.definition,
        sources: stored.sources,
      }) !== stored.digest
    )
      throw new IdentityError(409, "process_conflict");
    return stored;
  };
  const pinned = (current: ProcessActor, runId: string) => {
    authorize(current);
    const row = db
      .prepare("SELECT * FROM agent_service_process_run WHERE run_id=?")
      .get(runId);
    if (
      !row ||
      row.organization_id !== actor.organizationId ||
      row.workspace_id !== actor.workspaceId ||
      row.user_id !== actor.userId
    )
      throw new IdentityError(404, "process_not_found");
    const value = fixed(current, String(row.process_id));
    if (row.version !== value.version)
      throw new IdentityError(409, "process_conflict");
    return value;
  };
  const registry: Pick<
    ServiceProcessStore,
    "activeRunVersion" | "pinRun" | "pinnedVersion"
  > = {
    activeRunVersion: (current, processId, expected) => {
      const value = fixed(current, processId);
      if (
        expected.version !== value.version ||
        expected.artifactDigest !== value.digest
      )
        throw new IdentityError(409, "process_conflict");
      return value;
    },
    pinRun: (current, processId, runId, expected) => {
      const value = fixed(current, processId);
      if (
        expected &&
        (expected.version !== value.version ||
          expected.artifactDigest !== value.digest)
      )
        throw new IdentityError(409, "process_conflict");
      if (
        db
          .prepare("SELECT 1 FROM agent_service_process_run WHERE run_id=?")
          .get(runId)
      ) {
        const saved = pinned(current, runId);
        if (saved.processId !== processId)
          throw new IdentityError(409, "process_conflict");
        return saved;
      }
      db.prepare(
        "INSERT INTO agent_service_process_run VALUES(?,?,?,?,?,?,?)",
      ).run(
        runId,
        processId,
        value.version,
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        new Date().toISOString(),
      );
      return value;
    },
    pinnedVersion: pinned,
  };
  const starts = new ProcessStartStore(db, scope.serverId, registry, {
    authorize,
    read: (current, processId) => {
      fixed(current, processId);
    },
  });
  const origin = {
    type: "command" as const,
    conversationId: caseRunId,
    requestId: caseRunId,
  };
  const formDigest = processDigest({
    origin,
    inputSchema: artifact.definition.inputSchema,
  });
  const admit = (input: Record<string, unknown>) => {
    const intent = starts.issue(
      actor,
      scope,
      {
        origin,
        processId: artifact.processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        formDigest,
        fields: {},
      },
      (issued) => {
        if (
          processDigest(issued.origin) !== processDigest(origin) ||
          issued.formDigest !== formDigest
        )
          throw new IdentityError(409, "process_origin_changed");
      },
    );
    const command = ProcessStartCommandSchema.parse({
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: caseRunId + "-start",
      idempotencyKey: caseRunId + "-start-key",
      intentId: intent.intentId,
      conversationId: caseRunId,
      language: "en",
      input,
    });
    return starts.admit(
      actor,
      scope,
      intent.intentId,
      command,
      (issued, submitted) => {
        if (
          processDigest(issued.origin) !== processDigest(origin) ||
          submitted.conversationId !== caseRunId
        )
          throw new IdentityError(409, "process_origin_changed");
      },
    );
  };
  return {
    starts,
    admit,
    resolver: { pinRun: registry.pinRun, resolveRun: pinned },
  };
}
