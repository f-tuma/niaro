import {
  RecorderSession,
  RECORDING_KEY,
  JOURNAL_KEY,
} from "../spikes/audio/session";
import { stopRecording } from "../spikes/audio/stop-recording";
import { isRecordingUri } from "../spikes/audio/journal";
import type { RecordingStatus } from "expo-audio";

function fixture() {
  const files = new Map<string, number>([
    [
      "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a",
      4096,
    ],
  ]);
  const data = new Map<string, string>();
  const native = {
    isRecording: false,
    canRecord: false,
    durationMillis: 30125,
  };
  const ports = {
    recorder: {
      uri: () =>
        "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a",
      prepare: jest.fn(async () => {
        native.canRecord = true;
      }),
      record: jest.fn(() => {
        native.isRecording = true;
      }),
      stop: jest.fn(async () => {
        native.isRecording = false;
        native.canRecord = false;
        return "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a";
      }),
      status: () => native,
    },
    permission: jest.fn(async () => true),
    mode: jest.fn(async (_recording: boolean) => {}),
    valid: (uri: string) => isRecordingUri(uri, "file:///documents/"),
    list: () => [...files.keys()],
    probe: jest.fn(async (_uri: string) => 3000),
    inspect: (uri: string) => files.get(uri) ?? 0,
    storage: {
      getItem: jest.fn(async (key: string) => data.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        data.set(key, value);
      }),
    },
  };
  return { ports, files, data, native, session: new RecorderSession(ports) };
}
test("restoring is passive; denied permission never starts capture", async () => {
  const { session, ports } = fixture();
  await session.restore();
  expect(ports.permission).not.toHaveBeenCalled();
  ports.permission.mockResolvedValue(false);
  await session.start();
  expect(ports.recorder.prepare).not.toHaveBeenCalled();
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(session.getSnapshot()).toMatchObject({
    phase: "idle",
    message: "audioDenied",
  });
});
test("a finalized nonempty local file survives a new session without restarting the microphone", async () => {
  const { session, ports } = fixture();
  await session.restore();
  await session.start();
  await session.stop();
  expect(session.getSnapshot().saved).toMatchObject({
    durationMillis: 30125,
    bytes: 4096,
    interrupted: false,
  });
  const next = new RecorderSession(ports);
  await next.restore();
  expect(next.getSnapshot().message).toBe("audioRestored");
  expect(next.getSnapshot().saved).toEqual(session.getSnapshot().saved);
  expect(ports.recorder.record).toHaveBeenCalledTimes(1);
});
test("background ends capture once; returning never resumes it", async () => {
  const { session, ports } = fixture();
  await session.restore();
  await session.start();
  session.setForeground(false);
  await session.stop();
  session.setForeground(true);
  expect(ports.recorder.stop).toHaveBeenCalledTimes(1);
  expect(ports.recorder.record).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot()).toMatchObject({
    phase: "idle",
    message: "audioInterrupted",
    saved: { interrupted: true },
  });
});
test("duplicate start and permission completing after background cannot start capture", async () => {
  const { session, ports } = fixture();
  let grant!: (allowed: boolean) => void;
  ports.permission.mockImplementation(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  await session.restore();
  const starting = session.start();
  await session.start();
  session.setForeground(false);
  session.setForeground(true);
  grant(true);
  await starting;
  expect(ports.permission).toHaveBeenCalledTimes(1);
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(session.getSnapshot().phase).toBe("idle");
});
test("background during native preparation cleans up without recording", async () => {
  const { session, ports } = fixture();
  ports.recorder.prepare.mockImplementation(async () => {
    session.setForeground(false);
  });
  await session.restore();
  await session.start();
  expect(ports.recorder.stop).toHaveBeenCalledTimes(1);
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(ports.storage.setItem).not.toHaveBeenCalled();
});
test("empty output is never called saved; a failed stop retains an explicit Stop path", async () => {
  const { session, ports, files } = fixture();
  await session.restore();
  await session.start();
  ports.recorder.stop.mockRejectedValueOnce(new Error("busy"));
  await session.stop();
  expect(session.getSnapshot()).toMatchObject({
    phase: "recording",
    message: "audioError",
  });
  files.clear();
  await session.stop();
  expect(session.getSnapshot()).toMatchObject({
    phase: "idle",
    message: "audioError",
  });
  expect(session.getSnapshot().saved).toBeUndefined();
  expect(JSON.parse(dataValue(ports)).entries[0].status).toBe("pending");
});
function dataValue(ports: ReturnType<typeof fixture>["ports"]) {
  return ports.storage.setItem.mock.calls.at(-1)![1];
}
test("metadata write failure preserves the valid file in this session and explains the restart limitation", async () => {
  const { session, ports } = fixture();
  await session.restore();
  await session.start();
  ports.storage.setItem.mockRejectedValue(new Error("storage_full"));
  await session.stop();
  expect(session.getSnapshot()).toMatchObject({
    phase: "idle",
    message: "audioPersistenceError",
    saved: { bytes: 4096 },
  });
});
test.each(["missing", "corrupt"])(
  "%s previous file is not offered as a restored recording",
  async (kind) => {
    const { session, data, files } = fixture();
    data.set(
      RECORDING_KEY,
      kind === "corrupt"
        ? "{}"
        : JSON.stringify({
            uri: "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a",
            durationMillis: 10,
            bytes: 4096,
            interrupted: false,
          }),
    );
    files.clear();
    await session.restore();
    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      message: kind === "corrupt" ? "audioJournalError" : "audioRestoreError",
    });
    expect(session.getSnapshot().saved).toBeUndefined();
  },
);
test.each([false, true])(
  "stop completion event (hasError=%s) determines success even when native stop resolves",
  async (hasError) => {
    let listener!: (status: RecordingStatus) => void;
    const remove = jest.fn();
    const recorder = {
      addListener: jest.fn((_event, callback) => {
        listener = callback;
        return { remove };
      }),
      stop: jest.fn(async () => {
        listener({
          id: "test",
          isFinished: true,
          hasError,
          error: hasError ? "encoder" : null,
          url: hasError
            ? null
            : "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a",
        });
      }),
    };
    if (hasError)
      await expect(stopRecording(recorder)).rejects.toThrow(
        "recording_not_finalized",
      );
    else
      await expect(stopRecording(recorder)).resolves.toBe(
        "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a",
      );
    expect(remove).toHaveBeenCalledTimes(1);
  },
);

