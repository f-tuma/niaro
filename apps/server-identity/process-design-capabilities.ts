import { z } from "zod";
import { IdentityId, OrganizationRole } from "../../packages/protocol/identity";
import {
  ProcessLimitsSchema,
  type ProcessLimits,
} from "../../packages/protocol/service-processes";
import type {
  Service,
  ServiceAction,
} from "../../packages/protocol/service-catalog";
import type { ServiceCatalogStore } from "./service-catalog";
import type { WorkspacePluginStore } from "./workspace-plugins";
import type { ProcessActor } from "./service-processes";
import { DEFAULT_PROCESS_LIMITS, processDigest } from "./process-validation";
import { schemaValidator } from "../server-integrations/schema";
import { IdentityError } from "./error";

import type {
  DesignSchemaUnavailable,
  DesignCapabilityAction,
  DesignCapabilityService,
  DesignCapabilityModel,
  DesignCapabilities,
} from "../../packages/protocol/process-design";
export type {
  DesignSchemaUnavailable,
  DesignCapabilityAction,
  DesignCapabilityService,
  DesignCapabilityModel,
  DesignCapabilities,
} from "../../packages/protocol/process-design";

// Large enough for a typical workspace catalog in one response; each page
// rebuilds the complete snapshot to keep cursors bound to one fingerprint.
const PAGE_SIZE = 500;
const actorSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  role: OrganizationRole,
});
const annotations = new Set([
  "title",
  "description",
  "default",
  "examples",
  "$comment",
]);
// This list mirrors the authoritative bounded draft-7 catalog validator. Unknown
// constraints make the entire schema unavailable instead of silently weakening it.
const constraints = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "anyOf",
  "oneOf",
  "allOf",
  "nullable",
  "format",
  "$schema",
  "$defs",
  "definitions",
  "$ref",
  "propertyNames",
  "pattern",
]);
const schemaMaps = new Set(["properties", "$defs", "definitions"]);
const schemaChildren = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
]);
const schemaArrays = new Set(["anyOf", "oneOf", "allOf"]);
const unsafeKey = (value: string) =>
  ["__proto__", "prototype", "constructor"].includes(value);
const sensitiveKey = (value: string) =>
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|client[-_]?secret|credentials?|secret)$/i.test(
    value,
  );
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function projectSchema(raw: Record<string, unknown>): {
  inputSchema: Record<string, unknown> | null;
  schemaUnavailable: DesignSchemaUnavailable | null;
} {
  let nodes = 0;
  const visited = new Set<object>();
  const fail = (reason: DesignSchemaUnavailable): never => {
    throw reason;
  };
  const account = (value: unknown, depth: number) => {
    if (++nodes > 1000 || depth > 12) fail("schema_limit");
    if (value && typeof value === "object") {
      if (visited.has(value)) fail("schema_unsupported");
      visited.add(value);
    }
  };
  const literal = (value: unknown, depth: number): unknown => {
    account(value, depth);
    if (Array.isArray(value))
      return value.map((item) => literal(item, depth + 1));
    if (object(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (unsafeKey(key)) fail("schema_unsupported");
        if (sensitiveKey(key)) fail("sensitive_fields");
        result[key] = literal(child, depth + 1);
      }
      return result;
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return value;
    return fail("schema_unsupported");
  };
  const schema = (value: unknown, depth: number): Record<string, unknown> => {
    account(value, depth);
    if (!object(value)) return fail("schema_unsupported");
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (annotations.has(key)) continue;
      if (!constraints.has(key)) fail("schema_unsupported");
      if (
        key === "required" &&
        Array.isArray(child) &&
        child.some((name) => typeof name === "string" && sensitiveKey(name))
      )
        fail("sensitive_fields");
      if (schemaMaps.has(key)) {
        if (!object(child)) return fail("schema_unsupported");
        const properties: Record<string, unknown> = {};
        for (const [name, property] of Object.entries(child)) {
          if (unsafeKey(name)) fail("schema_unsupported");
          if (sensitiveKey(name)) fail("sensitive_fields");
          properties[name] = schema(property, depth + 1);
        }
        result[key] = properties;
      } else if (schemaChildren.has(key) && object(child))
        result[key] = schema(child, depth + 1);
      else if (schemaArrays.has(key)) {
        if (!Array.isArray(child)) return fail("schema_unsupported");
        result[key] = child.map((item) => schema(item, depth + 1));
      } else result[key] = literal(child, depth + 1);
    }
    return result;
  };
  try {
    // Check source size too: discarded annotations cannot make oversized input affordable.
    if (Buffer.byteLength(JSON.stringify(raw)) > 32768) fail("schema_limit");
    const projected = schema(raw, 0);
    if (Buffer.byteLength(JSON.stringify(projected)) > 16384)
      fail("schema_limit");
    // Reuse actual schema semantics, including local refs, regex bounds and root objects.
    schemaValidator(projected);
    return { inputSchema: projected, schemaUnavailable: null };
  } catch (error) {
    return {
      inputSchema: null,
      schemaUnavailable:
        error === "schema_limit" || error === "sensitive_fields"
          ? error
          : "schema_unsupported",
    };
  }
}
const serviceSummary = (service: Service): DesignCapabilityService => ({
  id: service.id,
  revision: service.revision,
  name: service.name,
  description: service.description ?? "",
  enabled: service.enabled,
  actions: [],
});
const actionSummary = (
  service: Service,
  action: ServiceAction,
): DesignCapabilityAction => ({
  id: action.id,
  revision: action.revision,
  name: action.name,
  description: action.description,
  enabled: action.enabled,
  status: service.enabled && action.enabled ? "configured" : "disabled",
  effect: action.effect,
  approval: action.approval,
  ...projectSchema(action.inputSchema),
});
type Entry =
  | { key: string; kind: "service"; service: Service }
  | { key: string; kind: "action"; service: Service; action: ServiceAction }
  | { key: string; kind: "model"; model: DesignCapabilityModel };

