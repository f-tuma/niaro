import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Workspace } from "../apps/mobile/App";
import {
  CHAT_IDLE_MS,
  chatBackgrounded,
  chatResumed,
  resetChatSession,
} from "../apps/mobile/chat-session";
import type { Section } from "../apps/mobile/ScreenChrome";
import { translate } from "../packages/i18n";
import { WorkItemSchema, type Language } from "../packages/protocol";
import {
  processApprovalFixture,
  approvalResponse,
} from "./helpers/process-approval-client";

jest.mock("expo-crypto", () => {
  let id = 0;
  return { randomUUID: () => `TEST-notice-${++id}` };
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
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
beforeEach(() => resetChatSession());

function Harness({
  session,
  language,
}: {
  session: ReturnType<ReturnType<typeof processApprovalFixture>["open"]>;
  language: Language;
}) {
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
async function openRunDetail(language: Language) {
  const tr = translate(language);
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
    fireEvent.press(screen.getByTestId("process-run-history-TEST-parent"));
    await flush();
  });
}
async function closeProcessPanel(language: Language) {
  const tr = translate(language);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: tr("back") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: tr("close") }));
    await flush();
  });
}
const cases = [
  ["cancelled", "process_action_rejected", "processDecisionDeclined", null],
  ["unknown", "action_failed", "processResultUnknown", null],
  ["failed", "action_failed", "processResultFailed", null],
  [
    "failed",
    "process_origin_changed",
    "processResultFailed",
    "process_origin_changed",
  ],
  ["unknown", "", "processResultUnknown", null],
  ["failed", "", "processResultFailed", null],
  ["failed", "requestRejected", "processResultFailed", null],
  ["unknown", "auth_expired", "processResultUnknown", null],
  ["unknown", "storage_error", "processResultUnknown", null],
  ["unknown", "network_error", "processResultUnknown", null],
  ["failed", "connection_failed", "processResultFailed", null],
  ["failed", "requestInterruptFailed", "processResultFailed", null],
  [
    "failed",
    "client.process-execution-unverified",
    "processResultFailed",
    null,
  ],
  ["failed", "savedProcessExecutionUnverified", "processResultFailed", null],
  [
    "unknown",
    "client.process-execution-unverified",
    "processResultUnknown",
    null,
  ],
  ["unknown", "savedProcessExecutionUnverified", "processResultUnknown", null],
] as const;

test.each(
  (["en", "cs"] as const).flatMap((language) =>
    cases.map(
      ([status, code, key, detailKey]) =>
        [language, status, code, key, detailKey] as const,
    ),
  ),
)(
  "%s %s (%s) keeps its Chat notice and canonical result while Tasks excludes the resolved agent execution",
  async (language, status, code, key, detailKey) => {
    const h = processApprovalFixture(),
      session = h.open(),
      tr = translate(language),
      noticeText = detailKey ? `${tr(key)} ${tr(detailKey)}` : tr(key);
    h.handlers.command = async (command) => {
      const runtime = h.runtime(command),
        work = JSON.parse(
          JSON.stringify(h.snapshot.workItems[0]!),
        ) as (typeof h.snapshot.workItems)[number];
      work.revision++;
      work.native!.revision = runtime.process.revision;
      work.status = status === "unknown" ? "waiting_system" : status;
      work.native!.process!.status = status;
      work.native!.process!.journalStatus = status;
      delete work.native!.process!.approval;
      work.native!.process!.receipts[1]!.status =
        status === "cancelled" ? "rejected" : status;
      work.result = "TEST original canonical detail";
      h.snapshot.workItems[0] = WorkItemSchema.parse(work);
      return approvalResponse(
        {
          ...runtime,
          process: {
            ...runtime.process,
            approval: undefined,
            status,
            failure: { code },
          },
        },
        202,
      );
    };
    await session.start(false);
    render(<Harness session={session} language={language} />);
    try {
      await openRunDetail(language);
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: tr(
              status === "cancelled" ? "serviceReject" : "serviceApprove",
            ),
          }),
        );
        await flush();
      });
      expect(screen.getByText("TEST original canonical detail")).toBeTruthy();
      await closeProcessPanel(language);
      expect(screen.getByText(noticeText)).toBeTruthy();
      expect(screen.queryByText(tr("requestRejected"))).toBeNull();
      expect(
        screen
          .getByTestId("process-command-notice")
          .findByProps({ accessibilityLiveRegion: "polite" }),
      ).toBeTruthy();
      expect(screen.getByLabelText(tr("composer"))).toBeEnabled();
      expect(screen.queryByRole("button", { name: tr("retry") })).toBeNull();
      const receipts = session
        .getSnapshot()
        .store!.workItems[
          "TEST-parent"
        ]!.native!.process!.receipts.map((receipt) => ({ ...receipt }));
      expect(receipts[0]!.status).toBe("succeeded");
      expect(receipts[1]!.status).toBe(
        status === "cancelled" ? "rejected" : status,
      );
      await act(async () => {
        fireEvent.press(screen.getByRole("tab", { name: tr("tasks") }));
        await flush();
      });
      expect(screen.getByText(noticeText)).toBeTruthy();
      expect(screen.getAllByTestId("process-command-notice")).toHaveLength(1);
      for (const tab of ["openTasks", "doneTasks"] as const) {
        await act(async () => {
          fireEvent.press(screen.getByRole("tab", { name: tr(tab) }));
          await flush();
        });
        expect(screen.queryByTestId("summary-TEST-parent")).toBeNull();
        expect(screen.queryByText("TEST original canonical detail")).toBeNull();
        expect(screen.getByText(noticeText)).toBeTruthy();
        expect(screen.getAllByTestId("process-command-notice")).toHaveLength(1);
        expect(
          session.getSnapshot().store!.workItems["TEST-parent"]!.native!
            .process!.receipts,
        ).toEqual(receipts);
      }
      await act(async () => {
        const back = screen.queryByRole("button", {
          name: language === "cs" ? "Zpět" : "Back",
        });
        fireEvent.press(back ?? screen.getByRole("tab", { name: tr("chat") }));
        await flush();
      });
      expect(screen.getByText(noticeText)).toBeTruthy();
      expect(screen.queryByText("TEST original canonical detail")).toBeNull();
      expect(screen.getByLabelText(tr("composer"))).toBeEnabled();
      expect(
        session.getSnapshot().store!.workItems["TEST-parent"]!.native!.process!
          .receipts,
      ).toEqual(receipts);
      expect(h.commands).toHaveLength(1);
      expect(JSON.parse(h.commands[0]!).approved).toBe(status !== "cancelled");
    } finally {
      session.stop();
    }
  },
);

