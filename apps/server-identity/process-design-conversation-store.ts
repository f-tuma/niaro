import type { DatabaseSync } from "node:sqlite";
import {
  DESIGN_PROFILE,
  DesignTurnSchema,
  type DesignTurn,
} from "../../packages/protocol/process-design";
import type { ProcessActor } from "./service-processes";
import type { InferenceRunCaps } from "./inference-budget";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";

export type DesignConversationBinding = {
  sessionId: string;
  creator: ProcessActor;
  rootId: string;
  threadId: string;
  resourceId: string;
  modelId: string;
  modelRevision: number;
  providerId: string;
  providerRevision: number;
  caps: InferenceRunCaps;
};
export type DesignTurnState = Omit<DesignTurn, "model"> & {
  sequence: number;
  /** Durable boundary: false means the native executor was never invoked. */
  nativeStarted?: boolean;
  candidateReply: string | null;
  candidateReviewDigest: string | null;
  /** Pagination and explicit schema reads are re-projected under current authority. */
  capabilityAfter?: string;
  capabilityRefs: { serviceId: string; actionId: string }[];
};

/** Construct once after the identity process lock. Every method runs under its queue. */
export class ProcessDesignConversationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly serverId: string,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_design_conversation (
      session_id TEXT PRIMARY KEY REFERENCES agent_process_design(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_process_design_turn (
      command_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_process_design_conversation(session_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, payload_digest TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(session_id,sequence)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_process_design_tool (
      turn_id TEXT NOT NULL REFERENCES agent_process_design_turn(command_key) ON DELETE CASCADE,
      call_id TEXT NOT NULL, payload_digest TEXT NOT NULL, output TEXT NOT NULL,
      PRIMARY KEY(turn_id,call_id)
    ) STRICT;`);
    // A previous process cannot still be alive once this owner holds the identity lock.
    // These run IDs are permanently non-attachable. Reads may only prove retirement.
    db.prepare(
      `UPDATE agent_process_design_turn SET data=json_set(data,
      '$.status','interrupted','$.failure','process_design_server_restarted',
      '$.updatedAt',?) WHERE json_extract(data,'$.status')='running'`,
    ).run(this.time());
  }
  private time() {
    return new Date(this.now()).toISOString();
  }
  key(actor: ProcessActor, requestId: string) {
    return processDigest([
      "design-command/1",
      this.serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      requestId,
    ]);
  }
  ids(actor: ProcessActor, sessionId: string) {
    const namespace = [
      "design-conversation/1",
      this.serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      sessionId,
    ];
    return {
      rootId: processDigest([...namespace, "budget"]),
      threadId: processDigest([...namespace, "thread"]),
      resourceId: processDigest([...namespace, "resource"]),
    };
  }
  private owned(actor: ProcessActor, binding: DesignConversationBinding) {
    const owner = binding.creator;
    if (
      actor.organizationId !== owner.organizationId ||
      actor.workspaceId !== owner.workspaceId ||
      actor.userId !== owner.userId ||
      (actor.role === "member" && !this.personal(actor, binding.sessionId))
    )
      throw new IdentityError(404, "process_design_not_found");
  }
  /** Members (including demoted administrators) keep only personal sessions. */
  private personal(actor: ProcessActor, sessionId: string) {
    try {
      return !!this.db
        .prepare(
          `SELECT 1 FROM agent_process_design WHERE id=? AND organization_id=?
            AND workspace_id=? AND user_id=? AND json_extract(data,'$.owner.type')='user'
            AND json_extract(data,'$.owner.userId')=user_id`,
        )
        .get(sessionId, actor.organizationId, actor.workspaceId, actor.userId);
    } catch {
      return false;
    }
  }
  binding(actor: ProcessActor, sessionId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM agent_process_design_conversation WHERE session_id=?",
      )
      .get(sessionId);
    if (!row) return null;
    const binding: DesignConversationBinding = JSON.parse(String(row.data));
    this.owned(actor, binding);
    return binding;
  }
  bind(actor: ProcessActor, binding: DesignConversationBinding) {
    this.owned(actor, binding);
    if (this.binding(actor, binding.sessionId))
      throw new IdentityError(409, "process_design_conflict");
    this.db
      .prepare("INSERT INTO agent_process_design_conversation VALUES (?,?)")
      .run(binding.sessionId, JSON.stringify(binding));
    return binding;
  }
  read(actor: ProcessActor, sessionId: string, requestId: string) {
    const key = this.key(actor, requestId);
    const row = this.db
      .prepare("SELECT * FROM agent_process_design_turn WHERE command_key=?")
      .get(key);
    if (!row) return null;
    if (row.session_id !== sessionId)
      throw new IdentityError(409, "process_design_command_conflict");
    const binding = this.binding(actor, sessionId);
    if (!binding) throw new IdentityError(404, "process_design_not_found");
    return {
      state: JSON.parse(String(row.data)) as DesignTurnState,
      digest: String(row.payload_digest),
    };
  }
  list(actor: ProcessActor, sessionId: string): DesignTurnState[] {
    if (!this.binding(actor, sessionId)) return [];
    return this.db
      .prepare(
        "SELECT data FROM agent_process_design_turn WHERE session_id=? ORDER BY sequence",
      )
      .all(sessionId)
      .map((row) => JSON.parse(String(row.data)));
  }
  start(
    actor: ProcessActor,
    input: {
      sessionId: string;
      requestId: string;
      text: string;
      language: "en" | "cs";
      revision: number;
    },
    digest: string,
    maxTurns: number,
  ) {
    const turns = this.list(actor, input.sessionId);
    if (
      turns.some(
        (t) =>
          t.status === "running" ||
          (t.status === "interrupted" &&
            t.nativeStarted !== false &&
            t.nativeSettled !== true),
      )
    )
      throw new IdentityError(429, "process_design_busy");
    if (turns.length >= maxTurns)
      throw new IdentityError(429, "process_design_turn_limit");
    const state: DesignTurnState = {
      profile: DESIGN_PROFILE,
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      turnId: this.key(actor, input.requestId),
      requestRevision: input.revision,
      nativeStarted: false,
      nativeSettled: false,
      status: "running",
      userText: input.text,
      language: input.language,
      reply: null,
      failure: null,
      revision: input.revision,
      sequence: turns.length + 1,
      candidateReply: null,
      candidateReviewDigest: null,
      capabilityRefs: [],
      toolReceipts: [],
      createdAt: this.time(),
      updatedAt: this.time(),
    };
    this.db
      .prepare("INSERT INTO agent_process_design_turn VALUES (?,?,?,?,?)")
      .run(
        state.turnId,
        state.sessionId,
        state.sequence,
        digest,
        JSON.stringify(state),
      );
    return state;
  }
  write(actor: ProcessActor, state: DesignTurnState) {
    const existing = this.read(actor, state.sessionId, state.requestId);
    if (!existing || existing.state.turnId !== state.turnId)
      throw new IdentityError(404, "process_design_not_found");
    state.updatedAt = this.time();
    this.db
      .prepare(
        "UPDATE agent_process_design_turn SET data=? WHERE command_key=?",
      )
      .run(JSON.stringify(state), state.turnId);
  }
  view(actor: ProcessActor, state: DesignTurnState) {
    const binding = this.binding(actor, state.sessionId);
    if (!binding) throw new IdentityError(404, "process_design_not_found");
    // Internal candidate and read intents never grant a published assistant reply.
    const {
      sequence: _sequence,
      nativeStarted: _nativeStarted,
      candidateReply: _candidate,
      candidateReviewDigest: _candidateReviewDigest,
      capabilityAfter: _after,
      capabilityRefs: _refs,
      ...dto
    } = state;
    return DesignTurnSchema.parse({
      ...dto,
      nativeSettled:
        state.nativeSettled ??
        (state.status === "completed" || state.status === "failed"),
      model: {
        id: binding.modelId,
        revision: binding.modelRevision,
        providerId: binding.providerId,
        providerRevision: binding.providerRevision,
      },
      reply: state.status === "completed" ? state.reply : null,
    });
  }
  atomic<T>(run: () => T): T {
    this.db.exec("SAVEPOINT process_design_conversation_mutation");
    try {
      const result = run();
      this.db.exec("RELEASE process_design_conversation_mutation");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_design_conversation_mutation; RELEASE process_design_conversation_mutation",
      );
      throw error;
    }
  }
  /** The proposal command and opaque native tool receipt share this savepoint. */
  tool(
    actor: ProcessActor,
    state: DesignTurnState,
    callId: string,
    digest: string,
    invoke: () => unknown,
  ): unknown {
    return this.atomic(() => {
      const current = this.read(actor, state.sessionId, state.requestId);
      if (!current || current.state.turnId !== state.turnId)
        throw new IdentityError(404, "process_design_turn_not_found");
      const old = this.db
        .prepare(
          "SELECT * FROM agent_process_design_tool WHERE turn_id=? AND call_id=?",
        )
        .get(state.turnId, callId);
      if (old) {
        if (old.payload_digest !== digest)
          throw new IdentityError(409, "process_design_tool_conflict");
        return JSON.parse(String(old.output));
      }
      if (current.state.status !== "running" || state.status !== "running")
        throw new IdentityError(409, "process_design_turn_closed");
      const output = invoke();
      this.write(actor, state);
      this.db
        .prepare("INSERT INTO agent_process_design_tool VALUES (?,?,?,?)")
        .run(state.turnId, callId, digest, JSON.stringify(output));
      return output;
    });
  }
}
