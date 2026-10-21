import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import {
  MeetingProcessor,
  transientTranscriptionError,
  type MeetingProcessingAccess,
} from "../apps/server-identity/meeting-processing";
import {
  dropRepeatedPrefix,
  mergeUtterances,
  minuteSegments,
  speechSpan,
  stitchChunks,
  transcriptionPrompt,
  type MeetingChunkResult,
} from "../apps/server-identity/meeting-transcript";
import { SpeechQueue } from "../apps/fixture-server/speech-queue";
import { VoiceError } from "../apps/fixture-server/voice-media";
import { IntegrationError } from "../apps/server-integrations/transport";
import { transcribeMeetingChunk } from "../apps/server-integrations/transcription";
import { MEETING_PROFILE } from "../packages/protocol/meetings";
import {
  MeetingRecordSchema,
  validateMeetingSynthesis,
} from "../packages/protocol/meeting-record";
import {
  MEETING_QUOTE_FUZZY_CHARS,
  locateQuote,
  similarity,
} from "../packages/protocol/meeting-quotes";
import { resolveDateTime } from "../apps/server-plugins/datetime";
import { encodeWav } from "../packages/audio/analysis";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";

const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-pipeline-test-"));
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
async function seal(
  f: ReturnType<typeof fixture>,
  bytes: Uint8Array,
  extra: Partial<import("../packages/protocol/meetings").MeetingCreate> = {},
) {
  const id = randomUUID();
  f.store.create(scope, {
    profile: MEETING_PROFILE,
    id,
    title: "TEST planning",
    recordedAt: "2026-10-20T08:00:00.000Z",
    language: "cs",
    mimeType: "audio/wav",
    bytes: bytes.length,
    ...extra,
  });
  for (let at = 0; at < bytes.length; at += 262144)
    f.store.append(scope, id, at, bytes.slice(at, at + 262144));
  f.store.seal(scope, id, await f.store.hash(scope, id));
  return id;
}
function tone(seconds: number) {
  const samples = new Float32Array(16000 * seconds);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.2;
  return encodeWav(samples, 16000);
}
async function settled(f: ReturnType<typeof fixture>, id: string) {
  const until = Date.now() + 30000;
  for (;;) {
    const status = f.store.get(scope, id).status;
    if (["ready", "failed", "interrupted"].includes(status)) return status;
    assert(Date.now() < until, "TEST processing did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

test("speech queue: chat voice goes first and background work never takes the last slot", async () => {
  const queue = new SpeechQueue(2, 1);
  const order: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const job = (name: string, priority: "chat" | "background") => {
    const gate = deferred();
    gates.set(name, gate);
    return queue.run(priority, async () => {
      order.push(name);
      await gate.promise;
      return name;
    });
  };
  const meeting1 = job("meeting-1", "background");
  const meeting2 = job("meeting-2", "background");
  const meeting3 = job("meeting-3", "background");
  await new Promise((r) => setImmediate(r));
  // One background slot: the other meeting chunks wait; a chat request runs at once.
  assert.deepEqual(order, ["meeting-1"]);
  const chat1 = job("chat-1", "chat");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["meeting-1", "chat-1"]);
  // Both slots busy: a new chat request waits, and goes before the waiting meetings.
  const chat2 = job("chat-2", "chat");
  gates.get("meeting-1")!.resolve();
  await meeting1;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["meeting-1", "chat-1", "chat-2"]);
  gates.get("chat-1")!.resolve();
  gates.get("chat-2")!.resolve();
  await Promise.all([chat1, chat2]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order.slice(3), ["meeting-2"]);
  gates.get("meeting-2")!.resolve();
  await meeting2;
  await new Promise((r) => setImmediate(r));
  gates.get("meeting-3")!.resolve();
  assert.equal(await meeting3, "meeting-3");
  assert.deepEqual(queue.stats, {
    active: 0,
    activeBackground: 0,
    waitingChat: 0,
    waitingBackground: 0,
  });
  // A waiter that is cancelled leaves the queue without running.
  const holder = deferred();
  const busy = queue.run("background", () => holder.promise);
  const controller = new AbortController();
  const cancelled = queue.run(
    "background",
    async () => assert.fail("TEST cancelled work ran"),
    controller.signal,
  );
  controller.abort(new Error("TEST cancelled"));
  await assert.rejects(cancelled, /TEST cancelled/);
  holder.resolve();
  await busy;
  // Too many people dictating at once is still refused as busy.
  const tiny = new SpeechQueue(1, 1, 0);
  const hold = deferred();
  const running = tiny.run("chat", () => hold.promise);
  await assert.rejects(
    tiny.run("chat", async () => {}),
    (error: unknown) =>
      error instanceof VoiceError &&
      error.code === "voice_busy" &&
      error.status === 429,
  );
  hold.resolve();
  await running;
});

test("transient chunk failures are retried with backoff; permanent ones fail at once", async () => {
  assert(transientTranscriptionError(new VoiceError("voice_busy", 429)));
  assert(
    transientTranscriptionError(
      new IntegrationError("integration_timeout", 504),
    ),
  );
  assert(
    transientTranscriptionError(
      new IntegrationError("integration_rate_limited", 429),
    ),
  );
  assert(
    transientTranscriptionError(new VoiceError("voice_processing_failed", 503)),
  );
  assert(
    !transientTranscriptionError(new VoiceError("voice_model_limit", 503)),
  );
  assert(!transientTranscriptionError(new VoiceError("voice_empty")));
  assert(!transientTranscriptionError(new Error("TEST")));
  const f = fixture();
  const processor = new MeetingProcessor(f.store, { retryDelaysMs: [5, 5] });
  try {
    // Two meetings at once, both hitting a busy transcriber twice per minute.
    const ids = [await seal(f, tone(1)), await seal(f, tone(1))];
    const calls = new Map<string, number>();
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      transcriber: {
        transcribe: async (request, _signal, options) => {
          assert.equal(options?.priority, "background");
          const n = (calls.get(request.requestId) ?? 0) + 1;
          calls.set(request.requestId, n);
          if (n === 1) throw new VoiceError("voice_busy", 429);
          if (n === 2)
            throw new IntegrationError("integration_provider_unavailable", 503);
          return { text: "Pošlu nabídku.", reviewReasons: [] };
        },
      },
      analyzer: {
        model: "TEST",
        consolidate: async () => ({
          summary: "Nabídka",
          summarySources: [{ segment: 0, quote: "Pošlu nabídku." }],
          points: [],
          tasks: [],
          overflow: false,
        }),
      },
    };
    for (const id of ids) await processor.start(access, id, false);
    for (const id of ids) assert.equal(await settled(f, id), "ready");
    assert.deepEqual([...calls.values()], [3, 3]);
    // Three failures in a row fail the meeting visibly.
    const failing = await seal(f, tone(1));
    let attempts = 0;
    await processor.start(
      {
        ...access,
        transcriber: {
          transcribe: async () => {
            attempts++;
            throw new IntegrationError("integration_timeout", 504);
          },
        },
      },
      failing,
      false,
    );
    assert.equal(await settled(f, failing), "failed");
    assert.equal(attempts, 3);
    assert.equal(
      f.store.get(scope, failing).failure,
      "meeting_transcription_failed",
    );
  } finally {
    await processor.close();
    f.close();
  }
});

