import { z } from "zod";
import { IdentityId } from "./identity";

/**
 * Skills: know-how for the agent. A named skill says when it is useful
 * (`description`) and how to do the task (`instructions`, Markdown), with up
 * to five small text files (a template, a price list, …). A skill is data:
 * it guides how the agent works, it never grants permission or replaces the
 * server's rules. Company skills belong to the workspace and administrators
 * manage them; personal skills belong to one person.
 */
export const SKILLS_PROFILE = "agent-skills/1" as const;
export const SKILL_LIMITS = Object.freeze({
  name: 80,
  description: 300,
  instructionsBytes: 32 * 1024,
  files: 5,
  fileBytes: 64 * 1024,
  filesTotalBytes: 160 * 1024,
  /** Active (not archived) skills one person owns in a workspace. */
  personalPerPerson: 100,
  /** Active company skills in a workspace. */
  workspacePerWorkspace: 200,
  /** Skills the agent sees by name and description in one turn. */
  listedForAgent: 30,
  /** Distinct skills loaded into one turn (tool loads and @mentions). */
  loadsPerTurn: 4,
});
/** Text a person can read; files with these endings only (no binaries, no scripts). */
export const SKILL_FILE_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
] as const;

/** UTF-8 size without relying on Buffer or TextEncoder (mobile and web share this). */
export function utf8Length(value: string) {
  let length = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}
// Tabs and line breaks are text; other control characters mark binary data.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const text = (bytes: number) =>
  z
    .string()
    .refine((value) => !CONTROL.test(value), "Text only")
    .refine((value) => utf8Length(value) <= bytes, "Too long");

export const SkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_LIMITS.name)
  .refine((value) => !CONTROL.test(value), "Text only");
export const SkillDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_LIMITS.description)
  .refine((value) => !CONTROL.test(value), "Text only");
export const SkillInstructionsSchema = text(
  SKILL_LIMITS.instructionsBytes,
).refine((value) => value.trim().length > 0, "Required");
export const SkillFileNameSchema = z
  .string()
  // Latin letters with diacritics; no Unicode property escapes (older mobile engines).
  .regex(/^[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F ._()-]{0,79}$/)
  .refine((value) => {
    const extension = value.split(".").at(-1)?.toLowerCase();
    return (
      value.includes(".") &&
      (SKILL_FILE_EXTENSIONS as readonly string[]).includes(extension ?? "")
    );
  }, "Unsupported file type");
export const SkillFileSchema = z.strictObject({
  name: SkillFileNameSchema,
  content: text(SKILL_LIMITS.fileBytes),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

const contentShape = {
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  instructions: SkillInstructionsSchema,
  files: z.array(SkillFileSchema).max(SKILL_LIMITS.files).default([]),
};
const filesFit = (files: SkillFile[]) =>
  new Set(files.map((file) => file.name.toLowerCase())).size === files.length &&
  files.reduce((total, file) => total + utf8Length(file.content), 0) <=
    SKILL_LIMITS.filesTotalBytes;
/** What a skill says; shared by saving, proposals from chat and the editor. */
export const SkillContentSchema = z
  .strictObject(contentShape)
  .refine((value) => filesFit(value.files), {
    message: "Files must have distinct names and fit the total limit",
    path: ["files"],
  });
export type SkillContent = z.infer<typeof SkillContentSchema>;

export const SkillOwnerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("workspace") }),
  z.strictObject({ type: z.literal("user"), userId: IdentityId }),
]);
export type SkillOwner = z.infer<typeof SkillOwnerSchema>;
const iso = z.iso.datetime();

export const SkillSchema = z.strictObject({
  id: IdentityId,
  owner: SkillOwnerSchema,
  ...contentShape,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: iso,
  updatedAt: iso,
});
export type Skill = z.infer<typeof SkillSchema>;
export const SkillSummarySchema = z.strictObject({
  id: IdentityId,
  owner: SkillOwnerSchema,
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  updatedAt: iso,
  files: z.array(SkillFileNameSchema).max(SKILL_LIMITS.files),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** The person's own skills and the company skills they may see. */
export const SkillListSchema = z.strictObject({
  profile: z.literal(SKILLS_PROFILE),
  /** Owners and administrators manage company skills. */
  canManageWorkspace: z.boolean(),
  personal: z.array(SkillSummarySchema).max(SKILL_LIMITS.personalPerPerson),
  workspace: z
    .array(SkillSummarySchema)
    .max(SKILL_LIMITS.workspacePerWorkspace),
});
export type SkillList = z.infer<typeof SkillListSchema>;

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Changes from the editors (console and web app). */
export const SkillCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    profile: z.literal(SKILLS_PROFILE),
    type: z.literal("save"),
    /** Absent for a new skill; `revision` is then 0. */
    id: IdentityId.optional(),
    revision,
    /** Only for a new skill; the owner never changes. */
    owner: z.enum(["personal", "workspace"]).optional(),
    content: SkillContentSchema,
    enabled: z.boolean(),
  }),
  z.strictObject({
    profile: z.literal(SKILLS_PROFILE),
    type: z.literal("setEnabled"),
    id: IdentityId,
    revision,
    enabled: z.boolean(),
  }),
  z.strictObject({
    profile: z.literal(SKILLS_PROFILE),
    type: z.literal("archive"),
    id: IdentityId,
    revision,
  }),
]);
export type SkillCommand = z.infer<typeof SkillCommandSchema>;

/**
 * A skill the assistant drafted in chat. Nothing is saved until the person
 * accepts it; the server keeps the full content under `proposalId`.
 */
export const SkillProposalResultSchema = z.strictObject({
  type: z.literal("skill.proposal"),
  version: z.literal(1),
  proposalId: IdentityId,
  name: z.string().min(1).max(SKILL_LIMITS.name),
  description: z.string().min(1).max(SKILL_LIMITS.description),
  /** The beginning of the instructions, for review in the card. */
  preview: z.string().max(1500),
  /** File names that come with it. */
  files: z.array(z.string().min(1).max(80)).max(SKILL_LIMITS.files),
  /** The person may also save it for the whole company. */
  workspaceAllowed: z.boolean(),
});
export type SkillProposalResult = z.infer<typeof SkillProposalResultSchema>;

/** Saving a proposal: an authenticated, idempotent command over the app API. */
export const SkillProposalAcceptSchema = z.strictObject({
  profile: z.literal(SKILLS_PROFILE),
  type: z.literal("accept"),
  proposalId: IdentityId,
  target: z.enum(["personal", "workspace"]),
});
export type SkillProposalAccept = z.infer<typeof SkillProposalAcceptSchema>;
export const SkillProposalStatusSchema = z.strictObject({
  profile: z.literal(SKILLS_PROFILE),
  proposalId: IdentityId,
  status: z.enum(["open", "saved"]),
  /** Where it was saved, once saved. */
  target: z.enum(["personal", "workspace"]).optional(),
  skillId: IdentityId.optional(),
});
export type SkillProposalStatus = z.infer<typeof SkillProposalStatusSchema>;
