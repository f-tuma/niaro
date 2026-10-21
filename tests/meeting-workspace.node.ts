import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import {
  meetingAudioRoute,
  meetingRoute,
} from "../apps/server-identity/meeting-http";
import {
  MEETING_DATA_NOTE,
  MEETING_READ_CHARS,
  meetingAgentAccess,
} from "../apps/server-identity/meeting-agent";
import { IdentityError } from "../apps/server-identity/error";
import {
  MEETING_PROFILE,
  type MeetingCreate,
} from "../packages/protocol/meetings";
import { mobileHttpChildFixture } from "./helpers/process-mobile-http-child";
import { ClientSession } from "../packages/client-core/session";

const owner = {
  connectionId: "TEST-connection",
  serverId: "TEST-server",
  workspaceId: "TEST-workspace",
  userId: "TEST-owner",
};
const stranger = { ...owner, userId: "TEST-stranger" };
const AUDIO = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "niaro-meeting-workspace-"));
  const db = new DatabaseSync(":memory:");
  const store = new MeetingStore(db, join(directory, "audio"));
  return {
    store,
    db,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const input = (patch: Partial<MeetingCreate> = {}): MeetingCreate => ({
  profile: MEETING_PROFILE,
  id: randomUUID(),
  title: "TEST porada obchodu",
  recordedAt: "2026-10-08T10:00:00.000Z",
  language: "cs",
  mimeType: "audio/mp4",
  bytes: AUDIO.length,
  ...patch,
});
/** A sealed, ready meeting with a transcript, a summary and two tasks. */
async function readyMeeting(
  store: MeetingStore,
  db: DatabaseSync,
  patch: Partial<MeetingCreate> = {},
  minutes: string[] = [
    "Úvod a přivítání.",
    "Domluvili jsme ceník pro pana Šťastného do pátku.",
  ],
) {
  const meeting = store.create(owner, input(patch));
  store.append(owner, meeting.id, 0, AUDIO);
  store.seal(owner, meeting.id, await store.hash(owner, meeting.id));
  minutes.forEach((text, index) =>
    store.putSegment(owner, meeting.id, {
      index,
      startSeconds: index * 60,
      endSeconds: (index + 1) * 60,
      text,
      reviewReasons: [],
      transcriber: "TEST",
      analyzer: null,
      analysis: null,
    }),
  );
  store.update(owner, meeting.id, {
    durationSeconds: minutes.length * 60,
    status: "ready",
  });
  const prior = store.record(owner, meeting.id);
  const quote = minutes.at(-1)!.slice(-40).trim();
  const analysis = {
    summary: "Probrali jsme rozpočet a ceník.",
    summarySources: [{ segment: minutes.length - 1, quote }],
    points: [],
    tasks: [
      {
        text: "Poslat ceník",
        assignee: null,
        due: "pátek",
        sources: [{ segment: minutes.length - 1, quote }],
      },
      {
        text: "Domluvit další schůzku",
        assignee: null,
        due: null,
        sources: [{ segment: minutes.length - 1, quote }],
      },
    ],
    overflow: false,
  };
  const humanTaskIds = analysis.tasks.map((task, index) =>
    store.humanTasks.create(
      owner,
      `meeting:${meeting.id}:${index}`,
      { title: task.text, detail: "", assignee: null, due: task.due },
      {
        kind: "meeting",
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        recordDigest: "c".repeat(64),
        sources: task.sources,
      },
    ),
  );
  db.prepare("INSERT INTO niaro_meeting_record VALUES (?,?)").run(
    meeting.id,
    JSON.stringify({
      analysis,
      analyzer: "TEST",
      recordDigest: "c".repeat(64),
      transcriptDigest: prior.transcriptDigest,
      sourceHash: prior.meeting.sourceHash,
      humanTaskIds: humanTaskIds.map((task) => task.id),
    }),
  );
  return store.get(owner, meeting.id);
}

test("a meeting keeps the consent the client sent; only its owner renames it", () => {
  const f = fixture();
  try {
    const consent = { at: "2026-10-08T09:59:00.000Z", by: "TEST-owner" };
    const meeting = f.store.create(owner, input({ consent }));
    assert.deepEqual(f.store.get(owner, meeting.id).consent, consent);
    // An older client sends none; nothing is invented.
    const older = f.store.create(owner, input());
    assert.equal(f.store.get(owner, older.id).consent, undefined);
    assert.throws(
      () => f.store.rename(stranger, meeting.id, "TEST cizí"),
      (error: IdentityError) => error.code === "meeting_not_found",
    );
    assert.equal(
      f.store.rename(owner, meeting.id, "  TEST Nabídka Novák ").title,
      "TEST Nabídka Novák",
    );
    assert.equal(f.store.get(owner, meeting.id).title, "TEST Nabídka Novák");
  } finally {
    f.close();
  }
});

test("search finds names, summaries and transcripts without case or accents, per owner and date", async () => {
  const f = fixture();
  try {
    const meeting = await readyMeeting(f.store, f.db);
    const hit = (q: string, scope = owner) =>
      f.store.search(scope, q).map((h) => [h.meeting.id, h.field, h.at]);
    assert.deepEqual(hit("PORADA"), [[meeting.id, "title", null]]);
    assert.deepEqual(hit("rozpocet"), [[meeting.id, "summary", null]]);
    const [transcript] = f.store.search(owner, "stastneho");
    assert.equal(transcript?.field, "transcript");
    assert.equal(transcript?.at, 60);
    assert.match(transcript!.snippet, /Šťastného/);
    assert.deepEqual(hit("50%_"), []);
    assert.deepEqual(hit("ceník", stranger), []);
    assert.deepEqual(
      f.store.search(owner, "ceník", { from: "2026-10-09T00:00:00.000Z" }),
      [],
    );
    assert.equal(f.store.search(owner, "ceník", { limit: 1 }).length, 1);
  } finally {
    f.close();
  }
});

test("open tasks count only what is still open; the overview shows the next one", async () => {
  const f = fixture();
  try {
    const meeting = await readyMeeting(f.store, f.db);
    f.store.humanTasks.close(owner, `meeting:${meeting.id}:0`, "TEST done");
    assert.deepEqual(f.store.openTasks(owner).get(meeting.id), {
      count: 1,
      next: "Domluvit další schůzku",
    });
    const [recent] = f.store.recent(owner, 4);
    assert.equal(recent?.tasks, 1);
    assert.equal(recent?.next, "Domluvit další schůzku");
    assert.equal(recent?.summary, "Probrali jsme rozpočet a ceník.");
    f.store.humanTasks.close(owner, `meeting:${meeting.id}:1`, "TEST done");
    const [done] = f.store.recent(owner, 4);
    assert.equal(done?.tasks, 0);
    assert.equal("next" in done!, false);
  } finally {
    f.close();
  }
});

/** A request as meetingRoute reads it: method, headers and a body. */
function request(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const stream = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage;
  Object.assign(stream, { method, headers });
  return stream;
}
function access(store: MeetingStore, scope = owner) {
  return {
    store,
    processor: {
      start: async () => {
        throw new Error("TEST processing must not start");
      },
    },
    runtime: {
      session: { scope },
      run: async <T>(fn: () => T) => fn(),
    },
    failure: async <T>(fn: () => T) => fn(),
  } as unknown as Parameters<typeof meetingRoute>[3];
}
async function bodyOf(stream: NodeJS.ReadableStream | null) {
  const parts: Buffer[] = [];
  for await (const part of stream ?? []) parts.push(Buffer.from(part));
  return new Uint8Array(Buffer.concat(parts));
}

test("routes: list search and task counts, rename, audio with ranges, audio deletion", async () => {
  const f = fixture();
  try {
    const meeting = await readyMeeting(f.store, f.db);
    const url = (path: string) => new URL(`http://test/${path}`);
    const list = (await meetingRoute(
      request("GET"),
      "meetings",
      url("meetings?q=c%C3%A9n%C3%ADk&include=tasks"),
      access(f.store),
    )) as { status: number; value: Record<string, unknown> };
    assert.equal(list.status, 200);
    assert.deepEqual(list.value.openTasks, { [meeting.id]: 2 });
    assert.deepEqual(
      (list.value.matches as { field: string }[]).map((m) => m.field),
      ["summary"],
    );
    // Without either parameter the list stays as older apps read it.
    const plain = (await meetingRoute(
      request("GET"),
      "meetings",
      url("meetings"),
      access(f.store),
    )) as { value: Record<string, unknown> };
    assert.equal("openTasks" in plain.value, false);
    assert.equal("matches" in plain.value, false);
    for (const bad of [
      "meetings?include=all",
      "meetings?q=",
      "meetings?other=1",
      `meetings?q=${"x".repeat(201)}`,
    ])
      await assert.rejects(
        meetingRoute(request("GET"), "meetings", url(bad), access(f.store)),
      );

    const renamed = (await meetingRoute(
      request("PATCH", { profile: MEETING_PROFILE, title: "TEST Novák" }),
      `meetings/${meeting.id}`,
      url(`meetings/${meeting.id}`),
      access(f.store),
    )) as { value: { title: string } };
    assert.equal(renamed.value.title, "TEST Novák");
    await assert.rejects(
      meetingRoute(
        request("PATCH", { profile: MEETING_PROFILE, title: "TEST cizí" }),
        `meetings/${meeting.id}`,
        url(`meetings/${meeting.id}`),
        access(f.store, stranger),
      ),
      (error: IdentityError) => error.code === "meeting_not_found",
    );

    const audio = (headers: Record<string, string> = {}, scope = owner) =>
      meetingAudioRoute(
        request("GET", undefined, headers),
        `meetings/${meeting.id}/audio`,
        url(`meetings/${meeting.id}/audio`),
        access(f.store, scope),
      );
    const whole = await audio();
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["Accept-Ranges"], "bytes");
    assert.equal(whole.headers["Content-Type"], "audio/mp4");
    assert.deepEqual(await bodyOf(whole.body), AUDIO);
    const part = await audio({ range: "bytes=2-5" });
    assert.equal(part.status, 206);
    assert.equal(part.headers["Content-Range"], "bytes 2-5/8");
    assert.deepEqual(await bodyOf(part.body), AUDIO.slice(2, 6));
    const tail = await audio({ range: "bytes=-3" });
    assert.deepEqual(await bodyOf(tail.body), AUDIO.slice(5));
    assert.equal((await audio({ range: "bytes=9-" })).status, 416);
    assert.equal((await audio({ range: "items=0-1" })).status, 416);
    await assert.rejects(
      audio({}, stranger),
      (error: IdentityError) => error.code === "meeting_not_found",
    );

    const deleted = (await meetingRoute(
      request("DELETE"),
      `meetings/${meeting.id}/audio`,
      url(`meetings/${meeting.id}/audio`),
      access(f.store),
    )) as { value: { audioDeletedAt?: string; title: string } };
    assert.ok(deleted.value.audioDeletedAt);
    assert.equal(existsSync(f.store.path(meeting)), false);
    await assert.rejects(
      audio(),
      (error: IdentityError) => error.code === "meeting_audio_not_found",
    );
    // Notes and transcript stay; processing again is refused.
    assert.ok(f.store.record(owner, meeting.id).analysis);
    await assert.rejects(
      meetingRoute(
        request("POST", { profile: MEETING_PROFILE, retry: true }),
        `meetings/${meeting.id}/process`,
        url(`meetings/${meeting.id}/process`),
        access(f.store),
      ),
      (error: IdentityError) => error.code === "meeting_audio_deleted",
    );
    // Only a processed meeting's sound can be deleted.
    const sealed = f.store.create(owner, input());
    await assert.rejects(
      meetingRoute(
        request("DELETE"),
        `meetings/${sealed.id}/audio`,
        url(`meetings/${sealed.id}/audio`),
        access(f.store),
      ),
      (error: IdentityError) => error.code === "meeting_processing_busy",
    );
  } finally {
    f.close();
  }
});

