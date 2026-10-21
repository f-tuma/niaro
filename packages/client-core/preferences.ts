import { LanguageSchema, type Language } from "../protocol";
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export const LANGUAGE_KEY = "agent-client.ui-language.v1";
export const SPOKEN_REPLIES_KEY = "agent-client.spoken-replies.v1";
export async function loadSpokenReplies(
  storage: KeyValueStorage,
): Promise<boolean> {
  return (await storage.getItem(SPOKEN_REPLIES_KEY)) !== "off";
}
export async function saveSpokenReplies(
  storage: KeyValueStorage,
  enabled: boolean,
) {
  await storage.setItem(SPOKEN_REPLIES_KEY, enabled ? "on" : "off");
}
export async function loadLanguage(
  storage: KeyValueStorage,
): Promise<Language> {
  const value = LanguageSchema.safeParse(await storage.getItem(LANGUAGE_KEY));
  return value.success ? value.data : "en";
}
export async function saveLanguage(
  storage: KeyValueStorage,
  language: Language,
) {
  await storage.setItem(LANGUAGE_KEY, LanguageSchema.parse(language));
}
const FEEDBACK_KEY = "agent-client.feedback.v1";
/** Interface sounds and haptics; on unless the person turned them off. */
export async function loadFeedback(storage: KeyValueStorage): Promise<boolean> {
  return (await storage.getItem(FEEDBACK_KEY)) !== "off";
}
export async function saveFeedback(storage: KeyValueStorage, enabled: boolean) {
  await storage.setItem(FEEDBACK_KEY, enabled ? "on" : "off");
}
