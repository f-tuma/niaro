import { Connections } from "../packages/client-core/connections";
import { ClientSession } from "../packages/client-core/session";
import { AuthenticationError } from "../packages/client-core/auth";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { DEVICE_SESSION_PROFILE, type Credential } from "../packages/protocol";
import { credential, authInfo } from "./auth-fixtures";
import { messageCommand } from "../packages/client-core/commands";

const key = "agent-client.active-credential.v1";
const address = "https://fixture/v1/a";
const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
};
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const device = (expired = false): Credential => ({
  ...credential(),
  expiresAt: new Date(Date.now() + (expired ? -1 : 1800000)).toISOString(),
  refresh: {
    profile: DEVICE_SESSION_PROFILE,
    token: "R".repeat(43),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  },
});
const fresh = (old: Credential): Credential => ({
  ...old,
  accessToken: "B".repeat(43),
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
  refresh: {
    profile: DEVICE_SESSION_PROFILE,
    token: "S".repeat(43),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  },
});
function setup(initial = device(true), pendingRefreshId?: string) {
  const storage = memory(),
    vault = memory();
  vault.map.set(
    key,
    JSON.stringify({
      address,
      credential: initial,
      ...(pendingRefreshId ? { pendingRefreshId } : {}),
    }),
  );
  const engine = new FixtureEngine(
    "a",
    undefined,
    undefined,
    undefined,
    initial.scope,
  );
  const current = fresh(initial);
  const request = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/auth/refresh")) {
      if (init?.method === "DELETE") return response(null, 204);
      expect(JSON.parse(vault.map.get(key)!).pendingRefreshId).toBe(
        JSON.parse(String(init?.body)).requestId,
      );
      return response(current);
    }
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${current.accessToken}`,
    });
    return response(
      String(url).endsWith("/auth/session")
        ? authInfo(current)
        : engine.snapshot(),
    );
  });
  const connections = () =>
    new Connections(
      storage,
      vault,
      false,
      request as typeof fetch,
      () => "TEST-refresh-intent-1234",
    );
  return { storage, vault, request, current, connections, engine };
}
afterEach(() => jest.useRealTimers());

test("cold start renews expired access before cache reads; refresh secrets never enter public state or ordinary storage", async () => {
  const b = setup(),
    c = b.connections();
  await c.restore();
  const s = c.getSnapshot().session!;
  await s.start(false);
  expect(s.getSnapshot().status).toBe("online");
  expect(c.getSnapshot().renewable).toBe(true);
  expect(c.getSnapshot().identity).toEqual(authInfo(b.current));
  expect(JSON.parse(b.vault.map.get(key)!)).toEqual({
    address,
    credential: b.current,
  });
  expect(JSON.stringify([...b.storage.map])).not.toContain(
    b.current.refresh!.token,
  );
  expect(b.request.mock.calls[0]![0]).toBe(`${address}/auth/refresh`);
  c.dispose();
});
test("network loss keeps credentials and durable rotation ID; restart recovers expired rotation response then rotates again", async () => {
  const b = setup(),
    old = device(true),
    c = b.connections();
  b.request.mockImplementationOnce(async () => {
    throw Error("offline");
  });
  await c.restore();
  await c.getSnapshot().session!.start(false);
  expect(c.getSnapshot().status).toBe("connected");
  expect(c.getSnapshot().session!.getSnapshot().status).toBe("offline");
  expect(JSON.parse(b.vault.map.get(key)!).pendingRefreshId).toBe(
    "TEST-refresh-intent-1234",
  );
  c.dispose();
  // Simulate reopening after both the original refresh expiry and recovered access expiry.
  const stored = JSON.parse(b.vault.map.get(key)!);
  stored.credential.refresh.expiresAt = new Date(0).toISOString();
  b.vault.map.set(key, JSON.stringify(stored));
  b.request.mockImplementationOnce(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).requestId).toBe(
      stored.pendingRefreshId,
    );
    return response({ ...fresh(old), expiresAt: new Date(0).toISOString() });
  });
  const reopened = b.connections();
  await reopened.restore();
  await reopened.getSnapshot().session!.start(false);
  expect(reopened.getSnapshot().session!.getSnapshot().status).toBe("online");
  expect(
    b.request.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/auth/refresh") && init?.method === "POST",
    ),
  ).toHaveLength(3);
  reopened.dispose();
});
test("pending rotation is recovered even if local access still looks valid", async () => {
  const b = setup(device(), "TEST-pending-request-1234"),
    c = b.connections();
  await c.restore();
  await c.getSnapshot().session!.start(false);
  expect(b.request.mock.calls[0]![0]).toBe(`${address}/auth/refresh`);
  expect(c.getSnapshot().session!.getSnapshot().status).toBe("online");
  c.dispose();
});
test("cold-start bearer rejection attempts renewal before ending a device sign-in", async () => {
  const b = setup(device()),
    c = b.connections();
  b.request.mockImplementationOnce(async () =>
    response({ error: "auth_expired" }, 401),
  );
  await c.restore();
  await c.getSnapshot().session!.start(false);
  expect(b.request.mock.calls[0]![0]).toBe(`${address}/auth/session`);
  expect(b.request.mock.calls[1]![0]).toBe(`${address}/auth/refresh`);
  expect(c.getSnapshot().session!.getSnapshot().status).toBe("online");
  c.dispose();
});
test("terminal renewal rejection clears vault and visible identity", async () => {
  const b = setup(),
    c = b.connections();
  b.request.mockImplementationOnce(async () =>
    response({ error: "auth_expired" }, 401),
  );
  await c.restore();
  await c.getSnapshot().session!.start(false);
  await Promise.resolve();
  expect(c.getSnapshot()).toMatchObject({
    status: "expired",
    session: null,
    identity: null,
    renewable: false,
  });
  expect(b.vault.map.get(key)).toBe("null");
  c.dispose();
});
test.each(["dispose", "disconnect"] as const)(
  "%s during renewal never resurrects an identity",
  async (action) => {
    const b = setup(),
      c = b.connections();
    let release!: (r: Response) => void;
    b.request.mockImplementationOnce(
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await c.restore();
    const start = c.getSnapshot().session!.start(false);
    while (!release) await Promise.resolve();
    await c[action]();
    release(response(b.current));
    await start;
    if (action === "disconnect") {
      expect(c.getSnapshot().identity).toBeNull();
      expect(b.vault.map.get(key)).toBe("null");
      expect(
        b.request.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(true);
    } else {
      expect(JSON.parse(b.vault.map.get(key)!).pendingRefreshId).toBeDefined();
      expect(
        b.request.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
      const reopened = b.connections();
      await reopened.restore();
      await reopened.getSnapshot().session!.start(false);
      expect(reopened.getSnapshot().session!.getSnapshot().status).toBe(
        "online",
      );
      reopened.dispose();
    }
  },
);
test("concurrent requests share one refresh, and a failed vault write sends no refresh", async () => {
  const b = setup(),
    c = b.connections();
  await c.restore();
  const s = c.getSnapshot().session!;
  await Promise.all([s.refresh(), s.refresh()]);
  expect(
    b.request.mock.calls.filter(([url]) =>
      String(url).endsWith("/auth/refresh"),
    ),
  ).toHaveLength(1);
  c.dispose();
  const failing = setup(),
    other = failing.connections();
  await other.restore();
  failing.vault.setItem = async () => {
    throw Error("keychain unavailable");
  };
  await other.getSnapshot().session!.start(false);
  expect(failing.request).not.toHaveBeenCalled();
  expect(other.getSnapshot().identity).not.toBeNull();
  other.dispose();
});
test("accepted command response is not discarded if its access token approaches expiry", async () => {
  jest.useFakeTimers();
  const c = device(),
    engine = new FixtureEngine("a", undefined, undefined, undefined, c.scope);
  c.expiresAt = new Date(Date.now() + 11000).toISOString();
  const renewal = jest.fn(async () => {
    throw Error("offline");
  });
  const request = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/auth/session")) return response(authInfo(c));
    if (init?.method === "POST") {
      jest.setSystemTime(Date.now() + 2000);
      return response(engine.execute(JSON.parse(String(init.body))), 202);
    }
    return response(engine.snapshot());
  });
  const s = new ClientSession(
    address,
    memory(),
    c,
    request as typeof fetch,
    () => {},
    renewal,
  );
  await s.start(false);
  await s.send(messageCommand("Choose Peter", "en", "accepted-near-expiry"));
  expect(s.getSnapshot().pending).toBeNull();
  expect(renewal).not.toHaveBeenCalled();
  s.stop();
});
test("revocation during renewal cannot be undone by a late successful response", async () => {
  const b = setup(),
    c = b.connections();
  b.request.mockImplementationOnce(async () => {
    throw new AuthenticationError("auth_expired");
  });
  await c.restore();
  await c.getSnapshot().session!.start(false);
  expect(c.getSnapshot().status).toBe("expired");
  c.dispose();
});

test("a late rotation cannot overwrite a newly paired account", async () => {
  const b = setup(),
    c = b.connections();
  let release!: (r: Response) => void;
  const other = {
    ...device(),
    accessToken: "C".repeat(43),
    scope: { ...credential().scope, userId: "bob" },
  };
  b.request.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/auth/pair"))
      return response(other);
    if (init?.method === "DELETE") return response(null, 204);
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  await c.restore();
  const starting = c.getSnapshot().session!.start(false);
  while (!release) await Promise.resolve();
  await c.pair(address, "1".repeat(32));
  release(response(b.current));
  await starting;
  expect(c.getSnapshot().identity?.scope.userId).toBe("bob");
  expect(JSON.parse(b.vault.map.get(key)!).credential).toEqual(other);
  c.dispose();
});
