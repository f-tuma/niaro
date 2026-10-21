import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import {
  MeetingProcessor,
  type MeetingProcessingAccess,
} from "../apps/server-identity/meeting-processing";
import {
  MEETING_PROFILE,
  validateMeetingAnalysis,
  type MeetingAnalysis,
} from "../packages/protocol/meetings";
import { type MeetingSynthesis } from "../packages/protocol/meeting-record";
import { encodeWav } from "../packages/audio/analysis";
import { consolidateMeeting } from "@niaro/server-agent";
import {
  Mp4AudioError,
  extractMp4Audio,
} from "../apps/server-admin/web/app/meeting-mp4-audio";
import {
  createNiaroMastraModel,
  type NiaroModelSelection,
} from "../apps/server-integrations/mastra-model";
const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
type MeetingCreate = import("../packages/protocol/meetings").MeetingCreate;
const input = (
  bytes: number,
  mimeType: MeetingCreate["mimeType"] = "audio/wav",
): MeetingCreate => ({
  profile: MEETING_PROFILE,
  id: randomUUID(),
  title: "TEST meeting",
  recordedAt: new Date().toISOString(),
  language: "cs" as const,
  mimeType,
  bytes,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-meeting-test-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  return {
    root,
    db,
    store,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const selection: NiaroModelSelection = {
  key: "TEST-key",
  provider: {
    id: randomUUID(),
    revision: 1,
    name: "TEST",
    url: "https://model.test.invalid/v1",
    enabled: true,
    dailyRequestLimit: 100,
    hasCredential: true,
    requestsToday: 0,
  },
  model: {
    id: randomUUID(),
    revision: 1,
    providerId: "",
    name: "TEST",
    model: "TEST/model",
    enabled: true,
    tools: true,
    audioInput: false,
    audioOutput: false,
    kind: "chat",
  },
};
selection.model.providerId = selection.provider.id;
const transcript = "Jan do pátku pošle nabídku. Odeslat email klientovi nyní.";
const analysis = (segment: number): MeetingAnalysis => ({
  summary: [
    {
      text: "Příprava nabídky",
      source: { segment, quote: "Jan do pátku pošle nabídku." },
    },
  ],
  points: [
    {
      text: "Byl zmíněn termín pátku.",
      source: { segment, quote: "do pátku" },
    },
  ],
  tasks: [
    {
      text: "Připravit nabídku",
      assignee: "Jan",
      due: "pátku",
      source: { segment, quote: "Jan do pátku pošle nabídku." },
    },
  ],
});
const synthesis = (segment: number): MeetingSynthesis => ({
  summary: "Příprava nabídky",
  summarySources: [analysis(segment).summary[0]!.source],
  points: analysis(segment).points.map((p) => ({
    text: p.text,
    sources: [p.source],
  })),
  tasks: analysis(segment).tasks.map((t) => ({
    text: t.text,
    assignee: t.assignee,
    due: t.due,
    sources: [t.source],
  })),
  overflow: false,
});
async function wait(f: () => boolean) {
  const until = Date.now() + 15000;
  while (!f()) {
    assert(Date.now() < until, "TEST processing did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function seal(
  f: ReturnType<typeof fixture>,
  audio: Uint8Array,
  mimeType?: MeetingCreate["mimeType"],
) {
  const request = input(audio.length, mimeType);
  f.store.create(scope, request);
  for (let at = 0; at < audio.length; at += 262144)
    f.store.append(scope, request.id, at, audio.slice(at, at + 262144));
  f.store.seal(scope, request.id, await f.store.hash(scope, request.id));
  return request.id;
}
function audio(silent = false) {
  const samples = new Float32Array(16000);
  if (!silent)
    for (let i = 0; i < samples.length; i++)
      samples[i] = Math.sin(i / 20) * 0.2;
  return encodeWav(samples, 16000);
}
test("durable upload: exact replay, conflicting bytes, complete seal, full scope and crash tail", async () => {
  const f = fixture();
  try {
    const request = input(8);
    const m = f.store.create(scope, request);
    assert.deepEqual(f.store.create(scope, request), m);
    assert.throws(
      () => f.store.get({ ...scope, connectionId: "TEST-other" }, m.id),
      /meeting_not_found/,
    );
    assert.throws(
      () => f.store.create(scope, { ...request, title: "changed" }),
      /meeting_upload_conflict/,
    );
    assert.equal(f.store.append(scope, m.id, 0, Buffer.from("1234")).offset, 4);
    assert.equal(f.store.append(scope, m.id, 0, Buffer.from("1234")).offset, 4);
    assert.throws(
      () => f.store.append(scope, m.id, 0, Buffer.from("4321")),
      /meeting_upload_conflict/,
    );
    await assert.rejects(
      f.store.hash(scope, m.id),
      /meeting_upload_incomplete/,
    );
    writeFileSync(f.store.path(m), "1234junk"); // Crash wrote an unacknowledged next block.
    const reopened = new MeetingStore(f.db);
    reopened.append(scope, m.id, 4, Buffer.from("5678"));
    const hash = await reopened.hash(scope, m.id);
    assert.equal(reopened.seal(scope, m.id, hash).status, "sealed");
    assert.throws(
      () => reopened.append(scope, m.id, 4, Buffer.from("5678")),
      /meeting_upload_conflict/,
    );
    assert.equal(reopened.seal(scope, m.id, hash).sourceHash, hash);
    reopened.delete(scope, m.id);
    assert.throws(() => reopened.get(scope, m.id), /meeting_not_found/);
  } finally {
    f.close();
  }
});
test("real disk audio → bounded STT → closed Mastra extraction → durable source-linked artifacts", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  let speechCalls = 0,
    modelCalls = 0;
  try {
    const id = await seal(f, audio());
    const model = createNiaroMastraModel(
      selection,
      async (req) => {
        await req.beforeDispatch!(() => {
          modelCalls++;
        });
        const body = req.body as {
          tools?: unknown[];
          messages: { content: string }[];
        };
        assert(!body.tools?.length, "TEST meeting has zero business tools");
        assert(body.messages.some((m) => m.content.includes(transcript)));
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify(synthesis(0)) },
              },
            ],
          }),
        };
      },
      async (start) => start(),
    );
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      transcriber: {
        engine: "openrouter",
        model: "TEST/STT",
        transcribe: async (request) => {
          speechCalls++;
          assert(
            Buffer.from(request.audio.base64, "base64").length <
              4 * 1024 * 1024,
          );
          return transcript;
        },
      },
      analyzer: {
        model: "TEST/model",
        consolidate: (input, lang, signal) =>
          consolidateMeeting(model, input, lang, signal),
      },
    };
    await processor.start(access, id, false);
    await wait(() => f.store.get(scope, id).status === "ready");
    assert.equal(speechCalls, 1);
    assert.equal(modelCalls, 1);
    const segment = f.store.segment(scope, id, 0)!;
    assert.equal(segment.text, transcript);
    assert.equal(segment.analysis, null);
    const published = f.store.record(scope, id).analysis!;
    assert.equal(published.summary, synthesis(0).summary);
    assert.deepEqual(published.summarySources, synthesis(0).summarySources);
    assert.deepEqual(
      published.points.map((p) => [p.text, p.sources]),
      synthesis(0).points.map((p) => [p.text, p.sources]),
    );
    assert.deepEqual(
      published.tasks.map((t) => [t.text, t.assignee, t.due, t.sources]),
      synthesis(0).tasks.map((t) => [t.text, t.assignee, t.due, t.sources]),
    );
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 1);
    assert.deepEqual(segment.reviewReasons, ["uncertain"]);
    await processor.start(access, id, false);
    assert.equal(modelCalls, 1);
  } finally {
    await processor.close();
    f.close();
  }
});
test("whole-meeting synthesis turns an explicit unanswered blocker into a sourced human task", async () => {
  const unresolved =
    "Kdo nám do pátku potvrdí termín? Bez potvrzení nemůžeme poslat nabídku.";
  const evidence = "Kdo nám do pátku potvrdí termín?";
  const expected: MeetingSynthesis = {
    summary: "Odeslání nabídky čeká na potvrzení termínu.",
    summarySources: [{ segment: 0, quote: "nemůžeme poslat nabídku" }],
    points: [],
    tasks: [
      {
        text: "Rozhodnout, kdo potvrdí termín.",
        assignee: null,
        due: null,
        sources: [{ segment: 0, quote: evidence }],
      },
    ],
    overflow: false,
  };
  let receivedInstructions = false;
  const model = createNiaroMastraModel(
    selection,
    async (req) => {
      await req.beforeDispatch!(() => {});
      const body = req.body as { messages: { content: string }[] };
      receivedInstructions = body.messages.some(
        (message) =>
          message.content.includes("unanswered questions") &&
          message.content.includes("missing information requests"),
      );
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(expected) },
            },
          ],
        }),
      };
    },
    async (start) => start(),
  );
  const result = await consolidateMeeting(
    model,
    { segments: [{ index: 0, text: unresolved }] },
    "cs",
    new AbortController().signal,
  );
  assert(
    receivedInstructions,
    "TEST unresolved questions must be requested as tasks",
  );
  assert.deepEqual(
    result.tasks.map((t) => [t.text, t.owner, t.due, t.sources]),
    expected.tasks.map((t) => [t.text, t.assignee, t.due, t.sources]),
  );
});
test("silent intervals produce empty preserved segments without any paid dispatch", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  try {
    const id = await seal(f, audio(true));
    let calls = 0;
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      transcriber: {
        transcribe: async () => {
          calls++;
          throw Error("should not call");
        },
      },
      analyzer: {
        model: "TEST",
        consolidate: async () => {
          calls++;
          throw Error("should not call");
        },
      },
    };
    await processor.start(access, id, false);
    await wait(() => f.store.get(scope, id).status === "ready");
    assert.equal(calls, 0);
    assert.equal(f.store.segment(scope, id, 0)!.text, "");
  } finally {
    await processor.close();
    f.close();
  }
});
test("lost inference/boot marks interrupted; explicit retry reuses committed transcript", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  try {
    const id = await seal(f, audio());
    let stt = 0,
      models = 0;
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      transcriber: {
        transcribe: async () => {
          stt++;
          return { text: transcript, reviewReasons: [] };
        },
      },
      analyzer: {
        model: "TEST",
        consolidate: async (_s, _l, signal) => {
          models++;
          return new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(Error("TEST interrupted")),
              { once: true },
            ),
          );
        },
      },
    };
    await processor.start(access, id, false);
    await wait(() => models === 1);
    await processor.close();
    assert.equal(f.store.get(scope, id).status, "interrupted");
    assert.equal(f.store.segment(scope, id, 0)!.text, transcript);
    const restarted = new MeetingProcessor(new MeetingStore(f.db));
    try {
      await assert.rejects(
        restarted.start(access, id, false),
        /meeting_retry_required/,
      );
      await restarted.start(
        {
          ...access,
          analyzer: {
            model: "TEST",
            consolidate: async (input) => {
              models++;
              return synthesis(input.segments[0]!.index);
            },
          },
        },
        id,
        true,
      );
      await wait(() => f.store.get(scope, id).status === "ready");
      assert.equal(stt, 1);
      assert.equal(models, 2);
    } finally {
      await restarted.close();
    }
  } finally {
    await processor.close();
    f.close();
  }
});
test("provenance rejects invented sources, owners and deadlines", () => {
  const segment = { index: 0, text: transcript };
  assert.throws(
    () =>
      validateMeetingAnalysis(
        {
          ...analysis(0),
          points: [{ text: "TEST", source: { segment: 0, quote: "Invented" } }],
        },
        segment,
      ),
    /meeting_source_invalid/,
  );
  assert.throws(
    () =>
      validateMeetingAnalysis(
        {
          ...analysis(0),
          tasks: [{ ...analysis(0).tasks[0]!, assignee: "Petr" }],
        },
        segment,
      ),
    /meeting_source_invalid/,
  );
  assert.throws(
    () => validateMeetingAnalysis(analysis(1), segment),
    /meeting_source_invalid/,
  );
});

