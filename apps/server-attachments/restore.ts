import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScopeSchema } from "../../packages/protocol";
import { AttachmentUuidSchema } from "../../packages/protocol/attachments";
import type { ServerConfig } from "../reference-server/config";
import { FixtureStorage } from "../fixture-server/storage";
import { ServiceCatalogStore } from "../server-identity/service-catalog";
import {
  purgeNativeAttachmentGeneration,
  closeNativeCatalogRuntime,
} from "../server-identity/mastra-runtime";
import { loadStorageConfiguration } from "../server-storage/config";
import {
  descriptor,
  locationId,
  StorageError,
  type StorageConfiguration,
} from "../server-storage/types";
import {
  RESTORE_MARKER,
  validateRestoreMarker,
  validateAttachmentManifest,
  validateDeletionEvidence,
  deletionCoverage,
  validRestoreActivation,
  attachmentOwnerLocks,
  attachmentInventory,
} from "../../scripts/backup-common.mjs";
import { loadAttachmentConfiguration } from "./schema";

const SafeCode = z.enum([
  "owner_busy",
  "manifest_missing",
  "manifest_mismatch",
  "identity_mismatch",
  "location_mismatch",
  "object_missing",
  "object_corrupt",
  "storage_unavailable",
  "mutation_unsettled",
  "deletion_gap",
  "reconciliation_conflict",
  "local_failure",
]);
export const AttachmentRestoreResultSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum([
    "verified",
    "activated",
    "already-serving",
    "blocked",
    "failed",
  ]),
  restoreId: AttachmentUuidSchema,
  barrier: z.enum(["unverified", "serving"]),
  verifiedCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  corruptCount: z.number().int().nonnegative(),
  blockedUncertainCount: z.number().int().nonnegative(),
  pendingPurgeCount: z.number().int().nonnegative(),
  deletionGap: z.enum(["unreconciled", "reconciled"]),
  code: SafeCode.nullable(),
});
export type AttachmentRestoreResult = z.infer<
  typeof AttachmentRestoreResultSchema
