import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "../../packages/protocol";
import { z } from "zod";
import {
  OUTPUT_VOICE_PROFILE,
  OutputVoiceChoiceSchema,
  OutputVoiceSnapshotSchema,
  OutputVoiceUpdateSchema,
  type OutputVoiceSnapshot,
  type OutputVoiceUpdate,
} from "../../packages/protocol/output-voice";
import {
  outputVoiceCatalogue,
  speechVoiceCompatibility,
  voiceDigest,
  type OutputVoiceActor,
  type SpeechVoiceRoute,
} from "../server-integrations/speech-voices";
import { IdentityError } from "./error";

const storedChoice = z.strictObject({
  version: z.literal(1),
  choice: OutputVoiceChoiceSchema,
});
const storedBinding = z.strictObject({
  version: z.literal(1),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  voice: z.string().min(1).max(200),
});
type Row = {
  revision: number;
  choice_json: string;
  saved_label: string;
  binding_json: string | null;
  last_request_id: string;
  last_request_digest: string;
};

/** Synchronous: callers hold the identity queue; every operation rechecks membership. */
export class OutputVoiceStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_output_voice_route_epoch (
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      binding_digest TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=0),
      PRIMARY KEY(organization_id,workspace_id)
    ) STRICT;`);
  }
  private initializePersonal() {
    // Catalog-only runtimes need epoch tracking, but may not host identity users.
    // Install the additive personal table only when the personal capability is used.
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_personal_output_voice (
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision>=0), choice_json TEXT NOT NULL,
      saved_label TEXT NOT NULL, binding_json TEXT,
      last_request_id TEXT NOT NULL, last_request_digest TEXT NOT NULL,
      last_write_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(organization_id,workspace_id,user_id)
    ) STRICT;`);
  }
  private member(actor: OutputVoiceActor, scope: Scope) {
    if (
      scope.userId !== actor.userId ||
      scope.workspaceId !== actor.workspaceId
    )
      throw new IdentityError(403, "identity_forbidden");
    const member = this.db
      .prepare(
        `SELECT m.id,m.role FROM member m
      JOIN agent_workspace w ON w.organization_id=m."organizationId"
      WHERE m."organizationId"=? AND m."userId"=? AND w.id=?`,
      )
      .get(actor.organizationId, actor.userId, actor.workspaceId);
    if (
      !member ||
      !["owner", "admin", "member"].includes(String(member.role)) ||
      (member.role === "member" &&
        !this.db
          .prepare(
            "SELECT 1 FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
          )
          .get(actor.workspaceId, String(member.id)))
    )
      throw new IdentityError(403, "identity_forbidden");
    return String(member.id);
  }
  private row(actor: OutputVoiceActor) {
    this.initializePersonal();
    return this.db
      .prepare(
        `SELECT * FROM agent_personal_output_voice
      WHERE organization_id=? AND workspace_id=? AND user_id=?`,
      )
      .get(actor.organizationId, actor.workspaceId, actor.userId) as
      | Row
      | undefined;
  }
  /** Called before and after relevant successful catalog commands, as well as lazy reads. */
  observeRoute(
    organizationId: string,
    workspaceId: string,
    route: SpeechVoiceRoute | null,
  ) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace WHERE id=? AND organization_id=?",
        )
        .get(workspaceId, organizationId)
    )
      throw new IdentityError(403, "identity_forbidden");
    const digest = voiceDigest(speechVoiceCompatibility(route));
    const row = this.db
      .prepare(
        `SELECT binding_digest,epoch FROM agent_output_voice_route_epoch
      WHERE organization_id=? AND workspace_id=?`,
      )
      .get(organizationId, workspaceId);
    if (!row) {
      this.db
        .prepare("INSERT INTO agent_output_voice_route_epoch VALUES (?,?,?,0)")
        .run(organizationId, workspaceId, digest);
      return 0;
    }
    const epoch = Number(row.epoch);
    if (row.binding_digest === digest) return epoch;
    if (!Number.isSafeInteger(epoch) || epoch >= Number.MAX_SAFE_INTEGER)
      throw new IdentityError(409, "output_voice_catalogue_changed");
    this.db
      .prepare(
        `UPDATE agent_output_voice_route_epoch SET binding_digest=?,epoch=?
      WHERE organization_id=? AND workspace_id=?`,
      )
      .run(digest, epoch + 1, organizationId, workspaceId);
    return epoch + 1;
  }
  private intent(row: Row | undefined): OutputVoiceSnapshot["saved"] {
    if (!row) return null;
    try {
      const { choice } = storedChoice.parse(JSON.parse(row.choice_json));
      return OutputVoiceSnapshotSchema.shape.saved.parse({
        choice,
        label: row.saved_label,
      });
    } catch {
      return null;
    }
  }
  resolve(
    actor: OutputVoiceActor,
    scope: Scope,
    route: SpeechVoiceRoute | null,
  ) {
    this.member(actor, scope);
    const epoch = this.observeRoute(
      actor.organizationId,
      actor.workspaceId,
      route,
    );
    const catalogue = outputVoiceCatalogue(actor, route, epoch);
    const row = this.row(actor);
    const saved = this.intent(row);
    let selected: (typeof catalogue.options)[number] | undefined;
    if (saved?.choice.kind === "catalogue" && row?.binding_json) {
      try {
        const binding = storedBinding.parse(JSON.parse(row.binding_json));
        const optionId = saved.choice.optionId;
        selected = catalogue.options.find(
          (option) =>
            binding.identity === catalogue.identity &&
            option.optionId === optionId &&
            binding.voice === option.voice,
        );
      } catch {
        /* Corrupt or old data falls back without disabling chat. */
      }
    }
    const snapshot = OutputVoiceSnapshotSchema.parse({
      profile: OUTPUT_VOICE_PROFILE,
      scope,
      revision:
        row && Number.isSafeInteger(row.revision) && row.revision >= 0
          ? row.revision
          : 0,
      catalogueRevision: catalogue.catalogueRevision,
      availability: !route
        ? "speech-unavailable"
        : catalogue.options.length
          ? "selectable"
          : "server-default-only",
      route: route
        ? {
            identity: catalogue.identity,
            model: route.model.model,
            method: route.method,
          }
        : null,
      serverDefault: route ? { label: catalogue.defaultLabel } : null,
      options: catalogue.options.map(({ optionId, label }) => ({
        optionId,
        label,
      })),
      saved,
      effective: !route
        ? {
            choice: { kind: "server-default" },
            label: "",
            reason: "speech-unavailable",
          }
        : selected
          ? {
              choice: { kind: "catalogue", optionId: selected.optionId },
              label: selected.label,
              reason: "selected",
            }
          : {
              choice: { kind: "server-default" },
              label: catalogue.defaultLabel,
              reason:
                row && (!saved || saved.choice.kind === "catalogue")
                  ? "saved-choice-unavailable"
                  : "server-default",
            },
    });
    return {
      snapshot,
      voice: selected?.voice ?? route?.voice,
      epoch,
      identity: catalogue.identity,
    };
  }
  read(actor: OutputVoiceActor, scope: Scope, route: SpeechVoiceRoute | null) {
    return this.resolve(actor, scope, route).snapshot;
  }
  save(
    actor: OutputVoiceActor,
    scope: Scope,
    route: SpeechVoiceRoute | null,
    input: OutputVoiceUpdate,
  ) {
    const parsed = OutputVoiceUpdateSchema.safeParse(input);
    if (!parsed.success) throw new IdentityError(400, "invalid_payload");
    const update = parsed.data;
    const memberId = this.member(actor, scope);
    // Fixed field order makes replay independent of JSON property ordering.
    const digest = voiceDigest([
      update.profile,
      update.requestId,
      update.expectedRevision,
      update.catalogueRevision,
      update.choice.kind,
      update.choice.kind === "catalogue" ? update.choice.optionId : null,
    ]);
    this.db.exec("SAVEPOINT output_voice_save");
    try {
      const previous = this.row(actor);
      if (previous?.last_request_id === update.requestId) {
        if (previous.last_request_digest !== digest)
          throw new IdentityError(409, "output_voice_conflict");
        const snapshot = this.read(actor, scope, route);
        this.db.exec("RELEASE output_voice_save");
        return snapshot;
      }
      const current = this.read(actor, scope, route);
      if (current.catalogueRevision !== update.catalogueRevision)
        throw new IdentityError(409, "output_voice_catalogue_changed");
      if (current.revision !== update.expectedRevision)
        throw new IdentityError(409, "output_voice_conflict");
      const catalogue = outputVoiceCatalogue(
        actor,
        route,
        this.observeRoute(actor.organizationId, actor.workspaceId, route),
      );
      const optionId =
        update.choice.kind === "catalogue" ? update.choice.optionId : null;
      const option = catalogue.options.find(
        (option) => option.optionId === optionId,
      );
      if (update.choice.kind === "catalogue" && !option)
        throw new IdentityError(422, "output_voice_choice_unavailable");
      // An unreadable existing row has no comparable intent. Explicit Reset
      // must replace it; only absence or a valid default can already follow default.
      const before =
        current.saved?.choice ?? (previous ? null : { kind: "server-default" });
      if (
        before !== null &&
        JSON.stringify(before) === JSON.stringify(update.choice)
      ) {
        this.db.exec("RELEASE output_voice_save");
        return current;
      }
      if (current.revision === Number.MAX_SAFE_INTEGER)
        throw new IdentityError(409, "output_voice_conflict");
      const revision = current.revision + 1;
      this.db
        .prepare(
          `INSERT INTO agent_personal_output_voice VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(organization_id,workspace_id,user_id) DO UPDATE SET member_id=excluded.member_id,
        revision=excluded.revision,choice_json=excluded.choice_json,saved_label=excluded.saved_label,
        binding_json=excluded.binding_json,last_request_id=excluded.last_request_id,
        last_request_digest=excluded.last_request_digest,last_write_revision=excluded.last_write_revision,updated_at=excluded.updated_at`,
        )
        .run(
          actor.organizationId,
          actor.workspaceId,
          actor.userId,
          memberId,
          revision,
          JSON.stringify({ version: 1, choice: update.choice }),
          option?.label ?? "",
          option
            ? JSON.stringify({
                version: 1,
                identity: catalogue.identity,
                voice: option.voice,
              })
            : null,
          update.requestId,
          digest,
          revision,
          Date.now(),
        );
      const snapshot = this.read(actor, scope, route);
      this.db.exec("RELEASE output_voice_save");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK TO output_voice_save; RELEASE output_voice_save");
      throw error;
    }
  }
}
