import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import AudioSpike from "../spikes/audio/App";
import type { RecorderSession } from "../spikes/audio/session";

let mockNativeStatus = { isRecording: true, durationMillis: 1000 };
const mockListeners = new Set<() => void>();
const mockRecorder = { getStatus: () => mockNativeStatus };
const mockPlayer = { pause: jest.fn() };
let mockState: ReturnType<RecorderSession["getSnapshot"]>;
const mockSession = {
  subscribe: () => () => {},
  getSnapshot: () => mockState,
  restore: jest.fn(),
  setForeground: jest.fn(),
  stop: jest.fn(),
};
jest.mock("../spikes/audio/session", () => ({
  RecorderSession: jest.fn(() => mockSession),
}));
jest.mock("../spikes/audio/files", () => ({}));
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual(
    "@react-native-async-storage/async-storage/jest/async-storage-mock",
  ),
);
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  useAudioRecorder: () => mockRecorder,
  useAudioPlayer: () => mockPlayer,
  useAudioPlayerStatus: () => ({ playing: false, isLoaded: true }),
  useAudioRecorderState: () => {
    const { useSyncExternalStore } = jest.requireActual("react");
    return useSyncExternalStore(
      (listener: () => void) => {
        mockListeners.add(listener);
        return () => mockListeners.delete(listener);
      },
      () => mockNativeStatus,
    );
  },
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockNativeStatus = { isRecording: true, durationMillis: 1000 };
  mockState = {
    phase: "recording",
    storageBlocked: false,
    candidates: [
      {
        uri: "file:///documents/candidate.m4a",
        bytes: 2048,
        reason: "unfinished",
        status: "unchecked",
      },
    ],
    saved: {
      uri: "file:///documents/saved.m4a",
      bytes: 4096,
      durationMillis: 10000,
      interrupted: false,
    },
  };
});
function nativeTick(isRecording: boolean, durationMillis: number) {
  act(() => {
    mockNativeStatus = { isRecording, durationMillis };
    mockListeners.forEach((listener) => listener());
  });
}
test("recording timer updates without rerendering recovery and saved file metadata", async () => {
  const format = jest.spyOn(Number.prototype, "toLocaleString");
  try {
    render(<AudioSpike />);
    await act(async () => {});
    expect(screen.getByText("1 s")).toBeTruthy();
    expect(format).toHaveBeenCalledWith("en");
    format.mockClear();
    for (let time = 1500; time <= 6000; time += 500) nativeTick(true, time);
    expect(screen.getByText("6 s")).toBeTruthy();
    expect(format).not.toHaveBeenCalled();
    expect(mockSession.stop).not.toHaveBeenCalled();
  } finally {
    format.mockRestore();
  }
});
test("unexpected native stop requests finalization once, without retrying on later ticks", async () => {
  render(<AudioSpike />);
  await act(async () => {});
  nativeTick(false, 2000);
  expect(mockSession.stop).toHaveBeenCalledWith(true);
  nativeTick(false, 2500);
  nativeTick(false, 3000);
  expect(mockSession.stop).toHaveBeenCalledTimes(1);
});
test("a normal stop or initially inactive recorder does not request interruption cleanup", async () => {
  mockState = { ...mockState, phase: "stopping" };
  const { unmount } = render(<AudioSpike />);
  await act(async () => {});
  nativeTick(false, 2000);
  expect(mockSession.stop).not.toHaveBeenCalled();
  unmount();
  mockState = { ...mockState, phase: "recording" };
  render(<AudioSpike />);
  await act(async () => {});
  nativeTick(false, 2500);
  expect(mockSession.stop).not.toHaveBeenCalled();
});
