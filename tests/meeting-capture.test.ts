import {
  MeetingCapture,
  MEETING_RECORD_SECONDS,
  meetingImportType,
} from "../packages/client-core/meeting-capture";
import { AudioSessionCoordinator } from "../packages/audio/coordinator";
import type { ClientSession } from "../packages/client-core/session";
const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const storage = new Map<string, string>();
  const events: string[] = [];
  const coordinator = new AudioSessionCoordinator();
  let fail = false,
    recording = false,
    prepared = false;
  const ports = {
    storage: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        events.push("journal");
        if (fail) throw Error("TEST disk full");
        storage.set(key, value);
      },
    },
    coordinator,
    permission: async () => true,
    mode: async (on: boolean) => {
      events.push(`mode:${on}`);
    },
    prepare: async () => {
      if (prepared) throw Error("TEST encoder leaked");
      prepared = true;
      events.push("prepare");
    },
    uri: () => "file:///document/Audio/recording-test.m4a",
    record: () => {
      events.push("record");
      recording = true;
    },
    importFile: async (source: string, extension: string) => {
      events.push(`import:${source}:${extension}`);
      return {
        uri: `file:///document/Audio/import-TEST.${extension}`,
        bytes: 640,
      };
    },
    discard: (source: string) => {
      events.push(`discard:${source}`);
    },
    pause: () => {
      events.push("pause");
      recording = false;
    },
    resume: (remaining: number) => {
      events.push(`resume:${remaining}`);
      recording = true;
    },
    stop: async () => {
      events.push("stop");
      recording = false;
      prepared = false;
      return "file:///document/Audio/recording-test.m4a";
    },
    status: () => ({ isRecording: recording, durationMillis: 1000 }),
    valid: () => true,
    size: () => 64,
    probe: async () => 1000,
    read: (_uri: string, _at: number, n: number) => new Uint8Array(n),
    remove: () => {
      events.push("remove");
    },
  };
  const capture = new MeetingCapture("TEST-A", ports);
  return {
    capture,
    ports,
    storage,
    events,
    coordinator,
    fail(value: boolean) {
      fail = value;
    },
    finish() {
      recording = false;
      prepared = false;
    },
  };
}
test("journal is durable before the microphone starts; stop preserves a recoverable file", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST", "cs");
  expect(f.events.indexOf("journal")).toBeLessThan(f.events.indexOf("record"));
  expect(f.coordinator.current()).toBe("recording");
  await f.capture.stop();
  expect(f.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    bytes: 64,
    durationMillis: 1000,
  });
  expect(f.coordinator.current()).toBeNull();
  const restored = new MeetingCapture("TEST-A", f.ports);
  await restored.restore();
  expect(restored.getSnapshot().entries).toHaveLength(1);
  const other = new MeetingCapture("TEST-B", f.ports);
  await other.restore();
  expect(other.getSnapshot().entries).toHaveLength(0);
});
test("journal storage failure after native prepare resets encoder before next start", async () => {
  const f = fixture();
  await f.capture.restore();
  f.fail(true);
  await f.capture.start(id, "TEST", "en");
  expect(f.events).not.toContain("record");
  expect(f.events).toContain("stop");
  expect(f.coordinator.current()).toBeNull();
  f.fail(false);
  await f.capture.start(id, "TEST", "en");
  expect(f.capture.getSnapshot().phase).toBe("recording");
  await f.capture.stop();
});
test("native auto completion finalizes directly without issuing Stop twice", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST", "en");
  f.finish();
  await f.capture.finishNative();
  expect(f.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    interrupted: true,
  });
  expect(f.events).not.toContain("stop");
  expect(f.coordinator.current()).toBeNull();
});
test("scope switch during a pending permission never starts recording", async () => {
  const f = fixture();
  let grant: (value: boolean) => void = () => {};
  f.ports.permission = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  await f.capture.restore();
  const start = f.capture.start(id, "TEST", "en");
  f.capture.dispose();
  grant(true);
  await start;
  expect(f.events).not.toContain("record");
  expect(f.coordinator.current()).toBeNull();
});
test("backgrounding during native preparation invalidates the pending recording start", async () => {
  const f = fixture();
  let finishPrepare!: () => void;
  f.ports.prepare = () =>
    new Promise<void>((resolve) => {
      finishPrepare = resolve;
    });
  await f.capture.restore();
  const start = f.capture.start(id, "TEST", "en");
  await Promise.resolve();
  await Promise.resolve();
  f.capture.cancelPreparing();
  finishPrepare();
  await start;
  expect(f.events).not.toContain("record");
  expect(f.events).toContain("stop");
  expect(f.coordinator.current()).toBeNull();
  expect(f.capture.getSnapshot()).toMatchObject({
    phase: "idle",
    error: "meeting_recording_interrupted",
  });
});
test("backgrounding during journal persistence removes the unused meeting and file", async () => {
  const f = fixture();
  let enterJournal!: () => void;
  let finishJournal!: () => void;
  const journalEntered = new Promise<void>((resolve) => {
    enterJournal = resolve;
  });
  const journalGate = new Promise<void>((resolve) => {
    finishJournal = resolve;
  });
  const persist = f.ports.storage.setItem;
  f.ports.storage.setItem = async (key, value) => {
    if (
      JSON.parse(value).some(
        (entry: { state: string }) => entry.state === "pending",
      )
    ) {
      enterJournal();
      await journalGate;
    }
    await persist(key, value);
  };
  await f.capture.restore();
  const start = f.capture.start(id, "TEST", "en");
  await journalEntered;
  f.capture.cancelPreparing();
  finishJournal();
  await start;

  expect(f.events).not.toContain("record");
  expect(f.events).toContain("remove");
  expect(f.capture.getSnapshot()).toMatchObject({ phase: "idle", entries: [] });
  expect(JSON.parse(f.storage.get("niaro-meeting-capture/1:TEST-A")!)).toEqual(
    [],
  );
  expect(f.coordinator.current()).toBeNull();
});
test("upload cannot retarget a journaled recording to another destination", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST", "en");
  await f.capture.stop();
  const createMeeting = jest.fn();
  await f.capture.upload(id, {
    identityKey: "TEST-B",
    createMeeting,
  } as unknown as ClientSession);
  expect(createMeeting).not.toHaveBeenCalled();
  expect(f.capture.getSnapshot().entries[0]!.uploaded).toBe(false);
});
test("corrupt journal blocks capture without overwriting files", async () => {
  const f = fixture();
  f.storage.set("niaro-meeting-capture/1:TEST-A", "broken");
  await f.capture.restore();
  await f.capture.start(id, "TEST", "en");
  expect(f.capture.getSnapshot().phase).toBe("loading");
  expect(f.events).not.toContain("record");
});

