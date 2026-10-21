import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Workspace } from "../apps/mobile/App";
import type { Section } from "../apps/mobile/ScreenChrome";
import { ClientSession } from "../packages/client-core/session";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import { emptySnapshot, processTaskQuestion } from "../packages/test-fixtures";
import { translate } from "../packages/i18n";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import type { Language } from "../packages/protocol";
import type { ProcessAnswerCommand } from "../packages/protocol/process-questions";
import { credential, authInfo } from "./auth-fixtures";
import { resetChatSession } from "../apps/mobile/chat-session";

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
jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-reviewed-answer" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;

function fixture(language: Language, conversationId = "conversation-1") {
  const snapshot = emptySnapshot();
  const work = processTaskQuestion(language);
  snapshot.conversations[0]!.id = conversationId;
  work.conversationId = conversationId;
  work.native!.process!.provenance.conversationId = conversationId;
  snapshot.workItems.push(work);
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const commands: ProcessAnswerCommand[] = [];
  let outcome: "accepted" | "failed" | "rejected" | "unknown" = "accepted";
  let runtimeStatus: "failed" | "unknown" = "failed";
  let runtimeFailureCode = "process_authority_changed";
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/auth/session")) return response(authInfo());
    if (path.endsWith("/processes/commands")) {
      const command = JSON.parse(String(init?.body)) as ProcessAnswerCommand;
      commands.push(command);
      if (outcome === "unknown") throw Error("TEST disconnected");
      if (outcome === "rejected")
        return response({ error: "process_authority_changed" }, 409);
      return response(
        ProcessRuntimeResponseSchema.parse({
          profile: "agent-process-execution/2",
          scope: credential().scope,
          commandId: command.commandId,
          admission: {
            profile: "agent-process-start/1",
            status: "admitted",
            receiptId: "TEST-admission",
            intentId: "TEST-intent",
            commandId: "TEST-start",
            idempotencyKey: "TEST-start",
            commandDigest: "c".repeat(64),
            origin: {
              type: "command",
              conversationId,
              requestId: "TEST-start",
            },
            processId: "TEST-process",
            version: 1,
            artifactDigest: "a".repeat(64),
            formDigest: "b".repeat(64),
            input: {},
            inputDigest: "d".repeat(64),
            compilerVersion: "niaro-native-workflow/3",
            runId: "TEST-process-run",
            parentRunId: work.id,
            createdAt: "2026-10-06T00:00:00.000Z",
          },
          ...(outcome === "failed"
            ? {
                process: {
                  parentRunId: work.id,
                  runId: "TEST-process-run",
                  processId: "TEST-process",
                  version: 1,
                  revision: 8,
                  status: runtimeStatus,
                  failure: {
                    code: runtimeFailureCode,
                  },
                },
              }
            : {}),
        }),
      );
    }
    if (path.endsWith("/snapshot")) return response(snapshot);
    if (path.endsWith("/events"))
      return response({ ...snapshot, events: [] }, 409);
    throw Error(`Unexpected request ${path}`);
  };
  const open = () =>
    new ClientSession(
      "https://fixture.test/v1/a",
      storage,
      credential(),
      transport,
      undefined,
      undefined,
      false,
      { processQuestions: true },
    );
  const send = async (
    session: ClientSession,
    answer = '  TEST preserved\n{"approve":true}  ',
  ) => {
    await session.start(false);
    const store = session.getSnapshot().store!;
    const command = processAnswerCommand(
      store,
      captureProcessAnswerTarget(store, work.id),
      {
        commandId: "TEST-answer-A",
        idempotencyKey: "TEST-answer-key-A",
        answer,
        language,
      },
    );
    await session.send(command);
    await flush();
    return command;
  };
  return {
    open,
    send,
    work,
    snapshot,
    commands,
    cache,
    storage,
    setOutcome: (value: typeof outcome) => {
      outcome = value;
    },
    setRuntimeFailure: (status: typeof runtimeStatus, code: string) => {
      outcome = "failed";
      runtimeStatus = status;
      runtimeFailureCode = code;
    },
  };
}
async function mount(
  session: ClientSession,
  language: Language,
  initial: Section = "tasks",
) {
  function Harness() {
    const [section, setSection] = useState<Section>(initial);
    return (
      <Workspace
        session={session}
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
  await act(flush);
  return mounted;
}
beforeEach(() => {
  jest.useFakeTimers();
  resetChatSession();
});
afterEach(() => {
  jest.useRealTimers();
});

test.each(
  (["en", "cs"] as const).flatMap((language) =>
    (
      [
        ["failed", "requestRejected"],
        ["failed", "auth_expired"],
        ["failed", "storage_error"],
        ["unknown", ""],
      ] as const
    ).map(([status, code]) => [language, status, code] as const),
  ),
)(
  "%s accepted %s answer recovery after real reopen never translates historical %s into a current diagnosis",
  async (language, status, code) => {
    const f = fixture(language);
    f.setRuntimeFailure(status, code);
    const first = f.open();
    const command = await f.send(first);
    first.stop();
    const session = f.open();
    await session.start(false);
    const mounted = await mount(session, language, "chat");
    try {
      const state = session.getSnapshot(),
        tr = translate(language);
      expect(state.status).toBe("online");
      expect(state.pending).toBeNull();
      expect(state.error).toBeNull();
      expect(state.processNotice).toBeNull();
      expect(state.answerAttempts[0]?.outcome).toBe("accepted");
      expect(state.answerAttempts[0]?.error).toBe(code || null);
      expect(state.answerAttempts[0]?.command).toEqual(command);
      expect(screen.getByTestId("saved-process-answer")).toBeTruthy();
      expect(screen.getByText(command.answer)).toBeTruthy();
      expect(
        screen.getByText(tr("processResultUnavailable"), { exact: false }),
      ).toBeTruthy();
      for (const key of [
        "requestRejected",
        "auth_expired",
        "storage_error",
      ] as const)
        expect(screen.queryByText(tr(key), { exact: false })).toBeNull();
      expect(screen.queryByRole("button", { name: tr("retry") })).toBeNull();
      expect(f.commands).toHaveLength(1);
      fireEvent.press(screen.getByRole("tab", { name: tr("tasks") }));
      expect(
        screen.getByText(tr("processResultUnavailable"), { exact: false }),
      ).toBeTruthy();
      expect(f.commands).toHaveLength(1);
    } finally {
      mounted.unmount();
      session.stop();
    }
  },
);

test.each(["en", "cs"] as const)(
  "%s known accepted/rejected text survives actual Session restart and Workspace remount without dispatch",
  async (language) => {
    for (const outcome of ["accepted", "failed", "rejected"] as const) {
      const f = fixture(language);
      f.setOutcome(outcome);
      const first = f.open();
      const command = await f.send(first);
      const old = await mount(first, language);
      old.unmount();
      const session = f.open();
      const mounted = await mount(session, language);
      expect(screen.getByTestId("saved-process-answer")).toBeTruthy();
      expect(screen.getByText(command.answer)).toBeTruthy();
      expect(
        screen.getByText(translate(language)("savedProcessAnswer")),
      ).toBeTruthy();
      expect(session.getSnapshot().answerAttempts[0]?.outcome).toBe(
        outcome === "rejected" ? "rejected" : "accepted",
      );
      expect(session.getSnapshot().pending).toBeNull();
      expect(session.getSnapshot().answerAttempts[0]?.error).toBe(
        outcome === "accepted" ? null : "process_authority_changed",
      );
      expect(f.commands).toHaveLength(1);
      expect(f.snapshot.conversations[0]!.messages).toHaveLength(0);
      mounted.unmount();
    }
  },
);

test.each(["en", "cs"] as const)(
  "%s recovered answer in another conversation is discoverable and Review keeps its exact original context",
  async (language) => {
    const f = fixture(language, "TEST-other-conversation");
    const first = f.open();
    const command = await f.send(first);
    first.stop();
    const session = f.open();
    const mounted = await mount(session, language, "chat");
    fireEvent.press(
      screen.getByRole("button", {
        name: translate(language)("savedProcessAnswerReview"),
      }),
    );
    expect(
      screen.getByLabelText(translate(language)("composer")).props.value,
    ).toBe(command.answer);
    expect(
      screen.getAllByText(f.work.native!.process!.question!.question).length,
    ).toBeGreaterThan(0);
    expect(f.commands).toHaveLength(1);
    mounted.unmount();
  },
);

test.each(["en", "cs"] as const)(
  "%s unknown A survives B and only explicit retry dispatches byte-identical A",
  async (language) => {
    const f = fixture(language);
    f.setOutcome("unknown");
    const first = f.open();
    const command = await f.send(first);
    first.stop();
    f.work.native!.process!.question!.questionId = "TEST-question-B";
    f.work.native!.process!.question!.toolCallId = "TEST-call-B";
    f.work.native!.process!.question!.question = "TEST question B?";
    f.work.native!.process!.journalRevision = 8;
    const session = f.open();
    const mounted = await mount(session, language);
    expect(f.commands).toHaveLength(1);
    expect(
      screen.queryByRole("button", {
        name: translate(language)("savedProcessAnswerReview"),
      }),
    ).toBeNull();
    const discard = screen.getByRole("button", {
      name: translate(language)("savedProcessAnswerDiscard"),
    });
    fireEvent.press(discard);
    expect(session.getSnapshot().pending).toEqual(command);
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: translate(language)("retry") }),
      );
      await flush();
    });
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1]).toEqual(command);
    mounted.unmount();
  },
);