test("agent tools read only the owner's meetings, bounded and framed as untrusted data", async () => {
  const f = fixture();
  try {
    const long = Array.from(
      { length: 12 },
      (_, index) =>
        `Minuta ${index}: ` +
        "slovo ".repeat(560) +
        (index === 11 ? "ceník" : ""),
    );
    const meeting = await readyMeeting(f.store, f.db, {}, long);
    const mine = meetingAgentAccess(f.store, owner);
    const theirs = meetingAgentAccess(f.store, stranger);

    const found = mine.search({ q: "ceník", limit: 10 }) as {
      note: string;
      meetings: Record<string, unknown>[];
    };
    assert.equal(found.note, MEETING_DATA_NOTE);
    assert.match(found.note, /untrusted DATA/);
    assert.equal(found.meetings.length, 1);
    assert.equal(found.meetings[0]!.meetingId, meeting.id);
    assert.equal(found.meetings[0]!.summary, "Probrali jsme rozpočet a ceník.");
    const inTranscript = mine.search({ q: "minuta 3" }) as {
      meetings: Record<string, unknown>[];
    };
    assert.equal(inTranscript.meetings[0]!.matched, "transcript");
    assert.equal(inTranscript.meetings[0]!.time, "3:00");
    assert.deepEqual(
      (theirs.search({ q: "ceník" }) as unknown as { meetings: [] }).meetings,
      [],
    );
    for (const bad of [
      { q: "ceník", limit: 11 },
      { q: "" },
      { q: "x".repeat(201) },
      { q: "ceník", from: "včera" },
      { q: "ceník", extra: true },
    ])
      assert.deepEqual(mine.search(bad), { error: "invalid_input" });
    assert.deepEqual(
      (
        mine.search({ q: "ceník", to: "2026-10-07" }) as unknown as {
          meetings: [];
        }
      ).meetings,
      [],
    );

    assert.deepEqual(theirs.read({ meetingId: meeting.id, part: "notes" }), {
      error: "meeting_not_found",
    });
    assert.equal(theirs.describe(meeting.id), undefined);
    assert.equal(mine.describe(meeting.id)?.title, meeting.title);
    assert.deepEqual(mine.read({ meetingId: "x", part: "notes" }), {
      error: "invalid_input",
    });

    const notes = mine.read({ meetingId: meeting.id, part: "notes" }) as Record<
      string,
      unknown
    >;
    assert.equal(notes.note, MEETING_DATA_NOTE);
    assert.equal(notes.summary, "Probrali jsme rozpočet a ceník.");
    assert.deepEqual(notes.tasks, [
      { text: "Poslat ceník", time: "11:00", due: "pátek" },
      { text: "Domluvit další schůzku", time: "11:00" },
    ]);
    assert.deepEqual(notes.decisions, []);

    const first = mine.read({
      meetingId: meeting.id,
      part: "transcript",
    }) as Record<string, string | boolean>;
    assert.equal(first.note, MEETING_DATA_NOTE);
    assert.ok(String(first.transcript).length <= MEETING_READ_CHARS);
    assert.equal(first.truncated, true);
    // Continuing from where each part stopped reaches the end, nothing lost.
    let part = first;
    const parts = [String(first.transcript)];
    for (let i = 0; i < 10 && part.truncated; i++) {
      const from = Number(/from (\d+)/.exec(String(part.next))![1]);
      part = mine.read({
        meetingId: meeting.id,
        part: "transcript",
        from,
      }) as Record<string, string | boolean>;
      assert.ok(String(part.transcript).length <= MEETING_READ_CHARS);
      parts.push(String(part.transcript));
    }
    assert.equal(part.truncated, undefined);
    assert.match(String(part.transcript), /ceník$/);
    assert.equal(parts.join("\n").split("\n").length, 12);
    const window = mine.read({
      meetingId: meeting.id,
      part: "transcript",
      from: 120,
      to: 180,
    }) as Record<string, string>;
    assert.deepEqual(
      String(window.transcript)
        .split("\n")
        .map((line) => line.slice(0, 13)),
      ["2:00 Minuta 2", "3:00 Minuta 3"],
    );
  } finally {
    f.close();
  }
});

