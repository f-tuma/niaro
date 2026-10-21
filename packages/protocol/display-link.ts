import { z } from "zod";

export type DisplayLinkKind = "phone" | "email" | "url";
export type DisplayLink = { kind: DisplayLinkKind; href: string };

const email = z.email().max(254);
const control = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/;
const phoneLabels = new Set([
  "phone",
  "phone number",
  "telephone",
  "telephone number",
  "mobile",
  "mobile phone",
  "mobile number",
  "primary phone number",
  "tel",
  "telefon",
  "telefonni cislo",
  "mobil",
  "mobilni telefon",
  "mobilni cislo",
]);

/** Conservative semantics for server-projected scalar fields, never number heuristics. */
export function displayFieldIcon(
  label: string,
  value: string,
): "phone" | "mail" | "link" | undefined {
  const normalized = label
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ");
  if (phoneLabels.has(normalized) && displayLink(value, "phone"))
    return "phone";
  const link = displayLink(value);
  return link?.kind === "email"
    ? "mail"
    : link?.kind === "url"
      ? "link"
      : undefined;
}

/** A destination is derived from the complete visible value, never separate hidden data. */
export function displayLink(
  value: string,
  kind?: DisplayLinkKind,
): DisplayLink | undefined {
  const visible = value.trim();
  if (!visible || visible.length > 4000 || control.test(value)) return;
  if (kind === "phone") {
    // Only explicitly identified telephone fields get dialer links. IDs and
    // ordinary numbers never become calls; USSD and extension commands are excluded.
    if (!/^\+?[0-9(][0-9 ().-]{2,62}$/.test(visible)) return;
    const number = visible.replace(/[ ().-]/g, "");
    if (!/^\+?[0-9]{3,15}$/.test(number)) return;
    return { kind: "phone", href: `tel:${number}` };
  }
  if (/\s/.test(visible)) return;
  if (
    (kind === undefined || kind === "email") &&
    email.safeParse(visible).success
  )
    return {
      kind: "email",
      href: `mailto:${encodeURIComponent(visible).replace(/%40/g, "@")}`,
    };
  if (kind !== undefined && kind !== "url") return;
  if (!/^https?:\/\//i.test(visible) || visible.includes("\\")) return;
  try {
    const url = new URL(visible);
    if (!url.hostname || url.username || url.password) return;
    return { kind: "url", href: url.href };
  } catch {
    return;
  }
}
