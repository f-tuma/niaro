import { companionCopy } from "../apps/mobile/companion-copy";
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react-native";
import { Workspace } from "../apps/mobile/App";
import { ProcessApprovalRecovery } from "../apps/mobile/ProcessApprovalRecovery";
import { ProcessApprovalRecoveryCard } from "../packages/ui-catalog/ProcessApprovalRecoveryCard";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import { resetChatSession } from "../apps/mobile/chat-session";
import type { Section } from "../apps/mobile/ScreenChrome";
import type { Language } from "../packages/protocol";
import { translate } from "../packages/i18n";
import { ClientSession, commandTarget } from "../packages/client-core/session";
import { PROCESS_EXECUTION_UNVERIFIED } from "../packages/client-core/process-command-notice";
import {
  captureProcessResolveTarget,
  processResolveCommand,
} from "../packages/client-core/process-commands";
import {
  processApprovalFixture,
  processApprovalWork,
  approvalResponse,
} from "./helpers/process-approval-client";

jest.mock("expo-crypto", () => {
  let count = 0;
  return { randomUUID: () => `TEST-recovery-${++count}` };
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
  ensureMicrophone: jest.fn(async () => true),
  createVoiceCapture: jest.fn(),
}));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

type Fixture = ReturnType<typeof processApprovalFixture>;
const sessions: ClientSession[] = [];
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const pendingKey = (session: ClientSession) =>
  `agent-client.command.v2:${session.identityKey}`;
const open = (h: Fixture) => {
  const session = h.open();
  sessions.push(session);
  return session;
};
beforeEach(() => resetChatSession());
afterEach(() => {
  sessions.splice(0).forEach((session) => session.stop());
});

async function unresolved(h: Fixture, approved = true) {
  const session = open(h);
  await session.start(false);
  const target = captureProcessResolveTarget(
    session.getSnapshot().store!,
    "TEST-parent",
  );
  const command = processResolveCommand(session.getSnapshot().store!, target, {
    commandId: "TEST-original-decision-A",
    idempotencyKey: "TEST-original-decision-A-key",
    approved,
    language: "en",
  });
  // NIAR-284: a lost decision is checked by the session itself and shows no
  // card. It shows the saved card with Try again only once it failed: here a
  // Stop the server did not confirm, then the lost reply.
  let lose!: (error: Error) => void;
  h.handlers.command = () =>
    new Promise<Response>((_, reject) => {
      lose = reject;
    });
  const sent = session.send(command, false, target);
  await flush();
  expect(await session.interruptPending()).toBe(false);
  lose(Error("TEST lost reply"));
  await sent;
  expect(session.getSnapshot().processPending?.outcome).toBe("unknown");
  expect(session.getSnapshot().deliveryCheck).toBe("failed");
  return { session, target, command, bytes: h.commands[0]! };
}
/** The app returns to the foreground: the session checks a lost outcome at once. */
const foreground = async (session: ClientSession) => {
  await act(async () => {
    session.setActive(false);
    session.setActive(true);
    await flush();
  });
};