test("explicit playback owns shared audio and releases it on navigation/disposal", async () => {
  const f = fixture();
  const stop = jest.fn();
  const capture = new MeetingCapture("TEST-A", {
    ...f.ports,
    play: () => ({ stop }),
  });
  await capture.restore();
  await capture.start(id, "TEST", "en");
  await capture.stop();
  await capture.play(id);
  expect(f.coordinator.current()).toBe("playback");
  capture.dispose();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(f.coordinator.current()).toBeNull();
});

test("Stop during playback preparation prevents a delayed unowned play", async () => {
  const f = fixture();
  let release = () => {};
  let delayed = false;
  const play = jest.fn(() => ({ stop: jest.fn() }));
  const capture = new MeetingCapture("TEST-A", {
    ...f.ports,
    play,
    mode: async () => {
      if (delayed)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  await capture.restore();
  await capture.start(id, "TEST", "en");
  await capture.stop();
  delayed = true;
  const pending = capture.play(id);
  capture.stopPlayback();
  release();
  await pending;
  expect(play).not.toHaveBeenCalled();
  expect(f.coordinator.current()).toBeNull();
  expect(capture.getSnapshot().phase).toBe("idle");
});

test("pause holds the meeting open; resume continues it for the remaining time and stop from pause saves it", async () => {
  const f = fixture();
  await f.capture.restore();
  f.capture.pause();
  f.capture.resume();
  expect(f.events).not.toContain("pause");
  await f.capture.start(id, "TEST", "cs");
  f.capture.pause();
  expect(f.capture.getSnapshot().phase).toBe("paused");
  // The microphone and the file stay with the meeting while it is paused.
  expect(f.coordinator.current()).toBe("recording");
  f.capture.resume();
  expect(f.capture.getSnapshot().phase).toBe("recording");
  expect(f.events).toContain(`resume:${MEETING_RECORD_SECONDS - 1}`);
  f.capture.pause();
  await f.capture.stop();
  expect(f.capture.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  expect(f.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    interrupted: false,
  });
  expect(f.coordinator.current()).toBeNull();
});
test("the encoder's own time limit ends a paused meeting like a recording one", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST", "cs");
  f.capture.pause();
  f.finish();
  await f.capture.finishNative(true);
  expect(f.capture.getSnapshot().phase).toBe("idle");
  expect(f.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    interrupted: true,
  });
  expect(f.events.filter((event) => event === "stop")).toHaveLength(0);
});
test("a pause the encoder refuses keeps the meeting recording and says so", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST", "cs");
  f.ports.pause = () => {
    throw Error("TEST encoder busy");
  };
  f.capture.pause();
  expect(f.capture.getSnapshot()).toMatchObject({
    phase: "recording",
    error: "meeting_recording_failed",
  });
});