test("tolerant quotes: normalized and fuzzy quotes are repaired to the exact words; lost ones are dropped, never the meeting", () => {
  const minute0 =
    "Já: Pošlu vám „finální“ nabídku – nejpozději do pátku.\nOstatní: Dobře, a nezapomeňte na Šťastného.";
  const minute1 = "Ostatní: Kdo zajistí místnost na příští schůzku?";
  assert.equal(
    locateQuote(minute0, 'Pošlu vám "finální" nabídku - nejpozději do pátku.'),
    "Pošlu vám „finální“ nabídku – nejpozději do pátku.",
  );
  assert.equal(
    locateQuote(minute0, "já:   pošlu VÁM „finální“ nabídku"),
    "Pošlu vám „finální“ nabídku",
  );
  assert.equal(
    locateQuote(minute0, "Ostatní: Dobře, a nezapomeňte na Stastneho."),
    "Dobře, a nezapomeňte na Šťastného.",
  );
  // One misheard letter: the most similar window, with the original words.
  assert.equal(
    locateQuote(minute0, "nezapomeňte na Šťastnýho"),
    "nezapomeňte na Šťastného",
  );
  assert.equal(
    locateQuote(minute0, "Objednáme catering na sobotu."),
    undefined,
  );
  const input = {
    segments: [
      { index: 0, text: minute0 },
      { index: 1, text: minute1 },
    ],
    speakers: { self: "Já", others: "Ostatní" },
  };
  const result = validateMeetingSynthesis(
    {
      summary: "Nabídka do pátku a místnost na příští schůzku.",
      summarySources: [
        { segment: 0, quote: "Já: Pošlu vám „finální“ nabídku" },
        { segment: 0, quote: "Úplně vymyšlená věta o rozpočtu." },
      ],
      points: [
        {
          text: "Vymyšlený bod",
          sources: [{ segment: 1, quote: "Rozpočet je schválený." }],
        },
      ],
      decisions: [
        {
          text: "Nabídka půjde v pátek",
          // Cited from the wrong minute; found in the minute before.
          sources: [{ segment: 1, quote: "nejpozději do pátku" }],
        },
      ],
      tasks: [
        {
          text: "Poslat finální nabídku",
          owner: "me",
          due: "do pátku",
          dueWhen: { when: { kind: "next_weekday", weekday: 5 } },
          context: "Klient čeká na finální verzi.",
          sources: [
            {
              segment: 0,
              quote: 'Pošlu vám "finální" nabídku - nejpozději do pátku',
            },
            { segment: 0, quote: "Tohle nikdo neřekl." },
          ],
        },
        {
          text: "Zajistit místnost",
          owner: "Petr",
          due: "zítra",
          sources: [
            { segment: 1, quote: "Kdo zajistí místnost na příští schůzku?" },
          ],
        },
        {
          text: "Vymyšlený úkol",
          owner: null,
          due: null,
          sources: [{ segment: 0, quote: "Nic takového." }],
        },
      ],
      openQuestions: [
        {
          text: "Kdo zajistí místnost?",
          sources: [
            { segment: 1, quote: "Kdo zajistí místnost na příští schůzku" },
          ],
        },
      ],
      overflow: false,
    },
    input,
    {
      resolveDue: (due) => {
        const resolved = resolveDateTime(
          { when: due.when },
          {
            referenceNow: "2026-10-20T08:00:00.000Z",
            timeZone: "Europe/Prague",
          },
        );
        return resolved.status === "resolved"
          ? String(resolved.values.date)
          : null;
      },
    },
  );
  assert.deepEqual(result.summarySources, [
    { segment: 0, quote: "Pošlu vám „finální“ nabídku" },
  ]);
  assert.deepEqual(
    result.points,
    [],
    "an item without any source left is dropped",
  );
  assert.deepEqual(result.decisions, [
    {
      text: "Nabídka půjde v pátek",
      sources: [{ segment: 0, quote: "nejpozději do pátku" }],
      at: 0,
    },
  ]);
  assert.equal(result.tasks.length, 2);
  const [offer, room] = result.tasks;
  assert.deepEqual(offer!.sources, [
    { segment: 0, quote: "Pošlu vám „finální“ nabídku – nejpozději do pátku" },
  ]);
  assert.equal(offer!.owner, "me");
  assert.equal(offer!.assignee, null);
  assert.equal(offer!.due, "do pátku");
  // Tuesday 20 October 2026: the next Friday.
  assert.equal(offer!.dueDate, "2026-10-23");
  assert.equal(offer!.context, "Klient čeká na finální verzi.");
  // Neither the owner nor the deadline was said in its quote.
  assert.equal(room!.owner, null);
  assert.equal(room!.due, null);
  assert.equal(room!.dueDate, null);
  assert.equal(room!.at, 60);
  assert.equal(result.openQuestions!.length, 1);
  assert.equal(
    result.openQuestions![0]!.sources[0]!.quote,
    "Kdo zajistí místnost na příští schůzku",
  );
});

