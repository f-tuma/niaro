import React from "react";
import { Linking } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { ServiceConnectionCard } from "../packages/ui-catalog/ServiceConnectionCard";
import { ServiceConnection } from "../apps/mobile/ServiceConnection";
import type { ServiceConnectionCard as ConnectionResult } from "../packages/protocol/service-oauth";
import type { ClientSession } from "../packages/client-core/session";
import { translate } from "../packages/i18n";

const result: ConnectionResult = {
  type: "service.connection",
  version: 1,
  serviceId: "test-crm",
  service: "Twenty CRM",
  resumeText: "Find my contacts",
};
const disconnected = {
  serviceId: result.serviceId,
  status: "disconnected" as const,
  ready: true,
};
const connected = {
  ...disconnected,
  status: "connected" as const,
  flow: "connected" as const,
};
const attemptId = "a".repeat(43);
const start = () => ({
  serviceId: result.serviceId,
  attemptId,
  authorizationUrl: `https://assistant.example/admin/service-connect#${attemptId}`,
  expiresAt: Date.now() + 300_000,
});
type Response = Awaited<ReturnType<ClientSession["serviceConnection"]>>;
function mockSession() {
  const serviceConnection = jest
    .fn<Promise<Response>, Parameters<ClientSession["serviceConnection"]>>()
    .mockImplementation(async (action) =>
      action === "start" ? start() : disconnected,
    );
  return {
    serviceConnection,
    session: { serviceConnection } as unknown as ClientSession,
  };
}
async function flush() {
  await act(async () => {});
}
async function tick(ms = 2500) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each(["en", "cs"] as const)(
  "%s card is passive and exposes explicit translated actions",
  (language) => {
    const onConnect = jest.fn(),
      onContinue = jest.fn();
    const props = {
      result,
      language,
      onConnect,
      onContinue,
      onOpen: jest.fn(),
      onCancel: jest.fn(),
    };
    const ui = render(
      <ServiceConnectionCard {...props} phase="disconnected" />,
    );
    expect(ui.getByText("Twenty CRM")).toBeTruthy();
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    fireEvent.press(
      ui.getByRole("button", {
        name: translate(language)("serviceConnectionConnect"),
      }),
    );
    expect(onConnect).toHaveBeenCalledTimes(1);
    ui.rerender(<ServiceConnectionCard {...props} phase="connected" />);
    expect(onContinue).not.toHaveBeenCalled();
    expect(ui.getByText(result.resumeText!)).toBeTruthy();
    fireEvent.press(
      ui.getByRole("button", {
        name: translate(language)("serviceConnectionContinue"),
      }),
    );
    expect(onContinue).toHaveBeenCalledTimes(1);
    ui.rerender(
      <ServiceConnectionCard
        {...props}
        phase="connected"
        result={{ ...result, resumeText: undefined }}
      />,
    );
    expect(ui.queryAllByRole("button")).toHaveLength(0);
  },
);

test("replaying a card only reads status; its own completed attempt continues the request once", async () => {
  const { session, serviceConnection } = mockSession();
  const onContinue = jest.fn();
  const props = {
    session,
    result,
    language: "en" as const,
    disabled: false,
    onContinue,
  };
  const ui = render(<ServiceConnection {...props} />);
  await flush();
  expect(serviceConnection.mock.calls).toEqual([
    ["status", result.serviceId, expect.any(AbortSignal)],
  ]);
  expect(Linking.openURL).not.toHaveBeenCalled();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  expect(Linking.openURL).toHaveBeenCalledWith(start().authorizationUrl);
  expect(serviceConnection).toHaveBeenCalledTimes(2);
  serviceConnection.mockResolvedValueOnce(connected);
  await tick();
  expect(serviceConnection).toHaveBeenLastCalledWith(
    "status",
    result.serviceId,
    expect.any(AbortSignal),
    attemptId,
  );
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onContinue).toHaveBeenCalledWith(result.resumeText);
  expect(ui.getByText("Your account is connected.")).toBeTruthy();
  expect(ui.queryByRole("button", { name: "Continue request" })).toBeNull();
  await tick(10000);
  expect(serviceConnection).toHaveBeenCalledTimes(3);
  expect(onContinue).toHaveBeenCalledTimes(1);
  ui.unmount();
  serviceConnection.mockResolvedValueOnce(connected);
  render(<ServiceConnection {...props} />);
  await flush();
  expect(serviceConnection).toHaveBeenLastCalledWith(
    "status",
    result.serviceId,
    expect.any(AbortSignal),
  );
  expect(
    serviceConnection.mock.calls.filter(([action]) => action === "start"),
  ).toHaveLength(1);
  expect(onContinue).toHaveBeenCalledTimes(1);
});