test.each([
  ["Porada.m4a", "audio/mp4"],
  ["hovor.MP3", "audio/mpeg"],
  ["WhatsApp Audio.opus", "audio/ogg"],
  ["zaznam.wav", "audio/wav"],
  ["meeting.webm", "audio/webm"],
  ["voice.aac", null],
  ["notes.txt", null],
  ["no-extension", null],
])("%s is brought in as %s", (name, mimeType) => {
  expect(meetingImportType(name)?.mimeType ?? null).toBe(mimeType);
});
test("an audio file from elsewhere becomes a captured meeting that uploads like a recording", async () => {
  const f = fixture();
  await f.capture.restore();
  const imported = await f.capture.importFile(
    { uri: "file:///cache/picked.mp3", name: "Porada.mp3", size: 640 },
    id,
    "TEST",
    "cs",
  );
  expect(imported).toBe(id);
  expect(f.events).toContain("import:file:///cache/picked.mp3:mp3");
  expect(f.events).toContain("discard:file:///cache/picked.mp3");
  expect(f.capture.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  expect(f.capture.getSnapshot().entries[0]).toMatchObject({
    id,
    state: "captured",
    mimeType: "audio/mpeg",
    bytes: 640,
    durationMillis: 1000,
    uploaded: false,
    interrupted: false,
  });
  const meeting = (offset: number, status = "uploading") => ({
    status,
    offset,
  });
  const session = {
    identityKey: "TEST-A",
    createMeeting: jest.fn(async () => meeting(0)),
    uploadMeetingBlock: jest.fn(
      async (_id: string, at: number, block: Uint8Array) =>
        meeting(at + block.length),
    ),
    sealMeeting: jest.fn(async () => meeting(640, "sealed")),
    processMeeting: jest.fn(async () => {}),
  };
  f.ports.size = () => 640;
  await f.capture.upload(id, session as unknown as ClientSession);
  expect(session.createMeeting).toHaveBeenCalledWith(
    expect.objectContaining({ id, mimeType: "audio/mpeg", bytes: 640 }),
  );
  expect(session.processMeeting).toHaveBeenCalledWith(id);
  expect(f.capture.getSnapshot().entries[0]!.uploaded).toBe(true);
});
test("an unsupported or too large file is refused before anything is copied", async () => {
  const f = fixture();
  await f.capture.restore();
  for (const [file, error] of [
    [
      { uri: "file:///cache/a.aac", name: "a.aac" },
      "meeting_import_unsupported",
    ],
    [
      { uri: "file:///cache/b.mp3", name: "b.mp3", size: 64 * 1024 * 1024 + 1 },
      "meeting_import_too_large",
    ],
  ] as const) {
    expect(await f.capture.importFile(file, id, "TEST", "cs")).toBeNull();
    expect(f.capture.getSnapshot()).toMatchObject({ phase: "idle", error });
  }
  expect(f.events.some((event) => event.startsWith("import:"))).toBe(false);
  // The picker's temporary copies never stay behind.
  expect(f.events.filter((event) => event.startsWith("discard:"))).toEqual([
    "discard:file:///cache/a.aac",
    "discard:file:///cache/b.mp3",
  ]);
  expect(f.capture.getSnapshot().entries).toEqual([]);
});
test("a file this device cannot play is still imported; one over two hours is removed again", async () => {
  const f = fixture();
  await f.capture.restore();
  f.ports.probe = async () => {
    throw Error("TEST no decoder");
  };
  expect(
    await f.capture.importFile(
      { uri: "file:///cache/a.opus", name: "a.opus", size: 640 },
      id,
      "TEST",
      "cs",
    ),
  ).toBe(id);
  expect(f.capture.getSnapshot().entries[0]).toMatchObject({
    mimeType: "audio/ogg",
    durationMillis: 0,
  });
  f.ports.probe = async () => 7201 * 1000;
  expect(
    await f.capture.importFile(
      { uri: "file:///cache/b.m4a", name: "b.m4a", size: 640 },
      "22222222-2222-4222-8222-222222222222",
      "TEST",
      "cs",
    ),
  ).toBeNull();
  expect(f.capture.getSnapshot().error).toBe("meeting_import_too_long");
  expect(f.events).toContain("remove");
  expect(f.capture.getSnapshot().entries).toHaveLength(1);
});
test("no file is imported while a meeting records", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST", "cs");
  expect(
    await f.capture.importFile(
      { uri: "file:///cache/a.mp3", name: "a.mp3", size: 640 },
      "22222222-2222-4222-8222-222222222222",
      "TEST",
      "cs",
    ),
  ).toBeNull();
  expect(f.capture.getSnapshot().phase).toBe("recording");
  expect(f.events).toContain("discard:file:///cache/a.mp3");
});