test("agent tools: search dates are days in the workspace's time zone; transcript parts never repeat a line", async () => {
  const f = fixture();
  try {
    // 23:30 UTC on the 8th is already the 9th in Prague.
    const meeting = await readyMeeting(f.store, f.db, {
      recordedAt: "2026-10-08T23:30:00.000Z",
    });
    const found = (
      access: ReturnType<typeof meetingAgentAccess>,
      day: string,
    ) =>
      (
        access.search({ q: "ceník", from: day, to: day }) as {
          meetings: { meetingId: string }[];
        }
      ).meetings.map((hit) => hit.meetingId);
    const prague = meetingAgentAccess(f.store, owner, "Europe/Prague");
    assert.deepEqual(found(prague, "2026-10-09"), [meeting.id]);
    assert.deepEqual(found(prague, "2026-10-08"), []);
    const utc = meetingAgentAccess(f.store, owner);
    assert.deepEqual(found(utc, "2026-10-08"), [meeting.id]);
    assert.deepEqual(found(utc, "2026-10-09"), []);
    assert.deepEqual(prague.search({ q: "ceník", from: "1999-01-01" }), {
      error: "invalid_input",
    });

    // Turns 4–6 start at the same second; the first part would end inside them.
    const minutes = f.store.allSegments(owner, meeting.id);
    const starts = [0, 60, 120, 180, 300, 300, 300, 400];
    f.store.putTranscript(
      owner,
      meeting.id,
      minutes,
      starts.map((start, index) => ({
        start,
        end: start + 30,
        speaker: "unknown" as const,
        text: `Věta ${index} ` + "slovo ".repeat(500),
      })),
    );
    const read = (from?: number) =>
      utc.read({
        meetingId: meeting.id,
        part: "transcript",
        ...(from === undefined ? {} : { from }),
      }) as Record<string, string | boolean>;
    const parts = [read()];
    for (let i = 0; i < 5 && parts.at(-1)!.truncated; i++)
      parts.push(
        read(Number(/from ([\d.]+)/.exec(String(parts.at(-1)!.next))![1])),
      );
    assert.equal(parts.at(-1)!.truncated, undefined);
    const said = parts
      .flatMap((part) => String(part.transcript).split("\n"))
      .map((line) => /Věta \d/.exec(line)![0]);
    assert.deepEqual(
      said,
      starts.map((_, index) => `Věta ${index}`),
    );

    // A part made of one second alone moves on instead of repeating itself.
    f.store.putTranscript(
      owner,
      meeting.id,
      minutes,
      [...Array(9).fill(500), 600].map((start, index) => ({
        start,
        end: start + 30,
        speaker: "unknown" as const,
        text: `Věta ${index} ` + "slovo ".repeat(500),
      })),
    );
    const crowded = read(500);
    assert.equal(crowded.truncated, true);
    assert.match(String(crowded.next), /from 600\./);
  } finally {
    f.close();
  }
});

