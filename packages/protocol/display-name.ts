/**
 * Turns a machine identifier such as `list-mail-messages`, `search_people`
 * or `getCalendarView` into a readable sentence-case name. Names that already
 * contain spaces were written for people and are returned unchanged.
 */
export function readableName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;
  const words = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_.:/]+|\s+/)
    .filter(Boolean)
    // Acronyms such as CRM or ID stay as written; other words read as prose.
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Model IDs such as `google/gemini-3.1-flash-lite` read as "Gemini 3.1 Flash
 * Lite". The provider prefix is routing detail, not something people choose by.
 */
export function modelName(value: string): string {
  const id = value.trim().split("/").at(-1) ?? "";
  if (!id || /\s/.test(id)) return id;
  return id
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((word) =>
      /^(gpt|ai|tts|llm|xl)$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}
