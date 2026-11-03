/**
 * Fits a read's result into the receipt budget instead of failing it
 * (NIAR-281). An Outlook message with a long quoted history, or a long list,
 * keeps its start: the newest reply sits at the top of a mail body and a
 * list comes newest first. Every cut string ends with a marker, and the
 * result says `truncated: true` at its top, as the model's own projection
 * of a result does.
 *
 * Only reads are fitted. A write's receipt is evidence of what the service
 * did and is never cut.
 */
export const TRUNCATION_MARKER = "… [truncated]";

/** A JSON document carried as an MCP text block, fitted as data. */
class JsonText {
  constructor(readonly value: unknown) {}
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function decode(value: unknown, depth: number): unknown {
  if (depth > 24) return value;
  if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1));
  if (!record(value)) return value;
  if (value.type === "text" && typeof value.text === "string") {
    const text = value.text.trimStart();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return {
          ...value,
          text: new JsonText(decode(JSON.parse(value.text), depth + 1)),
        };
      } catch {
        /* Plain text is cut as a string. */
      }
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item, depth + 1)]),
  );
}

function shrink(
  value: unknown,
  text: number,
  items: number,
  depth: number,
  cut: { done: boolean },
): unknown {
  if (value instanceof JsonText)
    return JSON.stringify(shrink(value.value, text, items, depth + 1, cut));
  if (typeof value === "string") {
    if (value.length <= text) return value;
    cut.done = true;
    return value.slice(0, text) + TRUNCATION_MARKER;
  }
  if (depth > 24 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (value.length > items) cut.done = true;
    return value
      .slice(0, items)
      .map((item) => shrink(item, text, items, depth + 1, cut));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      shrink(item, text, items, depth + 1, cut),
    ]),
  );
}

/** Marks the data the model reads: the inner JSON of an MCP text block, or the result itself. */
function mark(value: unknown): unknown {
  if (record(value) && Array.isArray(value.content)) {
    const texts = value.content.filter(
      (block): block is Record<string, unknown> =>
        record(block) && block.type === "text",
    );
    const only = texts.length === 1 ? texts[0]!.text : undefined;
    if (only instanceof JsonText)
      return {
        ...value,
        content: value.content.map((block) =>
          block === texts[0]
            ? { ...texts[0], text: new JsonText(mark(only.value)) }
            : block,
        ),
      };
  }
  if (record(value))
    return "truncated" in value ? value : { ...value, truncated: true };
  return value;
}

/**
 * The result cut to at most `maxCharacters` of JSON, or undefined when even
 * the smallest cut does not fit (the read then fails as too large).
 */
export function fitReadResult(value: unknown, maxCharacters: number): unknown {
  if (JSON.stringify(value).length <= maxCharacters) return value;
  const decoded = mark(decode(value, 0));
  let text = Math.max(256, Math.floor(maxCharacters / 4));
  let items = 200;
  for (let attempt = 0; attempt < 12; attempt++) {
    const cut = { done: false };
    const fitted = shrink(decoded, text, items, 0, cut);
    if (cut.done && JSON.stringify(fitted).length <= maxCharacters)
      return fitted;
    text = Math.max(32, Math.floor(text / 2));
    items = Math.max(1, Math.floor(items / 2));
  }
  return undefined;
}
