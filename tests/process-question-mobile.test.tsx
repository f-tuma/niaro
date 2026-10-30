import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AppState } from "react-native";
import { Workspace } from "../apps/mobile/App";
import { createVoiceCapture } from "../apps/mobile/voice-capture";
import { type Section } from "../apps/mobile/ScreenChrome";
import {
  commandTarget,
  type ClientSession,
  type SessionCommand,
  type SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { resetChatSession } from "../apps/mobile/chat-session";
import { emptySnapshot, processTaskQuestion } from "../packages/test-fixtures";
import { translate } from "../packages/i18n";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import {
  voiceCapabilities,
  type VoiceRequest,
  type VoiceTranscript,
} from "../packages/protocol/voice";
import type { Language } from "../packages/protocol";

jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/app-login", () => ({
  loginProof: jest.fn(),
  authorizeApp: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-answer-command" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const gate = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fixture(language: Language = "en", conversationId = "conversation-1") {
  const snapshot = emptySnapshot();
  snapshot.conversations[0]!.id = conversationId;
  const questionWork = processTaskQuestion(language);
  questionWork.conversationId = conversationId;
  questionWork.native!.process!.provenance.conversationId = conversationId;
  snapshot.workItems.push(questionWork);
  let state: SessionState = {
    store: fromSnapshot("https://fixture.test/v1/a", snapshot.scope, snapshot),
    status: "online",
    pending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    processPending: null,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const listeners = new Set<() => void>();
  const delivery = gate<void>();
  const publish = (update: Partial<SessionState>) => {
    state = { ...state, ...update };
    listeners.forEach((listener) => listener());
  };
  const session = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    send: jest.fn((command: SessionCommand) => {
      publish({
        pending: command,
        commandStates: {
          ...state.commandStates,
          [commandTarget(command)]: "sending",
        },
        error: null,
      });
      return delivery.promise;
    }),
    retry: jest.fn(async () => {}),
    interruptPending: jest.fn(async () => true),
    voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
    transcribe: jest.fn(
      async (
        _request: VoiceRequest,
        _signal: AbortSignal,
      ): Promise<VoiceTranscript> => ({
        text: "TEST voice A",
        reviewReasons: ["uncertain"],
      }),
    ),
  };
  const capture = {
    supported: () => true,
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => ({
      mimeType: "audio/wav" as const,
      base64: "YWJjZA==",
    })),
    discard: jest.fn(async () => {}),
  };
  jest.mocked(createVoiceCapture).mockReturnValue(capture);
  function Harness() {
    const [section, setSection] = useState<Section>("tasks");
    return (
      <Workspace
        session={session as unknown as ClientSession}
        language={language}
        section={section}
        setSection={setSection}
        settings={null}
        authError={null}
        spokenReplies={false}
      />
    );
  }
  const mounted = render(<Harness />);
  const tr = translate(language);
  const openReply = async () => {
    await act(async () => {
      fireEvent.press(screen.getByRole("tab", { name: tr("chat") }));
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: tr("menu") }));
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByText(tr("processesTitle")));
      await flush();
    });
    await act(async () => {
      fireEvent.press(
        screen.getByTestId("process-run-history-TEST-process-parent"),
      );
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: tr("replyInChat") }));
      await flush();
    });
  };
  const settle = (
    status: "accepted" | "network_error" | "conflict" | "rejected",
  ) => {
    const command = state.pending;
    if (!command || command.type !== "process.answer")
      throw new Error("No native answer pending");
    let store = state.store!;
    if (status === "accepted") {
      const conversation = store.conversations[command.conversationId]!;
      const work = store.workItems[command.workItemId]!;
      const { question: _question, ...process } = work.native!.process!;
      store = {
        ...store,
        workItems: {
          ...store.workItems,
          [work.id]: {
            ...work,
            status: "running",
            native: {
              ...work.native!,
              process: {
                ...process,
                status: "running",
                journalStatus: "running",
                answerHistory: [
                  ...(process.answerHistory ?? []),
                  {
                    commandId: command.commandId,
                    questionId: command.questionId,
                    answer: command.answer,
                  },
                ],
              },
            },
          },
        },
        conversations: {
          ...store.conversations,
          [conversation.id]: {
            ...conversation,
            revision: conversation.revision + 1,
            messages: [
              ...conversation.messages,
              {
                id: `message-process-answer-${command.questionId}`,
                role: "user",
                text: command.answer,
                workItemId: command.workItemId,
              },
            ],
          },
        },
      };
    }
    publish({
      store,
      pending: status === "network_error" ? command : null,
      commandStates: {
        ...state.commandStates,
        [commandTarget(command)]: status,
      },
      error:
        status === "accepted"
          ? null
          : status === "network_error"
            ? "network_error"
            : "process_native_conflict",
    });
    delivery.resolve();
  };
  return {
    session,
    getState: () => state,
    publish,
    delivery,
    openReply,
    settle,
    capture,
    mounted,
    tr,
  };
}

