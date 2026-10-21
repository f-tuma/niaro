import { Connections } from "../packages/client-core/connections";
import { AbortController as NativeAbortController } from "abort-controller";
import { BROWSER_LOGIN_PROFILE } from "../packages/protocol/browser-login";
import {
  browserLoginRequest,
  loginOrigin,
  validateLoginChallenge,
  validateLoginPoll,
} from "../packages/client-core/browser-login";
import { credential } from "./auth-fixtures";
const origin = "https://server.example";
const workspaceId = "059e3706-df87-44b4-8b7c-65c5dd457731";
const c = {
  ...credential(),
  scope: {
    ...credential().scope,
    workspaceId,
    connectionId: `account-${workspaceId}`,
    userId: "TEST-user",
  },
};
const challenge = () => ({
  profile: BROWSER_LOGIN_PROFILE,
  deviceCode: "D".repeat(43),
  userCode: "ABCD1234EF56",
  serverId: c.scope.serverId,
  verificationUri: `${origin}/admin/device#ABCD1234EF56`,
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  interval: 5,
});
const approved = () => ({
  status: "approved",
  address: `${origin}/v1/${workspaceId}`,
  credential: c,
});
const response = (data: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  }) as Response;
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
afterEach(() => jest.useRealTimers());
test("browser login polling supports the React Native AbortSignal", async () => {
  const controller = new NativeAbortController();
  const signal = controller.signal as unknown as AbortSignal;
  expect(signal.throwIfAborted).toBeUndefined();
  const request = jest.fn(async (_url: unknown, init?: RequestInit) => {
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    return response({ status: "pending", interval: 5 });
  });
  await expect(
    browserLoginRequest(
      origin,
      "poll",
      request as typeof fetch,
      "D".repeat(43),
      signal,
    ),
  ).resolves.toEqual({ status: "pending", interval: 5 });
  expect(request).toHaveBeenCalledTimes(1);
  request.mockClear();
  await expect(
    browserLoginRequest(
      origin,
      "poll",
      request as typeof fetch,
      "D".repeat(43),
      signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(request).not.toHaveBeenCalled();
});
test("root address and received URLs/scopes are strictly bounded", () => {
  expect(loginOrigin(`${origin}/v1/a`, false)).toBe(origin);
  expect(() => loginOrigin(`${origin}/admin`, false)).toThrow();
  expect(() => loginOrigin("http://server.example", true)).toThrow();
  expect(validateLoginChallenge(challenge(), origin).userCode).toBe(
    "ABCD1234EF56",
  );
  expect(() =>
    validateLoginChallenge(
      {
        ...challenge(),
        verificationUri: "https://evil.example/admin/device#ABCD1234EF56",
      },
      origin,
    ),
  ).toThrow();
  expect(() =>
    validateLoginChallenge(
      { ...challenge(), expiresAt: new Date(0).toISOString() },
      origin,
    ),
  ).toThrow();
  expect(validateLoginPoll(approved(), origin, c.scope.serverId).status).toBe(
    "approved",
  );
  expect(() =>
    validateLoginPoll(
      { ...approved(), address: "https://evil.example/v1/x" },
      origin,
      c.scope.serverId,
    ),
  ).toThrow();
  expect(() => validateLoginPoll(approved(), origin, "other-server")).toThrow();
  expect(() =>
    validateLoginPoll(
      { ...approved(), credential: credential() },
      origin,
      c.scope.serverId,
    ),
  ).toThrow();
});
test("browser sign-in polls without cookies and persists only the final scoped credential", async () => {
  jest.useFakeTimers();
  const vault = memory(),
    storage = memory();
  const request = jest.fn(async (url, init) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    if (new URL(String(url)).pathname.endsWith("/start"))
      return response(challenge());
    if (String(url).endsWith("/poll")) return response(approved());
    return response({ ok: true });
  });
  const connections = new Connections(storage, vault, false, request);
  await connections.restore();
  const login = connections.signInWithBrowser(origin);
  await jest.advanceTimersByTimeAsync(0);
  expect(connections.getSnapshot().browserLogin?.userCode).toBe("ABCD1234EF56");
  expect(JSON.stringify([...vault.map])).not.toContain("D".repeat(43));
  await jest.advanceTimersByTimeAsync(5000);
  expect(await login).toBe(true);
  expect(connections.getSnapshot().status).toBe("connected");
  expect(connections.getSnapshot().browserLogin).toBeNull();
  expect(JSON.stringify([...vault.map])).toContain(c.accessToken);
  connections.dispose();
});
test("cancelling a pending poll revokes the request and ignores its late credential", async () => {
  jest.useFakeTimers();
  let release!: (res: Response) => void;
  const request = jest.fn(async (url) =>
    new URL(String(url)).pathname.endsWith("/start")
      ? response(challenge())
      : String(url).endsWith("/poll")
        ? await new Promise<Response>((r) => {
            release = r;
          })
        : response({ ok: true }),
  );
  const vault = memory(),
    connections = new Connections(memory(), vault, false, request);
  await connections.restore();
  const login = connections.signInWithBrowser(origin);
  await jest.advanceTimersByTimeAsync(5000);
  await connections.disconnect();
  release(response(approved()));
  await login;
  expect(connections.getSnapshot().status).toBe("signed_out");
  expect(JSON.stringify([...vault.map])).not.toContain(c.accessToken);
  expect(
    request.mock.calls.some(([url]) => String(url).endsWith("/cancel")),
  ).toBe(true);
  expect(
    request.mock.calls.some(([url]) => String(url).endsWith("/auth/session")),
  ).toBe(true);
  connections.dispose();
});
test("vault failure after redemption never activates and revokes the credential", async () => {
  jest.useFakeTimers();
  const request = jest.fn(async (url) =>
    new URL(String(url)).pathname.endsWith("/start")
      ? response(challenge())
      : String(url).endsWith("/poll")
        ? response(approved())
        : response({ ok: true }),
  );
  const vault = {
    getItem: async () => null,
    setItem: async (_k: string, v: string) => {
      if (v !== "null") throw Error("disk");
    },
  };
  const connections = new Connections(memory(), vault, false, request);
  await connections.restore();
  const login = connections.signInWithBrowser(origin);
  await jest.advanceTimersByTimeAsync(5000);
  await login;
  expect(connections.getSnapshot()).toMatchObject({
    status: "signed_out",
    error: "credential_storage_error",
  });
  expect(
    request.mock.calls.some(([url]) => String(url).endsWith("/cancel")),
  ).toBe(true);
  connections.dispose();
});
