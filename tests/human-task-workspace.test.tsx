import React, { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react-native";
import { Workspace } from "../apps/mobile/App";
import { HumanTaskLibrary } from "../apps/mobile/HumanTaskLibrary";
import {
  commandTarget,
  type ClientSession,
  type SessionCommand,
  type SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { resetChatSession } from "../apps/mobile/chat-session";
import {
  emptySnapshot,
  nativeTaskApproval,
  nativeTaskQuestion,
  scopeFor,
} from "../packages/test-fixtures";
import { humanTaskFixture } from "../packages/test-fixtures/human-task";
import {
  HUMAN_TASK_PROFILE,
  humanTaskTransition,
  type HumanTask,
  type HumanTaskCommand,
  type HumanTaskTab,
} from "../packages/protocol/human-tasks";
import type { Section } from "../apps/mobile/ScreenChrome";
import { CONVERSATION_HISTORY_PROFILE } from "../packages/protocol";

const mockStorage = new Map<string, string>();
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorage.set(key, value);
  }),
}));
jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/app-login", () => ({
  loginProof: jest.fn(),
  authorizeApp: jest.fn(),
}));
jest.mock("expo-crypto", () => {
  let count = 0;
  return { randomUUID: () => `TEST-human-command-${++count}` };
});
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));
const flush = async () => {
  for (let n = 0; n < 50; n++) await Promise.resolve();
};
beforeEach(() => {
  mockStorage.clear();
  resetChatSession();
});

