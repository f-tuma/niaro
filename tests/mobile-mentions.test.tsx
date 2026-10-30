import React from "react";
import { MotionProvider } from "../packages/ui/motion";
import { AppState, Animated, Modal, TextInput } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "../packages/ui";
import {
  MobileMentionSheet,
  useMobileMentionDirectory,
} from "../apps/mobile/MobileMentions";
import type { ClientSession } from "../packages/client-core/session";
import type { MentionDirectory } from "../packages/protocol/mentions";
function port(identityKey: string) {
  const signals: AbortSignal[] = [];
  let resolve!: (x: MentionDirectory) => void;
  const session = {
    identityKey,
    readMentions: jest.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<MentionDirectory>((r) => {
        resolve = r;
      });
    }),
  } as unknown as ClientSession;
  return {
    session,
    signals,
    resolve: (name: string) =>
      resolve({
        profile: "agent-mentions/1",
        items: [{ kind: "skill", id: "TEST-" + name, name }],
      }),
  };
}
function Probe({ session }: { session: ClientSession }) {
  const items = useMobileMentionDirectory(session, true);
  return <Text testID="refs">{items.map((x) => x.name).join(",")}</Text>;
}
test("late directory completions cannot populate a newer account and background refresh is owned", async () => {
  const original = jest
    .mocked(AppState.addEventListener)
    .getMockImplementation();
  let change!: (s: string) => void;
  const spy = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_, listener) => {
      change = listener as typeof change;
      return { remove: jest.fn() };
    });
  const a = port("TEST-A"),
    b = port("TEST-B");
  const { rerender, unmount } = render(<Probe session={a.session} />);
  rerender(<Probe session={b.session} />);
  expect(a.signals[0]!.aborted).toBe(true);
  await act(async () => {
    a.resolve("old");
    await Promise.resolve();
  });
  expect(screen.getByTestId("refs").props.children).toBe("");
  await act(async () => {
    b.resolve("current");
    await Promise.resolve();
  });
  expect(screen.getByTestId("refs").props.children).toBe("current");
  act(() => change("background"));
  expect(b.signals[0]!.aborted).toBe(true);
  act(() => change("active"));
  expect(b.signals).toHaveLength(2);
  unmount();
  expect(b.signals[1]!.aborted).toBe(true);
  spy.mockRestore();
  jest.mocked(AppState.addEventListener).mockImplementation(original!);
});

function holdSheetEntrance() {
  let finish: ((result: { finished: boolean }) => void) | undefined;
  const timing = jest
    .spyOn(Animated, "timing")
    .mockImplementation((_, config) => ({
      start: (callback?: (result: { finished: boolean }) => void) => {
        if (config.toValue === 1) finish = callback;
      },
      stop: jest.fn(),
      reset: jest.fn(),
    }));
  return {
    timing,
    finish: () => finish?.({ finished: true }),
    take: () => finish,
  };
}
const sheet = (key = "TEST-A") => (
  <MobileMentionSheet
    key={key}
    items={[]}
    language="en"
    onPick={jest.fn()}
    onClose={jest.fn()}
  />
);

async function mountSheet() {
  // Real App has resolved the OS motion preference before this deliberate sheet opens.
  const view = render(<MotionProvider />);
  await act(async () => {
    await Promise.resolve();
  });
  const rerender = (content: React.ReactElement) =>
    view.rerender(<MotionProvider>{content}</MotionProvider>);
  rerender(sheet());
  return { ...view, rerender };
}

test("real reference DetailSheet focuses search once after BOTH Modal show and entrance completion", async () => {
  const held = holdSheetEntrance();
  const { rerender, unmount } = await mountSheet();
  const focus = jest.mocked(screen.UNSAFE_getByType(TextInput).instance.focus);
  focus.mockClear();
  try {
    const modal = screen.UNSAFE_getByType(Modal);
    expect(
      screen.getByLabelText("Find a reference").props.autoFocus,
    ).toBeUndefined();
    fireEvent(modal, "show");
    expect(focus).not.toHaveBeenCalled();
    act(held.finish);
    expect(focus).toHaveBeenCalledTimes(1);
    fireEvent.changeText(screen.getByLabelText("Find a reference"), "changed");
    rerender(sheet());
    fireEvent(screen.UNSAFE_getByType(Modal), "show");
    act(held.finish);
    expect(focus).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
    held.timing.mockRestore();
  }
});

test.each(["background", "dismiss", "unmount", "new owner"])(
  "real reference DetailSheet refuses retired ready focus after %s",
  async (reason) => {
    const original = jest
      .mocked(AppState.addEventListener)
      .getMockImplementation();
    const changes = new Set<(state: string) => void>();
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_, listener) => {
        const change = listener as (state: string) => void;
        changes.add(change);
        return { remove: () => changes.delete(change) };
      });
    const held = holdSheetEntrance();
    const { rerender, unmount } = await mountSheet();
    const focus = jest.mocked(
      screen.UNSAFE_getByType(TextInput).instance.focus,
    );
    focus.mockClear();
    const onShow = screen.UNSAFE_getByType(Modal).props.onShow;
    const finish = held.take();
    try {
      if (reason === "background")
        act(() => changes.forEach((change) => change("background")));
      if (reason === "dismiss")
        fireEvent(screen.UNSAFE_getByType(Modal), "requestClose");
      if (reason === "unmount") unmount();
      if (reason === "new owner") rerender(sheet("TEST-B"));
      act(() => {
        onShow();
        finish?.({ finished: true });
      });
      expect(focus).not.toHaveBeenCalled();
    } finally {
      if (reason !== "unmount") unmount();
      held.timing.mockRestore();
      jest.mocked(AppState.addEventListener).mockImplementation(original!);
    }
  },
);
