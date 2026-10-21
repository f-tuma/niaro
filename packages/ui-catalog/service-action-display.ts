import {
  SERVICE_CARD_STATES,
  type ServiceResult,
} from "../protocol/service-result";
import type { CardDocument } from "../protocol/card-document";
import { readableName } from "../protocol/display-name";
import type { Language } from "../protocol";

// Display-only rules for a service action result, shared by the native and
// web cards. They never change what is approved or executed.

/** A recognisable glyph for the action itself, from its name. */
export function actionIcon(
  title: string,
  service: string,
): "calendar" | "mail" | "person" | "tasks" | "search" | "bolt" {
  const text = `${title} ${service}`.toLowerCase();
  if (/event|meeting|calendar|schedul|schůz|událost|kalend/.test(text))
    return "calendar";
  if (/mail|message|send|zpráv|e-mail/.test(text)) return "mail";
  if (/contact|person|people|kontakt|osob/.test(text)) return "person";
  if (/task|todo|úkol/.test(text)) return "tasks";
  if (/search|find|list|get|hledat|najít/.test(text)) return "search";
  return "bolt";
}
/** The card, structured result and title a service result shows. */
export function serviceActionDisplay(result: ServiceResult) {
  const presentation =
    result.status === "succeeded" ? result.presentation : undefined;
  const suppliedCard = result.card
    ? withoutLegacySourceDetails(result.card, result.summary)
    : undefined;
  // Generated event cards carry server (UTC) times; the client renders them locally.
  const card =
    suppliedCard &&
    !(
      presentation?.kind === "events" &&
      /^service-[a-f0-9]{32}$/.test(suppliedCard.id)
    )
      ? withoutGeneratedStatusBadge(suppliedCard)
      : undefined;
  const title =
    readableName(
      result.status === "succeeded"
        ? (suppliedCard?.title ?? result.title)
        : result.title,
    ) || result.title;
  return { presentation, card, title };
}
/** The client frame always owns the canonical state, including unknown guidance. */
function withoutGeneratedStatusBadge(
  document: CardDocument,
): CardDocument | undefined {
  const first = document.nodes.find((node) => node.id === document.root[0]);
  if (
    !/^service-[a-f0-9]{32}$/.test(document.id) ||
    first?.type !== "badge" ||
    !Object.values(SERVICE_CARD_STATES).some(
      (state) =>
        state.tone === first.tone && [state.en, state.cs].includes(first.label),
    )
  )
    return document;
  const root = document.root.slice(1);
  return root.length
    ? {
        ...document,
        root,
        nodes: document.nodes.filter((node) => node.id !== first.id),
      }
    : undefined;
}

/** Old generated cards keep their evidence in history but no longer render diagnostic payloads. */
function withoutLegacySourceDetails(
  card: CardDocument,
  summary: string,
): CardDocument {
  if (
    !/^service-[a-f0-9]{32}$/.test(card.id) ||
    card.actions.length ||
    !summary
  )
    return card;
  const removed = new Set<string>();
  for (const node of card.nodes) {
    if (
      node.type !== "disclosure" ||
      !card.root.includes(node.id) ||
      !["Source details", "Podrobnosti zdroje"].includes(node.label) ||
      node.children.length !== 1
    )
      continue;
    const child = card.nodes.find((item) => item.id === node.children[0]);
    if (child?.type !== "code" || child.text !== summary) continue;
    removed.add(node.id);
    removed.add(child.id);
  }
  if (!removed.size) return card;
  return {
    ...card,
    root: card.root.filter((id) => !removed.has(id)),
    nodes: card.nodes.filter((node) => !removed.has(node.id)),
  };
}

/** Original review identity, also usable for an older saved receipt without parameters. */
export type ServiceActionReviewFrame = {
  source: string;
  workspace?: string;
  nativeRevision: number;
  serviceId?: string;
  serviceRevision?: number;
  actionId?: string;
  actionRevision?: number;
  conversationId?: string;
  language?: Language;
};

export function completeServiceActionReview(
  result: ServiceResult,
  frame: ServiceActionReviewFrame,
): boolean {
  if (
    !frame.source.trim() ||
    !frame.workspace?.trim() ||
    !frame.serviceId?.trim() ||
    !frame.actionId?.trim() ||
    !Number.isSafeInteger(frame.nativeRevision) ||
    frame.nativeRevision <= 0 ||
    !Number.isSafeInteger(frame.serviceRevision) ||
    frame.serviceRevision! < 0 ||
    !Number.isSafeInteger(frame.actionRevision) ||
    frame.actionRevision! < 0
  )
    return false;
  try {
    const parameters: unknown = JSON.parse(result.inputJson);
    return (
      typeof parameters === "object" &&
      parameters !== null &&
      !Array.isArray(parameters)
    );
  } catch {
    return false;
  }
}