function Harness({
  session,
  language = "en",
}: {
  session: ClientSession;
  language?: Language;
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
const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name }));
    await flush();
  });
};
const openRunDetail = async (language: Language = "en") => {
  const tr = translate(language);
  await act(async () => {
    fireEvent.press(screen.getByRole("tab", { name: tr("chat") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(
      screen.getByRole("tab", { name: companionCopy(language).library }),
    );
    await flush();
  });
  await press(tr("processesTitle"));
  await act(async () => {
    fireEvent.press(screen.getByTestId("process-run-history-TEST-parent"));
    await flush();
  });
};
const closeProcessPanel = async (language: Language = "en") => {
  const tr = translate(language);
  await press(tr("back"));
  await press(tr("close"));
  // Processes open from Library; the chat is one tab away.
  await act(async () => {
    fireEvent.press(screen.getByRole("tab", { name: tr("chat") }));
    await flush();
  });
};
const reviewSaved = async (language: Language = "en") => {
  await press(translate(language)("savedProcessApprovalReview"));
  return within(screen.getByTestId("saved-process-approval"));
};

test.each(["en", "cs"] as const)(
  "%s Workspace checks lost A by itself after reopen, with no card, while B stays current and disabled",
  async (language) => {
    const h = processApprovalFixture(),
      first = open(h),
      tr = translate(language);
    await first.start(false);
    const view = render(<Harness session={first} language={language} />);
    await openRunDetail(language);
    h.handlers.command = async () => {
      throw Error("TEST lost A response");
    };
    await press(tr("serviceReject"));
    const bytes = h.commands[0]!;
    expect(JSON.parse(bytes).approved).toBe(false);
    // The lost decision shows as being sent; no card asks anything.
    expect(screen.queryByTestId("saved-process-approval")).toBeNull();
    expect(first.getSnapshot().error).toBeNull();
    expect(first.getSnapshot().deliveryCheck).toBe("checking");
    view.unmount();
    h.snapshot.workItems[0] = processApprovalWork("B", 8);
    const reopened = open(h);
    await reopened.start(false);
    render(<Harness session={reopened} language={language} />);
    await act(async () => {
      await flush();
    });
    expect(screen.queryByTestId("saved-process-approval")).toBeNull();
    expect(screen.queryByText(/Not confirmed|Nepotvrzeno/)).toBeNull();
    expect(screen.queryByRole("button", { name: tr("retry") })).toBeNull();
    expect(
      screen.queryByRole("button", { name: tr("progressRetry") }),
    ).toBeNull();
    expect(h.commands).toEqual([bytes]);
    await openRunDetail(language);
    expect(screen.getAllByTestId("work-TEST-parent")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: tr("serviceApprove") }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: tr("serviceReject") }),
    ).toBeDisabled();
    const oldB = screen.UNSAFE_getByType(WorkItemCard).props.onProcessDecision;
    await act(async () => {
      oldB(true);
      await reopened.sync();
      await reopened.refresh();
      await flush();
    });
    expect(h.commands).toEqual([bytes]);
    await closeProcessPanel(language);
    h.handlers.command = async (command) =>
      approvalResponse(h.runtime(command), 202);
    // Back in the foreground the session posts A's identical bytes once.
    await foreground(reopened);
    expect(h.commands).toEqual([bytes, bytes]);
    expect(reopened.getSnapshot().pending).toBeNull();
    expect(screen.queryByTestId("saved-process-approval")).toBeNull();
    expect(
      reopened.getSnapshot().store!.workItems["TEST-parent"]!.native!.process!
        .approval!.result.operationId,
    ).toBe("TEST-operation-B");
    expect(screen.queryByText(tr("serviceSucceeded"))).toBeNull();
    await foreground(reopened);
    expect(h.commands).toEqual([bytes, bytes]);
  },
);

test.each(["known_marker", "clear"])(
  "%s failed saving exposes an offline local retry and never another POST",
  async (failure) => {
    const h = processApprovalFixture(),
      session = open(h),
      write = h.storage.setItem;
    await session.start(false);
    const target = captureProcessResolveTarget(
      session.getSnapshot().store!,
      "TEST-parent",
    );
    const command = processResolveCommand(
      session.getSnapshot().store!,
      target,
      {
        commandId: `TEST-${failure}`,
        idempotencyKey: `TEST-${failure}-key`,
        approved: true,
        language: "en",
      },
    );
    h.storage.setItem = async (key, value) => {
      if (
        key === pendingKey(session) &&
        (failure === "clear"
          ? value === "null"
          : value !== "null" && JSON.parse(value).outcome === "accepted")
      )
        throw Error("TEST local saving failed");
      await write(key, value);
    };
    await session.send(command, false, target);
    expect(session.getSnapshot().processPending?.outcome).toBe("accepted");
    h.offline(true);
    await session.sync();
    render(<Harness session={session} />);
    await act(async () => {
      await flush();
    });
    expect(session.getSnapshot().status).toBe("offline");
    const saved = await reviewSaved();
    expect(
      saved.getByText(translate("en")("savedProcessApprovalAccepted")),
    ).toBeTruthy();
    expect(
      saved.getByRole("button", {
        name: translate("en")("processesRetrySaving"),
      }),
    ).toBeEnabled();
    const requests = h.requests.length;
    h.storage.setItem = write;
    await press(translate("en")("processesRetrySaving"));
    expect(h.commands).toHaveLength(1);
    expect(
      h.requests
        .slice(requests)
        .every((url) => new URL(url).pathname.endsWith("/snapshot")),
    ).toBe(true);
    expect(h.cache.get(pendingKey(session))).toBe("null");
    expect(session.getSnapshot().pending).toBeNull();
  },
);