test("room noise with no VAD speech preserves an empty interval instead of failing the meeting", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  try {
    const id = await seal(f, audio());
    let modelCalls = 0;
    await processor.start(
      {
        scope,
        run: async (fn) => fn(),
        failure: async (fn) => fn(),
        transcriber: {
          transcribe: async () => {
            throw Object.assign(new Error("voice_empty"), {
              code: "voice_empty",
              reason: "no_speech",
            });
          },
        },
        analyzer: {
          model: "TEST",
          consolidate: async () => {
            modelCalls++;
            throw Error("should not call");
          },
        },
      },
      id,
      false,
    );
    await wait(() => f.store.get(scope, id).status === "ready");
    assert.equal(modelCalls, 0);
    assert.equal(f.store.segment(scope, id, 0)!.text, "");
  } finally {
    await processor.close();
    f.close();
  }
});

test("recognition-empty on non-silent audio fails visibly and never publishes an incomplete transcript", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  try {
    const id = await seal(f, audio());
    await processor.start(
      {
        scope,
        run: async (fn) => fn(),
        failure: async (fn) => fn(),
        transcriber: {
          transcribe: async () => {
            throw Object.assign(Error("TEST undecipherable speech"), {
              code: "voice_empty",
            });
          },
        },
        analyzer: {
          model: "TEST",
          consolidate: async () => {
            throw Error("TEST should not infer");
          },
        },
      },
      id,
      false,
    );
    await wait(() => f.store.get(scope, id).status === "failed");
    assert.equal(
      f.store.get(scope, id).failure,
      "meeting_transcription_failed",
    );
    assert.equal(f.store.record(scope, id).transcriptComplete, false);
    assert.equal(f.store.record(scope, id).analysis, null);
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 0);
  } finally {
    await processor.close();
    f.close();
  }
});

