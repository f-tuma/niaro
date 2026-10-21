import { ClientSession } from "../packages/client-core/session";
import { Connections } from "../packages/client-core/connections";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { credential, authInfo } from "./auth-fixtures";
import { messageCommand } from "../packages/client-core/commands";
import { PROFILE, type Credential } from "../packages/protocol";
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
function backend(c: Credential = credential()) {
  const engine = new FixtureEngine(
    c.scope.workspaceId,
    undefined,
    undefined,
    undefined,
    c.scope,
  );
  let expired = false;
  const request = jest.fn(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/auth/pair"))
      return response(c);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${c.accessToken}`,
    });
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    if (expired) return response({ error: "auth_expired" }, 401);
    if (String(url).endsWith("/auth/session")) return response(authInfo(c));
    if (init?.method === "POST")
      return response(engine.execute(JSON.parse(String(init.body))), 202);
    return response(
      String(url).includes("/events?") ? engine.events(0) : engine.snapshot(),
    );
  }) as jest.MockedFunction<typeof fetch>;
  return {
    engine,
    request,
    expire: () => {
      expired = true;
    },
  };
}
test("server expiry clears all visible data, cancels polling and never retries a command", async () => {
  const b = backend(),
    storage = memory(),
    invalid = jest.fn();
  const s = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    b.request,
    invalid,
  );
  await s.start(false);
  await s.send(messageCommand("Choose Peter", "en", "first"));
  b.expire();
  await s.sync();
  expect(s.getSnapshot()).toMatchObject({
    status: "unauthorized",
    store: null,
    pending: null,
    commandStates: {},
  });
  const calls = b.request.mock.calls.length;
  await s.refresh();
  await s.retry();
  await s.send(messageCommand("Choose Peter", "en", "after-expiry"));
  expect(b.request).toHaveBeenCalledTimes(calls);
  expect(invalid).toHaveBeenCalledTimes(1);
});
test("session validation precedes cache reads; mismatched identity and expired local token show nothing", async () => {
  const storage = memory();
  const read = jest.spyOn(storage, "getItem");
  const request = jest.fn(async () =>
    response({
      ...authInfo(),
      scope: { ...credential().scope, userId: "someone-else" },
    }),
  );
  const s = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  await s.start(false);
  expect(s.getSnapshot().store).toBeNull();
  expect(read).not.toHaveBeenCalled();
  const expired = new ClientSession(
    "https://fixture/v1/a",
    storage,
    { ...credential(), expiresAt: "2000-01-01T00:00:00.000Z" },
    request,
  );
  await expired.start(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(expired.getSnapshot().status).toBe("unauthorized");
});
test("same endpoint with another user never reads the prior user's snapshot or pending command", async () => {
  const storage = memory(),
    a = backend();
  let lose = true;
  const request: typeof fetch = async (url, init) => {
    const result = await a.request(url, init);
    if (init?.method === "POST" && lose) {
      lose = false;
      throw Error("lost response");
    }
    return result;
  };
  const first = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  await first.start(false);
  await first.send(messageCommand("Choose Peter", "en", "uncertain"));
  first.stop();
  const c = {
    ...credential(),
    scope: { ...credential().scope, userId: "bob" },
  };
  const b = backend(c);
  const second = new ClientSession(
    "https://fixture/v1/a",
    storage,
    c,
    b.request,
  );
  await second.start(false);
  expect(second.getSnapshot().pending).toBeNull();
  expect(second.getSnapshot().store?.workItems).toEqual({});
  expect(
    [...storage.map.keys()].filter((k) => k.includes("snapshot")),
  ).toHaveLength(2);
  expect([...storage.map.values()].join()).not.toContain(
    credential().accessToken,
  );
  second.stop();
});
test("native-style vault restores identity, validates server first, and sign-out forgets/revokes it", async () => {
  const storage = memory(),
    vault = memory(),
    b = backend();
  const first = new Connections(storage, vault, false, b.request);
  await first.restore();
  await first.pair("https://fixture/v1/a", "1".repeat(32));
  expect(first.getSnapshot().status).toBe("connected");
  first.dispose();
  const reopened = new Connections(storage, vault, false, b.request);
  await reopened.restore();
  await reopened.getSnapshot().session!.start(false);
  expect(reopened.getSnapshot().session?.getSnapshot().status).toBe("online");
  await reopened.disconnect();
  expect(reopened.getSnapshot().session).toBeNull();
  expect([...vault.map.values()]).toEqual(["null"]);
  expect(
    b.request.mock.calls.some(([, init]) => init?.method === "DELETE"),
  ).toBe(true);
  reopened.dispose();
});
test("0.5 vault and cache restore the same identity and uncertain command without auto-sending", async () => {
  const storage = memory(),
    vault = memory(),
    b = backend();
  b.engine.execute(messageCommand("Choose Peter", "en", "existing-work"));
  let loseReceipt = true;
  let snapshotUnavailable = false;
  const request = jest.fn(async (url, init) => {
    if (
      snapshotUnavailable &&
      new URL(String(url)).pathname.endsWith("/snapshot")
    )
      throw Error("offline");
    const result = await b.request(url, init);
    if (new URL(String(url)).pathname.endsWith("/commands") && loseReceipt) {
      loseReceipt = false;
      throw Error("receipt lost");
    }
    return result;
  }) as jest.MockedFunction<typeof fetch>;
  const first = new Connections(storage, vault, false, request);
  await first.restore();
  await first.pair("https://fixture/v1/a", "1".repeat(32));
  const original = first.getSnapshot().session!;
  await original.start(false);
  const command = messageCommand("Choose Peter", "en", "uncertain-upgrade");
  await original.send(command);
  first.dispose();
  for (const [key, raw] of vault.map) {
    const stored = JSON.parse(raw);
    stored.credential.profile = "agent-client/0.5-fixture";
    vault.map.set(key, JSON.stringify(stored));
  }
  for (const [key, raw] of storage.map) {
    if (!key.includes("snapshot")) continue;
    const stored = JSON.parse(raw);
    stored.profile = "agent-client/0.5-fixture";
    storage.map.set(key, JSON.stringify(stored));
  }
  request.mockClear();
  snapshotUnavailable = true;
  const reopened = new Connections(storage, vault, false, request);
  try {
    await reopened.restore();
    expect(reopened.getSnapshot().identity).toEqual(authInfo());
    expect(reopened.getSnapshot().identity?.profile).toBe(PROFILE);
    const session = reopened.getSnapshot().session!;
    await session.start(false);
    expect(session.getSnapshot()).toMatchObject({
      status: "offline",
      pending: command,
      store: {
        stale: true,
        workItems: { "work-1": { status: "waiting_input" } },
      },
    });
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
    snapshotUnavailable = false;
    await session.refresh();
    await session.retry();
    expect(session.getSnapshot().pending).toBeNull();
    expect(b.engine.snapshot().workItems).toHaveLength(2);
    const posts = request.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual(command);
  } finally {
    reopened.dispose();
  }
});
test.each([
  { profile: "agent-client/99-fixture" },
  { profile: "agent-client/0.5-fixture", permissions: ["workflow.admin"] },
])(
  "stored credential migration rejects incompatible data: %j",
  async (invalid) => {
    const vault = memory(),
      request = jest.fn();
    vault.map.set(
      "agent-client.active-credential.v1",
      JSON.stringify({
        address: "https://fixture/v1/a",
        credential: { ...credential(), ...invalid },
      }),
    );
    const connection = new Connections(memory(), vault, false, request);
    await connection.restore();
    expect(connection.getSnapshot()).toMatchObject({
      status: "signed_out",
      session: null,
      error: "credential_storage_error",
    });
    expect(request).not.toHaveBeenCalled();
    connection.dispose();
  },
);
test("stored profile migration does not accept a legacy network auth response", async () => {
  const storage = memory();
  const read = jest.spyOn(storage, "getItem");
  const request = jest.fn(async () =>
    response({
      ...authInfo(),
      profile: "agent-client/0.5-fixture",
    }),
  );
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  await session.start(false);
  expect(session.getSnapshot().store).toBeNull();
  expect(read).not.toHaveBeenCalled();
  session.stop();
});
test("cancelled pairing ignores a late credential and revokes it; storage failure does not activate a session", async () => {
  let finish!: (r: Response) => void;
  const b = backend();
  const request = jest.fn(async (url, init) =>
    new URL(String(url)).pathname.endsWith("/auth/pair")
      ? new Promise<Response>((r) => {
          finish = r;
        })
      : b.request(url, init),
  );
  const vault = memory(),
    c = new Connections(memory(), vault, false, request);
  await c.restore();
  const pairing = c.pair("https://fixture/v1/a", "1".repeat(32));
  while (!finish) await Promise.resolve();
  await c.disconnect();
  finish(response(credential()));
  await pairing;
  expect(c.getSnapshot().session).toBeNull();
  expect([...vault.map.values()]).toEqual(["null"]);
  expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
    true,
  );
  vault.setItem = async (_key, value) => {
    if (value !== "null") throw Error("keystore unavailable");
  };
  const failing = new Connections(memory(), vault, false, b.request);
  await failing.restore();
  await failing.pair("https://fixture/v1/a", "1".repeat(32));
  expect(failing.getSnapshot()).toMatchObject({
    status: "signed_out",
    session: null,
    error: "credential_storage_error",
  });
});
test("lost logout response hides local work but reports unconfirmed revocation", async () => {
  const b = backend();
  const request: typeof fetch = async (url, init) => {
    if (init?.method === "DELETE") throw Error("offline");
    return b.request(url, init);
  };
  const c = new Connections(memory(), memory(), false, request);
  await c.restore();
  await c.pair("https://fixture/v1/a", "1".repeat(32));
  await c.disconnect();
  expect(c.getSnapshot()).toMatchObject({
    status: "signed_out",
    session: null,
    error: "logout_unconfirmed",
  });
});

test("late old pairing cannot overwrite a newer server identity or its vault credential", async () => {
  const old = credential(),
    fresh = {
      ...credential(),
      accessToken: "B".repeat(43),
      scope: { ...credential().scope, userId: "bob" },
    };
  let finish!: (r: Response) => void;
  const request = jest.fn(async (url, init) => {
    if (
      new URL(String(url)).origin === "https://one.example" &&
      new URL(String(url)).pathname.endsWith("/auth/pair")
    )
      return new Promise<Response>((r) => {
        finish = r;
      });
    if (
      new URL(String(url)).origin === "https://two.example" &&
      new URL(String(url)).pathname.endsWith("/auth/pair")
    ) {
      expect(init?.headers).not.toHaveProperty("Authorization");
      return response(fresh);
    }
    expect(String(url)).toBe("https://one.example/v1/a/auth/session");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${old.accessToken}`,
    });
    return response(null, 204);
  });
  const vault = memory(),
    c = new Connections(memory(), vault, false, request);
  await c.restore();
  const pending = c.pair("https://one.example/v1/a", "1".repeat(32));
  while (!finish) await Promise.resolve();
  await c.disconnect();
  await c.pair("https://two.example/v1/a", "2".repeat(32));
  finish(response(old));
  expect(await pending).toBeUndefined();
  expect(c.getSnapshot().address).toBe("https://two.example/v1/a");
  expect(c.getSnapshot().identity?.scope.userId).toBe("bob");
  expect([...vault.map.values()][0]).toContain(fresh.accessToken);
  expect([...vault.map.values()][0]).not.toContain(old.accessToken);
  c.dispose();
});
test("a late successful command response cannot restore content after authorization loss", async () => {
  const b = backend();
  let finish!: (r: Response) => void;
  const request: typeof fetch = async (url, init) => {
    if (init?.method === "POST")
      return new Promise<Response>((r) => {
        finish = r;
      });
    return b.request(url, init);
  };
  const s = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    credential(),
    request,
  );
  await s.start(false);
  const command = messageCommand("Choose Peter", "en", "late");
  const result = b.engine.execute(command);
  const sending = s.send(command);
  while (!finish) await Promise.resolve();
  b.expire();
  await s.sync();
  finish(response(result));
  await sending;
  expect(s.getSnapshot()).toMatchObject({
    status: "unauthorized",
    store: null,
    pending: null,
  });
});

