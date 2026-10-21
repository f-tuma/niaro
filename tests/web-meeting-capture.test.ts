import {
  MeetingCaptureStore,
  WEB_RECORD_SECONDS,
  importType,
  prepareImport,
  recordingFormat,
  type CapturePorts,
} from "../apps/server-admin/web/app/meeting-capture";
import { filterMeetings } from "../apps/server-admin/web/app/meetings-list";
import {
  MEETING_BLOCK_BYTES,
  MEETING_MAX_BYTES,
  MEETING_PROFILE,
  type Meeting,
} from "../packages/protocol/meetings";
import type { ClientSession } from "../packages/client-core/session";

class FakeTrack {
  stopped = false;
  listeners: Record<string, (() => void)[]> = {};
  constructor(readonly kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
}
class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}
(globalThis as { MediaStream?: unknown }).MediaStream = FakeStream;

type Node = {
  kind: string;
  connections: { to: Node; output?: number; input?: number }[];
  connect(to: Node, output?: number, input?: number): Node;
  [key: string]: unknown;
};
function node(kind: string, extra: Record<string, unknown> = {}): Node {
  const value: Node = {
    kind,
    connections: [],
    connect(to, output, input) {
      value.connections.push({ to, output, input });
      return to;
    },
    ...extra,
  };
  return value;
}
class FakeContext {
  closed = false;
  sources: Node[] = [];
  merger?: Node;
  destination = node("destination", {
    stream: new FakeStream([new FakeTrack("audio")]),
    channelCount: 2,
  });
  createMediaStreamDestination() {
    return this.destination;
  }
  createMediaStreamSource(stream: FakeStream) {
    const source = node("source", { stream });
    this.sources.push(source);
    return source;
  }
  createAnalyser() {
    return node("analyser", {
      fftSize: 4,
      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(0.1);
      },
    });
  }
  createChannelMerger(count: number) {
    this.merger = node("merger", { count });
    return this.merger;
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
}
class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  listeners: Record<string, ((event: { data: Blob }) => void)[]> = {};
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions,
  ) {}
  addEventListener(type: string, fn: (event: { data: Blob }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data = new Blob([])) {
    for (const fn of this.listeners[type] ?? []) fn({ data });
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.emit("dataavailable", new Blob([new Uint8Array(1000)]));
    this.emit("stop");
  }
}

