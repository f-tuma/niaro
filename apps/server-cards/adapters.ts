import { createHash } from "node:crypto";
import { ZodError } from "zod";
import {
  CrmContactResultSchema,
  WorkItemSchema,
  type CrmContactResult,
  type Language,
  type WorkItem,
} from "../../packages/protocol";
import {
  ServiceResultSchema,
  SERVICE_CARD_STATES,
  type ServiceResult,
} from "../../packages/protocol/service-result";
import type { ServicePresentation } from "../../packages/protocol/service-presentation";
import type {
  CardDocument,
  CardNode,
} from "../../packages/protocol/card-document";
import { CardBuilder } from "./builders";
import { displayFieldIcon } from "../../packages/protocol/display-link";
import { readableName } from "../../packages/protocol/display-name";

type Icon = NonNullable<CardDocument["icon"]>;
type Tone = Extract<CardNode, { type: "badge" }>["tone"];
const text = (language: Language, en: string, cs: string) =>
  language === "cs" ? cs : en;
const short = (value: string) =>
  value.trim().length > 160 ? value.trim().slice(0, 159) + "…" : value.trim();
const cardId = (kind: string, value: string) =>
  `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

function field(
  card: CardBuilder,
  label: string,
  value: string | undefined,
  icon?: Icon,
): string | undefined {
  if (!value?.trim()) return;
  const fieldIcon = icon ?? displayFieldIcon(label, value);
  return card.add(
    {
      type: "field",
      label: short(label.trim() || "—"),
      value: value.trim(),
      ...(fieldIcon ? { icon: fieldIcon } : {}),
    },
    { root: false },
  );
}

function section(
  card: CardBuilder,
  title: string,
  children: (string | undefined)[],
  icon?: Icon,
) {
  const ids = children.filter((id): id is string => !!id);
  const label = short(title) || "—";
  if (ids.length)
    card.add({
      type: "section",
      title: label,
      ...(icon ? { icon } : {}),
      children: ids,
    });
  else card.add({ type: "heading", text: label });
}

function more(card: CardBuilder, language: Language) {
  card.add({
    type: "notice",
    tone: "info",
    text: text(
      language,
      "This is a preview. More results are available in the service.",
      "Toto je náhled. Další výsledky jsou dostupné ve službě.",
    ),
  });
}

function contacts(
  card: CardBuilder,
  items: Extract<ServicePresentation, { kind: "contacts" }>["items"],
  hasMore: boolean,
  language: Language,
  limit = 10,
) {
  if (!items.length)
    card.add({
      type: "text",
      text: text(
        language,
        "No contacts found.",
        "Žádné kontakty nebyly nalezeny.",
      ),
    });
  for (const item of items.slice(0, limit)) {
    section(
      card,
      item.name,
      [
        field(card, text(language, "Role", "Pozice"), item.subtitle),
        field(card, text(language, "Email", "E-mail"), item.email, "mail"),
        field(card, text(language, "Phone", "Telefon"), item.phone, "phone"),
      ],
      "person",
    );
  }
  if (hasMore || items.length > limit) more(card, language);
}

function instant(value: string, language: Language) {
  return `${new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} · UTC`;
}

function presentation(
  card: CardBuilder,
  data: ServicePresentation,
  language: Language,
  limit: number,
) {
  switch (data.kind) {
    case "contacts":
      contacts(card, data.items, data.hasMore, language, limit);
      break;
    case "events":
      if (!data.items.length)
        card.add({
          type: "text",
          text: text(
            language,
            "No events found.",
            "Žádné události nebyly nalezeny.",
          ),
        });
      for (const event of data.items.slice(0, limit))
        section(
          card,
          event.title,
          [
            field(
              card,
              text(language, "Starts", "Začátek"),
              instant(event.start, language),
              "clock",
            ),
            field(
              card,
              text(language, "Ends", "Konec"),
              event.end ? instant(event.end, language) : undefined,
              "clock",
            ),
            field(card, text(language, "Location", "Místo"), event.location),
          ],
          "calendar",
        );
      if (data.hasMore || data.items.length > limit) more(card, language);
      break;
    case "records": {
      if (!data.items.length)
        card.add({
          type: "text",
          text: text(
            language,
            "No records found.",
            "Žádné záznamy nebyly nalezeny.",
          ),
        });
      // Six rich records fit within the same graph budget as any other card.
      for (const record of data.items.slice(0, Math.min(6, limit))) {
        const children: (string | undefined)[] = [];
        if (record.subtitle?.trim())
          children.push(
            card.add(
              { type: "text", text: record.subtitle, tone: "secondary" },
              { root: false },
            ),
          );
        children.push(
          ...record.fields.map((item) => field(card, item.label, item.value)),
        );
        section(card, record.title, children);
      }
      if (data.hasMore || data.items.length > Math.min(6, limit))
        more(card, language);
      break;
    }
    case "detail": {
      const children = data.fields.map((item) =>
        field(card, item.label, item.value),
      );
      if (children.some(Boolean))
        section(card, text(language, "Details", "Údaje"), children);
      break;
    }
    case "text":
      if (data.text.trim()) card.add({ type: "text", text: data.text });
      break;
  }
}

/** Passive body only. The client owns authoritative approval fields and controls. */
export function serviceCard(
  result: ServiceResult,
  language: Language,
): CardDocument {
  const value = ServiceResultSchema.parse(result);
  const state = SERVICE_CARD_STATES[value.status];
  function render(limit: number) {
    const card = new CardBuilder({
      id: cardId("service", value.operationId),
      revision: 1,
      title:
        readableName(value.title) ||
        text(language, "Service result", "Výsledek služby"),
      ...(value.service.trim() ? { subtitle: value.service } : {}),
      icon:
        value.status === "succeeded"
          ? "check"
          : value.status === "running"
            ? "clock"
            : "info",
    });
    card.add({
      type: "badge",
      label: language === "cs" ? state.cs : state.en,
      tone: state.tone,
    });
    if (value.status === "succeeded" && value.presentation)
      presentation(card, value.presentation, language, limit);
    if (value.status === "failed" || value.status === "unknown") {
      // Error codes and HTTP statuses help diagnosis, not the person reading.
      const visible = value.fields.filter(
        (item) => !["Error code", "Kód chyby", "HTTP"].includes(item.label),
      );
      const details = visible
        .slice(0, limit)
        .map((item) => field(card, item.label, item.value));
      if (details.some(Boolean))
        section(card, text(language, "What happened", "Co se stalo"), details);
      else if (value.summary.trim())
        card.add({ type: "text", text: value.summary.slice(0, 1200) });
      if (visible.length > limit)
        card.add({
          type: "notice",
          tone: "info",
          text: text(
            language,
            "Some diagnostic fields are omitted from this preview.",
            "Náhled neobsahuje všechny diagnostické údaje.",
          ),
        });
    }
    if (value.status === "unknown")
      card.add({
        type: "notice",
        tone: "warning",
        text: text(
          language,
          "Check the result in the service before retrying.",
          "Před opakováním ověř výsledek ve službě.",
        ),
      });
    return card.build();
  }
  try {
    return render(10);
  } catch (error) {
    if (
      !(error instanceof ZodError) ||
      !error.issues.some(
        (issue) => issue.message === "Card exceeds the character budget",
      )
    )
      throw error;
    // JSON-escaped field strings can be larger than their displayed text.
    // A one-record preview fits even at the legacy field limits; authoritative
    // approval parameters are a separate object and are never shortened here.
    return render(1);
  }
}

const workStates: Record<
  WorkItem["status"],
  { en: string; cs: string; tone: Tone }
> = {
  queued: { en: "Queued", cs: "Ve frontě", tone: "neutral" },
  running: { en: "In progress", cs: "Probíhá", tone: "info" },
  waiting_input: {
    en: "Needs your answer",
    cs: "Čeká na tvoji odpověď",
    tone: "info",
  },
  waiting_approval: {
    en: "Awaiting your confirmation",
    cs: "Čeká na tvoje potvrzení",
    tone: "info",
  },
  waiting_system: {
    en: "Waiting for the service",
    cs: "Čeká na službu",
    tone: "neutral",
  },
  scheduled: { en: "Scheduled", cs: "Naplánováno", tone: "info" },
  succeeded: { en: "Completed", cs: "Dokončeno", tone: "success" },
  failed: { en: "Failed", cs: "Selhalo", tone: "danger" },
  cancelled: { en: "Cancelled", cs: "Zrušeno", tone: "neutral" },
  expired: { en: "Expired", cs: "Vypršelo", tone: "neutral" },
  superseded: {
    en: "Replaced by a newer task",
    cs: "Nahrazeno novější úlohou",
    tone: "neutral",
  },
};

/** A work summary is evidence-free UI: no invented progress counts or controls. */
export function workCard(work: WorkItem, language: Language): CardDocument {
  const value = WorkItemSchema.parse(work);
  const state = workStates[value.status];
  const card = new CardBuilder({
    id: cardId("work", value.id),
    revision: value.revision,
    title: short(value.title) || text(language, "Task", "Úloha"),
    icon: value.status === "succeeded" ? "check" : "clock",
  });
  card.add({
    type: "badge",
    label: language === "cs" ? state.cs : state.en,
    tone: state.tone,
  });
  let shortened = false;
  function preview(value: string) {
    const trimmed = value.trim();
    if (JSON.stringify(trimmed).length <= 10000) return trimmed;
    let low = 0,
      high = trimmed.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(trimmed.slice(0, middle)).length <= 9997) low = middle;
      else high = middle - 1;
    }
    shortened = true;
    return trimmed.slice(0, low) + "…";
  }
  if (value.title.trim().length > 160)
    card.add({ type: "text", text: preview(value.title) });
  if (value.context.trim())
    card.add({ type: "text", text: preview(value.context), tone: "secondary" });
  if (value.result?.trim())
    card.add({ type: "text", text: preview(value.result) });
  if (shortened)
    card.add({
      type: "notice",
      tone: "info",
      text: text(
        language,
        "Some details are shortened in this task preview.",
        "Některé údaje jsou v tomto náhledu úlohy zkrácené.",
      ),
    });
  return card.build();
}

export function crmCard(
  result: CrmContactResult,
  language: Language,
): CardDocument {
  const value = CrmContactResultSchema.parse(result);
  const card = new CardBuilder({
    id: cardId("crm", JSON.stringify(value)),
    revision: 1,
    title: text(
      language,
      value.contacts.length === 1 ? "Contact" : "Contacts",
      value.contacts.length === 1 ? "Kontakt" : "Kontakty",
    ),
    subtitle: "Twenty",
    icon: "person",
  });
  contacts(
    card,
    value.contacts.map((item) => ({
      name: item.name,
      ...(item.jobTitle ? { subtitle: item.jobTitle } : {}),
      ...(item.email ? { email: item.email } : {}),
      ...(item.phone ? { phone: item.phone } : {}),
    })),
    value.hasMore,
    language,
  );
  return card.build();
}
