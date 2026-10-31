import { ClientSession } from "../packages/client-core/session";
import { credential } from "./auth-fixtures";
import { DEFAULT_PET_SETTINGS } from "../apps/server-identity/work-pet";
const c = credential();
const profile = {
  profile: "work-pet/1",
  organizationId: "org",
  workspaceId: c.scope.workspaceId,
  userId: c.scope.userId,
  revision: 0,
  settings: DEFAULT_PET_SETTINGS,
  automaticShape: "circle",
  look: ["work", "projects", "tools", "people", "style", "rhythm"].map(
    (section) => ({ section, weight: 0 }),
  ),
};
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const storage = { getItem: async () => null, setItem: async () => {} };
const create = (request: typeof fetch) =>
  new ClientSession("https://fixture/v1/a", storage, c, request);

test("pet account methods never initialize chat and reject foreign/unknown snapshots", async () => {
  const request = jest.fn(async (_url: unknown, _init?: RequestInit) =>
    response(profile),
  );
  const s = create(request);
  expect(await s.petProfile()).toEqual(profile);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe("https://fixture/v1/a/pet");
  request.mockImplementation(async () =>
    response({ ...profile, userId: "foreign" }),
  );
  await expect(s.petProfile()).rejects.toThrow("invalid_payload");
  request.mockImplementation(async () => response(null));
  await expect(s.petProfile()).rejects.toThrow();
  request.mockImplementation(async () =>
    response({ ...profile, extra: "unknown" }),
  );
  await expect(s.petProfile()).rejects.toThrow();
  s.stop();
});

test("write conflict is not replayed, unsupported must be explicit and drafts remain caller-owned", async () => {
  const request = jest.fn(async () => response({ error: "pet_conflict" }, 409));
  const s = create(request);
  const draft = {
    requestId: "test-request",
    revision: 0,
    settings: { ...DEFAULT_PET_SETTINGS, name: "TEST draft" },
  };
  await expect(s.savePetProfile(draft)).rejects.toThrow("pet_conflict");
  expect(request).toHaveBeenCalledTimes(1);
  expect(draft.settings.name).toBe("TEST draft");
  request.mockImplementation(async () => response({ error: "not_found" }, 404));
  await expect(s.petProfile()).rejects.toThrow("pet_failed");
  request.mockImplementation(async () =>
    response({ error: "pet_unsupported" }, 406),
  );
  expect(await s.petProfile()).toBeNull();
  s.stop();
});

test("pet responses enforce accepted UTF8 bound and query schema before transport", async () => {
  const request = jest.fn(async () =>
    response({
      ...profile,
      settings: { ...profile.settings, name: "ě".repeat(350001) },
    }),
  );
  const s = create(request);
  await expect(s.petProfile()).rejects.toThrow();
  const before = request.mock.calls.length;
  await expect(s.petMemory({ limit: 101 })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(before);
  s.stop();
});

test("pet 401 renews credential without replaying write", async () => {
  const renewable = {
    ...c,
    refresh: {
      profile: "agent-device-session/1" as const,
      token: "R".repeat(43),
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  const request = jest.fn(async () =>
    response({ error: "identity_unauthorized" }, 401),
  );
  const renew = jest.fn(async () => ({
    ...renewable,
    accessToken: "B".repeat(43),
  }));
  const s = new ClientSession(
    "https://fixture/v1/a",
    storage,
    renewable,
    request,
    () => {},
    renew,
  );
  await expect(
    s.savePetProfile({
      requestId: "test-renew",
      revision: 0,
      settings: DEFAULT_PET_SETTINGS,
    }),
  ).rejects.toThrow("connection_failed");
  expect(request).toHaveBeenCalledTimes(1);
  expect(renew).toHaveBeenCalledTimes(1);
  s.stop();
});

test("pet abort stays owned by session stop", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = jest.fn(async (_url: unknown, init?: RequestInit) => {
    entered();
    return await new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener(
        "abort",
        () => reject(new Error("TEST aborted")),
        { once: true },
      ),
    );
  });
  const s = create(request);
  const read = s.petProfile();
  await started;
  s.stop();
  await expect(read).rejects.toThrow("TEST aborted");
});
