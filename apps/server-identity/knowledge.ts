import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndex,
} from "@niaro/server-agent/knowledge-index";
import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_PROFILE,
  KnowledgeSettings,
  defaultKnowledgeSettings,
  type KnowledgeAdminViewValue,
  type KnowledgeChunkingValue,
  type KnowledgeSettingsValue,
  type KnowledgeSourceValue,
  type KnowledgeStatusValue,
} from "../../packages/protocol/knowledge";
import {
  embedTexts,
  embeddingBatches,
  type EmbeddingSelection,
} from "../server-integrations/embeddings";
import type { IntegrationTransport } from "../server-integrations/transport";
import type { NiaroModelSelection } from "../server-integrations/mastra-model";
import { IdentityError } from "./error";
import {
  budgetedInferenceTransport,
  type InferenceBudgetStore,
} from "./inference-budget";
import { operatorLog } from "../fixture-server/operator-log";

/** One file a person sent in a chat, as the attachment store keeps it. */
export type KnowledgeFile = {
  contentId: string;
  userId: string;
  name: string;
  sha256: string;
};
/**
 * The chat's attached files, provided by the attachment workflow: listed
 * and checked synchronously in its own store, read (converted to text)
 * asynchronously. Without it, files are neither indexed nor found.
 */
export type KnowledgeFilePort = {
  list(workspaceId: string): KnowledgeFile[];
  /** Whether the file is still the person's own and available to them. */
  available(workspaceId: string, userId: string, contentId: string): boolean;
  read(file: KnowledgeFile, signal: AbortSignal): Promise<string | undefined>;
};
export type KnowledgeEmbedding = EmbeddingSelection & {
  model: EmbeddingSelection["model"] & { name: string };
};
export type KnowledgeTarget = {
  organizationId: string;
  workspaceId: string;
  userId: string;
};
/**
 * What knowledge needs from the identity server. Synchronous members run
 * inside its queue (`serial`); every one re-reads current state.
 */
