import type { DispatchGuard, IntegrationTransport } from "./transport";

const MAX_BYTES = 128 * 1024;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function dimensions(width: number, height: number) {
  return width > 0 && height > 0 && width <= 1024 && height <= 1024;
}
/** Only bounded raster formats. Never return HTML or active SVG as image data. */
export function faviconData(bytes: Buffer): string | null {
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  let type: string;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(png)) {
    if (
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      !dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    )
      return null;
    type = "png";
  } else if (
    bytes.length >= 13 &&
    /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))
  ) {
    if (!dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) return null;
    type = "gif";
  } else if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x00010000) {
    const count = bytes.readUInt16LE(4);
    if (count < 1 || count > 64 || bytes.length < 6 + count * 16) return null;
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16,
        length = bytes.readUInt32LE(entry + 8),
        offset = bytes.readUInt32LE(entry + 12);
      if (
        offset < 6 + count * 16 ||
        length < 16 ||
        offset + length > bytes.length
      )
        return null;
      const frame = bytes.subarray(offset, offset + length);
      if (frame.subarray(0, 8).equals(png)) {
        if (!faviconData(frame)) return null;
      } else if (
        frame.length < 40 ||
        frame.readUInt32LE(0) !== 40 ||
        !dimensions(frame.readInt32LE(4), Math.abs(frame.readInt32LE(8)) / 2)
      )
        return null;
    }
    type = "x-icon";
  } else return null;
  return `data:image/${type};base64,${bytes.toString("base64")}`;
}
function iconLinks(html: string, origin: string) {
  const candidates: string[] = [];
  // Scan bounded markup as inert text. Only explicit same-origin icon links are eligible.
  for (const tag of html.matchAll(/<link\b[^<>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attribute of tag[0].matchAll(
      /\s([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      attrs.set(
        attribute[1]!.toLowerCase(),
        attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      );
    }
    if (
      !(attrs.get("rel") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .some((r) => r === "icon" || r === "apple-touch-icon")
    )
      continue;
    try {
      const href = attrs.get("href");
      if (!href) continue;
      const url = new URL(href.replaceAll("&amp;", "&"), origin + "/");
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.href.length > 2048 ||
        url.pathname.endsWith(".svg")
      )
        continue;
      if (!candidates.includes(url.href)) candidates.push(url.href);
      if (candidates.length === 3) break;
    } catch {
      /* Ignore malformed remote metadata. */
    }
  }
  return candidates;
}
export async function loadFavicon(
  transport: IntegrationTransport,
  serviceUrl: string,
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
): Promise<string | null> {
  const origin = new URL(serviceUrl).origin;
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  async function image(url: string) {
    const result = await transport({
      url,
      signal: boundedSignal,
      beforeDispatch,
      responseType: "bytes",
      maxResponseBytes: MAX_BYTES,
      headers: {
        Accept: "image/png,image/x-icon,image/vnd.microsoft.icon,image/gif",
      },
    });
    return result.status === 200 && result.bytes
      ? faviconData(result.bytes)
      : null;
  }
  try {
    const conventional = await image(origin + "/favicon.ico");
    if (conventional) return conventional;
  } catch {
    /* A missing/unsupported favicon must not break service rendering. */
  }
  if (boundedSignal.aborted) return null;
  try {
    const page = await transport({
      url: origin + "/",
      signal: boundedSignal,
      beforeDispatch,
      maxResponseBytes: MAX_BYTES,
      headers: { Accept: "text/html" },
    });
    if (
      page.status !== 200 ||
      !page.headers["content-type"]?.toLowerCase().startsWith("text/html")
    )
      return null;
    for (const url of iconLinks(page.text, origin)) {
      if (boundedSignal.aborted) break;
      try {
        const data = await image(url);
        if (data) return data;
      } catch {
        /* Try the next same-origin raster candidate. */
      }
    }
  } catch {
    /* Render the configured symbol instead. */
  }
  return null;
}