function fixture(owner = "a", includeNative = false) {
  const scope = scopeFor(owner);
  const snapshot = emptySnapshot(scope);
  if (includeNative) {
    const question = nativeTaskQuestion();
    const approval = nativeTaskApproval();
    approval.id = "TEST-native-approval";
    approval.title = "Approve calendar action";
    approval.native!.runId = approval.id;
    const running = nativeTaskQuestion();
    running.id = "TEST-ordinary-running";
    running.title = "Ordinary agent execution";
    running.status = "running";
    running.native = { runId: running.id, revision: 4 };
    const completed = {
      ...running,
      id: "TEST-ordinary-completed",
      title: "Ordinary completed execution",
      status: "succeeded" as const,
      native: { runId: "TEST-ordinary-completed", revision: 4 },
    };
    const phantomWait = {
      ...running,
      id: "TEST-phantom-wait",
      title: "System wait without a decision",
      status: "waiting_input" as const,
      native: { runId: "TEST-phantom-wait", revision: 4 },
    };
    snapshot.workItems = [question, approval, running, completed, phantomWait];
  }
  let state: SessionState = {
    store: fromSnapshot(`https://fixture.test/v1/${owner}`, scope, snapshot),
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
  // The server accepts each command at once, like a fast connection would.
  const accept = (command: SessionCommand) => {
    const store = state.store!;
    const conversation = store.conversations[command.conversationId] ?? {
      id: command.conversationId,
      revision: 0,
      messages: [],
    };
    state = {
      ...state,
      commandStates: {
        ...state.commandStates,
        [commandTarget(command)]: "accepted",
      },
      store: {
        ...store,
        conversations: {
          ...store.conversations,
          [command.conversationId]: {
            ...conversation,
            revision: conversation.revision + 1,
            messages:
              command.type === "message.send"
                ? [
                    ...conversation.messages,
                    {
                      id: `message-${command.commandId}-1`,
                      role: "user" as const,
                      text: command.text,
                      ...(command.humanTask
                        ? { humanTask: command.humanTask }
                        : {}),
                    },
                  ]
                : conversation.messages,
          },
        },
      },
    };
    for (const listener of listeners) listener();
  };
  const initial = { ...humanTaskFixture, scope, id: `TEST-human-${owner}` };
  const tasks = new Map<string, HumanTask>([[initial.id, initial]]);
  const receipts = new Map<string, HumanTask>();
  const commands: { id: string; command: HumanTaskCommand }[] = [];
  let loseAck = false;
  const session = {
    identityKey: `TEST-owner-${owner}`,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    send: jest.fn(async (command: SessionCommand) => {
      if (
        command.type === "conversation.create" ||
        command.type === "message.send"
      )
        accept(command);
    }),
    readProcessExecutions: jest.fn(async () => ({ processes: [] })),
    readMeetings: jest.fn(async () => ({ meetings: [], scope })),
    readConversations: jest.fn(async () => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope,
      conversations: [],
      nextAfter: null,
    })),
    readConversation: jest.fn(async (id: string) => {
      const conversation = state.store!.conversations[id]!;
      return {
        profile: CONVERSATION_HISTORY_PROFILE,
        scope,
        conversation: {
          id,
          title: "",
          revision: conversation.revision,
          createdAt: "2026-10-08T10:00:00.000Z",
          updatedAt: "2026-10-08T10:00:00.000Z",
          messageCount: conversation.messages.length,
          readOnly: false,
        },
        messages: conversation.messages,
        nextAfter: null,
      };
    }),
    readHumanTasks: jest.fn(async (tab: HumanTaskTab) => {
      const all = [...tasks.values()];
      const counts = {
        open: all.filter((task) => task.status === "open").length,
        done: all.filter((task) => task.status !== "open").length,
      };
      return {
        profile: HUMAN_TASK_PROFILE,
        scope,
        counts,
        next: null,
        tasks: all.filter(
          (task) => (task.status === "open") === (tab === "open"),
        ),
      };
    }),
    readHumanTask: jest.fn(async (id: string) => {
      const task = tasks.get(id);
      if (!task) throw new Error("human_task_not_found");
      return task;
    }),
    submitHumanTask: jest.fn(async (id: string, command: HumanTaskCommand) => {
      commands.push({ id, command });
      const old = receipts.get(command.commandId);
      if (old) return old;
      const task = tasks.get(id);
      if (!task) throw new Error("human_task_not_found");
      if (command.expectedRevision !== task.revision)
        throw new Error("human_task_revision_conflict");
      const status = humanTaskTransition(task.status, command.decision);
      if (!status) throw new Error("human_task_transition_invalid");
      const receipt: HumanTask = {
        ...task,
        revision: task.revision + 1,
        status,
        resolution:
          status === "open"
            ? null
            : { by: "user", reason: "", at: "2026-10-08T12:00:00.000Z" },
      };
      tasks.set(id, receipt);
      receipts.set(command.commandId, receipt);
      if (loseAck) {
        loseAck = false;
        throw new Error("connection_lost");
      }
      return receipt;
    }),
  } as unknown as ClientSession;
  return {
    session,
    initial,
    tasks,
    commands,
    loseNextAck: () => {
      loseAck = true;
    },
  };
}
function workspace(
  session: ClientSession,
  section: Section = "tasks",
  language: "en" | "cs" = "en",
) {
  return (
    <Workspace
      session={session}
      language={language}
      section={section}
      setSection={() => {}}
      settings={null}
      authError={null}
      spokenReplies={false}
    />
  );
}
test("human task filters use waiting language and keep done as the only other category", async () => {
  const h = fixture();
  render(workspace(h.session, "tasks", "cs"));
  await act(flush);
  expect(screen.getByRole("tab", { name: "Čeká" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Hotové" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Vše" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Aktivní" })).toBeNull();
});
function Navigable({ session }: { session: ClientSession }) {
  const [section, setSection] = useState<Section>("tasks");
  return (
    <Workspace
      session={session}
      language="en"
      section={section}
      setSection={setSection}
      settings={null}
      authError={null}
      spokenReplies={false}
    />
  );
}
/** Done, remove and reopen wait in the task sheet. */
async function choose(
  title: string,
  action: "Mark as done" | "Remove" | "Reopen",
) {
  fireEvent.press(screen.getByRole("button", { name: `Open task: ${title}` }));
  await act(flush);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: action }));
    await flush();
  });
}
const listed = () =>
  screen.UNSAFE_root.findAll(
    (node) =>
      typeof node.type === "string" &&
      typeof node.props.testID === "string" &&
      /^(summary-|human-task-TEST)/.test(node.props.testID),
  ).map((node) => node.props.testID as string);

