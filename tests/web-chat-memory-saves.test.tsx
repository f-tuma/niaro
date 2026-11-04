import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { MemoryItem } from "../packages/protocol/memory";
import type { PetMemoryCommand } from "../packages/protocol/work-pet";
import {
  NextChatProvider,
  type NextChat,
} from "../apps/server-admin/web/app/chat-next/parts";
import {
  MemorySaveLines,
  useChatMemorySaves,
  type ChatMemorySaves,
} from "../apps/server-admin/web/app/chat-next/memory-saves";
import {
  nextMeta,
  storedMessage,
} from "../apps/server-admin/web/app/chat-next/transport";

const mockMemory = {
  items: [] as MemoryItem[],
  queries: [] as unknown[],
  commands: [] as PetMemoryCommand[],
  reads: 0,
};
jest.mock("../apps/server-admin/web/app/pet-memory", () => ({
  usePetMemory: (query: unknown) => {
    mockMemory.queries.push(query);
    return {
      page: { items: mockMemory.items },
      read: async () => {
        mockMemory.reads++;
      },
      save: async (command: PetMemoryCommand) => {
        mockMemory.commands.push(command);
        mockMemory.items = mockMemory.items.filter(
          (item) => command.type !== "forget" || item.id !== command.id,
        );
      },
    };
  },
}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
}));
jest.mock(
  "@admin/components/ui/button",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock("@admin/components/ui/spinner", () => ({ Spinner: () => null }), {
  virtual: true,
});
jest.mock("@admin/components/ui/markdown", () => ({ Markdown: () => null }), {
  virtual: true,
});
jest.mock("../apps/server-admin/web/app/generative-ui/charts", () => ({}));

const memory = (
  id: string,
  content: string,
  commandId: string,
  createdAt = "2026-11-04T10:00:00.000Z",
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
  createdAt,
  updatedAt: createdAt,
  expiresAt: null,
  supersedesId: null,
});

/** The chat's context with only what the save lines read. */
const chat = (
  memorySaves: ChatMemorySaves,
  overrides: Partial<NextChat> = {},
) =>
  ({
    online: true,
    readOnly: false,
    memorySaves,
    ...overrides,
  }) as NextChat;

function Saves({ onReady }: { onReady: (saves: ChatMemorySaves) => void }) {
  const saves = useChatMemorySaves("conversation-1");
  onReady(saves);
  return null;
}

beforeEach(() => {
  mockMemory.items = [];
  mockMemory.queries = [];
  mockMemory.commands = [];
  mockMemory.reads = 0;
});

test("a stored answer names the request it replies to, for its save lines", () => {
  const thread = storedMessage(
    {
      id: "answer-1",
      role: "assistant",
      text: "Uloženo.",
      replyToCommandId: "command-1",
    },
    {},
  );
  expect(nextMeta(thread!).replyToCommandId).toBe("command-1");
});

test("the chat reads its own saves and groups them under the request that made them", async () => {
  mockMemory.items = [
    memory(
      "m2",
      "Role: produktový manažer",
      "command-1",
      "2026-11-04T10:00:02.000Z",
    ),
    memory("m1", "Jméno: Filip Tůma", "command-1", "2026-11-04T10:00:01.000Z"),
    memory("m3", "Tým: Niaro", "command-2"),
  ];
  let saves: ChatMemorySaves | undefined;
  await act(async () => {
    TestRenderer.create(<Saves onReady={(value) => (saves = value)} />);
  });
  expect(mockMemory.queries[0]).toEqual({
    origin: "explicit",
    conversationId: "conversation-1",
    limit: 100,
  });
  expect(saves!.forCommand("command-1").map((item) => item.content)).toEqual([
    "Jméno: Filip Tůma",
    "Role: produktový manažer",
  ]);
  expect(saves!.forCommand("command-2")).toHaveLength(1);
  expect(saves!.forCommand("command-3")).toHaveLength(0);
});

test("each save is a quiet line under the reply; Delete erases that memory", async () => {
  mockMemory.items = [
    memory("m1", "Jméno: Filip Tůma", "command-1"),
    memory("m2", "Role: produktový manažer", "command-1"),
  ];
  let saves: ChatMemorySaves | undefined;
  await act(async () => {
    TestRenderer.create(<Saves onReady={(value) => (saves = value)} />);
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <NextChatProvider value={chat(saves!)}>
        <MemorySaveLines commandId="command-1" />
      </NextChatProvider>,
    );
  });
  const lines = renderer.root.findAll(
    (node) => node.props["data-testid"] === "memory-save" && node.type === "li",
  );
  expect(lines).toHaveLength(2);
  const text = (node: TestRenderer.ReactTestInstance): string =>
    node.children
      .map((child) => (typeof child === "string" ? child : text(child)))
      .join("");
  expect(text(lines[0]!)).toContain("Uloženo do paměti: Jméno: Filip Tůma");
  const remove = lines[0]!.findByType("button");
  expect(remove.props["aria-label"]).toBe("Smazat z paměti: Jméno: Filip Tůma");
  await act(async () => {
    remove.props.onClick();
  });
  expect(mockMemory.commands).toEqual([
    expect.objectContaining({ type: "forget", id: "m1", revision: 1 }),
  ]);
  expect(mockMemory.reads).toBe(1);
});

test("no line without saves, and Delete waits while offline or archived", async () => {
  const saves: ChatMemorySaves = {
    forCommand: (commandId) =>
      commandId === "command-1"
        ? [memory("m1", "Tým: Niaro", "command-1")]
        : [],
    forget: jest.fn(async () => {}),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <NextChatProvider value={chat(saves)}>
        <MemorySaveLines commandId="command-2" />
        <MemorySaveLines />
      </NextChatProvider>,
    );
  });
  expect(renderer.toJSON()).toBeNull();
  await act(async () => {
    renderer.update(
      <NextChatProvider value={chat(saves, { readOnly: true })}>
        <MemorySaveLines commandId="command-1" />
      </NextChatProvider>,
    );
  });
  expect(renderer.root.findByType("button").props.disabled).toBe(true);
});