test("blocked browser can be reopened explicitly without creating another attempt", async () => {
  const { session, serviceConnection } = mockSession();
  jest.mocked(Linking.openURL).mockRejectedValueOnce(Error("blocked"));
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={jest.fn()}
    />,
  );
  await flush();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  expect(ui.getByText(/Browser didn't open\. Tap/)).toBeTruthy();
  fireEvent.press(ui.getByRole("button", { name: "Open sign-in" }));
  await flush();
  expect(Linking.openURL).toHaveBeenCalledTimes(2);
  expect(
    serviceConnection.mock.calls.filter(([action]) => action === "start"),
  ).toHaveLength(1);
});

test("cancelling aborts an in-flight poll and cannot replace a newer connected result", async () => {
  const { session, serviceConnection } = mockSession();
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={jest.fn()}
    />,
  );
  await flush();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  let finishPoll: (value: Response) => void = () => {};
  serviceConnection.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPoll = resolve;
      }),
  );
  await tick();
  const signal = serviceConnection.mock.calls[2]![2];
  serviceConnection.mockResolvedValueOnce(connected);
  fireEvent.press(ui.getByRole("button", { name: "Cancel" }));
  await flush();
  expect(signal.aborted).toBe(true);
  expect(serviceConnection).toHaveBeenLastCalledWith(
    "cancel",
    result.serviceId,
    expect.any(AbortSignal),
    attemptId,
  );
  await act(async () => {
    finishPoll({ ...disconnected, flow: "cancelled" });
  });
  expect(ui.getByText("Your account is connected.")).toBeTruthy();
  await tick();
  expect(serviceConnection).toHaveBeenCalledTimes(4);
});

test("cancel failure remains recoverable and successful cancellation stops polling", async () => {
  const { session, serviceConnection } = mockSession();
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={jest.fn()}
    />,
  );
  await flush();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  serviceConnection.mockRejectedValueOnce(Error("offline"));
  fireEvent.press(ui.getByRole("button", { name: "Cancel" }));
  await flush();
  expect(ui.getByText(/Couldn't cancel/)).toBeTruthy();
  serviceConnection.mockResolvedValueOnce({
    ...disconnected,
    flow: "cancelled",
  });
  fireEvent.press(ui.getByRole("button", { name: "Cancel" }));
  await flush();
  expect(ui.getByText(/Sign-in cancelled/)).toBeTruthy();
  await tick(10000);
  expect(serviceConnection).toHaveBeenCalledTimes(4);
});

test("expiry aborts pending status and never starts a replacement attempt automatically", async () => {
  const { session, serviceConnection } = mockSession();
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={jest.fn()}
    />,
  );
  await flush();
  serviceConnection.mockResolvedValueOnce({
    ...start(),
    expiresAt: Date.now() + 3000,
  });
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  serviceConnection.mockImplementationOnce(() => new Promise(() => {}));
  await tick();
  await tick(500);
  expect(
    ui.getByText("Sign-in expired. Connect your account again."),
  ).toBeTruthy();
  expect(serviceConnection.mock.calls[2]![2].aborted).toBe(true);
  await tick(10000);
  expect(serviceConnection).toHaveBeenCalledTimes(3);
});