test("real server: audio needs the owner's credential; rename, search and audio deletion over HTTP", async () => {
  const fixture = await mobileHttpChildFixture();
  let client: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 0, writes: 0 });
    client = new ClientSession(
      setup.endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
    );
    const created = input({
      mimeType: "audio/wav",
      consent: {
        at: "2026-10-08T09:59:00.000Z",
        by: setup.credential.scope.userId,
      },
    });
    assert.deepEqual(
      (await client.createMeeting(created)).consent,
      created.consent,
    );
    await client.uploadMeetingBlock(created.id, 0, AUDIO);
    await client.sealMeeting(created.id);
    const anonymous = await fetch(
      `${setup.endpoint}/meetings/${created.id}/audio`,
    );
    assert.equal(anonymous.status, 401);
    const blob = await client.readMeetingAudio(created.id);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), AUDIO);
    const ranged = await fetch(
      `${setup.endpoint}/meetings/${created.id}/audio`,
      {
        headers: {
          authorization: `Bearer ${setup.credential.accessToken}`,
          range: "bytes=0-1",
        },
      },
    );
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 0-1/8");
    assert.deepEqual(
      new Uint8Array(await ranged.arrayBuffer()),
      AUDIO.slice(0, 2),
    );
    assert.equal(
      (await client.renameMeeting(created.id, "TEST Přejmenovaná")).title,
      "TEST Přejmenovaná",
    );
    const found = await client.readMeetings({
      query: "prejmenovana",
      openTasks: true,
    });
    assert.deepEqual(
      found.meetings.map((m) => m.id),
      [created.id],
    );
    assert.equal(found.matches?.[0]?.field, "title");
    assert.deepEqual(found.openTasks, {});
    // A sealed meeting still needs its sound.
    await assert.rejects(
      client.deleteMeetingAudio(created.id),
      /meeting_processing_busy/,
    );
    assert.equal((await fixture.inspect()).serviceDispatches.length, 0);
  } finally {
    client?.stop();
    await fixture.close();
  }
});