export type KnowledgeDeps = {
  store: KnowledgeStore;
  index: () => Promise<KnowledgeIndex>;
  serial: <T>(fn: () => T | Promise<T>) => Promise<T>;
  files: () => KnowledgeFilePort | undefined;
  /** The embedding role's model now; undefined while the role is off. */
  embedding(
    organizationId: string,
    workspaceId: string,
  ): KnowledgeEmbedding | undefined;
  /**
   * One embedding request for `target` under the root run `runId`,
   * budgeted in the inference ledger and counted against the provider's
   * daily limit before dispatch; `check` re-validates the person first.
   */
  embed(input: {
    target: KnowledgeTarget;
    runId: string;
    selected: KnowledgeEmbedding;
    texts: string[];
    signal: AbortSignal;
    check: () => void;
  }): Promise<Float32Array[]>;
  /** Reads one source as `target`'s person through the ordinary catalog. */
  readSource(input: {
    target: KnowledgeTarget;
    source: KnowledgeSourceValue;
    signal: AbortSignal;
  }): Promise<{ name: string; text: string }>;
  /** Shared read actions that need no input, by service. */
  candidates(
    organizationId: string,
    workspaceId: string,
  ): KnowledgeAdminViewValue["candidates"];
  /** Whether the person may read the source's action now (service, grant). */
  sourceVisible(target: KnowledgeTarget, source: KnowledgeSourceValue): boolean;
  /** Throws unless the person is still a member of the workspace. */
  member(target: KnowledgeTarget): void;
  /** Whether attached files are read at all (a converter runs). */
  filesReadable(): boolean;
  now?: () => number;
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const knowledgeDocumentId = (workspaceId: string, sourceKey: string) =>
  sha(JSON.stringify([workspaceId, sourceKey])).slice(0, 32);
/** Stable across rebuilds of the same text with the same model, so citations survive. */
export const knowledgePassageId = (
  documentId: string,
  contentHash: string,
  modelKey: string,
  ordinal: number,
) =>
  sha(JSON.stringify([documentId, contentHash, modelKey, ordinal])).slice(
    0,
    32,
  );
export const knowledgeModelKey = (selected: EmbeddingSelection) =>
  `${selected.model.id}@${selected.model.revision}`;
const sourceKey = (source: KnowledgeSourceValue) =>
  `service:${source.serviceId}/${source.actionId}`;
const sourceLabel = (source: KnowledgeSourceValue) =>
  `${source.serviceId}/${source.actionId}`;
/** Per-document budget root: an embedding pass is background work of its own. */
export const KNOWLEDGE_INDEX_CAPS = {
  maxTokens: 2_000_000,
  maxCostMicros: 2_000_000,
  maxModelCalls: 200,
};
/**
 * Embedding for indexing: each document is its own budget root in the
 * inference ledger (within the workspace's usage limits and these caps),
 * every request counted against the provider's daily limit and the person
 * re-checked right before it leaves.
 */
export function knowledgeEmbedder(deps: {
  transport: IntegrationTransport;
  catalog: {
    inferenceBudget: InferenceBudgetStore;
    useProvider(orgId: string, id: string, revision: number): unknown;
  };
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
}): KnowledgeDeps["embed"] {
  return (input) => {
    const selected = input.selected as unknown as NiaroModelSelection;
    const transport = budgetedInferenceTransport(
      deps.transport,
      deps.catalog.inferenceBudget,
      input.runId,
      input.target,
      selected,
      "embedding",
      deps.serial,
      async () => input.check(),
      () => 0,
      KNOWLEDGE_INDEX_CAPS,
    );
    return embedTexts(transport, selected, input.texts, input.signal, (start) =>
      deps.serial(async () => {
        input.check();
        deps.catalog.useProvider(
          input.target.organizationId,
          selected.provider.id,
          selected.provider.revision,
        );
        start();
      }),
    );
  };
}
/** Failures that stop the whole pass: every later call would fail the same way. */
const STOPPING = new Set([
  "catalog_provider_limit",
  "catalog_budget_price_required",
  "catalog_model_unavailable",
  "integration_provider_denied",
]);
const errorCode = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "knowledge_failed";
};

/**
 * Cuts text into passages of about `size` characters that end at a
 * paragraph, a line or a sentence when one is near, overlapping by about
 * `overlap` characters so a sentence split between two passages is found
 * in either.
 */
export function chunkText(raw: string, chunking: KnowledgeChunkingValue) {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + chunking.size);
    if (end < text.length) {
      const window = text.slice(start, end);
      const floor = Math.floor(chunking.size * 0.6);
      const cut = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        Math.max(
          window.lastIndexOf(". "),
          window.lastIndexOf("! "),
          window.lastIndexOf("? "),
        ),
        window.lastIndexOf(" "),
      ].find((index) => index >= floor);
      if (cut !== undefined) end = start + cut + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    // Back up by the overlap, to a word boundary, never before the start.
    let next = Math.max(start + 1, end - chunking.overlap);
    const space = text.indexOf(" ", next);
    if (chunking.overlap && space > 0 && space < end) next = space + 1;
    start = next;
  }
  return chunks;
}

/**
 * A service result as text for the index: an MCP result's text parts, a
 * string as it is, anything else as indented `key: value` lines. Bounded.
 */
