/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import {
  InstructionsContentSchema,
  type InstructionsContent,
} from "../../../../packages/protocol/workspace-instructions";
import {
  organizationSection,
  same,
  workspaceSection,
  type OrganizationContext,
} from "../registry";

/**
 * Instructions and starters: the organization default and each workspace's
 * own. The bundle carries only the current text, never the version history;
 * an import that changes it saves a new version the editor can undo.
 */
const InstructionsSection = z.strictObject({
  version: z.literal(1),
  content: InstructionsContentSchema,
});
type InstructionsSection = z.infer<typeof InstructionsSection>;

function apply(
  ctx: OrganizationContext,
  workspaceId: string | null,
  content: InstructionsContent,
) {
  const current = ctx.instructions.readContent(
    ctx.organizationId,
    workspaceId ? { type: "workspace", workspaceId } : { type: "organization" },
  );
  if (same(current.content, content)) return "unchanged" as const;
  ctx.instructions.writeContent(
    ctx.actor,
    workspaceId ? { type: "workspace", workspaceId } : { type: "organization" },
    content,
    current.revision,
  );
  return "changed" as const;
}

export const organizationInstructionsSection =
  organizationSection<InstructionsSection>({
    key: "instructions",
    schema: InstructionsSection,
    export: (ctx) => ({
      version: 1,
      content: ctx.instructions.readContent(ctx.organizationId, {
        type: "organization",
      }).content,
    }),
    apply: (ctx, data, outcome) => {
      outcome.item("Default instructions", () =>
        apply(ctx, null, data.content),
      );
    },
  });

export const workspaceInstructionsSection =
  workspaceSection<InstructionsSection>({
    key: "instructions",
    schema: InstructionsSection,
    export: (ctx) => ({
      version: 1,
      content: ctx.instructions.readContent(ctx.organizationId, {
        type: "workspace",
        workspaceId: ctx.workspaceId,
      }).content,
    }),
    apply: (ctx, data, outcome) => {
      outcome.item("Workspace instructions", () =>
        apply(ctx, ctx.workspaceId, data.content),
      );
    },
  });