test.each(["storage", "network"] as const)(
  "actual later local %s failure replaces a native same-code announcement in the rendered Chat",
  async (failure) => {
    const h = processApprovalFixture(),
      session = h.open(),
      rawCode = failure === "storage" ? "storage_error" : "network_error",
      localCode =
        failure === "storage" ? "storage_error" : "connectionNetworkFailed";
    const write = h.storage.setItem;
    h.handlers.command = async (command) => {
      const runtime = h.runtime(command);
      return approvalResponse(
        {
          ...runtime,
          process: {
            ...runtime.process,
            approval: undefined,
            status: "unknown",
            failure: { code: rawCode },
          },
        },
        202,
      );
    };
    await session.start(false);
    const view = render(<Harness session={session} language="en" />);
    try {
      await openRunDetail("en");
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: translate("en")("serviceApprove"),
          }),
        );
        await flush();
      });
      await closeProcessPanel("en");
      expect(
        screen.getByText(translate("en")("processResultUnknown")),
      ).toBeTruthy();
      if (failure === "storage")
        h.storage.setItem = async (key, value) => {
          if (key.includes("agent-client.snapshot.v2:"))
            throw Error("TEST actual cache write failure");
          return write(key, value);
        };
      else h.offline(true);
      await act(async () => {
        await session.refresh();
        await flush();
      });
      expect(session.getSnapshot().error).toBe(rawCode);
      if (failure === "network")
        expect(session.getSnapshot().connectionDiagnostic?.reason).toBe(
          "network",
        );
      expect(screen.queryByTestId("process-command-notice")).toBeNull();
      expect(screen.getByText(translate("en")(localCode))).toBeTruthy();
      expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull();
      view.rerender(<Harness session={session} language="cs" />);
      expect(screen.getByText(translate("cs")(localCode))).toBeTruthy();
      expect(h.commands).toHaveLength(1);
    } finally {
      h.storage.setItem = write;
      h.offline(false);
      session.stop();
    }
  },
);

test.each(["chat", "language"] as const)(
  "a late native ACK cannot announce its old %s owner or fall back to a fake config error",
  async (change) => {
    const h = processApprovalFixture(),
      session = h.open();
    let release!: (value: Response) => void;
    let result: unknown;
    h.handlers.command = (command) =>
      new Promise((done) => {
        release = done;
        const runtime = h.runtime(command);
        result = {
          ...runtime,
          process: {
            ...runtime.process,
            approval: undefined,
            status: "unknown",
            failure: { code: "action_failed" },
          },
        };
      });
    await session.start(false);
    const view = render(<Harness session={session} language="en" />);
    try {
      await openRunDetail("en");
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: translate("en")("serviceApprove"),
          }),
        );
        await flush();
      });
      if (change === "chat")
        await act(async () => {
          chatBackgrounded(0);
          chatResumed(CHAT_IDLE_MS);
          await flush();
        });
      else view.rerender(<Harness session={session} language="cs" />);
      await act(async () => {
        release(approvalResponse(result, 202));
        await flush();
      });
      expect(screen.queryByTestId("process-command-notice")).toBeNull();
      expect(
        screen.queryByText(
          translate(change === "language" ? "cs" : "en")("requestRejected"),
        ),
      ).toBeNull();
      expect(session.getSnapshot().error).toBe("action_failed");
      expect(h.commands).toHaveLength(1);
    } finally {
      session.stop();
    }
  },
);
