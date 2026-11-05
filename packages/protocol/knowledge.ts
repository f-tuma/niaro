import { z } from "zod";
import { IdentityId } from "./identity";

/**
 * Workspace knowledge (NIAR-298): a derived, rebuildable index over the
 * files people send in their chats and the read actions an administrator
 * picked as sources. It is never a document store: nothing here is edited,
 * foldered or kept as the record. The embedding model comes from the
 * `embedding` role of the model policy; without one there is no index and
 * no knowledge search.
 */
export const KNOWLEDGE_PROFILE = "agent-knowledge/1" as const;
export const KNOWLEDGE_LIMITS = {
  /** Read actions one workspace may index. */
  sources: 20,
  /** Passages one search returns to the model at most. */
  hitsPerSearch: 8,
  /** Searches one request may make. */
  searchesPerRun: 4,
  /** Characters of a passage shown under an answer. */
  citation: 400,
  /** Characters of one document's text that are indexed. */
  documentChars: 400_000,
  /** Errors the status keeps, newest first. */
  errors: 20,
} as const;

/** How a document's text is cut into passages, in characters. */
export const KnowledgeChunking = z
  .strictObject({
    size: z.number().int().min(300).max(4000).default(1200),
    overlap: z.number().int().min(0).max(1000).default(150),
  })
  .refine(
    (value) => value.overlap < value.size / 2,
    "The overlap must be under half of the passage size",
  );
export type KnowledgeChunkingValue = z.infer<typeof KnowledgeChunking>;

/** One read action whose result is indexed, by its catalog ids. */
export const KnowledgeSource = z.strictObject({
  serviceId: IdentityId,
  actionId: IdentityId,
});
export type KnowledgeSourceValue = z.infer<typeof KnowledgeSource>;

/**
 * What a workspace indexes. Files people send are indexed for their sender
 * only; service sources are off until an administrator picks them.
 */
export const KnowledgeSettings = z
  .strictObject({
    files: z.boolean().default(true),
    sources: z.array(KnowledgeSource).max(KNOWLEDGE_LIMITS.sources).default([]),
    chunking: KnowledgeChunking.default({ size: 1200, overlap: 150 }),
  })
  .refine(
    (value) =>
      new Set(value.sources.map((s) => `${s.serviceId}/${s.actionId}`)).size ===
      value.sources.length,
    "A source appears once",
  );
export type KnowledgeSettingsValue = z.infer<typeof KnowledgeSettings>;
export const defaultKnowledgeSettings = () => KnowledgeSettings.parse({});

const ErrorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/**
 * Where the index stands. `off`: no embedding model; `idle`: up to date as
 * of `lastSync`; `running`: a sync is reading and embedding (`progress`).
 * `stale` passages were embedded with another model and are not searched
 * until a rebuild. Errors name the source and a code, never content.
 */
export const KnowledgeStatus = z.strictObject({
  state: z.enum(["off", "idle", "running"]),
  model: z.string().max(160).nullable(),
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  lastSync: z.iso.datetime().nullable(),
  progress: z
    .strictObject({
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
  errors: z
    .array(
      z.strictObject({
        source: z.string().max(240),
        error: ErrorCode,
        at: z.iso.datetime(),
      }),
    )
    .max(KNOWLEDGE_LIMITS.errors),
});
export type KnowledgeStatusValue = z.infer<typeof KnowledgeStatus>;

/** A read action an administrator may pick as a source. */
export const KnowledgeCandidate = z.strictObject({
  serviceId: IdentityId,
  serviceName: z.string().max(100),
  actions: z
    .array(z.strictObject({ id: IdentityId, name: z.string().max(100) }))
    .max(1000),
});

/** `POST /admin/api/identity/knowledge/get`: the settings, status and candidates. */
export const KnowledgeAdminView = z.strictObject({
  profile: z.literal(KNOWLEDGE_PROFILE),
  organizationId: IdentityId,
  workspaceId: IdentityId,
  revision: z.number().int().nonnegative(),
  settings: KnowledgeSettings,
  status: KnowledgeStatus,
  /** Shared read actions that need no input: what may become a source. */
  candidates: z.array(KnowledgeCandidate).max(100),
  /** Whether attached files are read at all (the document converter runs). */
  filesReadable: z.boolean(),
});
export type KnowledgeAdminViewValue = z.infer<typeof KnowledgeAdminView>;

/** `POST /admin/api/identity/knowledge/command`. */
export const KnowledgeCommand = z.discriminatedUnion("type", [
  z.strictObject({
    organizationId: IdentityId,
    workspaceId: IdentityId,
    type: z.literal("save"),
    revision: z.number().int().nonnegative(),
    settings: KnowledgeSettings,
  }),
  /** Drops the workspace's index and builds it again from its sources. */
  z.strictObject({
    organizationId: IdentityId,
    workspaceId: IdentityId,
    type: z.literal("rebuild"),
  }),
]);
export type KnowledgeCommandValue = z.infer<typeof KnowledgeCommand>;
