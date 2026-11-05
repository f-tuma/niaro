/**
 * Prompt variables: a fixed set of placeholders the server fills in at turn
 * time in workspace instructions, skill instructions and process prompts.
 * Values come only from the person the turn runs for and their own workspace
 * and organization; no variable names or reads anyone else. The text is
 * scanned once, so a value that itself looks like a variable stays literal,
 * and anything in braces that is not listed here stays exactly as typed.
 */
export type PromptVariableValues = {
  /** The person's own display name. */
  personName?: string;
  /** The job title the person confirmed on their profile, if any. */
  personRole?: string;
  workspaceName?: string;
  companyName?: string;
};
export type PromptTurn = {
  /** The person's IANA time zone for `{today}`. */
  timeZone: string;
  /** The app language; unknown for runs that carry none. */
  language?: "en" | "cs";
  now: number;
};

const VARIABLE =
  /\{(person\.name|person\.role|workspace\.name|company\.name|today|language)\}/gu;
/** One line, bounded: a value can't add structure to the prompt. */
const clean = (value: string | undefined) =>
  (value ?? "")
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);

/** The person's calendar day in their time zone, as `YYYY-MM-DD`. */
export function localDate(now: number, timeZone: string) {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

/**
 * Fills the known variables. A known variable without a value (no confirmed
 * job title, say) becomes empty; `usedRole` tells the caller the confirmed
 * job title (profile data) reached the text.
 */
export function resolvePromptVariables(
  text: string,
  values: PromptVariableValues,
  turn: PromptTurn,
) {
  let usedRole = false;
  const resolved = text.replace(VARIABLE, (_match, name: string) => {
    switch (name) {
      case "person.name":
        return clean(values.personName);
      case "person.role":
        usedRole ||= !!clean(values.personRole);
        return clean(values.personRole);
      case "workspace.name":
        return clean(values.workspaceName);
      case "company.name":
        return clean(values.companyName);
      case "today":
        return localDate(turn.now, turn.timeZone);
      default:
        return turn.language === "cs"
          ? "Czech"
          : turn.language === "en"
            ? "English"
            : "the person's language";
    }
  });
  return { text: resolved, usedRole };
}
