import React from "react";
import { AppState, type AppStateStatus } from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { createHash, randomUUID } from "node:crypto";
import { Workspace } from "../apps/mobile/App";
import { Composer, type Section } from "../apps/mobile/ScreenChrome";
import { ClientSession } from "../packages/client-core/session";
import { resetChatSession, withChatSession } from "../apps/mobile/chat-session";
import { attachmentClientHttp } from "./helpers/attachment-client-http";
import { translate } from "../packages/i18n";
import type { AttachmentCandidate } from "../packages/client-core/attachment-device";
import { messageCommand } from "../packages/client-core/commands";
import { AttachmentClientError } from "../packages/client-core/attachment-transport";
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual(
    "@react-native-async-storage/async-storage/jest/async-storage-mock",
  ),
);
const mockPick = jest.fn<
  Promise<AttachmentCandidate | null>,
  [string, number, AbortSignal]
>();
jest.mock("../apps/mobile/attachment-device", () => ({
  pickAttachment: (kind: string, limit: number, signal: AbortSignal) =>
    mockPick(kind, limit, signal),
  attachmentDigest: async (bytes: Uint8Array) =>
    jest
      .requireActual<typeof import("node:crypto")>("node:crypto")
      .createHash("sha256")
      .update(bytes)
      .digest("hex"),
  saveAttachment: jest.fn(async () => {}),
}));
jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () =>
    jest
      .requireActual<typeof import("node:crypto")>("node:crypto")
      .randomUUID(),
}));
const nodeFetch = jest.requireActual("node-fetch") as typeof fetch;
const NodeResponse = jest.requireActual<{ Response: typeof Response }>(
  "node-fetch",
).Response;
jest.setTimeout(30_000);
const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
function Harness({
  session,
  language = "en",
}: {
  session: ClientSession;
  language?: "en" | "cs";
}) {
  const [section, setSection] = React.useState<Section>("chat");
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
beforeEach(() => {
  resetChatSession();
  mockPick.mockReset();
});
test("actual mobile composer selection/cancel preserves text and a file-only send uses verified runtime refs", async () => {
  const h = await attachmentClientHttp();
  const storage = memory();
  let failLocalOutbox = false;
  const write = storage.setItem;
  storage.setItem = async (key, value) => {
    if (failLocalOutbox && key.startsWith("agent-client.command.v2:")) {
      failLocalOutbox = false;
      throw Error("TEST transient local outbox failure");
    }
    await write(key, value);
  };
  const session = new ClientSession(
    h.address,
    storage,
    h.actor,
    nodeFetch,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  const view = render(<Harness session={session} />);
  try {
    fireEvent.changeText(
      screen.getByLabelText(translate("en")("composer")),
      "TEST kept draft",
    );
    mockPick.mockResolvedValueOnce(null);
    fireEvent.press(screen.getByRole("button", { name: "Add context" }));
    fireEvent.press(await screen.findByRole("button", { name: "Camera" }));
    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(translate("en")("composer")).props.value).toBe(
      "TEST kept draft",
    );
    expect(h.puts).toBe(0);
    expect(h.commands).toBe(0);
    const bytes = new TextEncoder().encode("TEST selected text");
    const selection = {
      filename: "TEST.txt",
      mediaType: "text/plain",
      size: bytes.length,
      read: async () => bytes,
      release: jest.fn(),
    };
    mockPick.mockResolvedValueOnce({
      selection,
      release: selection.release,
      confirm: async () => selection,
    });
    fireEvent.press(screen.getByRole("button", { name: "Add context" }));
    fireEvent.press(await screen.findByRole("button", { name: "File" }));
    await waitFor(() => expect(session.attachments.ready).toBe(true));
    expect(h.commands).toBe(0);
    expect(screen.getByText("Uploaded")).toBeTruthy();
    fireEvent.changeText(
      screen.getByLabelText(translate("en")("composer")),
      "",
    );
    failLocalOutbox = true;
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("send") }),
    );
    await waitFor(() =>
      expect(session.getSnapshot().error).toBe("storage_error"),
    );
    expect(h.commands).toBe(0);
    expect(session.getSnapshot().pending).toBeNull();
    await waitFor(() => expect(session.attachments.ready).toBe(true));
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("send") }),
    );
    await waitFor(() => expect(h.commands).toBe(1));
    await waitFor(() =>
      expect(screen.getByText("Processing unavailable")).toBeTruthy(),
    );
    expect(h.snapshot.conversations[0]!.messages[0]!.text).toBe("");
    expect(selection.release).toHaveBeenCalled();
  } finally {
    view.unmount();
    session.stop();
    await h.close();
  }
});
test.each(["en", "cs"] as const)(
  "%s sendBlocked keeps text editable and prevents the actual Send callback",
  (language) => {
    const change = jest.fn(),
      send = jest.fn();
    render(
      <Composer
        language={language}
        value="TEST caption"
        onChange={change}
        onSend={send}
        onVoice={() => {}}
        hasAttachments
        sendBlocked
        disabled={false}
      />,
    );
    fireEvent.changeText(
      screen.getByLabelText(translate(language)("composer")),
      "TEST changed",
    );
    expect(change).toHaveBeenCalledWith("TEST changed");
    fireEvent.press(
      screen.getByRole("button", { name: translate(language)("send") }),
    );
    expect(send).not.toHaveBeenCalled();
  },
);
test("capability-disabled actual mobile adapter keeps Task and text with no file actions", async () => {
  const h = await attachmentClientHttp();
  h.setEnabled(false);
  const session = new ClientSession(
    h.address,
    memory(),
    h.actor,
    nodeFetch,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  const view = render(<Harness session={session} language="cs" />);
  try {
    fireEvent.press(screen.getByRole("button", { name: "Přidat kontext" }));
    expect(await screen.findByRole("button", { name: "Úkol" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fotoaparát" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Soubor" })).toBeNull();
  } finally {
    view.unmount();
    session.stop();
    await h.close();
  }
});

test("actual Workspace removes an HTTP-rejected Edit file and explicitly sends the remaining selected files", async () => {
  const h = await attachmentClientHttp();
  const session = new ClientSession(
    h.address,
    memory(),
    h.actor,
    nodeFetch,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  session.attachments.select({
    conversationId: "conversation-1",
    expectedGeneration: h.generation,
    mode: "current",
  });
  const view = render(<Harness session={session} />);
  try {
    await act(async () => {
      const bytes = new TextEncoder().encode("TEST retained files");
      for (const name of ["A", "B", "C"])
        await session.attachments.add(
          {
            filename: `${name}.txt`,
            mediaType: "text/plain",
            size: bytes.length,
            read: async () => bytes,
            release: () => {},
          },
          async (bytes) => createHash("sha256").update(bytes).digest("hex"),
        );
      await session.send(
        withChatSession(
          messageCommand(
            "TEST original caption",
            "en",
            randomUUID(),
            undefined,
            session.attachments.takeForSend(),
          ),
        ),
      );
    });
    const edit = await screen.findByRole("button", {
      name: "Edit",
    });
    const source = h.snapshot.conversations[0]!.messages[0]!;
    source.attachments = source.attachments!.filter(
      (file) => file.filename !== "B.txt",
    );
    fireEvent.press(edit);
    await waitFor(() =>
      expect(
        session.attachments
          .getSnapshot()
          .entries.find((entry) => entry.filename === "B.txt")?.state,
      ).toBe("failed"),
    );
    expect(
      screen.queryByRole("button", { name: "Retry upload: B.txt" }),
    ).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Remove: B.txt" }));
    await waitFor(() => expect(session.attachments.ready).toBe(true));
    expect(
      session.attachments.getSnapshot().entries.map((entry) => entry.filename),
    ).toEqual(["A.txt", "C.txt"]);
    expect(screen.getByLabelText(translate("en")("composer")).props.value).toBe(
      "TEST original caption",
    );
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("send") }),
    );
    await waitFor(() => expect(h.commands).toBe(2));
    expect(
      h.snapshot.conversations[0]!.messages[1]!.attachments!.map(
        (file) => file.filename,
      ),
    ).toEqual(["A.txt", "C.txt"]);
    expect(h.puts).toBe(3);
  } finally {
    view.unmount();
    session.stop();
    await h.close();
  }
});

