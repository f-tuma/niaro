import { z } from "zod";
import type { Language } from "../../packages/protocol";
import {
  ServicePresentationSchema,
  type ServicePresentation,
} from "../../packages/protocol/service-presentation";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max - 1) + "…" : value;
const text = (value: unknown, max = 160) => {
  const result = string(value);
  return result ? clip(result, max) : undefined;
};
const email = z.email().max(254);
const timestamp = z.iso
  .datetime({ offset: true })
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
const envelopes = new Set([
  "data",
  "result",
  "results",
  "items",
  "records",
  "nodes",
  "edges",
  "people",
  "contacts",
  "person",
  "contact",
  "events",
  "event",
]);
const metadata = new Set([
  "total",
  "totalCount",
  "count",
  "hasMore",
  "pageInfo",
  "nextCursor",
  "cursor",
  "limit",
  "offset",
  "page",
  "success",
  "status",
  "message",
  "hasNextPage",
  "recordReferences",
  "__typename",
]);
const sensitive =
  /^(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credentials|private[_-]?key)$/i;
type Unwrapped = {
  value: unknown;
  hint?: string;
  more: boolean;
  total?: number;
};

/** Recognize data envelopes only. No execution, inference, URLs, or provider calls. */
function unwrap(input: unknown): Unwrapped {
  let value = input;
  let hint: string | undefined;
  let more = false;
  let total: number | undefined;
  for (let depth = 0; depth < 10; depth++) {
    const object = record(value);
    if (!object || object.isError === true) break;
    more ||=
      object.hasMore === true ||
      record(object.pageInfo)?.hasNextPage === true ||
      object.hasNextPage === true ||
      !!string(object.nextCursor);
    const count = object.totalCount ?? object.total;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      total = count;
    // MCP structured content is authoritative; its duplicate text is not another result.
    if (object.structuredContent !== undefined) {
      value = object.structuredContent;
      continue;
    }
    if (Array.isArray(object.content)) {
      const blocks = object.content;
      // Mixed image/resource content must not be presented as a complete text result.
      if (
        !blocks.every(
          (block) =>
            record(block)?.type === "text" &&
            typeof record(block)?.text === "string",
        )
      )
        break;
      const joined = blocks
        .map((block) => (block as RecordValue).text)
        .join("\n");
      if (joined.length > 65536) break;
      try {
        value = JSON.parse(joined);
      } catch {
        value = joined;
      }
      continue;
    }
    const keys = Object.keys(object).filter((key) => !metadata.has(key));
    if (keys.length !== 1 || !envelopes.has(keys[0]!)) break;
    const key = keys[0]!;
    if (["contacts", "people", "contact", "person"].includes(key))
      hint = "contacts";
    else if (["events", "event"].includes(key)) hint = "events";
    value = object[key];
    if (key === "edges" && Array.isArray(value)) {
      if (!value.every((edge) => record(edge)?.node !== undefined)) break;
      value = value.map((edge) => (edge as RecordValue).node);
    }
  }
  return { value, hint, more, total };
}

function contact(value: unknown, hint?: string) {
  const item = record(value);
  if (!item) return undefined;
  const nestedName = record(item.name);
  const first = string(nestedName?.firstName ?? item.firstName);
  const last = string(nestedName?.lastName ?? item.lastName);
  const name =
    first || last
      ? text([first, last].filter(Boolean).join(" "))
      : text(item.name ?? item.displayName);
  const address = item.email ?? record(item.emails)?.primaryEmail;
  const validEmail = email.safeParse(address);
  const number = string(item.phone ?? record(item.phones)?.primaryPhoneNumber);
  const countryCode = string(record(item.phones)?.primaryPhoneCallingCode);
  const fullPhone =
    number && countryCode && !number.startsWith("+")
      ? `${countryCode.startsWith("+") ? countryCode : "+" + countryCode} ${number}`
      : number;
  const phone =
    fullPhone && /^\+?[0-9][0-9 ().-]{2,62}$/.test(fullPhone)
      ? fullPhone
      : undefined;
  if (
    !name ||
    !(hint === "contacts" || first || last || validEmail.success || phone)
  )
    return undefined;
  return {
    name,
    ...(validEmail.success ? { email: validEmail.data } : {}),
    ...(phone ? { phone } : {}),
    ...(text(item.jobTitle) ? { subtitle: text(item.jobTitle) } : {}),
  };
}

