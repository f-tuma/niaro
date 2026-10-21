import type { DatabaseSync } from "node:sqlite";
import type { DecisionRouter } from "../fixture-server/decision";
import type { Transcriber } from "../fixture-server/voice";
import {
  AIProfileSchema,
  AISelectionSchema,
  WorkspaceAISchema,
  type AISelection,
} from "../../packages/protocol/workspace-ai";
import { IdentityError } from "./error";

type Profile<T> = {
  id: string;
  label: string;
  provider: string;
  adapter: T;
};
export type AIProfiles = {
  models: Profile<DecisionRouter>[];
  voices: Profile<Transcriber>[];
};
function describe(profile: Profile<object>) {
  const adapter = profile.adapter as {
    adminInfo?: { model?: string; expiresAt?: string };
    available?: () => boolean;
  };
  const expiresAt = adapter.adminInfo?.expiresAt;
  return AIProfileSchema.parse({
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: adapter.adminInfo?.model,
    expiresAt,
    available:
      (!expiresAt || Date.parse(expiresAt) > Date.now()) &&
      (adapter.available?.() ?? true),
  });
}

/** Identity queue only. New workspaces start disabled; catalogs contain operator-owned adapters. */
export class WorkspaceAIStore {
  private profiles: AIProfiles = { models: [], voices: [] };
  private attached = false;
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_ai (
      workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, model_id TEXT, voice_id TEXT
    ) STRICT;`);
  }
  attach(profiles: AIProfiles) {
    if (this.attached) throw Error("AI profiles already attached");
    // Bootstrap only. Runtime changes to the catalog require a server restart.
    for (const list of [profiles.models, profiles.voices]) {
      if (
        list.length > 13 ||
        new Set(list.map((p) => p.id)).size !== list.length
      )
        throw Error("Invalid AI profile catalog");
      list.forEach(describe);
    }
    this.profiles = {
      models: [...profiles.models],
      voices: [...profiles.voices],
    };
    this.attached = true;
  }
  read(workspaceId: string) {
    const row = this.db
      .prepare("SELECT * FROM agent_workspace_ai WHERE workspace_id=?")
      .get(workspaceId);
    return {
      revision: Number(row?.revision ?? 0),
      selection: AISelectionSchema.parse({
        modelId: row?.model_id ?? null,
        voiceId: row?.voice_id ?? null,
      }),
    };
  }
  inventory(organizationId: string, workspaceId: string) {
    return WorkspaceAISchema.parse({
      profile: "agent-workspace-ai/1",
      organizationId,
      workspaceId,
      ...this.read(workspaceId),
      models: this.profiles.models.map(describe),
      voices: this.profiles.voices.map(describe),
    });
  }
  resolve(selection: AISelection) {
    const model = this.profiles.models.find((p) => p.id === selection.modelId);
    const voice = this.profiles.voices.find((p) => p.id === selection.voiceId);
    return {
      model: model && describe(model).available ? model.adapter : undefined,
      transcriber:
        voice && describe(voice).available ? voice.adapter : undefined,
    };
  }
  update(workspaceId: string, revision: number, selection: AISelection) {
    const current = this.read(workspaceId);
    if (current.revision !== revision)
      throw new IdentityError(409, "ai_conflict");
    const available = this.resolve(selection);
    if (
      (selection.modelId && !available.model) ||
      (selection.voiceId && !available.transcriber)
    )
      throw new IdentityError(400, "ai_profile_unavailable");
    this.db
      .prepare(
        `INSERT INTO agent_workspace_ai VALUES (?,?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,model_id=excluded.model_id,voice_id=excluded.voice_id`,
      )
      .run(workspaceId, revision + 1, selection.modelId, selection.voiceId);
    return current;
  }
}
