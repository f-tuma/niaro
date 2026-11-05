/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityName } from "../../../../packages/protocol/identity";
import {
  ProcessDefinitionSchema,
  ProcessLayoutSchema,
  type ProcessDefinition,
} from "../../../../packages/protocol/service-processes";
import { ModelRef, modelRefs, serviceRefs } from "../refs";
import {
  ConfigConflict,
  lower,
  same,
  workspaceSection,
  type WorkspaceContext,
} from "../registry";

/**
 * Company and service processes as drafts. A definition names services,
 * actions and models by name instead of id; an import saves the draft with
 * the same validation as the console and never freezes, tests or activates
 * it, which stays a person's decision on this server.
 */
const Capability = z.strictObject({
  service: IdentityName,
  action: IdentityName,
});
type Capability = z.infer<typeof Capability>;
const Owner = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("workspace") }),
  z.strictObject({ type: z.literal("service"), service: IdentityName }),
]);
const ProcessItem = z.strictObject({
  owner: Owner,
  name: IdentityName,
  /** The definition with `model`, `{service, action}` in place of ids. */
  definition: z.record(z.string(), z.unknown()),
  layout: ProcessLayoutSchema.nullable(),
});
type ProcessItem = z.infer<typeof ProcessItem>;
type Json = Record<string, unknown>;

function portable(ctx: WorkspaceContext, definition: ProcessDefinition): Json {
  const models = modelRefs(ctx),
    services = serviceRefs(ctx);
  const model = (id: string) => {
    const ref = models.ref(id);
    if (!ref) throw new ConfigConflict("reference_missing");
    return ref;
  };
  const capability = (c: { serviceId: string; actionId: string }) => ({
    service: services.name(c.serviceId),
    action: services.actionName(c.serviceId, c.actionId),
  });
  if (definition.kind === "agent") {
    const { modelId, capabilities, ...rest } = definition;
    return {
      ...rest,
      model: model(modelId),
      capabilities: capabilities.map(capability),
    };
  }
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (step.type === "action") {
        const { serviceId, actionId, ...rest } = step;
        return { ...rest, ...capability({ serviceId, actionId }) };
      }
      if (step.type === "agent") {
        const { modelId, capabilities, ...rest } = step;
        return {
          ...rest,
          model: model(modelId),
          capabilities: capabilities.map(capability),
        };
      }
      return step;
    }),
  };
}

function local(ctx: WorkspaceContext, value: Json): ProcessDefinition {
  const models = modelRefs(ctx),
    services = serviceRefs(ctx);
  const model = (raw: unknown) => models.find(ModelRef.parse(raw)).model.id;
  const capability = (raw: unknown) => {
    const ref: Capability = Capability.parse(raw);
    const found = services.action(ref.service, ref.action);
    return { serviceId: found.service.id, actionId: found.action.id };
  };
  const agent = (raw: Json) => {
    const { model: ref, capabilities, ...rest } = raw;
    return {
      ...rest,
      modelId: model(ref),
      capabilities: z
        .array(z.unknown())
        .max(16)
        .parse(capabilities)
        .map(capability),
    };
  };
  if (value.kind === "agent")
    return ProcessDefinitionSchema.parse(agent(value));
  const steps = z
    .array(z.record(z.string(), z.unknown()))
    .max(64)
    .parse(value.steps)
    .map((step) => {
      if (step.type === "action") {
        const { service, action, ...rest } = step;
        return { ...rest, ...capability({ service, action }) };
      }
      return step.type === "agent" ? agent(step) : step;
    });
  return ProcessDefinitionSchema.parse({ ...value, steps });
}

/** Company and service processes only; personal ones stay with their owner. */
function companyProcesses(ctx: WorkspaceContext) {
  const rows = [];
  let after: string | undefined;
  do {
    const page = ctx.processes.listOwned(ctx.workspaceActor, after);
    rows.push(...page.processes);
    after = page.nextAfter ?? undefined;
  } while (after);
  return rows.flatMap((summary) => {
    const owner =
      "owner" in summary && summary.owner
        ? summary.owner
        : "serviceId" in summary && summary.serviceId
          ? { type: "service" as const, serviceId: summary.serviceId }
          : undefined;
    if (!owner || owner.type === "user") return [];
    return [{ summary, owner }];
  });
}

export const processesSection = workspaceSection({
  key: "processes",
  schema: z.strictObject({
    version: z.literal(1),
    items: z.array(ProcessItem).max(500),
  }),
  export: (ctx) => {
    const services = serviceRefs(ctx);
    return {
      version: 1 as const,
      items: companyProcesses(ctx).flatMap(({ summary, owner }) => {
        try {
          const record = ctx.processes.getOwned(ctx.workspaceActor, summary.id);
          return [
            {
              owner:
                owner.type === "service"
                  ? {
                      type: "service" as const,
                      service: services.name(owner.serviceId),
                    }
                  : { type: "workspace" as const },
              name: record.draft.name,
              definition: portable(ctx, record.draft),
              layout: record.layout ?? null,
            },
          ];
        } catch (error) {
          // A draft that names something already removed cannot travel.
          if (error instanceof ConfigConflict) return [];
          throw error;
        }
      }),
    };
  },
  apply: (ctx, data, outcome) => {
    for (const item of data.items) applyProcess(ctx, item, outcome);
  },
});

function applyProcess(
  ctx: WorkspaceContext,
  item: ProcessItem,
  outcome: Parameters<typeof processesSection.apply>[2],
) {
  const label =
    item.owner.type === "service"
      ? `${item.owner.service} / ${item.name}`
      : item.name;
  outcome.item(label, () => {
    const definition = local(ctx, item.definition);
    if (lower(definition.name) !== lower(item.name))
      throw new ConfigConflict("invalid");
    const serviceId =
      item.owner.type === "service"
        ? serviceRefs(ctx).find(item.owner.service).id
        : undefined;
    const existing = companyProcesses(ctx).find(
      ({ summary, owner }) =>
        lower(summary.name) === lower(item.name) &&
        (owner.type === "service"
          ? owner.serviceId === serviceId
          : serviceId === undefined),
    );
    const record =
      existing &&
      ctx.processes.getOwned(ctx.workspaceActor, existing.summary.id);
    if (
      record &&
      same(record.draft, definition) &&
      same(record.layout ?? null, item.layout)
    )
      return "unchanged";
    const input = {
      ...(record ? { id: record.id } : {}),
      revision: record?.revision ?? 0,
      definition,
      layout: item.layout,
    };
    if (serviceId)
      ctx.processes.saveDraft(ctx.workspaceActor, { ...input, serviceId });
    else
      ctx.processes.saveWorkspaceDraft(ctx.workspaceActor, {
        ...input,
        owner: { type: "workspace" },
      });
    return record ? "changed" : "added";
  });
}
