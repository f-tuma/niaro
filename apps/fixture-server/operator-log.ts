/**
 * Structured operator log: one JSON object per line on stdout, enabled with
 * NIARO_LOG=1 (the container image sets it). Callers pass only fixed event
 * names and scalar diagnostics: never credentials, tokens, prompts, message
 * content, email addresses or client IPs.
 */
export function operatorLogEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NIARO_LOG === "1";
}

type Scalar = string | number | boolean | null | undefined;

export function operatorLog(
  event: string,
  fields: Record<string, Scalar>,
  level: "info" | "warn" | "error" = "info",
) {
  if (!operatorLogEnabled()) return;
  const line: Record<string, Scalar> = {
    time: new Date().toISOString(),
    level,
    event,
  };
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) line[key] = value;
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * The route shape of a request path for logs. The query string is dropped and
 * every segment that could be an identifier or a credential (mixed case,
 * several digits, encoded characters, long values) becomes `:id`, so reset,
 * invitation or callback tokens carried in a path never reach the log.
 */
export function loggedPath(url: string | undefined) {
  const path = (url ?? "/").split(/[?#]/, 1)[0] ?? "/";
  return path
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      const digits = segment.replace(/\D/g, "").length;
      return /^[a-z.][a-z0-9._-]*$/.test(segment) &&
        segment.length <= 40 &&
        digits <= 2
        ? segment
        : ":id";
    })
    .join("/")
    .slice(0, 200);
}
