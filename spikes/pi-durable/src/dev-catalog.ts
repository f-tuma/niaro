/**
 * Reads the OpenRouter provider and the chat role's model from the dev
 * identity database, read-only, and unseals the provider key in-process.
 * Mirrors what apps/server-identity/service-catalog.ts does (HKDF of the
 * identity secret, AES-256-GCM with [id, scope] as AAD); written here so the
 * spike never opens the catalog store, whose constructor writes to the DB.
 * The key is returned to the caller and never printed.
 */
import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NiaroProviderConfig } from "./niaro-provider.ts";

type Row = { id: string; scope_id: string; kind: string; data: string; secret: string | null };

export function devIdentityDirectory(repoRoot: string): string {
  // The dev profile (.servers/current.json) names the identity directory relative to .servers/.
  const profile = JSON.parse(readFileSync(join(repoRoot, ".servers/current.json"), "utf8"));
  return resolve(join(repoRoot, ".servers"), profile.administration.identity.directory);
}

function unseal(key: Buffer, row: Row): string {
  if (!row.secret) return "";
  const [iv, tag, data] = row.secret.split(".").map((v) => Buffer.from(v, "base64url"));
  if (!iv || !tag || !data) throw Error("Invalid credential");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify([row.id, row.scope_id])));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export type DevChoice = {
  provider: NiaroProviderConfig;
  chatCatalogId: string;
  organizationId: string;
  notes: string[];
};

export function loadDevOpenRouter(repoRoot: string): DevChoice {
  const dir = devIdentityDirectory(repoRoot);
  const secret = readFileSync(join(dir, "secret"), "utf8");
  const key = Buffer.from(hkdfSync("sha256", secret, "agent-server", "service-catalog/v1", 32));
  const db = new DatabaseSync(join(dir, "identity.sqlite"), { readOnly: true });
  try {
    const providers = db.prepare("SELECT * FROM agent_catalog WHERE kind='provider' ORDER BY id").all() as Row[];
    const row = providers.find((p) => {
      const d = JSON.parse(p.data);
      return d.enabled && d.dialect === "openrouter" && p.secret;
    });
    if (!row) throw Error("No enabled OpenRouter provider with a key in the dev catalog");
    const data = JSON.parse(row.data);
    const org = row.scope_id;
    const policyRow = db.prepare("SELECT data FROM agent_model_policy WHERE organization_id=?").get(org) as
      | { data: string }
      | undefined;
    const policy = policyRow ? JSON.parse(policyRow.data) : { roles: {} };
    const modelRows = (db.prepare("SELECT * FROM agent_catalog WHERE scope_id=? AND kind='model'").all(org) as Row[])
      .map((r) => ({ id: r.id, ...JSON.parse(r.data) }))
      .filter((m) => m.providerId === row.id);
    const usable = (m: any) => m.enabled && m.tools && (m.kind ?? "chat") === "chat" && !m.audioOutput;
    const notes: string[] = [];
    // The chat role's primary model, if it is enabled and tool-capable; this is how Niaro picks it.
    let chat = modelRows.find((m) => m.id === policy.roles?.chat?.models?.[0] && usable(m));
    if (chat) notes.push("model chosen by the organization's role policy: roles.chat.models[0]");
    else {
      chat = modelRows.find(usable);
      notes.push("chat role has no usable model; fell back to the first enabled tool-capable chat model");
    }
    if (!chat) throw Error("No enabled tool-capable chat model on the OpenRouter provider");
    return {
      organizationId: org,
      chatCatalogId: chat.id,
      notes,
      provider: {
        id: row.id,
        name: data.name,
        url: data.url,
        // Catalog rows written before auth existed default to bearer, as the presets do.
        auth: data.auth ?? { type: "bearer" },
        dialect: data.dialect,
        key: unseal(key, row),
        models: modelRows.filter(usable).map((m) => ({
          catalogId: m.id,
          model: m.model,
          tools: m.tools,
          maxTokens: 400,
        })),
      },
    };
  } finally {
    db.close();
  }
}