const uri =
  "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a";
const oldUri =
  "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000002.m4a";
test("pending journal is durably written before capture; write failure prevents capture", async () => {
  const { session, ports, data } = fixture();
  await session.restore();
  ports.recorder.record.mockImplementation(() => {
    expect(JSON.parse(data.get(JOURNAL_KEY)!).entries).toEqual([
      expect.objectContaining({ uri, status: "pending" }),
    ]);
    throw new Error("simulated_capture_failure");
  });
  await session.start();
  expect(ports.recorder.record).toHaveBeenCalledTimes(1);
  ports.recorder.record.mockClear();
  ports.storage.setItem.mockRejectedValueOnce(new Error("disk_full"));
  await session.start();
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(session.getSnapshot().message).toBe("audioJournalWriteError");
});
test("crash discovery is passive; explicit check and recovery retain an interrupted portion across restart", async () => {
  const { session, ports, native, data } = fixture();
  await session.restore();
  await session.start();
  native.isRecording = false;
  native.canRecord = false;
  const restarted = new RecorderSession(ports);
  await restarted.restore();
  expect(ports.probe).not.toHaveBeenCalled();
  expect(ports.permission).toHaveBeenCalledTimes(1);
  expect(restarted.getSnapshot().candidates).toEqual([
    { uri, bytes: 4096, reason: "unfinished", status: "unchecked" },
  ]);
  await restarted.recover(uri); // Cannot skip review.
  expect(restarted.getSnapshot().saved).toBeUndefined();
  await restarted.check(uri);
  expect(restarted.getSnapshot().candidates[0]).toMatchObject({
    status: "ready",
    durationMillis: 3000,
  });
  await restarted.recover(uri);
  expect(restarted.getSnapshot().saved).toMatchObject({
    uri,
    interrupted: true,
    durationMillis: 3000,
  });
  expect(JSON.parse(data.get(JOURNAL_KEY)!)).toMatchObject({
    saved: { uri },
    entries: [{ uri, status: "finished" }],
  });
  const again = new RecorderSession(ports);
  await again.restore();
  expect(again.getSnapshot().candidates).toEqual([]);
  expect(again.getSnapshot().saved).toEqual(restarted.getSnapshot().saved);
  expect(ports.recorder.record).toHaveBeenCalledTimes(1);
});
test("unreadable files remain available for retry, missing journal paths are visible, ignoring never deletes a file", async () => {
  const { ports, data, files } = fixture();
  data.set(
    JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      entries: [{ uri: oldUri, status: "pending", startedAt: 1 }],
    }),
  );
  const session = new RecorderSession(ports);
  await session.restore();
  expect(session.getSnapshot().candidates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        uri: oldUri,
        status: "missing",
        reason: "unfinished",
      }),
      expect.objectContaining({
        uri,
        status: "unchecked",
        reason: "unindexed",
      }),
    ]),
  );
  ports.probe.mockRejectedValueOnce(new Error("decoder"));
  await session.check(uri);
  expect(
    session.getSnapshot().candidates.find((item) => item.uri === uri)?.status,
  ).toBe("unreadable");
  await session.recover(uri);
  expect(session.getSnapshot().saved).toBeUndefined();
  await session.ignore(uri);
  expect(files.get(uri)).toBe(4096);
  const next = new RecorderSession(ports);
  await next.restore();
  expect(next.getSnapshot().candidates.map((item) => item.uri)).toEqual([
    oldUri,
  ]);
});
test("failed recovery commit preserves candidate and previous saved recording", async () => {
  const { session, ports, files, data } = fixture();
  files.set(oldUri, 2048);
  data.set(
    RECORDING_KEY,
    JSON.stringify({
      uri: oldUri,
      bytes: 2048,
      durationMillis: 1000,
      interrupted: false,
    }),
  );
  await session.restore();
  await session.check(uri);
  ports.storage.setItem.mockRejectedValueOnce(new Error("disk_full"));
  await session.recover(uri);
  expect(session.getSnapshot()).toMatchObject({
    saved: { uri: oldUri },
    message: "audioRecoverySaveError",
    candidates: [{ uri, status: "ready" }],
  });
  await session.recover(uri);
  const next = new RecorderSession(ports);
  await next.restore();
  expect(next.getSnapshot().saved?.uri).toBe(uri);
  expect(next.getSnapshot().candidates).toEqual([]);
  expect(files.size).toBe(2);
});
test.each([
  "",
  "{",
  JSON.stringify({ version: 2, entries: [] }),
  JSON.stringify({
    version: 1,
    entries: [{ uri: "file:///outside.m4a", status: "pending", startedAt: 1 }],
  }),
])("invalid journal stays untouched and blocks capture: %s", async (raw) => {
  const { session, ports, data } = fixture();
  data.set(JOURNAL_KEY, raw);
  await session.restore();
  await session.start();
  expect(session.getSnapshot().storageBlocked).toBe(true);
  expect(ports.permission).not.toHaveBeenCalled();
  expect(ports.storage.setItem).not.toHaveBeenCalled();
  expect(data.get(JOURNAL_KEY)).toBe(raw);
});
test("late journal write after leaving the app never starts capture", async () => {
  const { session, ports } = fixture();
  await session.restore();
  ports.storage.setItem.mockImplementationOnce(async () => {
    session.setForeground(false);
    session.setForeground(true);
  });
  await session.start();
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(ports.recorder.stop).toHaveBeenCalledTimes(1);
});
test("recovery serializes clicks and rejects a changed file", async () => {
  const { session, ports, files } = fixture();
  await session.restore();
  let finish!: (value: number) => void;
  ports.probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const checking = session.check(uri);
  await session.check(uri);
  await session.start();
  await session.ignore(uri);
  expect(ports.probe).toHaveBeenCalledTimes(1);
  expect(ports.recorder.record).not.toHaveBeenCalled();
  finish(3000);
  await checking;
  files.set(uri, 2048);
  await session.recover(uri);
  expect(session.getSnapshot().saved).toBeUndefined();
  expect(session.getSnapshot().candidates[0]?.status).toBe("unreadable");
});
test("managed file matching rejects traversal, encoded paths, foreign roots and remote sources", () => {
  expect(isRecordingUri(uri, "file:///documents/")).toBe(true);
  for (const other of [
    uri.replace("Audio/", "Audio/../"),
    uri.replace("Audio/", "Audio/%2e%2e/"),
    uri.replace("documents", "documents-other"),
    uri.replace("file:", "https:"),
    uri + "/other",
    uri + "?x=1",
    uri.replace("recording-", "other-"),
  ])
    expect(isRecordingUri(other, "file:///documents/")).toBe(false);
});
test("failed cleanup after preparation retains an explicit Stop action", async () => {
  const { session, ports } = fixture();
  await session.restore();
  ports.storage.setItem.mockRejectedValueOnce(new Error("storage_full"));
  ports.recorder.stop.mockRejectedValueOnce(new Error("busy"));
  await session.start();
  expect(ports.recorder.record).not.toHaveBeenCalled();
  expect(session.getSnapshot().phase).toBe("recording");
  await session.stop(true);
  expect(session.getSnapshot().phase).toBe("idle");
});
test("a transient journal read failure can be retried without overwriting storage", async () => {
  const { session, ports } = fixture();
  ports.storage.getItem.mockRejectedValueOnce(new Error("storage_busy"));
  await session.restore();
  expect(session.getSnapshot().storageBlocked).toBe(true);
  await session.restore();
  expect(session.getSnapshot().storageBlocked).toBe(false);
  expect(ports.storage.setItem).not.toHaveBeenCalled();
});