test("successful explicit remove retry clears only its owned deletion storage error", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST removal", "en");
  await f.capture.stop();
  const remove = jest.spyOn(f.ports, "remove").mockImplementationOnce(() => {
    throw Error("TEST remove failed");
  });
  await expect(f.capture.remove(id)).resolves.toBeUndefined();
  expect(f.capture.getSnapshot().entries).toHaveLength(1);
  expect(f.capture.getSnapshot().error).toBe("meeting_storage_failed");
  await f.capture.remove(id);
  expect(remove).toHaveBeenCalledTimes(2);
  expect(f.capture.getSnapshot().entries).toHaveLength(0);
  expect(f.capture.getSnapshot().error).toBeNull();
});

test("a successful removal cannot clear a newer same-text failure owned by another entry", async () => {
  const f = fixture(),
    other = "22222222-2222-4222-8222-222222222222";
  await f.capture.restore();
  for (const next of [id, other]) {
    await f.capture.start(next, "TEST removal", "en");
    await f.capture.stop();
  }
  jest
    .spyOn(f.ports, "remove")
    .mockImplementationOnce(() => {
      throw Error("TEST first remove failed");
    })
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw Error("TEST newer remove failed");
    });
  await f.capture.remove(id);
  const persist = f.ports.storage.setItem;
  let complete!: () => Promise<void>;
  f.ports.storage.setItem = (key, value) =>
    new Promise<void>((resolve) => {
      complete = async () => {
        await persist(key, value);
        resolve();
      };
    });
  const pending = f.capture.remove(id);
  await f.capture.remove(other);
  await complete();
  await pending;
  expect(f.capture.getSnapshot().entries.map((e) => e.id)).toEqual([other]);
  expect(f.capture.getSnapshot().error).toBe("meeting_storage_failed");
});

test("a successful removal preserves a newer unrelated import error", async () => {
  const f = fixture();
  await f.capture.restore();
  await f.capture.start(id, "TEST removal", "en");
  await f.capture.stop();
  jest.spyOn(f.ports, "remove").mockImplementationOnce(() => {
    throw Error("TEST remove failed");
  });
  await f.capture.remove(id);
  await f.capture.importFile(
    { uri: "file:///TEST.txt", name: "TEST.txt" },
    "22222222-2222-4222-8222-222222222222",
    "TEST import",
    "en",
  );
  expect(f.capture.getSnapshot().error).toBe("meeting_import_unsupported");
  await f.capture.remove(id);
  expect(f.capture.getSnapshot().error).toBe("meeting_import_unsupported");
});