beforeEach(() => {
  AppState.currentState = "active";
  resetChatSession();
  jest.clearAllMocks();
});

test.each(["en", "cs"] as const)(
  "%s Tasks reply sends exact native text and retains authoritative accepted history",
  async (language) => {
    const f = fixture(language);
    await f.openReply();
    const answer = '  TEST {"approved":true}\n';
    fireEvent.changeText(screen.getByLabelText(f.tr("composer")), answer);
    fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
    expect(f.session.send.mock.calls[0]?.[0]).toMatchObject({
      type: "process.answer",
      questionId: "TEST-question-A",
      expectedWorkRevision: 7,
      answer,
      language,
    });
    expect(screen.getByTestId("pending-message")).toBeTruthy();
    expect(screen.getByText(f.tr("process_question_pending"))).toBeTruthy();
    expect(screen.getByText(answer)).toBeTruthy();
    await act(async () => {
      f.settle("accepted");
      await flush();
    });
    expect(screen.queryByTestId("pending-message")).toBeNull();
    expect(screen.getByText(answer)).toBeTruthy();
    expect(screen.getByLabelText(f.tr("composer")).props.value).toBe("");
    expect(
      screen.queryByRole("button", { name: f.tr("clearContext") }),
    ).toBeNull();
    expect(f.getState().store?.operations).toEqual({});
  },
);

function acknowledgeDelivery(
  f: ReturnType<typeof fixture>,
  error: string | null,
) {
  const command = f.getState().pending!;
  f.publish({
    pending: null,
    store: { ...f.getState().store!, stale: true },
    commandStates: { [commandTarget(command)]: "accepted" },
    error,
  });
  f.delivery.resolve();
}
function consumedProjection(f: ReturnType<typeof fixture>) {
  const command = f.session.send.mock.calls[0]![0];
  if (command.type !== "process.answer") throw Error("No native answer");
  const store = f.getState().store!,
    conversation = store.conversations[command.conversationId]!;
  f.publish({
    store: {
      ...store,
      stale: false,
      workItems: {
        ...store.workItems,
        [command.workItemId]: {
          ...store.workItems[command.workItemId]!,
          native: {
            ...store.workItems[command.workItemId]!.native!,
            process: {
              ...store.workItems[command.workItemId]!.native!.process!,
              answerHistory: [
                {
                  commandId: command.commandId,
                  questionId: command.questionId,
                  answer: command.answer,
                },
              ],
            },
          },
        },
      },
      conversations: {
        ...store.conversations,
        [conversation.id]: {
          ...conversation,
          revision: conversation.revision + 1,
          messages: [
            ...conversation.messages,
            {
              id: `message-process-answer-${command.questionId}`,
              role: "user",
              text: command.answer,
              workItemId: command.workItemId,
            },
          ],
        },
      },
    },
  });
}
async function submitNative(
  f: ReturnType<typeof fixture>,
  voice: boolean,
  answer: string,
) {
  await f.openReply();
  if (voice) {
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: f.tr("voice_reply") }),
      );
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: f.tr("voice_stop") }));
      await flush();
    });
    fireEvent.changeText(
      screen.getByLabelText(f.tr("voice_transcript")),
      answer,
    );
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_send") }));
  } else {
    fireEvent.changeText(screen.getByLabelText(f.tr("composer")), answer);
    fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  }
}
test.each([
  ["en", false],
  ["en", true],
  ["cs", false],
  ["cs", true],
] as const)(
  "%s voice=%s acknowledged but unconsumed failure preserves original answer and explanation",
  async (language, voice) => {
    const f = fixture(language),
      answer = "  TEST unconsumed answer\n";
    await submitNative(f, voice, answer);
    await act(async () => {
      acknowledgeDelivery(f, "process_question_conflict");
      await flush();
    });
    expect(f.getState().pending).toBeNull();
    expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
    expect(
      screen.getByRole("button", { name: f.tr("clearContext") }),
    ).toBeTruthy();
    expect(screen.getByText(f.tr("process_question_rejected"))).toBeTruthy();
    expect(
      f.getState().store!.conversations["conversation-1"]!.messages,
    ).toHaveLength(0);
    expect(f.session.send).toHaveBeenCalledTimes(1);
  },
);
test.each([false, true])(
  "voice=%s retires original draft only after delayed canonical consumed projection",
  async (voice) => {
    const f = fixture(),
      answer = "  TEST delayed canonical\n";
    await submitNative(f, voice, answer);
    await act(async () => {
      acknowledgeDelivery(f, null);
      await flush();
    });
    expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
    expect(
      screen.getByRole("button", { name: f.tr("clearContext") }),
    ).toBeTruthy();
    expect(screen.getByText(f.tr("process_question_pending"))).toBeTruthy();
    await act(async () => {
      consumedProjection(f);
      await flush();
    });
    expect(screen.getByLabelText(f.tr("composer")).props.value).toBe("");
    expect(
      screen.queryByRole("button", { name: f.tr("clearContext") }),
    ).toBeNull();
    expect(screen.getByText(answer)).toBeTruthy();
    expect(f.session.send).toHaveBeenCalledTimes(1);
  },
);

