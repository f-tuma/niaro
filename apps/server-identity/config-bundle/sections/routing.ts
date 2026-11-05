import { z } from "zod";
import { IdentityName } from "../../../../packages/protocol/identity";
import { Routing } from "../../../../packages/protocol/service-catalog";
import { ModelRef, modelRefs, serviceRefs } from "../refs";
import { ConfigConflict, same, workspaceSection } from "../registry";

/**
 * Model choice of a workspace, against today's `Routing` type. Kept on its
 * own so a reshaped routing policy (roles and tiers) replaces this one file
 * and its section key version; nothing else in the bundle reads routing.
 */
const shape = Routing.shape;
const RoutingSectionSchema = z.strictObject({
  version: z.literal(1),
  model: ModelRef.nullable(),
  voiceModel: ModelRef.nullable(),
  voiceMode: shape.voiceMode.unwrap(),
  voiceMethod: shape.voiceMethod.unwrap(),
  meetingTranscriptionModel: ModelRef.nullable(),
  speech: z.strictObject({
    model: ModelRef.nullable(),
    method: z.enum(["reader", "speech"]),
    zeroDataRetention: z.boolean(),
    voice: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9._:/-]+$/),
  }),
  decision: z.strictObject({
    enabled: z.boolean(),
    model: ModelRef.nullable(),
    minConfidence: z.number().min(0.5).max(1),
  }),
  planner: shape.planner.unwrap(),
  services: z
    .array(
      z.strictObject({ service: IdentityName, model: ModelRef.nullable() }),
    )
    .max(100),
});
type RoutingSection = z.infer<typeof RoutingSectionSchema>;

export const routingSection = workspaceSection<RoutingSection>({
  key: "routing",
  schema: RoutingSectionSchema,
  export: (ctx) => {
    const route = ctx.catalog.routing(ctx.workspaceId);
    const models = modelRefs(ctx),
      services = serviceRefs(ctx);
    return {
      version: 1,
      model: models.ref(route.modelId),
      voiceModel: models.ref(route.voiceModelId),
      voiceMode: route.voiceMode,
      voiceMethod: route.voiceMethod,
      meetingTranscriptionModel: models.ref(route.meetingTranscriptionModelId),
      speech: {
        model: models.ref(route.speech.modelId),
        method: route.speech.method,
        zeroDataRetention: route.speech.zeroDataRetention,
        voice: route.speech.voice,
      },
      decision: {
        enabled: route.decision.enabled,
        model: models.ref(route.decision.modelId),
        minConfidence: route.decision.minConfidence,
      },
      planner: route.planner,
      // A member's own service has no shared model choice.
      services: route.services.flatMap((entry) => {
        const service = services.services.find((s) => s.id === entry.serviceId);
        return service
          ? [{ service: service.name, model: models.ref(entry.modelId) }]
          : [];
      }),
    };
  },
  apply: (ctx, data, outcome) => {
    outcome.item("Model choice", () => {
      const models = modelRefs(ctx),
        services = serviceRefs(ctx);
      const current = ctx.catalog.routing(ctx.workspaceId);
      const { revision, ...stored } = current;
      const desired = {
        modelId: models.id(data.model),
        voiceModelId: models.id(data.voiceModel),
        voiceMode: data.voiceMode,
        voiceMethod: data.voiceMethod,
        meetingTranscriptionModelId: models.id(data.meetingTranscriptionModel),
        speech: {
          modelId: models.id(data.speech.model),
          method: data.speech.method,
          zeroDataRetention: data.speech.zeroDataRetention,
          voice: data.speech.voice,
        },
        decision: {
          enabled: data.decision.enabled,
          modelId: models.id(data.decision.model),
          minConfidence: data.decision.minConfidence,
        },
        planner: data.planner,
        services: data.services.map((entry) => ({
          serviceId: services.find(entry.service).id,
          modelId: models.id(entry.model),
        })),
      };
      if (
        new Set(desired.services.map((s) => s.serviceId)).size !==
        desired.services.length
      )
        throw new ConfigConflict("invalid");
      if (same(stored, desired)) return "unchanged";
      ctx.catalog.command({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        type: "saveRouting",
        routing: { revision, ...desired },
      });
      return "changed";
    });
  },
});
