import { createHash } from "node:crypto";
import {
  CONFIG_BUNDLE_FILE,
  CONFIG_BUNDLE_VERSION,
  ConfigBundleSchema,
  type ConfigBundle,
  type ConfigSectionResult,
} from "../../../packages/protocol/config-bundle";
import { IdentityError } from "../error";
import {
  canonical,
  lower,
  SectionOutcome,
  type ConfigActor,
  type ConfigStores,
  type OrganizationContext,
  type OrganizationSection,
  type WorkspaceContext,
  type WorkspaceSection,
} from "./registry";
import {
  hostedSection,
  modelsSection,
  providersSection,
  serverSettingsSection,
} from "./sections/organization";
import { processesSection } from "./sections/processes";
import { routingSection } from "./sections/routing";
import {
  pluginsSection,
  rolesSection,
  servicesSection,
  skillsSection,
  usageSection,
} from "./sections/workspace";

/**
 * The sections of a bundle, one typed exporter each, applied in this order:
 * what a later section names (a model, a service, a role) is added first.
 * A new section (for example workspace instructions) is one more entry here.
 */
export const ORGANIZATION_SECTIONS: readonly OrganizationSection<never>[] = [
  serverSettingsSection,
  providersSection,
  modelsSection,
  hostedSection,
] as unknown as OrganizationSection<never>[];
export const WORKSPACE_SECTIONS: readonly WorkspaceSection<never>[] = [
  rolesSection,
  servicesSection,
  routingSection,
  usageSection,
  pluginsSection,
  skillsSection,
  processesSection,
] as unknown as WorkspaceSection<never>[];

export type ConfigTarget = {
  organizationId: string;
  actor: ConfigActor;
  /** The organization's workspaces. */
  workspaces: readonly { id: string; name: string }[];
};

function contexts(
  stores: ConfigStores,
  target: ConfigTarget,
  afterCommit: OrganizationContext["afterCommit"],
) {
  const organization: OrganizationContext = {
    ...stores,
    organizationId: target.organizationId,
    actor: target.actor,
    afterCommit,
  };
  const workspace = (workspaceId: string): WorkspaceContext => ({
    ...organization,
    workspaceId,
    workspaceActor: { ...target.actor, workspaceId },
  });
  return { organization, workspace };
}

const exportOf = <C>(
  sections: readonly { key: string; export: (ctx: C) => unknown }[],
  ctx: C,
) =>
  Object.fromEntries(
    sections.flatMap((section) => {
      const data = section.export(ctx);
      return data === undefined ? [] : [[section.key, data]];
    }),
  );

/** The organization's configuration without secrets; read-only. */
export function exportConfigBundle(
  stores: ConfigStores,
  target: ConfigTarget,
  options: { workspaceId?: string; server: string; now?: Date },
): ConfigBundle {
  const { organization, workspace } = contexts(stores, target, () => {
    throw Error("An export never changes anything");
  });
  const workspaces = target.workspaces.filter(
    (w) => !options.workspaceId || w.id === options.workspaceId,
  );
  return ConfigBundleSchema.parse({
    profile: CONFIG_BUNDLE_FILE,
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    source: { server: options.server.slice(0, 100) },
    organization: exportOf(ORGANIZATION_SECTIONS, organization),
    workspaces: workspaces.map((w) => ({
      name: w.name,
      sections: exportOf(WORKSPACE_SECTIONS, workspace(w.id)),
    })),
  });
}

/**
 * The digest of everything an import may change. A preview returns it and
 * the import must name it, so what the person confirmed is what is applied.
 */
export function configRevision(stores: ConfigStores, target: ConfigTarget) {
  const {
    exportedAt: _at,
    source: _source,
    ...rest
  } = exportConfigBundle(stores, target, {
    server: "",
  });
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

/** Reads the bundle a person sent; anything else is refused before any change. */
export function readConfigBundle(raw: unknown): ConfigBundle {
  const parsed = ConfigBundleSchema.safeParse(raw);
  if (!parsed.success) throw new IdentityError(400, "config_bundle_invalid");
  return parsed.data;
}

function runSections<C>(
  sections: readonly {
    key: string;
    schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
    apply: (ctx: C, data: never, outcome: SectionOutcome) => void;
  }[],
  data: Record<string, unknown>,
  ctx: C,
  db: ConfigStores["db"],
  workspace: string | null,
) {
  const results: { key: string; outcome: SectionOutcome }[] = [];
  for (const section of sections) {
    if (!(section.key in data)) continue;
    const outcome = new SectionOutcome(db);
    const parsed = section.schema.safeParse(data[section.key]);
    if (!parsed.success) outcome.conflict(section.key, "invalid");
    else section.apply(ctx, parsed.data as never, outcome);
    results.push({ key: section.key, outcome });
  }
  // A section from a newer server is reported, never guessed at.
  for (const key of Object.keys(data))
    if (!sections.some((section) => section.key === key)) {
      const outcome = new SectionOutcome(db);
      outcome.conflict(key, "section_unknown");
      results.push({ key, outcome });
    }
  return results.map(({ key, outcome }) => ({ key, workspace, outcome }));
}

/**
 * Applies a bundle section by section. Every section writes only what
 * differs, so applying the same bundle again changes nothing. The caller
 * holds the transaction: a preview runs this and rolls it back.
 */
export function applyConfigBundle(
  stores: ConfigStores,
  target: ConfigTarget,
  bundle: ConfigBundle,
  options: {
    /** A bundle with one workspace goes into this one. */
    workspaceId?: string;
    afterCommit: OrganizationContext["afterCommit"];
  },
) {
  const { organization, workspace } = contexts(
    stores,
    target,
    options.afterCommit,
  );
  const results = runSections(
    ORGANIZATION_SECTIONS,
    bundle.organization,
    organization,
    stores.db,
    null,
  );
  for (const entry of bundle.workspaces) {
    const match =
      options.workspaceId && bundle.workspaces.length === 1
        ? target.workspaces.find((w) => w.id === options.workspaceId)
        : target.workspaces.find((w) => lower(w.name) === lower(entry.name));
    if (!match) {
      const outcome = new SectionOutcome(stores.db);
      outcome.conflict(entry.name, "workspace_missing");
      results.push({ key: "workspace", workspace: entry.name, outcome });
      continue;
    }
    results.push(
      ...runSections(
        WORKSPACE_SECTIONS,
        entry.sections,
        workspace(match.id),
        stores.db,
        entry.name,
      ),
    );
  }
  return {
    /** Read after the deferred work ran, which may move an item to conflicts. */
    results: (): ConfigSectionResult[] =>
      results.map(({ key, workspace, outcome }) =>
        outcome.result(key, workspace),
      ),
  };
}

export const hasChanges = (results: readonly ConfigSectionResult[]) =>
  results.some((r) => r.added.length > 0 || r.changed.length > 0);