test.each(["network_error", "conflict", "rejected"] as const)(
  "%s preserves answer and its frozen native context",
  async (status) => {
    const f = fixture();
    await f.openReply();
    const answer = "  TEST A exact answer\n";
    fireEvent.changeText(screen.getByLabelText(f.tr("composer")), answer);
    fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
    await act(async () => {
      f.settle(status);
      await flush();
    });
    expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
    expect(
      screen.getByRole("button", { name: f.tr("clearContext") }),
    ).toBeTruthy();
    expect(f.session.send).toHaveBeenCalledTimes(1);
    if (status === "network_error") {
      expect(screen.getByText(answer)).toBeTruthy();
      fireEvent.press(screen.getByRole("button", { name: f.tr("retry") }));
      expect(f.session.retry).toHaveBeenCalledTimes(1);
      await act(async () => {
        f.settle("accepted");
        await flush();
      });
      expect(screen.getByLabelText(f.tr("composer")).props.value).toBe("");
      expect(
        screen.queryByRole("button", { name: f.tr("clearContext") }),
      ).toBeNull();
      expect(screen.getByText(answer)).toBeTruthy();
    } else
      expect(screen.getByText(f.tr("process_question_rejected"))).toBeTruthy();
  },
);

test("delayed consumption cannot erase a newer edit containing identical answer text", async () => {
  const f = fixture();
  const answer = "  TEST identical newer edit\n";
  await submitNative(f, false, answer);
  await act(async () => {
    acknowledgeDelivery(f, null);
    await flush();
  });
  fireEvent.changeText(screen.getByLabelText(f.tr("composer")), answer);
  await act(async () => {
    consumedProjection(f);
    await flush();
  });
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
  expect(
    screen.getByRole("button", { name: f.tr("clearContext") }),
  ).toBeTruthy();
  expect(f.session.send).toHaveBeenCalledTimes(1);
});

test("local answer capacity rejection is explained without losing the reviewed text", async () => {
  const f = fixture();
  await f.openReply();
  const answer = "  TEST keep capacity draft\n";
  f.session.send.mockRejectedValueOnce(Error("process_answer_attempts_full"));
  fireEvent.changeText(screen.getByLabelText(f.tr("composer")), answer);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
    await flush();
  });
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
  expect(screen.getByText(f.tr("process_answer_attempts_full"))).toBeTruthy();
  expect(f.session.send).toHaveBeenCalledTimes(1);
});

