import type { DatabaseSync } from "node:sqlite";

export const processOwnerTable = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
  service_id TEXT, revision INTEGER NOT NULL, draft TEXT NOT NULL,
  active_version INTEGER, updated_at TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'service' CHECK(owner_type IN ('service','workspace','user')),
  owner_user_id TEXT,
  CHECK((owner_type='service' AND service_id IS NOT NULL AND owner_user_id IS NULL)
    OR (owner_type='workspace' AND service_id IS NULL AND owner_user_id IS NULL)
    OR (owner_type='user' AND service_id IS NULL AND owner_user_id IS NOT NULL)),
  FOREIGN KEY(id,active_version) REFERENCES agent_service_process_version(process_id,version)
) STRICT`;

/** Startup only, under the identity owner lock. Never rename the referenced old
 * table: that rewrites child FK targets. Copy/drop/rename with FK enforcement
 * temporarily disabled preserves every child row and its original payload.
 * Both earlier shapes migrate to the current one: the original mandatory
 * `service_id` parent (rows become service-owned) and the October 7 owner
 * parent without personal owners (rows keep their owner). */
export function migrateProcessOwners(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(agent_service_process)").all();
  if (!columns.length || columns.some((c) => c.name === "owner_user_id"))
    return;
  const copied =
    "id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at" +
    (columns.some((c) => c.name === "owner_type") ? ",owner_type" : "");
  if (db.isTransaction) throw new Error("process_owner_migration_transaction");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("process_owner_migration_foreign_keys");
  const foreignKeys = Number(
    db.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
  );
  const legacyAlterTable = Number(
    db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table,
  );
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE tbl_name='agent_service_process' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all();
  // External views and child triggers can reference the parent while it is
  // temporarily absent. Keep their SQL unchanged during the replacement rename.
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(processOwnerTable("agent_service_process_owner_migration"));
    db.exec(`INSERT INTO agent_service_process_owner_migration (${copied})
      SELECT ${copied} FROM agent_service_process;
      DROP TABLE agent_service_process;
      ALTER TABLE agent_service_process_owner_migration RENAME TO agent_service_process;`);
    for (const row of indexes) db.exec(String(row.sql));
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("process_owner_migration_foreign_keys");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA legacy_alter_table=${legacyAlterTable ? "ON" : "OFF"};
      PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
  }
}
