import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { processLaunchDetails } from "./helpers/process-launch-details";
import { ProcessLaunch } from "../apps/mobile/ProcessLaunch";
import { ProcessLaunchView } from "../packages/ui-catalog/ProcessLaunchView";
import { Workspace } from "../apps/mobile/App";
import { translate } from "../packages/i18n";
import { processInputCopy as copy } from "../packages/ui-catalog/process-input-copy";
import type { Language } from "../packages/protocol";
import type { Section } from "../apps/mobile/ScreenChrome";
import {
  processLaunchFixture,
  launchGate,
  launchResponse,
} from "./helpers/process-launch-client";
import { resetChatSession } from "../apps/mobile/chat-session";
import type { ProcessOfferResult } from "../packages/protocol/process-offer";

jest.mock("expo-crypto", () => {
  let id = 0;
  return { randomUUID: () => `TEST-launch-${++id}` };
});
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
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name }));
    await flush();
  });
};
async function prepare(language: Language = "en") {
  const tr = translate(language);
  await press(tr("processesLoad"));
  fireEvent.press(
    screen.getByRole("radio", {
      name: `${tr("processesSelect")}: TEST process A`,
    }),
  );
  await press(tr("processesPrepare"));
  expect(screen.getByLabelText("name")).toBeTruthy();
}
async function review(
  language: Language = "en",
  value = "  TEST exact input\n",
) {
  await prepare(language);
  fireEvent.changeText(screen.getByLabelText("name"), value);
  await press(copy(language, "prepare"));
}
beforeEach(() => resetChatSession());

test.each(["en", "cs"] as const)(
  "%s real Session launcher reads only explicitly and preserves draft through review, close and edit",
  async (language) => {
    const h = processLaunchFixture(),
      session = h.open(),
      tr = translate(language);
    await session.start(false);
    render(
      <Workspace
        session={session}
        language={language}
        section="chat"
        setSection={jest.fn<void, [Section]>()}
        settings={null}
        authError={null}
        spokenReplies={false}
      />,
    );
    expect(h.inventoryRequests).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
    await press(tr("menu"));
    await press(tr("processesTitle"));
    await review(language);
    expect(h.commands).toHaveLength(0);
    expect(processLaunchDetails().props.children).toBe(
      JSON.stringify({ name: "  TEST exact input\n" }, null, 2),
    );
    await press(tr("close"));
    await press(tr("menu"));
    await press(tr("processesTitle"));
    await press(tr("processesEdit"));
    expect(screen.getByLabelText("name").props.value).toBe(
      "  TEST exact input\n",
    );
    await press(copy(language, "prepare"));
    await act(async () => {
      const start = screen.getByRole("button", { name: tr("processesStart") });
      fireEvent.press(start);
      fireEvent.press(start);
      await flush();
    });
    expect(h.commands).toHaveLength(1);
    expect(JSON.parse(h.commands[0]!).input).toEqual({
      name: "  TEST exact input\n",
    });
    expect(screen.getByText(tr("processesAccepted"))).toBeTruthy();
    expect(session.getSnapshot().pending).toBeNull();
    expect(Object.keys(session.getSnapshot().store!.workItems)).toHaveLength(0);
    await press(tr("processesChooseAnother"));
    expect(h.inventoryRequests).toHaveLength(2);
    session.stop();
  },
);

test("delayed form A cannot replace selected and edited form B", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  const delayed = launchGate<Response>();
  h.handlers.input = async (request) =>
    request.processId.endsWith("A")
      ? delayed.promise
      : launchResponse(h.cardFor(request));
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await press(tr("processesLoad"));
  fireEvent.press(
    screen.getByRole("radio", {
      name: `${tr("processesSelect")}: TEST process A`,
    }),
  );
  await press(tr("processesPrepare"));
  fireEvent.press(
    screen.getByRole("radio", {
      name: `${tr("processesSelect")}: TEST process B`,
    }),
  );
  await press(tr("processesPrepare"));
  fireEvent.changeText(screen.getByLabelText("name"), "TEST B survives");
  await act(async () => {
    delayed.resolve(launchResponse(h.cardFor(h.inputRequests[0]!)));
    await flush();
  });
  expect(screen.getByLabelText("name").props.value).toBe("TEST B survives");
  expect(screen.getByText("TEST process B")).toBeTruthy();
  expect(screen.queryByText("TEST process A")).toBeNull();
  expect(h.commands).toHaveLength(0);
  session.stop();
});