test("fuzzy quotes are bounded: long or hostile quotes never block the server", () => {
  // The banded distance agrees with the full one wherever it can matter.
  assert.equal(similarity("abcdefghij", "abcdefghij"), 1);
  assert.equal(similarity("abcdefghij", "abcdefghix"), 0.9);
  assert.equal(similarity("abcdefghij", "abcdefghix", 0.85), 0.9);
  assert.equal(similarity("abcdefghij", "abcdefgxyz", 0.85), 0);
  assert.equal(similarity("abcdefghij", "abcdefgxyz"), 0.7);
  assert.equal(similarity("kitten sitting", "sitting kitten", 0.85), 0);
  // A quote past the fuzzy limit is still found when it is exact.
  const words =
    "pošlu vám finální nabídku do pátku a potom probereme rozpočet s týmem obchodu".split(
      " ",
    );
  const text = (seed: number, n: number) =>
    Array.from(
      { length: n },
      (_, i) => words[(i * 7 + seed) % words.length],
    ).join(" ");
  const minute = text(0, 600).slice(0, 4000);
  const long = minute.slice(0, MEETING_QUOTE_FUZZY_CHARS + 100);
  assert.equal(locateQuote(minute, long.toUpperCase()), long);
  // Fake quotes filling the model's whole output, each sharing the minute's
  // words: once ten seconds of matching, now well under one.
  const segments = Array.from({ length: 120 }, (_, index) => ({
    index,
    text: text(index, 600).slice(0, 4000),
  }));
  const quote = (i: number) => text(i * 3, 180) + " xyzzy";
  const started = performance.now();
  const result = validateMeetingSynthesis(
    {
      summary: "Shrnutí",
      summarySources: [{ segment: 0, quote: text(0, 5) }],
      points: [],
      tasks: Array.from({ length: 10 }, (_, t) => ({
        text: `Úkol ${t}`,
        owner: null,
        due: null,
        sources: Array.from({ length: 8 }, (_, s) => ({
          segment: (t * 8 + s) % 120,
          quote: quote(t * 8 + s),
        })),
      })),
      overflow: false,
    },
    { segments },
  );
  assert(performance.now() - started < 3000);
  assert.deepEqual(result.tasks, []);
});