test("known A cannot be reviewed against B; explicit discard removes only the local saved copy", async () => {
  const f = fixture("en");
  const first = f.open();
  await f.send(first);
  first.stop();
  f.work.native!.process!.question!.questionId = "TEST-question-B";
  f.work.native!.process!.journalRevision = 8;
  const session = f.open();
  const mounted = await mount(session, "en");
  fireEvent.press(screen.getByRole("button", { name: "Review answer" }));
  expect(f.commands).toHaveLength(1);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Discard" }));
    await flush();
  });
  expect(screen.queryByTestId("saved-process-answer")).toBeNull();
  expect(f.commands).toHaveLength(1);
  mounted.unmount();
  const again = await mount(f.open(), "en");
  expect(screen.queryByTestId("saved-process-answer")).toBeNull();
  again.unmount();
});

test("archived consumed A retires via exact canonical answerHistory and cannot reappear after a second restart", async () => {
  const f = fixture("en");
  const first = f.open();
  const command = await f.send(first);
  first.stop();
  const session = f.open();
  const mounted = await mount(session, "en");
  f.work.native!.process!.answerHistory = [
    {
      commandId: command.commandId,
      questionId: command.questionId,
      answer: command.answer,
    },
  ];
  await act(async () => {
    await session.refresh();
    await flush();
  });
  expect(screen.queryByTestId("saved-process-answer")).toBeNull();
  mounted.unmount();
  f.work.native!.process!.answerHistory = [];
  const again = await mount(f.open(), "en");
  expect(screen.queryByTestId("saved-process-answer")).toBeNull();
  expect(f.commands).toHaveLength(1);
  again.unmount();
});