test.each(["accepted", "rejected"] as const)(
  "durable known %s survives reopen and retains its original reason through offline saving",
  async (outcome) => {
    const h = processApprovalFixture(),
      first = await unresolved(h, false);
    const envelope = JSON.parse(h.cache.get(pendingKey(first.session))!);
    // Restore a valid historical known envelope; current resolve replies only emit accepted.
    envelope.outcome = outcome;
    envelope.error = "process_approval_conflict";
    h.cache.set(pendingKey(first.session), JSON.stringify(envelope));
    first.session.stop();
    h.snapshot.workItems[0] = processApprovalWork("B", 8);
    const reopened = open(h);
    await reopened.start(false);
    expect(
      reopened.getSnapshot().commandStates[commandTarget(first.command)],
    ).toBe(outcome);
    h.offline(true);
    await reopened.sync();
    render(<Harness session={reopened} language="cs" />);
    await act(async () => {
      await flush();
    });
    const saved = await reviewSaved("cs");
    expect(
      saved.getByText(translate("cs")("process_approval_conflict")),
    ).toBeTruthy();
    expect(
      saved.getByRole("button", {
        name: translate("cs")("processesRetrySaving"),
      }),
    ).toBeEnabled();
    await press(translate("cs")("processesRetrySaving"));
    expect(h.commands).toEqual([first.bytes]);
    expect(reopened.getSnapshot().error).toBe("process_approval_conflict");
    expect(reopened.getSnapshot().pending).toBeNull();
  },
);

test("valid historical A without approval details is checked with its original bytes, without borrowing B parameters", async () => {
  const h = processApprovalFixture(),
    first = await unresolved(h);
  const envelope = JSON.parse(h.cache.get(pendingKey(first.session))!);
  delete envelope.target.approval;
  h.cache.set(pendingKey(first.session), JSON.stringify(envelope));
  first.session.stop();
  h.snapshot.workItems[0] = processApprovalWork("B", 8);
  const reopened = open(h);
  await reopened.start(false);
  render(<Harness session={reopened} />);
  await act(async () => {
    await flush();
  });
  // Restored after a restart, it is checked again by the session: no card.
  expect(reopened.getSnapshot().deliveryCheck).toBe("checking");
  expect(screen.queryByTestId("saved-process-approval")).toBeNull();
  h.handlers.command = async (command) =>
    approvalResponse(h.runtime(command), 202);
  await foreground(reopened);
  expect(h.commands).toEqual([first.bytes, first.bytes]);
  expect(reopened.getSnapshot().pending).toBeNull();
});

test.each(["raw", "scope", "bytes"])(
  "%s unproved saved decision is disabled and cannot gain B proof",
  async (damage) => {
    const h = processApprovalFixture(),
      first = await unresolved(h);
    const envelope = JSON.parse(h.cache.get(pendingKey(first.session))!);
    if (damage === "scope") envelope.target.scope.workspaceId = "b";
    if (damage === "bytes")
      envelope.serializedCommand = JSON.stringify({
        ...first.command,
        approved: false,
      });
    h.cache.set(
      pendingKey(first.session),
      damage === "raw"
        ? JSON.stringify(first.command)
        : JSON.stringify(envelope),
    );
    first.session.stop();
    h.snapshot.workItems[0] = processApprovalWork("B", 8);
    const reopened = open(h);
    await reopened.start(false);
    render(<Harness session={reopened} />);
    await act(async () => {
      await flush();
    });
    expect(reopened.getSnapshot().processPending).toBeNull();
    expect(
      screen.queryByRole("button", { name: translate("en")("retry") }),
    ).toBeNull();
    if (damage === "raw") {
      // It cannot be checked safely, so it stays quietly working: no card,
      // nothing to press, and the session never posts it.
      expect(screen.queryByTestId("saved-process-approval")).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: translate("en")("progressRetry"),
        }),
      ).toBeNull();
      await foreground(reopened);
    } else expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(true);
    await act(async () => {
      await flush();
    });
    expect(h.commands).toEqual([first.bytes]);
  },
);

