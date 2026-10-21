import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { ClientSession } from "../../packages/client-core/session";
import { conversationTitle } from "../../packages/client-core/conversation-title";
import {
  chatChangeError,
  ConversationOpenWorkError,
} from "../../packages/client-core/conversation-directory";
import type { ConversationSummary, Language } from "../../packages/protocol";
import {
  messageCount,
  translate,
  type TranslationKey,
} from "../../packages/i18n";
import { tokens as t } from "../../packages/design-tokens";
import {
  Button,
  Group,
  ListBlock,
  ListRow,
  Notice,
  Row,
  Text,
} from "../../packages/ui";
import { IconButton } from "./ScreenChrome";
import { OpenWorkNotice, type OpenWorkRefusal } from "./OpenWorkNotice";

/** More rows than fit a glance: the archive gets a search field. */
const SEARCH_FROM = 8;
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/**
 * Settings → Archived chats: every archived chat of the person, newest first.
 * A row opens the chat read-only; Restore brings it back to the menu, Delete
 * asks once. Reads only; nothing here starts a turn.
 */
export function ArchivedChats({
  session,
  language,
  online,
  onOpen,
}: {
  session: ClientSession;
  language: Language;
  online: boolean;
  onOpen: (conversation: ConversationSummary) => void;
}) {
  const tr = translate(language);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<TranslationKey>();
  const [confirming, setConfirming] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [refusal, setRefusal] = useState<OpenWorkRefusal>();
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  // Archived, restored or deleted on another device: read the archive again.
  const directoryVersion = useSyncExternalStore(
    session.subscribe,
    () => session.getDirectoryVersion?.() ?? 0,
    () => session.getDirectoryVersion?.() ?? 0,
  );
  // One read per retry and per change elsewhere; the last rows stay meanwhile.
  const key = `${attempt}:${directoryVersion}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: ConversationSummary[];
    error?: string;
  }>();
  const loading = loaded?.key !== key;
  const rows = loaded?.rows ?? [];
  const error = loading ? undefined : loaded?.error;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      const found: ConversationSummary[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      do {
        const page = await session.readConversations(
          after,
          controller.signal,
          "archived",
        );
        for (const c of page.conversations)
          if (c.readOnly && !seen.has(c.id)) {
            seen.add(c.id);
            found.push(c);
          }
        if (page.nextAfter && page.nextAfter === after)
          throw new Error("conversation_changed");
        after = page.nextAfter;
      } while (after && active);
      if (active) setLoaded({ key, rows: found });
    })().catch((e: unknown) => {
      if (active)
        setLoaded((current) => ({
          key,
          rows: current?.rows ?? [],
          error: e instanceof Error ? e.message : "connection_failed",
        }));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, key]);
  const change = async (
    conversation: ConversationSummary,
    run: (id: string, commandId: string) => Promise<void>,
  ) => {
    setActionError(undefined);
    setRefusal(undefined);
    setPending(conversation.id);
    try {
      await run(conversation.id, randomUUID());
      if (alive.current)
        setLoaded(
          (current) =>
            current && {
              ...current,
              rows: current.rows.filter((c) => c.id !== conversation.id),
            },
        );
    } catch (e) {
      if (!alive.current) return;
      // Only deletion is refused for open work here; it names that work.
      if (e instanceof ConversationOpenWorkError)
        setRefusal({
          conversationId: conversation.id,
          action: "delete",
          openWork: e.openWork,
        });
      else setActionError(chatChangeError(e));
    } finally {
      if (alive.current) setPending(undefined);
    }
  };
  const titleOf = (c: ConversationSummary) =>
    conversationTitle(c.title) || tr("untitledChat");
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = [...rows]
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    .filter((c) => words.every((word) => fold(titleOf(c)).includes(word)));
  const date = (c: ConversationSummary) =>
    new Date(c.updatedAt).toLocaleDateString(
      language === "cs" ? "cs-CZ" : "en-GB",
      { day: "numeric", month: "short", year: "numeric" },
    );
  return (
    <Group title={tr("archivedChats")} testID="archived-chats">
      {rows.length > SEARCH_FROM || query ? (
        <ListBlock>
          <TextInput
            accessibilityLabel={tr("searchArchivedChats")}
            placeholder={tr("searchArchivedChats")}
            placeholderTextColor={t.color.text.secondary}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            style={{
              minHeight: 40,
              color: t.color.text.primary,
              fontSize: 16,
            }}
          />
        </ListBlock>
      ) : null}
      {actionError ? (
        <ListBlock>
          <Notice error>{tr(actionError)}</Notice>
        </ListBlock>
      ) : null}
      {error ? (
        <ListBlock>
          <Notice error>
            {tr(
              error === "conversation_history_unavailable"
                ? "chatArchiveUpdateRequired"
                : "archivedChatsFailed",
            )}
          </Notice>
          {error !== "conversation_history_unavailable" ? (
            <Button
              variant="quiet"
              size="small"
              label={tr("refresh")}
              disabled={!online || loading}
              onPress={() => setAttempt((value) => value + 1)}
            />
          ) : null}
        </ListBlock>
      ) : loading && !rows.length ? (
        <ListBlock>
          <Text role="caption" tone="secondary">
            {tr("loading")}
          </Text>
        </ListBlock>
      ) : !shown.length ? (
        <ListBlock>
          <Text role="caption" tone="secondary">
            {tr(query ? "noArchiveMatches" : "noArchivedChats")}
          </Text>
        </ListBlock>
      ) : null}
      {error
        ? null
        : shown.map((conversation) => (
            <React.Fragment key={conversation.id}>
              <ListRow
                icon="archive"
                label={titleOf(conversation)}
                description={`${date(conversation)} · ${messageCount(language, conversation.messageCount)}`}
                onPress={() => onOpen(conversation)}
                chevron={false}
                trailing={
                  <Row style={{ gap: 2 }}>
                    <IconButton
                      icon="restore"
                      label={`${tr("restoreChat")}: ${titleOf(conversation)}`}
                      disabled={!online || !!pending}
                      loading={pending === conversation.id}
                      onPress={() =>
                        void change(conversation, (id, commandId) =>
                          session.restoreConversation(id, commandId),
                        )
                      }
                    />
                    <IconButton
                      icon="trash"
                      label={`${tr("deleteChat")}: ${titleOf(conversation)}`}
                      disabled={!online || !!pending}
                      onPress={() => setConfirming(conversation.id)}
                    />
                  </Row>
                }
              />
              {refusal?.conversationId === conversation.id ? (
                <ListBlock continued>
                  <OpenWorkNotice
                    language={language}
                    refusal={refusal}
                    disabled={!online || !!pending}
                    onKeep={() => setRefusal(undefined)}
                    onCancelAndContinue={() =>
                      void change(conversation, (id, commandId) =>
                        session.deleteConversation(id, commandId, {
                          cancelOpenWork: true,
                        }),
                      )
                    }
                  />
                </ListBlock>
              ) : null}
              {confirming === conversation.id ? (
                <ListBlock continued>
                  <Text>{tr("deleteChatTitle")}</Text>
                  <Text role="caption" tone="secondary">
                    {tr("deleteChatHint")}
                  </Text>
                  <Row style={{ justifyContent: "flex-end", gap: 8 }}>
                    <Button
                      variant="quiet"
                      size="small"
                      label={tr("cancel")}
                      onPress={() => setConfirming(undefined)}
                    />
                    <Button
                      variant="danger"
                      size="small"
                      label={tr("deleteChat")}
                      disabled={!online || !!pending}
                      onPress={() => {
                        setConfirming(undefined);
                        void change(conversation, (id, commandId) =>
                          session.deleteConversation(id, commandId),
                        );
                      }}
                    />
                  </Row>
                </ListBlock>
              ) : null}
            </React.Fragment>
          ))}
    </Group>
  );
}

/** The archive's place in Settings, under the app's own settings. */
export function ArchivedChatsSection(
  props: React.ComponentProps<typeof ArchivedChats>,
) {
  return (
    <View style={{ marginTop: t.spacing.xl }}>
      <ArchivedChats {...props} />
    </View>
  );
}
