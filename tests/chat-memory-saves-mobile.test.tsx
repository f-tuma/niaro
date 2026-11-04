import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ClientSession } from "../packages/client-core/session";
import type { MemoryItem } from "../packages/protocol/memory";
import type {
  PetMemoryCommand,
  PetMemoryPage,
  PetMemoryQuery,
} from "../packages/protocol/work-pet";
import {
  MobileChatProvider,
  ThreadMessage,
  type MobileChat,
} from "../apps/mobile/chat/parts";
import { projectThread, type ChatMessage } from "../apps/mobile/chat/thread";
import {
  useChatMemorySaves,
  type ChatMemorySaves,
} from "../apps/mobile/chat/memory-saves";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));

const memory = (
  id: string,
  content: string,
  commandId: string,
): MemoryItem => ({
  id,
  scope: "private",
  kind: "fact",
  status: "active",
  revision: 1,
  content,
  source: {
    type: "user_message",
    commandId,
    conversationId: "conversation-1",
  },
  origin: "explicit",
  seenAt: null,
  trust: "user_assertion",
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
  expiresAt: null,
  supersedesId: null,
});

/** A session holding the person's memory: reads filter by chat, forget erases. */
function memorySession(items: MemoryItem[]) {
  const calls = {
    queries: [] as PetMemoryQuery[],
    commands: [] as PetMemoryCommand[],
  };
  const page = (): PetMemoryPage => ({
    profile: "work-pet/1",
    organizationId: "org",
    workspaceId: "workspace",
    userId: "alice",
    version: 1,
    enabled: true,
    optOut: false,
    personalThings: "keep",
    items: [...items],
    nextCursor: null,
  });
  const session = {
    petMemory: jest.fn(async (query: PetMemoryQuery) => {
      calls.queries.push(query);
      return page();
    }),
    savePetMemory: jest.fn(async (command: PetMemoryCommand) => {
      calls.commands.push(command);
      if (command.type === "forget")
        items.splice(
          items.findIndex((item) => item.id === command.id),
          1,
        );
      return page();
    }),
  } as unknown as ClientSession;
  return { session, calls };
}

const messages: ChatMessage[] = [
  {
    id: "request-1",
    role: "user",
    text: "Zapamatuj si: Jméno: Filip Tůma, Role: produktový manažer",
  },
  {
    id: "answer-1",
    role: "assistant",
    text: "Uložil jsem si to.",
    replyToCommandId: "command-1",
  },
];

function Thread({
  session,
  online = true,
  readOnly = false,
}: {
  session: ClientSession;
  online?: boolean;
  readOnly?: boolean;
}) {
  const saves: ChatMemorySaves = useChatMemorySaves(
    session,
    "conversation-1",
    0,
    1,
    () => "TEST-forget",
  );
  const chat = {
    session,
    language: "cs",
    busy: false,
    online,
    readOnly,
    memorySaves: saves,
    followUp: () => {},
    edit: () => {},
    again: () => {},
    againBlocked: false,
    locateMessage: () => {},
    locateWork: () => {},
    work: () => undefined,
  } as unknown as MobileChat;
  const entries = projectThread({
    messages,
    work: [],
    anchors: new Map(),
    referencedWork: new Set(),
  });
  return (
    <MobileChatProvider value={chat}>
      {entries.map((entry) => (
        <ThreadMessage key={entry.message.id} entry={entry} />
      ))}
    </MobileChatProvider>
  );
}

const show = async (element: React.ReactElement) => {
  render(element);
  await act(async () => {
    await Promise.resolve();
  });
};

test("a save shows as a quiet line under the reply that made it; Delete erases it", async () => {
  const { session, calls } = memorySession([
    memory("m1", "Jméno: Filip Tůma", "command-1"),
    memory("m2", "Role: produktový manažer", "command-1"),
    memory("m3", "Tým: Niaro", "command-other"),
  ]);
  await show(<Thread session={session} />);
  expect(calls.queries[0]).toEqual({
    origin: "explicit",
    conversationId: "conversation-1",
    limit: 100,
  });
  expect(screen.getAllByTestId("memory-save")).toHaveLength(2);
  expect(screen.getByText("Uloženo do paměti: Jméno: Filip Tůma")).toBeTruthy();
  expect(screen.queryByText(/Tým: Niaro/)).toBeNull();
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: "Smazat z paměti: Jméno: Filip Tůma",
      }),
    );
  });
  expect(calls.commands).toEqual([
    { type: "forget", requestId: "TEST-forget", id: "m1", revision: 1 },
  ]);
  expect(screen.getAllByTestId("memory-save")).toHaveLength(1);
  expect(screen.queryByText("Uloženo do paměti: Jméno: Filip Tůma")).toBeNull();
});

test("an archived or offline chat shows its saves but Delete waits", async () => {
  const { session, calls } = memorySession([
    memory("m1", "Jméno: Filip Tůma", "command-1"),
  ]);
  await show(<Thread session={session} readOnly />);
  const remove = screen.getByRole("button", {
    name: "Smazat z paměti: Jméno: Filip Tůma",
  });
  expect(remove.props.accessibilityState).toEqual(
    expect.objectContaining({ disabled: true }),
  );
  await act(async () => {
    fireEvent.press(remove);
  });
  expect(calls.commands).toEqual([]);
});

test("no saves, no line", async () => {
  const { session } = memorySession([]);
  await show(<Thread session={session} />);
  expect(screen.queryByTestId("memory-saves")).toBeNull();
});
