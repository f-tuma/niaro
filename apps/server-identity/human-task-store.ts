import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "../../packages/protocol";
import {
  HUMAN_TASK_PROFILE,
  HumanTaskSchema,
  HumanTaskCommandSchema,
  HumanTaskContentSchema,
  humanTaskTransition,
  migrateHumanTask,
  type HumanTask,
  type HumanTaskCommand,
  type HumanTaskTab,
} from "../../packages/protocol/human-tasks";
import { IdentityError } from "./error";
const owner = (s: Scope) =>
  JSON.stringify([s.connectionId, s.serverId, s.workspaceId, s.userId]);
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const normalizedText = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
/** Stable exact-match key for suppressing a repeated open obligation. */
export function humanTaskContentKey(raw: unknown) {
  const content = HumanTaskContentSchema.parse(raw);
  return hash({
    title: normalizedText(content.title),
    detail: normalizedText(content.detail),
    assignee:
      content.assignee === null ? null : normalizedText(content.assignee),
    due: content.due === null ? null : normalizedText(content.due),
  });
}
const legacyStatuses = `('proposed','active','completed','dismissed')`;
export class HumanTaskStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS niaro_human_task(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL, meeting_id TEXT, value TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS niaro_human_task_owner ON niaro_human_task(owner,created_at,id);
    CREATE TABLE IF NOT EXISTS niaro_human_task_receipt(owner TEXT NOT NULL, command_id TEXT NOT NULL, idem TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES niaro_human_task(id) ON DELETE CASCADE, digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner,command_id),UNIQUE(owner,idem)) STRICT;`);
    this.migrate();
  }
  /** Proposals and accepted work became open items; v1 receipts cannot be replayed. */
  private migrate() {
    const rows = this.db
      .prepare(
        `SELECT id,value FROM niaro_human_task WHERE json_extract(value,'$.status') IN ${legacyStatuses}`,
      )
      .all();
    if (!rows.length) return;
    this.db.exec("SAVEPOINT human_task_migrate");
    try {
      const update = this.db.prepare(
        "UPDATE niaro_human_task SET value=? WHERE id=?",
      );
      for (const row of rows)
        update.run(
          JSON.stringify(migrateHumanTask(JSON.parse(String(row.value)))),
          String(row.id),
        );
      this.db.exec(
        `DELETE FROM niaro_human_task_receipt WHERE json_extract(value,'$.status') IN ${legacyStatuses}`,
      );
      this.db.exec("RELEASE human_task_migrate");
    } catch (e) {
      this.db.exec(
        "ROLLBACK TO human_task_migrate; RELEASE human_task_migrate",
      );
      throw e;
    }
  }
  get(scope: Scope, id: string) {
    const row = this.db
      .prepare("SELECT value FROM niaro_human_task WHERE owner=? AND id=?")
      .get(owner(scope), id);
    if (!row) throw new IdentityError(404, "human_task_not_found");
    return HumanTaskSchema.parse(JSON.parse(String(row.value)));
  }
  /** Saves a new open item. Repeating the same item returns it unchanged. */
  create(
    scope: Scope,
    id: string,
    content: unknown,
    origin: HumanTask["origin"],
  ) {
    const value = HumanTaskContentSchema.parse(content);
    const row = this.db
      .prepare("SELECT owner,value FROM niaro_human_task WHERE id=?")
      .get(id);
    if (row) {
      const old = this.get(scope, id);
      if (
        hash({
          content: {
            title: old.title,
            detail: old.detail,
            assignee: old.assignee,
            due: old.due,
            ...(old.dueDate ? { dueDate: old.dueDate } : {}),
          },
          origin: old.origin,
        }) !== hash({ content: value, origin })
      )
        throw new IdentityError(409, "human_task_conflict");
      return old;
    }
    if (
      Number(
        this.db
          .prepare("SELECT count(*) AS n FROM niaro_human_task WHERE owner=?")
          .get(owner(scope))!.n,
      ) >= 4000
    )
      throw new IdentityError(429, "human_task_limit");
    const at = new Date().toISOString();
    const task = HumanTaskSchema.parse({
      ...value,
      id,
      scope,
      origin,
      status: "open",
      resolution: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    this.db
      .prepare("INSERT INTO niaro_human_task VALUES (?,?,?,?,?)")
      .run(
        id,
        owner(scope),
        at,
        origin.kind === "meeting" ? origin.meetingId : null,
        JSON.stringify(task),
      );
    return task;
  }
  /** The newest open items, for the assistant's own context. */
  open(scope: Scope, limit: number) {
    return this.db
      .prepare(
        "SELECT value FROM niaro_human_task WHERE owner=? AND json_extract(value,'$.status')='open' ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(owner(scope), limit)
      .map((row) => HumanTaskSchema.parse(JSON.parse(String(row.value))));
  }
  openCount(scope: Scope) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM niaro_human_task WHERE owner=? AND json_extract(value,'$.status')='open'",
        )
        .get(owner(scope))!.n,
    );
  }
  /** Open items per meeting: how many, and the first one's title. */
  openByMeeting(scope: Scope) {
    const result = new Map<string, { count: number; next: string }>();
    for (const row of this.db
      .prepare(
        "SELECT meeting_id, json_extract(value,'$.title') AS title FROM niaro_human_task WHERE owner=? AND meeting_id IS NOT NULL AND json_extract(value,'$.status')='open' ORDER BY created_at,id",
      )
      .all(owner(scope))) {
      const id = String(row.meeting_id);
      const entry = result.get(id);
      if (entry) entry.count++;
      else result.set(id, { count: 1, next: String(row.title ?? "") });
    }
    return result;
  }
  /** Checks every open item, including older items omitted from model context. */
  findOpenDuplicate(scope: Scope, content: unknown) {
    const key = humanTaskContentKey(content);
    return this.db
      .prepare(
        "SELECT value FROM niaro_human_task WHERE owner=? AND json_extract(value,'$.status')='open' ORDER BY created_at DESC,id DESC",
      )
      .all(owner(scope))
      .map((row) => HumanTaskSchema.parse(JSON.parse(String(row.value))))
      .find(
        (task) =>
          humanTaskContentKey({
            title: task.title,
            detail: task.detail,
            assignee: task.assignee,
            due: task.due,
          }) === key,
      );
  }
  list(scope: Scope, tab: HumanTaskTab, after?: string) {
    const states = tab === "open" ? ["open"] : ["done", "removed"];
    const cursor = after ? this.get(scope, after) : undefined;
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT value FROM niaro_human_task WHERE owner=? AND json_extract(value,'$.status') IN (${placeholders}) ${cursor ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT 101`,
      )
      .all(
        owner(scope),
        ...states,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      );
    const tasks = rows
      .slice(0, 100)
      .map((row) => HumanTaskSchema.parse(JSON.parse(String(row.value))));
    const hasMore = rows.length > 100;
    const counts = { open: 0, done: 0 };
    for (const row of this.db
      .prepare(
        "SELECT json_extract(value,'$.status') AS status,count(*) AS n FROM niaro_human_task WHERE owner=? GROUP BY json_extract(value,'$.status')",
      )
      .all(owner(scope))) {
      counts[row.status === "open" ? "open" : "done"] += Number(row.n);
    }
    return {
      profile: HUMAN_TASK_PROFILE,
      scope,
      tasks,
      next: hasMore ? tasks.at(-1)!.id : null,
      counts,
    };
  }
  private write(scope: Scope, id: string, next: HumanTask) {
    this.db
      .prepare("UPDATE niaro_human_task SET value=? WHERE owner=? AND id=?")
      .run(JSON.stringify(HumanTaskSchema.parse(next)), owner(scope), id);
  }
  /** The assistant closes an open item it saw resolved; it always says why. */
  close(scope: Scope, id: string, reason: string) {
    const task = this.get(scope, id);
    if (task.status !== "open")
      throw new IdentityError(409, "human_task_transition_invalid");
    const at = new Date().toISOString();
    const next = HumanTaskSchema.parse({
      ...task,
      status: "done",
      resolution: { by: "agent", reason, at },
      revision: task.revision + 1,
      updatedAt: at,
    });
    this.write(scope, id, next);
    return next;
  }
  command(scope: Scope, id: string, raw: HumanTaskCommand) {
    const input = HumanTaskCommandSchema.parse(raw);
    this.get(scope, id);
    const digest = hash({ id, input });
    const old = this.db
      .prepare(
        "SELECT digest,value FROM niaro_human_task_receipt WHERE owner=? AND (command_id=? OR idem=?)",
      )
      .all(owner(scope), input.commandId, input.idempotencyKey);
    if (old.length) {
      if (old.length !== 1 || old[0]!.digest !== digest)
        throw new IdentityError(409, "human_task_conflict");
      return HumanTaskSchema.parse(JSON.parse(String(old[0]!.value)));
    }
    const task = this.get(scope, id);
    if (task.revision !== input.expectedRevision)
      throw new IdentityError(409, "human_task_revision_conflict");
    const status = humanTaskTransition(task.status, input.decision);
    if (!status) throw new IdentityError(409, "human_task_transition_invalid");
    const at = new Date().toISOString();
    const next = HumanTaskSchema.parse({
      ...task,
      status,
      resolution: status === "open" ? null : { by: "user", reason: "", at },
      revision: task.revision + 1,
      updatedAt: at,
    });
    this.db.exec("SAVEPOINT human_task_command");
    try {
      this.write(scope, id, next);
      this.db
        .prepare("INSERT INTO niaro_human_task_receipt VALUES (?,?,?,?,?,?)")
        .run(
          owner(scope),
          input.commandId,
          input.idempotencyKey,
          id,
          digest,
          JSON.stringify(next),
        );
      this.db.exec("RELEASE human_task_command");
      return next;
    } catch (e) {
      this.db.exec(
        "ROLLBACK TO human_task_command; RELEASE human_task_command",
      );
      throw e;
    }
  }
  deleteMeeting(scope: Scope, id: string) {
    this.db
      .prepare(
        "DELETE FROM niaro_human_task_receipt WHERE owner=? AND task_id IN (SELECT id FROM niaro_human_task WHERE owner=? AND meeting_id=?)",
      )
      .run(owner(scope), owner(scope), id);
    this.db
      .prepare("DELETE FROM niaro_human_task WHERE owner=? AND meeting_id=?")
      .run(owner(scope), id);
  }
}
