import { z } from "zod";
import { LanguageSchema, ScopeSchema } from "./index";

export const SPEECH_PROFILE = "agent-speech/1" as const;
export const SPEECH_TEXT_LENGTH = 2000;
export const SPEECH_AUDIO_BYTES = 6 * 1024 * 1024;
export const SPEECH_BODY_BYTES = 4 * Math.ceil(SPEECH_AUDIO_BYTES / 3) + 4096;
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const SpeechRequestSchema = z.strictObject({
  profile: z.literal(SPEECH_PROFILE),
  requestId: id,
  conversationId: id,
  messageId: id,
  language: LanguageSchema,
});
export type SpeechRequest = z.infer<typeof SpeechRequestSchema>;
export const SpeechAudioSchema = z.strictObject({
  mimeType: z.enum(["audio/wav", "audio/mpeg"]),
  base64: z
    .string()
    .min(4)
    .max(4 * Math.ceil(SPEECH_AUDIO_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((s) => s.length % 4 === 0),
});
export type SpeechAudio = z.infer<typeof SpeechAudioSchema>;
export const SpeechResultSchema = SpeechRequestSchema.extend({
  scope: ScopeSchema,
  audio: SpeechAudioSchema,
});
export const SpeechCapabilitiesSchema = z.strictObject({
  profile: z.literal(SPEECH_PROFILE),
  enabled: z.boolean(),
  model: z.string().min(1).max(200).nullable(),
  processing: z.literal("cloud"),
  maxTextLength: z.literal(SPEECH_TEXT_LENGTH),
});
export type SpeechCapabilities = z.infer<typeof SpeechCapabilitiesSchema>;
