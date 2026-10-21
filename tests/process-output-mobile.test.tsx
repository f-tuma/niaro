import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { MobileWorkItemCard } from "../apps/mobile/MobileWorkItemCard";
import { translate } from "../packages/i18n";
import { ClientSession } from "../packages/client-core/session";
import { credential } from "./auth-fixtures";
import {
  processOutputFixture,
  outputPage,
  outputResponse,
  outputWork,
} from "./helpers/process-output-client";
jest.mock("expo-crypto", () => ({
  randomUUID: () => "TEST-no-output-command",
}));
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
test.each(["en", "cs"] as const)(
  "%s shared mobile detail preserves scalar types and reaches every page",
  async (language) => {
    const h = processOutputFixture(),
      session = h.open();
    await session.start(false);
    const tr = translate(language);
    render(
      <MobileWorkItemCard
        work={h.snapshot.workItems[0]!}
        session={session}
        language={language}
        conversationId="conversation-1"
        chatGeneration={1}
        onAnswer={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("processOutputOpen") }),
      );
      await flush();
    });
    expect(screen.getByTestId("process-output-page")).toBeTruthy();
    const openField = async (label: string) => {
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: tr("processOutputOpenField").replace("{label}", label),
          }),
        );
        await flush();
      });
    };
    for (const [index, value] of [
      [0, tr("processOutputEmptyString")],
      [1, "null"],
      [2, "false"],
      [3, "0"],
      [4, tr("processOutputEmpty")],
      [5, tr("processOutputEmpty")],
      [6, tr("processOutputHidden")],
    ] as const) {
      await openField(`field${index}`);
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: tr("processOutputRoot") }),
        );
        await flush();
      });
    }
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("processOutputNext") }),
      );
      await flush();
    });
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("processOutputNext") }),
      );
      await flush();
    });
    await openField("meetingId");
    expect(screen.getByTestId("process-output-value").props.children).toBe(
      "TEST-meeting-after-eight",
    );
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: tr("close") }));
      await flush();
    });
    expect(screen.queryByTestId("detail-sheet")).toBeNull();
    expect(h.writes).toHaveLength(0);
    act(() => session.stop());
  },
);
test("unmount cancels the read and a transport ignoring abort cannot reopen its old owner", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  let release!: (value: Response) => void, signal: AbortSignal | undefined;
  const request = h.request;
  const original = h.handlers.output;
  h.handlers.output = () =>
    new Promise((done) => {
      release = done;
    });
  // The session's production transport owns its AbortController. Capture it only for this probe.
  const monitored = (async (url, init) => {
    if (String(url).includes("/processes/output?"))
      signal = init?.signal as AbortSignal;
    return request(url, init);
  }) as typeof fetch;
  const owned = new ClientSession(
    h.address,
    { getItem: async () => null, setItem: async () => {} },
    credential(),
    monitored,
    undefined,
    undefined,
    false,
    { processOutputs: true },
  );
  await owned.start(false);
  const props = {
    work: h.snapshot.workItems[0]!,
    session: owned,
    language: "en" as const,
    conversationId: "conversation-1",
    chatGeneration: 1,
    onAnswer: () => {},
  };
  const rendered = render(<MobileWorkItemCard {...props} />);
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: translate("en")("processOutputOpen"),
      }),
    );
    await flush();
  });
  rendered.unmount();
  expect(signal?.aborted).toBe(true);
  const selection = {
    reference: props.work.native!.process!.output!,
    path: [],
    cursor: null,
  };
  await act(async () => {
    release(outputResponse(outputPage(selection)));
    await flush();
  });
  h.handlers.output = original;
  expect(h.writes).toHaveLength(0);
  act(() => owned.stop());
  act(() => session.stop());
});
test("revision change removes the open private page and the next owner starts closed", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  const p = {
    work: h.snapshot.workItems[0]!,
    session,
    language: "en" as const,
    conversationId: "conversation-1",
    chatGeneration: 1,
    onAnswer: () => {},
  };
  const rendered = render(<MobileWorkItemCard {...p} />);
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: translate("en")("processOutputOpen"),
      }),
    );
    await flush();
  });
  expect(screen.getByTestId("detail-sheet")).toBeTruthy();
  h.snapshot = {
    ...h.snapshot,
    cursor: h.snapshot.cursor + 1,
    workItems: [outputWork(8)],
  };
  await act(async () => {
    await session.refresh();
  });
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  rendered.rerender(
    <MobileWorkItemCard {...p} work={h.snapshot.workItems[0]!} />,
  );
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  expect(h.writes).toHaveLength(0);
  act(() => session.stop());
});
test("stopping the session immediately removes its open detail", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  render(
    <MobileWorkItemCard
      work={h.snapshot.workItems[0]!}
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={1}
      onAnswer={() => {}}
    />,
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", {
        name: translate("en")("processOutputOpen"),
      }),
    );
    await flush();
  });
  expect(screen.getByTestId("detail-sheet")).toBeTruthy();
  act(() => session.stop());
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
});
test("malformed pages show a clear read error and explicit retry without retaining a partial value", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  const tr = translate("cs");
  h.handlers.output = async () =>
    outputResponse({ value: "TEST invalid partial" });
  render(
    <MobileWorkItemCard
      work={h.snapshot.workItems[0]!}
      session={session}
      language="cs"
      conversationId="conversation-1"
      chatGeneration={1}
      onAnswer={() => {}}
    />,
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processOutputOpen") }),
    );
    await flush();
  });
  expect(screen.getByText(tr("process_output_invalid"))).toBeTruthy();
  expect(screen.queryByText("TEST invalid partial")).toBeNull();
  h.handlers.output = async (request) => outputResponse(outputPage(request));
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processOutputRetry") }),
    );
    await flush();
  });
  expect(screen.getByTestId("process-output-page")).toBeTruthy();
  expect(h.writes).toHaveLength(0);
  act(() => session.stop());
});
test("authenticated revocation discards the open private read", async () => {
  const h = processOutputFixture(),
    session = h.open();
  await session.start(false);
  const tr = translate("en");
  h.handlers.output = async () =>
    outputResponse({ error: "auth_expired" }, 401);
  render(
    <MobileWorkItemCard
      work={h.snapshot.workItems[0]!}
      session={session}
      language="en"
      conversationId="conversation-1"
      chatGeneration={1}
      onAnswer={() => {}}
    />,
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("processOutputOpen") }),
    );
    await flush();
  });
  expect(session.getSnapshot().status).toBe("unauthorized");
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  expect(screen.queryByTestId("process-output-page")).toBeNull();
  expect(h.writes).toHaveLength(0);
  act(() => session.stop());
});
test("an older server preserves the task and explains why full details are unavailable", async () => {
  const h = processOutputFixture();
  h.capability = "old";
  const session = h.open();
  await session.start(false);
  render(
    <MobileWorkItemCard
      work={session.getSnapshot().store!.workItems["TEST-output-parent"]!}
      session={session}
      language="cs"
      conversationId="conversation-1"
      chatGeneration={1}
      onAnswer={() => {}}
    />,
  );
  expect(
    screen.getByText(translate("cs")("process_output_unsupported")),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: translate("cs")("processOutputOpen"),
    }),
  ).toBeNull();
  expect(h.writes).toHaveLength(0);
  act(() => session.stop());
});
