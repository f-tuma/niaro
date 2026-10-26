import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { IdentityError } from "../server-identity/error";
import {
  CommandSchema,
  ScopeSchema,
  sameScope,
  type Scope,
  type Command,
  type CalendarTarget,
  type ConversationListState,
} from "../../packages/protocol";
import { PrincipalSchema } from "./auth";
import { ConversationHistory } from "./conversation-history";
import { ChatSearchIndex } from "./chat-search";
import type { ChatSearchRole } from "../../packages/protocol/chat-search";
import { isAccountScope } from "../../packages/protocol/mobile-access";
import { migrateDatabase } from "./migrate";
import {
  DatabaseSchema,
  FixtureEngine,
  resettableConversation,
  type Database,
  type CalendarOutcome,
  type Interpretation,
  type ExecuteOptions,
} from "./engine";

type Change = "command" | "tick" | "migration" | "calendar";
/** What a deleted chat's receipts keep in place of the person's words. */
const DELETED_TEXT = "[deleted]";
export type CommitStage =
  | "state"
  | "events"
  | "session"
  | "receipts"
  | "before_commit"
  | "after_commit";
export type StorageCheckpoint = (stage: CommitStage, change: Change) => void;
const keyFor = (scope: Scope) =>
  JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.userId,
    scope.workspaceId,
  ]);

// Workflow writes use their own short transactions. This separate OS-held SQLite
// lock enforces the single HTTP owner required by the file-backed auth service.
// The OS releases it even on SIGKILL; no stale PID file needs manual removal.
export function acquireServerLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "server-lock.sqlite");
  const lock = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new Error(
      "Fixture data directory is already in use; stop its server first.",
    );
  }
  return () => lock.close();
}

/** A committed event log is the polling transport's outbox. Reads never consume it. */
/**
 * How many of a scope's newest receipts the engine loads for each command.
 * Receipts are never pruned: a command older than this window is still
 * deduplicated through a lookup by id, so no retry ever dispatches twice.
 */
