import { ClientSession } from "../packages/client-core/session";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { credential, authInfo } from "./auth-fixtures";
import {
  SPEECH_PROFILE,
  type SpeechRequest,
} from "../packages/protocol/speech";
const request: SpeechRequest = {
  profile: SPEECH_PROFILE,
  requestId: "r",
  conversationId: "c",
  messageId: "m",
  language: "cs",
};
const result = {
  ...request,
  scope: credential().scope,
  audio: { mimeType: "audio/wav", base64: "AAAA" },
};
const response = (value: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  }) as Response;
async function setup(value: unknown) {
  const storage = {
    getItem: async () => null,
    setItem: jest.fn(async () => {}),
  };
  const transport = jest.fn(async (url, init) => {
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${credential().accessToken}`,
    });
    if (String(url).endsWith("auth/session")) return response(authInfo());
    if (String(url).endsWith("voice/speech")) return response(value);
    return response(new FixtureEngine().snapshot());
  }) as jest.MockedFunction<typeof fetch>;
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    transport,
  );
  await session.start(false);
  storage.setItem.mockClear();
  return { session, storage };
}
test("speech delivery validates identity and never writes audio into workflow cache", async () => {
  const { session, storage } = await setup(result);
  try {
    expect(
      await session.synthesize(request, new AbortController().signal),
    ).toEqual(result.audio);
    expect(storage.setItem).not.toHaveBeenCalled();
    session.stop();
    await expect(
      session.synthesize(request, new AbortController().signal),
    ).rejects.toThrow("session_stopped");
  } finally {
    session.stop();
  }
});
test.each([
  { ...result, messageId: "other" },
  { ...result, scope: { ...result.scope, userId: "other" } },
  { ...result, language: "en" },
  { ...result, conversationId: "other" },
])("rejects speech for a different request or scope", async (wrong) => {
  const { session } = await setup(wrong);
  try {
    await expect(
      session.synthesize(request, new AbortController().signal),
    ).rejects.toThrow("speech_context_changed");
  } finally {
    session.stop();
  }
});