/** Exact, bounded identity fields for server context, separate from clipped display text. */
export function contactIdentities(input: unknown) {
  const presentation = presentServiceResult(input, "en");
  if (presentation?.kind !== "contacts" || !presentation.items.length)
    return undefined;
  const { value } = unwrap(input);
  const values = (Array.isArray(value) ? value : [value]).slice(0, 10);
  const contacts = values.map((value, index) => {
    const item = record(value)!;
    const nested = record(item.name);
    const first = string(nested?.firstName ?? item.firstName);
    const last = string(nested?.lastName ?? item.lastName);
    const name =
      first || last
        ? [first, last].filter(Boolean).join(" ")
        : string(item.name ?? item.displayName);
    const shown = presentation.items[index]!;
    const id =
      typeof item.id === "string" && item.id === item.id.trim()
        ? item.id
        : undefined;
    // Never turn a truncated label into an exact identity or guess an absent ID.
    if (!name || name.length > 160) return undefined;
    return {
      ref: `contact_${index + 1}`,
      name,
      ...(id && id.length <= 200 && !/[\u0000-\u001f]/.test(id) ? { id } : {}),
      ...(shown.email ? { email: shown.email } : {}),
      ...(shown.phone ? { phone: shown.phone } : {}),
    };
  });
  // Preserve card order and ambiguity: do not silently drop unrepresentable rows.
  if (contacts.some((value) => !value)) return undefined;
  return {
    contacts: contacts.filter((value) => value !== undefined),
    hasMore: presentation.hasMore,
  };
}

function event(value: unknown) {
  const item = record(value);
  if (!item) return undefined;
  const title = text(item.title ?? item.summary ?? item.name);
  const start = timestamp.safeParse(
    record(item.start)?.dateTime ?? item.start ?? item.startAt ?? item.startsAt,
  );
  const rawEnd =
    record(item.end)?.dateTime ?? item.end ?? item.endAt ?? item.endsAt;
  const end = timestamp.safeParse(rawEnd);
  // No invented timezone, all-day conversion, or silent repair of a reversed interval.
  if (
    !title ||
    !start.success ||
    (rawEnd !== undefined &&
      (!end.success || Date.parse(end.data) < Date.parse(start.data)))
  )
    return undefined;
  return {
    title,
    start: start.data,
    ...(end.success ? { end: end.data } : {}),
    ...(text(item.location) ? { location: text(item.location) } : {}),
  };
}

function scalar(value: unknown, language: Language): string | undefined {
  if (typeof value === "string") return text(value, 500);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean")
    return language === "cs" ? (value ? "Ano" : "Ne") : value ? "Yes" : "No";
  return undefined;
}
function fields(
  item: RecordValue,
  language: Language,
  skip = new Set<string>(),
) {
  const result: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(item)) {
    if (skip.has(key) || sensitive.test(key) || key.startsWith("__")) continue;
    const rendered = scalar(value, language);
    if (rendered !== undefined) {
      result.push({
        label: clip(
          key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "),
          100,
        ),
        value: rendered,
      });
    }
    if (result.length === 6) break;
  }
  return result;
}