test.each(["language", "conversation", "generation", "session"] as const)(
  "delayed preparation is discarded after %s changes",
  async (kind) => {
    const h = processLaunchFixture(),
      session = h.open();
    const delayed = launchGate<Response>();
    h.handlers.input = async () => delayed.promise;
    await session.start(false);
    const view = render(
      <ProcessLaunch
        session={session}
        language="en"
        conversationId="conversation-1"
        chatGeneration={0}
      />,
    );
    const tr = translate("en");
    await press(tr("processesLoad"));
    fireEvent.press(
      screen.getByRole("radio", {
        name: `${tr("processesSelect")}: TEST process A`,
      }),
    );
    await press(tr("processesPrepare"));
    const replacement = kind === "session" ? h.open() : session;
    if (replacement !== session) await replacement.start(false);
    view.rerender(
      <ProcessLaunch
        session={replacement}
        language={kind === "language" ? "cs" : "en"}
        conversationId={
          kind === "conversation" ? "conversation-2" : "conversation-1"
        }
        chatGeneration={kind === "generation" ? 1 : 0}
      />,
    );
    await act(async () => {
      delayed.resolve(launchResponse(h.cardFor(h.inputRequests[0]!)));
      await flush();
    });
    expect(screen.queryByLabelText("name")).toBeNull();
    expect(
      screen.queryByRole("button", { name: tr("processesStart") }),
    ).toBeNull();
    expect(
      screen.getByText(
        translate(kind === "language" ? "cs" : "en")("processesContextChanged"),
      ),
    ).toBeTruthy();
    expect(h.commands).toHaveLength(0);
    session.stop();
    replacement.stop();
  },
);

test("delayed inventory A is discarded after same-identity Session replacement", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    delayed = launchGate<Response>();
  const original = h.handlers.inventory;
  h.handlers.inventory = async () => delayed.promise;
  await session.start(false);
  const view = render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await press(translate("en")("processesLoad"));
  const replacement = h.open();
  await replacement.start(false);
  view.rerender(
    <ProcessLaunch
      session={replacement}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await act(async () => {
    delayed.resolve(await original(new URL("https://fixture.test")));
    await flush();
  });
  expect(screen.queryByText("TEST process A")).toBeNull();
  expect(h.inputRequests).toHaveLength(0);
  session.stop();
  replacement.stop();
});

test("unknown reopened start renders original review, explicit retry uses exact bytes", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  h.outcome("unknown");
  await session.start(false);
  const view = render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await review();
  await press(tr("processesStart"));
  expect(h.commands).toHaveLength(1);
  expect(screen.getByText(tr("processesUnknown"))).toBeTruthy();
  session.stop();
  view.unmount();
  const reopened = h.open();
  await reopened.start(false);
  render(
    <ProcessLaunch
      session={reopened}
      language="cs"
      conversationId="conversation-2"
      chatGeneration={1}
    />,
  );
  expect(h.commands).toHaveLength(1);
  expect(screen.getByText("TEST process A")).toBeTruthy();
  expect(
    processLaunchDetails("process-launch-recovery-input").props.children,
  ).toBe(JSON.stringify({ name: "  TEST exact input\n" }, null, 2));
  h.outcome("accepted");
  await press(translate("cs")("processesRetrySame"));
  expect(h.commands).toHaveLength(2);
  expect(h.commands[1]).toBe(h.commands[0]);
  expect(screen.getByText(translate("cs")("processesAccepted"))).toBeTruthy();
  expect(reopened.getSnapshot().pending).toBeNull();
  reopened.stop();
});

test("known accepted saving failure reopens and retries only storage, even offline", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  h.failClear(true);
  await session.start(false);
  const view = render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await review();
  await press(tr("processesStart"));
  expect(session.getSnapshot().processPending?.outcome).toBe("accepted");
  expect(screen.getByText(tr("processesSavingFailed"))).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: tr("processesRetrySame") }),
  ).toBeNull();
  session.stop();
  view.unmount();
  const reopened = h.open();
  await reopened.start(false);
  render(
    <ProcessLaunch
      session={reopened}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  h.failClear(false);
  h.offline(true);
  await act(async () => {
    await reopened.refresh();
    await flush();
  });
  expect(reopened.getSnapshot().status).toBe("offline");
  await press(tr("processesRetrySaving"));
  expect(h.commands).toHaveLength(1);
  expect(reopened.getSnapshot().pending).toBeNull();
  expect(screen.getByText(tr("processesAccepted"))).toBeTruthy();
  reopened.stop();
});