test("MP3 and OGG files brought in from elsewhere are decoded with their own demuxer; a mislabelled file fails visibly", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  const encode = (extension: string, codec: string) => {
    const source = join(f.root, "TEST.wav");
    const target = join(f.root, `TEST.${extension}`);
    // Silence still goes through the full decode; it needs no paid STT call.
    writeFileSync(source, audio(true));
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      source,
      "-c:a",
      codec,
      target,
    ]);
    return new Uint8Array(readFileSync(target));
  };
  let speechCalls = 0;
  const access: MeetingProcessingAccess = {
    scope,
    run: async (fn) => fn(),
    failure: async (fn) => fn(),
    transcriber: {
      engine: "openrouter",
      model: "TEST/STT",
      transcribe: async () => {
        speechCalls++;
        return "";
      },
    },
    // Silent audio has nothing to consolidate, so no model is called.
    analyzer: {
      model: "TEST/model",
      consolidate: async () => {
        throw new Error("TEST no model for silence");
      },
    },
  };
  try {
    const mp3 = encode("mp3", "libmp3lame");
    const ogg = encode("ogg", "libopus");
    for (const [bytes, mimeType] of [
      [mp3, "audio/mpeg"],
      [ogg, "audio/ogg"],
    ] as const) {
      const id = await seal(f, bytes, mimeType);
      await processor.start(access, id, false);
      await wait(() =>
        ["ready", "failed"].includes(f.store.get(scope, id).status),
      );
      const meeting = f.store.get(scope, id);
      assert.equal(meeting.status, "ready", `${mimeType} ${meeting.failure}`);
      assert(Math.abs(meeting.durationSeconds! - 1) < 0.2);
    }
    assert.equal(speechCalls, 0);
    const wrong = await seal(f, mp3, "audio/ogg");
    await processor.start(access, wrong, false);
    await wait(() => f.store.get(scope, wrong).status === "failed");
    assert.equal(f.store.get(scope, wrong).failure, "meeting_audio_invalid");
    assert.equal(speechCalls, 0);
  } finally {
    await processor.close();
    f.close();
  }
});

