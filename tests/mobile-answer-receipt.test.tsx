import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ClientSession } from "../packages/client-core/session";
import type { AnswerReceiptPage } from "../packages/protocol/answer-receipts";
import {
  MobileChatProvider,
  ThreadMessage,
  type MobileChat,
} from "../apps/mobile/chat/parts";
import { projectThread, type ChatMessage } from "../apps/mobile/chat/thread";
import {
  MobilePresetPicker,
  useAnswerReceipts,
  useMobileChatPresets,
} from "../apps/mobile/chat/answer-receipt";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));

const page: AnswerReceiptPage = {
  profile: "agent-answer-receipts/1",
  conversationId: "conversation-1",
  receipts: [
    {
      commandId: "command-1",
      read: [
        {
          kind: "service",
          id: "find",
          title: "Najdi kontakty",
          detail: "Acme CRM",
        },
      ],
      changed: [{ kind: "task", id: "task-1", title: "Zavolat Janovi" }],
      memories: [],
      skills: [{ kind: "skill", id: "offers", title: "Nabídky" }],
      meetings: [],
      files: [{ kind: "file", id: "file-1", title: "nabidka.pdf" }],
      sources: [],
      model: { name: "Silný model", reason: "escalation" },
    },
  ],
};

const messages: ChatMessage[] = [
  { id: "request-1", role: "user", text: "Kdo je Jan z Acme?" },
  {
    id: "answer-1",
    role: "assistant",
    text: "Jan Novák je nákupčí.",
    replyToCommandId: "command-1",
  },
];

function Thread({ session }: { session: ClientSession }) {
  const answerReceipts = useAnswerReceipts(
    session,
    "conversation-1",
    "1:command-1",
  );
  const chat = {
    session,
    language: "cs",
    busy: false,
    online: true,
    readOnly: false,
    answerReceipts,
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

test("an answer shows one quiet line from its receipt that opens to the details", async () => {
  const readAnswerReceipts = jest.fn(async () => page);
  await show(
    <Thread session={{ readAnswerReceipts } as unknown as ClientSession} />,
  );
  expect(readAnswerReceipts).toHaveBeenCalledWith(
    "conversation-1",
    expect.anything(),
  );
  const line = screen.getByRole("button", {
    name: "Čteno 1 · Změněno 1 · Dovednosti 1 · Soubory 1 · Odpověděl Silný model, silnější model po kontrole",
  });
  expect(line.props.accessibilityState).toEqual(
    expect.objectContaining({ expanded: false }),
  );
  expect(screen.queryByTestId("answer-receipt-details")).toBeNull();
  await act(async () => {
    fireEvent.press(line);
  });
  expect(line.props.accessibilityState).toEqual(
    expect.objectContaining({ expanded: true }),
  );
  expect(screen.getByLabelText("Z čeho odpověď vychází")).toBeTruthy();
  expect(screen.getByText("Najdi kontakty (Acme CRM)")).toBeTruthy();
  expect(screen.getByText("Zavolat Janovi")).toBeTruthy();
  expect(screen.getByText("nabidka.pdf")).toBeTruthy();
});

test("knowledge sources show under the answer with the passages it was given", async () => {
  const sources: AnswerReceiptPage = {
    ...page,
    receipts: [
      {
        commandId: "command-1",
        read: [],
        changed: [],
        memories: [],
        skills: [],
        meetings: [],
        files: [],
        sources: [
          {
            kind: "file",
            id: "a".repeat(32),
            title: "cenik.pdf",
            passage: "Instalace stojí 12 000 Kč.",
          },
          {
            kind: "service",
            id: "b".repeat(32),
            title: "Wiki · Postupy",
            passage: "Reklamace vyřizuje Petra.",
          },
        ],
      },
    ],
  };
  await show(
    <Thread
      session={
        {
          readAnswerReceipts: jest.fn(async () => sources),
        } as unknown as ClientSession
      }
    />,
  );
  const line = screen.getByRole("button", { name: "Zdroje 2" });
  await act(async () => {
    fireEvent.press(line);
  });
  expect(screen.getByText("Zdroje")).toBeTruthy();
  expect(screen.getByText("cenik.pdf")).toBeTruthy();
  expect(screen.getByText("Wiki · Postupy")).toBeTruthy();
  expect(
    screen
      .getAllByTestId("answer-receipt-passage")
      .map((node) => node.props.children),
  ).toEqual(["Instalace stojí 12 000 Kč.", "Reklamace vyřizuje Petra."]);
});

test("a failed read or a server without receipts shows no line", async () => {
  await show(
    <Thread
      session={
        {
          readAnswerReceipts: jest.fn(async () => {
            throw new Error("connection_failed");
          }),
        } as unknown as ClientSession
      }
    />,
  );
  expect(screen.queryByTestId("answer-receipt")).toBeNull();
  await show(
    <Thread
      session={
        {
          readAnswerReceipts: jest.fn(async () => null),
        } as unknown as ClientSession
      }
    />,
  );
  expect(screen.queryByTestId("answer-receipt")).toBeNull();
});

function Picker({ session }: { session: ClientSession }) {
  const presets = useMobileChatPresets(session, true);
  const [value, setValue] = useState<string>();
  return (
    <MobilePresetPicker
      presets={presets}
      value={value}
      onChange={setValue}
      language="cs"
    />
  );
}

test("the preset picker is a named radio group of Default and the offered presets", async () => {
  const session = {
    readChatPresets: jest.fn(async () => [
      { id: "quick", name: "Rychle" },
      { id: "thorough", name: "Důkladně" },
    ]),
  } as unknown as ClientSession;
  await show(<Picker session={session} />);
  // The group is named for a screen reader; each choice is a radio in it.
  const group = screen.getByLabelText("Předvolba modelu");
  expect(group.props.accessibilityRole).toBe("radiogroup");
  const radios = screen.getAllByRole("radio");
  expect(radios.map((radio) => radio.props.accessibilityLabel)).toEqual([
    "Výchozí",
    "Rychle",
    "Důkladně",
  ]);
  expect(
    screen.getByRole("radio", { name: "Výchozí" }).props.accessibilityState,
  ).toEqual(expect.objectContaining({ checked: true }));
  await act(async () => {
    fireEvent.press(screen.getByRole("radio", { name: "Důkladně" }));
  });
  expect(
    screen.getByRole("radio", { name: "Důkladně" }).props.accessibilityState,
  ).toEqual(expect.objectContaining({ checked: true }));
});

test("no presets offered, no picker", async () => {
  await show(
    <Picker
      session={
        { readChatPresets: jest.fn(async () => []) } as unknown as ClientSession
      }
    />,
  );
  expect(screen.queryByTestId("preset-picker")).toBeNull();
});