/** Data projection is deliberately deterministic and bounded. Unrecognized data retains the old detail fallback. */
export function presentServiceResult(
  input: unknown,
  language: Language,
): ServicePresentation | undefined {
  const { value, hint, more, total } = unwrap(input);
  const collection = Array.isArray(value) ? value : undefined;
  const values = collection ?? [value];
  const items = values.slice(0, 10);
  const hasMore =
    more ||
    values.length > items.length ||
    (total !== undefined && total > values.length);
  let presentation: unknown;
  if (!items.length) {
    presentation = {
      kind:
        hint === "contacts"
          ? "contacts"
          : hint === "events"
            ? "events"
            : "records",
      items: [],
      hasMore,
    };
  } else if (hint !== "contacts" && items.every((item) => !!event(item))) {
    presentation = { kind: "events", items: items.map(event), hasMore };
  } else if (
    hint !== "events" &&
    items.every((item) => !!contact(item, hint))
  ) {
    presentation = {
      kind: "contacts",
      items: items.map((item) => contact(item, hint)),
      hasMore,
    };
  } else if (collection) {
    const rows = items.map((item, i) => {
      const object = record(item);
      const title = object
        ? text(object.title ?? object.name ?? object.label)
        : text(scalar(item, language));
      const subtitle = object ? text(object.description) : undefined;
      return {
        title: title ?? `${language === "cs" ? "Položka" : "Item"} ${i + 1}`,
        ...(subtitle ? { subtitle } : {}),
        fields: object
          ? fields(
              object,
              language,
              new Set(["title", "name", "label", "description"]),
            )
          : [],
      };
    });
    // Do not turn complex/unrecognized objects into a list of empty placeholder cards.
    if (
      rows.every(
        (row, i) =>
          row.fields.length ||
          scalar(items[i], language) !== undefined ||
          text(
            record(items[i])?.title ??
              record(items[i])?.name ??
              record(items[i])?.label,
          ),
      )
    )
      presentation = { kind: "records", items: rows, hasMore };
  } else if (record(value)) {
    const visible = fields(record(value)!, language);
    if (visible.length) presentation = { kind: "detail", fields: visible };
  } else if (string(value)) {
    presentation = { kind: "text", text: clip(string(value)!, 1600) };
  }
  const parsed = ServicePresentationSchema.safeParse(presentation);
  return parsed.success ? parsed.data : undefined;
}

/** A short server-owned summary for history and speech; never asks a model to reinterpret the result. */
export function presentationReply(
  presentation: ServicePresentation,
  language: Language,
): string {
  const cs = language === "cs";
  if (presentation.kind === "text") return presentation.text.slice(0, 800);
  if (presentation.kind === "detail")
    return cs
      ? "Údaje jsou připravené v kartě."
      : "The details are ready in the card.";
  const count = presentation.items.length;
  if (!count)
    return presentation.hasMore
      ? cs
        ? "Tato část výsledků je prázdná. Upřesni požadavek."
        : "This part of the results is empty. Narrow your request."
      : cs
        ? "Nebyly nalezeny žádné položky."
        : "No items found.";
  if (
    presentation.kind === "contacts" &&
    count === 1 &&
    !presentation.hasMore
  ) {
    const person = presentation.items[0]!;
    const details = [
      person.email
        ? cs
          ? `e-mailem ${person.email}`
          : `email ${person.email}`
        : "",
      person.phone
        ? cs
          ? `telefonem ${person.phone}`
          : `phone ${person.phone}`
        : "",
    ].filter(Boolean);
    const withDetails = details.length
      ? (cs ? " s " : " with ") + details.join(cs ? " a " : " and ")
      : "";
    return (
      cs
        ? `Našel jsem kontakt ${person.name}${withDetails}. Posílám kartu.`
        : `I found ${person.name}${withDetails}. Here is the contact card.`
    ).slice(0, 800);
  }
  const names = presentation.items
    .slice(0, 3)
    .map((item) => ("name" in item ? item.name : item.title))
    .join(", ");
  const nouns = {
    contacts: cs
      ? ["kontakt", "kontakty", "kontaktů"]
      : ["contact", "contacts"],
    events: cs ? ["událost", "události", "událostí"] : ["event", "events"],
    records: cs ? ["záznam", "záznamy", "záznamů"] : ["result", "results"],
  }[presentation.kind];
  const noun = cs
    ? nouns[count === 1 ? 0 : count < 5 ? 1 : 2]
    : nouns[count === 1 ? 0 : 1];
  const lead = cs ? `Našel jsem ${count} ${noun}` : `I found ${count} ${noun}`;
  const tail = presentation.hasMore
    ? cs
      ? ". Výsledků je víc, upřesni požadavek."
      : ". There are more results; narrow your request."
    : count > 3
      ? cs
        ? ". Další položky najdeš v kartě."
        : ". See the card for more items."
      : ".";
  return `${lead}: ${names}${tail}`.slice(0, 800);
}
