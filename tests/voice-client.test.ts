import { ClientSession } from "../packages/client-core/session";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { credential, authInfo } from "./auth-fixtures";
import {
  VOICE_PROFILE,
  voiceCapabilities,
  type VoiceRequest,
} from "../packages/protocol/voice";
import { messageCommand } from "../packages/client-core/commands";
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const request: VoiceRequest = {
  profile: VOICE_PROFILE,
  requestId: "voice-1",
  language: "en",
  context: {
    conversationId: "conversation-1",
    workItemId: "work-1",
    inputRequestId: "input-1",
    expectedInputRevision: 1,
  },
  audio: { mimeType: "audio/wav", base64: "YWJjZA==" },
};
const result = {
  profile: VOICE_PROFILE,
  scope: credential().scope,
  requestId: request.requestId,
  context: request.context,
  language: "en",
  text: "Choose Peter Novak",
  reviewReasons: [],
};
async function setup(transcribe: (init?: RequestInit) => Promise<Response>) {
  const engine = new FixtureEngine();
  engine.execute(messageCommand("Choose Peter", "en", "start"));
  const storage = {
    getItem: async () => null,
    setItem: jest.fn(async () => {}),
  };
  const transport = jest.fn(async (url, init) => {
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${credential().accessToken}`,
    });
    if (String(url).endsWith("/auth/session")) return response(authInfo());
    if (String(url).endsWith("/voice/transcriptions")) return transcribe(init);
    if (String(url).endsWith("/voice"))
      return response(voiceCapabilities(true));
    return response(engine.snapshot());
  }) as jest.MockedFunction<typeof fetch>;
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    transport,
  );
  await session.start(false);
  return { session, storage, transport };
}
test("voice uses authenticated endpoint, does not store audio/transcript or submit commands", async () => {
  const { session, storage, transport } = await setup(async () =>
    response(result),
  );
  try {
    const signal = new AbortController().signal;
    expect((await session.voiceCapabilities(signal)).enabled).toBe(true);
    storage.setItem.mockClear();
    expect(await session.transcribe(request, signal)).toEqual({
      text: result.text,
      reviewReasons: [],
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(
      transport.mock.calls.filter(([url]) =>
        new URL(String(url)).pathname.endsWith("/commands"),
      ),
    ).toHaveLength(0);
    expect(session.getSnapshot().pending).toBeNull();
  } finally {
    session.stop();
  }
});
test.each([
  { ...result, scope: { ...result.scope, userId: "foreign" } },
  { ...result, context: { ...result.context, expectedInputRevision: 2 } },
  { ...result, requestId: "other" },
])(
  "rejects a transcript for a different identity, question or request",
  async (value) => {
    const { session } = await setup(async () => response(value));
    try {
      await expect(
        session.transcribe(request, new AbortController().signal),
      ).rejects.toThrow("voice_context_changed");
    } finally {
      session.stop();
    }
  },
);
test("disconnect aborts an in-flight upload and ignores a late response", async () => {
  let finish!: (value: Response) => void;
  let signal!: AbortSignal;
  const { session } = await setup(async (init) => {
    signal = init!.signal!;
    return new Promise((r) => {
      finish = r;
    });
  });
  const pending = session.transcribe(request, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow("session_stopped");
  while (!finish) await Promise.resolve();
  session.stop();
  expect(signal.aborted).toBe(true);
  finish(response(result));
  await rejected;
});
test("an explicitly cancelled upload cannot return a late transcript", async () => {
  let finish!: (value: Response) => void;
  const { session } = await setup(
    async () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  try {
    const controller = new AbortController();
    const pending = session.transcribe(request, controller.signal);
    const rejected = expect(pending).rejects.toThrow("session_stopped");
    while (!finish) await Promise.resolve();
    controller.abort();
    finish(response(result));
    await rejected;
  } finally {
    session.stop();
  }
});