async function historyWorkspace(request: typeof fetch) {
  const h = await attachmentClientHttp();
  const session = new ClientSession(
    h.address,
    memory(),
    h.actor,
    request,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  const view = render(<Harness session={session} />);
  await act(async () => {
    const bytes = new TextEncoder().encode("TEST original files");
    for (const name of ["A", "B", "C"])
      await session.attachments.add(
        {
          filename: `${name}.txt`,
          mediaType: "text/plain",
          size: bytes.length,
          read: async () => bytes,
          release: () => {},
        },
        async (bytes) => createHash("sha256").update(bytes).digest("hex"),
      );
    await session.send(
      withChatSession(
        messageCommand(
          "TEST source caption",
          "en",
          randomUUID(),
          undefined,
          session.attachments.takeForSend(),
        ),
      ),
    );
  });
  return {
    h,
    session,
    close: async () => {
      view.unmount();
      session.stop();
      await h.close();
    },
  };
}
test.each(
  (["Edit", "Again"] as const).flatMap((action) =>
    (["network", "uncorrelated503", "validated503"] as const).map(
      (failure) => ({ action, failure }),
    ),
  ),
)(
  "actual Workspace $action after $failure keeps source caption through compound file Retry and respects a newer edit",
  async ({ action, failure }) => {
    let references = 0;
    const f = await historyWorkspace(async (url, init) => {
      const response = await nodeFetch(url, init);
      if (
        String(url).includes("/references?") &&
        [2, 4].includes(++references)
      ) {
        await response.text();
        if (failure === "network")
          throw Error("TEST accepted pin response lost");
        return new NodeResponse(
          JSON.stringify(
            failure === "uncorrelated503"
              ? { label: "TEST accepted pin response lost" }
              : {
                  error: "attachment_unavailable",
                  retryable: false,
                  retryAfterSeconds: null,
                },
          ),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      return response;
    });
    try {
      fireEvent.changeText(
        screen.getByLabelText(translate("en")("composer")),
        "TEST unrelated draft",
      );
      fireEvent.press(await screen.findByRole("button", { name: action }));
      await screen.findByRole("button", { name: "Retry upload: B.txt" });
      expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull();
      expect(
        screen.getByLabelText(translate("en")("composer")).props.value,
      ).toBe("TEST source caption");
      fireEvent.press(
        screen.getByRole("button", { name: "Retry upload: B.txt" }),
      );
      await screen.findByRole("button", { name: "Retry upload: C.txt" });
      expect(
        screen.getByLabelText(translate("en")("composer")).props.value,
      ).toBe("TEST source caption");
      fireEvent.changeText(
        screen.getByLabelText(translate("en")("composer")),
        "TEST intentional later edit",
      );
      fireEvent.press(
        screen.getByRole("button", { name: "Retry upload: C.txt" }),
      );
      await waitFor(() => expect(f.session.attachments.ready).toBe(true));
      await waitFor(() =>
        expect(
          screen.queryByText(translate("en")("requestRejected")),
        ).toBeNull(),
      );
      expect(f.h.commands).toBe(1);
      expect(
        screen.getByLabelText(translate("en")("composer")).props.value,
      ).toBe("TEST intentional later edit");
      fireEvent.press(
        screen.getByRole("button", { name: translate("en")("send") }),
      );
      await waitFor(() => expect(f.h.commands).toBe(2));
      expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull();
      expect(f.h.snapshot.conversations[0]!.messages[1]!.text).toBe(
        "TEST intentional later edit",
      );
      expect(
        f.h.snapshot.conversations[0]!.messages[1]!.attachments,
      ).toHaveLength(3);
      const pins = f.h.calls.filter((call) =>
        call.path.includes("/references?"),
      );
      expect(pins).toHaveLength(5);
      expect(pins[1]!.body).toEqual(pins[2]!.body);
      expect(pins[3]!.body).toEqual(pins[4]!.body);
      expect(f.h.puts).toBe(3);
    } finally {
      await f.close();
    }
  },
);
test("actual Workspace ignores a late Edit callback after New chat and newer draft ownership", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let references = 0;
  const f = await historyWorkspace(async (url, init) => {
    const response = await nodeFetch(url, init);
    if (String(url).includes("/references?") && ++references === 2) {
      await held;
      await response.text();
      throw Error("TEST stale pin reply");
    }
    return response;
  });
  try {
    fireEvent.press(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(references).toBe(2));
    fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    fireEvent.changeText(
      screen.getByLabelText(translate("en")("composer")),
      "TEST newer conversation",
    );
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() =>
      expect(f.session.attachments.getSnapshot().entries).toHaveLength(0),
    );
    expect(screen.getByLabelText(translate("en")("composer")).props.value).toBe(
      "TEST newer conversation",
    );
    expect(f.h.commands).toBe(1);
  } finally {
    release();
    await f.close();
  }
});
test("actual Workspace Again waits for explicit Send when the person edits during initial pin preparation", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let references = 0;
  const f = await historyWorkspace(async (url, init) => {
    const response = await nodeFetch(url, init);
    if (String(url).includes("/references?") && ++references === 1) await held;
    return response;
  });
  try {
    fireEvent.press(await screen.findByRole("button", { name: "Again" }));
    await waitFor(() => expect(references).toBe(1));
    fireEvent.changeText(
      screen.getByLabelText(translate("en")("composer")),
      "TEST edited during preparation",
    );
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() => expect(f.session.attachments.ready).toBe(true));
    expect(f.h.commands).toBe(1);
    expect(screen.getByLabelText(translate("en")("composer")).props.value).toBe(
      "TEST edited during preparation",
    );
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("send") }),
    );
    await waitFor(() => expect(f.h.commands).toBe(2));
  } finally {
    release();
    await f.close();
  }
});

