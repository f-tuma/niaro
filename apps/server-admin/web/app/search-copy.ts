import { translate } from "../../../../packages/i18n";
import type { ChatSearchFilter } from "../../../../packages/client-core/chat-search";
import { useApp } from "./context";

const en = {
  search: "Search",
  placeholder: "Search chats…",
  clear: "Clear",
  filters: "Show",
  filter: {
    all: "All",
    mine: "My questions",
    answers: "Answers",
    archived: "Archived",
  } satisfies Record<ChatSearchFilter, string>,
  recent: "Recent chats",
  results: "Results",
  meetings: "Meetings",
  archived: "Archived",
  you: "You",
  assistant: "Assistant",
  more: "More results",
  noResults: "Nothing found",
  noChats: "No chats yet",
  noArchived: "No archived chats",
  failed: "Search didn't work.",
  slowDown: "Too fast. Wait a moment.",
  titlesOnly: "This server searches chat names only.",
  retry: "Try again",
  found: (count: number) =>
    count === 1 ? "1 chat found" : `${count} chats found`,
  shortcut: "Search chats (Ctrl+K)",
};
export type SearchCopy = typeof en;
const cs: SearchCopy = {
  search: "Hledat",
  placeholder: "Hledat v chatech…",
  clear: "Vymazat",
  filters: "Zobrazit",
  filter: {
    all: "Vše",
    mine: "Moje otázky",
    answers: "Odpovědi",
    archived: "Archivované",
  },
  recent: "Poslední chaty",
  results: "Výsledky",
  meetings: "Schůzky",
  archived: "Archivováno",
  you: "Ty",
  assistant: "Asistent",
  more: "Další výsledky",
  noResults: "Nic jsme nenašli",
  noChats: "Zatím žádné chaty",
  noArchived: "Žádné archivované chaty",
  failed: "Hledání nevyšlo.",
  slowDown: "Moc rychle. Chvilku počkej.",
  titlesOnly: "Tenhle server hledá jen v názvech chatů.",
  retry: "Zkusit znovu",
  found: (count: number) =>
    count === 1
      ? "Nalezen 1 chat"
      : count >= 2 && count <= 4
        ? `Nalezeny ${count} chaty`
        : `Nalezeno ${count} chatů`,
  shortcut: "Hledat v chatech (Ctrl+K)",
};

/** The search screen's words, with the chat list's shared day labels. */
export function useSearchCopy() {
  const { language } = useApp();
  const tr = translate(language);
  return {
    copy: language === "cs" ? cs : en,
    language,
    days: {
      today: tr("chatsToday"),
      yesterday: tr("chatsYesterday"),
      lastWeek: tr("chatsLastWeek"),
    },
    untitled: tr("untitledChat"),
  };
}
