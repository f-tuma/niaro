import type { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_HISTORY_PROFILE,
  ConversationHistoryPageSchema,
  type ConversationListState,
  ConversationMessagePageSchema,
  ConversationSchema,
  ConversationSummarySchema,
  MessageSchema,
  type Conversation,
  type Scope,
} from "../../packages/protocol";

const scopeKey = (scope: Scope) =>
  JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.userId,
    scope.workspaceId,
  ]);
const cursor = (value?: string | null) => {
  if (value == null) return 0;
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new RangeError("Invalid conversation cursor");
  return Number(value);
};

const DELETED = 1;
const EMPTIED = 2;

/** The public ledger is independent of the bounded live workflow projection. */
export class ConversationHistory {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS public_conversation (
      scope_key TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      read_only INTEGER NOT NULL, legacy_session INTEGER,
      PRIMARY KEY(scope_key,id), UNIQUE(scope_key,legacy_session)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS public_conversation_message (
      scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL, id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
      PRIMARY KEY(scope_key,conversation_id,id),
      UNIQUE(scope_key,conversation_id,ordinal)
    ) STRICT;`);
    // The person's own name and deletion are directory state of the chat.
    const columns = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info('public_conversation')")
        .all()
        .map((row) => String(row.name)),
    );
    if (!columns.has("custom_title"))
      db.exec("ALTER TABLE public_conversation ADD COLUMN custom_title TEXT");
    // 0 listed, 1 deleted for good (a tombstone that keeps the id from being
    // reused), 2 emptied server-owned chat, listed again with its next message.
    if (!columns.has("deleted"))
      db.exec(
        "ALTER TABLE public_conversation ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
      );
  }
  migrate() {
    // Existing archive rowids are used only once, then become durable public IDs.
    for (const row of this.db
      .prepare(
        "SELECT rowid,scope_key,ended_at,messages FROM conversation_sessions ORDER BY rowid",
      )
      .all())
      this.archiveRow(
        String(row.scope_key),
        Number(row.rowid),
        Number(row.ended_at),
        JSON.parse(String(row.messages)),
      );
    for (const row of this.db
      .prepare("SELECT scope_key,state FROM workflows")
      .all()) {
      const state = JSON.parse(String(row.state)) as {
        snapshot: { conversations: unknown[] };
      };
      for (const raw of state.snapshot.conversations)
        this.saveKey(String(row.scope_key), ConversationSchema.parse(raw));
    }
  }
  archiveRow(key: string, rowid: number, endedAt: number, raw: unknown) {
    const messages = MessageSchema.array().parse(raw);
    const id = `archived-${rowid}`;
    const exists = this.db
      .prepare(
        "SELECT id FROM public_conversation WHERE scope_key=? AND legacy_session=?",
      )
      .get(key, rowid);
    if (exists) return;
    this.saveKey(
      key,
      { id, revision: 1, messages: [] },
      true,
      new Date(endedAt).toISOString(),
      rowid,
    );
    this.saveMessages(key, id, messages);
    const title =
      messages
        .find((m) => m.role === "user")
        ?.text.trim()
        .slice(0, 160) ?? "";
    this.db
      .prepare(
        "UPDATE public_conversation SET title=? WHERE scope_key=? AND id=?",
      )
      .run(title, key, id);
  }
  save(scope: Scope, conversation: Conversation) {
    this.saveKey(scopeKey(scope), conversation);
  }
  private saveKey(
    key: string,
    conversation: Conversation,
    readOnly = false,
    date = new Date(this.now()).toISOString(),
    source: number | null = null,
  ) {
    const old = this.db
      .prepare(
        "SELECT revision,read_only,deleted FROM public_conversation WHERE scope_key=? AND id=?",
      )
      .get(key, conversation.id);
    // A deleted chat's empty reference never brings it or its messages back.
    if (old && Number(old.deleted) === DELETED) return;
    if (old && Number(old.revision) >= conversation.revision) return;
    if (old && Number(old.read_only)) {
      // A task's content-free reference to an archived chat changes nothing.
      if (!conversation.messages.length) return;
      throw new Error("Archived conversation is immutable");
    }
    const title =
      conversation.messages
        .find((m) => m.role === "user")
        ?.text.trim()
        .slice(0, 160) ?? "";
    this.db
      .prepare(
        `INSERT INTO public_conversation(scope_key,id,revision,title,created_at,updated_at,read_only,legacy_session) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope_key,id) DO UPDATE SET revision=excluded.revision,
      title=CASE WHEN public_conversation.title='' THEN excluded.title ELSE public_conversation.title END,
      updated_at=excluded.updated_at`,
      )
      .run(
        key,
        conversation.id,
        conversation.revision,
        title,
        date,
        date,
        readOnly ? 1 : 0,
        source,
      );
    // An emptied server-owned chat returns to the list as a new chat.
    if (old && Number(old.deleted) === EMPTIED && conversation.messages.length)
      this.db
        .prepare(
          "UPDATE public_conversation SET deleted=0,created_at=? WHERE scope_key=? AND id=?",
        )
        .run(date, key, conversation.id);
    this.saveMessages(key, conversation.id, conversation.messages);
  }
  private saveMessages(
    key: string,
    id: string,
    messages: Conversation["messages"],
  ) {
    let ordinal = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(ordinal),0) AS n FROM public_conversation_message WHERE scope_key=? AND conversation_id=?",
        )
        .get(key, id)!.n,
    );
    const existing = this.db.prepare(
      "SELECT ordinal FROM public_conversation_message WHERE scope_key=? AND conversation_id=? AND id=?",
    );
    const insert = this.db
      .prepare(`INSERT INTO public_conversation_message VALUES(?,?,?,?,?)
      ON CONFLICT(scope_key,conversation_id,id) DO UPDATE SET payload=excluded.payload`);
    for (const message of messages) {
      const old = existing.get(key, id, message.id);
      insert.run(
        key,
        id,
        message.id,
        old ? Number(old.ordinal) : ++ordinal,
        JSON.stringify(message),
      );
    }
  }
  /** Deleted ids still exist: they can never be created again. */
  exists(scope: Scope, id: string) {
    return !!this.db
      .prepare("SELECT id FROM public_conversation WHERE scope_key=? AND id=?")
      .get(scopeKey(scope), id);
  }
  deleted(scope: Scope, id: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM public_conversation WHERE scope_key=? AND id=? AND deleted=?",
      )
      .get(scopeKey(scope), id, DELETED);
  }
  /** Archived chats are read-only: listed under the archive, never continued. */
  archived(scope: Scope, id: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM public_conversation WHERE scope_key=? AND id=? AND read_only=1 AND deleted=0",
      )
      .get(scopeKey(scope), id);
  }
  /** The content-free reference a retained task may still need when its chat
   * was deleted or archived. A session archive was never referenced. */
  shell(scope: Scope, id: string): Conversation | undefined {
    const row = this.db
      .prepare(
        "SELECT revision FROM public_conversation WHERE scope_key=? AND id=? AND (deleted=? OR read_only=1) AND legacy_session IS NULL",
      )
      .get(scopeKey(scope), id, DELETED);
    return row
      ? { id, revision: Number(row.revision), messages: [] }
      : undefined;
  }
  /** Moves a listed chat into the archive; its messages stay as they are. */
  archive(scope: Scope, id: string) {
    this.db
      .prepare(
        "UPDATE public_conversation SET read_only=1,updated_at=? WHERE scope_key=? AND id=? AND deleted=0",
      )
      .run(new Date(this.now()).toISOString(), scopeKey(scope), id);
  }
  /**
   * Makes an archived chat a listed one that can continue, with a new
   * revision. A session archive drops its messages' references to work of
   * the earlier session, as its history pages always did.
   */
  restore(scope: Scope, id: string, minimumRevision = 0) {
    const key = scopeKey(scope);
    const row = this.db
      .prepare(
        "UPDATE public_conversation SET read_only=0,updated_at=?,revision=MAX(revision,?)+1 WHERE scope_key=? AND id=? AND read_only=1 AND deleted=0 RETURNING legacy_session",
      )
      .get(new Date(this.now()).toISOString(), minimumRevision, key, id);
    if (row && row.legacy_session != null)
      this.db
        .prepare(
          "UPDATE public_conversation_message SET payload=json_remove(payload,'$.workItemId','$.inputRequestId') WHERE scope_key=? AND conversation_id=?",
        )
        .run(key, id);
    return !!row;
  }
  /** The person's name for a chat; empty brings back the server's title. */
  rename(scope: Scope, id: string, title: string) {
    this.db
      .prepare(
        "UPDATE public_conversation SET custom_title=? WHERE scope_key=? AND id=? AND deleted<>?",
      )
      .run(title || null, scopeKey(scope), id, DELETED);
  }
  /**
   * Removes a chat's messages and names from the directory. A server-owned
   * chat stays as an empty, unlisted chat; any other keeps only a tombstone
   * (id, revision, dates) so the id is never reused. Returns the legacy
   * session row of an archive, whose stored copy must go too.
   */
  delete(scope: Scope, id: string, keepUsable: boolean) {
    const key = scopeKey(scope);
    this.db
      .prepare(
        "DELETE FROM public_conversation_message WHERE scope_key=? AND conversation_id=?",
      )
      .run(key, id);
    const row = this.db
      .prepare(
        "UPDATE public_conversation SET title='',custom_title=NULL,deleted=? WHERE scope_key=? AND id=? RETURNING legacy_session",
      )
      .get(keepUsable ? EMPTIED : DELETED, key, id);
    return row?.legacy_session == null ? undefined : Number(row.legacy_session);
  }
  live(scope: Scope, id: string): Conversation | undefined {
    const key = scopeKey(scope);
    const row = this.db
      .prepare(
        "SELECT revision FROM public_conversation WHERE scope_key=? AND id=? AND read_only=0 AND deleted<>?",
      )
      .get(key, id, DELETED);
    if (!row) return undefined;
    const messages = this.db
      .prepare(
        "SELECT payload FROM (SELECT ordinal,payload FROM public_conversation_message WHERE scope_key=? AND conversation_id=? ORDER BY ordinal DESC LIMIT 500) ORDER BY ordinal",
      )
      .all(key, id)
      .map((r) => MessageSchema.parse(JSON.parse(String(r.payload))));
    return { id, revision: Number(row.revision), messages };
  }
  clear(scope: Scope, id: string) {
    this.db
      .prepare(
        "DELETE FROM public_conversation_message WHERE scope_key=? AND conversation_id=?",
      )
      .run(scopeKey(scope), id);
    this.db
      .prepare(
        "UPDATE public_conversation SET title='',custom_title=NULL WHERE scope_key=? AND id=?",
      )
      .run(scopeKey(scope), id);
  }
  copyArchive(scope: Scope, source: string, destination: string) {
    const key = scopeKey(scope);
    this.db
      .prepare(
        "DELETE FROM public_conversation_message WHERE scope_key=? AND conversation_id=?",
      )
      .run(key, destination);
    this.db
      .prepare(
        `INSERT INTO public_conversation_message SELECT scope_key,?,id,ordinal,payload FROM public_conversation_message WHERE scope_key=? AND conversation_id=?`,
      )
      .run(destination, key, source);
    this.db
      .prepare(
        "UPDATE public_conversation SET (title,custom_title)=(SELECT title,custom_title FROM public_conversation WHERE scope_key=? AND id=?) WHERE scope_key=? AND id=?",
      )
      .run(key, source, key, destination);
  }
  private summary(row: Record<string, unknown>) {
    return ConversationSummarySchema.parse({
      id: row.id,
      revision: Number(row.revision),
      title: row.custom_title ?? row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      readOnly: !!Number(row.read_only),
      messageCount: Number(row.message_count),
    });
  }
  list(scope: Scope, after?: string | null, state?: ConversationListState) {
    const key = scopeKey(scope);
    const count = `(SELECT COUNT(*) FROM public_conversation_message m WHERE m.scope_key=c.scope_key AND m.conversation_id=c.id) AS message_count`;
    // A filtered page runs newest first; the cursor is the last row's rowid.
    const rows = state
      ? this.db
          .prepare(
            `SELECT c.rowid,c.*,${count} FROM public_conversation c
        WHERE c.scope_key=? AND c.deleted=0 AND c.read_only=?
        AND (?=0 OR (c.updated_at,c.rowid)<(SELECT updated_at,rowid FROM public_conversation WHERE rowid=?))
        ORDER BY c.updated_at DESC,c.rowid DESC LIMIT 41`,
          )
          .all(key, state === "archived" ? 1 : 0, cursor(after), cursor(after))
      : this.db
          .prepare(
            `SELECT c.rowid,c.*,${count}
      FROM public_conversation c WHERE c.scope_key=? AND c.rowid>? AND c.deleted=0 ORDER BY c.rowid LIMIT 41`,
          )
          .all(key, cursor(after));
    const page = rows.slice(0, 40);
    return ConversationHistoryPageSchema.parse({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope,
      conversations: page.map((r) => this.summary(r)),
      nextAfter: rows.length > 40 ? String(page.at(-1)!.rowid) : null,
    });
  }
  messages(
    scope: Scope,
    id: string,
    after?: string | null,
    expectedRevision?: number,
  ) {
    const key = scopeKey(scope);
    const row = this.db
      .prepare(
        `SELECT c.*,(SELECT COUNT(*) FROM public_conversation_message m WHERE m.scope_key=c.scope_key AND m.conversation_id=c.id) AS message_count FROM public_conversation c WHERE scope_key=? AND id=? AND deleted<>?`,
      )
      .get(key, id, DELETED);
    if (!row) return null;
    if (
      expectedRevision !== undefined &&
      Number(row.revision) !== expectedRevision
    )
      return undefined;
    const before = after == null ? Number.MAX_SAFE_INTEGER : cursor(after);
    const rows = this.db
      .prepare(
        "SELECT ordinal,payload FROM public_conversation_message WHERE scope_key=? AND conversation_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 41",
      )
      .all(key, id, before);
    const page = rows.slice(0, 40).reverse();
    return ConversationMessagePageSchema.parse({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope,
      conversation: this.summary(row),
      messages: page.map((r) => {
        const { result: _result, ...message } = MessageSchema.parse(
          JSON.parse(String(r.payload)),
        );
        if (!Number(row.read_only)) return message;
        const {
          workItemId: _work,
          inputRequestId: _input,
          ...historical
        } = message;
        return historical;
      }),
      nextAfter: rows.length > 40 ? String(page[0]!.ordinal) : null,
    });
  }
}
