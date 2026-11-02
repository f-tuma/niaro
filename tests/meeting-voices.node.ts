import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import { MeetingProcessor } from "../apps/server-identity/meeting-processing";
import { assignVoices } from "../apps/server-identity/meeting-diarization";
import { matchVoice } from "../apps/server-identity/meeting-voices";
import {
  MEETING_PROFILE,
  meetingSpeakerLabels,
  meetingTurnLabel,
  nameVoices,
} from "../packages/protocol/meetings";
import {
  meetingNotes,
  namedMeetingNotes,
  namedMeetingRecord,
} from "../packages/protocol/meeting-notes";

const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
const cs = meetingSpeakerLabels("cs");
const en = meetingSpeakerLabels("en");
const unit = (...values: number[]) => {
  const vector = [...values, ...Array(16 - values.length).fill(0)];
  const norm = Math.hypot(...vector);
  return vector.map((v) => v / norm);
};

test("names replace a voice everywhere it is mentioned, in either language and Czech case", () => {
  const people = { voiceNames: { "2": "Jana Nováková" }, selfVoice: 1 };
  assert.equal(
    nameVoices(
      "Mluvčí 2 navrhla termín, mluvčího 2 podpořil Mluvčí 1; Mluvčí 12 nesouhlasil.",
      cs,
      people,
    ),
    "Jana Nováková navrhla termín, Jana Nováková podpořil Já; Mluvčí 12 nesouhlasil.",
  );
  assert.equal(
    nameVoices("Speaker 2 will send it, speaker 3 asks.", en, people),
    "Jana Nováková will send it, speaker 3 asks.",
  );
  assert.equal(nameVoices("Speaker 2", en, undefined), "Speaker 2");
  assert.equal(
    meetingTurnLabel({ speaker: "unknown", voice: 2 }, en, people),
    "Jana Nováková",
  );
  assert.equal(
    meetingTurnLabel({ speaker: "unknown", voice: 1 }, en, people),
    "Me",
  );
  assert.equal(
    meetingTurnLabel({ speaker: "unknown", voice: 3 }, en, people),
    "Speaker 3",
  );
  const record = {
    meeting: { language: "cs" as const, voiceNames: { "2": "Jana" } },
    transcript: "Mluvčí 1: Dobrý den.\nMluvčí 2: Pošlu to.",
    analysis: {
      summary: "Mluvčí 2 pošle nabídku.",
      tasks: [{ text: "Poslat nabídku", owner: "Mluvčí 2", due: null }],
    },
  };
  const named = namedMeetingRecord(record);
  assert.equal(named.transcript, "Mluvčí 1: Dobrý den.\nJana: Pošlu to.");
  assert.deepEqual(named.analysis, {
    summary: "Jana pošle nabídku.",
    tasks: [{ text: "Poslat nabídku", owner: "Jana", due: null }],
  });
  const notes = namedMeetingNotes(
    meetingNotes(named as never),
    cs,
    record.meeting,
  );
  assert.equal(notes.summary, "Jana pošle nabídku.");
});

test("a voice is taken for the person only when clearly theirs", () => {
  const profile = {
    model: "TEST/model",
    embedding: unit(1, 0.1),
    seconds: 60,
    meetingId: "TEST",
    createdAt: new Date().toISOString(),
  };
  const voices = { "1": unit(0.2, 1), "2": unit(1, 0.12), "3": unit(0.5, 1) };
  assert.equal(matchVoice(voices, profile, "TEST/model"), 2);
  // Another model's fingerprints never compare.
  assert.equal(matchVoice(voices, profile, "TEST/other"), undefined);
  // Too far from everyone, or two voices too close to tell apart.
  assert.equal(
    matchVoice({ "1": unit(0, 1) }, profile, "TEST/model"),
    undefined,
  );
  assert.equal(
    matchVoice(
      { "1": unit(1, 0.15), "2": unit(1, 0.05) },
      profile,
      "TEST/model",
    ),
    undefined,
  );
  assert.equal(matchVoice(undefined, profile, "TEST/model"), undefined);
});

test("the recognized speaker's turns become Me and the others are numbered without a gap", () => {
  const turns = [
    { speaker: "unknown" as const, start: 0, end: 4, text: "A" },
    { speaker: "unknown" as const, start: 4, end: 8, text: "B" },
    { speaker: "unknown" as const, start: 8, end: 12, text: "C" },
  ];
  const segments = [
    { start: 0, end: 4, speaker: 3 },
    { start: 4, end: 8, speaker: 1 },
    { start: 8, end: 12, speaker: 2 },
  ];
  assert.deepEqual(
    assignVoices(turns, { segments }, "unknown", 1).map((t) => [
      t.speaker,
      t.voice,
    ]),
    [
      ["unknown", 1],
      ["me", undefined],
      ["unknown", 2],
    ],
  );
});

