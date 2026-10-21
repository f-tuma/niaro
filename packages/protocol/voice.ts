import { z } from "zod";
import { LanguageSchema, ScopeSchema } from "./index";

/** Optional, separately negotiated extension; existing workflow commands are unchanged. */
export const VOICE_PROFILE = "agent-voice/5" as const;
export const VOICE_SECONDS = 120;
export const VOICE_BYTES = 8 * 1024 * 1024;
export const VOICE_BODY_BYTES = 4 * Math.ceil(VOICE_BYTES / 3) + 8192;
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const VoiceQuestionContextSchema = z.strictObject({
  conversationId: id,
  workItemId: id,
  inputRequestId: id,
  expectedInputRevision: z.number().int().positive(),
});
export const VoiceContextSchema = z.union([
  VoiceQuestionContextSchema,
  z.strictObject({ conversationId: id }),
]);
export type VoiceContext = z.infer<typeof VoiceContextSchema>;
export const VoiceAudioSchema = z.strictObject({
  mimeType: z.enum(["audio/wav", "audio/mp4", "audio/webm"]),
  base64: z
    .string()
    .min(4)
    .max(4 * Math.ceil(VOICE_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((value) => value.length % 4 === 0),
});
export type VoiceAudio = z.infer<typeof VoiceAudioSchema>;
export const VoiceRequestSchema = z.strictObject({
  profile: z.literal(VOICE_PROFILE),
  requestId: id,
  /** Interface/review locale; transcribers detect the spoken language from audio. */
  language: LanguageSchema,
  context: VoiceContextSchema,
  audio: VoiceAudioSchema,
  stopReason: z.enum(["user", "silence", "limit"]).optional(),
});
export type VoiceRequest = z.infer<typeof VoiceRequestSchema>;
export const VoiceTranscriptSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  reviewReasons: z
    .array(z.enum(["uncertain", "repetition", "limit"]))
    .max(3)
    .refine((reasons) => new Set(reasons).size === reasons.length),
});
export type VoiceTranscript = z.infer<typeof VoiceTranscriptSchema>;
export const VoiceResultSchema = z.strictObject({
  profile: z.literal(VOICE_PROFILE),
  requestId: id,
  scope: ScopeSchema,
  context: VoiceContextSchema,
  language: LanguageSchema,
  ...VoiceTranscriptSchema.shape,
});
const capabilityFields = {
  profile: z.literal(VOICE_PROFILE),
  enabled: z.boolean(),
  languages: z.tuple([z.literal("en"), z.literal("cs")]),
  maxSeconds: z.literal(VOICE_SECONDS),
};
export const VoiceCapabilitiesSchema = z.discriminatedUnion("engine", [
  z.strictObject({
    ...capabilityFields,
    engine: z.literal("whisper.cpp"),
    model: z.literal("small"),
    processing: z.literal("connected_server"),
  }),
  z.strictObject({
    ...capabilityFields,
    engine: z.literal("openrouter"),
    model: z.string().min(1).max(200),
    processing: z.literal("cloud"),
  }),
]);
export type VoiceCapabilities = z.infer<typeof VoiceCapabilitiesSchema>;
export type VoiceEngine = VoiceCapabilities["engine"];
export const voiceCapabilities = (
  enabled: boolean,
  engine: VoiceEngine = "whisper.cpp",
  model?: string,
) =>
  VoiceCapabilitiesSchema.parse({
    profile: VOICE_PROFILE,
    enabled,
    engine,
    model:
      engine === "openrouter"
        ? (model ?? "google/gemini-3.1-flash-lite")
        : "small",
    processing: engine === "openrouter" ? "cloud" : "connected_server",
    languages: ["en", "cs"],
    maxSeconds: VOICE_SECONDS,
  });