>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
class Blocked extends Error {
  constructor(readonly code: z.infer<typeof SafeCode>) {
    super(code);
  }
}
function operatorFile(path: string, max: number) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max)
    throw new Blocked("reconciliation_conflict");
  return readFileSync(path, "utf8");
}
export function restoreVerifyArguments(args: string[]) {
  if (args[0] === undefined || args[0].startsWith("--")) throw Error("usage");
  const profile = args[0],
    seen = new Set<string>();
  let reconcile: string | undefined,
    activate = false;
  for (let n = 1; n < args.length; n++) {
    const flag = args[n]!;
    if (seen.has(flag)) throw Error("usage");
    seen.add(flag);
    if (flag === "--activate") activate = true;
    else if (flag === "--reconcile") {
      const value = args[++n];
      if (!value || value.startsWith("--")) throw Error("usage");
      reconcile = value;
    } else throw Error("usage");
  }
  return { profile, reconcile, activate };
}
/** Offline sole owner. No HTTP, IdentityService startup, model, job or registry recovery owner. */
export async function verifyAttachmentRestore(
  config: ServerConfig,
  options: {
    reconcile?: string;
    activate?: boolean;
    now?: () => number;
    checkpoint?: (point: "before_activation" | "after_activation") => void;
    objectStorage?: StorageConfiguration;
  } = {},
): Promise<{ exitCode: number; result: AttachmentRestoreResult }> {
  const now = options.now ?? Date.now;
  let result: AttachmentRestoreResult = {
    version: 1,
    status: "blocked",
    restoreId: "00000000-0000-4000-8000-000000000000",
    barrier: "unverified",
    verifiedCount: 0,
    missingCount: 0,
    corruptCount: 0,
    blockedUncertainCount: 0,
    pendingPurgeCount: 0,
    deletionGap: "unreconciled",
    code: null,
  };
  let storage: FixtureStorage | undefined,
    identity: DatabaseSync | undefined,
    release: (() => void) | undefined;
  let native:
    | { store: ReturnType<typeof ServiceCatalogStore.forAttachmentRestore> }
    | undefined;
  try {
    const candidates = [
      join(config.dataDirectory, RESTORE_MARKER),
      join(dirname(config.dataDirectory), RESTORE_MARKER),
    ].filter((p) => existsSync(p));
    if (candidates.length !== 1) throw new Blocked("identity_mismatch");
    const marker = validateRestoreMarker(
      JSON.parse(operatorFile(candidates[0]!, 4096)),
    );
    result.restoreId = marker.restoreId;
    const root = dirname(candidates[0]!),
      workflowRelative =
        resolve(config.dataDirectory) === resolve(root) ? "." : "workflow";
    if (resolve(root, workflowRelative) !== resolve(config.dataDirectory))
      throw new Blocked("identity_mismatch");
    const identityDirectory = config.administration?.identity?.directory;
    const layout = {
      workflowDirectory: workflowRelative,
      identityDirectory: identityDirectory ? "identity" : null,
    };
    if (
      identityDirectory &&
      resolve(root, "identity") !== resolve(identityDirectory)
    )
      throw new Blocked("identity_mismatch");
    try {
      release = attachmentOwnerLocks(root, layout);
    } catch {
      throw new Blocked("owner_busy");
    }
    const file = join(config.dataDirectory, "workflow.sqlite");
    if (!existsSync(file)) throw new Blocked("manifest_missing");
    const read = new DatabaseSync(file, { readOnly: true });
    let row: Record<string, unknown> | undefined;
    try {
      if (
        !read
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_restore_state'",
          )
          .get()
      )
        throw new Blocked("identity_mismatch");
      row = read
        .prepare("SELECT * FROM attachment_restore_state WHERE slot=1")
        .get();
    } finally {
      read.close();
    }
    if (
      !row ||
      row.restore_id !== marker.restoreId ||
      row.manifest_sha256 !== marker.manifestSha256 ||
      row.recovery_cutoff !== marker.recoveryCutoff
    )
      throw new Blocked("identity_mismatch");
    if (validRestoreActivation(marker, row)) {
      result = AttachmentRestoreResultSchema.parse({
        ...JSON.parse(String(row.last_verification)),
        status: "already-serving",
      });
      return { exitCode: 0, result };
    }
    if (row.state !== "unverified")
      throw new Blocked("reconciliation_conflict");
    if (!row.source_manifest) throw new Blocked("manifest_missing");
    if (
      createHash("sha256").update(String(row.source_manifest)).digest("hex") !==
      marker.manifestSha256
    )
      throw new Blocked("manifest_mismatch");
    const source = JSON.parse(String(row.source_manifest));
    validateAttachmentManifest(source.attachments);
    if (
      source.attachments.owners.workflowDirectory !==
        layout.workflowDirectory ||
      source.attachments.owners.identityDirectory !== layout.identityDirectory
    )
      throw new Blocked("identity_mismatch");
    const serverId = source.attachments.serverId;
    storage = new FixtureStorage(
      config.dataDirectory,
      serverId,
      now,
      undefined,
      undefined,
      loadAttachmentConfiguration({}),
      "attachment-restore",
    );
    const current = attachmentInventory(root, layout, "metadata-only", null);
    if (!current || current.serverId !== serverId)
      throw new Blocked("manifest_mismatch");
    const original = new Map<string, (typeof current.objects)[number]>(
      source.attachments.objects.map((o: (typeof current.objects)[number]) => [
        o.handleId,
        o,
      ]),
    );
    if (
      current.objects.length !== original.size ||
      current.objects.some((o: (typeof current.objects)[number]) => {
        const pin = original.get(o.handleId);
        return (
          !pin ||
          [
            "locationId",
            "key",
            "owner",
            "contentId",
            "generation",
            "kind",
            "size",
            "sha256",
          ].some((k) => (o as Record<string, unknown>)[k] !== pin[k])
        );
      })
    )
      throw new Blocked("manifest_mismatch");
    const configuration = options.objectStorage ?? loadStorageConfiguration();
    if (current.objects.length) {
      if (configuration.state !== "configured")
        throw new Blocked("storage_unavailable");
      if (
        current.locations.some(
          (l: { id: string; descriptor: unknown }) =>
            l.id !== locationId(configuration.config) ||
            JSON.stringify(l.descriptor) !== descriptor(configuration.config),
        )
      )
        throw new Blocked("location_mismatch");
      storage.initializeObjectStorage(configuration);
      if (storage.objectStorage.state !== "configured")
        throw new Blocked("location_mismatch");
    }
    if (identityDirectory) {
      const identityFile = join(identityDirectory, "identity.sqlite");
      if (!existsSync(identityFile)) throw new Blocked("identity_mismatch");
      identity = new DatabaseSync(identityFile);
      native = { store: ServiceCatalogStore.forAttachmentRestore(identity) };
    }
    let evidence: ReturnType<typeof validateDeletionEvidence> | undefined;
    if (options.reconcile) {
      try {
        evidence = deletionCoverage(
          validateDeletionEvidence(
            JSON.parse(operatorFile(options.reconcile, 1024 * 1024)),
          ),
          marker,
          source,
          now(),
        );
      } catch (error) {
        throw new Blocked(
          error instanceof Error && error.message === "deletion_gap"
            ? "deletion_gap"
            : "reconciliation_conflict",
        );
      }
      // Validate every target before the first erasure; never substitute the current fixed generation.
      for (const entry of evidence.deletions) {
        const scope = ScopeSchema.parse(entry.scope);
        if (scope.serverId !== serverId)
          throw new Blocked("reconciliation_conflict");
        const g = storage.attachmentRestoreGeneration(scope, entry.generation);
        if (!g || g.conversation_id !== entry.conversationId)
          throw new Blocked("reconciliation_conflict");
      }
      const prior = row.reconciliation_evidence
        ? validateDeletionEvidence(
            JSON.parse(String(row.reconciliation_evidence)),
          )
        : undefined;
      const targets = new Set(
        evidence.deletions.map((e: unknown) => digest(e)),
      );
      if (prior?.deletions.some((e: unknown) => !targets.has(digest(e))))
        throw new Blocked("reconciliation_conflict");
      for (const entry of evidence.deletions)
        storage.reconcileAttachmentDeletion(
          ScopeSchema.parse(entry.scope),
          entry.generation,
        );
    } else if (row.reconciliation_evidence && row.reconciliation_digest) {
      try {
        evidence = deletionCoverage(
          validateDeletionEvidence(
            JSON.parse(String(row.reconciliation_evidence)),
          ),
          marker,
          source,
          now(),
        );
      } catch {
        throw new Blocked("deletion_gap");
      }
    }
    if (evidence) {
      let afterScope = "",
        afterGeneration = "";
      for (;;) {
        const page = storage.attachmentRestoreTombstones(
          afterScope,
          afterGeneration,
        );
        if (!page.length) break;
        for (const target of page) {
          const workflow = storage;
          if (native) {
            const workspace = identity!
              .prepare("SELECT organization_id FROM agent_workspace WHERE id=?")
              .get(target.scope.workspaceId);
            if (!workspace) throw new Blocked("reconciliation_conflict");
            await purgeNativeAttachmentGeneration(
              native,
              target.scope,
              String(workspace.organization_id),
              target.generation,
              () =>
                workflow.attachments.isTombstoned(
                  target.scope,
                  target.generation,
                ),
              async (fn) => fn(),
              () =>
                workflow.attachments.nativePurgeCommands(
                  target.scope,
                  target.generation,
                ),
              () =>
                workflow.attachments.nativePurgeConversations(
                  target.scope,
                  target.generation,
                ),
            );
          } else if (
            workflow.attachments.nativePurgeCommands(
              target.scope,
              target.generation,
            ).length
          )
            throw new Blocked("reconciliation_conflict");
          workflow.attachmentRestoreNativeSettled(
            target.scope,
            target.generation,
          );
        }
        afterScope = page.at(-1)!.scopeKey;
        afterGeneration = page.at(-1)!.generation;
      }
      const final = storage.attachmentRestoreState()!;
      storage.recordAttachmentRestoreEvidence(
        marker.restoreId,
        marker.manifestSha256!,
        marker.recoveryCutoff,
        Number(final.reconciliation_revision),
        evidence,
        digest(evidence),
      );
      result.deletionGap = "reconciled";
    }
    const fresh = attachmentInventory(root, layout, "metadata-only", null)!;
    result.pendingPurgeCount = fresh.pendingPurgeCount;
    for (const object of fresh.objects) {
      const scoped = storage.attachments.db
        .prepare("SELECT scope_key FROM attachment_contents WHERE id=?")
        .get(object.contentId);
      if (!scoped) throw new Blocked("manifest_mismatch");
      const [connectionId, serverId, userId, workspaceId] = JSON.parse(
          String(scoped.scope_key),
        ),
        scope = ScopeSchema.parse({
          connectionId,
          serverId,
          userId,
          workspaceId,
        });
      const content = storage.attachments.content(
          scope,
          object.contentId,
          true,
        ),
        settlement = storage.attachments.objectSettlement(content)!;
      if (settlement.write_uncertain || settlement.mutation !== "idle") {
        result.blockedUncertainCount++;
        continue;
      }
      if (object.state === "never-uploaded") {
        if (
          content.ever_dispatched ||
          settlement.put_admitted !== 0 ||
          settlement.state !== "reserved"
        )
          throw new Blocked("mutation_unsettled");
        continue;
      }
      try {
        const bytes = await storage.attachments
            .objectStore()
            .get(storage.attachments.handle(content)),
          hash = createHash("sha256");
        for (let n = 0; n < bytes.length; n += 65536)
          hash.update(bytes.subarray(n, n + 65536));
        if (
          bytes.length !== object.size ||
          hash.digest("hex") !== object.sha256
        ) {
          result.corruptCount++;
          continue;
        }
        result.verifiedCount++;
      } catch (error) {
        if (
          error instanceof StorageError &&
          error.code === "not_found" &&
          (content.lifecycle === "tombstoned" ||
            content.lifecycle === "purged") &&
          !settlement.write_uncertain
        )
          continue;
        if (error instanceof StorageError && error.code === "not_found")
          result.missingCount++;
        else if (error instanceof StorageError && error.code === "integrity")
          result.corruptCount++;
        else throw new Blocked("storage_unavailable");
      }
    }
    const final = storage.attachmentRestoreState()!;
    if (result.blockedUncertainCount) throw new Blocked("mutation_unsettled");
    if (result.missingCount) throw new Blocked("object_missing");
    if (result.corruptCount) throw new Blocked("object_corrupt");
    if (!evidence || !final.reconciliation_digest)
      throw new Blocked("deletion_gap");
    result.status = options.activate ? "activated" : "verified";
    if (options.activate) {
      result.barrier = "serving";
      options.checkpoint?.("before_activation");
      storage.activateAttachmentRestore(
        marker,
        Number(final.reconciliation_revision),
        result,
        new Date(now()).toISOString(),
      );
      options.checkpoint?.("after_activation");
    } else
      storage.recordAttachmentVerification(
        marker.restoreId,
        Number(final.reconciliation_revision),
        result,
      );
    return { exitCode: 0, result: AttachmentRestoreResultSchema.parse(result) };
  } catch (error) {
    result.status = error instanceof Blocked ? "blocked" : "failed";
    result.code = error instanceof Blocked ? error.code : "local_failure";
    return {
      exitCode: error instanceof Blocked ? 2 : 1,
      result: AttachmentRestoreResultSchema.parse(result),
    };
  } finally {
    if (native) await closeNativeCatalogRuntime(native);
    identity?.close();
    storage?.close();
    release?.();
  }
}
