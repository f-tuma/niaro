import type { Language } from "../protocol";

export type FollowUpField = {
  label: string;
  kind: "text" | "select" | "checkbox" | "date";
};
/** Labels of the form fields a renderer has shown, by `form/name`. */
export type FollowUpFields = ReadonlyMap<string, FollowUpField>;
export const followUpKey = (form: string | undefined, name: string) =>
  `${form ?? ""}/${name}`;

const unwrap = (entry: unknown) =>
  entry &&
  typeof entry === "object" &&
  !Array.isArray(entry) &&
  "value" in entry
    ? (entry as { value: unknown }).value
    : entry;

/**
 * The message a @ToAssistant step puts in the person's message box: the
 * step's own words, then each answered field as "Label: value". The person
 * reads and sends it; nothing travels that they cannot see.
 */
export function followUpMessage({
  message,
  formName,
  formState,
  fields,
  language,
}: {
  message: string;
  formName?: string;
  formState?: Record<string, unknown>;
  fields: FollowUpFields;
  language: Language;
}): string {
  const form = formName ? unwrap(formState?.[formName]) : undefined;
  const lines = [message.trim()];
  if (form && typeof form === "object" && !Array.isArray(form)) {
    const values = form as Record<string, unknown>;
    // Answers follow the fields as shown; unlabelled state comes last.
    const shownOrder = [...fields.keys()]
      .filter((key) => key.startsWith(followUpKey(formName, "")))
      .map((key) => key.slice(followUpKey(formName, "").length));
    const names = [
      ...shownOrder.filter((name) => name in values),
      ...Object.keys(values).filter((name) => !shownOrder.includes(name)),
    ];
    for (const name of names) {
      const value = unwrap(values[name]);
      const field = fields.get(followUpKey(formName, name));
      if (value === undefined || value === null) continue;
      const shown =
        typeof value === "boolean"
          ? language === "cs"
            ? value
              ? "ano"
              : "ne"
            : value
              ? "yes"
              : "no"
          : String(value).trim();
      if (shown) lines.push(`${field?.label ?? name}: ${shown}`);
    }
  }
  return lines.filter(Boolean).join("\n").slice(0, 4000);
}
