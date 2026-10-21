import { Connections } from "../packages/client-core/connections";
import { DEVICE_SESSION_PROFILE } from "../packages/protocol";
import { credential } from "./auth-fixtures";
const origin = "https://server.example",
  workspace = "059e3706-df87-44b4-8b7c-65c5dd457731";
const c = {
  ...credential(),
  scope: {
    ...credential().scope,
    workspaceId: workspace,
    connectionId: `account-${workspace}`,
  },
  refresh: {
    profile: DEVICE_SESSION_PROFILE,
    token: "R".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const proof = {
  challenge: "C".repeat(43),
  state: "S".repeat(43),
  verifier: "V".repeat(43),
};
const response = (v: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(v) }) as Response;
function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
}
function setup() {
  const store = memory(),
    vault = memory();
  const request = jest.fn(async (url: unknown, _init?: RequestInit) =>
    String(url).endsWith("/start")
      ? response({
          authorizationUrl: origin + "/account/login#" + "A".repeat(43),
        })
      : response({ address: origin + "/v1/" + workspace, credential: c }),
  );
  const connection = new Connections(
    store,
    vault,
    false,
    request as typeof fetch,
  );
  return { connection, store, vault, request };
}
test("app login validates redirect and saves only returned persistent credential", async () => {
  const { connection, vault, request } = setup();
  await connection.restore();
  const authorize = jest.fn(async () => "K".repeat(43));
  expect(await connection.signInWithApp(origin, proof, authorize)).toBe(true);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(connection.getSnapshot().status).toBe("connected");
  expect([...vault.map.values()].some((v) => v.includes(c.accessToken))).toBe(
    true,
  );
  const body = JSON.parse(
    (request.mock.calls[1] as unknown as [string, RequestInit])[1]
      ?.body as string,
  );
  expect(body.verifier).toBe(proof.verifier);
  await connection.disconnect();
});
test("cancelled authorize cannot restore session after disconnect", async () => {
  const { connection, vault } = setup();
  await connection.restore();
  let release!: (code: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const login = connection.signInWithApp(origin, proof, async () => {
    entered();
    return new Promise<string>((r) => (release = r));
  });
  await started;
  await connection.disconnect();
  release("K".repeat(43));
  expect(await login).toBeUndefined();
  expect(connection.getSnapshot().status).toBe("signed_out");
  expect([...vault.map.values()].some((v) => v.includes(c.accessToken))).toBe(
    false,
  );
});
test("untrusted browser target is never opened", async () => {
  const { connection, request } = setup();
  await connection.restore();
  request.mockImplementation(async () =>
    response({ authorizationUrl: "https://evil.example/account/login" }),
  );
  const authorize = jest.fn();
  await connection.signInWithApp(origin, proof, authorize);
  expect(authorize).not.toHaveBeenCalled();
  expect(connection.getSnapshot().error).toBe("connection_failed");
});
test("invalid address preserves existing connected identity", async () => {
  const { connection } = setup();
  await connection.restore();
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  const prior = connection.getSnapshot().identity;
  await connection.signInWithApp("http://wrong.example", proof, jest.fn());
  expect(connection.getSnapshot().status).toBe("connected");
  expect(connection.getSnapshot().identity).toBe(prior);
  expect(connection.getSnapshot().error).toBe("addressError");
  await connection.disconnect();
});
test("a rejected exchange address cannot retarget credential revocation", async () => {
  const { connection, vault, request } = setup();
  await connection.restore();
  request.mockImplementation(async (url) =>
    String(url).endsWith("/start")
      ? response({
          authorizationUrl: origin + "/account/login#" + "A".repeat(43),
        })
      : response({
          address: "https://untrusted.example/v1/" + workspace,
          credential: c,
        }),
  );
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  expect(connection.getSnapshot().error).toBe("auth_scope_mismatch");
  expect(connection.getSnapshot().identity).toBeNull();
  expect(
    request.mock.calls.every(([url]) => new URL(String(url)).origin === origin),
  ).toBe(true);
  const revoke = request.mock.calls.find(
    ([, init]) => init?.method === "DELETE",
  );
  expect(String(revoke?.[0])).toBe(`${origin}/v1/${workspace}/auth/refresh`);
  expect([...vault.map.values()].some((v) => v.includes(c.accessToken))).toBe(
    false,
  );
});
test("a credential storage failure while switching revokes the new credential and reports it", async () => {
  const { connection, vault, request } = setup();
  await connection.restore();
  jest
    .spyOn(vault, "setItem")
    .mockRejectedValueOnce(Error("TEST unavailable storage"));
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  expect(connection.getSnapshot()).toMatchObject({
    status: "signed_out",
    error: "credential_storage_error",
  });
  expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
    true,
  );
  expect([...vault.map.values()].some((v) => v.includes(c.accessToken))).toBe(
    false,
  );
});
test("a cancelled or failed second sign-in keeps the current session", async () => {
  const { connection, vault, request } = setup();
  await connection.restore();
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  const prior = connection.getSnapshot();
  expect(prior.status).toBe("connected");
  request.mockClear();
  await connection.signInWithApp(origin, proof, async () => {
    throw Error("TEST cancelled");
  });
  const after = connection.getSnapshot();
  expect(after.status).toBe("connected");
  expect(after.session).toBe(prior.session);
  expect(after.identity).toBe(prior.identity);
  expect(after.error).toBe("connection_failed");
  // Nothing was revoked and the stored credential is still the current one.
  expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
    false,
  );
  expect([...vault.map.values()].some((v) => v.includes(c.accessToken))).toBe(
    true,
  );
  await connection.disconnect();
});
test("a successful second sign-in switches first and then revokes the old credential", async () => {
  const { connection, request } = setup();
  await connection.restore();
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  const prior = connection.getSnapshot().session;
  request.mockClear();
  expect(
    await connection.signInWithApp(origin, proof, async () => "K".repeat(43)),
  ).toBe(true);
  expect(connection.getSnapshot().status).toBe("connected");
  expect(connection.getSnapshot().session).not.toBe(prior);
  await Promise.resolve();
  const urls = request.mock.calls.map(([url, init]) => [
    String(url),
    init?.method,
  ]);
  const exchange = urls.findIndex(([url]) => url!.endsWith("/exchange"));
  const revoke = urls.findIndex(([, method]) => method === "DELETE");
  expect(exchange).toBeGreaterThanOrEqual(0);
  expect(revoke).toBeGreaterThan(exchange);
  await connection.disconnect();
});
test.each([
  {
    credential: { ...c, refresh: undefined },
    error: "auth_session_incompatible",
  },
  {
    credential: { ...c, expiresAt: "2000-01-01T00:00:00.000Z" },
    error: "auth_expired",
  },
  {
    credential: { ...c, scope: { ...c.scope, connectionId: "fixture-a" } },
    error: "auth_scope_mismatch",
  },
])(
  "invalid app session is rejected as $error without activating",
  async (invalid) => {
    const { connection, request } = setup();
    await connection.restore();
    request.mockImplementation(async (url) =>
      String(url).endsWith("/start")
        ? response({
            authorizationUrl: origin + "/account/login#" + "A".repeat(43),
          })
        : response({
            address: origin + "/v1/" + workspace,
            credential: invalid.credential,
          }),
    );
    await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
    expect(connection.getSnapshot()).toMatchObject({
      status: "signed_out",
      identity: null,
      error: invalid.error,
    });
    expect(
      request.mock.calls.every(
        ([url]) => new URL(String(url)).origin === origin,
      ),
    ).toBe(true);
  },
);
test("the device limit tells the person to remove a device", async () => {
  const { connection, request } = setup();
  await connection.restore();
  request.mockImplementation(async (url) =>
    String(url).endsWith("/start")
      ? response({
          authorizationUrl: origin + "/account/login#" + "A".repeat(43),
        })
      : ({
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ error: "mobile_device_limit" }),
        } as Response),
  );
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  expect(connection.getSnapshot().error).toBe("mobile_device_limit");
  // Any other refusal stays generic.
  request.mockImplementation(async (url) =>
    String(url).endsWith("/start")
      ? response({
          authorizationUrl: origin + "/account/login#" + "A".repeat(43),
        })
      : ({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: "app_login_invalid" }),
        } as Response),
  );
  await connection.signInWithApp(origin, proof, async () => "K".repeat(43));
  expect(connection.getSnapshot().error).toBe("connection_failed");
});