test("a browser's two-track WebM (no duration, L = me, R = others) is transcribed per speaker and labelled", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  // Piped output has no duration or cues, exactly like MediaRecorder's.
  const webm = new Uint8Array(
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=500:duration=3",
        "-filter_complex",
        "[0]adelay=800[late];[late][1]amerge=inputs=2[out]",
        "-map",
        "[out]",
        "-c:a",
        "libopus",
        "-f",
        "webm",
        "pipe:1",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const requests: string[] = [];
  let consolidated: Parameters<
    NonNullable<MeetingProcessingAccess["analyzer"]>["consolidate"]
  >[0] = { segments: [] };
  const self = "Domluvím další schůzku.";
  const others = "Pošlete nám nabídku.";
  const access: MeetingProcessingAccess = {
    scope,
    run: async (fn) => fn(),
    failure: async (fn) => fn(),
    transcriber: {
      engine: "openrouter",
      model: "TEST/STT",
      transcribe: async (request) => {
        requests.push(request.requestId);
        return {
          text: request.requestId.endsWith("-self") ? self : others,
          reviewReasons: [],
        };
      },
    },
    analyzer: {
      model: "TEST/model",
      consolidate: async (input) => {
        consolidated = input;
        return {
          summary: "Nabídka a další schůzka",
          summarySources: [{ segment: 0, quote: `Já: ${self}` }],
          points: [],
          tasks: [
            {
              text: "Domluvit další schůzku",
              assignee: null,
              due: null,
              sources: [{ segment: 0, quote: `Já: ${self}` }],
            },
          ],
          overflow: false,
        };
      },
    },
  };
  try {
    const request = {
      ...input(webm.length, "audio/webm"),
      speakerChannels: "self-others" as const,
    };
    f.store.create(scope, request);
    for (let at = 0; at < webm.length; at += 262144)
      f.store.append(scope, request.id, at, webm.slice(at, at + 262144));
    f.store.seal(scope, request.id, await f.store.hash(scope, request.id));
    await processor.start(access, request.id, false);
    await wait(() =>
      ["ready", "failed"].includes(f.store.get(scope, request.id).status),
    );
    const meeting = f.store.get(scope, request.id);
    assert.equal(meeting.status, "ready", String(meeting.failure));
    assert.equal(meeting.speakerChannels, "self-others");
    assert(Math.abs(meeting.durationSeconds! - 3) < 0.2);
    assert.deepEqual(requests.sort(), [
      `meeting-${request.id}-0-others`,
      `meeting-${request.id}-0-self`,
    ]);
    // The others started first (the left channel is delayed by 0.8 s).
    assert.equal(
      f.store.segment(scope, request.id, 0)!.text,
      `Ostatní: ${others}\nJá: ${self}`,
    );
    assert.deepEqual(consolidated.speakers, { self: "Já", others: "Ostatní" });
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 1);

    // A mono file can't claim two speaker channels.
    const mono = new Uint8Array(audio());
    const wrong = {
      ...input(mono.length),
      speakerChannels: "self-others" as const,
    };
    f.store.create(scope, wrong);
    f.store.append(scope, wrong.id, 0, mono);
    f.store.seal(scope, wrong.id, await f.store.hash(scope, wrong.id));
    await processor.start(access, wrong.id, false);
    await wait(() => f.store.get(scope, wrong.id).status === "failed");
    assert.equal(f.store.get(scope, wrong.id).failure, "meeting_audio_invalid");
  } finally {
    await processor.close();
    f.close();
  }
});

