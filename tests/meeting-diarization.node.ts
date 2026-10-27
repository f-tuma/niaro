import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import { MeetingProcessor } from "../apps/server-identity/meeting-processing";
import {
  assignVoices,
  diarizerConfig,
  diarizerHealth,
} from "../apps/server-identity/meeting-diarization";
import { minuteSegments } from "../apps/server-identity/meeting-transcript";
import { MEETING_PROFILE } from "../packages/protocol/meetings";
import { meetingNotes } from "../packages/protocol/meeting-notes";
import { locateQuote } from "../packages/protocol/meeting-quotes";

const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
const turn = (
  speaker: "me" | "others" | "unknown",
  start: number,
  end: number,
  text = "TEST",
) => ({ speaker, start, end, text });

test("voices: the most overlapping voice, else the nearest within a second, numbered by first appearance", () => {
  const turns = [
    turn("me", 0, 2),
    turn("others", 2, 4),
    turn("others", 4, 6),
    turn("others", 6.5, 7),
    turn("others", 20, 21),
    { ...turn("others", 30, 31), voice: 9 },
  ];
  const result = assignVoices(
    turns,
    {
      segments: [
        { start: 0, end: 2.1, speaker: 1 },
        { start: 2.1, end: 3.5, speaker: 3 },
        { start: 3.5, end: 4, speaker: 1 },
        { start: 4, end: 6, speaker: 1 },
        { start: 7.4, end: 8, speaker: 3 },
      ],
    },
    "others",
  );
  assert.deepEqual(
    result.map((t) => t.voice),
    // The person recording keeps no voice; 3 speaks first, so it becomes 1;
    // 6.5–7 is 0.4 s from voice 3; nothing is near 20 s, and an old voice
    // that no longer fits is dropped.
    [undefined, 1, 2, 1, undefined, undefined],
  );
  assert.equal(
    assignVoices(turns, { segments: [] }, "others")[1]!.voice,
    undefined,
  );
});

test("voices label the minute lines; a single track names only the diarized voices", () => {
  const voiced = [
    turn("me", 1, 2, "Pošlu nabídku."),
    { ...turn("others", 3, 4, "Do kdy?"), voice: 1 },
    { ...turn("others", 5, 6, "Do pátku."), voice: 2 },
    { ...turn("others", 7, 8, "Dobře."), voice: 2 },
  ];
  assert.equal(
    minuteSegments(voiced, 60, {
      language: "cs",
      twoTrack: true,
      transcriber: "TEST",
    })[0]!.text,
    "Já: Pošlu nabídku.\nMluvčí 1: Do kdy?\nMluvčí 2: Do pátku. Dobře.",
  );
  assert.equal(
    minuteSegments(
      [
        { ...turn("unknown", 1, 2, "Hello."), voice: 1 },
        turn("unknown", 3, 4, "Unheard."),
      ],
      60,
      { language: "en", twoTrack: false, transcriber: "TEST" },
    )[0]!.text,
    "Speaker 1: Hello.\nUnheard.",
  );
});

