/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityId, IdentityName } from "./identity";

/**
 * A configuration bundle: an organization's setup (providers, models,
 * model choice, usage limits, services and actions, company skills, process
 * drafts, plugin settings, installed connectors and server settings) as one
 * versioned JSON file without secrets. Every section is read and written by
 * its own exporter on the server; the envelope only names the sections, so a
 * newer server can add a section without a new file version and an older one
 * reports the sections it does not know.
 */
export const CONFIG_BUNDLE_FILE = "niaro-config-bundle" as const;
export const CONFIG_BUNDLE_VERSION = 1 as const;
export const CONFIG_BUNDLE_PREVIEW_PROFILE =
  "agent-config-bundle-preview/1" as const;
/** Largest bundle the server reads (skills with files, many actions). */
export const CONFIG_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

/** A section's key, such as `providers` or `routing`. */
export const ConfigSectionKey = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);
export type ConfigSectionKey = z.infer<typeof ConfigSectionKey>;
/** Each section's own data; its exporter validates it. */
const Sections = z
  .record(ConfigSectionKey, z.unknown())
  .refine((value) => Object.keys(value).length <= 40);

export const ConfigBundleSchema = z.strictObject({
  profile: z.literal(CONFIG_BUNDLE_FILE),
  version: z.literal(CONFIG_BUNDLE_VERSION),
  exportedAt: z.iso.datetime(),
  /** The server it came from, for people reading the file. */
  source: z.strictObject({ server: z.string().max(100) }),
  /** Sections that belong to the whole organization. */
  organization: Sections,
  /** Sections of each exported workspace, matched by name on import. */
  workspaces: z
    .array(z.strictObject({ name: IdentityName, sections: Sections }))
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.name.toLocaleLowerCase())).size ===
        items.length,
      "Workspace names must be unique",
    ),
});
export type ConfigBundle = z.infer<typeof ConfigBundleSchema>;

export const ConfigBundleExportQuery = z.strictObject({
  organizationId: IdentityId,
  /** Only this workspace; absent exports every workspace of the organization. */
  workspaceId: IdentityId.optional(),
});
export const ConfigBundlePreviewRequest = z.strictObject({
  organizationId: IdentityId,
  /** A bundle with one workspace is imported into this one. */
  workspaceId: IdentityId.optional(),
  bundle: z.unknown(),
});
export const ConfigBundleImportRequest = ConfigBundlePreviewRequest.extend({
  /** The `revision` of the preview the person confirmed. */
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Why an item of a bundle is not applied. */
export const ConfigConflictReason = z.enum([
  /** The section is not known to this server. */
  "section_unknown",
  /** The section's data does not validate. */
  "invalid",
  /** The bundle's workspace has no workspace of the same name here. */
  "workspace_missing",
  /** It names a provider, model, service, action or role that is missing here. */
  "reference_missing",
  /** A stored key or sign-in would go to a different address. */
  "address_changed",
  /** The change is refused by the same rules as the console's. */
  "refused",
  /** Installed connectors are changed in their own page, never by an import. */
  "managed_elsewhere",
]);
export const ConfigItemConflict = z.strictObject({
  name: z.string().max(300),
  reason: ConfigConflictReason,
  /** The server's error code, when the change was refused. */
  code: z.string().max(80).optional(),
});
export type ConfigItemConflict = z.infer<typeof ConfigItemConflict>;
const names = z.array(z.string().max(300)).max(5000);
export const ConfigSectionResult = z.strictObject({
  key: ConfigSectionKey,
  /** The workspace's name in the bundle; null for organization sections. */
  workspace: z.string().max(100).nullable(),
  added: names,
  changed: names,
  unchanged: names,
  conflicts: z.array(ConfigItemConflict).max(5000),
  /** Items that need a key or secret value entered here before they work. */
  needsKey: names,
});
export type ConfigSectionResult = z.infer<typeof ConfigSectionResult>;
export const ConfigBundlePreview = z.strictObject({
  profile: z.literal(CONFIG_BUNDLE_PREVIEW_PROFILE),
  /** The current configuration's digest; the import must name it. */
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  /** False when nothing would change. */
  changes: z.boolean(),
  sections: z.array(ConfigSectionResult).max(1000),
});
export type ConfigBundlePreview = z.infer<typeof ConfigBundlePreview>;
export const ConfigBundleImportResult = ConfigBundlePreview.extend({
  imported: z.literal(true),
});
export type ConfigBundleImportResult = z.infer<typeof ConfigBundleImportResult>;

/** Reads a file a person picked; throws when it is not a bundle. */
export function parseConfigBundle(text: string): ConfigBundle {
  return ConfigBundleSchema.parse(JSON.parse(text));
}