test("failure to clear the old credential prevents pairing and reports secure-storage failure", async () => {
  const vault = memory(),
    b = backend();
  const c = new Connections(memory(), vault, false, b.request);
  await c.restore();
  vault.setItem = async () => {
    throw Error("keychain locked");
  };
  await c.pair("https://fixture/v1/a", "1".repeat(32));
  expect(c.getSnapshot()).toMatchObject({
    status: "signed_out",
    session: null,
    error: "credential_storage_error",
  });
  expect(b.request).not.toHaveBeenCalled();
});
test("a web credential without a refresh token is reissued, not signed out", async () => {
  const first = {
    ...credential(),
    accessToken: "TEST-web-first-".padEnd(43, "a"),
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
  };
  const next = {
    ...credential(),
    accessToken: "TEST-web-next-".padEnd(43, "b"),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const b = backend(next);
  const renew = jest.fn(async () => next);
  const invalid = jest.fn();
  const s = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    first,
    b.request,
    invalid,
    renew,
    false,
    { reissue: true },
  );
  await s.start(false);
  // The expiring credential was replaced before the first request; every
  // request (checked by the backend) carries the new one.
  expect(renew).toHaveBeenCalledTimes(1);
  expect(invalid).not.toHaveBeenCalled();
  expect(s.getSnapshot().status).toBe("online");
});
