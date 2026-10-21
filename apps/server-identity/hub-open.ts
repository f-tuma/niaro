import { parseFragment, type DefaultTreeAdapterTypes as P } from "parse5";
import {
  HUB_DOC_LIMITS,
  HUB_DOC_TAGS,
  HUB_ITEM_TEXT_MAX,
  HubItemDetailSchema,
  type HubDocNode,
  type HubItemDetail,
} from "../../packages/protocol/hub";
import { unwrapMcpText } from "./bounded-preview";

/**
 * One message as a service returned it, read deterministically: the server
 * finds the message object in the read's result, takes its subject, people,
 * date, link and body, and turns an HTML body into plain text and into a
 * bounded, sanitized tree (`doc`) the page renders itself. No model touches
 * the content; the page never receives HTML.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};
function decodeEntities(value: string) {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi,
    (whole, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
          return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

/** HTML as readable plain text: blocks become lines, everything else goes. */
export function htmlToText(html: string) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|blockquote|pre|table|section)\s*>/gi, "\n\n")
    .replace(/<\/(div|li|tr)\s*>/gi, "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(/<\/?[a-z!/][^>]*>/gi, "")
    .replace(/\r\n?/g, "\n");
  return tidy(decodeEntities(text));
}
/** Collapses runs of spaces per line and more than one blank line; trims. */
function tidy(text: string) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const looksLikeHtml = (value: string) =>
  /<\s*(html|body|div|p|br|table|span|a|img|style)\b/i.test(value);

type DocTag = (typeof HUB_DOC_TAGS)[number];
const DOC_TAGS = new Set<string>(HUB_DOC_TAGS);
/** Tags kept under another name. */
const DOC_RENAMED: Record<string, DocTag> = {
  b: "strong",
  i: "em",
  strike: "s",
  del: "s",
  ins: "u",
  tt: "code",
  kbd: "code",
  samp: "code",
  font: "span",
  center: "div",
  section: "div",
  article: "div",
  header: "div",
  footer: "div",
  main: "div",
  nav: "div",
  aside: "div",
  address: "div",
  figure: "div",
  figcaption: "div",
  caption: "div",
  dl: "div",
  dt: "p",
  dd: "p",
  tfoot: "tbody",
};
/** Tags that go with everything inside them. */
const DOC_DROPPED = new Set([
  "style",
  "script",
  "head",
  "title",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "svg",
  "math",
  "noscript",
  "template",
  "link",
  "meta",
  "base",
  "applet",
  "frame",
  "frameset",
  "video",
  "audio",
  "canvas",
  "map",
]);
const DOC_VOID = new Set(["br", "hr", "img"]);
/** True when something readable (text or an image) is inside. */
const hasContent = (node: HubDocNode): boolean =>
  node.t === "text"
    ? node.v.trim().length > 0
    : node.tag === "img" || (node.children ?? []).some(hasContent);