test("chunks stitch by timestamps: the overlap is heard once", () => {
  const chunks: MeetingChunkResult[] = [
    {
      start: 0,
      end: 120,
      speaker: "unknown",
      timed: true,
      text: "",
      segments: [
        { start: 1, end: 5, text: "Dobrý den, začneme." },
        { start: 116, end: 120, text: "Rozpočet pošlu zítra" },
      ],
    },
    {
      start: 118,
      end: 240,
      speaker: "unknown",
      timed: true,
      text: "",
      segments: [
        // Heard again in the overlap.
        { start: 118, end: 119.9, text: "pošlu zítra" },
        // Straddles the boundary: its repeated words are dropped.
        { start: 118.5, end: 124, text: "pošlu zítra ráno a pak zavolám." },
        { start: 236.5, end: 239.5, text: "Další bod." },
      ],
      words: [
        { word: "pošlu", start: 118.5, end: 119 },
        { word: "zítra", start: 119, end: 119.8 },
        { word: "ráno", start: 120.1, end: 120.6 },
        { word: "a", start: 120.7, end: 120.8 },
        { word: "pak", start: 120.9, end: 121.2 },
        { word: "zavolám.", start: 121.3, end: 124 },
      ],
    },
    {
      // A provider without timestamps: text only, deduplicated by words.
      start: 238,
      end: 300,
      speaker: "unknown",
      timed: false,
      text: "Další bod. Hotovo, děkuji.",
      segments: [],
    },
  ];
  const turns = stitchChunks(chunks);
  assert.deepEqual(
    turns.map((t) => t.text),
    [
      "Dobrý den, začneme.",
      "Rozpočet pošlu zítra",
      "ráno a pak zavolám.",
      "Další bod.",
      "Hotovo, děkuji.",
    ],
  );
  assert.equal(turns[2]!.start, 120.1);
  assert.equal(turns[4]!.start, 240);
  assert.equal(dropRepeatedPrefix("a pak zavolám", "zavolám zítra"), "zítra");
  assert.equal(dropRepeatedPrefix("je to tak", "a to je vše"), "a to je vše");
  // Digital silence at either end of a chunk is not sent.
  const samples = new Float32Array(16000 * 180);
  for (let i = 16000 * 70; i < 16000 * 80; i++) samples[i] = 0.1;
  assert.deepEqual(speechSpan(samples), { from: 16000 * 60, to: 16000 * 120 });
  assert.equal(speechSpan(new Float32Array(16000 * 90)), undefined);
  assert.equal(
    transcriptionPrompt({
      title: "Nabídka Acme",
      attendees: ["Jana Nováková"],
      companies: ["Acme s.r.o."],
      glossary: ["Niaro"],
      previous: "x".repeat(300) + " konec věty",
    }),
    `Nabídka Acme. Jana Nováková. Acme s.r.o.. Niaro\n${("x".repeat(300) + " konec věty").slice(-200)}`,
  );
});

test("two-track turns are merged in the order they started; minute segments keep speaker lines", () => {
  const me = stitchChunks([
    {
      start: 0,
      end: 130,
      speaker: "me",
      timed: true,
      text: "",
      segments: [
        { start: 2, end: 6, text: "Dobrý den." },
        { start: 20, end: 25, text: "Pošlu nabídku." },
        { start: 70, end: 72, text: "Platí." },
      ],
    },
  ]);
  const others = stitchChunks([
    {
      start: 0,
      end: 130,
      speaker: "others",
      timed: true,
      text: "",
      segments: [
        { start: 7, end: 12, text: "Dobrý den, máme otázku." },
        { start: 26, end: 30, text: "Do kdy?" },
      ],
    },
  ]);
  const turns = mergeUtterances(me, others);
  assert.deepEqual(
    turns.map((t) => [t.speaker, t.start, t.text]),
    [
      ["me", 2, "Dobrý den."],
      ["others", 7, "Dobrý den, máme otázku."],
      ["me", 20, "Pošlu nabídku."],
      ["others", 26, "Do kdy?"],
      ["me", 70, "Platí."],
    ],
  );
  const minutes = minuteSegments(turns, 75, {
    language: "cs",
    twoTrack: true,
    transcriber: "TEST/STT",
  });
  assert.equal(minutes.length, 2);
  assert.equal(
    minutes[0]!.text,
    "Já: Dobrý den.\nOstatní: Dobrý den, máme otázku.\nJá: Pošlu nabídku.\nOstatní: Do kdy?",
  );
  assert.equal(minutes[1]!.text, "Já: Platí.");
  assert.equal(minutes[1]!.endSeconds, 75);
});

