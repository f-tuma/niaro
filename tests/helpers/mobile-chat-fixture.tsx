import React, { useState } from "react";
import { Workspace } from "../../apps/mobile/App";
import type { Section } from "../../apps/mobile/ScreenChrome";
import type { ChatMessage } from "../../apps/mobile/chat/thread";
import type {
  ClientSession,
  SessionCommand,
  SessionState,
} from "../../packages/client-core/session";
import { fromSnapshot } from "../../packages/client-core/store";
import { emptySnapshot } from "../../packages/test-fixtures";
import {
  CONVERSATION_HISTORY_PROFILE,
  type ConversationSummary,
} from "../../packages/protocol";
import { CHAT_SEARCH_PROFILE } from "../../packages/protocol/chat-search";

/*
 * A phone workspace over one saved chat, for the chat suites. The suite
 * mocks the native modules (voice, storage, crypto, speech) itself.
 */
export const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
const local = (value: string) => new Date(value).toISOString();
export const messages: ChatMessage[] = [
  {
    id: "TEST-u1",
    role: "user",
    text: "TEST first question",
    createdAt: local("2026-11-01T10:00:00"),
  },
  {
    id: "TEST-a1",
    role: "assistant",
    text: "TEST first answer",
    createdAt: local("2026-11-01T10:01:00"),
  },
  {
    id: "TEST-u2",
    role: "user",
    text: "TEST second question",
    createdAt: local("2026-11-02T09:00:00"),
  },
  {
    id: "TEST-a2",
    role: "assistant",
    text: "TEST **second** answer",
    createdAt: local("2026-11-02T09:01:00"),
  },
];
export const summary: ConversationSummary = {
  id: "TEST-A",
  title: "TEST chat",
  revision: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-02T08:01:00.000Z",
  messageCount: 4,
  readOnly: false,
};

/** One chat of four messages from yesterday and today; `paged` splits it. */
export function chatFixture(paged = false) {
  const snapshot = emptySnapshot();
  snapshot.conversations.push({ id: "TEST-A", revision: 1, messages });
  let state: SessionState = {
    store: fromSnapshot("https://fixture.test/v1/a", snapshot.scope, snapshot),
    status: "online",
    pending: null,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const listeners = new Set<() => void>();
  // The chat as the server has it now: its revision follows the store.
  const page = (part: ChatMessage[], nextAfter: string | null) => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: snapshot.scope,
    conversation: {
      ...summary,
      revision: state.store!.conversations["TEST-A"]!.revision,
    },
    messages: part,
    nextAfter,
  });
  const session = {
    identityKey: "TEST-server/alice/workspace-a",
    getSnapshot: () => state,
    subscribe: (r: () => void) => {
      listeners.add(r);
      return () => listeners.delete(r);
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    readConversations: jest.fn(async () => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: snapshot.scope,
      conversations: [summary],
      nextAfter: null,
    })),
    readConversation: jest.fn(async (_id: string, after?: string | null) =>
      !paged
        ? page(state.store!.conversations["TEST-A"]!.messages, null)
        : after === "TEST-older"
          ? page(messages.slice(0, 2), null)
          : page(messages.slice(2), "TEST-older"),
    ),
    searchConversations: jest.fn(async () => ({
      profile: CHAT_SEARCH_PROFILE,
      scope: snapshot.scope,
      results: [
        {
          conversation: {
            id: "TEST-A",
            title: "TEST chat",
            updatedAt: summary.updatedAt,
            archived: false,
          },
          titleRanges: [],
          matches: [
            {
              messageId: "TEST-u1",
              role: "user",
              snippet: "TEST first question",
              ranges: [],
            },
          ],
          matchCount: 1,
        },
      ],
      nextAfter: null,
    })),
    send: jest.fn((command: SessionCommand) => {
      state = { ...state, pending: command };
      listeners.forEach((r) => r());
      return new Promise<void>(() => {});
    }),
    renameConversation: jest.fn(async () => {}),
    deleteConversation: jest.fn(async () => {}),
    archiveConversation: jest.fn(async () => {}),
    retry: jest.fn(async () => {}),
    interruptPending: jest.fn(async () => true),
  };
  function Harness() {
    const [section, setSection] = useState<Section>("chat");
    return (
      <Workspace
        session={session as unknown as ClientSession}
        language="en"
        section={section}
        setSection={setSection}
        settings={null}
        authError={null}
        spokenReplies={false}
      />
    );
  }
  const publish = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    listeners.forEach((r) => r());
  };
  return { session, Harness, publish, state: () => state };
}