test("after a native answer, standalone chat stays in the selected task conversation", async () => {
  const f = fixture("en", "TEST-conversation-two");
  await f.openReply();
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST answer two",
  );
  fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  await act(async () => {
    f.settle("accepted");
    await flush();
  });
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST next message",
  );
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
    await flush();
  });
  expect(f.session.send.mock.calls[1]?.[0]).toMatchObject({
    type: "message.send",
    conversationId: "TEST-conversation-two",
    text: "TEST next message",
  });
});

test("standalone voice after answering a task transcribes and sends in that conversation", async () => {
  const f = fixture("en", "TEST-conversation-two");
  await f.openReply();
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST answer two",
  );
  fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  await act(async () => {
    f.settle("accepted");
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_reply") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_stop") }));
    await flush();
  });
  expect(f.session.transcribe.mock.calls[0]?.[0].context).toEqual({
    conversationId: "TEST-conversation-two",
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_send") }));
    await flush();
  });
  expect(f.session.send.mock.calls[1]?.[0]).toMatchObject({
    type: "message.send",
    conversationId: "TEST-conversation-two",
  });
});

test("an accepted response cannot clear a newer edit bound to the same old question", async () => {
  const f = fixture();
  await f.openReply();
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST submitted A",
  );
  fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST newer edit A",
  );
  await act(async () => {
    f.settle("accepted");
    await flush();
  });
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(
    "TEST newer edit A",
  );
  expect(screen.getByText(f.tr("inputContextChanged"))).toBeTruthy();
  expect(
    screen.getByRole("button", { name: f.tr("clearContext") }),
  ).toBeTruthy();
});

test("settling an ordinary chat command does not invalidate microphone capture without a reply context", async () => {
  const f = fixture();
  await f.openReply();
  fireEvent.press(screen.getByRole("button", { name: f.tr("clearContext") }));
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST old chat command",
  );
  fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  const old = f.getState().pending!;
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_reply") }));
    await flush();
  });
  await act(async () => {
    f.publish({
      pending: null,
      commandStates: { [commandTarget(old)]: "accepted" },
    });
    f.delivery.resolve();
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_stop") }));
    await flush();
  });
  expect(screen.getByRole("button", { name: f.tr("voice_send") })).toBeTruthy();
  expect(f.session.transcribe).toHaveBeenCalledTimes(1);
  expect(f.session.send).toHaveBeenCalledTimes(1);
});

test("a pending native answer is not displayed inside a different task conversation", async () => {
  const f = fixture();
  await act(flush);
  await f.openReply();
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST pending answer A",
  );
  fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  const current = f.getState().store!;
  const other = processTaskQuestion();
  other.id = "TEST-other-parent";
  other.native!.runId = other.id;
  other.conversationId = "TEST-conversation-other";
  other.native!.process!.provenance.conversationId = other.conversationId;
  act(() =>
    f.publish({
      store: {
        ...current,
        conversations: {
          ...current.conversations,
          [other.conversationId]: {
            id: other.conversationId,
            revision: 1,
            messages: [],
          },
        },
        workItems: { ...current.workItems, [other.id]: other },
      },
    }),
  );
  fireEvent.press(screen.getByRole("tab", { name: "Work" }));
  expect(screen.queryByTestId("summary-TEST-other-parent")).toBeNull();
  expect(screen.queryByTestId("pending-message")).toBeNull();
  expect(screen.queryByText("TEST pending answer A")).toBeNull();
});

test("replaced question keeps A visible and blocks sending instead of retargeting the draft to B", async () => {
  const f = fixture();
  await act(flush);
  await f.openReply();
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST answer A",
  );
  const current = f.getState().store!,
    work = current.workItems["TEST-process-parent"]!;
  const changed = {
    ...work,
    revision: 100,
    native: {
      ...work.native!,
      process: {
        ...work.native!.process!,
        question: {
          ...work.native!.process!.question!,
          questionId: "TEST-question-B",
          question: "TEST question B?",
        },
      },
    },
  };
  act(() =>
    f.publish({
      store: {
        ...current,
        workItems: { ...current.workItems, [work.id]: changed },
      },
    }),
  );
  expect(screen.getByText(f.tr("inputContextChanged"))).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
  expect(f.session.send).not.toHaveBeenCalled();
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(
    "TEST answer A",
  );
});