test("a long turn splits at sentences where the diarized voice changes", () => {
  const text =
    "Dobrý den, vítám vás na dnešním jednání zastupitelstva obce. Prvním bodem je zadávací řízení na stavbu. Děkuji, mám k tomu dotaz ohledně termínu dokončení stavby. Odpovím hned po přestávce.";
  const turns = [{ speaker: "unknown" as const, start: 0, end: 40, text }];
  const segments = [
    { start: 0, end: 18, speaker: 1 },
    { start: 18, end: 31, speaker: 2 },
    { start: 31, end: 40, speaker: 1 },
  ];
  const voiced = assignVoices(turns, { segments }, "unknown");
  assert.deepEqual(
    voiced.map((t) => [t.voice, t.text.slice(0, 12)]),
    [
      [1, "Dobrý den, v"],
      [2, "Děkuji, mám "],
      [1, "Odpovím hned"],
    ],
  );
  assert.equal(voiced.map((t) => t.text).join(" "), text);
  assert.equal(voiced[0]!.start, 0);
  assert.equal(voiced.at(-1)!.end, 40);
});

async function fakeDiarizer(embeddings: Record<string, number[]>) {
  const requests: { path: string; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    requests.push({ path: request.url!, body });
    const value = request.url!.startsWith("/embed")
      ? { model: "TEST/model", seconds: 12, embedding: unit(1, 0.1) }
      : {
          model: "TEST/model",
          speakers: 2,
          segments: [
            { start: 0, end: 6, speaker: 1 },
            { start: 6, end: 19, speaker: 2 },
          ],
          ...(request.url!.includes("embeddings=1") ? { embeddings } : {}),
        };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function processOneTrack(
  processor: MeetingProcessor,
  store: MeetingStore,
) {
  const bytes = new Uint8Array(
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=20",
        "-ac",
        "1",
        "-f",
        "wav",
        "pipe:1",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const id = randomUUID();
  store.create(scope, {
    profile: MEETING_PROFILE,
    id,
    title: "TEST planning",
    recordedAt: "2026-10-20T08:00:00.000Z",
    language: "en",
    mimeType: "audio/wav",
    bytes: bytes.length,
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
        transcribe: async () => ({
          text: "Welcome. I will send the offer by Friday.",
          segments: [
            { start: 0, end: 6, text: "Welcome." },
            { start: 6, end: 19, text: "I will send the offer by Friday." },
          ],
          timed: true,
        }),
      },
      analyzer: {
        model: "TEST/model",
        consolidate: async () => ({
          summary: "Speaker 2 sends the offer.",
          summarySources: [{ segment: 0, quote: "Welcome." }],
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

test("This is me keeps the owner's voice, and the next meeting labels them Me", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-voices-test-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  const service = await fakeDiarizer({ "1": unit(0, 1), "2": unit(1, 0.12) });
  const processor = new MeetingProcessor(store, {
    retryDelaysMs: [1, 1],
    diarization: { enabled: true, url: service.url },
  });
  try {
    const first = await processOneTrack(processor, store);
    assert.equal(first.status, "ready");
    assert.equal(service.requests[0]!.path, "/diarize?maxSpeakers=20");
    assert.deepEqual(
      store.utterances(scope, first.id)!.utterances.map((t) => t.voice),
      [1, 2],
    );
    // Naming a voice changes only labels; marking one as the owner's moves "Me".
    store.setSpeaker(scope, first.id, { voice: 1, name: "Jana", self: false });
    let meeting = store.setSpeaker(scope, first.id, {
      voice: 2,
      name: null,
      self: true,
    });
    assert.deepEqual(meeting.voiceNames, { "1": "Jana" });
    assert.equal(meeting.selfVoice, 2);
    assert.equal(store.voiceProfiles.get(scope), undefined);
    // Remembering cuts the voice's turns from the sound and fingerprints them.
    await processor.rememberVoice(
      scope,
      first.id,
      2,
      AbortSignal.timeout(30000),
    );
    const enrol = service.requests.find((r) => r.path === "/embed")!;
    assert.equal(enrol.body.toString("ascii", 0, 4), "RIFF");
    assert(
      Math.abs(enrol.body.length - 13 * 32000) < 8192,
      `${enrol.body.length}`,
    );
    assert.equal(store.voiceProfiles.get(scope)!.meetingId, first.id);
    // Too little speech gives no fingerprint.
    await assert.rejects(
      processor.rememberVoice(scope, first.id, 1, AbortSignal.timeout(30000)),
      { code: "meeting_voice_too_short" },
    );
    const second = await processOneTrack(processor, store);
    assert.equal(second.status, "ready");
    assert.equal(
      service.requests.at(-1)!.path,
      "/diarize?maxSpeakers=20&embeddings=1",
    );
    assert.deepEqual(
      store
        .utterances(scope, second.id)!
        .utterances.map((t) => [t.speaker, t.voice]),
      [
        ["unknown", 1],
        ["me", undefined],
      ],
    );
    // Unmarking clears it; forgetting deletes the fingerprint.
    meeting = store.setSpeaker(scope, first.id, {
      voice: 2,
      name: null,
      self: false,
    });
    assert.equal(meeting.selfVoice, undefined);
    store.voiceProfiles.delete(scope);
    assert.equal(store.voiceProfiles.get(scope), undefined);
  } finally {
    await processor.close();
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
