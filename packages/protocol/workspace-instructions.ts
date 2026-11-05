import { z } from "zod";
import { IdentityId } from "./identity";

/**
 * Workspace instructions: Markdown an owner or administrator writes for a
 * workspace (tone, conventions, company facts), with up to six starter
 * prompts for the empty chat. The organization keeps a default that a
 * workspace uses while its own text (or its own starters) is empty. Like a
 * skill, instructions are data: they shape how the assistant writes and
 * works, they never grant permission or override approvals and policies.
 */
export const INSTRUCTIONS_PROFILE = "workspace-instructions/1" as const;
export const INSTRUCTIONS_LIMITS = Object.freeze({
  /** Characters of instruction text per workspace or organization default. */
  text: 8000,
  starters: 6,
  /** Characters of one starter prompt. */
  starter: 200,
  /** Versions listed in the editor's history, newest first. */
  history: 50,
});
/**
 * Variables the server fills in at turn time in workspace instructions,
 * skills and process prompts. Anything else in braces stays as typed.
 */
export const PROMPT_VARIABLES = [
  "{person.name}",
  "{person.role}",
  "{workspace.name}",
  "{company.name}",
  "{today}",
  "{language}",
] as const;

// Tabs and line breaks are text; other control characters are refused.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
export const InstructionsTextSchema = z
  .string()
  .max(INSTRUCTIONS_LIMITS.text)
  .refine((value) => !CONTROL.test(value), "Text only");
export const StarterSchema = z
  .string()
  .trim()
  .min(1)
  .max(INSTRUCTIONS_LIMITS.starter)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "One line");
export const InstructionsContentSchema = z.strictObject({
  text: InstructionsTextSchema,
  starters: z
    .array(StarterSchema)
    .max(INSTRUCTIONS_LIMITS.starters)
    .refine(
      (starters) =>
        new Set(starters.map((starter) => starter.toLocaleLowerCase())).size ===
        starters.length,
      "Starters repeat",
    ),
});
export type InstructionsContent = z.infer<typeof InstructionsContentSchema>;

/** The organization default or one workspace. */
export const InstructionsScopeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("organization") }),
  z.strictObject({ type: z.literal("workspace"), workspaceId: IdentityId }),
]);
export type InstructionsScope = z.infer<typeof InstructionsScopeSchema>;

export const InstructionsVersionSchema = z.strictObject({
  revision: z.number().int().positive(),
  content: InstructionsContentSchema,
  event: z.enum(["saved", "restored"]),
  /** The revision a restore brought back. */
  restoredFrom: z.number().int().positive().optional(),
  authorName: z.string().max(200).nullable(),
  createdAt: z.iso.datetime(),
});
export type InstructionsVersion = z.infer<typeof InstructionsVersionSchema>;

/** `POST /admin/api/identity/instructions/get`: owners and administrators. */
export const InstructionsAdminViewSchema = z.strictObject({
  profile: z.literal(INSTRUCTIONS_PROFILE),
  organizationId: IdentityId,
  scope: InstructionsScopeSchema,
  /** 0 before the first save. */
  revision: z.number().int().nonnegative(),
  content: InstructionsContentSchema,
  updatedAt: z.iso.datetime().nullable(),
  updatedByName: z.string().max(200).nullable(),
  /** For a workspace: what applies while its own text or starters are empty. */
  organizationDefault: InstructionsContentSchema.optional(),
  history: z.array(InstructionsVersionSchema).max(INSTRUCTIONS_LIMITS.history),
});
export type InstructionsAdminView = z.infer<typeof InstructionsAdminViewSchema>;

/** `POST /admin/api/identity/instructions/command`. */
export const InstructionsCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("save"),
    scope: InstructionsScopeSchema,
    /** The revision the editor started from (0 for the first save). */
    revision: z.number().int().nonnegative(),
    content: InstructionsContentSchema,
  }),
  z.strictObject({
    type: z.literal("restore"),
    scope: InstructionsScopeSchema,
    revision: z.number().int().positive(),
    /** The older version to bring back as a new revision. */
    version: z.number().int().positive(),
  }),
]);
export type InstructionsCommand = z.infer<typeof InstructionsCommandSchema>;

/**
 * `GET /v1/:workspace/instructions` (and the browser twin
 * `instructions/effective`): what applies in this workspace now, read-only.
 * Text and starters each fall back to the organization default separately.
 */
export const WorkspaceChatSetupSchema = z.strictObject({
  profile: z.literal(INSTRUCTIONS_PROFILE),
  workspaceId: IdentityId,
  instructions: z
    .strictObject({
      text: InstructionsTextSchema.refine((value) => value.trim().length > 0),
      source: z.enum(["workspace", "organization"]),
    })
    .nullable(),
  starters: z.array(StarterSchema).max(INSTRUCTIONS_LIMITS.starters),
});
export type WorkspaceChatSetup = z.infer<typeof WorkspaceChatSetupSchema>;
