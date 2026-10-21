/** Redact recognizable credentials before clipping diagnostic text. */
export function loopText(value: unknown, limit = 2000) {
  if (typeof value !== "string") return "";
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "[redacted authorization]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
      "[redacted]",
    )
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        if (url.search) url.search = "?redacted";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .slice(0, limit);
}