test("rapid saved retry taps share one original flight and do not treat promise resolution as work success", async () => {
  const h = processApprovalFixture(),
    first = await unresolved(h);
  let release!: (value: Response) => void;
  h.handlers.command = () =>
    new Promise((done) => {
      release = done;
    });
  render(
    <ProcessApprovalRecovery
      session={first.session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={1}
    />,
  );
  const retained = screen.UNSAFE_getByType(ProcessApprovalRecoveryCard).props
    .onRetry;
  await act(async () => {
    retained();
    retained();
    fireEvent.press(
      screen.getByRole("button", {
        name: translate("en")("progressRetry"),
      }),
    );
    await flush();
  });
  expect(h.commands).toEqual([first.bytes, first.bytes]);
  await act(async () => {
    release(approvalResponse(h.runtime(first.command), 202));
    await flush();
  });
  expect(first.session.getSnapshot().pending).toBeNull();
  expect(screen.queryByText(translate("en")("serviceSucceeded"))).toBeNull();
});

test.each(["session", "language", "conversation", "chat", "unmount"])(
  "retained retry owner cannot send after %s changes",
  async (change) => {
    const h = processApprovalFixture(),
      first = await unresolved(h);
    const props = {
      session: first.session,
      language: "en" as const,
      conversationId: "conversation-1",
      chatGeneration: 1,
    };
    const view = render(<ProcessApprovalRecovery {...props} />);
    const retained = screen.UNSAFE_getByType(ProcessApprovalRecoveryCard).props
      .onRetry;
    const replacement = change === "session" ? open(h) : first.session;
    if (change === "session") await replacement.start(false);
    if (change === "unmount") view.unmount();
    else
      view.rerender(
        <ProcessApprovalRecovery
          {...props}
          session={replacement}
          language={change === "language" ? "cs" : "en"}
          conversationId={
            change === "conversation"
              ? "TEST-other-conversation"
              : props.conversationId
          }
          chatGeneration={change === "chat" ? 2 : 1}
        />,
      );
    await act(async () => {
      retained();
      await flush();
    });
    expect(h.commands).toEqual([first.bytes]);
  },
);

test("retained A retry cannot retry a new B outbox command", async () => {
  const h = processApprovalFixture(),
    first = await unresolved(h);
  const view = render(
    <ProcessApprovalRecovery
      session={first.session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={1}
    />,
  );
  const retained = screen.UNSAFE_getByType(ProcessApprovalRecoveryCard).props
    .onRetry;
  h.handlers.command = async (command) =>
    approvalResponse(h.runtime(command), 202);
  await act(async () => {
    await first.session.retry();
    await flush();
  });
  h.snapshot.workItems[0] = processApprovalWork("B", 8);
  await act(async () => {
    await first.session.sync();
    await flush();
  });
  const targetB = captureProcessResolveTarget(
    first.session.getSnapshot().store!,
    "TEST-parent",
  );
  const commandB = processResolveCommand(
    first.session.getSnapshot().store!,
    targetB,
    {
      commandId: "TEST-new-B",
      idempotencyKey: "TEST-new-B-key",
      approved: true,
      language: "en",
    },
  );
  h.handlers.command = async () => {
    throw Error("TEST lost B response");
  };
  await act(async () => {
    await first.session.send(commandB, false, targetB);
    await flush();
  });
  // B's lost reply is checked by the session: no card for B, and A's
  // retained Try again cannot reach it.
  expect(first.session.getSnapshot().deliveryCheck).toBe("checking");
  expect(view.queryByTestId("saved-process-approval")).toBeNull();
  const before = [...h.commands];
  await act(async () => {
    retained();
    await flush();
  });
  expect(h.commands).toEqual(before);
  expect(first.session.getSnapshot().pending).toEqual(commandB);
});

test("a stale or offline projection fences a retained unknown retry", async () => {
  const h = processApprovalFixture(),
    first = await unresolved(h);
  render(
    <ProcessApprovalRecovery
      session={first.session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={1}
    />,
  );
  const retained = screen.UNSAFE_getByType(ProcessApprovalRecoveryCard).props
    .onRetry;
  h.offline(true);
  await act(async () => {
    await first.session.sync();
    retained();
    await flush();
  });
  expect(
    screen.getByRole("button", {
      name: translate("en")("progressRetry"),
    }),
  ).toBeDisabled();
  expect(h.commands).toEqual([first.bytes]);
});

test("StrictMode effect replay remains passive and its current retry still works", async () => {
  const h = processApprovalFixture(),
    first = await unresolved(h);
  h.handlers.command = async (command) =>
    approvalResponse(h.runtime(command), 202);
  render(
    <React.StrictMode>
      <ProcessApprovalRecovery
        session={first.session}
        language="en"
        conversationId="conversation-1"
        chatGeneration={1}
      />
    </React.StrictMode>,
  );
  expect(h.commands).toEqual([first.bytes]);
  await press(translate("en")("progressRetry"));
  expect(h.commands).toEqual([first.bytes, first.bytes]);
});

test.each(["en", "cs"] as const)(
  "%s conflict stays quietly working across a real Session reopen and a failed rewrite shows Try again with the storage error",
  async (language) => {
    const h = processApprovalFixture(),
      session = open(h),
      tr = translate(language);
    await session.start(false);
    const target = captureProcessResolveTarget(
      session.getSnapshot().store!,
      "TEST-parent",
    );
    const command = processResolveCommand(
      session.getSnapshot().store!,
      target,
      {
        commandId: "TEST-unverified-original",
        idempotencyKey: "TEST-unverified-original-key",
        approved: false,
        language: "en",
      },
    );
    h.handlers.command = async () =>
      approvalResponse({ error: "process_start_conflict" }, 409);
    await session.send(command, false, target);
    const bytes = h.commands[0]!;
    session.stop();
    h.snapshot.workItems = [];
    const reopened = open(h);
    await reopened.start(false);
    render(<Harness session={reopened} language={language} />);
    // The server could not verify it: it stays working, the technical
    // explanation stays out of view.
    expect(
      screen.queryByText(tr("savedProcessExecutionUnverified")),
    ).toBeNull();
    expect(screen.queryByTestId("saved-process-approval")).toBeNull();
    expect(reopened.getSnapshot().processPending?.error).toBe(
      PROCESS_EXECUTION_UNVERIFIED,
    );
    expect(h.commands).toEqual([bytes]);
    const write = h.storage.setItem;
    h.storage.setItem = async (key, value) => {
      if (key === pendingKey(reopened)) throw Error("TEST retry write failed");
      await write(key, value);
    };
    // The session's own check cannot save the command before sending it.
    await foreground(reopened);
    expect(reopened.getSnapshot().deliveryCheck).toBe("failed");
    const saved = within(screen.getByTestId("saved-process-approval"));
    expect(saved.getByText(tr("progressFailedHint"))).toBeTruthy();
    expect(
      saved.getByRole("button", { name: tr("progressRetry") }),
    ).toBeTruthy();
    expect(
      screen.queryByText(tr("savedProcessExecutionUnverified")),
    ).toBeNull();
    expect(screen.getAllByText(tr("storage_error")).length).toBeGreaterThan(0);
    const details = await reviewSaved(language);
    expect(
      details.getByTestId("service-action-parameters").props.children,
    ).toBe(target.approval!.result.inputJson);
    expect(h.commands).toEqual([bytes]);
    expect(reopened.getSnapshot().processPending?.outcome).toBe("unknown");
    expect(reopened.getSnapshot().processPending?.target).toEqual(target);
  },
);

test.each([
  PROCESS_EXECUTION_UNVERIFIED,
  "savedProcessExecutionUnverified",
] as const)(
  "raw global error %s cannot acquire internal recovery copy",
  async (code) => {
    const h = processApprovalFixture(),
      session = open(h);
    await session.start(false);
    const get = session.getSnapshot;
    const injected = {
      ...get(),
      error: code,
      processNotice: null,
    };
    session.getSnapshot = () => injected;
    render(<Harness session={session} />);
    expect(
      screen.queryByText(translate("en")("savedProcessExecutionUnverified")),
    ).toBeNull();
    expect(screen.getByText(translate("en")("requestRejected"))).toBeTruthy();
  },
);
