import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { BackHandler } from "react-native";
import { MobileWorkItemCard } from "../apps/mobile/MobileWorkItemCard";
import { Workspace } from "../apps/mobile/App";
import { resetChatSession } from "../apps/mobile/chat-session";
import type { Section } from "../apps/mobile/ScreenChrome";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import { translate } from "../packages/i18n";
import type { Language } from "../packages/protocol";
import {
  processApprovalFixture,
  processApprovalWork,
} from "./helpers/process-approval-client";

jest.mock("expo-crypto", () => {
  let count = 0;
  return { randomUUID: () => `TEST-decision-${++count}` };
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
type Fixture = ReturnType<typeof processApprovalFixture>;
beforeEach(() => resetChatSession());
function props(
  h: Fixture,
  session: ReturnType<Fixture["open"]>,
  language: Language = "en",
) {
  return {
    session,
    work: h.snapshot.workItems[0]!,
    language,
    conversationId: "conversation-1",
    chatGeneration: 1,
    source: h.address,
    workspace: session.getSnapshot().store!.scope.workspaceId,
    onAnswer: jest.fn(),
    onNativeDecision: jest.fn(),
  };
}

test.each(["en", "cs"] as const)(
  "%s shared review submits only exact parameters and one explicit flight",
  async (language) => {
    const h = processApprovalFixture(),
      session = h.open(),
      tr = translate(language);
    await session.start(false);
    let release!: (value: Response) => void;
    const held = new Promise<Response>((done) => {
      release = done;
    });
    h.handlers.command = () => held;
    const p = props(h, session, language);
    render(<MobileWorkItemCard {...p} />);
    expect(
      screen.getByText(p.work.native!.process!.approval!.result.inputJson),
    ).toBeTruthy();
    expect(h.commands).toHaveLength(0);
    expect(
      h.requests
        .filter((url) => new URL(url).pathname.endsWith("/snapshot"))
        .every(
          (url) =>
            new URL(url).searchParams.get("tasks") === "agent-process-work/3",
        ),
    ).toBe(true);
    await act(async () => {
      const button = screen.getByRole("button", { name: tr("serviceApprove") });
      fireEvent.press(button);
      fireEvent.press(button);
      await flush();
    });
    expect(h.commands).toHaveLength(1);
    const command = JSON.parse(h.commands[0]!);
    expect(command).toMatchObject({
      type: "service.resolve",
      profile: "agent-process-execution/1",
      expectedWorkRevision: 7,
      operationId: "TEST-operation-A",
      approved: true,
      language,
    });
    expect(p.onNativeDecision).not.toHaveBeenCalled();
    const envelope = session.getSnapshot().processPending!;
    expect(envelope.target.type).toBe("service.resolve");
    if (envelope.target.type === "service.resolve")
      expect(envelope.target.approval).toEqual(
        p.work.native!.process!.approval,
      );
    await act(async () => {
      release({
        ok: true,
        status: 202,
        text: async () => JSON.stringify(h.runtime(command)),
      } as Response);
      await flush();
    });
    expect(
      screen.getByRole("button", { name: tr("serviceApprove") }),
    ).toBeDisabled();
    expect(screen.queryByText(tr("serviceSucceeded"))).toBeNull();
    // A retained event callback cannot mint a second command after its ACK.
    await act(async () => {
      screen.UNSAFE_getByType(WorkItemCard).props.onProcessDecision(true);
      await flush();
    });
    expect(h.commands).toHaveLength(1);
    session.stop();
  },
);

test("Android Back dismisses the chat history drawer before leaving Chat", async () => {
  const h = processApprovalFixture(),
    session = h.open();
  await session.start(false);
  let back: Parameters<typeof BackHandler.addEventListener>[1] | undefined;
  const listener = jest
    .spyOn(BackHandler, "addEventListener")
    .mockImplementation((_event, callback) => {
      back = callback;
      return { remove: jest.fn() };
    });
  function Harness() {
    const [section, setSection] = React.useState<Section>("chat");
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
  try {
    render(<Harness />);
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: translate("en")("menu") }));
      await flush();
    });
    expect(screen.getByText(translate("en")("processesTitle"))).toBeTruthy();
    await act(async () => {
      expect(back?.({} as never)).toBe(true);
      await flush();
    });
    expect(screen.queryByText(translate("en")("newChat"))).toBeNull();
    expect(screen.getByRole("button", { name: translate("en")("menu") })).toBeTruthy();
  } finally {
    listener.mockRestore();
    session.stop();
  }
});

