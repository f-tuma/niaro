import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createHandle,
  descriptor,
  locationId,
  StorageError,
  validateHandle,
  type ObjectHandle,
  type StorageConfig,
} from "./types";
type Row = {
  id: string;
  location_id: string;
  object_key: string;
  owner: string;
  sha256: string;
  size: number;
  state: string;
  mutation: string;
  mutation_id: string | null;
  write_uncertain: number;
};
export class StorageRegistry {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS object_storage_locations(id TEXT PRIMARY KEY, descriptor TEXT NOT NULL CHECK(json_valid(descriptor))) STRICT;
      CREATE TABLE IF NOT EXISTS object_storage_active(slot INTEGER PRIMARY KEY CHECK(slot=1), location_id TEXT NOT NULL REFERENCES object_storage_locations(id)) STRICT;
      CREATE TABLE IF NOT EXISTS object_storage_objects(
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES object_storage_locations(id), object_key TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64), size INTEGER NOT NULL CHECK(size>=0 AND size<=26214400),
        state TEXT NOT NULL CHECK(state IN ('reserved','retained','deleting','deleted')),
        mutation TEXT NOT NULL DEFAULT 'idle' CHECK(mutation IN ('idle','put','delete')), mutation_id TEXT,
        write_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(write_uncertain IN (0,1)),
        CHECK((mutation='idle' AND mutation_id IS NULL) OR (mutation!='idle' AND mutation_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS object_storage_retained ON object_storage_objects(location_id,state);
    `);
  }
  private transaction<T>(run: () => T): T {
    if (this.db.isTransaction) return run();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Only the owning workflow startup calls this, after acquiring the server lock. */
  recoverInterruptedMutations() {
    this.db.exec(
      "UPDATE object_storage_objects SET write_uncertain=1,mutation='idle',mutation_id=NULL WHERE mutation='put'; UPDATE object_storage_objects SET state='deleting',mutation='idle',mutation_id=NULL WHERE mutation='delete';",
    );
  }
  activate(c: StorageConfig) {
    this.transaction(() => {
      const id = locationId(c),
        description = descriptor(c);
      const active = this.db
        .prepare("SELECT location_id FROM object_storage_active WHERE slot=1")
        .get();
      if (active && active.location_id !== id) {
        const retained = this.db
          .prepare(
            "SELECT 1 FROM object_storage_objects WHERE state!='deleted' LIMIT 1",
          )
          .get();
        if (retained) throw new StorageError("migration_required");
      }
      const existing = this.db
        .prepare("SELECT descriptor FROM object_storage_locations WHERE id=?")
        .get(id);
      if (existing && existing.descriptor !== description)
        throw new StorageError("integrity");
      this.db
        .prepare("INSERT OR IGNORE INTO object_storage_locations VALUES (?,?)")
        .run(id, description);
      this.db
        .prepare(
          "INSERT INTO object_storage_active VALUES (1,?) ON CONFLICT(slot) DO UPDATE SET location_id=excluded.location_id",
        )
        .run(id);
    });
  }
  private active(c: StorageConfig) {
    if (
      this.db
        .prepare("SELECT location_id FROM object_storage_active WHERE slot=1")
        .get()?.location_id !== locationId(c)
    )
      throw new StorageError("location_mismatch");
  }
  reserve(
    c: StorageConfig,
    owner: string,
    digest: { sha256: string; size: number },
  ) {
    return this.transaction(() => {
      this.active(c);
      const h = createHandle(c, owner, digest);
      this.db
        .prepare(
          "INSERT INTO object_storage_objects(id,location_id,object_key,owner,sha256,size,state) VALUES (?,?,?,?,?,?,'reserved')",
        )
        .run(h.id, h.locationId, h.key, h.owner, h.sha256, h.size);
      return h;
    });
  }
  private row(c: StorageConfig, h: ObjectHandle): Row {
    validateHandle(c, h);
    const row = this.db
      .prepare("SELECT * FROM object_storage_objects WHERE id=?")
      .get(h.id) as Row | undefined;
    if (
      !row ||
      row.location_id !== h.locationId ||
      row.object_key !== h.key ||
      row.owner !== h.owner ||
      row.sha256 !== h.sha256 ||
      row.size !== h.size
    )
      throw new StorageError("invalid_handle");
    return row;
  }
  check(c: StorageConfig, h: ObjectHandle) {
    const r = this.row(c, h);
    this.active(c);
    if (r.state === "deleted") throw new StorageError("not_found");
    return r;
  }
  begin(
    c: StorageConfig,
    h: ObjectHandle,
    kind: "put" | "delete",
  ): string | null {
    if (this.db.isTransaction) throw new StorageError("busy", true);
    return this.transaction(() => {
      const row = this.row(c, h);
      if (kind === "delete" && row.state === "deleted") return null;
      this.active(c);
      if (row.write_uncertain)
        throw new StorageError("uncertain", false, "unknown");
      if (row.mutation !== "idle") throw new StorageError("busy", true);
      if (
        row.state === "deleted" ||
        (kind === "put" && row.state === "deleting")
      )
        throw new StorageError("conflict");
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE object_storage_objects SET mutation=?,mutation_id=?,state=? WHERE id=?",
        )
        .run(kind, token, kind === "delete" ? "deleting" : row.state, h.id);
      return token;
    });
  }
  finish(
    c: StorageConfig,
    h: ObjectHandle,
    token: string,
    kind: "put" | "delete",
    error?: StorageError,
  ) {
    if (this.db.isTransaction) throw new StorageError("busy", true);
    this.transaction(() => {
      const row = this.row(c, h);
      this.active(c);
      if (
        row.mutation_id !== token ||
        row.mutation !== kind ||
        row.state === "deleted" ||
        (kind === "put" && row.state === "deleting")
      )
        throw new StorageError("conflict");
      const uncertain =
        kind === "put" && error?.outcome === "unknown"
          ? 1
          : row.write_uncertain;
      const state = error ? row.state : kind === "put" ? "retained" : "deleted";
      if (state === "deleted" && uncertain)
        throw new StorageError("uncertain", false, "unknown");
      this.db
        .prepare(
          "UPDATE object_storage_objects SET state=?,mutation='idle',mutation_id=NULL,write_uncertain=? WHERE id=? AND mutation_id=?",
        )
        .run(state, uncertain, h.id, token);
    });
  }
  counts() {
    return this.db
      .prepare(
        "SELECT count(*) AS retained,coalesce(sum(write_uncertain),0) AS uncertainPuts,coalesce(sum(state='deleting'),0) AS deleting FROM object_storage_objects WHERE state!='deleted'",
      )
      .get()!;
  }
}
