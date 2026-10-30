import { z } from "zod";
import { ScopeSchema } from "./index";
import { utf8Length } from "./skills";

export const OUTPUT_VOICE_PROFILE = "agent-output-voice/1" as const;
export const OUTPUT_VOICE_UPDATE_BYTES = 2048;
export const OUTPUT_VOICE_SNAPSHOT_BYTES = 32768;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const OutputVoiceOptionIdSchema = z.string().regex(/^ov_[a-f0-9]{64}$/);
const label = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) =>
        value === value.trim() && !/[\u0000-\u001f\u007f<>]/.test(value),
      "Expected a trimmed plain-text label",
    );
export const OutputVoiceChoiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("server-default") }),
  z.strictObject({
    kind: z.literal("catalogue"),
    optionId: OutputVoiceOptionIdSchema,
  }),
]);
export type OutputVoiceChoice = z.infer<typeof OutputVoiceChoiceSchema>;
export const OutputVoiceUpdateSchema = z
  .strictObject({
    profile: z.literal(OUTPUT_VOICE_PROFILE),
    requestId: z.uuid(),
    expectedRevision: revision,
    catalogueRevision: digest,
    choice: OutputVoiceChoiceSchema,
  })
  .refine(
    (value) => utf8Length(JSON.stringify(value)) <= OUTPUT_VOICE_UPDATE_BYTES,
  );
export type OutputVoiceUpdate = z.infer<typeof OutputVoiceUpdateSchema>;
export const OutputVoiceSnapshotSchema = z
  .strictObject({
    profile: z.literal(OUTPUT_VOICE_PROFILE),
    scope: ScopeSchema,
    revision,
    catalogueRevision: digest,
    availability: z.enum([
      "selectable",
      "server-default-only",
      "speech-unavailable",
    ]),
    route: z
      .strictObject({
        identity: digest,
        model: z.string().min(1).max(200),
        method: z.enum(["reader", "speech"]),
      })
      .nullable(),
    serverDefault: z.strictObject({ label: label(200, 1) }).nullable(),
    options: z
      .array(
        z.strictObject({
          optionId: OutputVoiceOptionIdSchema,
          label: label(100, 1),
        }),
      )
      .max(32)
      .refine(
        (options) =>
          new Set(options.map((option) => option.optionId)).size ===
          options.length,
      ),
    saved: z
      .strictObject({ choice: OutputVoiceChoiceSchema, label: label(100) })
      .refine((saved) =>
        saved.choice.kind === "server-default"
          ? saved.label === ""
          : saved.label.length > 0,
      )
      .nullable(),
    effective: z.strictObject({
      choice: OutputVoiceChoiceSchema,
      label: label(200),
      reason: z.enum([
        "server-default",
        "selected",
        "saved-choice-unavailable",
        "speech-unavailable",
      ]),
    }),
  })
  .refine(
    (value) => utf8Length(JSON.stringify(value)) <= OUTPUT_VOICE_SNAPSHOT_BYTES,
  );
export type OutputVoiceSnapshot = z.infer<typeof OutputVoiceSnapshotSchema>;