function ports(overrides: Partial<CapturePorts> = {}) {
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  const microphone = new FakeStream([new FakeTrack("audio")]);
  const display = new FakeStream([
    new FakeTrack("video"),
    new FakeTrack("audio"),
  ]);
  const contexts: FakeContext[] = [];
  const recorders: FakeRecorder[] = [];
  const value: CapturePorts = {
    getUserMedia: jest.fn(async () => microphone as unknown as MediaStream),
    getDisplayMedia: jest.fn(async () => display as unknown as MediaStream),
    audioContext: () => {
      const context = new FakeContext();
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    recorder: (stream, options) => {
      const recorder = new FakeRecorder(stream as never, options);
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    supported: (type) => type === "audio/webm;codecs=opus",
    now: () => now,
    uuid: () => "8a4b8f0e-5d0c-4a52-9b0e-1f2d3c4b5a69",
    every: (fn) => {
      tick = fn;
      return () => {
        tick = null;
      };
    },
    ...overrides,
  };
  return {
    value,
    microphone,
    display,
    contexts,
    recorders,
    advance(ms: number) {
      now += ms;
      tick?.();
    },
  };
}

test("recording formats prefer WebM/Opus and fall back to what the server decodes", () => {
  expect(recordingFormat(() => true)?.mimeType).toBe("audio/webm");
  expect(
    recordingFormat((type) => type.startsWith("audio/mp4"))?.mimeType,
  ).toBe("audio/mp4");
  expect(recordingFormat(() => false)).toBeNull();
  expect(importType("Teams meeting.MP4")).toBe("audio/mp4");
  expect(importType("zoom.m4a")).toBe("audio/mp4");
  expect(importType("call.mkv")).toBe("audio/webm");
  expect(importType("notes.txt")).toBeNull();
});

test("microphone: one channel, paused time excluded, kept for upload", async () => {
  const fake = ports();
  const store = new MeetingCaptureStore(fake.value);
  await store.start("microphone", "identity-1", "cs", "Schůzka · 1. 1.");
  expect(store.getSnapshot().phase).toBe("recording");
  expect(fake.value.getDisplayMedia).not.toHaveBeenCalled();
  const context = fake.contexts[0]!;
  expect(context.destination.channelCount).toBe(1);
  expect(fake.recorders[0]!.options).toEqual({
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 48000,
  });
  fake.advance(2000);
  expect(store.getSnapshot().elapsedMs).toBe(2000);
  expect(store.getSnapshot().levels.self).toBeGreaterThan(0);
  expect(store.getSnapshot().levels.others).toBeNull();
  store.pause();
  fake.advance(60_000);
  expect(store.getSnapshot().elapsedMs).toBe(2000);
  store.resume();
  fake.advance(1000);
  expect(store.getSnapshot().elapsedMs).toBe(3000);
  const id = await store.stop();
  expect(id).toBeTruthy();
  const snapshot = store.getSnapshot();
  expect(snapshot.phase).toBe("idle");
  expect(snapshot.captures).toHaveLength(1);
  expect(snapshot.captures[0]!.input).toMatchObject({
    profile: MEETING_PROFILE,
    mimeType: "audio/webm",
    bytes: 1000,
    language: "cs",
  });
  expect(snapshot.captures[0]!.input.speakerChannels).toBeUndefined();
  expect(fake.microphone.tracks.every((track) => track.stopped)).toBe(true);
  expect(context.closed).toBe(true);
  expect(store.unsaved).toBe(true);
});

test("microphone + call: two separate channels, the picture never kept", async () => {
  const fake = ports();
  const store = new MeetingCaptureStore(fake.value);
  await store.start("meeting", "identity-1", "en", "Meeting");
  expect(fake.value.getDisplayMedia).toHaveBeenCalledWith(
    expect.objectContaining({ video: true, audio: expect.any(Object) }),
  );
  // The video track is stopped right away; only the call's sound is used.
  expect(fake.display.getVideoTracks()[0]!.stopped).toBe(true);
  const context = fake.contexts[0]!;
  const [self, others] = context.sources;
  expect(self!.connections).toContainEqual(
    expect.objectContaining({ to: context.merger, output: 0, input: 0 }),
  );
  expect(others!.connections).toContainEqual(
    expect.objectContaining({ to: context.merger, output: 0, input: 1 }),
  );
  expect(context.destination.channelCount).toBe(2);
  expect(context.destination.channelInterpretation).toBe("discrete");
  expect(fake.recorders[0]!.options.audioBitsPerSecond).toBe(64000);
  fake.advance(500);
  expect(store.getSnapshot().levels.others).toBeGreaterThan(0);
  // The other side stops sharing: the microphone keeps recording.
  fake.display.getAudioTracks()[0]!.fire("ended");
  expect(store.getSnapshot()).toMatchObject({
    phase: "recording",
    meetingAudioLost: true,
  });
  await store.stop();
  expect(store.getSnapshot().captures[0]!.input.speakerChannels).toBe(
    "self-others",
  );
  expect(fake.display.tracks.every((track) => track.stopped)).toBe(true);
});

test("a share without sound or a refused microphone stops cleanly with a reason", async () => {
  const silent = ports({
    getDisplayMedia: jest.fn(
      async () =>
        new FakeStream([new FakeTrack("video")]) as unknown as MediaStream,
    ),
  });
  const store = new MeetingCaptureStore(silent.value);
  await store.start("meeting", "identity-1", "cs", "Schůzka");
  expect(store.getSnapshot()).toMatchObject({
    phase: "idle",
    error: "meeting_share_no_audio",
    captures: [],
  });
  expect(silent.value.getUserMedia).not.toHaveBeenCalled();

  const denied = ports({
    getUserMedia: jest.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    }),
  });
  const other = new MeetingCaptureStore(denied.value);
  await other.start("meeting", "identity-1", "cs", "Schůzka");
  expect(other.getSnapshot().error).toBe("meeting_permission_denied");
  expect(denied.display.tracks.every((track) => track.stopped)).toBe(true);

  const unsupported = new MeetingCaptureStore(
    ports({ supported: () => false }).value,
  );
  await unsupported.start("microphone", "identity-1", "cs", "Schůzka");
  expect(unsupported.getSnapshot().error).toBe("meeting_browser_unsupported");
});