test("a meeting's video recording (MP4 with H.264 + AAC) is accepted as audio/mp4; only its audio is decoded", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  const target = join(f.root, "TEST.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=160x120:rate=10",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    target,
  ]);
  let speechCalls = 0;
  const access: MeetingProcessingAccess = {
    scope,
    run: async (fn) => fn(),
    failure: async (fn) => fn(),
    transcriber: {
      engine: "openrouter",
      model: "TEST/STT",
      transcribe: async () => {
        speechCalls++;
        return "";
      },
    },
    analyzer: {
      model: "TEST/model",
      consolidate: async () => {
        throw new Error("TEST no model for silence");
      },
    },
  };
  try {
    const id = await seal(f, new Uint8Array(readFileSync(target)), "audio/mp4");
    await processor.start(access, id, false);
    await wait(() =>
      ["ready", "failed"].includes(f.store.get(scope, id).status),
    );
    const meeting = f.store.get(scope, id);
    assert.equal(meeting.status, "ready", String(meeting.failure));
    assert(Math.abs(meeting.durationSeconds! - 2) < 0.2);
    assert.equal(speechCalls, 0);
  } finally {
    await processor.close();
    f.close();
  }
});

test("the web app takes a video recording's AAC track out of its MP4 without re-encoding", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-meeting-mp4-"));
  try {
    const source = join(root, "TEST.mp4");
    const encode = (target: string, extra: string[] = []) =>
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=12:size=320x240:rate=25,noise=alls=80:allf=t",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=12",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        ...extra,
        target,
      ]);
    encode(source);
    const original = new Blob([readFileSync(source)]);
    const audioOnly = await extractMp4Audio(original);
    assert(audioOnly.size < original.size / 2);
    const target = join(root, "TEST.m4a");
    writeFileSync(target, Buffer.from(await audioOnly.arrayBuffer()));
    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-f",
        "mov",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name",
        "-of",
        "json",
        target,
      ]).toString(),
    ) as {
      format: { duration: string };
      streams: { codec_type: string; codec_name: string }[];
    };
    assert.deepEqual(
      probe.streams.map((s) => [s.codec_type, s.codec_name]),
      [["audio", "aac"]],
    );
    assert(Math.abs(Number(probe.format.duration) - 12) < 0.2);
    // Every sample decodes, and seeking into the middle works for chunking.
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "mov",
      "-i",
      target,
      "-f",
      "null",
      "-",
    ]);
    const pcm = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "mov",
      "-ss",
      "6",
      "-i",
      target,
      "-t",
      "2",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "-",
    ]);
    assert(Math.abs(pcm.length - 64000) < 2000);
    // A fragmented recording has no single sample table to keep.
    const fragmented = join(root, "TEST-fragmented.mp4");
    encode(fragmented, ["-movflags", "frag_keyframe+empty_moov"]);
    await assert.rejects(
      extractMp4Audio(new Blob([readFileSync(fragmented)])),
      Mp4AudioError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