/** A stand-in for services/diarizer that records what it was sent. */
async function fakeDiarizer(
  reply: (request: IncomingMessage, body: Buffer) => [number, unknown],
) {
  const requests: { path: string; auth?: string; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    requests.push({
      path: request.url!,
      auth: request.headers.authorization,
      body,
    });
    const [status, value] = reply(request, body);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("diarizer health: ready, a wrong token, nothing listening", async () => {
  const service = await fakeDiarizer((request) =>
    request.headers.authorization === "Bearer TEST-token"
      ? [200, { ready: true, model: "TEST/model", error: null }]
      : [401, { error: "unauthorized" }],
  );
  try {
    const config = { enabled: true, url: service.url };
    assert.deepEqual(
      await diarizerHealth(
        diarizerConfig(config, {
          NIARO_DIARIZATION_TOKEN: "TEST-token",
        }),
      ),
      { reachable: true, ready: true, model: "TEST/model", error: null },
    );
    assert.deepEqual(await diarizerHealth(diarizerConfig(config, {})), {
      reachable: false,
      error: "unauthorized",
    });
  } finally {
    await service.close();
  }
  assert.deepEqual(await diarizerHealth({ enabled: true, url: service.url }), {
    reachable: false,
    error: "unreachable",
  });
});

function twoTrack() {
  return new Uint8Array(
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=20",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=500:duration=20",
        "-filter_complex",
        "[0][1]amerge=inputs=2[out]",
        "-map",
        "[out]",
        "-f",
        "wav",
        "pipe:1",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    ),
  );
}

async function processTwoTrack(
  processor: MeetingProcessor,
  store: MeetingStore,
) {
  const bytes = twoTrack();
  const id = randomUUID();
  store.create(scope, {
    profile: MEETING_PROFILE,
    id,
    title: "TEST planning",
    recordedAt: "2026-10-20T08:00:00.000Z",
    language: "cs",
    mimeType: "audio/wav",
    bytes: bytes.length,
    speakerChannels: "self-others",
  });
  for (let at = 0; at < bytes.length; at += 262144)
    store.append(scope, id, at, bytes.slice(at, at + 262144));
  store.seal(scope, id, await store.hash(scope, id));
  await processor.start(
    {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      meetingTranscriber: {
        model: "TEST/STT",
        transcribe: async (input) =>
          input.requestId.endsWith("-me")
            ? {
                text: "Pošlu nabídku.",
                segments: [{ start: 1, end: 3, text: "Pošlu nabídku." }],
                timed: true,
              }
            : {
                text: "Do kdy? Do pátku.",
                segments: [
                  { start: 5, end: 6, text: "Do kdy?" },
                  { start: 15, end: 16, text: "Do pátku." },
                ],
                timed: true,
              },
      },
      analyzer: {
        model: "TEST/model",
        consolidate: async () => ({
          summary: "Nabídka.",
          summarySources: [{ segment: 0, quote: "Pošlu nabídku." }],
          points: [],
          tasks: [],
          overflow: false,
        }),
      },
    },
    id,
    false,
  );
  const until = Date.now() + 30000;
  for (;;) {
    const status = store.get(scope, id).status;
    if (["ready", "failed", "interrupted"].includes(status))
      return { id, status };
    assert(Date.now() < until, "TEST processing did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("with the diarizer on, the others' channel is sent as mono 16 kHz WAV and its turns get voices", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-diarization-test-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  const service = await fakeDiarizer(() => [
    200,
    {
      model: "TEST/model",
      speakers: 2,
      segments: [
        { start: 4.8, end: 6.2, speaker: 2 },
        { start: 14.9, end: 16.1, speaker: 1 },
      ],
    },
  ]);
  const processor = new MeetingProcessor(store, {
    retryDelaysMs: [1, 1],
    diarization: { enabled: true, url: service.url, token: "TEST-token" },
  });
  try {
    const { id, status } = await processTwoTrack(processor, store);
    assert.equal(status, "ready");
    assert.equal(service.requests.length, 1);
    const sent = service.requests[0]!;
    assert.equal(sent.path, "/diarize?maxSpeakers=20");
    assert.equal(sent.auth, "Bearer TEST-token");
    // RIFF header: one channel, 16 000 Hz, 16 bits, about 20 s of sound.
    assert.equal(sent.body.toString("ascii", 0, 4), "RIFF");
    assert.equal(sent.body.readUInt16LE(22), 1);
    assert.equal(sent.body.readUInt32LE(24), 16000);
    assert.equal(sent.body.readUInt16LE(34), 16);
    assert(Math.abs(sent.body.length - 20 * 32000) < 4096);
    const record = store.record(scope, id);
    assert.deepEqual(
      record.utterances!.map((u) => [u.speaker, u.voice, u.text]),
      [
        ["me", undefined, "Pošlu nabídku."],
        ["others", 1, "Do kdy?"],
        ["others", 2, "Do pátku."],
      ],
    );
    assert.equal(
      store.segment(scope, id, 0)!.text,
      "Já: Pošlu nabídku.\nMluvčí 1: Do kdy?\nMluvčí 2: Do pátku.",
    );
    assert.deepEqual(
      meetingNotes(record).utterances.map((u) => u.voice),
      [undefined, 1, 2],
    );
  } finally {
    await processor.close();
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing or switched-off diarizer never stops a meeting", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-diarization-test-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  const service = await fakeDiarizer(() => [503, { error: "not_ready" }]);
  const processor = new MeetingProcessor(store, {
    retryDelaysMs: [1, 1],
    diarization: { enabled: true, url: service.url },
  });
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const failed = await processTwoTrack(processor, store);
    assert.equal(failed.status, "ready");
    assert.deepEqual(warnings, [
      "Meeting diarization failed: diarization_http_503",
    ]);
    assert(store.record(scope, failed.id).utterances!.every((u) => !u.voice));
    processor.configure({ diarization: { enabled: false, url: service.url } });
    const off = await processTwoTrack(processor, store);
    assert.equal(off.status, "ready");
    assert.equal(service.requests.length, 1);
  } finally {
    console.warn = warn;
    await processor.close();
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a voice label a model copies into a quote is stripped like Me and Others", () => {
  const minute = "Já: Pošlu nabídku.\nMluvčí 2: Do pátku, prosím.";
  assert.equal(
    locateQuote(minute, "Mluvčí 2: Do pátku, prosím."),
    "Do pátku, prosím.",
  );
  assert.equal(
    locateQuote(minute, "mluvčí 2: do patku, prosim"),
    "Do pátku, prosím",
  );
});