test("a transient poll failure remains pending and recovers without restarting sign-in", async () => {
  const { session, serviceConnection } = mockSession();
  const onContinue = jest.fn();
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={onContinue}
    />,
  );
  await flush();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  serviceConnection.mockRejectedValueOnce(Error("network unavailable"));
  await tick();
  expect(ui.getByText("Status unavailable. Still checking.")).toBeTruthy();
  expect(ui.getByRole("button", { name: "Open sign-in" })).toBeTruthy();
  serviceConnection.mockResolvedValueOnce(connected);
  await tick();
  expect(ui.getByText("Your account is connected.")).toBeTruthy();
  expect(
    serviceConnection.mock.calls.filter(([action]) => action === "start"),
  ).toHaveLength(1);
  expect(onContinue).toHaveBeenCalledTimes(1);
});

test("the app link from the browser checks the attempt at once", async () => {
  const { session, serviceConnection } = mockSession();
  const listeners: ((event: { url: string }) => void)[] = [];
  const remove = jest.fn();
  jest.spyOn(Linking, "addEventListener").mockImplementation(((
    _type: string,
    listener: (event: { url: string }) => void,
  ) => {
    listeners.push(listener);
    return { remove };
  }) as never);
  const onContinue = jest.fn();
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={onContinue}
    />,
  );
  await flush();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  expect(listeners).toHaveLength(1);
  serviceConnection.mockResolvedValueOnce(connected);
  listeners[0]!({ url: "https://elsewhere.example.test/" });
  await flush();
  expect(serviceConnection).toHaveBeenCalledTimes(2);
  listeners[0]!({ url: "agentclient://service-connected" });
  await flush();
  expect(serviceConnection).toHaveBeenLastCalledWith(
    "status",
    result.serviceId,
    expect.any(AbortSignal),
    attemptId,
  );
  expect(ui.getByText("Your account is connected.")).toBeTruthy();
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalled();
});

test("switching sessions aborts old work and ignores late browser launch or state", async () => {
  const old = mockSession(),
    next = mockSession();
  const props = {
    result,
    language: "en" as const,
    disabled: false,
    onContinue: jest.fn(),
  };
  const ui = render(<ServiceConnection {...props} session={old.session} />);
  await flush();
  let finish: (value: Response) => void = () => {};
  old.serviceConnection.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  ui.rerender(<ServiceConnection {...props} session={next.session} />);
  await act(async () => {
    finish(start());
  });
  expect(old.serviceConnection.mock.calls[1]![2].aborted).toBe(true);
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(ui.getByRole("button", { name: "Connect account" })).toBeTruthy();
  expect(next.serviceConnection).toHaveBeenCalledTimes(1);
});

test("offline and disabled cards cannot mutate, while unmount aborts polling without remote cancellation", async () => {
  const { session, serviceConnection } = mockSession();
  const props = {
    session,
    result,
    language: "en" as const,
    onContinue: jest.fn(),
  };
  const ui = render(<ServiceConnection {...props} disabled />);
  await flush();
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  expect(serviceConnection).toHaveBeenCalledTimes(1);
  ui.rerender(<ServiceConnection {...props} disabled={false} />);
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  await flush();
  ui.rerender(<ServiceConnection {...props} disabled online={false} />);
  expect(serviceConnection.mock.calls[1]![2].aborted).toBe(true);
  await tick(10000);
  expect(serviceConnection).toHaveBeenCalledTimes(2);
  ui.unmount();
  expect(
    serviceConnection.mock.calls.some(([action]) => action === "cancel"),
  ).toBe(false);
});

test("pending start after unmount cannot open a browser", async () => {
  const { session, serviceConnection } = mockSession();
  const ui = render(
    <ServiceConnection
      session={session}
      result={result}
      language="en"
      disabled={false}
      onContinue={jest.fn()}
    />,
  );
  await flush();
  let finish: (value: Response) => void = () => {};
  serviceConnection.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.press(ui.getByRole("button", { name: "Connect account" }));
  ui.unmount();
  await act(async () => {
    finish(start());
  });
  expect(serviceConnection.mock.calls[1]![2].aborted).toBe(true);
  expect(Linking.openURL).not.toHaveBeenCalled();
});