test("native voice failure keeps reviewed exact text bound; clear and delayed delivery cannot restore it into chat", async () => {
  const f = fixture();
  await f.openReply();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_reply") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_stop") }));
    await flush();
  });
  const answer = "  TEST edited voice answer\n";
  fireEvent.changeText(screen.getByLabelText(f.tr("voice_transcript")), answer);
  fireEvent.press(screen.getByRole("button", { name: f.tr("voice_send") }));
  expect(f.session.send.mock.calls[0]?.[0]).toMatchObject({
    type: "process.answer",
    answer,
  });
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
  fireEvent.press(screen.getByRole("button", { name: f.tr("clearContext") }));
  fireEvent.changeText(
    screen.getByLabelText(f.tr("composer")),
    "TEST newer draft",
  );
  await act(async () => {
    f.settle("rejected");
    await flush();
  });
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(
    "TEST newer draft",
  );
  expect(
    screen.queryByRole("button", { name: f.tr("clearContext") }),
  ).toBeNull();
});

test("rejected native voice retains its reviewed answer and question for an explicit text retry", async () => {
  const f = fixture();
  await f.openReply();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_reply") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_stop") }));
    await flush();
  });
  const answer = "  TEST voice exact retry\n";
  fireEvent.changeText(screen.getByLabelText(f.tr("voice_transcript")), answer);
  fireEvent.press(screen.getByRole("button", { name: f.tr("voice_send") }));
  await act(async () => {
    f.settle("rejected");
    await flush();
  });
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
  expect(
    screen.getByRole("button", { name: f.tr("clearContext") }),
  ).toBeTruthy();
  expect(screen.queryByTestId("pending-message")).toBeNull();
  expect(screen.queryByText(answer)).toBeNull();
  expect(screen.getByLabelText(f.tr("composer")).props.value).toBe(answer);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("send") }));
    await flush();
  });
  expect(f.session.send).toHaveBeenCalledTimes(2);
  expect(f.session.send.mock.calls[1]?.[0]).toMatchObject({
    type: "process.answer",
    questionId: "TEST-question-A",
    answer,
  });
});

test("closing before a late native transcript cancels capture ownership and sends nothing", async () => {
  const f = fixture(),
    transcript = gate<VoiceTranscript>();
  f.session.transcribe.mockReturnValue(transcript.promise);
  await f.openReply();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_reply") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: f.tr("voice_stop") }));
    await flush();
  });
  fireEvent.press(screen.getByRole("button", { name: f.tr("clearContext") }));
  await act(async () => {
    transcript.resolve({ text: "TEST late A", reviewReasons: [] });
    await flush();
  });
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.capture.discard).toHaveBeenCalled();
});

test.each(["en", "cs"] as const)(
  "%s native question is shown once and unavailable states cannot reply",
  (language) => {
    const work = processTaskQuestion(language),
      reply = jest.fn();
    const tr = translate(language);
    const rendered = render(
      <WorkItemCard
        work={work}
        language={language}
        onReply={reply}
        onAnswer={() => {}}
      />,
    );
    expect(
      screen.getAllByText(work.native!.process!.question!.question),
    ).toHaveLength(1);
    rendered.rerender(
      <WorkItemCard
        work={processTaskQuestion(language, false)}
        language={language}
        onReply={reply}
        onAnswer={() => {}}
      />,
    );
    expect(
      screen.getAllByText(work.native!.process!.question!.question),
    ).toHaveLength(1);
    rendered.rerender(
      <WorkItemCard
        work={work}
        language={language}
        stale
        onReply={reply}
        onAnswer={() => {}}
      />,
    );
    fireEvent.press(screen.getByRole("button", { name: tr("replyInChat") }));
    expect(reply).not.toHaveBeenCalled();
    rendered.rerender(
      <WorkItemCard
        work={work}
        language={language}
        blocked
        onReply={reply}
        onAnswer={() => {}}
      />,
    );
    fireEvent.press(screen.getByRole("button", { name: tr("replyInChat") }));
    expect(reply).not.toHaveBeenCalled();
    const unavailable = {
      ...work,
      native: {
        ...work.native!,
        process: { ...work.native!.process!, detailsAvailable: false },
      },
    };
    rendered.rerender(
      <WorkItemCard
        work={unavailable}
        language={language}
        onReply={reply}
        onAnswer={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: tr("replyInChat") }),
    ).toBeNull();
  },
);