test("recording stops itself at the two-hour and the size limit", async () => {
  const fake = ports();
  const store = new MeetingCaptureStore(fake.value);
  await store.start("microphone", "identity-1", "cs", "Schůzka");
  fake.advance(WEB_RECORD_SECONDS * 1000);
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.getSnapshot()).toMatchObject({
    phase: "idle",
    error: "meeting_recording_limit",
  });
  expect(store.getSnapshot().captures).toHaveLength(1);

  const big = ports();
  const sized = new MeetingCaptureStore(big.value);
  await sized.start("microphone", "identity-1", "cs", "Schůzka");
  big.recorders[0]!.emit(
    "dataavailable",
    new Blob([new Uint8Array(MEETING_MAX_BYTES - 600 * 1024)]),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sized.getSnapshot().phase).toBe("idle");
  expect(sized.getSnapshot().error).toBe("meeting_recording_limit");
});

function fakeServer(failAfterBlocks = Infinity) {
  let stored: Meeting | null = null;
  let blocks = 0;
  const received: number[] = [];
  const session = {
    identityKey: "identity-1",
    createMeeting: jest.fn(async (input) => {
      stored ??= {
        ...input,
        scope: {
          connectionId: "c",
          serverId: "s",
          workspaceId: "w",
          userId: "u",
        },
        status: "uploading",
        offset: 0,
        durationSeconds: null,
        sourceHash: null,
        failure: null,
        completedSegments: 0,
        processingAttempt: 0,
        updatedAt: new Date().toISOString(),
      };
      return stored;
    }),
    uploadMeetingBlock: jest.fn(
      async (_id: string, offset: number, bytes: Uint8Array) => {
        if (++blocks > failAfterBlocks) throw new Error("connection_failed");
        expect(offset).toBe(stored!.offset);
        expect(bytes.length).toBeLessThanOrEqual(MEETING_BLOCK_BYTES);
        received.push(bytes.length);
        stored = { ...stored!, offset: offset + bytes.length };
        return stored;
      },
    ),
    sealMeeting: jest.fn(async () => {
      stored = { ...stored!, status: "sealed", sourceHash: "a".repeat(64) };
      return stored;
    }),
    processMeeting: jest.fn(async () => {
      stored = { ...stored!, status: "transcribing" };
      return stored;
    }),
  };
  return {
    session: session as unknown as ClientSession,
    calls: session,
    received,
    allow() {
      failAfterBlocks = Infinity;
    },
  };
}

