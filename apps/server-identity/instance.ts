import type { DatabaseSync } from "node:sqlite";
import { operatorLog } from "../fixture-server/operator-log";

/**
 * The instance organization: the one whose owners manage what affects the
 * whole server (server settings, plugin code). Recorded once, never changed.
 */
export class InstanceStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_instance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      organization_id TEXT NOT NULL REFERENCES organization(id),
      recorded_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('setup', 'backfill'))
    ) STRICT;`);
  }
  /** Insert-only: a second record is ignored. */
  record(organizationId: string, source: "setup" | "backfill") {
    const { changes } = this.db
      .prepare(
        "INSERT INTO agent_instance VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(organizationId, Date.now(), source);
    if (changes)
      operatorLog("instance_organization_recorded", { organizationId, source });
  }
  /** Servers from earlier versions adopt their earliest-created organization (ties by id). */
  backfill() {
    if (this.db.prepare("SELECT 1 FROM agent_instance").get()) return;
    // Better Auth may store createdAt as ISO text or epoch, so compare in JS.
    const time = (value: unknown) => {
      const n =
        typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : value;
      const t = new Date(n as string | number).getTime();
      return Number.isNaN(t) ? Infinity : t;
    };
    const [first] = this.db
      .prepare('SELECT id, "createdAt" FROM organization')
      .all()
      .map((row) => ({ id: String(row.id), at: time(row.createdAt) }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (first) this.record(first.id, "backfill");
  }
  organizationId(): string | undefined {
    this.backfill();
    const row = this.db
      .prepare("SELECT organization_id FROM agent_instance")
      .get();
    return row ? String(row.organization_id) : undefined;
  }
  /** Re-read on every call: authority is never cached. */
  isOwner(userId: string) {
    const organizationId = this.organizationId();
    return (
      !!organizationId &&
      !!this.db
        .prepare(
          `SELECT 1 FROM member WHERE "userId"=? AND "organizationId"=? AND role='owner'`,
        )
        .get(userId, organizationId)
    );
  }
}