test.each([
  "operation",
  "parameters",
  "nativeRevision",
  "sourceAccess",
  "stale",
])(
  "old rendered A callback cannot approve after %s changes",
  async (change) => {
    const h = processApprovalFixture(),
      session = h.open();
    await session.start(false);
    const p = props(h, session);
    const result = render(<MobileWorkItemCard {...p} />);
    const old = result.UNSAFE_getByType(WorkItemCard).props.onProcessDecision;
    if (change === "operation")
      h.snapshot.workItems[0] = processApprovalWork("B", 8);
    else {
      const next = JSON.parse(JSON.stringify(h.snapshot.workItems[0]!));
      if (change === "parameters")
        next.native.process.approval.result.inputJson = '{"TEST":"changed"}';
      if (change === "nativeRevision") next.native.revision++;
      if (change === "sourceAccess") {
        delete next.native.process.approval;
        next.native.process.approvalUnavailable = "context";
        next.native.process.detailsAvailable = false;
      }
      h.snapshot.workItems[0] = next;
    }
    await act(async () => {
      if (change === "stale") {
        h.offline(true);
      }
      await session.sync();
      old(true);
      await flush();
    });
    expect(h.commands).toHaveLength(0);
    session.stop();
  },
);

test.each(["language", "conversation", "chat", "session", "unmount"])(
  "prior review owner cannot submit after %s changes",
  async (change) => {
    const h = processApprovalFixture(),
      session = h.open();
    await session.start(false);
    const p = props(h, session);
    const view = render(<MobileWorkItemCard {...p} />);
    const old = view.UNSAFE_getByType(WorkItemCard).props.onProcessDecision;
    let replacement: ReturnType<Fixture["open"]> | undefined;
    if (change === "session") {
      replacement = h.open();
      await replacement.start(false);
    }
    if (change === "unmount") view.unmount();
    else
      view.rerender(
        <MobileWorkItemCard
          {...p}
          language={change === "language" ? "cs" : "en"}
          conversationId={
            change === "conversation" ? "TEST-other" : p.conversationId
          }
          chatGeneration={change === "chat" ? 2 : 1}
          session={replacement ?? session}
        />,
      );
    await act(async () => {
      old(true);
      await flush();
    });
    expect(h.commands).toHaveLength(0);
    replacement?.stop();
    session.stop();
  },
);

test("deny is a process decision; unknown response preserves original retry while B is current", async () => {
  const h = processApprovalFixture(),
    session = h.open();
  await session.start(false);
  h.handlers.command = async () => {
    throw Error("TEST lost response");
  };
  const p = props(h, session);
  const view = render(<MobileWorkItemCard {...p} />);
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("serviceReject") }),
    );
    await flush();
  });
  expect(JSON.parse(h.commands[0]!).approved).toBe(false);
  const original = h.commands[0]!;
  view.unmount();
  session.stop();
  h.snapshot.workItems[0] = processApprovalWork("B", 8);
  const reopened = h.open();
  await reopened.start(false);
  await reopened.sync();
  render(<MobileWorkItemCard {...props(h, reopened, "cs")} />);
  expect(
    screen.getByRole("button", { name: translate("cs")("serviceApprove") }),
  ).toBeDisabled();
  h.handlers.command = async (command) =>
    ({
      ok: true,
      status: 202,
      text: async () => JSON.stringify(h.runtime(command)),
    }) as Response;
  await act(async () => {
    await reopened.retry();
    await flush();
  });
  expect(h.commands).toEqual([original, original]);
  expect(reopened.getSnapshot().pending).toBeNull();
  reopened.stop();
});

test("StrictMode replay leaves current review active and outer revision cannot retarget approval", async () => {
  const h = processApprovalFixture(),
    session = h.open();
  await session.start(false);
  h.snapshot.workItems[0]!.revision++;
  render(
    <React.StrictMode>
      <MobileWorkItemCard {...props(h, session)} />
    </React.StrictMode>,
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("serviceApprove") }),
    );
    await flush();
  });
  expect(h.commands).toHaveLength(1);
  expect(JSON.parse(h.commands[0]!).expectedWorkRevision).toBe(7);
  session.stop();
});

test.each(["en", "cs"] as const)(
	  "%s Workspace keeps a process out of Tasks and reviews it from Processes",
  async (language) => {
    const h = processApprovalFixture(),
      session = h.open();
    await session.start(false);
    function Harness() {
      const [section, setSection] = React.useState<Section>("tasks");
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
    render(<Harness />);
    // Tasks contain work for the person. Agent process runs and their
    // approvals are reviewed from Processes instead.
    expect(screen.queryByTestId("summary-TEST-parent")).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole("tab", { name: translate(language)("chat") }));
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: translate(language)("menu") }));
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByText(translate(language)("processesTitle")));
      await flush();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId("process-run-history-TEST-parent"));
      await flush();
    });
    expect(
      screen.getByText(
        h.snapshot.workItems[0]!.native!.process!.approval!.result.inputJson,
      ),
    ).toBeTruthy();
    expect(h.commands).toHaveLength(0);
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", {
          name: translate(language)("serviceReject"),
        }),
      );
      await flush();
    });
    expect(h.commands).toHaveLength(1);
    expect(JSON.parse(h.commands[0]!)).toMatchObject({
      profile: "agent-process-execution/1",
      type: "service.resolve",
      approved: false,
      operationId: "TEST-operation-A",
      expectedWorkRevision: 7,
    });
    expect(
      h.requests.filter((url) => new URL(url).pathname.endsWith("/commands")),
    ).toHaveLength(1);
    session.stop();
  },
);