test("unreadable attempt ledger blocks the composer; explicit refresh restores the original pending without dispatch", async () => {
  const f = fixture("en");
  f.setOutcome("unknown");
  const first = f.open();
  const command = await f.send(first);
  first.stop();
  for (const key of f.cache.keys())
    if (key.startsWith("agent-client.command.v2:")) f.cache.delete(key);
  const read = f.storage.getItem;
  let unreadable = true;
  f.storage.getItem = async (key) => {
    if (
      unreadable &&
      key.startsWith("agent-client.process-answer-attempts.v1:")
    )
      throw Error("TEST unavailable storage");
    return read(key);
  };
  const session = f.open();
  const mounted = await mount(session, "en", "chat");
  expect(session.getSnapshot().answerRecoveryBlocked).toBe(true);
  expect(
    screen.getByText(translate("en")("savedProcessAnswerStorageBlocked")),
  ).toBeTruthy();
  fireEvent.changeText(
    screen.getByLabelText(translate("en")("composer")),
    "TEST newer local draft",
  );
  expect(
    screen.getByRole("button", { name: translate("en")("send") }).props
      .accessibilityState.disabled,
  ).toBe(true);
  expect(f.commands).toHaveLength(1);
  unreadable = false;
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("refresh") }),
    );
    await flush();
  });
  expect(session.getSnapshot().answerRecoveryBlocked).toBe(false);
  expect(session.getSnapshot().pending).toEqual(command);
  expect(screen.getByTestId("saved-process-answer")).toBeTruthy();
  expect(f.commands).toHaveLength(1);
  mounted.unmount();
});

test("Retry saving repairs a known delivered answer without another command POST", async () => {
  const f = fixture("en");
  const write = f.storage.setItem;
  let fail = true;
  f.storage.setItem = async (key, value) => {
    if (
      fail &&
      key.startsWith("agent-client.process-answer-attempts.v1:") &&
      JSON.parse(value).attempts.some(
        (attempt: { outcome: string }) => attempt.outcome === "accepted",
      )
    ) {
      fail = false;
      throw Error("TEST local save failed");
    }
    return write(key, value);
  };
  const session = f.open();
  await f.send(session);
  const mounted = await mount(session, "en");
  expect(session.getSnapshot().pending?.commandId).toBe("TEST-answer-A");
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Save again" }));
    await flush();
  });
  expect(session.getSnapshot().pending).toBeNull();
  expect(f.commands).toHaveLength(1);
  expect(screen.getByTestId("saved-process-answer")).toBeTruthy();
  mounted.unmount();
});