export function resultText(value: unknown): string {
  const lines: string[] = [];
  let size = 0;
  const push = (line: string) => {
    if (size > KNOWLEDGE_LIMITS.documentChars) return;
    lines.push(line);
    size += line.length + 1;
  };
  const mcp =
    value && typeof value === "object" && "content" in value
      ? (value as { content?: unknown }).content
      : undefined;
  if (
    Array.isArray(mcp) &&
    mcp.every(
      (part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type,
    )
  ) {
    for (const part of mcp as { type: string; text?: unknown }[])
      if (part.type === "text" && typeof part.text === "string") {
        let inner: unknown = part.text;
        try {
          inner = JSON.parse(part.text);
        } catch {
          // Plain text stays text.
        }
        push(typeof inner === "string" ? inner : resultText(inner));
      }
    return lines.join("\n").slice(0, KNOWLEDGE_LIMITS.documentChars);
  }
  const walk = (item: unknown, indent: string, key?: string) => {
    const label = key ? `${indent}${key}: ` : indent;
    if (item === null || item === undefined) return;
    if (typeof item !== "object") {
      push(`${label}${String(item)}`);
      return;
    }
    if (Array.isArray(item)) {
      if (key) push(`${indent}${key}:`);
      for (const entry of item) {
        walk(entry, key ? `${indent}  ` : indent);
        if (!key) push("");
      }
      return;
    }
    if (key) push(`${indent}${key}:`);
    for (const [name, entry] of Object.entries(item))
      walk(entry, key ? `${indent}  ` : indent, name);
  };
  walk(value, "");
  return lines.join("\n").slice(0, KNOWLEDGE_LIMITS.documentChars);
}

type StatusRow = {
  lastSync: string | null;
  errors: KnowledgeStatusValue["errors"];
};
/**
 * The knowledge settings of each workspace and where its index stands
 * (last sync, recent errors). Synchronous, inside the identity queue. The
 * index itself lives in its own libSQL file and is never part of a bundle.
 */
export class KnowledgeStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_knowledge_settings(workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,organization_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),updated_by TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS agent_knowledge_status(workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,last_sync TEXT,errors TEXT NOT NULL CHECK(json_valid(errors))) STRICT;
    `);
  }
  private workspace(organizationId: string, workspaceId: string) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace WHERE id=? AND organization_id=?",
        )
        .get(workspaceId, organizationId)
    )
      throw new IdentityError(404, "identity_not_found");
  }
  read(organizationId: string, workspaceId: string) {
    this.workspace(organizationId, workspaceId);
    const row = this.db
      .prepare(
        "SELECT revision,data,updated_by FROM agent_knowledge_settings WHERE workspace_id=? AND organization_id=?",
      )
      .get(workspaceId, organizationId);
    return {
      revision: Number(row?.revision ?? 0),
      settings: row
        ? KnowledgeSettings.parse(JSON.parse(String(row.data)))
        : defaultKnowledgeSettings(),
      updatedBy: row?.updated_by ? String(row.updated_by) : null,
    };
  }
  write(
    organizationId: string,
    workspaceId: string,
    userId: string,
    revision: number,
    raw: KnowledgeSettingsValue,
  ) {
    const settings = KnowledgeSettings.parse(raw);
    if (this.read(organizationId, workspaceId).revision !== revision)
      throw new IdentityError(409, "knowledge_conflict");
    this.db
      .prepare(
        "INSERT INTO agent_knowledge_settings VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_by=excluded.updated_by",
      )
      .run(
        workspaceId,
        organizationId,
        revision + 1,
        JSON.stringify(settings),
        userId,
      );
    return this.read(organizationId, workspaceId);
  }
  status(workspaceId: string): StatusRow {
    const row = this.db
      .prepare(
        "SELECT last_sync,errors FROM agent_knowledge_status WHERE workspace_id=?",
      )
      .get(workspaceId);
    return {
      lastSync: row?.last_sync ? String(row.last_sync) : null,
      errors: row ? JSON.parse(String(row.errors)) : [],
    };
  }
  recordSync(
    workspaceId: string,
    at: string,
    errors: KnowledgeStatusValue["errors"],
    keepEarlier: boolean,
  ) {
    const earlier = keepEarlier ? this.status(workspaceId).errors : [];
    const kept = [...errors, ...earlier].slice(0, KNOWLEDGE_LIMITS.errors);
    this.db
      .prepare(
        "INSERT INTO agent_knowledge_status VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET last_sync=excluded.last_sync,errors=excluded.errors",
      )
      .run(workspaceId, at, JSON.stringify(kept));
  }
}

type Progress = { done: number; total: number };
type IndexInput = {
  sourceKey: string;
  kind: "file" | "service";
  name: string;
  ownerUserId: string | null;
  serviceId: string | null;
  actionId: string | null;
  /** What decides whether the stored passages are current. */
  contentHash: string;
  text: () => Promise<string | undefined>;
  /** Reads what the name and the hash depend on first (a service source). */
  prepare?: () => Promise<void>;
};

/**
 * Workspace knowledge (NIAR-298): indexing on change and on request, one
 * pass at a time per workspace, and search re-checked against the asker's
 * current identity and access before anything reaches a model.
 */
export class Knowledge {
  private lanes = new Map<string, Promise<void>>();
  private pending = new Map<string, number>();
  private progress = new Map<string, Progress>();
  private readonly abort = new AbortController();
  constructor(private readonly deps: KnowledgeDeps) {}
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  /** Runs work after the workspace's earlier passes, never two at once. */
  private enqueue(workspaceId: string, task: () => Promise<void>) {
    this.pending.set(workspaceId, (this.pending.get(workspaceId) ?? 0) + 1);
    const previous = this.lanes.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .then(() => (this.abort.signal.aborted ? undefined : task()))
      .catch((error: unknown) => {
        operatorLog(
          "knowledge_sync",
          { workspace: workspaceId, error: errorCode(error) },
          "warn",
        );
      })
      .finally(() => {
        const left = (this.pending.get(workspaceId) ?? 1) - 1;
        if (left) this.pending.set(workspaceId, left);
        else {
          this.pending.delete(workspaceId);
          this.progress.delete(workspaceId);
          if (this.lanes.get(workspaceId) === next)
            this.lanes.delete(workspaceId);
        }
      });
    this.lanes.set(workspaceId, next);
    return next;
  }
  /** Settles once every queued pass has finished (tests, shutdown). */
  async idle() {
    while (this.lanes.size) await Promise.all([...this.lanes.values()]);
  }
  async close() {
    this.abort.abort();
    await this.idle();
  }

  /** The administrator's view: settings, where the index stands, candidates. */
  async view(
    organizationId: string,
    workspaceId: string,
  ): Promise<KnowledgeAdminViewValue> {
    const current = await this.deps.serial(() => ({
      stored: this.deps.store.read(organizationId, workspaceId),
      status: this.deps.store.status(workspaceId),
      selected: this.selection(organizationId, workspaceId),
      candidates: this.deps.candidates(organizationId, workspaceId),
      filesReadable: this.deps.filesReadable(),
    }));
    const counts = await (
      await this.deps.index()
    ).counts(
      workspaceId,
      current.selected ? knowledgeModelKey(current.selected) : null,
    );
    const progress = this.progress.get(workspaceId) ?? null;
    return {
      profile: KNOWLEDGE_PROFILE,
      organizationId,
      workspaceId,
      revision: current.stored.revision,
      settings: current.stored.settings,
      status: {
        state: !current.selected
          ? "off"
          : this.pending.has(workspaceId)
            ? "running"
            : "idle",
        model: current.selected?.model.name.slice(0, 160) ?? null,
        ...counts,
        lastSync: current.status.lastSync,
        progress,
        errors: current.status.errors,
      },
      candidates: current.candidates,
      filesReadable: current.filesReadable,
    };
  }
  private selection(organizationId: string, workspaceId: string) {
    try {
      return this.deps.embedding(organizationId, workspaceId);
    } catch {
      // A removed or disabled model: no index until the role works again.
      return undefined;
    }
  }
  /**
   * Saves what the workspace indexes: only shared read actions that need
   * no input may be sources. The index follows in the background.
   */
  async save(
    actor: KnowledgeTarget,
    revision: number,
    settings: KnowledgeSettingsValue,
  ) {
    const saved = await this.deps.serial(() => {
      const allowed = new Set(
        this.deps
          .candidates(actor.organizationId, actor.workspaceId)
          .flatMap((service) =>
            service.actions.map(
              (action) => `${service.serviceId}/${action.id}`,
            ),
          ),
      );
      if (settings.sources.some((source) => !allowed.has(sourceLabel(source))))
        throw new IdentityError(409, "knowledge_source_unavailable");
      return this.deps.store.write(
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        revision,
        settings,
      );
    });
    void this.sync(actor, false);
    return saved;
  }
  /** Drops the workspace's index and builds it again, in the background. */
  rebuild(actor: KnowledgeTarget) {
    return this.sync(actor, true);
  }
  /**
   * One pass over the workspace's sources: files people sent (indexed for
   * their sender, under their own budget root) and the selected read
   * actions (read as `actor`). Unchanged documents are skipped, removed
   * ones dropped. Progress and errors go to the status.
   */
  sync(actor: KnowledgeTarget, clear: boolean) {
    const { organizationId, workspaceId } = actor;
    return this.enqueue(workspaceId, async () => {
      const signal = this.abort.signal;
      const prepared = await this.deps.serial(() => {
        this.deps.member(actor);
        const selected = this.selection(organizationId, workspaceId);
        const { settings } = this.deps.store.read(organizationId, workspaceId);
        const port = this.deps.files();
        return {
          selected,
          settings,
          // A file of someone who left the workspace is no longer indexed.
          files: (settings.files && port ? port.list(workspaceId) : []).filter(
            (file) => {
              try {
                this.deps.member({ ...actor, userId: file.userId });
                return true;
              } catch {
                return false;
              }
            },
          ),
          sources: settings.sources.filter((source) =>
            this.deps.sourceVisible(actor, source),
          ),
        };
      });
      const index = await this.deps.index();
      if (clear) await index.clear(workspaceId);
      const { selected, settings } = prepared;
      if (!selected) {
        // Off: nothing is embedded and nothing is searched.
        await this.deps.serial(() =>
          this.deps.store.recordSync(
            workspaceId,
            new Date(this.now()).toISOString(),
            [],
            false,
          ),
        );
        return;
      }
      const chunking = JSON.stringify(settings.chunking);
      const items: { target: KnowledgeTarget; input: IndexInput }[] = [
        ...prepared.files.map((file) => ({
          target: { organizationId, workspaceId, userId: file.userId },
          input: {
            sourceKey: `file:${file.contentId}`,
            kind: "file" as const,
            name: file.name,
            ownerUserId: file.userId,
            serviceId: null,
            actionId: null,
            contentHash: sha(`file\n${file.sha256}\n${chunking}`),
            text: () => this.deps.files()!.read(file, signal),
          },
        })),
        ...prepared.sources.map((source) => {
          let read: { name: string; text: string } | undefined;
          const load = async () =>
            (read ??= await this.deps.readSource({
              target: actor,
              source,
              signal,
            }));
          const input: IndexInput = {
            sourceKey: sourceKey(source),
            kind: "service",
            name: "",
            ownerUserId: null,
            serviceId: source.serviceId,
            actionId: source.actionId,
            contentHash: "",
            text: async () => (await load()).text,
            // A source's content is known only once read; its hash follows.
            prepare: async () => {
              const value = await load();
              input.name = value.name;
              input.contentHash = sha(`service\n${value.text}\n${chunking}`);
            },
          };
          return { target: actor, input };
        }),
      ];
      const progress: Progress = { done: 0, total: items.length };
      this.progress.set(workspaceId, progress);
      const existing = await index.documents(workspaceId);
      const keep = new Set(items.map((item) => item.input.sourceKey));
      await index.remove(
        workspaceId,
        existing
          .filter((document) => !keep.has(document.sourceKey))
          .map((document) => document.id),
      );
      const errors: KnowledgeStatusValue["errors"] = [];
      let stopped = false;
      for (const item of items) {
        if (signal.aborted) return;
        if (stopped) break;
        try {
          await item.input.prepare?.();
          await this.indexDocument(
            item.target,
            selected,
            settings,
            item.input,
            existing,
            signal,
          );
        } catch (error) {
          const code = errorCode(error);
          errors.push({
            source: (item.input.name || item.input.sourceKey).slice(0, 240),
            error: code,
            at: new Date(this.now()).toISOString(),
          });
          if (STOPPING.has(code)) stopped = true;
        }
        progress.done++;
      }
      await this.deps.serial(() =>
        this.deps.store.recordSync(
          workspaceId,
          new Date(this.now()).toISOString(),
          errors,
          false,
        ),
      );
      operatorLog("knowledge_sync", {
        workspace: workspaceId,
        documents: items.length,
        errors: errors.length,
      });
    });
  }
  /**
   * Indexes the files a person just sent, from the text the chat already
   * read, for that person only. Quietly nothing while files or the
   * embedding role are off.
   */
  indexFiles(
    target: KnowledgeTarget,
    files: { contentId: string; name: string; sha256: string; text: string }[],
  ) {
    const { organizationId, workspaceId } = target;
    return this.enqueue(workspaceId, async () => {
      const prepared = await this.deps.serial(() => {
        this.deps.member(target);
        return {
          selected: this.selection(organizationId, workspaceId),
          settings: this.deps.store.read(organizationId, workspaceId).settings,
        };
      });
      if (!prepared.selected || !prepared.settings.files) return;
      const index = await this.deps.index();
      const existing = await index.documents(workspaceId);
      const chunking = JSON.stringify(prepared.settings.chunking);
      const errors: KnowledgeStatusValue["errors"] = [];
      for (const file of files)
        try {
          await this.indexDocument(
            target,
            prepared.selected,
            prepared.settings,
            {
              sourceKey: `file:${file.contentId}`,
              kind: "file",
              name: file.name,
              ownerUserId: target.userId,
              serviceId: null,
              actionId: null,
              contentHash: sha(`file\n${file.sha256}\n${chunking}`),
              text: async () => file.text,
            },
            existing,
            this.abort.signal,
          );
        } catch (error) {
          errors.push({
            source: file.name.slice(0, 240),
            error: errorCode(error),
            at: new Date(this.now()).toISOString(),
          });
        }
      if (errors.length)
        await this.deps.serial(() =>
          this.deps.store.recordSync(
            workspaceId,
            this.deps.store.status(workspaceId).lastSync ??
              new Date(this.now()).toISOString(),
            errors,
            true,
          ),
        );
    });
  }
  private async indexDocument(
    target: KnowledgeTarget,
    selected: KnowledgeEmbedding,
    settings: KnowledgeSettingsValue,
    input: IndexInput,
    existing: KnowledgeDocument[],
    signal: AbortSignal,
  ) {
    const index = await this.deps.index();
    const modelKey = knowledgeModelKey(selected);
    const id = knowledgeDocumentId(target.workspaceId, input.sourceKey);
    const stored = existing.find((document) => document.id === id);
    if (
      stored &&
      stored.contentHash === input.contentHash &&
      stored.modelKey === modelKey &&
      (!input.name || stored.name === input.name)
    )
      return;
    const text = ((await input.text()) ?? "").slice(
      0,
      KNOWLEDGE_LIMITS.documentChars,
    );
    const chunks = chunkText(text, settings.chunking);
    if (!chunks.length) {
      await index.remove(target.workspaceId, stored ? [id] : []);
      throw new IdentityError(422, "knowledge_empty");
    }
    const runId = `knowledge/${target.workspaceId}/${randomUUID()}`;
    const check = () => {
      signal.throwIfAborted();
      this.deps.member(target);
    };
    const vectors: Float32Array[] = [];
    // The source's name leads each passage, so a question about it finds it.
    for (const batch of embeddingBatches(
      chunks.map((chunk) => `${input.name}\n${chunk}`),
    ))
      vectors.push(
        ...(await this.deps.embed({
          target,
          runId,
          selected,
          texts: batch,
          signal,
          check,
        })),
      );
    await index.replace(
      {
        id,
        workspaceId: target.workspaceId,
        sourceKey: input.sourceKey,
        kind: input.kind,
        name: input.name.slice(0, 200),
        ownerUserId: input.ownerUserId,
        serviceId: input.serviceId,
        actionId: input.actionId,
        contentHash: input.contentHash,
        modelKey,
        indexedAt: this.now(),
      },
      chunks.map((chunk, ordinal) => ({
        id: knowledgePassageId(id, input.contentHash, modelKey, ordinal),
        ordinal,
        text: chunk,
        vector: vectors[ordinal]!,
      })),
    );
  }

  /**
   * Whether a passage may reach this person now: the workspace's, still a
   * member, a file still their own and available while files are indexed,
   * a source still selected and readable by them. Fails closed.
   */
  private visible(
    target: KnowledgeTarget,
    settings: KnowledgeSettingsValue,
    hit: KnowledgeHit,
  ) {
    try {
      if (hit.workspaceId !== target.workspaceId) return false;
      if (hit.kind === "file") {
        const contentId = hit.sourceKey.startsWith("file:")
          ? hit.sourceKey.slice("file:".length)
          : "";
        return (
          settings.files &&
          hit.ownerUserId === target.userId &&
          !!contentId &&
          !!this.deps
            .files()
            ?.available(target.workspaceId, target.userId, contentId)
        );
      }
      const source = settings.sources.find(
        (item) =>
          item.serviceId === hit.serviceId && item.actionId === hit.actionId,
      );
      return !!source && this.deps.sourceVisible(target, source);
    } catch {
      return false;
    }
  }
  /** The labels a search may rank by, for this person now. */
  private access(target: KnowledgeTarget) {
    this.deps.member(target);
    const { settings } = this.deps.store.read(
      target.organizationId,
      target.workspaceId,
    );
    return {
      settings,
      sources: settings.sources
        .filter((source) => {
          try {
            return this.deps.sourceVisible(target, source);
          } catch {
            return false;
          }
        })
        .map(sourceLabel),
    };
  }
  /**
   * The passages nearest to `vector` among those the person may see: the
   * query filters by the labels, then every hit is re-checked against the
   * person's current identity and access before it is returned.
   */
  async search(input: {
    target: KnowledgeTarget;
    selected: EmbeddingSelection;
    vector: Float32Array;
    limit: number;
  }) {
    const { target } = input;
    let access: ReturnType<Knowledge["access"]>;
    try {
      access = await this.deps.serial(() => this.access(target));
    } catch {
      // No longer a member: nothing, never an error that says why.
      return [];
    }
    const hits = await (
      await this.deps.index()
    ).search({
      workspaceId: target.workspaceId,
      modelKey: knowledgeModelKey(input.selected),
      vector: input.vector,
      userId: target.userId,
      files: access.settings.files,
      sources: access.sources,
      limit: Math.min(KNOWLEDGE_LIMITS.hitsPerSearch, input.limit),
    });
    return this.deps.serial(() => {
      try {
        this.deps.member(target);
      } catch {
        return [];
      }
      const { settings } = this.deps.store.read(
        target.organizationId,
        target.workspaceId,
      );
      return hits.filter((hit) => this.visible(target, settings, hit));
    });
  }
  /** Passages by id as this person may read them now, for answer receipts. */
  async passages(target: KnowledgeTarget, ids: readonly string[]) {
    if (!ids.length) return new Map<string, KnowledgeHit>();
    const found = await (
      await this.deps.index()
    ).passages(target.workspaceId, ids);
    return this.deps.serial(() => {
      try {
        this.deps.member(target);
      } catch {
        return new Map<string, KnowledgeHit>();
      }
      const { settings } = this.deps.store.read(
        target.organizationId,
        target.workspaceId,
      );
      return new Map(
        found
          .filter((hit) => this.visible(target, settings, hit))
          .map((hit) => [hit.id, hit]),
      );
    });
  }
}