test("timestamped pipeline: chunks with overlap, utterances, structured notes with resolved deadlines, and a checkpoint before validation", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store, {
    chunkSeconds: 120,
    retryDelaysMs: [1, 1],
    glossary: ["Niaro"],
  });
  try {
    const id = await seal(f, tone(250), {
      attendees: ["Jana Nováková"],
      companies: ["Acme"],
    });
    const requests: { id: string; prompt: string; format: string }[] = [];
    let modelCalls = 0;
    let limited = false;
    const replies: Record<
      number,
      { start: number; end: number; text: string }[]
    > = {
      0: [
        { start: 1, end: 4, text: "Dobrý den, jsme tu kvůli nabídce." },
        { start: 116, end: 120, text: "Nabídku pošlu do pátku." },
      ],
      // The chunk starts two seconds early: its first segment is the overlap.
      1: [
        { start: 0, end: 2, text: "do pátku." },
        { start: 10, end: 14, text: "Kdo zajistí místnost?" },
      ],
      2: [{ start: 5, end: 9, text: "Děkuji, končíme." }],
    };
    const draft = {
      summary: "Nabídka půjde do pátku.",
      summarySources: [{ segment: 1, quote: "nabídku pošlu do pátku" }],
      points: [],
      decisions: [
        {
          text: "Nabídka do pátku",
          sources: [{ segment: 1, quote: "Nabídku pošlu do pátku." }],
        },
      ],
      tasks: [
        {
          text: "Poslat nabídku",
          owner: "me",
          due: "do pátku",
          dueWhen: { when: { kind: "next_weekday", weekday: 5 } },
          context: "Acme čeká na nabídku.",
          // Inexact: repaired, never failing the meeting.
          sources: [{ segment: 1, quote: "Nabídku pošlu – do pátku" }],
        },
      ],
      openQuestions: [
        {
          text: "Kdo zajistí místnost?",
          sources: [{ segment: 2, quote: "Kdo zajistí místnost?" }],
        },
      ],
      overflow: false,
    };
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      timeZone: "Europe/Prague",
      meetingTranscriber: {
        model: "TEST/gpt-transcribe",
        transcribe: async (input) => {
          requests.push({
            id: input.requestId,
            prompt: input.prompt,
            format: input.format,
          });
          assert(input.audio.length > 1000);
          const index = Number(input.requestId.split("-").at(-2));
          if (index === 2 && !limited) {
            limited = true;
            throw new IntegrationError("integration_rate_limited", 429);
          }
          return {
            text: replies[index]!.map((s) => s.text).join(" "),
            language: "cs",
            segments: replies[index]!,
            timed: true,
          };
        },
      },
      analyzer: {
        model: "TEST/model",
        consolidate: async (input) => {
          modelCalls++;
          assert.equal(input.meeting?.date, "2026-10-20");
          assert.equal(input.meeting?.weekday, 2);
          assert.deepEqual(input.meeting?.attendees, ["Jana Nováková"]);
          return draft;
        },
      },
    };
    await processor.start(access, id, false);
    assert.equal(
      await settled(f, id),
      "ready",
      String(f.store.get(scope, id).failure),
    );
    // Three chunks, one retried after a rate limit.
    assert.equal(requests.length, 4);
    assert(requests.every((r) => r.format === "flac"));
    assert(requests[0]!.prompt.includes("TEST planning"));
    assert(requests[0]!.prompt.includes("Jana Nováková"));
    assert(requests[0]!.prompt.includes("Acme"));
    assert(requests[0]!.prompt.includes("Niaro"));
    const record = f.store.record(scope, id);
    assert.equal(record.profile, "niaro-meeting-record/2");
    assert(record.transcriptComplete);
    assert.equal(record.detectedLanguage, "cs");
    assert.deepEqual(
      record.utterances!.map((u) => [u.start, u.speaker, u.text]),
      [
        [1, "unknown", "Dobrý den, jsme tu kvůli nabídce."],
        [116, "unknown", "Nabídku pošlu do pátku."],
        [128, "unknown", "Kdo zajistí místnost?"],
        [243, "unknown", "Děkuji, končíme."],
      ],
    );
    // Minute segments stay for older readers and quotes.
    assert.equal(record.meeting.completedSegments, 5);
    assert.equal(
      f.store.segment(scope, id, 1)!.text,
      "Nabídku pošlu do pátku.",
    );
    const analysis = record.analysis!;
    assert.equal(analysis.version, 2);
    assert.equal(analysis.decisions!.length, 1);
    assert.equal(analysis.decisions![0]!.at, 116);
    const task = analysis.tasks[0]!;
    assert.deepEqual(task.sources, [
      { segment: 1, quote: "Nabídku pošlu do pátku" },
    ]);
    assert.equal(task.owner, "me");
    assert.equal(task.dueDate, "2026-10-23");
    assert.equal(task.at, 116);
    assert.equal(analysis.openQuestions![0]!.at, 128);
    // The model's draft was saved as it came, before validation.
    const saved = f.db
      .prepare("SELECT value FROM niaro_meeting_synthesis WHERE id=?")
      .get(id)!;
    assert.deepEqual(JSON.parse(String(saved.value)), draft);
    assert.equal(modelCalls, 1);
    const human = f.store.humanTasks.get(scope, record.humanTaskIds[0]!);
    assert.equal(human.dueDate, "2026-10-23");
    assert.equal(human.assignee, null);
    assert.match(
      human.detail,
      /^Acme čeká na nabídku\.\nZe schůzky „TEST planning“ \(20\. 10\. 2026\)\.$/u,
    );
    // Chunk checkpoints are folded into the transcript once it is saved.
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM niaro_meeting_chunk").get()!.n,
      0,
    );
  } finally {
    await processor.close();
    f.close();
  }
});