export const RECENT_RECEIPTS = 500;
export class FixtureStorage {
  private db: DatabaseSync;
  private history!: ConversationHistory;
  private search!: ChatSearchIndex;
  constructor(
    directory: string,
    private serverId: string,
    private now = () => Date.now(),
    private checkpoint?: StorageCheckpoint,
    private calendarFor: (scope: Scope) => CalendarTarget | undefined = () =>
      undefined,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "workflow.sqlite");
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      // FULL syncs the WAL at every commit. Local filesystems only; not a network share.
      this.db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
      );
      this.transaction(true, () => {
        const version = this.db.prepare("PRAGMA user_version").get()!
          .user_version;
        if (version !== 0 && version !== 1)
          throw new Error("Unsupported workflow storage version");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS workflows (
            scope_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(json_valid(state)), next_due REAL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS workflows_due ON workflows(next_due);
          CREATE TABLE IF NOT EXISTS events (
            scope_key TEXT NOT NULL REFERENCES workflows(scope_key), sequence INTEGER NOT NULL,
            event_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(scope_key, sequence), UNIQUE(scope_key, event_id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS receipts (
            scope_key TEXT NOT NULL REFERENCES workflows(scope_key), command_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(scope_key, command_id), UNIQUE(scope_key, idempotency_key)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS conversation_sessions (
            scope_key TEXT NOT NULL REFERENCES workflows(scope_key), ended_at REAL NOT NULL,
            messages TEXT NOT NULL CHECK(json_valid(messages))
          ) STRICT;
          CREATE INDEX IF NOT EXISTS conversation_sessions_scope ON conversation_sessions(scope_key, ended_at);
          CREATE TABLE IF NOT EXISTS process_answer_messages (
            scope_key TEXT NOT NULL, work_id TEXT NOT NULL, question_id TEXT NOT NULL,
            PRIMARY KEY(scope_key,work_id,question_id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS conversation_session_command (
            scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
            command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL, session_id TEXT NOT NULL,
            PRIMARY KEY(scope_key,idempotency_key), UNIQUE(scope_key,command_id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS conversation_session_lookup
            ON conversation_session_command(scope_key,conversation_id);
          PRAGMA user_version=1;
        `);
        // The card.respond command (forms of model-composed cards) was
        // removed in October 2026; its receipts can no longer be parsed and
        // no client sends the command again, so they are dropped.
        this.db
          .prepare(
            "DELETE FROM receipts WHERE json_extract(payload,'$.command.type')='card.respond'",
          )
          .run();
        this.history = new ConversationHistory(this.db, this.now);
        this.history.migrate();
        // Follows the history through triggers; backfills once, bounded.
        this.search = new ChatSearchIndex(this.db, this.now);
        this.search.migrate();
        const owner = this.db
          .prepare("SELECT value FROM metadata WHERE key='server_id'")
          .get();
        if (owner && owner.value !== serverId)
          throw new Error("Persisted server identity mismatch");
        this.db
          .prepare("INSERT OR IGNORE INTO metadata VALUES ('server_id', ?)")
          .run(serverId);
      });
      this.importLegacy(directory);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  /** Readiness probe: the workflow database answers a trivial read. */
  ready() {
    try {
      return this.db.prepare("SELECT 1 AS ok").get()?.ok === 1;
    } catch {
      return false;
    }
  }

  private transaction<T>(write: boolean, run: () => T, change?: Change): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    let result: T;
    try {
      result = run();
      if (change) this.checkpoint?.("before_commit", change);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back on an I/O or full-disk error.
      }
      throw error;
    }
    // A failure here means an uncertain reply, never rollback of committed state.
    if (change) this.checkpoint?.("after_commit", change);
    return result;
  }

  private validateScope(scope: Scope) {
    ScopeSchema.parse(scope);
    const account = isAccountScope(scope);
    if (!account) PrincipalSchema.parse(scope.userId);
    if (
      scope.serverId !== this.serverId ||
      (!account &&
        (!["a", "b"].includes(scope.workspaceId) ||
          scope.connectionId !== `fixture-${scope.workspaceId}`))
    )
      throw new Error("Persisted workspace mismatch");
  }
  private load(scope: Scope): Database | undefined {
    this.validateScope(scope);
    const key = keyFor(scope);
    const row = this.db
      .prepare("SELECT state FROM workflows WHERE scope_key=?")
      .get(key);
    if (!row) return undefined;
    const state = JSON.parse(String(row.state));
    return DatabaseSchema.parse(
      migrateDatabase({
        ...state,
        events: this.db
          .prepare(
            "SELECT payload FROM events WHERE scope_key=? ORDER BY sequence",
          )
          .all(key)
          .map((r) => JSON.parse(String(r.payload))),
        // The engine works on the recent receipts; every receipt stays in
        // the table and older ones are looked up by id (`olderReceipt`).
        receipts: this.db
          .prepare(
            "SELECT payload FROM receipts WHERE scope_key=? ORDER BY rowid DESC LIMIT ?",
          )
          .all(key, RECENT_RECEIPTS)
          .map((r) => JSON.parse(String(r.payload)))
          .reverse(),
      }),
    );
  }
  private save(data: Database, previous: Database | undefined, change: Change) {
    const { events, receipts, ...state } = data;
    const scope = state.snapshot.scope;
    this.validateScope(scope);
    // A retained suffix may be truncated, but never contain holes or foreign events.
    if (
      state.eventFloor > state.snapshot.cursor ||
      (events.length === 0 && state.snapshot.cursor !== state.eventFloor) ||
      events.some((event) => event.sequence <= state.eventFloor) ||
      events.some(
        (event, index) =>
          !sameScope(event.scope, scope) ||
          event.sequence !== state.snapshot.cursor - events.length + index + 1,
      )
    )
      throw new Error("Invalid persisted event log");
    const key = keyFor(scope);
    for (const conversation of data.snapshot.conversations)
      this.history.save(scope, conversation);
    const nextDue = state.pending.length
      ? Math.min(...state.pending.map((p) => p.dueAt))
      : null;
    this.db
      .prepare(
        `INSERT INTO workflows VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET state=excluded.state, next_due=excluded.next_due`,
      )
      .run(key, JSON.stringify(state), nextDue);
    this.checkpoint?.("state", change);
    const insertEvent = this.db.prepare(
      "INSERT INTO events VALUES (?, ?, ?, ?)",
    );
    for (const event of events)
      if (event.sequence > (previous?.snapshot.cursor ?? 0))
        insertEvent.run(
          key,
          event.sequence,
          event.eventId,
          JSON.stringify(event),
        );
    this.db
      .prepare("DELETE FROM events WHERE scope_key=? AND sequence<=?")
      .run(key, Math.max(state.eventFloor, state.snapshot.cursor - 1000));
    this.checkpoint?.("events", change);
    const insertReceipt = this.db.prepare(
      "INSERT INTO receipts VALUES (?, ?, ?, ?)",
    );
    for (const receipt of receipts.slice(previous?.receipts.length ?? 0))
      insertReceipt.run(
        key,
        receipt.command.commandId,
        receipt.command.idempotencyKey,
        JSON.stringify(receipt),
      );
    this.checkpoint?.("receipts", change);
  }
  private engine(scope: Scope, change?: Change, conversationId?: string) {
    const previous = this.load(scope);
    const engine = new FixtureEngine(
      scope.workspaceId,
      previous,
      (data) => {
        if (!change) throw new Error("Read transaction cannot mutate workflow");
        this.save(data, previous, change);
      },
      this.now,
      scope,
      this.calendarFor(scope),
      (id) => this.history.live(scope, id),
      (id) => this.history.exists(scope, id),
      {
        has: (id) => this.history.deleted(scope, id),
        shell: (id) => this.history.shell(scope, id),
      },
      (id) => this.history.archived(scope, id),
      (commandId, idempotencyKey) =>
        this.receipt(scope, commandId, idempotencyKey),
    );
    if (conversationId) engine.selectConversation(conversationId);
    return engine;
  }
  /** A stored receipt by command id or idempotency key, however old. */
  private receipt(scope: Scope, commandId: string, idempotencyKey: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM receipts WHERE scope_key=? AND (command_id=? OR idempotency_key=?) LIMIT 1",
      )
      .get(keyFor(scope), commandId, idempotencyKey);
    return row
      ? DatabaseSchema.shape.receipts.element.parse(
          JSON.parse(String(row.payload)),
        )
      : undefined;
  }
  syncNativeWork(
    scope: Scope,
    items: import("../../packages/protocol").WorkItem[],
    authoritative = false,
  ) {
    return this.transaction(
      true,
      () =>
        this.engine(scope, "command").syncNativeWork(
          items,
          true,
          authoritative,
          (workId, questionId) => {
            const result = this.db
              .prepare(
                "INSERT OR IGNORE INTO process_answer_messages VALUES(?,?,?)",
              )
              .run(keyFor(scope), workId, questionId);
            return Number(result.changes) === 1;
          },
        ),
      "command",
    );
  }
  snapshot(scope: Scope, conversationId?: string) {
    return this.transaction(false, () =>
      this.engine(scope, undefined, conversationId).snapshot(),
    );
  }
  modelState(
    scope: Scope,
    timeZone: string,
    text?: string,
    conversationId = "conversation-1",
  ) {
    return this.transaction(false, () =>
      this.engine(scope, undefined, conversationId).modelState(
        timeZone,
        text,
        conversationId,
      ),
    );
  }
  events(scope: Scope, after: number) {
    return this.transaction(false, () => this.engine(scope).events(after));
  }
  /** Archives the live chat (long-term history) and clears short-term memory. */
  startSession(
    scope: Scope,
    conversationId = "conversation-1",
    command?: Command,
  ) {
    return this.transaction(
      true,
      () => this.archiveSession(scope, conversationId, command),
      "command",
    );
  }
  private archiveSession(
    scope: Scope,
    conversationId = "conversation-1",
    command?: Command,
  ) {
    const engine = this.engine(scope, "command", conversationId);
    let boundary: { requestHash: string; sessionId: string } | undefined;
    if (command) {
      const parsed = CommandSchema.parse(command);
      if (
        parsed.type !== "message.send" ||
        parsed.session !== "new" ||
        parsed.conversationId !== conversationId
      )
        throw new Error("Invalid conversation session command");
      if (!engine.snapshot().conversations.some((c) => c.id === conversationId))
        throw new IdentityError(409, "catalog_conflict");
      const requestHash = createHash("sha256")
        .update(JSON.stringify(parsed))
        .digest("hex");
      if (this.sessionReservation(scope, parsed)) return false;
      boundary = {
        requestHash,
        sessionId: createHash("sha256")
          .update(JSON.stringify([keyFor(scope), requestHash]))
          .digest("hex"),
      };
    }
    const all = this.history.live(scope, conversationId);
    const archived = engine.startSession(conversationId);
    if (archived) {
      const messages = all?.messages ?? archived;
      const insert = this.db
        .prepare("INSERT INTO conversation_sessions VALUES (?, ?, ?)")
        .run(keyFor(scope), this.now(), JSON.stringify(messages));
      this.history.archiveRow(
        keyFor(scope),
        Number(insert.lastInsertRowid),
        this.now(),
        messages,
      );
      this.history.copyArchive(
        scope,
        conversationId,
        `archived-${insert.lastInsertRowid}`,
      );
      this.history.clear(scope, conversationId);
    }
    if (boundary && command) {
      this.db
        .prepare("INSERT INTO conversation_session_command VALUES(?,?,?,?,?,?)")
        .run(
          keyFor(scope),
          conversationId,
          command.commandId,
          command.idempotencyKey,
          boundary.requestHash,
          boundary.sessionId,
        );
      this.checkpoint?.("session", "command");
    }
    return !!archived;
  }
  /** Only a committed server reset establishes a new native conversation generation. */
  private sessionReservation(scope: Scope, command: Command) {
    this.validateScope(scope);
    const rows = this.db
      .prepare(
        "SELECT request_hash,session_id FROM conversation_session_command WHERE scope_key=? AND (command_id=? OR idempotency_key=?)",
      )
      .all(keyFor(scope), command.commandId, command.idempotencyKey);
    if (!rows.length) return undefined;
    const hash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    if (rows.length !== 1 || rows[0]!.request_hash !== hash)
      throw new IdentityError(409, "idempotency_conflict");
    return rows[0]!;
  }
  conversationSession(scope: Scope, conversationId: string, command?: Command) {
    return this.transaction(false, () => {
      this.validateScope(scope);
      const parsed = command && CommandSchema.parse(command);
      if (
        parsed &&
        (parsed.type !== "message.send" ||
          parsed.session !== "new" ||
          parsed.conversationId !== conversationId)
      )
        throw new Error("Invalid conversation session command");
      const row = parsed
        ? this.sessionReservation(scope, parsed)
        : this.db
            .prepare(
              "SELECT session_id FROM conversation_session_command WHERE scope_key=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(keyFor(scope), conversationId);
      if (!row) return undefined;
      if (
        typeof row.session_id !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.session_id)
      )
        throw new Error("Invalid persisted conversation session");
      return row.session_id;
    });
  }
  /** Deleted for good: never continued, named or created again. */
  conversationDeleted(scope: Scope, id: string) {
    return this.transaction(false, () => {
      this.validateScope(scope);
      return this.history.deleted(scope, id);
    });
  }
  /** Archived: read-only until restored; never continued meanwhile. */
  conversationArchived(scope: Scope, id: string) {
    return this.transaction(false, () => {
      this.validateScope(scope);
      return this.history.archived(scope, id);
    });
  }
  conversations(
    scope: Scope,
    after?: string | null,
    state?: ConversationListState,
  ) {
    return this.transaction(false, () => {
      this.validateScope(scope);
      return this.history.list(scope, after, state);
    });
  }
  conversationMessages(
    scope: Scope,
    id: string,
    after?: string | null,
    revision?: number,
  ) {
    return this.transaction(false, () => {
      this.validateScope(scope);
      return this.history.messages(scope, id, after, revision);
    });
  }
  /** The person's chats matching a query; see `ChatSearchIndex.search`. */
  searchConversations(
    scope: Scope,
    query: string,
    options: {
      after?: number;
      limit: number;
      includeArchived: boolean;
      archivedOnly: boolean;
      role?: ChatSearchRole;
    },
  ) {
    // A write transaction: chats changed since the last search are indexed first.
    return this.transaction(true, () => {
      this.validateScope(scope);
      return this.search.search(scope, query, options);
    });
  }
  /** Earlier chat sessions, newest first; the base for long-term memory. */
  sessions(scope: Scope, limit = 20) {
    return this.transaction(false, () =>
      this.db
        .prepare(
          "SELECT ended_at, messages FROM conversation_sessions WHERE scope_key=? ORDER BY ended_at DESC LIMIT ?",
        )
        .all(keyFor(scope), limit)
        .map((row) => ({
          endedAt: Number(row.ended_at),
          messages: JSON.parse(String(row.messages)) as unknown[],
        })),
    );
  }
  replay(scope: Scope, command: unknown) {
    return this.transaction(false, () => {
      const parsed = CommandSchema.parse(command);
      const replay = this.engine(
        scope,
        undefined,
        parsed.conversationId,
      ).replay(parsed);
      if (!replay) this.sessionReservation(scope, parsed);
      return replay;
    });
  }
  /** Durable accepted creation distinguishes new public chats from historical origins. */
  createdConversation(scope: Scope, conversationId: string) {
    return this.transaction(false, () => {
      this.validateScope(scope);
      const row = this.db
        .prepare(
          "SELECT payload FROM receipts WHERE scope_key=? AND json_extract(payload,'$.command.type')='conversation.create' AND json_extract(payload,'$.command.conversationId')=? AND json_extract(payload,'$.status')='accepted' LIMIT 1",
        )
        .get(keyFor(scope), conversationId);
      if (!row) return false;
      const receipt = DatabaseSchema.shape.receipts.element.parse(
        JSON.parse(String(row.payload)),
      );
      return (
        receipt.status === "accepted" &&
        receipt.code === "accepted" &&
        receipt.command.type === "conversation.create" &&
        receipt.command.conversationId === conversationId
      );
    });
  }
  /** Existing scoped public ledger and correlated server reply are the only legacy origin proof. */
  legacyQuestionProof(scope: Scope, idempotencyKey: string) {
    const data = this.load(scope);
    if (!data || !sameScope(data.snapshot.scope, scope)) return undefined;
    const receipt = this.receipt(scope, idempotencyKey, idempotencyKey);
    if (
      !receipt ||
      receipt.status !== "accepted" ||
      receipt.command.type !== "message.send"
    )
      return undefined;
    const command = receipt.command;
    const conversation = data.snapshot.conversations.find(
      (c) => c.id === command.conversationId,
    );
    const replies = conversation?.messages.filter(
      (m) => m.role === "assistant" && m.replyToCommandId === command.commandId,
    );
    if (!replies || replies.length !== 1) return undefined;
    return { command, question: replies[0]!.text };
  }
  execute(
    scope: Scope,
    command: unknown,
    interpretation?: Interpretation,
    options?: ExecuteOptions,
  ) {
    // Acquire the writer lock BEFORE loading receipts/state; no cached stale engine.
    return this.transaction(
      true,
      () => {
        // Covers servers without a model service; with one, the chat is already
        // empty here and this is a no-op. Replayed commands never archive again.
        const parsed = CommandSchema.safeParse(command);
        const replay = parsed.success && this.engine(scope).replay(parsed.data);
        if (parsed.success && !replay)
          this.sessionReservation(scope, parsed.data);
        if (
          parsed.success &&
          parsed.data.type === "message.send" &&
          parsed.data.session === "new" &&
          !replay
        )
          this.archiveSession(scope, parsed.data.conversationId, parsed.data);
        const result = this.engine(
          scope,
          "command",
          parsed.success ? parsed.data.conversationId : undefined,
        ).execute(command, interpretation, options);
        if (parsed.success && !replay && result.status === "accepted")
          this.applyDirectoryCommand(scope, parsed.data);
        return result;
      },
      "command",
    );
  }
  /** A new native conversation generation: the chat's next turn never
   * resumes an earlier assistant thread. */
  private newGeneration(scope: Scope, command: Command, reason: string) {
    const key = keyFor(scope);
    this.db
      .prepare("INSERT INTO conversation_session_command VALUES(?,?,?,?,?,?)")
      .run(
        key,
        command.conversationId,
        command.commandId,
        command.idempotencyKey,
        createHash("sha256").update(JSON.stringify(command)).digest("hex"),
        createHash("sha256")
          .update(JSON.stringify([key, reason, command.idempotencyKey]))
          .digest("hex"),
      );
  }
  /** Chat names, archive and deletion live in the directory, in the command's transaction. */
  private applyDirectoryCommand(scope: Scope, command: Command) {
    if (command.type === "conversation.rename")
      this.history.rename(scope, command.conversationId, command.title);
    if (command.type === "conversation.archive") {
      const id = command.conversationId;
      if (this.history.archived(scope, id)) return;
      // The main chat keeps its fixed id: its messages move into a new
      // archived chat, as a new session does, and it continues empty.
      if (resettableConversation(id)) this.archiveSession(scope, id);
      else this.history.archive(scope, id);
      this.newGeneration(scope, command, "archived");
      return;
    }
    if (command.type === "conversation.restore") {
      const id = command.conversationId;
      if (!this.history.archived(scope, id)) return;
      this.engine(scope, "command").restoreConversation(id, (minimum) =>
        this.history.restore(scope, id, minimum),
      );
      // The restored chat continues with its visible history, in a fresh
      // assistant thread: the archived one is never resumed.
      this.newGeneration(scope, command, "restored");
      return;
    }
    if (command.type !== "conversation.delete") return;
    const id = command.conversationId;
    const key = keyFor(scope);
    const legacy = this.history.delete(scope, id, resettableConversation(id));
    if (legacy !== undefined)
      this.db
        .prepare(
          "UPDATE conversation_sessions SET messages='[]' WHERE scope_key=? AND rowid=?",
        )
        .run(key, legacy);
    // Receipts stay for idempotency, without what the person wrote there.
    this.db
      .prepare(
        `UPDATE receipts SET payload=json_remove(json_set(payload,'$.command.text',?),'$.command.humanTask','$.command.mentions')
        WHERE scope_key=? AND json_extract(payload,'$.command.conversationId')=?
        AND json_extract(payload,'$.command.type')='message.send'`,
      )
      .run(DELETED_TEXT, key, id);
    // A server-owned chat that continues starts a new native generation, so
    // its next turn cannot resume the deleted assistant thread.
    this.newGeneration(scope, command, "deleted");
  }
  tick() {
    const due = this.db
      .prepare("SELECT state FROM workflows WHERE next_due<=?")
      .all(this.now());
    const failures: unknown[] = [];
    for (const row of due) {
      try {
        const scope = ScopeSchema.parse(
          JSON.parse(String(row.state)).snapshot.scope,
        );
        this.transaction(true, () => this.engine(scope, "tick").tick(), "tick");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Fixture worker transactions failed");
  }
  calendarJobs() {
    return this.transaction(false, () =>
      this.db
        .prepare("SELECT state FROM workflows WHERE next_due<=?")
        .all(this.now())
        .flatMap((row) => {
          const scope = ScopeSchema.parse(
            JSON.parse(String(row.state)).snapshot.scope,
          );
          const data = this.load(scope)!;
          return data.pending
            .filter(
              (p) => p.kind === "calendar_operation" && p.dueAt <= this.now(),
            )
            .map((p) => ({ scope, operationId: p.operationId! }));
        }),
    );
  }
  claimCalendar(scope: Scope, operationId: string) {
    return this.transaction(
      true,
      () => this.engine(scope, "calendar").claimCalendar(operationId),
      "calendar",
    );
  }
  completeCalendar(
    scope: Scope,
    operationId: string,
    outcome: CalendarOutcome,
  ) {
    return this.transaction(
      true,
      () =>
        this.engine(scope, "calendar").completeCalendar(operationId, outcome),
      "calendar",
    );
  }
  private importLegacy(directory: string) {
    this.transaction(
      true,
      () => {
        if (
          this.db
            .prepare("SELECT value FROM metadata WHERE key='legacy_imported'")
            .get()
        )
          return;
        const root = join(directory, "authenticated");
        if (existsSync(root))
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (
              !entry.isDirectory() ||
              !PrincipalSchema.safeParse(entry.name).success
            )
              continue;
            for (const workspaceId of ["a", "b"]) {
              const file = join(root, entry.name, `${workspaceId}.json`);
              if (!existsSync(file)) continue;
              const scope = {
                connectionId: `fixture-${workspaceId}`,
                serverId: this.serverId,
                userId: entry.name,
                workspaceId,
              };
              const legacy = new FixtureEngine(
                workspaceId,
                JSON.parse(readFileSync(file, "utf8")),
                undefined,
                this.now,
                scope,
              );
              this.save(legacy.data, undefined, "migration");
            }
          }
        // The marker and ALL accounts commit together. Sources remain untouched.
        this.db
          .prepare("INSERT INTO metadata VALUES ('legacy_imported', '1')")
          .run();
      },
      "migration",
    );
  }
}
