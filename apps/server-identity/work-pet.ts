import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  PetSettingsSchema,
  SavePetProfileSchema,
  type PetSettings,
} from "../../packages/protocol/work-pet";
import type { MemoryActor } from "./memory";
import type { MemoryItem } from "../../packages/protocol/memory";
import { IdentityError } from "./error";

export const DEFAULT_PET_SETTINGS: PetSettings = {
  name: "Niaro",
  colour: "#BDB3FA",
  shape: "auto",
  jobTitle: "",
  department: "",
  animate: true,
  showInChat: true,
};
const shapes = {
  work: "cookie",
  projects: "flower",
  tools: "sunny",
  people: "clover",
  style: "burst",
  rhythm: "pill",
} as const;
/** Only current own work observations influence the automatic shape. No provider or inference. */
export function automaticPetShape(items: MemoryItem[]) {
  const sections = new Map<
    keyof typeof shapes,
    { count: number; seen: string }
  >();
  for (const item of items) {
    if (
      item.scope !== "private" ||
      item.origin !== "observed" ||
      item.status !== "active" ||
      item.source?.type !== "observed" ||
      item.source.personal
    )
      continue;
    const previous = sections.get(item.source.section) ?? {
      count: 0,
      seen: "",
    };
    sections.set(item.source.section, {
      count: previous.count + 1,
      seen: previous.seen > item.seenAt! ? previous.seen : item.seenAt!,
    });
  }
  const strongest = [...sections].sort(
    (a, b) =>
      b[1].count - a[1].count ||
      b[1].seen.localeCompare(a[1].seen) ||
      a[0].localeCompare(b[0]),
  )[0];
  return strongest ? shapes[strongest[0]] : "circle";
}
export function petLook(items: MemoryItem[]) {
  return (Object.keys(shapes) as (keyof typeof shapes)[]).map((section) => ({
    section,
    weight: Math.min(
      1,
      Math.sqrt(
        items.filter(
          (item) =>
            item.scope === "private" &&
            item.status === "active" &&
            item.origin === "observed" &&
            item.source?.type === "observed" &&
            !item.source.personal &&
            item.source.section === section,
        ).length,
      ) / Math.sqrt(12),
    ),
  }));
}
export class WorkPetStore {
  constructor(
    private db: DatabaseSync,
    private changed?: (actor: MemoryActor, position: boolean) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_pet (
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id,workspace_id,user_id)) STRICT;
      CREATE TABLE IF NOT EXISTS agent_pet_request (
      organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      PRIMARY KEY(organization_id,workspace_id,user_id,request_id),
      FOREIGN KEY(organization_id,workspace_id,user_id) REFERENCES agent_pet(organization_id,workspace_id,user_id) ON DELETE CASCADE) STRICT;`);
  }
  private key(actor: MemoryActor) {
    return [actor.organizationId, actor.workspaceId, actor.userId];
  }
  read(actor: MemoryActor) {
    const row = this.db
      .prepare(
        "SELECT settings_json,revision FROM agent_pet WHERE organization_id=? AND workspace_id=? AND user_id=?",
      )
      .get(...this.key(actor));
    return row
      ? {
          settings: PetSettingsSchema.parse(
            JSON.parse(String(row.settings_json)),
          ),
          revision: Number(row.revision),
        }
      : { settings: { ...DEFAULT_PET_SETTINGS }, revision: 0 };
  }
  save(actor: MemoryActor, input: unknown) {
    const command = SavePetProfileSchema.parse(input);
    const key = this.key(actor);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    this.db.exec("SAVEPOINT pet_save");
    try {
      const receipt = this.db
        .prepare(
          "SELECT fingerprint FROM agent_pet_request WHERE organization_id=? AND workspace_id=? AND user_id=? AND request_id=?",
        )
        .get(...key, command.requestId);
      if (receipt && receipt.fingerprint !== fingerprint)
        throw new IdentityError(409, "pet_request_conflict");
      if (!receipt) {
        const previous = this.read(actor);
        if (command.revision !== previous.revision)
          throw new IdentityError(409, "pet_conflict");
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO agent_pet VALUES (?,?,?,?,?,?,?) ON CONFLICT(organization_id,workspace_id,user_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`,
          )
          .run(
            ...key,
            JSON.stringify(command.settings),
            previous.revision + 1,
            now,
            now,
          );
        this.db
          .prepare("INSERT INTO agent_pet_request VALUES (?,?,?,?,?)")
          .run(...key, command.requestId, fingerprint);
        this.changed?.(
          actor,
          previous.settings.jobTitle !== command.settings.jobTitle ||
            previous.settings.department !== command.settings.department,
        );
      }
      this.db.exec("RELEASE pet_save");
      return this.read(actor);
    } catch (error) {
      this.db.exec("ROLLBACK TO pet_save; RELEASE pet_save");
      throw error;
    }
  }
}