test("rejected start explains exact admission reason and retains reviewed input for correction", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  h.outcome("rejected");
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await review();
  await press(tr("processesStart"));
  expect(screen.getByText(tr("processesRejected"))).toBeTruthy();
  expect(screen.getByText(tr("process_active_version_changed"))).toBeTruthy();
  expect(processLaunchDetails().props.children).toBe(
    JSON.stringify({ name: "  TEST exact input\n" }, null, 2),
  );
  await press(tr("processesEdit"));
  expect(screen.getByLabelText("name").props.value).toBe(
    "  TEST exact input\n",
  );
  expect(h.commands).toHaveLength(1);
  session.stop();
});

test("a stopped Session resolution is not acceptance", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await review();
  session.stop();
  await press(tr("processesStart"));
  expect(h.commands).toHaveLength(0);
  expect(screen.getByText(tr("processesNotStarted"))).toBeTruthy();
  expect(screen.queryByText(tr("processesAccepted"))).toBeNull();
});

test.each(["rejected", "unknown"] as const)(
  "reopened %s request preserves original input when editing after recovery",
  async (outcome) => {
    const h = processLaunchFixture(),
      session = h.open(),
      tr = translate("en");
    h.outcome(outcome);
    h.failClear(outcome === "rejected");
    await session.start(false);
    const view = render(
      <ProcessLaunch
        session={session}
        language="en"
        conversationId="conversation-1"
        chatGeneration={0}
      />,
    );
    await review();
    await press(tr("processesStart"));
    session.stop();
    view.unmount();
    const reopened = h.open();
    await reopened.start(false);
    render(
      <ProcessLaunch
        session={reopened}
        language="en"
        conversationId="conversation-1"
        chatGeneration={0}
      />,
    );
    h.outcome("rejected");
    h.failClear(false);
    await press(
      tr(
        outcome === "rejected" ? "processesRetrySaving" : "processesRetrySame",
      ),
    );
    expect(screen.getByText(tr("processesRejected"))).toBeTruthy();
    await press(tr("processesEdit"));
    expect(screen.getByLabelText("name").props.value).toBe(
      "  TEST exact input\n",
    );
    await press(copy("en", "prepare"));
    expect(processLaunchDetails().props.children).toBe(
      JSON.stringify({ name: "  TEST exact input\n" }, null, 2),
    );
    expect(h.commands).toHaveLength(outcome === "rejected" ? 1 : 2);
    if (outcome === "unknown") expect(h.commands[1]).toBe(h.commands[0]);
    reopened.stop();
  },
);

test("callbacks from original review A cannot submit or replace newer review B", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await review();
  const old = screen.UNSAFE_getByType(ProcessLaunchView).props;
  await press(tr("processesChooseAnother"));
  fireEvent.press(
    screen.getByRole("radio", {
      name: `${tr("processesSelect")}: TEST process B`,
    }),
  );
  await press(tr("processesPrepare"));
  fireEvent.changeText(screen.getByLabelText("name"), "TEST current B");
  act(() => old.onReview({ name: "TEST obsolete A" }));
  expect(screen.getByLabelText("name").props.value).toBe("TEST current B");
  await press(copy("en", "prepare"));
  await act(async () => {
    old.onStart();
    await flush();
  });
  expect(h.commands).toHaveLength(0);
  expect(processLaunchDetails().props.children).toBe(
    JSON.stringify({ name: "TEST current B" }, null, 2),
  );
  await press(tr("processesStart"));
  expect(h.commands).toHaveLength(1);
  expect(JSON.parse(h.commands[0]!).input).toEqual({ name: "TEST current B" });
  session.stop();
});

test("offline connection disables Start visibly and keeps exact reviewed input", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
    />,
  );
  await review();
  h.offline(true);
  await act(async () => {
    await session.refresh();
    await flush();
  });
  expect(session.getSnapshot().status).toBe("offline");
  expect(screen.getByText(tr("offline"))).toBeTruthy();
  const start = screen.getByRole("button", { name: tr("processesStart") });
  expect(start.props.accessibilityState.disabled).toBe(true);
  await act(async () => {
    fireEvent.press(start);
    await flush();
  });
  expect(h.commands).toHaveLength(0);
  expect(processLaunchDetails().props.children).toBe(
    JSON.stringify({ name: "  TEST exact input\n" }, null, 2),
  );
  session.stop();
});

test("StrictMode effect replay retains the active launcher owner", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  render(
    <React.StrictMode>
      <ProcessLaunch
        session={session}
        language="en"
        conversationId="conversation-1"
        chatGeneration={0}
      />
    </React.StrictMode>,
  );
  await review();
  await press(tr("processesStart"));
  expect(h.commands).toHaveLength(1);
  expect(screen.getByText(tr("processesAccepted"))).toBeTruthy();
  session.stop();
});