test("chunks decode only once they hold a queue slot, and a retry keeps the chunk size the meeting started with", async () => {
  const f = fixture();
  // Every ffmpeg run is logged before it runs, so the test sees when a chunk
  // is decoded (`-ss`) against when it entered the speech queue.
  const bin = join(f.root, "bin");
  const log = join(f.root, "ffmpeg.log");
  execFileSync("mkdir", [bin]);
  writeFileSync(
    join(bin, "ffmpeg"),
    `#!/bin/sh\necho "$*" >> '${log}'\nexec ${execFileSync("sh", ["-c", "command -v ffmpeg"]).toString().trim()} "$@"\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const decodes = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.includes(" -ss ")).length
      : 0;
  const queue = new SpeechQueue(2, 1);
  const first = new MeetingProcessor(f.store, {
    chunkSeconds: 120,
    retryDelaysMs: [],
    parallel: 3,
    queue,
  });
  const second = new MeetingProcessor(f.store, {
    chunkSeconds: 300,
    retryDelaysMs: [],
    queue,
  });
  try {
    const id = await seal(f, tone(250));
    const requests: string[] = [];
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => fn(),
      meetingTranscriber: {
        model: "TEST/gpt-transcribe",
        transcribe: async (input) => {
          requests.push(input.requestId);
          // The first processor's last chunk fails for good.
          if (requests.length === 3)
            throw new IntegrationError("integration_cancelled", 400);
          return {
            text: "Pošlu nabídku.",
            language: "cs",
            segments: [{ start: 1, end: 3, text: "Pošlu nabídku." }],
            timed: true,
          };
        },
      },
      analyzer: {
        model: "TEST/model",
        consolidate: async () => ({
          summary: "Nabídka",
          summarySources: [{ segment: 0, quote: "Pošlu nabídku." }],
          points: [],
          tasks: [],
          overflow: false,
        }),
      },
    };
    // Chat holds the only background slot: the meeting's three chunks wait
    // for it without having decoded any sound yet.
    const chat = deferred();
    const busy = queue.run("background", () => chat.promise);
    await first.start(access, id, false);
    for (let i = 0; queue.stats.waitingBackground < 3; i++) {
      assert(i < 500, "TEST chunks never queued");
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(decodes(), 0);
    chat.resolve();
    await busy;
    assert.equal(await settled(f, id), "failed");
    assert.equal(decodes(), 3);
    // A smaller chunk size since: the retry still cuts 120 s chunks, so the
    // two saved ones are not paid for again.
    await second.start(access, id, true);
    assert.equal(await settled(f, id), "ready");
    assert.deepEqual(
      requests.map((r) => r.slice(`meeting-${id}`.length)),
      ["-120-0-unknown", "-120-1-unknown", "-120-2-unknown", "-120-2-unknown"],
    );
  } finally {
    process.env.PATH = path;
    await first.close();
    await second.close();
    f.close();
  }
});

test("a two-track recording is transcribed per channel with timestamps and merged into me/others turns", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store, { retryDelaysMs: [1, 1] });
  try {
    const wav = new Uint8Array(
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
    const id = await seal(f, wav, { speakerChannels: "self-others" });
    const speakers: string[] = [];
    await processor.start(
      {
        scope,
        run: async (fn) => fn(),
        failure: async (fn) => fn(),
        meetingTranscriber: {
          model: "TEST/STT",
          transcribe: async (input) => {
            const speaker = input.requestId.split("-").at(-1)!;
            speakers.push(speaker);
            return speaker === "me"
              ? {
                  text: "Pošlu nabídku. Platí.",
                  segments: [
                    { start: 1, end: 3, text: "Pošlu nabídku." },
                    { start: 12, end: 13, text: "Platí." },
                  ],
                  timed: true,
                }
              : {
                  text: "Do kdy?",
                  segments: [{ start: 5, end: 6, text: "Do kdy?" }],
                  timed: true,
                };
          },
        },
        analyzer: {
          model: "TEST/model",
          consolidate: async () => ({
            summary: "Nabídka.",
            summarySources: [{ segment: 0, quote: "Já: Pošlu nabídku." }],
            points: [],
            tasks: [],
            overflow: false,
          }),
        },
      },
      id,
      false,
    );
    assert.equal(await settled(f, id), "ready");
    assert.deepEqual(speakers.sort(), ["me", "others"]);
    const record = f.store.record(scope, id);
    assert.deepEqual(
      record.utterances!.map((u) => [u.speaker, u.start, u.text]),
      [
        ["me", 1, "Pošlu nabídku."],
        ["others", 5, "Do kdy?"],
        ["me", 12, "Platí."],
      ],
    );
    assert.equal(
      f.store.segment(scope, id, 0)!.text,
      "Já: Pošlu nabídku.\nOstatní: Do kdy?\nJá: Platí.",
    );
    // The speaker label a model copies into a quote is stripped.
    assert.deepEqual(record.analysis!.summarySources, [
      { segment: 0, quote: "Pošlu nabídku." },
    ]);
  } finally {
    await processor.close();
    f.close();
  }
});

test("OpenRouter chunk request: verbose_json with privacy flags; an unsupported prompt or timestamps fall back", async () => {
  const bodies: Record<string, unknown>[] = [];
  const statuses = [400, 400, 404, 200];
  const selected = {
    key: "TEST-key",
    provider: {
      id: randomUUID(),
      revision: 1,
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1",
      enabled: true,
      dailyRequestLimit: 100,
      hasCredential: true,
      requestsToday: 0,
    },
    model: {
      id: randomUUID(),
      revision: 1,
      providerId: "",
      name: "STT",
      model: "openai/gpt-4o-transcribe",
      enabled: true,
      tools: false,
      audioInput: false,
      audioOutput: false,
      kind: "transcription" as const,
    },
  };
  const result = await transcribeMeetingChunk(
    async (request) => {
      bodies.push(request.body as Record<string, unknown>);
      assert.equal(
        request.url,
        "https://openrouter.ai/api/v1/audio/transcriptions",
      );
      assert.equal(request.timeoutMs, 60000);
      const status = statuses.shift()!;
      return {
        status,
        headers: {},
        text: status === 200 ? JSON.stringify({ text: "Ahoj." }) : "{}",
      };
    },
    selected,
    { data: Buffer.from("TEST-audio"), format: "flac" },
    "Acme. Niaro",
    new AbortController().signal,
    async (start) => start(),
  );
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies[0]!.provider, { zdr: true, data_collection: "deny" });
  assert.equal(bodies[0]!.response_format, "verbose_json");
  assert.equal(bodies[0]!.prompt, "Acme. Niaro");
  assert.equal(bodies[1]!.prompt, undefined);
  assert.equal(bodies[1]!.response_format, "verbose_json");
  assert.equal(bodies[2]!.response_format, undefined);
  assert.deepEqual(bodies[2]!.provider, { zdr: true, data_collection: "deny" });
  // Last: the plain request chat voice sends to the same model.
  assert.equal(bodies[3]!.provider, undefined);
  assert.equal(bodies[3]!.response_format, undefined);
  assert.deepEqual(result, { text: "Ahoj.", segments: [], timed: false });
  // A refusal of every request carries the provider's own message.
  await assert.rejects(
    transcribeMeetingChunk(
      async () => ({
        status: 400,
        headers: {},
        text: JSON.stringify({ error: { message: "Unsupported field" } }),
      }),
      selected,
      { data: Buffer.from("TEST-audio"), format: "flac" },
      "",
      new AbortController().signal,
      async (start) => start(),
    ),
    (error: unknown) =>
      (error as { failure?: { message?: string } }).failure?.message ===
      "Unsupported field",
  );
  await assert.rejects(
    transcribeMeetingChunk(
      async () => ({ status: 429, headers: {}, text: "{}" }),
      selected,
      { data: Buffer.from("TEST-audio"), format: "flac" },
      "",
      new AbortController().signal,
      async (start) => start(),
    ),
    (error: unknown) => transientTranscriptionError(error),
  );
});

test("audio retention: a daily sweep deletes old sound of ready meetings, keeps transcripts and frees the byte cap", async () => {
  const f = fixture();
  try {
    const old = await seal(f, tone(1));
    const fresh = await seal(f, tone(1));
    const sealed = await seal(f, tone(1));
    for (const id of [old, fresh]) {
      f.store.update(scope, id, { durationSeconds: 1 });
      f.store.putSegment(scope, id, {
        index: 0,
        startSeconds: 0,
        endSeconds: 1,
        text: "Pošlu nabídku.",
        reviewReasons: [],
        transcriber: "TEST",
        analyzer: null,
        analysis: null,
      });
      f.store.publishRecord(
        scope,
        id,
        {
          summary: "Nabídka.",
          summarySources: [{ segment: 0, quote: "Pošlu nabídku." }],
          points: [],
          tasks: [],
          overflow: false,
        },
        "TEST",
      );
    }
    const now = Date.now();
    // Ready 40 days ago; renamed since, which does not restart the clock.
    const row = f.db
      .prepare("SELECT value FROM niaro_meeting_record WHERE id=?")
      .get(old)!;
    f.db.prepare("UPDATE niaro_meeting_record SET value=? WHERE id=?").run(
      JSON.stringify({
        ...JSON.parse(String(row.value)),
        publishedAt: new Date(now - 40 * 86400000).toISOString(),
      }),
      old,
    );
    f.store.update(scope, old, { title: "TEST renamed" });
    assert.equal(f.store.sweepAudio(0, now), 0, "0 keeps sound forever");
    assert.equal(f.store.sweepAudio(30, now), 1);
    const swept = f.store.get(scope, old);
    assert(swept.audioDeletedAt);
    assert(!existsSync(f.store.path(swept)));
    assert.equal(f.store.record(scope, old).transcript, "Pošlu nabídku.");
    assert.equal(f.store.record(scope, old).analysis!.summary, "Nabídka.");
    assert(existsSync(f.store.path(f.store.get(scope, fresh))));
    assert(existsSync(f.store.path(f.store.get(scope, sealed))));
    assert.equal(f.store.sweepAudio(30, now), 0, "idempotent");
    // Deleted sound no longer counts toward the 512 MiB per-person cap.
    const big = 60 * 1024 * 1024;
    const filled = [];
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      f.store.create(scope, {
        profile: MEETING_PROFILE,
        id,
        title: "TEST big",
        recordedAt: new Date().toISOString(),
        language: "cs",
        mimeType: "audio/wav",
        bytes: big,
      });
      filled.push(id);
    }
    const create = () =>
      f.store.create(scope, {
        profile: MEETING_PROFILE,
        id: randomUUID(),
        title: "TEST big",
        recordedAt: new Date().toISOString(),
        language: "cs",
        mimeType: "audio/wav",
        bytes: big,
      });
    assert.throws(create, /meeting_storage_limit/);
    for (const id of filled.slice(0, 2)) {
      const value = JSON.parse(
        String(
          f.db.prepare("SELECT value FROM niaro_meeting WHERE id=?").get(id)!
            .value,
        ),
      );
      f.db.prepare("UPDATE niaro_meeting SET value=? WHERE id=?").run(
        JSON.stringify({
          ...value,
          audioDeletedAt: new Date().toISOString(),
        }),
        id,
      );
    }
    create();
    // Without its sound, a meeting with an incomplete transcript cannot be processed.
    const processor = new MeetingProcessor(f.store);
    try {
      const value = JSON.parse(
        String(
          f.db
            .prepare("SELECT value FROM niaro_meeting WHERE id=?")
            .get(sealed)!.value,
        ),
      );
      f.db.prepare("UPDATE niaro_meeting SET value=? WHERE id=?").run(
        JSON.stringify({
          ...value,
          audioDeletedAt: new Date().toISOString(),
        }),
        sealed,
      );
      await assert.rejects(
        processor.start(
          {
            scope,
            run: async (fn) => fn(),
            failure: async (fn) => fn(),
            transcriber: { transcribe: async () => "" },
            analyzer: { model: "TEST", consolidate: async () => ({}) },
          },
          sealed,
          false,
        ),
        /meeting_audio_deleted/,
      );
    } finally {
      await processor.close();
    }
  } finally {
    f.close();
  }
});

test("older records still read: a v1 analysis without the new fields and a /1 record", async () => {
  const f = fixture();
  try {
    const id = await seal(f, tone(1));
    f.store.update(scope, id, { durationSeconds: 1, status: "ready" });
    f.store.putSegment(scope, id, {
      index: 0,
      startSeconds: 0,
      endSeconds: 1,
      text: "Anna pošle nabídku v pátek.",
      reviewReasons: [],
      transcriber: "TEST",
      analyzer: null,
      analysis: null,
    });
    const transcriptDigest = f.store.record(scope, id).transcriptDigest;
    // Written by the previous version: no version, decisions, owners or times.
    const analysis = {
      summary: "Nabídka.",
      summarySources: [{ segment: 0, quote: "Anna pošle nabídku" }],
      points: [
        {
          text: "Pátek",
          sources: [{ segment: 0, quote: "v pátek" }],
        },
      ],
      tasks: [
        {
          text: "Připomenout nabídku",
          assignee: "Anna",
          due: "v pátek",
          sources: [{ segment: 0, quote: "Anna pošle nabídku v pátek." }],
        },
      ],
      overflow: false,
    };
    f.db.prepare("INSERT INTO niaro_meeting_record VALUES (?,?)").run(
      id,
      JSON.stringify({
        analysis,
        analyzer: "TEST",
        recordDigest: "c".repeat(64),
        transcriptDigest,
        sourceHash: f.store.get(scope, id).sourceHash,
        humanTaskIds: [],
      }),
    );
    const record = f.store.record(scope, id);
    assert.deepEqual(record.analysis, analysis);
    assert.equal(record.utterances, undefined);
    // A record served by an older server still parses.
    assert.equal(
      MeetingRecordSchema.parse({
        ...meetingRecordFixture,
        profile: "niaro-meeting-record/1",
      }).profile,
      "niaro-meeting-record/1",
    );
  } finally {
    f.close();
  }
});

test("a five-minute reply without timestamps keeps every word, spread over its minutes", () => {
  const text = Array.from(
    { length: 200 },
    (_, i) => `Bod číslo ${i + 1} jsme probrali a odsouhlasili.`,
  ).join(" ");
  assert.ok(text.length > 7000);
  const turns = stitchChunks([
    { start: 0, end: 300, speaker: "me", timed: false, text, segments: [] },
  ]);
  assert.equal(
    turns.map((turn) => turn.text).join(" "),
    text,
    "nothing is cut off",
  );
  assert.ok(turns.every((turn) => turn.text.length <= 600));
  assert.equal(turns[0]!.start, 0);
  assert.ok(turns.at(-1)!.start > 240, "times grow through the chunk");
  // A two-track minute stays within its limit instead of failing.
  const minutes = minuteSegments(turns, 300, {
    language: "cs",
    twoTrack: true,
    transcriber: "TEST/STT",
  });
  assert.equal(minutes.length, 5);
  assert.ok(minutes.every((minute) => minute.text.length <= 4000));
});
