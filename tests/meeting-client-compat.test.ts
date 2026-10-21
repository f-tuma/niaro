import { ClientSession } from "../packages/client-core/session";
import {
  MEETING_PROFILE,
  MEETING_MAX_BYTES,
} from "../packages/protocol/meetings";
import { HUMAN_TASK_PROFILE } from "../packages/protocol/human-tasks";
import { MEETING_RECORD_PROFILE } from "../packages/protocol/meeting-record";
import { DEVICE_SESSION_PROFILE, type Credential } from "../packages/protocol";
import {
  meetingFixture,
  meetingRecordFixture,
} from "../packages/test-fixtures/meeting";
import { humanTaskFixture } from "../packages/test-fixtures/human-task";
import { credential, authInfo } from "./auth-fixtures";

const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;

function setup(
  answer: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  initial: Credential = credential(),
  renew?: (old: Credential) => Promise<Credential>,
) {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("auth/session"))
        return response(authInfo(initial));
      return answer(new URL(String(url)), init);
    },
  );
  const session = new ClientSession(
    "https://fixture/v1/a",
    { getItem: async () => null, setItem: async () => {} },
    initial,
    fetcher,
    () => {},
    renew,
  );
  return { session, fetcher };
}

const scope = credential().scope;
const meeting = { ...meetingFixture, scope };
// What a newer server may add anywhere; this build does not know it.
const future = { futureField: "TEST", futureObject: { nested: true } };

describe("a client older than the server still reads its answers", () => {
  test("a meeting list with unknown fields at every level", async () => {
    const { session } = setup(() =>
      response({
        profile: MEETING_PROFILE,
        scope,
        meetings: [
          {
            ...meeting,
            ...future,
            consent: { at: meeting.recordedAt, by: scope.userId, ...future },
          },
        ],
        matches: [
          {
            meetingId: meeting.id,
            field: "title",
            snippet: "Product",
            at: null,
            ...future,
          },
        ],
        ...future,
      }),
    );
    const list = await session.readMeetings({ query: "product" });
    expect(list.meetings[0]).toEqual({
      ...meeting,
      consent: { at: meeting.recordedAt, by: scope.userId },
    });
    expect(list.matches?.[0]).not.toHaveProperty("futureField");
    expect(list).not.toHaveProperty("futureField");
  });

  test("a meeting record with a newer profile and unknown fields reads as the newest known one", async () => {
    const analysis = meetingRecordFixture.analysis!;
    const { session } = setup(() =>
      response({
        ...meetingRecordFixture,
        ...future,
        profile: "niaro-meeting-record/3",
        scope,
        meeting: { ...meeting, ...future },
        analysis: {
          ...analysis,
          ...future,
          version: 2,
          tasks: analysis.tasks.map((task) => ({ ...task, ...future })),
          decisions: [{ ...analysis.points[0]!, ...future }],
        },
        utterances: [
          { start: 0, end: 4, speaker: "me", text: "Hello", ...future },
        ],
      }),
    );
    const record = await session.readMeetingRecord(meeting.id);
    expect(record.profile).toBe(MEETING_RECORD_PROFILE);
    expect(record).not.toHaveProperty("futureField");
    expect(record.analysis!.tasks[0]).not.toHaveProperty("futureField");
    expect(record.analysis!.decisions![0]).toEqual(analysis.points[0]);
    expect(record.utterances).toEqual([
      { start: 0, end: 4, speaker: "me", text: "Hello" },
    ]);
  });

  test("a meeting record still refuses a known field with a wrong shape", async () => {
    const { session } = setup(() =>
      response({
        ...meetingRecordFixture,
        profile: "niaro-meeting-record/3",
        scope,
        meeting,
        transcriptComplete: "yes",
      }),
    );
    await expect(session.readMeetingRecord(meeting.id)).rejects.toThrow();
  });

  test("human tasks with unknown fields in the task and its origin", async () => {
    const task = { ...humanTaskFixture, scope };
    const extended = {
      ...task,
      ...future,
      origin: { ...task.origin, ...future },
    };
    const { session } = setup((url) =>
      response(
        url.pathname.endsWith("/human-tasks")
          ? {
              profile: HUMAN_TASK_PROFILE,
              scope,
              tasks: [extended],
              next: null,
              counts: { open: 1, done: 0, ...future },
              ...future,
            }
          : extended,
      ),
    );
    expect((await session.readHumanTasks("open")).tasks).toEqual([task]);
    expect(await session.readHumanTask(task.id)).toEqual(task);
  });
});

describe("a meeting's recording", () => {
  const audio = (
    status = 200,
    length?: number,
    blob = jest.fn(async () => new Blob([new Uint8Array([1, 2, 3])])),
  ) =>
    ({
      ok: status < 400,
      status,
      headers: new Headers(
        length === undefined ? {} : { "content-length": String(length) },
      ),
      blob,
    }) as unknown as Response;
  const device = (accessToken = "A".repeat(43)): Credential => ({
    ...credential(),
    accessToken,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    refresh: {
      profile: DEVICE_SESSION_PROFILE,
      token: "R".repeat(43),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });

  test("a refused credential is renewed and the read asked once more", async () => {
    const renew = jest.fn(async () => device("B".repeat(43)));
    const { session, fetcher } = setup(
      (_, init) =>
        (init?.headers as Record<string, string>).Authorization ===
        `Bearer ${"B".repeat(43)}`
          ? audio()
          : audio(401),
      device(),
      renew,
    );
    const blob = await session.readMeetingAudio(meeting.id);
    expect(blob.size).toBe(3);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/audio")),
    ).toHaveLength(2);
  });

  test("a body larger than a meeting is refused before it is read", async () => {
    const blob = jest.fn();
    const { session } = setup(() => audio(200, MEETING_MAX_BYTES + 1, blob));
    await expect(session.readMeetingAudio(meeting.id)).rejects.toThrow(
      "meeting_audio_invalid",
    );
    expect(blob).not.toHaveBeenCalled();
  });

  test("stop() cancels a download in flight", async () => {
    let started!: () => void;
    const requested = new Promise<void>((resolve) => (started = resolve));
    const { session } = setup(
      (_, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
          started();
        }),
    );
    const read = session.readMeetingAudio(meeting.id);
    await requested;
    session.stop();
    await expect(read).rejects.toThrow();
  });
});
