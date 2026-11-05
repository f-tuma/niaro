import { z } from "zod";
import {
  CONFIG_BUNDLE_PREVIEW_PROFILE,
  ConfigBundleExportQuery,
  ConfigBundleImportRequest,
  ConfigBundlePreview,
  ConfigBundlePreviewRequest,
  ConfigBundleImportResult,
  type ConfigSectionResult,
} from "../../../packages/protocol/config-bundle";
import { OrganizationRole } from "../../../packages/protocol/identity";
import { IdentityError } from "../error";
import {
  applyConfigBundle,
  configRevision,
  exportConfigBundle,
  hasChanges,
  readConfigBundle,
  type ConfigTarget,
} from "./index";
import type { ConfigStores } from "./registry";

export type ConfigBundleHost = {
  stores: ConfigStores;
  /** The signed-in account's role in the organization (never a recovery key). */
  actor: (
    organizationId: string,
  ) => Promise<{ userId: string; role: z.infer<typeof OrganizationRole> }>;
  /** BEGIN IMMEDIATE … COMMIT, rolled back on a throw. */
  transaction: <T>(run: () => Promise<T>) => Promise<T>;
  /** Retires running work after a change that could take authority away. */
  changePolicy: (organizationId: string) => void;
  /** Drops cached values a rolled back transaction left behind. */
  forget: () => void;
  serverName: () => string;
};
type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

/** Rolled back on purpose after a preview: nothing of it stays. */
class PreviewDone extends Error {
  constructor(readonly results: ConfigSectionResult[]) {
    super("preview");
  }
}

/**
 * `GET …/config-bundle/export`, `POST …/preview` and `POST …/import`:
 * owners and administrators of the organization, from an account. Called
 * with the identity queue held.
 */
export async function handleConfigBundle(
  method: string,
  url: URL,
  payload: unknown,
  host: ConfigBundleHost,
): Promise<Reply> {
  const action = url.pathname.slice("/admin/api/identity/config-bundle".length);
  const allowed = { "/export": "GET", "/preview": "POST", "/import": "POST" }[
    action
  ];
  if (!allowed) return { status: 404, body: { error: "not_found" } };
  if (method !== allowed)
    return { status: 405, body: { error: "method_not_allowed" } };
  const input =
    action === "/export"
      ? ConfigBundleExportQuery.parse(Object.fromEntries(url.searchParams))
      : action === "/preview"
        ? ConfigBundlePreviewRequest.parse(payload)
        : ConfigBundleImportRequest.parse(payload);
  const actor = await host.actor(input.organizationId);
  if (actor.role === "member")
    throw new IdentityError(403, "identity_forbidden");
  const db = host.stores.db;
  const workspaces = db
    .prepare(
      "SELECT id, name FROM agent_workspace WHERE organization_id=? ORDER BY name, id",
    )
    .all(input.organizationId)
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
  if (input.workspaceId && !workspaces.some((w) => w.id === input.workspaceId))
    throw new IdentityError(404, "identity_not_found");
  const target: ConfigTarget = {
    organizationId: input.organizationId,
    actor: {
      organizationId: input.organizationId,
      userId: actor.userId,
      role: actor.role,
    },
    workspaces,
  };
  if (action === "/export") {
    const bundle = exportConfigBundle(host.stores, target, {
      workspaceId: input.workspaceId,
      server: host.serverName(),
    });
    return {
      status: 200,
      body: bundle,
      headers: {
        "Content-Disposition": `attachment; filename="niaro-configuration-${bundle.exportedAt.slice(0, 10)}.json"`,
      },
    };
  }
  const bundle = readConfigBundle("bundle" in input ? input.bundle : undefined);
  const options = { workspaceId: input.workspaceId };
  if (action === "/preview") {
    const revision = configRevision(host.stores, target);
    let results: ConfigSectionResult[] = [];
    try {
      await host.transaction(async () => {
        const run = applyConfigBundle(host.stores, target, bundle, {
          ...options,
          afterCommit: () => {},
        });
        throw new PreviewDone(run.results());
      });
    } catch (error) {
      if (!(error instanceof PreviewDone)) throw error;
      results = error.results;
    } finally {
      host.forget();
    }
    return {
      status: 200,
      body: ConfigBundlePreview.parse({
        profile: CONFIG_BUNDLE_PREVIEW_PROFILE,
        revision,
        changes: hasChanges(results),
        sections: results,
      }),
    };
  }
  if (!("revision" in input))
    throw new IdentityError(400, "identity_invalid_input");
  const deferred: (() => Promise<void> | void)[] = [];
  let run: ReturnType<typeof applyConfigBundle>;
  try {
    run = await host.transaction(async () => {
      // What the person reviewed must still be what is stored.
      if (configRevision(host.stores, target) !== input.revision)
        throw new IdentityError(409, "config_bundle_conflict");
      const before = authority(host.stores, target);
      const applied = applyConfigBundle(host.stores, target, bundle, {
        ...options,
        afterCommit: (task) => deferred.push(task),
      });
      const results = applied.results();
      // Running work keeps its policy epoch unless authority may have moved.
      if (authority(host.stores, target) !== before)
        host.changePolicy(input.organizationId);
      host.stores.audit({
        organizationId: input.organizationId,
        workspaceId:
          input.workspaceId && bundle.workspaces.length === 1
            ? input.workspaceId
            : null,
        actorId: actor.userId,
        source: "console",
        action: "config.bundle_imported",
        targetId: null,
        outcome: "succeeded",
        details: {
          added: results.reduce((n, r) => n + r.added.length, 0),
          changed: results.reduce((n, r) => n + r.changed.length, 0),
        },
      });
      return applied;
    });
  } catch (error) {
    host.forget();
    throw error;
  }
  // Installed connectors start and server settings take effect once committed.
  for (const task of deferred) await task();
  const results = run.results();
  return {
    status: 200,
    body: ConfigBundleImportResult.parse({
      profile: CONFIG_BUNDLE_PREVIEW_PROFILE,
      imported: true,
      revision: configRevision(host.stores, target),
      changes: hasChanges(results),
      sections: results,
    }),
  };
}

/** Everything that decides who may do what, for the policy epoch. */
function authority(stores: ConfigStores, target: ConfigTarget) {
  return JSON.stringify(
    target.workspaces.map((w) => [
      [...stores.catalog.authorityShape(target.organizationId, w.id)],
      stores.catalog.workspaceRoles.list(w.id).map((r) => r.name),
    ]),
  );
}
