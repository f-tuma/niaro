import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  ConfigItemConflict,
  ConfigSectionResult,
} from "../../../packages/protocol/config-bundle";
import type { OrganizationRole } from "../../../packages/protocol/identity";
import type { AuditRecord } from "../../../packages/protocol/audit";
import type { ServerSettings } from "../../../packages/protocol/server-settings";
import type { HostedServers } from "../../server-hosting/manager";
import { IdentityError } from "../error";
import type { ServerSettingsStore } from "../server-settings";
import type { ServiceCatalogStore } from "../service-catalog";
import type { ServiceProcessStore } from "../service-processes";
import type { SkillStore } from "../skill-store";
import type { WorkspacePluginStore } from "../workspace-plugins";

/** The stores the sections read and write; all synchronous, in one transaction. */
export type ConfigStores = {
  db: DatabaseSync;
  catalog: ServiceCatalogStore;
  skills: SkillStore;
  processes: ServiceProcessStore;
  plugins: WorkspacePluginStore;
  serverSettings?: ServerSettingsStore;
  /** Makes saved server settings take effect in the running server. */
  applyServerSettings?: (
    next: ServerSettings,
    previous: ServerSettings,
  ) => void;
  hosted?: HostedServers;
  audit: (record: AuditRecord) => number;
};
export type ConfigActor = {
  organizationId: string;
  userId: string;
  role: z.infer<typeof OrganizationRole>;
};
export type OrganizationContext = ConfigStores & {
  organizationId: string;
  actor: ConfigActor;
  /**
   * Work that cannot share the transaction (starting an installed connector,
   * applying server settings to the running server). Runs after the commit,
   * never on a preview.
   */
  afterCommit: (run: () => Promise<void> | void) => void;
};
export type WorkspaceContext = OrganizationContext & {
  workspaceId: string;
  /** The administrator as the workspace stores expect them. */
  workspaceActor: ConfigActor & { workspaceId: string };
};

/** A bundle item this server will not apply, with the reason the preview shows. */
export class ConfigConflict extends Error {
  constructor(
    readonly reason: ConfigItemConflict["reason"],
    readonly code?: string,
  ) {
    super(reason);
  }
}

type Outcome = "added" | "changed" | "unchanged";
/** Collects one section's outcome item by item. */
export class SectionOutcome {
  readonly added: string[] = [];
  readonly changed: string[] = [];
  readonly unchanged: string[] = [];
  readonly conflicts: ConfigItemConflict[] = [];
  readonly needsKey: string[] = [];
  constructor(private readonly db: DatabaseSync) {}
  /**
   * Applies one item in its own savepoint: a refused item leaves nothing
   * behind and the rest of the bundle still applies.
   */
  item(name: string, apply: () => Outcome) {
    this.db.exec("SAVEPOINT config_bundle_item");
    try {
      const outcome = apply();
      this.db.exec("RELEASE config_bundle_item");
      this[outcome].push(name);
      return outcome;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO config_bundle_item; RELEASE config_bundle_item",
      );
      if (error instanceof ConfigConflict)
        this.conflict(name, error.reason, error.code);
      else if (error instanceof IdentityError)
        this.conflict(name, "refused", error.code);
      else if (error instanceof z.ZodError) this.conflict(name, "invalid");
      else throw error;
      return undefined;
    }
  }
  conflict(name: string, reason: ConfigItemConflict["reason"], code?: string) {
    this.conflicts.push({ name, reason, ...(code ? { code } : {}) });
  }
  result(key: string, workspace: string | null): ConfigSectionResult {
    return {
      key,
      workspace,
      added: this.added,
      changed: this.changed,
      unchanged: this.unchanged,
      conflicts: this.conflicts,
      needsKey: [...new Set(this.needsKey)],
    };
  }
}

/**
 * One section of the bundle, read and written by its own typed exporter.
 * `export` returns nothing secret; `apply` compares the stored state with the
 * bundle and writes only what differs, so a second import changes nothing.
 * Sections are applied in registry order, so a later section can refer to
 * what an earlier one added (models before routing, services before processes).
 */
export type ConfigSection<T, C> = {
  key: string;
  schema: z.ZodType<T>;
  export: (ctx: C) => T | undefined;
  apply: (ctx: C, data: T, outcome: SectionOutcome) => void;
};
export type OrganizationSection<T = unknown> = ConfigSection<
  T,
  OrganizationContext
> & { scope: "organization" };
export type WorkspaceSection<T = unknown> = ConfigSection<
  T,
  WorkspaceContext
> & { scope: "workspace" };
export type AnySection = OrganizationSection<never> | WorkspaceSection<never>;

export function organizationSection<T>(
  section: ConfigSection<T, OrganizationContext>,
): OrganizationSection<T> {
  return { ...section, scope: "organization" };
}
export function workspaceSection<T>(
  section: ConfigSection<T, WorkspaceContext>,
): WorkspaceSection<T> {
  return { ...section, scope: "workspace" };
}

/** Compares stored and imported values the same way on every section. */
export function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}
export const lower = (value: string) => value.toLocaleLowerCase();