test("Waiting lists human tasks only and leaves out all agent executions", async () => {
  const h = fixture("a", true);
  render(workspace(h.session));
  await act(flush);
  expect(screen.getByText(h.initial.title)).toBeTruthy();
  expect(screen.queryByText("Prepare a meeting with Jane")).toBeNull();
  expect(screen.queryByText("Approve calendar action")).toBeNull();
  expect(screen.queryByText("Question about Jane")).toBeNull();
  expect(screen.queryByText("Ordinary agent execution")).toBeNull();
  expect(screen.queryByText("Ordinary completed execution")).toBeNull();
  expect(screen.queryByText("System wait without a decision")).toBeNull();
  const order = listed();
  expect(order.at(-1)).toBe(`human-task-${h.initial.id}`);
  expect(order.filter((id) => id.startsWith("summary-"))).toHaveLength(0);
  expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  expect(screen.queryByRole("tab", { name: "Active" })).toBeNull();
  fireEvent.press(screen.getByRole("tab", { name: "Done" }));
  await act(flush);
  expect(screen.getByText("Nothing resolved yet.")).toBeTruthy();
  expect(screen.queryByText("Prepare a meeting with Jane")).toBeNull();
  expect(screen.queryByText("Ordinary completed execution")).toBeNull();
  expect(h.commands).toEqual([]);
});
test("The task sheet marks an item done, removes another and reopens one, refreshing both lists", async () => {
  const h = fixture();
  render(workspace(h.session));
  await act(flush);
  await choose(h.initial.title, "Mark as done");
  expect(h.tasks.get(h.initial.id)?.status).toBe("done");
  expect(screen.queryByTestId(`human-task-${h.initial.id}`)).toBeNull();
  expect(screen.getByText("Nothing left to resolve.")).toBeTruthy();
  const other = { ...h.initial, id: "TEST-removed", title: "Unneeded item" };
  h.tasks.set(other.id, other);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Refresh" }));
    await flush();
  });
  await choose(other.title, "Remove");
  expect(h.tasks.get(other.id)?.status).toBe("removed");
  fireEvent.press(screen.getByRole("tab", { name: "Done" }));
  await act(flush);
  expect(
    within(screen.getByTestId(`human-task-${h.initial.id}`)).getByText("Done"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId(`human-task-${other.id}`)).getByText("Removed"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Resolve with assistant" }),
  ).toBeNull();
  await choose(h.initial.title, "Reopen");
  expect(h.tasks.get(h.initial.id)?.status).toBe("open");
  fireEvent.press(screen.getByRole("tab", { name: "Waiting" }));
  await act(flush);
  expect(screen.getByTestId(`human-task-${h.initial.id}`)).toBeTruthy();
  expect(
    h.commands.map(({ command }) => [
      command.decision,
      command.expectedRevision,
    ]),
  ).toEqual([
    ["complete", 1],
    ["remove", 1],
    ["reopen", 2],
  ]);
});
test("Resolve with assistant opens a new chat with the item attached and sends it with the first message", async () => {
  const h = fixture();
  render(<Navigable session={h.session} />);
  await act(flush);
  fireEvent.press(
    screen.getByRole("button", { name: `Open task: ${h.initial.title}` }),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: "Resolve with assistant" }),
    );
    await flush();
  });
  expect(screen.getByTestId("composer-task")).toBeTruthy();
  expect(screen.getByText("Resolving task")).toBeTruthy();
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST when works for Anna?",
  );
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await flush();
  });
  const sent = (h.session.send as jest.Mock).mock.calls.map(
    ([command]) => command as SessionCommand,
  );
  expect(sent.map((command) => command.type)).toEqual([
    "conversation.create",
    "message.send",
  ]);
  const message = sent[1]!;
  expect(message.type === "message.send" && message.humanTask).toEqual({
    id: h.initial.id,
    title: h.initial.title,
  });
  expect(message.conversationId).toBe(sent[0]!.conversationId);
  expect(message.conversationId.startsWith("chat-")).toBe(true);
  // The item now belongs to the chat: shown on the message, gone from the composer.
  expect(screen.queryByTestId("composer-task")).toBeNull();
  expect(
    screen.getByLabelText(`Resolving task: ${h.initial.title}`),
  ).toBeTruthy();
  expect(h.commands).toEqual([]);
});
test("a detached item is not sent", async () => {
  const h = fixture();
  render(<Navigable session={h.session} />);
  await act(flush);
  fireEvent.press(
    screen.getByRole("button", { name: `Open task: ${h.initial.title}` }),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: "Resolve with assistant" }),
    );
    await flush();
  });
  fireEvent.press(
    screen.getByRole("button", { name: "Remove the task from this message" }),
  );
  fireEvent.changeText(screen.getByLabelText("Type a message…"), "TEST hi");
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await flush();
  });
  const message = (h.session.send as jest.Mock).mock.calls.at(-1)![0];
  expect(message.type).toBe("message.send");
  expect(message.humanTask).toBeUndefined();
});
test("lost acknowledgment survives tab navigation, remount, and another owner without replaying there", async () => {
  const a = fixture("a"),
    b = fixture("b");
  a.loseNextAck();
  const view = render(workspace(a.session));
  await act(flush);
  await choose(a.initial.title, "Mark as done");
  expect(a.commands).toHaveLength(1);
  const original = a.commands[0]!;
  expect(screen.getByTestId("human-task-recovery")).toBeTruthy();
  fireEvent.press(screen.getByRole("tab", { name: "Done" }));
  await act(flush);
  expect(screen.getByTestId("human-task-recovery")).toBeTruthy();
  view.rerender(workspace(a.session, "chat"));
  await act(flush);
  expect(screen.queryByTestId("human-task-recovery")).toBeNull();
  view.rerender(workspace(b.session));
  await act(flush);
  expect(b.commands).toEqual([]);
  expect(screen.queryByTestId("human-task-recovery")).toBeNull();
  view.rerender(workspace(a.session));
  await act(flush);
  expect(screen.getByTestId("human-task-recovery")).toBeTruthy();
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: "Retry saved decision" }),
    );
    await flush();
  });
  expect(a.commands).toEqual([original, original]);
  expect(screen.queryByTestId("human-task-recovery")).toBeNull();
  expect(b.commands).toEqual([]);
});
test("an old list response cannot replace the selected tab", async () => {
  const h = fixture();
  let release!: (
    value: Awaited<ReturnType<ClientSession["readHumanTasks"]>>,
  ) => void;
  const held = new Promise<
    Awaited<ReturnType<ClientSession["readHumanTasks"]>>
  >((resolve) => {
    release = resolve;
  });
  const first = await h.session.readHumanTasks("open");
  (h.session.readHumanTasks as jest.Mock).mockImplementationOnce(() => held);
  const view = render(
    <HumanTaskLibrary
      key={h.session.identityKey}
      session={h.session}
      language="en"
      tab="open"
      visible
    />,
  );
  await act(flush);
  view.rerender(
    <HumanTaskLibrary
      key={h.session.identityKey}
      session={h.session}
      language="en"
      tab="done"
      visible
    />,
  );
  await act(flush);
  expect(screen.getByText("Nothing resolved yet.")).toBeTruthy();
  await act(async () => {
    release(first);
    await flush();
  });
  expect(screen.queryByText(h.initial.title)).toBeNull();
  expect(screen.getByText("Nothing resolved yet.")).toBeTruthy();
});
test("Tasks explains and preserves an unsent decision from the previous model until the person reviews it", async () => {
  const h = fixture();
  const legacyKey = `agent-client.human-task-command.v1:${h.session.identityKey}`;
  mockStorage.set(
    legacyKey,
    JSON.stringify({
      version: 1,
      owner: h.session.identityKey,
      pending: {
        task: { ...h.initial, status: "active" },
        command: {
          profile: "niaro-human-tasks/1",
          commandId: "TEST-unsent-v1-decision",
          idempotencyKey: "TEST-unsent-v1-decision",
          expectedRevision: h.initial.revision,
          decision: "complete",
        },
      },
    }),
  );
  const view = render(
    <HumanTaskLibrary
      key={h.session.identityKey}
      session={h.session}
      language="en"
      tab="open"
      visible
    />,
  );
  await act(flush);
  const recovery = screen.getByTestId("human-task-legacy-recovery");
  expect(recovery).toBeTruthy();
  expect(within(recovery).getByText(h.initial.title)).toBeTruthy();
  expect(
    screen.getByText(/Its meaning changed, so it was not sent/),
  ).toBeTruthy();
  expect(h.commands).toHaveLength(0);
  expect(
    JSON.parse(mockStorage.get(legacyKey)!).pending.command.commandId,
  ).toBe("TEST-unsent-v1-decision");
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: "Show current actions",
      }),
    );
    await flush();
  });
  expect(screen.queryByTestId("human-task-legacy-recovery")).toBeNull();
  expect(JSON.parse(mockStorage.get(legacyKey)!).pending).toBeNull();
  expect(h.commands).toHaveLength(0);
  view.unmount();
});
test("an item changed by another device reconciles the rejected decision and allows an explicit decision on the current revision", async () => {
  const h = fixture();
  render(workspace(h.session));
  await act(flush);
  h.tasks.set(h.initial.id, {
    ...h.initial,
    revision: 2,
    status: "done",
    resolution: {
      by: "agent",
      reason: "Meeting booked.",
      at: "2026-10-08T12:00:00.000Z",
    },
  });
  await choose(h.initial.title, "Mark as done");
  expect(screen.queryByTestId("human-task-recovery")).toBeNull();
  expect(
    screen.getByText(/The server did not accept this saved decision/),
  ).toBeTruthy();
  expect(h.commands).toHaveLength(1);
  fireEvent.press(screen.getByRole("tab", { name: "Done" }));
  await act(flush);
  expect(
    screen.getByText("Closed by your assistant: Meeting booked."),
  ).toBeTruthy();
  await choose(h.initial.title, "Reopen");
  expect(h.commands).toHaveLength(2);
  expect(h.commands[1]!.command.expectedRevision).toBe(2);
  expect(h.commands[1]!.command.commandId).not.toBe(
    h.commands[0]!.command.commandId,
  );
});
test("a deleted source does not leave its rejected decision locking the list", async () => {
  const h = fixture();
  render(workspace(h.session));
  await act(flush);
  h.tasks.delete(h.initial.id);
  await choose(h.initial.title, "Mark as done");
  expect(screen.queryByTestId("human-task-recovery")).toBeNull();
  expect(screen.getByText(/This task was removed/)).toBeTruthy();
  expect(h.commands).toHaveLength(1);
  h.tasks.set("TEST-new-item", {
    ...h.initial,
    id: "TEST-new-item",
    title: "Another item",
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Refresh" }));
    await flush();
  });
  expect(
    screen.getByRole("button", { name: "Open task: Another item" }).props
      .accessibilityState.disabled,
  ).toBe(false);
});
