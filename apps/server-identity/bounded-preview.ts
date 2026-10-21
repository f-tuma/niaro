/**
 * A service result small enough for a model prompt that still says what is
 * there: long lists keep their first items and their full length, long text is
 * cut, and an MCP text block holding JSON is read as that JSON. The preview is
 * marked so the model knows it is not the whole result.
 */
export function boundedPreview(value: unknown, maxBytes = 4000): unknown {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "");
  if (size(value) <= maxBytes) return value;
  for (const items of [5, 3, 1, 0])
    for (const text of [400, 160, 60]) {
      const preview = shrink(readMcp(value), items, text, 0);
      if (size(preview) <= maxBytes)
        return { preview, truncated: true, note: TRUNCATED };
    }
  return { truncated: true, note: TRUNCATED };
}
const TRUNCATED =
  "The result was too large and is shortened: lists keep their first items and their total length. Answer from it, or call with a narrower input for details.";

/**
 * An MCP tools/call result whose single text block is JSON, as that JSON;
 * other text becomes `{ text }`. Anything else passes through unchanged.
 */
export function unwrapMcpText(value: unknown): unknown {
  return readMcp(value);
}
function readMcp(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray(value.content)
  ) {
    const texts = value.content.filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string",
    );
    if (texts.length === 1)
      try {
        return JSON.parse(texts[0]!.text) as unknown;
      } catch {
        return { text: texts[0]!.text };
      }
  }
  return value;
}

function shrink(
  value: unknown,
  items: number,
  text: number,
  depth: number,
): unknown {
  if (typeof value === "string")
    return value.length > text ? value.slice(0, text) + "…" : value;
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, items)
      .map((item) => shrink(item, items, text, depth + 1));
    return value.length > items
      ? { items: kept, total: value.length, shown: kept.length }
      : kept;
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [key, shrink(item, items, text, depth + 1)]),
  );
}
