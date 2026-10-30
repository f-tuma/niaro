import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ClientSession } from "../../packages/client-core/session";
import {
  CHAT_SEARCH_FILTERS,
  chatSearchOptions,
  highlightParts,
  searchDateLabel,
  type ChatSearchFilter,
} from "../../packages/client-core/chat-search";
import { conversationTitle } from "../../packages/client-core/conversation-title";
import type { ConversationSummary, Language } from "../../packages/protocol";
import type { ChatSearchResult } from "../../packages/protocol/chat-search";
import { translate } from "../../packages/i18n";
import { tokens as t } from "../../packages/design-tokens";
import { Button, Notice, Row, Segmented, Text } from "../../packages/ui";
import { EmptyState, IconButton } from "./ScreenChrome";
import { useCompanionTypography } from "../../packages/ui/typography";

/** Typing settles this long before the server is asked. */
export const MOBILE_SEARCH_DEBOUNCE_MS = 250;

const copy = {
  en: {
    title: "Search",
    placeholder: "Search chats",
    clear: "Clear",
    back: "Back",
    filters: "Show",
    filter: {
      all: "All",
      mine: "Mine",
      answers: "Answers",
      archived: "Archived",
    } satisfies Record<ChatSearchFilter, string>,
    archived: "Archived",
    noResults: "Nothing found",
    noResultsHint: "Try other words.",
    noChats: "No chats yet",
    failed: "Search didn't work.",
    slowDown: "Too fast. Wait a moment.",
    unavailable: "This server can't search chats yet.",
    more: "More results",
    retry: "Try again",
  },
  cs: {
    title: "Hledat",
    placeholder: "Hledat v chatech",
    clear: "Vymazat",
    back: "Zpět",
    filters: "Zobrazit",
    filter: {
      all: "Vše",
      mine: "Moje",
      answers: "Odpovědi",
      archived: "Archiv",
    },
    archived: "Archivováno",
    noResults: "Nic jsme nenašli",
    noResultsHint: "Zkus jiná slova.",
    noChats: "Zatím žádné chaty",
    failed: "Hledání nevyšlo.",
    slowDown: "Moc rychle. Chvilku počkej.",
    unavailable: "Tenhle server v chatech hledat neumí.",
    more: "Další výsledky",
    retry: "Zkusit znovu",
  },
} as const;

/** What the app needs to open a found chat; the history read fills in the rest. */
export function summaryOf(result: ChatSearchResult): ConversationSummary {
  return {
    id: result.conversation.id,
    revision: 1,
    title: result.conversation.title,
    createdAt: result.conversation.updatedAt,
    updatedAt: result.conversation.updatedAt,
    messageCount: result.matchCount,
    readOnly: result.conversation.archived,
  };
}