/** One scope check and catalog read for either a page or a complete validation index. */
function capabilitySnapshot(
  catalog: ServiceCatalogStore,
  plugins: WorkspacePluginStore,
  rawActor: ProcessActor,
  options: { limits?: ProcessLimits },
) {
  // Everyone designs with their own grants: members can design personal
  // processes, and every listed action passes the same per-actor check
  // (`catalog.allowed`) the chat runtime and execution inventory use.
  const actor = actorSchema.parse(rawActor);
  if (catalog.workspaceOrganization(actor.workspaceId) !== actor.organizationId)
    throw new IdentityError(404, "process_not_found");
  const limits = ProcessLimitsSchema.parse(
    options.limits ?? DEFAULT_PROCESS_LIMITS,
  );
  const inventory = catalog.inventory(
    actor.organizationId,
    actor.workspaceId,
    actor,
  );
  const entries: Entry[] = [];
  const dependencies: unknown[] = [];
  for (const listed of inventory.services) {
    // A member's inventory already omits disabled/unusable actions but strips
    // their policies; authorize the stored actions, never the projection.
    // Each action as it applies to this person: under their own account the
    // approval they chose (and `allowed` below, their own on/off).
    const service = catalog.serviceFor(
      actor.workspaceId,
      listed.id,
      actor.userId,
    );
    const visible = new Set(listed.actions.map((action) => action.id));
    entries.push({ key: "service:" + service.id, kind: "service", service });
    dependencies.push(serviceSummary(service));
    // Management visibility does not grant execution capability.
    for (const action of service.actions) {
      if (!visible.has(action.id) || !catalog.allowed(action, actor)) continue;
      entries.push({
        key: "action:" + service.id + ":" + action.id,
        kind: "action",
        service,
        action,
      });
      dependencies.push({
        serviceId: service.id,
        id: action.id,
        revision: action.revision,
        name: action.name,
        description: action.description,
        enabled: action.enabled,
        effect: action.effect,
        approval: action.approval,
        schemaDigest: processDigest(action.inputSchema),
      });
    }
  }
  // Model choice is not a role grant; budget and provider limits still apply.
  // Members' inventory omits model metadata, so list the IDs directly.
  for (const id of catalog.processModelIds(actor.organizationId)) {
    try {
      const usable = catalog.model(actor.organizationId, id, "tools");
      const model: DesignCapabilityModel = {
        id: usable.model.id,
        revision: usable.model.revision,
        name: usable.model.name,
        model: usable.model.model,
        providerId: usable.provider.id,
        providerRevision: usable.provider.revision,
        tools: true,
        status: "configured",
      };
      entries.push({ key: "model:" + model.id, kind: "model", model });
      dependencies.push(model);
    } catch (error) {
      if (
        !(error instanceof IdentityError) ||
        !["catalog_model_unavailable", "catalog_not_found"].includes(error.code)
      )
        throw error;
    }
  }
  entries.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  // Designer turns and tests refuse to start without enforced limits and a
  // price for the model; members learn that here, before any request.
  const budget = catalog.inferenceBudget.policy(
    actor.organizationId,
    actor.workspaceId,
  ).settings;
  const budgetReady =
    budget.mode === "enforce" &&
    entries.some(
      (entry) =>
        entry.kind === "model" &&
        budget.prices.some(
          (price) =>
            price.modelId === entry.model.id &&
            price.modelRevision === entry.model.revision &&
            price.providerRevision === entry.model.providerRevision,
        ),
    );
  const memory = plugins.read(actor.workspaceId);
  const memoryModes: DesignCapabilities["memoryModes"] = [
    "none",
    "conversation",
  ];
  if (memory.settings.enabled.includes("memory")) memoryModes.push("saved");
  const fingerprint = processDigest({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    dependencies: dependencies.map((value) => processDigest(value)).sort(),
    memoryModes,
    memoryRevision: memory.revision,
    memoryDigest: processDigest(memory),
    limits,
  });
  return { actor, entries, memoryModes, limits, fingerprint, budgetReady };
}