test("upload sends 256 KiB blocks, keeps the recording on failure and resumes where the server stopped", async () => {
  const store = new MeetingCaptureStore(ports().value);
  const file = new File(
    [new Uint8Array(MEETING_BLOCK_BYTES * 2 + 10)],
    "call.webm",
    { lastModified: Date.UTC(2026, 9, 1) },
  );
  const id = (await store.addFile(file, "identity-1", "cs", "Schůzka"))!;
  expect(store.getSnapshot().captures[0]!.input).toMatchObject({
    mimeType: "audio/webm",
    bytes: file.size,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  const server = fakeServer(1);
  expect(await store.upload(id, server.session)).toBeNull();
  expect(store.getSnapshot().captures[0]).toMatchObject({
    phase: "failed",
    uploaded: MEETING_BLOCK_BYTES,
    error: "meeting_connection_failed",
  });
  // Another account never sends this recording.
  const stranger = {
    ...server.session,
    identityKey: "identity-2",
  } as ClientSession;
  expect(await store.upload(id, stranger)).toBeNull();
  server.allow();
  const meeting = await store.upload(id, server.session);
  expect(meeting?.status).toBe("transcribing");
  expect(server.received).toEqual([
    MEETING_BLOCK_BYTES,
    MEETING_BLOCK_BYTES,
    10,
  ]);
  expect(server.calls.sealMeeting).toHaveBeenCalledTimes(1);
  expect(server.calls.processMeeting).toHaveBeenCalledWith(id);
  expect(store.getSnapshot().captures).toEqual([]);
});

test("a retry after the server sealed the recording only starts processing, never seals again", async () => {
  const store = new MeetingCaptureStore(ports().value);
  const file = new File([new Uint8Array(10)], "call.webm");
  const server = fakeServer(Infinity);
  // The first try sealed it; starting the processing never answered.
  server.calls.processMeeting.mockRejectedValueOnce(
    new Error("connection_failed"),
  );
  const id = (await store.addFile(file, "identity-1", "cs", "Schůzka"))!;
  expect(await store.upload(id, server.session)).toBeNull();
  expect(server.calls.sealMeeting).toHaveBeenCalledTimes(1);
  const meeting = await store.upload(id, server.session);
  expect(meeting?.status).toBe("transcribing");
  expect(server.calls.sealMeeting).toHaveBeenCalledTimes(1);
  expect(server.calls.processMeeting).toHaveBeenCalledTimes(2);
  // Already processing (this fake server keeps one meeting): nothing more
  // is asked of the server.
  const again = (await store.addFile(file, "identity-1", "cs", "Schůzka"))!;
  expect((await store.upload(again, server.session))?.status).toBe(
    "transcribing",
  );
  expect(server.calls.sealMeeting).toHaveBeenCalledTimes(1);
  expect(server.calls.processMeeting).toHaveBeenCalledTimes(2);
});

test("picked files: unknown types are refused, large non-MP4 video is too large", async () => {
  await expect(prepareImport(new File(["x"], "notes.txt"))).rejects.toThrow(
    "meeting_import_unsupported",
  );
  const large = { name: "call.webm", size: MEETING_MAX_BYTES + 1 } as File;
  await expect(prepareImport(large)).rejects.toThrow(
    "meeting_import_too_large",
  );
  const store = new MeetingCaptureStore(ports().value);
  expect(
    await store.addFile(new File(["x"], "a.txt"), "identity-1", "cs", "S"),
  ).toBeNull();
  expect(store.getSnapshot().error).toBe("meeting_import_unsupported");
});

test("meetings filter by state and by title without case or accents", () => {
  const meeting = (title: string, status: Meeting["status"]) =>
    ({ id: title, title, status }) as Meeting;
  const all = [
    meeting("Porada s Janem", "ready"),
    meeting("Klient Šťastný", "transcribing"),
    meeting("Nabídka", "failed"),
    meeting("Plán", "interrupted"),
  ];
  expect(filterMeetings(all, "stastny", "all").map((m) => m.title)).toEqual([
    "Klient Šťastný",
  ]);
  expect(filterMeetings(all, "", "failed").map((m) => m.title)).toEqual([
    "Nabídka",
    "Plán",
  ]);
  expect(filterMeetings(all, "", "processing")).toHaveLength(1);
  expect(filterMeetings(all, "JAN", "ready")).toHaveLength(1);
});

test("closing the share picker just returns to idle", async () => {
  const fake = ports({
    getDisplayMedia: jest.fn(async () => {
      throw new DOMException("cancelled", "NotAllowedError");
    }),
  });
  const store = new MeetingCaptureStore(fake.value);
  await store.start("meeting", "identity-1", "cs", "Schůzka");
  expect(store.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  expect(fake.value.getUserMedia).not.toHaveBeenCalled();
});
