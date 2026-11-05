/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityName } from "../../../../packages/protocol/identity";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeChunking,
  KnowledgeSettings,
} from "../../../../packages/protocol/knowledge";
import { serviceRefs } from "../refs";
import { ConfigConflict, same, workspaceSection } from "../registry";

/**
 * What a workspace indexes as knowledge (NIAR-298): whether files are
 * indexed, how passages are cut and which read actions are sources, by
 * service and action name. Never the index: it is derived and the target
 * server builds its own from its own files and services.
 */
const KnowledgeSection = z.strictObject({
  version: z.literal(1),
  files: z.boolean(),
  chunking: KnowledgeChunking,
  sources: z
    .array(
      z.strictObject({
        service: IdentityName,
        action: IdentityName,
      }),
    )
    .max(KNOWLEDGE_LIMITS.sources),
});
type KnowledgeSection = z.infer<typeof KnowledgeSection>;

export const knowledgeSection = workspaceSection<KnowledgeSection>({
  key: "knowledge",
  schema: KnowledgeSection,
  export: (ctx) => {
    if (!ctx.knowledge) return undefined;
    const services = serviceRefs(ctx);
    const { settings } = ctx.knowledge.store.read(
      ctx.organizationId,
      ctx.workspaceId,
    );
    return {
      version: 1,
      files: settings.files,
      chunking: settings.chunking,
      // A source whose service or action is gone is left out.
      sources: settings.sources.flatMap((source) => {
        try {
          return [
            {
              service: services.name(source.serviceId),
              action: services.actionName(source.serviceId, source.actionId),
            },
          ];
        } catch {
          return [];
        }
      }),
    };
  },
  apply: (ctx, data, outcome) => {
    const knowledge = ctx.knowledge;
    if (!knowledge) return;
    outcome.item("Workspace knowledge", () => {
      const services = serviceRefs(ctx);
      const eligible = new Set(
        knowledge
          .candidates(ctx.organizationId, ctx.workspaceId)
          .flatMap((service) =>
            service.actions.map(
              (action) => `${service.serviceId}/${action.id}`,
            ),
          ),
      );
      const settings = KnowledgeSettings.parse({
        files: data.files,
        chunking: data.chunking,
        sources: data.sources.map((source) => {
          const found = services.action(source.service, source.action);
          // Only a shared read that needs no input may be a source here too.
          if (!eligible.has(`${found.service.id}/${found.action.id}`))
            throw new ConfigConflict("refused", "knowledge_source_unavailable");
          return { serviceId: found.service.id, actionId: found.action.id };
        }),
      });
      const current = knowledge.store.read(ctx.organizationId, ctx.workspaceId);
      if (same(current.settings, settings)) return "unchanged";
      knowledge.store.write(
        ctx.organizationId,
        ctx.workspaceId,
        ctx.actor.userId,
        current.revision,
        settings,
      );
      // The index follows once the import is committed.
      ctx.afterCommit(() =>
        knowledge.resync(ctx.organizationId, ctx.workspaceId),
      );
      return "changed";
    });
  },
});