export type DesignCapabilityIndex = {
  fingerprint: string;
  actions: Map<string, DesignCapabilityAction>;
  models: Set<string>;
};

/** Complete passive validation lookup from one snapshot, never page-by-page
 * inventory rebuilding. Keys use the existing process serviceId:actionId pair. */
export function designCapabilityIndex(
  catalog: ServiceCatalogStore,
  plugins: WorkspacePluginStore,
  actor: ProcessActor,
  options: { limits?: ProcessLimits } = {},
): DesignCapabilityIndex {
  const snapshot = capabilitySnapshot(catalog, plugins, actor, options);
  const actions = new Map<string, DesignCapabilityAction>();
  const models = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entry.kind === "action")
      actions.set(
        entry.service.id + ":" + entry.action.id,
        actionSummary(entry.service, entry.action),
      );
    if (entry.kind === "model") models.add(entry.model.id);
  }
  return { fingerprint: snapshot.fingerprint, actions, models };
}

/** Passive local projection only. Caller supplies a freshly authenticated actor
 * while holding the identity queue. Never calls action authorization/dispatch,
 * personal account retrieval, remote discovery, or saved-memory retrieval. */
export function designCapabilities(
  catalog: ServiceCatalogStore,
  plugins: WorkspacePluginStore,
  rawActor: ProcessActor,
  options: { after?: string; limits?: ProcessLimits; pageSize?: number } = {},
): DesignCapabilities {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const { actor, entries, memoryModes, limits, fingerprint, budgetReady } =
    capabilitySnapshot(catalog, plugins, rawActor, options);
  let after = "";
  if (options.after !== undefined) {
    try {
      if (options.after.length > 1024) throw Error("cursor");
      const cursor = JSON.parse(
        Buffer.from(options.after, "base64url").toString("utf8"),
      );
      if (
        !object(cursor) ||
        Object.keys(cursor).length !== 2 ||
        typeof cursor.key !== "string" ||
        typeof cursor.fingerprint !== "string"
      )
        throw Error("cursor");
      if (cursor.fingerprint !== fingerprint)
        throw new IdentityError(409, "process_design_capabilities_changed");
      if (!entries.some((entry) => entry.key === cursor.key))
        throw Error("cursor");
      after = cursor.key;
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError(400, "process_design_cursor_invalid");
    }
  }
  const remaining = entries.filter((entry) => entry.key > after);
  const page = remaining.slice(0, pageSize);
  const services = new Map<string, DesignCapabilityService>();
  const models: DesignCapabilityModel[] = [];
  for (const entry of page) {
    if (entry.kind === "model") {
      models.push(entry.model);
      continue;
    }
    const service =
      services.get(entry.service.id) ?? serviceSummary(entry.service);
    services.set(service.id, service);
    if (entry.kind === "action")
      service.actions.push(actionSummary(entry.service, entry.action));
  }
  return {
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    services: [...services.values()],
    models,
    memoryModes,
    limits,
    grammar: {
      schemaVersion: 1,
      trigger: "manual",
      kinds: ["agent", "workflow"],
    },
    fingerprint,
    nextAfter:
      remaining.length > pageSize
        ? Buffer.from(
            JSON.stringify({ key: page.at(-1)!.key, fingerprint }),
          ).toString("base64url")
        : null,
    totalItems: entries.length,
    budgetReady,
  };
}

/** What a chat proposal needs from one snapshot: the names and policies of
 * the actions the person may use, every tool model by id, and the tool models
 * the workspace budget prices (designer turns need one of them). */
export function designProposalCatalog(
  catalog: ServiceCatalogStore,
  plugins: WorkspacePluginStore,
  actor: ProcessActor,
) {
  const snapshot = capabilitySnapshot(catalog, plugins, actor, {});
  const budget = catalog.inferenceBudget.policy(
    actor.organizationId,
    actor.workspaceId,
  ).settings;
  const models = snapshot.entries.flatMap((entry) =>
    entry.kind === "model" ? [entry.model] : [],
  );
  const actions = new Map<
    string,
    {
      service: string;
      action: string;
      effect: "read" | "write";
      approval: "always" | "never";
    }
  >();
  for (const entry of snapshot.entries)
    if (entry.kind === "action")
      actions.set(entry.service.id + ":" + entry.action.id, {
        service: entry.service.name,
        action: entry.action.name,
        effect: entry.action.effect,
        approval: entry.action.approval,
      });
  return {
    budgetReady: snapshot.budgetReady,
    models,
    priced:
      budget.mode === "enforce"
        ? models.filter((model) =>
            budget.prices.some(
              (price) =>
                price.modelId === model.id &&
                price.modelRevision === model.revision &&
                price.providerRevision === model.providerRevision,
            ),
          )
        : [],
    actions,
  };
}