test.each(["en", "cs"] as const)(
  "%s start conflict retains its explanation and original input after Session reopen",
  async (language) => {
    const h = processLaunchFixture(),
      session = h.open(),
      tr = translate(language);
    let reopened: ReturnType<typeof h.open> | undefined;
    try {
      await session.start(false);
      const view = render(
        <ProcessLaunch
          session={session}
          language={language}
          conversationId="conversation-1"
          chatGeneration={1}
        />,
      );
      await review(language);
      h.handlers.command = async () =>
        launchResponse({ error: "process_start_conflict" }, 409);
      await press(tr("processesStart"));
      expect(
        screen.getByText(tr("savedProcessExecutionUnverified")),
      ).toBeTruthy();
      const bytes = h.commands[0]!;
      view.unmount();
      session.stop();
      reopened = h.open();
      await reopened.start(false);
      render(
        <ProcessLaunch
          session={reopened}
          language={language}
          conversationId="conversation-1"
          chatGeneration={2}
        />,
      );
      expect(
        screen.getByText(tr("savedProcessExecutionUnverified")),
      ).toBeTruthy();
      expect(
        processLaunchDetails("process-launch-recovery-input").props.children,
      ).toBe(JSON.stringify(JSON.parse(bytes).input, null, 2));
      expect(h.commands).toEqual([bytes]);
      expect(reopened.getSnapshot().processPending?.outcome).toBe("unknown");
    } finally {
      session.stop();
      reopened?.stop();
    }
  },
);

test.each([
  "client.process-execution-unverified",
  "savedProcessExecutionUnverified",
] as const)("launcher thrown %s cannot acquire internal copy", async (code) => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  try {
    await session.start(false);
    h.handlers.inventory = async () => {
      throw Error(code);
    };
    render(
      <ProcessLaunch
        session={session}
        language="en"
        conversationId="conversation-1"
        chatGeneration={1}
      />,
    );
    await press(tr("processesLoad"));
    expect(
      screen.queryByText(tr("savedProcessExecutionUnverified")),
    ).toBeNull();
    expect(h.commands).toHaveLength(0);
  } finally {
    session.stop();
  }
});

const offer = (
  overrides: Partial<ProcessOfferResult> = {},
): ProcessOfferResult => ({
  type: "process.offer",
  version: 1,
  processId: "TEST-process-A",
  processVersion: 1,
  artifactDigest: "a".repeat(64),
  name: "TEST process A",
  description: "",
  kind: "workflow",
  reason: "TEST fits",
  input: { name: "TEST offered name", unknown: "TEST dropped" },
  ...overrides,
});

test("an offered process opens its prefilled form and starts only after review", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en"),
    onDone = jest.fn();
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
      offer={offer()}
      onDone={onDone}
    />,
  );
  await act(flush);
  expect(h.inventoryRequests).toHaveLength(1);
  expect(h.inputRequests).toHaveLength(1);
  expect(screen.getByLabelText("name").props.value).toBe("TEST offered name");
  expect(h.commands).toHaveLength(0);
  await press(copy("en", "prepare"));
  expect(h.commands).toHaveLength(0);
  await press(tr("processesStart"));
  expect(h.commands).toHaveLength(1);
  expect(JSON.parse(h.commands[0]!).input).toEqual({
    name: "TEST offered name",
  });
  await press(tr("processesBackToChat"));
  expect(onDone).toHaveBeenCalledTimes(1);
  session.stop();
});

test("an offer opens once: choosing another process shows the list", async () => {
  const h = processLaunchFixture(),
    session = h.open(),
    tr = translate("en");
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={0}
      offer={offer()}
    />,
  );
  await act(flush);
  expect(h.inputRequests).toHaveLength(1);
  await press(tr("processesChooseAnother"));
  await act(flush);
  expect(h.inventoryRequests).toHaveLength(2);
  expect(h.inputRequests).toHaveLength(1);
  expect(screen.queryByLabelText("name")).toBeNull();
  session.stop();
});

test("a changed offered process asks for a new choice instead of opening another version", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  render(
    <ProcessLaunch
      session={session}
      language="cs"
      conversationId="conversation-1"
      chatGeneration={0}
      offer={offer({ processVersion: 2 })}
    />,
  );
  await act(flush);
  expect(h.inputRequests).toHaveLength(0);
  expect(
    screen.getByText(translate("cs")("processOfferUnavailable")),
  ).toBeTruthy();
  session.stop();
});
