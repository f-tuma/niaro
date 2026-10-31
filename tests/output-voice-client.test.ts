import { ClientSession } from "../packages/client-core/session";
import { credential } from "./auth-fixtures";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceSnapshot,
  type OutputVoiceUpdate,
} from "../packages/protocol/output-voice";
const signal = () => new AbortController().signal;
const snapshot = (): OutputVoiceSnapshot => ({
  profile: OUTPUT_VOICE_PROFILE,
  scope: credential().scope,
  revision: 0,
  catalogueRevision: "a".repeat(64),
  availability: "selectable",
  route: { identity: "b".repeat(64), model: "Reader", method: "reader" },
  serverDefault: { label: "Cedar" },
  options: [{ optionId: `ov_${"c".repeat(64)}`, label: "Echo" }],
  saved: null,
  effective: {
    choice: { kind: "server-default" },
    label: "Cedar",
    reason: "server-default",
  },
});
const update = (): OutputVoiceUpdate => ({
  profile: OUTPUT_VOICE_PROFILE,
  requestId: "93ff8b48-19a7-469b-a9a3-8a9b2d9fecbd",
  expectedRevision: 0,
  catalogueRevision: snapshot().catalogueRevision,
  choice: { kind: "catalogue", optionId: snapshot().options[0]!.optionId },
});
const response = (value: unknown, status = 200): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(value),
  }) as Response;
function setup(handler: typeof fetch) {
  const request = jest.fn(handler);
  const session = new ClientSession(
    "https://fixture/v1/a",
    { getItem: async () => null, setItem: async () => {} },
    credential(),
    request,
  );
  return { session, request };
}
test("actual methods negotiate only the sidecar and bound the exact save body", async () => {
  const { session, request } = setup(async () => response(snapshot()));
  expect(await session.outputVoiceSettings(signal())).toEqual(snapshot());
  expect(await session.saveOutputVoiceSettings(update(), signal())).toEqual(
    snapshot(),
  );
  expect(request).toHaveBeenCalledTimes(2);
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe(
      `https://fixture/v1/a/voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}`,
    );
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: { Authorization: `Bearer ${credential().accessToken}` },
    });
  }
  expect(request.mock.calls[1]![1]).toMatchObject({
    method: "POST",
    body: JSON.stringify(update()),
  });
  session.stop();
});
test.each([404, 406])(
  "only old-server/profile refusal is unsupported (%s)",
  async (status) => {
    const { session } = setup(async () =>
      status === 404
        ? ({ status, text: async () => "" } as Response)
        : response({ error: "output_voice_profile_unsupported" }, status),
    );
    expect(await session.outputVoiceSettings(signal())).toBeNull();
    session.stop();
  },
);
test.each([
  [406, { error: "other" }],
  [500, { error: "oops" }],
  [200, { ...snapshot(), profile: "agent-output-voice/2" }],
  [200, { ...snapshot(), extra: true }],
  [200, { ...snapshot(), scope: { ...snapshot().scope, userId: "foreign" } }],
])(
  "failed/malformed/foreign reads are never unsupported (%s)",
  async (status, value) => {
    const { session } = setup(async () => response(value, status as number));
    await expect(session.outputVoiceSettings(signal())).rejects.toThrow();
    session.stop();
  },
);
test.each([401, 403])(
  "authorization is handled by the existing session (%s)",
  async (status) => {
    const { session, request } = setup(async () =>
      response({ error: "auth_expired" }, status),
    );
    await expect(session.outputVoiceSettings(signal())).rejects.toThrow(
      "auth_expired",
    );
    await expect(session.outputVoiceSettings(signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    session.stop();
  },
);
test("network and invalid JSON fail; the response limit counts UTF-8 bytes", async () => {
  for (const handler of [
    async () => {
      throw Error("network");
    },
    async () => ({ status: 200, ok: true, text: async () => "{" }) as Response,
    async () =>
      ({
        status: 200,
        ok: true,
        text: async () => `"${"ž".repeat(17000)}"`,
      }) as Response,
  ]) {
    const { session } = setup(handler);
    await expect(session.outputVoiceSettings(signal())).rejects.toThrow();
    session.stop();
  }
});
test.each(["read", "save"])(
  "ignored abort/stop and scope changes cannot complete %s",
  async (mode) => {
    for (const cancel of ["abort", "stop", "scope"] as const) {
      let finish!: (value: Response) => void;
      const { session, request } = setup(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const controller = new AbortController();
      const pending =
        mode === "read"
          ? session.outputVoiceSettings(controller.signal)
          : session.saveOutputVoiceSettings(update(), controller.signal);
      await Promise.resolve();
      await Promise.resolve();
      if (cancel === "abort") controller.abort();
      if (cancel === "stop") session.stop();
      if (cancel === "scope")
        Object.assign(credentialScope(session), { userId: "changed" });
      finish(response(snapshot()));
      await expect(pending).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      session.stop();
    }
  },
);
// Simulates a hostile identity mutation at the existing credential port, never a production escape hatch.
function credentialScope(session: ClientSession) {
  return (session as unknown as { credential: ReturnType<typeof credential> })
    .credential.scope;
}
test("late response body after stop is rejected and subsequent calls do not dispatch", async () => {
  let finish!: (value: string) => void;
  const { session, request } = setup(
    async () =>
      ({
        status: 200,
        ok: true,
        text: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }) as Response,
  );
  const pending = session.outputVoiceSettings(signal());
  for (let i = 0; i < 8; i++) await Promise.resolve();
  session.stop();
  finish(JSON.stringify(snapshot()));
  await expect(pending).rejects.toThrow();
  await expect(
    session.saveOutputVoiceSettings(update(), signal()),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
test("strict update rejects raw targets before dispatch; mutation errors never replay", async () => {
  const { session, request } = setup(async () => {
    throw Error("lost_response");
  });
  await expect(
    session.saveOutputVoiceSettings(
      { ...update(), voice: "echo" } as OutputVoiceUpdate,
      signal(),
    ),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  await expect(
    session.saveOutputVoiceSettings(update(), signal()),
  ).rejects.toThrow("lost_response");
  expect(request).toHaveBeenCalledTimes(1);
  session.stop();
});
test.each([
  "output_voice_conflict",
  "output_voice_catalogue_changed",
  "output_voice_choice_unavailable",
])("preserves %s without replay", async (error) => {
  const { session, request } = setup(async () =>
    response({ error }, error.endsWith("unavailable") ? 422 : 409),
  );
  await expect(
    session.saveOutputVoiceSettings(update(), signal()),
  ).rejects.toThrow(error);
  expect(request).toHaveBeenCalledTimes(1);
  session.stop();
});
test("credential renewal after a refused mutation never replays the POST", async () => {
  const c = {
    ...credential(),
    refresh: {
      profile: "agent-device-session/1" as const,
      token: "R".repeat(43),
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  const request = jest.fn(async () => response({ error: "auth_expired" }, 401));
  const renew = jest.fn(async () => ({
    ...credential(),
    accessToken: "B".repeat(43),
  }));
  const session = new ClientSession(
    "https://fixture/v1/a",
    { getItem: async () => null, setItem: async () => {} },
    c,
    request,
    () => {},
    renew,
  );
  await expect(
    session.saveOutputVoiceSettings(update(), signal()),
  ).rejects.toThrow("connection_failed");
  expect(request).toHaveBeenCalledTimes(1);
  expect(renew).toHaveBeenCalledTimes(1);
  session.stop();
});