/** Containers where whitespace between children means nothing. */
const DOC_STRUCTURAL = new Set(["ul", "ol", "table", "thead", "tbody", "tr"]);
const docHref = (value: string | undefined) =>
  value &&
  value.length <= 2000 &&
  /^(?:https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i.test(value)
    ? value
    : undefined;
const docSrc = (value: string | undefined) =>
  value && value.length <= 2000 && /^https:\/\/[^\s"'<>]+$/i.test(value)
    ? value
    : undefined;
const docSpan = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
};

/**
 * The HTML body as the page's tree: an allowlist of tags and attributes,
 * safe links only, images over https only, bounded in depth, count and size
 * (`truncated` when something was cut). Entities are decoded by the parser.
 */
export function htmlToDoc(html: string): {
  doc: HubDocNode[];
  truncated: boolean;
} {
  let nodes = 0;
  let bytes = 0;
  let truncated = false;
  const fits = (node: HubDocNode) => {
    const size =
      JSON.stringify(node.t === "el" ? { ...node, children: undefined } : node)
        .length + 2;
    if (nodes >= HUB_DOC_LIMITS.nodes || bytes + size > HUB_DOC_LIMITS.bytes) {
      truncated = true;
      return false;
    }
    nodes++;
    bytes += size;
    return true;
  };
  const text = (value: string, parent: DocTag | null, pre: boolean) => {
    const out: HubDocNode[] = [];
    if (!pre) {
      value = value.replace(/\s+/g, " ");
      if (value === " " && parent !== null && DOC_STRUCTURAL.has(parent))
        return out;
    }
    for (let at = 0; at < value.length; at += HUB_DOC_LIMITS.text) {
      const node: HubDocNode = {
        t: "text",
        v: value.slice(at, at + HUB_DOC_LIMITS.text),
      };
      if (!fits(node)) break;
      out.push(node);
    }
    return out;
  };
  const children = (
    list: P.Node[],
    parent: DocTag | null,
    depth: number,
    pre: boolean,
  ): HubDocNode[] => {
    const out: HubDocNode[] = [];
    for (const child of list) {
      if (truncated && nodes >= HUB_DOC_LIMITS.nodes) break;
      if (child.nodeName === "#text") {
        out.push(...text((child as P.TextNode).value, parent, pre));
        continue;
      }
      if (!("tagName" in child)) continue;
      const element = child as P.Element;
      const name = element.tagName.toLowerCase();
      if (DOC_DROPPED.has(name)) continue;
      const tag: DocTag | undefined = DOC_TAGS.has(name)
        ? (name as DocTag)
        : DOC_RENAMED[name];
      if (!tag) {
        // Unknown: its content stays, the tag goes.
        out.push(...children(element.childNodes, parent, depth, pre));
        continue;
      }
      if (depth >= HUB_DOC_LIMITS.depth) {
        truncated = true;
        continue;
      }
      const attr = (key: string) =>
        element.attrs.find((entry) => entry.name === key)?.value;
      const node: HubDocNode = { t: "el", tag };
      if (tag === "a") {
        const href = docHref(attr("href"));
        if (href) node.href = href;
        else node.tag = "span";
      }
      if (tag === "img") {
        const src = docSrc(attr("src"));
        const alt = attr("alt")?.trim().slice(0, 300);
        if (!src) {
          if (alt) out.push(...text(alt, parent, pre));
          continue;
        }
        node.src = src;
        if (alt) node.alt = alt;
      }
      if (tag === "td" || tag === "th") {
        const colspan = docSpan(attr("colspan"));
        const rowspan = docSpan(attr("rowspan"));
        if (colspan && colspan > 1) node.colspan = colspan;
        if (rowspan && rowspan > 1) node.rowspan = rowspan;
      }
      if (!fits(node)) break;
      if (!DOC_VOID.has(tag)) {
        const inner = children(
          element.childNodes,
          tag,
          depth + 1,
          pre || tag === "pre",
        );
        if (inner.length) node.children = inner;
        else if (tag !== "td" && tag !== "th") {
          // Nothing inside: layout leftovers go.
          nodes--;
          continue;
        }
        // A table row or table with nothing to read is a layout leftover too.
        if (
          (tag === "tr" ||
            tag === "table" ||
            tag === "thead" ||
            tag === "tbody") &&
          !inner.some(hasContent)
        ) {
          nodes--;
          continue;
        }
      }
      out.push(node);
    }
    return out;
  };
  const fragment = parseFragment(html.replace(/\r\n?/g, "\n"));
  return { doc: children(fragment.childNodes, null, 0, false), truncated };
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** "Jane Smith <jane@example.test>", from the shapes services use. */
function person(value: unknown): string | undefined {
  if (typeof value === "string") return str(value);
  if (!isObject(value)) return undefined;
  if (isObject(value.emailAddress)) return person(value.emailAddress);
  const name = str(value.name) ?? str(value.displayName);
  const address = str(value.address) ?? str(value.email);
  return name && address && name !== address
    ? `${name} <${address}>`
    : (name ?? address);
}
function people(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;,]\s*/)
      : [value];
  return list
    .map(person)
    .filter((entry): entry is string => !!entry)
    .slice(0, 10)
    .map((entry) => entry.slice(0, 400));
}
function when(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return isoOf(value > 1e11 ? value : value * 1000);
  const text = str(value);
  if (!text) return undefined;
  return isoOf(/^\d{10,13}$/.test(text) ? Number(text) : Date.parse(text));
}
function isoOf(time: number) {
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function link(value: unknown) {
  const text = str(value);
  return text && /^https?:\/\/[^\s"'<>]+$/i.test(text) && text.length <= 500
    ? text
    : undefined;
}
const BODY_KEYS = [
  "body",
  "content",
  "text",
  "bodyPreview",
  "snippet",
  "description",
] as const;
/** The message's body as plain text, when the object has one. */
/** A body as plain text and, when it was HTML, the HTML for the tree. */
type Body = { text: string; html?: string };
const asBody = (value: string, html: boolean): Body =>
  html
    ? { text: htmlToText(value), html: value }
    : { text: tidy(value.replace(/\r\n?/g, "\n")) };
function body(message: Obj): Body | undefined {
  const inner = message.body;
  if (isObject(inner)) {
    const content = str(inner.content);
    if (content) {
      const type = str(inner.contentType)?.toLowerCase();
      return asBody(
        content,
        type === "html" || (!type && looksLikeHtml(content)),
      );
    }
    // Gmail: a base64url part.
    const data = str(inner.data);
    if (data) return decodePart(data, str(message.mimeType));
  }
  for (const key of BODY_KEYS) {
    const value = str(message[key]);
    if (value) return asBody(value, looksLikeHtml(value));
  }
  return undefined;
}
function decodePart(data: string, mimeType?: string) {
  let decoded: string;
  try {
    decoded = Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  return asBody(
    decoded,
    mimeType?.toLowerCase() === "text/html" || looksLikeHtml(decoded),
  );
}

/** A Gmail-shaped message (`payload.headers`, `payload.parts`) as fields. */
function fromGmail(message: Obj): Obj | undefined {
  const payload = message.payload;
  if (!isObject(payload) || !Array.isArray(payload.headers)) return undefined;
  const header = (name: string) =>
    str(
      (payload.headers as unknown[]).find(
        (entry): entry is Obj =>
          isObject(entry) &&
          typeof entry.name === "string" &&
          entry.name.toLowerCase() === name,
      )?.value,
    );
  const parts = (node: unknown): Obj[] =>
    isObject(node)
      ? [node, ...(Array.isArray(node.parts) ? node.parts.flatMap(parts) : [])]
      : [];
  const all = parts(payload);
  const pick = (type: string) =>
    all.find(
      (part) =>
        str(part.mimeType)?.toLowerCase() === type &&
        isObject(part.body) &&
        str(part.body.data),
    );
  const part = pick("text/plain") ?? pick("text/html");
  const decoded = part
    ? decodePart(
        str((part.body as Obj).data) ?? "",
        str(part.mimeType) ?? undefined,
      )
    : undefined;
  return {
    id: message.id,
    subject: header("subject") ?? "",
    from: header("from"),
    to: header("to"),
    receivedDateTime: when(message.internalDate) ?? header("date"),
    ...(decoded
      ? decoded.html
        ? { body: { contentType: "html", content: decoded.html } }
        : { text: decoded.text }
      : { text: str(message.snippet) }),
    link: message.webLink,
  };
}

/** Objects at most this deep are searched, shallowest first. */
const MAX_DEPTH = 6;
const MAX_NODES = 4000;
/**
 * The message object in a read result: the one with `id === ref` when there
 * is one, else the only message-like object (a subject and a body) when the
 * result holds exactly one and it names no other id. A list without the
 * asked id, or a result too large to search whole, holds no answer: another
 * email must never be kept as this one.
 */
function findMessage(root: unknown, ref: string): Obj | undefined {
  let only: Obj | undefined;
  let found = 0;
  let nodes = 0;
  let level: unknown[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: unknown[] = [];
    for (const value of level) {
      if (++nodes > MAX_NODES) return undefined;
      if (Array.isArray(value)) {
        next.push(...value.slice(0, 200));
        continue;
      }
      if (!isObject(value)) continue;
      const message = isObject(value.payload) ? fromGmail(value) : value;
      if (message && isMessage(message)) {
        const id = str(value.id);
        if (id === ref) return message;
        found++;
        only = id === undefined ? message : undefined;
      }
      next.push(...Object.values(value).slice(0, 80));
    }
    level = next;
  }
  return found === 1 ? only : undefined;
}
const isMessage = (value: Obj) =>
  (typeof value.subject === "string" || typeof value.title === "string") &&
  body(value) !== undefined;

/**
 * The message `ref` in a service's read result, as the page shows it, or
 * null when the result holds no message. The text is bounded; HTML never
 * passes through.
 */
export function extractHubItemDetail(
  raw: unknown,
  ref: string,
): HubItemDetail | null {
  const message = findMessage(unwrapMcpText(raw), ref);
  if (!message) return null;
  const content = body(message) ?? { text: "" };
  const full = content.text;
  const tree = content.html ? htmlToDoc(content.html) : undefined;
  const truncated = full.length > HUB_ITEM_TEXT_MAX || !!tree?.truncated;
  const to = people(message.toRecipients ?? message.to ?? message.recipients);
  const at =
    when(message.receivedDateTime) ??
    when(message.receivedAt) ??
    when(message.sentDateTime) ??
    when(message.date) ??
    when(message.internalDate);
  const detail = HubItemDetailSchema.safeParse({
    subject: (str(message.subject) ?? str(message.title) ?? "").slice(0, 1000),
    from: (
      person(message.from) ??
      person(message.sender) ??
      person(message.author) ??
      ""
    ).slice(0, 400),
    ...(to.length ? { to } : {}),
    ...(at ? { at } : {}),
    text: full.slice(0, HUB_ITEM_TEXT_MAX),
    ...(tree?.doc.length ? { doc: tree.doc } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    ...((link(message.webLink) ?? link(message.link) ?? link(message.url))
      ? {
          link:
            link(message.webLink) ?? link(message.link) ?? link(message.url),
        }
      : {}),
  });
  return detail.success ? detail.data : null;
}