/** Plain text with its matched parts bold; never markup from the server. */
function Marked({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}) {
  return highlightParts(text, ranges).map((part, index) =>
    part.match ? (
      <Text key={index} style={{ fontWeight: "700" }}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
}

type FoundRow = {
  id: string;
  title: string;
  titleRanges: readonly (readonly [number, number])[];
  snippet?: { text: string; ranges: readonly (readonly [number, number])[] };
  at: string;
  archived: boolean;
  open: ConversationSummary;
};

/**
 * Search in the person's chats, reached from the menu. Without words it
 * lists recent chats; a row opens the chat. Reads only.
 */
export function ChatSearchScreen({
  session,
  language,
  online,
  onClose,
  onOpen,
}: {
  session: ClientSession;
  language: Language;
  online: boolean;
  onClose: () => void;
  onOpen: (conversation: ConversationSummary) => void;
}) {
  const c = copy[language];
  const tr = translate(language);
  const searchFont = useCompanionTypography(t.typography.body);
  const largeText = useWindowDimensions().fontScale > 1.3;
  const [query, setQuery] = useState("");
  const [words, setWords] = useState("");
  const [filter, setFilter] = useState<ChatSearchFilter>("all");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const typed = query.trim();
    if (!typed) {
      setWords("");
      return;
    }
    const timer = setTimeout(() => setWords(typed), MOBILE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const key = `${words}\n${filter}\n${attempt}`;
  const [state, setState] = useState<{
    key: string;
    rows: FoundRow[];
    next: string | null;
    error?: string;
    loading: boolean;
  }>({ key: "", rows: [], next: null, loading: true });
  const reads = useRef(0);
  const titleOf = (title: string) =>
    conversationTitle(title) || tr("untitledChat");
  const read = async (after: string | null) => {
    const owner = ++reads.current;
    const archive = filter === "archived";
    try {
      let rows: FoundRow[];
      let next: string | null;
      if (words) {
        const page = await session.searchConversations(words, {
          ...chatSearchOptions(filter),
          after,
        });
        rows = page.results.map((result) => {
          const best = result.matches[0];
          const title = titleOf(result.conversation.title);
          return {
            id: result.conversation.id,
            title,
            titleRanges:
              title === result.conversation.title ? result.titleRanges : [],
            snippet: best
              ? { text: best.snippet, ranges: best.ranges }
              : undefined,
            at: best?.createdAt ?? result.conversation.updatedAt,
            archived: result.conversation.archived,
            open: summaryOf(result),
          };
        });
        next = page.nextAfter;
      } else {
        const page = await session.readConversations(
          after,
          undefined,
          archive ? "archived" : "active",
        );
        rows = page.conversations
          .filter((conversation) => conversation.messageCount > 0)
          .map((conversation) => ({
            id: conversation.id,
            title: titleOf(conversation.title),
            titleRanges: [],
            at: conversation.updatedAt,
            archived: conversation.readOnly,
            open: conversation,
          }));
        next = page.nextAfter;
      }
      if (owner !== reads.current) return;
      setState((current) => ({
        key,
        rows: after ? [...current.rows, ...rows] : rows,
        next,
        loading: false,
      }));
    } catch (error) {
      if (owner !== reads.current) return;
      setState((current) => ({
        ...current,
        key,
        error: error instanceof Error ? error.message : "connection_failed",
        loading: false,
      }));
    }
  };
  const readPage = useRef(read);
  readPage.current = read;
  useEffect(() => {
    setState((current) => ({ ...current, error: undefined, loading: true }));
    void readPage.current(null);
  }, [key]);
  const shown = state.key === key || state.rows.length ? state.rows : [];
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView
        testID="chat-search-screen"
        edges={["top", "bottom", "left", "right"]}
        style={{ flex: 1, backgroundColor: t.color.background }}
      >
        <Row style={{ minHeight: 64, paddingHorizontal: 12, gap: 4 }}>
          <IconButton icon="back" label={c.back} onPress={onClose} />
          <TextInput
            testID="chat-search-input"
            autoFocus
            accessibilityLabel={c.title}
            placeholder={c.placeholder}
            placeholderTextColor={t.color.text.secondary}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            autoCorrect={false}
            maxLength={200}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              color: t.color.text.primary,
              ...t.typography.body,
              ...searchFont,
            }}
          />
          {query ? (
            <IconButton
              icon="close"
              label={c.clear}
              onPress={() => setQuery("")}
            />
          ) : null}
        </Row>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, flexShrink: 0 }}
          contentContainerStyle={{
            minWidth: "100%",
            paddingHorizontal: t.spacing.screenGutter,
            paddingBottom: 8,
          }}
        >
          <Segmented
            accessibilityLabel={c.filters}
            options={CHAT_SEARCH_FILTERS.map((value) => ({
              value,
              label: c.filter[value],
            }))}
            value={filter}
            onChange={setFilter}
          />
        </ScrollView>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 }}
        >
          {state.error ? (
            <View style={{ padding: 16, gap: 8 }}>
              <Notice error>
                {state.error === "chat_search_unavailable"
                  ? c.unavailable
                  : state.error === "chat_search_rate_limited"
                    ? c.slowDown
                    : c.failed}
              </Notice>
              {state.error !== "chat_search_unavailable" ? (
                <Button
                  variant="quiet"
                  size="small"
                  label={c.retry}
                  disabled={!online}
                  onPress={() => setAttempt((value) => value + 1)}
                />
              ) : null}
            </View>
          ) : !shown.length && !state.loading ? (
            <EmptyState
              icon="search"
              title={words ? c.noResults : c.noChats}
              hint={words ? c.noResultsHint : undefined}
            />
          ) : null}
          {shown.map((row) => (
            <Pressable
              key={row.id}
              testID="chat-search-result"
              accessibilityRole="button"
              accessibilityLabel={row.title}
              onPress={() => onOpen(row.open)}
              style={({ pressed }) => ({
                paddingHorizontal: 20,
                paddingVertical: 12,
                gap: 2,
                backgroundColor: pressed ? t.color.pressed : "transparent",
              })}
            >
              <Row
                style={{
                  gap: 8,
                  ...(largeText
                    ? ({
                        flexDirection: "column",
                        alignItems: "stretch",
                      } as const)
                    : {}),
                }}
              >
                <Text
                  numberOfLines={largeText ? 2 : 1}
                  style={{
                    flex: largeText ? undefined : 1,
                    minWidth: 0,
                    fontWeight: "600",
                  }}
                >
                  <Marked text={row.title} ranges={row.titleRanges} />
                </Text>
                <Row style={{ gap: 8, flexWrap: "wrap" }}>
                  {row.archived ? (
                    <Text role="caption" tone="secondary">
                      {c.archived}
                    </Text>
                  ) : null}
                  <Text role="caption" tone="secondary">
                    {searchDateLabel(row.at, language, {
                      yesterday: tr("chatsYesterday"),
                    })}
                  </Text>
                </Row>
              </Row>
              {row.snippet ? (
                <Text role="caption" tone="secondary" numberOfLines={2}>
                  <Marked text={row.snippet.text} ranges={row.snippet.ranges} />
                </Text>
              ) : null}
            </Pressable>
          ))}
          {state.next && !state.error ? (
            <View style={{ padding: 16, alignItems: "center" }}>
              <Button
                variant="quiet"
                size="small"
                label={c.more}
                disabled={state.loading || !online}
                onPress={() => {
                  setState((current) => ({ ...current, loading: true }));
                  void read(state.next);
                }}
              />
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
