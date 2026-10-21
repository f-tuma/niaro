import { createAudioPlayer } from "expo-audio";
import { probeRecording } from "../spikes/audio/files";
jest.mock("expo-file-system", () => ({
  Paths: { document: { uri: "file:///documents/" } },
  File: jest.fn(() => ({ exists: true, size: 4096 })),
  Directory: jest.fn(),
}));
jest.mock("expo-audio", () => ({ createAudioPlayer: jest.fn() }));
const uri =
  "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a";
function mockPlayer(isLoaded: boolean) {
  const player = {
    isLoaded,
    duration: isLoaded ? 3.5 : 0,
    remove: jest.fn(),
    play: jest.fn(),
  };
  jest
    .mocked(createAudioPlayer)
    .mockReturnValue(player as unknown as ReturnType<typeof createAudioPlayer>);
  return player;
}
afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});
test("native recovery probe reads duration without playback and releases its player", async () => {
  const player = mockPlayer(true);
  await expect(probeRecording(uri)).resolves.toBe(3500);
  expect(player.play).not.toHaveBeenCalled();
  expect(player.remove).toHaveBeenCalledTimes(1);
});
test("unreadable probe times out and releases native resources without playing", async () => {
  jest.useFakeTimers();
  const player = mockPlayer(false);
  const checking = expect(probeRecording(uri)).rejects.toThrow(
    "recording_not_readable",
  );
  await jest.advanceTimersByTimeAsync(5000);
  await checking;
  expect(player.remove).toHaveBeenCalledTimes(1);
  expect(player.play).not.toHaveBeenCalled();
});
test("probe rejects paths outside the managed recording directory before opening a player", async () => {
  await expect(probeRecording("https://example.com/audio.m4a")).rejects.toThrow(
    "outside_recording_directory",
  );
  expect(createAudioPlayer).not.toHaveBeenCalled();
});