test("native system-picker inactivity survives permission UI, while background releases an app-owned preview", async () => {
  const h = await attachmentClientHttp();
  const session = new ClientSession(
    h.address,
    memory(),
    h.actor,
    nodeFetch,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  const listeners: ((state: AppStateStatus) => void)[] = [];
  const addEventListener = AppState.addEventListener;
  AppState.addEventListener = (_event, listener) => {
    listeners.push(listener as (state: AppStateStatus) => void);
    return { remove: () => {} };
  };
  await session.start(false);
  const view = render(<Harness session={session} />);
  let resolve!: (value: AttachmentCandidate | null) => void;
  const release = jest.fn();
  try {
    mockPick.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.press(screen.getByRole("button", { name: "Add context" }));
    fireEvent.press(await screen.findByRole("button", { name: "Camera" }));
    await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(1));
    await act(async () => {
      listeners.forEach((listener) => listener("inactive"));
    });
    expect(mockPick.mock.calls[0]![2].aborted).toBe(false);
    const bytes = new Uint8Array([1, 2, 3]);
    const selection = {
      filename: "TEST.png",
      mediaType: "image/png",
      size: bytes.length,
      read: async () => bytes,
      release,
    };
    await act(async () =>
      resolve({
        selection,
        release,
        raster: { uri: "file:///TEST.png", mediaType: "image/png" },
        confirm: async () => selection,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Use photo" }),
    ).toBeTruthy();
    await act(async () => {
      listeners.forEach((listener) => listener("background"));
    });
    expect(release).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Use photo" })).toBeNull();
    expect(h.puts).toBe(0);
    expect(h.commands).toBe(0);
  } finally {
    view.unmount();
    AppState.addEventListener = addEventListener;
    session.stop();
    await h.close();
  }
});

test("actual Workspace keeps row-local pin failures quiet and preserves a later unrelated Send error", async () => {
  let references = 0;
  const f = await historyWorkspace(async (url, init) => {
    const response = await nodeFetch(url, init);
    if (String(url).includes("/references?") && ++references === 2) {
      await response.text();
      return new NodeResponse(
        JSON.stringify({ label: "TEST unknown accepted pin" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return response;
  });
  let send: jest.SpyInstance | undefined;
  try {
    fireEvent.press(await screen.findByRole("button", { name: "Again" }));
    const retry = await screen.findByRole("button", {
      name: "Retry upload: B.txt",
    });
    expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull();
    fireEvent.press(retry);
    await waitFor(() => expect(f.session.attachments.ready).toBe(true));
    await waitFor(() =>
      expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull(),
    );
    // A different failure can have the same translated text; retiring the pin error must not clear it.
    send = jest
      .spyOn(f.session, "send")
      .mockImplementationOnce(async (command) => {
        // This injected port refuses before dispatch, so release only its frozen local send.
        if (command.type === "message.send" && command.attachments)
          f.session.attachments.settleSend(command.attachments, "rejected");
        throw new Error("requestRejected");
      });
    fireEvent.press(
      screen.getByRole("button", { name: translate("en")("send") }),
    );
    await screen.findByText(translate("en")("requestRejected"));
    send.mockRestore();
    send = undefined;
    fireEvent.press(screen.getByRole("button", { name: "Remove: A.txt" }));
    await waitFor(() =>
      expect(f.session.attachments.getSnapshot().entries).toHaveLength(2),
    );
    await waitFor(() => expect(f.session.attachments.ready).toBe(true));
    expect(screen.getByText(translate("en")("requestRejected"))).toBeTruthy();
    expect(f.h.commands).toBe(1);
  } finally {
    send?.mockRestore();
    await f.close();
  }
});

test("actual Workspace attachment failure stays visible while unresolved and does not follow New chat", async () => {
  let references = 0;
  const f = await historyWorkspace(async (url, init) => {
    const response = await nodeFetch(url, init);
    if (String(url).includes("/references?") && ++references === 2) {
      await response.text();
      throw Error("TEST accepted pin response lost");
    }
    return response;
  });
  try {
    fireEvent.press(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Retry upload: B.txt" });
    expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull();
    expect(
      f.session.attachments
        .getSnapshot()
        .entries.find((entry) => entry.filename === "B.txt")?.error,
    ).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(f.session.attachments.getSnapshot().entries).toHaveLength(0),
    );
    expect(screen.queryByText(translate("en")("requestRejected"))).toBeNull();
    fireEvent.changeText(
      screen.getByLabelText(translate("en")("composer")),
      "TEST newer scope draft",
    );
    expect(screen.getByLabelText(translate("en")("composer")).props.value).toBe(
      "TEST newer scope draft",
    );
    expect(f.h.commands).toBe(1);
  } finally {
    await f.close();
  }
});

test("actual Workspace preserves the global fallback for a genuine pre-entry reuse failure", async () => {
  const f = await historyWorkspace(nodeFetch);
  try {
    f.h.snapshot.conversations[0]!.messages[0]!.attachments![0]!.availability =
      "unavailable";
    await act(async () => f.session.refresh());
    fireEvent.press(await screen.findByRole("button", { name: "Again" }));
    await screen.findByText(translate("en")("requestRejected"));
    expect(f.session.attachments.getSnapshot().entries).toHaveLength(0);
    expect(f.h.commands).toBe(1);
    expect(f.h.puts).toBe(3);
  } finally {
    await f.close();
  }
});

test("actual Workspace saved-credential offline cold start keeps passive attachment discovery quiet", async () => {
  const h = await attachmentClientHttp(),
    storage = memory();
  const first = new ClientSession(
    h.address,
    storage,
    h.actor,
    nodeFetch,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await first.start(false);
  first.stop();
  let capabilityCalls = 0;
  const offline: typeof fetch = async (url) => {
    if (String(url).includes("/attachments/capabilities?")) capabilityCalls++;
    throw Error("TEST offline connection");
  };
  const session = new ClientSession(
    h.address,
    storage,
    h.actor,
    offline,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  const view = render(<Harness session={session} />);
  try {
    await waitFor(() => expect(capabilityCalls).toBeGreaterThan(0));
    await waitFor(() =>
      expect(session.attachments.getSnapshot().discovering).toBe(false),
    );
    expect(session.identityKey).toBe(first.identityKey);
    expect(session.getSnapshot().status).not.toBe("online");
    expect(session.attachments.getSnapshot().capabilities).toBeNull();
    expect(session.attachments.available).toBe(false);
    expect(session.attachments.getSnapshot().entries).toHaveLength(0);
    expect(screen.queryByText("Could not attach the file.")).toBeNull();
    expect(mockPick).not.toHaveBeenCalled();
    expect(h.commands).toBe(0);
    expect(h.puts).toBe(0);
  } finally {
    view.unmount();
    session.stop();
    await h.close();
  }
});

test.each([
  ["attachment_permission", "Camera unavailable. Choose a file."],
  ["attachment_integrity", "Could not attach the file."],
] as const)(
  "actual Workspace explicit zero-entry picker failure %s stays visible",
  async (code, message) => {
    const h = await attachmentClientHttp();
    const session = new ClientSession(
      h.address,
      memory(),
      h.actor,
      nodeFetch,
      undefined,
      undefined,
      false,
      { attachments: true, attachmentId: randomUUID },
    );
    await session.start(false);
    const view = render(<Harness session={session} />);
    try {
      mockPick.mockRejectedValueOnce(new AttachmentClientError(code));
      fireEvent.press(screen.getByRole("button", { name: "Add context" }));
      fireEvent.press(await screen.findByRole("button", { name: "Camera" }));
      await screen.findByText(message);
      expect(session.attachments.getSnapshot().entries).toHaveLength(0);
      expect(h.commands).toBe(0);
      expect(h.puts).toBe(0);
    } finally {
      view.unmount();
      session.stop();
      await h.close();
    }
  },
);

test("actual Workspace explicit zero-entry size failure remains visible without reading or upload", async () => {
  const h = await attachmentClientHttp();
  const session = new ClientSession(
    h.address,
    memory(),
    h.actor,
    nodeFetch,
    undefined,
    undefined,
    false,
    { attachments: true, attachmentId: randomUUID },
  );
  await session.start(false);
  const view = render(<Harness session={session} />);
  const read = jest.fn(async () => new Uint8Array([1]));
  try {
    const selection = {
      filename: "TEST-large.txt",
      mediaType: "text/plain",
      size:
        session.attachments.getSnapshot().capabilities!.limits.maxFileBytes + 1,
      read,
      release: jest.fn(),
    };
    mockPick.mockResolvedValueOnce({
      selection,
      release: selection.release,
      confirm: async () => selection,
    });
    fireEvent.press(screen.getByRole("button", { name: "Add context" }));
    fireEvent.press(await screen.findByRole("button", { name: "File" }));
    await screen.findByText("Could not attach the file.");
    expect(session.attachments.getSnapshot().entries).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(selection.release).toHaveBeenCalled();
    expect(h.commands).toBe(0);
    expect(h.puts).toBe(0);
  } finally {
    view.unmount();
    session.stop();
    await h.close();
  }
});
