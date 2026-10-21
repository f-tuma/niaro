import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sameScope, type Scope } from "../../packages/protocol";
import {
  ProcessQuestionSchema,
  ProcessAnswerCommandSchema,
  ProcessAnswerBindingSchema,
  type ProcessQuestion,
  type ProcessAnswerCommand,
  type ProcessAnswerBinding,
  type ProcessQuestionAccess,
} from "../../packages/protocol/process-questions";
import type { ProcessStartAdmission } from "../../packages/protocol/process-start";
import type { ProcessActor } from "./service-processes";
import { JournalSchema, type Journal } from "./service-process-journal";
import { ProcessStartStore } from "./process-start-store";
import { IdentityError } from "./error";
import { processDigest } from "./process-validation";
import {
  assertProcessCommandUnused,
  processCommandKey,
} from "./process-command-namespace";

/** Identity-owned immutable question, canonical answer and atomic consumption journal. */
export class ProcessQuestionStore implements ProcessQuestionAccess {
  constructor(
    private db: DatabaseSync,
    private starts: ProcessStartStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_question (
      question_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES agent_service_process_run(run_id),
      child_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(parent_id,child_id,tool_call_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_process_answer_command (
      binding_id TEXT PRIMARY KEY, command_key TEXT UNIQUE NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      question_id TEXT UNIQUE NOT NULL REFERENCES agent_process_question(question_id),
      data TEXT NOT NULL CHECK(json_valid(data))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_process_answer_consumption (
      binding_id TEXT PRIMARY KEY REFERENCES agent_process_answer_command(binding_id),
      question_id TEXT UNIQUE NOT NULL REFERENCES agent_process_question(question_id),
      question_digest TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_process_question_immutable
      BEFORE UPDATE ON agent_process_question BEGIN SELECT RAISE(ABORT,'process_question_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_process_answer_command_immutable
      BEFORE UPDATE ON agent_process_answer_command BEGIN SELECT RAISE(ABORT,'process_answer_command_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_process_answer_consumption_immutable
      BEFORE UPDATE ON agent_process_answer_consumption BEGIN SELECT RAISE(ABORT,'process_answer_consumption_immutable'); END;`);
  }
  private conflict(): never {
    throw new IdentityError(409, "process_question_conflict");
  }
  private proof(raw: ProcessQuestion) {
    const q = ProcessQuestionSchema.parse(raw);
    if (
      q.questionDigest !== processDigest(q.question) ||
      q.questionId !==
        processDigest([
          q.parentRunId,
          "question",
          q.nodeId,
          q.childRunId,
          q.toolCallId,
        ]) ||
      q.childRunId !== processDigest([q.parentRunId, "agent", q.nodeId])
    )
      this.conflict();
    return q;
  }
  issue(raw: ProcessQuestion): ProcessQuestion {
    const q = this.proof(raw);
    const prior = this.question(q.questionId);
    if (prior) {
      if (processDigest(prior) !== processDigest(q)) this.conflict();
      return prior;
    }
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_process_question WHERE parent_id=? AND child_id=? AND tool_call_id=?",
        )
        .get(q.parentRunId, q.childRunId, q.toolCallId)
    )
      this.conflict();
    const latest = this.db
      .prepare(
        "SELECT max(json_extract(data,'$.questionRevision')) AS revision FROM agent_process_question WHERE parent_id=? AND child_id=?",
      )
      .get(q.parentRunId, q.childRunId);
    if (q.questionRevision !== Number(latest?.revision ?? 0) + 1)
      this.conflict();
    this.db
      .prepare("INSERT INTO agent_process_question VALUES(?,?,?,?,?)")
      .run(
        q.questionId,
        q.parentRunId,
        q.childRunId,
        q.toolCallId,
        JSON.stringify(q),
      );
    return structuredClone(q);
  }
  question(id: string): ProcessQuestion | undefined {
    const row = this.db
      .prepare("SELECT data FROM agent_process_question WHERE question_id=?")
      .get(id);
    if (!row) return;
    const q = this.proof(JSON.parse(String(row.data)));
    if (q.questionId !== id) this.conflict();
    return q;
  }
  answer(id: string): ProcessAnswerBinding | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM agent_process_answer_command WHERE binding_id=?",
      )
      .get(id);
    if (!row) return;
    const binding = ProcessAnswerBindingSchema.parse(
      JSON.parse(String(row.data)),
    );
    if (
      binding.bindingId !== id ||
      processDigest(this.question(binding.question.questionId)) !==
        processDigest(binding.question)
    )
      this.conflict();
    this.assertBinding(binding);
    return binding;
  }
  private assertBinding(b: ProcessAnswerBinding) {
    const { question: q, command: c, admission: a } = b;
    this.proof(q);
    if (
      a.parentRunId !== q.parentRunId ||
      a.parentRunId !== c.workItemId ||
      a.compilerVersion !== q.compilerVersion ||
      a.artifactDigest !== q.artifactDigest ||
      a.inputDigest !== q.inputDigest ||
      a.origin.conversationId !== c.conversationId ||
      c.nodeId !== q.nodeId ||
      c.childRunId !== q.childRunId ||
      c.toolCallId !== q.toolCallId ||
      c.questionId !== q.questionId ||
      c.questionRevision !== q.questionRevision ||
      c.expectedWorkRevision < q.issuedWorkRevision
    )
      this.conflict();
  }
  private previous(scope: Scope, command: ProcessAnswerCommand) {
    const rows = this.db
      .prepare(
        "SELECT binding_id FROM agent_process_answer_command WHERE command_key=? OR idempotency_key=?",
      )
      .all(
        processCommandKey(scope, "command", command.commandId),
        processCommandKey(scope, "idempotency", command.idempotencyKey),
      );
    if (!rows.length) return;
    if (rows.length !== 1) throw new IdentityError(409, "idempotency_conflict");
    const binding = this.answer(String(rows[0]!.binding_id))!;
    if (
      !sameScope(binding.scope, scope) ||
      processDigest(binding.command) !== processDigest(command)
    )
      throw new IdentityError(409, "idempotency_conflict");
    return binding;
  }
  /** Authenticated passive lookup never accepts an answer or hydrates Mastra. */
  read(actor: ProcessActor, scope: Scope, raw: unknown) {
    const command = ProcessAnswerCommandSchema.parse(raw);
    const original = this.starts.forParent(actor, scope, command.workItemId);
    const binding = this.previous(scope, command);
    if (!binding) return;
    if (processDigest(binding.admission) !== processDigest(original.receipt))
      this.conflict();
    return binding;
  }
  bind(
    actor: ProcessActor,
    scope: Scope,
    raw: unknown,
    validate: (journal: Journal) => void,
    validateOrigin?: (admission: ProcessStartAdmission) => void,
  ) {
    const command = ProcessAnswerCommandSchema.parse(raw);
    const admission = this.starts.forParent(
      actor,
      scope,
      command.workItemId,
    ).receipt;
    if (
      admission.status !== "admitted" ||
      admission.origin.conversationId !== command.conversationId
    )
      this.conflict();
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
      "agent_process_resolve_command",
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    // Replay A is resolved before looking at the current pending question B.
    const prior = this.previous(scope, command);
    if (prior) {
      if (processDigest(prior.admission) !== processDigest(admission))
        this.conflict();
      return { binding: prior, replay: true };
    }
    const row = this.db
      .prepare(
        "SELECT data FROM agent_service_turn WHERE id=? AND workspace_id=? AND user_id=?",
      )
      .get(admission.parentRunId, scope.workspaceId, scope.userId);
    if (!row) throw new IdentityError(404, "process_start_not_found");
    const journal = JournalSchema.parse(JSON.parse(String(row.data)));
    const q = journal.pending;
    if (
      journal.status !== "waiting" ||
      journal.revision !== command.expectedWorkRevision ||
      !q ||
      !("kind" in q) ||
      q.kind !== "question"
    )
      this.conflict();
    const question = this.question(command.questionId);
    const childPending = journal.agents[q.nodeId]?.pending;
    const child = journal.agents[q.nodeId];
    if (
      !question ||
      processDigest(question) !== processDigest(q) ||
      childPending?.kind !== "question" ||
      processDigest(childPending.questionProof) !== processDigest(q)
    )
      this.conflict();
    if (
      q.artifactDigest !== journal.artifactDigest ||
      q.compilerVersion !== journal.compilerVersion ||
      q.resourceId !== journal.scopeDigest ||
      q.childRunId !== child?.runId ||
      q.childThreadId !== child.threadId ||
      q.inputDigest !== journal.inputDigest ||
      q.childThreadId !==
        processDigest([
          q.parentRunId,
          journal.scopeDigest,
          "agent-thread",
          q.nodeId,
        ])
    )
      this.conflict();
    validateOrigin?.(admission);
    const binding = ProcessAnswerBindingSchema.parse({
      bindingId: randomUUID(),
      scope,
      command,
      admission,
      question,
      createdAt: new Date().toISOString(),
    });
    this.assertBinding(binding);
    validate(journal);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_process_answer_command WHERE question_id=?",
        )
        .get(q.questionId)
    )
      this.conflict();
    this.db
      .prepare("INSERT INTO agent_process_answer_command VALUES(?,?,?,?,?)")
      .run(
        binding.bindingId,
        processCommandKey(scope, "command", command.commandId),
        processCommandKey(scope, "idempotency", command.idempotencyKey),
        q.questionId,
        JSON.stringify(binding),
      );
    return { binding: structuredClone(binding), replay: false };
  }
  consumed(bindingId: string, raw: ProcessQuestion): boolean {
    const q = this.proof(raw),
      b = this.answer(bindingId);
    if (!b || processDigest(b.question) !== processDigest(q)) return false;
    const row = this.db
      .prepare(
        "SELECT question_id,question_digest FROM agent_process_answer_consumption WHERE binding_id=?",
      )
      .get(bindingId);
    return Boolean(
      row &&
        row.question_id === q.questionId &&
        row.question_digest === processDigest(q),
    );
  }
  /** Passive, scoped canonical user text. Binding alone never means consumption. */
  history(actor: ProcessActor, scope: Scope, parentRunId: string) {
    const original = this.starts.forParent(actor, scope, parentRunId).receipt;
    const rows = this.db
      .prepare(
        `SELECT a.binding_id FROM agent_process_answer_command a
      JOIN agent_process_answer_consumption c ON c.binding_id=a.binding_id
      JOIN agent_process_question q ON q.question_id=a.question_id
      WHERE q.parent_id=? ORDER BY a.rowid LIMIT 65`,
      )
      .all(parentRunId);
    if (rows.length > 64) this.conflict();
    return rows.map((row) => {
      const b = this.answer(String(row.binding_id));
      if (
        !b ||
        !sameScope(b.scope, scope) ||
        processDigest(b.admission) !== processDigest(original) ||
        !this.consumed(b.bindingId, b.question)
      )
        this.conflict();
      return {
        commandId: b.command.commandId,
        questionId: b.question.questionId,
        answer: b.command.answer,
      };
    });
  }
  /** Consumption and domain journal save are one durable transaction before tool-end/ACK. */
  consume(bindingId: string, raw: ProcessQuestion, commit: () => void): string {
    const q = this.proof(raw),
      b = this.answer(bindingId);
    if (!b || processDigest(b.question) !== processDigest(q)) this.conflict();
    if (this.consumed(bindingId, q)) return b.command.answer;
    this.db.exec("SAVEPOINT process_question_consume");
    try {
      this.db
        .prepare("INSERT INTO agent_process_answer_consumption VALUES(?,?,?)")
        .run(bindingId, q.questionId, processDigest(q));
      commit();
      this.db.exec("RELEASE process_question_consume");
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_question_consume; RELEASE process_question_consume",
      );
      throw error;
    }
    return b.command.answer;
  }
}
